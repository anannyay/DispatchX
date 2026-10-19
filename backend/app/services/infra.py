"""Live view of the container platform the app is running on.

On AWS it reads the ECS API (EC2 container instances, tasks, services);
inside Kubernetes it reads the in-cluster API (nodes, pods, deployments).
Both are normalised to one shape so a single UI can draw either platform:

    nodes[]    -> machine with CPU/memory capacity and reserved amounts
      tasks[]  -> container group (ECS task / Kubernetes pod) on that node
    services[] -> desired vs running counts (ECS service / Deployment)
    events[]   -> recent scheduler activity
"""
import json
import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import boto3
import httpx

from app.config import settings
from app.redis_client import r

CACHE_KEY = "infra:snapshot"
CACHE_TTL_S = 3   # many dispatchers polling must not hammer the ECS API

K8S_SA = Path("/var/run/secrets/kubernetes.io/serviceaccount")


def platform() -> str:
    if os.environ.get("KUBERNETES_SERVICE_HOST"):
        return "kubernetes"
    if os.environ.get("ECS_CLUSTER"):
        return "ecs"
    return "none"


def _iso(dt) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    return dt.astimezone(timezone.utc).isoformat()


def snapshot() -> dict:
    cached = r.get(CACHE_KEY)
    if cached:
        return json.loads(cached)
    kind = platform()
    if kind == "ecs":
        data = _ecs_snapshot()
    elif kind == "kubernetes":
        data = _k8s_snapshot()
    else:
        data = {"platform": "none", "cluster": None, "nodes": [], "services": [], "events": []}
    data["fetched_at"] = datetime.now(timezone.utc).isoformat()
    r.set(CACHE_KEY, json.dumps(data, default=str), ex=CACHE_TTL_S)
    return data


def stop(task_id: str) -> None:
    """Chaos test: kill one task/pod and let the orchestrator replace it."""
    kind = platform()
    if kind == "ecs":
        _ecs().stop_task(cluster=os.environ["ECS_CLUSTER"], task=task_id,
                         reason="Chaos test from DispatchX Cluster View")
    elif kind == "kubernetes":
        _k8s_request("DELETE", f"/api/v1/namespaces/{_k8s_namespace()}/pods/{task_id}")
    else:
        raise RuntimeError("No container platform detected")
    r.delete(CACHE_KEY)


# ======================= Amazon ECS =======================
@lru_cache
def _ecs():
    return boto3.client("ecs", region_name=settings.aws_region)


def _chunks(items, n):
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _resource(resources, name) -> int:
    return next((x.get("integerValue", 0) for x in resources if x["name"] == name), 0)


def _ecs_snapshot() -> dict:
    ecs, cluster = _ecs(), os.environ["ECS_CLUSTER"]

    ci_arns = []
    for page in ecs.get_paginator("list_container_instances").paginate(cluster=cluster):
        ci_arns += page["containerInstanceArns"]
    nodes, by_arn = [], {}
    for chunk in _chunks(ci_arns, 100):
        for ci in ecs.describe_container_instances(cluster=cluster, containerInstances=chunk)["containerInstances"]:
            attrs = {a["name"]: a.get("value") for a in ci.get("attributes", [])}
            reg, rem = ci["registeredResources"], ci["remainingResources"]
            node = {
                "id": ci["containerInstanceArn"].split("/")[-1],
                "name": ci.get("ec2InstanceId"),
                "zone": attrs.get("ecs.availability-zone"),
                "instance_type": attrs.get("ecs.instance-type"),
                "status": ci["status"],
                "cpu_total": _resource(reg, "CPU"),
                "cpu_used": _resource(reg, "CPU") - _resource(rem, "CPU"),
                "mem_total": _resource(reg, "MEMORY"),
                "mem_used": _resource(reg, "MEMORY") - _resource(rem, "MEMORY"),
                "started_at": _iso(ci.get("registeredAt")),
                "tasks": [],
            }
            nodes.append(node)
            by_arn[ci["containerInstanceArn"]] = node

    task_arns = []
    for status in ("RUNNING", "STOPPED"):
        for page in ecs.get_paginator("list_tasks").paginate(cluster=cluster, desiredStatus=status):
            task_arns += page["taskArns"]
    now = datetime.now(timezone.utc)
    for chunk in _chunks(task_arns, 100):
        for t in ecs.describe_tasks(cluster=cluster, tasks=chunk)["tasks"]:
            stopped_at = t.get("stoppedAt")
            if t["lastStatus"] == "STOPPED" and (not stopped_at or (now - stopped_at).total_seconds() > 90):
                continue   # keep just-stopped tasks briefly so the UI can show them dying
            node = by_arn.get(t.get("containerInstanceArn"))
            if not node:
                continue
            node["tasks"].append({
                "id": t["taskArn"].split("/")[-1],
                "service": t.get("group", "").replace("service:", "").replace("family:", ""),
                "status": t["lastStatus"],
                "desired": t["desiredStatus"],
                "health": t.get("healthStatus", "UNKNOWN"),
                "cpu": int(t.get("cpu") or 0),
                "memory": int(t.get("memory") or 0),
                "containers": [c["name"] for c in t.get("containers", [])],
                "started_at": _iso(t.get("startedAt") or t.get("createdAt")),
                "stopped_reason": t.get("stoppedReason"),
            })

    services, events = [], []
    svc_arns = []
    for page in ecs.get_paginator("list_services").paginate(cluster=cluster):
        svc_arns += page["serviceArns"]
    for chunk in _chunks(svc_arns, 10):
        for s in ecs.describe_services(cluster=cluster, services=chunk)["services"]:
            services.append({
                "name": s["serviceName"], "desired": s["desiredCount"],
                "running": s["runningCount"], "pending": s["pendingCount"],
            })
            for e in s.get("events", [])[:6]:
                events.append({"at": _iso(e["createdAt"]), "message": e["message"]})
    events.sort(key=lambda e: e["at"], reverse=True)
    services.sort(key=lambda s: s["name"])
    nodes.sort(key=lambda n: (n["zone"] or "", n["started_at"] or ""))
    return {"platform": "ecs", "cluster": cluster, "nodes": nodes, "services": services, "events": events[:15]}


# ======================= Kubernetes =======================
def _k8s_namespace() -> str:
    try:
        return (K8S_SA / "namespace").read_text().strip()
    except OSError:
        return "dispatchx"


def _k8s_request(method: str, path: str) -> dict:
    host = os.environ["KUBERNETES_SERVICE_HOST"]
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    token = (K8S_SA / "token").read_text().strip()
    res = httpx.request(method, f"https://{host}:{port}{path}", timeout=5,
                        headers={"Authorization": f"Bearer {token}"}, verify=str(K8S_SA / "ca.crt"))
    res.raise_for_status()
    return res.json()


_UNITS = {"Ki": 1 / 1024, "Mi": 1, "Gi": 1024, "K": 1 / 1048.576, "M": 1 / 1.048576, "G": 953.674}


def _cpu_millis(q: str | None) -> int:
    if not q:
        return 0
    return int(q[:-1]) if q.endswith("m") else int(float(q) * 1000)


def _mem_mib(q: str | None) -> int:
    if not q:
        return 0
    m = re.fullmatch(r"([0-9.]+)([A-Za-z]*)", q)
    if not m:
        return 0
    num, unit = float(m.group(1)), m.group(2)
    return int(num * _UNITS[unit]) if unit in _UNITS else int(num / 1048576)


def _k8s_snapshot() -> dict:
    ns = _k8s_namespace()
    nodes, by_name = [], {}
    for n in _k8s_request("GET", "/api/v1/nodes")["items"]:
        labels = n["metadata"].get("labels", {})
        ready = next((c["status"] for c in n["status"].get("conditions", []) if c["type"] == "Ready"), "Unknown")
        node = {
            "id": n["metadata"]["uid"], "name": n["metadata"]["name"],
            "zone": labels.get("topology.kubernetes.io/zone") or labels.get("kubernetes.io/hostname"),
            "instance_type": labels.get("node.kubernetes.io/instance-type")
            or ("control-plane" if "node-role.kubernetes.io/control-plane" in labels else "worker"),
            "status": "ACTIVE" if ready == "True" else "NOT_READY",
            "cpu_total": _cpu_millis(n["status"]["allocatable"].get("cpu")),
            "cpu_used": 0,
            "mem_total": _mem_mib(n["status"]["allocatable"].get("memory")),
            "mem_used": 0,
            "started_at": n["metadata"].get("creationTimestamp"),
            "tasks": [],
        }
        nodes.append(node)
        by_name[node["name"]] = node

    for p in _k8s_request("GET", f"/api/v1/namespaces/{ns}/pods")["items"]:
        node = by_name.get(p["spec"].get("nodeName"))
        if not node:
            continue
        containers = p["spec"]["containers"]
        cpu = sum(_cpu_millis(c.get("resources", {}).get("requests", {}).get("cpu")) for c in containers)
        mem = sum(_mem_mib(c.get("resources", {}).get("requests", {}).get("memory")) for c in containers)
        phase = p["status"].get("phase", "Unknown")
        deleting = bool(p["metadata"].get("deletionTimestamp"))
        statuses = p["status"].get("containerStatuses", [])
        ready = bool(statuses) and all(s.get("ready") for s in statuses)
        node["cpu_used"] += cpu
        node["mem_used"] += mem
        node["tasks"].append({
            "id": p["metadata"]["name"],
            "service": p["metadata"].get("labels", {}).get("app", p["metadata"]["name"]),
            "status": "STOPPING" if deleting else {"Running": "RUNNING", "Pending": "PENDING"}.get(phase, phase.upper()),
            "desired": "STOPPED" if deleting else "RUNNING",
            "health": "HEALTHY" if ready else "UNKNOWN",
            "cpu": cpu, "memory": mem,
            "containers": [c["name"] for c in containers],
            "started_at": p["status"].get("startTime"),
            "stopped_reason": None,
        })

    services = []
    for d in _k8s_request("GET", f"/apis/apps/v1/namespaces/{ns}/deployments")["items"]:
        st = d.get("status", {})
        services.append({
            "name": d["metadata"]["name"], "desired": d["spec"].get("replicas", 0),
            "running": st.get("readyReplicas", 0),
            "pending": max(0, st.get("replicas", 0) - st.get("readyReplicas", 0)),
        })
    events = []
    try:
        for e in _k8s_request("GET", f"/api/v1/namespaces/{ns}/events")["items"]:
            at = e.get("lastTimestamp") or e.get("eventTime") or e["metadata"].get("creationTimestamp")
            obj = e.get("involvedObject", {})
            events.append({"at": at, "message": f"{obj.get('kind', '')} {obj.get('name', '')}: {e.get('message', '')}"})
    except httpx.HTTPError:
        pass
    events.sort(key=lambda e: e["at"] or "", reverse=True)
    services.sort(key=lambda s: s["name"])
    return {"platform": "kubernetes", "cluster": ns, "nodes": nodes, "services": services, "events": events[:15]}

"""Unit tests for the Cluster View normaliser using canned ECS / Kubernetes API responses."""
import os
from datetime import datetime, timedelta, timezone

from app.services import infra

NOW = datetime.now(timezone.utc)


class FakePaginator:
    def __init__(self, pages):
        self.pages = pages

    def paginate(self, **kw):
        key = kw.get("desiredStatus", "_")
        return self.pages.get(key, self.pages.get("_", []))


class FakeEcs:
    def get_paginator(self, name):
        return {
            "list_container_instances": FakePaginator({"_": [{"containerInstanceArns": ["arn:ci/c1", "arn:ci/c2"]}]}),
            "list_tasks": FakePaginator({
                "RUNNING": [{"taskArns": ["arn:task/t1", "arn:task/t2"]}],
                "STOPPED": [{"taskArns": ["arn:task/t3", "arn:task/t4"]}],
            }),
            "list_services": FakePaginator({"_": [{"serviceArns": ["arn:svc/api"]}]}),
        }[name]

    def describe_container_instances(self, **kw):
        def ci(arn, az, ec2):
            return {"containerInstanceArn": arn, "ec2InstanceId": ec2, "status": "ACTIVE",
                    "registeredAt": NOW - timedelta(hours=1),
                    "attributes": [{"name": "ecs.availability-zone", "value": az},
                                   {"name": "ecs.instance-type", "value": "t3.small"}],
                    "registeredResources": [{"name": "CPU", "integerValue": 2048}, {"name": "MEMORY", "integerValue": 1900}],
                    "remainingResources": [{"name": "CPU", "integerValue": 1536}, {"name": "MEMORY", "integerValue": 1132}]}
        return {"containerInstances": [ci("arn:ci/c1", "ap-southeast-2a", "i-aaa"), ci("arn:ci/c2", "ap-southeast-2b", "i-bbb")]}

    def describe_tasks(self, **kw):
        def t(arn, ci, group, status="RUNNING", stopped=None):
            return {"taskArn": arn, "containerInstanceArn": ci, "group": group, "lastStatus": status,
                    "desiredStatus": "RUNNING" if status != "STOPPED" else "STOPPED", "cpu": "256", "memory": "768",
                    "startedAt": NOW - timedelta(minutes=5), "stoppedAt": stopped,
                    "containers": [{"name": group.split(":")[1]}]}
        return {"tasks": [
            t("arn:task/t1", "arn:ci/c1", "service:api"),
            t("arn:task/t2", "arn:ci/c2", "service:web"),
            t("arn:task/t3", "arn:ci/c1", "service:api", "STOPPED", NOW - timedelta(seconds=20)),   # just died: shown
            t("arn:task/t4", "arn:ci/c2", "service:api", "STOPPED", NOW - timedelta(minutes=10)),   # old: hidden
        ]}

    def describe_services(self, **kw):
        return {"services": [{"serviceName": "api", "desiredCount": 3, "runningCount": 2, "pendingCount": 1,
                              "events": [{"createdAt": NOW, "message": "(service api) has started 1 tasks"}]}]}


def test_ecs_snapshot(monkeypatch):
    monkeypatch.setenv("ECS_CLUSTER", "dispatchx-cluster")
    monkeypatch.setattr(infra, "_ecs", lambda: FakeEcs())
    s = infra._ecs_snapshot()
    assert s["platform"] == "ecs" and len(s["nodes"]) == 2
    n1 = next(n for n in s["nodes"] if n["name"] == "i-aaa")
    assert n1["cpu_used"] == 512 and n1["mem_used"] == 768 and n1["zone"] == "ap-southeast-2a"
    assert {t["id"] for t in n1["tasks"]} == {"t1", "t3"}          # t3 just stopped, still visible
    assert all(t["id"] != "t4" for n in s["nodes"] for t in n["tasks"])
    assert s["services"][0] == {"name": "api", "desired": 3, "running": 2, "pending": 1}
    assert "started 1 tasks" in s["events"][0]["message"]


def test_k8s_snapshot(monkeypatch):
    responses = {
        "/api/v1/nodes": {"items": [{
            "metadata": {"uid": "u1", "name": "dispatchx-worker", "creationTimestamp": "2026-10-19T00:00:00Z",
                         "labels": {"kubernetes.io/hostname": "dispatchx-worker"}},
            "status": {"allocatable": {"cpu": "4", "memory": "8146868Ki"},
                       "conditions": [{"type": "Ready", "status": "True"}]}}]},
        "/api/v1/namespaces/dispatchx/pods": {"items": [{
            "metadata": {"name": "api-7d9f-abc", "labels": {"app": "api"}},
            "spec": {"nodeName": "dispatchx-worker", "containers": [
                {"name": "api", "resources": {"requests": {"cpu": "100m", "memory": "256Mi"}}}]},
            "status": {"phase": "Running", "startTime": "2026-10-19T00:01:00Z",
                       "containerStatuses": [{"ready": True}]}}]},
        "/apis/apps/v1/namespaces/dispatchx/deployments": {"items": [{
            "metadata": {"name": "api"}, "spec": {"replicas": 2}, "status": {"replicas": 2, "readyReplicas": 1}}]},
        "/api/v1/namespaces/dispatchx/events": {"items": []},
    }
    monkeypatch.setattr(infra, "_k8s_request", lambda m, p: responses[p])
    monkeypatch.setattr(infra, "_k8s_namespace", lambda: "dispatchx")
    s = infra._k8s_snapshot()
    node = s["nodes"][0]
    assert node["cpu_total"] == 4000 and node["mem_total"] == 7955
    assert node["cpu_used"] == 100 and node["mem_used"] == 256
    assert node["tasks"][0]["service"] == "api" and node["tasks"][0]["health"] == "HEALTHY"
    assert s["services"][0] == {"name": "api", "desired": 2, "running": 1, "pending": 1}

"""Turns a failed deploy into readable GitHub annotations.

Reports the root-cause events from the parent and nested CloudFormation
stacks, why ECS tasks stopped, and the last log lines of each service.
    python infra/scripts/diagnose.py [events|tasks|logs]
"""
import sys
import time
from datetime import datetime, timedelta, timezone

import boto3

STACK = "dispatchx"
CLUSTER = "dispatchx-cluster"
since = datetime.now(timezone.utc) - timedelta(hours=2)
cf = boto3.client("cloudformation")


def annotate(level, title, msg):
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::{level} title={title}::{msg[:1500]}")


def stack_events():
    stacks = []
    paginator = cf.get_paginator("list_stacks")
    for page in paginator.paginate():
        for s in page["StackSummaries"]:
            if (s["StackName"] == STACK or s["StackName"].startswith(f"{STACK}-")) and \
                    s.get("LastUpdatedTime", s["CreationTime"]) > since and "bootstrap" not in s["StackName"]:
                stacks.append(s)
    seen, n = set(), 0
    for s in stacks:
        events = cf.describe_stack_events(StackName=s["StackId"])["StackEvents"]
        for e in events:
            reason = e.get("ResourceStatusReason", "")
            if not e["ResourceStatus"].endswith("FAILED") or e["Timestamp"] < since:
                continue
            # Skip cascade noise; we want the first real error
            if any(x in reason for x in ("Resource creation cancelled", "Resource update cancelled",
                                         "The following resource(s) failed", "Embedded stack")):
                continue
            key = (e["LogicalResourceId"], reason)
            if key in seen:
                continue
            seen.add(key)
            short = s["StackName"].replace(f"{STACK}-", "").split("-")[0]
            annotate("error", f"{short}/{e['LogicalResourceId']} {e['ResourceStatus']}", reason)
            n += 1
            if n >= 9:
                return
    if n == 0:
        print("no failed stack events found")


def stopped_tasks():
    ecs = boto3.client("ecs")
    try:
        arns = ecs.list_tasks(cluster=CLUSTER, desiredStatus="STOPPED")["taskArns"][:20]
    except Exception as e:
        print(f"cluster not available: {e}")
        return
    if not arns:
        print("no stopped tasks")
        return
    seen = set()
    for t in ecs.describe_tasks(cluster=CLUSTER, tasks=arns)["tasks"]:
        group = t.get("group", "?")
        details = "; ".join(f"{c['name']}: exit={c.get('exitCode')} {c.get('reason', '')}" for c in t["containers"])
        msg = f"{t.get('stoppedReason', '')} | {details}"
        if (group, msg) in seen:
            continue
        seen.add((group, msg))
        annotate("error", f"ECS task stopped ({group})", msg)
        if len(seen) >= 8:
            break


def recent_logs():
    logs = boto3.client("logs")
    start = int((time.time() - 1800) * 1000)
    for svc in ("api", "worker", "consumer", "beat", "web", "monitoring"):
        try:
            evs = logs.filter_log_events(logGroupName=f"/{STACK}/{svc}", startTime=start, limit=10000)["events"]
        except Exception:
            continue
        lines = [e["message"] for e in evs][-25:]
        if lines:
            annotate("warning", f"Last log lines: {svc}", "\n".join(lines))


if __name__ == "__main__":
    {"events": stack_events, "tasks": stopped_tasks, "logs": recent_logs}[sys.argv[1]]()

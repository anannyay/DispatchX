"""Generates dashboards/dispatchx.json (run after editing the panel list)."""
import json
from pathlib import Path

PROM = {"type": "prometheus", "uid": "prometheus"}
CW = {"type": "cloudwatch", "uid": "cloudwatch"}
panels, y = [], 0


def stat(title, expr, x, w=4, unit="none", thresholds=None):
    panels.append({
        "type": "stat", "title": title, "datasource": PROM,
        "gridPos": {"x": x, "y": y, "w": w, "h": 4},
        "targets": [{"expr": expr, "refId": "A", "datasource": PROM}],
        "fieldConfig": {"defaults": {"unit": unit, "thresholds": thresholds or {
            "mode": "absolute", "steps": [{"color": "green", "value": None}]}}},
        "options": {"colorMode": "value", "graphMode": "area", "reduceOptions": {"calcs": ["lastNotNull"]}},
    })


def ts(title, targets, x, w=12, h=8, unit="short", ds=PROM):
    panels.append({
        "type": "timeseries", "title": title, "datasource": ds,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": {"defaults": {"unit": unit, "custom": {"lineWidth": 2, "fillOpacity": 10}}},
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}},
    })


def prom(expr, legend, ref):
    return {"expr": expr, "legendFormat": legend, "refId": ref, "datasource": PROM}


def cw(namespace, metric, dims, stat_, ref, label):
    return {"datasource": CW, "refId": ref, "namespace": namespace, "metricName": metric,
            "dimensions": dims, "statistic": stat_, "period": "60", "region": "default",
            "matchExact": True, "metricQueryType": 0, "metricEditorMode": 0, "label": label}


def row(title):
    global y
    panels.append({"type": "row", "title": title, "collapsed": False,
                   "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}})
    y += 1


row("Business")
warn = {"mode": "absolute", "steps": [{"color": "green", "value": None}, {"color": "red", "value": 1}]}
stat("Riders online", 'max(dispatchx_riders{state="online"})', 0)
stat("Riders available", 'max(dispatchx_riders{state="available"})', 4)
stat("Orders / min", "max(rate(dispatchx_orders_created_total[2m])) * 60", 8, unit="short")
stat("Avg assign time", "max(dispatchx_assign_seconds_avg)", 12, unit="s")
stat("SLA breaches", "max(dispatchx_sla_breaches_active)", 16, thresholds=warn)
stat("API tasks up", 'count(up{job="api"} == 1)', 20)
y += 4
ts("Dispatch offers per minute", [
    prom("max(rate(dispatchx_offers_sent_total[2m])) * 60", "sent", "A"),
    prom("max(rate(dispatchx_offers_accepted_total[2m])) * 60", "accepted", "B"),
    prom("max(rate(dispatchx_offers_rejected_total[2m])) * 60", "declined", "C"),
    prom("max(rate(dispatchx_offers_expired_total[2m])) * 60", "expired", "D"),
], 0)
ts("Real-time traffic", [
    prom("max(rate(dispatchx_location_updates_total[1m]))", "GPS pings / s", "A"),
    prom("max(rate(dispatchx_socket_connects_total[5m])) * 60", "socket connects / min", "B"),
], 12)
y += 8

row("API")
ts("Requests / s by status", [
    prom("sum by (status) (rate(http_requests_total[1m]))", "{{status}}", "A"),
], 0, unit="reqps")
ts("p95 latency by endpoint", [
    prom("histogram_quantile(0.95, sum by (le, handler) (rate(http_request_duration_seconds_bucket[5m])))",
         "{{handler}}", "A"),
], 12, unit="s")
y += 8
ts("Requests / s per API task (load balancing)", [
    prom("sum by (instance) (rate(http_requests_total[1m]))", "{{instance}}", "A"),
], 0, w=24, h=7, unit="reqps")
y += 7

row("AWS infrastructure (CloudWatch)")
ts("SQS dispatch backlog", [
    cw("AWS/SQS", "ApproximateNumberOfMessagesVisible", {"QueueName": ["dispatchx-dispatch"]}, "Maximum", "A", "backlog"),
    cw("AWS/SQS", "ApproximateNumberOfMessagesVisible", {"QueueName": ["dispatchx-dispatch-dlq"]}, "Maximum", "B", "DLQ"),
], 0, w=8, ds=CW)
ts("ECS running tasks", [
    cw("ECS/ContainerInsights", "RunningTaskCount", {"ClusterName": ["dispatchx-cluster"], "ServiceName": ["api"]}, "Average", "A", "api"),
    cw("ECS/ContainerInsights", "RunningTaskCount", {"ClusterName": ["dispatchx-cluster"], "ServiceName": ["consumer"]}, "Average", "B", "consumer"),
    cw("ECS/ContainerInsights", "ContainerInstanceCount", {"ClusterName": ["dispatchx-cluster"]}, "Average", "C", "EC2 hosts"),
], 8, w=8, ds=CW)
ts("RDS MySQL CPU %", [
    cw("AWS/RDS", "CPUUtilization", {"DBInstanceIdentifier": ["dispatchx-mysql"]}, "Average", "A", "CPU"),
], 16, w=8, unit="percent", ds=CW)
y += 8

dashboard = {
    "uid": "dispatchx", "title": "DispatchX Live Operations", "tags": ["dispatchx"],
    "timezone": "browser", "refresh": "10s", "time": {"from": "now-30m", "to": "now"},
    "schemaVersion": 39, "panels": [dict(p, id=i + 1) for i, p in enumerate(panels)],
}
out = Path(__file__).parent / "dashboards" / "dispatchx.json"
out.write_text(json.dumps(dashboard, indent=2))
print(f"wrote {out} ({len(panels)} panels)")

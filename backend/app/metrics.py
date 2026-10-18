"""Business metrics for Prometheus. Most live in Redis (shared by every API
and worker instance), so they are read at scrape time by a custom collector.
Every instance reports the same value: aggregate with max() in Grafana."""
from prometheus_client.core import REGISTRY, CounterMetricFamily, GaugeMetricFamily

from app.redis_client import AVAILABLE, ONLINE, metric, r

COUNTERS = {
    "orders_created": "Orders placed",
    "offers_sent": "Job offers sent to riders",
    "offers_accepted": "Job offers accepted",
    "offers_rejected": "Job offers rejected",
    "offers_expired": "Job offers that timed out",
    "orders_unassigned": "Orders dispatch gave up on",
    "location_updates": "Rider GPS pings received",
    "socket_connects": "Socket.IO connections opened",
}


class BusinessCollector:
    def collect(self):
        try:
            for name, doc in COUNTERS.items():
                c = CounterMetricFamily(f"fleetpulse_{name}", doc)
                c.add_metric([], float(r.get(metric(name)) or 0))
                yield c
            g = GaugeMetricFamily("fleetpulse_riders", "Riders by state", labels=["state"])
            g.add_metric(["online"], r.scard(ONLINE))
            g.add_metric(["available"], r.scard(AVAILABLE))
            yield g
            sla = GaugeMetricFamily("fleetpulse_sla_breaches_active", "Active deliveries past SLA")
            sla.add_metric([], float(r.get(metric("sla_breaches_active")) or 0))
            yield sla
            samples = [float(x) for x in r.lrange(metric("assign_seconds"), 0, 99)]
            a = GaugeMetricFamily("fleetpulse_assign_seconds_avg", "Avg seconds from order to rider accept (last 100)")
            a.add_metric([], sum(samples) / len(samples) if samples else 0)
            yield a
        except Exception:
            return


def register():
    REGISTRY.register(BusinessCollector())

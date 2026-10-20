"""Bounded application probes. Unknown is not zero; this is not cloud health."""
import logging
import math
import time
from datetime import datetime, timezone

from sqlalchemy import func, select, text

from app.config import settings
from app.models import Order, OrderStatus, Role
from app.redis_client import AVAILABLE, ONLINE, metric
from app.services import infra

log = logging.getLogger(__name__)
MAINTENANCE_KEY = "ops:maintenance:last_success"


def _samples(values):
    result = []
    for raw in values:
        try:
            value = float(raw)
            if math.isfinite(value) and value >= 0:
                result.append(value)
        except (TypeError, ValueError):
            continue
    return result


def system_snapshot(db, client, user):
    now = time.time()
    can_stop = settings.enable_chaos_tests and user.role == Role.admin
    snapshot = {
        "sampled_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
        "status": "ok", "platform": infra.platform(),
        "dependencies": {name: {"status": "error", "latency_ms": None} for name in ("database", "redis")},
        "fleet": {"online": None, "available": None},
        "orders": {"pending": None, "unassigned": None, "active": None, "oldest_pending_age_seconds": None},
        "queue": {"name": "celery", "ready": None,
                  "scope": "Default Celery ready list only; excludes scheduled/in-flight tasks and AWS SQS queues."},
        "dispatch": {name: None for name in ("offers_sent", "offers_accepted", "offers_rejected", "offers_expired", "assignment_p95_seconds", "samples")},
        "worker": {"last_maintenance_at": None, "age_seconds": None},
        "safeguards": {"idempotent_booking": True, "chaos_enabled": settings.enable_chaos_tests, "can_stop_tasks": can_stop},
        "booking": {"replays": None, "conflicts": None}, "errors": [],
    }
    started = time.perf_counter()
    try:
        db.execute(text("SELECT 1"))
        waiting = (OrderStatus.pending, OrderStatus.unassigned, OrderStatus.assigned, OrderStatus.picked_up)
        counts = dict(db.execute(select(Order.status, func.count(Order.id)).where(Order.status.in_(waiting)).group_by(Order.status)).all())
        oldest = db.scalar(select(func.min(Order.created_at)).where(Order.status == OrderStatus.pending))
        age = max(0.0, now - oldest.replace(tzinfo=timezone.utc).timestamp()) if oldest else None
        snapshot["orders"] = {"pending": counts.get(OrderStatus.pending, 0),
                              "unassigned": counts.get(OrderStatus.unassigned, 0),
                              "active": counts.get(OrderStatus.assigned, 0) + counts.get(OrderStatus.picked_up, 0),
                              "oldest_pending_age_seconds": round(age, 1) if age is not None else None}
        snapshot["dependencies"]["database"] = {"status": "ok", "latency_ms": round((time.perf_counter() - started) * 1000, 2)}
    except Exception:
        db.rollback()
        snapshot["errors"].append("Database probe failed; order measurements are unknown.")
        log.warning("System database probe failed")

    started = time.perf_counter()
    try:
        pipe = client.pipeline(transaction=False)
        pipe.ping()
        pipe.scard(ONLINE)
        pipe.scard(AVAILABLE)
        pipe.llen("celery")
        for name in ("offers_sent", "offers_accepted", "offers_rejected", "offers_expired", "booking_replays", "booking_conflicts"):
            pipe.get(metric(name))
        pipe.lrange(metric("assign_seconds"), 0, 199)
        pipe.get(MAINTENANCE_KEY)
        _, online, available, ready, sent, accepted, rejected, expired, replays, conflicts, samples, maintenance = pipe.execute()
        assignment = sorted(_samples(samples))
        heartbeat = _samples([maintenance])
        heartbeat = heartbeat[0] if heartbeat else None
        snapshot["fleet"] = {"online": int(online), "available": int(available)}
        snapshot["queue"]["ready"] = int(ready)
        snapshot["dispatch"] = {"offers_sent": int(sent or 0), "offers_accepted": int(accepted or 0),
                                "offers_rejected": int(rejected or 0), "offers_expired": int(expired or 0),
                                "assignment_p95_seconds": round(assignment[math.ceil(len(assignment) * .95) - 1], 2) if len(assignment) >= 20 else None,
                                "samples": len(assignment)}
        snapshot["booking"] = {"replays": int(replays or 0), "conflicts": int(conflicts or 0)}
        if heartbeat is not None:
            snapshot["worker"] = {"last_maintenance_at": datetime.fromtimestamp(heartbeat, timezone.utc).isoformat(),
                                  "age_seconds": round(max(0, now - heartbeat), 1)}
        snapshot["dependencies"]["redis"] = {"status": "ok", "latency_ms": round((time.perf_counter() - started) * 1000, 2)}
    except Exception:
        snapshot["errors"].append("Redis probe failed; queue and coordination measurements are unknown.")
        log.warning("System Redis probe failed")
    if snapshot["errors"]:
        snapshot["status"] = "degraded"
    return snapshot

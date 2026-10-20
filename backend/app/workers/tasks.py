import logging
import time
from datetime import timedelta

from app.db import SessionLocal
from app.models import Order, OrderStatus, utcnow
from app.realtime import emit
from app.redis_client import order_offer, r
from app.services import dispatch, handlers
from app.workers.celery_app import celery

log = logging.getLogger(__name__)


@celery.task(name="app.workers.tasks.dispatch_order_task")
def dispatch_order_task(order_id: int):
    return dispatch.dispatch_order(order_id)


@celery.task(name="app.workers.tasks.offer_timeout_task")
def offer_timeout_task(order_id: int, rider_id: int):
    return dispatch.expire_offer(order_id, rider_id)


@celery.task(name="app.workers.tasks.handle_event_task")
def handle_event_task(event: dict):
    handlers.handle_all(event)


@celery.task(name="app.workers.tasks.prune_stale_riders_task")
def prune_stale_riders_task():
    return dispatch.prune_stale_riders()


@celery.task(name="app.workers.tasks.sla_monitor_task")
def sla_monitor_task():
    """Flag deliveries running well past their promised ETA."""
    now = utcnow()
    breaches = []
    with SessionLocal() as db:
        active = db.query(Order).filter(
            Order.status.in_([OrderStatus.assigned, OrderStatus.picked_up])
        ).all()
        for o in active:
            promised = o.created_at + timedelta(minutes=o.eta_minutes * 1.5)
            if now > promised:
                breaches.append(o.id)
                key = f"sla:alerted:{o.id}"
                if r.set(key, "1", nx=True, ex=3600):
                    emit("dispatch:alert", {
                        "order_id": o.id, "level": "warning",
                        "msg": f"Order #{o.id} is past its SLA ({o.eta_minutes:.0f} min promised)",
                    }, "dispatch")
    r.set("metrics:sla_breaches_active", len(breaches))
    # A last-success observation, not a count of healthy workers or an uptime SLA.
    r.set("ops:maintenance:last_success", time.time(), ex=86400)
    return breaches


@celery.task(name="app.workers.tasks.rescue_stuck_orders_task")
def rescue_stuck_orders_task():
    """Safety net: a pending order with no live offer (e.g. a lost message) gets re-dispatched."""
    cutoff = utcnow() - timedelta(seconds=30)
    with SessionLocal() as db:
        stuck = db.query(Order.id).filter(
            Order.status == OrderStatus.pending, Order.created_at < cutoff
        ).all()
    rescued = 0
    for (oid,) in stuck:
        if not r.exists(order_offer(oid)):
            dispatch_order_task.delay(oid)
            rescued += 1
    return rescued

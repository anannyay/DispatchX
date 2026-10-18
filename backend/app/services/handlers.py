"""Consumers of domain events. Called by the SQS consumer in AWS, or by the
Celery `handle_event_task` locally. Handlers must be idempotent because SQS
delivers at-least-once."""
from app.services import notify
from app.services.dispatch import dispatch_order, release_rider


def handle_dispatch(event: dict):
    etype, p = event["event_type"], event["payload"]
    if etype in ("order.created", "order.pending"):
        dispatch_order(p["order_id"])
    elif etype in ("order.delivered", "order.cancelled") and p.get("rider_id"):
        release_rider(p["rider_id"])


def handle_notify(event: dict):
    notify.notify(event)


def handle_all(event: dict):
    handle_dispatch(event)
    handle_notify(event)

"""Customer notifications: in-app (Socket.IO) always, plus email/SMS through
the SNS notifications topic when running in AWS."""
import json
import logging
from functools import lru_cache

import boto3

from app.config import settings
from app.realtime import emit
from app.redis_client import r

log = logging.getLogger(__name__)

MESSAGES = {
    "order.created": ("Order placed", "We're finding a rider for order #{order_id}."),
    "order.assigned": ("Rider assigned", "A rider is on the way to pick up order #{order_id}."),
    "order.picked_up": ("Parcel picked up", "Order #{order_id} has been picked up and is on its way."),
    "order.delivered": ("Delivered", "Order #{order_id} was delivered. Thanks for using DispatchX!"),
    "order.cancelled": ("Order cancelled", "Order #{order_id} was cancelled."),
    "order.unassigned": ("Delay", "We're having trouble finding a rider for order #{order_id}. Our team is on it."),
}


@lru_cache
def sns():
    return boto3.client("sns", region_name=settings.aws_region)


def notify(event: dict):
    etype, p = event["event_type"], event["payload"]
    if etype not in MESSAGES or not p.get("customer_id"):
        return
    title, body = MESSAGES[etype]
    body = body.format(**p)
    note = {"title": title, "body": body, "order_id": p.get("order_id"), "at": event["occurred_at"]}

    key = f"notifications:{p['customer_id']}"
    r.lpush(key, json.dumps(note))
    r.ltrim(key, 0, 49)
    emit("notification", note, f"user:{p['customer_id']}")

    if settings.notify_topic_arn and etype in ("order.assigned", "order.delivered", "order.unassigned"):
        sns().publish(
            TopicArn=settings.notify_topic_arn,
            Subject=f"DispatchX: {title}"[:100],
            Message=body,
            MessageAttributes={
                "event_type": {"DataType": "String", "StringValue": etype},
                "customer_id": {"DataType": "String", "StringValue": str(p["customer_id"])},
            },
        )
    log.info("notified customer %s: %s", p["customer_id"], title)

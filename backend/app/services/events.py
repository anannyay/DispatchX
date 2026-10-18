"""Domain event bus.

In AWS every event is published to the SNS `order-events` topic, which fans
out to SQS queues (dispatch, notify, analytics) using subscription filter
policies on the `event_type` attribute. Locally (no SNS configured) events
are handed to a Celery task that calls the same handlers in-process.
"""
import json
import logging
from datetime import datetime, timezone
from functools import lru_cache

import boto3

from app.config import settings

log = logging.getLogger(__name__)


@lru_cache
def sns():
    return boto3.client("sns", region_name=settings.aws_region)


def publish(event_type: str, payload: dict):
    event = {
        "event_type": event_type,
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    if settings.sns_topic_arn:
        sns().publish(
            TopicArn=settings.sns_topic_arn,
            Message=json.dumps(event, default=str),
            MessageAttributes={"event_type": {"DataType": "String", "StringValue": event_type}},
        )
    else:
        from app.workers.tasks import handle_event_task

        handle_event_task.delay(event)
    log.info("event published %s %s", event_type, payload.get("order_id"))

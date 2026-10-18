"""Long-polls the SQS queues that SNS fans out to and runs the matching handler.

    python -m app.workers.sqs_consumer

Messages are deleted only after the handler succeeds; failures become visible
again and, after maxReceiveCount attempts, land in the queue's DLQ.
"""
import json
import logging
import signal
import threading

import boto3

from app.config import settings
from app.services import handlers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("sqs-consumer")

running = True


def _stop(*_):
    global running
    running = False
    log.info("shutting down after current batch")


def unwrap(body: str) -> dict:
    """SNS -> SQS wraps the event in an envelope unless raw delivery is enabled."""
    msg = json.loads(body)
    if "Message" in msg and "TopicArn" in msg:
        msg = json.loads(msg["Message"])
    return msg


def poll(queue_url: str, handler, name: str):
    sqs = boto3.client("sqs", region_name=settings.aws_region)
    log.info("polling %s", name)
    while running:
        resp = sqs.receive_message(
            QueueUrl=queue_url, MaxNumberOfMessages=10, WaitTimeSeconds=20, VisibilityTimeout=60,
        )
        for m in resp.get("Messages", []):
            try:
                event = unwrap(m["Body"])
                handler(event)
                sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=m["ReceiptHandle"])
            except Exception:
                log.exception("%s: failed to process message %s", name, m.get("MessageId"))


def main():
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    queues = [
        (settings.sqs_dispatch_queue_url, handlers.handle_dispatch, "dispatch"),
        (settings.sqs_notify_queue_url, handlers.handle_notify, "notify"),
    ]
    threads = [threading.Thread(target=poll, args=q, daemon=True) for q in queues if q[0]]
    if not threads:
        raise SystemExit("No SQS queue URLs configured")
    for t in threads:
        t.start()
    for t in threads:
        t.join()


if __name__ == "__main__":
    main()

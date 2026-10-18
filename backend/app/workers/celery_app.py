from celery import Celery

from app.config import settings

celery = Celery("dispatchx", broker=settings.redis_url, backend=None, include=["app.workers.tasks"])
celery.conf.update(
    task_acks_late=True,                 # re-run tasks if a worker dies mid-task
    worker_prefetch_multiplier=1,
    task_ignore_result=True,
    broker_connection_retry_on_startup=True,
    timezone="UTC",
    beat_schedule={
        "sla-monitor": {"task": "app.workers.tasks.sla_monitor_task", "schedule": 30.0},
        "prune-stale-riders": {"task": "app.workers.tasks.prune_stale_riders_task", "schedule": 60.0},
        "rescue-stuck-orders": {"task": "app.workers.tasks.rescue_stuck_orders_task", "schedule": 45.0},
    },
)

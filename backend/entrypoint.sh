#!/bin/sh
# One image, several roles: api | worker | beat | consumer | migrate | seed
set -e
case "$1" in
  api)
    alembic upgrade head
    exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers \
      --forwarded-allow-ips='*' --workers "${UVICORN_WORKERS:-1}"
    ;;
  worker)
    exec celery -A app.workers.celery_app worker --loglevel=INFO \
      --pool="${CELERY_POOL:-prefork}" --concurrency="${CELERY_CONCURRENCY:-4}"
    ;;
  beat)
    exec celery -A app.workers.celery_app beat --loglevel=INFO --schedule=/tmp/celerybeat-schedule
    ;;
  consumer)
    exec python -m app.workers.sqs_consumer
    ;;
  migrate)
    exec alembic upgrade head
    ;;
  seed)
    alembic upgrade head
    shift
    exec python -m app.seed "$@"
    ;;
  *)
    exec "$@"
    ;;
esac

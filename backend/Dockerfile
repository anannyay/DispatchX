FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .
RUN useradd -r -u 1001 app && chmod +x entrypoint.sh \
    && mkdir -p /tmp/fleetpulse-uploads && chown app /tmp/fleetpulse-uploads
USER app

EXPOSE 8000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["api"]

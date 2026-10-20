"""Bounded real-Redis fleet read benchmark; refuses shared/nonempty test databases.

Run in a local backend container with this file mounted at /app/tests. Use the
same image/config/data and repetitions for both revisions. No HTTP/cloud claims.
"""
import argparse
import hashlib
import json
import math
import platform
import statistics
import time
from urllib.parse import urlparse

import redis

from app.redis_client import AVAILABLE, ONLINE, rider_offer, rider_state
from app.models import Role, User
from app.routers import admin


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--redis-url", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--riders", type=int, default=500)
    parser.add_argument("--repetitions", type=int, default=15)
    args = parser.parse_args()
    target = urlparse(args.redis_url)
    if target.hostname not in {"localhost", "127.0.0.1", "redis"} or target.path in {"", "/", "/0"}:
        parser.error("Only a non-default local Redis database is allowed")
    if not 1 <= args.riders <= 1000 or not 3 <= args.repetitions <= 30:
        parser.error("Bounded workload: 1-1000 riders, 3-30 repetitions")
    client = redis.Redis.from_url(args.redis_url, decode_responses=True)
    if client.dbsize():
        parser.error("The test Redis database must be empty; nothing was changed")
    owned = [ONLINE, AVAILABLE]
    seed = client.pipeline(transaction=False)
    now = time.time()
    for index in range(args.riders):
        rid = 8_000_000 + index
        state, offer = rider_state(rid), rider_offer(rid)
        owned.extend([state, offer])
        seed.sadd(ONLINE, rid)
        if index % 2 == 0:
            seed.sadd(AVAILABLE, rid)
        seed.hset(state, mapping={"name": f"Benchmark rider {index}", "lat": 12.97,
                  "lng": 77.59, "heading": index % 360, "ts": now,
                  "rating": 4.8, "vehicle": "bike", "order_id": ""})
        if index % 10 == 0:
            seed.set(offer, 42)
    previous = admin.r
    try:
        seed.execute()
        admin.r = client
        rounds = [0]
        execute, pipeline = client.execute_command, client.pipeline

        def counted_execute(*values, **options):
            rounds[0] += 1
            return execute(*values, **options)

        def counted_pipeline(*values, **options):
            batch = pipeline(*values, **options)
            run = batch.execute

            def counted_run(*values, **options):
                rounds[0] += 1
                return run(*values, **options)

            batch.execute = counted_run
            return batch

        client.execute_command, client.pipeline = counted_execute, counted_pipeline
        staff = User(id=0, role=Role.dispatcher, name="Benchmark", email="benchmark@example.invalid", password_hash="unused")
        for _ in range(3):
            admin.fleet(staff)
        samples, calls = [], []
        rows = []
        started = time.monotonic()
        for _ in range(args.repetitions):
            rounds[0] = 0
            before = time.perf_counter()
            rows = admin.fleet(staff)
            samples.append(round((time.perf_counter() - before) * 1000, 3))
            calls.append(rounds[0])
            assert len(rows) == args.riders
            assert all(isinstance(row["available"], bool) for row in rows)
            if time.monotonic() - started > 45:
                raise TimeoutError("Benchmark exceeded its 45-second measurement budget")
        stable = sorted(({k: v for k, v in row.items() if k != "last_seen_s"} for row in rows), key=lambda row: row["rider_id"])
        print(json.dumps({"label": args.label, "python": platform.python_version(),
              "architecture": platform.machine(), "redis_version": client.info("server")["redis_version"],
              "riders": args.riders, "warmup": 3, "repetitions": args.repetitions,
              "samples_ms": samples, "median_ms": round(statistics.median(samples), 3),
              "p95_ms": sorted(samples)[math.ceil(len(samples) * .95) - 1],
              "client_round_trips": calls,
              "payload_fingerprint": hashlib.sha256(json.dumps(stable, sort_keys=True).encode()).hexdigest()}, indent=2))
    finally:
        admin.r = previous
        # Delete only keys this benchmark created, never FLUSHDB or live DB 0.
        client.delete(*owned)
        client.close()


if __name__ == "__main__":
    main()

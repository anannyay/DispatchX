"""Explicit, bounded local integration check. Creates/cancels only its own orders.

Requires the seeded local MySQL/Redis demo. Never use a public deployment.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import threading
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from sqlalchemy import func, select, text

from app.db import SessionLocal
from app.models import BookingIdentity, Order, OrderEvent, OrderStatus
from app.redis_client import order_offer, r, rider_offer
from app.services.dispatch import OfferError, accept_offer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://api:8000")
    parser.add_argument("--allow-local-mutations", action="store_true", required=True)
    args = parser.parse_args()
    assert urlparse(args.base_url).hostname in {"api", "localhost", "127.0.0.1"}, "Local API only"
    with SessionLocal() as db:
        assert db.bind.dialect.name == "mysql", "This check specifically requires real MySQL"
        print("MySQL isolation:", db.scalar(text("SELECT @@transaction_isolation")))
    client = httpx.Client(base_url=args.base_url, timeout=20, limits=httpx.Limits(max_connections=25))
    created = []
    credentials = {}

    def login(email):
        response = client.post("/api/auth/login", json={"email": email, "password": "dispatchx123"})
        response.raise_for_status()
        data = response.json()
        return {"Authorization": f"Bearer {data['access_token']}"}

    def create(headers, payload, key=None):
        response = client.post("/api/orders", json=payload, headers={**headers, **({"Idempotency-Key": key} if key else {})})
        assert response.status_code == 201, response.status_code
        oid = response.json()["id"]
        credentials[oid] = headers
        created.append(oid)
        return oid

    customer = login("customer@dispatchx.dev")
    key = f"local-concurrency-{uuid4().hex}"
    body = {"pickup": {"address": "Local concurrency pickup", "lat": 0, "lng": 0},
            "drop": {"address": "Local concurrency drop", "lat": .001, "lng": .001}, "package_note": key}
    try:
        barrier = threading.Barrier(20)

        def retry(_):
            barrier.wait(timeout=10)
            return create(customer, body, key)

        with ThreadPoolExecutor(max_workers=20) as pool:
            ids = list(pool.map(retry, range(20)))
        assert len(set(ids)) == 1, ids
        oid = ids[0]
        with SessionLocal() as db:
            assert db.scalar(select(func.count(Order.id)).where(Order.package_note == key)) == 1
            assert db.scalar(select(func.count(BookingIdentity.order_id)).where(BookingIdentity.order_id == oid)) == 1
            assert db.scalar(select(func.count(OrderEvent.id)).where(OrderEvent.order_id == oid, OrderEvent.type == "status.pending")) == 1
        assert create(customer, body, key) == oid
        conflict = client.post("/api/orders", json={**body, "package_note": "changed payload"}, headers={**customer, "Idempotency-Key": key})
        assert conflict.status_code == 409
        other = login("customer1@sim.dispatchx.dev")
        assert create(other, body, key) != oid
        assert create(customer, body) != create(customer, body)
        print("PASS 20 concurrent identical keyed requests → one persisted order, identity and initial audit")
        print("PASS replay, changed-payload conflict, customer scope and unkeyed compatibility")

        registration = client.post("/api/auth/register", json={"name": "Concurrency test rider", "email": f"race-{uuid4().hex}@sim.dispatchx.dev", "password": "Local-fixture-123", "role": "rider"})
        registration.raise_for_status()
        rid = registration.json()["user"]["id"]
        pair = [create(customer, {**body, "package_note": key + ":rider-race"}) for _ in range(2)]
        for order_id in pair:
            r.set(order_offer(order_id), rid, ex=30)
        gate = threading.Barrier(2)

        def claim(order_id):
            with SessionLocal() as db:
                gate.wait(timeout=10)
                try:
                    return accept_offer(db, order_id, rid).id
                except OfferError as exc:
                    assert str(exc) == "Rider already has an active order", str(exc)
                    return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            winners = [value for value in pool.map(claim, pair) if value is not None]
        assert len(winners) == 1, winners
        with SessionLocal() as db:
            assert db.scalar(select(func.count(Order.id)).where(Order.rider_id == rid, Order.status.in_([OrderStatus.assigned, OrderStatus.picked_up]))) == 1
        r.delete(*(order_offer(order_id) for order_id in pair), rider_offer(rid))
        print("PASS two simultaneous assignments to one rider → one active order under real InnoDB locking")

        staff = login("dispatch@dispatchx.dev")
        administrator = login("admin@dispatchx.dev")
        snapshot = client.get("/api/admin/system", headers=staff)
        snapshot.raise_for_status()
        assert snapshot.json()["status"] == "ok"
        assert snapshot.json()["safeguards"]["chaos_enabled"] is False
        assert client.post("/api/admin/infra/tasks/invalid!fixture/stop", headers=staff).status_code == 403
        assert client.post("/api/admin/infra/tasks/invalid!fixture/stop", headers=administrator).status_code == 403
        assert client.get("/api/admin/system", headers=customer).status_code == 403
        print("PASS live system measurements and default-deny chaos authorization (no stop call executed)")
    finally:
        for order_id in set(created):
            response = client.post(f"/api/orders/{order_id}/cancel", headers=credentials[order_id])
            if response.status_code not in (200, 409):
                print(f"Cleanup warning: order {order_id}, HTTP {response.status_code}")
        client.close()


if __name__ == "__main__":
    main()

"""Booking API checks with real SQLite transactions and mocked external effects.

SQLite exercises unique-constraint races, but does not emulate InnoDB snapshots.
Also run simultaneous HTTP requests against MySQL REPEATABLE READ before shipping.
"""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base, get_db
from app.models import BookingIdentity, Order, OrderEvent, Role, User
from app.routers import orders
from app.security import create_access_token
from app.services import booking
from app.services import orders as order_service

KEY = "booking-test:0001"
PAYLOAD = {
    "pickup": {"address": "Pickup", "lat": 12.97, "lng": 77.59},
    "drop": {"address": "Drop", "lat": 12.98, "lng": 77.60},
    "package_note": "Handle carefully",
}


def headers(customer_id: int = 1, key: str | None = KEY):
    result = {"Authorization": f"Bearer {create_access_token(customer_id, 'customer')}"}
    if key is not None:
        result["Idempotency-Key"] = key
    return result


@pytest.fixture
def api(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'booking.db'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    class TestSession(Session):
        pass

    sessions = sessionmaker(bind=engine, class_=TestSession, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with sessions() as db:
        db.add_all([
            User(id=1, name="Customer One", email="one@example.com", password_hash="unused", role=Role.customer),
            User(id=2, name="Customer Two", email="two@example.com", password_hash="unused", role=Role.customer),
            User(id=3, name="Rider", email="rider@example.com", password_hash="unused", role=Role.rider),
        ])
        db.commit()

    def test_db():
        with sessions() as db:
            yield db

    app = FastAPI()
    app.include_router(orders.router, prefix="/api")
    app.dependency_overrides[get_db] = test_db
    redis = Mock()
    broadcast = Mock()
    publish = Mock()
    monkeypatch.setattr(orders, "r", redis)
    monkeypatch.setattr(orders, "broadcast", broadcast)
    monkeypatch.setattr(order_service, "broadcast", broadcast)
    monkeypatch.setattr(orders.events, "publish", publish)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield SimpleNamespace(
            client=client, sessions=sessions, session_class=TestSession,
            redis=redis, broadcast=broadcast, publish=publish, engine=engine,
        )
    engine.dispose()


def counts(api):
    with api.sessions() as db:
        return tuple(db.query(model).count() for model in (Order, BookingIdentity, OrderEvent))


def test_creation_persists_identity_order_and_audit_before_publish(api):
    def published(event_type, payload):
        assert event_type == "order.created"
        # An independent connection must see all three writes at publication time.
        assert counts(api) == (1, 1, 1)
        with api.sessions() as db:
            order = db.get(Order, payload["order_id"])
            identity = db.get(BookingIdentity, order.id)
            audit = db.query(OrderEvent).one()
            assert identity.customer_id == order.customer_id == 1
            assert identity.key_hash == hashlib.sha256(KEY.encode("ascii")).hexdigest()
            assert len(identity.request_fingerprint) == 64
            assert audit.order_id == order.id
            assert audit.type == "status.pending"
            assert audit.data["actor"] == "customer:1"

    api.publish.side_effect = published
    response = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert response.status_code == 201, response.text
    assert response.json()["customer_id"] == 1
    assert response.json()["status"] == "pending"
    assert "key_hash" not in response.json()
    assert KEY not in response.text
    assert KEY not in repr(api.redis.mock_calls + api.broadcast.mock_calls + api.publish.mock_calls)
    api.redis.incr.assert_called_once_with("metrics:orders_created")
    api.broadcast.assert_called_once()
    api.publish.assert_called_once()
    readback = api.client.get(f"/api/orders/{response.json()['id']}", headers=headers(key=None))
    assert readback.status_code == 200
    assert readback.json() == response.json()


def test_sequential_retry_uses_persisted_identity_without_requoting(api, monkeypatch):
    original = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert original.status_code == 201
    # New request sessions / connections must recover the booking from the DB.
    api.engine.dispose()
    monkeypatch.setattr(booking, "quote", Mock(side_effect=AssertionError("must not requote a replay")))
    replay = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert replay.status_code == 201, replay.text
    assert replay.json() == original.json()
    assert counts(api) == (1, 1, 1)
    api.broadcast.assert_called_once()
    api.publish.assert_called_once()
    api.redis.incr.assert_any_call("metrics:booking_replays")


def test_replay_returns_current_order_with_original_identity(api):
    original = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert original.status_code == 201
    # Use the real lifecycle route rather than mutating order status directly.
    api.redis.get.return_value = None
    cancelled = api.client.post(f"/api/orders/{original.json()['id']}/cancel", headers=headers())
    assert cancelled.status_code == 200
    api.broadcast.reset_mock()
    api.publish.reset_mock()
    replay = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert replay.status_code == 201
    assert replay.json()["id"] == original.json()["id"]
    assert replay.json()["status"] == "cancelled"
    assert counts(api) == (1, 1, 2)
    api.broadcast.assert_not_called()
    api.publish.assert_not_called()


@pytest.mark.parametrize("change", [
    {"package_note": "Different note"},
    {"package_note": None},
    {"pickup": {**PAYLOAD["pickup"], "address": "Different pickup"}},
    {"pickup": {**PAYLOAD["pickup"], "lat": 12.971}},
    {"pickup": {**PAYLOAD["pickup"], "lng": 77.591}},
    {"drop": {**PAYLOAD["drop"], "address": "Different drop"}},
    {"drop": {**PAYLOAD["drop"], "lat": 12.981}},
    {"drop": {**PAYLOAD["drop"], "lng": 77.601}},
])
def test_changed_payload_conflicts_without_side_effects(api, change):
    original = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert original.status_code == 201
    conflict = api.client.post("/api/orders", headers=headers(), json={**PAYLOAD, **change})
    assert conflict.status_code == 409
    assert KEY not in conflict.text
    assert counts(api) == (1, 1, 1)
    api.broadcast.assert_called_once()
    api.publish.assert_called_once()
    api.redis.incr.assert_any_call("metrics:booking_conflicts")
    replay = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert replay.json()["id"] == original.json()["id"]


def test_fingerprint_canonicalizes_field_order_defaults_and_coordinates(api):
    payload = {
        "pickup": {"address": "Café pickup", "lat": 0, "lng": 0},
        "drop": {"address": "Drop", "lat": 0.01, "lng": 0.01},
    }
    original = api.client.post("/api/orders", headers=headers(), json=payload)
    equivalent = {
        "package_note": None,
        "drop": {"lng": 0.01, "lat": 0.01, "address": "Drop"},
        "pickup": {"lng": -0.0, "address": "Café pickup", "lat": 0.0},
    }
    replay = api.client.post("/api/orders", headers=headers(), json=equivalent)
    assert original.status_code == replay.status_code == 201
    assert replay.json()["id"] == original.json()["id"]
    assert counts(api) == (1, 1, 1)


def test_same_key_is_scoped_to_customer(api):
    first = api.client.post("/api/orders", headers=headers(1), json=PAYLOAD)
    second = api.client.post("/api/orders", headers=headers(2), json={**PAYLOAD, "package_note": "Customer two"})
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    assert second.json()["customer_id"] == 2
    assert counts(api) == (2, 2, 2)
    replay = api.client.post("/api/orders", headers=headers(1), json=PAYLOAD)
    assert replay.json()["id"] == first.json()["id"]


def test_different_and_case_distinct_keys_create_new_bookings(api):
    keys = ["Booking-Key:1", "booking-key:1", "booking-key:2"]
    responses = [api.client.post("/api/orders", headers=headers(key=key), json=PAYLOAD) for key in keys]
    assert all(response.status_code == 201 for response in responses)
    assert len({response.json()["id"] for response in responses}) == 3
    assert counts(api) == (3, 3, 3)


def test_missing_key_retains_non_idempotent_behavior(api):
    first = api.client.post("/api/orders", headers=headers(key=None), json=PAYLOAD)
    second = api.client.post("/api/orders", headers=headers(key=None), json=PAYLOAD)
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    assert counts(api) == (2, 0, 2)
    assert api.broadcast.call_count == api.publish.call_count == 2


@pytest.mark.parametrize("key", ["a" * 8, "Z" * 128, "azAZ09._:-"])
def test_key_boundaries_and_safe_characters(api, key):
    response = api.client.post("/api/orders", headers=headers(key=key), json=PAYLOAD)
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("key", [
    "", "short", "a" * 7, "a" * 129, "has space", " trailing", "trailing ",
    "tab\tinside", "line\nbreak", "line\rbreak", "null\x00byte", "delete\x7fbyte",
    "comma,key", 'quoted"key', "slash/key", "é" * 8,
])
def test_invalid_key_is_rejected_without_persistence(api, key):
    # Byte header values let the ASGI client exercise non-ASCII and controls.
    request_headers = [(b"authorization", headers()["Authorization"].encode()),
                       (b"idempotency-key", key.encode("utf-8"))]
    response = api.client.post("/api/orders", headers=request_headers, json=PAYLOAD)
    assert response.status_code == 422, response.text
    assert response.json() == {"detail": booking.INVALID_KEY_DETAIL}
    assert counts(api) == (0, 0, 0)
    api.broadcast.assert_not_called()
    api.publish.assert_not_called()
    api.redis.incr.assert_not_called()


def test_duplicate_header_is_rejected(api):
    request_headers = list(headers().items()) + [("Idempotency-Key", "another-key")]
    response = api.client.post("/api/orders", headers=request_headers, json=PAYLOAD)
    assert response.status_code == 422
    assert counts(api) == (0, 0, 0)


def test_invalid_payload_and_distance_do_not_reserve_key(api):
    invalid = api.client.post("/api/orders", headers=headers(), json={})
    assert invalid.status_code == 422
    far = {**PAYLOAD, "drop": {"address": "Too far", "lat": 0, "lng": 0}}
    rejected = api.client.post("/api/orders", headers=headers(), json=far)
    assert rejected.status_code == 422
    assert counts(api) == (0, 0, 0)
    accepted = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert accepted.status_code == 201
    assert counts(api) == (1, 1, 1)


def test_authentication_and_customer_authorization_still_apply(api):
    assert api.client.post("/api/orders", json=PAYLOAD).status_code == 401
    assert api.client.post("/api/orders", headers=headers(3), json=PAYLOAD).status_code == 403
    assert counts(api) == (0, 0, 0)


@pytest.mark.parametrize("changed", [False, True])
def test_unique_collision_rolls_back_before_rereading_winner(api, monkeypatch, changed):
    original = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert original.status_code == 201
    real_replay = booking._replay
    calls = []

    def stale_then_fresh(db, customer_id, key_hash, fingerprint):
        calls.append(db.get_transaction())
        if len(calls) == 1:
            # Emulate a pre-winner snapshot. The real INSERT below must hit the
            # DB unique constraint, then reset the full transaction to reread.
            assert db.get_transaction() is not None  # authentication read
            return None
        assert len(calls) == 2
        assert db.get_transaction() is None
        assert db.is_active
        return real_replay(db, customer_id, key_hash, fingerprint)

    monkeypatch.setattr(booking, "_replay", stale_then_fresh)
    payload = {**PAYLOAD, "package_note": "Changed"} if changed else PAYLOAD
    response = api.client.post("/api/orders", headers=headers(), json=payload)
    assert response.status_code == (409 if changed else 201), response.text
    if not changed:
        assert response.json()["id"] == original.json()["id"]
    assert len(calls) == 2
    assert counts(api) == (1, 1, 1)
    api.publish.assert_called_once()
    api.broadcast.assert_called_once()


@pytest.mark.parametrize("changed", [False, True])
def test_concurrent_requests_converge_on_one_order(api, monkeypatch, changed):
    requests = 2 if changed else 8
    barrier = Barrier(requests)
    real_replay = booking._replay

    def simultaneous_lookup(db, customer_id, key_hash, fingerprint):
        result = real_replay(db, customer_id, key_hash, fingerprint)
        if not db.info.get("initial_lookup_finished"):
            db.info["initial_lookup_finished"] = True
            assert result is None
            barrier.wait(timeout=20)
        return result

    monkeypatch.setattr(booking, "_replay", simultaneous_lookup)

    def post(index):
        payload = {**PAYLOAD, "package_note": f"Changed {index}"} if changed else PAYLOAD
        return api.client.post("/api/orders", headers=headers(), json=payload)

    with ThreadPoolExecutor(max_workers=requests) as pool:
        responses = list(pool.map(post, range(requests)))
    assert sorted(response.status_code for response in responses) == ([201, 409] if changed else [201] * requests)
    assert len({response.json()["id"] for response in responses if response.status_code == 201}) == 1
    assert counts(api) == (1, 1, 1)
    api.publish.assert_called_once()
    api.broadcast.assert_called_once()


@pytest.mark.parametrize("failure,key", [
    ("audit", KEY), ("audit", None), ("commit", KEY), ("commit", None), ("identity", KEY),
])
def test_transaction_failure_rolls_back_every_write_and_key_is_retryable(api, monkeypatch, key, failure):
    with monkeypatch.context() as patch:
        if failure == "audit":
            real_log = booking.log_event

            def broken_audit(db, order_id, type_, data):
                real_log(db, order_id, type_, data)
                db.flush()  # Prove rollback includes an already-inserted audit.
                raise RuntimeError("injected audit failure")

            patch.setattr(booking, "log_event", broken_audit)
        elif failure == "commit":
            def broken_commit(db):
                db.flush()
                raise OperationalError("COMMIT", {}, RuntimeError("injected commit failure"))

            patch.setattr(api.session_class, "commit", broken_commit)
        else:
            real_flush = api.session_class.flush

            def broken_identity(db, *args, **kwargs):
                if any(isinstance(obj, BookingIdentity) for obj in db.new):
                    raise IntegrityError("INSERT", {}, RuntimeError("unrelated integrity failure"))
                return real_flush(db, *args, **kwargs)

            patch.setattr(api.session_class, "flush", broken_identity)

        response = api.client.post("/api/orders", headers=headers(key=key), json=PAYLOAD)
        assert response.status_code == 500

    assert counts(api) == (0, 0, 0)
    api.publish.assert_not_called()
    api.broadcast.assert_not_called()
    api.redis.incr.assert_not_called()
    retry = api.client.post("/api/orders", headers=headers(key=key), json=PAYLOAD)
    assert retry.status_code == 201, retry.text
    assert counts(api) == (1, int(key is not None), 1)


def test_redis_counter_failure_does_not_change_booking_results(api):
    api.redis.incr.side_effect = RedisConnectionError("counter unavailable")
    created = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    replay = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    conflict = api.client.post("/api/orders", headers=headers(), json={**PAYLOAD, "package_note": "Changed"})
    assert created.status_code == replay.status_code == 201
    assert created.json()["id"] == replay.json()["id"]
    assert conflict.status_code == 409
    assert counts(api) == (1, 1, 1)
    api.publish.assert_called_once()
    api.broadcast.assert_called_once()


@pytest.mark.parametrize("effect", ["broadcast", "publish"])
def test_post_commit_side_effect_failure_does_not_create_or_publish_on_retry(api, effect):
    getattr(api, effect).side_effect = RuntimeError("injected post-commit failure")
    failed = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert failed.status_code == 500
    assert counts(api) == (1, 1, 1)
    with api.sessions() as db:
        original_id = db.query(Order).one().id
    api.broadcast.reset_mock(side_effect=True)
    api.publish.reset_mock(side_effect=True)
    replay = api.client.post("/api/orders", headers=headers(), json=PAYLOAD)
    assert replay.status_code == 201
    assert replay.json()["id"] == original_id
    assert counts(api) == (1, 1, 1)
    # Documents the remaining commit/publish gap; replay is not event repair.
    api.broadcast.assert_not_called()
    api.publish.assert_not_called()

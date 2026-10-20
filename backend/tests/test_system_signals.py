from datetime import timedelta
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.config import settings
from app.db import Base
from app.deps import get_current_user
from app.models import Order, OrderStatus, Role, User, utcnow
from app.routers import admin
from app.services.operations import system_snapshot


class ProbeRedis:
    def __init__(self, fail=False):
        self.commands = []
        self.fail = fail

    def pipeline(self, transaction):
        assert transaction is False
        return self

    def __getattr__(self, name):
        def enqueue(*args):
            self.commands.append((name, args))
            return self
        return enqueue

    def execute(self):
        if self.fail:
            raise RedisConnectionError("private endpoint details must not escape")
        return [True, 12, 8, 3, "30", "24", "2", "4", "7", "1", [str(n) for n in range(1, 21)], None]


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(User(id=1, name="Fixture", email="fixture@example.invalid", password_hash="unused", role=Role.customer))
        for state in [OrderStatus.pending, OrderStatus.assigned, OrderStatus.picked_up, OrderStatus.delivered]:
            session.add(Order(customer_id=1, status=state, pickup_address="Pickup", drop_address="Drop",
                              pickup_lat=12.97, pickup_lng=77.59, drop_lat=12.98, drop_lng=77.60,
                              distance_km=1, price=42, eta_minutes=3, created_at=utcnow() - timedelta(seconds=60)))
        session.commit()
        yield session
    engine.dispose()


def test_system_measurements_are_bounded_and_have_explicit_scope(db, monkeypatch):
    monkeypatch.setattr(settings, "enable_chaos_tests", False)
    client = ProbeRedis()
    snap = system_snapshot(db, client, User(role=Role.dispatcher))
    assert snap["status"] == "ok"
    assert snap["orders"]["pending"] == 1 and snap["orders"]["active"] == 2
    assert snap["orders"]["oldest_pending_age_seconds"] >= 59
    assert snap["queue"]["ready"] == 3 and "SQS" in snap["queue"]["scope"]
    assert snap["dispatch"]["assignment_p95_seconds"] == 19
    assert snap["booking"] == {"replays": 7, "conflicts": 1}
    assert snap["worker"]["age_seconds"] is None
    assert snap["safeguards"]["can_stop_tasks"] is False
    assert len(client.commands) == 12
    assert ("lrange", ("metrics:assign_seconds", 0, 199)) in client.commands


def test_redis_failure_is_unknown_not_zero_and_does_not_hide_database(db):
    snap = system_snapshot(db, ProbeRedis(fail=True), User(role=Role.dispatcher))
    assert snap["status"] == "degraded"
    assert snap["dependencies"]["database"]["status"] == "ok"
    assert snap["queue"]["ready"] is None and snap["fleet"]["online"] is None
    assert "private endpoint" not in str(snap)


def test_database_failure_does_not_hide_redis_or_leak_errors():
    db = Mock()
    db.execute.side_effect = RuntimeError("private database details")
    snap = system_snapshot(db, ProbeRedis(), User(role=Role.admin))
    assert snap["status"] == "degraded"
    assert snap["orders"]["pending"] is None
    assert snap["dependencies"]["redis"]["status"] == "ok"
    assert "private database" not in str(snap)
    db.rollback.assert_called_once()


@pytest.mark.parametrize("role,enabled,status", [
    (Role.customer, True, 403), (Role.rider, True, 403),
    (Role.dispatcher, False, 403), (Role.dispatcher, True, 403),
    (Role.admin, False, 403), (Role.admin, True, 200),
])
def test_chaos_requires_both_admin_and_explicit_opt_in(monkeypatch, role, enabled, status):
    monkeypatch.setattr(settings, "enable_chaos_tests", enabled)
    stop = Mock()
    monkeypatch.setattr(admin.infra, "stop", stop)
    app = FastAPI()
    app.include_router(admin.router)
    app.dependency_overrides[get_current_user] = lambda: User(id=1, role=role, email="fixture@example.invalid")
    with TestClient(app) as client:
        response = client.post("/admin/infra/tasks/safe-fixture/stop")
    assert response.status_code == status
    assert stop.call_count == (1 if status == 200 else 0)


def test_infra_capabilities_are_per_user_and_do_not_mutate_cached_snapshot(monkeypatch):
    monkeypatch.setattr(settings, "enable_chaos_tests", True)
    cached = {"platform": "ecs", "nodes": [], "services": [], "events": []}
    monkeypatch.setattr(admin.infra, "snapshot", lambda: cached)
    assert admin.infrastructure(User(role=Role.admin))["capabilities"]["can_stop_tasks"] is True
    assert admin.infrastructure(User(role=Role.dispatcher))["capabilities"]["can_stop_tasks"] is False
    assert "capabilities" not in cached

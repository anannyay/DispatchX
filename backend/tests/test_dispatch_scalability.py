"""Bounded matching and dispatch concurrency regressions.

The default suite uses deterministic Redis doubles and a disposable SQLite DB.
SQL compilation checks the MySQL locking protocol; SQLite does not prove row
lock contention. Set DISPATCH_TEST_REDIS_URL to an isolated Redis to additionally
execute the actual Lua scripts (only uniquely prefixed test keys are touched).
"""
import os
import random
from collections import defaultdict
from typing import cast
from unittest.mock import Mock
from uuid import uuid4

import pytest
import redis
from sqlalchemy import create_engine, event
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import Order, OrderEvent, OrderStatus, RiderProfile, Role, User
from app.services import dispatch


class MemoryRedis:
    """Command-counting double; real Lua execution is tested separately below."""

    def __init__(self, hits=()):
        self.hits = list(hits)
        self.values = {}
        self.sets = defaultdict(set)
        self.hashes = defaultdict(dict)
        self.lists = defaultdict(list)
        self.round_trips = 0
        self.batches = []
        self.set_calls = []
        self.eval_calls = []
        self.before_eval = None

    def geosearch(self, key, **kwargs):
        self.round_trips += 1
        self.geo_args = (key, kwargs)
        return self.hits[:kwargs["count"]]

    def pipeline(self, transaction=True):
        assert transaction is False
        owner = self

        class Pipeline:
            def __init__(self):
                self.commands = []

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def sismember(self, key, member):
                self.commands.append(("sismember", key, member))

            def hgetall(self, key):
                self.commands.append(("hgetall", key))

            def execute(self):
                owner.round_trips += 1
                owner.batches.append(self.commands)
                return [
                    int(str(cmd[2]) in owner.sets[cmd[1]]) if cmd[0] == "sismember"
                    else dict(owner.hashes[cmd[1]])
                    for cmd in self.commands
                ]

        return Pipeline()

    def sismember(self, key, member):
        self.round_trips += 1
        return int(str(member) in self.sets[key])

    def hgetall(self, key):
        self.round_trips += 1
        return dict(self.hashes[key])

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value, nx=False, ex=None):
        self.set_calls.append((key, str(value), nx, ex))
        if nx and key in self.values:
            return False
        self.values[key] = str(value)
        return True

    def exists(self, key):
        return key in self.values

    def smembers(self, key):
        return set(self.sets[key])

    def sadd(self, key, value):
        self.sets[key].add(str(value))

    def srem(self, key, value):
        self.sets[key].discard(str(value))

    def expire(self, key, seconds):
        return True

    def hset(self, key, field, value):
        self.hashes[key][field] = str(value)

    def incr(self, key):
        self.values[key] = str(int(self.values.get(key, 0)) + 1)

    def lpush(self, key, value):
        self.lists[key].insert(0, value)

    def ltrim(self, key, start, end):
        self.lists[key] = self.lists[key][start:end + 1]

    def eval(self, script, numkeys, *args):
        self.eval_calls.append((script, numkeys, args))
        if self.before_eval:
            callback, self.before_eval = self.before_eval, None
            callback()
        keys, expected = args[:numkeys], args[numkeys:]
        if script == dispatch._RELEASE_LOCK:
            assert numkeys == 1
            if self.values.get(keys[0]) != expected[0]:
                return 0
            del self.values[keys[0]]
            return 1
        assert script == dispatch._RELEASE_OFFER and numkeys == 2
        if self.values.get(keys[0]) != expected[0]:
            return 0
        del self.values[keys[0]]
        if self.values.get(keys[1]) == expected[1]:
            del self.values[keys[1]]
        return 1


@pytest.fixture
def store(monkeypatch):
    store = MemoryRedis()
    monkeypatch.setattr(dispatch, "r", store)
    monkeypatch.setattr(dispatch, "emit", Mock())
    monkeypatch.setattr(dispatch, "broadcast", Mock())
    monkeypatch.setattr(dispatch.events, "publish", Mock())
    monkeypatch.setattr(dispatch, "_schedule", Mock())
    return store


@pytest.fixture
def db_factory(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'dispatch.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as db:
        db.add_all([
            User(id=1, name="Customer", email="customer@test.invalid", password_hash="test", role=Role.customer),
            User(id=10, name="Rider", email="rider@test.invalid", password_hash="test", role=Role.rider),
            User(id=11, name="Other rider", email="other@test.invalid", password_hash="test", role=Role.rider),
        ])
        db.flush()
        db.add_all([RiderProfile(user_id=10), RiderProfile(user_id=11)])
        db.add_all([
            Order(id=oid, customer_id=1, pickup_address="Pickup", pickup_lat=12.9, pickup_lng=77.6,
                  drop_address="Drop", drop_lat=13.0, drop_lng=77.7,
                  distance_km=2, price=50, eta_minutes=10)
            for oid in (101, 102)
        ])
        db.commit()
    monkeypatch.setattr(dispatch, "SessionLocal", factory)
    yield factory
    engine.dispose()


def legacy_candidates(store, now, exclude):
    """Frozen pre-batching scoring oracle, including the original read order."""
    hits = store.geosearch(dispatch.GEO, longitude=77.6, latitude=12.9,
                           radius=3, unit="km", withdist=True, sort="ASC", count=30)
    out = []
    for rid, dist in hits:
        if rid in exclude or not store.sismember(dispatch.AVAILABLE, rid):
            continue
        state = store.hgetall(dispatch.rider_state(rid))
        if not state or now - float(state.get("ts", 0)) > dispatch.STALE_AFTER_S:
            continue
        rating = float(state.get("rating") or 4.5)
        out.append({"rider_id": int(rid), "distance_km": round(dist, 2),
                    "rating": rating, "score": dist + (5.0 - rating) * 1.0})
    return sorted(out, key=lambda item: item["score"])


def test_scoring_equivalence_at_boundaries_and_stable_ties(store, monkeypatch):
    monkeypatch.setattr(dispatch.time, "time", lambda: 1000)
    store.hits = [(str(rid), dist) for rid, dist in enumerate(
        [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1.0, 1.0, 1.125, 1.2, 1.3, 1.4], 1)]
    store.sets[dispatch.AVAILABLE] = {rid for rid, _ in store.hits} - {"3"}
    states = {
        "1": {"ts": "1000", "rating": "5"},       # excluded, even though best
        "2": {},                                  # missing state
        "3": {"ts": "bad", "rating": "bad"},    # unavailable: never parsed
        "4": {"ts": "954.999", "rating": "5"},  # just stale
        "5": {"rating": "5"},                    # absent timestamp is zero
        "6": {"ts": "955", "rating": ""},      # exactly 45s, default rating
        "7": {"ts": "1000", "rating": "4.75"},
        "8": {"ts": "1000", "rating": "5"},    # tie: keep GEO order 7,8,9
        "9": {"ts": "1001", "rating": "5"},    # future timestamps stay eligible
        "10": {"ts": "1000"},                    # absent rating defaults to 4.5
        "11": {"ts": "1000", "rating": "0"},   # string zero is not missing
        "12": {"ts": "1000", "rating": "3.5"},
        "13": {"ts": "bad", "rating": "bad"},  # excluded: never parsed
    }
    for rid, state in states.items():
        store.hashes[dispatch.rider_state(rid)] = state
    expected = legacy_candidates(store, 1000, {"1", "13"})
    store.round_trips = 0
    assert dispatch.find_candidates(12.9, 77.6, 3, {"1", "13"}) == expected
    assert [item["rider_id"] for item in expected[:4]] == [7, 8, 9, 6]
    assert store.round_trips == 2
    assert len(store.batches[0]) == 22


@pytest.mark.parametrize("fleet_size", [0, 1, 10, 30, 31, 1000])
def test_scoring_equivalence_and_bounded_round_trips(store, monkeypatch, fleet_size):
    rng = random.Random(42)
    monkeypatch.setattr(dispatch.time, "time", lambda: 1000)
    store.hits = [(str(rid), rid / 10) for rid in range(1, fleet_size + 1)]
    for rid, _ in store.hits:
        store.sets[dispatch.AVAILABLE].add(rid)
        store.hashes[dispatch.rider_state(rid)] = {
            "ts": str(1000 - rng.choice([0, 44, 45, 46])),
            "rating": rng.choice(["", "0", "3.5", "4.5", "5"]),
        }
    expected = legacy_candidates(store, 1000, set())
    legacy_round_trips = store.round_trips
    store.round_trips = 0
    assert dispatch.find_candidates(12.9, 77.6, 3, set()) == expected
    candidates = min(fleet_size, 30)
    assert legacy_round_trips == 1 + 2 * candidates
    assert store.round_trips == (2 if candidates else 1)
    assert sum(len(batch) for batch in store.batches) == 2 * candidates
    assert len(store.batches) == (1 if candidates else 0)
    assert store.geo_args[1]["sort"] == "ASC"
    assert store.geo_args[1]["count"] == 30


def test_all_excluded_skips_pipeline(store):
    store.hits = [("10", 1.0)]
    assert dispatch.find_candidates(12.9, 77.6, 3, {"10"}) == []
    assert store.round_trips == 1 and store.batches == []


@pytest.mark.parametrize("field", ["ts", "rating"])
def test_invalid_eligible_values_keep_existing_error_behavior(store, monkeypatch, field):
    monkeypatch.setattr(dispatch.time, "time", lambda: 1000)
    store.hits = [("10", 1.0)]
    store.sets[dispatch.AVAILABLE].add("10")
    store.hashes[dispatch.rider_state(10)] = {"ts": "1000", "rating": "5", field: "invalid"}
    with pytest.raises(ValueError):
        dispatch.find_candidates(12.9, 77.6, 3, set())


def test_dispatch_lock_tokens_are_unique_and_owner_releases(store, db_factory):
    assert dispatch.dispatch_order(999) == "not-pending"
    assert dispatch.dispatch_order(999) == "not-pending"
    tokens = [value for key, value, nx, ttl in store.set_calls if key == dispatch.dispatch_lock(999)]
    assert len(set(tokens)) == 2 and all(len(token) == 32 for token in tokens)
    assert store.get(dispatch.dispatch_lock(999)) is None
    assert all(nx and ttl == 10 for _, _, nx, ttl in store.set_calls)


@pytest.mark.parametrize("fail", [False, True])
def test_old_dispatch_owner_cannot_release_replacement_lock(store, monkeypatch, fail):
    class DelayedSession:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def get(self, *args):
            store.set(dispatch.dispatch_lock(101), "successor-token", ex=10)
            if fail:
                raise RuntimeError("DB failed after lease expired")
            return None

    monkeypatch.setattr(dispatch, "SessionLocal", DelayedSession)
    if fail:
        with pytest.raises(RuntimeError, match="DB failed"):
            dispatch.dispatch_order(101)
    else:
        assert dispatch.dispatch_order(101) == "not-pending"
    assert store.get(dispatch.dispatch_lock(101)) == "successor-token"


def test_contended_dispatch_does_not_release_another_owners_lock(store):
    store.set(dispatch.dispatch_lock(101), "owner", ex=10)
    assert dispatch.dispatch_order(101) == "locked"
    assert store.get(dispatch.dispatch_lock(101)) == "owner"
    assert store.eval_calls == []


def test_dispatch_preserves_raw_offer_ids_and_grace(store, db_factory, monkeypatch):
    monkeypatch.setattr(dispatch, "find_candidates", lambda *args: [
        {"rider_id": 10, "distance_km": 1.2, "rating": 4.8, "score": 1.4},
    ])
    assert dispatch.dispatch_order(101) == "offered:10"
    assert store.get(dispatch.order_offer(101)) == "10"
    assert store.get(dispatch.rider_offer(10)) == "101"
    offer_sets = [call for call in store.set_calls if call[0] in (
        dispatch.order_offer(101), dispatch.rider_offer(10))]
    assert len(offer_sets) == 2
    assert all(call[3] == dispatch.settings.offer_timeout_s + 15 for call in offer_sets)
    cast(Mock, dispatch._schedule).assert_called_once_with(
        "offer_timeout_task", [101, 10], dispatch.settings.offer_timeout_s + 1,
    )


@pytest.mark.parametrize("callback", ["expire_offer", "reject_offer"])
def test_stale_callbacks_preserve_replaced_pair(store, monkeypatch, callback):
    store.set(dispatch.order_offer(101), 10)
    store.set(dispatch.rider_offer(10), 101)

    def replace_before_cleanup():
        store.set(dispatch.order_offer(101), 11)
        store.set(dispatch.rider_offer(10), 102)

    store.before_eval = replace_before_cleanup
    db = Mock(side_effect=AssertionError("stale callback must not write SQL"))
    monkeypatch.setattr(dispatch, "SessionLocal", db)
    if callback == "expire_offer":
        assert dispatch.expire_offer(101, 10) == "stale"
    else:
        with pytest.raises(dispatch.OfferError, match="no longer available"):
            dispatch.reject_offer(101, 10)
    assert store.get(dispatch.order_offer(101)) == "11"
    assert store.get(dispatch.rider_offer(10)) == "102"
    assert len(store.eval_calls) == 1
    cast(Mock, dispatch._schedule).assert_not_called()
    cast(Mock, dispatch.emit).assert_not_called()
    assert not any(key.startswith("metrics:") for key in store.values)


@pytest.mark.parametrize("callback", ["expire_offer", "reject_offer"])
@pytest.mark.parametrize("rider_reservation", [None, "101", "102"])
def test_cleanup_only_removes_matching_reservations_once(
    store, db_factory, monkeypatch, callback, rider_reservation,
):
    store.set(dispatch.order_offer(101), 10)
    if rider_reservation:
        store.set(dispatch.rider_offer(10), rider_reservation)
    redispatch = Mock(return_value="redispatched")
    monkeypatch.setattr(dispatch, "dispatch_order", redispatch)
    getattr(dispatch, callback)(101, 10)
    assert store.get(dispatch.order_offer(101)) is None
    assert store.get(dispatch.rider_offer(10)) == ("102" if rider_reservation == "102" else None)
    if callback == "expire_offer":
        assert dispatch.expire_offer(101, 10) == "stale"
        redispatch.assert_called_once_with(101)
        metric = "offers_expired"
    else:
        with pytest.raises(dispatch.OfferError):
            dispatch.reject_offer(101, 10)
        cast(Mock, dispatch._schedule).assert_called_once_with("dispatch_order_task", [101], 0)
        metric = "offers_rejected"
    assert store.get(dispatch.metric(metric)) == "1"
    with db_factory() as db:
        assert db.query(OrderEvent).count() == 1


def test_admin_style_acceptance_and_mysql_locking_protocol(store, db_factory):
    # force_assign sets only this raw key; no rider_offer key is required.
    store.set(dispatch.order_offer(101), 10)
    store.sadd(dispatch.AVAILABLE, 10)
    with db_factory() as db:
        profile = db.get(RiderProfile, 10)  # retain the already-loaded identity
        statements = []
        event.listen(db, "do_orm_execute", lambda ctx: statements.append(ctx.statement))
        order = dispatch.accept_offer(db, 101, 10)
        assert profile.user_id == 10
        sql = [str(stmt.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))
               for stmt in statements[:3]]
        assert "FROM rider_profiles" in sql[0] and sql[0].endswith("FOR UPDATE")
        assert "rider_profiles.user_id = 10" in sql[0]
        assert "orders.rider_id = 10" in sql[1] and sql[1].endswith("FOR UPDATE")
        assert "'assigned', 'picked_up'" in sql[1] and "LIMIT 1" in sql[1]
        assert sql[2].startswith("UPDATE orders") and "orders.status = 'pending'" in sql[2]
        assert order.status == OrderStatus.assigned and order.rider_id == 10
        assert db.query(OrderEvent).filter_by(type="status.assigned").count() == 1
    assert store.get(dispatch.order_offer(101)) is None
    assert "10" not in store.sets[dispatch.AVAILABLE]
    assert store.hashes[dispatch.rider_state(10)]["order_id"] == "101"
    cast(Mock, dispatch.broadcast).assert_called_once()
    cast(Mock, dispatch.events.publish).assert_called_once()


@pytest.mark.parametrize("status", [OrderStatus.assigned, OrderStatus.picked_up])
def test_busy_rider_rejected_without_mutating_pending_order_or_offer(store, db_factory, status):
    with db_factory() as db:
        active = db.get(Order, 102)
        active.rider_id, active.status = 10, status
        db.commit()
    store.set(dispatch.order_offer(101), 10)
    store.set(dispatch.rider_offer(10), 101)
    with db_factory() as db:
        with pytest.raises(dispatch.OfferError, match="active order"):
            dispatch.accept_offer(db, 101, 10)
        assert not db.in_transaction()
        assert db.get(Order, 101).status == OrderStatus.pending
        assert db.get(Order, 101).rider_id is None
        assert db.query(OrderEvent).count() == 0
    assert store.get(dispatch.order_offer(101)) == "10"
    assert store.get(dispatch.rider_offer(10)) == "101"
    assert store.eval_calls == []
    cast(Mock, dispatch.broadcast).assert_not_called()
    cast(Mock, dispatch.events.publish).assert_not_called()


def test_second_acceptance_cannot_assign_another_active_order(store, db_factory):
    store.set(dispatch.order_offer(101), 10)
    store.set(dispatch.order_offer(102), 10)
    with db_factory() as first:
        dispatch.accept_offer(first, 101, 10)
    with db_factory() as second:
        with pytest.raises(dispatch.OfferError, match="active order"):
            dispatch.accept_offer(second, 102, 10)
        assert second.get(Order, 102).status == OrderStatus.pending
        assert second.query(Order).filter_by(rider_id=10, status=OrderStatus.assigned).count() == 1


@pytest.mark.parametrize("status", [OrderStatus.delivered, OrderStatus.cancelled, OrderStatus.unassigned])
def test_inactive_order_does_not_make_rider_busy(store, db_factory, status):
    with db_factory() as db:
        old = db.get(Order, 102)
        old.rider_id, old.status = 10, status
        db.commit()
        store.set(dispatch.order_offer(101), 10)
        assert dispatch.accept_offer(db, 101, 10).status == OrderStatus.assigned


def test_offer_is_rechecked_after_profile_lock_wait(store, db_factory):
    store.set(dispatch.order_offer(101), 10)
    with db_factory() as db:
        def replace_on_lock(ctx):
            sql = str(ctx.statement.compile(dialect=mysql.dialect()))
            if "FROM rider_profiles" in sql and sql.endswith("FOR UPDATE"):
                store.set(dispatch.order_offer(101), 11)

        event.listen(db, "do_orm_execute", replace_on_lock)
        with pytest.raises(dispatch.OfferError, match="no longer available"):
            dispatch.accept_offer(db, 101, 10)
        assert not db.in_transaction()
        assert db.get(Order, 101).status == OrderStatus.pending
    assert store.get(dispatch.order_offer(101)) == "11"


@pytest.mark.parametrize("replacement", ["order", "rider", "both"])
def test_accepted_cleanup_preserves_newer_offer_after_sql_commit(store, db_factory, replacement):
    store.set(dispatch.order_offer(101), 10)
    store.set(dispatch.rider_offer(10), 101)
    with db_factory() as db:
        def replace_after_commit(session):
            if replacement in ("order", "both"):
                store.set(dispatch.order_offer(101), 11)
            if replacement in ("rider", "both"):
                store.set(dispatch.rider_offer(10), 102)

        event.listen(db, "after_commit", replace_after_commit)
        assert dispatch.accept_offer(db, 101, 10).status == OrderStatus.assigned
    assert store.get(dispatch.order_offer(101)) == (None if replacement == "rider" else "11")
    assert store.get(dispatch.rider_offer(10)) == ("101" if replacement == "order" else "102")


@pytest.mark.parametrize("failure", ["missing-profile", "cancelled", "taken", "audit-error"])
def test_acceptance_failure_rolls_back_and_preserves_offer(store, db_factory, monkeypatch, failure):
    with db_factory() as db:
        if failure == "missing-profile":
            db.delete(db.get(RiderProfile, 10))
        elif failure in ("cancelled", "taken"):
            order = db.get(Order, 101)
            order.status = OrderStatus.cancelled if failure == "cancelled" else OrderStatus.assigned
            order.rider_id = None if failure == "cancelled" else 11
        db.commit()
        if failure == "audit-error":
            monkeypatch.setattr(dispatch, "log_event", Mock(side_effect=RuntimeError("audit failed")))
        store.set(dispatch.order_offer(101), 10)
        with pytest.raises(RuntimeError if failure == "audit-error" else dispatch.OfferError):
            dispatch.accept_offer(db, 101, 10)
        assert not db.in_transaction()
        assert db.query(OrderEvent).count() == 0
        assert db.get(Order, 101).rider_id != 10
    assert store.get(dispatch.order_offer(101)) == "10"
    assert store.eval_calls == []


@pytest.fixture
def real_redis():
    url = os.getenv("DISPATCH_TEST_REDIS_URL")
    if not url:
        pytest.skip("set DISPATCH_TEST_REDIS_URL for actual Redis Lua checks")
    client = redis.Redis.from_url(url, decode_responses=True)
    prefix = f"dispatch-test:{uuid4().hex}:"
    keys = [prefix + name for name in ("order", "rider", "lock")]
    try:
        client.ping()
        yield client, keys
    finally:
        client.delete(*keys)
        client.close()


@pytest.mark.parametrize("order_value,rider_value,removed", [
    ("10", "101", 1), ("10", None, 1), ("10", "102", 1),
    ("11", "101", 0), ("11", "102", 0), (None, "101", 0),
])
def test_real_redis_offer_script(real_redis, order_value, rider_value, removed):
    client, (order_key, rider_key, _) = real_redis
    if order_value is not None:
        client.set(order_key, order_value)
    if rider_value is not None:
        client.set(rider_key, rider_value)
    assert client.eval(dispatch._RELEASE_OFFER, 2, order_key, rider_key, "10", "101") == removed
    assert client.get(order_key) == (None if removed else order_value)
    assert client.get(rider_key) == (None if removed and rider_value == "101" else rider_value)
    assert client.eval(dispatch._RELEASE_OFFER, 2, order_key, rider_key, "10", "101") == 0


def test_real_redis_lock_script_preserves_successor(real_redis):
    client, (_, _, key) = real_redis
    old, successor = uuid4().hex, uuid4().hex
    assert client.set(key, old, nx=True, ex=10)
    client.pexpire(key, 0)  # deterministically expire the old lease
    assert client.set(key, successor, nx=True, ex=10)
    assert client.eval(dispatch._RELEASE_LOCK, 1, key, old) == 0
    assert client.get(key) == successor
    assert client.eval(dispatch._RELEASE_LOCK, 1, key, successor) == 1
    assert client.get(key) is None

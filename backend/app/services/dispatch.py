"""Rider matching.

1. Look up online riders near the pickup with Redis GEOSEARCH, widening the
   radius on every failed attempt (3 -> 6 -> 12 -> 25 km).
2. Score candidates on distance and rating, skipping anyone who already
   declined this order, has gone stale, or is busy.
3. Offer the job to the best rider. A per-rider reservation (SET NX) prevents
   competing dispatchers from reserving the rider while that key is live.
4. The offer expires after OFFER_TIMEOUT seconds and a Celery countdown task
   moves on to the next rider.
5. Acceptance locks the rider profile, checks for active work using a current
   read, then conditionally updates the pending order in the same transaction.

These are bounded safeguards, not exactly-once processing: dispatch leases can
expire mid-flight, and Redis, SQL and event publication are not one transaction.
The rider row lock coordinates accept_offer callers, not other lifecycle writers
or admin's pre-assignment Redis cleanup.
Offer keys retain raw IDs for admin compatibility; callbacks cannot distinguish
two generations of the same order/rider pair (e.g. after manual redispatch).
"""
import logging
import time
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import Order, OrderStatus, RiderProfile, utcnow
from app.realtime import emit
from app.redis_client import (
    AVAILABLE, GEO, ONLINE, dispatch_lock, metric, order_offer, order_tried, r,
    rider_offer, rider_state,
)
from app.services import events
from app.services.geo import haversine_km
from app.services.orders import broadcast, log_event, serialize, transition

log = logging.getLogger(__name__)

STALE_AFTER_S = 45
RETRY_DELAY_S = 5
# Offer keys outlive the offer window so the timeout task always finds them;
# if Celery is down they still self-heal and the rescue job re-dispatches.
OFFER_GRACE_S = 15

# Compare and delete in Redis, never GET followed by an unconditional DEL.
_RELEASE_LOCK = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""

_RELEASE_OFFER = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[2]) == ARGV[2] then
    redis.call('DEL', KEYS[2])
end
return 1
"""


def _release_offer(order_id: int, rider_id: int) -> bool:
    """Remove only this pair; tolerate admin offers without a rider reservation.

    The order key is authoritative. If it changed, leave both keys alone; if
    the rider is now reserved by another order, leave that reservation alone.
    Raw IDs cannot detect a later offer of the *same* pair (the ABA boundary).
    """
    return bool(r.eval(
        _RELEASE_OFFER, 2, order_offer(order_id), rider_offer(rider_id),
        str(rider_id), str(order_id),
    ))


def _schedule(task_name: str, args: list, countdown: int):
    from app.workers import tasks

    getattr(tasks, task_name).apply_async(args=args, countdown=countdown)


def find_candidates(lat: float, lng: float, radius_km: float, exclude: set[str]) -> list[dict]:
    hits = r.geosearch(
        GEO, longitude=lng, latitude=lat, radius=radius_km, unit="km",
        withdist=True, sort="ASC", count=30,
    )
    now = time.time()
    hits = [(rid, dist) for rid, dist in hits if rid not in exclude]
    if not hits:
        return []
    # GEOSEARCH bounds this to 30 riders / 60 reads in one network round trip.
    # Preserve GEO order for stable score ties and the original hash defaults.
    with r.pipeline(transaction=False) as pipe:
        for rid, _ in hits:
            pipe.sismember(AVAILABLE, rid)
            pipe.hgetall(rider_state(rid))
        states = pipe.execute()
    out = []
    for (rid, dist), available, st in zip(hits, states[::2], states[1::2]):
        if not available:
            continue
        if not st or now - float(st.get("ts", 0)) > STALE_AFTER_S:
            continue
        rating = float(st.get("rating") or 4.5)
        # Lower is better: 1 km of distance ~ 1 rating point
        score = dist + (5.0 - rating) * 1.0
        out.append({"rider_id": int(rid), "distance_km": round(dist, 2), "rating": rating, "score": score})
    return sorted(out, key=lambda c: c["score"])


def dispatch_order(order_id: int):
    """Try to offer an order, suppressing duplicate dispatch during the lease."""
    token = uuid4().hex
    if not r.set(dispatch_lock(order_id), token, nx=True, ex=10):
        return "locked"
    try:
        with SessionLocal() as db:
            order = db.get(Order, order_id)
            if not order or order.status != OrderStatus.pending:
                return "not-pending"
            if r.exists(order_offer(order_id)):
                return "offer-outstanding"

            radii = settings.radii
            radius = radii[min(order.dispatch_attempts // 2, len(radii) - 1)]
            tried = r.smembers(order_tried(order_id))
            candidates = find_candidates(order.pickup_lat, order.pickup_lng, radius, tried)

            chosen = None
            for c in candidates:
                if r.set(rider_offer(c["rider_id"]), order_id, nx=True, ex=settings.offer_timeout_s + OFFER_GRACE_S):
                    chosen = c
                    break

            order.dispatch_attempts += 1
            if chosen:
                rid = chosen["rider_id"]
                r.set(order_offer(order_id), rid, ex=settings.offer_timeout_s + OFFER_GRACE_S)
                r.sadd(order_tried(order_id), rid)
                r.expire(order_tried(order_id), 3600)
                r.incr(metric("offers_sent"))
                log_event(db, order_id, "dispatch.offered", {**chosen, "radius_km": radius})
                db.commit()
                emit("job:offer", {
                    "order": serialize(order),
                    "distance_to_pickup_km": chosen["distance_km"],
                    "expires_in": settings.offer_timeout_s,
                    "expires_at": time.time() + settings.offer_timeout_s,
                }, f"rider:{rid}")
                emit("dispatch:log", {"order_id": order_id, "msg": f"Offered to rider #{rid} ({chosen['distance_km']} km)"}, "dispatch")
                _schedule("offer_timeout_task", [order_id, rid], settings.offer_timeout_s + 1)
                return f"offered:{rid}"

            log_event(db, order_id, "dispatch.no_rider", {"radius_km": radius, "attempt": order.dispatch_attempts})
            if order.dispatch_attempts >= settings.max_dispatch_attempts:
                r.incr(metric("orders_unassigned"))
                transition(db, order, OrderStatus.unassigned, "dispatcher", reason="no riders")
                emit("dispatch:alert", {"order_id": order_id, "level": "critical",
                                        "msg": f"Order #{order_id} could not be assigned"}, "dispatch")
                return "gave-up"
            db.commit()
            emit("dispatch:log", {"order_id": order_id, "msg": f"No rider within {radius} km, retrying"}, "dispatch")
            _schedule("dispatch_order_task", [order_id], RETRY_DELAY_S)
            return "retry"
    finally:
        # A worker delayed past the TTL must not release its successor's lock.
        r.eval(_RELEASE_LOCK, 1, dispatch_lock(order_id), token)


def expire_offer(order_id: int, rider_id: int):
    """Called by Celery after the offer window. No-op if the rider already answered."""
    if not _release_offer(order_id, rider_id):
        return "stale"
    r.incr(metric("offers_expired"))
    with SessionLocal() as db:
        log_event(db, order_id, "dispatch.offer_expired", {"rider_id": rider_id})
        db.commit()
    emit("job:offer_closed", {"order_id": order_id, "reason": "expired"}, f"rider:{rider_id}")
    return dispatch_order(order_id)


class OfferError(Exception):
    pass


def accept_offer(db: Session, order_id: int, rider_id: int) -> Order:
    if r.get(order_offer(order_id)) != str(rider_id):
        raise OfferError("This offer is no longer available")

    try:
        # Serialize all accept paths (including force_assign) for this rider.
        # Select a scalar so a profile already in the identity map cannot skip
        # the locking query. The lock is held until commit/rollback below.
        profile_id = db.execute(
            select(RiderProfile.user_id)
            .where(RiderProfile.user_id == rider_id)
            .with_for_update()
        ).scalar_one_or_none()
        if profile_id is None:
            raise OfferError("Rider profile not found")

        # FOR UPDATE is also essential here: under MySQL REPEATABLE READ an
        # ordinary SELECT could use a snapshot from before the profile wait.
        active_id = db.execute(
            select(Order.id)
            .where(
                Order.rider_id == rider_id,
                Order.status.in_([OrderStatus.assigned, OrderStatus.picked_up]),
            )
            .limit(1)
            .with_for_update()
        ).scalar_one_or_none()
        if active_id is not None:
            raise OfferError("Rider already has an active order")
        # The offer may have expired or changed while waiting on the row lock.
        if r.get(order_offer(order_id)) != str(rider_id):
            raise OfferError("This offer is no longer available")

        # Atomic compare-and-set: competing riders cannot both assign this
        # pending order. Redis can still change between this check and commit.
        res = db.execute(
            update(Order)
            .where(Order.id == order_id, Order.status == OrderStatus.pending)
            .values(status=OrderStatus.assigned, rider_id=rider_id, assigned_at=utcnow())
        )
        if res.rowcount != 1:
            raise OfferError("Order was already taken or cancelled")
        log_event(db, order_id, "status.assigned", {"from": "pending", "actor": f"rider:{rider_id}"})
        db.commit()
    except Exception:
        db.rollback()
        raise

    _release_offer(order_id, rider_id)
    r.srem(AVAILABLE, rider_id)
    r.hset(rider_state(rider_id), "order_id", order_id)
    r.incr(metric("offers_accepted"))

    order = db.get(Order, order_id)
    db.refresh(order)
    wait_s = (order.assigned_at - order.created_at).total_seconds()
    r.lpush(metric("assign_seconds"), round(wait_s, 2))
    r.ltrim(metric("assign_seconds"), 0, 499)

    broadcast(order)
    events.publish("order.assigned", {
        "order_id": order.id, "customer_id": order.customer_id,
        "rider_id": rider_id, "assign_seconds": wait_s,
    })
    return order


def reject_offer(order_id: int, rider_id: int):
    if not _release_offer(order_id, rider_id):
        raise OfferError("This offer is no longer available")
    r.incr(metric("offers_rejected"))
    with SessionLocal() as db:
        log_event(db, order_id, "dispatch.offer_rejected", {"rider_id": rider_id})
        db.commit()
    _schedule("dispatch_order_task", [order_id], 0)


def release_rider(rider_id: int):
    """Rider finished or lost a job: make them dispatchable again if still online."""
    r.hdel(rider_state(rider_id), "order_id")
    if r.sismember(ONLINE, rider_id):
        r.sadd(AVAILABLE, rider_id)


def go_online(db: Session, rider_id: int, name: str, lat: float, lng: float) -> dict:
    profile = db.get(RiderProfile, rider_id)
    active = db.query(Order).filter(
        Order.rider_id == rider_id,
        Order.status.in_([OrderStatus.assigned, OrderStatus.picked_up]),
    ).first()
    pipe = r.pipeline()
    pipe.sadd(ONLINE, rider_id)
    pipe.geoadd(GEO, (lng, lat, str(rider_id)))
    pipe.hset(rider_state(rider_id), mapping={
        "lat": lat, "lng": lng, "ts": time.time(), "name": name,
        "rating": profile.rating if profile else 4.5,
        "vehicle": profile.vehicle if profile else "bike",
    })
    if active:
        pipe.hset(rider_state(rider_id), "order_id", active.id)
        pipe.srem(AVAILABLE, rider_id)
    else:
        pipe.hdel(rider_state(rider_id), "order_id")
        pipe.sadd(AVAILABLE, rider_id)
    pipe.execute()
    emit("fleet:rider", {"rider_id": rider_id, "online": True, "name": name, "lat": lat, "lng": lng}, "dispatch")
    return {"online": True, "active_order_id": active.id if active else None}


def go_offline(rider_id: int):
    pipe = r.pipeline()
    pipe.srem(ONLINE, rider_id)
    pipe.srem(AVAILABLE, rider_id)
    pipe.zrem(GEO, str(rider_id))
    pipe.execute()
    emit("fleet:rider", {"rider_id": rider_id, "online": False}, "dispatch")


def prune_stale_riders() -> int:
    """Riders whose app stopped sending GPS (crash, no network) are taken offline."""
    now, pruned = time.time(), 0
    for rid in r.smembers(ONLINE):
        st = r.hgetall(rider_state(rid))
        if not st or now - float(st.get("ts", 0)) > 120:
            if not st.get("order_id"):
                go_offline(int(rid))
                pruned += 1
    return pruned


def nearest_distance(order: Order) -> float | None:
    if not order.rider_id:
        return None
    st = r.hgetall(rider_state(order.rider_id))
    if not st.get("lat"):
        return None
    target = (order.drop_lat, order.drop_lng) if order.status == OrderStatus.picked_up else (order.pickup_lat, order.pickup_lng)
    return haversine_km(float(st["lat"]), float(st["lng"]), *target)

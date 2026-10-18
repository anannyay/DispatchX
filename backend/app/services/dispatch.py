"""Rider matching.

1. Look up online riders near the pickup with Redis GEOSEARCH, widening the
   radius on every failed attempt (3 -> 6 -> 12 -> 25 km).
2. Score candidates on distance and rating, skipping anyone who already
   declined this order, has gone stale, or is busy.
3. Offer the job to the best rider. A per-rider lock (SET NX) guarantees a
   rider never sees two offers at once, even with many workers dispatching
   in parallel.
4. The offer expires after OFFER_TIMEOUT seconds and a Celery countdown task
   moves on to the next rider.
5. Acceptance is a conditional UPDATE (status must still be pending), so two
   riders can never both win the same order.
"""
import logging
import time

from sqlalchemy import update
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


def _schedule(task_name: str, args: list, countdown: int):
    from app.workers import tasks

    getattr(tasks, task_name).apply_async(args=args, countdown=countdown)


def find_candidates(lat: float, lng: float, radius_km: float, exclude: set[str]) -> list[dict]:
    hits = r.geosearch(
        GEO, longitude=lng, latitude=lat, radius=radius_km, unit="km",
        withdist=True, sort="ASC", count=30,
    )
    now = time.time()
    out = []
    for rid, dist in hits:
        if rid in exclude or not r.sismember(AVAILABLE, rid):
            continue
        st = r.hgetall(rider_state(rid))
        if not st or now - float(st.get("ts", 0)) > STALE_AFTER_S:
            continue
        rating = float(st.get("rating") or 4.5)
        # Lower is better: 1 km of distance ~ 1 rating point
        score = dist + (5.0 - rating) * 1.0
        out.append({"rider_id": int(rid), "distance_km": round(dist, 2), "rating": rating, "score": score})
    return sorted(out, key=lambda c: c["score"])


def dispatch_order(order_id: int):
    """Try to offer an order to the best available rider. Idempotent."""
    if not r.set(dispatch_lock(order_id), "1", nx=True, ex=10):
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
        r.delete(dispatch_lock(order_id))


def expire_offer(order_id: int, rider_id: int):
    """Called by Celery after the offer window. No-op if the rider already answered."""
    if r.get(order_offer(order_id)) != str(rider_id):
        return "stale"
    r.delete(order_offer(order_id))
    r.delete(rider_offer(rider_id))
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

    # Atomic compare-and-set: only one rider can ever flip pending -> assigned
    res = db.execute(
        update(Order)
        .where(Order.id == order_id, Order.status == OrderStatus.pending)
        .values(status=OrderStatus.assigned, rider_id=rider_id, assigned_at=utcnow())
    )
    if res.rowcount != 1:
        db.rollback()
        raise OfferError("Order was already taken or cancelled")
    log_event(db, order_id, "status.assigned", {"from": "pending", "actor": f"rider:{rider_id}"})
    db.commit()

    r.delete(order_offer(order_id), rider_offer(rider_id))
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
    if r.get(order_offer(order_id)) != str(rider_id):
        raise OfferError("This offer is no longer available")
    r.delete(order_offer(order_id), rider_offer(rider_id))
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

import statistics
import time
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_staff
from app.models import Order, OrderStatus, Role, User, utcnow
from app.redis_client import AVAILABLE, ONLINE, metric, order_offer, order_tried, r, rider_offer, rider_state
from app.schemas import AssignIn
from app.services.dispatch import OfferError, accept_offer, release_rider
from app.services.orders import InvalidTransition, serialize, transition

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/stats")
def stats(_: User = Depends(require_staff), db: Session = Depends(get_db)):
    by_status = dict(db.query(Order.status, func.count()).group_by(Order.status).all())
    since = utcnow() - timedelta(hours=1)
    last_hour = db.query(func.count(Order.id)).filter(Order.created_at >= since).scalar()
    delivered_hour = db.query(Order).filter(Order.delivered_at >= since).all()
    revenue_today = db.query(func.coalesce(func.sum(Order.price), 0)).filter(
        Order.status == OrderStatus.delivered, Order.delivered_at >= utcnow() - timedelta(days=1)
    ).scalar()
    assign = [float(x) for x in r.lrange(metric("assign_seconds"), 0, 199)]
    delivery_mins = [
        (o.delivered_at - o.created_at).total_seconds() / 60 for o in delivered_hour if o.delivered_at
    ]
    return {
        "orders_by_status": {k.value: v for k, v in by_status.items()},
        "orders_last_hour": last_hour,
        "delivered_last_hour": len(delivered_hour),
        "revenue_24h": float(revenue_today or 0),
        "riders_online": r.scard(ONLINE),
        "riders_available": r.scard(AVAILABLE),
        "avg_assign_seconds": round(statistics.mean(assign), 2) if assign else None,
        "p95_assign_seconds": round(sorted(assign)[int(len(assign) * 0.95) - 1], 2) if len(assign) >= 20 else None,
        "avg_delivery_minutes": round(statistics.mean(delivery_mins), 1) if delivery_mins else None,
        "sla_breaches_active": int(r.get(metric("sla_breaches_active")) or 0),
        "offers": {k: int(r.get(metric(f"offers_{k}")) or 0) for k in ("sent", "accepted", "rejected", "expired")},
    }


@router.get("/fleet")
def fleet(_: User = Depends(require_staff)):
    now = time.time()
    riders = []
    for rid in r.smembers(ONLINE):
        st = r.hgetall(rider_state(rid))
        if not st.get("lat"):
            continue
        riders.append({
            "rider_id": int(rid), "name": st.get("name"), "lat": float(st["lat"]), "lng": float(st["lng"]),
            "heading": float(st.get("heading") or 0),
            "order_id": int(st["order_id"]) if st.get("order_id") else None,
            "available": r.sismember(AVAILABLE, rid), "offer": r.get(rider_offer(rid)),
            "vehicle": st.get("vehicle"), "rating": float(st.get("rating") or 0),
            "last_seen_s": round(now - float(st.get("ts", now)), 1),
        })
    return riders


@router.get("/riders")
def riders(_: User = Depends(require_staff), db: Session = Depends(get_db)):
    users = db.query(User).filter(User.role == Role.rider).order_by(User.id).limit(500).all()
    return [{"id": u.id, "name": u.name, "online": r.sismember(ONLINE, u.id),
             "available": r.sismember(AVAILABLE, u.id)} for u in users]


@router.post("/orders/{order_id}/redispatch")
def redispatch(order_id: int, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    """Put an unassigned/stuck order back into automatic dispatch with a fresh retry budget."""
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    old_rider = order.rider_id
    order.dispatch_attempts = 0
    order.rider_id = None
    r.delete(order_tried(order_id))
    try:
        transition(db, order, OrderStatus.pending, f"{user.role.value}:{user.id}", manual=True)
    except InvalidTransition as e:
        raise HTTPException(409, str(e))
    if old_rider:
        release_rider(old_rider)
    return serialize(order)


@router.post("/orders/{order_id}/assign")
def force_assign(order_id: int, body: AssignIn, user: User = Depends(require_staff), db: Session = Depends(get_db)):
    """Dispatcher override: hand an order directly to a specific available rider."""
    order = db.get(Order, order_id)
    if not order or order.status not in (OrderStatus.pending, OrderStatus.unassigned):
        raise HTTPException(409, "Order is not waiting for a rider")
    if not r.sismember(AVAILABLE, body.rider_id):
        raise HTTPException(409, "Rider is not available")
    if order.status == OrderStatus.unassigned:
        transition(db, order, OrderStatus.pending, f"{user.role.value}:{user.id}", manual=True)
    prev = r.get(order_offer(order_id))
    if prev:
        r.delete(rider_offer(prev))
    r.set(order_offer(order_id), body.rider_id, ex=30)
    try:
        order = accept_offer(db, order_id, body.rider_id)
    except OfferError as e:
        raise HTTPException(409, str(e))
    return serialize(order)

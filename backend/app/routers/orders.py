import json

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from redis.exceptions import RedisError
from sqlalchemy.orm import Session, joinedload

from app.db import get_db
from app.deps import get_current_user, require_customer
from app.models import Order, OrderEvent, OrderStatus, Role, User
from app.redis_client import order_offer, r, rider_offer, rider_state
from app.schemas import OrderEventOut, OrderIn, QuoteIn, QuoteOut
from app.services import events
from app.services.booking import book_order
from app.services.dispatch import release_rider
from app.services.geo import quote
from app.services.orders import InvalidTransition, broadcast, serialize, transition

router = APIRouter(prefix="/orders", tags=["orders"])

STAFF = (Role.dispatcher, Role.admin)


def get_visible_order(order_id: int, user: User, db: Session) -> Order:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(404, "Order not found")
    if user.role in STAFF or order.customer_id == user.id or order.rider_id == user.id:
        return order
    raise HTTPException(404, "Order not found")


@router.post("/quote", response_model=QuoteOut)
def get_quote(body: QuoteIn, _: User = Depends(get_current_user)):
    return quote(body.pickup.lat, body.pickup.lng, body.drop.lat, body.drop.lng)


@router.post("", status_code=201)
def create_order(
    body: OrderIn,
    request: Request,
    user: User = Depends(require_customer),
    db: Session = Depends(get_db),
    idempotency_key: str | None = Header(
        default=None, alias="Idempotency-Key",
        description="Optional case-sensitive retry key: 8-128 characters from A-Z, a-z, 0-9, '.', '_', ':', '-'.",
    ),
):
    """Create a booking, or return its current representation for a matching retry.

    Both creation and replay return 201 with the original order ID. A key is
    scoped to the authenticated customer and retained without expiry. Reusing
    it with a different validated payload returns 409; invalid keys return 422.
    Omitting the header creates a new booking on every request.
    """
    if len(request.headers.getlist("Idempotency-Key")) > 1:
        raise HTTPException(422, "Supply only one Idempotency-Key header")
    try:
        order, created = book_order(db, user.id, body, idempotency_key)
    except HTTPException as exc:
        if exc.status_code == 409:
            _booking_metric("booking_conflicts")
        raise
    if not created:
        _booking_metric("booking_replays")
        return serialize(order)

    _booking_metric("orders_created")
    # There is still a DB commit / event publish gap: crashes or publish errors
    # here can lose creation side effects. Replays never republish; an outbox is
    # required for durable event delivery and is outside booking idempotency.
    broadcast(order)
    # Fan-out: dispatch, notifications and analytics all react to this one event
    events.publish("order.created", {
        "order_id": order.id, "customer_id": order.customer_id,
        "distance_km": order.distance_km, "price": order.price, "eta_minutes": order.eta_minutes,
    })
    return serialize(order)


def _booking_metric(name: str):
    try:
        r.incr(f"metrics:{name}")
    except RedisError:
        pass  # Observability must not change the result of a committed booking.


@router.get("")
def list_orders(
    status: OrderStatus | None = None,
    limit: int = Query(50, le=200),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(Order).options(joinedload(Order.rider), joinedload(Order.customer))
    if user.role == Role.customer:
        q = q.filter(Order.customer_id == user.id)
    elif user.role == Role.rider:
        q = q.filter(Order.rider_id == user.id)
    if status:
        q = q.filter(Order.status == status)
    return [serialize(o) for o in q.order_by(Order.id.desc()).limit(limit)]


@router.get("/{order_id}")
def get_order(order_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    order = get_visible_order(order_id, user, db)
    data = serialize(order)
    if order.rider_id:
        st = r.hgetall(rider_state(order.rider_id))
        if st.get("lat"):
            data["rider_location"] = {"lat": float(st["lat"]), "lng": float(st["lng"]),
                                      "heading": float(st.get("heading") or 0)}
    return data


@router.get("/{order_id}/events", response_model=list[OrderEventOut])
def order_events(order_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_visible_order(order_id, user, db)
    return db.query(OrderEvent).filter(OrderEvent.order_id == order_id).order_by(OrderEvent.id).all()


@router.post("/{order_id}/cancel")
def cancel_order(order_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    order = get_visible_order(order_id, user, db)
    if user.role == Role.rider:
        raise HTTPException(403, "Riders cannot cancel orders")
    rider_id = order.rider_id
    try:
        transition(db, order, OrderStatus.cancelled, f"{user.role.value}:{user.id}")
    except InvalidTransition as e:
        raise HTTPException(409, str(e))
    # Withdraw any outstanding offer and free the rider
    offered = r.get(order_offer(order_id))
    if offered:
        r.delete(order_offer(order_id), rider_offer(offered))
    for rid in filter(None, [rider_id, offered]):
        release_rider(int(rid))
    return serialize(order)


@router.get("/notifications/me")
def my_notifications(user: User = Depends(get_current_user)):
    return [json.loads(n) for n in r.lrange(f"notifications:{user.id}", 0, 19)]

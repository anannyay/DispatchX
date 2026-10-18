"""Order state machine. Every status change goes through `transition` so the
audit log, real-time updates and domain events can never get out of sync."""
from sqlalchemy.orm import Session

from app.models import Order, OrderEvent, OrderStatus, utcnow
from app.realtime import emit
from app.schemas import OrderOut
from app.services import events

ALLOWED = {
    OrderStatus.pending: {OrderStatus.assigned, OrderStatus.cancelled, OrderStatus.unassigned},
    OrderStatus.unassigned: {OrderStatus.pending, OrderStatus.assigned, OrderStatus.cancelled},
    OrderStatus.assigned: {OrderStatus.picked_up, OrderStatus.cancelled, OrderStatus.pending},
    OrderStatus.picked_up: {OrderStatus.delivered},
    OrderStatus.delivered: set(),
    OrderStatus.cancelled: set(),
}

TIMESTAMP = {
    OrderStatus.assigned: "assigned_at",
    OrderStatus.picked_up: "picked_up_at",
    OrderStatus.delivered: "delivered_at",
}


class InvalidTransition(Exception):
    pass


def serialize(order: Order) -> dict:
    out = OrderOut.model_validate(order)
    out.rider_name = order.rider.name if order.rider else None
    out.customer_name = order.customer.name if order.customer else None
    return out.model_dump(mode="json")


def log_event(db: Session, order_id: int, type_: str, data: dict | None = None):
    db.add(OrderEvent(order_id=order_id, type=type_, data=data or {}))


def broadcast(order: Order):
    """Push the fresh order state to everyone who cares about it."""
    data = serialize(order)
    rooms = [f"order:{order.id}", f"user:{order.customer_id}", "dispatch"]
    if order.rider_id:
        rooms.append(f"rider:{order.rider_id}")
    emit("order:update", data, rooms)


def transition(db: Session, order: Order, new: OrderStatus, actor: str, **extra) -> Order:
    if new not in ALLOWED[order.status]:
        raise InvalidTransition(f"cannot go from {order.status.value} to {new.value}")
    old = order.status
    order.status = new
    if new in TIMESTAMP:
        setattr(order, TIMESTAMP[new], utcnow())
    log_event(db, order.id, f"status.{new.value}", {"from": old.value, "actor": actor, **extra})
    db.commit()
    db.refresh(order)
    broadcast(order)
    events.publish(f"order.{new.value}", {
        "order_id": order.id,
        "customer_id": order.customer_id,
        "rider_id": order.rider_id,
        "from": old.value,
        **extra,
    })
    return order

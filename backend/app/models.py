import enum
from datetime import datetime, timezone

from sqlalchemy import (
    JSON, DateTime, Enum, Float, ForeignKey, Index, Integer, String, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Role(str, enum.Enum):
    customer = "customer"
    rider = "rider"
    dispatcher = "dispatcher"
    admin = "admin"


class OrderStatus(str, enum.Enum):
    pending = "pending"          # created, looking for a rider
    assigned = "assigned"        # rider accepted, heading to pickup
    picked_up = "picked_up"      # parcel collected, heading to drop
    delivered = "delivered"
    cancelled = "cancelled"
    unassigned = "unassigned"    # dispatch gave up; needs a dispatcher


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(20))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.customer, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    rider: Mapped["RiderProfile | None"] = relationship(back_populates="user", uselist=False)


class RiderProfile(Base):
    __tablename__ = "rider_profiles"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    vehicle: Mapped[str] = mapped_column(String(30), default="bike")
    plate: Mapped[str | None] = mapped_column(String(20))
    rating: Mapped[float] = mapped_column(Float, default=4.8)
    deliveries: Mapped[int] = mapped_column(Integer, default=0)
    earnings: Mapped[float] = mapped_column(Float, default=0.0)

    user: Mapped[User] = relationship(back_populates="rider")


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (Index("ix_orders_status_created", "status", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    rider_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus), default=OrderStatus.pending)

    pickup_address: Mapped[str] = mapped_column(String(255))
    pickup_lat: Mapped[float] = mapped_column(Float)
    pickup_lng: Mapped[float] = mapped_column(Float)
    drop_address: Mapped[str] = mapped_column(String(255))
    drop_lat: Mapped[float] = mapped_column(Float)
    drop_lng: Mapped[float] = mapped_column(Float)
    package_note: Mapped[str | None] = mapped_column(String(255))

    distance_km: Mapped[float] = mapped_column(Float)
    price: Mapped[float] = mapped_column(Float)
    eta_minutes: Mapped[float] = mapped_column(Float)
    dispatch_attempts: Mapped[int] = mapped_column(Integer, default=0)
    pod_key: Mapped[str | None] = mapped_column(String(255))

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime)
    picked_up_at: Mapped[datetime | None] = mapped_column(DateTime)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime)

    customer: Mapped[User] = relationship(foreign_keys=[customer_id])
    rider: Mapped[User | None] = relationship(foreign_keys=[rider_id])


class OrderEvent(Base):
    """Append-only audit trail of everything that happened to an order."""

    __tablename__ = "order_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(50))
    data: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class BookingIdentity(Base):
    """Durable, customer-scoped retry identity; never stores the raw header key."""

    __tablename__ = "booking_identities"
    __table_args__ = (UniqueConstraint("customer_id", "key_hash", name="uq_booking_customer_key"),)

    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    key_hash: Mapped[str] = mapped_column(String(64))
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models import OrderStatus, Role


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    phone: str | None = None
    role: Literal["customer", "rider"] = "customer"
    vehicle: str | None = "bike"


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str
    phone: str | None
    role: Role


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserOut


class Point(BaseModel):
    address: str = Field(max_length=255)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class QuoteIn(BaseModel):
    pickup: Point
    drop: Point


class QuoteOut(BaseModel):
    distance_km: float
    price: float
    eta_minutes: float


class OrderIn(QuoteIn):
    package_note: str | None = Field(default=None, max_length=255)


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    customer_id: int
    rider_id: int | None
    status: OrderStatus
    pickup_address: str
    pickup_lat: float
    pickup_lng: float
    drop_address: str
    drop_lat: float
    drop_lng: float
    package_note: str | None
    distance_km: float
    price: float
    eta_minutes: float
    dispatch_attempts: int
    pod_key: str | None
    created_at: datetime
    assigned_at: datetime | None
    picked_up_at: datetime | None
    delivered_at: datetime | None
    rider_name: str | None = None
    customer_name: str | None = None


class OrderEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    type: str
    data: dict | None
    created_at: datetime


class OnlineIn(BaseModel):
    lat: float
    lng: float


class DeliverIn(BaseModel):
    pod_key: str | None = None


class PodUploadIn(BaseModel):
    order_id: int
    content_type: str = "image/jpeg"


class AssignIn(BaseModel):
    rider_id: int

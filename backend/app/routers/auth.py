import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.models import RiderProfile, Role, User
from app.schemas import LoginIn, RefreshIn, RegisterIn, TokenOut, UserOut
from app.security import (
    create_access_token, create_refresh_token, decode_token, hash_password, verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _tokens(user: User) -> TokenOut:
    return TokenOut(
        access_token=create_access_token(user.id, user.role.value),
        refresh_token=create_refresh_token(user.id, user.role.value),
        user=UserOut.model_validate(user),
    )


@router.post("/register", response_model=TokenOut, status_code=201)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == body.email.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(
        name=body.name, email=body.email.lower(), phone=body.phone,
        password_hash=hash_password(body.password), role=Role(body.role),
    )
    db.add(user)
    db.flush()
    if user.role == Role.rider:
        db.add(RiderProfile(user_id=user.id, vehicle=body.vehicle or "bike"))
    db.commit()
    return _tokens(user)


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    return _tokens(user)


@router.post("/refresh", response_model=TokenOut)
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    try:
        claims = decode_token(body.refresh_token, expected_type="refresh")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    user = db.get(User, int(claims["sub"]))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return _tokens(user)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user

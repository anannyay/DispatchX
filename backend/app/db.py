from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

_kwargs = {"pool_pre_ping": True}
if settings.sqlalchemy_url.startswith("sqlite"):
    _kwargs["connect_args"] = {"check_same_thread": False}
else:
    # pool_recycle keeps connections fresh across an RDS Multi-AZ failover
    _kwargs.update(pool_size=10, max_overflow=20, pool_recycle=280)

engine = create_engine(settings.sqlalchemy_url, **_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

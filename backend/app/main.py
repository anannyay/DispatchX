import logging
import socket

import socketio
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_fastapi_instrumentator import Instrumentator
from sqlalchemy import text

from app import metrics
from app.config import settings
from app.db import engine
from app.realtime import sio
from app.redis_client import r
from app.routers import admin, auth, orders, riders, uploads

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

api = FastAPI(title="FleetPulse API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.cors_origins == "*" else settings.cors_origins.split(","),
    allow_methods=["*"], allow_headers=["*"],
)

v1 = APIRouter(prefix="/api")
for router in (auth.router, orders.router, riders.router, uploads.router, admin.router):
    v1.include_router(router)


@v1.get("/health", tags=["ops"])
def health():
    """Liveness: the process is up. Used by the ALB target group."""
    return {"status": "ok", "host": socket.gethostname()}


@v1.get("/ready", tags=["ops"])
def ready():
    """Readiness: dependencies reachable."""
    checks = {}
    try:
        with engine.connect() as c:
            c.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"error: {e.__class__.__name__}"
    try:
        r.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e.__class__.__name__}"
    ok = all(v == "ok" for v in checks.values())
    return JSONResponse({"status": "ok" if ok else "degraded", **checks}, status_code=200 if ok else 503)


api.include_router(v1)

Instrumentator(excluded_handlers=["/metrics", "/api/health"]).instrument(api).expose(api, include_in_schema=False)
metrics.register()

# One ASGI app serves REST under /api and Socket.IO under /socket.io
app = socketio.ASGIApp(sio, other_asgi_app=api, socketio_path="socket.io")

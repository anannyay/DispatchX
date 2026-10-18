"""Proof-of-delivery photos. Clients upload straight to S3 with a presigned
PUT URL, so image bytes never pass through our API servers. Locally (no
bucket configured) the same flow is served by a disk-backed fallback."""
import os
import uuid
from functools import lru_cache
from pathlib import Path

import boto3
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from app.config import settings
from app.db import get_db
from app.deps import get_current_user, require_rider
from app.models import User
from app.routers.orders import get_visible_order
from app.schemas import PodUploadIn

router = APIRouter(prefix="/uploads", tags=["uploads"])

ALLOWED_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_BYTES = 8 * 1024 * 1024


@lru_cache
def s3():
    return boto3.client("s3", region_name=settings.aws_region,
                        endpoint_url=f"https://s3.{settings.aws_region}.amazonaws.com")


@router.post("/pod")
def pod_upload_url(body: PodUploadIn, user: User = Depends(require_rider), db=Depends(get_db)):
    order = get_visible_order(body.order_id, user, db)
    if order.rider_id != user.id:
        raise HTTPException(403, "Not your delivery")
    ext = ALLOWED_TYPES.get(body.content_type)
    if not ext:
        raise HTTPException(422, "Only JPEG, PNG or WebP images")
    key = f"pod/{order.id}/{uuid.uuid4().hex}.{ext}"
    if settings.s3_bucket:
        url = s3().generate_presigned_url(
            "put_object",
            Params={"Bucket": settings.s3_bucket, "Key": key, "ContentType": body.content_type},
            ExpiresIn=300,
        )
    else:
        url = f"{settings.public_api_url}/api/uploads/local/{key}"
    return {"upload_url": url, "key": key, "method": "PUT", "headers": {"Content-Type": body.content_type}}


@router.get("/pod/{order_id}")
def pod_view_url(order_id: int, user: User = Depends(get_current_user), db=Depends(get_db)):
    order = get_visible_order(order_id, user, db)
    if not order.pod_key:
        raise HTTPException(404, "No proof of delivery")
    if settings.s3_bucket:
        url = s3().generate_presigned_url(
            "get_object", Params={"Bucket": settings.s3_bucket, "Key": order.pod_key}, ExpiresIn=300,
        )
    else:
        url = f"{settings.public_api_url}/api/uploads/local/{order.pod_key}"
    return {"url": url}


def _local_path(key: str) -> Path:
    base = Path(settings.local_upload_dir).resolve()
    path = (base / key).resolve()
    if base not in path.parents or not key.startswith("pod/"):
        raise HTTPException(400, "Bad key")
    return path


if not settings.s3_bucket:
    @router.put("/local/{key:path}")
    async def local_put(key: str, request: Request):
        data = await request.body()
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Too large")
        path = _local_path(key)
        os.makedirs(path.parent, exist_ok=True)
        path.write_bytes(data)
        return {"ok": True}

    @router.get("/local/{key:path}")
    def local_get(key: str):
        path = _local_path(key)
        if not path.exists():
            raise HTTPException(404, "Not found")
        return FileResponse(path)

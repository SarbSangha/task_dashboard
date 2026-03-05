# routers/upload.py
import os
import time
from pathlib import Path
from typing import List, Optional
from urllib.parse import unquote, urlparse

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse, StreamingResponse


router = APIRouter(tags=["Upload"])


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.getenv(name, default)
    if value is None:
        return None
    value = value.strip()
    return value or default


def _is_r2_configured() -> bool:
    endpoint = _env("R2_ENDPOINT")
    access_key = _env("R2_ACCESS_KEY")
    secret_key = _env("R2_SECRET_KEY")
    bucket = _env("R2_BUCKET")
    values = [endpoint, access_key, secret_key, bucket]
    return all(values)


def _build_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=_env("R2_ENDPOINT"),
        aws_access_key_id=_env("R2_ACCESS_KEY"),
        aws_secret_access_key=_env("R2_SECRET_KEY"),
        region_name=_env("R2_REGION", "auto"),
    )


def _build_public_url(key: str) -> str:
    public_base = _env("R2_PUBLIC_BASE_URL")
    if public_base:
        return f"{public_base.rstrip('/')}/{key}"
    endpoint = _env("R2_ENDPOINT", "") or ""
    bucket = _env("R2_BUCKET", "") or ""
    return f"{endpoint.rstrip('/')}/{bucket}/{key}"


def _extract_r2_key(path: Optional[str], url: Optional[str]) -> Optional[str]:
    bucket = (_env("R2_BUCKET") or "").strip()
    if path:
        normalized = path.replace("\\", "/").lstrip("/")
        if normalized:
            return normalized

    if not url:
        return None
    parsed = urlparse(url)
    candidate = (parsed.path or "").lstrip("/")
    if not candidate:
        return None
    if bucket and candidate.startswith(f"{bucket}/"):
        candidate = candidate[len(bucket) + 1 :]
    return unquote(candidate) if candidate else None


def _safe_filename(filename: Optional[str], fallback: str = "download") -> str:
    name = (filename or fallback).strip()
    if not name:
        name = fallback
    return os.path.basename(name)


def _upload_to_r2(file: UploadFile, unique_filename: str, timestamp_ms: int) -> dict:
    key = f"task-attachments/{timestamp_ms}/{unique_filename}"
    client = _build_r2_client()

    file.file.seek(0)
    extra_args = {}
    if file.content_type:
        extra_args["ContentType"] = file.content_type

    upload_kwargs = {}
    if extra_args:
        upload_kwargs["ExtraArgs"] = extra_args

    client.upload_fileobj(
        file.file,
        _env("R2_BUCKET"),
        key,
        **upload_kwargs,
    )

    return {
        "filename": unique_filename,
        "originalName": file.filename,
        "path": key,
        "size": file.size,
        "mimetype": file.content_type,
        "url": _build_public_url(key),
        "storage": "r2",
    }


@router.post("/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload multiple files to Cloudflare R2."""
    try:
        if not _is_r2_configured():
            raise HTTPException(status_code=500, detail="R2 is not configured on server")

        uploaded_files = []
        for file in files:
            if not file.filename:
                continue

            file_extension = Path(file.filename).suffix
            timestamp_ms = int(time.time() * 1000)
            unique_filename = f"{Path(file.filename).stem}_{timestamp_ms}{file_extension}"

            try:
                uploaded_file = _upload_to_r2(file, unique_filename, timestamp_ms)
            except (ClientError, BotoCoreError, ValueError) as exc:
                raise HTTPException(status_code=500, detail=f"R2 upload failed: {exc}") from exc

            uploaded_files.append(uploaded_file)
            file.file.close()

        if not uploaded_files:
            raise HTTPException(status_code=400, detail="No valid files provided")

        print(f"✅ {len(uploaded_files)} file(s) uploaded successfully to R2")

        return {
            "success": True,
            "message": f"{len(uploaded_files)} file(s) uploaded successfully",
            "data": uploaded_files,
            "storage": "r2",
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"❌ Upload error: {str(exc)}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/files/open")
async def open_file(
    url: Optional[str] = Query(None),
    path: Optional[str] = Query(None),
):
    """Open a file from R2 via short-lived signed URL."""
    if not _is_r2_configured():
        raise HTTPException(status_code=500, detail="R2 is not configured on server")

    r2_key = _extract_r2_key(path, url)
    if r2_key:
        try:
            client = _build_r2_client()
            signed_url = client.generate_presigned_url(
                "get_object",
                Params={"Bucket": _env("R2_BUCKET"), "Key": r2_key},
                ExpiresIn=600,
            )
            return RedirectResponse(url=signed_url, status_code=307)
        except (ClientError, BotoCoreError) as exc:
            raise HTTPException(status_code=500, detail=f"Unable to open R2 file: {exc}") from exc

    if url and (url.startswith("http://") or url.startswith("https://")):
        return RedirectResponse(url=url, status_code=307)

    raise HTTPException(status_code=404, detail="File not found")


@router.get("/api/files/download")
async def download_file(
    filename: Optional[str] = Query(None),
    url: Optional[str] = Query(None),
    path: Optional[str] = Query(None),
):
    """Force-download a file from R2."""
    download_name = _safe_filename(filename)
    if not _is_r2_configured():
        raise HTTPException(status_code=500, detail="R2 is not configured on server")

    r2_key = _extract_r2_key(path, url)
    if r2_key:
        try:
            client = _build_r2_client()
            obj = client.get_object(Bucket=_env("R2_BUCKET"), Key=r2_key)
            content_type = obj.get("ContentType") or "application/octet-stream"
            body = obj["Body"]
            headers = {"Content-Disposition": f'attachment; filename="{download_name}"'}
            return StreamingResponse(body, media_type=content_type, headers=headers)
        except (ClientError, BotoCoreError) as exc:
            raise HTTPException(status_code=500, detail=f"Unable to download R2 file: {exc}") from exc

    if url and (url.startswith("http://") or url.startswith("https://")):
        return RedirectResponse(url=url, status_code=307)

    raise HTTPException(status_code=404, detail="File not found")

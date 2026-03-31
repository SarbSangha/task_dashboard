# routers/upload.py
import io
import os
import time
import zipfile
from uuid import uuid4
from pathlib import Path
from typing import List, Optional
from urllib.parse import unquote, urlparse

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
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


def _normalize_relative_path(relative_path: Optional[str]) -> Optional[str]:
    raw = (relative_path or "").replace("\\", "/").strip().lstrip("/")
    if not raw:
        return None

    parts = [part for part in raw.split("/") if part and part not in {".", ".."}]
    if not parts:
        return None

    return "/".join(parts)


def _safe_zip_entry_name(filename: Optional[str], fallback: str = "download") -> str:
    normalized = _normalize_relative_path(filename)
    if normalized:
        return normalized
    return _safe_filename(filename, fallback=fallback)


def _upload_to_r2(file: UploadFile, unique_filename: str, timestamp_ms: int, relative_path: Optional[str] = None) -> dict:
    normalized_relative_path = _normalize_relative_path(relative_path)
    relative_dir = ""
    if normalized_relative_path:
        relative_parent = Path(normalized_relative_path).parent.as_posix()
        if relative_parent not in {"", "."}:
            relative_dir = f"{relative_parent.strip('/')}/"

    key = f"task-attachments/{timestamp_ms}/{relative_dir}{unique_filename}"
    client = _build_r2_client()
    original_name = _safe_filename(file.filename, fallback=unique_filename)

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
        "originalName": original_name,
        "relativePath": normalized_relative_path,
        "path": key,
        "size": file.size,
        "mimetype": file.content_type,
        "url": _build_public_url(key),
        "storage": "r2",
    }


@router.post("/upload")
async def upload_files(
    files: List[UploadFile] = File(...),
    relative_paths: List[str] = Form(default=[]),
):
    """Upload multiple files to Cloudflare R2."""
    try:
        if not _is_r2_configured():
            raise HTTPException(status_code=500, detail="R2 is not configured on server")

        uploaded_files = []
        for index, file in enumerate(files):
            if not file.filename:
                continue

            file_extension = Path(file.filename).suffix
            timestamp_ms = int(time.time() * 1000)
            original_name = _safe_filename(file.filename, fallback=f"file{file_extension}")
            unique_filename = f"{Path(original_name).stem}_{timestamp_ms}_{uuid4().hex[:8]}{file_extension}"
            relative_path = relative_paths[index] if index < len(relative_paths) else None

            try:
                uploaded_file = _upload_to_r2(file, unique_filename, timestamp_ms, relative_path)
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


@router.get("/api/files/download-folder")
async def download_folder(
    name: Optional[str] = Query(None),
    path: List[str] = Query(default=[]),
    relative_paths: List[str] = Query(default=[], alias="relative_path"),
):
    """Download a folder attachment collection as a ZIP archive."""
    if not _is_r2_configured():
        raise HTTPException(status_code=500, detail="R2 is not configured on server")

    normalized_items = []
    for index, item_path in enumerate(path or []):
        r2_key = _extract_r2_key(item_path, None)
        if not r2_key:
            continue
        relative_path = relative_paths[index] if index < len(relative_paths) else None
        archive_name = _safe_zip_entry_name(relative_path, fallback=Path(r2_key).name)
        normalized_items.append((r2_key, archive_name))

    if not normalized_items:
        raise HTTPException(status_code=404, detail="Folder files not found")

    try:
        client = _build_r2_client()
        zip_buffer = io.BytesIO()
        seen_names = set()

        with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zip_file:
            for r2_key, archive_name in normalized_items:
                obj = client.get_object(Bucket=_env("R2_BUCKET"), Key=r2_key)
                entry_name = archive_name
                if entry_name in seen_names:
                    stem = Path(entry_name).stem
                    suffix = Path(entry_name).suffix
                    counter = 2
                    while f"{stem}_{counter}{suffix}" in seen_names:
                        counter += 1
                    entry_name = f"{stem}_{counter}{suffix}"
                seen_names.add(entry_name)
                zip_file.writestr(entry_name, obj["Body"].read())

        zip_buffer.seek(0)
        folder_name = _safe_filename(name or "folder")
        if not folder_name.lower().endswith(".zip"):
            folder_name = f"{folder_name}.zip"
        headers = {"Content-Disposition": f'attachment; filename="{folder_name}"'}
        return StreamingResponse(zip_buffer, media_type="application/zip", headers=headers)
    except (ClientError, BotoCoreError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Unable to download folder archive: {exc}") from exc

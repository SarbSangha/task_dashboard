# routers/upload.py
import io
import os
import shutil
import subprocess
import tempfile
import time
import zipfile
from uuid import uuid4
from pathlib import Path
from typing import List, Optional
from urllib.parse import unquote, urlparse

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from models_new import User
from routers.auth_router import get_current_user

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # pragma: no cover - dependency guard for environments not yet upgraded
    Image = None
    UnidentifiedImageError = OSError


router = APIRouter(tags=["Upload"])


class UploadPrepareFile(BaseModel):
    name: str = Field(min_length=1, max_length=512)
    size: int = Field(ge=0)
    contentType: Optional[str] = Field(default=None, max_length=255)
    relativePath: Optional[str] = Field(default=None, max_length=2048)


class UploadPreparePayload(BaseModel):
    files: List[UploadPrepareFile] = Field(default_factory=list, min_items=1, max_items=100)


class MultipartCompletePart(BaseModel):
    partNumber: int = Field(ge=1)
    etag: str = Field(min_length=1, max_length=512)


class MultipartCompletePayload(BaseModel):
    key: str = Field(min_length=1, max_length=2048)
    uploadId: str = Field(min_length=1, max_length=2048)
    parts: List[MultipartCompletePart] = Field(default_factory=list, min_items=1, max_items=10000)


class MultipartAbortPayload(BaseModel):
    key: str = Field(min_length=1, max_length=2048)
    uploadId: str = Field(min_length=1, max_length=2048)


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


def _multipart_part_size_bytes() -> int:
    raw_value = _env("R2_MULTIPART_PART_SIZE_MB", "24") or "24"
    try:
        megabytes = max(5, int(raw_value))
    except ValueError:
        megabytes = 24
    return megabytes * 1024 * 1024


def _build_public_url(key: str) -> str:
    public_base = _env("R2_PUBLIC_BASE_URL")
    if public_base:
        return f"{public_base.rstrip('/')}/{key}"
    endpoint = _env("R2_ENDPOINT", "") or ""
    bucket = _env("R2_BUCKET", "") or ""
    return f"{endpoint.rstrip('/')}/{bucket}/{key}"


def _normalized_content_type(content_type: Optional[str]) -> str:
    value = (content_type or "").strip()
    return value or "application/octet-stream"


def _should_use_multipart(size: Optional[int]) -> bool:
    if size is None:
        return False
    return size >= _multipart_part_size_bytes()


def _multipart_part_count(size: int, part_size: int) -> int:
    if size <= 0:
        return 1
    return max(1, (size + part_size - 1) // part_size)


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


def _build_attachment_record(
    filename: Optional[str],
    timestamp_ms: int,
    *,
    content_type: Optional[str] = None,
    size: Optional[int] = None,
    relative_path: Optional[str] = None,
) -> tuple[str, dict]:
    original_name = _safe_filename(filename)
    file_extension = Path(original_name).suffix
    unique_filename = f"{Path(original_name).stem}_{timestamp_ms}_{uuid4().hex[:8]}{file_extension}"
    normalized_relative_path = _normalize_relative_path(relative_path)

    relative_dir = ""
    if normalized_relative_path:
        relative_parent = Path(normalized_relative_path).parent.as_posix()
        if relative_parent not in {"", "."}:
            relative_dir = f"{relative_parent.strip('/')}/"

    key = f"task-attachments/{timestamp_ms}/{relative_dir}{unique_filename}"
    normalized_content_type = _normalized_content_type(content_type)

    return key, {
        "filename": unique_filename,
        "originalName": original_name,
        "relativePath": normalized_relative_path,
        "path": key,
        "size": size,
        "mimetype": normalized_content_type,
        "url": _build_public_url(key),
        "storage": "r2",
    }


def _safe_zip_entry_name(filename: Optional[str], fallback: str = "download") -> str:
    normalized = _normalize_relative_path(filename)
    if normalized:
        return normalized
    return _safe_filename(filename, fallback=fallback)


def _thumbnail_cache_key(r2_key: str, width: int) -> str:
    source = r2_key.replace("\\", "/").lstrip("/")
    return f"thumbnails/w{width}/{source}.webp"


def _is_video_content(content_type: str, r2_key: str) -> bool:
    extension = Path(r2_key).suffix.lower()
    return content_type.startswith("video/") or extension in {".mp4", ".mov", ".mkv", ".webm", ".avi"}


def _is_image_content(content_type: str, r2_key: str) -> bool:
    extension = Path(r2_key).suffix.lower()
    return content_type.startswith("image/") or extension in {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def _generate_image_thumbnail_bytes(source_bytes: bytes, width: int) -> bytes:
    if Image is None:
        raise HTTPException(status_code=503, detail="Thumbnail generation dependency is not installed")

    try:
        with Image.open(io.BytesIO(source_bytes)) as image:
            image.thumbnail((width, width), Image.Resampling.LANCZOS)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGB")
            output = io.BytesIO()
            image.save(output, format="WEBP", quality=78, method=6)
            return output.getvalue()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=415, detail="File is not a supported image") from exc


def _generate_video_thumbnail_bytes(source_bytes: bytes, width: int) -> bytes:
    if not shutil.which("ffmpeg"):
        raise HTTPException(status_code=503, detail="Video thumbnail generation requires ffmpeg")

    with tempfile.TemporaryDirectory() as temp_dir:
        input_path = Path(temp_dir) / "source-video"
        output_path = Path(temp_dir) / "thumbnail.webp"
        input_path.write_bytes(source_bytes)
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            "00:00:02",
            "-i",
            str(input_path),
            "-frames:v",
            "1",
            "-vf",
            f"scale='min({width},iw)':-2",
            "-q:v",
            "70",
            "-y",
            str(output_path),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, timeout=25)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            fallback_command = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(input_path),
                "-frames:v",
                "1",
                "-vf",
                f"scale='min({width},iw)':-2",
                "-q:v",
                "70",
                "-y",
                str(output_path),
            ]
            try:
                subprocess.run(fallback_command, check=True, capture_output=True, timeout=25)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                raise HTTPException(status_code=415, detail="Could not generate a video thumbnail") from exc

        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise HTTPException(status_code=415, detail="Could not generate a video thumbnail")

        return output_path.read_bytes()


def _generate_presigned_put_url(client, key: str, content_type: Optional[str]) -> str:
    params = {
        "Bucket": _env("R2_BUCKET"),
        "Key": key,
        "ContentType": _normalized_content_type(content_type),
    }
    return client.generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=900,
    )


def _generate_presigned_upload_part_url(client, key: str, upload_id: str, part_number: int) -> str:
    return client.generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": _env("R2_BUCKET"),
            "Key": key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=900,
    )


def _upload_to_r2(file: UploadFile, timestamp_ms: int, relative_path: Optional[str] = None) -> dict:
    key, attachment = _build_attachment_record(
        file.filename,
        timestamp_ms,
        content_type=file.content_type,
        size=getattr(file, "size", None),
        relative_path=relative_path,
    )
    client = _build_r2_client()

    file.file.seek(0)
    extra_args = {}
    if attachment["mimetype"]:
        extra_args["ContentType"] = attachment["mimetype"]

    upload_kwargs = {}
    if extra_args:
        upload_kwargs["ExtraArgs"] = extra_args

    client.upload_fileobj(
        file.file,
        _env("R2_BUCKET"),
        key,
        **upload_kwargs,
    )

    return attachment


@router.post("/api/uploads/presign")
def create_presigned_uploads(
    payload: UploadPreparePayload,
    _current_user: User = Depends(get_current_user),
):
    """Create short-lived presigned R2 upload URLs for direct browser uploads."""
    try:
        if not _is_r2_configured():
            raise HTTPException(status_code=500, detail="R2 is not configured on server")

        batch_timestamp = int(time.time() * 1000)
        client = _build_r2_client()
        upload_targets = []
        multipart_part_size = _multipart_part_size_bytes()

        for file in payload.files:
            key, attachment = _build_attachment_record(
                file.name,
                batch_timestamp,
                content_type=file.contentType,
                size=file.size,
                relative_path=file.relativePath,
            )

            if _should_use_multipart(file.size):
                try:
                    multipart = client.create_multipart_upload(
                        Bucket=_env("R2_BUCKET"),
                        Key=key,
                        ContentType=attachment["mimetype"],
                    )
                    upload_id = multipart["UploadId"]
                    part_count = _multipart_part_count(file.size, multipart_part_size)
                    if part_count > 10_000:
                        raise HTTPException(
                            status_code=400,
                            detail="File is too large for the current multipart upload configuration",
                        )
                    parts = [
                        {
                            "partNumber": part_number,
                            "uploadUrl": _generate_presigned_upload_part_url(client, key, upload_id, part_number),
                        }
                        for part_number in range(1, part_count + 1)
                    ]
                except HTTPException:
                    raise
                except (ClientError, BotoCoreError, ValueError) as exc:
                    raise HTTPException(status_code=500, detail=f"Unable to prepare multipart upload: {exc}") from exc

                upload_targets.append(
                    {
                        "strategy": "multipart",
                        "key": key,
                        "uploadId": upload_id,
                        "partSize": multipart_part_size,
                        "parts": parts,
                        "attachment": attachment,
                    }
                )
            else:
                try:
                    upload_url = _generate_presigned_put_url(client, key, attachment["mimetype"])
                except (ClientError, BotoCoreError, ValueError) as exc:
                    raise HTTPException(status_code=500, detail=f"Unable to prepare upload: {exc}") from exc

                upload_targets.append(
                    {
                        "strategy": "single",
                        "uploadUrl": upload_url,
                        "method": "PUT",
                        "headers": {
                            "Content-Type": attachment["mimetype"],
                        },
                        "attachment": attachment,
                    }
                )

        return {
            "success": True,
            "message": f"{len(upload_targets)} upload target(s) prepared successfully",
            "data": upload_targets,
            "storage": "r2",
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"❌ Presign error: {str(exc)}")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/api/uploads/multipart/complete")
def complete_multipart_upload(
    payload: MultipartCompletePayload,
    _current_user: User = Depends(get_current_user),
):
    try:
        if not _is_r2_configured():
            raise HTTPException(status_code=500, detail="R2 is not configured on server")

        client = _build_r2_client()
        normalized_parts = [
            {
                "PartNumber": part.partNumber,
                "ETag": part.etag.strip(),
            }
            for part in sorted(payload.parts, key=lambda item: item.partNumber)
        ]
        if not normalized_parts:
            raise HTTPException(status_code=400, detail="Multipart upload parts are required")

        client.complete_multipart_upload(
            Bucket=_env("R2_BUCKET"),
            Key=payload.key.strip(),
            UploadId=payload.uploadId.strip(),
            MultipartUpload={"Parts": normalized_parts},
        )
        return {
            "success": True,
            "message": "Multipart upload completed successfully",
        }
    except HTTPException:
        raise
    except (ClientError, BotoCoreError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Unable to complete multipart upload: {exc}") from exc


@router.post("/api/uploads/multipart/abort")
def abort_multipart_upload(
    payload: MultipartAbortPayload,
    _current_user: User = Depends(get_current_user),
):
    try:
        if not _is_r2_configured():
            raise HTTPException(status_code=500, detail="R2 is not configured on server")

        client = _build_r2_client()
        client.abort_multipart_upload(
            Bucket=_env("R2_BUCKET"),
            Key=payload.key.strip(),
            UploadId=payload.uploadId.strip(),
        )
        return {
            "success": True,
            "message": "Multipart upload aborted successfully",
        }
    except HTTPException:
        raise
    except (ClientError, BotoCoreError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Unable to abort multipart upload: {exc}") from exc


@router.post("/upload")
def upload_files(
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

            timestamp_ms = int(time.time() * 1000)
            relative_path = relative_paths[index] if index < len(relative_paths) else None

            try:
                uploaded_file = _upload_to_r2(file, timestamp_ms, relative_path)
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
def open_file(
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


@router.get("/api/files/thumbnail")
def thumbnail_file(
    url: Optional[str] = Query(None),
    path: Optional[str] = Query(None),
    width: int = Query(360, ge=120, le=960),
):
    """Serve a cached WebP thumbnail for image/video files stored in R2."""
    if not _is_r2_configured():
        raise HTTPException(status_code=500, detail="R2 is not configured on server")

    r2_key = _extract_r2_key(path, url)
    if not r2_key:
        if url and (url.startswith("http://") or url.startswith("https://")):
            return RedirectResponse(url=url, status_code=307)
        raise HTTPException(status_code=404, detail="File not found")

    client = _build_r2_client()
    bucket = _env("R2_BUCKET")
    cache_key = _thumbnail_cache_key(r2_key, width)

    try:
        client.head_object(Bucket=bucket, Key=cache_key)
        signed_url = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": cache_key},
            ExpiresIn=600,
        )
        return RedirectResponse(url=signed_url, status_code=307)
    except ClientError as exc:
        status_code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        error_code = exc.response.get("Error", {}).get("Code")
        if status_code not in {403, 404} and error_code not in {"404", "NoSuchKey", "NotFound"}:
            raise HTTPException(status_code=500, detail=f"Unable to check thumbnail cache: {exc}") from exc

    try:
        obj = client.get_object(Bucket=bucket, Key=r2_key)
        content_type = (obj.get("ContentType") or "").lower()
        body = obj["Body"].read()
        if _is_image_content(content_type, r2_key):
            thumbnail_bytes = _generate_image_thumbnail_bytes(body, width)
        elif _is_video_content(content_type, r2_key):
            thumbnail_bytes = _generate_video_thumbnail_bytes(body, width)
        else:
            raise HTTPException(status_code=415, detail="Thumbnails are only available for image and video files")

        client.put_object(
            Bucket=bucket,
            Key=cache_key,
            Body=thumbnail_bytes,
            ContentType="image/webp",
            CacheControl="public, max-age=31536000, immutable",
        )
        return StreamingResponse(io.BytesIO(thumbnail_bytes), media_type="image/webp")
    except HTTPException:
        raise
    except (ClientError, BotoCoreError) as exc:
        raise HTTPException(status_code=500, detail=f"Unable to generate thumbnail: {exc}") from exc


@router.get("/api/files/download")
def download_file(
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
def download_folder(
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

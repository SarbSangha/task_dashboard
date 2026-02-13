# routers/upload.py
from fastapi import APIRouter, UploadFile, File, HTTPException
from typing import List
import shutil
import os
from pathlib import Path
import time
from database_config import get_operational_db as get_db
from models_new import Task, User


router = APIRouter(tags=["Upload"])

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@router.post("/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload multiple files"""
    try:
        uploaded_files = []
        
        for file in files:
            # Create unique filename
            file_extension = Path(file.filename).suffix
            unique_filename = f"{Path(file.filename).stem}_{int(time.time() * 1000)}{file_extension}"
            file_path = os.path.join(UPLOAD_DIR, unique_filename)
            
            # Save file
            with open(file_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
            
            uploaded_files.append({
                "filename": unique_filename,
                "originalName": file.filename,
                "path": file_path,
                "size": os.path.getsize(file_path),
                "mimetype": file.content_type,
                "url": f"/uploads/{unique_filename}"
            })
        
        print(f"✅ {len(uploaded_files)} file(s) uploaded successfully")
        
        return {
            "success": True,
            "message": f"{len(uploaded_files)} file(s) uploaded successfully",
            "data": uploaded_files
        }
    except Exception as e:
        print(f"❌ Upload error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

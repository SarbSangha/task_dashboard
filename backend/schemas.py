# schemas.py - Updated to match models_new.py
from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime


class UserCreate(BaseModel):
    email: EmailStr
    name: str
    password: str = Field(..., min_length=6)
    position: Optional[str] = None
    department: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserLoginExtended(BaseModel):
    email: EmailStr
    password: str
    remember_me: bool = False


class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    position: Optional[str] = None
    department: Optional[str] = None
    is_active: bool = True
    created_at: Optional[datetime] = None
    last_login: Optional[datetime] = None
    avatar: Optional[str] = None
    # mfa_enabled: bool = False  # ← REMOVE THIS LINE (or make optional)
    
    class Config:
        from_attributes = True  # For Pydantic v2
        # orm_mode = True  # For Pydantic v1


class PasswordUpdate(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=6)


class MessageResponse(BaseModel):
    message: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(..., min_length=6)


class AvatarUpload(BaseModel):
    avatar: str  # Base64 encoded image


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    avatar: Optional[str] = None

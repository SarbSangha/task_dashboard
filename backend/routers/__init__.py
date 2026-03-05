# routers/__init__.py
"""
Routers package initialization
"""
from . import auth_router
from . import tasks_router
from . import drafts_router
from . import archive_router
from . import approvals
from . import upload
from . import activity_router
from . import admin_router
from . import groups_router

__all__ = [
    'auth_router',
    'tasks_router', 
    'drafts_router',
    'archive_router',
    'approvals',
    'upload',
    'activity_router',
    'admin_router',
    'groups_router'
]

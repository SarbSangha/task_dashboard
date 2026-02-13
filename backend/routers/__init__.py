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

__all__ = [
    'auth_router',
    'tasks_router', 
    'drafts_router',
    'archive_router',
    'approvals',
    'upload'
]

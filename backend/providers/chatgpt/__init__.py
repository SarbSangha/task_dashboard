# providers/chatgpt/__init__.py
"""
ChatGPT Capture & Conversation Intelligence System.

Importing this package registers the ChatGPT SQLAlchemy models onto the
shared declarative Base (see database_config.Base) so Base.metadata.create_all
picks them up during app startup.
"""
from . import models  # noqa: F401

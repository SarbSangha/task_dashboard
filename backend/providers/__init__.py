# providers/__init__.py
"""
Providers package: each AI tool/provider (ChatGPT, and future ones such as
Claude, Gemini) owns its own module (models, migrations, capture, recovery,
analytics, router) under providers/<name>/. Kling remains in the legacy flat
layout (models_new.py, routers/generation_*_router.py) for now.

Shared infrastructure (auth, permissions, database, observability) stays in
the existing top-level modules and is imported by provider modules rather
than duplicated.
"""

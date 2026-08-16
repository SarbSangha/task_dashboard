import importlib
import traceback

from database_config import archive_engine, operational_engine
from db_migrations import ensure_operational_schema
from models_new import ArchiveBase, Base


def _ascii_safe_text(value: object) -> str:
    return f"{value}".encode("ascii", "backslashreplace").decode("ascii")


def _safe_print(value: object = "") -> None:
    print(_ascii_safe_text(value), flush=True)


def _import_provider_models() -> list[str]:
    """Import every provider's model module so its tables are registered on
    Base.metadata before create_all runs.

    Base.metadata only knows about tables whose model modules have been
    imported, and this script's own imports (database_config, db_migrations,
    models_new) don't reach into providers/*/models.py. Most providers survived
    that because their migrations.py hand-writes CREATE TABLE - but Flow and
    ElevenLabs deliberately don't (see providers/elevenlabs/migrations.py's
    docstring: "this file does NOT hand-write CREATE TABLE"), so they depended
    entirely on a create_all that never saw them.

    The result in production (2026-08-16): flow_generations and
    elevenlabs_generations were never created, the ALTER TABLE passes for those
    providers then failed against tables that didn't exist, and both Capture
    Center tabs returned UndefinedTable to users.

    Driven off the registry rather than a hand-kept import list, so the next
    provider added is covered without anyone remembering to touch this file.
    """
    from providers.registry import PROVIDERS

    imported: list[str] = []
    failed: list[str] = []
    for slug, info in sorted(PROVIDERS.items()):
        module_name = getattr(info, "models_module", None)
        if not module_name:
            continue
        try:
            importlib.import_module(module_name)
            imported.append(module_name)
        except Exception as exc:  # noqa: BLE001 - reported below, never silent
            failed.append(f"{slug} ({module_name}): {exc}")

    for entry in failed:
        _safe_print(f"  WARNING: could not import models for {entry}")
    if failed:
        # Loud on purpose. A provider whose models fail to import silently
        # loses its tables, which is the exact failure this function exists to
        # prevent - it must not be possible to miss it in the deploy log.
        raise RuntimeError(
            f"{len(failed)} provider model module(s) failed to import; their tables would be "
            "silently skipped by create_all. Fix the import before deploying."
        )
    return imported


def main() -> int:
    try:
        _safe_print(f"Operational dialect: {operational_engine.dialect.name}")

        _safe_print("Importing provider model modules...")
        imported = _import_provider_models()
        _safe_print(f"  registered models from {len(imported)} provider module(s)")

        _safe_print(f"Creating operational model tables ({len(Base.metadata.tables)} known)...")
        Base.metadata.create_all(bind=operational_engine)

        _safe_print("Applying operational schema migration fixes...")
        ensure_operational_schema(operational_engine)

        if archive_engine is operational_engine:
            _safe_print("Archive database shares the operational engine; archive create_all skipped.")
        else:
            _safe_print(f"Archive dialect: {archive_engine.dialect.name}")
            _safe_print("Creating archive model tables...")
            ArchiveBase.metadata.create_all(bind=archive_engine)

        _safe_print("Database migration completed.")
        return 0
    except Exception as exc:
        _safe_print(f"Database migration failed: {exc}")
        _safe_print("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        return 1
    finally:
        operational_engine.dispose()
        if archive_engine is not operational_engine:
            archive_engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())

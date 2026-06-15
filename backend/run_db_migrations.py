import traceback

from database_config import archive_engine, operational_engine
from db_migrations import ensure_operational_schema
from models_new import ArchiveBase, Base


def _ascii_safe_text(value: object) -> str:
    return f"{value}".encode("ascii", "backslashreplace").decode("ascii")


def _safe_print(value: object = "") -> None:
    print(_ascii_safe_text(value), flush=True)


def main() -> int:
    try:
        _safe_print(f"Operational dialect: {operational_engine.dialect.name}")
        _safe_print("Creating operational model tables...")
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

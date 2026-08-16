"""Guards the rule that caused a production connection-pool outage: no request
handler may hold a database session across blocking network I/O.

Why this is a static check and not a runtime one
------------------------------------------------
Under the hosted Supabase pooler the app runs with NullPool (see
database_config.py), so there is no app-side pool to queue behind - every
checked-out session is a real client connection against the pooler's limit. A
handler that keeps its session while uploading to R2, fetching a remote asset,
or waiting on IMAP/SMTP therefore parks a real connection for the length of a
remote round-trip. Enough of those in flight and login and every other request
starve until the process restarts.

Nothing about that is visible in a unit test: each individual handler works
fine. It only shows up under concurrency, in production. So the invariant is
enforced here instead - by reading the code.

The rule
--------
A handler that receives a Session (via Depends(get_*_db)) or builds one must
call db.close() BEFORE any blocking call. Closing mid-request is safe and is
the established pattern in this codebase (routers/it_tools_router.py's OTP
endpoints, routers/reports_router.py's workbook export): the yield-dependency
closes again on the way out, which is a no-op, and SQLAlchemy transparently
re-acquires a connection the next time the Session is touched.

The one trap: db.close() DETACHES any ORM instance already loaded. Assigning to
a detached instance and committing looks like it worked and silently persists
nothing, so a handler that writes after releasing must re-query by id first -
see providers/envato/router.py's capture_download_media for the shape.

Run: python tests/db_session_hold_smoke.py
"""
import ast
import pathlib
import sys

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]

# Calls that wait on a remote host (or a slow local device) for an unbounded or
# multi-second period. Add to this list when a new one appears.
BLOCKING_CALLS = {
    # object storage
    "put_object", "get_object", "upload_fileobj", "download_fileobj",
    "create_multipart_upload", "complete_multipart_upload", "generate_presigned_url",
    "_upload_bytes_to_r2",
    # outbound HTTP
    "urlopen", "fetch_remote_media_bytes",
    # mail
    "IMAP4", "IMAP4_SSL", "SMTP", "SMTP_SSL",
    "fetch_otp_from_gmail", "latest_otp_uid_from_gmail", "fetch_auth_link_from_gmail",
    "send_report_email", "_test_mailbox_entry",
    # push
    "webpush", "_send_single_web_push",
}

SESSION_DEPENDENCIES = {"get_operational_db", "get_archive_db", "get_db", "get_dual_db"}
SESSION_FACTORIES = {"OperationalSessionLocal", "ArchiveSessionLocal", "SessionLocal"}
SESSION_VARIABLE_NAMES = {"db", "op_db", "operational_db", "archive_db", "ar_db"}

# Handlers deliberately exempt, with the reason. Keep this empty if you can; an
# entry here is a documented decision, not a place to silence the check.
ALLOWLIST: dict[tuple[str, str], str] = {}


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _call_name(node: ast.Call):
    return getattr(node.func, "id", None) or getattr(node.func, "attr", None)


def _dependency_name(node):
    """Depends(get_operational_db) -> 'get_operational_db'."""
    if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Depends" and node.args:
        arg = node.args[0]
        return getattr(arg, "id", None) or getattr(arg, "attr", None)
    return None


def _receives_session(fn) -> bool:
    args = fn.args
    defaults = list(args.defaults or [])
    positional = args.args[-len(defaults):] if defaults else []
    for _arg, default in zip(positional, defaults):
        if _dependency_name(default) in SESSION_DEPENDENCIES:
            return True
    for _arg, default in zip(args.kwonlyargs, args.kw_defaults or []):
        if default is not None and _dependency_name(default) in SESSION_DEPENDENCIES:
            return True
    return False


def _builds_session(fn) -> bool:
    return any(
        isinstance(node, ast.Call) and _call_name(node) in SESSION_FACTORIES
        for node in ast.walk(fn)
    )


def _first_release_line(fn):
    """Line of the first db.close(), or None."""
    lines = [
        node.lineno
        for node in ast.walk(fn)
        if isinstance(node, ast.Call)
        and _call_name(node) == "close"
        and getattr(getattr(node.func, "value", None), "id", "") in SESSION_VARIABLE_NAMES
    ]
    return min(lines) if lines else None


def _source_files():
    for path in sorted(BACKEND_DIR.rglob("*.py")):
        relative = path.relative_to(BACKEND_DIR).as_posix()
        if relative.split("/")[0] in {"venv", "venv_broken_old", "tests", "scripts", "__pycache__"}:
            continue
        if relative.startswith("routers/") or relative.startswith("providers/") or relative.startswith("utils/"):
            yield relative, path


def _functions_that_release_internally(trees):
    """Names of project functions that release the session themselves.

    Needed because a handler may delegate the blocking work: providers/chatgpt/
    router.py's capture_media calls store_media_asset, and the db.close() lives
    inside that callee. Without resolving one level, the delegating handler
    looks like a violation when it is in fact correct.
    """
    releasing = set()
    for _relative, tree in trees:
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if _first_release_line(node) is not None:
                    releasing.add(node.name)
    return releasing


def test_no_handler_holds_a_session_across_blocking_io() -> None:
    trees = []
    for relative, path in _source_files():
        try:
            trees.append((relative, ast.parse(path.read_text(encoding="utf-8", errors="ignore"))))
        except SyntaxError as exc:  # a file that doesn't parse is its own problem
            raise AssertionError(f"{relative} failed to parse: {exc}") from exc

    releases_internally = _functions_that_release_internally(trees)

    violations = []
    for relative, tree in trees:
        for fn in ast.walk(tree):
            if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not (_receives_session(fn) or _builds_session(fn)):
                continue
            if (relative, fn.name) in ALLOWLIST:
                continue
            release_line = _first_release_line(fn)
            for node in ast.walk(fn):
                if not isinstance(node, ast.Call):
                    continue
                name = _call_name(node)
                if name not in BLOCKING_CALLS and name not in releases_internally:
                    continue
                if name not in BLOCKING_CALLS:
                    continue
                if release_line is not None and release_line < node.lineno:
                    continue  # released before the blocking call - correct
                violations.append(f"  {relative}:{node.lineno}  {fn.name}() holds its session across {name}()")

    _assert(
        not violations,
        "database session held across blocking network I/O:\n"
        + "\n".join(sorted(set(violations)))
        + "\n\nRelease it with db.close() before the call (and re-query by id if you "
          "write afterwards - close() detaches loaded instances). See this module's "
          "docstring for why this is not optional.",
    )
    print("ok  no request handler holds a database session across blocking network I/O")


def test_delegated_blocking_work_is_still_covered() -> None:
    """The check above resolves one level of delegation. Prove that still
    works, so a future refactor that moves blocking I/O behind a helper can't
    quietly turn the whole check into a no-op."""
    trees = []
    for relative, path in _source_files():
        trees.append((relative, ast.parse(path.read_text(encoding="utf-8", errors="ignore"))))
    releasing = _functions_that_release_internally(trees)
    for expected in ("store_media_asset", "capture_download_media", "capture_audio"):
        _assert(
            expected in releasing,
            f"{expected}() no longer releases its session before blocking I/O - "
            "either it regressed, or it was renamed and this guard needs updating",
        )
    print("ok  delegated blocking work is still recognised as releasing its session")


def test_r2_clients_are_time_bounded() -> None:
    """botocore's defaults (60s connect + 60s read, 5 legacy retry attempts)
    let one stalled upload occupy its caller for minutes. Both R2 client
    builders must pass an explicit Config."""
    sys.path.insert(0, str(BACKEND_DIR))
    from utils import r2_storage
    from routers import upload as upload_router

    for label, config in (
        ("utils/r2_storage.build_client", r2_storage._r2_client_config()),
        ("routers/upload._build_r2_client", upload_router._r2_client_config()),
    ):
        _assert(config.connect_timeout and config.connect_timeout <= 30, f"{label}: connect_timeout unbounded")
        _assert(config.read_timeout and config.read_timeout <= 120, f"{label}: read_timeout unbounded")
        _assert(
            (config.retries or {}).get("max_attempts", 99) <= 5,
            f"{label}: retry count left at the botocore default",
        )
    print("ok  both R2 clients are built with explicit timeout and retry bounds")


if __name__ == "__main__":
    test_no_handler_holds_a_session_across_blocking_io()
    test_delegated_blocking_work_is_still_covered()
    test_r2_clients_are_time_bounded()
    print("\nall db session hold smoke checks passed")

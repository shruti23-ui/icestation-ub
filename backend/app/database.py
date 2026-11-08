"""SQLAlchemy engine/session. SQLite locally; swap DATABASE_URL for PostgreSQL later."""
from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATA_DIR, get_settings

settings = get_settings()
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _migrate_legacy_db_name() -> None:
    """The app was renamed IceStation -> WeParkit. Move an existing data/icestation.db (and its WAL files)
    to data/weparkit.db once, so users keep their accounts, lots and reports. Never overwrites."""
    new = DATA_DIR / "weparkit.db"
    old = DATA_DIR / "icestation.db"
    if not settings.database_url.endswith("/weparkit.db") or new.exists() or not old.exists():
        return
    moved: list[tuple] = []
    try:
        # The DB and its WAL/SHM must move together: all or nothing.
        for suffix in ("", "-wal", "-shm"):
            src, dst = DATA_DIR / f"icestation.db{suffix}", DATA_DIR / f"weparkit.db{suffix}"
            if src.exists():
                src.rename(dst)
                moved.append((dst, src))
    except OSError as exc:  # e.g. an old server still holds the file open: keep using the old name this run
        for dst, src in reversed(moved):
            try:
                dst.rename(src)
            except OSError:
                pass
        import logging
        logging.getLogger(__name__).warning("couldn't rename icestation.db -> weparkit.db (%s); using the old file", exc)
        settings.database_url = f"sqlite:///{old.as_posix()}"


_migrate_legacy_db_name()

_is_sqlite = settings.database_url.startswith("sqlite")
engine = create_engine(
    settings.database_url,
    # timeout: wait up to 15 s for a write lock instead of failing at once ("database is locked")
    connect_args={"check_same_thread": False, "timeout": 15} if _is_sqlite else {},
    pool_pre_ping=True,
    future=True,
)

if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        # WAL lets readers run while a writer commits: the API thread pool, the expiry loop and the
        # background cache refreshers no longer block each other.
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=15000")
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

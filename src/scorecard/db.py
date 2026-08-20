"""Database connection and initialization utilities."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Generator
from contextlib import contextmanager

from scorecard.config import DB_PATH

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


def get_connection(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Return a configured SQLite connection with foreign keys, row factory, and high-speed PRAGMAs."""
    target_path = Path(db_path) if db_path else DB_PATH
    target_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    if str(target_path) != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA cache_size = -64000;")
        conn.execute("PRAGMA mmap_size = 268435456;")
        conn.execute("PRAGMA temp_store = MEMORY;")
    return conn


@contextmanager
def db_session(db_path: Path | str | None = None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager for SQLite transactions."""
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
# add a column to a table that already exists, so they are applied explicitly.
_MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    (
        "market_observation",
        "source",
        "ALTER TABLE market_observation ADD COLUMN source TEXT NOT NULL DEFAULT 'massive_aggregates'",
    ),
)


def _apply_migrations(conn: sqlite3.Connection) -> None:
    for table, column, ddl in _MIGRATIONS:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not exists:
            continue
        columns = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            conn.execute(ddl)


def init_db(db_path: Path | str | None = None) -> None:
    """Initialize SQLite database with schema, applying any pending migrations."""
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        schema_sql = f.read()

    with db_session(db_path) as conn:
        conn.executescript(schema_sql)
        _apply_migrations(conn)


def reset_score_tables(conn: sqlite3.Connection) -> None:
    """Drop and recreate all score_* tables cleanly."""
    drop_sql = """
    DROP TABLE IF EXISTS score_bank;
    DROP TABLE IF EXISTS score_lag;
    DROP TABLE IF EXISTS score_probability;
    DROP TABLE IF EXISTS score_allocation;
    DROP TABLE IF EXISTS score_direction;
    """
    conn.executescript(drop_sql)

    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        schema_sql = f.read()
    conn.executescript(schema_sql)

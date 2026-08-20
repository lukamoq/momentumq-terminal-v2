"""Configuration and project paths for Sell-Side Scorecard."""

from __future__ import annotations

import os
import sqlite3
from datetime import date
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")

DATA_DIR = PROJECT_ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
MASSIVE_CACHE_DIR = CACHE_DIR / "massive"
TAVILY_CACHE_DIR = CACHE_DIR / "tavily"
CURATED_DIR = DATA_DIR / "curated"
DB_PATH = DATA_DIR / "scorecard.db"
WEB_DIR = PROJECT_ROOT / "web"

MASSIVE_API_KEY = os.getenv("MASSIVE_API_KEY", "")
MASSIVE_BASE_URL = os.getenv("MASSIVE_BASE_URL", "https://api.massive.com")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

# Product & Modeling Parameters
DIRECTION_BAND = 0.02  # 2% band for bullish/bearish/neutral

# S&P 500 index level = SPY x 10.
#
# The vendor plan does not carry index aggregates (``I:SPX`` returns 403
# NOT_AUTHORIZED), so the index level is reconstructed from the ETF. The two
# are not identical: SPY's price is the index divided by ten less the dividend
# it has accrued but not yet distributed, so SPY x 10 runs a few tenths of a
# percent under SPX and the gap resets each ex-date. Scored *returns* are
# unaffected because both ends of every window use the same series; what the
# gap does touch is ``target / spot - 1`` for a call whose target was published
# against the real index. ``SPX_TRACKING_NOTE`` is surfaced through the API so
# the terminal states this rather than implying an exact index print.
SPY_PROXY_MULTIPLIER = 10.0
SPX_TRACKING_NOTE = (
    "S&P 500 levels are reconstructed as SPY x 10; the vendor plan carries no "
    "index aggregates. SPY x 10 trades marginally below the cash index by the "
    "dividend accrued since the last distribution."
)

HORIZONS = ("1M", "3M", "6M", "YE")
HORIZON_DAYS = {
    "1M": 30,
    "3M": 90,
    "6M": 180,
    "YE": None,  # Evaluates to 2026-12-31
}
CLIMATOLOGY_RECESSION_PRIOR = 1.0 / 6.0  # ~16.67% prior for 1-year recession
HISTORY_START_DATE = "2021-08-19"  # start of the 5-year market window
YEAR_END_2026 = "2026-12-31"
MAX_SPOT_LOOKBACK_DAYS = 7

# Underlyings whose full option chain is ingested. These three carry the index
# trio the options page reports on; every Greek, wall, and volatility figure on
# that page is computed from their observed chains.
OPTIONS_UNDERLYINGS = ("SPY", "QQQ", "IWM")
OPTION_CHAIN_MAX_DTE = 120      # far-dated contracts carry no gamma worth plotting
OPTION_CHAIN_STRIKE_SPAN = 0.20  # +/- 20% of spot

# Fallback only. The live value is the newest bar in market_observation and is
# resolved by resolve_as_of_date(); this constant is what a caller gets when no
# database exists yet (fresh clone, tests against an empty schema).
AS_OF_DATE_FALLBACK = "2026-08-18"

_AS_OF_CACHE: Optional[str] = None


def resolve_as_of_date(db_path: Optional[Path] = None, refresh: bool = False) -> str:
    """Latest session actually present in the database.

    The as-of date used to be a literal, which froze every window boundary at
    the day the constant was typed: ingesting newer bars changed nothing
    downstream because scoring still asked "has this horizon elapsed as of
    2026-08-18?". Reading it from the data means a sync moves the terminal
    forward on its own.
    """
    global _AS_OF_CACHE
    if _AS_OF_CACHE is not None and not refresh:
        return _AS_OF_CACHE

    target = Path(db_path) if db_path else DB_PATH
    resolved = AS_OF_DATE_FALLBACK
    if target.exists():
        try:
            conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
            try:
                row = conn.execute(
                    "SELECT MAX(date) FROM market_observation WHERE ticker = 'SPY'"
                ).fetchone()
            finally:
                conn.close()
            if row and row[0]:
                resolved = str(row[0])
        except sqlite3.Error:
            resolved = AS_OF_DATE_FALLBACK

    # Never evaluate a horizon against a date that has not happened yet.
    today = date.today().isoformat()
    if resolved > today:
        resolved = today

    _AS_OF_CACHE = resolved
    return resolved


def invalidate_as_of_cache() -> None:
    """Drop the memoised as-of date after an ingest has written new bars."""
    global _AS_OF_CACHE
    _AS_OF_CACHE = None


# Module-level convenience for the many call sites that use it as a default
# argument. Callers that must see a post-sync value call resolve_as_of_date().
AS_OF_DATE = resolve_as_of_date()

"""
Deep historical backfill for the seasonality window.

Why this exists as a separate feed: the Massive plan serves a **rolling
five-year window** of daily aggregates. Ask it for SPY from 1995 and it returns
1,253 bars starting five years ago, not 6,700 starting in 2000. The 27-year
seasonality matrix and the cumulative-path curves need the years before that
window, so the archive is filled from Yahoo's public chart endpoint and the two
feeds are kept in their own lanes:

* Massive owns everything inside its window and is refreshed on every sync.
* This module owns only dates **strictly before** that window. It never writes
  into the vendor's span, so the two sources cannot disagree about a session.

Every row written here is tagged ``source = 'yahoo_chart_archive'`` so the
provenance of any bar is answerable from the database.

Two things this module used to do that made the archive untrustworthy:

* ``period2`` was the literal ``1787025600`` (August 2026), so the fetch window
  stopped at whatever date was typed in rather than following the calendar.
* ``vwap`` was set to the close and ``num_trades`` to 0. Yahoo's chart endpoint
  publishes neither. Writing a stand-in put fabricated values in columns that
  read as observed; they are now left NULL.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import urllib.request
from datetime import date, datetime, timezone
from typing import Dict, List, Optional

from scorecard.config import HISTORY_START_DATE, SPY_PROXY_MULTIPLIER
from scorecard.db import get_connection, init_db

logger = logging.getLogger(__name__)

try:  # zoneinfo is stdlib on 3.9+, but keep the import local to this module
    from zoneinfo import ZoneInfo

    NY_TZ = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover - platform without tzdata
    NY_TZ = timezone.utc

ARCHIVE_SOURCE = "yahoo_chart_archive"

# Tickers whose pre-window history the terminal actually reports on: the index
# trio, the equal-weight benchmark, and the Magnificent 7 constituents.
TICKERS_TO_BACKFILL = (
    "SPY", "QQQ", "IWM", "RSP", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"
)

# Earliest year each symbol has a real listing history for. Asking before this
# returns nothing, or worse, a different issuer's bars.
TICKER_INCEPTION_YEAR = {
    "SPY": 2000,
    "QQQ": 2000,
    "IWM": 2000,
    "AAPL": 2000,
    "MSFT": 2000,
    "NVDA": 2000,
    "AMZN": 2000,
    "RSP": 2003,
    "GOOGL": 2004,
    "TSLA": 2010,
    "META": 2012,
}

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"


def fetch_historical_bars(
    ticker: str,
    start_year: Optional[int] = None,
    end_date: Optional[str] = None,
) -> List[Dict]:
    """Fetch daily bars from ``start_year`` up to ``end_date`` (default: today)."""
    symbol = ticker.upper()
    s_yr = start_year or TICKER_INCEPTION_YEAR.get(symbol, 2000)
    period1 = int(datetime(s_yr, 1, 1, tzinfo=timezone.utc).timestamp())
    stop = date.fromisoformat(end_date) if end_date else date.today()
    period2 = int(datetime(stop.year, stop.month, stop.day, tzinfo=timezone.utc).timestamp()) + 86400

    url = (
        f"{YAHOO_CHART_URL.format(ticker=symbol)}"
        f"?period1={period1}&period2={period2}&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.error("Failed to fetch %s from the archive endpoint: %s", symbol, exc)
        return []

    try:
        result = data["chart"]["result"][0]
        timestamps = result.get("timestamp", []) or []
        quote = result["indicators"]["quote"][0]
    except (KeyError, IndexError, TypeError) as exc:
        logger.error("Unexpected archive payload for %s: %s", symbol, exc)
        return []

    closes = quote.get("close", [])
    opens = quote.get("open", [])
    highs = quote.get("high", [])
    lows = quote.get("low", [])
    volumes = quote.get("volume", [])

    observations: List[Dict] = []
    for i, ts in enumerate(timestamps):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        dt_str = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(NY_TZ).date().isoformat()

        def _at(seq, default):
            v = seq[i] if i < len(seq) else None
            return float(v) if v is not None else default

        close = float(c)
        observations.append({
            "date": dt_str,
            "ticker": symbol,
            "open": round(_at(opens, close), 4),
            "high": round(_at(highs, close), 4),
            "low": round(_at(lows, close), 4),
            "close": round(close, 4),
            "volume": _at(volumes, 0.0),
            # Yahoo's chart endpoint publishes neither a VWAP nor a trade
            # count. NULL is the honest value; the close is not a VWAP.
            "vwap": None,
            "num_trades": None,
            "index_level": (
                round(close * SPY_PROXY_MULTIPLIER, 4) if symbol in ("SPY", "SPX") else None
            ),
            "source": ARCHIVE_SOURCE,
        })
    return observations


def backfill_all_tickers(
    conn: sqlite3.Connection,
    start_year: int = 2000,
    boundary: str = HISTORY_START_DATE,
    tickers: tuple[str, ...] = TICKERS_TO_BACKFILL,
) -> Dict[str, int]:
    """Write archive bars dated strictly before ``boundary`` into the database.

    ``boundary`` is where the vendor's rolling window begins. Staying strictly
    below it means an archive run can never overwrite a vendor bar, so the two
    feeds never contradict each other on a session both could claim.
    """
    results: Dict[str, int] = {}

    for ticker in tickers:
        observations = [
            o for o in fetch_historical_bars(ticker, start_year=start_year)
            if o["date"] < boundary
        ]
        if not observations:
            results[ticker] = 0
            logger.warning("No archive bars before %s for %s.", boundary, ticker)
            continue

        conn.executemany(
            """
            INSERT INTO market_observation (
                date, ticker, open, high, low, close, volume, vwap,
                num_trades, index_level, source
            ) VALUES (
                :date, :ticker, :open, :high, :low, :close, :volume, :vwap,
                :num_trades, :index_level, :source
            )
            ON CONFLICT(date, ticker) DO UPDATE SET
                open = excluded.open,
                high = excluded.high,
                low = excluded.low,
                close = excluded.close,
                volume = excluded.volume,
                vwap = excluded.vwap,
                num_trades = excluded.num_trades,
                index_level = excluded.index_level,
                source = excluded.source
            """,
            observations,
        )
        conn.commit()
        results[ticker] = len(observations)
        logger.info(
            "Archived %d bars for %s (%s to %s).",
            len(observations), ticker, observations[0]["date"], observations[-1]["date"],
        )

    return results


def archive_coverage(conn: sqlite3.Connection) -> List[Dict]:
    """Per-ticker bar counts split by feed, for reporting provenance."""
    rows = conn.execute(
        """
        SELECT ticker, source, COUNT(*) AS bars, MIN(date) AS first_date, MAX(date) AS last_date
        FROM market_observation
        GROUP BY ticker, source
        ORDER BY ticker, source
        """
    ).fetchall()
    return [dict(r) for r in rows]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    init_db()
    conn = get_connection()
    try:
        logger.info("Backfilling archive history before %s...", HISTORY_START_DATE)
        res = backfill_all_tickers(conn)
        logger.info("Backfill complete: %s", res)
    finally:
        conn.close()

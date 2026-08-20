"""Market data client and storage for Massive API (SPY, ACWI, BIL)."""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from zoneinfo import ZoneInfo

import httpx

from scorecard.config import (
    HISTORY_START_DATE,
    MASSIVE_API_KEY,
    MASSIVE_BASE_URL,
    MASSIVE_CACHE_DIR,
    MAX_SPOT_LOOKBACK_DAYS,
    SPY_PROXY_MULTIPLIER,
)

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")
MAG7_TICKERS = ("NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA")

# Broad-market and benchmark series the scorecard scores against.
CORE_TICKERS = ("SPY", "ACWI", "BIL", "QQQ", "RSP", "IWM", "MDY", "IWF", "IWD", "MTUM")

# GICS sector SPDRs — lets a sector-rotation call be scored against the sector
# it actually named rather than against the index.
SECTOR_TICKERS = ("XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC")

# Rates / credit, commodities & dollar, international, volatility.
MACRO_TICKERS = (
    "TLT", "IEF", "SHY", "HYG", "LQD", "TIP", "AGG",
    "GLD", "SLV", "USO", "DBC", "UUP",
    "EFA", "EEM", "VGK", "EWJ", "FXI",
    "VIXY", "UVXY", "SVXY",
)

# AI / semis complex the desks called alongside the Magnificent 7.
AI_ADJACENT_TICKERS = ("AVGO", "TSM", "AMD", "ORCL", "CRM", "NFLX", "PLTR", "MU", "SMCI", "ASML", "ARM", "INTC")

# Large caps outside tech, carried so that "breadth" means breadth.
#
# The Fear & Greed breadth and liquidity scorers name a cross-sector universe
# (financials, healthcare, energy, industrials, discretionary) but none of those
# symbols were ever ingested, and both scorers skip a ticker with no bars
# without saying so. Half the named universe silently vanished and what
# survived was eight mega-cap tech names -- so the "advance/decline" and
# "% above the 200-day" readings were tech momentum wearing a breadth label.
BREADTH_TICKERS = (
    "JPM", "BAC", "GS", "UNH", "JNJ", "LLY", "PFE", "HD", "MCD",
    "XOM", "CVX", "DIS", "CAT", "BA", "HON", "PG", "KO", "WMT", "COST", "VZ",
)

DEFAULT_TICKERS = (
    CORE_TICKERS + MAG7_TICKERS + SECTOR_TICKERS + MACRO_TICKERS
    + AI_ADJACENT_TICKERS + BREADTH_TICKERS
)

# Ticker lineage: which vendor symbol carried the company we are scoring, over
# which dates. Vendor aggregates key on the *symbol*, not the issuer, so a
# reassigned symbol splices two unrelated companies into one series unless the
# history is reassembled segment by segment.
#
#   META — Meta Platforms traded as FB until 2022-06-09.
#          * Before that date the META symbol belonged to Meta Materials Inc.
#            (112 bars at $12-15 on ~1.7M median volume), which produced a
#            fabricated +1,395% overnight "gain" into Meta Platforms' $184.
#          * FB carries the real pre-rename history: 202 bars, 2021-08-20 to
#            2022-06-08, $175-382 on ~24M median volume, covering every SPY
#            session in the window. The boundary is continuous (-6.4% on
#            2022-06-09, a real session).
#          * FB was itself reassigned later; its post-2025-06-26 bars ($40-45
#            on ~700 shares/day) belong to a different issuer and are excluded
#            by the segment's end date.
#
# Each segment is (source_symbol, valid_from_inclusive, valid_to_exclusive);
# None means unbounded on that side.
TICKER_LINEAGE: Dict[str, List[Tuple[str, Optional[str], Optional[str]]]] = {
    "META": [
        ("FB", None, "2022-06-09"),
        ("META", "2022-06-09", None),
    ],
}


def lineage_segments(ticker: str) -> List[Tuple[str, Optional[str], Optional[str]]]:
    """Segments that make up `ticker`'s canonical series (identity by default)."""
    return TICKER_LINEAGE.get(ticker.upper(), [(ticker.upper(), None, None)])


def lineage_source_symbols(ticker: str) -> List[str]:
    """Vendor symbols that must be cached to build `ticker`."""
    return [src for src, _, _ in lineage_segments(ticker)]


def expand_to_source_symbols(tickers: Iterable[str]) -> tuple[str, ...]:
    """Every vendor symbol needed to assemble `tickers`, canonical order preserved.

    A canonical series can be spliced from more than one vendor symbol -- META
    needs FB for everything before the 2022 rename. Fetching only the canonical
    names left the other segment's cache frozen at whatever window it was first
    pulled on, and because the plan serves a *rolling* five-year window the two
    halves drifted apart: META kept a 2021-08-20 bar that every freshly-fetched
    peer had already rolled off, so the equal-weight basket and the normalised
    return chart no longer shared a first session.
    """
    out: List[str] = []
    for ticker in tickers:
        for source in lineage_source_symbols(ticker):
            if source not in out:
                out.append(source)
    return tuple(out)


def parse_massive_response(raw_data: Dict[str, Any], ticker: str) -> List[Dict[str, Any]]:
    """Parse Massive daily bar response into normalized database records.

    Timestamp is converted to Eastern Time (America/New_York) calendar date.
    SPY close is multiplied by 10 to proxy the S&P 500 index level.
    """
    results = raw_data.get("results", [])
    observations = []
    for bar in results:
        ms = bar["t"]
        dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).astimezone(NY_TZ).date()
        date_str = dt.isoformat()
        close = float(bar["c"])
        open_p = float(bar.get("o", close))
        high_p = float(bar.get("h", close))
        low_p = float(bar.get("l", close))
        volume = float(bar.get("v", 0.0))
        vwap = float(bar.get("vw", close))
        num_trades = int(bar.get("n", 0))

        index_level = round(close * SPY_PROXY_MULTIPLIER, 4) if ticker.upper() in ("SPY", "SPX") else None

        observations.append(
            {
                "date": date_str,
                "ticker": ticker.upper(),
                "open": open_p,
                "high": high_p,
                "low": low_p,
                "close": close,
                "volume": volume,
                "vwap": vwap,
                "num_trades": num_trades,
                "index_level": index_level,
            }
        )
    return observations


def load_lineage_observations(ticker: str) -> List[Dict[str, Any]]:
    """Assemble `ticker`'s canonical series from its lineage segments."""
    canonical = ticker.upper()
    rows: Dict[str, Dict[str, Any]] = {}
    for source, start, end in lineage_segments(canonical):
        cache_file = MASSIVE_CACHE_DIR / f"{source}.json"
        if not cache_file.exists():
            fetch_and_cache_market_data((source,))
        if not cache_file.exists():
            logger.warning("No cache for lineage segment %s of %s", source, canonical)
            continue
        with open(cache_file, "r", encoding="utf-8") as f:
            raw = json.load(f)
        for obs in parse_massive_response(raw, source):
            d = obs["date"]
            if start and d < start:
                continue
            if end and d >= end:
                continue
            obs = dict(obs)
            obs["ticker"] = canonical
            # index_level is derived from the canonical symbol, not the source.
            obs["index_level"] = (
                round(obs["close"] * SPY_PROXY_MULTIPLIER, 4)
                if canonical in ("SPY", "SPX") else None
            )
            rows[d] = obs
    if canonical in TICKER_LINEAGE:
        logger.info(
            "%s: assembled %d bars from %d lineage segment(s): %s",
            canonical, len(rows), len(lineage_segments(canonical)),
            ", ".join(f"{src}[{st or '..'}:{en or '..'}]" for src, st, en in lineage_segments(canonical)),
        )
    return [rows[d] for d in sorted(rows)]


def fetch_and_cache_market_data(
    tickers: tuple[str, ...] = DEFAULT_TICKERS,
    from_date: str = HISTORY_START_DATE,
    to_date: Optional[str] = None,
    force_api: bool = False,
) -> Dict[str, int]:
    """Fetch market data from Massive or load from disk cache.

    ``to_date`` defaults to *today*, not to the configured as-of date. Pinning
    the upper bound to the as-of date made refreshing circular: the as-of date
    is derived from the newest bar in the database, so a fetch bounded by it
    could never pull the bar that would move it forward.
    """
    MASSIVE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    to_date = to_date or date.today().isoformat()
    counts = {}

    for ticker in expand_to_source_symbols(tickers):
        cache_file = MASSIVE_CACHE_DIR / f"{ticker.upper()}.json"
        data = None

        if MASSIVE_API_KEY and (force_api or not cache_file.exists()):
            base = MASSIVE_BASE_URL.rstrip("/")
            url = f"{base}/v2/aggs/ticker/{ticker.upper()}/range/1/day/{from_date}/{to_date}"
            headers = {"Authorization": f"Bearer {MASSIVE_API_KEY}"}
            try:
                with httpx.Client(timeout=30.0) as client:
                    resp = client.get(url, headers=headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        with open(cache_file, "w", encoding="utf-8") as f:
                            json.dump(data, f, indent=2)
                        logger.info(f"Fetched and cached {ticker} from Massive API")
                    else:
                        logger.warning(f"Massive API returned {resp.status_code} for {ticker}: {resp.text}")
            except Exception as e:
                logger.warning(f"Failed to fetch {ticker} from Massive API: {e}")

        if data is None and cache_file.exists():
            with open(cache_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            logger.info(f"Loaded {ticker} from cache {cache_file}")

        if data:
            obs = parse_massive_response(data, ticker)
            counts[ticker] = len(obs)
        else:
            counts[ticker] = 0

    return counts


def load_market_data_into_db(conn: sqlite3.Connection, tickers: tuple[str, ...] = DEFAULT_TICKERS) -> int:
    """Load all cached/fetched market data into the SQLite market_observation table.

    The vendor plan serves a rolling five-year window, so a fetch can only ever
    speak for the span it actually returned. Reconciliation is therefore bounded
    to ``[min(fetched), max(fetched)]``: inside that span a date the vendor no
    longer lists is genuinely stale and is removed (this is what evicts a
    reassigned symbol's bars); outside it, the rows are deep history from
    :mod:`scorecard.backfill` and must survive untouched.

    Bounding this was not cosmetic. Reconciling against the whole table deleted
    every bar older than the vendor window on each run, so one `ingest` -- or
    one press of the terminal's SYNC button -- cut SPY from 6,696 bars back to
    2000 down to 1,254 back to 2021 and silently turned the "27-year" cycle
    curves into six years.
    """
    total_loaded = 0
    for ticker in tickers:
        canonical = ticker.upper()
        observations = load_lineage_observations(canonical)
        if observations:
            valid = {o["date"] for o in observations}
            window_start = min(valid)
            window_end = max(valid)
            existing = [
                r["date"] for r in conn.execute(
                    "SELECT date FROM market_observation WHERE ticker = ? AND date BETWEEN ? AND ?",
                    (canonical, window_start, window_end),
                ).fetchall()
            ]
            stale = [d for d in existing if d not in valid]
            if stale:
                logger.info(
                    "%s: evicting %d stale bar(s) inside the vendor window %s..%s",
                    canonical, len(stale), window_start, window_end,
                )
                conn.executemany(
                    "DELETE FROM market_observation WHERE ticker = ? AND date = ?",
                    [(canonical, d) for d in stale],
                )
            for obs in observations:
                conn.execute(
                    """
                    INSERT INTO market_observation (date, ticker, open, high, low, close, volume, vwap, num_trades, index_level)
                    VALUES (:date, :ticker, :open, :high, :low, :close, :volume, :vwap, :num_trades, :index_level)
                    ON CONFLICT(date, ticker) DO UPDATE SET
                        open = excluded.open,
                        high = excluded.high,
                        low = excluded.low,
                        close = excluded.close,
                        volume = excluded.volume,
                        vwap = excluded.vwap,
                        num_trades = excluded.num_trades,
                        index_level = excluded.index_level
                    """,
                    obs,
                )
                total_loaded += 1
    conn.commit()
    return total_loaded


def get_spot_at_publication(
    conn: sqlite3.Connection,
    ticker: str,
    published_on: str,
    max_lookback_days: int = MAX_SPOT_LOOKBACK_DAYS,
) -> float:
    """Find the spot price/index level on or immediately before published_on.

    Fails if the gap is greater than max_lookback_days.
    """
    actual_ticker = "SPY" if ticker.upper() in ("SPX", "SPY") else ticker.upper()
    cur = conn.execute(
        """
        SELECT date, close, index_level FROM market_observation
        WHERE ticker = ? AND date <= ?
        ORDER BY date DESC LIMIT 1
        """,
        (actual_ticker, published_on),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(
            f"No market data found for {ticker} on or before publication date {published_on}."
        )

    found_date = date.fromisoformat(row["date"])
    pub_date = date.fromisoformat(published_on)
    gap_days = (pub_date - found_date).days

    if gap_days > max_lookback_days:
        raise ValueError(
            f"Market data gap for {ticker} at {published_on} is {gap_days} calendar days "
            f"(last available: {row['date']}, max allowed: {max_lookback_days})."
        )

    if ticker.upper() in ("SPX", "SPY") and row["index_level"] is not None:
        return float(row["index_level"])
    return float(row["close"])


def get_price_at_date(
    conn: sqlite3.Connection, ticker: str, target_date: str, max_lookback_days: int = MAX_SPOT_LOOKBACK_DAYS
) -> Optional[float]:
    """Retrieve market price on or immediately before target_date."""
    try:
        return get_spot_at_publication(conn, ticker, target_date, max_lookback_days)
    except ValueError:
        return None


def get_all_trading_dates(conn: sqlite3.Connection, ticker: str = "SPY") -> List[str]:
    """Return all unique trading dates in chronological order."""
    cur = conn.execute(
        "SELECT DISTINCT date FROM market_observation WHERE ticker = ? ORDER BY date ASC",
        (ticker.upper(),),
    )
    return [row["date"] for row in cur.fetchall()]

"""Observed reference data: options chains, the Treasury curve, splits, dividends, market cap.

Everything in this module is *fetched and stored*, never modeled. It exists
because the analytics layer used to invent the inputs it could not look up --
implied volatility was the VIXY share price times a constant, open interest was
a gaussian ladder, the risk-free rate and dividend yields were literals, and
market caps were typed into a dict that went stale by tens of percent. All of
those are served by the vendor on the plan this project already pays for.

Entitlements actually available (verified against the live API):
  * ``/v3/snapshot/options/{underlying}`` -- full chain with open interest,
    day volume/close, vendor greeks and vendor implied volatility.
  * ``/fed/v1/treasury-yields``            -- constant-maturity Treasury curve.
  * ``/v3/reference/splits``               -- corporate split history.
  * ``/v3/reference/dividends``            -- cash dividend history.
  * ``/v3/reference/tickers/{ticker}``     -- name, market cap, shares.

NOT entitled (do not add code paths that assume them): index aggregates
(``I:SPX``, ``I:VIX``) and options quotes/trades (NBBO, tick). That is why the
volatility index in :mod:`scorecard.volatility` is computed from the SPY option
chain with the CBOE model-free formula rather than read off a VIX feed.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx

from scorecard.config import (
    MASSIVE_API_KEY,
    MASSIVE_BASE_URL,
    MASSIVE_CACHE_DIR,
    OPTION_CHAIN_MAX_DTE,
    OPTION_CHAIN_STRIKE_SPAN,
    OPTIONS_UNDERLYINGS,
)

logger = logging.getLogger(__name__)

OPTIONS_CACHE_DIR = MASSIVE_CACHE_DIR / "options"
REFERENCE_CACHE_DIR = MASSIVE_CACHE_DIR / "reference"

# Vendor IV outside this range is a solver artefact (deep ITM contracts whose
# stale daily close sits below intrinsic solve to ~0), not a market quote.
MIN_SANE_IV = 0.01
MAX_SANE_IV = 3.00


def _headers() -> Dict[str, str]:
    return {"Authorization": f"Bearer {MASSIVE_API_KEY}"}


def _paginate(url: str, cap: int = 20000) -> List[Dict[str, Any]]:
    """Follow ``next_url`` until the vendor stops paging or ``cap`` is reached."""
    out: List[Dict[str, Any]] = []
    with httpx.Client(timeout=60.0) as client:
        while url and len(out) < cap:
            resp = client.get(url, headers=_headers())
            if resp.status_code != 200:
                logger.warning("Vendor returned %s for %s: %s", resp.status_code, url, resp.text[:200])
                break
            payload = resp.json()
            out.extend(payload.get("results", []) or [])
            url = payload.get("next_url") or ""
    return out


# ---------------------------------------------------------------------------
# Options chains
# ---------------------------------------------------------------------------

def _chain_cache_path(underlying: str) -> Path:
    return OPTIONS_CACHE_DIR / f"{underlying.upper()}.json"


def fetch_option_chain(
    underlying: str,
    spot: float,
    max_dte: int = OPTION_CHAIN_MAX_DTE,
    strike_span: float = OPTION_CHAIN_STRIKE_SPAN,
    force_api: bool = False,
    today: Optional[str] = None,
) -> Dict[str, Any]:
    """Fetch (or load from cache) one underlying's listed option chain.

    The pull is bounded to strikes within ``strike_span`` of spot and expiries
    inside ``max_dte`` days: past those bounds contracts carry no gamma and no
    meaningful open interest, and the page count grows without adding signal.
    """
    underlying = underlying.upper()
    cache_file = _chain_cache_path(underlying)
    snapshot_day = today or date.today().isoformat()

    if MASSIVE_API_KEY and (force_api or not cache_file.exists()):
        lo = round(spot * (1.0 - strike_span), 2)
        hi = round(spot * (1.0 + strike_span), 2)
        exp_max = (date.fromisoformat(snapshot_day) + timedelta(days=max_dte)).isoformat()
        base = MASSIVE_BASE_URL.rstrip("/")
        url = (
            f"{base}/v3/snapshot/options/{underlying}"
            f"?strike_price.gte={lo}&strike_price.lte={hi}"
            f"&expiration_date.lte={exp_max}&limit=250"
        )
        try:
            results = _paginate(url)
        except Exception as exc:  # network failure must not take the terminal down
            logger.warning("Option chain fetch failed for %s: %s", underlying, exc)
            results = []

        if results:
            OPTIONS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            payload = {
                "underlying": underlying,
                "snapshot_date": snapshot_day,
                "spot_at_fetch": spot,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "results": results,
            }
            cache_file.write_text(json.dumps(payload), encoding="utf-8")
            logger.info("Fetched %d %s contracts from vendor chain.", len(results), underlying)
            return payload

    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))

    logger.warning("No option chain available for %s (no API key and no cache).", underlying)
    return {"underlying": underlying, "snapshot_date": snapshot_day, "results": []}


def _normalise_contract(row: Dict[str, Any], underlying: str, snapshot_date: str) -> Optional[Dict[str, Any]]:
    details = row.get("details") or {}
    ticker = details.get("ticker")
    strike = details.get("strike_price")
    ctype = details.get("contract_type")
    expiry = details.get("expiration_date")
    if not (ticker and strike and ctype in ("call", "put") and expiry):
        return None

    day = row.get("day") or {}
    greeks = row.get("greeks") or {}
    raw_iv = row.get("implied_volatility")
    iv = float(raw_iv) if isinstance(raw_iv, (int, float)) and MIN_SANE_IV <= float(raw_iv) <= MAX_SANE_IV else None

    return {
        "snapshot_date": snapshot_date,
        "underlying": underlying,
        "contract_ticker": ticker,
        "expiration_date": expiry,
        "strike": float(strike),
        "contract_type": ctype,
        "open_interest": float(row.get("open_interest") or 0.0),
        "volume": float(day.get("volume") or 0.0),
        "close": float(day["close"]) if isinstance(day.get("close"), (int, float)) else None,
        "vendor_iv": iv,
        "vendor_delta": greeks.get("delta"),
        "vendor_gamma": greeks.get("gamma"),
        "vendor_theta": greeks.get("theta"),
        "vendor_vega": greeks.get("vega"),
    }


def load_option_chains_into_db(
    conn: sqlite3.Connection,
    underlyings: Iterable[str] = OPTIONS_UNDERLYINGS,
    force_api: bool = False,
) -> int:
    """Fetch and persist every configured underlying's chain. Returns rows written."""
    total = 0
    for underlying in underlyings:
        row = conn.execute(
            "SELECT date, close FROM market_observation WHERE ticker = ? ORDER BY date DESC LIMIT 1",
            (underlying.upper(),),
        ).fetchone()
        if not row:
            logger.warning("No underlying price for %s; skipping chain.", underlying)
            continue
        spot = float(row["close"])

        payload = fetch_option_chain(underlying, spot, force_api=force_api)
        snapshot_date = payload.get("snapshot_date") or str(row["date"])
        records = [
            rec
            for rec in (
                _normalise_contract(r, underlying.upper(), snapshot_date)
                for r in payload.get("results", [])
            )
            if rec is not None
        ]
        if not records:
            continue

        # A snapshot is a point-in-time photograph: replace the day's rows
        # wholesale so a shrinking chain cannot leave orphans behind.
        conn.execute(
            "DELETE FROM option_contract WHERE underlying = ? AND snapshot_date = ?",
            (underlying.upper(), snapshot_date),
        )
        conn.executemany(
            """
            INSERT INTO option_contract (
                snapshot_date, underlying, contract_ticker, expiration_date, strike,
                contract_type, open_interest, volume, close, vendor_iv,
                vendor_delta, vendor_gamma, vendor_theta, vendor_vega
            ) VALUES (
                :snapshot_date, :underlying, :contract_ticker, :expiration_date, :strike,
                :contract_type, :open_interest, :volume, :close, :vendor_iv,
                :vendor_delta, :vendor_gamma, :vendor_theta, :vendor_vega
            )
            ON CONFLICT(snapshot_date, contract_ticker) DO UPDATE SET
                open_interest = excluded.open_interest,
                volume = excluded.volume,
                close = excluded.close,
                vendor_iv = excluded.vendor_iv,
                vendor_delta = excluded.vendor_delta,
                vendor_gamma = excluded.vendor_gamma,
                vendor_theta = excluded.vendor_theta,
                vendor_vega = excluded.vendor_vega
            """,
            records,
        )
        total += len(records)
    conn.commit()
    return total


def load_chain_rows(
    conn: sqlite3.Connection, underlying: str
) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    """Return the latest stored snapshot date and its contracts for ``underlying``."""
    head = conn.execute(
        "SELECT MAX(snapshot_date) AS d FROM option_contract WHERE underlying = ?",
        (underlying.upper(),),
    ).fetchone()
    snapshot_date = head["d"] if head else None
    if not snapshot_date:
        return None, []

    rows = conn.execute(
        """
        SELECT expiration_date, strike, contract_type, open_interest, volume,
               close, vendor_iv, vendor_delta, vendor_gamma
        FROM option_contract
        WHERE underlying = ? AND snapshot_date = ?
        ORDER BY expiration_date ASC, strike ASC
        """,
        (underlying.upper(), snapshot_date),
    ).fetchall()
    return snapshot_date, [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Treasury curve
# ---------------------------------------------------------------------------

_YIELD_FIELDS = (
    "yield_1_month", "yield_3_month", "yield_6_month",
    "yield_1_year", "yield_2_year", "yield_5_year",
    "yield_10_year", "yield_30_year",
)


def fetch_treasury_yields(start_date: str = "2021-01-01", force_api: bool = False) -> List[Dict[str, Any]]:
    """Fetch the constant-maturity Treasury curve, newest first, with a disk cache."""
    cache_file = REFERENCE_CACHE_DIR / "treasury_yields.json"
    if MASSIVE_API_KEY and (force_api or not cache_file.exists()):
        base = MASSIVE_BASE_URL.rstrip("/")
        url = f"{base}/fed/v1/treasury-yields?date.gte={start_date}&limit=1000&sort=date&order=desc"
        try:
            results = _paginate(url, cap=5000)
        except Exception as exc:
            logger.warning("Treasury yield fetch failed: %s", exc)
            results = []
        if results:
            REFERENCE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(results), encoding="utf-8")
            return results
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))
    return []


def load_treasury_yields_into_db(conn: sqlite3.Connection, force_api: bool = False) -> int:
    rows = fetch_treasury_yields(force_api=force_api)
    if not rows:
        return 0
    records = [
        {"date": r["date"], **{f: r.get(f) for f in _YIELD_FIELDS}}
        for r in rows
        if r.get("date")
    ]
    conn.executemany(
        f"""
        INSERT INTO treasury_yield (date, {", ".join(_YIELD_FIELDS)})
        VALUES (:date, {", ".join(f":{f}" for f in _YIELD_FIELDS)})
        ON CONFLICT(date) DO UPDATE SET
            {", ".join(f"{f} = excluded.{f}" for f in _YIELD_FIELDS)}
        """,
        records,
    )
    conn.commit()
    return len(records)


# Pillar tenors in years, used to interpolate r at an arbitrary option maturity.
_TENOR_YEARS: Tuple[Tuple[str, float], ...] = (
    ("yield_1_month", 1.0 / 12.0),
    ("yield_3_month", 0.25),
    ("yield_6_month", 0.5),
    ("yield_1_year", 1.0),
    ("yield_2_year", 2.0),
    ("yield_5_year", 5.0),
    ("yield_10_year", 10.0),
    ("yield_30_year", 30.0),
)

DEFAULT_RISK_FREE = 0.0435  # only used when the curve table is empty


def risk_free_curve(conn: sqlite3.Connection, as_of: Optional[str] = None) -> List[Tuple[float, float]]:
    """Latest observed curve as ``(tenor_years, rate_decimal)`` pairs, ascending."""
    if as_of:
        row = conn.execute(
            "SELECT * FROM treasury_yield WHERE date <= ? ORDER BY date DESC LIMIT 1", (as_of,)
        ).fetchone()
    else:
        row = conn.execute("SELECT * FROM treasury_yield ORDER BY date DESC LIMIT 1").fetchone()
    if not row:
        return []
    keys = row.keys()
    pillars = [
        (years, float(row[field]) / 100.0)
        for field, years in _TENOR_YEARS
        if field in keys and row[field] is not None
    ]
    return sorted(pillars)


def risk_free_rate(conn: sqlite3.Connection, dte_days: float, as_of: Optional[str] = None) -> float:
    """Linearly interpolate the observed Treasury curve at ``dte_days``.

    Falls back to :data:`DEFAULT_RISK_FREE` only when no curve has been
    ingested at all -- never silently, the caller can check the curve itself.
    """
    pillars = risk_free_curve(conn, as_of)
    if not pillars:
        return DEFAULT_RISK_FREE
    t = max(1.0 / 365.0, dte_days / 365.0)
    if t <= pillars[0][0]:
        return pillars[0][1]
    if t >= pillars[-1][0]:
        return pillars[-1][1]
    for (t0, r0), (t1, r1) in zip(pillars, pillars[1:]):
        if t0 <= t <= t1:
            w = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            return r0 + w * (r1 - r0)
    return pillars[-1][1]


def yield_curve_slope(conn: sqlite3.Connection, as_of: Optional[str] = None) -> Optional[float]:
    """10Y minus 2Y in percentage points -- the actual curve slope, not an ETF ratio."""
    if as_of:
        row = conn.execute(
            "SELECT yield_2_year, yield_10_year FROM treasury_yield WHERE date <= ? ORDER BY date DESC LIMIT 1",
            (as_of,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT yield_2_year, yield_10_year FROM treasury_yield ORDER BY date DESC LIMIT 1"
        ).fetchone()
    if not row or row["yield_2_year"] is None or row["yield_10_year"] is None:
        return None
    return float(row["yield_10_year"]) - float(row["yield_2_year"])


# ---------------------------------------------------------------------------
# Corporate reference: splits, dividends, market cap
# ---------------------------------------------------------------------------

def _fetch_reference(name: str, url: str, force_api: bool) -> List[Dict[str, Any]]:
    cache_file = REFERENCE_CACHE_DIR / f"{name}.json"
    if MASSIVE_API_KEY and (force_api or not cache_file.exists()):
        try:
            results = _paginate(url, cap=2000)
        except Exception as exc:
            logger.warning("Reference fetch failed for %s: %s", name, exc)
            results = []
        if results:
            REFERENCE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(results), encoding="utf-8")
            return results
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))
    return []


def load_splits_into_db(conn: sqlite3.Connection, tickers: Iterable[str], force_api: bool = False) -> int:
    """Persist the observed split history. Replaces the hand-typed STOCK_SPLITS table."""
    base = MASSIVE_BASE_URL.rstrip("/")
    total = 0
    for ticker in tickers:
        ticker = ticker.upper()
        rows = _fetch_reference(
            f"splits_{ticker}",
            f"{base}/v3/reference/splits?ticker={ticker}&limit=100",
            force_api,
        )
        records = [
            {
                "ticker": ticker,
                "execution_date": r["execution_date"],
                "split_from": float(r.get("split_from") or 1.0),
                "split_to": float(r.get("split_to") or 1.0),
            }
            for r in rows
            if r.get("execution_date")
        ]
        if not records:
            continue
        conn.executemany(
            """
            INSERT INTO ticker_split (ticker, execution_date, split_from, split_to)
            VALUES (:ticker, :execution_date, :split_from, :split_to)
            ON CONFLICT(ticker, execution_date) DO UPDATE SET
                split_from = excluded.split_from, split_to = excluded.split_to
            """,
            records,
        )
        total += len(records)
    conn.commit()
    return total


def load_dividends_into_db(conn: sqlite3.Connection, tickers: Iterable[str], force_api: bool = False) -> int:
    base = MASSIVE_BASE_URL.rstrip("/")
    total = 0
    for ticker in tickers:
        ticker = ticker.upper()
        rows = _fetch_reference(
            f"dividends_{ticker}",
            f"{base}/v3/reference/dividends?ticker={ticker}&limit=100&order=desc&sort=ex_dividend_date",
            force_api,
        )
        records = [
            {
                "ticker": ticker,
                "ex_dividend_date": r["ex_dividend_date"],
                "cash_amount": float(r.get("cash_amount") or 0.0),
                "frequency": int(r.get("frequency") or 0),
            }
            for r in rows
            if r.get("ex_dividend_date")
        ]
        if not records:
            continue
        conn.executemany(
            """
            INSERT INTO ticker_dividend (ticker, ex_dividend_date, cash_amount, frequency)
            VALUES (:ticker, :ex_dividend_date, :cash_amount, :frequency)
            ON CONFLICT(ticker, ex_dividend_date) DO UPDATE SET
                cash_amount = excluded.cash_amount, frequency = excluded.frequency
            """,
            records,
        )
        total += len(records)
    conn.commit()
    return total


def load_ticker_reference_into_db(conn: sqlite3.Connection, tickers: Iterable[str], force_api: bool = False) -> int:
    """Persist live market cap / shares / company name per ticker."""
    base = MASSIVE_BASE_URL.rstrip("/")
    today = date.today().isoformat()
    total = 0
    for ticker in tickers:
        ticker = ticker.upper()
        cache_file = REFERENCE_CACHE_DIR / f"ticker_{ticker}.json"
        payload: Dict[str, Any] = {}
        if MASSIVE_API_KEY and (force_api or not cache_file.exists()):
            try:
                with httpx.Client(timeout=30.0) as client:
                    resp = client.get(f"{base}/v3/reference/tickers/{ticker}", headers=_headers())
                if resp.status_code == 200:
                    payload = resp.json().get("results") or {}
                    if payload:
                        REFERENCE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                        cache_file.write_text(json.dumps(payload), encoding="utf-8")
            except Exception as exc:
                logger.warning("Ticker reference fetch failed for %s: %s", ticker, exc)
        if not payload and cache_file.exists():
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
        if not payload:
            continue

        conn.execute(
            """
            INSERT INTO ticker_reference (
                ticker, name, market_cap, shares_outstanding,
                sic_description, primary_exchange, as_of_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                name = excluded.name,
                market_cap = excluded.market_cap,
                shares_outstanding = excluded.shares_outstanding,
                sic_description = excluded.sic_description,
                primary_exchange = excluded.primary_exchange,
                as_of_date = excluded.as_of_date
            """,
            (
                ticker,
                payload.get("name"),
                payload.get("market_cap"),
                payload.get("share_class_shares_outstanding") or payload.get("weighted_shares_outstanding"),
                payload.get("sic_description"),
                payload.get("primary_exchange"),
                today,
            ),
        )
        total += 1
    conn.commit()
    return total


def split_factor_after(conn: sqlite3.Connection, ticker: str, published_on: str) -> float:
    """Cumulative forward-split ratio applied strictly after ``published_on``.

    Vendor bars are retroactively split-adjusted; a published price target is
    not. Dividing an as-published target by this factor puts both on one scale.
    """
    rows = conn.execute(
        """
        SELECT split_from, split_to FROM ticker_split
        WHERE ticker = ? AND execution_date > ?
        """,
        (ticker.upper(), published_on),
    ).fetchall()
    factor = 1.0
    for r in rows:
        frm = float(r["split_from"] or 1.0)
        to = float(r["split_to"] or 1.0)
        if frm > 0:
            factor *= to / frm
    return factor


def trailing_dividend_yield(conn: sqlite3.Connection, ticker: str, spot: float, as_of: Optional[str] = None) -> Optional[float]:
    """Trailing twelve-month cash dividends over spot, as a decimal.

    This is the continuous-carry ``q`` in Black-Scholes-Merton. Returns None
    when the ticker pays nothing or nothing has been ingested, so a caller can
    tell "no dividend" from "not looked up".
    """
    if spot <= 0:
        return None
    end = as_of or date.today().isoformat()
    start = (date.fromisoformat(end) - timedelta(days=365)).isoformat()
    row = conn.execute(
        """
        SELECT SUM(cash_amount) AS total FROM ticker_dividend
        WHERE ticker = ? AND ex_dividend_date > ? AND ex_dividend_date <= ?
        """,
        (ticker.upper(), start, end),
    ).fetchone()
    if not row or row["total"] is None:
        return None
    return float(row["total"]) / spot


def market_cap(conn: sqlite3.Connection, ticker: str) -> Optional[float]:
    row = conn.execute(
        "SELECT market_cap FROM ticker_reference WHERE ticker = ?", (ticker.upper(),)
    ).fetchone()
    if not row or row["market_cap"] is None:
        return None
    return float(row["market_cap"])


def format_market_cap(value: Optional[float]) -> Optional[str]:
    """Render a cap as ``$1.39T`` / ``$812.4B``. None stays None -- never ``$0.0T``."""
    if not value or value <= 0:
        return None
    if value >= 1e12:
        return f"${value / 1e12:.2f}T"
    if value >= 1e9:
        return f"${value / 1e9:.1f}B"
    return f"${value / 1e6:.1f}M"

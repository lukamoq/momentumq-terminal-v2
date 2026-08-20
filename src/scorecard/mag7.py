"""Magnificent 7 and Big Tech sell-side audit engine.

Evaluates sell-side research calls across NVDA, AAPL, MSFT, AMZN, GOOGL, META, TSLA,
and the MAG7 Concentration Basket against realized stock prices and S&P 500 (SPY) benchmarks.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import yaml

from scorecard.config import CURATED_DIR, DATA_DIR, AS_OF_DATE, MAX_SPOT_LOOKBACK_DAYS
from scorecard.market import MAG7_TICKERS, get_spot_at_publication, get_price_at_date

logger = logging.getLogger(__name__)

# Stock definitions & meta
MAG7_META = {
    "NVDA": {
        "name": "Nvidia Corporation",
        "sector": "Semiconductors / AI Compute",
        "market_cap_t": "$3.1T",
        "theme": "AI Accelerators & Datacenter Compute",
        "color": "#76B900",
    },
    "AAPL": {
        "name": "Apple Inc.",
        "sector": "Consumer Hardware & Services",
        "market_cap_t": "$3.4T",
        "theme": "Edge AI & Installed Base Monetization",
        "color": "#A2AAAD",
    },
    "MSFT": {
        "name": "Microsoft Corporation",
        "sector": "Enterprise Software & Cloud",
        "market_cap_t": "$3.3T",
        "theme": "Azure AI & Enterprise Copilot Seats",
        "color": "#00A4EF",
    },
    "AMZN": {
        "name": "Amazon.com, Inc.",
        "sector": "E-Commerce & Cloud Infrastructure",
        "market_cap_t": "$2.1T",
        "theme": "AWS Cloud Reacceleration & Ad Margins",
        "color": "#FF9900",
    },
    "GOOGL": {
        "name": "Alphabet Inc.",
        "sector": "Digital Advertising & Search",
        "market_cap_t": "$2.2T",
        "theme": "Search AI Overviews & Google Cloud Profit",
        "color": "#4285F4",
    },
    "META": {
        "name": "Meta Platforms, Inc.",
        "sector": "Social Media & Digital Ads",
        "market_cap_t": "$1.4T",
        "theme": "Year of Efficiency & Open Source Llama",
        "color": "#0081FB",
    },
    "TSLA": {
        "name": "Tesla, Inc.",
        "sector": "EVs, Clean Energy & Robotics",
        "market_cap_t": "$0.7T",
        "theme": "Auto Gross Margin War vs Full Autonomy",
        "color": "#E82127",
    },
    "MAG7_BASKET": {
        "name": "Magnificent 7 Basket & Concentration",
        "sector": "Macro / Mega-Cap Tech Concentration",
        "market_cap_t": "$16.2T",
        "theme": "Mag 7 EPS Dominance vs Equal-Weight Rotation",
        "color": "#C4B56A",
    },
}


# Ticker used for the synthetic equal-weight Magnificent 7 basket index.
# MAG7_BASKET calls are scored against this, NOT against SPY — scoring a "Mag 7
# vs the market" call against SPY makes its relative alpha identically zero.
MAG7_BASKET_TICKER = "MAG7"
MAG7_BASKET_BASE_LEVEL = 1000.0

# Seed split map, used only when the observed split table has not been
# ingested yet (fresh clone, offline run, unit test against a bare schema).
#
# The authoritative source is `ticker_split`, populated from the vendor's
# reference endpoint by scorecard.optionsdata.load_splits_into_db. Vendor bars
# are retroactively split-adjusted while published price targets are not, so an
# as-published target is divided by the ratio of every split executed AFTER its
# publication date to put both on one scale.
#
# Keeping this by hand was already losing: NVDA's 2021-07-20 four-for-one split
# is absent below, and nothing would have flagged it if a call had been dated
# before it.
STOCK_SPLITS: Dict[str, List[Tuple[str, float]]] = {
    "NVDA": [("2024-06-10", 10.0), ("2021-07-20", 4.0)],
    "AMZN": [("2022-06-06", 20.0)],
    "GOOGL": [("2022-07-18", 20.0)],
    "TSLA": [("2022-08-25", 3.0)],
}

# A neutral / equal-weight rating claims in-line performance. Alpha inside this
# band counts as a hit; outside it the analyst was directionally wrong either way.
NEUTRAL_ALPHA_BAND = 0.10


def split_adjustment_factor(
    ticker: str, published_on: str, conn: Optional[sqlite3.Connection] = None
) -> float:
    """Cumulative split ratio applied to `ticker` strictly after `published_on`.

    Prefers the observed `ticker_split` table; falls back to the seed map when
    no split history has been ingested.
    """
    if conn is not None:
        try:
            rows = conn.execute(
                "SELECT split_from, split_to FROM ticker_split WHERE ticker = ? AND execution_date > ?",
                (ticker.upper(), published_on),
            ).fetchall()
            if rows is not None and conn.execute(
                "SELECT COUNT(*) FROM ticker_split WHERE ticker = ?", (ticker.upper(),)
            ).fetchone()[0] > 0:
                factor = 1.0
                for r in rows:
                    frm, to = float(r[0] or 1.0), float(r[1] or 1.0)
                    if frm > 0:
                        factor *= to / frm
                return factor
        except sqlite3.Error:
            pass

    factor = 1.0
    for split_date, ratio in STOCK_SPLITS.get(ticker.upper(), []):
        if published_on < split_date:
            factor *= ratio
    return factor


def build_mag7_basket_series(conn: sqlite3.Connection) -> int:
    """Materialise an equal-weight Magnificent 7 index into `market_observation`.

    Construction: a daily-rebalanced equal-weight return index, base 1000 at the
    first session on which every constituent has a bar. Each session the index
    advances by the simple average of the seven constituents' daily returns, so
    the weights stay equal instead of letting the biggest winner quietly become
    most of the "basket". A constituent missing a session carries its last close
    forward (0% for that day). This is the series MAG7_BASKET calls are scored
    against — scoring them against SPY made their relative alpha identically zero.
    """
    closes: Dict[str, Dict[str, float]] = {}
    for t in MAG7_TICKERS:
        rows = conn.execute(
            "SELECT date, close FROM market_observation WHERE ticker = ? ORDER BY date ASC",
            (t,),
        ).fetchall()
        closes[t] = {r["date"]: float(r["close"]) for r in rows}
        if not closes[t]:
            logger.warning("No market data for Mag 7 constituent %s; basket not built.", t)
            return 0

    # Inception = first session on which all seven constituents have priced.
    first_dates = [min(closes[t]) for t in MAG7_TICKERS]
    base_date = max(first_dates)

    calendar = sorted({d for t in MAG7_TICKERS for d in closes[t] if d >= base_date})
    last_seen: Dict[str, float] = {t: closes[t][base_date] for t in MAG7_TICKERS}

    inserted = 0
    level = MAG7_BASKET_BASE_LEVEL
    for day in calendar:
        daily_returns = []
        for t in MAG7_TICKERS:
            px = closes[t].get(day)
            prev = last_seen[t]
            if px is None or prev <= 0:
                daily_returns.append(0.0)
            else:
                daily_returns.append((px / prev) - 1.0)
                last_seen[t] = px
        if day != base_date:
            level *= 1.0 + (sum(daily_returns) / len(daily_returns))
        # The basket is constructed here, not quoted anywhere, so it is tagged
        # as derived rather than inheriting the vendor-feed default.
        conn.execute(
            """
            INSERT INTO market_observation (
                date, ticker, open, high, low, close, volume, vwap, num_trades, index_level, source
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 'derived_equal_weight_basket')
            ON CONFLICT(date, ticker) DO UPDATE SET
                open = excluded.open, high = excluded.high, low = excluded.low,
                close = excluded.close, vwap = excluded.vwap,
                index_level = excluded.index_level, source = excluded.source
            """,
            (day, MAG7_BASKET_TICKER, level, level, level, level, level, level),
        )
        inserted += 1
    return inserted


def derive_mag7_verdict(
    stance: str, relative_alpha: Optional[float], window_complete: bool
) -> Tuple[str, str]:
    """Score a single-name / basket call against the benchmark it was measured on.

    Returns (verdict, one-line rationale). Consistent with the allocation rule used
    elsewhere in the scorecard: a recommendation is scored on relative performance,
    never on a rising tide.
    """
    if not window_complete or relative_alpha is None:
        return "TOO_EARLY", "Evaluation window has not closed as of the as-of date."

    alpha_pct = f"{relative_alpha * 100:+.1f}%"
    st = (stance or "").upper()
    if st in ("OVERWEIGHT", "BUY", "OUTPERFORM"):
        if relative_alpha > 0:
            return "HIT", f"Overweight outperformed the benchmark by {alpha_pct}."
        return "MISS", f"Overweight lagged the benchmark by {alpha_pct}."
    if st in ("UNDERWEIGHT", "SELL", "REDUCE", "UNDERPERFORM"):
        if relative_alpha < 0:
            return "HIT", f"Underweight avoided {alpha_pct} of relative downside."
        return "MISS", f"Underweight missed {alpha_pct} of relative upside."
    # EQUALWEIGHT / NEUTRAL / HOLD
    if abs(relative_alpha) <= NEUTRAL_ALPHA_BAND:
        return "HIT", f"Neutral rating tracked the benchmark ({alpha_pct} alpha)."
    return "MISS", f"Neutral rating missed a {alpha_pct} relative move."


def init_mag7_schema(conn: sqlite3.Connection) -> None:
    """Create Mag 7 database tables if they do not exist."""
    # Check if table exists and has switch columns
    cur = conn.execute("PRAGMA table_info(mag7_call)")
    cols = [r["name"] for r in cur.fetchall()]
    required = {"has_switched", "curated_verdict", "target_price_adjusted", "is_window_complete"}
    if cols and not required.issubset(set(cols)):
        conn.execute("DROP TABLE IF EXISTS mag7_call")

    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS mag7_call (
            id TEXT PRIMARY KEY,
            institution_id TEXT NOT NULL REFERENCES institution(id),
            ticker TEXT NOT NULL,
            company_name TEXT NOT NULL,
            strategist_or_analyst TEXT,
            published_on TEXT NOT NULL,
            call_type TEXT NOT NULL,
            rating_or_stance TEXT NOT NULL,
            target_price NUMERIC,
            spot_at_publication NUMERIC NOT NULL,
            forecast_horizon TEXT NOT NULL,
            exit_date TEXT NOT NULL,
            exit_spot NUMERIC,
            realized_stock_return NUMERIC,
            realized_spy_return NUMERIC,
            relative_alpha NUMERIC,
            target_price_adjusted NUMERIC,
            split_adjustment_factor NUMERIC DEFAULT 1.0,
            target_implied_return NUMERIC,
            target_error NUMERIC,
            benchmark_ticker TEXT NOT NULL DEFAULT 'SPY',
            is_window_complete INTEGER NOT NULL DEFAULT 1,
            verdict TEXT NOT NULL CHECK(verdict IN ('HIT', 'MISS', 'TOO_EARLY')),
            verdict_explanation TEXT,
            curated_verdict TEXT,
            curated_verdict_agrees INTEGER,
            has_switched INTEGER DEFAULT 0,
            switch_date TEXT,
            switch_reason TEXT,
            switch_spot NUMERIC,
            switch_stock_return NUMERIC,
            switch_spy_return NUMERIC,
            switch_alpha NUMERIC,
            switch_duration_days INTEGER,
            switch_verdict TEXT,
            key_quote_or_headline TEXT,
            thesis_summary TEXT,
            market_outcome TEXT,
            source_url TEXT,
            confidence TEXT DEFAULT 'verified',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_mag7_inst ON mag7_call(institution_id);
        CREATE INDEX IF NOT EXISTS idx_mag7_ticker ON mag7_call(ticker);
        CREATE INDEX IF NOT EXISTS idx_mag7_verdict ON mag7_call(verdict);
        """
    )


def calculate_horizon_exit_date(published_on_str: str, forecast_horizon: str) -> str:
    """Calculate the target realization date, clamped to the as-of date.

    Use :func:`horizon_window_is_complete` to tell a genuinely elapsed window from
    one that was merely truncated at the as-of date.
    """
    pub_date = date.fromisoformat(published_on_str)
    
    if forecast_horizon == "12M":
        try:
            target_d = pub_date.replace(year=pub_date.year + 1)
        except ValueError: # Feb 29 leap year
            target_d = pub_date + timedelta(days=365)
    elif forecast_horizon.startswith("YE_"):
        year = int(forecast_horizon.split("_")[1])
        target_d = date(year, 12, 31)
    elif forecast_horizon == "6M":
        target_d = pub_date + timedelta(days=180)
    elif forecast_horizon == "3M":
        target_d = pub_date + timedelta(days=90)
    else:
        target_d = pub_date + timedelta(days=365)

    as_of = date.fromisoformat(AS_OF_DATE)
    if target_d > as_of:
        # Window still active / open
        return as_of.isoformat()
    return target_d.isoformat()


def horizon_window_is_complete(published_on_str: str, forecast_horizon: str) -> bool:
    """True when the call's stated horizon has fully elapsed by the as-of date."""
    pub_date = date.fromisoformat(published_on_str)
    if forecast_horizon == "12M":
        try:
            target_d = pub_date.replace(year=pub_date.year + 1)
        except ValueError:
            target_d = pub_date + timedelta(days=365)
    elif forecast_horizon.startswith("YE_"):
        target_d = date(int(forecast_horizon.split("_")[1]), 12, 31)
    elif forecast_horizon == "6M":
        target_d = pub_date + timedelta(days=180)
    elif forecast_horizon == "3M":
        target_d = pub_date + timedelta(days=90)
    else:
        target_d = pub_date + timedelta(days=365)
    return target_d <= date.fromisoformat(AS_OF_DATE)


def _price_on(
    conn: sqlite3.Connection, ticker: str, on_date: str, max_lookback_days: int = MAX_SPOT_LOOKBACK_DAYS
) -> Optional[float]:
    """Last close for `ticker` on or before `on_date`, or None if the gap is too wide.

    Always goes through `get_price_at_date` so SPY/SPX resolve to the same
    index-level scale everywhere and the lookback limit is never bypassed.
    """
    return get_price_at_date(conn, ticker, on_date, max_lookback_days)


def ingest_and_score_mag7(conn: sqlite3.Connection, yaml_path: Optional[Path] = None) -> int:
    """Ingest curated Mag 7 calls and score them on realized relative performance."""
    init_mag7_schema(conn)
    build_mag7_basket_series(conn)
    path = yaml_path or (CURATED_DIR / "mag7_calls.yaml")
    if not path.exists():
        logger.warning(f"Mag 7 calls file not found: {path}")
        return 0

    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    calls = data.get("calls", [])
    conn.execute("DELETE FROM mag7_call")

    # Group calls by (institution_id, ticker) to compute position switches
    groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for c in calls:
        key = (c["institution_id"], c["ticker"])
        groups.setdefault(key, []).append(c)

    # Sort each group by published_on ascending
    for k in groups:
        groups[k].sort(key=lambda item: str(item["published_on"]))

    inserted = 0
    for (inst_id, ticker), group_calls in groups.items():
        for i, c in enumerate(group_calls):
            call_id = c["id"]
            company_name = c.get("company_name", MAG7_META.get(ticker, {}).get("name", ticker))
            analyst = c.get("strategist_or_analyst", "Equity Research")
            published_on = str(c["published_on"])
            call_type = c.get("call_type", "rating_target")
            rating_stance = c.get("rating_or_stance", "OVERWEIGHT").upper()
            target_price = c.get("target_price")
            horizon = c.get("forecast_horizon", "12M")
            thesis = c.get("thesis_summary", "")
            market_outcome = c.get("market_outcome", "")
            verdict = c.get("verdict", "HIT").upper()
            verdict_expl = c.get("verdict_explanation", "")
            headline = c.get("key_quote_or_headline", "")
            source_url = c.get("source_url", "")
            confidence = c.get("confidence", "verified")

            # 1. Spot at publication. The basket is priced off the synthetic
            #    equal-weight Mag 7 index, never off SPY.
            market_ticker = MAG7_BASKET_TICKER if ticker == "MAG7_BASKET" else ticker
            benchmark_ticker = "SPY"

            spot_at_pub = _price_on(conn, market_ticker, published_on)
            if spot_at_pub is None:
                raise ValueError(
                    f"Mag 7 call {call_id}: no {market_ticker} price within "
                    f"{MAX_SPOT_LOOKBACK_DAYS} days of {published_on}."
                )

            spy_spot_pub = _price_on(conn, benchmark_ticker, published_on)
            if spy_spot_pub is None:
                raise ValueError(
                    f"Mag 7 call {call_id}: no {benchmark_ticker} benchmark price within "
                    f"{MAX_SPOT_LOOKBACK_DAYS} days of {published_on}."
                )

            # 2. Exit price at the realization horizon
            exit_date = calculate_horizon_exit_date(published_on, horizon)
            window_complete = horizon_window_is_complete(published_on, horizon)
            exit_spot = _price_on(conn, market_ticker, exit_date)
            spy_exit_spot = _price_on(conn, benchmark_ticker, exit_date)

            # 3. Realized returns over the horizon window
            if exit_spot is not None and spot_at_pub > 0:
                realized_stock_ret = (exit_spot / spot_at_pub) - 1.0
            else:
                realized_stock_ret = None
            if spy_exit_spot is not None and spy_spot_pub > 0:
                realized_spy_ret = (spy_exit_spot / spy_spot_pub) - 1.0
            else:
                realized_spy_ret = None
            relative_alpha = (
                realized_stock_ret - realized_spy_ret
                if (realized_stock_ret is not None and realized_spy_ret is not None)
                else None
            )

            # Targets are published pre-split; market bars are split-adjusted.
            split_factor = split_adjustment_factor(ticker, published_on, conn)
            target_adj = (float(target_price) / split_factor) if target_price else None
            target_implied_ret = (target_adj / spot_at_pub - 1.0) if (target_adj and spot_at_pub) else None
            target_err = (
                abs(target_adj - exit_spot) / exit_spot if (target_adj and exit_spot) else None
            )

            # 4. Calculate Position Switch Exit (when the desk flipped/revised this position)
            if i + 1 < len(group_calls):
                next_c = group_calls[i + 1]
                has_switched = 1
                switch_date = str(next_c["published_on"])
                next_tgt = f"${next_c['target_price']}" if next_c.get("target_price") else next_c.get("rating_or_stance", "revised")
                switch_reason = f"Position revised on {switch_date} (Replaced by {next_c.get('rating_or_stance', 'REVISED')} {next_tgt})"
            else:
                has_switched = 0
                switch_date = AS_OF_DATE
                switch_reason = f"Active standing position (No switch yet as of {AS_OF_DATE})"

            try:
                switch_duration_days = (date.fromisoformat(switch_date) - date.fromisoformat(published_on)).days
            except Exception:
                switch_duration_days = 0

            switch_spot = _price_on(conn, market_ticker, switch_date)
            switch_spy_spot = _price_on(conn, benchmark_ticker, switch_date)

            switch_stock_ret = (
                (switch_spot / spot_at_pub) - 1.0 if (switch_spot is not None and spot_at_pub) else None
            )
            switch_spy_ret = (
                (switch_spy_spot / spy_spot_pub) - 1.0
                if (switch_spy_spot is not None and spy_spot_pub)
                else None
            )
            switch_alpha = (
                switch_stock_ret - switch_spy_ret
                if (switch_stock_ret is not None and switch_spy_ret is not None)
                else None
            )

            # The holding period a desk actually stood behind is always closed —
            # it ends at the revision, or at the as-of date for a live position.
            switch_verdict, _switch_rationale = derive_mag7_verdict(
                rating_stance, switch_alpha, switch_alpha is not None
            )

            # 5. Verdict is earned from the realized numbers. The curated call
            #    keeps its assertion alongside so disagreements stay visible.
            derived_verdict, derived_rationale = derive_mag7_verdict(
                rating_stance, relative_alpha, window_complete
            )
            curated_verdict = verdict
            curated_agrees = 1 if curated_verdict == derived_verdict else 0
            if curated_agrees:
                final_explanation = verdict_expl or derived_rationale
            else:
                final_explanation = (
                    f"{derived_rationale} Curated note asserted {curated_verdict}: "
                    f"{verdict_expl or 'no rationale given'}"
                )
            verdict = derived_verdict
            verdict_expl = final_explanation

            conn.execute(
                """
                INSERT INTO mag7_call (
                    id, institution_id, ticker, company_name, strategist_or_analyst,
                    published_on, call_type, rating_or_stance, target_price,
                    target_price_adjusted, split_adjustment_factor,
                    spot_at_publication, forecast_horizon, exit_date, exit_spot,
                    realized_stock_return, realized_spy_return, relative_alpha,
                    target_implied_return, target_error, benchmark_ticker,
                    is_window_complete, verdict, verdict_explanation,
                    curated_verdict, curated_verdict_agrees,
                    has_switched, switch_date, switch_reason, switch_spot,
                    switch_stock_return, switch_spy_return, switch_alpha,
                    switch_duration_days, switch_verdict,
                    key_quote_or_headline, thesis_summary, market_outcome, source_url, confidence
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?,
                    ?, ?, ?, ?, ?
                )
                """,
                (
                    call_id,
                    inst_id,
                    ticker,
                    company_name,
                    analyst,
                    published_on,
                    call_type,
                    rating_stance,
                    target_price,
                    target_adj,
                    split_factor,
                    spot_at_pub,
                    horizon,
                    exit_date,
                    exit_spot,
                    realized_stock_ret,
                    realized_spy_ret,
                    relative_alpha,
                    target_implied_ret,
                    target_err,
                    benchmark_ticker,
                    1 if window_complete else 0,
                    verdict,
                    verdict_expl,
                    curated_verdict,
                    curated_agrees,
                    has_switched,
                    switch_date,
                    switch_reason,
                    switch_spot,
                    switch_stock_ret,
                    switch_spy_ret,
                    switch_alpha,
                    switch_duration_days,
                    switch_verdict,
                    headline,
                    thesis,
                    market_outcome,
                    source_url,
                    confidence,
                ),
            )
            inserted += 1

    conn.commit()
    return inserted


def grade_from_record(hit_rate: Optional[float], avg_alpha: float, resolved: int) -> str:
    """Letter grade derived from the resolved hit rate and average benchmark alpha."""
    if not resolved or hit_rate is None:
        return "N/R"
    score = (hit_rate * 100.0) + min(25.0, max(-25.0, avg_alpha * 40.0))
    if score >= 95:
        return "A+"
    if score >= 85:
        return "A"
    if score >= 78:
        return "A-"
    if score >= 70:
        return "B+"
    if score >= 60:
        return "B"
    if score >= 50:
        return "B-"
    if score >= 40:
        return "C+"
    if score >= 30:
        return "C"
    return "D"


def compute_mag7_bank_scorecard(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Aggregate Mag 7 performance metrics for all institutions."""
    cur_inst = conn.execute("SELECT id, name, full_name, notes FROM institution ORDER BY name ASC")
    institutions = [dict(r) for r in cur_inst.fetchall()]

    bank_scores = []
    for inst in institutions:
        inst_id = inst["id"]
        cur_calls = conn.execute(
            """
            SELECT * FROM mag7_call
            WHERE institution_id = ?
            ORDER BY published_on DESC
            """,
            (inst_id,),
        )
        calls = [dict(r) for r in cur_calls.fetchall()]
        total = len(calls)
        if total == 0:
            continue

        hits = sum(1 for c in calls if c["verdict"] == "HIT")
        misses = sum(1 for c in calls if c["verdict"] == "MISS")
        too_early = sum(1 for c in calls if c["verdict"] == "TOO_EARLY")
        resolved = hits + misses
        hit_rate = (hits / resolved) if resolved > 0 else None

        # Average excess alpha over the benchmark, resolved windows only.
        alphas = [
            c["relative_alpha"]
            for c in calls
            if c["relative_alpha"] is not None and c["verdict"] != "TOO_EARLY"
        ]
        avg_alpha = (sum(alphas) / len(alphas)) if alphas else 0.0

        # How often the hand-written verdict disagreed with the realized numbers.
        curated_disagreements = sum(1 for c in calls if c["curated_verdict_agrees"] == 0)

        # Find best standout win and biggest blunder
        hit_calls = [c for c in calls if c["verdict"] == "HIT"]
        hit_calls.sort(key=lambda c: (c["relative_alpha"] if c["relative_alpha"] is not None else 0.0, c["id"]), reverse=True)
        standout_win = hit_calls[0] if hit_calls else None

        miss_calls = [c for c in calls if c["verdict"] == "MISS"]
        miss_calls.sort(key=lambda c: (c["relative_alpha"] if c["relative_alpha"] is not None else 0.0, c["id"]))
        biggest_blunder = miss_calls[0] if miss_calls else None

        # Grade is earned from the resolved record, not asserted.
        grade = grade_from_record(hit_rate, avg_alpha, resolved)

        # Editorial context on each desk (narrative only — the grade above is computed).
        if inst_id == "GS":
            narrative = "High-Conviction AI & Big Tech Bull: Successfully defended Mag 7 fundamentals against bubble comparisons and championed NVDA/AMZN."
        elif inst_id == "BAC":
            narrative = "Elite Tech Stock-Picking (NVDA/AAPL) with Cautious Macro Allocation: Arya called Nvidia's AI rise; Mohan caught Apple AI supercycle."
        elif inst_id == "JPM":
            narrative = "Bifurcated: Superb Single-Stock Picks (Meta bottom pick, Tesla underweight) offset by Kolanovic's expensive 2023-24 permabear tech warnings."
        elif inst_id == "MS":
            narrative = "Sector Analysts (Keith Weiss MSFT, Adam Jonas TSLA) outperformed Chief Strategist Mike Wilson's costly 2023 tech earnings collapse call."
        elif inst_id == "HSBC":
            narrative = "Prescient Early Mover on AI Hardware: Frank Lee double-upgraded NVDA with Street-high target in early 2023 before consensus."
        elif inst_id == "DB":
            narrative = "Secular Tech Growth Optimist: Binky Chadha maintained bullish mega-cap stance throughout, though Ross Seymore was cautious on Nvidia."
        elif inst_id == "UBS":
            narrative = "Solid Bottom-Up Hardware/Software Channel Checks, but suffered from untimely late-2022 Meta downgrade and cautious 2026 macro cut."
        elif inst_id == "C":
            narrative = "Strong on Cloud/AI Hyperscalers (Radke MSFT, Josey AMZN), but repeatedly missed by predicting premature Equal-Weight rotations."
        elif inst_id == "BARC":
            narrative = "Tactical Divergence: Ross Sandler accurately backed Google's AI search resilience, but Tim Long's Apple downgrade missed the AI re-rating."
        elif inst_id == "GLE":
            narrative = "Extreme Permabear Drag: Albert Edwards' persistent 1999-style AI bubble warnings missed the entire multi-year bull market."
        else:
            narrative = "Evaluated on Big Tech & AI recommendations."

        bank_scores.append(
            {
                "institution_id": inst_id,
                "institution_name": inst["name"],
                "institution_full_name": inst["full_name"],
                "total_calls": total,
                "hits": hits,
                "misses": misses,
                "too_early": too_early,
                "resolved": resolved,
                "hit_rate": round(hit_rate, 4) if hit_rate is not None else None,
                "avg_alpha": round(avg_alpha, 4),
                "curated_verdict_disagreements": curated_disagreements,
                "grade": grade,
                "narrative": narrative,
                "standout_win": standout_win,
                "biggest_blunder": biggest_blunder,
                "calls": calls,
            }
        )

    # Sort banks by hit rate descending, then avg alpha, then name for stability.
    bank_scores.sort(key=lambda b: b["institution_name"])
    bank_scores.sort(
        key=lambda b: (b["hit_rate"] if b["hit_rate"] is not None else -1.0, b["avg_alpha"]),
        reverse=True,
    )
    return bank_scores


def live_market_cap(conn: sqlite3.Connection, ticker: str) -> Optional[str]:
    """Formatted market capitalisation from the observed reference table.

    The constants that used to fill this field had gone badly stale -- NVDA was
    carried at $3.1T against an observed $5.3T, GOOGL at $2.2T against $4.2T,
    TSLA at $0.7T against $1.3T, and the basket at $16.2T against $23.2T. They
    are now looked up, and a ticker with nothing ingested returns None so the
    UI can print a dash instead of a wrong number.
    """
    from scorecard.optionsdata import format_market_cap, market_cap

    if ticker.upper() in ("MAG7_BASKET", "MAG7"):
        total = 0.0
        for t in MAG7_TICKERS:
            cap = market_cap(conn, t)
            if cap is None:
                return None
            total += cap
        return format_market_cap(total)
    return format_market_cap(market_cap(conn, ticker))


def mag7_aggregate_market_cap(conn: sqlite3.Connection) -> Optional[str]:
    """Combined observed market capitalisation of the seven constituents."""
    return live_market_cap(conn, "MAG7_BASKET")


def compute_mag7_stock_breakdown(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Return performance and sell-side call statistics for each individual Mag 7 stock and basket."""
    stocks = []
    for ticker, meta in MAG7_META.items():
        market_ticker = MAG7_BASKET_TICKER if ticker == "MAG7_BASKET" else ticker

        # 1. Price stats from market_observation
        cur_p = conn.execute(
            """
            SELECT
                (SELECT close FROM market_observation WHERE ticker = ? ORDER BY date ASC LIMIT 1) as p_start,
                (SELECT close FROM market_observation WHERE ticker = ? AND date >= '2023-01-01' ORDER BY date ASC LIMIT 1) as p_2023,
                (SELECT close FROM market_observation WHERE ticker = ? AND date >= '2024-01-01' ORDER BY date ASC LIMIT 1) as p_2024,
                (SELECT close FROM market_observation WHERE ticker = ? AND date >= '2026-01-01' ORDER BY date ASC LIMIT 1) as p_2026_start,
                (SELECT close FROM market_observation WHERE ticker = ? ORDER BY date DESC LIMIT 1) as p_latest
            """,
            (market_ticker, market_ticker, market_ticker, market_ticker, market_ticker),
        )
        p_row = cur_p.fetchone()

        latest_price = float(p_row["p_latest"]) if p_row and p_row["p_latest"] else 0.0
        p_2023 = float(p_row["p_2023"]) if p_row and p_row["p_2023"] else latest_price
        p_2026 = float(p_row["p_2026_start"]) if p_row and p_row["p_2026_start"] else latest_price

        ret_since_2023 = (latest_price / p_2023 - 1.0) if p_2023 > 0 else 0.0
        ret_ytd = (latest_price / p_2026 - 1.0) if p_2026 > 0 else 0.0

        # 2. Associated calls
        cur_calls = conn.execute(
            """
            SELECT c.*, i.name as institution_name
            FROM mag7_call c
            JOIN institution i ON c.institution_id = i.id
            WHERE c.ticker = ?
            ORDER BY c.published_on DESC
            """,
            (ticker,),
        )
        calls = [dict(r) for r in cur_calls.fetchall()]

        total_calls = len(calls)
        hits = sum(1 for c in calls if c["verdict"] == "HIT")
        misses = sum(1 for c in calls if c["verdict"] == "MISS")
        hit_rate = (hits / (hits + misses)) if (hits + misses) > 0 else 0.0

        # Identify key bank stances (sorted — set() iteration order is not stable
        # across processes and leaked into the API response).
        bull_banks = sorted({c["institution_name"] for c in calls if c["rating_or_stance"] in ("OVERWEIGHT", "BUY")})
        bear_banks = sorted({c["institution_name"] for c in calls if c["rating_or_stance"] in ("UNDERWEIGHT", "EQUALWEIGHT", "SELL", "REDUCE")})

        stocks.append(
            {
                "ticker": ticker,
                "name": meta["name"],
                "sector": meta["sector"],
                "market_cap": live_market_cap(conn, ticker),
                "market_cap_measured": live_market_cap(conn, ticker) is not None,
                "key_theme": meta["theme"],
                "color": meta["color"],
                "latest_price": round(latest_price, 2),
                "return_since_2023": round(ret_since_2023, 4),
                "return_ytd_2026": round(ret_ytd, 4),
                "total_calls": total_calls,
                "hits": hits,
                "misses": misses,
                "hit_rate": round(hit_rate, 4),
                "is_basket": 1 if ticker == "MAG7_BASKET" else 0,
                "bull_banks": bull_banks,
                "bear_banks": bear_banks,
                "calls": calls,
            }
        )

    return stocks


THEME_BANK_IDS = {
    "Goldman Sachs": "GS",
    "Morgan Stanley": "MS",
    "JPMorgan": "JPM",
    "Bank of America": "BAC",
    "Citi": "C",
    "Deutsche Bank": "DB",
    "UBS": "UBS",
    "Barclays": "BARC",
    "Société Générale": "GLE",
    "HSBC": "HSBC",
}


def _theme_scored_record(
    conn: sqlite3.Connection, bank_name: str, hero_stocks: List[str]
) -> Dict[str, Any]:
    """Scored record for one desk on one dossier's hero stocks."""
    inst_id = THEME_BANK_IDS.get(bank_name)
    empty = {"institution_id": inst_id, "hits": 0, "misses": 0, "too_early": 0, "avg_alpha": None}
    if not inst_id or not hero_stocks:
        return empty

    placeholders = ",".join("?" for _ in hero_stocks)
    rows = conn.execute(
        f"SELECT verdict, relative_alpha FROM mag7_call "
        f"WHERE institution_id = ? AND ticker IN ({placeholders})",
        [inst_id, *hero_stocks],
    ).fetchall()
    if not rows:
        return empty

    alphas = [r["relative_alpha"] for r in rows if r["relative_alpha"] is not None]
    return {
        "institution_id": inst_id,
        "hits": sum(1 for r in rows if r["verdict"] == "HIT"),
        "misses": sum(1 for r in rows if r["verdict"] == "MISS"),
        "too_early": sum(1 for r in rows if r["verdict"] == "TOO_EARLY"),
        "avg_alpha": round(sum(alphas) / len(alphas), 4) if alphas else None,
    }


def compute_mag7_themes(conn: Optional[sqlite3.Connection] = None) -> List[Dict[str, Any]]:
    """Return the four thematic dossiers, each reconciled against the scored record.

    The prose is editorial. When a connection is supplied, every named winner and
    loser also carries the desk's actual hits/misses on that dossier's hero stocks
    plus a ``contradicted`` flag, so an editorial claim can never quietly outlive
    the data it was written from.
    """
    themes: List[Dict[str, Any]] = [
        {
            "id": "ai_hardware_capex",
            "title": "THE AI HARDWARE & GPU CAPEX REVOLUTION",
            "subtitle": "Nvidia, Custom ASICs, and Hyperscaler Infrastructure Spending",
            "narrative": "Between 2023 and 2026, Wall Street faced the fastest revenue inflection in semiconductor history. BofA (Vivek Arya), Goldman Sachs (Toshiya Hari), and HSBC (Frank Lee) correctly recognized that hyperscaler capex was non-discretionary. Skeptics at Deutsche Bank and SocGen who expected a 'cyclical digestion' or dot-com bust were repeatedly wrong-footed as Nvidia's datacenter revenue exploded 500%+.",
            "hero_stocks": ["NVDA", "MSFT", "AMZN"],
            "key_winners": [
                {"bank": "Bank of America", "strategist": "Vivek Arya", "call": "Top AI Pick & $1,100 / $180 target raises"},
                {"bank": "HSBC", "strategist": "Frank Lee", "call": "Double-Upgrade to Buy with Street-High $355 Target"},
                {"bank": "Goldman Sachs", "strategist": "Toshiya Hari", "call": "Blackwell Architecture Supercycle Conviction Buy"},
            ],
            "key_losers": [
                {"bank": "Deutsche Bank", "strategist": "Ross Seymore", "call": "Maintained Hold during +250% Nvidia surge citing valuation"},
                {"bank": "Société Générale", "strategist": "Albert Edwards", "call": "Called AI rally a 1999 Cisco-style dot-com bubble"},
            ],
        },
        {
            "id": "meta_efficiency_rebound",
            "title": "META'S 2022-2023 CRASH & 'YEAR OF EFFICIENCY' REBOUND",
            "subtitle": "From $89 Metaverse Low to $500+ AI Advertising Powerhouse",
            "narrative": "When Meta plummeted below $90 in late 2022 amid runaway Reality Labs spending, UBS capitulated with a downgrade. JPMorgan's Doug Anmuth stepped in at $115 to name Meta the #1 Internet Pick for 2023, capturing a +194% rally. Morgan Stanley (Brian Nowak) and BofA (Justin Post) correctly distinguished productive AI ad targeting (Advantage+) from unconstrained metaverse capex.",
            "hero_stocks": ["META"],
            "key_winners": [
                {"bank": "JPMorgan", "strategist": "Doug Anmuth", "call": "Upgraded Meta at $115 in Dec 2022 before 194% rally"},
                {"bank": "Morgan Stanley", "strategist": "Brian Nowak", "call": "Aggressively bought 2024 AI capex pullbacks to $550+"},
            ],
            "key_losers": [
                {"bank": "UBS", "strategist": "Lloyd Walmsley", "call": "Downgraded Meta at $120 right before $89 generational bottom"},
            ],
        },
        {
            "id": "tesla_margin_war",
            "title": "TESLA'S EV PRICE WARS VS ROBOTAXI VALUATION PREMIUM",
            "subtitle": "Gross Margin Deterioration vs Autonomous AI Optionality",
            "narrative": "Tesla divided Wall Street like no other Mag 7 stock. JPMorgan's Ryan Brinkman maintained a courageous, Street-low Underweight ($125 target) predicting that price cuts would decimate automotive margins from 28% to 15%. Conversely, Morgan Stanley's Adam Jonas championed a $400 Dojo supercomputer SOTP valuation that failed to materialize in the forecast window.",
            "hero_stocks": ["TSLA"],
            "key_winners": [
                {"bank": "JPMorgan", "strategist": "Ryan Brinkman", "call": "Street-low Underweight correctly foreseeing margin collapse"},
                {"bank": "Goldman Sachs", "strategist": "Mark Delaney", "call": "Timely downgrade to Neutral at $260 before 2024 slide"},
            ],
            "key_losers": [
                {"bank": "Morgan Stanley", "strategist": "Adam Jonas", "call": "Premature $400 Dojo AI upgrade before stock fell 40%"},
            ],
        },
        {
            "id": "mag7_vs_equal_weight",
            "title": "MAG 7 CONCENTRATION VS THE ELUSIVE 'GREAT ROTATION'",
            "subtitle": "Debunking the 'Nifty Fifty' Bubble & Equal-Weight Underperformance",
            "narrative": "Throughout 2023-2026, Wall Street strategists repeatedly advised rotating out of Mag 7 into equal-weight S&P 500 (RSP) or defensive cash. JPMorgan's Marko Kolanovic and Morgan Stanley's Mike Wilson suffered career-defining misses warning of a tech crash. Goldman Sachs' David Kostin correctly demonstrated that Mag 7 multiples were underpinned by superior ROE (35%) and secular EPS growth.",
            "hero_stocks": ["MAG7_BASKET"],
            "key_winners": [
                {"bank": "Goldman Sachs", "strategist": "David Kostin", "call": "Published 'Mag 7 Not a Bubble' research defending 28x P/E"},
                {"bank": "Deutsche Bank", "strategist": "Binky Chadha", "call": "Aggressive 8,000 S&P target supported by big tech cash flows"},
            ],
            "key_losers": [
                {"bank": "JPMorgan", "strategist": "Marko Kolanovic", "call": "Warned of 'Nifty Fifty' crash and told clients to hold cash"},
                {"bank": "Morgan Stanley", "strategist": "Mike Wilson", "call": "Called 2023 tech rally a 'bear market trap' before +75% surge"},
                {"bank": "Citi", "strategist": "Scott Chronert", "call": "Repeatedly predicted Equal-Weight would beat Mag 7"},
            ],
        },
    ]

    if conn is None:
        return themes

    for theme in themes:
        hero = theme.get("hero_stocks", [])
        for side, entries in (("winner", theme["key_winners"]), ("loser", theme["key_losers"])):
            for entry in entries:
                record = _theme_scored_record(conn, entry["bank"], hero)
                entry["record"] = record
                # A "winner" with no scored hits and at least one miss (or the
                # mirror image for a "loser") is an editorial claim the data no
                # longer supports.
                if side == "winner":
                    entry["contradicted"] = record["hits"] == 0 and record["misses"] > 0
                else:
                    entry["contradicted"] = record["misses"] == 0 and record["hits"] > 0
    return themes


def get_mag7_market_series(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Return price series rebased to a single common date for like-for-like comparison.

    Every series is normalised by its own close on the shared ``base_date`` — the
    latest first-observation across the tickers — so a line at 250 always means
    "2.5x since the base", whatever date each ticker's own history happens to
    start. Normalising each ticker to its own first bar (the previous behaviour)
    silently compared different windows on one axis, which is how META's
    truncated history read as +3,465%.
    """
    tickers = [
        "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA",
        "SPY", "QQQ", "RSP", MAG7_BASKET_TICKER,
    ]

    raw: Dict[str, List[Dict[str, Any]]] = {}
    for t in tickers:
        rows = conn.execute(
            "SELECT date, close FROM market_observation WHERE ticker = ? ORDER BY date ASC",
            (t,),
        ).fetchall()
        if rows:
            raw[t] = [{"date": r["date"], "close": float(r["close"])} for r in rows]

    if not raw:
        return {"base_date": None, "series": {}}

    base_date = max(rows[0]["date"] for rows in raw.values())

    series_by_ticker: Dict[str, List[Dict[str, Any]]] = {}
    for t, rows in raw.items():
        base_price = next((r["close"] for r in rows if r["date"] >= base_date), None)
        if not base_price:
            continue
        series_by_ticker[t] = [
            {
                "date": r["date"],
                "close": r["close"],
                "normalized": round((r["close"] / base_price) * 100.0, 2),
                "return_pct": round((r["close"] / base_price - 1.0) * 100.0, 2),
            }
            for r in rows
        ]

    return {"base_date": base_date, "series": series_by_ticker}

"""
MoQ Fear & Greed Index 2.0 Engine.

Composite market sentiment built from 10 weighted categories, each scored 0-100
(0 = Extreme Fear, 100 = Extreme Greed):

   1. Sentiment   (10%) — return momentum plus the variance risk premium
   2. Volatility  (10%) — 30-day implied volatility level and curve slope
   3. Positioning (15%) — observed put/call ratios from the SPY option chain
   4. Trend       (10%) — SPY vs its 20d / 50d / 200d moving averages
   5. Breadth     (10%) — cross-sector advance/decline and 52-week highs
   6. Momentum    (10%) — SPY 14D RSI plus cyclical vs defensive sector spread
   7. Liquidity   (15%) — % of the universe trading above its 50d and 200d MAs
   8. Credit      (10%) — high-yield vs Treasury total-return spread (HYG/IEF)
   9. Macro        (5%) — observed 10Y-2Y Treasury curve slope
  10. Cross-Asset  (5%) — equity risk appetite relative to gold

Four of these used to be scored off quantities that did not measure what their
label claimed:

* **Volatility** ranked the *VIXY share price* against its own trailing year.
  VIXY loses several percent a month to roll decay, so its price sits near the
  bottom of its trailing range almost permanently — the category printed
  "complacency" as a structural artefact. It now uses the model-free implied
  volatility computed from the observed chain.
* **Positioning** called ``VIXY_volume / SPY_volume`` a "put/call ratio". Those
  are share volumes in two unrelated ETFs. It now uses the actual put and call
  volume and open interest on the SPY chain.
* **Sentiment** derived an "AAII bull/bear proxy" from the VIXY share price on
  the scale ``(price - 12) / 20``, which is only meaningful if that price
  happens to look like a VIX print. It now uses the variance risk premium —
  implied minus realized — which is a real measure of what the market pays to
  hedge.
* **Macro** used the ``TLT / IEF`` *price* ratio as a "yield curve slope". That
  ratio is a function of the two funds' duration and distribution history and
  barely moves with the curve. It now uses the observed 10Y minus 2Y Treasury
  yield.

**Breadth** and **Liquidity** also named a cross-sector universe of which
eleven of twenty-two symbols were never ingested; both scorers skipped a
missing ticker silently, so what survived was eight mega-cap tech names wearing
a breadth label. The universe is now ingested in full and each category reports
the coverage it actually achieved.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from scorecard.optionsdata import load_chain_rows, risk_free_rate, yield_curve_slope
from scorecard.volatility import group_by_expiry, term_structure

WEIGHTS: Dict[str, float] = {
    "sentiment": 0.10,
    "volatility": 0.10,
    "positioning": 0.15,
    "trend": 0.10,
    "breadth": 0.10,
    "momentum": 0.10,
    "liquidity": 0.15,
    "credit": 0.10,
    "macro": 0.05,
    "cross_asset": 0.05,
}

CATEGORY_LABELS: Dict[str, str] = {
    "sentiment": "Sentiment",
    "volatility": "Volatility",
    "positioning": "Positioning",
    "trend": "Trend",
    "breadth": "Breadth",
    "momentum": "Momentum",
    "liquidity": "Liquidity",
    "credit": "Credit",
    "macro": "Macro",
    "cross_asset": "Cross-Asset",
}

CATEGORY_DESCRIPTIONS: Dict[str, str] = {
    "sentiment": "Multi-week return momentum & the implied-over-realized variance premium",
    "volatility": "30-day model-free implied volatility & the 3M/1M curve slope",
    "positioning": "Observed SPY put/call ratios on volume and open interest",
    "trend": "S&P 500 distance above 20D, 50D, and 200D moving averages",
    "breadth": "Cross-sector advance/decline ratio & 52-week new highs",
    "momentum": "14-day RSI and cyclical tech vs defensive utility spread",
    "liquidity": "% of the large-cap universe trading above key moving averages",
    "credit": "High-yield vs Treasury total-return spread (HYG vs IEF)",
    "macro": "Observed 10Y minus 2Y Treasury curve slope",
    "cross_asset": "Equity risk appetite relative to gold",
}

# The cross-sector large-cap universe. Every name here is ingested by
# scorecard.market; a category that cannot price one of them says so through
# its `coverage` field rather than quietly shrinking its own sample.
BREADTH_UNIVERSE: Tuple[str, ...] = (
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX", "AVGO",
    "JPM", "BAC", "GS", "UNH", "JNJ", "LLY", "PFE", "HD", "MCD",
    "XOM", "CVX", "DIS", "CAT", "BA", "HON", "PG", "KO", "WMT", "COST", "VZ",
)

LIQUIDITY_UNIVERSE: Tuple[str, ...] = ("SPY", "QQQ", "IWM", "RSP", "MDY") + BREADTH_UNIVERSE


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        f = float(val)
        return default if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return default


def _clamp(val: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, val))


def _label(score: float) -> str:
    if score <= 25.0:
        return "Extreme Fear"
    if score <= 40.0:
        return "Fear"
    if score <= 60.0:
        return "Neutral"
    if score <= 75.0:
        return "Greed"
    return "Extreme Greed"


def _bar_color(score: float) -> str:
    if score <= 25.0:
        return "#ef4444"
    if score <= 40.0:
        return "#f97316"
    if score <= 60.0:
        return "#fbbf24"
    if score <= 75.0:
        return "#34d399"
    return "#10b981"


def _fetch_series(conn: sqlite3.Connection, ticker: str, limit: int = 300) -> List[Dict[str, Any]]:
    cur = conn.execute(
        """
        SELECT date, open, high, low, close, volume
        FROM market_observation
        WHERE ticker = ?
        ORDER BY date DESC
        LIMIT ?
        """,
        (ticker.upper(), limit),
    )
    rows = cur.fetchall()
    return [
        {
            "date": str(r[0]),
            "open": float(r[1]),
            "high": float(r[2]),
            "low": float(r[3]),
            "close": float(r[4]),
            "volume": float(r[5] or 0.0),
        }
        for r in reversed(rows)
    ]


def _calc_rsi(closes: List[float], period: int = 14) -> float:
    """Wilder's RSI with the standard smoothed average, not a flat mean."""
    if len(closes) < period + 1:
        return 50.0
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(0.0, d) for d in deltas]
    losses = [max(0.0, -d) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(deltas)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss <= 1e-12:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return _clamp(100.0 - (100.0 / (1.0 + rs)))


def _realized_vol(closes: List[float], window: int = 21) -> Optional[float]:
    if len(closes) < window + 2:
        return None
    rets = [(closes[i] / closes[i - 1]) - 1.0 for i in range(1, len(closes)) if closes[i - 1] > 0]
    chunk = rets[-window:]
    if len(chunk) < 2:
        return None
    mean = sum(chunk) / len(chunk)
    var = sum((x - mean) ** 2 for x in chunk) / (len(chunk) - 1)
    return math.sqrt(var * 252) * 100.0


# ═══════════════════════════════════════════════════════════════════════
# Observed option-chain inputs
# ═══════════════════════════════════════════════════════════════════════

def _chain_metrics(conn: sqlite3.Connection, underlying: str = "SPY") -> Dict[str, Any]:
    """Implied volatility, curve slope and put/call ratios from the stored chain."""
    out: Dict[str, Any] = {
        "iv_30d": None, "iv_9d": None, "iv_90d": None,
        "contango_ratio": None, "pcr_volume": None, "pcr_oi": None,
        "available": False,
    }
    snapshot_date, rows = load_chain_rows(conn, underlying)
    if not rows or snapshot_date is None:
        return out

    spot_row = conn.execute(
        "SELECT close FROM market_observation WHERE ticker = ? ORDER BY date DESC LIMIT 1",
        (underlying.upper(),),
    ).fetchone()
    if not spot_row:
        return out

    chains = group_by_expiry(rows)
    curve = term_structure(
        chains, snapshot_date, float(spot_row["close"]),
        lambda d: risk_free_rate(conn, d, as_of=snapshot_date),
        tenors=(9.0, 30.0, 90.0),
    )
    out.update({"iv_9d": curve.get("9d"), "iv_30d": curve.get("30d"), "iv_90d": curve.get("90d")})
    if curve.get("30d") and curve.get("90d"):
        out["contango_ratio"] = curve["90d"] / curve["30d"]

    call_oi = sum(float(r["open_interest"] or 0.0) for r in rows if r["contract_type"] == "call")
    put_oi = sum(float(r["open_interest"] or 0.0) for r in rows if r["contract_type"] == "put")
    call_vol = sum(float(r["volume"] or 0.0) for r in rows if r["contract_type"] == "call")
    put_vol = sum(float(r["volume"] or 0.0) for r in rows if r["contract_type"] == "put")
    if call_oi > 0:
        out["pcr_oi"] = put_oi / call_oi
    if call_vol > 0:
        out["pcr_volume"] = put_vol / call_vol
    out["available"] = out["iv_30d"] is not None or out["pcr_oi"] is not None
    return out


# ═══════════════════════════════════════════════════════════════════════
# 10 Independent Category Scorers (0–100 Scale)
# ═══════════════════════════════════════════════════════════════════════

def _score_sentiment(
    spy_bars: List[Dict[str, Any]], chain: Dict[str, Any]
) -> Tuple[float, Dict[str, Any]]:
    """Return momentum, tempered by what the options market charges to hedge it."""
    if len(spy_bars) < 25:
        return 50.0, {"note": "Fewer than 25 sessions of price history."}
    closes = [b["close"] for b in spy_bars]
    ret5 = ((closes[-1] / closes[-6]) - 1.0) * 100.0 if len(closes) >= 6 else 0.0
    ret20 = ((closes[-1] / closes[-21]) - 1.0) * 100.0 if len(closes) >= 21 else 0.0

    sent_20d = _clamp((ret20 + 6.0) / 12.0 * 100.0)
    sent_5d = _clamp((ret5 + 3.0) / 6.0 * 100.0)
    momentum_component = sent_20d * 0.6 + sent_5d * 0.4

    details: Dict[str, Any] = {"ret_5d": round(ret5, 2), "ret_20d": round(ret20, 2)}

    # Variance risk premium: implied minus realized. A wide premium means the
    # market is paying up for protection (fear); a negative one means the tape
    # is moving more than options charge for (complacency).
    realized = _realized_vol(closes, 21)
    iv_30 = chain.get("iv_30d")
    if realized is not None and iv_30 is not None:
        vrp = iv_30 - realized
        # Typical S&P variance premium runs roughly -2 to +6 vol points.
        premium_score = _clamp(100.0 - ((vrp + 2.0) / 8.0 * 100.0))
        details.update({
            "implied_vol_30d": round(iv_30, 2),
            "realized_vol_21d": round(realized, 2),
            "variance_risk_premium": round(vrp, 2),
        })
        score = _clamp(momentum_component * 0.65 + premium_score * 0.35)
    else:
        details["note"] = "No option chain — sentiment scored on return momentum alone."
        score = _clamp(momentum_component)

    return score, details


def _score_volatility(
    conn: sqlite3.Connection, chain: Dict[str, Any], underlying: str = "SPY"
) -> Tuple[float, Dict[str, Any]]:
    """Implied volatility level ranked against stored history, plus curve slope."""
    iv_30 = chain.get("iv_30d")
    if iv_30 is None:
        return 50.0, {"note": "No option chain ingested — volatility category is neutral by default."}

    details: Dict[str, Any] = {
        "implied_vol_30d": round(iv_30, 2),
        "implied_vol_9d": round(chain["iv_9d"], 2) if chain.get("iv_9d") else None,
        "implied_vol_90d": round(chain["iv_90d"], 2) if chain.get("iv_90d") else None,
    }

    # Level: rank against stored implied history when there is enough of it,
    # otherwise fall back to an absolute S&P volatility scale (10% = calm,
    # 35% = crisis). The fallback is stated in the details, never hidden.
    hist = [
        float(r["iv_30d"])
        for r in conn.execute(
            "SELECT iv_30d FROM vol_index_observation WHERE underlying = ? AND iv_30d IS NOT NULL ORDER BY date DESC LIMIT 252",
            (underlying.upper(),),
        ).fetchall()
    ]
    if len(hist) >= 30:
        below = sum(1 for v in hist if v <= iv_30)
        pct = (below / len(hist)) * 100.0
        level_score = _clamp(100.0 - pct)
        details["implied_vol_percentile"] = round(pct, 1)
        details["level_basis"] = f"percentile of {len(hist)} stored snapshots"
    else:
        level_score = _clamp(100.0 - ((iv_30 - 10.0) / 25.0 * 100.0))
        details["implied_vol_percentile"] = None
        details["level_basis"] = (
            f"absolute scale (10-35% implied); {len(hist)} of 30 snapshots stored for a percentile"
        )

    # Slope: contango is the calm regime, backwardation the stressed one.
    ratio = chain.get("contango_ratio")
    if ratio is not None:
        slope_score = _clamp((ratio - 0.90) / 0.25 * 100.0)
        details["contango_ratio"] = round(ratio, 4)
    else:
        slope_score = level_score
        details["contango_ratio"] = None

    return _clamp(level_score * 0.6 + slope_score * 0.4), details


def _score_positioning(chain: Dict[str, Any]) -> Tuple[float, Dict[str, Any]]:
    """Observed put/call ratios. High put demand is hedging, which is fear."""
    pcr_vol = chain.get("pcr_volume")
    pcr_oi = chain.get("pcr_oi")
    if pcr_vol is None and pcr_oi is None:
        return 50.0, {"note": "No option chain ingested — positioning is neutral by default."}

    details: Dict[str, Any] = {
        "pcr_volume": round(pcr_vol, 3) if pcr_vol is not None else None,
        "pcr_oi": round(pcr_oi, 3) if pcr_oi is not None else None,
    }

    # Index put/call volume typically runs 0.7 (greed) to 1.8 (fear); index
    # open-interest ratios sit structurally higher because index puts are held
    # as portfolio insurance, so the two get their own scales.
    parts: List[float] = []
    if pcr_vol is not None:
        parts.append(_clamp((1.8 - pcr_vol) / 1.1 * 100.0))
    if pcr_oi is not None:
        parts.append(_clamp((2.6 - pcr_oi) / 1.6 * 100.0))
    return _clamp(sum(parts) / len(parts)), details


def _score_trend(spy_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 50:
        return 50.0, {"note": "Fewer than 50 sessions of price history."}
    closes = [b["close"] for b in spy_bars]
    curr = closes[-1]
    sma20 = sum(closes[-20:]) / 20.0
    sma50 = sum(closes[-50:]) / 50.0
    sma200 = sum(closes[-min(200, len(closes)):]) / min(200, len(closes))

    dist20 = ((curr / sma20) - 1.0) * 100.0
    dist50 = ((curr / sma50) - 1.0) * 100.0
    dist200 = ((curr / sma200) - 1.0) * 100.0

    s20 = _clamp((dist20 + 3.0) / 6.0 * 100.0)
    s50 = _clamp((dist50 + 5.0) / 10.0 * 100.0)
    s200 = _clamp((dist200 + 10.0) / 20.0 * 100.0)

    score = _clamp(s20 * 0.25 + s50 * 0.35 + s200 * 0.40)
    return score, {
        "dist_sma20": round(dist20, 2),
        "dist_sma50": round(dist50, 2),
        "dist_sma200": round(dist200, 2),
        "sma200_window": min(200, len(closes)),
    }


def _score_breadth(conn: sqlite3.Connection) -> Tuple[float, Dict[str, Any]]:
    """Advance/decline and 52-week-high participation across the full universe."""
    advances = 0
    total = 0
    near_highs = 0
    missing: List[str] = []

    for t in BREADTH_UNIVERSE:
        series = _fetch_series(conn, t, limit=260)
        if len(series) < 20:
            missing.append(t)
            continue
        total += 1
        closes = [b["close"] for b in series]
        if len(closes) >= 2 and closes[-1] > closes[-2]:
            advances += 1
        high52 = max(b["high"] for b in series)
        if high52 > 0 and (closes[-1] / high52) >= 0.95:
            near_highs += 1

    if total == 0:
        return 50.0, {"note": "No universe constituents priced.", "coverage": "0/%d" % len(BREADTH_UNIVERSE)}

    ad_ratio = advances / total
    high_pct = near_highs / total

    ad_score = _clamp(ad_ratio * 100.0)
    high_score = _clamp(high_pct * 120.0)
    score = _clamp(ad_score * 0.5 + high_score * 0.5)

    return score, {
        "advance_decline_pct": round(ad_ratio * 100.0, 1),
        "near_52w_high_pct": round(high_pct * 100.0, 1),
        "coverage": f"{total}/{len(BREADTH_UNIVERSE)}",
        "missing": missing,
    }


def _score_momentum(
    spy_bars: List[Dict[str, Any]], xlk_bars: List[Dict[str, Any]], xlu_bars: List[Dict[str, Any]]
) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 20:
        return 50.0, {"note": "Fewer than 20 sessions of price history."}
    spy_closes = [b["close"] for b in spy_bars]
    rsi = _calc_rsi(spy_closes, period=14)

    spread_score = 50.0
    diff = None
    if len(xlk_bars) >= 21 and len(xlu_bars) >= 21:
        xlk_ret = (xlk_bars[-1]["close"] / xlk_bars[-21]["close"]) - 1.0
        xlu_ret = (xlu_bars[-1]["close"] / xlu_bars[-21]["close"]) - 1.0
        diff = (xlk_ret - xlu_ret) * 100.0
        spread_score = _clamp((diff + 8.0) / 16.0 * 100.0)

    score = _clamp(rsi * 0.6 + spread_score * 0.4)
    return score, {
        "spy_rsi": round(rsi, 1),
        "tech_vs_util_spread_pct": round(diff, 2) if diff is not None else None,
        "tech_vs_util_score": round(spread_score, 1),
    }


def _score_liquidity(conn: sqlite3.Connection) -> Tuple[float, Dict[str, Any]]:
    """Participation: how much of the universe is above its own trend."""
    above_200 = 0
    above_50 = 0
    total_50 = 0
    total_200 = 0
    missing: List[str] = []

    for t in LIQUIDITY_UNIVERSE:
        series = _fetch_series(conn, t, limit=260)
        if len(series) < 50:
            missing.append(t)
            continue
        closes = [b["close"] for b in series]
        curr = closes[-1]
        total_50 += 1
        if curr > sum(closes[-50:]) / 50.0:
            above_50 += 1
        if len(closes) >= 200:
            total_200 += 1
            if curr > sum(closes[-200:]) / 200.0:
                above_200 += 1

    if total_50 == 0:
        return 50.0, {"note": "No universe constituents priced.", "coverage": f"0/{len(LIQUIDITY_UNIVERSE)}"}

    pct_50 = (above_50 / total_50) * 100.0
    pct_200 = (above_200 / total_200) * 100.0 if total_200 else pct_50

    score = _clamp(pct_50 * 0.4 + pct_200 * 0.6)
    return score, {
        "pct_above_50d": round(pct_50, 1),
        "pct_above_200d": round(pct_200, 1),
        "coverage": f"{total_50}/{len(LIQUIDITY_UNIVERSE)}",
        "missing": missing,
    }


def _score_credit(
    hyg_bars: List[Dict[str, Any]], ief_bars: List[Dict[str, Any]]
) -> Tuple[float, Dict[str, Any]]:
    """High-yield versus Treasury relative performance over the past month.

    This is a total-return spread between two ETFs, not an option-adjusted
    credit spread — the vendor plan carries no OAS series. It moves with credit
    risk appetite, which is what the category is weighting, and the field names
    say `relative_return`, not `spread_bps`.
    """
    if len(hyg_bars) < 31 or len(ief_bars) < 31:
        return 50.0, {"note": "Fewer than 31 sessions of HYG/IEF history."}
    hyg_closes = [b["close"] for b in hyg_bars]
    ief_closes = [b["close"] for b in ief_bars]

    ratio_now = hyg_closes[-1] / ief_closes[-1]
    ratio_30d = hyg_closes[-31] / ief_closes[-31]
    change_pct = ((ratio_now / ratio_30d) - 1.0) * 100.0

    score = _clamp((change_pct + 4.0) / 8.0 * 100.0)
    return score, {
        "hyg_ief_ratio": round(ratio_now, 4),
        "relative_return_30d_pct": round(change_pct, 2),
    }


def _score_macro(conn: sqlite3.Connection) -> Tuple[float, Dict[str, Any]]:
    """Observed 10Y minus 2Y Treasury slope.

    A steep curve is the expansionary regime; an inverted one has preceded
    every post-war US recession. Scored on the observed yields rather than on
    the TLT/IEF price ratio, which is a duration artefact.
    """
    slope = yield_curve_slope(conn)
    if slope is None:
        return 50.0, {"note": "No Treasury curve ingested — macro is neutral by default."}
    row = conn.execute(
        "SELECT date, yield_2_year, yield_10_year FROM treasury_yield "
        "WHERE yield_2_year IS NOT NULL AND yield_10_year IS NOT NULL ORDER BY date DESC LIMIT 1"
    ).fetchone()

    # -1.0pp (deeply inverted) to +2.0pp (steep) spans the modern range.
    score = _clamp((slope + 1.0) / 3.0 * 100.0)
    return score, {
        "curve_slope_10y_2y": round(slope, 3),
        "yield_2y": float(row["yield_2_year"]) if row else None,
        "yield_10y": float(row["yield_10_year"]) if row else None,
        "curve_date": str(row["date"]) if row else None,
        "inverted": slope < 0,
    }


def _score_cross_asset(
    spy_bars: List[Dict[str, Any]], gld_bars: List[Dict[str, Any]]
) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 31 or len(gld_bars) < 31:
        return 50.0, {"note": "Fewer than 31 sessions of SPY/GLD history."}
    spy_ret = (spy_bars[-1]["close"] / spy_bars[-31]["close"]) - 1.0
    gld_ret = (gld_bars[-1]["close"] / gld_bars[-31]["close"]) - 1.0

    spread = (spy_ret - gld_ret) * 100.0
    score = _clamp((spread + 8.0) / 16.0 * 100.0)
    return score, {
        "spy_return_30d_pct": round(spy_ret * 100.0, 2),
        "gld_return_30d_pct": round(gld_ret * 100.0, 2),
        "equity_vs_gold_spread": round(spread, 2),
    }


# ═══════════════════════════════════════════════════════════════════════
# Master Fear & Greed Index 2.0 Engine
# ═══════════════════════════════════════════════════════════════════════

def compute_fear_greed_index(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Compute the composite MoQ Fear & Greed Index 2.0.

    Evaluates ten weighted categories and returns the composite score, gauge
    colour, per-category breakdown, key metrics and timestamp. Categories that
    lack their input score a neutral 50 and say so in ``details.note`` — the
    composite never silently absorbs a missing input as a signal.
    """
    spy_bars = _fetch_series(conn, "SPY")
    xlk_bars = _fetch_series(conn, "XLK")
    xlu_bars = _fetch_series(conn, "XLU")
    hyg_bars = _fetch_series(conn, "HYG")
    ief_bars = _fetch_series(conn, "IEF")
    gld_bars = _fetch_series(conn, "GLD")
    chain = _chain_metrics(conn, "SPY")

    cat_results: Dict[str, Tuple[float, Dict[str, Any]]] = {
        "sentiment": _score_sentiment(spy_bars, chain),
        "volatility": _score_volatility(conn, chain),
        "positioning": _score_positioning(chain),
        "trend": _score_trend(spy_bars),
        "breadth": _score_breadth(conn),
        "momentum": _score_momentum(spy_bars, xlk_bars, xlu_bars),
        "liquidity": _score_liquidity(conn),
        "credit": _score_credit(hyg_bars, ief_bars),
        "macro": _score_macro(conn),
        "cross_asset": _score_cross_asset(spy_bars, gld_bars),
    }

    categories: Dict[str, Dict[str, Any]] = {}
    composite = 0.0
    degraded: List[str] = []

    for key, (score, details) in cat_results.items():
        w = WEIGHTS[key]
        contrib = round(score * w, 1)
        composite += score * w
        if details.get("note"):
            degraded.append(key)
        categories[key] = {
            "key": key,
            "label": CATEGORY_LABELS[key],
            "description": CATEGORY_DESCRIPTIONS[key],
            "score": round(score, 1),
            "weight": round(w * 100),
            "contribution": contrib,
            "bar_color": _bar_color(score),
            "measured": not details.get("note"),
            "details": details,
        }

    composite_score = round(_clamp(composite), 1)

    def _detail(cat: str, field: str, default: Any = None) -> Any:
        return categories.get(cat, {}).get("details", {}).get(field, default)

    key_metrics = {
        "spy_price": round(spy_bars[-1]["close"], 2) if spy_bars else None,
        "implied_vol_30d": _detail("volatility", "implied_vol_30d"),
        "realized_vol_21d": _detail("sentiment", "realized_vol_21d"),
        "spy_rsi": _detail("momentum", "spy_rsi"),
        "pct_above_200d": _detail("liquidity", "pct_above_200d"),
        "pcr_volume": _detail("positioning", "pcr_volume"),
        "pcr_oi": _detail("positioning", "pcr_oi"),
        "curve_slope_10y_2y": _detail("macro", "curve_slope_10y_2y"),
        "credit_relative_return_30d": _detail("credit", "relative_return_30d_pct"),
    }

    return {
        "composite_score": composite_score,
        "label": _label(composite_score),
        "bar_color": _bar_color(composite_score),
        "as_of_date": spy_bars[-1]["date"] if spy_bars else None,
        "chain_available": chain["available"],
        "degraded_categories": degraded,
        "categories": categories,
        "key_metrics": key_metrics,
        "category_order": list(WEIGHTS.keys()),
    }

"""
MoQ Fear & Greed Index 2.0 Engine.
Ported from MomentumQ Terminal (backend/app/processing/fear_greed.py).

Composite market sentiment indicator built from 10 independent categories:
  1. Sentiment   (10%) — Short/medium term return momentum + AAII proxy
  2. Volatility  (10%) — VIX proxy level + term structure contango slope
  3. Positioning (15%) — Put/call volume hedging ratio proxy
  4. Trend       (10%) — SPY vs 20d / 50d / 200d moving averages
  5. Breadth     (10%) — Stock universe advance/decline ratio & 52W highs/lows
  6. Momentum    (10%) — SPY 14D RSI + cyclical vs defensive sector alpha spread
  7. Liquidity   (15%) — % of universe stocks trading above 50d and 200d MAs
  8. Credit      (10%) — High-yield credit spread proxy (HYG vs IEF/TLT)
  9. Macro        (5%) — Yield curve duration proxy (TLT vs IEF)
  10. Cross-Asset (5%) — Risk-on vs safe haven flows (SPY vs GLD/TLT)

Each category produces a 0-100 score (0 = Extreme Fear, 100 = Extreme Greed).
The composite score is the weighted average.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

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
    "sentiment": "AAII bull/bear proxy & multi-week return momentum",
    "volatility": "VIX proxy percentile & 5-day term structure roll slope",
    "positioning": "Put/call volume hedging intensity ratio",
    "trend": "S&P 500 distance above 20D, 50D, and 200D moving averages",
    "breadth": "Universe advance/decline ratio & 52-week new highs vs lows",
    "momentum": "14-day RSI and cyclical tech vs defensive sector spread",
    "liquidity": "% of mega-cap components trading above key moving averages",
    "credit": "High yield corporate credit spread (HYG vs Treasuries)",
    "macro": "Treasury yield curve slope & rate regime proxy",
    "cross_asset": "Equity risk appetite relative to gold and government bonds",
}


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
            "volume": float(r[5]),
        }
        for r in reversed(rows)
    ]


def _calc_rsi(closes: List[float], period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(0.0, d) for d in deltas]
    losses = [max(0.0, -d) for d in deltas]

    recent_gains = gains[-period:]
    recent_losses = losses[-period:]
    avg_gain = sum(recent_gains) / period
    avg_loss = sum(recent_losses) / period

    if avg_loss <= 1e-9:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return _clamp(100.0 - (100.0 / (1.0 + rs)))


def _calc_pct_rank(val: float, series: List[float]) -> float:
    if not series:
        return 50.0
    count_below = sum(1 for x in series if x <= val)
    return (count_below / len(series)) * 100.0


# ═══════════════════════════════════════════════════════════════════════
# 10 Independent Category Scorers (0–100 Scale)
# ═══════════════════════════════════════════════════════════════════════

def _score_sentiment(spy_bars: List[Dict[str, Any]], vix_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 25:
        return 50.0, {}
    closes = [b["close"] for b in spy_bars]
    ret5 = ((closes[-1] / closes[-6]) - 1.0) * 100.0 if len(closes) >= 6 else 0.0
    ret20 = ((closes[-1] / closes[-21]) - 1.0) * 100.0 if len(closes) >= 21 else 0.0

    sent_20d = _clamp((ret20 + 6.0) / 12.0 * 100.0)
    sent_5d = _clamp((ret5 + 3.0) / 6.0 * 100.0)
    composite_ret_sent = sent_20d * 0.6 + sent_5d * 0.4

    vix_now = vix_bars[-1]["close"] if vix_bars else 18.0
    bear_pct = _clamp((vix_now - 12.0) / 20.0 * 100.0)
    bull_pct = 100.0 - bear_pct

    score = _clamp(composite_ret_sent * 0.5 + bull_pct * 0.3 + sent_5d * 0.2)
    return score, {
        "ret_5d": round(ret5, 2),
        "ret_20d": round(ret20, 2),
        "aaii_bull_proxy": round(bull_pct, 1),
        "aaii_bear_proxy": round(bear_pct, 1),
    }


def _score_volatility(vix_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(vix_bars) < 20:
        return 50.0, {}
    closes = [b["close"] for b in vix_bars]
    vix_now = closes[-1]
    vix_pct = _calc_pct_rank(vix_now, closes[-min(252, len(closes)):])
    
    roc5 = ((closes[-1] / closes[-6]) - 1.0) * 100.0 if len(closes) >= 6 else 0.0
    contango_score = _clamp(50.0 - (roc5 * 3.0))
    vix_level_score = _clamp(100.0 - vix_pct)

    score = _clamp(vix_level_score * 0.5 + contango_score * 0.5)
    return score, {
        "vix_proxy": round(vix_now, 2),
        "vix_percentile": round(vix_pct, 1),
        "term_structure_roc": round(roc5, 2),
    }


def _score_positioning(spy_bars: List[Dict[str, Any]], vix_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 10 or len(vix_bars) < 10:
        return 50.0, {}
    spy_vol = sum(b["volume"] for b in spy_bars[-5:]) / 5.0
    vix_vol = sum(b["volume"] for b in vix_bars[-5:]) / 5.0

    ratio = (vix_vol / spy_vol) * 100.0 if spy_vol > 0 else 1.0
    # Higher hedging volume = more fear -> lower score
    pc_score = _clamp((1.8 - min(3.0, ratio)) / 1.5 * 100.0)

    # 10-day price skew proxy
    spy_closes = [b["close"] for b in spy_bars[-10:]]
    skew_trend = ((spy_closes[-1] / spy_closes[0]) - 1.0) * 100.0
    skew_score = _clamp((skew_trend + 2.5) / 5.0 * 100.0)

    score = _clamp(pc_score * 0.6 + skew_score * 0.4)
    return score, {
        "put_call_proxy": round(ratio, 2),
        "hedging_score": round(pc_score, 1),
    }


def _score_trend(spy_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 50:
        return 50.0, {}
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
    }


def _score_breadth(conn: sqlite3.Connection) -> Tuple[float, Dict[str, Any]]:
    tickers = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "JPM", "BAC", "UNH", "JNJ", "LLY", "HD", "XOM", "CVX", "NFLX", "DIS", "CAT", "BA", "IWM", "QQQ"]
    advances = 0
    total = 0
    near_highs = 0

    for t in tickers:
        series = _fetch_series(conn, t, limit=260)
        if len(series) >= 20:
            total += 1
            closes = [b["close"] for b in series]
            if len(closes) >= 2 and closes[-1] > closes[-2]:
                advances += 1
            high52 = max(b["high"] for b in series)
            if high52 > 0 and (closes[-1] / high52) >= 0.95:
                near_highs += 1

    if total == 0:
        return 50.0, {}
    ad_ratio = advances / total
    high_pct = near_highs / total

    ad_score = _clamp(ad_ratio * 100.0)
    high_score = _clamp(high_pct * 120.0)
    score = _clamp(ad_score * 0.5 + high_score * 0.5)

    return score, {
        "advance_decline_pct": round(ad_ratio * 100.0, 1),
        "near_52w_high_pct": round(high_pct * 100.0, 1),
    }


def _score_momentum(spy_bars: List[Dict[str, Any]], xlk_bars: List[Dict[str, Any]], xlu_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 20:
        return 50.0, {}
    spy_closes = [b["close"] for b in spy_bars]
    rsi = _calc_rsi(spy_closes, period=14)

    # Cyclical tech (XLK) vs defensive utility (XLU) relative spread
    spread_score = 50.0
    if len(xlk_bars) >= 20 and len(xlu_bars) >= 20:
        xlk_ret = (xlk_bars[-1]["close"] / xlk_bars[-20]["close"]) - 1.0
        xlu_ret = (xlu_bars[-1]["close"] / xlu_bars[-20]["close"]) - 1.0
        diff = (xlk_ret - xlu_ret) * 100.0
        spread_score = _clamp((diff + 8.0) / 16.0 * 100.0)

    score = _clamp(rsi * 0.6 + spread_score * 0.4)
    return score, {
        "spy_rsi": round(rsi, 1),
        "tech_vs_util_spread": round(spread_score, 1),
    }


def _score_liquidity(conn: sqlite3.Connection) -> Tuple[float, Dict[str, Any]]:
    tickers = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "JPM", "UNH", "XOM"]
    above_200 = 0
    above_50 = 0
    total = 0

    for t in tickers:
        series = _fetch_series(conn, t, limit=220)
        if len(series) >= 50:
            total += 1
            closes = [b["close"] for b in series]
            curr = closes[-1]
            sma50 = sum(closes[-50:]) / 50.0
            if curr > sma50:
                above_50 += 1
            if len(closes) >= 150:
                sma200 = sum(closes[-min(200, len(closes)):]) / min(200, len(closes))
                if curr > sma200:
                    above_200 += 1

    if total == 0:
        return 50.0, {}
    pct_50 = (above_50 / total) * 100.0
    pct_200 = (above_200 / total) * 100.0

    score = _clamp(pct_50 * 0.4 + pct_200 * 0.6)
    return score, {
        "pct_above_50d": round(pct_50, 1),
        "pct_above_200d": round(pct_200, 1),
    }


def _score_credit(hyg_bars: List[Dict[str, Any]], ief_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(hyg_bars) < 30 or len(ief_bars) < 30:
        return 50.0, {}
    hyg_closes = [b["close"] for b in hyg_bars]
    ief_closes = [b["close"] for b in ief_bars]

    # Ratio of High Yield vs 7-10Y Treasuries
    ratio_now = hyg_closes[-1] / ief_closes[-1]
    ratio_30d = hyg_closes[-30] / ief_closes[-30]
    change_pct = ((ratio_now / ratio_30d) - 1.0) * 100.0

    score = _clamp((change_pct + 4.0) / 8.0 * 100.0)
    return score, {
        "hyg_ief_ratio": round(ratio_now, 3),
        "credit_appetite_change": round(change_pct, 2),
    }


def _score_macro(tlt_bars: List[Dict[str, Any]], ief_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(tlt_bars) < 20 or len(ief_bars) < 20:
        return 50.0, {}
    tlt_curr = tlt_bars[-1]["close"]
    ief_curr = ief_bars[-1]["close"]

    curve_ratio = tlt_curr / ief_curr
    score = _clamp((curve_ratio - 0.70) / 0.50 * 100.0)
    return score, {
        "yield_curve_ratio": round(curve_ratio, 3),
    }


def _score_cross_asset(spy_bars: List[Dict[str, Any]], gld_bars: List[Dict[str, Any]]) -> Tuple[float, Dict[str, Any]]:
    if len(spy_bars) < 30 or len(gld_bars) < 30:
        return 50.0, {}
    spy_ret = (spy_bars[-1]["close"] / spy_bars[-30]["close"]) - 1.0
    gld_ret = (gld_bars[-1]["close"] / gld_bars[-30]["close"]) - 1.0

    spread = (spy_ret - gld_ret) * 100.0
    score = _clamp((spread + 8.0) / 16.0 * 100.0)
    return score, {
        "equity_vs_gold_spread": round(spread, 2),
    }


# ═══════════════════════════════════════════════════════════════════════
# Master Fear & Greed Index 2.0 Engine
# ═══════════════════════════════════════════════════════════════════════

def compute_fear_greed_index(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Compute composite MoQ Fear & Greed Index 2.0.
    Evaluates 10 independent categories and returns composite score, gauge color,
    category breakdown, key metrics, and timestamp.
    """
    spy_bars = _fetch_series(conn, "SPY")
    vix_bars = _fetch_series(conn, "VIXY")
    xlk_bars = _fetch_series(conn, "XLK")
    xlu_bars = _fetch_series(conn, "XLU")
    hyg_bars = _fetch_series(conn, "HYG")
    ief_bars = _fetch_series(conn, "IEF")
    tlt_bars = _fetch_series(conn, "TLT")
    gld_bars = _fetch_series(conn, "GLD")

    cat_results: Dict[str, Tuple[float, Dict[str, Any]]] = {
        "sentiment": _score_sentiment(spy_bars, vix_bars),
        "volatility": _score_volatility(vix_bars),
        "positioning": _score_positioning(spy_bars, vix_bars),
        "trend": _score_trend(spy_bars),
        "breadth": _score_breadth(conn),
        "momentum": _score_momentum(spy_bars, xlk_bars, xlu_bars),
        "liquidity": _score_liquidity(conn),
        "credit": _score_credit(hyg_bars, ief_bars),
        "macro": _score_macro(tlt_bars, ief_bars),
        "cross_asset": _score_cross_asset(spy_bars, gld_bars),
    }

    categories: Dict[str, Dict[str, Any]] = {}
    composite = 0.0

    for key, (score, details) in cat_results.items():
        w = WEIGHTS[key]
        contrib = round(score * w, 1)
        composite += score * w
        categories[key] = {
            "key": key,
            "label": CATEGORY_LABELS[key],
            "description": CATEGORY_DESCRIPTIONS[key],
            "score": round(score, 1),
            "weight": round(w * 100),
            "contribution": contrib,
            "bar_color": _bar_color(score),
            "details": details,
        }

    composite_score = round(_clamp(composite), 1)

    key_metrics = {
        "spy_price": round(spy_bars[-1]["close"], 2) if spy_bars else 0.0,
        "vix_proxy": categories.get("volatility", {}).get("details", {}).get("vix_proxy", 0.0),
        "spy_rsi": categories.get("momentum", {}).get("details", {}).get("spy_rsi", 50.0),
        "pct_above_200d": categories.get("liquidity", {}).get("details", {}).get("pct_above_200d", 50.0),
        "put_call_proxy": categories.get("positioning", {}).get("details", {}).get("put_call_proxy", 1.0),
        "credit_spread_change": categories.get("credit", {}).get("details", {}).get("credit_appetite_change", 0.0),
    }

    return {
        "composite_score": composite_score,
        "label": _label(composite_score),
        "bar_color": _bar_color(composite_score),
        "as_of_date": spy_bars[-1]["date"] if spy_bars else "2026-08-18",
        "categories": categories,
        "key_metrics": key_metrics,
        "category_order": list(WEIGHTS.keys()),
    }

"""
Commodities, Precious Metals & Energy Macro Analytics Engine.
Provides institutional quantitative statistics for Gold (GLD), Brent/Crude Oil (USO),
Silver (SLV), Broad Commodities (DBC), US Dollar Index (UUP), and Cross-Asset Ratios.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional


def _calc_rvol(closes: List[float], window: int = 21) -> float:
    if len(closes) < window + 1:
        return 15.0
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - window, len(closes))]
    mean_r = sum(rets) / len(rets)
    var_r = sum((r - mean_r) ** 2 for r in rets) / (len(rets) - 1)
    return round(math.sqrt(var_r * 252.0) * 100.0, 1)


def _calc_rsi(closes: List[float], window: int = 14) -> float:
    if len(closes) < window + 1:
        return 50.0
    deltas = [closes[i] - closes[i - 1] for i in range(len(closes) - window, len(closes))]
    gains = [max(0.0, d) for d in deltas]
    losses = [max(0.0, -d) for d in deltas]
    avg_g = sum(gains) / window
    avg_l = sum(losses) / window
    if avg_l == 0:
        return 100.0
    rs = avg_g / avg_l
    return round(100.0 - (100.0 / (1.0 + rs)), 1)


def _calc_correlation(series_a: List[float], series_b: List[float], window: int = 60) -> float:
    n = min(len(series_a), len(series_b), window)
    if n < 10:
        return 0.0
    a = series_a[-n:]
    b = series_b[-n:]
    rets_a = [(a[i] / a[i - 1]) - 1.0 for i in range(1, n)]
    rets_b = [(b[i] / b[i - 1]) - 1.0 for i in range(1, n)]
    m_a = sum(rets_a) / len(rets_a)
    m_b = sum(rets_b) / len(rets_b)
    cov = sum((rets_a[i] - m_a) * (rets_b[i] - m_b) for i in range(len(rets_a)))
    var_a = sum((x - m_a) ** 2 for x in rets_a)
    var_b = sum((y - m_b) ** 2 for y in rets_b)
    if var_a <= 0 or var_b <= 0:
        return 0.0
    return round(cov / math.sqrt(var_a * var_b), 2)


def compute_commodities_analytics(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Compute multi-factor quantitative statistics, moving averages, ratios,
    and inflation sensitivities for commodities, gold, crude oil, and currencies.
    """
    def _fetch_series(ticker: str, limit: int = 600) -> List[Dict[str, Any]]:
        rows = conn.execute(
            "SELECT date, close FROM market_observation WHERE ticker = ? ORDER BY date DESC LIMIT ?",
            (ticker.upper(), limit),
        ).fetchall()
        return [{"date": str(r[0]), "close": float(r[1])} for r in reversed(rows)]

    gld_bars = _fetch_series("GLD")
    slv_bars = _fetch_series("SLV")
    uso_bars = _fetch_series("USO")
    dbc_bars = _fetch_series("DBC")
    uup_bars = _fetch_series("UUP")
    tip_bars = _fetch_series("TIP")
    tlt_bars = _fetch_series("TLT")
    spy_bars = _fetch_series("SPY")

    if not gld_bars or not uso_bars:
        return {"as_of_date": "2026-08-19", "assets": [], "cross_ratios": {}, "summary": {}}

    as_of = gld_bars[-1]["date"]

    def _build_asset_card(name: str, ticker: str, category: str, bars: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not bars:
            return {}
        closes = [b["close"] for b in bars]
        c = closes[-1]
        c_1d = closes[-2] if len(closes) > 1 else c
        c_21d = closes[-22] if len(closes) > 21 else c
        c_63d = closes[-64] if len(closes) > 63 else c
        c_252d = closes[-253] if len(closes) > 252 else closes[0]

        high_52w = max(closes[-252:]) if len(closes) >= 252 else max(closes)
        low_52w = min(closes[-252:]) if len(closes) >= 252 else min(closes)

        m50 = sum(closes[-50:]) / 50.0 if len(closes) >= 50 else c
        m200 = sum(closes[-200:]) / 200.0 if len(closes) >= 200 else c

        rvol_21d = _calc_rvol(closes, 21)
        rvol_252d = _calc_rvol(closes, min(252, len(closes) - 1))
        rsi_14 = _calc_rsi(closes, 14)

        ret_1d = ((c / c_1d) - 1.0) * 100.0
        ret_1m = ((c / c_21d) - 1.0) * 100.0
        ret_3m = ((c / c_63d) - 1.0) * 100.0
        ret_1y = ((c / c_252d) - 1.0) * 100.0

        # Technical posture
        if c > m50 and m50 > m200:
            trend_posture = "BULLISH_TREND"
        elif c < m50 and c > m200:
            trend_posture = "PULLBACK_SUPPORT"
        elif c < m200 and m50 < m200:
            trend_posture = "BEARISH_TREND"
        else:
            trend_posture = "NEUTRAL_CONSOLIDATION"

        return {
            "name": name,
            "ticker": ticker,
            "category": category,
            "spot": round(c, 2),
            "chg_1d_pct": round(ret_1d, 2),
            "ret_1m_pct": round(ret_1m, 2),
            "ret_3m_pct": round(ret_3m, 2),
            "ret_1y_pct": round(ret_1y, 2),
            "high_52w": round(high_52w, 2),
            "low_52w": round(low_52w, 2),
            "pct_from_52w_high": round(((c / high_52w) - 1.0) * 100.0, 2),
            "pct_from_52w_low": round(((c / low_52w) - 1.0) * 100.0, 2),
            "sma_50": round(m50, 2),
            "sma_200": round(m200, 2),
            "rvol_21d": rvol_21d,
            "rvol_252d": rvol_252d,
            "rsi_14": rsi_14,
            "trend_posture": trend_posture,
        }

    gold_card = _build_asset_card("Gold Bullion (SPDR)", "GLD", "Precious Metals", gld_bars)
    oil_card = _build_asset_card("Crude Oil / Brent Proxy (USO)", "USO", "Energy & Petroleum", uso_bars)
    silver_card = _build_asset_card("Silver Physical Trust (SLV)", "SLV", "Precious & Industrial Metals", slv_bars)
    dbc_card = _build_asset_card("Commodity Index Basket (DBC)", "DBC", "Broad Commodities", dbc_bars)
    dollar_card = _build_asset_card("US Dollar Index Bullish (UUP)", "UUP", "Currencies / FX", uup_bars)

    # Cross-Asset Relative Ratios
    gld_closes = [b["close"] for b in gld_bars]
    slv_closes = [b["close"] for b in slv_bars]
    uso_closes = [b["close"] for b in uso_bars]
    tlt_closes = [b["close"] for b in tlt_bars]
    tip_closes = [b["close"] for b in tip_bars]
    uup_closes = [b["close"] for b in uup_bars]
    spy_closes = [b["close"] for b in spy_bars]

    # 1. Gold / Silver Ratio
    gld_slv_ratio = round(gold_card["spot"] / silver_card["spot"], 2) if silver_card["spot"] > 0 else 0.0

    # 2. Gold / Oil Ratio (GLD / USO)
    gld_uso_ratio = round(gold_card["spot"] / oil_card["spot"], 2) if oil_card["spot"] > 0 else 0.0

    # 3. Oil / Treasury Ratio (USO / TLT)
    uso_tlt_ratio = round(oil_card["spot"] / tlt_closes[-1], 2) if tlt_closes else 0.0

    # Correlations (60D)
    corr_gold_tips = _calc_correlation(gld_closes, tip_closes, 60)
    corr_gold_dxy = _calc_correlation(gld_closes, uup_closes, 60)
    corr_oil_dxy = _calc_correlation(uso_closes, uup_closes, 60)
    corr_oil_spy = _calc_correlation(uso_closes, spy_closes, 60)
    corr_gold_spy = _calc_correlation(gld_closes, spy_closes, 60)

    # Commodity Macro Regime summary
    if gold_card["ret_3m_pct"] > 5.0 and dbc_card["ret_3m_pct"] > 0.0:
        macro_stance = "PRECIOUS_METALS_EXPANSION"
        stance_desc = "Gold outperforming equities and broad commodities, driven by sovereign reserve demand and real-yield hedge positioning."
    elif oil_card["ret_3m_pct"] > 10.0:
        macro_stance = "ENERGY_TIGHTNESS_INFLATIONARY"
        stance_desc = "Crude oil leading macro basket, signaling commodity supply friction and cost-push headline inflation risk."
    elif dollar_card["ret_3m_pct"] > 3.0:
        macro_stance = "DOLLAR_SQUEEZE_DISINFLATIONARY"
        stance_desc = "Strong US Dollar acting as headwind to emerging markets and global commodity pricing."
    else:
        macro_stance = "BALANCED_MACRO_CARRY"
        stance_desc = "Orderly commodity dispersion with contained energy volatility supporting equity duration."

    return {
        "as_of_date": as_of,
        "macro_stance": macro_stance,
        "stance_description": stance_desc,
        "assets": [gold_card, oil_card, silver_card, dbc_card, dollar_card],
        "cross_ratios": {
            "gold_silver_ratio": gld_slv_ratio,
            "gold_oil_ratio": gld_uso_ratio,
            "oil_treasury_ratio": uso_tlt_ratio,
            "corr_gold_tips_60d": corr_gold_tips,
            "corr_gold_dxy_60d": corr_gold_dxy,
            "corr_oil_dxy_60d": corr_oil_dxy,
            "corr_oil_spy_60d": corr_oil_spy,
            "corr_gold_spy_60d": corr_gold_spy,
        },
    }

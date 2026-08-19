"""
VIX Term Structure & Contango/Backwardation Analytics Engine.
Ported from MomentumQ Terminal (app/processing/vix_structure.py).
Infers contango and backwardation in the VIX futures curve using VIXY, SVXY, and SPY proxies.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        f = float(val)
        return default if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return default


def compute_vix_structure(conn: sqlite3.Connection, history_days: int = 252) -> Dict[str, Any]:
    """
    Compute VIX term structure analysis using ETF proxies (VIXY, SVXY, SPY).
    Returns current state, severity, 1Y percentile, contango ratio, history, and narrative interpretation.
    """
    # 1. Fetch VIXY daily observations
    cur = conn.execute(
        """
        SELECT date, close
        FROM market_observation
        WHERE ticker = 'VIXY'
        ORDER BY date DESC
        LIMIT 300
        """
    )
    vixy_rows = cur.fetchall()
    if len(vixy_rows) < 20:
        return _empty_vix_result("VIXY data unavailable in observation database")

    # Chronological order
    vixy_rows = list(reversed(vixy_rows))
    dates = [str(r[0]) for r in vixy_rows]
    vixy_closes = [float(r[1]) for r in vixy_rows]

    # 2. Fetch SPY daily observations for alignment
    cur = conn.execute(
        """
        SELECT date, close
        FROM market_observation
        WHERE ticker = 'SPY'
        ORDER BY date DESC
        LIMIT 300
        """
    )
    spy_map = {str(r[0]): float(r[1]) for r in cur.fetchall()}

    # 3. VIX proxy and 1-Year percentile
    vix_proxy = vixy_closes[-1]
    vix_1y = vixy_closes[-min(252, len(vixy_closes)):]
    vix_min = min(vix_1y)
    vix_max = max(vix_1y)

    if vix_max > vix_min:
        vix_percentile = (vix_proxy - vix_min) / (vix_max - vix_min) * 100.0
    else:
        vix_percentile = 50.0
    vix_percentile = max(0.0, min(100.0, _safe_float(vix_percentile, 50.0)))

    # 4. 5-day rate of change of VIXY (Term structure slope proxy)
    # Contango (normal) -> VIXY rolls down futures curve -> negative ROC
    # Backwardation (stress) -> VIXY spikes -> positive ROC
    roc5_list: List[Optional[float]] = []
    for i in range(len(vixy_closes)):
        if i >= 5 and vixy_closes[i - 5] > 0:
            roc5 = ((vixy_closes[i] / vixy_closes[i - 5]) - 1.0) * 100.0
            roc5_list.append(round(roc5, 2))
        else:
            roc5_list.append(None)

    # Contango ratio: average 5d ROC over last 20 trading days
    recent_roc = [r for r in roc5_list[-20:] if r is not None]
    contango_ratio = sum(recent_roc) / len(recent_roc) if recent_roc else 0.0

    # 5. Classify State & Severity
    if contango_ratio < -1.5:
        current_state = "Contango"
        if contango_ratio < -4.0:
            severity = "steep"
            color = "#34d399"
        elif contango_ratio < -2.5:
            severity = "moderate"
            color = "#34d399"
        else:
            severity = "mild"
            color = "#7aa2ff"
    elif contango_ratio > 1.5:
        current_state = "Backwardation"
        if contango_ratio > 6.0:
            severity = "steep"
            color = "#ef4444"
        elif contango_ratio > 3.0:
            severity = "moderate"
            color = "#f59e0b"
        else:
            severity = "mild"
            color = "#fbbf24"
    else:
        current_state = "Flat"
        severity = "mild"
        color = "#8c97b2"

    # 6. VIXY vs SPY 30-day rolling inverse correlation
    vixy_spy_corr: Optional[float] = None
    if len(vixy_closes) >= 35:
        v_sub = vixy_closes[-30:]
        s_sub = [spy_map.get(d, 0.0) for d in dates[-30:]]
        if all(s > 0 for s in s_sub):
            v_rets = [(v_sub[i] / v_sub[i-1]) - 1.0 for i in range(1, 30)]
            s_rets = [(s_sub[i] / s_sub[i-1]) - 1.0 for i in range(1, 30)]
            
            mean_v = sum(v_rets) / len(v_rets)
            mean_s = sum(s_rets) / len(s_rets)
            cov = sum((v_rets[i] - mean_v) * (s_rets[i] - mean_s) for i in range(len(v_rets)))
            var_v = sum((v_rets[i] - mean_v)**2 for i in range(len(v_rets)))
            var_s = sum((s_rets[i] - mean_s)**2 for i in range(len(s_rets)))
            denom = math.sqrt(var_v * var_s)
            vixy_spy_corr = round(cov / denom, 3) if denom > 1e-9 else None

    # 7. Trim history to requested lookback days
    trim_len = min(history_days, len(dates))
    h_dates = dates[-trim_len:]
    h_vix = [round(v, 2) for v in vixy_closes[-trim_len:]]
    h_signal = [round(r, 2) if r is not None else 0.0 for r in roc5_list[-trim_len:]]
    h_spy = [round(spy_map.get(d, 0.0), 2) for d in h_dates]

    # 8. Contango / Backwardation Regions
    regions: List[Dict[str, str]] = []
    if h_signal:
        cur_type = "contango" if h_signal[0] <= 0 else "backwardation"
        reg_start = 0
        for idx in range(1, len(h_signal)):
            sig_type = "contango" if h_signal[idx] <= 0 else "backwardation"
            if sig_type != cur_type:
                regions.append({"start": h_dates[reg_start], "end": h_dates[idx - 1], "type": cur_type})
                reg_start = idx
                cur_type = sig_type
        if reg_start < len(h_dates):
            regions.append({"start": h_dates[reg_start], "end": h_dates[-1], "type": cur_type})

    interpretation = _build_vix_interpretation(
        current_state, severity, vix_proxy, vix_percentile, contango_ratio, vixy_spy_corr
    )

    return {
        "current_state": current_state,
        "severity": severity,
        "state_color": color,
        "vix_proxy": round(vix_proxy, 2),
        "vix_percentile": round(vix_percentile, 1),
        "contango_ratio": round(contango_ratio, 3),
        "vixy_spy_corr": vixy_spy_corr,
        "as_of_date": dates[-1],
        "history": {
            "dates": h_dates,
            "vix_proxy": h_vix,
            "contango_signal": h_signal,
            "spy_close": h_spy,
            "regions": regions
        },
        "interpretation": interpretation
    }


def _build_vix_interpretation(
    state: str,
    severity: str,
    vix_proxy: float,
    vix_percentile: float,
    contango_ratio: float,
    vixy_spy_corr: Optional[float]
) -> str:
    """Build narrative interpretation for quants and research analysts."""
    parts = []
    if state == "Contango":
        parts.append(
            f"VIX futures curve is in {severity} contango (avg 5d decay {contango_ratio:.1f}%). "
            "Normal volatility roll yield is positive, supporting equity momentum and carry strategies."
        )
    elif state == "Backwardation":
        parts.append(
            f"VIX futures curve is inverted in {severity} backwardation (avg 5d spike {contango_ratio:+.1f}%). "
            "Institutional hedging demand is elevated — typically accompanying risk-off macro corrections."
        )
    else:
        parts.append(
            "VIX term structure is flat (neutral roll slope), signaling a transitional volatility regime."
        )

    if vix_percentile > 80:
        parts.append(f"VIX proxy (${vix_proxy:.2f}) sits in the {vix_percentile:.0f}th percentile of its 1-year range (elevated tail-risk pricing).")
    elif vix_percentile < 25:
        parts.append(f"VIX proxy (${vix_proxy:.2f}) is in the {vix_percentile:.0f}th percentile (subdued complacency / low-vol regime).")
    else:
        parts.append(f"VIX proxy (${vix_proxy:.2f}) sits at the {vix_percentile:.0f}th percentile.")

    if vixy_spy_corr is not None:
        if vixy_spy_corr < -0.6:
            parts.append(f"Strong inverse correlation with SPY ({vixy_spy_corr:.2f}) confirms normal risk-asset hedging mechanics.")
        elif vixy_spy_corr > -0.2:
            parts.append(f"Weak SPY inverse correlation ({vixy_spy_corr:.2f}) signals non-linear or decoupling macro dynamics.")

    return " ".join(parts)


def _empty_vix_result(msg: str) -> Dict[str, Any]:
    return {
        "current_state": "Unknown",
        "severity": "mild",
        "state_color": "#8c97b2",
        "vix_proxy": 0.0,
        "vix_percentile": 50.0,
        "contango_ratio": 0.0,
        "vixy_spy_corr": None,
        "as_of_date": "2026-08-18",
        "history": {
            "dates": [],
            "vix_proxy": [],
            "contango_signal": [],
            "spy_close": [],
            "regions": []
        },
        "interpretation": msg
    }

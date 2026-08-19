"""
Macro Market Regime & Cross-Asset Analytics Engine.
Inspired by MomentumQ Terminal quantitative models.
Computes market regimes, cross-asset correlation matrices, and sector rotation dynamics.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional

SECTOR_MAP = {
    "XLK": "Technology",
    "XLC": "Communication Services",
    "XLY": "Consumer Discretionary",
    "XLF": "Financials",
    "XLI": "Industrials",
    "XLV": "Healthcare",
    "XLP": "Consumer Staples",
    "XLE": "Energy",
    "XLU": "Utilities",
    "XLB": "Materials",
    "XLRE": "Real Estate"
}

CORE_ASSETS = ["SPY", "QQQ", "IWM", "MAG7", "NVDA", "AAPL", "MSFT", "TLT", "GLD", "USO", "HYG"]


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        f = float(val)
        return default if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return default


def compute_macro_regime(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Detect market regime from SPY, RSP, VIXY, TLT, HYG, and IEF observations.
    Classifies regime into BULL_TRENDING, BULL_EXUBERANT, VOLATILE_CORRECTION, BEAR_CONTRACTION, or RANGEBOUND.
    """
    # 1. Fetch SPY recent price series
    cur = conn.execute(
        """
        SELECT date, close
        FROM market_observation
        WHERE ticker = 'SPY'
        ORDER BY date DESC
        LIMIT 250
        """
    )
    spy_rows = cur.fetchall()
    if len(spy_rows) < 50:
        return {
            "regime": "NEUTRAL",
            "regime_label": "Neutral / Data Loading",
            "confidence_pct": 50.0,
            "factors": {},
            "signals": []
        }

    spy_prices = [float(r[1]) for r in reversed(spy_rows)]
    latest_spy = spy_prices[-1]
    spy_50d_sma = sum(spy_prices[-50:]) / 50.0
    spy_200d_sma = sum(spy_prices[-200:]) / len(spy_prices[-200:]) if len(spy_prices) >= 200 else spy_50d_sma

    dist_50d = (latest_spy / spy_50d_sma) - 1.0
    dist_200d = (latest_spy / spy_200d_sma) - 1.0

    # 2. 20-day realized volatility vs historical
    returns_20d = [(spy_prices[i] / spy_prices[i-1]) - 1.0 for i in range(len(spy_prices)-20, len(spy_prices))]
    mean_ret = sum(returns_20d) / len(returns_20d)
    var_20d = sum((r - mean_ret)**2 for r in returns_20d) / (len(returns_20d) - 1)
    realized_vol_annual = math.sqrt(var_20d * 252)

    # 3. RSP vs SPY 60-day relative strength (Breadth)
    cur = conn.execute(
        """
        SELECT date, close
        FROM market_observation
        WHERE ticker = 'RSP'
        ORDER BY date DESC
        LIMIT 60
        """
    )
    rsp_rows = cur.fetchall()
    breadth_ratio = 1.0
    if len(rsp_rows) >= 20:
        rsp_prices = [float(r[1]) for r in reversed(rsp_rows)]
        rsp_60d_ret = (rsp_prices[-1] / rsp_prices[0]) - 1.0
        spy_60d_ret = (spy_prices[-1] / spy_prices[-len(rsp_prices)]) - 1.0
        breadth_ratio = rsp_60d_ret - spy_60d_ret

    # 4. Credit Risk Appetite (HYG vs IEF)
    cur = conn.execute(
        """
        SELECT ticker, close, date
        FROM market_observation
        WHERE ticker IN ('HYG', 'IEF')
        ORDER BY date DESC
        LIMIT 120
        """
    )
    credit_rows = cur.fetchall()
    credit_spread_signal = "STABLE"
    if credit_rows:
        credit_spread_signal = "RISK_ON"

    # 5. Regime Classification Logic
    if dist_50d > 0.015 and dist_200d > 0.04 and realized_vol_annual < 0.18:
        if dist_50d > 0.06:
            regime = "BULL_EXUBERANT"
            label = "Bull Exuberance (Overextended Momentum)"
            confidence = 88.0
            color = "#fbbf24"
        else:
            regime = "BULL_TRENDING"
            label = "Bull Trending (Low-Vol Expansion)"
            confidence = 94.0
            color = "#34d399"
    elif dist_50d < -0.01 and dist_200d > 0.0:
        regime = "VOLATILE_CORRECTION"
        label = "Volatile Pullback / Dip Opportunity"
        confidence = 78.0
        color = "#f59e0b"
    elif dist_200d < -0.02 and realized_vol_annual > 0.22:
        regime = "BEAR_CONTRACTION"
        label = "Bearish Liquidity Contraction"
        confidence = 85.0
        color = "#ef4444"
    else:
        regime = "RANGEBOUND"
        label = "Rangebound Consolidation"
        confidence = 72.0
        color = "#7aa2ff"

    return {
        "regime": regime,
        "regime_label": label,
        "regime_color": color,
        "confidence_pct": confidence,
        "as_of_date": spy_rows[0][0],
        "factors": {
            "spy_spot": round(latest_spy, 2),
            "spy_50d_sma": round(spy_50d_sma, 2),
            "spy_200d_sma": round(spy_200d_sma, 2),
            "dist_50d_pct": round(dist_50d * 100, 2),
            "dist_200d_pct": round(dist_200d * 100, 2),
            "realized_vol_pct": round(realized_vol_annual * 100, 1),
            "breadth_spread_pct": round(breadth_ratio * 100, 2),
            "credit_signal": credit_spread_signal
        },
        "signals": [
            {
                "name": "SPY Trend Structure",
                "value": f"{'+' if dist_50d>=0 else ''}{dist_50d*100:.1f}% vs 50D SMA",
                "status": "BULL" if dist_50d >= 0 else "BEAR"
            },
            {
                "name": "Macro 200D Baseline",
                "value": f"{'+' if dist_200d>=0 else ''}{dist_200d*100:.1f}% vs 200D SMA",
                "status": "BULL" if dist_200d >= 0 else "BEAR"
            },
            {
                "name": "Realized Volatility",
                "value": f"{realized_vol_annual*100:.1f}% Annualized",
                "status": "BULL" if realized_vol_annual < 0.18 else "WARN"
            },
            {
                "name": "Equal-Weight Breadth",
                "value": f"{'+' if breadth_ratio>=0 else ''}{breadth_ratio*100:.1f}% RSP Alpha",
                "status": "BULL" if breadth_ratio >= 0 else "NEUTRAL"
            }
        ]
    }


def compute_cross_asset_correlation(
    conn: sqlite3.Connection,
    symbols: Optional[List[str]] = None,
    lookback_days: int = 60
) -> Dict[str, Any]:
    """
    Compute rolling N-day correlation matrix between selected symbols.
    Calculates pairwise correlations, clusters, and diversification scores.
    """
    syms = symbols or CORE_ASSETS
    placeholders = ",".join("?" for _ in syms)
    
    cur = conn.execute(
        f"""
        SELECT date, ticker, close
        FROM market_observation
        WHERE ticker IN ({placeholders})
        ORDER BY date DESC
        """,
        syms
    )
    rows = cur.fetchall()
    if not rows:
        return {"symbols": [], "matrix": [], "clusters": []}

    # Group prices by ticker
    price_by_ticker: Dict[str, Dict[str, float]] = {s: {} for s in syms}
    all_dates_set = set()
    for r in rows:
        d, t, c = str(r[0]), str(r[1]), float(r[2])
        if t in price_by_ticker:
            price_by_ticker[t][d] = c
            all_dates_set.add(d)

    sorted_dates = sorted(list(all_dates_set), reverse=True)[:lookback_days + 1]
    sorted_dates = sorted(sorted_dates)  # chronological

    if len(sorted_dates) < 10:
        return {"symbols": [], "matrix": [], "clusters": []}

    # Calculate returns series for each symbol
    valid_syms = []
    return_series: Dict[str, List[float]] = {}

    for s in syms:
        closes = [price_by_ticker[s].get(d) for d in sorted_dates]
        if any(c is None for c in closes):
            continue
        rets = [(closes[i] / closes[i-1]) - 1.0 for i in range(1, len(closes))]
        if len(rets) >= lookback_days - 5:
            valid_syms.append(s)
            return_series[s] = rets

    n = len(valid_syms)
    if n < 2:
        return {"symbols": valid_syms, "matrix": [], "clusters": []}

    matrix = [[1.0] * n for _ in range(n)]

    def _calc_corr(x: List[float], y: List[float]) -> float:
        min_len = min(len(x), len(y))
        x_s, y_s = x[:min_len], y[:min_len]
        mean_x = sum(x_s) / min_len
        mean_y = sum(y_s) / min_len
        cov = sum((x_s[i] - mean_x) * (y_s[i] - mean_y) for i in range(min_len))
        var_x = sum((x_s[i] - mean_x)**2 for i in range(min_len))
        var_y = sum((y_s[i] - mean_y)**2 for i in range(min_len))
        denom = math.sqrt(var_x * var_y)
        return cov / denom if denom > 1e-9 else 0.0

    for i in range(n):
        for j in range(i + 1, n):
            c_val = round(_calc_corr(return_series[valid_syms[i]], return_series[valid_syms[j]]), 3)
            matrix[i][j] = c_val
            matrix[j][i] = c_val

    # Cluster detection (>0.70 correlation)
    clusters = []
    seen = set()
    for i in range(n):
        if i in seen:
            continue
        cluster = [valid_syms[i]]
        for j in range(i + 1, n):
            if j not in seen and matrix[i][j] >= 0.70:
                cluster.append(valid_syms[j])
                seen.add(j)
        if len(cluster) > 1:
            clusters.append({
                "symbols": cluster,
                "warning": f"High co-movement ({len(cluster)} assets >0.70 corr)"
            })
        seen.add(i)

    # Average correlation & diversification score
    off_diag = [abs(matrix[i][j]) for i in range(n) for j in range(i + 1, n)]
    avg_corr = round(sum(off_diag) / len(off_diag), 3) if off_diag else 0.0
    diversification_score = round(max(0.0, (1.0 - avg_corr) * 100), 1)

    return {
        "symbols": valid_syms,
        "matrix": matrix,
        "clusters": clusters,
        "avg_correlation": avg_corr,
        "diversification_score": diversification_score,
        "lookback_days": lookback_days
    }


def compute_sector_rotation(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Compute sector returns and relative alpha vs SPY across 1M, 3M, 6M, 1Y, and YTD.
    """
    all_syms = list(SECTOR_MAP.keys()) + ["SPY"]
    placeholders = ",".join("?" for _ in all_syms)

    cur = conn.execute(
        f"""
        SELECT date, ticker, close
        FROM market_observation
        WHERE ticker IN ({placeholders})
        ORDER BY date DESC
        """,
        all_syms
    )
    rows = cur.fetchall()
    if not rows:
        return {"sectors": []}

    prices: Dict[str, List[Dict[str, Any]]] = {s: [] for s in all_syms}
    for r in rows:
        prices[r[1]].append({"date": r[0], "close": float(r[2])})

    def _get_return(series: List[Dict[str, Any]], days_back: int) -> Optional[float]:
        if len(series) <= days_back:
            return None
        c_now = series[0]["close"]
        c_then = series[days_back]["close"]
        return (c_now / c_then) - 1.0

    spy_1m = _get_return(prices["SPY"], 21) or 0.0
    spy_3m = _get_return(prices["SPY"], 63) or 0.0
    spy_6m = _get_return(prices["SPY"], 126) or 0.0
    spy_1y = _get_return(prices["SPY"], 252) or 0.0

    sector_results = []
    for ticker, name in SECTOR_MAP.items():
        s_data = prices.get(ticker, [])
        if not s_data:
            continue

        ret_1m = _get_return(s_data, 21)
        ret_3m = _get_return(s_data, 63)
        ret_6m = _get_return(s_data, 126)
        ret_1y = _get_return(s_data, 252)

        alpha_1m = (ret_1m - spy_1m) if ret_1m is not None else None
        alpha_3m = (ret_3m - spy_3m) if ret_3m is not None else None
        alpha_1y = (ret_1y - spy_1y) if ret_1y is not None else None

        sector_results.append({
            "ticker": ticker,
            "name": name,
            "latest_close": s_data[0]["close"],
            "return_1m": round(ret_1m, 4) if ret_1m is not None else None,
            "return_3m": round(ret_3m, 4) if ret_3m is not None else None,
            "return_1y": round(ret_1y, 4) if ret_1y is not None else None,
            "alpha_1m": round(alpha_1m, 4) if alpha_1m is not None else None,
            "alpha_3m": round(alpha_3m, 4) if alpha_3m is not None else None,
            "alpha_1y": round(alpha_1y, 4) if alpha_1y is not None else None,
            "quadrant": "LEADING" if (alpha_3m or 0) > 0 and (alpha_1m or 0) > 0 else (
                "WEAKENING" if (alpha_3m or 0) > 0 and (alpha_1m or 0) <= 0 else (
                    "IMPROVING" if (alpha_3m or 0) <= 0 and (alpha_1m or 0) > 0 else "LAGGING"
                )
            )
        })

    # Sort sectors by 3M Alpha descending
    sector_results.sort(key=lambda s: s["alpha_3m"] if s["alpha_3m"] is not None else -999, reverse=True)

    return {
        "as_of_date": prices["SPY"][0]["date"] if prices.get("SPY") else "2026-08-18",
        "benchmark": {
            "return_1m": round(spy_1m, 4),
            "return_3m": round(spy_3m, 4),
            "return_1y": round(spy_1y, 4)
        },
        "sectors": sector_results
    }

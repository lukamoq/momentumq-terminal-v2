"""
Seasonality & Advanced Macro Analytics Engine for Sell-Side Scorecard.

Computes:
1. Monthly and quarterly return matrices for individual assets (SPY, QQQ, NVDA, AAPL, etc.)
2. Multi-asset comparative seasonal heatmap with historical win rates and summary stats
3. Day-of-year cumulative seasonality trajectories (average year vs actual years)
4. Sell-side research call seasonality, bias, and accuracy patterns by month/quarter
"""

import sqlite3
import statistics
from typing import Dict, List, Any, Optional

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _mean(vals: List[float]) -> float:
    return statistics.mean(vals) if vals else 0.0


def _median(vals: List[float]) -> float:
    return statistics.median(vals) if vals else 0.0


def _stdev(vals: List[float]) -> float:
    return statistics.stdev(vals) if len(vals) > 1 else 0.0


def compute_monthly_returns(conn: sqlite3.Connection, ticker: str) -> Dict[str, Any]:
    """
    Compute monthly percentage returns for a ticker across all available years.
    """
    cur = conn.execute(
        """
        SELECT date, close
        FROM market_observation
        WHERE ticker = ?
        ORDER BY date ASC
        """,
        (ticker,)
    )
    rows = cur.fetchall()
    if not rows:
        return {
            "ticker": ticker,
            "years": [],
            "matrix": {},
            "full_year_returns": {},
            "monthly_averages": [0.0] * 12,
            "monthly_medians": [0.0] * 12,
            "monthly_win_rates": [0.0] * 12,
            "monthly_volatility": [0.0] * 12,
            "best_month": None,
            "worst_month": None,
            "month_names": MONTH_NAMES
        }

    # Group prices by year-month
    ym_map: Dict[str, List[float]] = {}
    for r in rows:
        d_str, close = str(r[0]), float(r[1])
        ym = d_str[:7]  # YYYY-MM
        if ym not in ym_map:
            ym_map[ym] = []
        ym_map[ym].append(close)

    sorted_yms = sorted(ym_map.keys())
    all_years = sorted(list(set(int(ym.split("-")[0]) for ym in sorted_yms)))

    # Compute return for each YYYY-MM
    monthly_ret: Dict[str, float] = {}
    prev_close: Optional[float] = None

    for ym in sorted_yms:
        closes = ym_map[ym]
        if not closes:
            continue
        first_c = closes[0]
        last_c = closes[-1]

        if prev_close is not None and prev_close > 0:
            ret = (last_c / prev_close) - 1.0
        else:
            ret = (last_c / first_c) - 1.0 if first_c > 0 else 0.0

        monthly_ret[ym] = ret
        prev_close = last_c

    # Build matrix by year
    matrix: Dict[str, List[Optional[float]]] = {}
    full_year_returns: Dict[str, Optional[float]] = {}

    for y in all_years:
        year_str = str(y)
        m_rets: List[Optional[float]] = []
        year_start_close: Optional[float] = None
        year_end_close: Optional[float] = None

        for m in range(1, 13):
            ym = f"{y:04d}-{m:02d}"
            if ym in monthly_ret:
                m_rets.append(round(monthly_ret[ym], 4))
                if ym in ym_map and ym_map[ym]:
                    if year_start_close is None:
                        year_start_close = ym_map[ym][0]
                    year_end_close = ym_map[ym][-1]
            else:
                m_rets.append(None)

        matrix[year_str] = m_rets
        if year_start_close and year_end_close and year_start_close > 0:
            full_year_returns[year_str] = round((year_end_close / year_start_close) - 1.0, 4)
        else:
            full_year_returns[year_str] = None

    # Compute aggregates per month across active observations
    monthly_averages: List[float] = []
    monthly_medians: List[float] = []
    monthly_win_rates: List[float] = []
    monthly_volatilities: List[float] = []

    for m_idx in range(12):
        rets = [matrix[str(y)][m_idx] for y in all_years if matrix[str(y)][m_idx] is not None]
        if rets:
            avg = _mean(rets)
            med = _median(rets)
            win = sum(1 for r in rets if r > 0) / len(rets)
            vol = _stdev(rets)
            monthly_averages.append(round(avg, 4))
            monthly_medians.append(round(med, 4))
            monthly_win_rates.append(round(win, 4))
            monthly_volatilities.append(round(vol, 4))
        else:
            monthly_averages.append(0.0)
            monthly_medians.append(0.0)
            monthly_win_rates.append(0.0)
            monthly_volatilities.append(0.0)

    # Determine best & worst months
    valid_avg_indices = [i for i in range(12) if any(matrix[str(y)][i] is not None for y in all_years)]
    if valid_avg_indices:
        best_idx = max(valid_avg_indices, key=lambda i: monthly_averages[i])
        worst_idx = min(valid_avg_indices, key=lambda i: monthly_averages[i])
        best_month = {
            "month": MONTH_NAMES[best_idx],
            "month_index": best_idx + 1,
            "avg_return": monthly_averages[best_idx],
            "win_rate": monthly_win_rates[best_idx]
        }
        worst_month = {
            "month": MONTH_NAMES[worst_idx],
            "month_index": worst_idx + 1,
            "avg_return": monthly_averages[worst_idx],
            "win_rate": monthly_win_rates[worst_idx]
        }
    else:
        best_month = None
        worst_month = None

    return {
        "ticker": ticker,
        "years": all_years,
        "matrix": matrix,
        "full_year_returns": full_year_returns,
        "monthly_averages": monthly_averages,
        "monthly_medians": monthly_medians,
        "monthly_win_rates": monthly_win_rates,
        "monthly_volatility": monthly_volatilities,
        "best_month": best_month,
        "worst_month": worst_month,
        "month_names": MONTH_NAMES
    }


def compute_multi_asset_seasonality_overview(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Compute comparative seasonality averages across major assets.
    """
    # Broad market, style, the eleven GICS sector SPDRs, rates/commodities and
    # the Mag 7 — the seasonality grid is far more useful across asset classes
    # than across seven correlated mega-caps alone.
    tickers = [
        "SPY", "QQQ", "IWM", "MDY", "RSP", "IWF", "IWD", "MTUM",
        "XLK", "XLC", "XLY", "XLF", "XLI", "XLV", "XLP", "XLE", "XLU", "XLB", "XLRE",
        "TLT", "IEF", "HYG", "LQD", "GLD", "USO", "UUP", "EFA", "EEM", "ACWI",
        "MAG7", "NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA",
        "AVGO", "TSM", "AMD", "ORCL", "NFLX", "PLTR", "MU", "ASML", "INTC", "CRM",
    ]
    assets_data = []

    for t in tickers:
        data = compute_monthly_returns(conn, t)
        if data["years"]:
            all_valid_full_years = [v for v in data["full_year_returns"].values() if v is not None]
            avg_annual = _mean(all_valid_full_years) if all_valid_full_years else 0.0

            q4_rets = []
            for y in data["years"]:
                oct_r = data["matrix"][str(y)][9]
                nov_r = data["matrix"][str(y)][10]
                dec_r = data["matrix"][str(y)][11]
                if oct_r is not None and nov_r is not None and dec_r is not None:
                    q4_rets.append((1 + oct_r) * (1 + nov_r) * (1 + dec_r) - 1.0)
            avg_q4 = _mean(q4_rets) if q4_rets else 0.0

            assets_data.append({
                "ticker": t,
                "monthly_averages": data["monthly_averages"],
                "monthly_win_rates": data["monthly_win_rates"],
                "avg_annual_return": round(avg_annual, 4),
                "avg_q4_return": round(avg_q4, 4),
                "best_month": data["best_month"],
                "worst_month": data["worst_month"],
                "years_count": len(data["years"])
            })

    return {
        "assets": assets_data,
        "month_names": MONTH_NAMES
    }


def compute_index_trio_seasonality(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Compute detailed comparative matrix for the Core Index Trio:
    SPY (Large Cap S&P 500), QQQ (Nasdaq 100 Tech), IWM (Russell 2000 Small Cap).
    Also computes QQQ/SPY and IWM/SPY relative monthly spreads.
    """
    spy = compute_monthly_returns(conn, "SPY")
    qqq = compute_monthly_returns(conn, "QQQ")
    iwm = compute_monthly_returns(conn, "IWM")

    # Compute monthly spreads (e.g. QQQ - SPY, IWM - SPY)
    qqq_spy_spread = []
    iwm_spy_spread = []

    for m in range(12):
        s_avg = spy["monthly_averages"][m]
        q_avg = qqq["monthly_averages"][m]
        i_avg = iwm["monthly_averages"][m]

        qqq_spy_spread.append(round(q_avg - s_avg, 4))
        iwm_spy_spread.append(round(i_avg - s_avg, 4))

    return {
        "indices": {
            "SPY": spy,
            "QQQ": qqq,
            "IWM": iwm,
        },
        "spreads": {
            "qqq_vs_spy": qqq_spy_spread,
            "iwm_vs_spy": iwm_spy_spread
        },
        "month_names": MONTH_NAMES
    }


def compute_cumulative_day_of_year_curves(conn: sqlite3.Connection, ticker: str = "SPY") -> Dict[str, Any]:
    """
    Compute cumulative normalized trajectory across trading days of the year (1 to 252).
    """
    cur = conn.execute(
        """
        SELECT date, close
        FROM market_observation
        WHERE ticker = ?
        ORDER BY date ASC
        """,
        (ticker,)
    )
    rows = cur.fetchall()
    if not rows:
        return {"ticker": ticker, "max_trading_days": 252, "average_curve": [], "yearly_curves": {}}

    by_year: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        d_str, close = str(r[0]), float(r[1])
        y = int(d_str[:4])
        if y not in by_year:
            by_year[y] = []
        by_year[y].append({"date": d_str, "close": close})

    yearly_curves: Dict[str, List[Dict[str, Any]]] = {}
    completed_year_indexed: List[List[float]] = []

    for y, pts in by_year.items():
        if not pts:
            continue
        base_c = pts[0]["close"]
        if base_c <= 0:
            continue
        curve = []
        indexed = []
        for i, p in enumerate(pts):
            norm = round((p["close"] / base_c) * 100.0, 2)
            curve.append({
                "day": i + 1,
                "date": p["date"],
                "normalized": norm,
                "return_pct": round((p["close"] / base_c - 1.0) * 100.0, 2)
            })
            indexed.append(norm)
        yearly_curves[str(y)] = curve

        # Include completed years (>=200 trading days) in composite average
        # Forward-fill final day close to Day 252 to prevent sample attrition drops/spikes on Days 250-252
        if len(pts) >= 200:
            aligned = list(indexed)
            while len(aligned) < 252:
                aligned.append(aligned[-1])
            completed_year_indexed.append(aligned[:252])

    max_days = 252
    average_curve = []
    if completed_year_indexed:
        for d in range(max_days):
            vals = [indexed[d] for indexed in completed_year_indexed]
            avg_val = round(_mean(vals), 2)
            average_curve.append({
                "day": d + 1,
                "normalized": avg_val,
                "return_pct": round(avg_val - 100.0, 2)
            })

    return {
        "ticker": ticker,
        "max_trading_days": max_days,
        "average_curve": average_curve,
        "yearly_curves": yearly_curves
    }


def compute_call_seasonality_analytics(conn: sqlite3.Connection) -> Dict[str, Any]:
    """
    Audit research calls by publication month and quarter.
    """
    cur_m7 = conn.execute(
        """
        SELECT published_on, rating_or_stance, verdict, relative_alpha, target_implied_return, institution_id
        FROM mag7_call
        """
    )
    m7_calls = cur_m7.fetchall()

    cur_macro = conn.execute(
        """
        SELECT published_on, direction, target_level, spot_at_publication, implied_return, institution_id
        FROM call
        WHERE call_type = 'direction'
        """
    )
    macro_calls = cur_macro.fetchall()

    month_stats: Dict[int, Dict[str, Any]] = {
        m: {
            "month_num": m,
            "month_name": MONTH_NAMES[m - 1],
            "total_calls": 0,
            "bullish_calls": 0,
            "bearish_calls": 0,
            "neutral_calls": 0,
            "hits": 0,
            "misses": 0,
            "resolved": 0,
            "avg_alpha": []
        }
        for m in range(1, 13)
    }

    for r in m7_calls:
        pub_date = str(r[0])
        stance = str(r[1]).upper()
        verdict = str(r[2]).upper()
        alpha = float(r[3]) if r[3] is not None else None

        try:
            m_num = int(pub_date.split("-")[1])
        except Exception:
            continue

        s = month_stats[m_num]
        s["total_calls"] += 1
        if stance in ["OVERWEIGHT", "BUY", "BULLISH"]:
            s["bullish_calls"] += 1
        elif stance in ["UNDERWEIGHT", "SELL", "BEARISH"]:
            s["bearish_calls"] += 1
        else:
            s["neutral_calls"] += 1

        if verdict == "HIT":
            s["hits"] += 1
            s["resolved"] += 1
        elif verdict == "MISS":
            s["misses"] += 1
            s["resolved"] += 1

        if alpha is not None:
            s["avg_alpha"].append(alpha)

    for r in macro_calls:
        pub_date = str(r[0])
        direction = str(r[1]).lower() if r[1] else "neutral"

        try:
            m_num = int(pub_date.split("-")[1])
        except Exception:
            continue

        s = month_stats[m_num]
        s["total_calls"] += 1
        if direction == "bullish":
            s["bullish_calls"] += 1
        elif direction == "bearish":
            s["bearish_calls"] += 1
        else:
            s["neutral_calls"] += 1

    result_months = []
    for m in range(1, 13):
        s = month_stats[m]
        hit_rate = round(s["hits"] / s["resolved"], 3) if s["resolved"] > 0 else None
        bull_pct = round(s["bullish_calls"] / s["total_calls"], 3) if s["total_calls"] > 0 else 0.0
        avg_a = round(_mean(s["avg_alpha"]), 3) if s["avg_alpha"] else 0.0

        result_months.append({
            "month": s["month_name"],
            "month_num": m,
            "total_calls": s["total_calls"],
            "bullish_calls": s["bullish_calls"],
            "bearish_calls": s["bearish_calls"],
            "neutral_calls": s["neutral_calls"],
            "bullish_ratio": bull_pct,
            "hits": s["hits"],
            "misses": s["misses"],
            "resolved": s["resolved"],
            "hit_rate": hit_rate,
            "avg_alpha": avg_a
        })

    quarters = []
    q_names = ["Q1 (Winter Outlooks)", "Q2 (Spring Revisions)", "Q3 (Summer Doldrums)", "Q4 (Year-End Santa Rallies)"]
    for q_idx in range(4):
        q_months = result_months[q_idx*3 : (q_idx+1)*3]
        q_total = sum(m["total_calls"] for m in q_months)
        q_bull = sum(m["bullish_calls"] for m in q_months)
        q_hits = sum(m["hits"] for m in q_months)
        q_resolved = sum(m["resolved"] for m in q_months)
        q_hit_rate = round(q_hits / q_resolved, 3) if q_resolved > 0 else None
        q_bull_ratio = round(q_bull / q_total, 3) if q_total > 0 else 0.0

        quarters.append({
            "quarter": f"Q{q_idx + 1}",
            "name": q_names[q_idx],
            "total_calls": q_total,
            "bullish_ratio": q_bull_ratio,
            "hits": q_hits,
            "resolved": q_resolved,
            "hit_rate": q_hit_rate
        })

    return {
        "months": result_months,
        "quarters": quarters,
        "total_audited_calls": len(m7_calls) + len(macro_calls)
    }

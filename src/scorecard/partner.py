"""Institutional Partner Reliability & Trust Matrix Engine.

Calculates multi-dimensional reliability indices (0–100) evaluating:
1. Directional discriminant edge (over always-bullish baseline)
2. Target precision & realization calibration (MAPE)
3. Pivot agility & lag ratio (timely revisions vs. chasing trends)
4. Macro cycle resilience (2022 bear market vs. 2023-2026 bull run)
5. Anti-failure penalty for uninformative permabulls
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional


def compute_partner_reliability(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Compute comprehensive partner reliability profiles and rankings for all 10 institutions."""
    cur_inst = conn.execute("SELECT id, name, full_name, notes FROM institution ORDER BY name ASC")
    institutions = [dict(r) for r in cur_inst.fetchall()]

    partners = []

    # S&P 500 Year-End Closing Realizations
    ye_realizations = {
        "YE_2022": 3839.5,
        "YE_2023": 4769.8,
        "YE_2024": 5881.6,
        "YE_2025": 6845.2,
    }

    excluded: List[Dict[str, Any]] = []

    for inst in institutions:
        inst_id = inst["id"]

        # 1. Bank Scorecard Row
        cur_sb = conn.execute("SELECT * FROM score_bank WHERE institution_id = ?", (inst_id,))
        sb = cur_sb.fetchone()
        if not sb:
            continue
        sb = dict(sb)

        total_calls = sb["total_calls"]

        # A house with no direction record has nothing for this index to measure.
        # The composite defaults each missing component to a neutral value, so
        # including them let a probability-only house outrank every desk that
        # actually published targets and got them wrong.
        if not total_calls:
            excluded.append({
                "institution_id": inst_id,
                "institution_name": inst["name"],
                "institution_full_name": inst["full_name"],
                "reason": "no direction calls on record",
            })
            continue
        n_bullish = sb["n_bullish"]
        n_bearish = sb["n_bearish"]
        n_neutral = sb["n_neutral"]
        is_always_bullish = sb["is_always_bullish"]
        stance_edge = sb["stance_day_edge"] if sb["stance_day_edge"] is not None else 0.0
        hit_rate = sb["stance_day_hit_rate"] if sb["stance_day_hit_rate"] is not None else 0.0
        ab_baseline = sb["always_bullish_stance_day_hit_rate"] if sb["always_bullish_stance_day_hit_rate"] is not None else 0.0
        avg_lag = sb["avg_lag_ratio"]

        # 2. Target Calibration & MAPE (Mean Absolute Percentage Error)
        cur_targets = conn.execute(
            """
            SELECT target_level, forecast_horizon, published_on, direction
            FROM call
            WHERE institution_id = ? AND call_type = 'direction' AND target_level IS NOT NULL
            ORDER BY published_on ASC
            """,
            (inst_id,),
        )
        t_rows = cur_targets.fetchall()
        mapes = []
        for tr in t_rows:
            hz = tr["forecast_horizon"]
            realized = ye_realizations.get(hz)
            if realized and tr["target_level"]:
                err = abs(tr["target_level"] - realized) / realized
                mapes.append(err)

        # None means "no realized year-end to compare against" — do not let a
        # placeholder masquerade as a measured error.
        avg_mape = (sum(mapes) / len(mapes)) if mapes else None
        mape_measured = avg_mape is not None
        mape_n = len(mapes)
        avg_mape_display = avg_mape if mape_measured else 0.12

        # 3. Regime Specific Performance: 2022 Bear Market (Defensive Risk) vs 2023-2026 Bull Market
        # 2022 Bear: Evaluated calls with published_on in 2021/2022 for YE_2022
        cur_bear = conn.execute(
            """
            SELECT
                sum(case when verdict = 'hit' then 1 else 0 end) as hits,
                sum(is_resolved) as resolved,
                sum(case when is_resolved = 1 and always_bullish_verdict = 'hit' then 1 else 0 end) as ab_hits
            FROM score_direction
            WHERE institution_id = ? AND window_start_date >= '2021-11-01' AND window_start_date <= '2022-12-31'
            """,
            (inst_id,),
        )
        bear_row = cur_bear.fetchone()
        bear_resolved = bear_row["resolved"] or 0
        bear_hits = bear_row["hits"] or 0
        bear_ab_hits = bear_row["ab_hits"] or 0
        bear_hit_rate = (bear_hits / bear_resolved) if bear_resolved > 0 else 0.0
        bear_ab_rate = (bear_ab_hits / bear_resolved) if bear_resolved > 0 else 0.0
        bear_edge = (bear_hit_rate - bear_ab_rate) if bear_resolved > 0 else 0.0

        # 2023-2026 Bull: Evaluated calls in 2023-2026
        cur_bull = conn.execute(
            """
            SELECT
                sum(case when verdict = 'hit' then 1 else 0 end) as hits,
                sum(is_resolved) as resolved,
                sum(case when is_resolved = 1 and always_bullish_verdict = 'hit' then 1 else 0 end) as ab_hits
            FROM score_direction
            WHERE institution_id = ? AND window_start_date >= '2023-01-01'
            """,
            (inst_id,),
        )
        bull_row = cur_bull.fetchone()
        bull_resolved = bull_row["resolved"] or 0
        bull_hits = bull_row["hits"] or 0
        bull_ab_hits = bull_row["ab_hits"] or 0
        bull_hit_rate = (bull_hits / bull_resolved) if bull_resolved > 0 else 0.0
        bull_ab_rate = (bull_ab_hits / bull_resolved) if bull_resolved > 0 else 0.0
        bull_edge = (bull_hit_rate - bull_ab_rate) if bull_resolved > 0 else 0.0

        # 4. Agility Rating
        if avg_lag is None:
            agility_label = "Neutral (No Flips)"
            agility_score = 70.0
        elif avg_lag <= 0.5:
            agility_label = "Leader / Highly Agile"
            agility_score = 95.0
        elif avg_lag <= 1.2:
            agility_label = "Balanced / Moderate"
            agility_score = 80.0
        elif avg_lag <= 2.5:
            agility_label = "Follower / Lags Trends"
            agility_score = 55.0
        else:
            agility_label = "Late Capitulator"
            agility_score = 35.0

        # 5. Composite Reliability Index Calculation (0 to 100)
        # Components:
        # - Base: 50.0
        # - Stance Edge contribution: + 120.0 * stance_edge (typically ranges from -0.20 to +0.05)
        # - Target Error Penalty: - 50.0 * avg_mape (avg MAPE 0.08 -> -4 pts, 0.16 -> -8 pts)
        # - Agility contribution: (agility_score - 50.0) * 0.25
        # - Bear Market Defense: + 40.0 * bear_edge
        # - Discriminant Call Bonus vs Permabull Penalty: -15.0 if always-bullish with 0 discriminating signal
        raw_score = (
            55.0
            + (stance_edge * 90.0)
            - (avg_mape_display * 45.0)
            + ((agility_score - 50.0) * 0.25)
            + (bear_edge * 35.0)
        )

        if is_always_bullish:
            raw_score -= 12.0  # Permabull discount: no discriminating downside signal
            tier = "Tier 4: Permabull Free-Rider"
        elif raw_score >= 60.0:
            tier = "Tier 1: High Conviction Leader"
        elif raw_score >= 48.0:
            tier = "Tier 2: Tactical Forecaster"
        elif raw_score >= 38.0:
            tier = "Tier 3: Consensus Follower"
        else:
            tier = "Tier 5: Lagging Indicator"

        reliability_score = round(max(15.0, min(96.0, raw_score)), 1)

        # 6. Qualitative Strengths & Risk Warnings
        strengths = []
        risks = []

        # One realized year-end is an anecdote, not precision.
        if mape_measured and mape_n >= 2 and avg_mape < 0.11:
            strengths.append(f"High Target Precision ({avg_mape*100:.1f}% avg error, n={mape_n})")
        if avg_lag and avg_lag < 1.0:
            strengths.append(f"Proactive Pivot Agility (Lag ratio: {avg_lag:.2f})")
        # Only claim bear-market defence when 2022 windows were actually evaluated.
        if bear_resolved > 0 and bear_edge > -0.05:
            strengths.append("Disciplined Bear Market Risk Defense (2022)")
        if n_bearish > 0:
            strengths.append(f"Demonstrated Downside Conviction ({n_bearish} bearish calls)")
        if not strengths:
            strengths.append("Consistent Market Participation")

        if is_always_bullish:
            risks.append("Always-Bullish Bias: Zero discriminating downside protection")
        if avg_lag and avg_lag > 2.5:
            risks.append(f"Late Trend Revisions (High lag ratio: {avg_lag:.2f})")
        if mape_measured and mape_n >= 2 and avg_mape > 0.14:
            risks.append(f"Higher Target Deviation ({avg_mape*100:.1f}% MAPE, n={mape_n})")
        if mape_n == 1:
            risks.append("Target error measured on a single resolved year-end")
        elif mape_n == 0:
            risks.append("No resolved year-end target to measure error against")
        if stance_edge < -0.15:
            risks.append("Counter-trend stance caused substantial drag during bull moves")
        if not risks:
            risks.append("Minor tracking error on mid-year revisions")

        partners.append({
            "institution_id": inst_id,
            "institution_name": inst["name"],
            "institution_full_name": inst["full_name"],
            "reliability_score": reliability_score,
            "tier": tier,
            "total_calls": total_calls,
            "n_bullish": n_bullish,
            "n_bearish": n_bearish,
            "n_neutral": n_neutral,
            "is_always_bullish": is_always_bullish,
            "stance_day_edge": stance_edge,
            "stance_day_hit_rate": hit_rate,
            "always_bullish_baseline": ab_baseline,
            "target_mape": avg_mape,
            "target_mape_measured": 1 if mape_measured else 0,
            "target_mape_n": mape_n,
            "bear_market_resolved": bear_resolved,
            "bull_market_resolved": bull_resolved,
            "avg_lag_ratio": avg_lag,
            "agility_label": agility_label,
            "bear_market_edge": bear_edge,
            "bear_market_hit_rate": bear_hit_rate,
            "bull_market_edge": bull_edge,
            "bull_market_hit_rate": bull_hit_rate,
            "strengths": strengths,
            "risks": risks,
        })

    # Sort and rank partners
    partners.sort(key=lambda p: (-p["reliability_score"], p["institution_name"]))
    for rank, p in enumerate(partners, 1):
        p["rank"] = rank
        p["ranked_out_of"] = len(partners)
        p["excluded_houses"] = excluded

    return partners

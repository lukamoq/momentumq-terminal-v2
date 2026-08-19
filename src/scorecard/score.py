"""Scoring engine: direction, multi-horizon, stance-days, allocation, probability, and lag."""

from __future__ import annotations

import logging
import sqlite3
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from scorecard.config import (
    AS_OF_DATE,
    CLIMATOLOGY_RECESSION_PRIOR,
    DIRECTION_BAND,
    HORIZONS,
)
from scorecard.db import reset_score_tables
from scorecard.derive import (
    classify_realised_direction,
    compute_horizon_end_date,
    derive_allocation_verdict,
    derive_brier_score,
    derive_direction_verdict,
    derive_lag_ratio,
    make_score_allocation_id,
    make_score_direction_id,
    make_score_lag_id,
    make_score_probability_id,
)
from scorecard.market import get_all_trading_dates, get_price_at_date

logger = logging.getLogger(__name__)


def score_direction_events(conn: sqlite3.Connection, as_of_date: str = AS_OF_DATE) -> int:
    """Score direction calls at event publication dates across all horizons."""
    cur = conn.execute(
        """
        SELECT id, institution_id, published_on, target_level, spot_at_publication, direction, forecast_horizon
        FROM call
        WHERE call_type = 'direction'
        ORDER BY published_on ASC
        """
    )
    calls = cur.fetchall()
    inserted = 0

    for c in calls:
        call_id = c["id"]
        inst_id = c["institution_id"]
        pub_on = c["published_on"]
        forecast_dir = c["direction"]
        forecast_hz = c["forecast_horizon"]
        start_price = float(c["spot_at_publication"])

        for horizon in HORIZONS:
            end_date_target = compute_horizon_end_date(pub_on, horizon, forecast_hz)
            score_id = make_score_direction_id(call_id, "event", horizon, as_of_date)

            end_price = None
            realised_ret = None
            realised_dir = None
            verdict = "too_early"
            always_bullish_verdict = "too_early"
            is_resolved = 0

            # Only resolve if the horizon window has fully elapsed relative to as_of_date
            if end_date_target <= as_of_date:
                end_price = get_price_at_date(conn, "SPX", end_date_target)
                if end_price is not None and start_price > 0:
                    realised_ret = (end_price / start_price) - 1.0
                    realised_dir = classify_realised_direction(realised_ret, DIRECTION_BAND)
                    verdict = derive_direction_verdict(forecast_dir, realised_dir)
                    always_bullish_verdict = derive_direction_verdict("bullish", realised_dir)
                    is_resolved = 1

            conn.execute(
                """
                INSERT INTO score_direction (
                    id, call_id, institution_id, evaluation_kind, as_of_date,
                    horizon, window_start_date, window_end_date, start_price,
                    end_price, realised_return, forecast_direction, realised_direction,
                    verdict, is_resolved, always_bullish_verdict
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    end_price = excluded.end_price,
                    realised_return = excluded.realised_return,
                    realised_direction = excluded.realised_direction,
                    verdict = excluded.verdict,
                    is_resolved = excluded.is_resolved,
                    always_bullish_verdict = excluded.always_bullish_verdict
                """,
                (
                    score_id,
                    call_id,
                    inst_id,
                    "event",
                    as_of_date,
                    horizon,
                    pub_on,
                    end_date_target,
                    start_price,
                    end_price,
                    realised_ret,
                    forecast_dir,
                    realised_dir,
                    verdict,
                    is_resolved,
                    always_bullish_verdict,
                ),
            )
            inserted += 1

    return inserted


def score_direction_stance_days(conn: sqlite3.Connection, as_of_date: str = AS_OF_DATE) -> int:
    """Score standing direction calls on every active trading day across history."""
    # Find earliest call date
    cur_min = conn.execute("SELECT MIN(published_on) as min_pub FROM call WHERE call_type = 'direction'")
    min_row = cur_min.fetchone()
    min_date = min_row["min_pub"] if min_row and min_row["min_pub"] else "2023-11-01"

    all_dates = get_all_trading_dates(conn, "SPY")
    active_dates = [d for d in all_dates if d >= min_date and d <= as_of_date]

    cur_inst = conn.execute("SELECT id FROM institution ORDER BY id ASC")
    institutions = [r["id"] for r in cur_inst.fetchall()]

    inserted = 0
    for day in active_dates:
        day_spot = get_price_at_date(conn, "SPX", day)
        if day_spot is None:
            continue

        for inst_id in institutions:
            cur_call = conn.execute(
                """
                SELECT id, direction, forecast_horizon FROM call
                WHERE institution_id = ? AND call_type = 'direction' AND published_on <= ?
                ORDER BY published_on DESC, created_at DESC, id DESC LIMIT 1
                """,
                (inst_id, day),
            )
            active_call = cur_call.fetchone()
            if not active_call:
                continue

            call_id = active_call["id"]
            forecast_dir = active_call["direction"]
            forecast_hz = active_call["forecast_horizon"]

            for horizon in HORIZONS:
                end_date_target = compute_horizon_end_date(day, horizon, forecast_hz)
                score_id = make_score_direction_id(f"{call_id}_{day}", "stance_day", horizon, as_of_date)

                end_price = None
                realised_ret = None
                realised_dir = None
                verdict = "too_early"
                always_bullish_verdict = "too_early"
                is_resolved = 0

                if end_date_target <= as_of_date:
                    end_price = get_price_at_date(conn, "SPX", end_date_target)
                    if end_price is not None and day_spot > 0:
                        realised_ret = (end_price / day_spot) - 1.0
                        realised_dir = classify_realised_direction(realised_ret, DIRECTION_BAND)
                        verdict = derive_direction_verdict(forecast_dir, realised_dir)
                        always_bullish_verdict = derive_direction_verdict("bullish", realised_dir)
                        is_resolved = 1

                conn.execute(
                    """
                    INSERT INTO score_direction (
                        id, call_id, institution_id, evaluation_kind, as_of_date,
                        horizon, window_start_date, window_end_date, start_price,
                        end_price, realised_return, forecast_direction, realised_direction,
                        verdict, is_resolved, always_bullish_verdict
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        end_price = excluded.end_price,
                        realised_return = excluded.realised_return,
                        realised_direction = excluded.realised_direction,
                        verdict = excluded.verdict,
                        is_resolved = excluded.is_resolved,
                        always_bullish_verdict = excluded.always_bullish_verdict
                    """,
                    (
                        score_id,
                        call_id,
                        inst_id,
                        "stance_day",
                        as_of_date,
                        horizon,
                        day,
                        end_date_target,
                        day_spot,
                        end_price,
                        realised_ret,
                        forecast_dir,
                        realised_dir,
                        verdict,
                        is_resolved,
                        always_bullish_verdict,
                    ),
                )
                inserted += 1

    return inserted


def score_allocations(conn: sqlite3.Connection, as_of_date: str = AS_OF_DATE) -> int:
    """Score allocation calls against benchmark return (spread = SPY - ACWI)."""
    cur = conn.execute(
        """
        SELECT id, institution_id, published_on, allocation_stance, allocation_asset, allocation_benchmark, forecast_horizon
        FROM call
        WHERE call_type = 'allocation'
        ORDER BY published_on ASC
        """
    )
    calls = cur.fetchall()
    inserted = 0

    for c in calls:
        call_id = c["id"]
        inst_id = c["institution_id"]
        pub_on = c["published_on"]
        stance = c["allocation_stance"]
        asset_ticker = c["allocation_asset"] or "SPX"
        bench_ticker = c["allocation_benchmark"] or "ACWI"
        forecast_hz = c["forecast_horizon"]

        actual_asset = "SPY" if asset_ticker in ("SPX", "SPY") else asset_ticker
        actual_bench = bench_ticker

        start_asset = get_price_at_date(conn, actual_asset, pub_on)
        start_bench = get_price_at_date(conn, actual_bench, pub_on)

        if start_asset is None or start_bench is None:
            continue

        for horizon in HORIZONS:
            end_date_target = compute_horizon_end_date(pub_on, horizon, forecast_hz)
            score_id = make_score_allocation_id(call_id, "event", horizon, as_of_date)

            end_asset = None
            end_bench = None
            asset_ret = None
            bench_ret = None
            spread_ret = None
            verdict = "too_early"
            is_resolved = 0

            if end_date_target <= as_of_date:
                end_asset = get_price_at_date(conn, actual_asset, end_date_target)
                end_bench = get_price_at_date(conn, actual_bench, end_date_target)

                if end_asset is not None and end_bench is not None:
                    asset_ret = (end_asset / start_asset) - 1.0
                    bench_ret = (end_bench / start_bench) - 1.0
                    spread_ret = asset_ret - bench_ret
                    verdict = derive_allocation_verdict(stance, spread_ret, DIRECTION_BAND)
                    is_resolved = 1

            conn.execute(
                """
                INSERT INTO score_allocation (
                    id, call_id, institution_id, evaluation_kind, as_of_date,
                    horizon, window_start_date, window_end_date, asset_start_price,
                    asset_end_price, asset_return, bench_start_price, bench_end_price,
                    bench_return, spread_return, stance, verdict, is_resolved
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    asset_end_price = excluded.asset_end_price,
                    asset_return = excluded.asset_return,
                    bench_end_price = excluded.bench_end_price,
                    bench_return = excluded.bench_return,
                    spread_return = excluded.spread_return,
                    verdict = excluded.verdict,
                    is_resolved = excluded.is_resolved
                """,
                (
                    score_id,
                    call_id,
                    inst_id,
                    "event",
                    as_of_date,
                    horizon,
                    pub_on,
                    end_date_target,
                    start_asset,
                    end_asset,
                    asset_ret,
                    start_bench,
                    end_bench,
                    bench_ret,
                    spread_ret,
                    stance,
                    verdict,
                    is_resolved,
                ),
            )
            inserted += 1

    return inserted


def score_probabilities(conn: sqlite3.Connection, as_of_date: str = AS_OF_DATE) -> int:
    """Score probabilistic forecasts (e.g. recession) using Brier skill scores."""
    cur = conn.execute(
        """
        SELECT c.id, c.institution_id, c.probability_event, c.probability_value,
               e.resolved, e.outcome, e.climatology_prior
        FROM call c
        LEFT JOIN event_outcome e ON c.probability_event = e.event_key
        WHERE c.call_type = 'probability'
        """
    )
    calls = cur.fetchall()
    inserted = 0

    for c in calls:
        call_id = c["id"]
        inst_id = c["institution_id"]
        event_key = c["probability_event"]
        if c["probability_value"] is None or not event_key:
            logger.warning(
                "Skipping probability call %s: missing probability_value or event key.", call_id
            )
            continue
        prob_val = float(c["probability_value"])
        resolved = int(c["resolved"] or 0)
        outcome = float(c["outcome"]) if c["outcome"] is not None else None

        # Each event carries its own base rate; falling back to the recession
        # prior for, say, a Fed-cut call would score it against the wrong bar.
        prior = (
            float(c["climatology_prior"])
            if c["climatology_prior"] is not None
            else CLIMATOLOGY_RECESSION_PRIOR
        )
        score_id = make_score_probability_id(call_id, event_key, as_of_date)
        brier, brier_clim, bss, verdict = derive_brier_score(
            prob_val, outcome if resolved else None, prior
        )

        conn.execute(
            """
            INSERT INTO score_probability (
                id, call_id, institution_id, event_key, as_of_date,
                probability_value, climatology_prior, is_resolved, actual_outcome,
                brier_score, brier_climatology, brier_skill_score, verdict
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                is_resolved = excluded.is_resolved,
                actual_outcome = excluded.actual_outcome,
                brier_score = excluded.brier_score,
                brier_climatology = excluded.brier_climatology,
                brier_skill_score = excluded.brier_skill_score,
                verdict = excluded.verdict
            """,
            (
                score_id,
                call_id,
                inst_id,
                event_key,
                as_of_date,
                prob_val,
                prior,
                resolved,
                outcome if resolved else None,
                brier,
                brier_clim,
                bss,
                verdict,
            ),
        )
        inserted += 1

    return inserted


def score_lag_ratios(conn: sqlite3.Connection, as_of_date: str = AS_OF_DATE) -> int:
    """Score direction flips for responsiveness vs lagging market moves."""
    cur_inst = conn.execute("SELECT id FROM institution ORDER BY id ASC")
    institutions = [r["id"] for r in cur_inst.fetchall()]
    inserted = 0

    for inst_id in institutions:
        cur_calls = conn.execute(
            """
            SELECT id, published_on, direction, spot_at_publication
            FROM call
            WHERE institution_id = ? AND call_type = 'direction'
            ORDER BY published_on ASC, id ASC
            """,
            (inst_id,),
        )
        calls = cur_calls.fetchall()
        for i in range(1, len(calls)):
            prev_call = calls[i - 1]
            curr_call = calls[i]

            # Only evaluate actual direction flips (not same-stance raises)
            if curr_call["direction"] != prev_call["direction"]:
                flip_date = curr_call["published_on"]
                spot_flip = float(curr_call["spot_at_publication"])

                # 30d before
                date_30d_before = (date.fromisoformat(flip_date) - timedelta(days=30)).isoformat()
                spot_before = get_price_at_date(conn, "SPX", date_30d_before)
                if spot_before is None or spot_before <= 0:
                    continue
                move_before = (spot_flip / spot_before) - 1.0

                # 30d after
                date_30d_after = (date.fromisoformat(flip_date) + timedelta(days=30)).isoformat()
                spot_after = None
                move_after = None
                lag_ratio = None
                status = "too_early"
                is_resolved = 0

                if date_30d_after <= as_of_date:
                    spot_after = get_price_at_date(conn, "SPX", date_30d_after)
                    if spot_after is not None:
                        move_after = (spot_after / spot_flip) - 1.0
                        lag_ratio, status = derive_lag_ratio(move_before, move_after)
                        is_resolved = 1 if status == "resolved" else 0

                score_id = make_score_lag_id(curr_call["id"], prev_call["id"])
                conn.execute(
                    """
                    INSERT INTO score_lag (
                        id, call_id, previous_call_id, institution_id, flip_date,
                        from_direction, to_direction, move_30d_before, move_30d_after,
                        lag_ratio, is_resolved, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        move_30d_after = excluded.move_30d_after,
                        lag_ratio = excluded.lag_ratio,
                        is_resolved = excluded.is_resolved,
                        status = excluded.status
                    """,
                    (
                        score_id,
                        curr_call["id"],
                        prev_call["id"],
                        inst_id,
                        flip_date,
                        prev_call["direction"],
                        curr_call["direction"],
                        move_before,
                        move_after,
                        lag_ratio,
                        is_resolved,
                        status,
                    ),
                )
                inserted += 1

    return inserted


def aggregate_bank_scores(conn: sqlite3.Connection) -> int:
    """Aggregate bank-level metrics and detect always-bullish uninformative desks."""
    cur_inst = conn.execute("SELECT id FROM institution ORDER BY id ASC")
    institutions = [r["id"] for r in cur_inst.fetchall()]
    inserted = 0

    for inst_id in institutions:
        # Call direction counts
        cur_counts = conn.execute(
            """
            SELECT
                count(*) as total,
                sum(case when direction = 'bullish' then 1 else 0 end) as n_bull,
                sum(case when direction = 'bearish' then 1 else 0 end) as n_bear,
                sum(case when direction = 'neutral' then 1 else 0 end) as n_neut
            FROM call
            WHERE institution_id = ? AND call_type = 'direction'
            """,
            (inst_id,),
        )
        c_row = cur_counts.fetchone()
        total_calls = c_row["total"] or 0
        n_bull = c_row["n_bull"] or 0
        n_bear = c_row["n_bear"] or 0
        n_neut = c_row["n_neut"] or 0

        # Always-bullish detection (Anti-failure rule): n_bearish + n_neutral == 0
        is_always_bullish = 1 if (total_calls > 0 and (n_bear + n_neut == 0)) else 0
        if total_calls == 0:
            # Probability-only or allocation-only houses. Reporting these as
            # "evaluated" implied a direction record they do not have.
            status_label = "no direction calls"
        elif is_always_bullish:
            status_label = "no discriminating calls"
        else:
            status_label = "evaluated"

        # Direction Event Aggregates
        cur_ev = conn.execute(
            """
            SELECT
                sum(case when verdict = 'hit' then 1 else 0 end) as hits,
                sum(case when verdict = 'miss' then 1 else 0 end) as misses,
                sum(case when verdict = 'too_early' then 1 else 0 end) as too_early,
                sum(is_resolved) as resolved,
                sum(case when is_resolved = 1 and always_bullish_verdict = 'hit' then 1 else 0 end) as ab_hits
            FROM score_direction
            WHERE institution_id = ? AND evaluation_kind = 'event'
            """,
            (inst_id,),
        )
        ev_row = cur_ev.fetchone()
        ev_hits = ev_row["hits"] or 0
        ev_misses = ev_row["misses"] or 0
        ev_too_early = ev_row["too_early"] or 0
        ev_resolved = ev_row["resolved"] or 0
        ev_ab_hits = ev_row["ab_hits"] or 0

        ev_hit_rate = (ev_hits / ev_resolved) if ev_resolved > 0 else None
        ab_ev_hit_rate = (ev_ab_hits / ev_resolved) if ev_resolved > 0 else None
        ev_edge = (ev_hit_rate - ab_ev_hit_rate) if (ev_hit_rate is not None and ab_ev_hit_rate is not None) else None

        # Stance-Day Aggregates
        cur_sd = conn.execute(
            """
            SELECT
                sum(case when verdict = 'hit' then 1 else 0 end) as hits,
                sum(case when verdict = 'miss' then 1 else 0 end) as misses,
                sum(case when verdict = 'too_early' then 1 else 0 end) as too_early,
                sum(is_resolved) as resolved,
                sum(case when is_resolved = 1 and always_bullish_verdict = 'hit' then 1 else 0 end) as ab_hits
            FROM score_direction
            WHERE institution_id = ? AND evaluation_kind = 'stance_day'
            """,
            (inst_id,),
        )
        sd_row = cur_sd.fetchone()
        sd_hits = sd_row["hits"] or 0
        sd_misses = sd_row["misses"] or 0
        sd_too_early = sd_row["too_early"] or 0
        sd_resolved = sd_row["resolved"] or 0
        sd_ab_hits = sd_row["ab_hits"] or 0

        sd_hit_rate = (sd_hits / sd_resolved) if sd_resolved > 0 else None
        ab_sd_hit_rate = (sd_ab_hits / sd_resolved) if sd_resolved > 0 else None
        sd_edge = (sd_hit_rate - ab_sd_hit_rate) if (sd_hit_rate is not None and ab_sd_hit_rate is not None) else None

        # Allocation Aggregates
        cur_al = conn.execute(
            """
            SELECT
                sum(case when verdict = 'hit' then 1 else 0 end) as hits,
                sum(case when verdict = 'miss' then 1 else 0 end) as misses,
                sum(case when verdict = 'too_early' then 1 else 0 end) as too_early,
                sum(is_resolved) as resolved
            FROM score_allocation
            WHERE institution_id = ?
            """,
            (inst_id,),
        )
        al_row = cur_al.fetchone()
        al_hits = al_row["hits"] or 0
        al_misses = al_row["misses"] or 0
        al_too_early = al_row["too_early"] or 0
        al_resolved = al_row["resolved"] or 0
        al_hit_rate = (al_hits / al_resolved) if al_resolved > 0 else None

        # Lag Ratio
        cur_lag = conn.execute(
            """
            SELECT avg(lag_ratio) as avg_lag
            FROM score_lag
            WHERE institution_id = ? AND is_resolved = 1 AND lag_ratio IS NOT NULL
            """,
            (inst_id,),
        )
        lag_row = cur_lag.fetchone()
        avg_lag = lag_row["avg_lag"]

        conn.execute(
            """
            INSERT INTO score_bank (
                institution_id, total_calls, n_bullish, n_bearish, n_neutral,
                is_always_bullish, event_hits, event_misses, event_too_early,
                event_resolved, event_hit_rate, always_bullish_event_hit_rate,
                event_edge, stance_day_hits, stance_day_misses, stance_day_too_early,
                stance_day_resolved, stance_day_hit_rate, always_bullish_stance_day_hit_rate,
                stance_day_edge, allocation_hits, allocation_misses, allocation_too_early,
                allocation_resolved, allocation_hit_rate, avg_lag_ratio, status_label
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?
            )
            ON CONFLICT(institution_id) DO UPDATE SET
                total_calls = excluded.total_calls,
                n_bullish = excluded.n_bullish,
                n_bearish = excluded.n_bearish,
                n_neutral = excluded.n_neutral,
                is_always_bullish = excluded.is_always_bullish,
                event_hits = excluded.event_hits,
                event_misses = excluded.event_misses,
                event_too_early = excluded.event_too_early,
                event_resolved = excluded.event_resolved,
                event_hit_rate = excluded.event_hit_rate,
                always_bullish_event_hit_rate = excluded.always_bullish_event_hit_rate,
                event_edge = excluded.event_edge,
                stance_day_hits = excluded.stance_day_hits,
                stance_day_misses = excluded.stance_day_misses,
                stance_day_too_early = excluded.stance_day_too_early,
                stance_day_resolved = excluded.stance_day_resolved,
                stance_day_hit_rate = excluded.stance_day_hit_rate,
                always_bullish_stance_day_hit_rate = excluded.always_bullish_stance_day_hit_rate,
                stance_day_edge = excluded.stance_day_edge,
                allocation_hits = excluded.allocation_hits,
                allocation_misses = excluded.allocation_misses,
                allocation_too_early = excluded.allocation_too_early,
                allocation_resolved = excluded.allocation_resolved,
                allocation_hit_rate = excluded.allocation_hit_rate,
                avg_lag_ratio = excluded.avg_lag_ratio,
                status_label = excluded.status_label
            """,
            (
                inst_id,
                total_calls,
                n_bull,
                n_bear,
                n_neut,
                is_always_bullish,
                ev_hits,
                ev_misses,
                ev_too_early,
                ev_resolved,
                ev_hit_rate,
                ab_ev_hit_rate,
                ev_edge,
                sd_hits,
                sd_misses,
                sd_too_early,
                sd_resolved,
                sd_hit_rate,
                ab_sd_hit_rate,
                sd_edge,
                al_hits,
                al_misses,
                al_too_early,
                al_resolved,
                al_hit_rate,
                avg_lag,
                status_label,
            ),
        )
        inserted += 1

    return inserted


from scorecard.ai_stance import run_ai_stance_audit_on_all_calls


def run_scoring(conn: sqlite3.Connection, as_of_date: str = AS_OF_DATE, reset_first: bool = True) -> Dict[str, int]:
    """Execute complete scoring rebuild workflow."""
    if reset_first:
        reset_score_tables(conn)

    ev_dir_count = score_direction_events(conn, as_of_date)
    sd_dir_count = score_direction_stance_days(conn, as_of_date)
    alloc_count = score_allocations(conn, as_of_date)
    prob_count = score_probabilities(conn, as_of_date)
    lag_count = score_lag_ratios(conn, as_of_date)
    ai_audit_count = run_ai_stance_audit_on_all_calls(conn)
    bank_count = aggregate_bank_scores(conn)

    return {
        "direction_event_scores": ev_dir_count,
        "direction_stance_day_scores": sd_dir_count,
        "allocation_scores": alloc_count,
        "probability_scores": prob_count,
        "lag_scores": lag_count,
        "ai_stance_audits": ai_audit_count,
        "bank_scorecards": bank_count,
    }

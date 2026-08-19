"""Mathematical derivation and deterministic identity helpers."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional, Tuple

from scorecard.config import (
    DIRECTION_BAND,
    CLIMATOLOGY_RECESSION_PRIOR,
    HORIZON_DAYS,
    YEAR_END_2026,
)


def classify_direction(implied_return: Optional[float], band: float = DIRECTION_BAND) -> Optional[str]:
    """Classify an implied return into bullish / bearish / neutral under the indifference band.

    This is the authoritative direction rule for the scorecard (see README, HANDOFF):

        implied = target / spot_at_publication - 1
        bullish  if implied >  +band
        bearish  if implied <  -band
        neutral  otherwise

    The band is a product parameter, stored on every call row, and is never
    overridden by narrative or sentiment analysis.
    """
    if implied_return is None:
        return None
    if implied_return > band:
        return "bullish"
    if implied_return < -band:
        return "bearish"
    return "neutral"


def derive_direction(
    target: Optional[float],
    spot: float,
    institution_id: str = "",
    institution_name: str = "",
    strategist_name: Optional[str] = None,
    published_on: str = "",
    call_type: str = "direction",
    notes: Optional[str] = None,
    source_title: Optional[str] = None,
    source_snippet: Optional[str] = None,
    band: float = DIRECTION_BAND,
) -> Tuple[Optional[float], Optional[str]]:
    """Derive implied return and directional stance from the target/spot arithmetic.

    Direction is decided by :func:`classify_direction` under ``band``. The AI
    stance classifier in :mod:`scorecard.ai_stance` runs as a separate,
    non-authoritative narrative layer and is reconciled against this result via
    ``ai_call_audit.ai_math_agreement``.
    """
    if target is None or spot <= 0:
        return None, None

    implied = (float(target) / float(spot)) - 1.0
    return implied, classify_direction(implied, band)


def classify_realised_direction(
    realised_return: Optional[float], band: float = DIRECTION_BAND
) -> Optional[str]:
    """Classify realised market move into bullish, bearish, or flat."""
    if realised_return is None:
        return None
    if realised_return > band:
        return "bullish"
    elif realised_return < -band:
        return "bearish"
    else:
        return "flat"


def derive_direction_verdict(
    forecast_direction: str, realised_direction: Optional[str]
) -> str:
    """Determine hit/miss/too_early for a directional call.

    Bullish hits on bullish. Bearish hits on bearish.
    Neutral hits on flat.
    Miss if realized != forecast, or if forecast is bullish/bearish vs flat.
    """
    if realised_direction is None:
        return "too_early"
    if forecast_direction == realised_direction:
        return "hit"
    if forecast_direction == "neutral" and realised_direction == "flat":
        return "hit"
    return "miss"


def derive_allocation_verdict(
    stance: str, spread_return: Optional[float], band: float = DIRECTION_BAND
) -> str:
    """Determine allocation verdict relative to benchmark return (spread = asset - bench).

    Overweight hits iff spread > 0.
    Underweight hits iff spread < 0.
    Neutral hits iff |spread| <= band.
    """
    if spread_return is None:
        return "too_early"
    if stance == "overweight":
        return "hit" if spread_return > 0 else "miss"
    elif stance == "underweight":
        return "hit" if spread_return < 0 else "miss"
    elif stance == "neutral":
        return "hit" if abs(spread_return) <= band else "miss"
    return "miss"


def derive_brier_score(
    prob: float,
    outcome: Optional[float],
    prior: float = CLIMATOLOGY_RECESSION_PRIOR,
) -> Tuple[Optional[float], Optional[float], Optional[float], str]:
    """Calculate Brier score, climatology Brier score, skill score, and verdict."""
    if outcome is None:
        return None, None, None, "too_early"

    brier = (float(prob) - float(outcome)) ** 2
    brier_clim = (float(prior) - float(outcome)) ** 2
    bss = 1.0 - (brier / brier_clim) if brier_clim > 0 else 0.0
    verdict = "hit" if brier < brier_clim else "miss"
    return brier, brier_clim, bss, verdict


def derive_lag_ratio(
    move_30d_before: float, move_30d_after: Optional[float]
) -> Tuple[Optional[float], str]:
    """Calculate lag ratio on a direction flip: |move_30d_before| / |move_30d_after|."""
    if move_30d_after is None:
        return None, "too_early"
    if abs(move_30d_after) < 1e-6:
        # Avoid division by zero if market was completely unchanged
        return None, "resolved"

    ratio = abs(move_30d_before) / abs(move_30d_after)
    return ratio, "resolved"


def compute_horizon_end_date(
    start_date: str, horizon: str, forecast_horizon: Optional[str] = None
) -> str:
    """Compute the target calendar end date for a given horizon."""
    start = date.fromisoformat(start_date)
    if horizon == "YE":
        if forecast_horizon and forecast_horizon.startswith("YE_"):
            year_str = forecast_horizon.split("_")[1]
            return f"{year_str}-12-31"
        # If forecast_horizon is not given: if start is in Nov/Dec, YE target is end of next year, else current year
        target_year = start.year + 1 if start.month >= 11 else start.year
        return f"{target_year}-12-31"
    days = HORIZON_DAYS.get(horizon)
    if days is not None:
        return (start + timedelta(days=days)).isoformat()
    raise ValueError(f"Unknown horizon: {horizon}")


def make_call_idempotency_key(
    institution_id: str,
    published_on: str,
    call_type: str,
    forecast_horizon: str,
    payload_str: str,
) -> str:
    """Generate unique idempotency key for calls."""
    return f"{institution_id}|{published_on}|{call_type}|{forecast_horizon}|{payload_str}"


def make_score_direction_id(
    call_id: str, evaluation_kind: str, horizon: str, as_of_date: str
) -> str:
    """Deterministic primary key for direction score rows."""
    return f"direction|{call_id}|{evaluation_kind}|{horizon}|{as_of_date}"


def make_score_allocation_id(
    call_id: str, evaluation_kind: str, horizon: str, as_of_date: str
) -> str:
    """Deterministic primary key for allocation score rows."""
    return f"allocation|{call_id}|{evaluation_kind}|{horizon}|{as_of_date}"


def make_score_probability_id(
    call_id: str, event_key: str, as_of_date: str
) -> str:
    """Deterministic primary key for probability score rows."""
    return f"probability|{call_id}|{event_key}|{as_of_date}"


def make_score_lag_id(call_id: str, previous_call_id: str) -> str:
    """Deterministic primary key for lag score rows."""
    return f"lag|{call_id}|{previous_call_id}"

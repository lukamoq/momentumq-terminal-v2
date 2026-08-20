"""
Volatility Term Structure & Contango/Backwardation Analytics.

The curve is measured from the observed SPY option chain using the CBOE
model-free formula at 9, 30 and 90-day constant maturities. Contango and
backwardation are read off the *shape of that curve*, which is what those words
mean.

What this replaces:

* ``vix_proxy`` used to be the VIXY **share price**. VIXY is a rolling-futures
  ETF that has reverse-split repeatedly: split-adjusted it closed at $633,840
  in 2011, $292 in 2022 and $18.86 in 2026. Its level tracks split history, not
  volatility, so "VIX proxy = $18.86" only resembled a VIX print by accident,
  and any historical comparison was meaningless.
* The 1-year **percentile** of that series was worse than meaningless. VIXY
  bleeds several percent a month to roll decay, so its price is almost always
  near the bottom of its own trailing range; the percentile printed "subdued
  complacency" as a structural artefact regardless of what volatility did.
* ``contango_ratio`` was the mean 5-day rate of change of VIXY. That conflates
  the direction of spot volatility with the slope of the curve: in a rising-vol
  regime that is still in contango, VIXY rises and the old code reported
  backwardation.

History accumulates in ``vol_index_observation``, one row per pipeline run.
Until enough snapshots exist to rank against, the percentile is reported as
None rather than computed off a handful of points -- and the realized-volatility
series from SPY bars (which does go back decades) is supplied alongside as
observed context, labelled as realized rather than implied.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional

from scorecard.optionsdata import load_chain_rows, risk_free_rate
from scorecard.volatility import group_by_expiry, term_structure

# Minimum stored snapshots before a percentile is meaningful. Below this the
# field is None -- a rank against five observations is not a percentile.
MIN_HISTORY_FOR_PERCENTILE = 30

# Curve slope thresholds, in ratio terms (90-day IV / 30-day IV).
_STEEP_CONTANGO = 1.10
_MILD_CONTANGO = 1.02
_MILD_BACKWARDATION = 0.98
_STEEP_BACKWARDATION = 0.90


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        f = float(val)
        return default if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return default


def _realized_vol_series(
    conn: sqlite3.Connection, ticker: str = "SPY", window: int = 21, limit: int = 400
) -> List[Dict[str, Any]]:
    """Trailing annualised realized volatility from observed daily closes."""
    rows = conn.execute(
        """
        SELECT date, close FROM market_observation
        WHERE ticker = ? ORDER BY date DESC LIMIT ?
        """,
        (ticker.upper(), limit + window + 1),
    ).fetchall()
    if len(rows) < window + 2:
        return []
    series = [(str(r["date"]), float(r["close"])) for r in reversed(rows)]
    rets = [
        (series[i][0], (series[i][1] / series[i - 1][1]) - 1.0)
        for i in range(1, len(series))
        if series[i - 1][1] > 0
    ]
    out: List[Dict[str, Any]] = []
    for i in range(window, len(rets) + 1):
        chunk = [r for _, r in rets[i - window:i]]
        mean = sum(chunk) / len(chunk)
        var = sum((x - mean) ** 2 for x in chunk) / (len(chunk) - 1)
        out.append({"date": rets[i - 1][0], "realized_vol": round(math.sqrt(var * 252) * 100.0, 2)})
    return out[-limit:]


def record_vol_index_snapshot(conn: sqlite3.Connection, underlying: str = "SPY") -> Optional[Dict[str, Any]]:
    """Compute today's curve from the chain and persist it into the history table."""
    snapshot_date, rows = load_chain_rows(conn, underlying)
    if not rows or snapshot_date is None:
        return None

    spot_row = conn.execute(
        "SELECT close FROM market_observation WHERE ticker = ? ORDER BY date DESC LIMIT 1",
        (underlying.upper(),),
    ).fetchone()
    if not spot_row:
        return None
    spot = float(spot_row["close"])

    chains = group_by_expiry(rows)
    curve = term_structure(
        chains, snapshot_date, spot,
        lambda d: risk_free_rate(conn, d, as_of=snapshot_date),
        tenors=(9.0, 30.0, 90.0),
    )

    rv_series = _realized_vol_series(conn, underlying, window=21, limit=1)
    realized = rv_series[-1]["realized_vol"] if rv_series else None

    conn.execute(
        """
        INSERT INTO vol_index_observation (date, underlying, iv_9d, iv_30d, iv_90d, realized_vol_21d)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, underlying) DO UPDATE SET
            iv_9d = excluded.iv_9d, iv_30d = excluded.iv_30d,
            iv_90d = excluded.iv_90d, realized_vol_21d = excluded.realized_vol_21d
        """,
        (snapshot_date, underlying.upper(), curve.get("9d"), curve.get("30d"), curve.get("90d"), realized),
    )
    conn.commit()
    return {"date": snapshot_date, "spot": spot, **curve, "realized_vol_21d": realized}


def _classify_curve(ratio: Optional[float]) -> tuple[str, str, str]:
    """Map the 90d/30d implied-volatility ratio onto a curve state."""
    if ratio is None:
        return "Unknown", "mild", "#8c97b2"
    if ratio >= _STEEP_CONTANGO:
        return "Contango", "steep", "#34d399"
    if ratio >= _MILD_CONTANGO:
        return "Contango", "moderate" if ratio >= 1.05 else "mild", "#34d399"
    if ratio > _MILD_BACKWARDATION:
        return "Flat", "mild", "#8c97b2"
    if ratio > _STEEP_BACKWARDATION:
        return "Backwardation", "moderate", "#f59e0b"
    return "Backwardation", "steep", "#ef4444"


def compute_vix_structure(
    conn: sqlite3.Connection, history_days: int = 252, underlying: str = "SPY"
) -> Dict[str, Any]:
    """
    Compute the implied-volatility term structure from the observed SPY chain.

    Returns the constant-maturity curve, its contango/backwardation state, the
    accumulated implied-volatility history (when long enough to rank against),
    the realized-volatility series for context, and a narrative reading.
    """
    snapshot = record_vol_index_snapshot(conn, underlying)
    if snapshot is None:
        return _empty_vix_result(
            "No option chain ingested — run `python -m scorecard options` to pull one."
        )

    iv_9 = snapshot.get("9d")
    iv_30 = snapshot.get("30d")
    iv_90 = snapshot.get("90d")
    realized = snapshot.get("realized_vol_21d")

    if iv_30 is None:
        return _empty_vix_result("Chain present but 30-day implied volatility could not be solved.")

    # Curve slope: the ratio the market itself quotes, 3-month over 1-month.
    contango_ratio = (iv_90 / iv_30) if (iv_90 and iv_30 > 0) else None
    near_slope = (iv_30 / iv_9) if (iv_9 and iv_9 > 0) else None
    current_state, severity, color = _classify_curve(contango_ratio)

    # Percentile against the accumulated implied history, not against an ETF.
    hist_rows = conn.execute(
        """
        SELECT date, iv_9d, iv_30d, iv_90d, realized_vol_21d
        FROM vol_index_observation
        WHERE underlying = ? ORDER BY date ASC
        """,
        (underlying.upper(),),
    ).fetchall()
    iv_history = [dict(r) for r in hist_rows][-history_days:]
    iv30_values = [float(r["iv_30d"]) for r in iv_history if r["iv_30d"] is not None]

    if len(iv30_values) >= MIN_HISTORY_FOR_PERCENTILE:
        below = sum(1 for v in iv30_values if v <= iv_30)
        iv_percentile: Optional[float] = round((below / len(iv30_values)) * 100.0, 1)
        percentile_basis = f"{len(iv30_values)} stored implied-volatility snapshots"
    else:
        iv_percentile = None
        percentile_basis = (
            f"{len(iv30_values)} of {MIN_HISTORY_FOR_PERCENTILE} snapshots needed — "
            "implied-volatility history accumulates one row per pipeline run"
        )

    # Realized volatility is available from the price history going back decades
    # and is supplied as observed context, explicitly not as an implied series.
    realized_series = _realized_vol_series(conn, underlying, window=21, limit=history_days)
    realized_values = [r["realized_vol"] for r in realized_series]
    if realized is not None and len(realized_values) >= 30:
        rv_below = sum(1 for v in realized_values if v <= realized)
        realized_percentile: Optional[float] = round((rv_below / len(realized_values)) * 100.0, 1)
    else:
        realized_percentile = None

    iv_premium = round(iv_30 - realized, 2) if realized is not None else None

    interpretation = _build_vix_interpretation(
        current_state, severity, iv_9, iv_30, iv_90,
        contango_ratio, realized, iv_premium, iv_percentile, realized_percentile,
    )

    return {
        "underlying": underlying.upper(),
        "as_of_date": snapshot["date"],
        "current_state": current_state,
        "severity": severity,
        "state_color": color,
        "basis": "observed_option_chain",
        "method": "CBOE model-free implied variance, constant maturity",
        "curve": {
            "iv_9d": round(iv_9, 2) if iv_9 is not None else None,
            "iv_30d": round(iv_30, 2),
            "iv_90d": round(iv_90, 2) if iv_90 is not None else None,
        },
        "contango_ratio": round(contango_ratio, 4) if contango_ratio is not None else None,
        "contango_spread": round(iv_90 - iv_30, 2) if iv_90 is not None else None,
        "near_slope_ratio": round(near_slope, 4) if near_slope is not None else None,
        "iv_30d": round(iv_30, 2),
        "iv_percentile": iv_percentile,
        "percentile_basis": percentile_basis,
        "realized_vol_21d": realized,
        "realized_percentile": realized_percentile,
        "iv_premium": iv_premium,
        "history": {
            "implied": [
                {
                    "date": r["date"],
                    "iv_9d": r["iv_9d"],
                    "iv_30d": r["iv_30d"],
                    "iv_90d": r["iv_90d"],
                }
                for r in iv_history
            ],
            "realized": realized_series,
        },
        "interpretation": interpretation,
    }


def _build_vix_interpretation(
    state: str,
    severity: str,
    iv_9: Optional[float],
    iv_30: float,
    iv_90: Optional[float],
    contango_ratio: Optional[float],
    realized: Optional[float],
    iv_premium: Optional[float],
    iv_percentile: Optional[float],
    realized_percentile: Optional[float],
) -> str:
    """Build narrative interpretation for quants and research analysts."""
    parts: List[str] = []

    if iv_9 is not None and iv_90 is not None:
        parts.append(
            f"Implied volatility term structure reads {iv_9:.1f}% at 9 days, "
            f"{iv_30:.1f}% at 30 days and {iv_90:.1f}% at 90 days."
        )
    else:
        parts.append(f"Thirty-day implied volatility is {iv_30:.1f}%.")

    if state == "Contango" and contango_ratio is not None:
        parts.append(
            f"The curve is in {severity} contango (3M/1M = {contango_ratio:.2f}). "
            "Forward variance is priced above spot variance, the normal regime, "
            "and short-vol carry earns a positive roll."
        )
    elif state == "Backwardation" and contango_ratio is not None:
        parts.append(
            f"The curve is inverted in {severity} backwardation (3M/1M = {contango_ratio:.2f}). "
            "Near-dated protection is bid above longer-dated — the signature of an "
            "active hedging scramble rather than a steady-state regime."
        )
    else:
        parts.append("The curve is essentially flat, signalling a transitional volatility regime.")

    if realized is not None and iv_premium is not None:
        if iv_premium > 0:
            parts.append(
                f"Thirty-day implied sits {iv_premium:.1f} points above 21-day realized "
                f"({realized:.1f}%), so options are pricing a variance risk premium."
            )
        else:
            parts.append(
                f"Thirty-day implied sits {abs(iv_premium):.1f} points below 21-day realized "
                f"({realized:.1f}%) — the tape has been moving more than the options market charges for."
            )

    if iv_percentile is not None:
        parts.append(f"That places implied volatility in the {iv_percentile:.0f}th percentile of the stored implied history.")
    elif realized_percentile is not None:
        parts.append(
            f"Implied history is still accumulating; realized volatility is in the "
            f"{realized_percentile:.0f}th percentile of its own trailing year."
        )

    return " ".join(parts)


def _empty_vix_result(msg: str) -> Dict[str, Any]:
    """No-data path. Every measured field is None -- never a plausible placeholder."""
    return {
        "underlying": "SPY",
        "as_of_date": None,
        "current_state": "Unknown",
        "severity": "mild",
        "state_color": "#8c97b2",
        "basis": "unavailable",
        "method": None,
        "curve": {"iv_9d": None, "iv_30d": None, "iv_90d": None},
        "contango_ratio": None,
        "contango_spread": None,
        "near_slope_ratio": None,
        "iv_30d": None,
        "iv_percentile": None,
        "percentile_basis": msg,
        "realized_vol_21d": None,
        "realized_percentile": None,
        "iv_premium": None,
        "history": {"implied": [], "realized": []},
        "interpretation": msg,
    }

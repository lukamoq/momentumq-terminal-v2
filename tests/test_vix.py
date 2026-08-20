"""
Unit tests for the implied-volatility term structure engine.

The curve is measured from the observed SPY option chain, so the chain-dependent
assertions skip when nothing has been ingested.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.optionsdata import load_chain_rows
from scorecard.vix import _empty_vix_result, compute_vix_structure


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def _require_chain(conn):
    _, rows = load_chain_rows(conn, "SPY")
    if not rows:
        pytest.skip("no option chain ingested")


def test_compute_vix_structure(conn):
    _require_chain(conn)
    vix = compute_vix_structure(conn)

    assert vix["current_state"] in ("Contango", "Backwardation", "Flat")
    assert vix["basis"] == "observed_option_chain"
    assert len(vix["interpretation"]) > 20

    curve = vix["curve"]
    for tenor in ("iv_9d", "iv_30d", "iv_90d"):
        assert curve[tenor] is not None, f"{tenor} failed to solve"
        assert 3.0 < curve[tenor] < 150.0

    assert vix["contango_ratio"] == pytest.approx(curve["iv_90d"] / curve["iv_30d"], abs=1e-3)
    assert vix["contango_spread"] == pytest.approx(curve["iv_90d"] - curve["iv_30d"], abs=0.02)


def test_level_is_in_volatility_points_not_an_etf_share_price(conn):
    """
    Regression: `vix_proxy` was the VIXY close. Split-adjusted that series ran
    from $633,840 in 2011 to $18.86 in 2026, so the field tracked reverse-split
    history rather than volatility and only resembled a VIX print by accident.
    """
    _require_chain(conn)
    vix = compute_vix_structure(conn)
    assert 3.0 < vix["iv_30d"] < 150.0

    vixy = conn.execute(
        "SELECT close FROM market_observation WHERE ticker = 'VIXY' ORDER BY date DESC LIMIT 1"
    ).fetchone()
    if vixy:
        assert vix["iv_30d"] != pytest.approx(float(vixy["close"]), abs=0.01)


def test_state_is_derived_from_the_curve_not_from_a_rate_of_change(conn):
    """
    Regression: contango was the mean 5-day rate of change of VIXY, which
    conflates the direction of spot volatility with the slope of the curve --
    a rising-vol tape in contango was reported as backwardation. The state must
    follow the 3M/1M ratio.
    """
    _require_chain(conn)
    vix = compute_vix_structure(conn)
    ratio = vix["contango_ratio"]
    assert ratio is not None
    if vix["current_state"] == "Contango":
        assert ratio > 1.0
    elif vix["current_state"] == "Backwardation":
        assert ratio < 1.0


def test_percentile_is_withheld_until_there_is_history_to_rank_against(conn):
    """A rank against a handful of stored snapshots is not a percentile."""
    _require_chain(conn)
    vix = compute_vix_structure(conn)
    stored = conn.execute(
        "SELECT COUNT(*) AS n FROM vol_index_observation WHERE underlying = 'SPY' AND iv_30d IS NOT NULL"
    ).fetchone()["n"]

    if stored < 30:
        assert vix["iv_percentile"] is None
        assert "snapshots" in vix["percentile_basis"]
    else:
        assert 0.0 <= vix["iv_percentile"] <= 100.0


def test_realized_series_is_supplied_as_observed_context(conn):
    """Realized vol comes from the price history and is labelled separately."""
    _require_chain(conn)
    vix = compute_vix_structure(conn)
    realized = vix["history"]["realized"]
    assert len(realized) >= 20
    assert all(0.0 < r["realized_vol"] < 300.0 for r in realized)
    assert vix["realized_vol_21d"] is not None
    assert vix["iv_premium"] == pytest.approx(vix["iv_30d"] - vix["realized_vol_21d"], abs=0.02)


def test_snapshot_is_persisted_for_future_percentiles(conn):
    _require_chain(conn)
    vix = compute_vix_structure(conn)
    row = conn.execute(
        "SELECT iv_30d FROM vol_index_observation WHERE underlying = 'SPY' AND date = ?",
        (vix["as_of_date"],),
    ).fetchone()
    assert row is not None
    assert float(row["iv_30d"]) == pytest.approx(vix["iv_30d"], abs=0.01)


def test_empty_result_reports_nothing_measured():
    empty = _empty_vix_result("no chain")
    assert empty["current_state"] == "Unknown"
    assert empty["iv_30d"] is None
    assert empty["contango_ratio"] is None
    assert empty["iv_percentile"] is None
    assert empty["curve"] == {"iv_9d": None, "iv_30d": None, "iv_90d": None}


def test_api_vix_structure_endpoint(client):
    res = client.get("/api/macro/vix-structure")
    assert res.status_code == 200
    data = res.json()
    assert "current_state" in data
    assert "curve" in data
    assert "history" in data

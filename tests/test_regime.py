"""
Unit & Integration Tests for Macro Regime, Cross-Asset Correlation, and Sector Rotation.
"""

import sqlite3
import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.regime import (
    compute_macro_regime,
    compute_cross_asset_correlation,
    compute_sector_rotation,
)


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def test_compute_macro_regime(conn):
    regime = compute_macro_regime(conn)
    assert "regime" in regime
    assert "regime_label" in regime
    assert "confidence_pct" in regime
    assert regime["confidence_pct"] > 0
    assert "factors" in regime
    assert "spy_spot" in regime["factors"]
    assert "signals" in regime
    assert len(regime["signals"]) >= 4


def test_compute_cross_asset_correlation(conn):
    corr = compute_cross_asset_correlation(conn, lookback_days=60)
    assert "symbols" in corr
    assert len(corr["symbols"]) >= 4
    assert "matrix" in corr
    assert len(corr["matrix"]) == len(corr["symbols"])
    assert "diversification_score" in corr
    assert 0 <= corr["diversification_score"] <= 100


def test_compute_sector_rotation(conn):
    sectors = compute_sector_rotation(conn)
    assert "sectors" in sectors
    assert len(sectors["sectors"]) >= 10
    first = sectors["sectors"][0]
    assert "ticker" in first
    assert "name" in first
    assert "alpha_3m" in first
    assert "quadrant" in first


def test_api_macro_regime_endpoint(client):
    res = client.get("/api/macro/regime")
    assert res.status_code == 200
    data = res.json()
    assert data["regime"] in ("BULL_TRENDING", "BULL_EXUBERANT", "VOLATILE_CORRECTION", "BEAR_CONTRACTION", "RANGEBOUND")


def test_api_correlation_endpoint(client):
    res = client.get("/api/analytics/correlation?lookback=60")
    assert res.status_code == 200
    data = res.json()
    assert "matrix" in data


def test_api_sectors_endpoint(client):
    res = client.get("/api/analytics/sectors")
    assert res.status_code == 200
    data = res.json()
    assert "sectors" in data


def test_credit_signal_is_computed_not_hardcoded(conn):
    """
    Regression: this block queried HYG and IEF, discarded the result, and set
    the signal to "RISK_ON" whenever the query returned any row at all -- so
    the terminal reported risk-on credit unconditionally, including through a
    drawdown.
    """
    regime = compute_macro_regime(conn)
    factors = regime["factors"]
    assert factors["credit_signal"] in ("RISK_ON", "RISK_OFF", "STABLE", "UNAVAILABLE")

    rel = factors["credit_relative_return_60d_pct"]
    if factors["credit_signal"] == "UNAVAILABLE":
        assert rel is None
        return

    assert rel is not None
    # The label must follow the measurement.
    if rel > 1.0:
        assert factors["credit_signal"] == "RISK_ON"
    elif rel < -1.0:
        assert factors["credit_signal"] == "RISK_OFF"
    else:
        assert factors["credit_signal"] == "STABLE"

    # And it must equal a direct HYG/IEF computation.
    hyg = [float(r["close"]) for r in conn.execute(
        "SELECT close FROM market_observation WHERE ticker='HYG' ORDER BY date DESC LIMIT 61").fetchall()]
    ief = [float(r["close"]) for r in conn.execute(
        "SELECT close FROM market_observation WHERE ticker='IEF' ORDER BY date DESC LIMIT 61").fetchall()]
    expected = ((hyg[0] / ief[0]) / (hyg[60] / ief[60]) - 1.0) * 100.0
    assert rel == pytest.approx(expected, abs=0.01)


def test_confidence_is_derived_from_the_evidence(conn):
    """
    Regression: confidence was a literal per branch -- "Bull Trending" always
    printed 94% -- so it conveyed which branch fired, not how well the data
    agreed. It must now vary with the inputs.
    """
    from scorecard.regime import _condition_strength, _confidence

    regime = compute_macro_regime(conn)
    assert 50.0 <= regime["confidence_pct"] <= 95.0
    # Not one of the old hardcoded constants (except by coincidence of scale).
    assert regime["confidence_pct"] not in (88.0, 94.0, 78.0, 85.0, 72.0)

    # The scaler is monotone and clamped.
    assert _condition_strength(0.0, 0.0, 0.1) == 0.0
    assert _condition_strength(0.1, 0.0, 0.1) == 1.0
    assert _condition_strength(0.5, 0.0, 0.1) == 1.0
    assert _condition_strength(0.05, 0.0, 0.1) == pytest.approx(0.5)
    assert _confidence([0.0, 0.0]) == 50.0
    assert _confidence([1.0, 1.0]) == 95.0
    assert _confidence([]) == 50.0


def test_credit_signal_appears_as_a_reported_signal(conn):
    regime = compute_macro_regime(conn)
    names = {s["name"] for s in regime["signals"]}
    assert "Credit Risk Appetite" in names


def test_compute_macro_history(conn):
    from scorecard.regime import compute_macro_history

    hist = compute_macro_history(conn, lookback_days=252)
    assert "dates" in hist
    assert len(hist["dates"]) >= 200
    assert "spy" in hist
    assert len(hist["spy"]["close"]) == len(hist["dates"])
    assert "indicators" in hist
    assert "credit_spread" in hist["indicators"]
    assert "yield_slope" in hist["indicators"]
    assert "gold_spread" in hist["indicators"]
    assert "summary_stats" in hist
    assert hist["summary_stats"]["current_price"] > 0
    assert hist["summary_stats"]["cagr"] is not None


def test_api_macro_history_endpoint(client):
    res = client.get("/api/macro/history?lookback=252")
    assert res.status_code == 200
    data = res.json()
    assert "dates" in data
    assert "spy" in data
    assert "indicators" in data
    assert "summary_stats" in data

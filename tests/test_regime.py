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

"""
Tests for Seasonality Matrix & Advanced Macro Analytics.
"""

import sqlite3
import pytest
from fastapi.testclient import TestClient

from scorecard.config import DB_PATH
from scorecard.api import app
from scorecard.seasonality import (
    compute_monthly_returns,
    compute_multi_asset_seasonality_overview,
    compute_cumulative_day_of_year_curves,
    compute_call_seasonality_analytics,
)


@pytest.fixture
def conn():
    c = sqlite3.connect(DB_PATH)
    yield c
    c.close()


def test_compute_monthly_returns_spy(conn):
    data = compute_monthly_returns(conn, "SPY")
    assert data["ticker"] == "SPY"
    assert len(data["years"]) >= 4
    assert len(data["monthly_averages"]) == 12
    assert len(data["monthly_win_rates"]) == 12
    assert data["best_month"] is not None
    assert data["worst_month"] is not None
    assert "month" in data["best_month"]


def test_compute_multi_asset_seasonality(conn):
    multi = compute_multi_asset_seasonality_overview(conn)
    assert len(multi["assets"]) >= 5
    tickers = [a["ticker"] for a in multi["assets"]]
    assert "SPY" in tickers
    assert "QQQ" in tickers
    assert "NVDA" in tickers


def test_compute_cumulative_curves(conn):
    curves = compute_cumulative_day_of_year_curves(conn, "SPY")
    assert curves["ticker"] == "SPY"
    assert len(curves["average_curve"]) > 0
    assert len(curves["yearly_curves"]) > 0


def test_compute_call_seasonality_analytics(conn):
    calls_data = compute_call_seasonality_analytics(conn)
    assert len(calls_data["months"]) == 12
    assert len(calls_data["quarters"]) == 4
    assert calls_data["total_audited_calls"] > 50


def test_analytics_api_endpoints():
    client = TestClient(app)
    
    r1 = client.get("/api/analytics/seasonality?ticker=SPY")
    assert r1.status_code == 200
    assert "matrix" in r1.json()

    r2 = client.get("/api/analytics/multi-asset")
    assert r2.status_code == 200
    assert "assets" in r2.json()

    r3 = client.get("/api/analytics/seasonality-curves?ticker=NVDA")
    assert r3.status_code == 200
    assert "average_curve" in r3.json()

    r4 = client.get("/api/analytics/call-patterns")
    assert r4.status_code == 200
    assert "quarters" in r4.json()

    r5 = client.get("/api/analytics/stats")
    assert r5.status_code == 200
    assert "spy_best_month" in r5.json()

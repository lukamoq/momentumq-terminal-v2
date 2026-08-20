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


def test_partial_months_are_excluded_from_the_seasonal_averages(conn):
    """
    Regression: the live, incomplete month landed in its own column and was
    averaged in as though it were a full month. With twelve sessions of an
    August on the tape that stub moved the 27-year August mean by roughly a
    quarter of its own size, so the seasonal statistic was partly a readout of
    the last two weeks.
    """
    data = compute_monthly_returns(conn, "SPY")
    years = [str(y) for y in data["years"]]

    for m_idx in range(12):
        sample = [
            data["matrix"][y][m_idx] for y in years
            if data["matrix"][y][m_idx] is not None and data["month_complete"][y][m_idx]
        ]
        assert data["monthly_sample_counts"][m_idx] == len(sample)
        if sample:
            assert data["monthly_averages"][m_idx] == pytest.approx(
                sum(sample) / len(sample), abs=1e-4
            )
            wins = sum(1 for r in sample if r > 0) / len(sample)
            assert data["monthly_win_rates"][m_idx] == pytest.approx(wins, abs=1e-4)

    # The first and last months of the series are the partial ones.
    first_year, last_year = years[0], years[-1]
    assert not all(data["month_complete"][last_year][i] for i in range(12)) or last_year != years[-1]
    assert any(
        not flag
        for y in (first_year, last_year)
        for i, flag in enumerate(data["month_complete"][y])
        if data["matrix"][y][i] is not None
    )


def test_partial_months_still_render_in_the_matrix(conn):
    """Excluding a stub from the statistics must not delete it from the grid."""
    data = compute_monthly_returns(conn, "SPY")
    last_year = str(data["years"][-1])
    present = [i for i, v in enumerate(data["matrix"][last_year]) if v is not None]
    assert present, "latest year has no months at all"
    incomplete = [i for i in present if not data["month_complete"][last_year][i]]
    assert incomplete, "expected the live month to be flagged incomplete"


def test_annual_return_compounds_from_its_own_months(conn):
    """
    Regression: the year was measured from the first close *inside* January
    while each month was measured from the prior month's close, so the twelve
    months did not compound to the year -- 24.00% reported against 23.32%
    compounded for SPY in 2024.
    """
    import math

    data = compute_monthly_returns(conn, "SPY")
    checked = 0
    for y in data["years"]:
        ys = str(y)
        if not data["year_complete"][ys]:
            continue
        months = [m for m in data["matrix"][ys] if m is not None]
        compounded = math.prod(1.0 + m for m in months) - 1.0
        assert data["full_year_returns"][ys] == pytest.approx(compounded, abs=0.001)
        checked += 1
    assert checked >= 5, "no complete years available to verify"

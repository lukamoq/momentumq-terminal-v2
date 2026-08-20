"""
Unit & Integration Tests for Commodities, Precious Metals & Energy Analytics.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.commodities import compute_commodities_analytics


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def test_compute_commodities_analytics(conn):
    data = compute_commodities_analytics(conn)
    assert "as_of_date" in data
    assert "macro_stance" in data
    assert "assets" in data
    assert len(data["assets"]) == 5

    tickers = {a["ticker"] for a in data["assets"]}
    assert "GLD" in tickers
    assert "USO" in tickers
    assert "SLV" in tickers
    assert "DBC" in tickers
    assert "UUP" in tickers

    gld = next(a for a in data["assets"] if a["ticker"] == "GLD")
    assert gld["spot"] > 0
    assert gld["high_52w"] >= gld["low_52w"]
    assert gld["rvol_21d"] > 0

    assert "cross_ratios" in data
    r = data["cross_ratios"]
    assert "gold_silver_ratio" in r
    assert r["gold_silver_ratio"] > 0
    assert "gold_oil_ratio" in r
    assert r["gold_oil_ratio"] > 0


def test_api_commodities_endpoint(client):
    res = client.get("/api/macro/commodities")
    assert res.status_code == 200
    data = res.json()
    assert "assets" in data
    assert len(data["assets"]) >= 5
    assert "cross_ratios" in data

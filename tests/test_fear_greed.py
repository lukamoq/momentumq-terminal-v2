"""
Unit Tests for MoQ Fear & Greed Index 2.0 Engine.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.fear_greed import compute_fear_greed_index, WEIGHTS


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def test_compute_fear_greed_index(conn):
    fg = compute_fear_greed_index(conn)
    assert "composite_score" in fg
    assert 0.0 <= fg["composite_score"] <= 100.0
    assert "label" in fg
    assert fg["label"] in ("Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed")
    assert "bar_color" in fg
    assert "categories" in fg
    assert len(fg["categories"]) == 10

    # Ensure all 10 category weights sum to 1.0
    total_w = sum(WEIGHTS.values())
    assert total_w == pytest.approx(1.0, abs=1e-5)

    for k, cat in fg["categories"].items():
        assert 0.0 <= cat["score"] <= 100.0
        assert cat["weight"] > 0
        assert "contribution" in cat
        assert "details" in cat

    assert "key_metrics" in fg
    assert "spy_price" in fg["key_metrics"]
    assert "spy_rsi" in fg["key_metrics"]


def test_api_fear_greed_endpoint(client):
    res = client.get("/api/macro/fear-greed")
    assert res.status_code == 200
    data = res.json()
    assert "composite_score" in data
    assert "categories" in data
    assert "key_metrics" in data

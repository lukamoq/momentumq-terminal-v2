"""
Unit Tests for VIX Term Structure & Contango Analytics Engine.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.vix import compute_vix_structure


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def test_compute_vix_structure(conn):
    vix = compute_vix_structure(conn)
    assert "current_state" in vix
    assert vix["current_state"] in ("Contango", "Backwardation", "Flat")
    assert "vix_proxy" in vix
    assert vix["vix_proxy"] > 0
    assert "vix_percentile" in vix
    assert 0 <= vix["vix_percentile"] <= 100
    assert "contango_ratio" in vix
    assert "interpretation" in vix
    assert len(vix["interpretation"]) > 20
    assert "history" in vix
    assert len(vix["history"]["dates"]) >= 20


def test_api_vix_structure_endpoint(client):
    res = client.get("/api/macro/vix-structure")
    assert res.status_code == 200
    data = res.json()
    assert "current_state" in data
    assert "history" in data

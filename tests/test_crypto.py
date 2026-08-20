"""Unit & Integration Tests for Crypto & Digital Assets Analytics Suite."""

import sqlite3
import pytest
from fastapi.testclient import TestClient

from scorecard.api import app
from scorecard.crypto import (
    compute_crypto_overview,
    compute_crypto_sentiment,
    compute_bitcoin_halving_cycles,
    compute_crypto_correlations,
    compute_crypto_historical_series,
)


@pytest.fixture
def memory_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    yield conn
    conn.close()


def test_compute_crypto_overview(memory_db):
    """Test crypto overview, headline dominance, and ETF metrics."""
    res = compute_crypto_overview(memory_db)
    assert "headline" in res
    assert res["headline"]["btc_dominance_pct"] > 50.0
    assert len(res["assets"]) >= 5
    assert len(res["etfs"]) >= 3

    btc = next(a for a in res["assets"] if a["ticker"] == "BTC")
    assert btc["spot"] > 50000.0
    assert btc["high_52w"] >= btc["spot"]


def test_compute_crypto_sentiment(memory_db):
    """Test 6-factor crypto fear & greed calculation."""
    res = compute_crypto_sentiment(memory_db)
    assert 0 <= res["score"] <= 100
    assert res["label"] in ["EXTREME GREED", "GREED", "NEUTRAL", "FEAR", "EXTREME FEAR"]
    assert len(res["categories"]) == 6


def test_compute_bitcoin_halving_cycles(memory_db):
    """Test 4-year halving cycle trajectory comparison."""
    res = compute_bitcoin_halving_cycles(memory_db)
    assert "active_cycle" in res
    assert len(res["historical_cycles"]) == 4
    assert res["active_cycle"]["current_multiple"] > 1.0


def test_compute_crypto_correlations(memory_db):
    """Test 10x10 cross-asset crypto correlation matrix."""
    res = compute_crypto_correlations(memory_db)
    assert len(res["tickers"]) >= 8
    assert res["matrix"]["BTC"]["BTC"] == 1.0
    assert -1.0 <= res["matrix"]["BTC"]["SPY"] <= 1.0


def test_compute_crypto_historical_series(memory_db):
    """Test historical series generation with SMAs and RSI."""
    res = compute_crypto_historical_series(memory_db, ticker="BTC", lookback_days=180)
    assert res["ticker"] == "BTC"
    assert len(res["dates"]) == 180
    assert len(res["close"]) == 180
    assert len(res["sma_50"]) == 180
    assert len(res["rsi_14"]) == 180


def test_api_crypto_endpoints():
    """Test all 5 crypto API endpoints."""
    client = TestClient(app)

    r1 = client.get("/api/crypto/overview")
    assert r1.status_code == 200
    assert "assets" in r1.json()

    r2 = client.get("/api/crypto/sentiment")
    assert r2.status_code == 200
    assert "score" in r2.json()

    r3 = client.get("/api/crypto/halving-cycles")
    assert r3.status_code == 200
    assert "historical_cycles" in r3.json()

    r4 = client.get("/api/crypto/correlations")
    assert r4.status_code == 200
    assert "matrix" in r4.json()

    r5 = client.get("/api/crypto/history?ticker=ETH&lookback=90")
    assert r5.status_code == 200
    assert len(r5.json()["dates"]) == 90

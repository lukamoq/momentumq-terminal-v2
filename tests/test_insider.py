"""Unit tests for SEC Form 4 insider trading and 13F smart money analytics."""

import sqlite3
import pytest
from fastapi.testclient import TestClient

from scorecard.api import app
from scorecard.insider import (
    init_insider_tables,
    seed_insider_tables_if_empty,
    compute_insider_sentiment_analytics,
    compute_smart_money_whales,
)


@pytest.fixture
def memory_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_insider_tables(conn)
    seed_insider_tables_if_empty(conn)
    yield conn
    conn.close()


def test_insider_tables_seeding(memory_db):
    """Test that Form 4 insider trades and 13F whale holdings seed correctly."""
    cur = memory_db.execute("SELECT count(*) as cnt FROM insider_trade")
    assert cur.fetchone()["cnt"] >= 8

    cur_w = memory_db.execute("SELECT count(*) as cnt FROM institutional_whale_holding")
    assert cur_w.fetchone()["cnt"] >= 6


def test_compute_insider_sentiment_analytics(memory_db):
    """Test insider sentiment analytics calculation and cluster signals."""
    res = compute_insider_sentiment_analytics(memory_db)

    assert "summary" in res
    assert res["summary"]["sentiment_score"] > 0
    assert res["summary"]["opportunistic_buy_dollars"] > 0
    assert res["summary"]["routine_10b5_1_sell_dollars"] > 0
    assert len(res["cluster_buy_signals"]) >= 1
    assert len(res["recent_transactions"]) >= 8

    # Test ticker filter
    nvda_res = compute_insider_sentiment_analytics(memory_db, ticker="NVDA")
    assert len(nvda_res["recent_transactions"]) >= 3
    for t in nvda_res["recent_transactions"]:
        assert t["ticker"] == "NVDA"


def test_compute_smart_money_whales(memory_db):
    """Test 13F institutional whale holdings aggregation."""
    res = compute_smart_money_whales(memory_db)

    assert res["whales_tracked_count"] >= 5
    assert len(res["consensus_overweights"]) >= 3
    assert len(res["holdings"]) >= 6

    # Verify top overweights have values
    for ow in res["consensus_overweights"]:
        assert ow["total_value_m"] > 0
        assert ow["funds_count"] >= 1


def test_api_insider_endpoints():
    """Test API endpoints for insider trading and smart money."""
    client = TestClient(app)

    res1 = client.get("/api/alpha/insider-trades")
    assert res1.status_code == 200
    data1 = res1.json()
    assert "summary" in data1
    assert "cluster_buy_signals" in data1
    assert "recent_transactions" in data1

    res2 = client.get("/api/alpha/smart-money")
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["whales_tracked_count"] >= 5
    assert len(data2["holdings"]) >= 5

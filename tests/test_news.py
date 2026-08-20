"""Unit & Integration Tests for Live News Feed & Bull/Bear Sentiment Engine."""

import sqlite3
import pytest
from fastapi.testclient import TestClient

from scorecard.api import app
from scorecard.news import (
    classify_news_item_heuristics,
    analyze_news_item,
    get_live_news_feed_analytics,
    analyze_custom_news_text,
    ingest_source_documents,
)


@pytest.fixture
def memory_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS source_document (
            id TEXT PRIMARY KEY,
            url TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            publisher TEXT,
            published_at TEXT,
            snippet TEXT,
            query_used TEXT,
            fetch_method TEXT
        )
    """)
    yield conn
    conn.close()


def test_classify_news_bullish():
    """Test classification of clearly bullish market headlines."""
    res = classify_news_item_heuristics(
        headline="NVIDIA posts record quarterly revenue surge, beating consensus estimates by 28%",
        summary="Datacenter AI GPU demand accelerates with gross margin expansion.",
        tickers=["NVDA", "TSM"]
    )
    assert res["sentiment"] == "BULLISH"
    assert res["confidence_pct"] >= 70.0
    assert res["bull_bear_score"] > 0
    assert len(res["catalysts"]) > 0


def test_classify_news_bearish():
    """Test classification of clearly bearish market headlines."""
    res = classify_news_item_heuristics(
        headline="Tech giant warns of severe revenue slump and earnings miss due to plunging consumer demand",
        summary="Company announces widespread layoffs as operating margins crash.",
        tickers=["AAPL", "AMZN"]
    )
    assert res["sentiment"] == "BEARISH"
    assert res["confidence_pct"] >= 70.0
    assert res["bull_bear_score"] < 0


def test_classify_news_neutral():
    """Test classification of neutral / routine operational updates."""
    res = classify_news_item_heuristics(
        headline="Company holds scheduled annual general meeting of shareholders in Delaware",
        summary="Shareholders vote on routine procedural committee assignments.",
        tickers=["SPY"]
    )
    assert res["sentiment"] == "NEUTRAL"
    assert res["bull_bear_score"] == 0.0


def test_get_live_news_feed_analytics():
    """Test complete live feed analytics and market barometer."""
    res = get_live_news_feed_analytics()
    assert "barometer" in res
    assert "feed" in res
    assert len(res["feed"]) >= 5
    assert res["barometer"]["total_items_analyzed"] == len(res["feed"])
    assert res["barometer"]["bullish_pct"] + res["barometer"]["bearish_pct"] + res["barometer"]["neutral_pct"] == pytest.approx(100.0, abs=1.0)


def test_analyze_custom_news_text():
    """Test interactive breaking news headline scanner."""
    res = analyze_custom_news_text("Federal Reserve signals immediate interest rate easing as inflation moderates")
    assert res["sentiment"] == "BULLISH"
    assert "SPY" in res["tickers"] or len(res["tickers"]) > 0


def test_news_api_endpoints():
    """Test GET /api/news/feed and POST /api/news/analyze endpoints."""
    client = TestClient(app)

    # Test feed endpoint
    res_feed = client.get("/api/news/feed?category=Tech")
    assert res_feed.status_code == 200
    feed_data = res_feed.json()
    assert "feed" in feed_data
    assert "barometer" in feed_data

    # Test analyze endpoint
    res_analyze = client.post("/api/news/analyze", json={
        "headline": "BlackRock Spot Bitcoin ETF breaks single-day volume record with +$1.2B institutional inflows",
        "summary": "Massive sovereign demand propels Bitcoin spot prices."
    })
    assert res_analyze.status_code == 200
    analyze_data = res_analyze.json()
    assert analyze_data["sentiment"] == "BULLISH"
    assert analyze_data["confidence_pct"] >= 75.0

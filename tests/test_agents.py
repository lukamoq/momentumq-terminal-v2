"""
Unit & Integration Tests for Gemini 3.7 Flash Autonomous Agent Desk.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.agent_engine import (
    build_system_macro_context,
    generate_agent_report,
    generate_deterministic_eow_report,
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


def test_build_system_macro_context(conn):
    ctx = build_system_macro_context(conn)
    assert "as_of_date" in ctx
    assert "macro_regime" in ctx
    assert "sentiment_fear_greed" in ctx
    assert "volatility_vix" in ctx
    assert "commodities_energy" in ctx
    assert "options_dealer_gamma" in ctx


def test_deterministic_eow_report(conn):
    ctx = build_system_macro_context(conn)
    rep = generate_deterministic_eow_report(ctx)
    assert "# MOMENTUMQ QUANTITATIVE INTELLIGENCE DOSSIER" in rep
    assert "EXECUTIVE SUMMARY" in rep
    assert "DEALER GAMMA" in rep
    assert "COMMODITIES" in rep
    assert "FEAR & GREED" in rep


def test_api_agents_status(client):
    res = client.get("/api/agents/status")
    assert res.status_code == 200
    data = res.json()
    assert data["model"] == "gemini-3.7-flash"
    assert len(data["agents"]) == 5
    agent_ids = [a["id"] for a in data["agents"]]
    assert "macro_regime" in agent_ids
    assert "options_gex" in agent_ids
    assert "commodities" in agent_ids
    assert "cio_synthesis" in agent_ids


def test_api_generate_report_endpoint(client):
    res = client.post(
        "/api/agents/generate-report",
        json={"report_type": "eow_dossier", "user_query": None},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "content" in data
    assert len(data["content"]) > 100
    assert "context_summary" in data


def test_api_agents_chat_endpoint(client):
    res = client.post(
        "/api/agents/chat",
        json={"report_type": "chat_query", "user_query": "Analyze dealer gamma wall positioning"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "content" in data

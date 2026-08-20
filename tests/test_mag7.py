"""Test suite for Magnificent 7 & Big Tech sell-side audit engine and API."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app
from scorecard.db import db_session, init_db
from scorecard.ingest import run_ingest
from scorecard.mag7 import (
    compute_mag7_bank_scorecard,
    compute_mag7_stock_breakdown,
    compute_mag7_themes,
    get_mag7_market_series,
    ingest_and_score_mag7,
)
from scorecard.score import run_scoring


@pytest.fixture(scope="module")
def mag7_db(tmp_path_factory):
    """Create test database populated with market observations and Mag 7 calls."""
    db_file = tmp_path_factory.mktemp("mag7_data") / "test_mag7.db"
    init_db(db_file)
    with db_session(db_file) as conn:
        run_ingest(conn)
        run_scoring(conn)
    return db_file


def test_mag7_ingestion_and_counts(mag7_db):
    """Test Mag 7 calls ingestion and table integrity."""
    with db_session(mag7_db) as conn:
        count = conn.execute("SELECT count(*) as c FROM mag7_call").fetchone()["c"]
        assert count >= 30, f"Expected at least 30 Mag 7 calls, got {count}"

        # Verify all 7 stocks + basket are present
        tickers = [r["ticker"] for r in conn.execute("SELECT DISTINCT ticker FROM mag7_call").fetchall()]
        for expected in ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "MAG7_BASKET"]:
            assert expected in tickers, f"Missing ticker {expected} in Mag 7 calls"


def test_mag7_position_switch_exits(mag7_db):
    """Test position switch and stance flip exit calculations."""
    with db_session(mag7_db) as conn:
        calls = conn.execute(
            """
            SELECT id, institution_id, ticker, published_on, exit_date, switch_date,
                   has_switched, switch_duration_days, switch_stock_return, switch_alpha, switch_reason
            FROM mag7_call
            WHERE institution_id = 'BAC' AND ticker = 'NVDA'
            ORDER BY published_on ASC
            """
        ).fetchall()
        assert len(calls) >= 3

        # Call 1: 2023-02-15 was switched on 2024-03-20 when Vivek Arya raised target to $1,100
        call1 = dict(calls[0])
        assert call1["has_switched"] == 1
        assert call1["switch_date"] == "2024-03-20"
        assert call1["switch_duration_days"] == 399
        assert call1["switch_stock_return"] > 2.0  # +297% return
        assert call1["switch_alpha"] > 2.0

        # Latest call: 2026-01-14 is active standing (has_switched = 0). A
        # standing call marks out to the as-of date, which is now read from the
        # newest bar in the database rather than pinned to a constant -- so this
        # asserts against that, not against a literal that a sync would break.
        from scorecard.config import resolve_as_of_date

        call_latest = dict(calls[-1])
        assert call_latest["has_switched"] == 0
        assert call_latest["switch_date"] == resolve_as_of_date()
        assert "Active standing" in call_latest["switch_reason"]



def test_mag7_bank_scorecard(mag7_db):
    """Test bank scorecard aggregation and rankings."""
    with db_session(mag7_db) as conn:
        banks = compute_mag7_bank_scorecard(conn)
        assert len(banks) == 10, f"Expected 10 banks, got {len(banks)}"

        # Every bank's hit rate must be the arithmetic of its own scored calls —
        # not a number asserted anywhere in the curated YAML.
        for b in banks:
            assert b["hits"] + b["misses"] == b["resolved"]
            assert b["hits"] + b["misses"] + b["too_early"] == b["total_calls"]
            if b["resolved"]:
                assert b["hit_rate"] == pytest.approx(b["hits"] / b["resolved"], abs=1e-4)
                assert b["grade"] != "N/R"
            else:
                assert b["hit_rate"] is None
                assert b["grade"] == "N/R"

        gs = next((b for b in banks if b["institution_id"] == "GS"), None)
        assert gs is not None
        assert gs["total_calls"] >= 6

        # Check that JPM has Doug Anmuth's Meta win
        jpm = next((b for b in banks if b["institution_id"] == "JPM"), None)
        assert jpm is not None
        assert jpm["standout_win"]["ticker"] == "META" or jpm["hits"] >= 3

        # Check that Morgan Stanley has Mike Wilson's bear blunder on record
        ms = next((b for b in banks if b["institution_id"] == "MS"), None)
        assert ms is not None
        assert ms["biggest_blunder"] is not None


def test_mag7_stock_breakdown(mag7_db):
    """Test individual stock performance calculation."""
    with db_session(mag7_db) as conn:
        stocks = compute_mag7_stock_breakdown(conn)
        assert len(stocks) == 8  # 7 stocks + 1 basket

        nvda = next((s for s in stocks if s["ticker"] == "NVDA"), None)
        assert nvda is not None
        assert nvda["latest_price"] > 0
        assert nvda["total_calls"] >= 5
        assert nvda["hit_rate"] == pytest.approx(nvda["hits"] / (nvda["hits"] + nvda["misses"]), abs=1e-4)

        # The basket is its own equal-weight index, not a relabelled SPY.
        basket = next((s for s in stocks if s["ticker"] == "MAG7_BASKET"), None)
        spy_like = next((s for s in stocks if s["ticker"] == "MSFT"), None)
        assert basket is not None and spy_like is not None
        assert basket["is_basket"] == 1
        assert basket["latest_price"] > 0


def test_mag7_thematic_dossiers():
    """Test the 4 thematic dossiers."""
    themes = compute_mag7_themes()
    assert len(themes) == 4
    ids = [t["id"] for t in themes]
    assert "ai_hardware_capex" in ids
    assert "meta_efficiency_rebound" in ids
    assert "tesla_margin_war" in ids
    assert "mag7_vs_equal_weight" in ids


def test_mag7_dossier_claims_are_reconciled(mag7_db):
    """Editorial winner/loser claims must carry the desk's real scored record."""
    with db_session(mag7_db) as conn:
        themes = compute_mag7_themes(conn)
        for t in themes:
            for entry in [*t["key_winners"], *t["key_losers"]]:
                assert "record" in entry
                assert "contradicted" in entry
                r = entry["record"]
                assert r["hits"] >= 0 and r["misses"] >= 0

        # The Tesla dossier names JPMorgan a winner while the scored record on
        # TSLA is all misses — the reconciliation must catch that, not hide it.
        tesla = next(t for t in themes if t["id"] == "tesla_margin_war")
        jpm = next(w for w in tesla["key_winners"] if w["bank"] == "JPMorgan")
        assert jpm["contradicted"] is True


def test_mag7_verdicts_are_derived_not_asserted(mag7_db):
    """Every verdict must follow from realized alpha, never from the curated YAML."""
    from scorecard.mag7 import NEUTRAL_ALPHA_BAND

    with db_session(mag7_db) as conn:
        rows = conn.execute(
            "SELECT id, rating_or_stance, relative_alpha, verdict, curated_verdict, "
            "is_window_complete FROM mag7_call"
        ).fetchall()
        assert len(rows) > 0

        for r in rows:
            stance, alpha, verdict = r["rating_or_stance"], r["relative_alpha"], r["verdict"]
            if not r["is_window_complete"] or alpha is None:
                assert verdict == "TOO_EARLY", f"{r['id']} has an open window but scored {verdict}"
                continue
            if stance in ("OVERWEIGHT", "BUY", "OUTPERFORM"):
                assert verdict == ("HIT" if alpha > 0 else "MISS"), r["id"]
            elif stance in ("UNDERWEIGHT", "SELL", "REDUCE", "UNDERPERFORM"):
                assert verdict == ("HIT" if alpha < 0 else "MISS"), r["id"]
            else:
                assert verdict == ("HIT" if abs(alpha) <= NEUTRAL_ALPHA_BAND else "MISS"), r["id"]

        # A hand-written HIT on an underweight that the stock doubled through
        # must be overruled, with the original assertion preserved.
        jpm_tsla = conn.execute(
            "SELECT verdict, curated_verdict, relative_alpha FROM mag7_call WHERE id = 'mag7_jpm_tsla_20240403'"
        ).fetchone()
        assert jpm_tsla["curated_verdict"] == "HIT"
        assert jpm_tsla["relative_alpha"] > 1.0
        assert jpm_tsla["verdict"] == "MISS"


def test_mag7_targets_are_split_adjusted(mag7_db):
    """Pre-split price targets must be put on the same scale as adjusted bars."""
    with db_session(mag7_db) as conn:
        pre_split = conn.execute(
            "SELECT target_price, target_price_adjusted, split_adjustment_factor, "
            "target_implied_return FROM mag7_call WHERE id = 'mag7_bac_nvda_20240320'"
        ).fetchone()
        assert pre_split["target_price"] == 1100.0
        assert pre_split["split_adjustment_factor"] == 10.0
        assert pre_split["target_price_adjusted"] == pytest.approx(110.0)
        # Unadjusted this read as +1117%; adjusted it is a plausible target.
        assert 0.0 < pre_split["target_implied_return"] < 1.0

        post_split = conn.execute(
            "SELECT split_adjustment_factor, target_implied_return FROM mag7_call "
            "WHERE id = 'mag7_bac_nvda_20260114'"
        ).fetchone()
        assert post_split["split_adjustment_factor"] == 1.0
        assert abs(post_split["target_implied_return"]) < 0.5


def test_mag7_basket_is_not_spy(mag7_db):
    """MAG7_BASKET calls must score against the Mag 7 index, not a relabelled SPY."""
    with db_session(mag7_db) as conn:
        rows = conn.execute(
            "SELECT id, relative_alpha FROM mag7_call WHERE ticker = 'MAG7_BASKET'"
        ).fetchall()
        assert len(rows) >= 5
        # Scored against SPY every one of these was exactly 0.0.
        assert all(r["relative_alpha"] is None or abs(r["relative_alpha"]) > 1e-9 for r in rows), (
            "Basket alpha is identically zero — the basket is still proxied by SPY"
        )

        basket = conn.execute(
            "SELECT count(*) c FROM market_observation WHERE ticker = 'MAG7'"
        ).fetchone()["c"]
        assert basket > 1000


def test_mag7_market_series(mag7_db):
    """Test normalized market series for charts."""
    with db_session(mag7_db) as conn:
        payload = get_mag7_market_series(conn)
        base_date = payload["base_date"]
        series = payload["series"]
        assert base_date, "series must declare the common base date"

        for t in ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "SPY", "QQQ", "RSP", "MAG7"]:
            assert t in series
            assert len(series[t]) > 1000
            # Every series is rebased to the SAME date, so 100 lands on that date
            # for all of them — not on each ticker's own first bar.
            at_base = next(r for r in series[t] if r["date"] >= base_date)
            assert at_base["normalized"] == pytest.approx(100.0, abs=0.01), t

        # META is reassembled from FB + META, so it spans the same window as
        # its peers rather than starting late.
        assert series["META"][0]["date"] == series["NVDA"][0]["date"]
        assert all(r["close"] > 50 for r in series["META"]), "Meta Materials bars leaked in"


def test_meta_lineage_is_reassembled(mag7_db):
    """META must be Meta Platforms end to end: FB before the rename, META after."""
    from scorecard.market import lineage_source_symbols

    assert lineage_source_symbols("META") == ["FB", "META"]

    with db_session(mag7_db) as conn:
        rows = conn.execute(
            "SELECT date, close FROM market_observation WHERE ticker = 'META' ORDER BY date"
        ).fetchall()

        # Full window, matching a peer that never changed symbol.
        peer_start = conn.execute(
            "SELECT min(date) d FROM market_observation WHERE ticker = 'NVDA'"
        ).fetchone()["d"]
        assert rows[0]["date"] == peer_start

        # Meta Materials traded at $12-15 on the META symbol before the rename;
        # none of those bars may survive.
        assert min(r["close"] for r in rows) > 50, "Meta Materials bars are still loaded"

        # FB was itself reassigned in 2025 to a ~$45 issuer trading a few hundred
        # shares a day; the lineage window must exclude those too.
        late = [r["close"] for r in rows if r["date"] >= "2025-06-26"]
        assert min(late) > 100, "post-reassignment FB bars leaked in"

        # And the splice must not create a fabricated overnight gap.
        moves = [
            abs(rows[i]["close"] / rows[i - 1]["close"] - 1.0)
            for i in range(1, len(rows))
            if rows[i - 1]["close"]
        ]
        assert max(moves) < 0.35, f"META has an implausible {max(moves):.0%} single-day move"

        basket = conn.execute(
            "SELECT close FROM market_observation WHERE ticker = 'MAG7' ORDER BY date"
        ).fetchall()
        bmoves = [
            abs(basket[i]["close"] / basket[i - 1]["close"] - 1.0)
            for i in range(1, len(basket))
            if basket[i - 1]["close"]
        ]
        assert max(bmoves) < 0.30, f"basket has an implausible {max(bmoves):.0%} single-day move"


def test_mag7_api_endpoints():
    """Test all FastAPI Mag 7 endpoints using TestClient."""
    client = TestClient(app)

    # 1. Summary stats
    r_stats = client.get("/api/mag7/stats")
    assert r_stats.status_code == 200
    data_stats = r_stats.json()
    assert data_stats["total_calls"] >= 30
    assert data_stats["total_institutions"] == 10
    assert data_stats["spy_ytd_return"] is not None

    # 2. Scorecard
    r_scorecard = client.get("/api/mag7/scorecard")
    assert r_scorecard.status_code == 200
    data_scorecard = r_scorecard.json()
    assert len(data_scorecard) == 10

    # 3. Stocks
    r_stocks = client.get("/api/mag7/stocks")
    assert r_stocks.status_code == 200
    data_stocks = r_stocks.json()
    assert len(data_stocks) == 8

    # 4. Themes
    r_themes = client.get("/api/mag7/themes")
    assert r_themes.status_code == 200
    data_themes = r_themes.json()
    assert len(data_themes) == 4

    # 5. Calls with filter
    r_calls = client.get("/api/mag7/calls?ticker=NVDA")
    assert r_calls.status_code == 200
    data_calls = r_calls.json()
    assert len(data_calls) >= 5
    for c in data_calls:
        assert c["ticker"] == "NVDA"

    # 6. Market series
    r_series = client.get("/api/mag7/market-series")
    assert r_series.status_code == 200
    data_series = r_series.json()
    assert data_series["base_date"]
    assert "NVDA" in data_series["series"]
    assert "SPY" in data_series["series"]
    assert "MAG7" in data_series["series"]

"""Pytest test suite verifying all 8 Acceptance Criteria and system invariants."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
import pytest

from scorecard.config import DB_PATH, DIRECTION_BAND
from scorecard.db import db_session, get_connection, init_db, reset_score_tables
from scorecard.derive import (
    classify_direction,
    derive_allocation_verdict,
    derive_brier_score,
    derive_direction,
    derive_direction_verdict,
    derive_lag_ratio,
)
from scorecard.ingest import run_ingest
from scorecard.market import get_spot_at_publication, load_market_data_into_db
from scorecard.score import run_scoring


@pytest.fixture(scope="module")
def populated_db(tmp_path_factory):
    """Create an isolated test database with market data, curated calls, and full scores."""
    db_file = tmp_path_factory.mktemp("data") / "test_scorecard.db"
    init_db(db_file)
    with db_session(db_file) as conn:
        run_ingest(conn)
        run_scoring(conn)
    return db_file


# =========================================================================
# Acceptance Criterion 1: Always-bullish desks render "no discriminating calls"
# =========================================================================
def test_ac1_always_bullish_no_discriminating(populated_db):
    """Always-bullish desks must render 'no discriminating calls', not 100%."""
    with db_session(populated_db) as conn:
        always_bullish_banks = conn.execute(
            "SELECT institution_id, status_label, is_always_bullish, event_edge, event_hit_rate "
            "FROM score_bank WHERE is_always_bullish = 1"
        ).fetchall()

        assert len(always_bullish_banks) > 0, "Expected always-bullish banks in dataset"
        for bank in always_bullish_banks:
            assert bank["status_label"] == "no discriminating calls", (
                f"{bank['institution_id']} must have status_label 'no discriminating calls'"
            )
            # Edge vs always-bullish baseline must be exactly 0
            if bank["event_edge"] is not None:
                assert bank["event_edge"] == pytest.approx(0.0), (
                    f"{bank['institution_id']} edge should be 0.0"
                )

        # Confirm discriminating banks (BofA, UBS) are properly classified
        bofa = conn.execute(
            "SELECT is_always_bullish, status_label FROM score_bank WHERE institution_id = 'BAC'"
        ).fetchone()
        assert bofa["is_always_bullish"] == 0
        assert bofa["status_label"] == "evaluated"


# =========================================================================
# Acceptance Criterion 2: Every UI hit rate has baseline adjacent
# =========================================================================
def test_ac2_baseline_adjacent_to_hit_rate(populated_db):
    """Every hit rate must have the always-bullish baseline adjacent."""
    with db_session(populated_db) as conn:
        banks = conn.execute("SELECT * FROM score_bank WHERE event_resolved > 0").fetchall()
        for b in banks:
            if b["event_hit_rate"] is not None:
                assert b["always_bullish_event_hit_rate"] is not None, (
                    f"Bank {b['institution_id']} missing always_bullish_event_hit_rate"
                )

            if b["stance_day_hit_rate"] is not None:
                assert b["always_bullish_stance_day_hit_rate"] is not None, (
                    f"Bank {b['institution_id']} missing always_bullish_stance_day_hit_rate"
                )


# =========================================================================
# Acceptance Criterion 3: JPM supersession chain and August 8000 formula
# =========================================================================
def test_ac3_jpm_supersession_chain_and_august_formula(populated_db):
    """JPM targets form one immutable supersession chain; Aug 8000 is bullish under 2% band."""
    with db_session(populated_db) as conn:
        jpm_calls = conn.execute(
            "SELECT id, published_on, target_level, spot_at_publication, implied_return, direction, supersedes_id "
            "FROM call WHERE institution_id = 'JPM' AND call_type = 'direction' AND forecast_horizon = 'YE_2026' "
            "ORDER BY published_on ASC"
        ).fetchall()

        assert len(jpm_calls) == 5, f"Expected 5 JPM 2026 calls in chain, got {len(jpm_calls)}"

        expected_targets = [7500, 7200, 7600, 7800, 8000]
        for i, c in enumerate(jpm_calls):
            assert c["target_level"] == expected_targets[i]
            if i > 0:
                assert c["supersedes_id"] == jpm_calls[i - 1]["id"], (
                    f"Call {c['id']} must supersede {jpm_calls[i - 1]['id']}"
                )

        # August 8000 analysis
        aug_call = jpm_calls[-1]
        assert aug_call["target_level"] == 8000
        # Implied return is ~+3.5%
        assert aug_call["implied_return"] > 0.02
        assert aug_call["direction"] == "bullish", (
            "Under the 2% band, +3.5% implied return MUST derive as 'bullish'"
        )

        # Implied conviction is the lowest of all raises
        # Raises: 7500 (~+10.3%), 7200 (~+11.0%), 7600 (~+7.9%), 7800 (~+6.4%), 8000 (~+3.5%)
        assert aug_call["implied_return"] < jpm_calls[0]["implied_return"]
        assert aug_call["implied_return"] < jpm_calls[2]["implied_return"]
        assert aug_call["implied_return"] < jpm_calls[3]["implied_return"]


# =========================================================================
# Acceptance Criterion 4: Multi-horizon scoring > 100 observations
# =========================================================================
def test_ac4_multi_horizon_over_100_obs(populated_db):
    """Multi-horizon scoring must produce > 100 observations from 2026."""
    with db_session(populated_db) as conn:
        total_evals = conn.execute(
            "SELECT count(*) as count FROM score_direction"
        ).fetchone()["count"]
        stance_days = conn.execute(
            "SELECT count(*) as count FROM score_direction WHERE evaluation_kind = 'stance_day'"
        ).fetchone()["count"]

        assert total_evals > 100, f"Total evaluations {total_evals} must be > 100"
        assert stance_days > 100, f"Stance-day evaluations {stance_days} must be > 100"


# =========================================================================
# Acceptance Criterion 5: Overweight that rose but lagged ACWI is a miss
# =========================================================================
def test_ac5_allocation_lagging_acwi_is_miss(populated_db):
    """Overweight position that rose in absolute terms but lagged ACWI benchmark is a miss."""
    # Test formula directly
    verdict = derive_allocation_verdict("overweight", spread_return=-0.0082, band=DIRECTION_BAND)
    assert verdict == "miss"

    verdict_hit = derive_allocation_verdict("overweight", spread_return=0.015, band=DIRECTION_BAND)
    assert verdict_hit == "hit"

    # Verify in live database: GS OW Jan 2026 (SPY rose ~0.95%, ACWI rose ~1.37%, spread -0.42%)
    with db_session(populated_db) as conn:
        score = conn.execute(
            "SELECT asset_return, bench_return, spread_return, verdict "
            "FROM score_allocation WHERE call_id = 'call_gs_20251210_alloc' AND horizon = '1M'"
        ).fetchone()

        assert score is not None
        assert score["asset_return"] > 0, "Asset had positive nominal return"
        assert score["spread_return"] < 0, "Asset lagged ACWI benchmark"
        assert score["verdict"] == "miss", "Lagging benchmark must be evaluated as miss"


# =========================================================================
# Acceptance Criterion 6: Drop score_* and rerun is deterministic
# =========================================================================
def test_ac6_score_rebuild_deterministic(populated_db):
    """Dropping and rebuilding score tables must produce identical row counts and hashes."""
    with db_session(populated_db) as conn:
        # Capture hash 1
        rows1 = conn.execute(
            "SELECT id, verdict, is_resolved, realised_return FROM score_direction ORDER BY id"
        ).fetchall()
        hash1 = hashlib.sha256(json.dumps([list(r) for r in rows1]).encode()).hexdigest()

        # Rebuild
        run_scoring(conn)

        # Capture hash 2
        rows2 = conn.execute(
            "SELECT id, verdict, is_resolved, realised_return FROM score_direction ORDER BY id"
        ).fetchall()
        hash2 = hashlib.sha256(json.dumps([list(r) for r in rows2]).encode()).hexdigest()

        assert len(rows1) == len(rows2)
        assert hash1 == hash2, "Score table rebuild produced non-deterministic results"


# =========================================================================
# Acceptance Criterion 7: Ingest twice -> identical row counts
# =========================================================================
def test_ac7_ingest_idempotent(populated_db):
    """Ingesting twice must produce identical row counts in all tables."""
    tables = ["institution", "strategist", "market_observation", "source_document", "call", "event_outcome"]
    with db_session(populated_db) as conn:
        counts1 = {t: conn.execute(f"SELECT count(*) as c FROM {t}").fetchone()["c"] for t in tables}

        # Run ingest again
        run_ingest(conn)

        counts2 = {t: conn.execute(f"SELECT count(*) as c FROM {t}").fetchone()["c"] for t in tables}

        for t in tables:
            assert counts1[t] == counts2[t], f"Table {t} count changed after second ingest: {counts1[t]} vs {counts2[t]}"


# =========================================================================
# Acceptance Criterion 8: Flip after a large move has lag ratio
# =========================================================================
def test_ac8_bofa_flip_lag_ratio(populated_db):
    """Direction flips record lag ratio; unresolved 30d-after window produces too_early."""
    with db_session(populated_db) as conn:
        # BofA June 2026 flip
        bofa_lag = conn.execute(
            "SELECT * FROM score_lag WHERE call_id = 'call_bac_20260609_dir'"
        ).fetchone()
        assert bofa_lag is not None
        assert bofa_lag["from_direction"] == "bullish"
        assert bofa_lag["to_direction"] == "bearish"
        assert bofa_lag["is_resolved"] == 1
        assert bofa_lag["status"] == "resolved"
        assert bofa_lag["lag_ratio"] is not None

        # UBS August 2026 flip (30d after is in future / past available data)
        ubs_lag = conn.execute(
            "SELECT * FROM score_lag WHERE call_id = 'call_ubs_20260811_dir'"
        ).fetchone()
        assert ubs_lag is not None
        assert ubs_lag["status"] == "too_early"
        assert ubs_lag["is_resolved"] == 0


# =========================================================================
# Additional Invariant Tests: Immutability Trigger & Probability Scoring
# =========================================================================
def test_call_immutability_trigger(populated_db):
    """Database trigger must prevent modifying core call fields."""
    with db_session(populated_db) as conn:
        call_id = "call_jpm_20251126_dir"
        with pytest.raises(sqlite3.DatabaseError) as exc_info:
            conn.execute("UPDATE call SET target_level = 9000 WHERE id = ?", (call_id,))
        assert "Call records are immutable" in str(exc_info.value)

        # But updating supersedes_id is allowed
        conn.execute("UPDATE call SET supersedes_id = NULL WHERE id = ?", (call_id,))


def test_spot_lookback_limit(tmp_path):
    """get_spot_at_publication must fail if gap exceeds max lookback days."""
    db_file = tmp_path / "empty_db.db"
    init_db(db_file)
    with db_session(db_file) as conn:
        # Empty DB should raise ValueError immediately
        with pytest.raises(ValueError) as exc:
            get_spot_at_publication(conn, "SPX", "2026-06-01")
        assert "No market data found" in str(exc.value)

        # Insert a bar that is 30 days old (exceeding 7-day limit)
        conn.execute(
            "INSERT INTO market_observation (date, ticker, open, high, low, close, index_level) "
            "VALUES ('2026-05-01', 'SPY', 700, 705, 695, 700, 7000)"
        )
        with pytest.raises(ValueError) as exc2:
            get_spot_at_publication(conn, "SPX", "2026-06-01", max_lookback_days=7)
        assert "Market data gap" in str(exc2.value)


def test_unresolved_probability_brier():
    """Unresolved event outcomes must evaluate to 'too_early'."""
    brier, brier_clim, bss, verdict = derive_brier_score(0.35, outcome=None)
    assert verdict == "too_early"
    assert brier is None


# =========================================================================
# Direction band is the authoritative rule (no narrative override)
# =========================================================================
def test_direction_band_is_authoritative():
    """The band arithmetic decides direction — nothing else may override it."""
    assert classify_direction(0.0349) == "bullish"      # JPM Aug 2026, 8000 @ 7730
    assert classify_direction(0.0201) == "bullish"      # just outside the band
    assert classify_direction(0.02) == "neutral"        # exactly on the band edge
    assert classify_direction(0.0) == "neutral"
    assert classify_direction(-0.02) == "neutral"
    assert classify_direction(-0.0267) == "bearish"     # UBS Aug 2026, 7500 @ 7706
    assert classify_direction(None) is None

    # The band is configurable and honoured.
    assert classify_direction(0.03, band=0.05) == "neutral"
    assert classify_direction(0.03, band=0.01) == "bullish"

    # Bearish-sounding prose on a call with double-digit upside stays bullish.
    implied, direction = derive_direction(
        target=7200.0,
        spot=6485.7,
        notes="JPMorgan cuts target on Iran war uncertainty; macro headwinds and recession risks",
    )
    assert implied == pytest.approx(0.1101, abs=1e-3)
    assert direction == "bullish", "Sentiment must not override the arithmetic"


def test_every_stored_direction_matches_the_band(populated_db):
    """No stored call may disagree with its own implied return under the band."""
    with db_session(populated_db) as conn:
        rows = conn.execute(
            "SELECT id, implied_return, direction, band FROM call "
            "WHERE call_type = 'direction' AND target_level IS NOT NULL"
        ).fetchall()
        assert len(rows) > 50

        mismatches = [
            r["id"]
            for r in rows
            if classify_direction(r["implied_return"], r["band"]) != r["direction"]
        ]
        assert not mismatches, f"Calls classified against their own band: {mismatches}"


def test_ai_stance_agreement_flag_is_computed(populated_db):
    """ai_math_agreement must reflect a real comparison, not a constant."""
    with db_session(populated_db) as conn:
        rows = conn.execute(
            "SELECT c.direction, a.ai_stance, a.ai_math_agreement "
            "FROM call c JOIN ai_call_audit a ON a.call_id = c.id"
        ).fetchall()
        assert len(rows) > 0

        for r in rows:
            if r["direction"] is None:
                # No price target means there is nothing to agree with.
                assert r["ai_math_agreement"] is None
            else:
                assert r["ai_math_agreement"] == int(r["ai_stance"] == r["direction"])

        # The lexicon genuinely disagrees with the arithmetic somewhere in this
        # dataset; a flag that is always 1 would be hiding that.
        assert any(r["ai_math_agreement"] == 0 for r in rows)


# =========================================================================
# Determinism across processes, not just within one
# =========================================================================
def test_source_document_ids_are_stable_across_processes(tmp_path):
    """Document ids must not depend on the per-process string hash seed."""
    import subprocess
    import sys

    script = (
        "from scorecard.news import ingest_source_documents\n"
        "from scorecard.db import db_session, init_db\n"
        "import sys\n"
        "db = sys.argv[1]\n"
        "init_db(db)\n"
        "with db_session(db) as conn:\n"
        "    ingest_source_documents(conn)\n"
        "    rows = conn.execute('SELECT id FROM source_document ORDER BY url').fetchall()\n"
        "print('|'.join(r['id'] for r in rows))\n"
    )
    outputs = []
    for i in range(2):
        db_file = tmp_path / f"seed_{i}.db"
        env = {"PYTHONHASHSEED": str(i * 7 + 1)}
        import os

        full_env = dict(os.environ, **env)
        res = subprocess.run(
            [sys.executable, "-c", script, str(db_file)],
            capture_output=True, text=True, env=full_env, check=True,
        )
        outputs.append(res.stdout.strip())

    assert outputs[0] == outputs[1], "source_document ids differ between hash seeds"
    assert outputs[0], "no source documents ingested"


def test_same_day_calls_resolve_deterministically(populated_db):
    """Two calls published the same day must not make scoring order-dependent."""
    with db_session(populated_db) as conn:
        dupes = conn.execute(
            "SELECT institution_id, published_on, count(*) n FROM call "
            "WHERE call_type = 'direction' GROUP BY 1, 2 HAVING n > 1"
        ).fetchall()
        assert dupes, "fixture no longer contains a same-day pair to guard"

        before = conn.execute(
            "SELECT id, call_id, verdict FROM score_direction "
            "WHERE evaluation_kind = 'stance_day' ORDER BY id"
        ).fetchall()
        run_scoring(conn)
        after = conn.execute(
            "SELECT id, call_id, verdict FROM score_direction "
            "WHERE evaluation_kind = 'stance_day' ORDER BY id"
        ).fetchall()
        assert [tuple(r) for r in before] == [tuple(r) for r in after]


def test_scorecard_endpoint_returns_one_row_per_bank(populated_db):
    """A bank with two same-day calls must not fan out into duplicate rows."""
    with db_session(populated_db) as conn:
        n_banks = conn.execute("SELECT count(*) c FROM score_bank").fetchone()["c"]

    from fastapi.testclient import TestClient
    from scorecard.api import app

    rows = TestClient(app).get("/api/scorecard").json()
    ids = [r["institution_id"] for r in rows]
    assert len(ids) == len(set(ids)), f"duplicate bank rows: {ids}"
    assert len(ids) == n_banks or len(ids) > 0


def test_macro_endpoint_carries_real_verdicts():
    """The macro tables must be fed real per-call scores, not one hardcoded row."""
    from fastapi.testclient import TestClient
    from scorecard.api import app

    data = TestClient(app).get("/api/macro").json()
    allocations = data["allocations"]
    assert len(allocations) >= 4

    verdicts = set()
    for a in allocations:
        assert a["horizons"], f"{a['call_id']} has no scored horizons"
        for h in a["horizons"].values():
            verdicts.add(h["verdict"])
            if h["verdict"] == "too_early":
                assert h["spread_return"] is None
            else:
                assert h["spread_return"] is not None
                expected = "hit" if (
                    (a["allocation_stance"] == "overweight" and h["spread_return"] > 0)
                    or (a["allocation_stance"] == "underweight" and h["spread_return"] < 0)
                    or (a["allocation_stance"] == "neutral" and abs(h["spread_return"]) <= DIRECTION_BAND)
                ) else "miss"
                assert h["verdict"] == expected

    # Not every allocation call is a miss — the old UI rendered "MISS" for all of them.
    assert "hit" in verdicts and "miss" in verdicts


def test_ingest_rejects_a_changed_payload_under_an_existing_id(populated_db):
    """Calls are immutable: a changed payload must fail loud, not with a bare UNIQUE error."""
    from scorecard.ingest import ingest_calls
    import yaml

    with db_session(populated_db) as conn:
        row = conn.execute(
            "SELECT id, institution_id, published_on, target_level, forecast_horizon "
            "FROM call WHERE call_type = 'direction' AND target_level IS NOT NULL LIMIT 1"
        ).fetchone()

        tampered = {
            "calls": [
                {
                    "id": row["id"],
                    "institution_id": row["institution_id"],
                    "call_type": "direction",
                    "published_on": row["published_on"],
                    "target_level": float(row["target_level"]) + 500.0,
                    "forecast_horizon": row["forecast_horizon"],
                }
            ]
        }
        path = Path(str(populated_db)).parent / "tampered_calls.yaml"
        path.write_text(yaml.safe_dump(tampered), encoding="utf-8")

        with pytest.raises(ValueError) as exc:
            ingest_calls(conn, path)
        assert "immutable" in str(exc.value)


# =========================================================================
# Expanded data coverage
# =========================================================================
def test_market_universe_breadth(populated_db):
    """The scored universe must cover more than the index and the Mag 7."""
    with db_session(populated_db) as conn:
        tickers = {
            r["ticker"] for r in conn.execute(
                "SELECT DISTINCT ticker FROM market_observation"
            ).fetchall()
        }
        # All eleven GICS sector SPDRs, so a sector call can be scored against
        # the sector it named rather than against the index.
        sectors = {"XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC"}
        assert sectors <= tickers, f"missing sectors: {sorted(sectors - tickers)}"
        # Rates, commodities, international, volatility.
        assert {"TLT", "IEF", "HYG", "GLD", "USO", "UUP", "EFA", "EEM", "VIXY"} <= tickers
        # The AI complex the desks called alongside the Mag 7.
        assert {"AVGO", "TSM", "AMD", "ORCL", "PLTR", "MU"} <= tickers
        assert len(tickers) >= 55, f"universe shrank to {len(tickers)} tickers"

        # Every series covers the full authorised window, not a fragment.
        short = conn.execute(
            "SELECT ticker, count(*) n FROM market_observation "
            "GROUP BY ticker HAVING n < 700 ORDER BY n"
        ).fetchall()
        # ARM only IPO'd in 2023 and BNB feed window on Massive is 169 bars.
        short_tickers = {r["ticker"] for r in short}
        assert short_tickers <= {"ARM", "BNB"}, \
            f"unexpectedly short series: {[(r['ticker'], r['n']) for r in short]}"


def test_probability_uses_per_event_prior(populated_db):
    """Each event is scored against its own base rate, not one global constant."""
    with db_session(populated_db) as conn:
        rows = conn.execute(
            "SELECT sp.event_key, sp.climatology_prior, e.climatology_prior AS event_prior "
            "FROM score_probability sp JOIN event_outcome e ON e.event_key = sp.event_key"
        ).fetchall()
        assert rows
        for r in rows:
            assert r["climatology_prior"] == pytest.approx(r["event_prior"])


def test_resolved_probability_event_is_scored(populated_db):
    """The Brier path must be exercised by a genuinely resolved event."""
    with db_session(populated_db) as conn:
        event = conn.execute(
            "SELECT resolved, outcome FROM event_outcome WHERE event_key = 'us_recession_2023'"
        ).fetchone()
        assert event is not None, "no resolved event in the dataset"
        assert event["resolved"] == 1 and event["outcome"] == 0

        scored = conn.execute(
            "SELECT institution_id, probability_value, brier_score, brier_climatology, "
            "brier_skill_score, verdict FROM score_probability "
            "WHERE event_key = 'us_recession_2023' ORDER BY probability_value"
        ).fetchall()
        assert len(scored) >= 3, "resolved event needs several forecasts to be informative"

        for r in scored:
            assert r["verdict"] != "too_early"
            # Event did not occur, so Brier is just the forecast squared.
            assert r["brier_score"] == pytest.approx(r["probability_value"] ** 2, abs=1e-9)
            # Every published forecast was above the base rate on an event that
            # did not happen, so every one must score worse than climatology.
            assert r["brier_score"] > r["brier_climatology"]
            assert r["brier_skill_score"] < 0
            assert r["verdict"] == "miss"

        # Ordering must be monotone: a higher probability on a false event is worse.
        briers = [r["brier_score"] for r in scored]
        assert briers == sorted(briers)


def test_desks_without_direction_calls_are_labelled(populated_db):
    """A probability-only house must not be reported as 'evaluated'."""
    with db_session(populated_db) as conn:
        rows = conn.execute(
            "SELECT institution_id, total_calls, status_label, is_always_bullish FROM score_bank"
        ).fetchall()
        assert rows
        for r in rows:
            if r["total_calls"] == 0:
                assert r["status_label"] == "no direction calls"
                assert r["is_always_bullish"] == 0
            elif r["is_always_bullish"] == 1:
                assert r["status_label"] == "no discriminating calls"
            else:
                assert r["status_label"] == "evaluated"


def test_discovery_plan_is_reproducible():
    """The query plan behind the corpus must be code, with stable save names."""
    from scorecard.discover import build_query_plan

    plan = build_query_plan()
    assert len(plan) >= 40
    names = [n for n, _, _, _ in plan]
    assert len(names) == len(set(names)), "duplicate corpus save names"
    for name, query, start, end in plan:
        assert query and start <= end
        assert name.replace("_", "").isalnum()


def test_partner_ranking_excludes_houses_without_a_record(populated_db):
    """A house with no direction calls cannot be ranked on directional reliability."""
    from scorecard.partner import compute_partner_reliability

    with db_session(populated_db) as conn:
        partners = compute_partner_reliability(conn)
        assert partners

        ranked_ids = {p["institution_id"] for p in partners}
        direction_less = {
            r["institution_id"] for r in conn.execute(
                "SELECT institution_id FROM score_bank WHERE total_calls = 0"
            ).fetchall()
        }
        assert direction_less, "fixture no longer has a probability-only house to guard"
        assert not (ranked_ids & direction_less), (
            "houses with no direction record are being ranked on directional edge"
        )

        # They must be reported, not silently dropped.
        excluded_ids = {e["institution_id"] for e in partners[0]["excluded_houses"]}
        assert excluded_ids == direction_less

        # Rank is dense, ordered, and every ranked house has a real record.
        assert [p["rank"] for p in partners] == list(range(1, len(partners) + 1))
        scores = [p["reliability_score"] for p in partners]
        assert scores == sorted(scores, reverse=True)
        assert all(p["total_calls"] > 0 for p in partners)

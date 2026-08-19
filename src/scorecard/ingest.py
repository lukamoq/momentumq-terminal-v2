"""Idempotent ingestion pipeline for market data, curated calls, and sources."""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
import yaml

from scorecard.config import (
    CLIMATOLOGY_RECESSION_PRIOR,
    CURATED_DIR,
    DIRECTION_BAND,
    SPY_PROXY_MULTIPLIER,
)
from scorecard.derive import derive_direction, make_call_idempotency_key
from scorecard.market import get_spot_at_publication, load_market_data_into_db
from scorecard.news import ingest_source_documents

logger = logging.getLogger(__name__)


def load_yaml(path: Path) -> Dict[str, Any]:
    """Safely load a YAML file."""
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def ingest_institutions(conn: sqlite3.Connection, yaml_path: Optional[Path] = None) -> int:
    """Ingest institutions and strategists from curated YAML."""
    path = yaml_path or (CURATED_DIR / "institutions.yaml")
    if not path.exists():
        logger.warning(f"Institutions file not found: {path}")
        return 0

    data = load_yaml(path)
    count = 0

    for inst in data.get("institutions", []):
        conn.execute(
            """
            INSERT INTO institution (id, name, full_name, website, notes)
            VALUES (:id, :name, :full_name, :website, :notes)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                full_name = excluded.full_name,
                website = excluded.website,
                notes = excluded.notes
            """,
            inst,
        )
        count += 1

    for strat in data.get("strategists", []):
        strat_id = strat["id"]
        name = strat["name"]
        title = strat.get("title")
        inst_id = strat.get("institution_id")

        conn.execute(
            """
            INSERT INTO strategist (id, name, title)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                title = excluded.title
            """,
            (strat_id, name, title),
        )

        if inst_id:
            conn.execute(
                """
                INSERT INTO strategist_affiliation (strategist_id, institution_id, start_date)
                VALUES (?, ?, ?)
                ON CONFLICT(strategist_id, institution_id, start_date) DO NOTHING
                """,
                (strat_id, inst_id, "2025-01-01"),
            )

    return count


def ingest_events(conn: sqlite3.Connection, yaml_path: Optional[Path] = None) -> int:
    """Ingest binary probability events and outcomes."""
    path = yaml_path or (CURATED_DIR / "events.yaml")
    if not path.exists():
        logger.warning(f"Events file not found: {path}")
        return 0

    data = load_yaml(path)
    count = 0
    for evt in data.get("events", []):
        conn.execute(
            """
            INSERT INTO event_outcome (
                event_key, name, description, climatology_prior,
                resolved, outcome, resolved_on, notes
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_key) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                climatology_prior = excluded.climatology_prior,
                resolved = excluded.resolved,
                outcome = excluded.outcome,
                resolved_on = excluded.resolved_on,
                notes = excluded.notes
            """,
            (
                evt["event_key"],
                evt.get("name"),
                evt.get("description"),
                float(evt.get("climatology_prior", CLIMATOLOGY_RECESSION_PRIOR)),
                int(evt.get("resolved", 0)),
                evt.get("outcome"),
                evt.get("resolved_on"),
                evt.get("notes"),
            ),
        )
        count += 1
    return count


def ingest_calls(conn: sqlite3.Connection, yaml_path: Optional[Path] = None) -> int:
    """Ingest curated calls, derive directions from exact spot prices, and link supersessions."""
    path = yaml_path or (CURATED_DIR / "calls.yaml")
    if not path.exists():
        logger.warning(f"Calls file not found: {path}")
        return 0

    data = load_yaml(path)
    calls_list = data.get("calls", [])
    # Sort calls chronologically so supersession chains link correctly
    calls_list.sort(key=lambda c: (c["published_on"], c["id"]))

    count = 0
    for call_data in calls_list:
        call_id = call_data["id"]
        inst_id = call_data["institution_id"]
        strat_id = call_data.get("strategist_id")
        call_type = call_data["call_type"]
        published_on = str(call_data["published_on"])
        approximate_date = int(call_data.get("approximate_date", 0))
        target_level = call_data.get("target_level")
        forecast_horizon = call_data.get("forecast_horizon", "YE_2026")
        confidence = call_data.get("confidence", "verified")
        source_url = call_data.get("source_url")
        notes = call_data.get("notes")

        # Allocation specific
        alloc_stance = call_data.get("allocation_stance")
        alloc_asset = call_data.get("allocation_asset", "SPX")
        alloc_bench = call_data.get("allocation_benchmark", "ACWI")

        # Probability specific
        prob_event = call_data.get("probability_event")
        prob_val = call_data.get("probability_value")

        # Look up spot price at publication date (required, fails loud if gap > 7 days)
        spot_at_pub = get_spot_at_publication(conn, "SPX", published_on)

        # Derive direction and implied return from the band arithmetic (see README).
        implied_return = None
        direction = None
        if call_type == "direction" and target_level is not None:
            implied_return, direction = derive_direction(
                target=target_level,
                spot=spot_at_pub,
                band=DIRECTION_BAND,
            )

        # Build payload string for idempotency
        if call_type == "direction":
            payload_str = f"{target_level}:{direction}"
        elif call_type == "allocation":
            payload_str = f"{alloc_stance}:{alloc_asset}:{alloc_bench}"
        else:
            payload_str = f"{prob_event}:{prob_val}"

        idempotency_key = make_call_idempotency_key(
            inst_id, published_on, call_type, forecast_horizon, payload_str
        )

        # Find previous active call to establish supersedes_id
        cur = conn.execute(
            """
            SELECT id FROM call
            WHERE institution_id = ? AND call_type = ? AND forecast_horizon = ?
              AND published_on < ?
            ORDER BY published_on DESC, created_at DESC, id DESC
            LIMIT 1
            """,
            (inst_id, call_type, forecast_horizon, published_on),
        )
        prev_row = cur.fetchone()
        supersedes_id = prev_row["id"] if prev_row else None

        # Calls are immutable: a curated payload change under an existing id is an
        # operator error, not an update. Detect it before SQLite raises a bare
        # "UNIQUE constraint failed: call.id".
        existing = conn.execute(
            "SELECT idempotency_key FROM call WHERE id = ?", (call_id,)
        ).fetchone()
        if existing and existing["idempotency_key"] != idempotency_key:
            raise ValueError(
                f"Call {call_id} already exists with a different payload "
                f"(stored key: {existing['idempotency_key']!r}, new key: {idempotency_key!r}). "
                "Calls are immutable — publish a revision as a new id, or delete "
                "data/scorecard.db and rebuild with `python -m scorecard run`."
            )

        # Insert or relink supersedes_id
        conn.execute(
            """
            INSERT INTO call (
                id, institution_id, strategist_id, call_type, published_on,
                approximate_date, target_level, spot_at_publication, implied_return,
                band, direction, allocation_stance, allocation_asset, allocation_benchmark,
                probability_event, probability_value, forecast_horizon, confidence,
                source_url, supersedes_id, idempotency_key, raw_payload, notes
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )
            ON CONFLICT(idempotency_key) DO UPDATE SET
                supersedes_id = excluded.supersedes_id
            """,
            (
                call_id,
                inst_id,
                strat_id,
                call_type,
                published_on,
                approximate_date,
                target_level,
                spot_at_pub,
                implied_return,
                DIRECTION_BAND,
                direction,
                alloc_stance,
                alloc_asset,
                alloc_bench,
                prob_event,
                prob_val,
                forecast_horizon,
                confidence,
                source_url,
                supersedes_id,
                idempotency_key,
                json.dumps(call_data),
                notes,
            ),
        )
        count += 1

    return count


def run_ingest(conn: sqlite3.Connection) -> Dict[str, int]:
    """Execute complete ingestion workflow."""
    from scorecard.mag7 import ingest_and_score_mag7
    market_count = load_market_data_into_db(conn)
    sources_count = ingest_source_documents(conn)
    inst_count = ingest_institutions(conn)
    events_count = ingest_events(conn)
    calls_count = ingest_calls(conn)
    mag7_count = ingest_and_score_mag7(conn)

    return {
        "market_observations": market_count,
        "source_documents": sources_count,
        "institutions": inst_count,
        "events": events_count,
        "calls": calls_count,
        "mag7_calls": mag7_count,
    }

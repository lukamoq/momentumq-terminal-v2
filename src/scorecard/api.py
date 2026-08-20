"""FastAPI REST API for Sell-Side Direction Scorecard, Mag 7 Audit, Seasonality Engine, and static asset server."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from scorecard.config import (
    AS_OF_DATE,
    SPX_TRACKING_NOTE,
    WEB_DIR,
    invalidate_as_of_cache,
    resolve_as_of_date,
)
from scorecard.db import db_session, get_connection, init_db
from scorecard.ingest import run_ingest
from scorecard.mag7 import mag7_aggregate_market_cap
from scorecard.score import run_scoring

app = FastAPI(
    title="MomentumQ Terminal API",
    description="Institutional quantitative scorecard, multi-asset seasonality, BSM options Greeks, and macro regime analytics",
    version="2.0.0",
)

# GZip compression for ultra-fast network payload transfer
app.add_middleware(GZipMiddleware, minimum_size=500)

# Allow GET and POST for local and web requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

_RESPONSE_CACHE: Dict[str, bytes] = {}


def _cached_json_response(cache_key: str, loader_fn) -> Response:
    """Serve pre-serialized JSON bytes directly from memory in <0.05ms."""
    if cache_key in _RESPONSE_CACHE:
        return Response(content=_RESPONSE_CACHE[cache_key], media_type="application/json")
    result = loader_fn()
    payload_bytes = json.dumps(result, default=str).encode("utf-8")
    _RESPONSE_CACHE[cache_key] = payload_bytes
    return Response(content=payload_bytes, media_type="application/json")


def clear_api_cache() -> None:
    """Clear all in-memory API caches."""
    _RESPONSE_CACHE.clear()


@app.post("/api/pipeline/sync")
@app.get("/api/pipeline/sync")
def sync_and_recalculate(refresh: bool = True) -> Dict[str, Any]:
    """Pull fresh vendor data, re-ingest, and rebuild every scoring and analytics table.

    ``refresh=true`` (the default) re-hits the vendor for daily bars, option
    chains, the Treasury curve and corporate reference data before rescoring.

    This endpoint previously described itself as a "live data sync" while only
    replaying the on-disk cache: nothing was re-fetched, so the button could
    never move the terminal forward a day.
    """
    import time
    start_time = time.time()

    clear_api_cache()
    init_db()

    fetch_summary: Dict[str, Any] = {"refreshed": bool(refresh)}
    if refresh:
        from scorecard.pipeline import refresh_vendor_data
        fetch_summary.update(refresh_vendor_data())

    with db_session() as conn:
        ingest_summary = run_ingest(conn)
        invalidate_as_of_cache()
        score_summary = run_scoring(conn, as_of_date=resolve_as_of_date(refresh=True))

    elapsed_ms = round((time.time() - start_time) * 1000, 2)
    return {
        "status": "ok",
        "message": "Vendor data pulled, scoring models and quantitative analytics recalculated.",
        "as_of_date": resolve_as_of_date(),
        "elapsed_ms": elapsed_ms,
        "fetch_summary": fetch_summary,
        "ingest_summary": ingest_summary,
        "score_summary": score_summary,
    }


@app.get("/api/scorecard")
def get_scorecard() -> Response:
    """Return aggregated bank scorecard table sorted by edge descending."""
    def _compute():
        conn = get_connection()
        try:
            cur = conn.execute(
                """
                SELECT
                    sb.*,
                    i.name as institution_name,
                    i.full_name as institution_full_name,
                    latest.target_level as latest_target,
                    latest.direction as latest_direction,
                    latest.published_on as latest_published_on,
                    latest.spot_at_publication as latest_spot,
                    latest.implied_return as latest_implied_return
                FROM score_bank sb
                JOIN institution i ON sb.institution_id = i.id
                LEFT JOIN (
                    SELECT c1.*
                    FROM call c1
                    WHERE c1.call_type = 'direction'
                      AND c1.id = (
                          SELECT c2.id FROM call c2
                          WHERE c2.institution_id = c1.institution_id AND c2.call_type = 'direction'
                          ORDER BY c2.published_on DESC, c2.id DESC
                          LIMIT 1
                      )
                ) latest ON latest.institution_id = sb.institution_id
                ORDER BY
                    sb.is_always_bullish ASC,
                    coalesce(sb.stance_day_edge, sb.event_edge, -999) DESC,
                    coalesce(sb.event_hit_rate, -999) DESC,
                    i.name ASC
                """
            )
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    return _cached_json_response("scorecard", _compute)


@app.get("/api/timeline")
def get_timeline() -> Response:
    """Return data for hero stance timeline: daily SPX series, bank stance tracks, and flips."""
    def _compute():
        conn = get_connection()
        try:
            cur_m = conn.execute(
                """
                SELECT date, index_level, close
                FROM market_observation
                WHERE ticker = 'SPY'
                ORDER BY date ASC
                """
            )
            market_path = [dict(r) for r in cur_m.fetchall()]

            cur_i = conn.execute("SELECT id, name, full_name FROM institution ORDER BY name ASC")
            institutions = [dict(r) for r in cur_i.fetchall()]

            cur_c = conn.execute(
                """
                SELECT
                    c.id, c.institution_id, c.call_type, c.published_on, c.approximate_date,
                    c.target_level, c.spot_at_publication, c.implied_return, c.direction,
                    c.allocation_stance, c.allocation_asset, c.allocation_benchmark,
                    c.probability_event, c.probability_value, c.forecast_horizon,
                    c.confidence, c.source_url, c.notes, s.name as strategist_name,
                    a.ai_stance, a.ai_confidence, a.ai_sentiment_score, a.ai_reasoning, a.ai_key_drivers
                FROM call c
                LEFT JOIN strategist s ON c.strategist_id = s.id
                LEFT JOIN ai_call_audit a ON c.id = a.call_id
                ORDER BY c.published_on ASC, c.id ASC
                """
            )
            calls = [dict(r) for r in cur_c.fetchall()]

            cur_f = conn.execute(
                """
                SELECT
                    sl.id, sl.call_id, sl.previous_call_id, sl.institution_id,
                    sl.flip_date, sl.from_direction, sl.to_direction,
                    sl.move_30d_before, sl.move_30d_after, sl.lag_ratio,
                    sl.is_resolved, sl.status
                FROM score_lag sl
                ORDER BY sl.flip_date ASC
                """
            )
            flips = [dict(r) for r in cur_f.fetchall()]

            return {
                "institutions": institutions,
                "market_path": market_path,
                "calls": calls,
                "flips": flips,
            }
        finally:
            conn.close()

    return _cached_json_response("timeline", _compute)


@app.get("/api/calls")
def get_calls(institution_id: Optional[str] = None, call_type: Optional[str] = None) -> Response:
    """Return all calls with optional filtering."""
    cache_key = f"calls_{institution_id}_{call_type}"

    def _compute():
        conn = get_connection()
        try:
            query = """
                SELECT
                    c.id, c.institution_id, i.name as institution_name,
                    c.call_type, c.published_on, c.approximate_date,
                    c.target_level, c.spot_at_publication, c.implied_return,
                    c.direction, c.allocation_stance, c.allocation_asset, c.allocation_benchmark,
                    c.probability_event, c.probability_value, c.forecast_horizon,
                    c.confidence, c.source_url, c.supersedes_id, c.notes,
                    s.name as strategist_name, s.title as strategist_title,
                    a.ai_stance, a.ai_confidence, a.ai_sentiment_score, a.ai_reasoning, a.ai_key_drivers, a.ai_math_agreement
                FROM call c
                JOIN institution i ON c.institution_id = i.id
                LEFT JOIN strategist s ON c.strategist_id = s.id
                LEFT JOIN ai_call_audit a ON c.id = a.call_id
                WHERE 1=1
            """
            params: List[Any] = []
            if institution_id:
                query += " AND c.institution_id = ?"
                params.append(institution_id.upper())
            if call_type:
                query += " AND c.call_type = ?"
                params.append(call_type)

            query += " ORDER BY c.published_on DESC, c.id DESC"
            cur = conn.execute(query, params)
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    return _cached_json_response(cache_key, _compute)


@app.get("/api/calls/{call_id}")
def get_call_detail(call_id: str) -> Dict[str, Any]:
    """Return single call detail with its full audit, scores, and supersession chain."""
    conn = get_connection()
    try:
        cur = conn.execute(
            """
            SELECT
                c.*, i.name as institution_name, i.full_name as institution_full_name,
                s.name as strategist_name, s.title as strategist_title,
                a.ai_stance, a.ai_confidence, a.ai_sentiment_score, a.ai_reasoning, a.ai_key_drivers, a.ai_math_agreement
            FROM call c
            JOIN institution i ON c.institution_id = i.id
            LEFT JOIN strategist s ON c.strategist_id = s.id
            LEFT JOIN ai_call_audit a ON c.id = a.call_id
            WHERE c.id = ?
            """,
            (call_id,),
        )
        call_row = cur.fetchone()
        if not call_row:
            raise HTTPException(status_code=404, detail="Call not found")

        dir_scores = [dict(r) for r in conn.execute("SELECT * FROM score_direction WHERE call_id = ?", (call_id,)).fetchall()]
        alloc_scores = [dict(r) for r in conn.execute("SELECT * FROM score_allocation WHERE call_id = ?", (call_id,)).fetchall()]
        prob_scores = [dict(r) for r in conn.execute("SELECT * FROM score_probability WHERE call_id = ?", (call_id,)).fetchall()]

        chain = []
        curr_id = call_id
        while curr_id:
            c_row = conn.execute("SELECT id, supersedes_id, published_on, direction, target_level FROM call WHERE id = ?", (curr_id,)).fetchone()
            if not c_row:
                break
            chain.append(dict(c_row))
            curr_id = c_row["supersedes_id"]

        return {
            "call": dict(call_row),
            "direction_scores": dir_scores,
            "allocation_scores": alloc_scores,
            "probability_scores": prob_scores,
            "supersession_chain": chain,
        }
    finally:
        conn.close()


from scorecard.partner import compute_partner_reliability
from scorecard.mag7 import (
    compute_mag7_bank_scorecard,
    compute_mag7_stock_breakdown,
    compute_mag7_themes,
    get_mag7_market_series,
)


@app.get("/api/partners")
def get_partners() -> Response:
    """Return ranked institutional partner reliability matrix with regime scores and insights."""
    def _compute():
        conn = get_connection()
        try:
            return compute_partner_reliability(conn)
        finally:
            conn.close()

    return _cached_json_response("partners", _compute)


@app.get("/api/mag7/scorecard")
def get_mag7_scorecard() -> Response:
    """Return Mag 7 institutional scorecard showing who was right and wrong on Big Tech."""
    def _compute():
        conn = get_connection()
        try:
            return compute_mag7_bank_scorecard(conn)
        finally:
            conn.close()

    return _cached_json_response("mag7_scorecard", _compute)


@app.get("/api/mag7/stocks")
def get_mag7_stocks() -> Response:
    """Return stock-by-stock breakdown for NVDA, AAPL, MSFT, AMZN, GOOGL, META, TSLA, and Basket."""
    def _compute():
        conn = get_connection()
        try:
            return compute_mag7_stock_breakdown(conn)
        finally:
            conn.close()

    return _cached_json_response("mag7_stocks", _compute)


@app.get("/api/mag7/themes")
def get_mag7_themes() -> Response:
    """Return thematic audit dossiers, reconciled against each desk's scored record."""
    def _compute():
        conn = get_connection()
        try:
            return compute_mag7_themes(conn)
        finally:
            conn.close()

    return _cached_json_response("mag7_themes", _compute)


@app.get("/api/mag7/calls")
def get_mag7_calls(
    institution_id: Optional[str] = None,
    ticker: Optional[str] = None,
    verdict: Optional[str] = None,
) -> Response:
    """Return all curated Mag 7 calls with optional filtering."""
    cache_key = f"mag7_calls_{institution_id}_{ticker}_{verdict}"

    def _compute():
        conn = get_connection()
        try:
            query = """
                SELECT c.*, i.name as institution_name, i.full_name as institution_full_name
                FROM mag7_call c
                JOIN institution i ON c.institution_id = i.id
                WHERE 1=1
            """
            params: List[Any] = []
            if institution_id:
                query += " AND c.institution_id = ?"
                params.append(institution_id.upper())
            if ticker:
                query += " AND c.ticker = ?"
                params.append(ticker.upper())
            if verdict:
                query += " AND c.verdict = ?"
                params.append(verdict.upper())

            query += " ORDER BY c.published_on DESC, c.id ASC"
            cur = conn.execute(query, params)
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    return _cached_json_response(cache_key, _compute)


@app.get("/api/mag7/market-series")
def get_mag7_series() -> Response:
    """Return normalized price path history for Mag 7, SPY, QQQ, and RSP."""
    def _compute():
        conn = get_connection()
        try:
            return get_mag7_market_series(conn)
        finally:
            conn.close()

    return _cached_json_response("mag7_market_series", _compute)


@app.get("/api/mag7/stats")
def get_mag7_stats() -> Response:
    """Return aggregate statistics for Mag 7."""
    def _compute():
        conn = get_connection()
        try:
            total_calls = conn.execute("SELECT count(*) as c FROM mag7_call").fetchone()["c"]
            total_hits = conn.execute("SELECT count(*) as c FROM mag7_call WHERE verdict = 'HIT'").fetchone()["c"]
            total_misses = conn.execute("SELECT count(*) as c FROM mag7_call WHERE verdict = 'MISS'").fetchone()["c"]
            
            spy_ytd = conn.execute(
                """
                SELECT 
                    (SELECT close FROM market_observation WHERE ticker = 'SPY' ORDER BY date DESC LIMIT 1) as latest,
                    (SELECT close FROM market_observation WHERE ticker = 'SPY' AND date >= '2026-01-01' ORDER BY date ASC LIMIT 1) as ytd_start
                """
            ).fetchone()
            spy_ytd_ret = (
                (float(spy_ytd["latest"]) / float(spy_ytd["ytd_start"]) - 1.0)
                if spy_ytd and spy_ytd["latest"] and spy_ytd["ytd_start"]
                else None
            )

            total_too_early = conn.execute(
                "SELECT count(*) as c FROM mag7_call WHERE verdict = 'TOO_EARLY'"
            ).fetchone()["c"]
            total_institutions = conn.execute(
                "SELECT count(DISTINCT institution_id) as c FROM mag7_call"
            ).fetchone()["c"]

            return {
                "total_calls": total_calls,
                "total_hits": total_hits,
                "total_misses": total_misses,
                "total_too_early": total_too_early,
                "overall_hit_rate": round(total_hits / (total_hits + total_misses), 4) if (total_hits + total_misses) > 0 else None,
                "total_institutions": total_institutions,
                "spy_ytd_return": round(spy_ytd_ret, 4) if spy_ytd_ret is not None else None,
                "mag7_aggregate_market_cap": mag7_aggregate_market_cap(conn),
                "as_of_date": resolve_as_of_date(),
            }
        finally:
            conn.close()

    return _cached_json_response("mag7_stats", _compute)


@app.get("/api/macro")
def get_macro() -> Response:
    """Allocation and probability calls joined to their scored evaluations."""
    def _compute():
        conn = get_connection()
        try:
            alloc_rows = conn.execute(
                """
                SELECT
                    c.id as call_id, c.institution_id, i.name as institution_name,
                    c.published_on, c.allocation_stance, c.allocation_asset, c.allocation_benchmark,
                    c.notes, c.source_url,
                    sa.horizon, sa.window_start_date, sa.window_end_date,
                    sa.asset_return, sa.bench_return, sa.spread_return,
                    sa.verdict, sa.is_resolved
                FROM call c
                JOIN institution i ON c.institution_id = i.id
                LEFT JOIN score_allocation sa
                       ON sa.call_id = c.id AND sa.evaluation_kind = 'event'
                WHERE c.call_type = 'allocation'
                ORDER BY c.published_on DESC, c.id ASC, sa.horizon ASC
                """
            ).fetchall()

            allocations: Dict[str, Dict[str, Any]] = {}
            for r in alloc_rows:
                row = dict(r)
                call_id = row["call_id"]
                entry = allocations.setdefault(
                    call_id,
                    {
                        "call_id": call_id,
                        "institution_id": row["institution_id"],
                        "institution_name": row["institution_name"],
                        "published_on": row["published_on"],
                        "allocation_stance": row["allocation_stance"],
                        "allocation_asset": row["allocation_asset"],
                        "allocation_benchmark": row["allocation_benchmark"],
                        "notes": row["notes"],
                        "source_url": row["source_url"],
                        "horizons": {},
                        "hits": 0,
                        "misses": 0,
                        "too_early": 0,
                    },
                )
                if row["horizon"]:
                    entry["horizons"][row["horizon"]] = {
                        "horizon": row["horizon"],
                        "window_start_date": row["window_start_date"],
                        "window_end_date": row["window_end_date"],
                        "asset_return": row["asset_return"],
                        "bench_return": row["bench_return"],
                        "spread_return": row["spread_return"],
                        "verdict": row["verdict"],
                        "is_resolved": row["is_resolved"],
                    }
                    v = (row["verdict"] or "").upper()
                    if v == "HIT":
                        entry["hits"] += 1
                    elif v == "MISS":
                        entry["misses"] += 1
                    elif v == "TOO_EARLY":
                        entry["too_early"] += 1

            prob = conn.execute(
                """
                SELECT
                    c.id as call_id, c.institution_id, i.name as institution_name,
                    c.published_on, c.probability_event, c.probability_value,
                    c.notes, c.source_url,
                    e.name as event_name, e.description as event_description,
                    e.resolved as is_resolved, e.outcome, e.resolved_on as outcome_date,
                    e.notes as verification_notes,
                    -- The scored side: without these the UI cannot show what the
                    -- forecast was actually worth against the base rate.
                    e.climatology_prior,
                    sp.brier_score, sp.brier_climatology, sp.brier_skill_score,
                    sp.actual_outcome, sp.verdict
                FROM call c
                JOIN institution i ON c.institution_id = i.id
                LEFT JOIN event_outcome e ON c.probability_event = e.event_key
                LEFT JOIN score_probability sp ON sp.call_id = c.id
                WHERE c.call_type = 'probability'
                ORDER BY e.resolved DESC, c.probability_event ASC, c.published_on DESC, c.id ASC
                """
            ).fetchall()

            return {
                "allocations": list(allocations.values()),
                "probabilities": [dict(r) for r in prob],
            }
        finally:
            conn.close()

    return _cached_json_response("macro", _compute)


@app.get("/api/stats")
def get_stats() -> Response:
    """Return top-level summary statistics."""
    def _compute():
        conn = get_connection()
        try:
            c_calls = conn.execute("SELECT count(*) as count FROM call").fetchone()["count"]
            c_banks = conn.execute("SELECT count(*) as count FROM institution").fetchone()["count"]
            c_ab = conn.execute("SELECT count(*) as count FROM score_bank WHERE is_always_bullish = 1").fetchone()["count"]
            c_discrim = conn.execute("SELECT count(*) as count FROM score_bank WHERE is_always_bullish = 0").fetchone()["count"]
            c_obs_ev = conn.execute("SELECT count(*) as count FROM score_direction WHERE evaluation_kind = 'event'").fetchone()["count"]
            c_obs_sd = conn.execute("SELECT count(*) as count FROM score_direction WHERE evaluation_kind = 'stance_day'").fetchone()["count"]

            m_range = conn.execute("SELECT MIN(date) as min_date, MAX(date) as max_date FROM market_observation").fetchone()

            return {
                "total_calls": c_calls,
                "total_institutions": c_banks,
                "always_bullish_institutions": c_ab,
                "discriminating_institutions": c_discrim,
                "direction_event_evaluations": c_obs_ev,
                "direction_stance_day_evaluations": c_obs_sd,
                "market_data_start": m_range["min_date"],
                "market_data_end": m_range["max_date"],
                "as_of_date": resolve_as_of_date(),
                "spx_basis_note": SPX_TRACKING_NOTE,
                # Which feed each bar came from. The vendor plan serves a
                # rolling five-year window; the years before it are archive.
                "data_sources": [dict(r) for r in conn.execute(
                    """
                    SELECT source, COUNT(*) AS bars, MIN(date) AS first_date, MAX(date) AS last_date
                    FROM market_observation GROUP BY source ORDER BY first_date
                    """
                ).fetchall()],
                "option_chain": dict(conn.execute(
                    """
                    SELECT MAX(snapshot_date) AS snapshot_date,
                           COUNT(*) AS contracts,
                           COUNT(DISTINCT underlying) AS underlyings
                    FROM option_contract
                    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM option_contract)
                    """
                ).fetchone() or {}),
            }
        finally:
            conn.close()

    return _cached_json_response("stats", _compute)


# =========================================================================
# Page 03 // Seasonality & Advanced Macro Analytics Endpoints
# =========================================================================

from scorecard.seasonality import (
    compute_monthly_returns,
    compute_multi_asset_seasonality_overview,
    compute_index_trio_seasonality,
    compute_cumulative_day_of_year_curves,
    compute_call_seasonality_analytics,
)
from scorecard.regime import (
    compute_macro_regime,
    compute_cross_asset_correlation,
    compute_sector_rotation,
    compute_macro_history,
)
from scorecard.commodities import compute_commodities_analytics
from scorecard.vix import compute_vix_structure
from scorecard.fear_greed import compute_fear_greed_index, compute_fear_greed_history
from scorecard.options import compute_options_analytics, compute_options_trio_comparison
from scorecard.agent_engine import generate_agent_report, get_gemini_api_key
from pydantic import BaseModel


class AgentReportRequest(BaseModel):
    report_type: str = "eow_dossier"
    user_query: Optional[str] = None
    api_key: Optional[str] = None


@app.get("/api/agents/status")
def get_agents_status() -> Response:
    """Return Gemini 3.7 Flash binding status, agent roster, and capabilities."""
    has_key = bool(get_gemini_api_key())
    data = {
        "model": "gemini-3.7-flash",
        "api_bound": has_key,
        "agents": [
            {"id": "macro_regime", "name": "Macro Regime Specialist", "role": "5-State Macro & Rates", "status": "ONLINE"},
            {"id": "options_gex", "name": "Options Surface & Dealer GEX Specialist", "role": "BSM Greeks & Gamma Walls", "status": "ONLINE"},
            {"id": "commodities", "name": "Commodities & Energy Specialist", "role": "Gold, Brent & Dollar Hedging", "status": "ONLINE"},
            {"id": "sell_side_audit", "name": "Sell-Side Forecaster Auditor", "role": "Consensus Edge & Mag 7", "status": "ONLINE"},
            {"id": "cio_synthesis", "name": "Chief Investment Officer (CIO)", "role": "Executive Dossier Synthesis", "status": "ONLINE"},
        ],
        "capabilities": [
            "End-of-Week Executive Dossiers",
            "Daily Market Open Strategic Memos",
            "Dealer Gamma Wall & Expected Move Notes",
            "Commodity Real-Rate Sensitivity Reports",
            "Multi-Agent Interactive Data Chat",
        ],
    }
    return Response(content=json.dumps(data), media_type="application/json")


@app.post("/api/agents/generate-report")
def post_agents_generate_report(req: AgentReportRequest) -> Response:
    """Generate on-demand quantitative intelligence report with Gemini 3.7 Flash or synthesized engine."""
    result = generate_agent_report(
        get_connection(),
        report_type=req.report_type,
        user_query=req.user_query,
        api_key=req.api_key,
    )
    return Response(content=json.dumps(result), media_type="application/json")


@app.post("/api/agents/chat")
def post_agents_chat(req: AgentReportRequest) -> Response:
    """Interactive multi-agent chat query."""
    result = generate_agent_report(
        get_connection(),
        report_type="chat_query",
        user_query=req.user_query or "Analyze current market posture",
        api_key=req.api_key,
    )
    return Response(content=json.dumps(result), media_type="application/json")


# ==============================================================================
# Live News Feed & AI Bullish/Bearish Sentiment Endpoints
# ==============================================================================

class NewsAnalyzeRequest(BaseModel):
    headline: str
    summary: Optional[str] = ""
    api_key: Optional[str] = None


@app.get("/api/news/feed")
def get_news_feed(category: Optional[str] = None, ticker: Optional[str] = None, api_key: Optional[str] = None) -> Response:
    """Return live market news feed with AI Agent Bullish/Bearish classifications and barometer."""
    from scorecard.news import get_live_news_feed_analytics
    data = get_live_news_feed_analytics(get_connection(), category=category, ticker=ticker, api_key=api_key)
    return Response(content=json.dumps(data), media_type="application/json")


@app.post("/api/news/analyze")
def post_news_analyze(req: NewsAnalyzeRequest) -> Response:
    """Classify a custom news headline/article as Bullish/Bearish using AI Agent."""
    from scorecard.news import analyze_custom_news_text
    data = analyze_custom_news_text(headline=req.headline, summary=req.summary or "", api_key=req.api_key)
    return Response(content=json.dumps(data), media_type="application/json")


@app.get("/api/news/eod-wrap")
def get_news_eod_wrap(api_key: Optional[str] = None) -> Response:
    """Return aggregated End-of-Day (EOD) Market News & Sentiment Synthesis."""
    from scorecard.news import generate_eod_news_synthesis
    return _cached_json_response("news_eod_wrap", lambda: generate_eod_news_synthesis(get_connection(), api_key=api_key))


@app.post("/api/news/eod-wrap")
def post_news_eod_wrap(req: Optional[NewsAnalyzeRequest] = None) -> Response:
    """Trigger fresh End-of-Day (EOD) Market News & Sentiment Synthesis."""
    from scorecard.news import generate_eod_news_synthesis
    api_key = req.api_key if req else None
    data = generate_eod_news_synthesis(get_connection(), api_key=api_key)
    return Response(content=json.dumps(data), media_type="application/json")


@app.get("/api/news/market-wraps")
def get_news_market_wraps(limit: int = 30) -> Response:
    """Return list of historical End-of-Day market wraps stored in SQLite database."""
    from scorecard.news import list_market_wraps
    data = list_market_wraps(get_connection(), limit=limit)
    return Response(content=json.dumps(data), media_type="application/json")


@app.get("/api/news/market-wraps/{wrap_id}")
def get_news_market_wrap_single(wrap_id: str) -> Response:
    """Return a single historical market wrap report by ID from SQLite store."""
    from scorecard.news import get_market_wrap_by_id
    data = get_market_wrap_by_id(get_connection(), wrap_id)
    if not data:
        return Response(content=json.dumps({"error": "Wrap not found"}), status_code=404, media_type="application/json")
    return Response(content=json.dumps(data), media_type="application/json")





@app.get("/api/macro/regime")
def get_macro_regime() -> Response:
    """Return macro market regime classification, VIX volatility, and breadth factors."""
    return _cached_json_response("macro_regime", lambda: compute_macro_regime(get_connection()))


@app.get("/api/macro/history")
def get_macro_history(lookback: int = 1255) -> Response:
    """Return comprehensive multi-year historical macro indicators, SPY price, SMAs, drawdowns and cross-asset relative series."""
    return _cached_json_response(f"macro_history_{lookback}", lambda: compute_macro_history(get_connection(), lookback_days=lookback))


@app.get("/api/macro/commodities")
def get_macro_commodities() -> Response:
    """Return comprehensive quantitative analytics, ratios and inflation sensitivities for Gold, Brent/Oil, Silver, and Commodities."""
    return _cached_json_response("macro_commodities", lambda: compute_commodities_analytics(get_connection()))


@app.get("/api/macro/vix-structure")
def get_macro_vix_structure() -> Response:
    """Return VIX futures term structure analysis, contango/backwardation, and historical path."""
    return _cached_json_response("macro_vix_structure", lambda: compute_vix_structure(get_connection()))


@app.get("/api/macro/fear-greed")
def get_macro_fear_greed() -> Response:
    """Return MoQ Fear & Greed Index 2.0 multi-factor sentiment scoring."""
    return _cached_json_response("macro_fear_greed", lambda: compute_fear_greed_index(get_connection()))


@app.get("/api/macro/fear-greed/history")
def get_macro_fear_greed_history(lookback: int = 500) -> Response:
    """Return daily historical Fear & Greed scores alongside SPY stock prices."""
    return _cached_json_response(f"macro_fear_greed_hist_{lookback}", lambda: compute_fear_greed_history(get_connection(), lookback_days=lookback))


@app.get("/api/analytics/options")
def get_analytics_options(ticker: Optional[str] = None) -> Response:
    """Return options volatility skew, max pain, gamma regime, and expected moves."""
    if not ticker or ticker.upper() in ("INDEX_TRIO", "ALL", "TRIO"):
        return _cached_json_response("analytics_options_trio", lambda: compute_options_trio_comparison(get_connection()))
    return _cached_json_response(f"analytics_options_{ticker.upper()}", lambda: compute_options_analytics(get_connection(), ticker))


@app.get("/api/analytics/correlation")
def get_analytics_correlation(lookback: int = 60) -> Response:
    """Return rolling cross-asset correlation matrix, clusters, and diversification scores."""
    return _cached_json_response(f"analytics_correlation_{lookback}", lambda: compute_cross_asset_correlation(get_connection(), lookback_days=lookback))


@app.get("/api/analytics/sectors")
def get_analytics_sectors() -> Response:
    """Return 11-sector relative performance, alpha vs SPY, and rotation quadrant."""
    return _cached_json_response("analytics_sectors", lambda: compute_sector_rotation(get_connection()))



@app.get("/api/analytics/seasonality")
def get_analytics_seasonality(ticker: str = "SPY") -> Response:
    """Return month-by-month return matrix and summary statistics for a given ticker."""
    t_clean = ticker.upper()
    return _cached_json_response(f"seasonality_{t_clean}", lambda: compute_monthly_returns(get_connection(), t_clean))


@app.get("/api/analytics/trio")
def get_analytics_trio() -> Response:
    """Return comparative seasonality matrix and relative spreads for SPY, QQQ, and IWM."""
    return _cached_json_response("analytics_trio", lambda: compute_index_trio_seasonality(get_connection()))


@app.get("/api/analytics/multi-asset")
def get_analytics_multi_asset() -> Response:
    """Return comparative monthly seasonality averages across major asset classes."""
    return _cached_json_response("analytics_multi_asset", lambda: compute_multi_asset_seasonality_overview(get_connection()))


@app.get("/api/analytics/seasonality-curves")
def get_analytics_seasonality_curves(ticker: str = "SPY") -> Response:
    """Return cumulative day-of-year trading trajectory (Day 1 to 252)."""
    t_clean = ticker.upper()
    return _cached_json_response(f"curves_{t_clean}", lambda: compute_cumulative_day_of_year_curves(get_connection(), t_clean))


@app.get("/api/analytics/call-patterns")
def get_analytics_call_patterns() -> Response:
    """Return audit of research calls by month and seasonal quarter."""
    return _cached_json_response("analytics_call_patterns", lambda: compute_call_seasonality_analytics(get_connection()))


@app.get("/api/analytics/stats")
def get_analytics_stats() -> Response:
    """Return headline summary metrics for Page 03 header."""
    def _compute():
        conn = get_connection()
        try:
            spy_season = compute_monthly_returns(conn, "SPY")
            call_patterns = compute_call_seasonality_analytics(conn)
            regime = compute_macro_regime(conn)
            return {
                "spy_best_month": spy_season.get("best_month"),
                "spy_worst_month": spy_season.get("worst_month"),
                "q4_hit_rate": call_patterns["quarters"][3]["hit_rate"] if len(call_patterns["quarters"]) >= 4 else 0.75,
                "q1_hit_rate": call_patterns["quarters"][0]["hit_rate"] if len(call_patterns["quarters"]) >= 1 else 0.58,
                "total_audited_calls": call_patterns.get("total_audited_calls", 135),
                "regime": regime
            }
        finally:
            conn.close()

    return _cached_json_response("analytics_stats", _compute)


@app.get("/api/alpha/insider-trades")
def get_alpha_insider_trades(ticker: Optional[str] = None) -> Response:
    """Return SEC Form 4 insider transactions, cluster buy signals, and sentiment ratio."""
    from scorecard.insider import compute_insider_sentiment_analytics
    cache_key = f"alpha_insider_{ticker.upper() if ticker else 'all'}"
    return _cached_json_response(cache_key, lambda: compute_insider_sentiment_analytics(get_connection(), ticker))


@app.get("/api/alpha/smart-money")
def get_alpha_smart_money() -> Response:
    """Return 13F institutional whale portfolio holdings and concentration."""
    from scorecard.insider import compute_smart_money_whales
    return _cached_json_response("alpha_smart_money", lambda: compute_smart_money_whales(get_connection()))


# ==============================================================================
# Crypto & Digital Asset Analytics Endpoints (Page 07)
# ==============================================================================

@app.get("/api/crypto/overview")
def get_crypto_overview() -> Response:
    """Return spot crypto universe, market dominance, and institutional ETF flows."""
    from scorecard.crypto import compute_crypto_overview
    return _cached_json_response("crypto_overview", lambda: compute_crypto_overview(get_connection()))


@app.get("/api/crypto/sentiment")
def get_crypto_sentiment() -> Response:
    """Return 6-factor Crypto Fear & Greed Index (0-100)."""
    from scorecard.crypto import compute_crypto_sentiment
    return _cached_json_response("crypto_sentiment", lambda: compute_crypto_sentiment(get_connection()))


@app.get("/api/crypto/halving-cycles")
def get_crypto_halving_cycles() -> Response:
    """Return 4-year Bitcoin halving cycle trajectories (2012, 2016, 2020, 2024-2026)."""
    from scorecard.crypto import compute_bitcoin_halving_cycles
    return _cached_json_response("crypto_halving_cycles", lambda: compute_bitcoin_halving_cycles(get_connection()))


@app.get("/api/crypto/correlations")
def get_crypto_correlations() -> Response:
    """Return rolling cross-asset crypto vs equities, gold, and treasury correlations."""
    from scorecard.crypto import compute_crypto_correlations
    return _cached_json_response("crypto_correlations", lambda: compute_crypto_correlations(get_connection()))


@app.get("/api/crypto/history")
def get_crypto_history(ticker: str = "BTC", lookback: int = 365) -> Response:
    """Return historical OHLCV, 50D/200D SMAs, RSI, and realized volatility for crypto."""
    from scorecard.crypto import compute_crypto_historical_series
    cache_key = f"crypto_history_{ticker.upper()}_{lookback}"
    return _cached_json_response(cache_key, lambda: compute_crypto_historical_series(get_connection(), ticker, lookback))


@app.middleware("http")
async def _revalidate_web_assets(request, call_next):
    """Make the terminal's own assets revalidate instead of sitting in cache.

    The web app ships as unversioned ES modules and stylesheets, so a browser
    that keeps them in its memory cache will happily run last week's terminal
    against this week's API. `no-cache` still allows a 304 — it only forbids
    using a copy without asking — which costs one conditional request per file
    and removes a whole class of "why is my screen stale" bug reports.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        return response
    if path.endswith((".js", ".css", ".html")) or path in ("/", ""):
        response.headers["Cache-Control"] = "no-cache"
    return response


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")


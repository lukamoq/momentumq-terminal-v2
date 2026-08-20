"""Command Line Interface (CLI) for Sell-Side Direction Scorecard."""

from __future__ import annotations

import argparse
import logging
import sys
from typing import List, Optional

import uvicorn

from scorecard.config import DB_PATH
from scorecard.db import db_session, init_db
from scorecard.ingest import run_ingest
from scorecard.market import fetch_and_cache_market_data, load_market_data_into_db
from scorecard.news import ingest_source_documents
from scorecard.score import run_scoring

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("scorecard")


def cmd_market(args: argparse.Namespace) -> int:
    """Fetch and load market data."""
    logger.info("Fetching and caching market data from Massive...")
    counts = fetch_and_cache_market_data(force_api=args.force)
    logger.info(f"Market bars fetched: {counts}")

    init_db()
    with db_session() as conn:
        loaded = load_market_data_into_db(conn)
        logger.info(f"Loaded {loaded} market observations into database.")
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    """Run the Tavily discovery sweep into data/cache/tavily/."""
    from scorecard.discover import run_discovery

    logger.info("Running Tavily discovery sweep (refresh=%s)...", args.refresh)
    counts = run_discovery(depth=args.depth, skip_cached=not args.refresh)
    total = sum(counts.values())
    empty = sorted(k for k, v in counts.items() if v == 0)
    logger.info("Discovery complete: %d results across %d queries.", total, len(counts))
    if empty:
        logger.warning("Queries returning nothing: %s", ", ".join(empty))
    logger.info("Corpora cached. Curation into data/curated/ remains manual and evidence-backed.")
    return 0


def cmd_news(args: argparse.Namespace) -> int:
    """Load news and sources from Tavily cache."""
    init_db()
    with db_session() as conn:
        count = ingest_source_documents(conn)
        logger.info(f"Ingested {count} source documents from Tavily cache.")
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    """Execute complete data ingestion pipeline."""
    init_db()
    with db_session() as conn:
        res = run_ingest(conn)
        logger.info(f"Ingestion summary: {res}")
    return 0


def cmd_score(args: argparse.Namespace) -> int:
    """Rebuild all score tables."""
    init_db()
    with db_session() as conn:
        res = run_scoring(conn)
        logger.info(f"Scoring summary: {res}")
    return 0


def cmd_options(args: argparse.Namespace) -> int:
    """Pull option chains, the Treasury curve, and corporate reference data."""
    from scorecard.pipeline import refresh_vendor_data
    from scorecard.optionsdata import (
        load_dividends_into_db, load_option_chains_into_db,
        load_splits_into_db, load_ticker_reference_into_db,
        load_treasury_yields_into_db,
    )
    from scorecard.config import OPTIONS_UNDERLYINGS
    from scorecard.market import MAG7_TICKERS

    init_db()
    reference = tuple(OPTIONS_UNDERLYINGS) + MAG7_TICKERS
    with db_session() as conn:
        logger.info("Fetching constant-maturity Treasury curve...")
        n_curve = load_treasury_yields_into_db(conn, force_api=args.force)
        logger.info("Fetching option chains for %s...", ", ".join(OPTIONS_UNDERLYINGS))
        n_chain = load_option_chains_into_db(conn, OPTIONS_UNDERLYINGS, force_api=args.force)
        logger.info("Fetching splits, dividends and market caps...")
        n_split = load_splits_into_db(conn, reference, force_api=args.force)
        n_div = load_dividends_into_db(conn, reference, force_api=args.force)
        n_ref = load_ticker_reference_into_db(conn, reference, force_api=args.force)

    logger.info(
        "Reference data loaded: %d curve days, %d option contracts, %d splits, "
        "%d dividends, %d ticker profiles.",
        n_curve, n_chain, n_split, n_div, n_ref,
    )
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    """Refresh every vendor feed, re-ingest, and rebuild all scoring tables."""
    from scorecard.config import invalidate_as_of_cache, resolve_as_of_date
    from scorecard.pipeline import refresh_vendor_data

    logger.info("Pulling fresh vendor data (bars, chains, curve, reference)...")
    fetch_summary = refresh_vendor_data(force=not args.cached)
    logger.info("Fetch summary: %s", fetch_summary)

    with db_session() as conn:
        ingest = run_ingest(conn)
        logger.info("Ingest summary: %s", ingest)

    invalidate_as_of_cache()
    as_of = resolve_as_of_date(refresh=True)
    with db_session() as conn:
        scores = run_scoring(conn, as_of_date=as_of)
        logger.info("Scoring summary: %s", scores)

    logger.info("Terminal is current as of %s.", as_of)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """Run full pipeline: market -> options -> news -> ingest -> score."""
    logger.info("Running full pipeline...")
    cmd_market(args)
    cmd_options(args)
    cmd_news(args)
    cmd_ingest(args)
    cmd_score(args)
    logger.info("Pipeline completed successfully.")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Validate all 8 acceptance criteria invariants."""
    init_db()
    failures: List[str] = []

    with db_session() as conn:
        # AC1: Always-bullish desk -> 'no discriminating calls', not 100%
        cur = conn.execute("SELECT institution_id, status_label, is_always_bullish FROM score_bank WHERE is_always_bullish = 1")
        ab_banks = cur.fetchall()
        if not ab_banks:
            failures.append("AC1 Failed: No always-bullish desks found")
        for ab in ab_banks:
            if ab["status_label"] != "no discriminating calls":
                failures.append(f"AC1 Failed: {ab['institution_id']} is always-bullish but status_label is not 'no discriminating calls'")

        # AC2: Every UI hit rate has always-bullish baseline adjacent
        cur = conn.execute("SELECT institution_id, event_hit_rate, always_bullish_event_hit_rate FROM score_bank WHERE event_resolved > 0")
        rows = cur.fetchall()
        for r in rows:
            if r["event_hit_rate"] is not None and r["always_bullish_event_hit_rate"] is None:
                failures.append(f"AC2 Failed: {r['institution_id']} has hit_rate but missing always_bullish baseline")

        # AC3: JPM supersession chain (5 calls) and August 8000 is bullish (+3.5%)
        cur = conn.execute("SELECT id, target_level, spot_at_publication, implied_return, direction, supersedes_id FROM call WHERE institution_id = 'JPM' AND call_type = 'direction' AND forecast_horizon = 'YE_2026' ORDER BY published_on ASC")
        jpm_chain = cur.fetchall()
        if len(jpm_chain) != 5:
            failures.append(f"AC3 Failed: JPM 2026 has {len(jpm_chain)} calls, expected 5")
        else:
            aug_call = jpm_chain[-1]
            if aug_call["target_level"] != 8000:
                failures.append(f"AC3 Failed: Latest JPM call target is {aug_call['target_level']}, expected 8000")
            if aug_call["direction"] != "bullish":
                failures.append(f"AC3 Failed: August JPM 8000 derived as {aug_call['direction']}, expected 'bullish'")

        # AC4: Multi-horizon scoring > 100 observations
        cur = conn.execute("SELECT count(*) as cnt FROM score_direction WHERE evaluation_kind = 'stance_day'")
        sd_count = cur.fetchone()["cnt"]
        if sd_count < 100:
            failures.append(f"AC4 Failed: Stance-day score count is {sd_count}, expected > 100")

        # AC5: OW that rose but lagged ACWI = miss
        cur = conn.execute("SELECT verdict, asset_return, bench_return, spread_return FROM score_allocation WHERE call_id = 'call_gs_20251210_alloc' AND horizon = '1M'")
        alloc_row = cur.fetchone()
        if not alloc_row or alloc_row["verdict"] != "miss":
            failures.append(f"AC5 Failed: GS OW Jan 2026 expected 'miss' but got {alloc_row['verdict'] if alloc_row else 'None'}")

        # AC6: Rebuild scoring produces deterministic identical counts
        cnt1 = conn.execute("SELECT count(*) as cnt FROM score_direction").fetchone()["cnt"]
        run_scoring(conn)
        cnt2 = conn.execute("SELECT count(*) as cnt FROM score_direction").fetchone()["cnt"]
        if cnt1 != cnt2:
            failures.append(f"AC6 Failed: Score rebuild row counts differ ({cnt1} vs {cnt2})")

        # AC7: Ingest twice -> identical row counts
        c_cnt1 = conn.execute("SELECT count(*) as cnt FROM call").fetchone()["cnt"]
        run_ingest(conn)
        c_cnt2 = conn.execute("SELECT count(*) as cnt FROM call").fetchone()["cnt"]
        if c_cnt1 != c_cnt2:
            failures.append(f"AC7 Failed: Ingest twice produced different call counts ({c_cnt1} vs {c_cnt2})")

        # AC8: Flip after large move (BofA June) has lag record
        cur = conn.execute("SELECT lag_ratio, status, is_resolved FROM score_lag WHERE call_id = 'call_bac_20260609_dir'")
        lag_row = cur.fetchone()
        if not lag_row:
            failures.append("AC8 Failed: Missing lag ratio evaluation for BofA June 2026 flip")

    if failures:
        logger.error(f"Invariants check FAILED with {len(failures)} errors:")
        for f in failures:
            logger.error(f"  - {f}")
        return 1

    logger.info("All 8 Acceptance Criteria Invariants PASSED!")
    return 0


def cmd_config(args: argparse.Namespace) -> int:
    """Configure API keys and environment variables in .env."""
    from pathlib import Path
    from scorecard.config import PROJECT_ROOT

    env_path = PROJECT_ROOT / ".env"
    existing_lines = []
    env_vars = {}

    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            existing_lines = f.readlines()
        for line in existing_lines:
            line_str = line.strip()
            if line_str and not line_str.startswith("#") and "=" in line_str:
                k, v = line_str.split("=", 1)
                env_vars[k.strip()] = v.strip()

    updated = False
    if args.massive_key is not None:
        env_vars["MASSIVE_API_KEY"] = args.massive_key.strip()
        updated = True
    if args.tavily_key is not None:
        env_vars["TAVILY_API_KEY"] = args.tavily_key.strip()
        updated = True
    if args.massive_url is not None:
        env_vars["MASSIVE_BASE_URL"] = args.massive_url.strip()
        updated = True

    if updated:
        with open(env_path, "w", encoding="utf-8") as f:
            f.write("# MomentumQ Quantitative Research Platform Configuration\n\n")
            f.write("# Massive — market data provider (https://massive.com)\n")
            f.write(f"MASSIVE_API_KEY={env_vars.get('MASSIVE_API_KEY', '')}\n")
            f.write(f"MASSIVE_BASE_URL={env_vars.get('MASSIVE_BASE_URL', 'https://api.massive.com')}\n\n")
            f.write("# Tavily — search discovery provider (https://app.tavily.com)\n")
            f.write(f"TAVILY_API_KEY={env_vars.get('TAVILY_API_KEY', '')}\n")
        logger.info("Successfully updated .env configuration file.")

    # Always show status
    def mask_key(k: str) -> str:
        if not k:
            return "[NOT SET]"
        if len(k) <= 8:
            return "****"
        return f"{k[:4]}****{k[-4:]}"

    print("\n--- Current Configuration (.env) ---")
    print(f"  MASSIVE_API_KEY : {mask_key(env_vars.get('MASSIVE_API_KEY', ''))}")
    print(f"  MASSIVE_BASE_URL: {env_vars.get('MASSIVE_BASE_URL', 'https://api.massive.com')}")
    print(f"  TAVILY_API_KEY  : {mask_key(env_vars.get('TAVILY_API_KEY', ''))}")
    print(f"  DATABASE PATH   : {DB_PATH}")
    print("------------------------------------\n")
    return 0


def cmd_setup(args: argparse.Namespace) -> int:
    """Complete interactive/automated setup wizard for new clones."""
    from pathlib import Path
    from scorecard.config import PROJECT_ROOT

    print("\n=======================================================")
    print("  MomentumQ Quantitative Research & Scorecard Platform ")
    print("  Environment & Database Initialization Wizard         ")
    print("=======================================================\n")

    env_path = PROJECT_ROOT / ".env"
    env_example = PROJECT_ROOT / ".env.example"

    # 1. Configure .env if not present or interactive requested
    if not env_path.exists() and env_example.exists():
        with open(env_example, "r", encoding="utf-8") as f:
            content = f.read()
        with open(env_path, "w", encoding="utf-8") as f:
            f.write(content)
        logger.info("Created .env template from .env.example")

    if args.interactive:
        try:
            m_key = input("Enter Massive API Key (press Enter to skip): ").strip()
            t_key = input("Enter Tavily API Key (press Enter to skip): ").strip()
            if m_key or t_key:
                class DummyArgs:
                    massive_key = m_key if m_key else None
                    tavily_key = t_key if t_key else None
                    massive_url = None
                cmd_config(DummyArgs())
        except (KeyboardInterrupt, EOFError):
            print("\nSetup cancelled.")
            return 1
    else:
        class DummyArgs:
            massive_key = getattr(args, "massive_key", None)
            tavily_key = getattr(args, "tavily_key", None)
            massive_url = getattr(args, "massive_url", None)
        cmd_config(DummyArgs())

    # 2. Initialize Database & Ingest Curated Data
    logger.info("Initializing SQLite database schema...")
    init_db()

    logger.info("Ingesting curated sell-side forecasts and Mag 7 dossiers...")
    with db_session() as conn:
        run_ingest(conn)

    logger.info("Rebuilding quantitative scoring and benchmark tracking tables...")
    with db_session() as conn:
        run_scoring(conn)

    print("\n=======================================================")
    print("  Setup Complete! The platform is fully initialized.   ")
    print("  Start the Web Dashboard with:                        ")
    print("    python -m scorecard serve --port 8000             ")
    print("=======================================================\n")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    """Run FastAPI / Web server."""
    logger.info(f"Starting Scorecard server on http://{args.host}:{args.port}")
    uvicorn.run("scorecard.api:app", host=args.host, port=args.port, reload=args.reload)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    """Main CLI entrypoint."""
    parser = argparse.ArgumentParser(
        prog="scorecard",
        description="Sell-Side Direction Scorecard for S&P 500 in 2026",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # setup
    p_setup = subparsers.add_parser("setup", help="Initialize keys, database, and curated scoring")
    p_setup.add_argument("-i", "--interactive", action="store_true", help="Prompt interactively for API keys")
    p_setup.add_argument("--massive-key", help="Set Massive API key")
    p_setup.add_argument("--tavily-key", help="Set Tavily API key")
    p_setup.add_argument("--massive-url", help="Set Massive base URL")
    p_setup.set_defaults(func=cmd_setup)

    # config
    p_config = subparsers.add_parser("config", help="View or set API keys and configuration")
    p_config.add_argument("--massive-key", help="Set Massive API key in .env")
    p_config.add_argument("--tavily-key", help="Set Tavily API key in .env")
    p_config.add_argument("--massive-url", help="Set Massive base URL in .env")
    p_config.set_defaults(func=cmd_config)

    # market
    p_market = subparsers.add_parser("market", help="Fetch and load market data")
    p_market.add_argument("--force", action="store_true", help="Force API fetch even if cache exists")
    p_market.set_defaults(func=cmd_market)

    # news
    p_news = subparsers.add_parser("news", help="Ingest source documents from Tavily cache")
    p_news.set_defaults(func=cmd_news)

    # discover
    p_discover = subparsers.add_parser(
        "discover", help="Run the Tavily discovery sweep into the search cache")
    p_discover.add_argument("--refresh", action="store_true",
                            help="Re-query even when a corpus is already cached")
    p_discover.add_argument("--depth", default="advanced", choices=["basic", "advanced"],
                            help="Tavily search depth")
    p_discover.set_defaults(func=cmd_discover)

    # ingest
    p_ingest = subparsers.add_parser("ingest", help="Ingest curated data into SQLite")
    p_ingest.set_defaults(func=cmd_ingest)

    # score
    p_score = subparsers.add_parser("score", help="Rebuild all score tables")
    p_score.set_defaults(func=cmd_score)

    # options
    p_options = subparsers.add_parser(
        "options",
        help="Pull option chains, the Treasury curve, splits, dividends and market caps",
    )
    p_options.add_argument("--force", action="store_true", help="Re-fetch even if cached")
    p_options.set_defaults(func=cmd_options)

    # sync
    p_sync = subparsers.add_parser(
        "sync", help="Refresh every vendor feed, re-ingest, and rebuild all scores")
    p_sync.add_argument("--cached", action="store_true",
                        help="Replay the on-disk cache instead of re-fetching")
    p_sync.set_defaults(func=cmd_sync)

    # run
    p_run = subparsers.add_parser(
        "run", help="Run full pipeline (market + options + news + ingest + score)")
    p_run.add_argument("--force", action="store_true", help="Force API fetch")
    p_run.set_defaults(func=cmd_run)

    # check
    p_check = subparsers.add_parser("check", help="Verify all 8 acceptance criteria invariants")
    p_check.set_defaults(func=cmd_check)

    # serve
    p_serve = subparsers.add_parser("serve", help="Start web UI server")
    p_serve.add_argument("--host", default="127.0.0.1", help="Host address")
    p_serve.add_argument("--port", type=int, default=8000, help="Port number")
    p_serve.add_argument("--reload", action="store_true", help="Enable live reload")
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

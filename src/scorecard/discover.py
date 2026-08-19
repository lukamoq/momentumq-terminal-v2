"""Tavily discovery sweep — the reproducible query plan behind the curated data.

Curation is manual and evidence-backed: a call only enters `data/curated/` when a
cached search result gives a named institution, a date, and a concrete target or
stance. This module records *which* queries produced that corpus so the sourcing
is auditable and re-runnable, rather than living in a shell history somewhere.

Nothing here writes to the curated YAML. It only fills `data/cache/tavily/`.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from scorecard.config import HISTORY_START_DATE, AS_OF_DATE, TAVILY_CACHE_DIR
from scorecard.news import search_tavily

logger = logging.getLogger(__name__)

# Desks already curated in data/curated/institutions.yaml.
COVERED_DESKS = [
    ("JPM", "JPMorgan"), ("GS", "Goldman Sachs"), ("MS", "Morgan Stanley"),
    ("BAC", "Bank of America"), ("C", "Citi"), ("DB", "Deutsche Bank"),
    ("UBS", "UBS"), ("BARC", "Barclays"), ("GLE", "Societe Generale"), ("HSBC", "HSBC"),
]

# Desks that publish S&P 500 year-end targets but are not yet in the scorecard.
CANDIDATE_DESKS = [
    ("WFC", "Wells Fargo"), ("RBC", "RBC Capital Markets"), ("EVR", "Evercore ISI"),
    ("BMO", "BMO Capital Markets"), ("OPCO", "Oppenheimer"), ("FUND", "Fundstrat"),
    ("PIPR", "Piper Sandler"), ("TFC", "Truist"), ("STIF", "Stifel"),
    ("CIBC", "Scotiabank"), ("YARD", "Yardeni Research"), ("NDR", "Ned Davis Research"),
    ("BNP", "BNP Paribas"), ("MIZ", "Mizuho"), ("JEF", "Jefferies"),
]

# Sector calls now scoreable against the SPDR series in the ticker universe.
SECTOR_THEMES = [
    ("XLK", "technology sector"), ("XLE", "energy sector"), ("XLF", "financials sector"),
    ("XLV", "health care sector"), ("XLU", "utilities sector"), ("XLI", "industrials sector"),
]

# Single names in the AI/semis complex beyond the Magnificent 7.
AI_ADJACENT_NAMES = ["Broadcom AVGO", "AMD", "Micron MU", "Oracle ORCL",
                     "Palantir PLTR", "Taiwan Semiconductor TSM", "Netflix NFLX", "Arm Holdings"]


def build_query_plan() -> List[Tuple[str, str, str, str]]:
    """Return (save_name, query, start_date, end_date) for the full sweep."""
    plan: List[Tuple[str, str, str, str]] = []
    full_start, full_end = HISTORY_START_DATE, AS_OF_DATE

    # 1. Year-end outlook roundups, one per forecast year. These are the highest
    #    yield queries: a single factbox often carries eight desks' targets.
    for year in (2022, 2023, 2024, 2025, 2026):
        plan.append((
            f"roundup_ye{year}",
            f"Wall Street strategists S&P 500 year-end {year} price target forecasts factbox",
            full_start, full_end,
        ))
        plan.append((
            f"revisions_ye{year}",
            f"strategists cut raise S&P 500 {year} target revision mid-year",
            full_start, full_end,
        ))

    # 2. Desks not yet covered.
    for code, name in CANDIDATE_DESKS:
        plan.append((
            f"desk_{code.lower()}",
            f"{name} S&P 500 year-end price target strategist forecast",
            full_start, full_end,
        ))

    # 3. Probability / recession calls. The Brier path currently has one event.
    for q, name in [
        ("US recession probability forecast economists bank odds 2026", "recession_2026"),
        ("recession probability 2023 economists Wall Street odds forecast", "recession_2023"),
        ("Federal Reserve rate cut probability forecast bank economists", "fed_cuts"),
        ("hard landing soft landing probability strategist forecast", "landing"),
    ]:
        plan.append((f"prob_{name}", q, full_start, full_end))

    # 4. Allocation and rotation calls, now scoreable against sector/style series.
    plan.append(("alloc_rotation", "strategists rotate out of Magnificent 7 into equal weight S&P 500", full_start, full_end))
    plan.append(("alloc_intl", "overweight international equities versus US stocks strategist allocation", full_start, full_end))
    plan.append(("alloc_smallcap", "overweight small caps Russell 2000 strategist call", full_start, full_end))
    plan.append(("alloc_bonds", "overweight bonds duration Treasuries versus equities strategist allocation", full_start, full_end))
    for tkr, theme in SECTOR_THEMES:
        plan.append((f"sector_{tkr.lower()}", f"analysts overweight underweight {theme} outlook S&P 500", full_start, full_end))

    # 5. Big-tech / AI single names.
    for name in AI_ADJACENT_NAMES:
        slug = name.split()[0].lower()
        plan.append((f"ai_{slug}", f"{name} analyst price target upgrade downgrade rating", full_start, full_end))

    return plan


def run_discovery(
    plan: Optional[List[Tuple[str, str, str, str]]] = None,
    depth: str = "advanced",
    pause: float = 0.35,
    skip_cached: bool = True,
) -> Dict[str, int]:
    """Execute the query plan and cache each response. Returns name -> result count."""
    TAVILY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    plan = plan or build_query_plan()
    counts: Dict[str, int] = {}

    for save_name, query, start, end in plan:
        cache_file = TAVILY_CACHE_DIR / f"tavily_{save_name}.json"
        if skip_cached and cache_file.exists():
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    counts[save_name] = len(json.load(f).get("results", []))
                continue
            except Exception:
                pass
        try:
            data = search_tavily(
                query, topic="finance", search_depth=depth,
                start_date=start, end_date=end, include_answer=True,
                save_name=save_name,
            )
            counts[save_name] = len(data.get("results", []))
            logger.info("discover %-22s %2d results", save_name, counts[save_name])
        except Exception as e:  # a single bad query must not abort the sweep
            logger.warning("discover %-22s FAILED: %s", save_name, e)
            counts[save_name] = 0
        time.sleep(pause)

    return counts

"""One place that pulls every vendor feed the terminal depends on.

Before this existed, "refresh" meant different things in different callers:
``ingest`` replayed the on-disk cache without re-fetching, the API's sync
endpoint called ``ingest`` and described itself as a live sync, and the option
chain, Treasury curve and corporate reference feeds had no caller at all
because the analytics that needed them were inventing their inputs instead.

:func:`refresh_vendor_data` is now the single entry point, used by both
``python -m scorecard sync`` and ``POST /api/pipeline/sync``.

Provenance, stated plainly:

* **Daily bars, option chains, Treasury yields, splits, dividends, market cap**
  come from Massive. The plan serves a rolling five-year window of bars, so
  anything older than that window is archive.
* **Deep history** (SPY and the mega-caps back to 2000) predates the vendor
  window and comes from :mod:`scorecard.backfill`. It is never re-fetched here
  and never overwritten -- :func:`scorecard.market.load_market_data_into_db`
  reconciles only inside the span the vendor actually returned.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, Optional

from scorecard.config import OPTIONS_UNDERLYINGS
from scorecard.db import db_session, init_db
from scorecard.market import DEFAULT_TICKERS, MAG7_TICKERS, fetch_and_cache_market_data
from scorecard.optionsdata import (
    load_dividends_into_db,
    load_option_chains_into_db,
    load_splits_into_db,
    load_ticker_reference_into_db,
    load_treasury_yields_into_db,
)

logger = logging.getLogger(__name__)

# Reference data is pulled for the names the terminal actually reports on.
REFERENCE_TICKERS = tuple(OPTIONS_UNDERLYINGS) + MAG7_TICKERS


def refresh_vendor_data(
    tickers: Iterable[str] = DEFAULT_TICKERS,
    underlyings: Iterable[str] = OPTIONS_UNDERLYINGS,
    reference_tickers: Iterable[str] = REFERENCE_TICKERS,
    force: bool = True,
) -> Dict[str, Any]:
    """Re-fetch every vendor feed and load it into the database.

    Each feed is independent: a failure in one is logged and reported in the
    summary rather than aborting the rest, so a chain outage cannot also block
    the daily bars.
    """
    summary: Dict[str, Any] = {}

    try:
        counts = fetch_and_cache_market_data(tuple(tickers), force_api=force)
        summary["market_bars_fetched"] = sum(counts.values())
        summary["market_tickers"] = len(counts)
        empty = sorted(t for t, n in counts.items() if n == 0)
        if empty:
            summary["market_tickers_empty"] = empty
            logger.warning("No bars returned for: %s", ", ".join(empty))
    except Exception as exc:
        logger.warning("Market bar refresh failed: %s", exc)
        summary["market_bars_error"] = str(exc)

    init_db()
    with db_session() as conn:
        for name, fn in (
            ("treasury_yields", lambda: load_treasury_yields_into_db(conn, force_api=force)),
            ("option_contracts", lambda: load_option_chains_into_db(conn, underlyings, force_api=force)),
            ("splits", lambda: load_splits_into_db(conn, reference_tickers, force_api=force)),
            ("dividends", lambda: load_dividends_into_db(conn, reference_tickers, force_api=force)),
            ("ticker_reference", lambda: load_ticker_reference_into_db(conn, reference_tickers, force_api=force)),
        ):
            try:
                summary[name] = fn()
            except Exception as exc:
                logger.warning("%s refresh failed: %s", name, exc)
                summary[f"{name}_error"] = str(exc)

    return summary


def refresh_options_only(
    underlyings: Iterable[str] = OPTIONS_UNDERLYINGS, force: bool = True
) -> Dict[str, Any]:
    """Pull just the option chains and the Treasury curve they are discounted on."""
    init_db()
    with db_session() as conn:
        return {
            "treasury_yields": load_treasury_yields_into_db(conn, force_api=force),
            "option_contracts": load_option_chains_into_db(conn, underlyings, force_api=force),
        }

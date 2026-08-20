"""
Tests for the observed-data layer: bar reconciliation, the Treasury curve,
splits, dividends and market capitalisation.

The headline case here is :func:`test_deep_history_survives_a_reload`. Bar
reconciliation used to compare the whole table against whatever the vendor
returned and delete everything else. The vendor plan serves a rolling five-year
window, so every ingest -- and every press of the terminal's SYNC button --
deleted the archive behind it: SPY went from 6,696 bars back to 2000 down to
1,254 back to 2021, and the "27-year" seasonality curves quietly became six.
"""

import sqlite3

import pytest

from scorecard.db import get_connection, init_db
from scorecard.market import (
    BREADTH_TICKERS,
    DEFAULT_TICKERS,
    load_market_data_into_db,
    parse_massive_response,
)
from scorecard.optionsdata import (
    DEFAULT_RISK_FREE,
    format_market_cap,
    market_cap,
    risk_free_curve,
    risk_free_rate,
    split_factor_after,
    trailing_dividend_yield,
    yield_curve_slope,
)


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def memdb():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    from scorecard.db import SCHEMA_PATH

    c.executescript(SCHEMA_PATH.read_text())
    yield c
    c.close()


# ---------------------------------------------------------------------------
# Bar reconciliation
# ---------------------------------------------------------------------------


def test_deep_history_survives_a_reload(memdb):
    """
    Bars older than the vendor's window are archive and must be left alone;
    only dates *inside* the returned span may be reconciled away.
    """
    archive = [("2000-01-03", 100.0), ("2010-06-15", 200.0), ("2020-03-16", 300.0)]
    window = [("2026-08-14", 755.0), ("2026-08-18", 768.0)]
    for d, c in archive + window:
        memdb.execute(
            "INSERT INTO market_observation (date, ticker, open, high, low, close) VALUES (?,?,?,?,?,?)",
            (d, "SPY", c, c, c, c),
        )
    # A bar the vendor no longer lists, dated inside the window it does cover
    # (this is how a reassigned symbol's rows get evicted).
    stale_inside_window = "2026-08-17"
    memdb.execute(
        "INSERT INTO market_observation (date, ticker, open, high, low, close) VALUES (?,?,?,?,?,?)",
        (stale_inside_window, "SPY", 1, 1, 1, 1),
    )
    memdb.commit()

    observations = [
        {
            "date": d, "ticker": "SPY", "open": c, "high": c, "low": c, "close": c,
            "volume": 1.0, "vwap": c, "num_trades": 1, "index_level": c * 10,
        }
        for d, c in window
    ]

    import scorecard.market as market

    original = market.load_lineage_observations
    market.load_lineage_observations = lambda t: observations if t == "SPY" else []
    try:
        load_market_data_into_db(memdb, ("SPY",))
    finally:
        market.load_lineage_observations = original

    dates = [r["date"] for r in memdb.execute(
        "SELECT date FROM market_observation WHERE ticker='SPY' ORDER BY date"
    ).fetchall()]

    for d, _ in archive:
        assert d in dates, f"archive bar {d} was deleted by a reload"
    assert stale_inside_window not in dates, "stale bar inside the vendor window was not evicted"
    assert len(dates) == len(archive) + len(window)


def test_live_database_retains_its_deep_history(conn):
    """The shipped database must still carry the full seasonality window."""
    row = conn.execute(
        "SELECT COUNT(*) AS n, MIN(date) AS lo FROM market_observation WHERE ticker='SPY'"
    ).fetchone()
    if row["n"] < 2000:
        pytest.skip("deep history not backfilled in this database")
    assert row["lo"] < "2005-01-01"
    years = conn.execute(
        "SELECT COUNT(DISTINCT substr(date,1,4)) AS y FROM market_observation WHERE ticker='SPY'"
    ).fetchone()["y"]
    assert years >= 20, f"only {years} distinct years of SPY history"


def test_breadth_universe_is_in_the_default_ingest_set():
    """A universe the analytics name must be one the pipeline actually fetches."""
    for t in BREADTH_TICKERS:
        assert t in DEFAULT_TICKERS


def test_parse_massive_response_derives_the_index_level():
    raw = {"results": [{"t": 1787097600000, "o": 1, "h": 2, "l": 0.5, "c": 768.17, "v": 10, "vw": 768.0, "n": 5}]}
    obs = parse_massive_response(raw, "SPY")
    assert len(obs) == 1
    assert obs[0]["index_level"] == pytest.approx(7681.7, abs=0.01)
    assert parse_massive_response(raw, "QQQ")[0]["index_level"] is None


# ---------------------------------------------------------------------------
# Treasury curve
# ---------------------------------------------------------------------------


def test_risk_free_rate_interpolates_the_observed_curve(memdb):
    memdb.execute(
        "INSERT INTO treasury_yield (date, yield_3_month, yield_1_year, yield_2_year, yield_10_year) "
        "VALUES ('2026-08-18', 4.00, 4.40, 4.20, 4.70)"
    )
    memdb.commit()

    # A 3-month option sits exactly on a pillar.
    assert risk_free_rate(memdb, 91.25, as_of="2026-08-18") == pytest.approx(0.04, abs=1e-6)
    # Halfway between 1y (4.40) and 2y (4.20) in time -> 4.30.
    mid = risk_free_rate(memdb, 547.5, as_of="2026-08-18")
    assert mid == pytest.approx(0.043, abs=1e-4)
    # Beyond the long end clamps rather than extrapolating.
    assert risk_free_rate(memdb, 40 * 365, as_of="2026-08-18") == pytest.approx(0.047, abs=1e-6)
    # Below the short end clamps too.
    assert risk_free_rate(memdb, 1, as_of="2026-08-18") == pytest.approx(0.04, abs=1e-6)


def test_risk_free_rate_falls_back_only_when_no_curve_exists(memdb):
    assert risk_free_curve(memdb) == []
    assert risk_free_rate(memdb, 30) == DEFAULT_RISK_FREE


def test_yield_curve_slope_is_ten_minus_two(memdb):
    memdb.execute(
        "INSERT INTO treasury_yield (date, yield_2_year, yield_10_year) VALUES ('2026-08-18', 4.19, 4.71)"
    )
    memdb.commit()
    assert yield_curve_slope(memdb) == pytest.approx(0.52, abs=1e-9)


def test_live_curve_is_ingested_and_sane(conn):
    pillars = risk_free_curve(conn)
    if not pillars:
        pytest.skip("no treasury curve ingested")
    assert len(pillars) >= 3
    for tenor, rate in pillars:
        assert 0.0 <= rate <= 0.25, f"{tenor}y rate of {rate:.2%} is out of range"
    assert pillars == sorted(pillars)


# ---------------------------------------------------------------------------
# Splits, dividends, market cap
# ---------------------------------------------------------------------------


def test_split_factor_compounds_every_split_after_the_publication_date(memdb):
    memdb.executemany(
        "INSERT INTO ticker_split (ticker, execution_date, split_from, split_to) VALUES (?,?,?,?)",
        [("NVDA", "2021-07-20", 1, 4), ("NVDA", "2024-06-10", 1, 10)],
    )
    memdb.commit()
    # A target published before both splits must be divided by 40, not 10.
    assert split_factor_after(memdb, "NVDA", "2021-01-01") == pytest.approx(40.0)
    assert split_factor_after(memdb, "NVDA", "2022-01-01") == pytest.approx(10.0)
    assert split_factor_after(memdb, "NVDA", "2025-01-01") == pytest.approx(1.0)


def test_observed_splits_include_the_one_the_hand_table_missed(conn):
    """The hardcoded map carried NVDA's 2024 split but not its 2021 four-for-one."""
    rows = conn.execute(
        "SELECT execution_date FROM ticker_split WHERE ticker='NVDA'"
    ).fetchall()
    if not rows:
        pytest.skip("no split history ingested")
    dates = {r["execution_date"] for r in rows}
    assert "2024-06-10" in dates
    assert "2021-07-20" in dates


def test_trailing_dividend_yield_sums_twelve_months(memdb):
    memdb.executemany(
        "INSERT INTO ticker_dividend (ticker, ex_dividend_date, cash_amount, frequency) VALUES (?,?,?,?)",
        [
            ("SPY", "2026-06-18", 1.90, 4),
            ("SPY", "2026-03-20", 1.80, 4),
            ("SPY", "2025-12-19", 1.90, 4),
            ("SPY", "2025-09-19", 1.80, 4),
            ("SPY", "2024-06-21", 1.60, 4),  # older than a year — must be excluded
        ],
    )
    memdb.commit()
    y = trailing_dividend_yield(memdb, "SPY", 740.0, as_of="2026-08-18")
    assert y == pytest.approx((1.90 + 1.80 + 1.90 + 1.80) / 740.0, abs=1e-9)


def test_dividend_yield_is_none_when_nothing_is_ingested(memdb):
    """None distinguishes "pays nothing" from "never looked up"."""
    assert trailing_dividend_yield(memdb, "NOPE", 100.0) is None


def test_live_dividend_yields_are_plausible(conn):
    for ticker, ceiling in (("SPY", 0.04), ("QQQ", 0.03), ("IWM", 0.04)):
        row = conn.execute(
            "SELECT close FROM market_observation WHERE ticker=? ORDER BY date DESC LIMIT 1", (ticker,)
        ).fetchone()
        if not row:
            continue
        y = trailing_dividend_yield(conn, ticker, float(row["close"]))
        if y is None:
            pytest.skip(f"no dividend history for {ticker}")
        assert 0.0 < y < ceiling, f"{ticker} trailing yield {y:.2%} is implausible"


def test_format_market_cap_never_prints_a_zero_placeholder():
    assert format_market_cap(5.32e12) == "$5.32T"
    assert format_market_cap(8.124e11) == "$812.4B"
    assert format_market_cap(None) is None
    assert format_market_cap(0.0) is None


def test_live_market_caps_are_current(conn):
    """
    Regression: the caps were literals that had drifted badly -- NVDA carried
    at $3.1T against an observed $5.3T, GOOGL at $2.2T against $4.2T.
    """
    caps = {}
    for t in ("NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA"):
        cap = market_cap(conn, t)
        if cap is None:
            pytest.skip("no ticker reference ingested")
        caps[t] = cap
        assert 1e11 < cap < 1e14, f"{t} market cap of {cap} is out of range"

    stale = {"NVDA": 3.1e12, "GOOGL": 2.2e12, "TSLA": 0.7e12}
    for t, old in stale.items():
        assert abs(caps[t] - old) / old > 0.05, f"{t} still reporting the stale constant"


def test_every_bar_declares_a_source(conn):
    """No bar may claim a feed by default; provenance is answerable per row."""
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM market_observation WHERE source IS NULL OR source = ''"
    ).fetchone()["n"]
    assert n == 0


def test_vendor_bars_stay_inside_the_vendor_window(conn):
    """
    The plan serves a rolling five-year window, so a bar older than it cannot
    have come from that feed. Anything earlier is archive or derived and must
    be labelled as such — otherwise the provenance field asserts something the
    vendor could not have supplied.
    """
    from scorecard.config import HISTORY_START_DATE

    row = conn.execute(
        "SELECT COUNT(*) AS n, MIN(date) AS lo FROM market_observation WHERE source = 'massive_aggregates'"
    ).fetchone()
    if not row["n"]:
        pytest.skip("no vendor bars loaded")
    assert row["lo"] >= HISTORY_START_DATE, (
        f"vendor-tagged bars reach back to {row['lo']}, before the window at {HISTORY_START_DATE}"
    )


def test_archive_and_vendor_feeds_never_claim_the_same_session(conn):
    """Two feeds disagreeing about one session is a silent data conflict."""
    n = conn.execute(
        """
        SELECT COUNT(*) AS n FROM (
            SELECT date, ticker FROM market_observation WHERE source = 'yahoo_chart_archive'
            INTERSECT
            SELECT date, ticker FROM market_observation WHERE source = 'massive_aggregates'
        )
        """
    ).fetchone()["n"]
    assert n == 0


def test_derived_basket_is_not_labelled_as_a_vendor_feed(conn):
    """MAG7 is constructed in-process, not quoted anywhere."""
    rows = conn.execute(
        "SELECT DISTINCT source FROM market_observation WHERE ticker = 'MAG7'"
    ).fetchall()
    if not rows:
        pytest.skip("basket not built")
    assert {r["source"] for r in rows} == {"derived_equal_weight_basket"}

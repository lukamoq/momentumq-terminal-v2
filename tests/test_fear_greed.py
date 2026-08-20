"""
Unit Tests for MoQ Fear & Greed Index 2.0 Engine.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.fear_greed import compute_fear_greed_index, WEIGHTS


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def test_compute_fear_greed_index(conn):
    fg = compute_fear_greed_index(conn)
    assert "composite_score" in fg
    assert 0.0 <= fg["composite_score"] <= 100.0
    assert "label" in fg
    assert fg["label"] in ("Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed")
    assert "bar_color" in fg
    assert "categories" in fg
    assert len(fg["categories"]) == 10

    # Ensure all 10 category weights sum to 1.0
    total_w = sum(WEIGHTS.values())
    assert total_w == pytest.approx(1.0, abs=1e-5)

    for k, cat in fg["categories"].items():
        assert 0.0 <= cat["score"] <= 100.0
        assert cat["weight"] > 0
        assert "contribution" in cat
        assert "details" in cat

    assert "key_metrics" in fg
    assert "spy_price" in fg["key_metrics"]
    assert "spy_rsi" in fg["key_metrics"]


def test_api_fear_greed_endpoint(client):
    res = client.get("/api/macro/fear-greed")
    assert res.status_code == 200
    data = res.json()
    assert "composite_score" in data
    assert "categories" in data
    assert "key_metrics" in data


def test_every_named_universe_constituent_is_actually_priced(conn):
    """
    Regression: breadth and liquidity named a cross-sector universe of which
    eleven of twenty-two symbols were never ingested. Both scorers skipped a
    missing ticker silently, so what survived was eight mega-cap tech names
    reported as "market breadth". Coverage must now be complete.
    """
    fg = compute_fear_greed_index(conn)
    for key in ("breadth", "liquidity"):
        details = fg["categories"][key]["details"]
        assert details.get("missing") == [], f"{key} is missing {details.get('missing')}"
        have, want = details["coverage"].split("/")
        assert have == want, f"{key} priced {have} of {want} constituents"


def test_breadth_universe_spans_more_than_technology(conn):
    """Breadth must be measured across sectors, not on a tech basket."""
    from scorecard.fear_greed import BREADTH_UNIVERSE

    for sector_name in ("JPM", "XOM", "JNJ", "CAT", "PG"):
        assert sector_name in BREADTH_UNIVERSE
    rows = conn.execute(
        "SELECT COUNT(DISTINCT ticker) AS n FROM market_observation WHERE ticker IN (%s)"
        % ",".join("?" * len(BREADTH_UNIVERSE)),
        BREADTH_UNIVERSE,
    ).fetchone()
    assert rows["n"] == len(BREADTH_UNIVERSE)


def test_volatility_category_uses_implied_vol_not_the_vixy_price(conn):
    """
    Regression: this category ranked the VIXY share price against its own
    trailing year. VIXY bleeds to roll decay, so its price sits near the bottom
    of that range structurally and the category printed complacency regardless
    of what volatility did.
    """
    fg = compute_fear_greed_index(conn)
    details = fg["categories"]["volatility"]["details"]
    if details.get("note"):
        pytest.skip("no option chain ingested")
    assert "vix_proxy" not in details
    assert details["implied_vol_30d"] is not None
    assert 3.0 < details["implied_vol_30d"] < 150.0


def test_positioning_uses_real_option_put_call_ratios(conn):
    """
    Regression: `put_call_proxy` was VIXY share volume over SPY share volume --
    two unrelated ETF volumes, not a put/call ratio.
    """
    fg = compute_fear_greed_index(conn)
    details = fg["categories"]["positioning"]["details"]
    if details.get("note"):
        pytest.skip("no option chain ingested")
    assert "put_call_proxy" not in details

    chain = conn.execute(
        """
        SELECT
          SUM(CASE WHEN contract_type='put'  THEN open_interest ELSE 0 END) AS p,
          SUM(CASE WHEN contract_type='call' THEN open_interest ELSE 0 END) AS c
        FROM option_contract
        WHERE underlying='SPY' AND snapshot_date=(SELECT MAX(snapshot_date) FROM option_contract WHERE underlying='SPY')
        """
    ).fetchone()
    assert details["pcr_oi"] == pytest.approx(float(chain["p"]) / float(chain["c"]), abs=1e-3)


def test_macro_category_uses_the_observed_treasury_curve(conn):
    """
    Regression: the "yield curve slope" was the TLT/IEF *price* ratio, a
    duration artefact that barely moves with the curve.
    """
    fg = compute_fear_greed_index(conn)
    details = fg["categories"]["macro"]["details"]
    if details.get("note"):
        pytest.skip("no treasury curve ingested")
    assert "yield_curve_ratio" not in details
    assert details["curve_slope_10y_2y"] == pytest.approx(
        details["yield_10y"] - details["yield_2y"], abs=1e-6
    )


def test_unmeasured_categories_are_flagged_not_silently_neutral(conn):
    """A category that lacks its input must say so rather than score a quiet 50."""
    fg = compute_fear_greed_index(conn)
    for key, cat in fg["categories"].items():
        if not cat["measured"]:
            assert cat["details"].get("note"), f"{key} unmeasured but gives no reason"
            assert key in fg["degraded_categories"]

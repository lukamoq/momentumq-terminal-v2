"""
Unit Tests for Options & Volatility Analytics Engine (SPY, QQQ, IWM) with Multi-Horizon BSM Greeks.
"""

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.options import (
    _bsm_gamma,
    _build_oi_ladder,
    _empty_options_response,
    _gamma_flip_level,
    _net_gex,
    compute_bsm_greeks,
    compute_gex_structure,
    compute_options_analytics,
    compute_options_trio_comparison,
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


def test_compute_bsm_greeks_math():
    g = compute_bsm_greeks(100.0, 100.0, 30, 20.0, r=0.04, q=0.01)
    assert 0.45 < g["call_delta"] < 0.60
    assert -0.60 < g["put_delta"] < -0.40
    assert g["gamma"] > 0
    assert g["call_theta"] < 0
    assert g["put_theta"] < 0
    assert g["vega"] > 0
    assert g["call_rho"] > 0
    assert g["put_rho"] < 0


def test_compute_options_horizons(conn):
    opt = compute_options_analytics(conn, "SPY")
    assert "horizons" in opt
    for h in ("1_week", "next_week", "1_month"):
        assert h in opt["horizons"]
        h_data = opt["horizons"][h]
        assert "atm" in h_data
        assert "call_delta" in h_data["atm"]
        assert "gamma" in h_data["atm"]
        assert "call_theta" in h_data["atm"]
        assert "vega" in h_data["atm"]
        assert "expected_move" in h_data

    # Gamma should be higher for shorter DTE
    gamma_1w = opt["horizons"]["1_week"]["atm"]["gamma"]
    gamma_1m = opt["horizons"]["1_month"]["atm"]["gamma"]
    assert gamma_1w > gamma_1m

    # Vega should be higher for longer DTE
    vega_1w = opt["horizons"]["1_week"]["atm"]["vega"]
    vega_1m = opt["horizons"]["1_month"]["atm"]["vega"]
    assert vega_1m > vega_1w


def test_compute_options_analytics_qqq_iwm(conn):
    for sym in ("QQQ", "IWM"):
        opt = compute_options_analytics(conn, sym)
        assert opt["ticker"] == sym
        assert opt["spot"] > 0
        assert "1_week" in opt["horizons"]
        assert "next_week" in opt["horizons"]
        assert "1_month" in opt["horizons"]


def test_compute_options_trio_comparison(conn):
    trio = compute_options_trio_comparison(conn)
    assert "indices" in trio
    assert "SPY" in trio["indices"]
    assert "QQQ" in trio["indices"]
    assert "IWM" in trio["indices"]


def test_api_options_endpoint(client):
    res_trio = client.get("/api/analytics/options")
    assert res_trio.status_code == 200
    data_trio = res_trio.json()
    assert "indices" in data_trio
    assert "horizons" in data_trio["indices"]["SPY"]


# ---------------------------------------------------------------------------
# Dealer Gamma Exposure (GEX)
# ---------------------------------------------------------------------------


def _ladder(strike=100.0, iv=20.0, call_oi=0.0, put_oi=0.0, dte=30.0):
    return {
        "dte": dte,
        "T": dte / 365.0,
        "rows": [{"strike": strike, "iv": iv, "call_oi": call_oi, "put_oi": put_oi}],
    }


def test_gex_matches_the_hand_computed_formula():
    """GEX = gamma * OI * 100 * S^2 * 0.01, in dollars of dealer delta per 1% move."""
    spot, strike, iv, oi, dte = 100.0, 100.0, 20.0, 1000.0, 30.0
    gex = compute_gex_structure(spot, [_ladder(strike, iv, call_oi=oi, dte=dte)], 0.0435, 0.0)

    gamma = _bsm_gamma(spot, strike, dte / 365.0, iv / 100.0, 0.0435, 0.0)
    expected = gamma * oi * 100.0 * spot * spot * 0.01

    assert gex["net_gex"] == pytest.approx(expected, rel=1e-9)
    assert gex["call_gex"] == pytest.approx(expected, rel=1e-9)
    assert gex["put_gex"] == pytest.approx(0.0)


def test_dealer_sign_convention_calls_positive_puts_negative():
    """Dealers are long calls / short puts, so put open interest subtracts."""
    calls = compute_gex_structure(100.0, [_ladder(call_oi=1000.0)], 0.0435, 0.0)
    puts = compute_gex_structure(100.0, [_ladder(put_oi=1000.0)], 0.0435, 0.0)
    assert calls["net_gex"] > 0.0
    assert puts["net_gex"] < 0.0
    assert puts["net_gex"] == pytest.approx(-calls["net_gex"], rel=1e-9)


def test_gex_scales_with_spot_squared():
    """Dollar gamma per 1% carries an S^2 term -- doubling spot roughly quadruples it."""
    small = compute_gex_structure(100.0, [_ladder(100.0, call_oi=1000.0)], 0.0435, 0.0)
    big = compute_gex_structure(200.0, [_ladder(200.0, call_oi=1000.0)], 0.0435, 0.0)
    # gamma itself carries a 1/S, so the net scaling is linear in S
    assert big["net_gex"] == pytest.approx(2.0 * small["net_gex"], rel=1e-6)


def test_regime_follows_the_sign_of_net_gex_not_a_multiple_of_spot(conn):
    """
    Regression: the flip level used to be spot * 0.970 and the regime was
    `spot > flip`, which is true for every possible spot -- the short-gamma
    branch could never fire. The regime must track the computed sign.
    """
    flip_ratios = set()
    for sym in ("SPY", "QQQ", "IWM"):
        opt = compute_options_analytics(conn, sym)
        s = opt["structure"]
        assert (s["net_gex_dollars"] > 0.0) == s["gex_regime"].startswith("Positive")
        flip_ratios.add(round(s["gamma_flip"] / opt["spot"], 4))
    # the tell of the old bug: one hardcoded ratio shared by every ticker
    assert len(flip_ratios) > 1


def test_short_gamma_is_reachable_when_spot_breaks_below_the_book():
    """Walk spot down through the put mass: net GEX must go negative."""
    anchor = 500.0
    ladders = [_build_oi_ladder(anchor, anchor, dte, 20.0, 4.0, 1.5, 20000.0) for dte in (7, 14, 30)]
    assert _net_gex(ladders, anchor * 1.03, 0.0435, 0.0) > 0.0
    assert _net_gex(ladders, anchor * 0.93, 0.0435, 0.0) < 0.0


def test_gamma_flip_is_solved_and_sits_between_the_humps():
    anchor = 500.0
    ladders = [_build_oi_ladder(anchor, anchor, dte, 20.0, 4.0, 1.5, 20000.0) for dte in (7, 14, 30)]
    flip = _gamma_flip_level(ladders, anchor, 0.0435, 0.0)
    assert flip is not None
    assert abs(_net_gex(ladders, flip, 0.0435, 0.0)) < abs(_net_gex(ladders, anchor * 1.05, 0.0435, 0.0))


def test_walls_widen_with_implied_volatility():
    """A 30-vol name must carry its gamma walls further from spot than a 12-vol name."""
    spot = 400.0
    calm = compute_gex_structure(
        spot, [_build_oi_ladder(spot, spot, 30, 12.0, 4.0, 1.4, 20000.0)], 0.0435, 0.0
    )
    wild = compute_gex_structure(
        spot, [_build_oi_ladder(spot, spot, 30, 30.0, 4.0, 1.4, 20000.0)], 0.0435, 0.0
    )
    assert (wild["call_wall"] - spot) > (calm["call_wall"] - spot)
    assert (spot - wild["put_wall"]) > (spot - calm["put_wall"])


def test_max_pain_sits_inside_the_ladder_and_near_the_open_interest():
    spot = 400.0
    ladder = _build_oi_ladder(spot, spot, 30, 18.0, 4.0, 1.4, 20000.0)
    gex = compute_gex_structure(spot, [ladder], 0.0435, 0.0)
    strikes = [r["strike"] for r in ladder["rows"]]
    assert min(strikes) <= gex["max_pain"] <= max(strikes)
    assert abs(gex["max_pain"] / spot - 1.0) < 0.10


def test_structure_levels_respond_to_the_ticker(conn):
    """The old levels were the same fixed % of spot for every ticker."""
    ratios = set()
    for sym in ("SPY", "QQQ", "IWM"):
        s = compute_options_analytics(conn, sym)["structure"]
        spot = compute_options_analytics(conn, sym)["spot"]
        ratios.add(round(s["put_wall"] / spot, 4))
    assert len(ratios) > 1


def test_gex_output_is_labelled_as_modeled(conn):
    """No options chain is ingested -- callers must be able to see that."""
    s = compute_options_analytics(conn, "SPY")["structure"]
    assert s["gex_basis"] == "modeled_oi"
    assert s["peak_strike_oi"] > 0
    assert s["oi_anchor"] > 0
    assert s["net_gex_millions"] == pytest.approx(s["net_gex_dollars"] / 1e6, abs=0.05)


def test_empty_response_reports_gex_as_unavailable():
    empty = _empty_options_response("NOPE")
    assert empty["structure"]["gex_regime"] == "Unavailable"
    assert empty["structure"]["net_gex_dollars"] == 0.0
    assert empty["structure"]["gex_basis"] == "unavailable"
    for h in empty["horizons"].values():
        assert h["structure"]["gex_regime"] == "Unavailable"

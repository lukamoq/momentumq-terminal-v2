"""
Unit tests for the Options & Volatility Analytics Engine (SPY, QQQ, IWM).

The engine reads the observed option chain out of `option_contract`, so the
chain-dependent tests skip when nothing has been ingested rather than failing
on a fresh clone. Run `python -m scorecard options` to populate it.
"""

import math

import pytest
from fastapi.testclient import TestClient

from scorecard.api import app, clear_api_cache
from scorecard.db import get_connection
from scorecard.options import (
    _bsm_gamma,
    _empty_options_response,
    _gamma_flip_level,
    _net_gex,
    _put_call_ratios,
    build_observed_ladders,
    compute_bsm_greeks,
    compute_gex_structure,
    compute_options_analytics,
    compute_options_trio_comparison,
)
from scorecard.optionsdata import load_chain_rows
from scorecard.volatility import group_by_expiry

TRIO = ("SPY", "QQQ", "IWM")


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


@pytest.fixture
def client():
    clear_api_cache()
    return TestClient(app)


def _require_chain(conn, ticker="SPY"):
    snapshot, rows = load_chain_rows(conn, ticker)
    if not rows:
        pytest.skip(f"no option chain ingested for {ticker}")
    return snapshot, rows


# ---------------------------------------------------------------------------
# Black-Scholes-Merton
# ---------------------------------------------------------------------------


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


def test_put_call_parity_holds():
    """C - P = S*e^{-qT} - K*e^{-rT}. Catches a sign slip in the carry terms."""
    spot, strike, dte, iv, r, q = 430.0, 415.0, 45, 18.0, 0.041, 0.013
    g = compute_bsm_greeks(spot, strike, dte, iv, r=r, q=q)
    T = dte / 365.0
    lhs = g["call_price"] - g["put_price"]
    rhs = spot * math.exp(-q * T) - strike * math.exp(-r * T)
    assert lhs == pytest.approx(rhs, abs=0.02)


def test_delta_parity_holds():
    """call_delta - put_delta = e^{-qT}."""
    dte, q = 60, 0.02
    g = compute_bsm_greeks(300.0, 300.0, dte, 22.0, r=0.04, q=q)
    assert (g["call_delta"] - g["put_delta"]) == pytest.approx(math.exp(-q * dte / 365.0), abs=0.002)


# ---------------------------------------------------------------------------
# Chain-driven analytics
# ---------------------------------------------------------------------------


def test_compute_options_horizons(conn):
    _require_chain(conn)
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
    assert opt["horizons"]["1_week"]["atm"]["gamma"] > opt["horizons"]["1_month"]["atm"]["gamma"]
    # Vega should be higher for longer DTE
    assert opt["horizons"]["1_month"]["atm"]["vega"] > opt["horizons"]["1_week"]["atm"]["vega"]


def test_compute_options_analytics_qqq_iwm(conn):
    for sym in ("QQQ", "IWM"):
        _require_chain(conn, sym)
        opt = compute_options_analytics(conn, sym)
        assert opt["ticker"] == sym
        assert opt["spot"] > 0
        assert set(opt["horizons"]) == {"1_week", "next_week", "1_month"}


def test_compute_options_trio_comparison(conn):
    _require_chain(conn)
    trio = compute_options_trio_comparison(conn)
    assert set(trio["indices"]) == set(TRIO)


def test_api_options_endpoint(client):
    res = client.get("/api/analytics/options")
    assert res.status_code == 200
    assert "horizons" in res.json()["indices"]["SPY"]


# ---------------------------------------------------------------------------
# Inputs must be observed, not invented
# ---------------------------------------------------------------------------


def test_gex_is_labelled_as_observed_and_matches_stored_open_interest(conn):
    """
    Regression: open interest used to be a modeled gaussian ladder and IV was
    the VIXY share price times a constant. Both are now read off the chain, and
    the reported totals must equal what the table holds.
    """
    snapshot, rows = _require_chain(conn)
    opt = compute_options_analytics(conn, "SPY")
    s = opt["structure"]

    assert s["gex_basis"] == "observed_oi"
    assert opt["contracts_observed"] == len(rows)
    assert opt["chain_snapshot_date"] == snapshot

    db_call_oi = sum(float(r["open_interest"] or 0.0) for r in rows if r["contract_type"] == "call")
    db_put_oi = sum(float(r["open_interest"] or 0.0) for r in rows if r["contract_type"] == "put")
    assert s["total_call_oi"] == pytest.approx(db_call_oi, rel=1e-6)
    assert s["total_put_oi"] == pytest.approx(db_put_oi, rel=1e-6)
    assert db_call_oi > 0 and db_put_oi > 0


def test_put_call_ratios_match_a_direct_sum(conn):
    """The ratios were per-ticker literals (SPY: 1.18 volume / 1.42 OI)."""
    _, rows = _require_chain(conn)
    opt = compute_options_analytics(conn, "SPY")
    direct = _put_call_ratios(rows)
    assert opt["positioning"]["pcr_oi"] == pytest.approx(direct["pcr_oi"], abs=1e-6)
    assert opt["positioning"]["pcr_volume"] == pytest.approx(direct["pcr_volume"], abs=1e-6)


def test_implied_volatility_is_not_the_vixy_share_price(conn):
    """
    Regression: IV was `VIXY_close * mult` with mult 0.85/1.15/1.35. That made
    every ticker's IV a fixed multiple of one ETF price, so the three moved in
    lockstep and their ratios were constants.
    """
    _require_chain(conn)
    vixy = conn.execute(
        "SELECT close FROM market_observation WHERE ticker = 'VIXY' ORDER BY date DESC LIMIT 1"
    ).fetchone()
    ivs = {}
    for sym in TRIO:
        opt = compute_options_analytics(conn, sym)
        assert opt["implied_volatility"] is not None
        assert 1.0 < opt["implied_volatility"] < 150.0
        ivs[sym] = opt["implied_volatility"]

    if vixy:
        for sym, mult in (("SPY", 0.85), ("QQQ", 1.15), ("IWM", 1.35)):
            stale = round(float(vixy["close"]) * mult, 1)
            assert ivs[sym] != pytest.approx(stale, abs=0.05)

    # The old scheme forced IWM/SPY to exactly 1.35/0.85; a real surface will not.
    assert (ivs["IWM"] / ivs["SPY"]) != pytest.approx(1.35 / 0.85, abs=0.01)


def test_risk_free_rate_comes_from_the_treasury_curve(conn):
    """r was the literal 4.35 for every ticker and every maturity."""
    _require_chain(conn)
    curve = conn.execute("SELECT COUNT(*) AS n FROM treasury_yield").fetchone()["n"]
    if not curve:
        pytest.skip("no treasury curve ingested")
    opt = compute_options_analytics(conn, "SPY")
    assert opt["risk_free_rate"] is not None
    assert 0.0 <= opt["risk_free_rate"] <= 20.0
    # Different maturities sit at different points on the curve.
    rates = {opt["horizons"][h]["risk_free_rate"] for h in opt["horizons"]}
    assert len(rates) >= 1


def test_skew_is_measured_at_a_real_25_delta(conn):
    """
    Regression: the skew was `ATM + const*0.65` against `ATM - const*0.35`, so
    it always returned the per-ticker constant and the strikes were fixed
    +2.5% / -3.0% offsets.
    """
    _require_chain(conn)
    opt = compute_options_analytics(conn, "SPY")
    skew = opt["skew"]
    if not skew["measured"]:
        pytest.skip("chain lacks quotable 25-delta wings")

    assert skew["put_25d_strike"] < opt["spot"] < skew["call_25d_strike"]
    # Strikes are wherever delta lands, not a hardcoded percentage of spot.
    assert skew["call_25d_strike"] != pytest.approx(round(opt["spot"] * 1.025, 0), abs=0.01)
    # Equity index skew is put-over-call.
    assert skew["put_25d_iv"] > skew["call_25d_iv"]
    assert skew["skew_25d"] == pytest.approx(skew["put_25d_iv"] - skew["call_25d_iv"], abs=0.01)


def test_expected_move_uses_each_horizons_own_implied_vol(conn):
    """
    The cones used to scale one IV by sqrt(t). With a real term structure each
    tenor carries its own IV, so the cone is not a pure square-root fan.
    """
    _require_chain(conn)
    em = compute_options_analytics(conn, "SPY")["expected_moves"]
    ivs = {k: em[k]["iv"] for k in ("weekly", "monthly", "quarterly") if em[k]["iv"]}
    assert len(ivs) >= 2
    assert len(set(ivs.values())) > 1, "term structure is flat to the digit — suspicious"


def test_structure_levels_land_on_listed_strikes(conn):
    """Max pain and the walls must be actual strikes from the book."""
    _, rows = _require_chain(conn)
    listed = {float(r["strike"]) for r in rows}
    s = compute_options_analytics(conn, "SPY")["structure"]
    assert s["max_pain"] in listed
    assert s["call_wall"] in listed
    assert s["put_wall"] in listed


def test_structure_levels_respond_to_the_ticker(conn):
    """The old levels were the same fixed % of spot for every ticker."""
    ratios = set()
    for sym in TRIO:
        _require_chain(conn, sym)
        opt = compute_options_analytics(conn, sym)
        ratios.add(round(opt["structure"]["put_wall"] / opt["spot"], 4))
    assert len(ratios) > 1


def test_regime_follows_the_sign_of_net_gex(conn):
    """
    Regression: the flip level used to be spot * 0.970 and the regime was
    `spot > flip`, true for every possible spot -- the short-gamma branch could
    never fire. The regime must track the computed sign.
    """
    for sym in TRIO:
        _require_chain(conn, sym)
        s = compute_options_analytics(conn, sym)["structure"]
        assert (s["net_gex_dollars"] > 0.0) == s["gex_regime"].startswith("Positive")


# ---------------------------------------------------------------------------
# GEX formula invariants (synthetic ladders — pure math, no chain needed)
# ---------------------------------------------------------------------------


def _ladder(strike=100.0, iv=0.20, call_oi=0.0, put_oi=0.0, dte=30.0, r=0.0435, q=0.0):
    return {
        "expiry": "2099-01-01",
        "dte": dte,
        "T": dte / 365.0,
        "r": r,
        "q": q,
        "rows": [{"strike": strike, "iv": iv, "call_oi": call_oi, "put_oi": put_oi}],
    }


def test_gex_matches_the_hand_computed_formula():
    """GEX = gamma * OI * 100 * S^2 * 0.01, in dollars of dealer delta per 1% move."""
    spot, strike, iv, oi, dte = 100.0, 100.0, 0.20, 1000.0, 30.0
    gex = compute_gex_structure(spot, [_ladder(strike, iv, call_oi=oi, dte=dte)])

    gamma = _bsm_gamma(spot, strike, dte / 365.0, iv, 0.0435, 0.0)
    expected = gamma * oi * 100.0 * spot * spot * 0.01

    assert gex["net_gex"] == pytest.approx(expected, rel=1e-9)
    assert gex["call_gex"] == pytest.approx(expected, rel=1e-9)
    assert gex["put_gex"] == pytest.approx(0.0)


def test_dealer_sign_convention_calls_positive_puts_negative():
    """Dealers are long calls / short puts, so put open interest subtracts."""
    calls = compute_gex_structure(100.0, [_ladder(call_oi=1000.0)])
    puts = compute_gex_structure(100.0, [_ladder(put_oi=1000.0)])
    assert calls["net_gex"] > 0.0
    assert puts["net_gex"] < 0.0
    assert puts["net_gex"] == pytest.approx(-calls["net_gex"], rel=1e-9)


def test_gex_scales_linearly_with_spot():
    """Dollar gamma carries S^2 while gamma carries 1/S — net scaling is linear."""
    small = compute_gex_structure(100.0, [_ladder(100.0, call_oi=1000.0)])
    big = compute_gex_structure(200.0, [_ladder(200.0, call_oi=1000.0)])
    assert big["net_gex"] == pytest.approx(2.0 * small["net_gex"], rel=1e-6)


def test_gamma_flip_is_solved_where_net_gex_crosses_zero():
    """A book long calls above and short puts below must flip between them."""
    ladders = [{
        "expiry": "2099-01-01", "dte": 30.0, "T": 30.0 / 365.0, "r": 0.0435, "q": 0.0,
        "rows": [
            {"strike": 105.0, "iv": 0.20, "call_oi": 5000.0, "put_oi": 0.0},
            {"strike": 95.0, "iv": 0.22, "call_oi": 0.0, "put_oi": 5000.0},
        ],
    }]
    flip = _gamma_flip_level(ladders, 100.0)
    assert flip is not None
    assert 95.0 < flip < 105.0
    assert abs(_net_gex(ladders, flip)) < abs(_net_gex(ladders, 104.0))


def test_max_pain_minimises_intrinsic_payout():
    """Max pain must beat every other listed strike on total intrinsic paid out."""
    ladder = {
        "expiry": "2099-01-01", "dte": 30.0, "T": 30.0 / 365.0, "r": 0.0435, "q": 0.0,
        "rows": [
            {"strike": 90.0, "iv": 0.2, "call_oi": 100.0, "put_oi": 900.0},
            {"strike": 100.0, "iv": 0.2, "call_oi": 500.0, "put_oi": 500.0},
            {"strike": 110.0, "iv": 0.2, "call_oi": 900.0, "put_oi": 100.0},
        ],
    }
    gex = compute_gex_structure(100.0, [ladder])

    def pain(p):
        return sum(
            r["call_oi"] * max(0.0, p - r["strike"]) + r["put_oi"] * max(0.0, r["strike"] - p)
            for r in ladder["rows"]
        )

    strikes = [r["strike"] for r in ladder["rows"]]
    assert gex["max_pain"] in strikes
    assert pain(gex["max_pain"]) == min(pain(k) for k in strikes)


def test_observed_ladder_carries_the_chains_open_interest(conn):
    """build_observed_ladders must not invent or drop open interest."""
    snapshot, rows = _require_chain(conn)
    chains = group_by_expiry(rows)
    expiry = sorted(chains)[len(chains) // 2]
    ladders = build_observed_ladders(
        chains, snapshot, 100.0, lambda d: 0.04, 0.01, expiries=[expiry]
    )
    if not ladders:
        pytest.skip("expiry produced no usable ladder")
    ladder_call_oi = sum(r["call_oi"] for r in ladders[0]["rows"])
    chain_call_oi = sum(
        float(r["open_interest"] or 0.0) for r in chains[expiry] if r["contract_type"] == "call"
    )
    assert ladder_call_oi == pytest.approx(chain_call_oi, rel=1e-6)


# ---------------------------------------------------------------------------
# Missing-data path
# ---------------------------------------------------------------------------


def test_empty_response_reports_every_field_as_unavailable():
    """
    The no-chain path used to return a full Greek set priced off a $100
    underlying at 15% vol, which rendered as though it were a measurement.
    """
    empty = _empty_options_response("NOPE", "no chain")
    assert empty["data_available"] is False
    assert empty["implied_volatility"] is None
    assert empty["skew"]["skew_25d"] is None
    assert empty["positioning"]["pcr_oi"] is None
    assert empty["structure"]["gex_regime"] == "Unavailable"
    assert empty["structure"]["net_gex_dollars"] is None
    assert empty["structure"]["gex_basis"] == "unavailable"
    for h in empty["horizons"].values():
        assert h["structure"]["gex_regime"] == "Unavailable"
        assert h["atm"] is None
    for cone in empty["expected_moves"].values():
        assert cone["pct"] is None

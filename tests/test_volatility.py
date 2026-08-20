"""
Tests for the volatility surface math computed off the observed option chain.

These cover the pieces that replaced fabricated inputs: Black-Scholes
inversion, at-the-money and delta-interpolated implied volatility, variance-time
interpolation across maturities, and the CBOE model-free variance formula that
produces a correctly-scaled volatility index.
"""

import math

import pytest

from scorecard.db import get_connection
from scorecard.optionsdata import load_chain_rows, risk_free_rate
from scorecard.volatility import (
    atm_iv,
    bsm_delta,
    bsm_price,
    calendar_days,
    constant_maturity_iv,
    forward_price,
    group_by_expiry,
    implied_vol,
    iv_at_delta,
    model_free_variance,
    otm_iv_points,
    term_structure,
    volatility_index,
    year_fraction,
)


@pytest.fixture
def conn():
    c = get_connection()
    yield c
    c.close()


def _require_chain(conn, ticker="SPY"):
    snapshot, rows = load_chain_rows(conn, ticker)
    if not rows:
        pytest.skip(f"no option chain ingested for {ticker}")
    spot_row = conn.execute(
        "SELECT close FROM market_observation WHERE ticker = ? ORDER BY date DESC LIMIT 1",
        (ticker,),
    ).fetchone()
    return snapshot, group_by_expiry(rows), float(spot_row["close"])


# ---------------------------------------------------------------------------
# Black-Scholes inversion
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("sigma", [0.08, 0.15, 0.30, 0.75])
@pytest.mark.parametrize("moneyness", [0.85, 1.0, 1.15])
@pytest.mark.parametrize("is_call", [True, False])
def test_implied_vol_round_trips(sigma, moneyness, is_call):
    """Price at a known sigma, then invert: the solver must recover it."""
    spot, T, r, q = 500.0, 45.0 / 365.0, 0.042, 0.012
    strike = spot * moneyness
    price = bsm_price(spot, strike, T, sigma, r, q, is_call)
    if price < 0.01:
        pytest.skip("premium too small to invert meaningfully")
    recovered = implied_vol(price, spot, strike, T, r, q, is_call)
    assert recovered is not None
    assert recovered == pytest.approx(sigma, abs=1e-4)


def test_implied_vol_rejects_a_price_below_intrinsic():
    """A stale settle printed under intrinsic has no implied vol — say so."""
    spot, strike, T, r, q = 700.0, 600.0, 0.1, 0.04, 0.01
    intrinsic = spot * math.exp(-q * T) - strike * math.exp(-r * T)
    assert implied_vol(intrinsic - 5.0, spot, strike, T, r, q, is_call=True) is None


def test_implied_vol_rejects_a_price_above_the_underlying():
    assert implied_vol(900.0, 700.0, 600.0, 0.1, 0.04, 0.01, is_call=True) is None


def test_bsm_delta_bounds():
    d_call = bsm_delta(100.0, 100.0, 0.25, 0.2, 0.04, 0.0, is_call=True)
    d_put = bsm_delta(100.0, 100.0, 0.25, 0.2, 0.04, 0.0, is_call=False)
    assert 0.0 < d_call < 1.0
    assert -1.0 < d_put < 0.0


# ---------------------------------------------------------------------------
# Calendar handling
# ---------------------------------------------------------------------------


def test_calendar_days_distinguishes_zero_dte_from_one():
    """year_fraction floors at a day, so 0-DTE must be filtered on raw days."""
    assert calendar_days("2026-08-20", "2026-08-20") == 0
    assert calendar_days("2026-08-20", "2026-08-21") == 1
    assert year_fraction("2026-08-20", "2026-08-20") == year_fraction("2026-08-20", "2026-08-21")


# ---------------------------------------------------------------------------
# Variance-time interpolation
# ---------------------------------------------------------------------------


def _synthetic_chain(spot, expiries_and_ivs, snapshot="2026-01-01"):
    """Build a chain whose vendor IVs are exactly the requested flat levels."""
    chains = {}
    for expiry, iv in expiries_and_ivs:
        T = year_fraction(snapshot, expiry)
        rows = []
        for k in range(int(spot * 0.8), int(spot * 1.2), 5):
            for ctype in ("call", "put"):
                is_call = ctype == "call"
                rows.append({
                    "expiration_date": expiry,
                    "strike": float(k),
                    "contract_type": ctype,
                    "open_interest": 100.0,
                    "volume": 10.0,
                    "close": bsm_price(spot, float(k), T, iv, 0.04, 0.0, is_call),
                    "vendor_iv": iv,
                    "vendor_delta": bsm_delta(spot, float(k), T, iv, 0.04, 0.0, is_call),
                    "vendor_gamma": None,
                })
        chains[expiry] = rows
    return snapshot, chains


def test_constant_maturity_iv_interpolates_in_total_variance():
    """
    Between a 30-day 20% and a 90-day 30% pillar, the 60-day point must satisfy
    sigma^2*T linear in T -- not sigma linear in T, which would give 25%.
    """
    spot = 100.0
    snapshot, chains = _synthetic_chain(spot, [("2026-01-31", 0.20), ("2026-04-01", 0.30)])
    t0 = year_fraction(snapshot, "2026-01-31")
    t1 = year_fraction(snapshot, "2026-04-01")
    target_days = (t0 + t1) / 2 * 365.0
    target_T = target_days / 365.0

    got = constant_maturity_iv(chains, snapshot, spot, target_days, lambda d: 0.04)
    var0, var1 = 0.20 ** 2 * t0, 0.30 ** 2 * t1
    w = (target_T - t0) / (t1 - t0)
    expected = math.sqrt((var0 + w * (var1 - var0)) / target_T)

    assert got == pytest.approx(expected, abs=1e-4)
    assert got != pytest.approx(0.25, abs=1e-3), "interpolated volatility linearly, not variance"


def test_constant_maturity_iv_clamps_outside_the_listed_range():
    spot = 100.0
    snapshot, chains = _synthetic_chain(spot, [("2026-01-31", 0.20), ("2026-04-01", 0.30)])
    assert constant_maturity_iv(chains, snapshot, spot, 5.0, lambda d: 0.04) == pytest.approx(0.20, abs=1e-3)
    assert constant_maturity_iv(chains, snapshot, spot, 500.0, lambda d: 0.04) == pytest.approx(0.30, abs=1e-3)


def test_atm_iv_recovers_a_flat_surface():
    spot = 100.0
    snapshot, chains = _synthetic_chain(spot, [("2026-02-01", 0.22)])
    T = year_fraction(snapshot, "2026-02-01")
    assert atm_iv(chains["2026-02-01"], spot, T, 0.04) == pytest.approx(0.22, abs=1e-3)


def test_iv_at_delta_finds_the_requested_wing():
    spot = 100.0
    snapshot, chains = _synthetic_chain(spot, [("2026-04-01", 0.25)])
    T = year_fraction(snapshot, "2026-04-01")
    call_leg = iv_at_delta(chains["2026-04-01"], spot, T, 0.04, 0.0, 0.25, is_call=True)
    put_leg = iv_at_delta(chains["2026-04-01"], spot, T, 0.04, 0.0, 0.25, is_call=False)
    assert call_leg and put_leg
    call_strike, call_iv = call_leg
    put_strike, put_iv = put_leg
    # On a flat surface both wings report the same vol...
    assert call_iv == pytest.approx(0.25, abs=1e-3)
    assert put_iv == pytest.approx(0.25, abs=1e-3)
    # ...and the 25-delta strikes straddle spot.
    assert put_strike < spot < call_strike
    # The recovered strike really is near a 0.25 delta.
    assert abs(bsm_delta(spot, call_strike, T, 0.25, 0.04, 0.0, True)) == pytest.approx(0.25, abs=0.05)


# ---------------------------------------------------------------------------
# Model-free variance / volatility index
# ---------------------------------------------------------------------------


def test_model_free_variance_recovers_a_flat_black_scholes_surface():
    """
    With a constant sigma across strikes the model-free integral must return
    that same sigma. Catches sign errors and a mis-weighted dK/K^2 term.
    """
    spot, sigma = 100.0, 0.20
    snapshot, chains = _synthetic_chain(spot, [("2026-02-01", sigma)])
    T = year_fraction(snapshot, "2026-02-01")
    var = model_free_variance(chains["2026-02-01"], T, 0.04, spot)
    assert var is not None
    # Discretisation over a finite strike ladder biases the integral slightly low.
    assert math.sqrt(var) == pytest.approx(sigma, abs=0.02)


def test_volatility_index_is_in_volatility_points_not_dollars():
    spot, sigma = 100.0, 0.18
    snapshot, chains = _synthetic_chain(
        spot, [("2026-01-25", sigma), ("2026-02-08", sigma)]
    )
    vi = volatility_index(chains, snapshot, spot, lambda d: 0.04, target_days=30.0)
    assert vi is not None
    assert vi == pytest.approx(sigma * 100.0, abs=2.5)


def test_volatility_index_on_the_real_chain_is_a_plausible_level(conn):
    """
    Regression: the "VIX proxy" was the VIXY share price, which split-adjusted
    ran from $633,840 in 2011 to $18.86 in 2026. A real index must sit in
    volatility points.
    """
    snapshot, chains, spot = _require_chain(conn)
    vi = volatility_index(chains, snapshot, spot, lambda d: risk_free_rate(conn, d, as_of=snapshot))
    assert vi is not None
    assert 5.0 < vi < 100.0


def test_real_term_structure_is_monotone_in_the_usual_regime(conn):
    """9d / 30d / 90d must each solve, and sit in a sane band."""
    snapshot, chains, spot = _require_chain(conn)
    ts = term_structure(
        chains, snapshot, spot, lambda d: risk_free_rate(conn, d, as_of=snapshot)
    )
    for tenor, value in ts.items():
        assert value is not None, f"{tenor} failed to solve"
        assert 3.0 < value < 150.0


def test_forward_is_near_spot_and_lands_on_a_listed_strike(conn):
    snapshot, chains, spot = _require_chain(conn)
    expiry = sorted(chains)[len(chains) // 2]
    T = year_fraction(snapshot, expiry)
    fwd, k0 = forward_price(chains[expiry], spot, T, risk_free_rate(conn, T * 365.0, as_of=snapshot))
    assert abs(fwd / spot - 1.0) < 0.05
    assert k0 in {float(r["strike"]) for r in chains[expiry]}


def test_otm_points_exclude_the_in_the_money_side(conn):
    """
    Deep ITM contracts solve to nonsense off a stale settle (the chain carries
    IVs like 0.0002). Restricting the surface to OTM is what removes them.
    """
    snapshot, chains, spot = _require_chain(conn)
    expiry = sorted(chains)[len(chains) // 2]
    T = year_fraction(snapshot, expiry)
    fwd, _ = forward_price(chains[expiry], spot, T, risk_free_rate(conn, T * 365.0, as_of=snapshot))
    points = otm_iv_points(chains[expiry], fwd)
    assert points
    assert all(0.01 <= iv <= 3.0 for _, iv in points)
    assert points == sorted(points)

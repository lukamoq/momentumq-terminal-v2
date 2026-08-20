"""Volatility surface math computed from the observed option chain.

Nothing here is calibrated, assumed, or scaled off an ETF share price. Every
number is derived from listed contracts: their strikes, their settle prices,
their open interest, and the vendor's own implied volatilities.

What this module provides:

* :func:`implied_vol` -- Black-Scholes inversion by bracketed bisection, used
  to fill in an IV the vendor did not solve and to sanity-check the ones it did.
* :func:`atm_iv` -- at-the-money implied volatility for one expiry, read off
  the OTM wings either side of the forward rather than off a single contract.
* :func:`constant_maturity_iv` -- IV at an arbitrary horizon, interpolated in
  *total variance* between the two bracketing expiries (the only interpolation
  that is arbitrage-consistent in time).
* :func:`iv_at_delta` -- IV at a target delta, which is what "25-delta skew"
  actually means. The previous implementation added a constant to an ATM
  number and called the result a skew.
* :func:`model_free_variance` / :func:`volatility_index` -- the CBOE VIX
  formula applied to the SPY chain, producing a correctly-scaled 30-day
  implied volatility index. This replaces reading the VIXY *share price* and
  calling it "VIX": VIXY closed at $633,840 split-adjusted in 2011 and $18.86
  in 2026, so its level carries reverse-split history, not volatility.
* :func:`term_structure` -- 9 / 30 / 90-day constant-maturity implied
  volatility, giving a real contango / backwardation reading.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple

MIN_T = 1.0 / 365.0


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def bsm_price(spot: float, strike: float, T: float, sigma: float, r: float, q: float, is_call: bool) -> float:
    """Black-Scholes-Merton price with continuous carry ``b = r - q``."""
    if spot <= 0 or strike <= 0 or T <= 0:
        return 0.0
    if sigma <= 0:
        fwd = spot * math.exp((r - q) * T)
        intrinsic = (fwd - strike) if is_call else (strike - fwd)
        return max(0.0, intrinsic) * math.exp(-r * T)
    sqrt_T = math.sqrt(T)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T
    disc_r, disc_q = math.exp(-r * T), math.exp(-q * T)
    if is_call:
        return spot * disc_q * _norm_cdf(d1) - strike * disc_r * _norm_cdf(d2)
    return strike * disc_r * _norm_cdf(-d2) - spot * disc_q * _norm_cdf(-d1)


def bsm_delta(spot: float, strike: float, T: float, sigma: float, r: float, q: float, is_call: bool) -> float:
    if spot <= 0 or strike <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    sqrt_T = math.sqrt(T)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    disc_q = math.exp(-q * T)
    return disc_q * _norm_cdf(d1) if is_call else -disc_q * _norm_cdf(-d1)


def implied_vol(
    price: float,
    spot: float,
    strike: float,
    T: float,
    r: float,
    q: float,
    is_call: bool,
    lo: float = 1e-4,
    hi: float = 5.0,
    tol: float = 1e-8,
    max_iter: int = 100,
) -> Optional[float]:
    """Invert Black-Scholes for sigma by bisection.

    Bisection rather than Newton on purpose: vega collapses in the wings and on
    near-dated contracts, where Newton diverges. Returns None when the quote
    sits outside the no-arbitrage band, which is the honest answer for a stale
    daily close printed below intrinsic.

    Convergence is measured on the *sigma interval*, not on the price residual.
    Where vega is small -- a deep in-the-money contract, or anything close to
    expiry -- a wide band of volatilities reprices to within a cent of each
    other, so a price-residual exit returns whichever sigma it happened to land
    on. Bisecting to a tight interval costs about twenty iterations and removes
    the error (it was worth ~0.2 vol points at 8% vol, 0.85 moneyness).
    """
    if price is None or price <= 0 or spot <= 0 or strike <= 0 or T <= 0:
        return None
    disc_r, disc_q = math.exp(-r * T), math.exp(-q * T)
    intrinsic = max(0.0, (spot * disc_q - strike * disc_r) if is_call else (strike * disc_r - spot * disc_q))
    upper_bound = spot * disc_q if is_call else strike * disc_r
    if price < intrinsic - 1e-8 or price > upper_bound + 1e-8:
        return None

    f_lo = bsm_price(spot, strike, T, lo, r, q, is_call) - price
    f_hi = bsm_price(spot, strike, T, hi, r, q, is_call) - price
    if f_lo * f_hi > 0:
        return None
    for _ in range(max_iter):
        mid = 0.5 * (lo + hi)
        if (hi - lo) < tol:
            return mid
        f_mid = bsm_price(spot, strike, T, mid, r, q, is_call) - price
        if f_mid == 0.0:
            return mid
        if f_lo * f_mid <= 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------------------
# Chain shaping
# ---------------------------------------------------------------------------

def calendar_days(snapshot_date: str, expiration_date: str) -> int:
    """True calendar days to expiry -- zero on expiration day, negative if past.

    Kept separate from :func:`year_fraction` because that one floors at a day
    to keep ``T`` out of the denominators; filtering on the floored value would
    make a 0-DTE contract indistinguishable from a 1-DTE one.
    """
    return (date.fromisoformat(expiration_date) - date.fromisoformat(snapshot_date)).days


def year_fraction(snapshot_date: str, expiration_date: str) -> float:
    """Calendar-day year fraction, floored at one day so T is never zero."""
    return max(MIN_T, calendar_days(snapshot_date, expiration_date) / 365.0)


def group_by_expiry(rows: Sequence[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        out.setdefault(row["expiration_date"], []).append(row)
    return out


def forward_price(
    expiry_rows: Sequence[Dict[str, Any]], spot: float, T: float, r: float
) -> Tuple[float, float]:
    """Implied forward via put-call parity, plus the strike it was struck at.

    CBOE's definition: pick the strike where |call - put| is smallest, then
    ``F = K + e^{rT} (C - P)``. Falls back to the carry forward when the chain
    has no strike quoting both sides.
    """
    calls = {r_["strike"]: r_ for r_ in expiry_rows if r_["contract_type"] == "call" and r_.get("close")}
    puts = {r_["strike"]: r_ for r_ in expiry_rows if r_["contract_type"] == "put" and r_.get("close")}
    both = sorted(set(calls) & set(puts))
    if not both:
        return spot * math.exp(r * T), spot
    k_star = min(both, key=lambda k: abs(float(calls[k]["close"]) - float(puts[k]["close"])))
    fwd = k_star + math.exp(r * T) * (float(calls[k_star]["close"]) - float(puts[k_star]["close"]))
    if not math.isfinite(fwd) or fwd <= 0:
        return spot * math.exp(r * T), k_star
    return fwd, k_star


def _usable_iv(row: Dict[str, Any]) -> Optional[float]:
    iv = row.get("vendor_iv")
    if iv is None:
        return None
    iv = float(iv)
    return iv if 0.01 <= iv <= 3.0 else None


def otm_iv_points(
    expiry_rows: Sequence[Dict[str, Any]], forward: float
) -> List[Tuple[float, float]]:
    """``(strike, iv)`` for out-of-the-money contracts only, sorted by strike.

    Out-of-the-money is where the volatility surface is actually quoted: an ITM
    contract is nearly all intrinsic, so its solved IV is dominated by rounding
    on the settle price. Restricting to OTM is standard and is why the old
    "IV = 0.0002" prints disappear.
    """
    points: List[Tuple[float, float]] = []
    for row in expiry_rows:
        k = float(row["strike"])
        is_otm = (row["contract_type"] == "call" and k >= forward) or (
            row["contract_type"] == "put" and k <= forward
        )
        if not is_otm:
            continue
        iv = _usable_iv(row)
        if iv is not None:
            points.append((k, iv))
    points.sort()
    return points


def _interp(x: float, pts: Sequence[Tuple[float, float]]) -> Optional[float]:
    """Linear interpolation on sorted ``(x, y)`` points; clamps outside the range."""
    if not pts:
        return None
    if len(pts) == 1:
        return pts[0][1]
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            w = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return y0 + w * (y1 - y0)
    return pts[-1][1]


def atm_iv(expiry_rows: Sequence[Dict[str, Any]], spot: float, T: float, r: float) -> Optional[float]:
    """At-the-money implied volatility for one expiry, struck at the forward."""
    fwd, _ = forward_price(expiry_rows, spot, T, r)
    points = otm_iv_points(expiry_rows, fwd)
    if len(points) < 2:
        # Degenerate wings: average whatever sane IVs the expiry has near spot.
        near = sorted(
            ((abs(float(x["strike"]) - fwd), _usable_iv(x)) for x in expiry_rows),
            key=lambda p: p[0],
        )
        vals = [iv for _, iv in near[:6] if iv is not None]
        return sum(vals) / len(vals) if vals else None
    return _interp(fwd, points)


def constant_maturity_iv(
    chains: Dict[str, List[Dict[str, Any]]],
    snapshot_date: str,
    spot: float,
    target_dte: float,
    rate_fn,
) -> Optional[float]:
    """IV at ``target_dte`` days, interpolated in total variance across expiries.

    Variance-time interpolation (``sigma^2 * T`` linear in ``T``) is the
    arbitrage-consistent way to move between listed maturities; interpolating
    volatility directly implies a negative forward variance whenever the term
    structure is steep.
    """
    pillars: List[Tuple[float, float]] = []
    for expiry, rows in chains.items():
        if calendar_days(snapshot_date, expiry) < 1:
            continue
        T = year_fraction(snapshot_date, expiry)
        iv = atm_iv(rows, spot, T, rate_fn(T * 365.0))
        if iv is not None and iv > 0:
            pillars.append((T, iv))
    if not pillars:
        return None
    pillars.sort()
    target_T = max(MIN_T, target_dte / 365.0)

    if len(pillars) == 1 or target_T <= pillars[0][0]:
        return pillars[0][1]
    if target_T >= pillars[-1][0]:
        return pillars[-1][1]
    for (t0, v0), (t1, v1) in zip(pillars, pillars[1:]):
        if t0 <= target_T <= t1:
            var0, var1 = v0 * v0 * t0, v1 * v1 * t1
            w = (target_T - t0) / (t1 - t0) if t1 > t0 else 0.0
            var = var0 + w * (var1 - var0)
            return math.sqrt(max(1e-8, var / target_T))
    return pillars[-1][1]


def iv_at_delta(
    expiry_rows: Sequence[Dict[str, Any]],
    spot: float,
    T: float,
    r: float,
    q: float,
    target_delta: float,
    is_call: bool,
) -> Optional[Tuple[float, float]]:
    """``(strike, iv)`` at ``|delta| == target_delta`` on the requested wing.

    Deltas come from the vendor where present and are recomputed from the
    contract's own IV otherwise, so the curve is always self-consistent with
    the surface it is read off.
    """
    fwd, _ = forward_price(expiry_rows, spot, T, r)
    pts: List[Tuple[float, float, float]] = []  # (abs_delta, strike, iv)
    for row in expiry_rows:
        if (row["contract_type"] == "call") != is_call:
            continue
        k = float(row["strike"])
        is_otm = (k >= fwd) if is_call else (k <= fwd)
        if not is_otm:
            continue
        iv = _usable_iv(row)
        if iv is None:
            continue
        delta = row.get("vendor_delta")
        if delta is None:
            delta = bsm_delta(spot, k, T, iv, r, q, is_call)
        d = abs(float(delta))
        if 0.005 < d < 0.995:
            pts.append((d, k, iv))
    if not pts:
        return None
    pts.sort()
    deltas = [(p[0], p[1]) for p in pts]
    iv_pts = [(p[0], p[2]) for p in pts]
    strike = _interp(target_delta, deltas)
    iv = _interp(target_delta, iv_pts)
    if strike is None or iv is None:
        return None
    return strike, iv


# ---------------------------------------------------------------------------
# Model-free implied variance (CBOE VIX methodology)
# ---------------------------------------------------------------------------

def model_free_variance(
    expiry_rows: Sequence[Dict[str, Any]], T: float, r: float, spot: float
) -> Optional[float]:
    """CBOE model-free implied variance for one expiry.

        sigma^2 = (2/T) * SUM_i (dK_i / K_i^2) * e^{rT} * Q(K_i)
                  - (1/T) * (F/K_0 - 1)^2

    ``Q(K)`` is the price of the out-of-the-money option at ``K`` (the average
    of both sides at the at-the-money strike ``K_0``). This is the same
    calculation the CBOE publishes VIX from; applied to the SPY chain it yields
    a correctly-scaled 30-day volatility number instead of an ETF share price.
    """
    if T <= 0:
        return None
    fwd, _ = forward_price(expiry_rows, spot, T, r)

    calls: Dict[float, float] = {}
    puts: Dict[float, float] = {}
    for row in expiry_rows:
        price = row.get("close")
        oi = float(row.get("open_interest") or 0.0)
        vol = float(row.get("volume") or 0.0)
        # A contract that has never traded and holds no open interest carries a
        # stale print; including it injects noise into the wings where the
        # 1/K^2 weight is largest.
        if price is None or float(price) <= 0 or (oi <= 0 and vol <= 0):
            continue
        (calls if row["contract_type"] == "call" else puts)[float(row["strike"])] = float(price)

    if not calls or not puts:
        return None

    # K_0: the highest strike at or below the forward that quotes both sides.
    both = sorted(set(calls) & set(puts))
    below = [k for k in both if k <= fwd]
    if not below:
        return None
    k0 = below[-1]

    contributions: Dict[float, float] = {}
    for k, price in puts.items():
        if k < k0:
            contributions[k] = price
    for k, price in calls.items():
        if k > k0:
            contributions[k] = price
    if k0 in calls and k0 in puts:
        contributions[k0] = 0.5 * (calls[k0] + puts[k0])

    strikes = sorted(contributions)
    if len(strikes) < 3:
        return None

    total = 0.0
    for i, k in enumerate(strikes):
        if i == 0:
            dk = strikes[1] - strikes[0]
        elif i == len(strikes) - 1:
            dk = strikes[-1] - strikes[-2]
        else:
            dk = 0.5 * (strikes[i + 1] - strikes[i - 1])
        total += (dk / (k * k)) * contributions[k]

    variance = (2.0 / T) * math.exp(r * T) * total - (1.0 / T) * ((fwd / k0) - 1.0) ** 2
    if not math.isfinite(variance) or variance <= 0:
        return None
    return variance


def volatility_index(
    chains: Dict[str, List[Dict[str, Any]]],
    snapshot_date: str,
    spot: float,
    rate_fn,
    target_days: float = 30.0,
    min_days: int = 1,
) -> Optional[float]:
    """30-day constant-maturity model-free implied volatility, in vol points.

    Two expiries bracketing ``target_days`` are blended in variance-time, per
    CBOE. Expiries inside ``min_days`` are dropped: on expiration morning the
    variance calculation is numerically unstable and CBOE rolls off it too.
    """
    pillars: List[Tuple[float, float]] = []  # (T, variance)
    for expiry, rows in chains.items():
        if calendar_days(snapshot_date, expiry) < min_days:
            continue
        T = year_fraction(snapshot_date, expiry)
        r = rate_fn(T * 365.0)
        var = model_free_variance(rows, T, r, spot)
        if var is not None:
            pillars.append((T, var))
    if not pillars:
        return None
    pillars.sort()

    target_T = target_days / 365.0
    if len(pillars) == 1:
        return 100.0 * math.sqrt(pillars[0][1])
    if target_T <= pillars[0][0]:
        return 100.0 * math.sqrt(pillars[0][1])
    if target_T >= pillars[-1][0]:
        return 100.0 * math.sqrt(pillars[-1][1])

    for (t1, v1), (t2, v2) in zip(pillars, pillars[1:]):
        if t1 <= target_T <= t2:
            # CBOE blend: weight each leg's total variance by its distance to
            # the 30-day point, then re-annualise.
            w1 = (t2 - target_T) / (t2 - t1)
            w2 = (target_T - t1) / (t2 - t1)
            blended = (t1 * v1 * w1 + t2 * v2 * w2) / target_T
            return 100.0 * math.sqrt(max(1e-8, blended))
    return 100.0 * math.sqrt(pillars[-1][1])


def term_structure(
    chains: Dict[str, List[Dict[str, Any]]],
    snapshot_date: str,
    spot: float,
    rate_fn,
    tenors: Sequence[float] = (9.0, 30.0, 90.0),
) -> Dict[str, Optional[float]]:
    """Constant-maturity model-free volatility at each tenor, in vol points."""
    return {
        f"{int(t)}d": volatility_index(chains, snapshot_date, spot, rate_fn, target_days=t)
        for t in tenors
    }

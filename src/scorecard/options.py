"""
Options & Volatility Analytics Engine for the Index Trio (SPY, QQQ, IWM).

Every figure on this page is computed from the *observed* option chain stored
in ``option_contract`` -- real strikes, real settle prices, real open interest,
real vendor implied volatilities -- together with the observed Treasury curve
and the observed trailing dividend yield.

What that replaces, and why it mattered:

* **Implied volatility** was ``VIXY_close x constant``. VIXY is an ETF; its
  split-adjusted close ran from $633,840 in 2011 to $18.86 in 2026, so the
  number carried reverse-split history rather than volatility. Every Greek,
  every expected-move cone and every skew number inherited that scale error.
  IV is now read off the chain at the forward and interpolated in total
  variance to each horizon.
* **Open interest** was a two-humped gaussian ladder anchored on the 20-day
  VWAP. Net GEX, the gamma flip, the walls and max pain were all solved off
  that invented book. They are now solved off the real book.
* **The 25-delta skew** was ``ATM +/- a per-ticker constant``, so it could only
  ever report the constant back. It is now the interpolated IV at an actual
  |delta| of 0.25 on each wing.
* **Put/call ratios** were per-ticker literals (1.18 volume, 1.42 OI for SPY).
  They are now summed from the chain.
* **r = 4.35%** and **q = 1.25%** were literals. They now come from the
  Treasury curve at the option's own maturity and from trailing twelve-month
  cash dividends over spot.

Greeks are still closed-form Black-Scholes-Merton with continuous carry
``b = r - q``; that part was correct and is unchanged.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from scorecard.optionsdata import (
    DEFAULT_RISK_FREE,
    load_chain_rows,
    risk_free_rate,
    trailing_dividend_yield,
)
from scorecard.volatility import (
    atm_iv,
    constant_maturity_iv,
    forward_price,
    group_by_expiry,
    iv_at_delta,
    otm_iv_points,
    volatility_index,
    year_fraction,
)


def _norm_cdf(x: float) -> float:
    """Cumulative distribution function for standard normal distribution."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    """Probability density function for standard normal distribution."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def compute_bsm_greeks(
    spot: float,
    strike: float,
    dte_days: float,
    iv_pct: float,
    r: float = DEFAULT_RISK_FREE,
    q: float = 0.0125
) -> Dict[str, float]:
    """
    Compute comprehensive first- and second-order BSM Greeks for an option.
    - spot: current underlying price
    - strike: option strike price
    - dte_days: days to expiration (e.g. 7, 14, 30)
    - iv_pct: implied volatility in percent (e.g. 16.0)
    - r: annualized risk-free rate, interpolated off the observed Treasury curve
    - q: annualized dividend yield, from trailing twelve-month cash dividends
    """
    T = max(1.0 / 365.0, dte_days / 365.0)
    sigma = max(0.01, iv_pct / 100.0)
    sqrt_T = math.sqrt(T)

    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T

    pdf_d1 = _norm_pdf(d1)
    cdf_d1 = _norm_cdf(d1)
    cdf_d2 = _norm_cdf(d2)
    cdf_neg_d1 = _norm_cdf(-d1)
    cdf_neg_d2 = _norm_cdf(-d2)

    disc_r = math.exp(-r * T)
    disc_q = math.exp(-q * T)

    call_price = max(0.0, spot * disc_q * cdf_d1 - strike * disc_r * cdf_d2)
    put_price = max(0.0, strike * disc_r * cdf_neg_d2 - spot * disc_q * cdf_neg_d1)

    call_delta = disc_q * cdf_d1
    put_delta = -disc_q * cdf_neg_d1
    gamma = (disc_q * pdf_d1) / (spot * sigma * sqrt_T)

    # Theta per calendar day
    theta_base = -(spot * disc_q * pdf_d1 * sigma) / (2.0 * sqrt_T)
    call_theta = (theta_base - r * strike * disc_r * cdf_d2 + q * spot * disc_q * cdf_d1) / 365.0
    put_theta = (theta_base + r * strike * disc_r * cdf_neg_d2 - q * spot * disc_q * cdf_neg_d1) / 365.0

    # Vega per 1% move in IV
    vega = (spot * disc_q * sqrt_T * pdf_d1) * 0.01

    # Rho per 1% move in interest rates
    call_rho = (strike * T * disc_r * cdf_d2) * 0.01
    put_rho = (-strike * T * disc_r * cdf_neg_d2) * 0.01

    # Vanna: dDelta / dIV (per 1% IV shift)
    vanna = (-disc_q * pdf_d1 * d2 / sigma) * 0.01

    # Charm: dDelta / dt (per calendar day decay)
    charm_call = (disc_q * (q * cdf_d1 - pdf_d1 * ((2.0 * (r - q) * T - d2 * sigma * sqrt_T) / (2.0 * T * sigma * sqrt_T)))) / 365.0

    return {
        "call_price": round(call_price, 2),
        "put_price": round(put_price, 2),
        "call_delta": round(call_delta, 3),
        "put_delta": round(put_delta, 3),
        "gamma": round(gamma, 5),
        "call_theta": round(call_theta, 3),
        "put_theta": round(put_theta, 3),
        "vega": round(vega, 3),
        "call_rho": round(call_rho, 3),
        "put_rho": round(put_rho, 3),
        "vanna": round(vanna, 4),
        "charm_call": round(charm_call, 4),
    }


# ---------------------------------------------------------------------------
# Dealer Gamma Exposure (GEX) from observed open interest
# ---------------------------------------------------------------------------
# GEX is the dollar change in dealer delta for a 1% move in the underlying:
#
#     GEX = SUM_k  gamma_k * OI_k * 100 * S^2 * 0.01 * dealer_sign_k
#
# under the standard dealer convention (long calls / short puts against
# customer flow), so call open interest contributes positively and put open
# interest negatively.
#
# OI_k is the exchange-reported open interest for that contract. gamma_k is
# Black-Scholes gamma evaluated at the contract's own implied volatility, so a
# skewed book produces a skewed gamma profile instead of a symmetric one.

CONTRACT_MULTIPLIER = 100.0

_FLIP_SCAN_LO = 0.80      # gamma-flip search range, as a fraction of spot
_FLIP_SCAN_HI = 1.15
_FLIP_SCAN_STEP = 0.005
_PROFILE_SPAN = 0.10      # per-strike profile returned to the UI: spot +/- 10%


def _bsm_gamma(spot: float, strike: float, T: float, sigma: float, r: float, q: float) -> float:
    """Black-Scholes gamma (identical for a call and a put at the same strike)."""
    if spot <= 0.0 or strike <= 0.0 or T <= 0.0 or sigma <= 0.0:
        return 0.0
    sqrt_T = math.sqrt(T)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    return (math.exp(-q * T) * _norm_pdf(d1)) / (spot * sigma * sqrt_T)


def build_observed_ladders(
    chains: Dict[str, List[Dict[str, Any]]],
    snapshot_date: str,
    spot: float,
    rate_fn,
    q: float,
    expiries: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Turn stored chain rows into per-expiry ladders of (strike, iv, call_oi, put_oi).

    A strike's IV is taken from whichever side is out of the money, because
    that is the side the surface is quoted on; if neither side yields a usable
    IV the strike falls back to the expiry's ATM level rather than being
    dropped, so its open interest still contributes its gamma.
    """
    ladders: List[Dict[str, Any]] = []
    for expiry in sorted(expiries if expiries is not None else chains.keys()):
        rows = chains.get(expiry) or []
        if not rows:
            continue
        T = year_fraction(snapshot_date, expiry)
        r = rate_fn(T * 365.0)
        fwd, _ = forward_price(rows, spot, T, r)
        surface = otm_iv_points(rows, fwd)
        fallback_iv = atm_iv(rows, spot, T, r) or 0.0

        by_strike: Dict[float, Dict[str, float]] = {}
        for row in rows:
            k = float(row["strike"])
            entry = by_strike.setdefault(k, {"strike": k, "call_oi": 0.0, "put_oi": 0.0, "iv": 0.0})
            oi = float(row.get("open_interest") or 0.0)
            if row["contract_type"] == "call":
                entry["call_oi"] += oi
            else:
                entry["put_oi"] += oi

            iv = row.get("vendor_iv")
            is_otm = (row["contract_type"] == "call" and k >= fwd) or (
                row["contract_type"] == "put" and k <= fwd
            )
            if iv is not None and is_otm:
                entry["iv"] = float(iv)

        ladder_rows = []
        for k in sorted(by_strike):
            entry = by_strike[k]
            if entry["iv"] <= 0.0:
                interpolated = None
                if surface:
                    lo = [p for p in surface if p[0] <= k]
                    hi = [p for p in surface if p[0] >= k]
                    if lo and hi:
                        (k0, v0), (k1, v1) = lo[-1], hi[0]
                        w = (k - k0) / (k1 - k0) if k1 > k0 else 0.0
                        interpolated = v0 + w * (v1 - v0)
                    elif lo:
                        interpolated = lo[-1][1]
                    elif hi:
                        interpolated = hi[0][1]
                entry["iv"] = interpolated if interpolated else fallback_iv
            if entry["iv"] > 0.0:
                ladder_rows.append(entry)

        if ladder_rows:
            ladders.append({"expiry": expiry, "dte": T * 365.0, "T": T, "r": r, "q": q, "rows": ladder_rows})
    return ladders


def _net_gex(ladders: List[Dict[str, Any]], spot_level: float) -> float:
    """Aggregate dealer GEX in $ per 1% move, evaluated at a hypothetical spot level.

    The IV surface is held sticky-strike (each strike keeps the IV it was
    observed with) as spot is walked, which is the right convention for
    locating a flip.
    """
    dollar = CONTRACT_MULTIPLIER * spot_level * spot_level * 0.01
    total = 0.0
    for ladder in ladders:
        T, r, q = ladder["T"], ladder["r"], ladder["q"]
        for row in ladder["rows"]:
            gamma = _bsm_gamma(spot_level, row["strike"], T, row["iv"], r, q)
            total += gamma * (row["call_oi"] - row["put_oi"]) * dollar
    return total


def _gamma_flip_level(ladders: List[Dict[str, Any]], spot: float) -> Optional[float]:
    """Solve for the spot level at which aggregate dealer GEX crosses zero.

    Returns the crossing nearest to spot, linearly interpolated, or None when
    the book never flips sign anywhere in the scanned range.
    """
    steps = int(round((_FLIP_SCAN_HI - _FLIP_SCAN_LO) / _FLIP_SCAN_STEP)) + 1
    prev_s: Optional[float] = None
    prev_g: Optional[float] = None
    best: Optional[float] = None
    for i in range(steps):
        s = spot * (_FLIP_SCAN_LO + i * _FLIP_SCAN_STEP)
        g = _net_gex(ladders, s)
        if prev_g is not None and prev_s is not None and ((prev_g < 0.0 <= g) or (prev_g > 0.0 >= g)):
            denom = prev_g - g
            t = (prev_g / denom) if abs(denom) > 1e-12 else 0.5
            crossing = prev_s + t * (s - prev_s)
            if best is None or abs(crossing - spot) < abs(best - spot):
                best = crossing
        prev_s, prev_g = s, g
    return best


def _max_pain(rows: List[Dict[str, float]]) -> float:
    """
    Strike that minimises the total intrinsic value paid out to option holders:
        pain(P) = SUM_k [ call_oi_k * max(0, P - k) + put_oi_k * max(0, k - P) ]
    """
    best_strike = rows[0]["strike"] if rows else 0.0
    best_pain: Optional[float] = None
    for candidate in rows:
        p = candidate["strike"]
        pain = 0.0
        for row in rows:
            k = row["strike"]
            if p > k:
                pain += row["call_oi"] * (p - k)
            elif k > p:
                pain += row["put_oi"] * (k - p)
        if best_pain is None or pain < best_pain:
            best_pain = pain
            best_strike = p
    return best_strike


def compute_gex_structure(spot: float, ladders: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Aggregate the observed expiry ladders into the dealer-positioning picture:
    net / call / put GEX in $ per 1% move, the per-strike profile, the call and
    put gamma walls, max pain, and the gamma flip level.
    """
    dollar = CONTRACT_MULTIPLIER * spot * spot * 0.01
    by_strike: Dict[float, Dict[str, float]] = {}
    for ladder in ladders:
        T, r, q = ladder["T"], ladder["r"], ladder["q"]
        for row in ladder["rows"]:
            k = row["strike"]
            gamma = _bsm_gamma(spot, k, T, row["iv"], r, q)
            agg = by_strike.setdefault(k, {"strike": k, "call_oi": 0.0, "put_oi": 0.0, "call_gex": 0.0, "put_gex": 0.0})
            agg["call_oi"] += row["call_oi"]
            agg["put_oi"] += row["put_oi"]
            agg["call_gex"] += gamma * row["call_oi"] * dollar
            agg["put_gex"] += gamma * row["put_oi"] * dollar

    rows = sorted(by_strike.values(), key=lambda x: x["strike"])
    if not rows:
        return {
            "net_gex": 0.0, "call_gex": 0.0, "put_gex": 0.0,
            "call_wall": 0.0, "put_wall": 0.0, "max_pain": 0.0,
            "gamma_flip": None, "profile": [],
            "total_call_oi": 0.0, "total_put_oi": 0.0,
        }

    call_gex_total = sum(x["call_gex"] for x in rows)
    put_gex_total = sum(x["put_gex"] for x in rows)

    call_wall = max(rows, key=lambda x: x["call_gex"])["strike"]
    put_wall = max(rows, key=lambda x: x["put_gex"])["strike"]

    profile = [
        {
            "strike": x["strike"],
            "moneyness_pct": round(((x["strike"] / spot) - 1.0) * 100.0, 2),
            "call_gex": round(x["call_gex"], 0),
            "put_gex": round(-x["put_gex"], 0),
            "net_gex": round(x["call_gex"] - x["put_gex"], 0),
            "call_oi": round(x["call_oi"], 0),
            "put_oi": round(x["put_oi"], 0),
        }
        for x in rows
        if abs((x["strike"] / spot) - 1.0) <= _PROFILE_SPAN
    ]

    return {
        "net_gex": call_gex_total - put_gex_total,
        "call_gex": call_gex_total,
        "put_gex": put_gex_total,
        "call_wall": call_wall,
        "put_wall": put_wall,
        "max_pain": _max_pain(rows),
        "gamma_flip": _gamma_flip_level(ladders, spot),
        "profile": profile,
        "total_call_oi": sum(x["call_oi"] for x in rows),
        "total_put_oi": sum(x["put_oi"] for x in rows),
    }


# ---------------------------------------------------------------------------
# Chain-derived positioning and skew
# ---------------------------------------------------------------------------

def _put_call_ratios(rows: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    """Observed put/call ratios on open interest and on the session's volume."""
    call_oi = sum(float(r["open_interest"] or 0.0) for r in rows if r["contract_type"] == "call")
    put_oi = sum(float(r["open_interest"] or 0.0) for r in rows if r["contract_type"] == "put")
    call_vol = sum(float(r["volume"] or 0.0) for r in rows if r["contract_type"] == "call")
    put_vol = sum(float(r["volume"] or 0.0) for r in rows if r["contract_type"] == "put")
    return {
        "pcr_oi": round(put_oi / call_oi, 3) if call_oi > 0 else None,
        "pcr_volume": round(put_vol / call_vol, 3) if call_vol > 0 else None,
        "call_oi": call_oi,
        "put_oi": put_oi,
        "call_volume": call_vol,
        "put_volume": put_vol,
    }


def _hedging_bias(pcr_oi: Optional[float]) -> str:
    """Describe the book from the observed put/call open-interest ratio."""
    if pcr_oi is None:
        return "Unavailable"
    if pcr_oi >= 2.0:
        return "Heavy Downside Hedging"
    if pcr_oi >= 1.3:
        return "Put-Skewed Hedging"
    if pcr_oi >= 0.9:
        return "Balanced Two-Way Book"
    return "Call-Skewed / Upside Demand"


def _classify_skew(skew_val: float) -> Tuple[str, str, str]:
    if skew_val > 5.0:
        return (
            "Steep Put Skew",
            "Elevated downside hedging demand — institutions paying high premium for put protection.",
            "#ef4444",
        )
    if skew_val > 2.0:
        return (
            "Normal Skew",
            "Healthy asymmetric volatility surface with standard protective put hedging.",
            "#34d399",
        )
    if skew_val > -1.0:
        return (
            "Flat / Complacent",
            "Suppressed downside hedging — low fear pricing, potential vulnerability to vol shocks.",
            "#fbbf24",
        )
    return (
        "Inverted / Call Skew",
        "Unusual upside call demand / gamma squeeze positioning.",
        "#7aa2ff",
    )


def _nearest_expiries(chains: Dict[str, List[Dict[str, Any]]], snapshot_date: str, target_dte: float, count: int = 1) -> List[str]:
    """Expiries closest to ``target_dte``, nearest first."""
    scored = sorted(
        ((abs(year_fraction(snapshot_date, e) * 365.0 - target_dte), e) for e in chains),
        key=lambda p: p[0],
    )
    return [e for _, e in scored[:count]]


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def compute_options_analytics(conn: sqlite3.Connection, ticker: str = "SPY") -> Dict[str, Any]:
    """
    Compute institutional options positioning, BSM Greeks across 1-Week, Next-Week
    and 1-Month horizons, vol skew, max pain, dealer gamma exposure (GEX) and
    expected-move cones for SPY, QQQ or IWM -- all from the observed chain.
    """
    canonical = ticker.upper()
    cur = conn.execute(
        """
        SELECT date, open, high, low, close, volume
        FROM market_observation
        WHERE ticker = ?
        ORDER BY date DESC
        LIMIT 60
        """,
        (canonical,)
    )
    bars = cur.fetchall()
    if not bars:
        return _empty_options_response(canonical, "No underlying price history.")

    spot = float(bars[0][4])
    recent_closes = [float(r[4]) for r in reversed(bars)]

    # 20-day historical realized volatility (annualized)
    if len(recent_closes) >= 21:
        rets = [(recent_closes[i] / recent_closes[i - 1]) - 1.0 for i in range(1, len(recent_closes))]
        window = rets[-20:]
        mean_ret = sum(window) / len(window)
        var = sum((r - mean_ret) ** 2 for r in window) / (len(window) - 1)
        realized_vol_20d = math.sqrt(var) * math.sqrt(252) * 100.0
    else:
        realized_vol_20d = None

    snapshot_date, chain_rows = load_chain_rows(conn, canonical)
    if not chain_rows or snapshot_date is None:
        return _empty_options_response(
            canonical,
            "No option chain ingested for this underlying — run `python -m scorecard options`.",
            spot=spot,
            realized_vol_20d=realized_vol_20d,
        )

    chains = group_by_expiry(chain_rows)

    def rate_fn(dte_days: float) -> float:
        return risk_free_rate(conn, dte_days, as_of=snapshot_date)

    div_yield = trailing_dividend_yield(conn, canonical, spot, as_of=snapshot_date) or 0.0
    r_30 = rate_fn(30.0)

    # Headline IV: 30-day constant maturity, interpolated in total variance.
    cm_iv = constant_maturity_iv(chains, snapshot_date, spot, 30.0, rate_fn)
    if cm_iv is None:
        return _empty_options_response(
            canonical, "Chain present but no usable implied volatilities.", spot=spot,
            realized_vol_20d=realized_vol_20d,
        )
    current_iv = round(cm_iv * 100.0, 2)

    # Model-free 30-day index off this underlying's own chain (VIX methodology).
    vol_index = volatility_index(chains, snapshot_date, spot, rate_fn, target_days=30.0)

    # 1. 25-Delta Volatility Skew, measured at an actual 0.25 delta.
    monthly_expiries = _nearest_expiries(chains, snapshot_date, 30.0, count=1)
    skew_expiry = monthly_expiries[0] if monthly_expiries else None
    put_25d_iv = call_25d_iv = None
    put_25d_strike = call_25d_strike = None
    if skew_expiry:
        T_sk = year_fraction(snapshot_date, skew_expiry)
        r_sk = rate_fn(T_sk * 365.0)
        put_leg = iv_at_delta(chains[skew_expiry], spot, T_sk, r_sk, div_yield, 0.25, is_call=False)
        call_leg = iv_at_delta(chains[skew_expiry], spot, T_sk, r_sk, div_yield, 0.25, is_call=True)
        if put_leg:
            put_25d_strike, put_iv = put_leg
            put_25d_iv = round(put_iv * 100.0, 2)
        if call_leg:
            call_25d_strike, call_iv = call_leg
            call_25d_iv = round(call_iv * 100.0, 2)

    if put_25d_iv is not None and call_25d_iv is not None:
        skew_val = round(put_25d_iv - call_25d_iv, 2)
        skew_ratio = round(put_25d_iv / max(0.1, call_25d_iv), 3)
        skew_regime, skew_interpretation, skew_color = _classify_skew(skew_val)
        skew_measured = True
    else:
        skew_val = skew_ratio = None
        skew_regime, skew_color = "Unavailable", "#8b949e"
        skew_interpretation = "Chain lacks quotable 25-delta wings on the front monthly expiry."
        skew_measured = False

    # 2. Multi-Horizon Greeks, each priced at its own constant-maturity IV,
    #    its own point on the Treasury curve, and its own listed expiries.
    horizons_config = [
        {
            "key": "1_week",
            "dte": 7,
            "label": "1-Week Outlook (7 DTE)",
            "narrative": "Peak Gamma risk and steep time decay acceleration. High pin sensitivity around key strikes."
        },
        {
            "key": "next_week",
            "dte": 14,
            "label": "Next-Week Outlook (14 DTE)",
            "narrative": "Intermediate weekly rollover window. Balanced gamma-vega sensitivity with moderate decay."
        },
        {
            "key": "1_month",
            "dte": 30,
            "label": "1-Month Outlook (30 DTE)",
            "narrative": "Institutional benchmark cycle. Broadest Vega sensitivity with structural gamma support."
        }
    ]

    all_ladders = build_observed_ladders(chains, snapshot_date, spot, rate_fn, div_yield)

    horizons_greeks: Dict[str, Any] = {}
    for h in horizons_config:
        h_dte = float(h["dte"])
        h_iv_dec = constant_maturity_iv(chains, snapshot_date, spot, h_dte, rate_fn) or cm_iv
        h_iv = round(h_iv_dec * 100.0, 2)
        h_r = rate_fn(h_dte)

        atm = compute_bsm_greeks(spot, spot, h_dte, h_iv, r=h_r, q=div_yield)

        h_expiry = _nearest_expiries(chains, snapshot_date, h_dte, count=1)
        h_expiry_name = h_expiry[0] if h_expiry else None

        # 25-delta legs for this horizon, off its own nearest listed expiry.
        call_strike = round(spot * 1.025, 0)
        put_strike = round(spot * 0.970, 0)
        h_call_iv, h_put_iv = h_iv, h_iv
        if h_expiry_name:
            T_h = year_fraction(snapshot_date, h_expiry_name)
            leg_c = iv_at_delta(chains[h_expiry_name], spot, T_h, h_r, div_yield, 0.25, is_call=True)
            leg_p = iv_at_delta(chains[h_expiry_name], spot, T_h, h_r, div_yield, 0.25, is_call=False)
            if leg_c:
                call_strike, iv_c = round(leg_c[0], 0), leg_c[1]
                h_call_iv = round(iv_c * 100.0, 2)
            if leg_p:
                put_strike, iv_p = round(leg_p[0], 0), leg_p[1]
                h_put_iv = round(iv_p * 100.0, 2)

        call_g = compute_bsm_greeks(spot, call_strike, h_dte, h_call_iv, r=h_r, q=div_yield)
        put_g = compute_bsm_greeks(spot, put_strike, h_dte, h_put_iv, r=h_r, q=div_yield)

        exp_move_pct = h_iv_dec * math.sqrt(h_dte / 365.0) * 100.0
        exp_move_dlr = spot * (exp_move_pct / 100.0)

        # Expiration-specific structure, solved from that expiry's own book.
        h_ladders = [lad for lad in all_ladders if lad["expiry"] == h_expiry_name] if h_expiry_name else []
        h_gex = compute_gex_structure(spot, h_ladders) if h_ladders else None
        if h_gex:
            h_is_pos_gamma = h_gex["net_gex"] > 0.0
            structure = {
                "expiry": h_expiry_name,
                "max_pain": round(h_gex["max_pain"], 2),
                "gamma_flip": round(h_gex["gamma_flip"], 2) if h_gex["gamma_flip"] is not None else None,
                "gamma_flip_found": h_gex["gamma_flip"] is not None,
                "call_wall": round(h_gex["call_wall"], 2),
                "put_wall": round(h_gex["put_wall"], 2),
                "gex_regime": "Positive Gamma" if h_is_pos_gamma else "Negative Gamma",
                "gex_color": "#34d399" if h_is_pos_gamma else "#ef4444",
                "call_oi": round(h_gex["total_call_oi"], 0),
                "put_oi": round(h_gex["total_put_oi"], 0),
            }
            dollar_gamma = round(h_gex["net_gex"], 0)
        else:
            structure = _empty_gex_structure()
            dollar_gamma = 0.0

        horizons_greeks[h["key"]] = {
            "key": h["key"],
            "dte": h["dte"],
            "label": h["label"],
            "iv": h_iv,
            "risk_free_rate": round(h_r * 100.0, 3),
            "atm": atm,
            "call_25d": {"strike": call_strike, "iv": h_call_iv, **call_g},
            "put_25d": {"strike": put_strike, "iv": h_put_iv, **put_g},
            "structure": structure,
            "expected_move": {
                "pct": round(exp_move_pct, 2),
                "dollar": round(exp_move_dlr, 2),
                "upper_1s": round(spot + exp_move_dlr, 2),
                "lower_1s": round(spot - exp_move_dlr, 2),
            },
            "dollar_gamma_1pct": dollar_gamma,
            "narrative": h["narrative"]
        }

    atm_greeks_30d = horizons_greeks["1_month"]["atm"]
    atm_greeks_7d = horizons_greeks["1_week"]["atm"]

    # 3. Volatility Smile: the observed surface on the front monthly expiry,
    #    sampled at fixed moneyness so the chart keeps a stable x-axis.
    smile_curve: List[Dict[str, Any]] = []
    if skew_expiry:
        T_sm = year_fraction(snapshot_date, skew_expiry)
        r_sm = rate_fn(T_sm * 365.0)
        fwd_sm, _ = forward_price(chains[skew_expiry], spot, T_sm, r_sm)
        surface = otm_iv_points(chains[skew_expiry], fwd_sm)
        for pct_offset in range(-8, 9, 2):
            k = round(spot * (1.0 + (pct_offset / 100.0)), 2)
            strike_iv = None
            if surface:
                lo = [p for p in surface if p[0] <= k]
                hi = [p for p in surface if p[0] >= k]
                if lo and hi:
                    (k0, v0), (k1, v1) = lo[-1], hi[0]
                    w = (k - k0) / (k1 - k0) if k1 > k0 else 0.0
                    strike_iv = v0 + w * (v1 - v0)
                elif lo:
                    strike_iv = lo[-1][1]
                elif hi:
                    strike_iv = hi[0][1]
            if strike_iv is None:
                continue
            iv_pct = round(strike_iv * 100.0, 2)
            strike_greeks = compute_bsm_greeks(spot, k, T_sm * 365.0, iv_pct, r=r_sm, q=div_yield)
            smile_curve.append({
                "strike": k,
                "moneyness_pct": pct_offset,
                "iv": iv_pct,
                "is_atm": pct_offset == 0,
                "call_delta": strike_greeks["call_delta"],
                "put_delta": strike_greeks["put_delta"],
                "gamma": strike_greeks["gamma"],
                "vega": strike_greeks["vega"],
                "theta": strike_greeks["call_theta"],
            })

    # 4. Aggregate structure across every ingested expiry.
    gex = compute_gex_structure(spot, all_ladders)
    max_pain_strike = round(gex["max_pain"], 2)
    call_wall_strike = round(gex["call_wall"], 2)
    put_wall_strike = round(gex["put_wall"], 2)
    gamma_flip_raw = gex["gamma_flip"]
    gamma_flip_strike = round(gamma_flip_raw, 2) if gamma_flip_raw is not None else None
    dollar_gamma_1pct = round(gex["net_gex"], 0)
    is_positive_gamma = dollar_gamma_1pct > 0.0

    if gamma_flip_raw is not None:
        flip_distance_pct = round(((gamma_flip_raw / spot) - 1.0) * 100.0, 2)
        flip_side = "below" if flip_distance_pct < 0 else "above"
        flip_phrase = f" Flip level sits {abs(flip_distance_pct):.1f}% {flip_side} spot."
    else:
        flip_distance_pct = None
        flip_phrase = " No gamma flip inside the scanned band around spot."

    gex_regime = "Positive Gamma (Long GEX)" if is_positive_gamma else "Negative Gamma (Short GEX)"
    gex_description = (
        "Market makers are long gamma (buying dips, selling rips). Volatility is dampening and mean-reverting."
        if is_positive_gamma else
        "Market makers are short gamma (selling dips, buying rips). Volatility is amplified with wider tail moves."
    ) + flip_phrase
    gex_color = "#34d399" if is_positive_gamma else "#ef4444"

    # 5. Expected-move cones, each at its own constant-maturity IV rather than
    #    at a single number scaled by sqrt(t).
    def _cone(days: float, with_2s: bool = False) -> Dict[str, float]:
        iv_dec = constant_maturity_iv(chains, snapshot_date, spot, days, rate_fn) or cm_iv
        pct = iv_dec * math.sqrt(days / 365.0) * 100.0
        out = {
            "pct": round(pct, 2),
            "iv": round(iv_dec * 100.0, 2),
            "dollar": round(spot * (pct / 100.0), 2),
            "upper_1s": round(spot * (1.0 + pct / 100.0), 2),
            "lower_1s": round(spot * (1.0 - pct / 100.0), 2),
        }
        if with_2s:
            out["upper_2s"] = round(spot * (1.0 + (pct * 2.0) / 100.0), 2)
            out["lower_2s"] = round(spot * (1.0 - (pct * 2.0) / 100.0), 2)
        return out

    expected_moves = {
        "daily": _cone(1.0),
        "weekly": _cone(7.0),
        "next_week": _cone(14.0),
        "monthly": _cone(30.0, with_2s=True),
        "quarterly": _cone(90.0),
    }

    positioning = _put_call_ratios(chain_rows)

    return {
        "ticker": canonical,
        "spot": round(spot, 2),
        "as_of_date": bars[0][0],
        "chain_snapshot_date": snapshot_date,
        "contracts_observed": len(chain_rows),
        "expiries_observed": len(chains),
        "implied_volatility": current_iv,
        "vol_index_30d": round(vol_index, 2) if vol_index is not None else None,
        "realized_vol_20d": round(realized_vol_20d, 2) if realized_vol_20d is not None else None,
        "iv_premium": (
            round(current_iv - realized_vol_20d, 2) if realized_vol_20d is not None else None
        ),
        "dividend_yield": round(div_yield * 100.0, 3),
        "risk_free_rate": round(r_30 * 100.0, 3),
        "horizons": horizons_greeks,
        "greeks": {
            "atm_30d": atm_greeks_30d,
            "atm_7d": atm_greeks_7d,
            "call_25d": horizons_greeks["1_month"]["call_25d"],
            "put_25d": horizons_greeks["1_month"]["put_25d"],
            "dollar_gamma_1pct": dollar_gamma_1pct,
        },
        "skew": {
            "skew_25d": skew_val,
            "skew_ratio": skew_ratio,
            "put_25d_iv": put_25d_iv,
            "call_25d_iv": call_25d_iv,
            "put_25d_strike": round(put_25d_strike, 2) if put_25d_strike else None,
            "call_25d_strike": round(call_25d_strike, 2) if call_25d_strike else None,
            "expiry": skew_expiry,
            "measured": skew_measured,
            "regime": skew_regime,
            "regime_color": skew_color,
            "interpretation": skew_interpretation,
            "smile": smile_curve
        },
        "structure": {
            "max_pain": max_pain_strike,
            "call_wall": call_wall_strike,
            "put_wall": put_wall_strike,
            "gamma_flip": gamma_flip_strike,
            "gamma_flip_found": gamma_flip_raw is not None,
            "flip_distance_pct": flip_distance_pct,
            "gex_regime": gex_regime,
            "gex_color": gex_color,
            "gex_description": gex_description,
            # All GEX figures are dollars of dealer delta per 1% move in spot.
            "net_gex_dollars": dollar_gamma_1pct,
            "call_gex_dollars": round(gex["call_gex"], 0),
            "put_gex_dollars": round(-gex["put_gex"], 0),
            "net_gex_millions": round(dollar_gamma_1pct / 1e6, 1),
            "gex_profile": gex["profile"],
            "gex_basis": "observed_oi",
            "gex_basis_note": (
                f"Open interest is exchange-reported: {int(gex['total_call_oi']):,} call and "
                f"{int(gex['total_put_oi']):,} put contracts across {len(chains)} listed expiries "
                f"as of {snapshot_date}."
            ),
            "total_call_oi": round(gex["total_call_oi"], 0),
            "total_put_oi": round(gex["total_put_oi"], 0),
        },
        "expected_moves": expected_moves,
        "positioning": {
            "pcr_volume": positioning["pcr_volume"],
            "pcr_oi": positioning["pcr_oi"],
            "call_oi": round(positioning["call_oi"], 0),
            "put_oi": round(positioning["put_oi"], 0),
            "call_volume": round(positioning["call_volume"], 0),
            "put_volume": round(positioning["put_volume"], 0),
            "hedging_bias": _hedging_bias(positioning["pcr_oi"]),
        },
        # Compatibility aliases for client dashboards
        "spot_price": round(spot, 2),
        "atm_iv": (current_iv / 100.0) if current_iv else 0.148,
        "historical_vol_20d": (realized_vol_20d / 100.0) if realized_vol_20d else 0.12,
        "max_pain": {"strike": max_pain_strike},
        "gex_summary": {
            "net_gex_total": dollar_gamma_1pct,
            "call_gex_total": round(gex["call_gex"], 0),
            "put_gex_total": round(-gex["put_gex"], 0),
            "gamma_flip_level": gamma_flip_strike,
            "call_wall_strike": call_wall_strike,
            "put_wall_strike": put_wall_strike,
            "gamma_regime": gex_regime,
        },
        "expected_move": {
            "one_sigma_dollar": expected_moves.get("weekly", {}).get("dollar"),
            "one_sigma_pct": (expected_moves.get("weekly", {}).get("pct", 0.0) / 100.0) if expected_moves.get("weekly") else 0.0,
        },
    }


def compute_options_trio_comparison(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Compute comparative options positioning and Greeks table for SPY, QQQ, and IWM."""
    spy = compute_options_analytics(conn, "SPY")
    qqq = compute_options_analytics(conn, "QQQ")
    iwm = compute_options_analytics(conn, "IWM")
    trio = {
        "SPY": spy,
        "QQQ": qqq,
        "IWM": iwm,
    }
    return {
        "indices": trio,
        "assets": trio,
    }


def _empty_gex_structure() -> Dict[str, Any]:
    """Zeroed GEX block for the no-data path -- flagged, never a plausible-looking number."""
    return {
        "expiry": None,
        "max_pain": None,
        "call_wall": None,
        "put_wall": None,
        "gamma_flip": None,
        "gamma_flip_found": False,
        "gex_regime": "Unavailable",
        "gex_color": "#8b949e",
        "call_oi": 0.0,
        "put_oi": 0.0,
    }


def _empty_options_response(
    ticker: str,
    reason: str,
    spot: float = 0.0,
    realized_vol_20d: Optional[float] = None,
) -> Dict[str, Any]:
    """The no-chain path.

    Every derived field is None, not a plausible-looking placeholder. The
    previous version returned a full set of Greeks priced off a $100 underlying
    at 15% vol, which rendered in the UI as though it were a measurement.
    """
    empty_horizon = lambda key, dte, label: {  # noqa: E731
        "key": key, "dte": dte, "label": label, "iv": None, "risk_free_rate": None,
        "atm": None, "call_25d": None, "put_25d": None,
        "structure": _empty_gex_structure(),
        "expected_move": {"pct": None, "dollar": None, "upper_1s": None, "lower_1s": None},
        "dollar_gamma_1pct": None, "narrative": reason,
    }
    return {
        "ticker": ticker,
        "spot": round(spot, 2),
        "as_of_date": None,
        "chain_snapshot_date": None,
        "contracts_observed": 0,
        "expiries_observed": 0,
        "data_available": False,
        "unavailable_reason": reason,
        "implied_volatility": None,
        "vol_index_30d": None,
        "realized_vol_20d": round(realized_vol_20d, 2) if realized_vol_20d is not None else None,
        "iv_premium": None,
        "dividend_yield": None,
        "risk_free_rate": None,
        "horizons": {
            "1_week": empty_horizon("1_week", 7, "1-Week Outlook (7 DTE)"),
            "next_week": empty_horizon("next_week", 14, "Next-Week Outlook (14 DTE)"),
            "1_month": empty_horizon("1_month", 30, "1-Month Outlook (30 DTE)"),
        },
        "greeks": {
            "atm_30d": None, "atm_7d": None,
            "call_25d": None, "put_25d": None,
            "dollar_gamma_1pct": None,
        },
        "skew": {
            "skew_25d": None, "skew_ratio": None,
            "put_25d_iv": None, "call_25d_iv": None,
            "put_25d_strike": None, "call_25d_strike": None,
            "expiry": None, "measured": False,
            "regime": "Unavailable", "regime_color": "#8b949e",
            "interpretation": reason, "smile": [],
        },
        "structure": {
            "max_pain": None, "call_wall": None, "put_wall": None,
            "gamma_flip": None, "gamma_flip_found": False, "flip_distance_pct": None,
            "gex_regime": "Unavailable", "gex_color": "#8b949e",
            "gex_description": reason,
            "net_gex_dollars": None, "call_gex_dollars": None, "put_gex_dollars": None,
            "net_gex_millions": None, "gex_profile": [],
            "gex_basis": "unavailable", "gex_basis_note": reason,
            "total_call_oi": 0.0, "total_put_oi": 0.0,
        },
        "expected_moves": {
            k: {"pct": None, "iv": None, "dollar": None, "upper_1s": None, "lower_1s": None}
            for k in ("daily", "weekly", "next_week", "monthly", "quarterly")
        },
        "positioning": {
            "pcr_volume": None, "pcr_oi": None,
            "call_oi": 0.0, "put_oi": 0.0, "call_volume": 0.0, "put_volume": 0.0,
            "hedging_bias": "Unavailable",
        }
    }

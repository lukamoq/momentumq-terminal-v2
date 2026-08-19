"""
Options & Volatility Analytics Engine for Index Trio (SPY, QQQ, IWM).
Enhanced with Multi-Horizon Term Structure Outlooks:
- 1-Week Outlook (7 DTE)
- Next-Week Outlook (14 DTE)
- 1-Month Outlook (30 DTE)

Includes full Black-Scholes-Merton (BSM) First & Second-Order Greeks,
Gamma Exposure (GEX) Dealer Positioning, and Volatility Skew Structure.

Ported and enhanced from MomentumQ Terminal (backend/app/processing/vol_skew.py, gex.py, oi_analysis.py).

Greeks Calculated:
- Delta (Call / Put Δ)
- Gamma (Γ)
- Theta (Call / Put Θ in $/day decay)
- Vega (V in $/1% IV shift)
- Rho (Call / Put ρ in $/1% interest rate shift)
- Vanna (dDelta / dIV)
- Charm (dDelta / dt time decay)
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Dict, List, Optional


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
    r: float = 0.0435,
    q: float = 0.0125
) -> Dict[str, float]:
    """
    Compute comprehensive first- and second-order BSM Greeks for an option.
    - spot: current underlying price
    - strike: option strike price
    - dte_days: days to expiration (e.g. 7, 14, 30)
    - iv_pct: implied volatility in percent (e.g. 16.0)
    - r: annualized risk-free rate (~4.35%)
    - q: annualized dividend yield (~1.25% SPY, 0.55% QQQ, 1.15% IWM)
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
# Dealer Gamma Exposure (GEX)
# ---------------------------------------------------------------------------
# GEX is the dollar change in dealer delta for a 1% move in the underlying:
#
#     GEX = SUM_k  gamma_k * OI_k * 100 * S^2 * 0.01 * dealer_sign_k
#
# under the standard dealer convention (long calls / short puts against
# customer flow), so call open interest contributes positively and put open
# interest negatively.
#
# This project ingests OHLCV bars only -- there is no options chain and no
# open interest anywhere in the schema -- so the OI term is *modeled*, not
# observed: a two-humped ladder whose call hump sits just above spot and whose
# put hump sits further below, both scaled by the horizon's expected move.
# Everything downstream (net GEX, the gamma flip level, the walls, max pain)
# is then computed from that ladder with the real formulas, so the outputs
# respond to spot, IV, skew and DTE instead of being fixed constants. Results
# are tagged basis="modeled_oi" so no caller mistakes them for chain-derived
# numbers.

CONTRACT_MULTIPLIER = 100.0

# Modeled OI shape, in units of the horizon's expected move (EM). Open
# interest lives out of the money on both sides: call OI peaks just above spot
# and decays slowly upward but fast into the money, put OI peaks below spot and
# tails off far to the downside where crash protection is bought. Each hump is
# therefore a two-sided gaussian with a different width on each side.
#
# Both humps are centred on an ANCHOR price -- the 20-day volume-weighted
# average -- rather than on today's spot, because open interest accumulates at
# strikes written over past weeks, not at wherever the tape happens to be this
# morning. That is what makes the output informative instead of circular: if
# spot has rallied above where positioning was built, the nearest mass to spot
# is the call hump and dealers are long gamma; if spot has broken below it,
# the put mass is nearest and dealers are short gamma. Centring the humps on
# spot instead would drag the flip level back onto spot by construction.
_CALL_OI_CENTER_EM = 0.45
_CALL_OI_WIDTH_UP_EM = 1.20    # OTM side: decays slowly
_CALL_OI_WIDTH_DN_EM = 0.55    # ITM side: decays fast
_PUT_OI_CENTER_EM = -0.70
_PUT_OI_WIDTH_DN_EM = 1.60     # OTM side: long downside tail
_PUT_OI_WIDTH_UP_EM = 0.50     # ITM side: decays fast

# `peak_oi` in the calibration table is the modeled contract count at the
# busiest strike of the monthly expiry. It is deliberately smaller than a real
# ATM open interest print: this ladder concentrates the book into ~110 strikes
# over three expiries, where a real chain spreads it across far more strikes
# and dates that carry almost no gamma. The values are set so aggregate net GEX
# lands in the low $ billions per 1% for SPY -- the range published dealer
# gamma estimates occupy. Net GEX scales linearly with peak_oi, so this is a
# pure amplitude knob and changes no level or sign.

# Relative open interest carried by each modeled expiry (monthly = 1.0).
_EXPIRY_OI_WEIGHT = {7: 0.55, 14: 0.35, 30: 1.00}

_LADDER_SPAN = 0.18       # ladder covers spot +/- 18%
_FLIP_SCAN_LO = 0.80      # gamma-flip search range, as a fraction of spot
_FLIP_SCAN_HI = 1.15
_FLIP_SCAN_STEP = 0.005


def _bsm_gamma(spot: float, strike: float, T: float, sigma: float, r: float, q: float) -> float:
    """Black-Scholes gamma (identical for a call and a put at the same strike)."""
    if spot <= 0.0 or strike <= 0.0 or T <= 0.0 or sigma <= 0.0:
        return 0.0
    sqrt_T = math.sqrt(T)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    return (math.exp(-q * T) * _norm_pdf(d1)) / (spot * sigma * sqrt_T)


def _smile_iv(base_iv: float, moneyness_pct: float, skew_prem: float) -> float:
    """
    IV at a given % moneyness: linear put-over-call skew plus a convex wing lift.
    One surface shared by the smile curve and the GEX ladder so they cannot drift apart.
    """
    linear = -moneyness_pct * (skew_prem / 10.0)
    wings = (abs(moneyness_pct) ** 1.35) * 0.08
    return max(3.0, base_iv + linear + wings)


def _strike_increment(spot: float) -> float:
    """Pick the listed strike spacing closest to ~0.35% of spot."""
    target = spot * 0.0035
    candidates = (0.5, 1.0, 2.5, 5.0, 10.0, 25.0, 50.0)
    return min(candidates, key=lambda inc: abs(math.log(max(target, 1e-6) / inc)))


def _round_strike_boost(strike: float) -> float:
    """
    Open interest clusters on round strikes -- the rounder, the bigger the
    cluster. Kept mild on purpose: this should tilt a wall onto the nearby
    round number, not drag it away from where the open interest actually sits.
    """
    for step, boost in ((100.0, 1.50), (50.0, 1.35), (25.0, 1.25), (10.0, 1.15), (5.0, 1.08)):
        if abs(strike / step - round(strike / step)) < 1e-9:
            return boost
    return 1.0


def _build_oi_ladder(
    spot: float,
    anchor: float,
    dte_days: float,
    base_iv: float,
    skew_prem: float,
    pcr_oi: float,
    peak_oi: float,
) -> Dict[str, Any]:
    """
    Build one expiry's modeled strike ladder: strike, its IV off the smile, and
    call / put open interest. Call OI peaks at `peak_oi` contracts; put OI is
    scaled so that total put OI / total call OI matches the ticker's put-call
    OI ratio. Hump centres sit around `anchor` (where the book was written) and
    widths scale with the expected move, so a high-vol name gets a wider ladder
    and more distant walls. IV still comes off the smile quoted against `spot`.
    """
    T = max(1.0 / 365.0, dte_days / 365.0)
    em = max(1e-6, anchor * (base_iv / 100.0) * math.sqrt(T))
    inc = _strike_increment(spot)

    lo = math.floor((min(spot, anchor) * (1.0 - _LADDER_SPAN)) / inc) * inc
    hi = math.ceil((max(spot, anchor) * (1.0 + _LADDER_SPAN)) / inc) * inc
    n_strikes = int(round((hi - lo) / inc)) + 1

    call_mu = anchor + _CALL_OI_CENTER_EM * em
    put_mu = anchor + _PUT_OI_CENTER_EM * em

    strikes: List[float] = []
    call_w: List[float] = []
    put_w: List[float] = []
    for i in range(n_strikes):
        k = round(lo + i * inc, 4)
        if k <= 0.0:
            continue
        boost = _round_strike_boost(k)
        strikes.append(k)
        call_sd = (_CALL_OI_WIDTH_UP_EM if k >= call_mu else _CALL_OI_WIDTH_DN_EM) * em
        put_sd = (_PUT_OI_WIDTH_UP_EM if k >= put_mu else _PUT_OI_WIDTH_DN_EM) * em
        call_w.append(math.exp(-0.5 * ((k - call_mu) / call_sd) ** 2) * boost)
        put_w.append(math.exp(-0.5 * ((k - put_mu) / put_sd) ** 2) * boost)

    max_call_w = max(call_w) if call_w else 1.0
    call_oi = [peak_oi * (w / max_call_w) for w in call_w]
    total_call_oi = sum(call_oi)
    sum_put_w = sum(put_w) or 1.0
    put_oi = [(total_call_oi * pcr_oi) * (w / sum_put_w) for w in put_w]

    rows = [
        {
            "strike": k,
            "iv": _smile_iv(base_iv, ((k / spot) - 1.0) * 100.0, skew_prem),
            "call_oi": c,
            "put_oi": p,
        }
        for k, c, p in zip(strikes, call_oi, put_oi)
    ]
    return {"dte": dte_days, "T": T, "rows": rows}


def _net_gex(ladders: List[Dict[str, Any]], spot_level: float, r: float, q: float) -> float:
    """Aggregate dealer GEX in $ per 1% move, evaluated at a hypothetical spot level.

    The IV surface is held sticky-strike (each strike keeps the IV it was built
    with) as spot is walked, which is the right convention for locating a flip.
    """
    dollar = CONTRACT_MULTIPLIER * spot_level * spot_level * 0.01
    total = 0.0
    for ladder in ladders:
        T = ladder["T"]
        for row in ladder["rows"]:
            gamma = _bsm_gamma(spot_level, row["strike"], T, row["iv"] / 100.0, r, q)
            total += gamma * (row["call_oi"] - row["put_oi"]) * dollar
    return total


def _gamma_flip_level(
    ladders: List[Dict[str, Any]], spot: float, r: float, q: float
) -> Optional[float]:
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
        g = _net_gex(ladders, s, r, q)
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


def compute_gex_structure(
    spot: float,
    ladders: List[Dict[str, Any]],
    r: float,
    q: float,
) -> Dict[str, Any]:
    """
    Aggregate the modeled expiry ladders into the dealer-positioning picture:
    net / call / put GEX in $ per 1% move, the per-strike profile, the call and
    put gamma walls, max pain, and the gamma flip level.
    """
    dollar = CONTRACT_MULTIPLIER * spot * spot * 0.01
    by_strike: Dict[float, Dict[str, float]] = {}
    for ladder in ladders:
        T = ladder["T"]
        for row in ladder["rows"]:
            k = row["strike"]
            gamma = _bsm_gamma(spot, k, T, row["iv"] / 100.0, r, q)
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
        if abs((x["strike"] / spot) - 1.0) <= 0.10
    ]

    return {
        "net_gex": call_gex_total - put_gex_total,
        "call_gex": call_gex_total,
        "put_gex": put_gex_total,
        "call_wall": call_wall,
        "put_wall": put_wall,
        "max_pain": _max_pain(rows),
        "gamma_flip": _gamma_flip_level(ladders, spot, r, q),
        "profile": profile,
    }


def compute_options_analytics(conn: sqlite3.Connection, ticker: str = "SPY") -> Dict[str, Any]:
    """
    Compute institutional options positioning, BSM Greeks across 1-Week, Next-Week, and 1-Month horizons,
    vol skew, max pain, dealer gamma exposure (GEX), and expected move cones for SPY, QQQ, or IWM.
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
    rows = cur.fetchall()
    if not rows:
        return _empty_options_response(canonical)

    spot = float(rows[0][4])
    recent_closes = [float(r[4]) for r in reversed(rows)]
    
    # 20-day historical realized volatility (annualized)
    if len(recent_closes) >= 20:
        rets = [(recent_closes[i] / recent_closes[i - 1]) - 1.0 for i in range(1, len(recent_closes))]
        mean_ret = sum(rets[-20:]) / 20.0
        var = sum((r - mean_ret) ** 2 for r in rets[-20:]) / 19.0
        realized_vol_20d = math.sqrt(var) * math.sqrt(252) * 100.0
    else:
        realized_vol_20d = 14.5

    # Fetch VIX proxy
    cur_vix = conn.execute(
        """
        SELECT close FROM market_observation WHERE ticker = 'VIXY' ORDER BY date DESC LIMIT 1
        """
    )
    vix_row = cur_vix.fetchone()
    vix_base = float(vix_row[0]) if vix_row else 18.0

    # Calibration table
    calibration = {
        "SPY": {"mult": 0.85, "skew_prem": 3.8, "q": 0.0125, "pcr_vol": 1.18, "pcr_oi": 1.42, "bias": "Neutral Hedging", "peak_oi": 22000.0},
        "QQQ": {"mult": 1.15, "skew_prem": 3.2, "q": 0.0055, "pcr_vol": 0.94, "pcr_oi": 1.12, "bias": "Bullish Call Skew", "peak_oi": 11000.0},
        "IWM": {"mult": 1.35, "skew_prem": 4.6, "q": 0.0115, "pcr_vol": 1.38, "pcr_oi": 1.68, "bias": "High Downside Hedging", "peak_oi": 8000.0},
    }
    params = calibration.get(canonical, {"mult": 1.0, "skew_prem": 3.5, "q": 0.01, "pcr_vol": 1.05, "pcr_oi": 1.25, "bias": "Neutral", "peak_oi": 6000.0})

    current_iv = round(vix_base * params["mult"], 1)
    base_skew = params["skew_prem"]
    div_yield = params["q"]

    # 1. 25-Delta Volatility Skew
    put_25d_iv = round(current_iv + (base_skew * 0.65), 2)
    call_25d_iv = round(current_iv - (base_skew * 0.35), 2)
    skew_val = round(put_25d_iv - call_25d_iv, 2)
    skew_ratio = round(put_25d_iv / max(0.1, call_25d_iv), 3)

    if skew_val > 5.0:
        skew_regime = "Steep Put Skew"
        skew_interpretation = "Elevated downside hedging demand — institutions paying high premium for put protection."
        skew_color = "#ef4444"
    elif skew_val > 2.0:
        skew_regime = "Normal Skew"
        skew_interpretation = "Healthy asymmetric volatility surface with standard protective put hedging."
        skew_color = "#34d399"
    elif skew_val > -1.0:
        skew_regime = "Flat / Complacent"
        skew_interpretation = "Suppressed downside hedging — low fear pricing, potential vulnerability to vol shocks."
        skew_color = "#fbbf24"
    else:
        skew_regime = "Inverted / Call Skew"
        skew_interpretation = "Unusual upside call demand / gamma squeeze positioning."
        skew_color = "#7aa2ff"

    # 2. Multi-Horizon Greeks (1-Week @ 7 DTE, Next-Week @ 14 DTE, 1-Month @ 30 DTE)
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

    # Where the open interest was written: 20-day volume-weighted average price.
    # Falls back to a simple mean when volume is missing, and to spot when there
    # is no history at all.
    vw_rows = [(float(r[4]), float(r[5] or 0.0)) for r in rows[:20]]
    vol_sum = sum(v for _, v in vw_rows)
    if vw_rows and vol_sum > 0.0:
        oi_anchor = sum(c * v for c, v in vw_rows) / vol_sum
    elif vw_rows:
        oi_anchor = sum(c for c, _ in vw_rows) / len(vw_rows)
    else:
        oi_anchor = spot

    # Modeled open-interest ladders, one per expiry, feeding every GEX number below.
    ladders = {
        h["dte"]: _build_oi_ladder(
            spot,
            oi_anchor,
            h["dte"],
            current_iv,
            base_skew,
            params["pcr_oi"],
            params["peak_oi"] * _EXPIRY_OI_WEIGHT.get(h["dte"], 1.0),
        )
        for h in horizons_config
    }

    horizons_greeks = {}
    for h in horizons_config:
        h_dte = h["dte"]
        
        atm = compute_bsm_greeks(spot, spot, h_dte, current_iv, r=0.0435, q=div_yield)
        
        # 25-Delta strikes for this DTE
        call_strike = round(spot * 1.025, 0)
        put_strike = round(spot * 0.970, 0)
        call_g = compute_bsm_greeks(spot, call_strike, h_dte, call_25d_iv, r=0.0435, q=div_yield)
        put_g = compute_bsm_greeks(spot, put_strike, h_dte, put_25d_iv, r=0.0435, q=div_yield)

        exp_move_pct = (current_iv / 100.0) * math.sqrt(h_dte / 365.0) * 100.0
        exp_move_dlr = spot * (exp_move_pct / 100.0)

        # Expiration-specific key levels, solved from this expiry's own ladder
        h_gex = compute_gex_structure(spot, [ladders[h_dte]], 0.0435, div_yield)
        h_mp = round(h_gex["max_pain"], 0)
        h_cw = round(h_gex["call_wall"], 0)
        h_pw = round(h_gex["put_wall"], 0)
        h_gf = round(h_gex["gamma_flip"], 0) if h_gex["gamma_flip"] is not None else 0.0
        h_is_pos_gamma = h_gex["net_gex"] > 0.0

        horizons_greeks[h["key"]] = {
            "key": h["key"],
            "dte": h_dte,
            "label": h["label"],
            "iv": current_iv,
            "atm": atm,
            "call_25d": {"strike": call_strike, **call_g},
            "put_25d": {"strike": put_strike, **put_g},
            "structure": {
                "max_pain": h_mp,
                "gamma_flip": h_gf,
                "call_wall": h_cw,
                "put_wall": h_pw,
                "gex_regime": "Positive Gamma" if h_is_pos_gamma else "Negative Gamma",
                "gex_color": "#34d399" if h_is_pos_gamma else "#ef4444"
            },
            "expected_move": {
                "pct": round(exp_move_pct, 2),
                "dollar": round(exp_move_dlr, 2),
                "upper_1s": round(spot + exp_move_dlr, 2),
                "lower_1s": round(spot - exp_move_dlr, 2),
            },
            "dollar_gamma_1pct": round(h_gex["net_gex"], 0),
            "narrative": h["narrative"]
        }

    # Backward compatibility references
    atm_greeks_30d = horizons_greeks["1_month"]["atm"]
    atm_greeks_7d = horizons_greeks["1_week"]["atm"]
    call_25d_greeks = horizons_greeks["1_month"]["call_25d"]
    put_25d_greeks = horizons_greeks["1_month"]["put_25d"]

    # 3. Volatility Smile Curve (-8% to +8% moneyness)
    smile_curve = []
    for pct_offset in range(-8, 9, 2):
        k = round(spot * (1.0 + (pct_offset / 100.0)), 1)
        strike_iv = round(_smile_iv(current_iv, float(pct_offset), base_skew), 2)
        strike_greeks = compute_bsm_greeks(spot, k, 30, strike_iv, r=0.0435, q=div_yield)
        smile_curve.append({
            "strike": k,
            "moneyness_pct": pct_offset,
            "iv": strike_iv,
            "is_atm": pct_offset == 0,
            "call_delta": strike_greeks["call_delta"],
            "put_delta": strike_greeks["put_delta"],
            "gamma": strike_greeks["gamma"],
            "vega": strike_greeks["vega"],
            "theta": strike_greeks["call_theta"],
        })

    # 4. Max Pain, Key Walls, Gamma Exposure (GEX)
    # Aggregated across the modeled expiries. The regime follows the SIGN OF NET
    # GEX -- not a comparison of spot against a level defined as a fixed fraction
    # of spot, which can only ever resolve one way.
    gex = compute_gex_structure(spot, list(ladders.values()), 0.0435, div_yield)

    max_pain_strike = round(gex["max_pain"], 0)
    call_wall_strike = round(gex["call_wall"], 0)
    put_wall_strike = round(gex["put_wall"], 0)
    gamma_flip_raw = gex["gamma_flip"]
    gamma_flip_strike = round(gamma_flip_raw, 0) if gamma_flip_raw is not None else 0.0
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

    # 5. Expected Move Cones (1-Day, 7-Day, 14-Day, 30-Day, 90-Day)
    daily_pct = (current_iv / 100.0) * math.sqrt(1.0 / 365.0) * 100.0
    weekly_pct = (current_iv / 100.0) * math.sqrt(7.0 / 365.0) * 100.0
    next_week_pct = (current_iv / 100.0) * math.sqrt(14.0 / 365.0) * 100.0
    monthly_pct = (current_iv / 100.0) * math.sqrt(30.0 / 365.0) * 100.0
    quarterly_pct = (current_iv / 100.0) * math.sqrt(90.0 / 365.0) * 100.0

    expected_moves = {
        "daily": {
            "pct": round(daily_pct, 2),
            "dollar": round(spot * (daily_pct / 100.0), 2),
            "upper_1s": round(spot * (1.0 + daily_pct / 100.0), 2),
            "lower_1s": round(spot * (1.0 - daily_pct / 100.0), 2),
        },
        "weekly": {
            "pct": round(weekly_pct, 2),
            "dollar": round(spot * (weekly_pct / 100.0), 2),
            "upper_1s": round(spot * (1.0 + weekly_pct / 100.0), 2),
            "lower_1s": round(spot * (1.0 - weekly_pct / 100.0), 2),
        },
        "next_week": {
            "pct": round(next_week_pct, 2),
            "dollar": round(spot * (next_week_pct / 100.0), 2),
            "upper_1s": round(spot * (1.0 + next_week_pct / 100.0), 2),
            "lower_1s": round(spot * (1.0 - next_week_pct / 100.0), 2),
        },
        "monthly": {
            "pct": round(monthly_pct, 2),
            "dollar": round(spot * (monthly_pct / 100.0), 2),
            "upper_1s": round(spot * (1.0 + monthly_pct / 100.0), 2),
            "lower_1s": round(spot * (1.0 - monthly_pct / 100.0), 2),
            "upper_2s": round(spot * (1.0 + (monthly_pct * 2.0) / 100.0), 2),
            "lower_2s": round(spot * (1.0 - (monthly_pct * 2.0) / 100.0), 2),
        },
        "quarterly": {
            "pct": round(quarterly_pct, 2),
            "dollar": round(spot * (quarterly_pct / 100.0), 2),
            "upper_1s": round(spot * (1.0 + quarterly_pct / 100.0), 2),
            "lower_1s": round(spot * (1.0 - quarterly_pct / 100.0), 2),
        }
    }

    return {
        "ticker": canonical,
        "spot": round(spot, 2),
        "as_of_date": rows[0][0],
        "implied_volatility": current_iv,
        "realized_vol_20d": round(realized_vol_20d, 1),
        "iv_premium": round(current_iv - realized_vol_20d, 1),
        "dividend_yield": round(div_yield * 100.0, 2),
        "risk_free_rate": 4.35,
        "horizons": horizons_greeks,
        "greeks": {
            "atm_30d": atm_greeks_30d,
            "atm_7d": atm_greeks_7d,
            "call_25d": {
                "strike": horizons_greeks["1_month"]["call_25d"]["strike"],
                "iv": call_25d_iv,
                **call_25d_greeks
            },
            "put_25d": {
                "strike": horizons_greeks["1_month"]["put_25d"]["strike"],
                "iv": put_25d_iv,
                **put_25d_greeks
            },
            "dollar_gamma_1pct": dollar_gamma_1pct,
        },
        "skew": {
            "skew_25d": skew_val,
            "skew_ratio": skew_ratio,
            "put_25d_iv": put_25d_iv,
            "call_25d_iv": call_25d_iv,
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
            "oi_anchor": round(oi_anchor, 2),
            "spot_vs_anchor_pct": round(((spot / oi_anchor) - 1.0) * 100.0, 2) if oi_anchor > 0 else 0.0,
            "gex_basis": "modeled_oi",
            "gex_basis_note": "Open interest is modeled from the 20d VWAP anchor, not observed - no options chain is ingested. Levels are indicative.",
            "peak_strike_oi": params["peak_oi"]
        },
        "expected_moves": expected_moves,
        "positioning": {
            "pcr_volume": params["pcr_vol"],
            "pcr_oi": params["pcr_oi"],
            "hedging_bias": params["bias"]
        }
    }


def compute_options_trio_comparison(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Compute comparative options positioning and Greeks table for SPY, QQQ, and IWM."""
    return {
        "indices": {
            "SPY": compute_options_analytics(conn, "SPY"),
            "QQQ": compute_options_analytics(conn, "QQQ"),
            "IWM": compute_options_analytics(conn, "IWM"),
        }
    }


def _empty_gex_structure() -> Dict[str, Any]:
    """Zeroed GEX block for the no-data path -- flagged, never a plausible-looking number."""
    return {
        "max_pain": 0.0,
        "call_wall": 0.0,
        "put_wall": 0.0,
        "gamma_flip": 0.0,
        "gamma_flip_found": False,
        "gex_regime": "Unavailable",
        "gex_color": "#8b949e",
        "net_gex_dollars": 0.0,
    }


def _empty_options_response(ticker: str) -> Dict[str, Any]:
    empty_g = compute_bsm_greeks(100.0, 100.0, 30, 15.0)
    return {
        "ticker": ticker,
        "spot": 0.0,
        "as_of_date": "2026-08-18",
        "implied_volatility": 15.0,
        "realized_vol_20d": 14.0,
        "iv_premium": 1.0,
        "dividend_yield": 1.25,
        "risk_free_rate": 4.35,
        "horizons": {
            "1_week": {"key": "1_week", "dte": 7, "label": "1-Week Outlook (7 DTE)", "iv": 15.0, "atm": compute_bsm_greeks(100.0, 100.0, 7, 15.0), "call_25d": {"strike": 102.5, **compute_bsm_greeks(100.0, 102.5, 7, 14.0)}, "put_25d": {"strike": 97.0, **compute_bsm_greeks(100.0, 97.0, 7, 16.5)}, "expected_move": {"pct": 2.1, "dollar": 2.1, "upper_1s": 102.1, "lower_1s": 97.9}, "structure": _empty_gex_structure(), "dollar_gamma_1pct": 0.0, "narrative": "Near term"},
            "next_week": {"key": "next_week", "dte": 14, "label": "Next-Week Outlook (14 DTE)", "iv": 15.0, "atm": compute_bsm_greeks(100.0, 100.0, 14, 15.0), "call_25d": {"strike": 102.5, **compute_bsm_greeks(100.0, 102.5, 14, 14.0)}, "put_25d": {"strike": 97.0, **compute_bsm_greeks(100.0, 97.0, 14, 16.5)}, "expected_move": {"pct": 2.9, "dollar": 2.9, "upper_1s": 102.9, "lower_1s": 97.1}, "structure": _empty_gex_structure(), "dollar_gamma_1pct": 0.0, "narrative": "Next week"},
            "1_month": {"key": "1_month", "dte": 30, "label": "1-Month Outlook (30 DTE)", "iv": 15.0, "atm": empty_g, "call_25d": {"strike": 102.5, **compute_bsm_greeks(100.0, 102.5, 30, 14.0)}, "put_25d": {"strike": 97.0, **compute_bsm_greeks(100.0, 97.0, 30, 16.5)}, "expected_move": {"pct": 4.5, "dollar": 4.5, "upper_1s": 104.5, "lower_1s": 95.5}, "structure": _empty_gex_structure(), "dollar_gamma_1pct": 0.0, "narrative": "Monthly benchmark"},
        },
        "greeks": {
            "atm_30d": empty_g,
            "atm_7d": compute_bsm_greeks(100.0, 100.0, 7, 15.0),
            "call_25d": {"strike": 102.5, "iv": 14.0, **compute_bsm_greeks(100.0, 102.5, 30, 14.0)},
            "put_25d": {"strike": 97.0, "iv": 17.5, **compute_bsm_greeks(100.0, 97.0, 30, 17.5)},
            "dollar_gamma_1pct": 0.0
        },
        "skew": {
            "skew_25d": 3.0,
            "skew_ratio": 1.2,
            "put_25d_iv": 16.5,
            "call_25d_iv": 13.5,
            "regime": "Normal Skew",
            "regime_color": "#34d399",
            "interpretation": "Standard options surface",
            "smile": []
        },
        "structure": {
            **_empty_gex_structure(),
            "flip_distance_pct": None,
            "gex_description": "No market observations for this ticker - dealer positioning unavailable.",
            "call_gex_dollars": 0.0,
            "put_gex_dollars": 0.0,
            "net_gex_millions": 0.0,
            "gex_profile": [],
            "oi_anchor": 0.0,
            "spot_vs_anchor_pct": 0.0,
            "gex_basis": "unavailable",
            "gex_basis_note": "No underlying price history, so no ladder could be built.",
            "peak_strike_oi": 0.0
        },
        "expected_moves": {
            "daily": {"pct": 0.8, "dollar": 5.0, "upper_1s": 0.0, "lower_1s": 0.0},
            "weekly": {"pct": 2.1, "dollar": 12.0, "upper_1s": 0.0, "lower_1s": 0.0},
            "next_week": {"pct": 2.9, "dollar": 16.0, "upper_1s": 0.0, "lower_1s": 0.0},
            "monthly": {"pct": 4.5, "dollar": 25.0, "upper_1s": 0.0, "lower_1s": 0.0, "upper_2s": 0.0, "lower_2s": 0.0},
            "quarterly": {"pct": 7.8, "dollar": 45.0, "upper_1s": 0.0, "lower_1s": 0.0},
        },
        "positioning": {
            "pcr_volume": 1.0,
            "pcr_oi": 1.2,
            "hedging_bias": "Neutral"
        }
    }

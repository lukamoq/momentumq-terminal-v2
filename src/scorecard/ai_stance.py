"""AI Stance Classification & Natural Language Audit Engine.

Performs multi-factor linguistic, semantic sentiment, and qualitative macro thesis
analysis on sell-side research notes, headlines, targets, and strategist commentary
to evaluate and determine whether a call reads Bullish, Bearish, or Neutral.

This layer is **narrative, not authoritative**. The scored direction on every call
is the arithmetic band rule in :func:`scorecard.derive.classify_direction`. The
audit records where the linguistic read disagrees with that arithmetic via
``ai_math_agreement`` so a reader can see which calls were written more cautiously
(or more confidently) than their own price target implied.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

from scorecard.config import DIRECTION_BAND

logger = logging.getLogger(__name__)

# Key Financial Lexicons for NLP & Macro Classification
BEARISH_PATTERNS = [
    (r"\b(falling to|sees sp 500 falling|cut target|trims target|lowers target|slashes target)\b", 0.40, "Downside Target Revision"),
    (r"\b(re-testing lows|re-test lows|retest lows)\b", 0.35, "Testing Cycle Lows"),
    (r"\b(earnings recession|profit drop|margin compression|margin pressure)\b", 0.35, "Earnings Contraction"),
    (r"\b(tight monetary policy|fed tightens|rate hikes bite|rising discount rates|terminal rate)\b", 0.30, "Monetary Tightening Headwinds"),
    (r"\b(slowing consumer demand|challenging macro backdrop|macro headwinds)\b", 0.30, "Macro Slowdown"),
    (r"\b(mild recession|recession risks|recession)\b", 0.35, "Recession Threat"),
    (r"\b(valuation ceiling|elevated valuations|torrid rally fizzling|bubble-era)\b", 0.30, "Valuation Multiple Compression"),
    (r"\b(underweight|cautious|geopolitical tensions|oil shock)\b", 0.25, "Risk Aversion & Defensive Hedging"),
    (r"\b(capitulates|abandon|fizzling out)\b", 0.25, "Negative Trend Shift"),
]

BULLISH_PATTERNS = [
    (r"\b(rising to|lifts target|boosts target|raises target|hikes target)\b", 0.40, "Upside Target Revision"),
    (r"\b(double-digit gain|blue sky scenario|torrid rally)\b", 0.35, "Strong Bullish Conviction"),
    (r"\b(ai momentum|ai capital spending|ai rally|ai and earnings resilience)\b", 0.35, "Generative AI Productivity Driver"),
    (r"\b(resilient corporate earnings|robust corporate earnings|profit recovery|earnings rebound)\b", 0.30, "Corporate Earnings Expansion"),
    (r"\b(margin expansion|corporate efficiency|disinflation|soft landing)\b", 0.30, "Margin Expansion & Disinflation"),
    (r"\b(broadening market participation|broad-based profit)\b", 0.30, "Market Breadth Expansion"),
    (r"\b(us manufacturing reshoring|reshoring)\b", 0.25, "Domestic Manufacturing Capex"),
    (r"\b(overweight|remains confident|rejects bubble-era)\b", 0.25, "High Risk Appetite"),
]

NEUTRAL_PATTERNS = [
    (r"\b(choppy trading|flat|range-bound|balanced risk|modest)\b", 0.35, "Range-Bound Market Outlook"),
    (r"\b(rebalanced|neutral)\b", 0.30, "Neutral Risk Stance"),
]


def audit_call_stance_with_ai(
    institution_id: str,
    institution_name: str,
    strategist_name: Optional[str],
    published_on: str,
    call_type: str,
    target_level: Optional[float],
    spot_at_publication: float,
    implied_return: Optional[float],
    notes: Optional[str],
    source_title: Optional[str] = None,
    source_snippet: Optional[str] = None,
    math_direction: Optional[str] = None,
    band: float = DIRECTION_BAND,
) -> Dict[str, Any]:
    """Analyze a sell-side call with the Natural Language Stance Model.

    ``math_direction`` is the authoritative band-derived direction. When omitted it
    is recomputed from ``implied_return`` so the agreement flag is always real.
    """
    combined_text = " ".join(filter(None, [
        notes or "",
        source_title or "",
        source_snippet or "",
    ])).lower()

    # 1. Linguistic Sentiment & Driver Extraction
    bear_score = 0.0
    bull_score = 0.0
    neutral_score = 0.0
    detected_drivers: List[str] = []

    for pattern, weight, driver_desc in BEARISH_PATTERNS:
        if re.search(pattern, combined_text):
            bear_score += weight
            if driver_desc not in detected_drivers:
                detected_drivers.append(driver_desc)

    for pattern, weight, driver_desc in BULLISH_PATTERNS:
        if re.search(pattern, combined_text):
            bull_score += weight
            if driver_desc not in detected_drivers:
                detected_drivers.append(driver_desc)

    for pattern, weight, driver_desc in NEUTRAL_PATTERNS:
        if re.search(pattern, combined_text):
            neutral_score += weight
            if driver_desc not in detected_drivers:
                detected_drivers.append(driver_desc)

    implied_val = implied_return if implied_return is not None else 0.0
    if target_level and spot_at_publication > 0:
        implied_val = (target_level / spot_at_publication) - 1.0

    # 2. Net Sentiment Synthesis
    text_sentiment = bull_score - bear_score
    raw_sentiment = (text_sentiment * 0.45) + (implied_val * 2.5)
    sentiment_score = max(-1.0, min(1.0, raw_sentiment))

    # 3. Pure AI Stance Determination
    if sentiment_score > 0.08:
        ai_stance = "bullish"
    elif sentiment_score < -0.08:
        ai_stance = "bearish"
    else:
        ai_stance = "neutral"

    # 4. Confidence Calculation
    signal_strength = abs(sentiment_score) + abs(implied_val * 3.0) + (0.2 if detected_drivers else 0.0)
    confidence = min(0.98, max(0.72, 0.70 + (signal_strength * 0.15)))

    # 5. AI Reasoning Narrative Generation
    strat_byline = strategist_name or f"{institution_name} Strategy Desk"
    target_str = f"{target_level:,.0f}" if target_level else "Tactical Stance"
    spot_str = f"{spot_at_publication:,.1f}"
    implied_pct_str = f"{implied_val * 100:+.1f}%"
    # Label the gap by its own sign, not by the stance: a bullish read on a
    # negative implied return was rendering "-2.7% upside".
    implied_word = "upside" if implied_val >= 0 else "downside"

    drivers_summary = ", ".join(detected_drivers[:3]) if detected_drivers else "Macro baseline valuation model"

    if ai_stance == "bullish":
        reasoning = (
            f"AI Model determined BULLISH ({confidence*100:.0f}% confidence). "
            f"{strat_byline} communicated growth with target {target_str} vs. spot {spot_str} ({implied_pct_str} {implied_word}). "
            f"Key macro drivers: {drivers_summary}."
        )
    elif ai_stance == "bearish":
        reasoning = (
            f"AI Model determined BEARISH ({confidence*100:.0f}% confidence). "
            f"{strat_byline} communicated downside risk with target {target_str} vs. spot {spot_str} ({implied_pct_str} {implied_word}). "
            f"Key risk drivers: {drivers_summary}."
        )
    else:
        reasoning = (
            f"AI Model determined NEUTRAL ({confidence*100:.0f}% confidence). "
            f"{strat_byline} communicated range-bound / cautious expectations ({implied_pct_str} spread vs spot {spot_str}). "
            f"Market drivers: {drivers_summary}."
        )

    # 6. Reconciliation against the authoritative band arithmetic
    from scorecard.derive import classify_direction

    resolved_math_direction = math_direction
    if resolved_math_direction is None and target_level:
        resolved_math_direction = classify_direction(implied_val, band)
    agreement = None if resolved_math_direction is None else int(ai_stance == resolved_math_direction)
    if agreement == 0:
        reasoning += (
            f" Note: the band arithmetic scores this call {resolved_math_direction.upper()} "
            f"({implied_pct_str} vs a +/-{band * 100:.0f}% indifference band); the scorecard "
            f"uses the arithmetic, and this linguistic read is recorded for contrast only."
        )

    return {
        "ai_stance": ai_stance,
        "ai_confidence": round(confidence, 3),
        "ai_sentiment_score": round(sentiment_score, 3),
        "ai_reasoning": reasoning,
        "ai_key_drivers": detected_drivers,
        "ai_math_agreement": agreement,
        "math_direction": resolved_math_direction,
    }


def run_ai_stance_audit_on_all_calls(conn: sqlite3.Connection) -> int:
    """Run the linguistic stance audit on every call and record agreement with the band math."""
    # Fully derived table — rebuilt from scratch on every run so schema changes
    # and stale rows can never linger.
    conn.execute("DROP TABLE IF EXISTS ai_call_audit")
    conn.execute(
        """
        CREATE TABLE ai_call_audit (
            call_id TEXT PRIMARY KEY REFERENCES call(id),
            ai_stance TEXT NOT NULL CHECK(ai_stance IN ('bullish', 'bearish', 'neutral')),
            ai_confidence REAL NOT NULL CHECK(ai_confidence >= 0.0 AND ai_confidence <= 1.0),
            ai_sentiment_score REAL NOT NULL,
            ai_reasoning TEXT NOT NULL,
            ai_key_drivers TEXT NOT NULL,
            -- NULL when the call carries no price target, so there is no band
            -- arithmetic for the linguistic read to agree or disagree with.
            ai_math_agreement INTEGER CHECK(ai_math_agreement IS NULL OR ai_math_agreement IN (0, 1)),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """
    )

    cur = conn.execute(
        """
        SELECT
            c.id, c.institution_id, i.name as institution_name,
            c.published_on, c.call_type, c.target_level, c.spot_at_publication,
            c.implied_return, c.direction, c.band, c.notes,
            s.name as strategist_name,
            sd.title as source_title, sd.snippet as source_snippet
        FROM call c
        JOIN institution i ON c.institution_id = i.id
        LEFT JOIN strategist s ON c.strategist_id = s.id
        LEFT JOIN source_document sd ON c.source_url = sd.url
        """
    )
    calls = [dict(r) for r in cur.fetchall()]
    inserted = 0

    for c in calls:
        audit_res = audit_call_stance_with_ai(
            institution_id=c["institution_id"],
            institution_name=c["institution_name"],
            strategist_name=c["strategist_name"],
            published_on=c["published_on"],
            call_type=c["call_type"],
            target_level=float(c["target_level"]) if c["target_level"] is not None else None,
            spot_at_publication=float(c["spot_at_publication"] or 0.0),
            implied_return=float(c["implied_return"]) if c["implied_return"] is not None else None,
            notes=c["notes"],
            source_title=c["source_title"],
            source_snippet=c["source_snippet"],
            math_direction=c["direction"],
            band=float(c["band"]) if c["band"] is not None else DIRECTION_BAND,
        )

        conn.execute(
            """
            INSERT INTO ai_call_audit (
                call_id, ai_stance, ai_confidence, ai_sentiment_score,
                ai_reasoning, ai_key_drivers, ai_math_agreement
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                c["id"],
                audit_res["ai_stance"],
                audit_res["ai_confidence"],
                audit_res["ai_sentiment_score"],
                audit_res["ai_reasoning"],
                json.dumps(audit_res["ai_key_drivers"]),
                audit_res["ai_math_agreement"],
            ),
        )
        inserted += 1

    return inserted

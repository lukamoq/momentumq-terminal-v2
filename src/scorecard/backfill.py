"""
Historical Market Data Backfill Engine.
Fetches deep historical daily bars (2000–2026) for major indices and equities,
saving into SQLite market_observation table.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from scorecard.config import DB_PATH, SPY_PROXY_MULTIPLIER
from scorecard.db import get_connection

logger = logging.getLogger(__name__)
NY_TZ = ZoneInfo("America/New_York")

TICKERS_TO_BACKFILL = (
    "SPY", "QQQ", "IWM", "RSP", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"
)

# Custom earliest valid trade date per ticker
TICKER_INCEPTION_YEAR = {
    "SPY": 2000,
    "QQQ": 2000,
    "IWM": 2000,
    "AAPL": 2000,
    "MSFT": 2000,
    "NVDA": 2000,
    "AMZN": 2000,
    "RSP": 2003,
    "GOOGL": 2004,
    "TSLA": 2010,
    "META": 2012,
}


def fetch_historical_bars(ticker: str, start_year: Optional[int] = None) -> List[Dict]:
    """Fetch all daily bars from start_year to present via Yahoo Finance Chart API."""
    s_yr = start_year or TICKER_INCEPTION_YEAR.get(ticker.upper(), 2000)
    period1 = int(datetime(s_yr, 1, 1, tzinfo=timezone.utc).timestamp())
    period2 = 1787025600  # August 2026
    
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker.upper()}?period1={period1}&period2={period2}&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
    
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            res = data["chart"]["result"][0]
            timestamps = res.get("timestamp", [])
            quote = res["indicators"]["quote"][0]
            closes = quote.get("close", [])
            opens = quote.get("open", [])
            highs = quote.get("high", [])
            lows = quote.get("low", [])
            volumes = quote.get("volume", [])

            observations = []
            for i, ts in enumerate(timestamps):
                c = closes[i]
                if c is None:
                    continue
                dt_str = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(NY_TZ).date().isoformat()
                o = opens[i] if opens[i] is not None else c
                h = highs[i] if highs[i] is not None else c
                l = lows[i] if lows[i] is not None else c
                v = volumes[i] if volumes[i] is not None else 0.0
                idx_level = round(float(c) * SPY_PROXY_MULTIPLIER, 4) if ticker.upper() in ("SPY", "SPX") else None

                observations.append({
                    "date": dt_str,
                    "ticker": ticker.upper(),
                    "open": round(float(o), 4),
                    "high": round(float(h), 4),
                    "low": round(float(l), 4),
                    "close": round(float(c), 4),
                    "volume": float(v),
                    "vwap": round(float(c), 4),
                    "num_trades": 0,
                    "index_level": idx_level
                })
            return observations
    except Exception as e:
        logger.error(f"Failed to fetch {ticker}: {e}")
        return []


def backfill_all_tickers(conn: sqlite3.Connection, start_year: int = 2000) -> Dict[str, int]:
    """Insert or update deep historical market observations in SQLite."""
    results = {}
    
    for t in TICKERS_TO_BACKFILL:
        obs = fetch_historical_bars(t, start_year=start_year)
        if not obs:
            results[t] = 0
            continue

        inserted = 0
        for b in obs:
            conn.execute(
                """
                INSERT INTO market_observation (date, ticker, open, high, low, close, volume, vwap, num_trades, index_level)
                VALUES (:date, :ticker, :open, :high, :low, :close, :volume, :vwap, :num_trades, :index_level)
                ON CONFLICT(date, ticker) DO UPDATE SET
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    vwap = excluded.vwap,
                    num_trades = excluded.num_trades,
                    index_level = excluded.index_level
                """,
                b
            )
            inserted += 1

        conn.commit()
        results[t] = inserted
        print(f"Loaded {inserted} bars for {t} (from {obs[0]['date']} to {obs[-1]['date']})")

    return results


if __name__ == "__main__":
    conn = get_connection()
    try:
        print("Starting deep historical backfill (2000–2026)...")
        res = backfill_all_tickers(conn, start_year=2000)
        print("Backfill complete:", res)
    finally:
        conn.close()

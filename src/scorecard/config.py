"""Configuration and project paths for Sell-Side Scorecard."""

from __future__ import annotations

import os
from pathlib import Path
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(PROJECT_ROOT / ".env")

DATA_DIR = PROJECT_ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
MASSIVE_CACHE_DIR = CACHE_DIR / "massive"
TAVILY_CACHE_DIR = CACHE_DIR / "tavily"
CURATED_DIR = DATA_DIR / "curated"
DB_PATH = DATA_DIR / "scorecard.db"
WEB_DIR = PROJECT_ROOT / "web"

MASSIVE_API_KEY = os.getenv("MASSIVE_API_KEY", "")
MASSIVE_BASE_URL = os.getenv("MASSIVE_BASE_URL", "https://api.massive.com")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

# Product & Modeling Parameters
DIRECTION_BAND = 0.02  # 2% band for bullish/bearish/neutral
SPY_PROXY_MULTIPLIER = 10.0  # S&P 500 index level = SPY * 10
HORIZONS = ("1M", "3M", "6M", "YE")
HORIZON_DAYS = {
    "1M": 30,
    "3M": 90,
    "6M": 180,
    "YE": None,  # Evaluates to 2026-12-31
}
CLIMATOLOGY_RECESSION_PRIOR = 1.0 / 6.0  # ~16.67% prior for 1-year recession
HISTORY_START_DATE = "2021-08-19"  # start of the 5-year market window
AS_OF_DATE = "2026-08-18"
YEAR_END_2026 = "2026-12-31"
MAX_SPOT_LOOKBACK_DAYS = 7

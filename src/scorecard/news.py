"""News and source discovery client for Tavily search results."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
import httpx

from scorecard.config import TAVILY_API_KEY, TAVILY_CACHE_DIR

logger = logging.getLogger(__name__)


def search_tavily(
    query: str,
    topic: str = "finance",
    search_depth: str = "basic",
    start_date: str = "2025-11-01",
    end_date: str = "2026-08-18",
    include_answer: bool = True,
    save_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute search query against Tavily API and cache result."""
    TAVILY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not TAVILY_API_KEY:
        logger.warning("No TAVILY_API_KEY configured.")
        return {}

    url = "https://api.tavily.com/search"
    headers = {
        "Authorization": f"Bearer {TAVILY_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "query": query,
        "topic": topic,
        "search_depth": search_depth,
        "start_date": start_date,
        "end_date": end_date,
        "include_answer": include_answer,
    }

    with httpx.Client(timeout=30.0) as client:
        resp = client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()

    if save_name:
        cache_file = TAVILY_CACHE_DIR / f"tavily_{save_name}.json"
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    return data


def load_all_cached_tavily_results() -> List[Dict[str, Any]]:
    """Load all JSON files from data/cache/tavily/."""
    results = []
    if not TAVILY_CACHE_DIR.exists():
        return results

    for path in sorted(TAVILY_CACHE_DIR.glob("*.json")):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                data["_file_name"] = path.name
                results.append(data)
        except Exception as e:
            logger.warning(f"Error loading {path}: {e}")
    return results


def ingest_source_documents(conn: sqlite3.Connection) -> int:
    """Extract and insert all unique URLs and snippets from cached Tavily searches."""
    cached = load_all_cached_tavily_results()
    inserted_count = 0

    for item in cached:
        query = item.get("query", "")
        file_name = item.get("_file_name", "")
        for res in item.get("results", []):
            url = res.get("url")
            if not url:
                continue
            title = res.get("title", "")
            snippet = res.get("content", "")
            published_at = res.get("published_date")
            # Content-addressed, not hash() — builtin string hashing is salted
            # per process (PYTHONHASHSEED), which made document ids differ on
            # every rebuild of the database.
            doc_id = "doc_" + hashlib.blake2s(url.encode("utf-8"), digest_size=8).hexdigest()

            conn.execute(
                """
                INSERT INTO source_document (id, url, title, publisher, published_at, snippet, query_used, fetch_method)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url) DO UPDATE SET
                    title = coalesce(excluded.title, source_document.title),
                    snippet = coalesce(excluded.snippet, source_document.snippet),
                    published_at = coalesce(excluded.published_at, source_document.published_at)
                """,
                (
                    doc_id,
                    url,
                    title,
                    file_name,
                    published_at,
                    snippet,
                    query,
                    "tavily_search",
                ),
            )
            inserted_count += 1

    return inserted_count

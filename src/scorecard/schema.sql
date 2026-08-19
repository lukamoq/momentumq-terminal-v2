-- Sell-Side Direction Scorecard SQLite Schema

PRAGMA foreign_keys = ON;

-- 1. Core Reference Entities
CREATE TABLE IF NOT EXISTS institution (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    website TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategist (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategist_affiliation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategist_id TEXT NOT NULL REFERENCES strategist(id),
    institution_id TEXT NOT NULL REFERENCES institution(id),
    start_date TEXT,
    end_date TEXT,
    UNIQUE(strategist_id, institution_id, start_date)
);

-- 2. Market Observations
CREATE TABLE IF NOT EXISTS market_observation (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    open NUMERIC NOT NULL,
    high NUMERIC NOT NULL,
    low NUMERIC NOT NULL,
    close NUMERIC NOT NULL,
    volume NUMERIC,
    vwap NUMERIC,
    num_trades INTEGER,
    index_level NUMERIC,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_market_obs_date ON market_observation(date);
CREATE INDEX IF NOT EXISTS idx_market_obs_ticker_date ON market_observation(ticker, date);

-- 3. Sources & Documentation
CREATE TABLE IF NOT EXISTS source_document (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    publisher TEXT,
    published_at TEXT,
    snippet TEXT,
    query_used TEXT,
    fetch_method TEXT DEFAULT 'tavily_search',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Calls (Immutable historical record)
CREATE TABLE IF NOT EXISTS call (
    id TEXT PRIMARY KEY,
    institution_id TEXT NOT NULL REFERENCES institution(id),
    strategist_id TEXT REFERENCES strategist(id),
    call_type TEXT NOT NULL CHECK(call_type IN ('direction', 'allocation', 'probability')),
    published_on TEXT NOT NULL,
    approximate_date INTEGER NOT NULL DEFAULT 0 CHECK(approximate_date IN (0, 1)),
    target_level NUMERIC,
    spot_at_publication NUMERIC NOT NULL CHECK(spot_at_publication > 0),
    implied_return NUMERIC,
    band NUMERIC NOT NULL DEFAULT 0.02,
    direction TEXT CHECK(direction IN ('bullish', 'bearish', 'neutral')),
    allocation_stance TEXT CHECK(allocation_stance IN ('overweight', 'underweight', 'neutral')),
    allocation_asset TEXT DEFAULT 'SPX',
    allocation_benchmark TEXT DEFAULT 'ACWI',
    probability_event TEXT,
    probability_value NUMERIC CHECK(probability_value IS NULL OR (probability_value >= 0.0 AND probability_value <= 1.0)),
    forecast_horizon TEXT NOT NULL DEFAULT 'YE_2026',
    confidence TEXT NOT NULL DEFAULT 'verified' CHECK(confidence IN ('verified', 'approximate_date', 'unconfirmed')),
    source_url TEXT,
    source_document_id TEXT REFERENCES source_document(id),
    supersedes_id TEXT REFERENCES call(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    raw_payload TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_inst_date ON call(institution_id, published_on);
CREATE INDEX IF NOT EXISTS idx_call_type_date ON call(call_type, published_on);

-- Trigger: Immutability enforcement on call table
CREATE TRIGGER IF NOT EXISTS trg_call_immutable
BEFORE UPDATE ON call
FOR EACH ROW
WHEN (
    OLD.institution_id != NEW.institution_id OR
    OLD.strategist_id IS NOT NEW.strategist_id OR
    OLD.call_type != NEW.call_type OR
    OLD.published_on != NEW.published_on OR
    OLD.approximate_date != NEW.approximate_date OR
    OLD.target_level IS NOT NEW.target_level OR
    OLD.spot_at_publication != NEW.spot_at_publication OR
    OLD.implied_return IS NOT NEW.implied_return OR
    OLD.band != NEW.band OR
    OLD.direction IS NOT NEW.direction OR
    OLD.allocation_stance IS NOT NEW.allocation_stance OR
    OLD.allocation_asset IS NOT NEW.allocation_asset OR
    OLD.allocation_benchmark IS NOT NEW.allocation_benchmark OR
    OLD.probability_event IS NOT NEW.probability_event OR
    OLD.probability_value IS NOT NEW.probability_value OR
    OLD.forecast_horizon != NEW.forecast_horizon OR
    OLD.confidence != NEW.confidence OR
    OLD.source_url IS NOT NEW.source_url OR
    OLD.idempotency_key != NEW.idempotency_key
)
BEGIN
    SELECT RAISE(ABORT, 'Call records are immutable. Only supersedes_id may be updated.');
END;

-- 5. Binary Event Outcomes (e.g. recession)
CREATE TABLE IF NOT EXISTS event_outcome (
    event_key TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    -- Base rate for THIS event. A recession year and a Fed-cut year do not
    -- share a prior, so a single global constant cannot score both honestly.
    climatology_prior NUMERIC NOT NULL DEFAULT 0.16666666666666666
        CHECK(climatology_prior > 0.0 AND climatology_prior < 1.0),
    resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0, 1)),
    outcome NUMERIC CHECK(outcome IS NULL OR outcome IN (0, 1)),
    resolved_on TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Scoring Tables (Droppable & Rebuilt deterministically)

CREATE TABLE IF NOT EXISTS score_direction (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES call(id),
    institution_id TEXT NOT NULL REFERENCES institution(id),
    evaluation_kind TEXT NOT NULL CHECK(evaluation_kind IN ('event', 'stance_day')),
    as_of_date TEXT NOT NULL,
    horizon TEXT NOT NULL CHECK(horizon IN ('1M', '3M', '6M', 'YE')),
    window_start_date TEXT NOT NULL,
    window_end_date TEXT NOT NULL,
    start_price NUMERIC NOT NULL,
    end_price NUMERIC,
    realised_return NUMERIC,
    forecast_direction TEXT NOT NULL CHECK(forecast_direction IN ('bullish', 'bearish', 'neutral')),
    realised_direction TEXT CHECK(realised_direction IN ('bullish', 'bearish', 'flat')),
    verdict TEXT NOT NULL CHECK(verdict IN ('hit', 'miss', 'too_early')),
    is_resolved INTEGER NOT NULL CHECK(is_resolved IN (0, 1)),
    always_bullish_verdict TEXT NOT NULL CHECK(always_bullish_verdict IN ('hit', 'miss', 'too_early')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_score_dir_inst ON score_direction(institution_id, evaluation_kind);
CREATE INDEX IF NOT EXISTS idx_score_dir_call ON score_direction(call_id);

CREATE TABLE IF NOT EXISTS score_allocation (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES call(id),
    institution_id TEXT NOT NULL REFERENCES institution(id),
    evaluation_kind TEXT NOT NULL CHECK(evaluation_kind IN ('event', 'stance_day')),
    as_of_date TEXT NOT NULL,
    horizon TEXT NOT NULL CHECK(horizon IN ('1M', '3M', '6M', 'YE')),
    window_start_date TEXT NOT NULL,
    window_end_date TEXT NOT NULL,
    asset_start_price NUMERIC NOT NULL,
    asset_end_price NUMERIC,
    asset_return NUMERIC,
    bench_start_price NUMERIC NOT NULL,
    bench_end_price NUMERIC,
    bench_return NUMERIC,
    spread_return NUMERIC,
    stance TEXT NOT NULL CHECK(stance IN ('overweight', 'underweight', 'neutral')),
    verdict TEXT NOT NULL CHECK(verdict IN ('hit', 'miss', 'too_early')),
    is_resolved INTEGER NOT NULL CHECK(is_resolved IN (0, 1)),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_score_alloc_inst ON score_allocation(institution_id);

CREATE TABLE IF NOT EXISTS score_probability (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES call(id),
    institution_id TEXT NOT NULL REFERENCES institution(id),
    event_key TEXT NOT NULL REFERENCES event_outcome(event_key),
    as_of_date TEXT NOT NULL,
    probability_value NUMERIC NOT NULL,
    climatology_prior NUMERIC NOT NULL DEFAULT 0.16666666666666666,
    is_resolved INTEGER NOT NULL CHECK(is_resolved IN (0, 1)),
    actual_outcome NUMERIC,
    brier_score NUMERIC,
    brier_climatology NUMERIC,
    brier_skill_score NUMERIC,
    verdict TEXT NOT NULL CHECK(verdict IN ('hit', 'miss', 'too_early')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS score_lag (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES call(id),
    previous_call_id TEXT NOT NULL REFERENCES call(id),
    institution_id TEXT NOT NULL REFERENCES institution(id),
    flip_date TEXT NOT NULL,
    from_direction TEXT NOT NULL,
    to_direction TEXT NOT NULL,
    move_30d_before NUMERIC NOT NULL,
    move_30d_after NUMERIC,
    lag_ratio NUMERIC,
    is_resolved INTEGER NOT NULL CHECK(is_resolved IN (0, 1)),
    status TEXT NOT NULL CHECK(status IN ('resolved', 'too_early')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS score_bank (
    institution_id TEXT PRIMARY KEY REFERENCES institution(id),
    total_calls INTEGER NOT NULL DEFAULT 0,
    n_bullish INTEGER NOT NULL DEFAULT 0,
    n_bearish INTEGER NOT NULL DEFAULT 0,
    n_neutral INTEGER NOT NULL DEFAULT 0,
    is_always_bullish INTEGER NOT NULL DEFAULT 0 CHECK(is_always_bullish IN (0, 1)),
    event_hits INTEGER NOT NULL DEFAULT 0,
    event_misses INTEGER NOT NULL DEFAULT 0,
    event_too_early INTEGER NOT NULL DEFAULT 0,
    event_resolved INTEGER NOT NULL DEFAULT 0,
    event_hit_rate NUMERIC,
    always_bullish_event_hit_rate NUMERIC,
    event_edge NUMERIC,
    stance_day_hits INTEGER NOT NULL DEFAULT 0,
    stance_day_misses INTEGER NOT NULL DEFAULT 0,
    stance_day_too_early INTEGER NOT NULL DEFAULT 0,
    stance_day_resolved INTEGER NOT NULL DEFAULT 0,
    stance_day_hit_rate NUMERIC,
    always_bullish_stance_day_hit_rate NUMERIC,
    stance_day_edge NUMERIC,
    allocation_hits INTEGER NOT NULL DEFAULT 0,
    allocation_misses INTEGER NOT NULL DEFAULT 0,
    allocation_too_early INTEGER NOT NULL DEFAULT 0,
    allocation_resolved INTEGER NOT NULL DEFAULT 0,
    allocation_hit_rate NUMERIC,
    avg_lag_ratio NUMERIC,
    status_label TEXT NOT NULL DEFAULT 'evaluated',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

# MomentumQ Terminal v2

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python: 3.11+](https://img.shields.io/badge/python-3.11%20%7C%203.12-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg)](https://fastapi.tiangolo.com)
[![Tests: 68 Passed](https://img.shields.io/badge/tests-68%20passed-success.svg)](https://pytest.org)
[![Architecture: Swiss Dark Blotter](https://img.shields.io/badge/Design-Swiss%20Industrial%20Dark-gold.svg)](web/styles.css)

An institutional-grade, open-source quantitative research platform and analytics terminal evaluating Wall Street sell-side research calls (2021–2026), multi-asset seasonality, cross-asset macro regimes, Black-Scholes-Merton (BSM) options Greeks & dealer GEX positioning, Fear & Greed Index 2.0, and VIX term structure.

---

## Key Modules & Analytics

### 1. Sell-Side Direction Scorecard (`/index.html`)
- **Rigorous Direction Classifier**: Evaluates price targets against realized market prices using a strict $\pm 2.0\%$ indifference band. No subjective overrides.
- **Consensus Free-Rider Problem**: Measures empirical alpha against naive always-bullish baselines rather than unearned nominal win rates.
- **Anti-Failure Display**: Strategy desks with no discriminating bearish/neutral calls render `NO DISCRIMINATING CALLS` rather than inflated 100% scores.
- **Relative Allocation Benchmark**: Overweight/Underweight calls are scored against global equity benchmarks (`ACWI`) rather than nominal zero.
- **Interactive Price Chart**: Displays Wall Street bank price targets vertically aligned with historical price action.

### 2. Magnificent 7 Big Tech Stock Breakdown (`/mag7.html`)
- **Constituents**: `NVDA`, `AAPL`, `MSFT`, `AMZN`, `GOOGL`, `META`, `TSLA` + Equal-Weight `MAG7` Basket.
- **Split-Adjusted Target Normalization**: Reconciles historical published targets with retroactive stock splits.
- **Ticker Lineage Reassembly**: Reconstructs continuous corporate history (e.g. `FB` $\rightarrow$ `META` continuous boundary).
- **Thematic Dossiers**: Quantitatively cross-checks editorial claims against verified broker records.

### 3. Cross-Asset Seasonality & Cumulative Path Curves (`/seasonality.html`)
- **27-Year Daily Cycle Curves**: Forward-fills completed years to 252 trading days, eliminating calendar misalignment.
- **Dynamic Cycle Span Filtering**: Filter curves by `ALL (27Y)`, `20Y`, `10Y`, `5Y`, `POST_COVID`, `ELECTION`, `DECADE_2020S`, `DECADE_2010S`, `DECADE_2000S`.
- **Monthly Return Heatmaps**: Historical month-by-month return matrix and distribution statistics for `SPY`, `QQQ`, `IWM`, and major sectors.

### 4. Options Volatility Skew & Multi-Horizon BSM Greeks (`/seasonality.html#secOptionsAnalysis`)
- **Closed-Form BSM Analytical Engine**: Computes exact 1st- and 2nd-order Greeks with continuous dividend yield cost-of-carry ($b = r - q$):
  - **First-Order**: Call/Put Delta ($\Delta$), Gamma ($\Gamma$), Theta ($\Theta$/day decay), Vega ($\mathcal{V}$/1% IV), Rho ($\rho$).
  - **Second-Order**: Vanna ($\partial\Delta/\partial\sigma$), Charm ($\partial\Delta/\partial t$).
- **Multi-Horizon Outlook**: Real-time forward views across:
  - `1-Week (7 DTE)`: Peak Gamma risk and steep Theta decay acceleration.
  - `Next-Week (14 DTE)`: Intermediate weekly rollover and transition window.
  - `1-Month (30 DTE)`: Institutional benchmark cycle with high Vega sensitivity.
  - `All Horizons Matrix`: Complete term structure comparison matrix.
- **Dynamic Structure Levels**: Expiration-specific Max Pain, Gamma Flip level, Call Wall, Put Wall, and Expected Move Diffusion Cones ($\pm 1\sigma = S \cdot \sigma \sqrt{T}$).

### 5. Macro Regime, Fear & Greed 2.0, and VIX Term Structure
- **Fear & Greed Index 2.0**: 7-component institutional model (Price Momentum, Stock Price Strength, Market Breadth, Put/Call Ratio, Volatility Skew, Safe-Haven Demand, Junk Bond Spread).
- **Macro Regime Matrix**: Quad-state clustering (Risk-On Bull, High-Vol Expansion, Low-Vol Grind, Risk-Off Bear).
- **VIX Term Structure**: Constant-maturity curve monitoring contango/backwardation curvature (VIX vs VIX3M vs VIX9D).

---

## System Architecture

```
research/
├── src/scorecard/
│   ├── config.py       # Constants, asset parameters, dividend yields, risk-free baseline
│   ├── schema.sql      # SQLite schema with triggers & constraints
│   ├── db.py           # Connection handling & score table resets
│   ├── derive.py       # Band-based direction classification, Brier, lag math
│   ├── market.py       # Market data loader & ticker lineage reconstructor
│   ├── options.py      # BSM analytical Greeks, 25Δ skew, dealer GEX, multi-horizon engine
│   ├── fear_greed.py   # 7-component Fear & Greed Index 2.0 quantitative engine
│   ├── vix.py          # VIX constant-maturity term structure engine
│   ├── regime.py       # Cross-asset macro regime & sector rotation breadth
│   ├── seasonality.py  # 27-year seasonality matrix & 252-day forward-filled curve math
│   ├── score.py        # 6 scoring paths, edge vs baseline, stance-days
│   ├── mag7.py         # Mag 7 engine: equal-weight basket, split adjustment, derived verdicts
│   ├── api.py          # FastAPI REST endpoints & static file server
│   └── cli.py          # Unified CLI (ingest, score, check, serve)
├── data/
│   ├── curated/        # Verified calls.yaml, institutions.yaml, events.yaml, mag7_calls.yaml
│   └── scorecard.db    # SQLite database (auto-built via CLI)
├── web/
│   ├── index.html      # S&P 500 Direction Scorecard UI (Dark blotter)
│   ├── mag7.html       # Magnificent 7 Scorecard UI
│   ├── seasonality.html# Cross-Asset Seasonality & Quant Analytics Terminal
│   ├── styles.css      # Swiss industrial dark blotter design (IBM Plex)
│   ├── app.js          # S&P 500 interactive timeline & blotter
│   ├── mag7.js         # Mag 7 normalized return charts & audit blotter
│   └── seasonality.js  # Seasonality, Options Skew, Fear & Greed, VIX UI
└── tests/
    ├── test_scorecard.py   # 22 tests for direction scoring & 8 acceptance criteria
    ├── test_mag7.py        # 12 tests for Mag 7 stock breakdown & thematic dossiers
    ├── test_seasonality.py # 5 tests for seasonality matrix & curves
    ├── test_options.py     # 16 tests for BSM Greeks & multi-horizon term structure
    ├── test_regime.py      # 6 tests for macro regime & correlations
    ├── test_fear_greed.py  # 2 tests for Fear & Greed Index 2.0
    └── test_vix.py         # 2 tests for VIX term structure
```

---

## Quickstart Guide

### 1. Installation
```bash
# Clone the repository
git clone https://github.com/lukamoq/momentumq-terminal-v2.git
cd momentumq-terminal-v2

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"
```

### 2. API Keys & Environment Configuration

The platform operates **100% offline out-of-the-box** using the included curated datasets (`data/curated/`). To fetch live market data or run search sweeps, configure your provider API keys:

| Provider | Environment Variable | Purpose | Optional / Required |
| :--- | :--- | :--- | :--- |
| **[Massive](https://massive.com)** | `MASSIVE_API_KEY` | Daily aggregate bars across 61 tickers | Optional (curated offline bars included) |
| **[Tavily](https://app.tavily.com)** | `TAVILY_API_KEY` | Web search discovery sweeps for broker research | Optional (curated forecast YAMLs included) |

#### Interactive Setup Wizard
Run the setup wizard to configure keys, initialize the database, and build the initial scorecard in one step:
```bash
python -m scorecard setup -i
```

#### CLI Key Configuration
Alternatively, set keys directly via the CLI:
```bash
# Set Massive API key
python -m scorecard config --massive-key "msv_your_key_here"

# Set Tavily API key
python -m scorecard config --tavily-key "tvly_your_key_here"

# Inspect current configuration status (masked)
python -m scorecard config
```

### 3. Initialize Database & Run Scoring Pipeline
```bash
# Ingest curated Wall Street calls & historical market series
python -m scorecard ingest

# Score all institutions across multi-horizon windows
python -m scorecard score

# Verify all invariants and test suite
python -m scorecard check
pytest -v
```

### 4. Launch Web Terminal
```bash
python -m scorecard serve --host 127.0.0.1 --port 8000
```
Open your browser to:
- **S&P 500 Scorecard**: [http://localhost:8000](http://localhost:8000)
- **Mag 7 Tech Scorecard**: [http://localhost:8000/mag7.html](http://localhost:8000/mag7.html)
- **Seasonality & Options Terminal**: [http://localhost:8000/seasonality.html](http://localhost:8000/seasonality.html)

---

## Open Source Permissions & Branch Policy

- **Public Pull / Clone**: Anyone can clone (`git clone`) and pull (`git pull`) this repository to inspect, audit, and run the models locally.
- **Write / Push Restrictions**: Direct pushes to `main` are restricted to repository owners.
- **Contributions**: Contributions, fixes, and quantitative enhancements should be proposed via **Forks and Pull Requests** adhering to [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

This project is licensed under the [MIT License](LICENSE).

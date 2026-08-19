# Contributing to MomentumQ Terminal

Thank you for your interest in the MomentumQ Quantitative Research & Analytics Terminal!

## Repository Policy: Read-Only Public Distribution

This repository is published as an **open-source public project**:
- **Pull & Clone Access**: Anyone is welcome to clone (`git clone`), pull updates (`git pull`), inspect the code, reproduce research, and run the FastAPI server and visualization dashboards locally.
- **Push & Write Access**: Direct pushes (`git push`) to `main` and release branches are strictly restricted to repository maintainers.
- **Contributions**: Community contributions, bug reports, and research enhancements must be submitted via **Forks and Pull Requests (PRs)**.

---

## Local Development Setup

### 1. Prerequisites
- Python 3.11 or 3.12
- `uv` (recommended) or `pip` / `venv`
- Node.js (for syntax validation of frontend assets)

### 2. Clone and Install
```bash
# Clone repository
git clone https://github.com/lukamoq/momentumq-terminal.git
cd momentumq-terminal

# Create virtual environment and install dependencies
uv venv
source .venv/bin/activate
uv pip install -e ".[dev]"
```

### 3. Initialize Database & Run Scorecard
```bash
# Ingest curated market forecasts and score all desks
python -m scorecard ingest
python -m scorecard score

# Run the full validation check
python -m scorecard check
```

### 4. Launch the Web Analytics & Seasonality Dashboard
```bash
python -m scorecard serve --port 8000
```
Open [http://localhost:8000](http://localhost:8000) or [http://localhost:8000/seasonality.html](http://localhost:8000/seasonality.html) in your browser.

---

## Pull Request Guidelines

1. **Fork the Repository**: Create your feature branch from `main` (`git checkout -b feature/my-quant-feature`).
2. **Deterministic & Evidence-Backed**: All financial data, market models, and formulas must be mathematically sound, arbitrage-free, and tested against real market benchmarks.
3. **Run the Full Test Suite**:
   ```bash
   pytest -v
   node -c web/app.js && node -c web/mag7.js && node -c web/seasonality.js
   ```
4. **Submit PR**: Open a Pull Request against `main` detailing the mathematical rationale, benchmark comparison, and test results.

---

## Code of Conduct

Maintain professional, rigorous, and evidence-based quantitative discourse. All claims and verdicts must be mathematically verifiable and reproducible.

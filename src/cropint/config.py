"""Load and derive pipeline parameters from the project YAML config."""

from datetime import datetime, timedelta

import yaml


def load_config(path: str = "config/raichur.yaml") -> dict:
    """Load pipeline parameters from YAML."""
    try:
        with open(path, "r") as f:
            return yaml.safe_load(f)
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"Config not found at {path}; run from the repo root or pass an explicit path."
        ) from exc


def agri_year_bounds(cfg: dict) -> tuple[datetime, datetime]:
    """Parse agri_year.start/end (YYYY-MM-DD) into datetimes."""
    start = datetime.strptime(cfg["agri_year"]["start"], "%Y-%m-%d")
    end = datetime.strptime(cfg["agri_year"]["end"], "%Y-%m-%d")
    return start, end


def composite_periods(cfg: dict) -> list[tuple[datetime, datetime]]:
    """Regular composite_days-wide [period_start, period_end) windows spanning the agri-year, inclusive of the end date (last window may be shorter)."""
    start, end = agri_year_bounds(cfg)
    composite_days = cfg["satellite"]["composite_days"]
    periods = []
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=composite_days), end + timedelta(days=1))
        periods.append((cur, nxt))
        cur = nxt
    return periods


def period_labels(cfg: dict) -> list[str]:
    """Band-name labels matching composite_periods, e.g. 't00_20240601', 't01_20240616', ... (zero-padded index, period start date)."""
    return [
        f"t{i:02d}_{period_start:%Y%m%d}"
        for i, (period_start, _) in enumerate(composite_periods(cfg))
    ]

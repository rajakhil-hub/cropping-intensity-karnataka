"""Generate per-point inspection plots + combined grid from the extracted point time series."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pandas as pd

from cropint.config import load_config
from cropint.viz.plots import plot_group_grid

CSV = Path("data/samples/point_timeseries.csv")


def main() -> None:
    if not CSV.exists():
        sys.exit(f"Missing {CSV} — run scripts/extract_points.py first.")
    cfg = load_config()
    df = pd.read_csv(CSV)
    plot_group_grid(df, cfg, "data/samples")
    print("Wrote per-point PNGs and inspection grid under data/samples/")


if __name__ == "__main__":
    main()

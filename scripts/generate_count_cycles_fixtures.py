"""Generate JSON fixtures pairing NDVI series with the real Python `count_cycles` output.

Used by `gee_app/test/count_cycles.test.js` to check the JS port
(`gee_app/lib/count_cycles.js`) produces identical results to
`src/cropint/timeseries/processing.py`.
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np
import pandas as pd

from cropint.config import composite_periods, load_config
from cropint.timeseries.processing import count_cycles

POINT_TIMESERIES_CSV = "data/samples/point_timeseries.csv"
OUT_PATH = "tests/fixtures/count_cycles_expected.json"


def _gaussian_bumps(
    n: int,
    centers_steps: list[float],
    sigma_steps: float,
    baseline: float,
    height: float,
) -> np.ndarray:
    """Synthesize an NDVI-like curve as a baseline plus a sum of gaussian bumps (mirrors tests/test_processing.py)."""
    t = np.arange(n)
    curve = np.full(n, baseline, dtype=float)
    for c in centers_steps:
        curve += height * np.exp(-((t - c) ** 2) / (2 * sigma_steps**2))
    return curve


def nan_to_none(value):
    """Convert a bare float NaN to None (JSON has no NaN token); pass everything else through."""
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def load_real_points(n: int) -> list[dict]:
    """Group data/samples/point_timeseries.csv by name, sorted by date, into {name, ndvi} records of length n."""
    df = pd.read_csv(POINT_TIMESERIES_CSV)
    points = []
    for name, group in df.groupby("name", sort=True):
        group = group.sort_values("date")
        ndvi = group["ndvi"].astype(float).tolist()
        if len(ndvi) != n:
            raise SystemExit(f"{name}: expected {n} rows, got {len(ndvi)}")
        points.append({"name": name, "ndvi": ndvi})
    return points


def synthetic_points(n: int) -> list[dict]:
    """Six synthetic curves mirroring tests/test_processing.py's generators, one per expected class."""
    return [
        {"name": "synthetic_flat_class0", "ndvi": np.full(n, 0.12).tolist()},
        {
            "name": "synthetic_single_bump_class1",
            "ndvi": _gaussian_bumps(n, centers_steps=[12], sigma_steps=2.0, baseline=0.15, height=0.45).tolist(),
        },
        {
            "name": "synthetic_two_bumps_class2",
            "ndvi": _gaussian_bumps(n, centers_steps=[7, 17], sigma_steps=2.0, baseline=0.15, height=0.45).tolist(),
        },
        {
            "name": "synthetic_three_bumps_class3",
            "ndvi": _gaussian_bumps(n, centers_steps=[4, 12, 20], sigma_steps=2.0, baseline=0.15, height=0.45).tolist(),
        },
        {"name": "synthetic_all_nan_class255", "ndvi": np.full(n, np.nan).tolist()},
        {"name": "synthetic_plateau_class4", "ndvi": _plateau_curve(n)},
    ]


def _plateau_curve(n: int) -> list[float]:
    """Year-long high-NDVI plateau (sugarcane/plantation signature), mirrors tests/test_processing.py."""
    curve = np.full(n, 0.2)
    curve[2:23] = 0.75
    return curve.tolist()


def main() -> None:
    """Run the real count_cycles on real + synthetic points and write the JSON fixture for the JS parity test."""
    cfg = load_config()
    n = len(composite_periods(cfg))
    step_days = cfg["satellite"]["composite_days"]
    peaks_cfg = cfg["peaks"]

    points = load_real_points(n) + synthetic_points(n)

    fixture_points = []
    for point in points:
        ndvi = point["ndvi"]
        result = count_cycles(np.array(ndvi, dtype=float), step_days, cfg)
        fixture_points.append(
            {
                "name": point["name"],
                "ndvi": [nan_to_none(v) for v in ndvi],
                "expected": {
                    "n_peaks": result["n_peaks"],
                    "class_id": result["class_id"],
                    "amplitude": nan_to_none(result["amplitude"]),
                },
            }
        )

    fixture = {
        "step_days": step_days,
        "peaks_cfg": {
            "min_prominence": peaks_cfg["min_prominence"],
            "min_peak_ndvi": peaks_cfg["min_peak_ndvi"],
            "min_cycle_days": peaks_cfg["min_cycle_days"],
            "min_distance_days": peaks_cfg["min_distance_days"],
            "crop_amplitude_floor": peaks_cfg["crop_amplitude_floor"],
            "plateau_flag_days": peaks_cfg["plateau_flag_days"],
            "plateau_min_ndvi": peaks_cfg["plateau_min_ndvi"],
        },
        "points": fixture_points,
    }

    out_path = Path(OUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)

    print(f"Wrote {out_path} ({len(fixture_points)} points)")


if __name__ == "__main__":
    main()

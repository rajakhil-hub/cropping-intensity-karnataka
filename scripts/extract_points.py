"""Extract NDVI/VH composite time series at hand-picked sample points to a tidy CSV."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import ee
import pandas as pd
import yaml

from cropint.config import composite_periods, load_config, period_labels
from cropint.gee.init import ee_init
from cropint.gee.stacks import composite_series, extract_point_series, s1_vh_collection, s2_ndvi_collection

SAMPLE_POINTS_PATH = "config/sample_points.yaml"
OUT_PATH = "data/samples/point_timeseries.csv"


def load_sample_points(path: str = SAMPLE_POINTS_PATH) -> list[dict]:
    """Load {name, lon, lat, group, note} sample points from YAML, raising SystemExit if missing."""
    yaml_path = Path(path)
    if not yaml_path.exists():
        raise SystemExit(
            f"{path} not found. Create it as a YAML list of sample points, e.g.:\n\n"
            "- {name: Sindhanur_town, lon: 76.7560, lat: 15.7702, group: command, note: \"...\"}\n\n"
            "before running this script."
        )
    loaded = yaml.safe_load(yaml_path.read_text())
    # Accept either a bare list or a dict with a top-level "points" key (as used in this repo).
    points = loaded["points"] if isinstance(loaded, dict) else loaded
    if not isinstance(points, list) or not points:
        raise SystemExit(f"{path} must contain a non-empty list of sample points.")
    return points


def load_aoi_geometry(cfg: dict) -> ee.Geometry:
    """Load the AOI geometry written by scripts/fetch_boundary.py, raising SystemExit if missing."""
    geojson_path = Path(cfg["aoi"]["geojson"])
    if not geojson_path.exists():
        raise SystemExit(f"{geojson_path} not found. Run scripts/fetch_boundary.py first.")
    return ee.Geometry(json.loads(geojson_path.read_text()))


def main() -> None:
    """Sample NDVI and VH composite stacks at configured points and write a tidy long-format CSV."""
    points = load_sample_points()
    cfg = load_config()
    ee_init()

    aoi = load_aoi_geometry(cfg)
    points_fc = ee.FeatureCollection(
        [
            ee.Feature(ee.Geometry.Point([p["lon"], p["lat"]]), {"name": p["name"], "group": p.get("group", "")})
            for p in points
        ]
    )

    scale = cfg["satellite"]["scale_m"]
    s1_band = cfg["satellite"]["s1_band"]

    ndvi_stack = composite_series(s2_ndvi_collection(aoi, cfg), "NDVI", cfg).clip(aoi)
    vh_stack = composite_series(s1_vh_collection(aoi, cfg), s1_band, cfg).clip(aoi)

    ndvi_props = extract_point_series(ndvi_stack, points_fc, scale)
    vh_props = extract_point_series(vh_stack, points_fc, scale)

    ndvi_by_name = {p["name"]: p for p in ndvi_props}
    vh_by_name = {p["name"]: p for p in vh_props}

    labels = period_labels(cfg)
    starts = [period_start for period_start, _ in composite_periods(cfg)]

    rows = []
    for name in ndvi_by_name.keys() | vh_by_name.keys():
        ndvi_rec = ndvi_by_name.get(name, {})
        vh_rec = vh_by_name.get(name, {})
        group = ndvi_rec.get("group") or vh_rec.get("group") or ""
        for label, period_start in zip(labels, starts):
            ndvi_val = ndvi_rec.get(label)
            vh_val = vh_rec.get(label)
            rows.append(
                {
                    "name": name,
                    "group": group,
                    "date": period_start.strftime("%Y-%m-%d"),
                    "ndvi": float("nan") if ndvi_val is None else ndvi_val,
                    "vh": float("nan") if vh_val is None else vh_val,
                }
            )

    df = pd.DataFrame(rows, columns=["name", "group", "date", "ndvi", "vh"])
    df = df.sort_values(["name", "date"]).reset_index(drop=True)

    out_path = Path(OUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_path, index=False)

    print(f"Wrote {out_path} ({len(df)} rows)")


if __name__ == "__main__":
    main()

"""Classify cropping intensity per field polygon (Google ALU boundaries) instead of per pixel.

Per-pixel classification treats every 10 m cell independently, but ALU fields in the
NRBC Distributary-10 boundary set are often only a few pixels (median 764 sq m, ~8
S2 pixels; 40% under 4 pixels). Aggregating the NDVI stack over each field's own
geometry with a pixel-fraction-weighted mean (ee.Reducer.mean() on reduceRegions)
gives one clean time series per field, which is both more interpretable for
field-level QA/validation and avoids fragmenting a single crop cycle across noisy
individual-pixel classifications. The tradeoff is that sub-pixel/few-pixel fields are
inherently less reliable estimates -- so every field gets a reliability tier from its
area, and the final cropping-intensity figure is broken out per tier to show whether
small fields systematically diverge from large ones.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import ee
import numpy as np
import pandas as pd

from cropint.config import load_config, period_labels
from cropint.gee.init import ee_init
from cropint.gee.stacks import composite_series, s2_ndvi_collection
from cropint.timeseries.processing import count_cycles

DEFAULT_GEOJSON = "data/boundaries/1_NRBC_D10.geojson"
DEFAULT_CONFIG = "config/raichur.yaml"
DEFAULT_OUT = "data/fields/nrbc_d10_field_classes.csv"

# Degrees, not meters: ~1 km at this latitude. Only needs to cover the composite
# stack's edge pixels around the outermost fields, not add real margin -- the whole
# point of using the fields' own bbox (instead of the district boundary) is to keep
# the server-side compute small.
AOI_BUFFER_DEG = 0.01

CSV_COLUMNS = [
    "fid",
    "area_sq_m",
    "area_ha",
    "n_pixels_est",
    "reliability",
    "class_confidence",
    "capture_date",
    "class_id",
    "class_label",
    "n_peaks",
    "amplitude",
    "flags",
    "n_valid_periods",
]


def parse_args() -> argparse.Namespace:
    """CLI flags for the field-level classification run."""
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--geojson", default=DEFAULT_GEOJSON, help="Path to ALU field-boundary GeoJSON.")
    p.add_argument("--config", default=DEFAULT_CONFIG, help="Path to pipeline YAML config.")
    p.add_argument("--out", default=DEFAULT_OUT, help="Output CSV path.")
    p.add_argument("--limit", type=int, default=None, help="Only process the first N fields (smoke testing).")
    p.add_argument("--chunk-size", type=int, default=300, help="Fields per reduceRegions() call.")
    return p.parse_args()


def load_features(path: str, limit: int | None) -> list[dict]:
    """Load GeoJSON Features (stdlib json), optionally truncated to the first `limit`."""
    with open(path, "r") as f:
        fc = json.load(f)
    features = fc["features"]
    return features[:limit] if limit else features


def fields_bbox(features: list[dict], buffer_deg: float = AOI_BUFFER_DEG) -> ee.Geometry:
    """Bounding-box AOI (buffered) covering exactly the input fields, not the whole district.

    reduceRegions still only touches each field's own geometry -- this AOI is solely
    for scoping filterBounds/compositing so GEE isn't asked to build a stack over all
    of Raichur when we only need a couple square km around Distributary 10.
    """
    lons: list[float] = []
    lats: list[float] = []
    for feat in features:
        # MultiPolygon coordinates: [ [ [ [lon, lat], ... ] , ...rings ], ...polygons ]
        for polygon in feat["geometry"]["coordinates"]:
            for ring in polygon:
                for lon, lat in ring:
                    lons.append(lon)
                    lats.append(lat)
    min_lon, max_lon = min(lons) - buffer_deg, max(lons) + buffer_deg
    min_lat, max_lat = min(lats) - buffer_deg, max(lats) + buffer_deg
    return ee.Geometry.Rectangle([min_lon, min_lat, max_lon, max_lat])


def reliability_tier(area_sq_m: float, scale_m: int) -> tuple[float, str]:
    """Estimate pixel count from area and bucket into good/marginal/poor reliability."""
    n_px = area_sq_m / (scale_m * scale_m)
    if n_px >= 9:
        return n_px, "good"
    if n_px >= 4:
        return n_px, "marginal"
    return n_px, "poor"


def classify_chunk(stack: ee.Image, chunk_features: list[dict], chunk_fids: list[int], scale_m: int) -> dict[int, dict]:
    """reduceRegions() one chunk of fields against the composite stack; return {fid: properties}.

    Only `fid` is carried server-side (per the task's memory-hygiene note) -- every
    other field attribute (area, capture_date, ...) is joined back client-side from
    the original feature list by index once results return.
    """
    ee_features = [
        ee.Feature(ee.Geometry.MultiPolygon(feat["geometry"]["coordinates"]), {"fid": fid})
        for feat, fid in zip(chunk_features, chunk_fids)
    ]
    chunk_fc = ee.FeatureCollection(ee_features)
    sampled = stack.reduceRegions(collection=chunk_fc, reducer=ee.Reducer.mean(), scale=scale_m)
    result = sampled.getInfo()
    return {f["properties"]["fid"]: f["properties"] for f in result["features"]}


def main() -> None:
    args = parse_args()
    cfg = load_config(args.config)
    ee_init()

    features = load_features(args.geojson, args.limit)
    n_total = len(features)
    labels = period_labels(cfg)
    scale_m = cfg["satellite"]["scale_m"]
    composite_days = cfg["satellite"]["composite_days"]
    classes = cfg["classes"]

    aoi = fields_bbox(features)
    stack = composite_series(s2_ndvi_collection(aoi, cfg), "NDVI", cfg)

    chunk_size = args.chunk_size
    n_chunks = (n_total + chunk_size - 1) // chunk_size
    rows: list[dict] = []
    n_failed_chunks = 0

    for k in range(n_chunks):
        lo, hi = k * chunk_size, min((k + 1) * chunk_size, n_total)
        chunk_features = features[lo:hi]
        chunk_fids = list(range(lo, hi))
        print(f"chunk {k + 1}/{n_chunks} (fields {lo}-{hi - 1}), {lo}/{n_total} done so far", file=sys.stderr)

        try:
            props_by_fid = classify_chunk(stack, chunk_features, chunk_fids, scale_m)
        except Exception as exc:  # noqa: BLE001 -- deliberately broad: one bad chunk must not abort the run
            print(f"chunk {k + 1}/{n_chunks} (fields {lo}-{hi - 1}) FAILED: {exc}", file=sys.stderr)
            n_failed_chunks += 1
            continue

        for fid, feat in zip(chunk_fids, chunk_features):
            props = props_by_fid.get(fid)
            props_attrs = feat["properties"]
            area_sq_m = props_attrs["area_sq_m"]
            n_px, reliability = reliability_tier(area_sq_m, scale_m)

            if props is None:
                # reduceRegions dropped this fid entirely (shouldn't normally happen,
                # but a degenerate/self-intersecting geometry could do it) -- nodata.
                values = np.full(len(labels), np.nan)
            else:
                values = np.array([props.get(label, np.nan) for label in labels], dtype=float)
                values = np.where(values == None, np.nan, values)  # noqa: E711 -- getInfo() nulls come through as None

            n_valid_periods = int(np.sum(~np.isnan(values)))
            result = count_cycles(values, composite_days, cfg)

            rows.append(
                {
                    "fid": fid,
                    "area_sq_m": area_sq_m,
                    "area_ha": area_sq_m / 10000.0,
                    "n_pixels_est": round(n_px, 2),
                    "reliability": reliability,
                    "class_confidence": props_attrs["class_confidence"],
                    "capture_date": props_attrs["capture_date"],
                    "class_id": result["class_id"],
                    "class_label": classes[result["class_id"]],
                    "n_peaks": result["n_peaks"],
                    "amplitude": result["amplitude"],
                    "flags": ";".join(result["flags"]),
                    "n_valid_periods": n_valid_periods,
                }
            )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(rows, columns=CSV_COLUMNS)
    df.to_csv(out_path, index=False)

    print_summary(df, n_total, n_failed_chunks, out_path)


def print_summary(df: pd.DataFrame, n_total: int, n_failed_chunks: int, out_path: Path) -> None:
    """Class counts, area totals, and the area-weighted cropping-intensity headline (overall + per tier)."""
    n_processed = len(df)
    print(f"\nWrote {out_path} ({n_processed} rows)")
    print(f"fields requested: {n_total}, fields written: {n_processed}, failed chunks: {n_failed_chunks}")

    print("\nClass counts and area (ha):")
    by_class = df.groupby(["class_id", "class_label"])["area_ha"].agg(["count", "sum"]).reset_index()
    for _, r in by_class.iterrows():
        print(f"  {int(r['class_id'])} {r['class_label']:<20s} n={int(r['count']):>6d}  area_ha={r['sum']:.2f}")

    def cropping_intensity(sub: pd.DataFrame) -> float | None:
        """Area-weighted % cropping intensity from single/double/triple_plus classes only (1/2/3)."""
        ha = sub.groupby("class_id")["area_ha"].sum()
        numerator = sum(cid * ha.get(cid, 0.0) for cid in (1, 2, 3))
        denominator = sum(ha.get(cid, 0.0) for cid in (1, 2, 3))
        return (numerator / denominator * 100.0) if denominator > 0 else None

    overall = cropping_intensity(df)
    print("\n=== Area-weighted cropping intensity ===")
    print(f"  overall: {overall:.1f}%" if overall is not None else "  overall: n/a (no cropped area)")

    print("\n  by reliability tier (small-field vs large-field divergence check):")
    for tier in ("good", "marginal", "poor"):
        sub = df[df["reliability"] == tier]
        ci = cropping_intensity(sub)
        ci_str = f"{ci:.1f}%" if ci is not None else "n/a"
        print(f"    {tier:<9s} n={len(sub):>6d}  cropping_intensity={ci_str}")


if __name__ == "__main__":
    main()

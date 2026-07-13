"""Orchestrate export -> classify -> outputs for the Raichur cropping-intensity map.

Pipeline (see the approved strategy in the task brief): export the composited NDVI stack
from GEE as a tiled GeoTIFF (cropint.gee.export.export_ndvi_stack), then run the existing
count_cycles per pixel locally (cropint.map.classify_raster.classify_stack). Writes the
class raster (COG), a discrete-color PNG quicklook, and a class-area CSV.

Usage:
    .venv/bin/python scripts/generate_map.py --region-test      # ~10x10 km smoke test
    .venv/bin/python scripts/generate_map.py                    # full Raichur district
    .venv/bin/python scripts/generate_map.py --taluk sindhanur   # optional taluk subset
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import ee
import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import rasterio
from matplotlib.colors import ListedColormap
from rasterio.enums import Resampling

from cropint.config import load_config
from cropint.gee.export import export_ndvi_stack, load_boundary_geometry
from cropint.gee.init import ee_init
from cropint.map.classify_raster import classify_stack, CLASS_NODATA

SINDHANUR_TOWN = (76.7560, 15.7702)  # lon, lat -- Sindhanur command-area test box center

CLASS_COLORS = {
    0: "#d9c8a3",   # fallow / non-crop
    1: "#a6d96a",   # single
    2: "#1a9850",   # double
    3: "#004529",   # triple+
    4: "#762a83",   # long-plateau (sugarcane / plantation flag)
    255: "#f0f0f0",  # nodata
}
CLASS_ORDER = [0, 1, 2, 3, 4, 255]


def sindhanur_test_box(half_km: float = 5.0) -> ee.Geometry:
    """~2*half_km x 2*half_km box centered on Sindhanur town, inside the TLBC command belt."""
    lon, lat = SINDHANUR_TOWN
    dlon = half_km / (111.32 * np.cos(np.radians(lat)))
    dlat = half_km / 110.9
    return ee.Geometry.Rectangle([lon - dlon, lat - dlat, lon + dlon, lat + dlat])


def taluk_geometry(taluk: str, cfg: dict) -> ee.Geometry:
    """Load a taluk-subset AOI from config/taluk_boundaries/<taluk>.geojson, if present.

    No taluk-level boundary source is wired into this project yet (config/raichur.yaml's
    aoi is district-level GAUL only) -- this looks for a hand-supplied geojson so --taluk
    is usable once one exists, rather than silently falling back to the full district.
    """
    slug = taluk.strip().lower().replace(" ", "_")
    path = Path("config/taluk_boundaries") / f"{slug}.geojson"
    if not path.exists():
        raise SystemExit(
            f"--taluk {taluk!r}: no boundary at {path}. Taluk-level boundaries aren't wired "
            f"into this project yet (config/raichur.yaml's aoi is district-level GAUL only). "
            f"Add a geojson Polygon there (e.g. clipped from the district boundary) to use this flag."
        )
    return ee.Geometry(json.loads(path.read_text()))


def make_quicklook(class_tif: Path, out_png: Path, cfg: dict, max_dim: int = 2000) -> None:
    """Discrete-color PNG quicklook of the class raster, downsampled to at most max_dim px per side."""
    class_defs = cfg["classes"]

    with rasterio.open(class_tif) as src:
        factor = max(1, max(src.width, src.height) // max_dim)
        out_shape = (max(1, src.height // factor), max(1, src.width // factor))
        data = src.read(1, out_shape=out_shape, resampling=Resampling.nearest)

    remap = {c: i for i, c in enumerate(CLASS_ORDER)}
    display = np.zeros_like(data, dtype=np.uint8)
    for c, i in remap.items():
        display[data == c] = i

    cmap = ListedColormap([CLASS_COLORS[c] for c in CLASS_ORDER])
    fig, ax = plt.subplots(figsize=(9, 9))
    ax.imshow(display, cmap=cmap, vmin=-0.5, vmax=len(CLASS_ORDER) - 0.5, interpolation="nearest")
    ax.set_axis_off()
    ax.set_title("Raichur cropping intensity -- agri-year 2024-06-01 to 2025-05-31")

    patches = [
        mpatches.Patch(color=CLASS_COLORS[c], label=f"{c}: {class_defs.get(c, 'unknown')}")
        for c in CLASS_ORDER
    ]
    ax.legend(handles=patches, loc="lower left", fontsize=8, framealpha=0.9)

    out_png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=150, bbox_inches="tight")
    plt.close(fig)


def class_area_table(class_tif: Path, cfg: dict, out_csv: Path) -> pd.DataFrame:
    """Per-class pixel counts / area(km^2) / pct-of-total / pct-of-valid(non-nodata), saved to out_csv."""
    class_defs = cfg["classes"]

    with rasterio.open(class_tif) as src:
        pixel_area_km2 = abs(src.transform.a * src.transform.e) / 1e6
        counts = np.zeros(256, dtype=np.int64)
        for _, window in src.block_windows(1):
            block = src.read(1, window=window)
            counts += np.bincount(block.ravel(), minlength=256)[:256]

    total_all = int(counts.sum())
    total_valid = int(counts[:255].sum())  # excludes nodata (255)

    rows = []
    for c in sorted(class_defs):
        pixel_count = int(counts[c])
        rows.append(
            {
                "class": c,
                "label": class_defs[c],
                "pixel_count": pixel_count,
                "area_km2": pixel_count * pixel_area_km2,
                "pct_of_total": 100.0 * pixel_count / total_all if total_all else 0.0,
                "pct_of_valid": (100.0 * pixel_count / total_valid if total_valid and c != CLASS_NODATA else float("nan")),
            }
        )
    df = pd.DataFrame(rows)

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out_csv, index=False)
    return df


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scale", type=int, default=10, help="Export/classification resolution in meters (default 10).")
    parser.add_argument("--region-test", action="store_true", help="Run end-to-end on a small ~10x10 km box near Sindhanur instead of the full district.")
    parser.add_argument("--taluk", default=None, help="Optional taluk name; requires config/taluk_boundaries/<taluk>.geojson.")
    args = parser.parse_args()

    cfg = load_config()
    ee_init()

    if args.region_test:
        region = sindhanur_test_box()
        stack_dir = "data/exports/test_box"
        out_tif = Path("outputs/test_box_intensity.tif")
        out_png = Path("outputs/test_box_intensity.png")
        out_csv = Path("outputs/test_box_class_areas.csv")
        label = "region-test (Sindhanur ~10x10km box)"
    elif args.taluk:
        region = taluk_geometry(args.taluk, cfg)
        slug = args.taluk.strip().lower().replace(" ", "_")
        stack_dir = f"data/exports/{slug}"
        out_tif = Path(f"outputs/{slug}_intensity.tif")
        out_png = Path(f"outputs/{slug}_intensity.png")
        out_csv = Path(f"outputs/{slug}_class_areas.csv")
        label = f"taluk={args.taluk}"
    else:
        region = load_boundary_geometry(cfg)
        stack_dir = "data/exports/raichur_full"
        out_tif = Path("outputs/raichur_intensity_2024_25.tif")
        out_png = Path("outputs/raichur_intensity_2024_25.png")
        out_csv = Path("outputs/raichur_class_areas.csv")
        label = "full Raichur district"

    print(f"[generate_map] target: {label}, scale={args.scale}m")

    t0 = time.time()
    ndvi_tif = export_ndvi_stack(args.scale, stack_dir, region=region, cfg=cfg)
    t1 = time.time()
    size_mb = ndvi_tif.stat().st_size / 1e6
    print(f"[generate_map] export done in {t1 - t0:.1f}s -> {ndvi_tif} ({size_mb:.1f} MB)")

    classify_stack(ndvi_tif, cfg, out_tif)
    t2 = time.time()
    print(f"[generate_map] classification done in {t2 - t1:.1f}s -> {out_tif} ({out_tif.stat().st_size / 1e6:.1f} MB)")

    make_quicklook(out_tif, out_png, cfg)
    print(f"[generate_map] quicklook -> {out_png}")

    df = class_area_table(out_tif, cfg, out_csv)
    print(f"[generate_map] class areas -> {out_csv}")
    print(df.to_string(index=False))

    t3 = time.time()
    print(f"[generate_map] total wall time: {t3 - t0:.1f}s")


if __name__ == "__main__":
    main()

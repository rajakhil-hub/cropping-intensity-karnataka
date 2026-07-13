"""Export the composited NDVI stack from GEE to a local GeoTIFF for local classification.

Downloads via `geemap.download_ee_image` (geedim-backed tiled download) so the full-resolution
composite never needs a single `getInfo()`/`computePixels()` call and skips the Google-Drive
round trip: geedim requests/decompresses tiles concurrently and reassembles them directly into
one destination GeoTIFF.

Bands are quantized to int16 (NDVI * NDVI_SCALE, rounded) with an explicit NODATA_SENTINEL for
masked pixels, rather than exported as float32/float64. This halves on-disk size relative to
float32, which matters here because a full Raichur-bbox x 25-band stack is several GB and local
disk headroom is tight. `cropint.map.classify_raster` dequantizes back to float NDVI before
running the (unmodified) crop-cycle algorithm, so this is purely an I/O-size decision and does
not change any pipeline math.
"""

import json
from pathlib import Path

import ee
import geemap

from cropint.config import load_config
from cropint.gee.stacks import composite_series, s2_ndvi_collection

NDVI_SCALE = 10000
NODATA_SENTINEL = -32768
EXPORT_CRS = "EPSG:32643"  # WGS84 / UTM zone 43N -- covers all of Raichur district
STACK_FILENAME = "raichur_ndvi_stack.tif"


def load_boundary_geometry(cfg: dict) -> ee.Geometry:
    """Load the AOI boundary geometry written by scripts/fetch_boundary.py."""
    geojson_path = Path(cfg["aoi"]["geojson"])
    if not geojson_path.exists():
        raise SystemExit(f"{geojson_path} not found. Run scripts/fetch_boundary.py first.")
    return ee.Geometry(json.loads(geojson_path.read_text()))


def build_ndvi_stack(cfg: dict, region: ee.Geometry) -> ee.Image:
    """Build the per-period NDVI composite (band order = config.period_labels) over region.

    Reuses s2_ndvi_collection + composite_series unchanged; composite_series already names
    each band from period_labels(cfg) in order, so the band order guarantee comes for free
    from that function rather than being re-derived here.
    """
    return composite_series(s2_ndvi_collection(region, cfg), "NDVI", cfg)


def export_ndvi_stack(scale: int, out_dir: str, region: ee.Geometry | None = None, cfg: dict | None = None) -> Path:
    """Download the composited NDVI stack to out_dir/raichur_ndvi_stack.tif and return its path.

    region: optional smaller ee.Geometry (e.g. a test box) instead of the full Raichur boundary.
    cfg: optional pre-loaded config dict; defaults to load_config().

    Band order follows config.period_labels(cfg). Values are int16-quantized (see module
    docstring) with NODATA_SENTINEL marking masked/no-observation pixels.
    """
    cfg = cfg or load_config()
    aoi = region if region is not None else load_boundary_geometry(cfg)

    stack = build_ndvi_stack(cfg, aoi)
    quantized = stack.multiply(NDVI_SCALE).round()  # exact-integer floats; toInt16 cast is lossless

    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)
    out_path = out_dir_path / STACK_FILENAME

    geemap.download_ee_image(
        quantized,
        filename=str(out_path),
        region=aoi,
        scale=scale,
        crs=EXPORT_CRS,
        dtype="int16",
        unmask_value=NODATA_SENTINEL,
        overwrite=True,
    )

    return out_path


__all__ = [
    "NDVI_SCALE",
    "NODATA_SENTINEL",
    "build_ndvi_stack",
    "export_ndvi_stack",
    "load_boundary_geometry",
]

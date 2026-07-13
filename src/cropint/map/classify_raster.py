"""Per-pixel crop-cycle classification of an exported multiband NDVI composite GeoTIFF.

Reuses cropint.timeseries.processing.count_cycles UNCHANGED for the per-pixel peak/plateau
step: find_peaks (and peak_widths) are inherently 1-D, so that stage still loops pixel by
pixel. Everything that can be vectorized runs once per raster block, across every pixel in
the block at once, using cropint.timeseries.processing.gapfill_linear_batch /
smooth_savgol_batch:

  1. dequantize the int16 stack back to float NDVI,
  2. flag all-NaN pixels -> class 255 (nodata) without touching count_cycles,
  3. batch gapfill + batch Savitzky-Golay smoothing -> per-pixel amplitude,
  4. flag amplitude < crop_amplitude_floor -> class 0 (fallow/non-crop) without touching
     count_cycles -- this mirrors count_cycles's own amplitude-floor branch exactly (see
     the correctness check the batch helpers were validated against), so the result is
     byte-identical to what count_cycles would have returned for that pixel,
  5. only the remaining pixels (real seasonal signal) go through the untouched, tested
     count_cycles() per pixel to get the actual peak/plateau-derived class.

Blocks are processed by a multiprocessing pool (one process per block) so a full
~85M-pixel district run stays tractable; the main process writes each block's result into
the output raster serially as results arrive (rasterio datasets are not safely shared for
concurrent writes across processes).
"""

from __future__ import annotations

import multiprocessing as mp
import os
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window

from cropint.gee.export import NDVI_SCALE, NODATA_SENTINEL
from cropint.timeseries.processing import count_cycles, gapfill_linear_batch, smooth_savgol_batch

CLASS_NODATA = 255
DEFAULT_BLOCK_SIZE = 1024


def _dequantize(block: np.ndarray) -> np.ndarray:
    """int16 (NDVI * NDVI_SCALE, NODATA_SENTINEL) -> float32 NDVI with NaN nodata."""
    block = block.astype(np.float32)
    block[block == NODATA_SENTINEL] = np.nan
    return block / NDVI_SCALE


def _classify_columns(values: np.ndarray, cfg: dict, step_days: float) -> np.ndarray:
    """values: (n_bands, n_pixels) float NDVI (NaN = nodata). Returns (n_pixels,) uint8 classes."""
    n_pixels = values.shape[1]
    out = np.full(n_pixels, CLASS_NODATA, dtype=np.uint8)

    all_nan = np.isnan(values).all(axis=0)
    remaining_idx = np.flatnonzero(~all_nan)
    if remaining_idx.size == 0:
        return out

    sub = values[:, remaining_idx]  # guaranteed to have >=1 valid sample per column
    filled = gapfill_linear_batch(sub)  # NaN-free for every column here (see docstring above)
    smoothed = smooth_savgol_batch(filled, cfg)
    amplitude = np.nanmax(smoothed, axis=0) - np.nanmin(smoothed, axis=0)

    floor = cfg["peaks"]["crop_amplitude_floor"]
    below_floor = amplitude < floor
    out[remaining_idx[below_floor]] = 0

    needs_peaks = remaining_idx[~below_floor]
    for local_i, global_i in zip(np.flatnonzero(~below_floor), needs_peaks):
        result = count_cycles(sub[:, local_i], step_days, cfg)
        out[global_i] = result["class_id"]

    return out


def _block_windows(width: int, height: int, block_size: int) -> list[Window]:
    windows = []
    for row_off in range(0, height, block_size):
        h = min(block_size, height - row_off)
        for col_off in range(0, width, block_size):
            w = min(block_size, width - col_off)
            windows.append(Window(col_off, row_off, w, h))
    return windows


def _process_window(args: tuple[str, Window, dict, float]) -> tuple[Window, np.ndarray]:
    """Worker entrypoint (module-level so it is picklable for multiprocessing.Pool)."""
    src_path, window, cfg, step_days = args
    with rasterio.open(src_path) as src:
        block = src.read(window=window)  # (n_bands, h, w)

    n_bands, h, w = block.shape
    values = _dequantize(block).reshape(n_bands, h * w)
    classes = _classify_columns(values, cfg, step_days).reshape(h, w)
    return window, classes


def _finalize_cog(out_tif: Path) -> None:
    """Rewrite out_tif as a COG via rio_cogeo if available; else add overviews to the tiled GeoTIFF in place."""
    try:
        from rio_cogeo.cogeo import cog_translate
        from rio_cogeo.profiles import cog_profiles
    except ImportError:
        with rasterio.open(out_tif, "r+") as dst:
            dst.build_overviews([2, 4, 8, 16, 32], Resampling.nearest)
            dst.update_tags(ns="rio_overview", resampling="nearest")
        return

    tmp_path = out_tif.with_suffix(out_tif.suffix + ".precog.tif")
    os.replace(out_tif, tmp_path)
    try:
        cog_translate(
            str(tmp_path),
            str(out_tif),
            cog_profiles.get("deflate"),
            overview_resampling="nearest",
            in_memory=False,
            quiet=True,
        )
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def classify_stack(
    ndvi_tif: str | Path,
    cfg: dict,
    out_tif: str | Path,
    block_size: int = DEFAULT_BLOCK_SIZE,
    n_workers: int | None = None,
) -> Path:
    """Classify every pixel of ndvi_tif via count_cycles and write a single-band uint8 COG to out_tif.

    CRS/transform are copied from ndvi_tif. Processes the raster in block_size x block_size
    windows (default 1024, ~1e6 pixels/block) across a multiprocessing pool so this is
    tractable at full-district (~85M pixel) scale; see module docstring for what is
    vectorized per block vs. looped per pixel.
    """
    ndvi_tif = Path(ndvi_tif)
    out_tif = Path(out_tif)
    out_tif.parent.mkdir(parents=True, exist_ok=True)

    step_days = cfg["satellite"]["composite_days"]
    n_workers = n_workers or max(1, min(mp.cpu_count() - 1, 6))

    with rasterio.open(ndvi_tif) as src:
        profile = src.profile.copy()
        windows = _block_windows(src.width, src.height, block_size)

    out_profile = profile.copy()
    out_profile.update(
        driver="GTiff",
        count=1,
        dtype="uint8",
        nodata=CLASS_NODATA,
        compress="deflate",
        predictor=2,
        tiled=True,
        blockxsize=256,
        blockysize=256,
        bigtiff="IF_SAFER",
    )
    out_profile.pop("photometric", None)

    tasks = [(str(ndvi_tif), window, cfg, step_days) for window in windows]

    with rasterio.open(out_tif, "w", **out_profile) as dst:
        if n_workers > 1 and len(tasks) > 1:
            with mp.Pool(n_workers) as pool:
                for window, classes in pool.imap_unordered(_process_window, tasks):
                    dst.write(classes, 1, window=window)
        else:
            for task in tasks:
                window, classes = _process_window(task)
                dst.write(classes, 1, window=window)

    _finalize_cog(out_tif)
    return out_tif


__all__ = ["classify_stack", "CLASS_NODATA", "DEFAULT_BLOCK_SIZE"]

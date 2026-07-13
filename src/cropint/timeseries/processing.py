"""NDVI time-series gap-filling, smoothing, and crop-cycle counting (pure numpy/scipy, no GEE)."""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks, peak_widths, savgol_filter


def gapfill_linear(values: np.ndarray) -> np.ndarray:
    """Linearly interpolate NaN gaps, holding first/last valid values flat at the edges."""
    values = np.asarray(values, dtype=float)
    out = values.copy()
    valid = ~np.isnan(out)
    if not valid.any():
        return out
    idx = np.arange(out.size)
    out[~valid] = np.interp(idx[~valid], idx[valid], out[valid])
    return out


def smooth_savgol(values: np.ndarray, cfg: dict) -> np.ndarray:
    """Apply Savitzky-Golay smoothing, clamping the window to fit short series."""
    values = np.asarray(values, dtype=float)
    window = cfg["timeseries"]["savgol_window"]
    polyorder = cfg["timeseries"]["savgol_polyorder"]

    if window > values.size:
        window = values.size if values.size % 2 == 1 else values.size - 1
    if window <= polyorder:
        return values
    return savgol_filter(values, window_length=window, polyorder=polyorder)


def _longest_run(mask: np.ndarray) -> int:
    """Length of the longest contiguous run of True values in mask."""
    longest = 0
    current = 0
    for flag in mask:
        current = current + 1 if flag else 0
        longest = max(longest, current)
    return longest


def _step_days(dates_or_step_days, n: int) -> float:
    """Resolve days-per-sample from a scalar or a sequence of datetime-like values."""
    if isinstance(dates_or_step_days, (int, float)):
        return float(dates_or_step_days)
    dates = np.asarray(dates_or_step_days)
    diffs = np.diff(dates)
    # works for datetime64/timedelta64 and python datetime/timedelta objects
    diffs_days = np.array([d / np.timedelta64(1, "D") if isinstance(d, np.timedelta64) else d.days for d in diffs], dtype=float)
    return float(np.median(diffs_days))


def count_cycles(values: np.ndarray, dates_or_step_days, cfg: dict) -> dict:
    """Gap-fill, smooth, then detect crop cycles via peak prominence/width and a long-plateau override.

    Peaks are filtered by width (rel_height=0.7) rather than height/prominence alone,
    because narrow cloud-artifact bumps can clear those bars but aren't real-duration
    crop cycles. A long high-NDVI plateau (sugarcane/plantation signature) overrides
    the peak-count-derived class regardless of how many local peaks find_peaks() sees
    inside the plateau's noise.
    """
    values = np.asarray(values, dtype=float)
    step_days = _step_days(dates_or_step_days, values.size)

    if np.isnan(values).all():
        return {"n_peaks": 0, "class_id": 255, "flags": ["nodata"], "amplitude": float("nan")}

    filled = gapfill_linear(values)
    smoothed = smooth_savgol(filled, cfg)

    amplitude = float(np.nanmax(smoothed) - np.nanmin(smoothed))
    peaks_cfg = cfg["peaks"]

    if amplitude < peaks_cfg["crop_amplitude_floor"]:
        return {"n_peaks": 0, "class_id": 0, "flags": [], "amplitude": amplitude}

    distance_steps = max(1, round(peaks_cfg["min_distance_days"] / step_days))
    peaks, _properties = find_peaks(
        smoothed,
        prominence=peaks_cfg["min_prominence"],
        height=peaks_cfg["min_peak_ndvi"],
        distance=distance_steps,
    )

    if peaks.size:
        widths_steps, *_ = peak_widths(smoothed, peaks, rel_height=0.7)
        width_days = widths_steps * step_days
        peaks = peaks[width_days >= peaks_cfg["min_cycle_days"]]

    # Plateau must be both relatively high within the series AND absolutely green:
    # a flat low-NDVI (bare/built-up) pixel trivially clears the relative bar alone.
    plateau_threshold = max(
        np.nanmin(smoothed) + 0.4 * amplitude,
        peaks_cfg["plateau_min_ndvi"],
    )
    longest_run_steps = _longest_run(smoothed >= plateau_threshold)

    n_peaks = int(peaks.size)
    if longest_run_steps * step_days > peaks_cfg["plateau_flag_days"]:
        return {"n_peaks": n_peaks, "class_id": 4, "flags": ["long_plateau"], "amplitude": amplitude}

    return {"n_peaks": n_peaks, "class_id": min(n_peaks, 3), "flags": [], "amplitude": amplitude}

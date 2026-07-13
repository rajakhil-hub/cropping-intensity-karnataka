"""Unit tests for cropint.timeseries.processing.count_cycles branching logic."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np

from cropint.config import composite_periods, load_config
from cropint.timeseries.processing import count_cycles

cfg = load_config()
N = len(composite_periods(cfg))
STEP_DAYS = cfg["satellite"]["composite_days"]


def _gaussian_bumps(
    n: int,
    centers_steps: list[float],
    sigma_steps: float,
    baseline: float,
    height: float,
) -> np.ndarray:
    """Synthesize an NDVI-like curve as a baseline plus a sum of gaussian bumps."""
    t = np.arange(n)
    curve = np.full(n, baseline, dtype=float)
    for c in centers_steps:
        curve += height * np.exp(-((t - c) ** 2) / (2 * sigma_steps**2))
    return curve


def test_flat_curve_is_class_zero() -> None:
    """A flat, low NDVI curve has no seasonal amplitude and is classed as fallow/non-crop."""
    curve = np.full(N, 0.12)
    result = count_cycles(curve, STEP_DAYS, cfg)
    assert result["amplitude"] < cfg["peaks"]["crop_amplitude_floor"]
    assert result["n_peaks"] == 0
    assert result["class_id"] == 0


def test_single_bump_is_class_one() -> None:
    """One well-separated gaussian bump clearing the height/prominence/width bars is a single crop cycle."""
    curve = _gaussian_bumps(N, centers_steps=[12], sigma_steps=2.0, baseline=0.15, height=0.45)
    result = count_cycles(curve, STEP_DAYS, cfg)
    assert result["n_peaks"] == 1
    assert result["class_id"] == 1


def test_two_bumps_is_class_two() -> None:
    """Two bumps spaced well beyond min_distance_days are counted as a double-crop cycle."""
    curve = _gaussian_bumps(N, centers_steps=[7, 17], sigma_steps=2.0, baseline=0.15, height=0.45)
    result = count_cycles(curve, STEP_DAYS, cfg)
    assert result["n_peaks"] == 2
    assert result["class_id"] == 2


def test_three_bumps_is_class_three() -> None:
    """Three bumps spaced well beyond min_distance_days are counted as a triple-plus crop cycle."""
    # Centers 8 steps apart (120 days) comfortably clear min_distance_days (75 days / 5 steps)
    # while all three fit inside the N=25-step agri-year grid.
    curve = _gaussian_bumps(N, centers_steps=[4, 12, 20], sigma_steps=2.0, baseline=0.15, height=0.45)
    result = count_cycles(curve, STEP_DAYS, cfg)
    assert result["n_peaks"] >= 3
    assert result["class_id"] == 3


def test_all_nan_is_nodata() -> None:
    """A fully-masked (all-NaN) series is nodata, not fallow."""
    curve = np.full(N, np.nan)
    result = count_cycles(curve, STEP_DAYS, cfg)
    assert result["class_id"] == 255
    assert "nodata" in result["flags"]


def test_year_long_plateau_flags_class_four() -> None:
    """A long contiguous high-NDVI stretch (sugarcane/plantation signature) overrides the peak count and flags class 4."""
    # Realistic sugarcane: sustained high NDVI (~0.75) for most of the year. Must clear
    # both the relative bar and the absolute plateau_min_ndvi floor after smoothing.
    curve = np.full(N, 0.2)
    curve[2:23] = 0.75  # 21 steps * 15 days/step = 315 days > plateau_flag_days (270)
    result = count_cycles(curve, STEP_DAYS, cfg)
    assert "long_plateau" in result["flags"]
    assert result["class_id"] == 4

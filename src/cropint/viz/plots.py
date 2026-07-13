"""Diagnostic plots for point NDVI/VH time series and cycle-count results."""

import math
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy.signal import find_peaks

from cropint.timeseries.processing import gapfill_linear, smooth_savgol, count_cycles


def _smoothed_and_result(df_one_point: pd.DataFrame, cfg: dict) -> tuple[pd.Series, np.ndarray, np.ndarray, dict]:
    """Parse dates and compute smoothed NDVI + count_cycles result for one point."""
    dates = pd.to_datetime(df_one_point["date"])
    ndvi_raw = df_one_point["ndvi"].to_numpy(dtype=float)
    smoothed = smooth_savgol(gapfill_linear(ndvi_raw), cfg)
    result = count_cycles(ndvi_raw, dates, cfg)
    return dates, ndvi_raw, smoothed, result


def _peak_indices(smoothed: np.ndarray, cfg: dict) -> np.ndarray:
    """Re-derive peak indices on the smoothed series using cfg["peaks"] thresholds, mirroring count_cycles."""
    peaks_cfg = cfg["peaks"]
    composite_days = cfg["satellite"]["composite_days"]
    distance_steps = max(1, round(peaks_cfg["min_distance_days"] / composite_days))
    idx, _ = find_peaks(
        smoothed,
        prominence=peaks_cfg["min_prominence"],
        height=peaks_cfg["min_peak_ndvi"],
        distance=distance_steps,
    )
    return idx


def plot_point_series(df_one_point: pd.DataFrame, cfg: dict, out_png: str) -> None:
    """Plot raw/smoothed NDVI with detected peaks and VH on a secondary axis for one point, saved to out_png."""
    name = df_one_point["name"].iloc[0]
    dates, ndvi_raw, smoothed, result = _smoothed_and_result(df_one_point, cfg)
    peak_idx = _peak_indices(smoothed, cfg)

    class_id = result["class_id"]
    class_label = cfg["classes"].get(class_id, "unknown")
    title = f"{name} — class {class_id} ({class_label})"
    if result["flags"]:
        title += f" [{', '.join(result['flags'])}]"

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.scatter(dates, ndvi_raw, s=15, color="tab:gray", label="Raw NDVI")
    ax.plot(dates, smoothed, color="tab:green", label="Smoothed NDVI")
    ax.scatter(
        dates.to_numpy()[peak_idx],
        smoothed[peak_idx],
        marker="^",
        s=80,
        color="tab:red",
        zorder=5,
        label="Peaks",
    )
    ax.set_xlabel("Date")
    ax.set_ylabel("NDVI")

    ax2 = ax.twinx()
    ax2.plot(dates, df_one_point["vh"].to_numpy(dtype=float), color="tab:blue", alpha=0.6, label="VH (dB)")
    ax2.set_ylabel("VH (dB)")

    handles1, labels1 = ax.get_legend_handles_labels()
    handles2, labels2 = ax2.get_legend_handles_labels()
    ax.legend(handles1 + handles2, labels1 + labels2, loc="upper right")

    ax.set_title(title)
    fig.autofmt_xdate()

    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_png, dpi=150, bbox_inches="tight")
    plt.close(fig)


def plot_group_grid(df: pd.DataFrame, cfg: dict, out_dir: str) -> None:
    """Save a per-point PNG for every point in df, plus one combined inspection grid PNG."""
    names = df["name"].unique()

    for name in names:
        point_df = df[df["name"] == name].sort_values("date")
        plot_point_series(point_df, cfg, f"{out_dir}/{name}.png")

    n_points = len(names)
    ncols = math.ceil(math.sqrt(n_points))
    nrows = math.ceil(n_points / ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(4 * ncols, 3 * nrows), squeeze=False)
    flat_axes = axes.flatten()

    for ax, name in zip(flat_axes, names):
        point_df = df[df["name"] == name].sort_values("date")
        dates, ndvi_raw, smoothed, result = _smoothed_and_result(point_df, cfg)
        ax.scatter(dates, ndvi_raw, s=8, color="tab:gray")
        ax.plot(dates, smoothed, color="tab:green")
        ax.set_title(f"{name} (class {result['class_id']})", fontsize=9)
        ax.tick_params(axis="x", labelrotation=45, labelsize=6)
        ax.tick_params(axis="y", labelsize=6)

    for ax in flat_axes[n_points:]:
        ax.axis("off")

    fig.tight_layout()
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    fig.savefig(f"{out_dir}/inspection_grid.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

# Cropping-Intensity Mapping — Raichur Pilot

Satellite-based classification of crop cycles per pixel over one agricultural year (2024-06-01 to 2025-05-31) across Raichur district, Karnataka. Phase-1 classical baseline using Sentinel-2 NDVI peak-counting and Sentinel-1 VH gap-fill, outputting class maps (0: fallow, 1: single, 2: double, 3: triple+, 4: long-plateau/sugarcane flag, 255: nodata) via Google Earth Engine and local numpy signal processing.

## Setup

**Python**: 3.12 in a `.venv/` (uv-managed). Always run `.venv/bin/python`, never system python3.

```bash
uv pip install -r requirements.txt
earthengine authenticate
# GEE cloud project ID is pre-configured in config/ee_project.txt
```

## Pipeline & Usage

Run in order (each script reads the prior's outputs):

```bash
# 1. Fetch district boundary from FAO GAUL (writes config/raichur_boundary.geojson)
.venv/bin/python scripts/fetch_boundary.py

# 2. Extract NDVI + VH composites at ~20 sample points (writes data/samples/point_timeseries.csv)
.venv/bin/python scripts/extract_points.py

# 3. Generate per-point inspection plots (writes data/samples/*.png + grid)
.venv/bin/python scripts/plot_inspection.py

# 4. Classify full district map (or use flags for fast testing)
.venv/bin/python scripts/generate_map.py --region-test      # ~10x10 km Sindhanur smoke test
.venv/bin/python scripts/generate_map.py                     # Full Raichur (20–40 min)
.venv/bin/python scripts/generate_map.py --scale 20          # Lower resolution (faster)
```

**Outputs:**
- `data/samples/` — point time series CSV, per-point NDVI/VH plots
- `outputs/` — COG intensity GeoTIFF, discrete-color PNG quicklook, per-class area CSV

## Repo Layout

```
src/cropint/
├── config.py               # Load raichur.yaml, compute composite periods
├── gee/
│   ├── init.py            # ee.Authenticate wrapper
│   ├── stacks.py          # S2 NDVI & S1 VH collections + 15-day composites
│   └── export.py          # Export NDVI stack to tiled GeoTIFF
├── timeseries/
│   └── processing.py      # Savitzky–Golay smoothing, find_peaks logic
├── map/
│   └── classify_raster.py # Pixel-by-pixel cycle counting (count_cycles)
└── viz/
    └── plots.py           # NDVI/VH time-series plots per point

scripts/
├── fetch_boundary.py      # Download district boundary
├── extract_points.py      # Sample stacks at hand-picked locations
├── plot_inspection.py     # Diagnostic plots
└── generate_map.py        # End-to-end export → classify → outputs

config/
├── raichur.yaml          # All thresholds & satellite parameters (never hardcode)
├── sample_points.yaml    # ~20 NDVI-inspection point locations
└── ee_project.txt        # GEE project ID

data/, outputs/           # Gitignored; holds composites, exports, results
```

## Method

1. **CloudScore+ masking**: Filter Sentinel-2 pixels by cloud-shadow likelihood (cs_cdf ≥ 0.60).
2. **15-day composites**: Median-reduce S2 NDVI and S1 VH every 15 days over the agri-year.
3. **Monsoon gap-fill**: Use S1 VH to interpolate missing S2 during heavy rainfall.
4. **Smoothing**: Savitzky–Goyal (window=7 composites ≈105 days, polyorder=2).
5. **Peak-counting**: `scipy.signal.find_peaks` with prominence (≥0.20), min NDVI floor (≥0.35), cycle separation (≥75 days), min cycle duration (≥60 days).
6. **Plateaus & flags**: Pixels green >270 days with NDVI >0.50 → class 4 (sugarcane/plantation), not class 3.

All thresholds in `config/raichur.yaml`; no magic numbers in code.

## Status & Next

**Phase 1 complete**: Classical baseline (peak-counting) over Raichur, ready for analyst QA against sample-point inspection plots.

**Phase 2–3 (future)**: SAM2 field boundaries, Prithvi/Clay foundation-model embeddings, multi-state scaling.

**Pending external**: Digital Crop Survey parcel labels for ground-truth (manager-side dependency, Week-1 priority).

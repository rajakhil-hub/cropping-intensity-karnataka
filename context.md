# WELL Labs — Cropping Intensity Mapping using Satellite Data (Karnataka, India)
### Project Context & Handoff Document

---

## 0. How to use this document

This is a self-contained brief for the "cropping intensity" project at WELL Labs. If you are an AI assistant or a developer picking this up cold, read sections 1–4 to understand *what* and *why*, then jump to **Section 13 (Immediate Next Steps)** for the concrete first task. Section 14 lists the questions that must be resolved with the project manager before some phases can proceed — treat those as blocking dependencies, not afterthoughts.

Anything stated here about WELL Labs' internal data, field presence, or existing tooling is a **working assumption to be confirmed with the manager**, not established fact. Do not build irreversible decisions on unconfirmed assumptions.

---

## 1. Objective

Build a pipeline that uses satellite imagery to estimate **cropping intensity** across agricultural land in **Karnataka, India** — i.e., for a given farm plot (or pixel), how many crop cycles the farmer grew in one agricultural year.

**Output classes:** `0` (fallow / non-crop), `1` (single crop), `2` (double crop), `3+` (triple or more).

**Output format:** 10 m resolution raster map of cropping-intensity class, plus field-level polygon aggregates where field boundaries are available.

**Agricultural year:** June 1 – May 31.

**Target years (proposed):** 2024–25 and 2025–26 (both complete; Sentinel-1C operational through most of this window gives good SAR revisit over India).

---

## 2. Background: what "cropping intensity" actually is

Cropping intensity is defined by the number of annual crop cycles on a plot, conventionally classified as single, double, or triple cropping. In India this maps onto three growing seasons:

- **Kharif** — monsoon season, sown Jun–Jul, harvested Oct–Nov.
- **Rabi** — winter season, sown Oct–Nov, harvested Feb–Mar.
- **Zaid / Summer** — sown Jan–Feb, harvested Apr–May (mostly in irrigated areas).

**The core signal:** every crop cycle produces a characteristic vegetation curve — green-up → peak → senescence/harvest — visible in vegetation indices such as **NDVI** derived from satellite imagery. Counting the number of distinct green-up/peak/harvest cycles in the vegetation-index time series over one agricultural year gives the cropping intensity.

Two established algorithmic families exist:
1. **Peak counting** — smooth the NDVI time series, detect peaks with amplitude and duration thresholds, count them.
2. **Phenophase detection** — identify complete crop growth cycles using thresholds (e.g., transitions at ~50% of NDVI amplitude) and build a binary crop/no-crop temporal profile.

Either works as a classical baseline. Foundation models (below) are the "learned" alternative that this project also explores.

---

## 3. Reference resources (given by the manager) and their role

Three resources were provided. Here is what each is and *why it matters to this project*:

### 3.1 IBM–NASA Prithvi — https://huggingface.co/ibm-nasa-geospatial
A family of geospatial **foundation models** trained on NASA's Harmonized Landsat and Sentinel-2 (HLS) data. Latest is **Prithvi-EO-2.0** (available in 300M and 600M parameter sizes). Critically, IBM/NASA have already released a **multi-temporal crop-classification** fine-tuned model *and* dataset — this is the closest existing template to our task. Prithvi natively ingests *multi-temporal* image stacks (multiple dates), which is exactly what cycle-counting requires. Fine-tuning is done via **IBM TerraTorch**.
→ **Role:** primary candidate backbone / fine-tuning target for a learned intensity classifier.

### 3.2 Clay Foundation Model — https://clay-foundation.github.io/model/
An open-source **foundation model** that takes satellite imagery plus location and time as input and outputs **embeddings** (mathematical representations of a place at a time). Vision-Transformer architecture, trained via self-supervised masked-autoencoder learning. Can be fine-tuned for classification, regression, and change detection (crop type, land cover, etc.). More sensor-flexible than Prithvi and includes native Sentinel-2 (10 m) support — relevant for India's small fields.
→ **Role:** alternative backbone. Extract per-chip, per-timestep embeddings and train a lightweight temporal head on the embedding sequence.

### 3.3 Meta SAM2 — https://github.com/facebookresearch/sam2
Meta's promptable **segmentation** foundation model for images and video. Requires python≥3.10, torch≥2.5.1. The `segment-geospatial` / `samgeo` package wraps it for GeoTIFFs.
→ **Role:** **field / parcel boundary delineation.** Segment individual farm plots so pixel-level time series can be aggregated into clean per-field signals, letting us report results per farmer plot rather than per noisy pixel.

### 3.4 Implied architecture
Putting the three together, the intended system is:

> **SAM2 → field boundaries** · **Sentinel time series → temporal signal** · **Prithvi / Clay → learned intensity classifier** · benchmarked against a **classical NDVI peak-counting baseline**.

---

## 4. System architecture

```
                    ┌─────────────────────────────┐
                    │  Sentinel-2 L2A (10m optical)│
   Data ingest ──►  │  Sentinel-1 GRD (SAR)        │
   (GEE / STAC)     │  HLS (30m, for Prithvi)      │
                    └──────────────┬──────────────┘
                                   │ cloud-mask, composite, index
                                   ▼
                    ┌─────────────────────────────┐
                    │  NDVI / index time-series    │
                    │  (per pixel, per agri-year)  │
                    └──────┬───────────────┬───────┘
                           │               │
         classical path    │               │   learned path
                           ▼               ▼
             ┌──────────────────┐   ┌──────────────────────────┐
             │ Smooth (Sav-Gol) │   │ Prithvi (TerraTorch f/t)  │
             │ + peak detection │   │   OR                      │
             │ = BASELINE       │   │ Clay embeddings + head    │
             └────────┬─────────┘   └────────────┬─────────────┘
                      │                           │
                      └──────────┬────────────────┘
                                 ▼
                    ┌─────────────────────────────┐
   SAM2 boundaries►│  Aggregate to field polygons │
                    │  → cropping-intensity map    │
                    └─────────────────────────────┘
                                 ▼
                    Accuracy assessment vs ground truth
                    + district-stat validation (GCA/NSA)
```

**Guiding principle:** build the classical baseline *first*. It teaches the data, provides a benchmark the foundation models must beat, and can generate weak labels at scale.

---

## 5. Geographic scope & phasing (Karnataka)

Karnataka is ideal because it contains nearly every Indian farming system (irrigated command areas, rainfed drylands, sugarcane belts, evergreen plantations, cloudy coast) **and** has among the best parcel-level ground truth in India (see Section 8). Do not process the whole state at once (~1.9 lakh km², 31 districts). Tier it:

### Tier 1 — Baseline (weeks 1–4)
**Raichur.** A natural laboratory: the Tungabhadra Left Bank Command area gives irrigated paddy–paddy double/triple cropping, while the non-command uplands in the *same* district are classic rainfed single-crop kharif. Both extremes in one district — perfect for tuning the peak detector.
*(Assumption to confirm: WELL Labs may already have field programs in Raichur, which would provide validation teams.)*

### Tier 2 — Model training (weeks 5–9)
Add one or two contrasting districts:
- **Kalaburagi or Vijayapura** — rainfed black-soil systems where farmers sow **rabi-only** crops (chickpea, jowar) on residual moisture. Breaks the naive "kharif-first" assumption.
- **Mandya** — Cauvery command: paddy + sugarcane. Stress-tests sugarcane confusion handling.

### Tier 3 — Scale (weeks 10–12)
Full state. Handle **coastal** districts (Udupi, Dakshina Kannada) and **Malnad plantation belts** (Kodagu, Chikkamagaluru, Hassan) last — heaviest cloud cover and evergreen canopies.

---

## 6. Karnataka crop calendar → peak-detection windows

| Season | Sowing | Harvest | Typical crops |
|---|---|---|---|
| Kharif | Jun–Jul | Oct–Nov | Paddy, tur (pigeon pea), cotton, maize, groundnut |
| Rabi | Oct–Nov | Feb–Mar | Jowar (sorghum), chickpea, wheat, rabi paddy |
| Summer | Jan–Feb | Apr–May | Paddy (command areas), groundnut |

A plot's class = number of distinct growth cycles detected anywhere in the June–May window. **Cycle counting must not assume kharif presence** — northern rabi-on-residual-moisture fields show a single peak in *winter*.

---

## 7. Data sources

### Satellite imagery
- **Sentinel-2 L2A** (10 m, ~5-day revisit) — primary optical source. Harmonized collection available in Google Earth Engine.
- **Sentinel-1 GRD (SAR)** — **non-negotiable for India.** Kharif is buried under monsoon cloud; radar sees through it. Use VH backscatter to fill optical gaps.
- **HLS** (30 m) — only if fine-tuning Prithvi in its native domain.

### Labels / validation (see Section 8 for detail)
- Karnataka **Digital Crop Survey** / Bhoomi RTC records (primary, if accessible).
- **KSRSAC** LULC products.
- **Karnataka DES** district-level season-wise crop-area statistics (for aggregate validation).
- WELL Labs' own field data.
- ISRO/NRSC **Bhuvan** LULC (has kharif/rabi/double-crop classes) as a national fallback.

### Boundaries
- District boundaries: FAO GAUL level-2 (in GEE) or DataMeet India shapefiles.
- Field/parcel boundaries: check for existing India datasets first; otherwise derive with SAM2/samgeo.

---

## 8. Ground truth — the critical dependency (READ THIS)

**Ground truth is the single biggest bottleneck and the highest-priority external dependency.** Everything downstream depends on it.

Karnataka runs one of India's most mature **Digital Crop Survey** programs: season-wise, parcel-level, geotagged crop records tied to **Bhoomi** RTC land records. If WELL Labs can obtain even one or two seasons for the pilot districts, that is tens of thousands of labeled parcels — a major advantage over doing this work anywhere else in India.

**Action:** requesting this data is **Week-1 priority #1**, because government data access can take weeks. Do not wait until the modeling phase to start this conversation.

**Aggregate validation:** Karnataka DES publishes district season-wise crop areas. Validate predictions by checking predicted Gross Cropped Area ÷ Net Sown Area against official district cropping-intensity figures.

---

## 9. Tech stack

**Data access & prototyping**
- `earthengine-api` + `geemap` — fastest route to the baseline; likely aligns with WELL Labs' existing GEE-based tooling *(confirm)*.
- Pure-Python alternative: `pystac-client` + `stackstac` / `odc-stac` + Microsoft Planetary Computer.

**Geospatial**
- `rasterio`, `rioxarray`, `xarray`, `geopandas`, `shapely`, GDAL.
- QGIS for visual QA.

**Time-series processing**
- `scipy.signal.find_peaks`, Savitzky–Golay smoothing, linear interpolation for gap-filling.

**Deep learning**
- PyTorch + PyTorch Lightning.
- **TerraTorch** — official Prithvi fine-tuning toolkit.
- Clay repo: `pip install git+https://github.com/Clay-foundation/model.git`
- **SAM2** (python≥3.10, torch≥2.5.1) via `samgeo`.

**Ops**
- Experiment tracking: Weights & Biases or MLflow.
- Storage: Cloud-Optimized GeoTIFFs (COGs) + Zarr.
- Compute: GEE for the free heavy pixel crunching (research use); one A100/L4 GPU (Colab Pro / Kaggle / cloud VM) suffices for Prithvi-300M or Clay with a frozen encoder + small head.

---

## 10. Methodology — phases

**Phase 0 — Framing (with manager).** Lock geography, agri-year definition, output classes, output format, and what ground truth WELL Labs already has.

**Phase 1 — Classical baseline.** In GEE: cloud-mask Sentinel-2 (CloudScore+), build per-pixel NDVI stacks for the agri-year, fuse Sentinel-1 VH to fill monsoon gaps, smooth, detect peaks with amplitude + duration thresholds, count cycles. Validate visually in QGIS against high-res basemaps. **This is the first real deliverable.**

**Phase 2 — Field boundaries.** Check for existing India field-boundary datasets; where absent, run SAM2/samgeo on peak-season imagery. Aggregate the pixel time series to field level to clean up smallholder noise.

**Phase 3 — Foundation models (two parallel experiments).**
- (a) Fine-tune **Prithvi-EO-2.0** via TerraTorch for multi-temporal semantic segmentation with the intensity classes (adapt the released crop-classification example).
- (b) Extract **Clay** embeddings per chip per timestep; train a lightweight temporal head (LSTM / small transformer / XGBoost) on the embedding sequences.
- Train on ground truth + baseline-derived weak labels. Evaluate both against the Phase-1 baseline on a held-out region.

**Phase 4 — Scale & validate.** Run the winning model over the full target area, mosaic, and run a formal accuracy assessment: stratified-random-sample confusion matrix + comparison of district aggregates against official DES cropping-intensity statistics.

**Phase 5 — Package.** Reproducible pipeline (GitHub repo), COG outputs, a simple leafmap/Streamlit viewer, methods write-up.

---

## 11. Timeline (12 weeks)

| Weeks | Milestone |
|---|---|
| 1 | Run the 3 resources hands-on (Clay quickstart, Prithvi crop-classification demo, SAM2 notebook). Finalize scope with manager. **Start Digital Crop Survey data request.** |
| 2–3 | GEE data pipeline for **Raichur**: S2 cloud masking, NDVI stacks, S1 fusion, smoothing. |
| 4 | Baseline peak-counting classifier + first cropping-intensity map. Visual QA. **Checkpoint demo to manager.** |
| 5 | Field boundaries (existing datasets or SAM2); field-level aggregation; assemble/clean ground-truth labels. |
| 6–7 | Prithvi fine-tuning via TerraTorch (chip generation, training runs). |
| 8 | Clay embedding pipeline + temporal head; head-to-head evaluation baseline vs Prithvi vs Clay. |
| 9 | Error analysis (plantation vs double-crop, fallow vs single, cloud artifacts); iterate on best model. |
| 10 | Scale inference to full target geography; mosaic outputs. |
| 11 | Formal accuracy assessment + district-statistics comparison. |
| 12 | Documentation, repo cleanup, dashboard, final presentation. |

*8-week variant:* keep only Prithvi (the multi-temporal crop template already exists), drop Clay, and restrict Phase 4 to the pilot districts.

---

## 12. Karnataka-specific watchouts

- **Monsoon clouds** destroy the kharif optical signal — Sentinel-1 fusion is mandatory, doubly so on the coast.
- **Sugarcane** (Belagavi, Bagalkot, Mandya) is a 12–18 month crop: one long green plateau, with ratoon flushes that a naive counter misreads. Treat as its own class from day one.
- **Plantations** (coffee, arecanut, coconut in Malnad/coast) are permanently green — mask via LULC or classify out; never let them count as "triple crop."
- **Rabi-on-residual-moisture** in the north shows a single *winter* peak with no kharif — logic must count cycles anywhere in the agri-year.
- **Smallholder plots** are often 0.1–1 ha, so 30 m HLS pixels (Prithvi's native domain) mix multiple fields; expect domain-shift work when fine-tuning on 10 m Sentinel-2, and lean on field-level aggregation.

---

## 13. Immediate next steps (start here)

1. **Environment:** set up the Python geospatial + GEE stack (Section 9). Authenticate `earthengine-api`.
2. **Boundaries:** load Karnataka district boundaries into GEE, clip to **Raichur**.
3. **First data pull:** build the Sentinel-2 CloudScore+-masked NDVI stack for Raichur, **June 2024 – May 2025**.
4. **Look before you code:** hand-inspect NDVI time-series plots for ~20 known locations — command-area paddy (along the Tungabhadra canals) vs. rainfed upland. Seeing the real curves first prevents a dozen wrong assumptions before writing peak-detection logic.
5. **In parallel (manager):** (a) initiate Digital Crop Survey / Bhoomi data access, (b) confirm which districts WELL Labs has field presence in — the answer may reorder the Tier-2 district picks.

**First code artifact to produce:** a GEE starter script for the Raichur NDVI stack + a time-series inspector for chosen sample points.

---

## 14. Open questions / decisions pending (blocking dependencies)

- [ ] Does WELL Labs already use Google Earth Engine as its primary platform? (Affects whether the pipeline should be GEE-first or pure-Python STAC.)
- [ ] Can WELL Labs obtain Karnataka Digital Crop Survey / Bhoomi parcel-level crop records for the pilot districts? Which seasons/years?
- [ ] Which districts does WELL Labs have active field presence in? (May reorder Tier-2 picks.)
- [ ] Confirm target agricultural years (proposed: 2024–25, 2025–26).
- [ ] Confirm final output class scheme (0 / 1 / 2 / 3+) and whether plantations/sugarcane get dedicated classes.
- [ ] Required output deliverable format for WELL Labs' downstream use (raster only, or raster + field polygons + dashboard?).
- [ ] Available compute for fine-tuning (Colab Pro / Kaggle / dedicated cloud GPU?).

---

## 15. Definition of done / deliverables

- Reproducible pipeline in a GitHub repo (data ingest → baseline → model → map).
- Cropping-intensity maps (10 m COGs) for the target geography.
- Field-level polygon aggregates where boundaries exist.
- Accuracy assessment report (confusion matrix + district-statistics comparison).
- A simple interactive viewer (leafmap / Streamlit).
- Methods write-up documenting approach, assumptions, and limitations.

---

*Document owner: [your name]. Last updated: 2026-07-13. All internal-data and field-presence statements are working assumptions pending manager confirmation.*

# Cropping-Intensity Mapping — Karnataka (WELL Labs)

Satellite-based cropping-intensity classification: count crop cycles per pixel/field over one agricultural year. Full brief: `context.md` (read only when a domain question isn't answered here).

## Project constants
- Classes: 0 fallow/non-crop · 1 single · 2 double · 3 triple+ · 255 nodata.
- Current AOI: Raichur district (Tier 1). Agri-year: **2024-06-01 → 2025-05-31**.
- Data: Sentinel-2 `COPERNICUS/S2_SR_HARMONIZED` NDVI @10 m, masked with CloudScore+ (`GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED`, band `cs_cdf`); Sentinel-1 `COPERNICUS/S1_GRD` IW VH for monsoon gaps; 15-day composites.
- Baseline: gap-fill → Savitzky–Golay → `scipy.signal.find_peaks` (prominence + duration) → cycle count. Thresholds live in `config/raichur.yaml`, never hardcoded.
- Domain watchouts: cycles can occur anywhere Jun–May (rabi-only fields have a single *winter* peak — no kharif-first assumption); sugarcane = 12–18-month plateau, flag separately; evergreen plantations must never count as multi-crop.

## Environment
- Python: `.venv/` in repo root (Python 3.12, uv). Always `.venv/bin/python`; system python3 (3.14) is off-limits.
- GEE: authenticated user account. Heavy pixel math server-side in GEE; peak counting locally in numpy.
- Layout: `src/cropint/{gee,timeseries,viz}` · `scripts/` entrypoints · `config/` params · `data/`, `outputs/` gitignored.

## Model routing & subagents (token policy)
Do not run everything on the main-loop model. Delegate:

| Task | Route to |
|---|---|
| Writing/editing pipeline code | `geo-coder` (sonnet) |
| Running scripts/installs, reading long logs, debug loops | `runner-debugger` (sonnet) |
| Web/GEE-catalog fact-finding, coordinates, dataset IDs | `geo-researcher` (sonnet) |
| READMEs, docstrings, boilerplate configs | `docs-scribe` (haiku) |
| Architecture decisions, algorithm design/threshold tuning judgment, reviewing agent output, user checkpoints | main loop only |

Token hygiene:
- Never read whole notebooks, rasters, or long logs into the main context — delegate to `runner-debugger` and consume its summary.
- Subagent prompts must be self-contained (constants above are baked into each agent's definition); expect structured summaries back, not dumps.
- Big artifacts go to `data/`/`outputs/`/scratchpad, not into chat.
- Parallelize independent agent tasks in a single message.

## Open dependencies (manager-side, do not block on these)
- Karnataka Digital Crop Survey / Bhoomi parcel labels — access request pending (Week-1 priority per brief).
- Confirmation of WELL Labs field-presence districts (may reorder Tier-2 picks: Kalaburagi/Vijayapura, Mandya).

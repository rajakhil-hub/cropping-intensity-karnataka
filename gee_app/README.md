# Raichur Cropping-Intensity Field Inspector (GEE App)

A Google Earth Engine Code Editor JavaScript app for WELL Labs field teams to
inspect the Raichur district cropping-intensity classification (agri-year
2024-06-01 to 2025-05-31). Click any point on the map to see its classified
value (fallow / single / double / triple+ / long-plateau / nodata), plus
Sentinel-2 NDVI and Sentinel-1 VH 15-day-composite time series charts for
that pixel.

## How to open it (v1)
This is plain Earth Engine Code Editor JS — no build step, no npm/node. Copy
the full contents of `raichur_intensity_inspector.js`, paste it into a new
script at https://code.earthengine.google.com/, and click **Run**. The GEE
Code Editor cannot load `.js` files directly from disk; this repo copy is
just the version-controlled source to paste from.

## How to publish as a shareable app
Once it runs cleanly in the Code Editor: **Apps** (top-right) -> **Publish
new App** -> select this script. This gives a standalone URL that field
teams can open directly, without a GEE account or the code editor.

## Asset dependency
The script expects a classified uint8 asset at
`projects/my-project-13544-490022/assets/raichur_intensity_2024_25`
(0=fallow, 1=single, 2=double, 3=triple+, 4=long-plateau flag, 255=nodata).
If that asset is not yet ingested, the classified layer will fail to draw.

---

## v2: Karnataka-wide Inspector with Live Classification

`karnataka_intensity_inspector_v2.js` extends to anywhere in Karnataka with
live Sentinel-2 NDVI classification (no pre-computed asset required outside
Raichur). It adds:

- **State/district navigation**: dropdown selectors (currently Karnataka only)
  that zoom and outline the chosen district.
- **Lat/lon Go box**: enter coordinates, press Go to zoom and auto-inspect
  that point.
- **Dual classification modes**: inside Raichur district reads the pre-validated
  classified asset ("from validated map"); elsewhere in Karnataka builds the
  25-period NDVI series on the fly and classifies it via JavaScript port of the
  Python `count_cycles` algorithm ("computed live - same algorithm as validated
  map").
- **Source labels** in the results panel identify whether the value came from
  the validated asset or was computed live.

All parameters (agri-year dates, 15-day compositing, thresholds) are mirrored
from `config/raichur.yaml`, so live results are directly comparable to Raichur.

### How to run v2

1. Go to https://code.earthengine.google.com/
2. Create or open a script.
3. Copy the entire contents of `karnataka_intensity_inspector_v2.js` and paste
   it into the editor.
4. Click **Run**.

### Publishing v2 as a shareable app

Once it runs cleanly: **Apps** (top-right) -> **Publish new App** -> point it at
this script. Produces a standalone URL for field teams (no code editor, no GEE
account required).

### Validation: count_cycles JS port parity

The v2 app embeds a JavaScript port of the Python `count_cycles` classification
algorithm (`gee_app/lib/count_cycles.js`). To verify the port matches the Python
pipeline across 26 real + synthetic fixtures:

```bash
.venv/bin/python scripts/generate_count_cycles_fixtures.py
node --test gee_app/test/
```

**What green means:**
- `count_cycles.test.js`: JS port classifies 26 fixtures (synthetic + real point
  timeseries from `data/samples/point_timeseries.csv`) identically to the Python
  pipeline on class, peak count, and amplitude.
- `sync_check.test.js`: the embedded `count_cycles` block in `v2.js` (between
  BEGIN/END markers) is byte-identical to `gee_app/lib/count_cycles.js`
  (anti-drift gate).

### Editing the count_cycles algorithm

If you update `gee_app/lib/count_cycles.js`, you must re-paste the identical
block into `karnataka_intensity_inspector_v2.js` between these markers:

```
// >>> BEGIN count_cycles JS port (source: gee_app/lib/count_cycles.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>
// ... JS code here ...
// <<< END count_cycles JS port <<<
```

The test `gee_app/test/sync_check.test.js` will catch drift and tell you if
the blocks are out of sync.

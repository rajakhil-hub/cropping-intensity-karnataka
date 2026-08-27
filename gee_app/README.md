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

The v2 (and v3) app embeds a JavaScript port of the Python `count_cycles`
classification algorithm (`gee_app/lib/count_cycles.js`). To verify the port
matches the Python pipeline across 26 real + synthetic fixtures:

```bash
.venv/bin/python scripts/generate_count_cycles_fixtures.py
node --test gee_app/test/count_cycles.test.js gee_app/test/sync_check.test.js
```

(The directory form `node --test gee_app/test/` breaks when the repo path
contains a space, which this one does -- always pass the explicit file list
above.)

**What green means:**
- `count_cycles.test.js`: JS port classifies 26 fixtures (synthetic + real point
  timeseries from `data/samples/point_timeseries.csv`) identically to the Python
  pipeline on class, peak count, and amplitude.
- `sync_check.test.js`: the embedded `count_cycles` block in both `v2.js` and
  `v3.js` (between BEGIN/END markers) is byte-identical to
  `gee_app/lib/count_cycles.js` (anti-drift gate, one subtest per app file).

### Editing the count_cycles algorithm

If you update `gee_app/lib/count_cycles.js`, you must re-paste the identical
block into **both** `karnataka_intensity_inspector_v2.js` and
`karnataka_intensity_inspector_v3.js` between these markers:

```
// >>> BEGIN count_cycles JS port (source: gee_app/lib/count_cycles.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>
// ... JS code here ...
// <<< END count_cycles JS port <<<
```

The test `gee_app/test/sync_check.test.js` will catch drift and tell you if
any of the blocks are out of sync.

---

## v3: Agricultural-Year Selector + Monthly Field Photos

`karnataka_intensity_inspector_v3.js` extends v2 with a year dropdown and a
12-monthly field-photo strip. Everything else (state/district navigation,
Go-to-coordinates, click-to-inspect, NDVI/VH charts) works the same as v2.

- **Agricultural year dropdown**: choose **2024-25** or **2025-26**. Changing
  it reruns every collection builder (NDVI, VH, extraction image, photos) for
  the selected year's date range, and -- if a point has already been
  inspected -- automatically re-inspects that same point under the new year.
- **Validated-vs-live routing, per year**: the pre-classified Raichur asset is
  only used for **2024-25** clicks inside Raichur district. Every other
  combination (any point in 2025-26, or any point outside Raichur in either
  year) is classified live in-browser with the same `count_cycles` port used
  by v2. This is driven by a single `validatedAssetEligible` flag per year
  config, so asset-routing and layer-visibility can never disagree.
- **Intensity-layer visibility, per year**: the validated
  "Cropping Intensity 2024-25 (Raichur, validated)" map layer auto-hides
  itself when a year without an eligible asset (currently 2025-26) is
  selected, and a red note appears under the legend explaining why.
- **12-month field-photo strip**: for the currently inspected point, a small
  grid of Sentinel-2 true-color (B4/B3/B2) thumbnails, one per calendar month
  of the selected agri-year (Jun through May), sourced from a ~200 m box
  around the point (independent of the ~200 m NDVI/VH extraction region).
  Each cell renders the **clearest single Sentinel-2 scene** over that box
  for the month (ranked by mean CloudScore+ `cs_cdf` over the box) when one
  clears `PHOTO_CLEAR_THRESHOLD`; a single scene is sharper than a median
  because it isn't blending pixels from different dates. Cloudy months, where
  no scene is clear enough, fall back to a same-month median composite and
  are marked **"(composite)"** in grey under the thumbnail. Thumbnails render
  at 256 px (longest side) and full-size links at 768 px (both up from
  100x100/512), using bicubic resampling and a projected CRS (`EPSG:3857`)
  instead of nearest-neighbour on raw lat/lon -- this fixes blockiness and
  the east-west stretch you'd otherwise get from treating geographic pixels
  as square. Each thumbnail's label starts as the plain month name and is
  replaced with the scene's real capture date (`d MMM yyyy`) once a single
  batched Earth Engine round-trip resolves for all 12 months. A matching
  "open full size" link loads asynchronously below each thumbnail via
  `getThumbURL` and can take a few seconds to appear. Those full-size links
  are time-limited Earth Engine thumbnail URLs -- they are not meant to be
  saved or shared long-term, just for a closer look during the same session.
  Months with no usable Sentinel-2 pixels (cloud-obscured or no coverage)
  show a blank/black thumbnail rather than silently omitting the month --
  the calendar is honest about what has and hasn't got imagery.
  **Resolution ceiling**: Sentinel-2 is native 10 m, so these changes fix
  blockiness, framing, and lat/lon distortion, but cannot manufacture detail
  finer than a 10 m pixel -- there is no free sub-10 m imagery source over
  India in the GEE catalog, and Planet NICFI's free tropical-basemap access
  (which was sub-5 m) has ended and is not reachable on this account.

### How to run v3

1. Go to https://code.earthengine.google.com/
2. Create or open a script.
3. Copy the entire contents of `karnataka_intensity_inspector_v3.js` and
   paste it into the editor.
4. Click **Run**.

### Publishing v3 as a shareable app

Once it runs cleanly: **Apps** (top-right) -> **Publish new App** -> point it
at this script. Produces a standalone URL for field teams (no code editor, no
GEE account required).

### Draw-an-area cropping-intensity analysis

v3 also adds an area-level estimate alongside the per-field click inspection
above:

- Click **Draw area** (top-left panel) to arm the map's drawing tool (a
  rectangle by default; the on-map drawing toolbar this reveals also lets you
  switch to the polygon tool). Draw the shape and release the mouse to run
  the analysis; **Clear area** removes the drawn shape and its result.
- **Why sampling, not a wall-to-wall count**: the per-pixel classifier used
  for map clicks/the validated asset runs client-side in the browser and
  isn't something a whole drawn area can be run through directly, and
  re-implementing `count_cycles` server-side in GEE would risk diverging from
  the validated map. Instead, the app draws `AREA_SAMPLE_N` (default 500)
  random points inside the drawn area, pulls the full 25-period NDVI series
  for every point in one batched Earth Engine call, and classifies each point
  client-side with the exact same `countCycles` port used everywhere else in
  this app. This was measured end-to-end against live GEE on a 2,486 ha
  command-area block: N=200 took ~7 s, N=500 took ~6 s, with cropping
  intensity estimates of 194.2% and 193.4% respectively (stable) and
  consistent per-class tallies.
- The results panel (above the per-field results) shows, in order: the
  headline **cropping intensity** --
  `(1*ha_single + 2*ha_double + 3*ha_triple) / (ha_single + ha_double + ha_triple) x 100`
  -- the drawn area size, then a per-class row (color swatch, label,
  hectares, % of valid samples) using the same colors as the map legend.
  Nodata (cloud-obscured/masked) sample points are counted and shown
  separately and are never folded into the class percentages or the
  intensity calculation.
- The panel states the sample size actually used and the resulting margin of
  error (`1.96 * sqrt(0.25 / n) * 100`, e.g. "500 samples, +/-4.4% at 95%
  confidence") and explicitly notes that this is a **statistical estimate
  from sampled points, not a wall-to-wall pixel count**.
- Areas larger than `AREA_MAX_HA` (1,000,000 ha) are refused with a message to
  draw a smaller one -- a guard against runaway compute, checked before the
  sampling call runs. Above `AREA_SLOW_HA` (100,000 ha) the status line warns
  that the run takes about a minute. District-sized draws are supported: whole
  Raichur (~846,500 ha) completes in ~56 s.
- **Accuracy of the sampling method**: over all of Raichur it returned 128.6%
  cropping intensity against 128.5% from the 7-hour wall-to-wall raster
  classification -- agreement to 0.1 percentage points, roughly 450x faster.
  It also separates the extremes cleanly: a canal-command block reads ~194%
  (mostly double-cropped) and a rainfed block ~101% (93.6% single-cropped).
- **Per-field click inspection is unchanged** and remains the recommended way
  to spot-check one specific field's classification against an area's
  estimate.

### Water use (area scale only)

Under the class table, each drawn area also reports evapotranspiration from
MODIS `MOD16A2GF` (463 m, 8-day, gap-filled), loaded in its own round trip so
it never delays the cropping-intensity answer.

- **Actual ET (mm)** for the agricultural year, averaged over the drawn area.
- **ET/PET ratio** -- water actually used against atmospheric demand. This is
  the more comparable number across areas and seasons, and reads as an
  irrigation index. Measured for 2024-25: canal-command block 0.36 (ET 760 mm),
  rainfed block 0.24 (ET 567 mm), whole Raichur 0.27 (ET 599 mm).
- **Monthly water-use chart**, which acts as an independent cross-check on the
  NDVI-derived classification: over the command block it peaks in Sep-Oct
  (kharif) and again in Feb-Mar (rabi), reproducing the double-cropping cycle
  from a completely separate physical measurement.
- MODIS ET is 463 m -- one pixel covers ~20 ha, so it **cannot resolve a single
  field**. It is labelled area-scale context in the UI and is deliberately never
  shown in the per-field panel. Field-scale canopy signals (NDVI, and the
  SL2P LAI in `src/cropint/gee/biophysical.py`) stay at 10 m.

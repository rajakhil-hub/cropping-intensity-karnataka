/**
 * WELL Labs — Karnataka Cropping-Intensity Inspector (v3)
 * ========================================================
 *
 * WHAT THIS IS
 * ------------
 * A Google Earth Engine (GEE) Code Editor JavaScript app for field teams to
 * inspect cropping-intensity anywhere in Karnataka, not just Raichur:
 *   - State dropdown (Karnataka only for now) -> District dropdown (zooms +
 *     outlines the chosen district; the basemap's own place labels are used
 *     for navigation, there is no separate places dataset),
 *   - a "Go to coordinates" lat/lon box that zooms the map and immediately
 *     inspects that point,
 *   - click any point on the map to inspect that field:
 *       * inside Raichur district -> reads the pixel value from the
 *         validated, pre-classified Raichur asset ("from validated map"),
 *       * elsewhere in Karnataka -> builds the 25-period NDVI series for
 *         that point on the fly and classifies it in the browser with an
 *         exact JS port of the project's Python `count_cycles` algorithm
 *         ("computed live - same algorithm as validated map"),
 *       * outside Karnataka -> shows a message, no computation is run.
 *   - a Sentinel-2 NDVI 15-day-composite time series chart for that point,
 *   - a Sentinel-1 VH (radar) 15-day-composite time series chart.
 *
 * This mirrors the AOI, dates, thresholds, and 15-day compositing scheme used
 * in the project's Python pipeline (see config/raichur.yaml), so the NDVI/VH
 * curves and class here are directly comparable to what produced the
 * validated Raichur map.
 *
 * WHAT'S NEW IN v3
 * -----------------
 *   - Agricultural-year dropdown (2024-25 / 2025-26) that reruns every
 *     builder for the selected year -- no more hardcoded AGRI_START/AGRI_END.
 *   - Per-year validated-vs-live routing: only 2024-25 Raichur clicks read
 *     the pre-classified asset; every other year/place combination is
 *     classified live in-browser with the same count_cycles port.
 *   - Per-year intensity-layer visibility: the validated 2024-25 map layer
 *     auto-hides itself when a year without an eligible asset is selected.
 *   - A 12-monthly-photo strip (Jun-May) per inspected point: small Sentinel-2
 *     true-color thumbnails plus async "open full size" links.
 *
 * v1 (`gee_app/raichur_intensity_inspector.js`, Raichur-only, asset-only) and
 * v2 (`gee_app/karnataka_intensity_inspector_v2.js`, Karnataka-wide, single
 * fixed year) are kept untouched in the repo for rollback -- this is a new,
 * separate script.
 *
 * HOW TO RUN
 * ----------
 * This is plain Earth Engine Code Editor JavaScript -- there is no build
 * step, no npm/node, no import statements. To run it:
 *   1. Go to https://code.earthengine.google.com/
 *   2. Open (or create) a new script.
 *   3. Copy the entire contents of this file and paste it into the editor.
 *   4. Click "Run".
 * The GEE Code Editor cannot load .js files directly from disk -- this file
 * lives in the repo purely as a version-controlled copy to paste from.
 *
 * PUBLISHING AS A SHAREABLE APP
 * ------------------------------
 * Once it runs correctly in the Code Editor, use the "Apps" button in the
 * top-right of the editor -> "Publish new App" -> point it at this script.
 * That produces a standalone URL (no code editor, no GEE account needed by
 * the viewer) that can be shared with field teams for click-to-inspect use.
 *
 * NOTE ON THE CLASSIFIED ASSET
 * -----------------------------
 * This script references the classified asset id below. That asset may still
 * be ingesting/exporting at the time this script is written -- the id is not
 * verified here, it is only referenced as a constant.
 *
 * PRE-FLIGHT (manual, do once before relying on the state/district dropdown)
 * ----------------------------------------------------------------------------
 * Verify in the Code Editor console that FAO/GAUL/2015/level1 actually has a
 * feature with ADM1_NAME == 'Karnataka' (spelling/casing can drift between
 * GAUL releases) before trusting STATE_CONFIGS below.
 */

// ----------------------------------------------------------------------
// CONSTANTS (mirrors config/raichur.yaml -- do not hardcode values below
// anywhere else in this script; change them here only).
// ----------------------------------------------------------------------
var COMPOSITE_DAYS = 15;
var N_PERIODS = 25; // 375 days / 15-day steps ~= full agri-year coverage
var CS_THRESHOLD = 0.60;

// Per-year configs. validatedAssetEligible governs BOTH asset-read routing
// (inspectPoint) AND intensity-layer visibility (applyYearSelection) -- one
// flag so the two can't disagree with each other.
// Note: 2025-26 S2/CloudScore+ coverage is complete as of Aug 2026; Sentinel-1C
// has been operational since May 2025 so 2025-26 VH is richer than a
// mid-year read would have been.
var YEAR_CONFIGS = [
  {key: '2024-25', label: '2024-25', agriStart: '2024-06-01', agriEnd: '2025-05-31', validatedAssetEligible: true},
  {key: '2025-26', label: '2025-26', agriStart: '2025-06-01', agriEnd: '2026-05-31', validatedAssetEligible: false}
];
var currentYearCfg = YEAR_CONFIGS[0];
var lastClickedPoint = null; // {lon, lat}
var INTENSITY_LAYER_NAME = 'Cropping Intensity 2024-25 (Raichur, validated)';
// Photo-strip rendering params (display only -- the NDVI/VH extraction path
// never touches these). Measured cause of the original blockiness: S2 is
// native 10 m, so the old 300 m box (150 m half-side) was only ~30x30 real
// pixels, nearest-neighbour-upsampled to 512 px. Fixes: a tighter box
// (closer framing on the field), bigger renders + bicubic resample (softens
// the upsampling blockiness instead of showing hard 10 m squares), and a
// projected CRS (plain lat/lon pixels stretch east-west away from the
// equator, so the box would otherwise render as a non-square rectangle).
var PHOTO_BOX_HALF_SIDE_M = 100; // 200 m box (was 300 m) -- tighter frame on the clicked field
var PHOTO_THUMB_DIMENSIONS = 256; // bare number = longest-side px, keeps the box square (was '100x100')
var PHOTO_FULL_DIMENSIONS = 768; // was 512
var PHOTO_CRS = 'EPSG:3857'; // projected (metres) so the box renders square, not lat-stretched
var PHOTO_CLEAR_THRESHOLD = 0.5; // min mean CloudScore+ (cs_cdf) over the box to trust one scene over a month median
var PHOTO_RESAMPLE = 'bicubic'; // smooths nearest-neighbour blockiness when upsampling 10 m pixels to the render size
// Fallback stretch, used only when the adaptive one below cannot be measured
// (e.g. the whole box is cloud-masked all year).
var PHOTO_VIS = {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000, gamma: 1.2};
// Adaptive contrast stretch. Measured over real Raichur fields, surface
// reflectance in a cropland box spans roughly 275-890, so the fixed 0-3000
// stretch above used under a fifth of the available range and rendered every
// month as dark mush -- contrast, not resolution, was the dominant cause of
// the "blurry" look. Percentiles are taken ONCE over the whole agri-year (not
// per month) so the twelve frames stay comparable to each other: a per-month
// stretch would make a bare fallow field look as vivid as a standing crop and
// destroy the very seasonal story the strip exists to show.
var PHOTO_STRETCH_PCT = [2, 98];
var PHOTO_STRETCH_GAMMA = 1.0; // the 1.2 above was compensating for the bad range
var MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

var S2_COLLECTION_ID = 'COPERNICUS/S2_SR_HARMONIZED';
var CLOUDSCORE_COLLECTION_ID = 'GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED';
var CLOUDSCORE_BAND = 'cs_cdf';
var S1_COLLECTION_ID = 'COPERNICUS/S1_GRD';
var S1_BAND = 'VH';
var SCALE_M = 10;

// Classified asset (uint8). May still be ingesting at time of writing --
// referenced only, not loaded/verified here.
var CLASSIFIED_ASSET_ID = 'projects/my-project-13544-490022/assets/raichur_intensity_2024_25';

// Class legend: value -> {color, label}
var CLASS_INFO = [
  {value: 0, color: '#d9c29a', label: 'Fallow / non-crop'},
  {value: 1, color: '#a6d96a', label: 'Single crop (1 cycle)'},
  {value: 2, color: '#1a9850', label: 'Double crop (2 cycles)'},
  {value: 3, color: '#004529', label: 'Triple+ crop (3+ cycles)'},
  {value: 4, color: '#7b3294', label: 'Long plateau (sugarcane/plantation?)'}
];
var PALETTE = CLASS_INFO.map(function(c) { return c.color; });

// Click-time human-readable text per class value, keyed by string so it can
// be looked up directly from a (possibly null) reduceRegion result.
var CLASS_TEXT = {
  '0': 'Fallow / non-crop',
  '1': 'Single crop (1 cycle detected)',
  '2': 'Double crop (2 cycles detected)',
  '3': 'Triple+ crop (3+ cycles detected)',
  '4': 'Long green plateau — likely sugarcane or plantation'
};
var NODATA_TEXT = 'No data (cloud-obscured or masked)';

// Peak-detection thresholds -- mirrors config/raichur.yaml `peaks:` block
// exactly. Used by the embedded countCycles() JS port for live (non-Raichur)
// classification.
var PEAKS_CFG = {
  min_prominence: 0.20,
  min_peak_ndvi: 0.35,
  min_cycle_days: 60,
  min_distance_days: 75,
  crop_amplitude_floor: 0.15,
  plateau_flag_days: 270,
  plateau_min_ndvi: 0.50
};

var BUFFER_RADIUS_M = 100; // small point buffer used as the "region" for live extraction/classification
var GO_ZOOM = 16; // map zoom level after "Go to coordinates"

// Draw-an-area sampled cropping-intensity estimate (see analyzeArea() below
// and gee_app/README.md). Random-point sampling + the same client-side
// countCycles() used for per-field clicks, validated end-to-end against
// live GEE on a 2,486 ha command-area block: N=200 -> 7s, N=500 -> 6s,
// cropping intensity 194.2% vs 193.4% (stable), consistent class tallies.
var AREA_SAMPLE_N = 500;        // ~+/-4.4% margin at 95% confidence; ~6s round trip
var AREA_SAMPLE_SEED = 42;      // fixed so repeat runs of the same area agree
// Measured: a whole district (Raichur, ~846,500 ha) completes in ~56 s, and its
// sampled cropping intensity came back 128.6% against 128.5% from the 7-hour
// wall-to-wall raster classification -- so district-sized draws are supported.
// The cap exists only to stop runaway draws, not to stop districts.
var AREA_MAX_HA = 1000000;
var AREA_SLOW_HA = 100000;      // above this, warn the user it takes ~a minute
var AREA_LAYER_NAME = 'drawn area';

// Water use (MODIS MOD16A2GF, 463 m, 8-day, gap-filled). Deliberately area-only:
// one pixel covers ~20 ha, so this can never be a per-field number. Reported as
// actual ET, and as ET/PET -- water actually used against atmospheric demand,
// which is comparable across areas and seasons and reads as an irrigation index.
// Measured over the 2024-25 agri-year: command-area block ET 760 mm / ET/PET
// 0.36, rainfed block ET 567 mm / ET/PET 0.24.
var ET_COLLECTION_ID = 'MODIS/061/MOD16A2GF';
var ET_SCALE_M = 463;
var ET_UNIT_SCALE = 0.1;        // MOD16A2 ET/PET are stored as 0.1 mm

// State configs: one entry per state this app supports. Only Karnataka is
// wired up today; add more entries here (each with its own GAUL ADM1 name
// and map-center/zoom) to extend to other states later.
var STATE_CONFIGS = [
  {name: 'Karnataka', gaulAdm1: 'Karnataka', center: {lon: 76.5, lat: 15.3, zoom: 7}}
];

var SOURCE_VALIDATED = 'from validated map';
var SOURCE_LIVE = 'computed live - same algorithm as validated map';

// Build the "Class: ..." label text, tagging on whether the value came from
// the validated Raichur asset or was computed live in-browser.
function formatClassLabel(classValue, sourceTag) {
  var classText;
  if (classValue === null || classValue === undefined) {
    classText = NODATA_TEXT;
  } else {
    classText = CLASS_TEXT[String(classValue)] || NODATA_TEXT;
  }
  return classText + ' (' + sourceTag + ')';
}

// ----------------------------------------------------------------------
// >>> BEGIN count_cycles JS port (source: gee_app/lib/count_cycles.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>
/**
 * count_cycles.js
 * ================
 * Canonical JS port of `src/cropint/timeseries/processing.py` `count_cycles`
 * (gap-fill -> Savitzky-Golay smooth -> prominence/width-filtered peak count
 * -> long-plateau override). Validated against the Python implementation by
 * the fixture-based parity tests in `gee_app/test/count_cycles.test.js`
 * (see `scripts/generate_count_cycles_fixtures.py` for how the fixtures are
 * generated from the real Python `count_cycles`).
 *
 * This file must never be hand-copied elsewhere. The ONE sanctioned copy of
 * this content lives embedded, byte-identical, between the
 * "// >>> BEGIN count_cycles JS port ... >>>" / "// <<< END ... <<<" markers
 * in `gee_app/karnataka_intensity_inspector_v2.js`. Anti-drift is enforced by
 * `gee_app/test/sync_check.test.js`. If you need to change the algorithm,
 * change it here first, then re-paste the whole file (including this header)
 * into the marked block in the v2 app.
 */

function isMissing(v) {
  return v === null || v === undefined || (typeof v === "number" && isNaN(v));
}

function gapfillLinear(values) {
  var n = values.length;
  var out = values.slice();
  for (var j = 0; j < n; j++) {
    if (!isMissing(out[j])) continue;
    var prev = -1, next = -1;
    for (var a = j - 1; a >= 0; a--) { if (!isMissing(values[a])) { prev = a; break; } }
    for (var b = j + 1; b < n; b++) { if (!isMissing(values[b])) { next = b; break; } }
    if (prev === -1 && next === -1) { /* unreachable: caller checks all-missing first */ }
    else if (prev === -1) { out[j] = values[next]; }
    else if (next === -1) { out[j] = values[prev]; }
    else {
      var w = (j - prev) / (next - prev);
      out[j] = values[prev] + w * (values[next] - values[prev]);
    }
  }
  return out;
}

var SAVGOL_INTERIOR = [-2 / 21, 3 / 21, 6 / 21, 7 / 21, 6 / 21, 3 / 21, -2 / 21];
var SAVGOL_EDGE = [
  [16 / 21, 5 / 14, 1 / 14, -2 / 21, -1 / 7, -1 / 14, 5 / 42],
  [5 / 14, 2 / 7, 3 / 14, 1 / 7, 1 / 14, 0, -1 / 14],
  [1 / 14, 3 / 14, 2 / 7, 2 / 7, 3 / 14, 1 / 14, -1 / 7],
  [-1 / 7, 1 / 14, 3 / 14, 2 / 7, 2 / 7, 3 / 14, 1 / 14],
  [-1 / 14, 0, 1 / 14, 1 / 7, 3 / 14, 2 / 7, 5 / 14],
  [5 / 42, -1 / 14, -1 / 7, -2 / 21, 1 / 14, 5 / 14, 16 / 21]
];

function savgol7(x) {
  var n = x.length;
  if (n < 7) return x.slice();
  var y = new Array(n);
  for (var i = 3; i <= n - 4; i++) {
    // Sum symmetric tap pairs (SAVGOL_INTERIOR[k] === SAVGOL_INTERIOR[6-k]) together
    // before accumulating, rather than a plain left-to-right dot product. This keeps
    // the result bit-identical for mirror-symmetric windows (IEEE754 addition is
    // commutative but not associative, so a naive forward sum gives a 1-ULP-different
    // result depending on which side of a symmetric plateau the window sits on).
    var s = SAVGOL_INTERIOR[3] * x[i];
    for (var k = 0; k < 3; k++) s += SAVGOL_INTERIOR[k] * (x[i - 3 + k] + x[i + 3 - k]);
    y[i] = s;
  }
  for (var p = 0; p < 3; p++) {
    var sL = 0;
    for (var kL = 0; kL < 7; kL++) sL += SAVGOL_EDGE[p][kL] * x[kL];
    y[p] = sL;
  }
  for (var q = 0; q < 3; q++) {
    var sR = 0;
    for (var kR = 0; kR < 7; kR++) sR += SAVGOL_EDGE[3 + q][kR] * x[n - 7 + kR];
    y[n - 3 + q] = sR;
  }
  return y;
}

function localMaxima(x) {
  var n = x.length, mids = [], i = 1, iMax = n - 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      var iAhead = i + 1;
      while (iAhead < iMax && x[iAhead] === x[i]) iAhead++;
      if (x[iAhead] < x[i]) {
        mids.push(i + Math.floor((iAhead - 1 - i) / 2));
      }
      i = iAhead;
    } else {
      i++;
    }
  }
  return mids;
}

function peakProminence(x, peakIdx) {
  var n = x.length, peakVal = x[peakIdx];
  var leftMin = peakVal, leftBase = peakIdx;
  for (var i = peakIdx - 1; i >= 0; i--) {
    if (x[i] > peakVal) break;
    if (x[i] < leftMin) { leftMin = x[i]; leftBase = i; }
  }
  var rightMin = peakVal, rightBase = peakIdx;
  for (var j = peakIdx + 1; j < n; j++) {
    if (x[j] > peakVal) break;
    if (x[j] < rightMin) { rightMin = x[j]; rightBase = j; }
  }
  return { prominence: peakVal - Math.max(leftMin, rightMin), leftBase: leftBase, rightBase: rightBase };
}

function selectByDistance(peakIdxArr, heightsArr, distanceSteps) {
  var n = peakIdxArr.length;
  var order = peakIdxArr.map(function (_, idx) { return idx; });
  order.sort(function (a, b) {
    if (heightsArr[a] !== heightsArr[b]) return heightsArr[a] - heightsArr[b];
    return a - b;
  });
  var keep = [];
  for (var z = 0; z < n; z++) keep.push(true);
  for (var idx = n - 1; idx >= 0; idx--) {
    var j = order[idx];
    if (!keep[j]) continue;
    var k = j - 1;
    while (k >= 0 && (peakIdxArr[j] - peakIdxArr[k]) < distanceSteps) { keep[k] = false; k--; }
    k = j + 1;
    while (k < n && (peakIdxArr[k] - peakIdxArr[j]) < distanceSteps) { keep[k] = false; k++; }
  }
  return peakIdxArr.filter(function (_, idx) { return keep[idx]; });
}

function peakWidthSteps(x, peakIdx, leftBase, rightBase, prominence, relHeight) {
  var evalHeight = x[peakIdx] - relHeight * prominence;
  var i = peakIdx;
  while (i > leftBase && x[i] > evalHeight) i--;
  var leftIp = i;
  if (x[i] < evalHeight) leftIp = i + (evalHeight - x[i]) / (x[i + 1] - x[i]);
  i = peakIdx;
  while (i < rightBase && x[i] > evalHeight) i++;
  var rightIp = i;
  if (x[i] < evalHeight) rightIp = i - (evalHeight - x[i]) / (x[i - 1] - x[i]);
  return rightIp - leftIp;
}

function longestRunTrue(mask) {
  var longest = 0, current = 0;
  for (var i = 0; i < mask.length; i++) {
    current = mask[i] ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

// Python's round() is round-half-to-even (banker's rounding); JS Math.round is
// round-half-up. distance_steps must match Python exactly or a .5 ratio (e.g.
// min_distance_days=9, step_days=2) flips peak-merging and can change the class.
function roundHalfEven(v) {
  var f = Math.floor(v);
  var diff = v - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

function countCycles(rawValues, stepDays, peaksCfg) {
  if (rawValues.every(isMissing)) {
    return { nPeaks: 0, classId: 255, flags: ["nodata"], amplitude: NaN };
  }
  var filled = gapfillLinear(rawValues);
  var smoothed = savgol7(filled);
  var amplitude = Math.max.apply(null, smoothed) - Math.min.apply(null, smoothed);

  if (amplitude < peaksCfg.crop_amplitude_floor) {
    return { nPeaks: 0, classId: 0, flags: [], amplitude: amplitude };
  }

  var distanceSteps = Math.max(1, roundHalfEven(peaksCfg.min_distance_days / stepDays));

  var candidates = localMaxima(smoothed);
  candidates = candidates.filter(function (i) { return smoothed[i] >= peaksCfg.min_peak_ndvi; });
  candidates = selectByDistance(candidates, candidates.map(function (i) { return smoothed[i]; }), distanceSteps);

  var withProm = candidates
    .map(function (i) { return { i: i, prom: peakProminence(smoothed, i) }; })
    .filter(function (p) { return p.prom.prominence >= peaksCfg.min_prominence; });

  var finalPeaks = withProm.filter(function (p) {
    var widthSteps = peakWidthSteps(smoothed, p.i, p.prom.leftBase, p.prom.rightBase, p.prom.prominence, 0.7);
    return (widthSteps * stepDays) >= peaksCfg.min_cycle_days;
  });

  var nPeaks = finalPeaks.length;
  var minSmoothed = Math.min.apply(null, smoothed);
  var plateauThreshold = Math.max(minSmoothed + 0.4 * amplitude, peaksCfg.plateau_min_ndvi);
  var longestRunSteps = longestRunTrue(smoothed.map(function (v) { return v >= plateauThreshold; }));

  if (longestRunSteps * stepDays > peaksCfg.plateau_flag_days) {
    return { nPeaks: nPeaks, classId: 4, flags: ["long_plateau"], amplitude: amplitude };
  }
  return { nPeaks: nPeaks, classId: Math.min(nPeaks, 3), flags: [], amplitude: amplitude };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    countCycles: countCycles, gapfillLinear: gapfillLinear, savgol7: savgol7,
    localMaxima: localMaxima, peakProminence: peakProminence,
    selectByDistance: selectByDistance, peakWidthSteps: peakWidthSteps, longestRunTrue: longestRunTrue,
    roundHalfEven: roundHalfEven
  };
}
// <<< END count_cycles JS port <<<

// ----------------------------------------------------------------------
// SHARED COMPOSITING HELPER
// Builds N regular composites of `dayStep`-day periods starting at
// `startDate`, reducing `collection` with median() over each period, and
// stamping system:time_start on each output image so ui.Chart.image.series
// has a usable time axis. Used for both the NDVI series and the S1 VH
// series -- do not duplicate this logic. Copied verbatim from v1.
// ----------------------------------------------------------------------
function makePeriodicComposites(collection, startDate, nPeriods, dayStep) {
  var start = ee.Date(startDate);
  var periodIndices = ee.List.sequence(0, nPeriods - 1);

  var composites = periodIndices.map(function(i) {
    i = ee.Number(i);
    var periodStart = start.advance(i.multiply(dayStep), 'day');
    var periodEnd = periodStart.advance(dayStep, 'day');
    var periodImage = collection
      .filterDate(periodStart, periodEnd)
      .median()
      .set('system:time_start', periodStart.millis())
      .set('period_index', i);
    return periodImage;
  });

  return ee.ImageCollection.fromImages(composites);
}

// ----------------------------------------------------------------------
// LAZY COLLECTION BUILDERS
// No module-level prefiltered collections -- everything is scoped to a
// small `regionGeom` (a buffer around the clicked/Go point) built fresh per
// inspection, which is what keeps statewide clicks fast (a district- or
// state-wide filterBounds/join would be far too slow to run per click).
// ----------------------------------------------------------------------
function buildS2MaskedCollection(regionGeom, yearCfg) {
  var s2Raw = ee.ImageCollection(S2_COLLECTION_ID)
    .filterDate(yearCfg.agriStart, yearCfg.agriEnd)
    .filterBounds(regionGeom);

  var csColl = ee.ImageCollection(CLOUDSCORE_COLLECTION_ID)
    .filterDate(yearCfg.agriStart, yearCfg.agriEnd)
    .filterBounds(regionGeom);

  var s2CsJoin = ee.Join.saveFirst({matchKey: 'cs'}).apply({
    primary: s2Raw,
    secondary: csColl,
    condition: ee.Filter.equals({leftField: 'system:index', rightField: 'system:index'})
  });

  return ee.ImageCollection(s2CsJoin).map(function(img) {
    img = ee.Image(img);
    var csImage = ee.Image(img.get('cs')).select(CLOUDSCORE_BAND);
    var goodMask = csImage.gte(CS_THRESHOLD);
    return img.updateMask(goodMask);
  });
}

function buildNdviCollection(regionGeom, yearCfg) {
  var s2Masked = buildS2MaskedCollection(regionGeom, yearCfg);
  return s2Masked.map(function(img) {
    return img.normalizedDifference(['B8', 'B4'])
      .rename('NDVI')
      .copyProperties(img, ['system:time_start']);
  });
}

function buildVhCollection(regionGeom, yearCfg) {
  return ee.ImageCollection(S1_COLLECTION_ID)
    .filterDate(yearCfg.agriStart, yearCfg.agriEnd)
    .filterBounds(regionGeom)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', S1_BAND))
    .select(S1_BAND);
}

function buildNdviComposites(regionGeom, yearCfg) {
  return makePeriodicComposites(buildNdviCollection(regionGeom, yearCfg), yearCfg.agriStart, N_PERIODS, COMPOSITE_DAYS);
}

function buildVhComposites(regionGeom, yearCfg) {
  return makePeriodicComposites(buildVhCollection(regionGeom, yearCfg), yearCfg.agriStart, N_PERIODS, COMPOSITE_DAYS);
}

// ----------------------------------------------------------------------
// EXTRACTION IMAGE (for live, in-browser classification outside Raichur)
// One band per 15-day period, named "ndvi_00".."ndvi_24", so a single
// reduceRegion() at the clicked point returns the whole 25-value series in
// one round trip instead of 25.
// ----------------------------------------------------------------------
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function toYmd(date) {
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
}

function periodBounds(yearCfg) {
  var start = new Date(yearCfg.agriStart + 'T00:00:00Z');
  var periods = [];
  for (var i = 0; i < N_PERIODS; i++) {
    var periodStart = new Date(start.getTime() + i * COMPOSITE_DAYS * 24 * 60 * 60 * 1000);
    var periodEnd = new Date(periodStart.getTime() + COMPOSITE_DAYS * 24 * 60 * 60 * 1000);
    periods.push({start: toYmd(periodStart), end: toYmd(periodEnd), index: i});
  }
  return periods;
}

function buildNdviExtractionImage(regionGeom, yearCfg) {
  var ndviColl = buildNdviCollection(regionGeom, yearCfg);
  var periods = periodBounds(yearCfg);
  var bands = periods.map(function(p) {
    return ndviColl.filterDate(p.start, p.end).median().rename('ndvi_' + pad2(p.index));
  });
  return ee.Image.cat(bands);
}

// ----------------------------------------------------------------------
// MONTHLY FIELD PHOTOS
// One true-color Sentinel-2 frame per calendar month of the selected
// agri-year, for a small photo strip in the results panel: the clearest
// single scene over the photo box when one is clear enough (sharper than a
// median -- no cross-date blending), falling back to a same-month median
// composite when no single scene clears PHOTO_CLEAR_THRESHOLD.
// ----------------------------------------------------------------------
function monthWindows(yearCfg) {
  var start = new Date(yearCfg.agriStart + 'T00:00:00Z');
  var months = [];
  for (var i = 0; i < 12; i++) {
    var monthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    var monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
    months.push({start: toYmd(monthStart), end: toYmd(monthEnd),
                 label: MONTH_ABBR[monthStart.getUTCMonth()] + ' ' + monthStart.getUTCFullYear()});
  }
  return months;
}

// Ranks a month's cloud-masked S2 images by mean CloudScore+ clarity over the
// photo box, clearest first. img.get('cs') (the CloudScore+ image attached by
// the join in buildS2MaskedCollection) survives that function's updateMask()
// call -- verified empirically against live S2/CloudScore+ data, see
// gee_app/README.md -- so it can still be read here even though monthColl is
// already mask-applied.
function monthlyBestImage(monthColl, regionGeom) {
  return monthColl.map(function(img) {
    img = ee.Image(img);
    var clear = ee.Image(img.get('cs')).select(CLOUDSCORE_BAND).reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: regionGeom,
      scale: SCALE_M
    }).get(CLOUDSCORE_BAND);
    return img.set('fieldClear', clear);
  }).filter(ee.Filter.notNull(['fieldClear'])).sort('fieldClear', false);
}

function buildMonthlyPhotoImages(regionGeom, yearCfg) {
  var s2Masked = buildS2MaskedCollection(regionGeom, yearCfg);
  return monthWindows(yearCfg).map(function(m) {
    var monthColl = s2Masked.filterDate(m.start, m.end);
    var ranked = monthlyBestImage(monthColl, regionGeom);
    var rankedNonEmpty = ranked.size().gt(0);

    // ranked.first() throws on an empty collection; ee.Algorithms.If only
    // evaluates the branch it selects, so gating bestClear on rankedNonEmpty
    // keeps first() from ever actually running when nothing in the month had
    // a readable clarity value.
    var bestClear = ee.Number(ee.Algorithms.If(
      rankedNonEmpty, ee.Image(ranked.first()).get('fieldClear'), -1
    ));
    var useSingle = bestClear.gte(PHOTO_CLEAR_THRESHOLD);

    var displayImage = ee.Image(ee.Algorithms.If(
      useSingle,
      ee.Image(ranked.first()).select(PHOTO_VIS.bands),
      monthColl.median().select(PHOTO_VIS.bands)
    )).resample(PHOTO_RESAMPLE); // display only -- never applied on the NDVI/VH path

    var composite = ee.Image(ee.Algorithms.If(
      monthColl.size().gt(0),
      displayImage,
      ee.Image.constant([0, 0, 0]).rename(PHOTO_VIS.bands).selfMask()
    ));

    var dateStr = ee.String(ee.Algorithms.If(
      useSingle,
      ee.Date(ee.Image(ranked.first()).get('system:time_start')).format('d MMM yyyy'),
      m.label
    ));
    var isSingle = ee.Number(ee.Algorithms.If(useSingle, 1, 0));

    return {label: m.label, start: m.start, end: m.end, image: composite, dateStr: dateStr, isSingle: isSingle};
  });
}

// ----------------------------------------------------------------------
// LAYER UTILITIES
// ----------------------------------------------------------------------
var CLICK_LAYER_NAME = 'clicked point';

function removeLayerByName(name) {
  // Map.layers() returns a client-side list of ui.Map.Layer objects; find
  // any previous layer by name and remove it so repeated actions don't
  // stack duplicate layers.
  var layers = Map.layers();
  for (var i = layers.length() - 1; i >= 0; i--) {
    var layer = layers.get(i);
    if (layer.getName() === name) {
      layers.remove(layer);
    }
  }
}

function replaceMapLayer(name, eeObject, vis) {
  removeLayerByName(name);
  Map.addLayer(eeObject, vis, name);
}

function setLayerShownByName(name, shown) {
  var layers = Map.layers();
  for (var i = 0; i < layers.length(); i++) {
    var layer = layers.get(i);
    if (layer.getName() === name) {
      layer.setShown(shown);
    }
  }
}

// ----------------------------------------------------------------------
// STATE / DISTRICT SELECTION
// ----------------------------------------------------------------------
var raichurFeature;
var currentState = {};

// Pure-data initialization (no ui calls). Kept separate from
// applyStateSelection and invoked at load right below, so the click/Go
// handlers always have boundary collections even if something later in the
// UI assembly fails -- a load-order abort here previously surfaced as
// "Cannot read property 'filterBounds' of undefined" at click time.
function initStateData(stateCfg) {
  currentState.cfg = stateCfg;
  currentState.level1 = ee.FeatureCollection('FAO/GAUL/2015/level1')
    .filter(ee.Filter.eq('ADM1_NAME', stateCfg.gaulAdm1));
  currentState.districtsFC = ee.FeatureCollection('FAO/GAUL/2015/level2')
    .filter(ee.Filter.eq('ADM1_NAME', stateCfg.gaulAdm1));
  raichurFeature = currentState.districtsFC.filter(ee.Filter.eq('ADM2_NAME', 'Raichur'));
}
initStateData(STATE_CONFIGS[0]);

function applyStateSelection(stateCfg) {
  initStateData(stateCfg);

  Map.setCenter(stateCfg.center.lon, stateCfg.center.lat, stateCfg.center.zoom);
  removeLayerByName('district outline');
  removeLayerByName(CLICK_LAYER_NAME);

  populateDistrictSelect(currentState.districtsFC);
}

// Guards against a slow district-list evaluate from a previous state selection
// overwriting a newer one (dormant while STATE_CONFIGS has one entry, but the
// config list is designed to grow).
var districtLoadId = 0;

function populateDistrictSelect(districtsFC) {
  var myLoadId = ++districtLoadId;
  districtSelect.setPlaceholder('Loading districts...');
  districtSelect.setDisabled(true);
  districtSelect.items().reset([]);

  districtsFC.aggregate_array('ADM2_NAME').distinct().sort().evaluate(function(names, error) {
    if (myLoadId !== districtLoadId) return;
    if (error || !names) {
      districtSelect.items().reset(['Failed to load districts']);
      districtSelect.setPlaceholder('Failed to load districts');
      districtSelect.setDisabled(true);
      return;
    }
    districtSelect.items().reset(names);
    districtSelect.setPlaceholder('Select a district');
    districtSelect.setDisabled(false);
  });
}

function onDistrictChange(name) {
  if (!name || !currentState.districtsFC) return;
  var feature = currentState.districtsFC.filter(ee.Filter.eq('ADM2_NAME', name));
  Map.centerObject(feature);
  var outline = ee.Image().byte().paint({featureCollection: feature, color: 0, width: 2});
  replaceMapLayer('district outline', outline, {palette: ['#000000']});
}

// ----------------------------------------------------------------------
// CLASSIFIED IMAGE (validated Raichur asset; mask 255 = nodata so it
// renders transparent).
// ----------------------------------------------------------------------
var classifiedRaw = ee.Image(CLASSIFIED_ASSET_ID);
var classifiedImage = classifiedRaw.updateMask(classifiedRaw.neq(255));

// The validated-map asset may not have been uploaded yet. Probed async at
// startup (see MAP SETUP); until confirmed, every click uses the live path
// and the legend explains why. Uploading the asset later auto-upgrades the
// app on its next load -- no code change needed.
var validatedAssetAvailable = false;

// ----------------------------------------------------------------------
// RESULTS PANEL HELPERS
// resultsPanel is built from persistent slots (locationLabel, classLabel,
// photoStripPanel, chartsPanel) rather than being clear()'d and rebuilt on
// every inspection -- a full clear() would also wipe the async photo strip
// mid-flight and drop the location label between the "loading" and "done"
// states.
// ----------------------------------------------------------------------
function showMessage(msg) {
  classLabel.setValue(msg);
  classLabel.style().set('color', '#cc0000');
  photoStripPanel.clear();
  chartsPanel.clear();
}

function firstDictValue(dictResult) {
  // reduceRegion with ee.Reducer.first() returns a client-side dictionary
  // keyed by the image's band name (not a fixed key like 'first') -- read
  // whichever single key came back rather than assuming a literal name.
  var value = null;
  if (dictResult) {
    for (var key in dictResult) {
      if (dictResult.hasOwnProperty(key)) {
        value = dictResult[key];
        break;
      }
    }
  }
  return value;
}

function addCharts(ndviComposites, vhComposites, point, yearCfg) {
  chartsPanel.clear();
  var yearRange = yearCfg.agriStart.slice(0, 7) + ' -> ' + yearCfg.agriEnd.slice(0, 7);

  var ndviChart = ui.Chart.image.series({
    imageCollection: ndviComposites,
    region: point,
    reducer: ee.Reducer.mean(),
    scale: SCALE_M,
    xProperty: 'system:time_start'
  }).setOptions({
    title: 'NDVI ' + yearRange,
    vAxis: {title: 'NDVI', minValue: -0.1, maxValue: 1},
    hAxis: {title: 'Date'},
    lineWidth: 2,
    pointSize: 3,
    height: 220
  });
  chartsPanel.add(ndviChart);

  var vhChart = ui.Chart.image.series({
    imageCollection: vhComposites,
    region: point,
    reducer: ee.Reducer.mean(),
    scale: SCALE_M,
    xProperty: 'system:time_start'
  }).setOptions({
    title: 'Sentinel-1 VH (dB) ' + yearRange,
    vAxis: {title: 'VH (dB)'},
    hAxis: {title: 'Date'},
    lineWidth: 2,
    pointSize: 2,
    height: 160
  });
  chartsPanel.add(vhChart);
}

// Builds the 12-monthly photo strip for the currently inspected point.
// myRequestId is the caller's inspection generation -- the async
// getThumbURL callbacks and the batched capture-date evaluate below must
// stale-guard against it, since a later click/year-change can fire before
// an earlier photo's URLs or dates come back.
function buildPhotoStrip(regionGeom, yearCfg, myRequestId) {
  photoStripPanel.clear();
  photoStripPanel.add(ui.Label({
    value: 'Field photos (Jun-May)',
    style: {fontWeight: 'bold', margin: '4px 0 4px 0'}
  }));

  var loadingLabel = ui.Label({
    value: 'Loading field photos...',
    style: {fontSize: '11px', color: '#888888', margin: '2px 0'}
  });
  photoStripPanel.add(loadingLabel);

  var photos = buildMonthlyPhotoImages(regionGeom, yearCfg);

  // ONE round trip for everything the cells need before they can be drawn:
  // each month's real capture date + single/composite flag, plus the agri-year
  // contrast stretch. The stretch has to come back before the thumbnails are
  // built, because getThumbURL/ui.Thumbnail need client-side min/max numbers --
  // so the cells are constructed inside this callback rather than above it.
  var yearMedian = buildS2MaskedCollection(regionGeom, yearCfg)
    .select(PHOTO_VIS.bands)
    .median();
  var batched = ee.Dictionary({
    months: ee.List(photos.map(function(p) {
      return ee.Dictionary({date: p.dateStr, single: p.isSingle});
    })),
    stretch: yearMedian.reduceRegion({
      reducer: ee.Reducer.percentile(PHOTO_STRETCH_PCT),
      geometry: regionGeom,
      scale: SCALE_M,
      maxPixels: 1e7
    })
  });

  batched.evaluate(function(result, err) {
    if (myRequestId !== activeRequestId) return;

    photoStripPanel.remove(loadingLabel);
    if (err || !result) {
      photoStripPanel.add(ui.Label({
        value: 'Could not load field photos.',
        style: {fontSize: '11px', color: '#cc0000', margin: '2px 0'}
      }));
      return;
    }

    var vis = resolvePhotoStretch(result.stretch);

    var gridPanel = ui.Panel({
      layout: ui.Panel.Layout.Flow('horizontal', true),
      style: {margin: '0'}
    });
    photoStripPanel.add(gridPanel);

    var months = result.months || [];

    photos.forEach(function(p, idx) {
      var entry = months[idx] || {};
      var labelText = entry.date || p.label;
      if (!entry.single) labelText = labelText + ' (composite)';

      var thumb = ui.Thumbnail({
        image: p.image,
        params: {
          region: regionGeom,
          dimensions: PHOTO_THUMB_DIMENSIONS,
          crs: PHOTO_CRS,
          format: 'png',
          bands: vis.bands,
          min: vis.min,
          max: vis.max,
          gamma: vis.gamma
        },
        style: {width: '100px', height: '100px', margin: '2px'}
      });
      var monthLabel = ui.Label({
        value: labelText,
        style: {
          fontSize: '10px',
          margin: '0 2px',
          textAlign: 'center',
          stretch: 'horizontal',
          color: entry.single ? '#000000' : '#888888'
        }
      });
      var linkLabel = ui.Label({
        value: 'loading link...',
        style: {fontSize: '9px', color: '#888888', margin: '0 2px'}
      });

      var cell = ui.Panel({
        widgets: [thumb, monthLabel, linkLabel],
        layout: ui.Panel.Layout.Flow('vertical'),
        style: {width: '108px', backgroundColor: '#f4f4f4', margin: '2px'}
      });
      gridPanel.add(cell);

      p.image.getThumbURL({
        region: regionGeom,
        dimensions: PHOTO_FULL_DIMENSIONS,
        crs: PHOTO_CRS,
        format: 'png',
        bands: vis.bands,
        min: vis.min,
        max: vis.max,
        gamma: vis.gamma
      }, function(url, thumbErr) {
        if (myRequestId !== activeRequestId) return;
        if (thumbErr || !url) {
          linkLabel.setValue('link failed');
          return;
        }
        if (typeof linkLabel.setUrl === 'function') {
          linkLabel.setValue('open full size');
          linkLabel.style().set('color', '#1a73e8');
          linkLabel.setUrl(url);
        } else {
          var newLabel = ui.Label({
            value: 'open full size',
            targetUrl: url,
            style: {fontSize: '9px', color: '#1a73e8', margin: '0 2px'}
          });
          cell.remove(linkLabel);
          cell.add(newLabel);
        }
      });
    });
  });
}

// Turns the percentile dictionary from reduceRegion into visualization params.
// Keys come back as '<band>_p<pct>' (e.g. B4_p2 / B4_p98). Falls back to the
// fixed PHOTO_VIS stretch if any value is missing or the range is degenerate,
// so a fully-masked box still renders something rather than failing.
function resolvePhotoStretch(stretch) {
  var loPct = PHOTO_STRETCH_PCT[0];
  var hiPct = PHOTO_STRETCH_PCT[1];
  var lo = null;
  var hi = null;

  if (stretch) {
    for (var i = 0; i < PHOTO_VIS.bands.length; i++) {
      var band = PHOTO_VIS.bands[i];
      var bandLo = stretch[band + '_p' + loPct];
      var bandHi = stretch[band + '_p' + hiPct];
      if (typeof bandLo !== 'number' || typeof bandHi !== 'number') {
        lo = null;
        break;
      }
      lo = (lo === null || bandLo < lo) ? bandLo : lo;
      hi = (hi === null || bandHi > hi) ? bandHi : hi;
    }
  }

  if (lo === null || hi === null || !(hi > lo)) {
    return PHOTO_VIS;
  }
  return {bands: PHOTO_VIS.bands, min: lo, max: hi, gamma: PHOTO_STRETCH_GAMMA};
}

// ----------------------------------------------------------------------
// INSPECTION
// ----------------------------------------------------------------------
var activeRequestId = 0;

function inspectPoint(lon, lat) {
  activeRequestId++;
  var myRequestId = activeRequestId;
  var yearCfg = currentYearCfg;

  lastClickedPoint = {lon: lon, lat: lat};

  var point = ee.Geometry.Point([lon, lat]);
  var regionGeom = point.buffer(BUFFER_RADIUS_M);
  var photoRegion = point.buffer(PHOTO_BOX_HALF_SIDE_M).bounds();

  replaceMapLayer(CLICK_LAYER_NAME, point, {color: 'FF0000'});

  var lonR = Math.round(lon * 10000) / 10000;
  var latR = Math.round(lat * 10000) / 10000;

  locationLabel.setValue('Location: ' + lonR + ', ' + latR);
  classLabel.setValue('Loading field data...');
  classLabel.style().set('color', '#888888');
  photoStripPanel.clear();
  chartsPanel.clear();

  var boundaryCheck = ee.Dictionary({
    inKarnataka: currentState.level1.filterBounds(point).size(),
    inRaichur: raichurFeature.filterBounds(point).size()
  });

  boundaryCheck.evaluate(function(flags, error) {
    if (myRequestId !== activeRequestId) return;

    if (error) {
      showMessage('Error checking boundary: ' + error);
      return;
    }

    if (!flags || !flags.inKarnataka) {
      showMessage('Outside ' + currentState.cfg.name + ' boundary.');
      return;
    }

    var ndviComposites = buildNdviComposites(regionGeom, yearCfg);
    var vhComposites = buildVhComposites(regionGeom, yearCfg);

    buildPhotoStrip(photoRegion, yearCfg, myRequestId);

    var useValidated = flags.inRaichur && yearCfg.validatedAssetEligible && validatedAssetAvailable;
    if (useValidated) {
      inspectValidated(point, ndviComposites, vhComposites, yearCfg, myRequestId);
    } else {
      inspectLive(point, regionGeom, ndviComposites, vhComposites, yearCfg, myRequestId);
    }
  });
}

function inspectValidated(point, ndviComposites, vhComposites, yearCfg, myRequestId) {
  var classDict = classifiedImage.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: SCALE_M,
    maxPixels: 1e6
  });

  classDict.evaluate(function(dictResult, dictError) {
    if (myRequestId !== activeRequestId) return;

    if (dictError) {
      showMessage('Error reading classification: ' + dictError);
      return;
    }

    var classValue = firstDictValue(dictResult);
    classLabel.setValue('Class: ' + formatClassLabel(classValue, SOURCE_VALIDATED));
    classLabel.style().set('color', '#000000');

    addCharts(ndviComposites, vhComposites, point, yearCfg);
  });
}

function inspectLive(point, regionGeom, ndviComposites, vhComposites, yearCfg, myRequestId) {
  var extractionImage = buildNdviExtractionImage(regionGeom, yearCfg);
  var ndviDict = extractionImage.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: SCALE_M,
    maxPixels: 1e6
  });

  ndviDict.evaluate(function(dictResult, dictError) {
    if (myRequestId !== activeRequestId) return;

    if (dictError) {
      showMessage('Error computing live classification: ' + dictError);
      return;
    }

    var values = [];
    for (var i = 0; i < N_PERIODS; i++) {
      var key = 'ndvi_' + pad2(i);
      var v = dictResult ? dictResult[key] : null;
      values.push(v === undefined ? null : v);
    }

    var result = countCycles(values, COMPOSITE_DAYS, PEAKS_CFG);
    var classValue = result.classId === 255 ? null : result.classId;

    classLabel.setValue('Class: ' + formatClassLabel(classValue, SOURCE_LIVE));
    classLabel.style().set('color', '#000000');

    addCharts(ndviComposites, vhComposites, point, yearCfg);
  });
}

// ----------------------------------------------------------------------
// AREA ANALYSIS (draw-a-rectangle sampled cropping-intensity estimate)
// Area statistics cannot reuse the per-pixel client-side classifier
// directly, and re-implementing count_cycles server-side would risk
// diverging from the validated map. Instead: randomly sample points across
// the drawn area, pull all N_PERIODS NDVI periods for every sample in ONE
// round trip, and run the existing client-side countCycles() on each
// sample -- reusing the exact validated algorithm while staying fast. This
// is a separate flow from inspectPoint()/inspectLive() above -- per-field
// click inspection is untouched and remains the way to spot-check a single
// field's classification against an area estimate.
// ----------------------------------------------------------------------
var areaRequestId = 0;

// Documented Earth Engine idiom for clearing all drawn geometries (leaves
// the drawing-tools layer list itself intact, just empty).
function clearDrawnGeometries() {
  var layers = Map.drawingTools().layers();
  layers.forEach(function(layer) {
    layers.remove(layer);
  });
}

function areaPanelHeader() {
  return ui.Label({
    value: 'Area analysis',
    style: {fontWeight: 'bold', fontSize: '13px', margin: '0 0 4px 0'}
  });
}

function clearAreaResults() {
  areaPanel.clear();
  areaPanel.add(areaPanelHeader());
  areaPanel.add(ui.Label({
    value: 'Draw a rectangle on the map ("Draw area", top-left) to estimate ' +
      'cropping intensity across an area from sampled points.',
    style: {fontSize: '11px', color: '#666666', margin: '0'}
  }));
}

function showAreaStatus(msg) {
  areaPanel.clear();
  areaPanel.add(areaPanelHeader());
  areaPanel.add(ui.Label({value: msg, style: {color: '#888888', margin: '0'}}));
}

function showAreaError(msg) {
  areaPanel.clear();
  areaPanel.add(areaPanelHeader());
  areaPanel.add(ui.Label({value: msg, style: {color: '#cc0000', margin: '0'}}));
}

// One row: class-color swatch + label + hectares + percent (sample count
// folded into the percent cell, e.g. "23.8% (n=100)"), matching the
// CLASS_INFO legend used for the map layer.
function makeAreaClassRow(classInfo, haText, pctText, count) {
  var swatch = ui.Label({style: {backgroundColor: classInfo.color, padding: '6px', margin: '2px 4px 0 0'}});
  var label = ui.Label({value: classInfo.label, style: {fontSize: '11px', width: '150px', margin: '2px 4px 0 0'}});
  var haLabel = ui.Label({value: haText, style: {fontSize: '11px', width: '65px', margin: '2px 4px 0 0'}});
  var pctLabel = ui.Label({value: pctText + ' (n=' + count + ')', style: {fontSize: '11px', margin: '2px 0 0 0'}});
  return ui.Panel({
    widgets: [swatch, label, haLabel, pctLabel],
    layout: ui.Panel.Layout.Flow('horizontal'),
    style: {margin: '0'}
  });
}

// Tallies countCycles() over every sampled feature's NDVI series (same band
// keys and missing-value handling as inspectLive) and renders the headline
// cropping-intensity number + per-class hectare/percent table into
// areaPanel. Nodata (classId 255) samples are counted and shown separately,
// never folded into the class 0-4 tallies used for hectares/percent/intensity.
function finishAreaAnalysis(areaHa, sampleFc, yearCfg) {
  var features = (sampleFc && sampleFc.features) || [];
  var classCounts = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0};
  var nodataCount = 0;

  for (var i = 0; i < features.length; i++) {
    var props = features[i].properties || {};
    var values = [];
    for (var j = 0; j < N_PERIODS; j++) {
      var key = 'ndvi_' + pad2(j);
      var v = props[key];
      values.push(v === undefined ? null : v);
    }
    var result = countCycles(values, COMPOSITE_DAYS, PEAKS_CFG);
    if (result.classId === 255) {
      nodataCount++;
    } else {
      classCounts[result.classId] = (classCounts[result.classId] || 0) + 1;
    }
  }

  var nSampled = features.length;
  var nValid = nSampled - nodataCount;

  areaPanel.clear();
  areaPanel.add(areaPanelHeader());

  if (nValid <= 0) {
    areaPanel.add(ui.Label({
      value: 'All ' + nSampled + ' sample points were nodata (cloud-obscured/masked) for ' +
        yearCfg.label + ' -- try a different area or agricultural year.',
      style: {color: '#cc0000', margin: '0'}
    }));
    return;
  }

  var ha = {}, pct = {};
  for (var c = 0; c <= 4; c++) {
    pct[c] = classCounts[c] / nValid;
    ha[c] = pct[c] * areaHa;
  }
  var croppedHa = ha[1] + ha[2] + ha[3];
  var grossCroppedHa = ha[1] + 2 * ha[2] + 3 * ha[3];
  var intensityText = croppedHa > 0 ? (grossCroppedHa / croppedHa * 100).toFixed(1) + '%' : 'N/A';
  var marginPct = 1.96 * Math.sqrt(0.25 / nValid) * 100;

  areaPanel.add(ui.Label({
    value: 'Cropping intensity: ' + intensityText,
    style: {fontWeight: 'bold', fontSize: '16px', margin: '0 0 2px 0'}
  }));
  areaPanel.add(ui.Label({
    value: 'Area: ' + areaHa.toFixed(1) + ' ha (' + yearCfg.label + ')',
    style: {fontWeight: 'bold', fontSize: '12px', margin: '0 0 6px 0'}
  }));

  CLASS_INFO.forEach(function(c) {
    var haText = ha[c.value].toFixed(1) + ' ha';
    var pctText = (pct[c.value] * 100).toFixed(1) + '%';
    areaPanel.add(makeAreaClassRow(c, haText, pctText, classCounts[c.value]));
  });

  if (nodataCount > 0) {
    areaPanel.add(ui.Label({
      value: nodataCount + ' of ' + nSampled + ' sample points were nodata (cloud-obscured/masked) ' +
        'and are excluded from the classes above.',
      style: {fontSize: '10px', color: '#888888', margin: '6px 0 0 0'}
    }));
  }
  areaPanel.add(ui.Label({
    value: nValid + ' valid samples, ±' + marginPct.toFixed(1) + '% margin of error at 95% confidence.',
    style: {fontSize: '10px', color: '#666666', margin: '4px 0 0 0'}
  }));
  areaPanel.add(ui.Label({
    value: 'Statistical estimate from randomly sampled points -- not a wall-to-wall pixel count.',
    style: {fontSize: '10px', color: '#666666', margin: '2px 0 0 0'}
  }));
}

function analyzeArea(geometry) {
  areaRequestId++;
  var myAreaId = areaRequestId;
  var yearCfg = currentYearCfg;

  var outlineFc = ee.FeatureCollection([ee.Feature(geometry)]);
  var outline = ee.Image().byte().paint({featureCollection: outlineFc, color: 0, width: 2});
  replaceMapLayer(AREA_LAYER_NAME, outline, {palette: ['#1a73e8']});

  showAreaStatus('Checking area size...');

  // Guard BEFORE the heavy sampling call: a small, fast evaluate of just the
  // area, so an absurdly large draw never reaches reduceRegions() (which
  // would filter/join Sentinel-2 + CloudScore+ over the whole region).
  geometry.area(1).evaluate(function(areaM2, areaErr) {
    if (myAreaId !== areaRequestId) return;
    if (areaErr || typeof areaM2 !== 'number') {
      showAreaError('Error reading drawn area size: ' + (areaErr || 'no result'));
      return;
    }

    var areaHaCheck = areaM2 / 1e4;
    if (areaHaCheck > AREA_MAX_HA) {
      showAreaError(
        'Drawn area is ~' + Math.round(areaHaCheck) + ' ha, above the ' + AREA_MAX_HA +
        ' ha cap -- draw a smaller area.'
      );
      return;
    }

    showAreaStatus(areaHaCheck > AREA_SLOW_HA
      ? 'Analysing ' + Math.round(areaHaCheck) + ' ha (' + AREA_SAMPLE_N +
        ' sample points) -- large areas take about a minute...'
      : 'Analysing area (' + AREA_SAMPLE_N + ' sample points)...');

    var extractionImage = buildNdviExtractionImage(geometry, yearCfg);
    var samplePts = ee.FeatureCollection.randomPoints({
      region: geometry, points: AREA_SAMPLE_N, seed: AREA_SAMPLE_SEED
    });

    // ONE round trip for both the (re-derived, still cheap) area and the
    // sampled NDVI series -- see gee_app/README.md for the measured timing.
    var payload = ee.Dictionary({
      areaHa: geometry.area(1).divide(1e4),
      samples: extractionImage.reduceRegions({
        collection: samplePts, reducer: ee.Reducer.first(), scale: SCALE_M
      })
    });

    payload.evaluate(function(result, error) {
      if (myAreaId !== areaRequestId) return;
      if (error || !result) {
        showAreaError('Error analysing area: ' + (error || 'no result returned'));
        return;
      }
      finishAreaAnalysis(result.areaHa, result.samples, yearCfg);
      addAreaWaterUse(geometry, yearCfg, myAreaId);
    });
  });
}

// Appends the MODIS ET summary under the class table. Runs as its own round
// trip after the class results are already on screen, so the (slower, coarser)
// water figures never hold up the cropping-intensity answer.
function addAreaWaterUse(geometry, yearCfg, myAreaId) {
  var pending = ui.Label({
    value: 'Loading water use...',
    style: {fontSize: '10px', color: '#888888', margin: '6px 0 0 0'}
  });
  areaPanel.add(pending);

  var et = ee.ImageCollection(ET_COLLECTION_ID)
    .filterDate(yearCfg.agriStart, yearCfg.agriEnd);

  function areaMeanSum(band) {
    return et.select(band).sum().multiply(ET_UNIT_SCALE)
      .reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: geometry,
        scale: ET_SCALE_M,
        maxPixels: 1e9,
        bestEffort: true
      }).get(band);
  }

  // Twelve monthly means, so the curve can show the crop cycles independently
  // of NDVI. Measured on a command block: peaks in Sep-Oct (kharif) and
  // Feb-Mar (rabi) -- water use reproduces the double-cropping signal.
  var monthly = ee.List.sequence(0, 11).map(function(m) {
    var start = ee.Date(yearCfg.agriStart).advance(m, 'month');
    return et.select('ET').filterDate(start, start.advance(1, 'month'))
      .sum().multiply(ET_UNIT_SCALE)
      .reduceRegion({
        reducer: ee.Reducer.mean(),
        geometry: geometry,
        scale: ET_SCALE_M,
        maxPixels: 1e9,
        bestEffort: true
      }).get('ET');
  });

  ee.Dictionary({et: areaMeanSum('ET'), pet: areaMeanSum('PET'), monthly: monthly})
    .evaluate(function(res, err) {
      if (myAreaId !== areaRequestId) return;
      areaPanel.remove(pending);

      if (err || !res || typeof res.et !== 'number') {
        areaPanel.add(ui.Label({
          value: 'Water use unavailable for this area/year.',
          style: {fontSize: '10px', color: '#888888', margin: '6px 0 0 0'}
        }));
        return;
      }

      areaPanel.add(ui.Label({
        value: 'Water use (area scale)',
        style: {fontWeight: 'bold', fontSize: '12px', margin: '8px 0 2px 0'}
      }));
      var ratioText = (typeof res.pet === 'number' && res.pet > 0)
        ? (res.et / res.pet).toFixed(2)
        : 'N/A';
      areaPanel.add(ui.Label({
        value: 'Actual ET ' + Math.round(res.et) + ' mm  |  ET/PET ' + ratioText +
          '  (higher = more irrigated)',
        style: {fontSize: '11px', margin: '0 0 2px 0'}
      }));

      var values = [];
      var labels = [];
      for (var m = 0; m < 12; m++) {
        var v = (res.monthly && typeof res.monthly[m] === 'number') ? res.monthly[m] : 0;
        values.push(v);
        labels.push(MONTH_ABBR[(5 + m) % 12]);
      }
      areaPanel.add(ui.Chart.array.values(ee.Array(values), 0, labels).setOptions({
        title: 'Monthly water use (mm)',
        legend: {position: 'none'},
        hAxis: {title: ''},
        vAxis: {title: 'ET (mm)'},
        height: 130
      }).setChartType('ColumnChart'));

      areaPanel.add(ui.Label({
        value: 'MODIS 463 m -- area-scale context only, never a per-field figure.',
        style: {fontSize: '10px', color: '#666666', margin: '2px 0 0 0'}
      }));
    });
}

// ----------------------------------------------------------------------
// MAP SETUP
// ----------------------------------------------------------------------
Map.setOptions('HYBRID');

// Add the validated-map layer only if the asset actually exists: an eager
// addLayer on a missing asset surfaces a permanent layer error. The probe
// resolves after startup, so it also refreshes the legend note and applies
// the current year's visibility itself.
classifiedImage.bandNames().evaluate(function(bandNames, error) {
  if (!error && bandNames && bandNames.length) {
    validatedAssetAvailable = true;
    Map.addLayer(
      classifiedImage,
      {min: 0, max: 4, palette: PALETTE},
      INTENSITY_LAYER_NAME,
      currentYearCfg.validatedAssetEligible
    );
  }
  updateLegendForYear(currentYearCfg);
});

// ----------------------------------------------------------------------
// LEGEND (bottom-left panel) -- verbatim from v1.
// ----------------------------------------------------------------------
function makeLegendRow(color, label) {
  var colorBox = ui.Label({
    style: {
      backgroundColor: color,
      padding: '8px',
      margin: '0 0 4px 0'
    }
  });
  var description = ui.Label({
    value: label,
    style: {margin: '0 0 4px 6px'}
  });
  return ui.Panel({
    widgets: [colorBox, description],
    layout: ui.Panel.Layout.Flow('horizontal')
  });
}

var legend = ui.Panel({
  style: {
    position: 'bottom-left',
    padding: '8px 15px'
  }
});
legend.add(ui.Label({
  value: 'Cropping Intensity (2024-25)',
  style: {fontWeight: 'bold', fontSize: '14px', margin: '0 0 6px 0'}
}));
CLASS_INFO.forEach(function(c) {
  legend.add(makeLegendRow(c.color, c.value + ' — ' + c.label));
});
legend.add(ui.Label({
  value: 'Transparent / no color = nodata (255, masked)',
  style: {fontSize: '11px', color: '#666666', margin: '6px 0 0 0'}
}));
var legendYearNote = ui.Label('', {fontSize: '11px', color: '#cc0000', margin: '6px 0 0 0'});
legend.add(legendYearNote);
Map.add(legend);

function updateLegendForYear(yearCfg) {
  if (!validatedAssetAvailable) {
    legendYearNote.setValue(
      'Validated 2024-25 map not uploaded yet -- all results are computed ' +
      'live (same algorithm). Upload asset raichur_intensity_2024_25 to enable it.'
    );
  } else if (yearCfg.validatedAssetEligible) {
    legendYearNote.setValue('');
  } else {
    legendYearNote.setValue(
      'Validated 2024-25 map hidden for ' + yearCfg.label +
      ' -- this year uses the live classification path everywhere, including Raichur.'
    );
  }
}

// ----------------------------------------------------------------------
// YEAR SELECTION
// Applying a year swaps currentYearCfg, toggles the validated intensity
// layer's visibility, updates the legend note, and -- if a point has
// already been inspected -- re-runs that inspection under the new year.
// ----------------------------------------------------------------------
function applyYearSelection(yearCfg) {
  currentYearCfg = yearCfg;
  setLayerShownByName(INTENSITY_LAYER_NAME, yearCfg.validatedAssetEligible);
  updateLegendForYear(yearCfg);
  if (lastClickedPoint) {
    inspectPoint(lastClickedPoint.lon, lastClickedPoint.lat);
  }
}

// ----------------------------------------------------------------------
// TOP-LEFT CONTROL PANEL: state select, district select, Go-to-coordinates.
// ----------------------------------------------------------------------
var yearLabels = YEAR_CONFIGS.map(function(c) { return c.label; });

var yearSelect = ui.Select({
  items: yearLabels,
  value: yearLabels[0],
  onChange: function(label) {
    for (var i = 0; i < YEAR_CONFIGS.length; i++) {
      if (YEAR_CONFIGS[i].label === label) {
        applyYearSelection(YEAR_CONFIGS[i]);
        return;
      }
    }
  },
  style: {stretch: 'horizontal'}
});

var stateNames = STATE_CONFIGS.map(function(c) { return c.name; });

var stateSelect = ui.Select({
  items: stateNames,
  value: stateNames[0],
  onChange: function(name) {
    for (var i = 0; i < STATE_CONFIGS.length; i++) {
      if (STATE_CONFIGS[i].name === name) {
        applyStateSelection(STATE_CONFIGS[i]);
        return;
      }
    }
  },
  style: {stretch: 'horizontal'}
});

var districtSelect = ui.Select({
  items: [],
  placeholder: 'Loading districts...',
  disabled: true,
  onChange: onDistrictChange,
  style: {stretch: 'horizontal'}
});

var latBox = ui.Textbox({placeholder: 'Latitude, e.g. 15.77'});
var lonBox = ui.Textbox({placeholder: 'Longitude, e.g. 76.76'});
var goErrorLabel = ui.Label({
  value: '',
  style: {color: '#cc0000', fontSize: '11px', margin: '2px 0 0 0'}
});

var goButton = ui.Button({
  label: 'Go',
  onClick: function() {
    goErrorLabel.setValue('');

    var lat = parseFloat(latBox.getValue());
    var lon = parseFloat(lonBox.getValue());

    if (isNaN(lat) || isNaN(lon)) {
      goErrorLabel.setValue('Enter numeric latitude and longitude.');
      return;
    }
    if (lat < -90 || lat > 90) {
      goErrorLabel.setValue('Latitude must be between -90 and 90.');
      return;
    }
    if (lon < -180 || lon > 180) {
      goErrorLabel.setValue('Longitude must be between -180 and 180.');
      return;
    }

    Map.setCenter(lon, lat, GO_ZOOM);
    inspectPoint(lon, lat);
  }
});

var goRow = ui.Panel({
  widgets: [latBox, lonBox, goButton],
  layout: ui.Panel.Layout.Flow('horizontal')
});

// Draw-area / clear-area buttons -- see analyzeArea() and the "AREA DRAWING
// SETUP" section below for the drawingTools wiring these trigger.
var drawAreaButton = ui.Button({
  label: 'Draw area',
  onClick: function() {
    areaRequestId++; // invalidate any in-flight analyzeArea from a previous draw
    clearDrawnGeometries();
    removeLayerByName(AREA_LAYER_NAME);
    showAreaStatus('Draw a rectangle on the map, then release to analyse it.');
    Map.drawingTools().setShape('rectangle');
    Map.drawingTools().setShown(true);
    Map.drawingTools().draw();
  }
});

var clearAreaButton = ui.Button({
  label: 'Clear area',
  onClick: function() {
    areaRequestId++; // invalidate any in-flight analyzeArea callback
    clearDrawnGeometries();
    removeLayerByName(AREA_LAYER_NAME);
    Map.drawingTools().setShape(null);
    clearAreaResults();
  }
});

var areaButtonRow = ui.Panel({
  widgets: [drawAreaButton, clearAreaButton],
  layout: ui.Panel.Layout.Flow('horizontal')
});

var controlPanel = ui.Panel({
  widgets: [
    ui.Label({value: 'Karnataka Cropping Inspector', style: {fontWeight: 'bold', fontSize: '15px', margin: '4px 4px 8px 4px'}}),
    ui.Label({value: 'Agricultural year', style: {margin: '0 4px 2px 4px'}}),
    yearSelect,
    ui.Label({value: 'State', style: {margin: '8px 4px 2px 4px'}}),
    stateSelect,
    ui.Label({value: 'District', style: {margin: '8px 4px 2px 4px'}}),
    districtSelect,
    ui.Label({value: 'Go to coordinates', style: {margin: '8px 4px 2px 4px'}}),
    goRow,
    goErrorLabel,
    ui.Label({value: 'Draw an area', style: {margin: '8px 4px 2px 4px'}}),
    areaButtonRow
  ],
  layout: ui.Panel.Layout.Flow('vertical'),
  style: {position: 'top-left', width: '260px', padding: '8px'}
});
Map.add(controlPanel);

// ----------------------------------------------------------------------
// RIGHT SIDE PANEL (title + instructions, never cleared; results, rebuilt
// on every inspection).
// ----------------------------------------------------------------------
var headerPanel = ui.Panel({
  widgets: [
    ui.Label({
      value: 'Karnataka Cropping Inspector',
      style: {fontWeight: 'bold', fontSize: '20px', margin: '8px 8px 4px 8px'}
    }),
    ui.Label({
      value: 'Pick a state and district, use "Go to coordinates", or click any point on the map to ' +
        'inspect that field. Use "Draw area" (top-left) to estimate cropping intensity across a larger area.',
      style: {margin: '0 8px 8px 8px', color: '#444444'}
    })
  ],
  layout: ui.Panel.Layout.Flow('vertical')
});

var locationLabel = ui.Label({style: {fontWeight: 'bold', margin: '8px 8px 2px 8px'}});
var classLabel = ui.Label({style: {margin: '0 8px 8px 8px'}});
var photoStripPanel = ui.Panel({layout: ui.Panel.Layout.Flow('vertical'), style: {margin: '0 8px 8px 8px'}});
var chartsPanel = ui.Panel({layout: ui.Panel.Layout.Flow('vertical'), style: {margin: '0 8px'}});
var resultsPanel = ui.Panel({
  widgets: [locationLabel, classLabel, photoStripPanel, chartsPanel],
  layout: ui.Panel.Layout.Flow('vertical'),
  style: {margin: '4px 0'}
});

// Draw-an-area sampled results -- a separate persistent slot from
// resultsPanel above (the per-field click/Go spot-check), cleared and
// rebuilt by analyzeArea() the same way photoStripPanel/chartsPanel are
// rebuilt per click, so the two flows never interfere with each other.
var areaPanel = ui.Panel({
  layout: ui.Panel.Layout.Flow('vertical'),
  style: {margin: '4px 8px 8px 8px', padding: '6px', backgroundColor: '#f4f4f4'}
});
clearAreaResults();

var sidePanel = ui.Panel({
  widgets: [headerPanel, areaPanel, resultsPanel],
  layout: ui.Panel.Layout.Flow('vertical'),
  style: {width: '350px'}
});

// Attach the side panel directly to ui.root instead of reparenting the
// default Map into a nested panel: the reparenting pattern aborts script
// load in the real Code Editor, leaving startup un-run (root cause of the
// "Cannot read property 'filterBounds' of undefined" click error).
ui.root.insert(1, sidePanel);

// ----------------------------------------------------------------------
// AREA DRAWING SETUP
// Configured once at startup. setLinked(false) keeps the drawn shape as a
// plain on-map geometry rather than also creating an importable script
// variable (this is a throwaway analysis shape, not a script import).
// onDraw fires once a shape is completed; setShape(null) immediately after
// hands map clicks back to the CLICK HANDLER below, so drawing and
// click-to-inspect never fight over the same click.
// ----------------------------------------------------------------------
Map.drawingTools().setLinked(false);
Map.drawingTools().onDraw(function(geometry) {
  Map.drawingTools().setShape(null);
  analyzeArea(geometry);
});

// ----------------------------------------------------------------------
// CLICK HANDLER
// ----------------------------------------------------------------------
Map.onClick(function(coords) {
  inspectPoint(coords.lon, coords.lat);
});

// ----------------------------------------------------------------------
// STARTUP
// ----------------------------------------------------------------------
applyStateSelection(STATE_CONFIGS[0]);
applyYearSelection(YEAR_CONFIGS[0]);

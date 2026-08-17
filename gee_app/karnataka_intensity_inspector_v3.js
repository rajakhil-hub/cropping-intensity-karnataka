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
var PHOTO_BOX_HALF_SIDE_M = 150;
var PHOTO_THUMB_DIMENSIONS = '100x100';
var PHOTO_FULL_DIMENSIONS = 512;
var PHOTO_VIS = {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000, gamma: 1.2};
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
// 12 true-color Sentinel-2 composites, one per calendar month of the
// selected agri-year, for a small photo strip in the results panel.
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

function buildMonthlyPhotoImages(regionGeom, yearCfg) {
  var s2Masked = buildS2MaskedCollection(regionGeom, yearCfg);
  return monthWindows(yearCfg).map(function(m) {
    var monthColl = s2Masked.filterDate(m.start, m.end);
    var composite = ee.Image(ee.Algorithms.If(
      monthColl.size().gt(0),
      monthColl.median().select(PHOTO_VIS.bands),
      ee.Image.constant([0, 0, 0]).rename(PHOTO_VIS.bands).selfMask()
    ));
    return {label: m.label, start: m.start, end: m.end, image: composite};
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

function applyStateSelection(stateCfg) {
  currentState.cfg = stateCfg;
  currentState.level1 = ee.FeatureCollection('FAO/GAUL/2015/level1')
    .filter(ee.Filter.eq('ADM1_NAME', stateCfg.gaulAdm1));
  currentState.districtsFC = ee.FeatureCollection('FAO/GAUL/2015/level2')
    .filter(ee.Filter.eq('ADM1_NAME', stateCfg.gaulAdm1));

  raichurFeature = currentState.districtsFC.filter(ee.Filter.eq('ADM2_NAME', 'Raichur'));

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
// getThumbURL callbacks below must stale-guard against it, since a later
// click/year-change can fire before an earlier photo's URL comes back.
function buildPhotoStrip(regionGeom, yearCfg, myRequestId) {
  photoStripPanel.clear();
  photoStripPanel.add(ui.Label({
    value: 'Field photos (Jun-May)',
    style: {fontWeight: 'bold', margin: '4px 0 4px 0'}
  }));

  var gridPanel = ui.Panel({
    layout: ui.Panel.Layout.Flow('horizontal', true),
    style: {margin: '0'}
  });
  photoStripPanel.add(gridPanel);

  var photos = buildMonthlyPhotoImages(regionGeom, yearCfg);
  photos.forEach(function(p) {
    var thumb = ui.Thumbnail({
      image: p.image,
      params: {
        region: regionGeom,
        dimensions: PHOTO_THUMB_DIMENSIONS,
        format: 'png',
        bands: PHOTO_VIS.bands,
        min: PHOTO_VIS.min,
        max: PHOTO_VIS.max,
        gamma: PHOTO_VIS.gamma
      },
      style: {width: '100px', height: '100px', margin: '2px'}
    });
    var monthLabel = ui.Label({
      value: p.label,
      style: {fontSize: '10px', margin: '0 2px', textAlign: 'center', stretch: 'horizontal'}
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
      format: 'png',
      bands: PHOTO_VIS.bands,
      min: PHOTO_VIS.min,
      max: PHOTO_VIS.max,
      gamma: PHOTO_VIS.gamma
    }, function(url, err) {
      if (myRequestId !== activeRequestId) return;
      if (err || !url) {
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
    goErrorLabel
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
      value: 'Pick a state and district, use "Go to coordinates", or click any point on the map to inspect that field.',
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

var sidePanel = ui.Panel({
  widgets: [headerPanel, resultsPanel],
  layout: ui.Panel.Layout.Flow('vertical'),
  style: {width: '350px'}
});

var mainPanel = ui.Panel({
  widgets: [Map, sidePanel],
  layout: ui.Panel.Layout.Flow('horizontal'),
  style: {stretch: 'both'}
});
Map.style().set('stretch', 'both');
ui.root.widgets().reset([mainPanel]);

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

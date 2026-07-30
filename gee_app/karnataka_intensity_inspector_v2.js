/**
 * WELL Labs — Karnataka Cropping-Intensity Inspector (v2)
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
 * v1 (`gee_app/raichur_intensity_inspector.js`, Raichur-only, asset-only) is
 * kept untouched in the repo for rollback -- this is a new, separate script.
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
var AGRI_START = '2024-06-01';
var AGRI_END = '2025-05-31';
var COMPOSITE_DAYS = 15;
var N_PERIODS = 25; // 375 days / 15-day steps ~= full agri-year coverage
var CS_THRESHOLD = 0.60;

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
function buildNdviCollection(regionGeom) {
  var s2Raw = ee.ImageCollection(S2_COLLECTION_ID)
    .filterDate(AGRI_START, AGRI_END)
    .filterBounds(regionGeom);

  var csColl = ee.ImageCollection(CLOUDSCORE_COLLECTION_ID)
    .filterDate(AGRI_START, AGRI_END)
    .filterBounds(regionGeom);

  var s2CsJoin = ee.Join.saveFirst({matchKey: 'cs'}).apply({
    primary: s2Raw,
    secondary: csColl,
    condition: ee.Filter.equals({leftField: 'system:index', rightField: 'system:index'})
  });

  var s2Masked = ee.ImageCollection(s2CsJoin).map(function(img) {
    img = ee.Image(img);
    var csImage = ee.Image(img.get('cs')).select(CLOUDSCORE_BAND);
    var goodMask = csImage.gte(CS_THRESHOLD);
    return img.updateMask(goodMask);
  });

  return s2Masked.map(function(img) {
    return img.normalizedDifference(['B8', 'B4'])
      .rename('NDVI')
      .copyProperties(img, ['system:time_start']);
  });
}

function buildVhCollection(regionGeom) {
  return ee.ImageCollection(S1_COLLECTION_ID)
    .filterDate(AGRI_START, AGRI_END)
    .filterBounds(regionGeom)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', S1_BAND))
    .select(S1_BAND);
}

function buildNdviComposites(regionGeom) {
  return makePeriodicComposites(buildNdviCollection(regionGeom), AGRI_START, N_PERIODS, COMPOSITE_DAYS);
}

function buildVhComposites(regionGeom) {
  return makePeriodicComposites(buildVhCollection(regionGeom), AGRI_START, N_PERIODS, COMPOSITE_DAYS);
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

function periodBounds() {
  var start = new Date(AGRI_START + 'T00:00:00Z');
  var periods = [];
  for (var i = 0; i < N_PERIODS; i++) {
    var periodStart = new Date(start.getTime() + i * COMPOSITE_DAYS * 24 * 60 * 60 * 1000);
    var periodEnd = new Date(periodStart.getTime() + COMPOSITE_DAYS * 24 * 60 * 60 * 1000);
    periods.push({start: toYmd(periodStart), end: toYmd(periodEnd), index: i});
  }
  return periods;
}

function buildNdviExtractionImage(regionGeom) {
  var ndviColl = buildNdviCollection(regionGeom);
  var periods = periodBounds();
  var bands = periods.map(function(p) {
    return ndviColl.filterDate(p.start, p.end).median().rename('ndvi_' + pad2(p.index));
  });
  return ee.Image.cat(bands);
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

// ----------------------------------------------------------------------
// RESULTS PANEL HELPERS
// ----------------------------------------------------------------------
function showMessage(msg) {
  resultsPanel.clear();
  resultsPanel.add(ui.Label({value: msg, style: {margin: '8px 8px'}}));
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

function addCharts(ndviComposites, vhComposites, point) {
  var ndviChart = ui.Chart.image.series({
    imageCollection: ndviComposites,
    region: point,
    reducer: ee.Reducer.mean(),
    scale: SCALE_M,
    xProperty: 'system:time_start'
  }).setOptions({
    title: 'NDVI 2024-06 -> 2025-05',
    vAxis: {title: 'NDVI', minValue: -0.1, maxValue: 1},
    hAxis: {title: 'Date'},
    lineWidth: 2,
    pointSize: 3,
    height: 220
  });
  resultsPanel.add(ndviChart);

  var vhChart = ui.Chart.image.series({
    imageCollection: vhComposites,
    region: point,
    reducer: ee.Reducer.mean(),
    scale: SCALE_M,
    xProperty: 'system:time_start'
  }).setOptions({
    title: 'Sentinel-1 VH (dB) 2024-06 -> 2025-05',
    vAxis: {title: 'VH (dB)'},
    hAxis: {title: 'Date'},
    lineWidth: 2,
    pointSize: 2,
    height: 160
  });
  resultsPanel.add(vhChart);
}

// ----------------------------------------------------------------------
// INSPECTION
// ----------------------------------------------------------------------
var activeRequestId = 0;

function inspectPoint(lon, lat) {
  activeRequestId++;
  var myRequestId = activeRequestId;

  var point = ee.Geometry.Point([lon, lat]);
  var regionGeom = point.buffer(BUFFER_RADIUS_M);

  replaceMapLayer(CLICK_LAYER_NAME, point, {color: 'FF0000'});

  var lonR = Math.round(lon * 10000) / 10000;
  var latR = Math.round(lat * 10000) / 10000;

  resultsPanel.clear();
  resultsPanel.add(ui.Label({
    value: 'Location: ' + lonR + ', ' + latR,
    style: {fontWeight: 'bold', margin: '8px 8px 2px 8px'}
  }));
  resultsPanel.add(ui.Label({
    value: 'Loading field data...',
    style: {margin: '0 8px 8px 8px', color: '#888888'}
  }));

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
      resultsPanel.clear();
      resultsPanel.add(ui.Label({
        value: 'Location: ' + lonR + ', ' + latR,
        style: {fontWeight: 'bold', margin: '8px 8px 2px 8px'}
      }));
      resultsPanel.add(ui.Label({
        value: 'Outside ' + currentState.cfg.name + ' boundary.',
        style: {margin: '0 8px 8px 8px', color: '#cc0000'}
      }));
      return;
    }

    var ndviComposites = buildNdviComposites(regionGeom);
    var vhComposites = buildVhComposites(regionGeom);

    if (flags.inRaichur) {
      inspectValidated(point, ndviComposites, vhComposites, myRequestId);
    } else {
      inspectLive(point, regionGeom, ndviComposites, vhComposites, myRequestId);
    }
  });
}

function inspectValidated(point, ndviComposites, vhComposites, myRequestId) {
  var classDict = classifiedImage.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: SCALE_M,
    maxPixels: 1e6
  });

  classDict.evaluate(function(dictResult, dictError) {
    if (myRequestId !== activeRequestId) return;

    resultsPanel.clear();
    var lonLat = point.coordinates();

    if (dictError) {
      resultsPanel.add(ui.Label({
        value: 'Error reading classification: ' + dictError,
        style: {margin: '0 8px 8px 8px', color: '#cc0000'}
      }));
      return;
    }

    var classValue = firstDictValue(dictResult);
    resultsPanel.add(ui.Label({
      value: 'Class: ' + formatClassLabel(classValue, SOURCE_VALIDATED),
      style: {margin: '0 8px 8px 8px'}
    }));

    addCharts(ndviComposites, vhComposites, point);
  });
}

function inspectLive(point, regionGeom, ndviComposites, vhComposites, myRequestId) {
  var extractionImage = buildNdviExtractionImage(regionGeom);
  var ndviDict = extractionImage.reduceRegion({
    reducer: ee.Reducer.first(),
    geometry: point,
    scale: SCALE_M,
    maxPixels: 1e6
  });

  ndviDict.evaluate(function(dictResult, dictError) {
    if (myRequestId !== activeRequestId) return;

    resultsPanel.clear();

    if (dictError) {
      resultsPanel.add(ui.Label({
        value: 'Error computing live classification: ' + dictError,
        style: {margin: '0 8px 8px 8px', color: '#cc0000'}
      }));
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

    resultsPanel.add(ui.Label({
      value: 'Class: ' + formatClassLabel(classValue, SOURCE_LIVE),
      style: {margin: '0 8px 8px 8px'}
    }));

    addCharts(ndviComposites, vhComposites, point);
  });
}

// ----------------------------------------------------------------------
// MAP SETUP
// ----------------------------------------------------------------------
Map.setOptions('HYBRID');

Map.addLayer(
  classifiedImage,
  {min: 0, max: 4, palette: PALETTE},
  'Cropping Intensity 2024-25 (Raichur, validated)'
);

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
Map.add(legend);

// ----------------------------------------------------------------------
// TOP-LEFT CONTROL PANEL: state select, district select, Go-to-coordinates.
// ----------------------------------------------------------------------
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
    ui.Label({value: 'State', style: {margin: '0 4px 2px 4px'}}),
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

var resultsPanel = ui.Panel({
  layout: ui.Panel.Layout.Flow('vertical'),
  style: {margin: '4px 8px'}
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

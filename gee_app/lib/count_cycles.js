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

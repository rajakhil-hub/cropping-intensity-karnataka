/**
 * sl2p_lai.js
 * ===========
 * Canonical JS port of `src/cropint/gee/biophysical.py` `sl2p_lai()` -- ESA's
 * SNAP S2 Biophysical Processor (SL2P) neural network for per-pixel leaf-area
 * index (LAI) from Sentinel-2 reflectances + scene view/sun angles. Validated
 * against the Python implementation by the fixture-based parity tests in
 * `gee_app/test/sl2p_lai.test.js` (see `scripts/generate_sl2p_fixtures.py`
 * for how the fixtures are generated from the real Python
 * `sl2p_lai_values()`).
 *
 * Coefficients: SNAP auxdata version "2_1" (matches ATBD v1.1), sensor-agnostic
 * (one set of weights for S2A and S2B) -- see biophysical.py for provenance
 * and cross-check notes. Valid output domain is LAI 0-8; the ATBD reports
 * RMSE 0.89 and notes uncertainty grows above LAI ~6.
 *
 * CAVEAT: rice/paddy is NOT in SL2P's training crop list, and standing water
 * under early transplanted paddy violates the model's soil-background
 * assumption. Trust the SHAPE of the LAI curve more than its absolute
 * magnitude over paddy.
 *
 * This file must never be hand-copied elsewhere. The ONE sanctioned copy of
 * this content lives embedded, byte-identical, between the
 * "// >>> BEGIN sl2p_lai JS port ... >>>" / "// <<< END ... <<<" markers in
 * `gee_app/karnataka_intensity_inspector_v3.js` (v3 only -- v2 has no LAI
 * code). Anti-drift is enforced by `gee_app/test/sync_check.test.js`. If you
 * need to change the algorithm, change it here first, then re-paste the
 * whole file (including this header) into the marked block in the v3 app.
 */

// Input order for the network: 8 reflectance bands then 3 angle cosines.
var SL2P_BANDS = ['B3', 'B4', 'B5', 'B6', 'B7', 'B8A', 'B11', 'B12'];

// [min, max] used to normalize each of the 11 inputs to [-1, 1].
var SL2P_NORM = [
  [0.0, 0.253061520471542],
  [0.0, 0.290393577911328],
  [0.0, 0.305398915248555],
  [0.006637972542253, 0.608900395797889],
  [0.013972727018939, 0.753827384322927],
  [0.026690138082061, 0.782011770669178],
  [0.016388074192258, 0.493761397883092],
  [0.0, 0.493025984460231],
  [0.918595400582046, 1.0],
  [0.342022871159208, 0.936206429175402],
  [-1.0, 1.0]
];

var SL2P_LAYER1_BIAS = [
  4.96238030555279,
  1.416008443981500,
  1.075897047213310,
  1.533988264655420,
  3.024115930757230
];

var SL2P_LAYER1_WEIGHTS = [
  [-0.023406878966470, 0.921655164636366, 0.135576544080099, -1.938331472397950,
   -3.342495816122680, 0.902277648009576, 0.205363538258614, -0.040607844721716,
   -0.083196409727092, 0.260029270773809, 0.284761567218845],
  [-0.132555480856684, -0.139574837333540, -1.014606016898920, -1.330890038649270,
   0.031730624503341, -1.433583541317050, -0.959637898574699, 1.133115706551000,
   0.216603876541632, 0.410652303762839, 0.064760155543506],
  [0.086015977724868, 0.616648776881434, 0.678003876446556, 0.141102398644968,
   -0.096682206883546, -1.128832638862200, 0.302189102741375, 0.434494937299725,
   -0.021903699490589, -0.228492476802263, -0.039460537589826],
  [-0.109366593670404, -0.071046262972729, 0.064582411478320, 2.906325236823160,
   -0.673873108979163, -3.838051868280840, 1.695979344531530, 0.046950296081713,
   -0.049709652688365, 0.021829545430994, 0.057483827104091],
  [-0.089939416159969, 0.175395483106147, -0.081847329172620, 2.219895367487790,
   1.713873975136850, 0.713069186099534, 0.138970813499201, -0.060771761518025,
   0.124263341255473, 0.210086140404351, -0.183878138700341]
];

var SL2P_LAYER2_BIAS = 1.096963107077220;
var SL2P_LAYER2_WEIGHTS = [
  -1.500135489728730,
  -0.096283269121503,
  -0.194935930577094,
  -0.352305895755591,
  0.075107415847473
];

// Output denormalization [Ymin, Ymax], and the processor's valid output domain.
var SL2P_DENORM = [0.000319182538301, 14.4675094548151];
var LAI_VALID_RANGE = [0.0, 8.0];

var SL2P_DEG2RAD = Math.PI / 180.0;

// SL2P's transfer function: 2 / (1 + exp(-2x)) - 1. Explicit sigmoid form
// (not Math.tanh) to mirror the ee-graph tansig formulation exactly -- the
// two agree to 1.8e-15 in the Python/ee path, so either is fine numerically,
// but this keeps the JS port a literal transcription of the network graph.
function tansig(x) {
  return 2 / (1 + Math.exp(-2 * x)) - 1;
}

// Pure numeric path: inputs is one 11-element array, [B3, B4, B5, B6, B7,
// B8A, B11, B12] reflectances already scaled 0-1, followed by [viewZen,
// sunZen, relAzim] angle cosines. Returns a plain number, clamped to [0, 8].
// No `ee` reference anywhere in this function -- Node-requireable, used by
// the parity tests.
function sl2pLaiFromInputs(inputs) {
  var normalized = [];
  var i;
  for (i = 0; i < SL2P_NORM.length; i++) {
    normalized.push(((inputs[i] - SL2P_NORM[i][0]) / (SL2P_NORM[i][1] - SL2P_NORM[i][0])) * 2 - 1);
  }

  var hidden = [];
  var neuron;
  for (neuron = 0; neuron < SL2P_LAYER1_BIAS.length; neuron++) {
    var acc = SL2P_LAYER1_BIAS[neuron];
    for (i = 0; i < normalized.length; i++) {
      acc += normalized[i] * SL2P_LAYER1_WEIGHTS[neuron][i];
    }
    hidden.push(tansig(acc));
  }

  var net = SL2P_LAYER2_BIAS;
  for (neuron = 0; neuron < hidden.length; neuron++) {
    net += hidden[neuron] * SL2P_LAYER2_WEIGHTS[neuron];
  }

  var lai = (net + 1) * (0.5 * (SL2P_DENORM[1] - SL2P_DENORM[0])) + SL2P_DENORM[0];
  if (lai < LAI_VALID_RANGE[0]) lai = LAI_VALID_RANGE[0];
  if (lai > LAI_VALID_RANGE[1]) lai = LAI_VALID_RANGE[1];
  return lai;
}

// Cosines of view zenith, sun zenith and relative azimuth from scene
// metadata -- mirrors `_scene_angle_cosines` in biophysical.py. B8A stands
// in for the mean view angle across bands.
function sl2pSceneAngleCosines(img) {
  var viewZen = ee.Number(img.get('MEAN_INCIDENCE_ZENITH_ANGLE_B8A')).multiply(SL2P_DEG2RAD).cos();
  var sunZen = ee.Number(img.get('MEAN_SOLAR_ZENITH_ANGLE')).multiply(SL2P_DEG2RAD).cos();
  var relAzim = ee.Number(img.get('MEAN_SOLAR_AZIMUTH_ANGLE'))
    .subtract(ee.Number(img.get('MEAN_INCIDENCE_AZIMUTH_ANGLE_B8A')))
    .multiply(SL2P_DEG2RAD)
    .cos();
  return [ee.Image.constant(viewZen), ee.Image.constant(sunZen), ee.Image.constant(relAzim)];
}

function sl2pTansigImage(img) {
  return img.multiply(-2).exp().add(1).pow(-1).multiply(2).subtract(1);
}

// ee wrapper: per-pixel LAI for one Sentinel-2 L2A scene, as a single-band
// 'LAI' image. Expects a raw COPERNICUS/S2_SR_HARMONIZED image (DN, scale
// factor 10000) with its metadata intact -- the angle properties are read
// off the image. Mirrors `sl2p_lai()` in biophysical.py exactly.
function sl2pLaiImage(img) {
  var inputs = SL2P_BANDS.map(function(b) { return img.select(b).divide(10000); });
  inputs = inputs.concat(sl2pSceneAngleCosines(img));

  var normalized = [];
  var i;
  for (i = 0; i < SL2P_NORM.length; i++) {
    normalized.push(
      inputs[i].subtract(SL2P_NORM[i][0]).divide(SL2P_NORM[i][1] - SL2P_NORM[i][0]).multiply(2).subtract(1)
    );
  }

  var hidden = [];
  var neuron;
  for (neuron = 0; neuron < SL2P_LAYER1_BIAS.length; neuron++) {
    var acc = ee.Image.constant(SL2P_LAYER1_BIAS[neuron]);
    for (i = 0; i < normalized.length; i++) {
      acc = acc.add(normalized[i].multiply(SL2P_LAYER1_WEIGHTS[neuron][i]));
    }
    hidden.push(sl2pTansigImage(acc));
  }

  var net = ee.Image.constant(SL2P_LAYER2_BIAS);
  for (neuron = 0; neuron < hidden.length; neuron++) {
    net = net.add(hidden[neuron].multiply(SL2P_LAYER2_WEIGHTS[neuron]));
  }

  var lai = net.add(1).multiply(0.5 * (SL2P_DENORM[1] - SL2P_DENORM[0])).add(SL2P_DENORM[0]).rename('LAI');
  lai = lai.clamp(LAI_VALID_RANGE[0], LAI_VALID_RANGE[1]);
  // copyProperties returns an Element, not an Image -- re-wrap so callers can
  // chain Image methods (reduceRegion, etc.) directly.
  return ee.Image(lai.copyProperties(img, ['system:time_start']));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sl2pLaiFromInputs: sl2pLaiFromInputs,
    sl2pLaiImage: sl2pLaiImage
  };
}

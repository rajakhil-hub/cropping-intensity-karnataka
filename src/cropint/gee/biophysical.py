"""Sentinel-2 biophysical variables: SL2P LAI, plus saturation-resistant indices.

LAI is computed with ESA's SNAP S2 Biophysical Processor (SL2P) neural network —
the same algorithm SNAP runs — ported to Earth Engine. Why bother, when MODIS
ships a ready LAI product? Because MODIS LAI is 463 m: one pixel swallows ~20 ha,
so it cannot see a 0.5-2 ha smallholder field at all. SL2P runs on the Sentinel-2
reflectances we already pull, at 10-20 m.

Why LAI matters here: NDVI saturates in dense canopy. Measured on a Raichur
double-crop paddy field, NDVI sat flat at 0.88/0.88/0.90 across 11 Mar, 26 Mar and
5 Apr 2025 while SL2P LAI resolved the canopy declining 4.25 -> 3.93 -> 3.70 over
the same dates. For cycle counting on paddy and sugarcane, that extra headroom is
the point.

Coefficients: SNAP auxdata version "2_1" (matches ATBD v1.1), taken from
senbox-org/s2tbx `s2tbx-biophysical/src/main/resources/auxdata/2_1/LAI/` and
cross-checked byte-for-byte against two independent community ports
(sentinel-hub/custom-scripts, ollinevalainen/satellitetools). The "2_1" set is
sensor-agnostic (one set of weights for S2A and S2B), which keeps a multi-year
series that mixes both satellites internally consistent. SNAP's current default
is a sensor-specific "3_0" set; do not mix the two within one time series.

Caveats worth carrying downstream:
  - Valid domain LAI 0-8; ATBD reports RMSE 0.89 and notes uncertainty grows
    above LAI ~6.
  - Rice/paddy is NOT in SL2P's training crop list, and standing water under
    early transplanted paddy violates the model's soil-background assumption.
    Trust the SHAPE of the LAI curve (what cycle counting needs) more than the
    absolute magnitude over paddy.

Reference: Weiss & Baret (2016), S2ToolBox Level 2 products ATBD v1.1,
https://step.esa.int/docs/extra/ATBD_S2ToolBox_L2B_V1.1.pdf
"""

from __future__ import annotations

import math
from typing import Sequence

import ee

# Input order for the network: 8 reflectance bands then 3 angle cosines.
SL2P_BANDS = ["B3", "B4", "B5", "B6", "B7", "B8A", "B11", "B12"]

# [min, max] used to normalize each of the 11 inputs to [-1, 1].
_NORM = [
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
    [-1.0, 1.0],
]

_LAYER1_BIAS = [
    4.96238030555279,
    1.416008443981500,
    1.075897047213310,
    1.533988264655420,
    3.024115930757230,
]

_LAYER1_WEIGHTS = [
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
     0.124263341255473, 0.210086140404351, -0.183878138700341],
]

_LAYER2_BIAS = 1.096963107077220
_LAYER2_WEIGHTS = [
    -1.500135489728730,
    -0.096283269121503,
    -0.194935930577094,
    -0.352305895755591,
    0.075107415847473,
]

# Output denormalization [Ymin, Ymax], and the processor's valid output domain.
_DENORM = [0.000319182538301, 14.4675094548151]
LAI_VALID_RANGE = (0.0, 8.0)

_DEG2RAD = math.pi / 180.0


def _scene_angle_cosines(img: ee.Image) -> list[ee.Image]:
    """Cosines of view zenith, sun zenith and relative azimuth from scene metadata.

    SL2P uses scene-representative mean angles, not per-pixel angle grids, so the
    Sentinel-2 scene properties are the right source. B8A stands in for the mean
    view angle across bands: they differ by only a couple of degrees because all
    bands are acquired near-simultaneously off the same push-broom array.
    """
    view_zen = ee.Number(img.get("MEAN_INCIDENCE_ZENITH_ANGLE_B8A")).multiply(_DEG2RAD).cos()
    sun_zen = ee.Number(img.get("MEAN_SOLAR_ZENITH_ANGLE")).multiply(_DEG2RAD).cos()
    rel_azim = (
        ee.Number(img.get("MEAN_SOLAR_AZIMUTH_ANGLE"))
        .subtract(ee.Number(img.get("MEAN_INCIDENCE_AZIMUTH_ANGLE_B8A")))
        .multiply(_DEG2RAD)
        .cos()
    )
    return [ee.Image.constant(a) for a in (view_zen, sun_zen, rel_azim)]


def _tansig(img: ee.Image) -> ee.Image:
    """SL2P's transfer function: 2 / (1 + exp(-2x)) - 1."""
    return img.multiply(-2).exp().add(1).pow(-1).multiply(2).subtract(1)


def sl2p_lai(img: ee.Image, clamp: bool = True) -> ee.Image:
    """Per-pixel LAI for one Sentinel-2 L2A scene, as a single-band 'LAI' image.

    Expects a raw COPERNICUS/S2_SR_HARMONIZED image (DN, scale factor 10000) with
    its metadata intact — the angle properties are read off the image. Set
    clamp=False to keep raw network output outside the 0-8 validity domain.
    """
    inputs = [img.select(b).divide(10000) for b in SL2P_BANDS]
    inputs += _scene_angle_cosines(img)

    normalized = [
        inputs[i].subtract(_NORM[i][0]).divide(_NORM[i][1] - _NORM[i][0]).multiply(2).subtract(1)
        for i in range(len(_NORM))
    ]

    hidden = []
    for neuron in range(len(_LAYER1_BIAS)):
        acc = ee.Image.constant(_LAYER1_BIAS[neuron])
        for i, norm_input in enumerate(normalized):
            acc = acc.add(norm_input.multiply(_LAYER1_WEIGHTS[neuron][i]))
        hidden.append(_tansig(acc))

    net = ee.Image.constant(_LAYER2_BIAS)
    for neuron, activation in enumerate(hidden):
        net = net.add(activation.multiply(_LAYER2_WEIGHTS[neuron]))

    lai = net.add(1).multiply(0.5 * (_DENORM[1] - _DENORM[0])).add(_DENORM[0]).rename("LAI")
    if clamp:
        lai = lai.clamp(*LAI_VALID_RANGE)
    # copyProperties returns an Element, not an Image — re-wrap so callers can
    # chain Image methods (reduceRegion, etc.) directly.
    return ee.Image(lai.copyProperties(img, ["system:time_start"]))


def sl2p_lai_values(inputs: Sequence[float]) -> float:
    """Pure-numeric SL2P LAI: mirrors `sl2p_lai()` exactly but on plain floats.

    `inputs` is 11 values -- 8 reflectances (0-1, SL2P_BANDS order) followed
    by 3 angle cosines (viewZen, sunZen, relAzim) -- same order as the JS
    port. No `ee` calls, so it can run without a live Earth Engine session
    (used by scripts/generate_sl2p_fixtures.py for parity-test fixtures).
    """
    normalized = [
        (inputs[i] - _NORM[i][0]) / (_NORM[i][1] - _NORM[i][0]) * 2 - 1 for i in range(len(_NORM))
    ]

    hidden = []
    for neuron in range(len(_LAYER1_BIAS)):
        acc = _LAYER1_BIAS[neuron]
        for i, norm_input in enumerate(normalized):
            acc += norm_input * _LAYER1_WEIGHTS[neuron][i]
        hidden.append(math.tanh(acc))

    net = _LAYER2_BIAS
    for neuron, activation in enumerate(hidden):
        net += activation * _LAYER2_WEIGHTS[neuron]

    lai = (net + 1) * (0.5 * (_DENORM[1] - _DENORM[0])) + _DENORM[0]
    return min(max(lai, LAI_VALID_RANGE[0]), LAI_VALID_RANGE[1])


def evi(img: ee.Image) -> ee.Image:
    """EVI (Huete et al. 2002) — cheap saturation-resistant alternative to LAI.

    The soil-adjustment term and blue-band aerosol correction keep it responsive
    at high biomass where NDVI's ratio form flattens out. Measured at peak growth
    in Raichur, EVI separated irrigated paddy from rainfed by 0.108 where NDVI
    managed only 0.036.
    """
    band = img.expression(
        "2.5 * (N - R) / (N + 6 * R - 7.5 * B + 1)",
        {
            "N": img.select("B8").divide(10000),
            "R": img.select("B4").divide(10000),
            "B": img.select("B2").divide(10000),
        },
    ).rename("EVI")
    return ee.Image(band.copyProperties(img, ["system:time_start"]))

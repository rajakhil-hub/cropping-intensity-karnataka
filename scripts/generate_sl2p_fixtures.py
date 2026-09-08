"""Generate JSON fixtures pairing SL2P LAI inputs with the real Python `sl2p_lai_values` output.

Used by `gee_app/test/sl2p_lai.test.js` to check the JS port
(`gee_app/lib/sl2p_lai.js`) produces identical results to
`src/cropint/gee/biophysical.py`.
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cropint.gee.biophysical import SL2P_BANDS, sl2p_lai_values

OUT_PATH = "tests/fixtures/sl2p_lai_expected.json"


def synthetic_points() -> list[dict]:
    """Synthetic 11-value input rows covering bare soil through dense canopy, plus clamp edges."""
    return [
        {
            "name": "bare_soil",
            "inputs": [0.10, 0.12, 0.14, 0.16, 0.18, 0.19, 0.20, 0.15, 0.95, 0.85, 0.9],
        },
        {
            "name": "sparse_canopy",
            "inputs": [0.06, 0.05, 0.08, 0.20, 0.28, 0.30, 0.18, 0.10, 0.95, 0.85, 0.9],
        },
        {
            "name": "dense_canopy",
            "inputs": [0.04, 0.03, 0.06, 0.35, 0.45, 0.48, 0.15, 0.08, 0.95, 0.85, 0.9],
        },
        {
            # Pushed below the network's raw output range; verified by
            # construction (see module docstring in generate step) to clamp
            # to exactly 0.0 after denormalization.
            "name": "out_of_range_clamps_low",
            "inputs": [0.253, 0.29, 0.305, 0.007, 0.014, 0.027, 0.016, 0.0, 1.0, 0.34, -1.0],
        },
        {
            # Pushed above the network's raw output range; verified by
            # construction to clamp to exactly 8.0 after denormalization.
            "name": "out_of_range_clamps_high",
            "inputs": [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0],
        },
    ]


def capture_anchor_inputs(name: str, lon: float, lat: float, date_start: str, date_end: str) -> dict:
    """Pull the 8 SL2P reflectance bands + 4 scene angle properties for the least-cloudy scene at a point.

    Requires a live, authenticated Earth Engine session (see cropint.gee.init.ee_init) --
    only called from main() when this script is run directly, never at import time.
    """
    import ee

    from cropint.gee.init import ee_init

    ee_init()

    point = ee.Geometry.Point([lon, lat])
    scene = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(point)
        .filterDate(date_start, date_end)
        .sort("CLOUDY_PIXEL_PERCENTAGE")
        .first()
    )

    band_values = scene.select(SL2P_BANDS).reduceRegion(
        reducer=ee.Reducer.first(), geometry=point, scale=20
    )
    props = scene.toDictionary(
        [
            "MEAN_INCIDENCE_ZENITH_ANGLE_B8A",
            "MEAN_SOLAR_ZENITH_ANGLE",
            "MEAN_SOLAR_AZIMUTH_ANGLE",
            "MEAN_INCIDENCE_AZIMUTH_ANGLE_B8A",
        ]
    )
    result = ee.Dictionary({"bands": band_values, "props": props}).getInfo()

    reflectances = [result["bands"][b] / 10000.0 for b in SL2P_BANDS]
    view_zen = math.cos(math.radians(result["props"]["MEAN_INCIDENCE_ZENITH_ANGLE_B8A"]))
    sun_zen = math.cos(math.radians(result["props"]["MEAN_SOLAR_ZENITH_ANGLE"]))
    rel_azim = math.cos(
        math.radians(
            result["props"]["MEAN_SOLAR_AZIMUTH_ANGLE"]
            - result["props"]["MEAN_INCIDENCE_AZIMUTH_ANGLE_B8A"]
        )
    )

    inputs = reflectances + [view_zen, sun_zen, rel_azim]
    return {"name": name, "inputs": inputs, "expected_lai": sl2p_lai_values(inputs)}


# name -> (lon, lat, target anchor LAI for a human sanity check; live imagery
# on the given date window can differ scene-to-scene, so this is not asserted)
ANCHORS = [
    ("Sindhanur_paddy", 76.73, 15.69, 3.071),
    ("Lingsugur_rainfed", 76.62, 16.13, 0.151),
    ("Jaladurga_scrub", 76.4197, 16.2525, 0.253),
]
ANCHOR_DATE_START = "2025-02-20"
ANCHOR_DATE_END = "2025-03-10"


def main() -> None:
    """Run the real sl2p_lai_values on synthetic + live-captured anchor points and write the JSON fixture."""
    points = synthetic_points()

    for point in points:
        point["expected_lai"] = sl2p_lai_values(point["inputs"])

    for name, lon, lat, target in ANCHORS:
        row = capture_anchor_inputs(name, lon, lat, ANCHOR_DATE_START, ANCHOR_DATE_END)
        print(f"{name}: computed {row['expected_lai']:.3f}, target anchor ~{target}")
        points.append(row)

    fixture = {"points": points}

    out_path = Path(OUT_PATH)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)

    print(f"Wrote {out_path} ({len(points)} points)")


if __name__ == "__main__":
    main()

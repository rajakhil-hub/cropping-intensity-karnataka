"""Fetch the AOI district boundary from FAO GAUL and save it as GeoJSON."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import ee

from cropint.config import load_config
from cropint.gee.init import ee_init


def main() -> None:
    """Fetch the configured district boundary from GAUL and write it to disk."""
    cfg = load_config()
    ee_init()

    aoi = cfg["aoi"]
    adm1 = aoi["gaul_adm1"]
    adm2 = aoi["gaul_adm2"]

    gaul = ee.FeatureCollection("FAO/GAUL/2015/level2")
    match = gaul.filter(ee.Filter.And(
        ee.Filter.eq("ADM1_NAME", adm1),
        ee.Filter.eq("ADM2_NAME", adm2),
    ))

    if match.size().getInfo() == 0:
        candidates = (
            gaul.filter(ee.Filter.eq("ADM1_NAME", adm1))
            .aggregate_array("ADM2_NAME")
            .getInfo()
        )
        names = sorted(set(candidates))
        raise SystemExit(
            f"No GAUL match for ADM1={adm1!r} ADM2={adm2!r}. "
            f"Available ADM2_NAME values under {adm1!r}: {names}"
        )

    geometry = match.geometry()
    area_km2 = geometry.area().divide(1e6).getInfo()
    geojson = geometry.getInfo()

    out_path = Path(aoi["geojson"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(geojson))

    print(f"Saved boundary to {out_path} ({area_km2:.1f} km^2)")


if __name__ == "__main__":
    main()

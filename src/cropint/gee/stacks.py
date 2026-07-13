"""Build S2/S1 masked/filtered collections and periodic composite stacks.

Requires GEE auth: the caller must invoke `ee_init()` from `cropint.gee.init`
before any function here is used. This module never calls `ee.Initialize`.
"""

import ee

from cropint.config import composite_periods, period_labels


def s2_ndvi_collection(aoi: ee.Geometry, cfg: dict) -> ee.ImageCollection:
    """Cloud-masked (CloudScore+) Sentinel-2 NDVI collection over aoi/agri-year."""
    sat = cfg["satellite"]
    start, end = cfg["agri_year"]["start"], cfg["agri_year"]["end"]
    threshold = sat["cloudscore_threshold"]
    cs_band = sat["cloudscore_band"]

    s2 = ee.ImageCollection(sat["s2_collection"]).filterBounds(aoi).filterDate(start, end)
    cs = ee.ImageCollection(sat["cloudscore_collection"])
    linked = s2.linkCollection(cs, [cs_band])

    def _to_masked_ndvi(img: ee.Image) -> ee.Image:
        mask = img.select(cs_band).gte(threshold)
        ndvi = img.normalizedDifference(["B8", "B4"]).rename("NDVI")
        return ndvi.updateMask(mask)

    return linked.map(_to_masked_ndvi)


def s1_vh_collection(aoi: ee.Geometry, cfg: dict) -> ee.ImageCollection:
    """Speckle-filtered Sentinel-1 IW VH collection (both orbit passes) over aoi/agri-year."""
    sat = cfg["satellite"]
    start, end = cfg["agri_year"]["start"], cfg["agri_year"]["end"]
    band = sat["s1_band"]

    s1 = (
        ee.ImageCollection(sat["s1_collection"])
        .filterBounds(aoi)
        .filterDate(start, end)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", band))
        .select(band)
    )

    def _despeckle(img: ee.Image) -> ee.Image:
        return img.focalMedian(30, "circle", "meters").rename(band)

    return s1.map(_despeckle)


def composite_series(collection: ee.ImageCollection, band: str, cfg: dict) -> ee.Image:
    """Median-composite `collection` into one multi-band image, one band per agri-year period."""
    periods = composite_periods(cfg)
    labels = period_labels(cfg)

    band_images = [
        collection.filterDate(period_start.strftime("%Y-%m-%d"), period_end.strftime("%Y-%m-%d"))
        .select(band)
        .median()
        .rename(label)
        for (period_start, period_end), label in zip(periods, labels)
    ]
    return ee.Image.cat(band_images)


def extract_point_series(image: ee.Image, points_fc: ee.FeatureCollection, scale: int) -> list[dict]:
    """Sample every band of `image` at every point in `points_fc` in one server-side call."""
    sampled = image.reduceRegions(collection=points_fc, reducer=ee.Reducer.first(), scale=scale)
    result = sampled.getInfo()
    return [f["properties"] for f in result["features"]]

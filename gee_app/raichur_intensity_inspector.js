/**
 * WELL Labs — Raichur Cropping-Intensity Field Inspector
 * ========================================================
 *
 * WHAT THIS IS
 * ------------
 * A Google Earth Engine (GEE) Code Editor JavaScript app for field teams to
 * inspect the Raichur district (Karnataka) cropping-intensity classification
 * (agri-year 2024-06-01 -> 2025-05-31). Click any point on the map to see:
 *   - the classified cropping-intensity value at that pixel (0-4, or nodata),
 *   - a Sentinel-2 NDVI 15-day-composite time series chart for that pixel,
 *   - a Sentinel-1 VH (radar) 15-day-composite time series chart.
 *
 * This mirrors the AOI, dates, thresholds, and 15-day compositing scheme used
 * in the project's Python pipeline (see config/raichur.yaml), so the NDVI/VH
 * curves shown here are directly comparable to what produced the classified
 * map.
 *
 * HOW TO RUN
 * ----------
 * This is plain Earth Engine Code Editor JavaScript — there is no build step,
 * no npm/node, no import statements. To run it:
 *   1. Go to https://code.earthengine.google.com/
 *   2. Open (or create) a new script.
 *   3. Copy the entire contents of this file and paste it into the editor.
 *   4. Click "Run".
 * The GEE Code Editor cannot load .js files directly from disk — this file
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
 * be ingesting/exporting at the time this script is written — the id is not
 * verified here, it is only referenced as a constant.
 */

// ----------------------------------------------------------------------
// CONSTANTS (mirrors config/raichur.yaml — do not hardcode values below
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

// Classified asset (uint8). May still be ingesting at time of writing —
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

// ----------------------------------------------------------------------
// AOI: Raichur district boundary (FAO GAUL level-2)
// ----------------------------------------------------------------------
var raichur = ee.FeatureCollection('FAO/GAUL/2015/level2')
  .filter(ee.Filter.and(
    ee.Filter.eq('ADM1_NAME', 'Karnataka'),
    ee.Filter.eq('ADM2_NAME', 'Raichur')
  ));

// ----------------------------------------------------------------------
// SHARED COMPOSITING HELPER
// Builds N regular composites of `dayStep`-day periods starting at
// `startDate`, reducing `collection` with median() over each period, and
// stamping system:time_start on each output image so ui.Chart.image.series
// has a usable time axis. Used for both the NDVI series and the S1 VH
// series — do not duplicate this logic.
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
// NDVI COLLECTION (S2 SR Harmonized, CloudScore+ masked)
// Join S2 to CloudScore+ by system:index using ee.Join.saveFirst (stable,
// well-documented pattern — preferred over ee.Image.linkCollection, which
// is a newer API and a bigger availability risk across EE JS versions).
// ----------------------------------------------------------------------
var s2Raw = ee.ImageCollection(S2_COLLECTION_ID)
  .filterDate(AGRI_START, AGRI_END)
  .filterBounds(raichur);

var csColl = ee.ImageCollection(CLOUDSCORE_COLLECTION_ID)
  .filterDate(AGRI_START, AGRI_END)
  .filterBounds(raichur);

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

var ndviColl = s2Masked.map(function(img) {
  return img.normalizedDifference(['B8', 'B4'])
    .rename('NDVI')
    .copyProperties(img, ['system:time_start']);
});

var ndviComposites = makePeriodicComposites(ndviColl, AGRI_START, N_PERIODS, COMPOSITE_DAYS);

// ----------------------------------------------------------------------
// SENTINEL-1 VH COLLECTION (monsoon gap-filler series)
// ----------------------------------------------------------------------
var s1Coll = ee.ImageCollection(S1_COLLECTION_ID)
  .filterDate(AGRI_START, AGRI_END)
  .filterBounds(raichur)
  .filter(ee.Filter.eq('instrumentMode', 'IW'))
  .filter(ee.Filter.listContains('transmitterReceiverPolarisation', S1_BAND))
  .select(S1_BAND);

var vhComposites = makePeriodicComposites(s1Coll, AGRI_START, N_PERIODS, COMPOSITE_DAYS);

// ----------------------------------------------------------------------
// CLASSIFIED IMAGE (mask 255 = nodata so it renders transparent)
// ----------------------------------------------------------------------
var classifiedRaw = ee.Image(CLASSIFIED_ASSET_ID);
var classifiedImage = classifiedRaw.updateMask(classifiedRaw.neq(255));

// ----------------------------------------------------------------------
// MAP SETUP
// ----------------------------------------------------------------------
Map.setOptions('HYBRID');
Map.setCenter(76.9, 15.9, 10);

Map.addLayer(
  classifiedImage,
  {min: 0, max: 4, palette: PALETTE},
  'Cropping Intensity 2024-25'
);

var raichurOutline = ee.Image().byte().paint({
  featureCollection: raichur,
  color: 0,
  width: 2
});
Map.addLayer(raichurOutline, {palette: ['#000000']}, 'Raichur boundary');

// ----------------------------------------------------------------------
// LEGEND (bottom-left panel)
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
// RIGHT SIDE PANEL (title + instructions, never cleared; results, rebuilt
// on every click)
// ----------------------------------------------------------------------
var headerPanel = ui.Panel({
  widgets: [
    ui.Label({
      value: 'Raichur Field Inspector',
      style: {fontWeight: 'bold', fontSize: '20px', margin: '8px 8px 4px 8px'}
    }),
    ui.Label({
      value: 'Click any point on the map to inspect that field.',
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
var CLICK_LAYER_NAME = 'clicked point';

function removeClickLayer() {
  // Map.layers() returns a client-side list of ui.Map.Layer objects; find
  // any previous click-marker layer by name and remove it so repeated
  // clicks don't stack duplicate markers.
  var layers = Map.layers();
  for (var i = layers.length() - 1; i >= 0; i--) {
    var layer = layers.get(i);
    if (layer.getName() === CLICK_LAYER_NAME) {
      layers.remove(layer);
    }
  }
}

function showMessage(msg) {
  resultsPanel.clear();
  resultsPanel.add(ui.Label({value: msg, style: {margin: '8px 8px'}}));
}

Map.onClick(function(coords) {
  var lon = coords.lon;
  var lat = coords.lat;
  var point = ee.Geometry.Point([lon, lat]);

  // Update click marker, removing any previous one first.
  removeClickLayer();
  Map.addLayer(point, {color: 'FF0000'}, CLICK_LAYER_NAME);

  resultsPanel.clear();
  resultsPanel.add(ui.Label({
    value: 'Loading field data...',
    style: {margin: '8px 8px', color: '#888888'}
  }));

  var lonR = Math.round(lon * 10000) / 10000;
  var latR = Math.round(lat * 10000) / 10000;

  // Check whether the point falls inside the Raichur boundary server-side,
  // then evaluate once.
  var insideCount = raichur.filterBounds(point).size();

  insideCount.evaluate(function(count, error) {
    if (error) {
      showMessage('Error checking boundary: ' + error);
      return;
    }
    if (!count || count === 0) {
      resultsPanel.clear();
      resultsPanel.add(ui.Label({
        value: 'Location: ' + lonR + ', ' + latR,
        style: {fontWeight: 'bold', margin: '8px 8px 2px 8px'}
      }));
      resultsPanel.add(ui.Label({
        value: 'Outside Raichur district boundary.',
        style: {margin: '0 8px 8px 8px', color: '#cc0000'}
      }));
      return;
    }

    // Inside boundary — read the classified pixel value.
    var classDict = classifiedImage.reduceRegion({
      reducer: ee.Reducer.first(),
      geometry: point,
      scale: SCALE_M,
      maxPixels: 1e6
    });

    classDict.evaluate(function(dictResult, dictError) {
      resultsPanel.clear();

      resultsPanel.add(ui.Label({
        value: 'Location: ' + lonR + ', ' + latR,
        style: {fontWeight: 'bold', margin: '8px 8px 2px 8px'}
      }));

      if (dictError) {
        resultsPanel.add(ui.Label({
          value: 'Error reading classification: ' + dictError,
          style: {margin: '0 8px 8px 8px', color: '#cc0000'}
        }));
      } else {
        // reduceRegion with ee.Reducer.first() returns a client-side
        // dictionary keyed by the image's band name (not a fixed key like
        // 'first'), and the classified image has exactly one band — so
        // just read whichever single key came back rather than assuming
        // a literal band-name string.
        var classValue = null;
        if (dictResult) {
          for (var key in dictResult) {
            if (dictResult.hasOwnProperty(key)) {
              classValue = dictResult[key];
              break;
            }
          }
        }

        var classText;
        if (classValue === null || classValue === undefined) {
          classText = NODATA_TEXT;
        } else {
          classText = CLASS_TEXT[String(classValue)] || NODATA_TEXT;
        }

        resultsPanel.add(ui.Label({
          value: 'Class: ' + classText,
          style: {margin: '0 8px 8px 8px'}
        }));
      }

      // NDVI time series chart.
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

      // Sentinel-1 VH time series chart (smaller, below NDVI).
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
    });
  });
});

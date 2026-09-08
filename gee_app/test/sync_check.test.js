// Anti-drift gate: each embedded JS-port block in the app files (between its
// BEGIN/END marker lines) must be byte-identical to its canonical source in
// gee_app/lib/. If this fails, someone edited one copy without re-pasting
// into the other(s) -- fix by copying the lib file's full content into the
// marked block in the failing app file(s).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// One entry per (lib, marker pair, app files it must be embedded in).
const SYNCED_LIBS = [
  {
    libPath: path.join(__dirname, "..", "lib", "count_cycles.js"),
    beginMarker: "// >>> BEGIN count_cycles JS port (source: gee_app/lib/count_cycles.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>",
    endMarker: "// <<< END count_cycles JS port <<<",
    appPaths: [
      path.join(__dirname, "..", "karnataka_intensity_inspector_v2.js"),
      path.join(__dirname, "..", "karnataka_intensity_inspector_v3.js"),
    ],
  },
  {
    libPath: path.join(__dirname, "..", "lib", "sl2p_lai.js"),
    beginMarker: "// >>> BEGIN sl2p_lai JS port (source: gee_app/lib/sl2p_lai.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>",
    endMarker: "// <<< END sl2p_lai JS port <<<",
    appPaths: [
      path.join(__dirname, "..", "karnataka_intensity_inspector_v3.js"),
    ],
  },
];

function extractEmbeddedBlock(appSrc, appPath, beginMarker, endMarker) {
  const beginIdx = appSrc.indexOf(beginMarker);
  const endIdx = appSrc.indexOf(endMarker);
  if (beginIdx === -1) {
    throw new Error("BEGIN marker not found in " + appPath);
  }
  if (endIdx === -1) {
    throw new Error("END marker not found in " + appPath);
  }
  const afterBeginLineStart = appSrc.indexOf("\n", beginIdx) + 1;
  return appSrc.slice(afterBeginLineStart, endIdx);
}

SYNCED_LIBS.forEach(function (entry) {
  const libBasename = path.basename(entry.libPath);

  entry.appPaths.forEach(function (appPath) {
    test("embedded " + libBasename + " block in " + path.basename(appPath) + " matches gee_app/lib/" + libBasename + " exactly", function () {
      const libSrc = fs.readFileSync(entry.libPath, "utf8");
      const appSrc = fs.readFileSync(appPath, "utf8");

      const embedded = extractEmbeddedBlock(appSrc, appPath, entry.beginMarker, entry.endMarker);

      assert.strictEqual(embedded.trim(), libSrc.trim());
    });
  });
});

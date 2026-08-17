// Anti-drift gate: the count_cycles JS port embedded in each app file
// (gee_app/karnataka_intensity_inspector_v2.js and _v3.js, between the
// BEGIN/END marker lines) must be byte-identical to
// gee_app/lib/count_cycles.js (including its header comment). If this
// fails, someone edited one copy without re-pasting into the other(s) --
// fix by copying lib/count_cycles.js's full content into the marked block
// in the failing app file(s).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LIB_PATH = path.join(__dirname, "..", "lib", "count_cycles.js");
const APP_PATHS = [
  path.join(__dirname, "..", "karnataka_intensity_inspector_v2.js"),
  path.join(__dirname, "..", "karnataka_intensity_inspector_v3.js"),
];

const BEGIN_MARKER = "// >>> BEGIN count_cycles JS port (source: gee_app/lib/count_cycles.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>";
const END_MARKER = "// <<< END count_cycles JS port <<<";

function extractEmbeddedBlock(appSrc, appPath) {
  const beginIdx = appSrc.indexOf(BEGIN_MARKER);
  const endIdx = appSrc.indexOf(END_MARKER);
  if (beginIdx === -1) {
    throw new Error("BEGIN marker not found in " + appPath);
  }
  if (endIdx === -1) {
    throw new Error("END marker not found in " + appPath);
  }
  const afterBeginLineStart = appSrc.indexOf("\n", beginIdx) + 1;
  return appSrc.slice(afterBeginLineStart, endIdx);
}

APP_PATHS.forEach(function (appPath) {
  test("embedded count_cycles block in " + path.basename(appPath) + " matches gee_app/lib/count_cycles.js exactly", function () {
    const libSrc = fs.readFileSync(LIB_PATH, "utf8");
    const appSrc = fs.readFileSync(appPath, "utf8");

    const embedded = extractEmbeddedBlock(appSrc, appPath);

    assert.strictEqual(embedded.trim(), libSrc.trim());
  });
});

// Anti-drift gate: the count_cycles JS port embedded in
// gee_app/karnataka_intensity_inspector_v2.js (between the BEGIN/END marker
// lines) must be byte-identical to gee_app/lib/count_cycles.js (including
// its header comment). If this fails, someone edited one copy without
// re-pasting into the other -- fix by copying lib/count_cycles.js's full
// content into the marked block in the v2 app.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LIB_PATH = path.join(__dirname, "..", "lib", "count_cycles.js");
const APP_PATH = path.join(__dirname, "..", "karnataka_intensity_inspector_v2.js");

const BEGIN_MARKER = "// >>> BEGIN count_cycles JS port (source: gee_app/lib/count_cycles.js -- keep byte-identical; see gee_app/test/sync_check.test.js) >>>";
const END_MARKER = "// <<< END count_cycles JS port <<<";

function extractEmbeddedBlock(appSrc) {
  const beginIdx = appSrc.indexOf(BEGIN_MARKER);
  const endIdx = appSrc.indexOf(END_MARKER);
  if (beginIdx === -1) {
    throw new Error("BEGIN marker not found in " + APP_PATH);
  }
  if (endIdx === -1) {
    throw new Error("END marker not found in " + APP_PATH);
  }
  const afterBeginLineStart = appSrc.indexOf("\n", beginIdx) + 1;
  return appSrc.slice(afterBeginLineStart, endIdx);
}

test("embedded count_cycles block in v2 app matches gee_app/lib/count_cycles.js exactly", function () {
  const libSrc = fs.readFileSync(LIB_PATH, "utf8");
  const appSrc = fs.readFileSync(APP_PATH, "utf8");

  const embedded = extractEmbeddedBlock(appSrc);

  assert.strictEqual(embedded.trim(), libSrc.trim());
});

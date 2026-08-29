const test = require("node:test");
const assert = require("node:assert");
const L = require("../lib.js");

test("posKey / parseKey round-trip", () => {
  const k = L.posKey("firefox-container-3", "abc123XYZ_-");
  assert.strictEqual(k, "p:firefox-container-3|abc123XYZ_-");
  assert.deepStrictEqual(L.parseKey(k), { store: "firefox-container-3", videoId: "abc123XYZ_-" });
});

test("parseKey ignores non-position keys", () => {
  assert.strictEqual(L.parseKey("settings"), null);
  assert.strictEqual(L.parseKey("enabledContainers"), null);
});

test("isPosKey", () => {
  assert.strictEqual(L.isPosKey("p:default|x"), true);
  assert.strictEqual(L.isPosKey("positions"), false);
});

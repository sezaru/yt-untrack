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

test("prune drops entries older than 90 days and malformed ones", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const store = {
    "p:default|fresh": { t: 5, d: 100, updated: now - 10 * day },
    "p:default|old":   { t: 5, d: 100, updated: now - 91 * day },
    "p:default|nostamp": { t: 5, d: 100 },
    "settings": { resumeEverywhere: true },
  };
  const removed = L.prune(store, now);
  assert.deepStrictEqual(removed.sort(), ["p:default|nostamp", "p:default|old"].sort());
  assert.ok(store["p:default|fresh"]);
  assert.ok(store["settings"]);
});

test("barWidthPct clamps and handles unknown duration", () => {
  assert.strictEqual(L.barWidthPct(30, 100), 30);
  assert.strictEqual(L.barWidthPct(150, 100), 100);
  assert.strictEqual(L.barWidthPct(-5, 100), 0);
  assert.strictEqual(L.barWidthPct(30, undefined), null);
  assert.strictEqual(L.barWidthPct(30, 0), null);
});

test("isFinished at >=95%", () => {
  assert.strictEqual(L.isFinished(95, 100), true);
  assert.strictEqual(L.isFinished(94.9, 100), false);
  assert.strictEqual(L.isFinished(10, undefined), false);
});

test("videoIdFromHref extracts v param, rejects non-watch", () => {
  assert.strictEqual(L.videoIdFromHref("/watch?v=abc123XYZ_-&t=10"), "abc123XYZ_-");
  assert.strictEqual(L.videoIdFromHref("https://www.youtube.com/watch?v=zzz"), "zzz");
  assert.strictEqual(L.videoIdFromHref("/shorts/abc"), null);
  assert.strictEqual(L.videoIdFromHref("/@channel"), null);
  assert.strictEqual(L.videoIdFromHref(null), null);
});

test("DEFAULTS", () => {
  assert.deepStrictEqual(L.DEFAULTS, { resumeEverywhere: true, watchedBadges: true });
});

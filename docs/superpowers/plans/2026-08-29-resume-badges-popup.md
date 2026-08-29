# Resume-everywhere, Watched Badges, Popup Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend yt-untrack with local resume on all videos (private-container resume stays always-on, tracked-container resume behind a toggle), "watched" thumbnail badges in private containers, and a redesigned system-themed popup — all on a memory-frugal per-video storage layer.

**Architecture:** A new dual-export `lib.js` holds all pure logic (storage keys, migration, prune, bar math, finish detection, href parsing) and is loaded both as a classic content/background script (`self.YtuLib`) and via `require` in `node --test`. Storage moves from one fat `positions` object to one key per video (`p:<store>|<vid>` → `{t,d,updated}`); the resume path reads one key and the badge path batch-reads only visible keys, so memory stays flat. `background.js` is the policy holder (knows each tab's container + settings) and answers content-script queries; `content.js` handles watch-page resume; a new `badges.js` content script handles feed thumbnails.

**Tech Stack:** Vanilla JS, WebExtensions MV2 (Firefox/Zen), `browser.*` APIs, `node --test` (built-in) for unit tests, `web-ext run` for manual browser testing. No bundler, no runtime deps.

**Reference spec:** `docs/superpowers/specs/2026-08-29-resume-badges-popup-design.md`

**Node for tests:** this machine has no `node` on PATH by default; run tests with
`PATH=/nix/store/4ic3pjy002lm3rw8jdn4zkalx53zamxw-nodejs-24.19.0/bin:$PATH node --test`
(or whatever `node` resolves to in your environment).

---

## File Structure

- **Create `lib.js`** — pure helpers, dual-export (`self.YtuLib` for the browser, `module.exports` for node). One responsibility: deterministic data/format logic with zero `browser.*` or DOM access.
- **Create `test/lib.test.js`** — `node --test` unit tests for `lib.js`.
- **Modify `background.js`** — per-key storage; settings; migration on install; prune off the hot path; policy-aware message handlers (`getResume`, `savePosition`, `clearPosition`, `getBadgeState`, `lookupPositions`).
- **Modify `content.js`** — resume in all containers (save always; restore always for untracked, toggle-gated for tracked) with bounded re-apply that overrides YouTube's resume; a debug currentTime timeline logger.
- **Create `badges.js`** — feed/thumbnail badge injector (throttled MutationObserver → batched `lookupPositions` → rAF inject → data-attr marking); listens to `storage.onChanged` to refresh on new watches.
- **Modify `manifest.json`** — load `lib.js` before `background.js`; add `lib.js` + `badges.js` to content scripts; bump version.
- **Modify `popup.html` / `popup.js`** — layout A (two global toggles on top + container checklist), system theme via `prefers-color-scheme`.

**Message contract (background is the policy holder):**
- `getResume {videoId}` → `{t, d}` if this tab should restore (untracked always; tracked iff `settings.resumeEverywhere`), else `null`.
- `savePosition {videoId, t, d}` → `true`. Saves in **any** container (data must exist regardless of toggle).
- `clearPosition {videoId}` → `true`.
- `getBadgeState {}` → `{active}` — `true` iff this tab's container is untracked **and** `settings.watchedBadges`.
- `lookupPositions {videoIds:[…]}` → `{ [videoId]: {t, d} }` for hits in this tab's container (badge batch read).

**Settings** (`storage.local.settings`): `{ resumeEverywhere: true, watchedBadges: true }` (both default on).

---

## Chunk 1: Data layer (`lib.js` + tests + migration)

### Task 1: Scaffold `lib.js` with dual export and storage-key helpers

**Files:**
- Create: `lib.js`
- Test: `test/lib.test.js`

- [ ] **Step 1: Write the failing test**

`test/lib.test.js`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — cannot find module `../lib.js`.

- [ ] **Step 3: Write minimal implementation**

`lib.js`:
```js
(function (root) {
  const P_PREFIX = "p:";

  function posKey(store, videoId) {
    return P_PREFIX + store + "|" + videoId;
  }

  function isPosKey(key) {
    return typeof key === "string" && key.startsWith(P_PREFIX);
  }

  function parseKey(key) {
    if (!isPosKey(key)) return null;
    const rest = key.slice(P_PREFIX.length);
    const i = rest.indexOf("|");
    if (i < 0) return null;
    return { store: rest.slice(0, i), videoId: rest.slice(i + 1) };
  }

  const api = { P_PREFIX, posKey, isPosKey, parseKey };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YtuLib = api;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib.js test/lib.test.js
git commit -m "feat(lib): storage-key helpers with node tests"
```

### Task 2: `prune`, `barWidthPct`, `isFinished`, `videoIdFromHref`, `DEFAULTS`

**Files:**
- Modify: `lib.js`
- Test: `test/lib.test.js`

- [ ] **Step 1: Write the failing tests** (append)

```js
test("prune drops entries older than 90 days and malformed ones", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const store = {
    "p:default|fresh": { t: 5, d: 100, updated: now - 10 * day },
    "p:default|old":   { t: 5, d: 100, updated: now - 91 * day },
    "p:default|nostamp": { t: 5, d: 100 },
    "settings": { resumeEverywhere: true },       // untouched non-pos key
  };
  const removed = L.prune(store, now);
  assert.deepStrictEqual(removed.sort(), ["p:default|nostamp", "p:default|old"].sort());
  assert.ok(store["p:default|fresh"]);
  assert.ok(store["settings"]);                    // never touches non-pos keys
});

test("barWidthPct clamps and handles unknown duration", () => {
  assert.strictEqual(L.barWidthPct(30, 100), 30);
  assert.strictEqual(L.barWidthPct(150, 100), 100);   // clamp high
  assert.strictEqual(L.barWidthPct(-5, 100), 0);      // clamp low
  assert.strictEqual(L.barWidthPct(30, undefined), null); // unknown length → no bar
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
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — `L.prune is not a function`, etc.

- [ ] **Step 3: Implement** (add to `lib.js` before the `api` object; extend `api`)

```js
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const FINISH_RATIO = 0.95;
  const DEFAULTS = { resumeEverywhere: true, watchedBadges: true };

  // Mutates `store`, returns the list of removed keys. Only touches p: keys.
  function prune(store, now) {
    const removed = [];
    for (const key of Object.keys(store)) {
      if (!isPosKey(key)) continue;
      const v = store[key];
      if (!v || typeof v.updated !== "number" || now - v.updated > NINETY_DAYS_MS) {
        delete store[key];
        removed.push(key);
      }
    }
    return removed;
  }

  function barWidthPct(t, d) {
    if (!d || !Number.isFinite(d) || d <= 0) return null;
    const pct = (t / d) * 100;
    if (pct < 0) return 0;
    if (pct > 100) return 100;
    return pct;
  }

  function isFinished(t, d) {
    return !!d && Number.isFinite(d) && t >= d * FINISH_RATIO;
  }

  function videoIdFromHref(href) {
    if (typeof href !== "string") return null;
    const q = href.indexOf("?");
    if (q < 0 || !href.slice(0, q).includes("/watch")) return null;
    return new URLSearchParams(href.slice(q)).get("v");
  }
```
Add `NINETY_DAYS_MS, FINISH_RATIO, DEFAULTS, prune, barWidthPct, isFinished, videoIdFromHref` to `api`.

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/lib.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib.js test/lib.test.js
git commit -m "feat(lib): prune, bar math, finish detection, href parsing"
```

### Task 3: Legacy migration helper

**Files:**
- Modify: `lib.js`
- Test: `test/lib.test.js`

- [ ] **Step 1: Failing test** (append)

```js
test("migrateLegacy converts old positions blob to per-video keys", () => {
  const legacy = {
    "firefox-default|aaa": { t: 12, updated: 111 },
    "firefox-container-2|bbb": { t: 34, updated: 222 },
  };
  const { sets, removeKeys } = L.migrateLegacy(legacy);
  assert.deepStrictEqual(sets, {
    "p:firefox-default|aaa": { t: 12, d: undefined, updated: 111 },
    "p:firefox-container-2|bbb": { t: 34, d: undefined, updated: 222 },
  });
  assert.deepStrictEqual(removeKeys, ["positions"]);
});

test("migrateLegacy on empty/absent blob is a no-op", () => {
  assert.deepStrictEqual(L.migrateLegacy(undefined), { sets: {}, removeKeys: [] });
  assert.deepStrictEqual(L.migrateLegacy({}), { sets: {}, removeKeys: [] });
});
```

- [ ] **Step 2: Run — fail** (`node --test test/lib.test.js`).

- [ ] **Step 3: Implement**

```js
  // Pure: turns a legacy `positions` object into { sets, removeKeys } for the caller
  // to write. Legacy entries have no duration → d: undefined (renders pill, no bar).
  function migrateLegacy(legacyPositions) {
    const sets = {};
    if (!legacyPositions || typeof legacyPositions !== "object") {
      return { sets, removeKeys: [] };
    }
    const entries = Object.entries(legacyPositions);
    for (const [oldKey, v] of entries) {
      const i = oldKey.indexOf("|");
      if (i < 0 || !v) continue;
      const store = oldKey.slice(0, i);
      const videoId = oldKey.slice(i + 1);
      sets[posKey(store, videoId)] = { t: v.t, d: undefined, updated: v.updated };
    }
    return { sets, removeKeys: entries.length ? ["positions"] : [] };
  }
```
Add `migrateLegacy` to `api`.

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Commit**

```bash
git add lib.js test/lib.test.js
git commit -m "feat(lib): legacy positions migration helper"
```

### Task 4: Wire `lib.js` into the extension and migrate on install

**Files:**
- Modify: `manifest.json`
- Modify: `background.js:30-80` (replace the resume-storage section)

- [ ] **Step 1: Load `lib.js` before `background.js`**

In `manifest.json`, change `"background": { "scripts": ["background.js"] }` to:
```json
"background": { "scripts": ["lib.js", "background.js"] }
```

- [ ] **Step 2: Replace the positions section of `background.js`** (the block from the `NINETY_DAYS_MS` comment through the `onMessage` handler) with per-key storage + settings + migration. Full replacement:

```js
// --- Settings ------------------------------------------------------------
let settings = { ...YtuLib.DEFAULTS };

async function loadSettings() {
  const { settings: s = {} } = await browser.storage.local.get("settings");
  settings = { ...YtuLib.DEFAULTS, ...s };
}

// --- Migration + prune ---------------------------------------------------
async function migrateAndPrune() {
  const all = await browser.storage.local.get(null); // full scan: install/prune only
  const { sets, removeKeys } = YtuLib.migrateLegacy(all.positions);
  if (Object.keys(sets).length) await browser.storage.local.set(sets);
  const posOnly = {};
  for (const [k, v] of Object.entries({ ...all, ...sets })) {
    if (YtuLib.isPosKey(k)) posOnly[k] = v;
  }
  const removedPrune = YtuLib.prune(posOnly, Date.now()); // mutates posOnly copy
  const toRemove = [...removeKeys, ...removedPrune];
  if (toRemove.length) await browser.storage.local.remove(toRemove);
}

// --- Position message handlers ------------------------------------------
function shouldRestore(storeId) {
  return untracked.has(storeId) || settings.resumeEverywhere;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const storeId = sender.tab && sender.tab.cookieStoreId;
  if (!storeId || !msg) return Promise.resolve(null);

  if (msg.type === "getBadgeState") {
    return Promise.resolve({ active: untracked.has(storeId) && settings.watchedBadges });
  }

  if (msg.type === "lookupPositions") {
    const ids = Array.isArray(msg.videoIds) ? msg.videoIds : [];
    const keys = ids.map((v) => YtuLib.posKey(storeId, v));
    return browser.storage.local.get(keys).then((got) => {
      const out = {};
      for (const id of ids) {
        const e = got[YtuLib.posKey(storeId, id)];
        if (e) out[id] = { t: e.t, d: e.d };
      }
      return out;
    });
  }

  const videoId = msg.videoId;
  if (!videoId) return Promise.resolve(null);
  const key = YtuLib.posKey(storeId, videoId);

  if (msg.type === "getResume") {
    if (!shouldRestore(storeId)) return Promise.resolve(null);
    return browser.storage.local.get(key).then((got) => {
      const e = got[key];
      return e ? { t: e.t, d: e.d } : null;
    });
  }
  if (msg.type === "savePosition") {
    // Save in ANY container regardless of toggle, so data exists to resume later.
    return browser.storage.local
      .set({ [key]: { t: msg.t, d: msg.d, updated: Date.now() } })
      .then(() => true);
  }
  if (msg.type === "clearPosition") {
    return browser.storage.local.remove(key).then(() => true);
  }
  return Promise.resolve(null);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) loadSettings();
});

browser.runtime.onInstalled.addListener(migrateAndPrune);
```

Also update the bottom bootstrap line from `loadEnabled().then(refreshAllBadges);` to:
```js
Promise.all([loadEnabled(), loadSettings()]).then(refreshAllBadges);
```
(Keep the existing `loadEnabled`, `enabledContainers` listener, `webRequest` blocker, and toolbar-badge code — `refreshAllBadges`/`updateBadge` — unchanged.)

- [ ] **Step 3: Manual smoke test — migration**

Seed old data, then load the extension:
1. `PATH=…/node --version` sanity, then run `web-ext run` (`npm start`) with a temp profile.
2. In the extension's background console (`about:debugging` → Inspect), before this build you'd have a `positions` object; after `onInstalled`, run:
   `browser.storage.local.get(null).then(console.log)`
   Expected: no `positions` key; per-video `p:…` keys present; `settings` present.

Note: `onInstalled` fires on install/update/reload of a temporary add-on — good enough to exercise migration during `web-ext run`.

- [ ] **Step 4: Run unit tests again** (unchanged, still green):

Run: `node --test test/lib.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add manifest.json background.js
git commit -m "feat(bg): per-video storage, settings, install migration + prune"
```

---

## Chunk 2: Feature 1 — resume everywhere (`content.js`)

### Task 5: Save duration + save/restore across all containers, toggle-aware

**Files:**
- Modify: `manifest.json` (content_scripts js list)
- Modify: `content.js` (whole file — extend existing logic)

**Design notes for the implementer:**
- `content.js` already saves on interval/pause/visibility/unload and restores on navigate. The only functional gaps for Feature 1 are: **(a)** include duration `d` when saving; **(b)** the restore now applies whenever `getResume` returns non-null (background already encodes the untracked-always / tracked-if-toggle policy, so `content.js` needs no policy of its own); **(c)** override YouTube's own resume with a **bounded re-apply loop** rather than the single 1s re-apply.
- Do NOT gate saving on anything in the content script — always attempt to save; background decides storage. (Background saves in any container.) This is what lets a later toggle-on resume.

- [ ] **Step 1: Load `lib.js` before `content.js`** in `manifest.json`:
```json
"content_scripts": [
  {
    "matches": ["*://*.youtube.com/*"],
    "js": ["lib.js", "content.js", "badges.js"],
    "run_at": "document_idle"
  }
]
```
(`badges.js` is created in Chunk 3; adding it now is fine — it will be an empty-safe file. If executing strictly in order, add `badges.js` to this list in Task 8 instead.)

- [ ] **Step 2: Update `positionNow` to send duration**

Replace the body of `positionNow()` so the save includes `d`:
```js
function positionNow() {
  const v = getVideo();
  if (!v || !v.duration || !currentVideoId) return;
  const { currentTime, duration } = v;
  if (YtuLib.isFinished(currentTime, duration)) {
    send("clearPosition");
  } else if (currentTime > 0) {
    send("savePosition", { t: currentTime, d: duration });
  }
}
```

- [ ] **Step 3: Replace single re-apply with a bounded override loop**

Replace `restore()` with:
```js
const OVERRIDE_WINDOW_MS = 3000;
const MAX_REAPPLY = 3;

// Returns true if this tab is resume-active (so we should attach save listeners).
async function restore() {
  const resume = await send("getResume");
  // Even if there's no stored position, we still want to SAVE here going
  // forward, so attach unless background says "not for this tab" (null).
  if (!resume) return true;
  if (typeof resume.t !== "number" || urlHasTimestamp()) return true;

  const v = await waitForVideo();
  if (!v) return true;

  const target = resume.t;
  const applyId = currentVideoId;
  let count = 0;
  const start = Date.now();

  const apply = () => {
    const cur = getVideo();
    if (!cur || currentVideoId !== applyId) return;      // navigated away
    if (Math.abs(cur.currentTime - target) > 2) {        // YouTube moved us
      cur.currentTime = target;
    }
  };

  apply(); // immediate
  // YouTube applies its own resume asynchronously; re-assert ours a few times,
  // then stop so we never fight the user's manual seeking.
  const timer = setInterval(() => {
    if (count >= MAX_REAPPLY || Date.now() - start > OVERRIDE_WINDOW_MS ||
        currentVideoId !== applyId) {
      clearInterval(timer);
      return;
    }
    count++;
    apply();
  }, 600);

  return true;
}
```

Note: with this change, `getResume` returning `null` from background means "background chose not to restore here" (tracked container + toggle off) — but we still return `true` so saving stays active. That matches the spec: save always, restore per policy.

- [ ] **Step 4: Manual test — resume on a normal video** (see `## Manual Test Matrix` at the end; run cases (a) finished, (b) resume, (d) `&t=`). Use `web-ext run`.

- [ ] **Step 5: Commit**

```bash
git add manifest.json content.js
git commit -m "feat(content): resume everywhere with bounded override of YouTube resume"
```

### Task 6: Debug currentTime timeline logger

**Files:**
- Modify: `content.js`

**Purpose:** the spec's "test this well" requirement — make the YouTube-vs-us seek ordering observable.

- [ ] **Step 1: Add a debug flag + logger**

At the top of `content.js`:
```js
// Flip on via: browser.storage.local.set({debugResume: true}) in the bg console.
let DEBUG = false;
browser.storage.local.get("debugResume").then((r) => (DEBUG = !!r.debugResume));
browser.storage.onChanged.addListener((c, a) => {
  if (a === "local" && c.debugResume) DEBUG = !!c.debugResume.newValue;
});
function dlog(...args) {
  if (DEBUG) console.log("[ytu-resume]", `${(performance.now() / 1000).toFixed(2)}s`, ...args);
}
```

- [ ] **Step 2: Instrument seek points**

In `apply()`, log before/after: `dlog("apply target", target, "was", cur.currentTime)`.
In `attach()`, add a one-shot `seeked` listener while DEBUG that logs external seeks:
```js
if (DEBUG) v.addEventListener("seeked", () => dlog("seeked ->", v.currentTime));
```
On `getResume` result, `dlog("getResume", resume)`.

- [ ] **Step 3: Manual verify — timeline visible**

1. `web-ext run`, open bg console, `browser.storage.local.set({debugResume:true})`.
2. Open a normal video watched previously; open the page console (content-script logs appear in the tab console).
3. Expected: a timeline showing `getResume`, our `apply target`, YouTube's `seeked ->`, and our re-applies landing last.

- [ ] **Step 4: Commit**

```bash
git add content.js
git commit -m "feat(content): debug currentTime timeline for resume testing"
```

---

## Chunk 3: Feature 2 — watched badges (`badges.js`)

### Task 7: Badge injector — activation gate + one-shot scan

**Files:**
- Create: `badges.js`
- (manifest already lists it from Task 5 Step 1; if not, add it now)

**Design notes:**
- Runs on every YouTube page but must be **inert unless** `getBadgeState` returns `{active:true}` (untracked container + badges toggle on).
- Thumbnails are `<a>` anchors with `href="/watch?v=…"` inside `ytd-thumbnail` / rich-grid / search / sidebar. Select broadly: `a#thumbnail[href]`. This is the selector most stable across surfaces; refine if a surface is missed.
- Mark processed nodes with `data-ytu="1"` so they're never reprocessed.
- Injected DOM: a `.ytu-pill` ("👁 watched") + a `.ytu-bar` (teal, width `t/d`), appended into the thumbnail anchor (which is `position:relative` in YouTube's CSS; if not, set it).

- [ ] **Step 1: Create `badges.js` with the activation gate and a manual scan (no observer yet)**

```js
// Watched-video badges for private (untracked) containers only. Inert elsewhere.
(function () {
  const MARK = "data-ytu";
  const PILL_CLASS = "ytu-pill";
  const BAR_CLASS = "ytu-bar";
  let active = false;

  function injectStyles() {
    if (document.getElementById("ytu-badge-style")) return;
    const s = document.createElement("style");
    s.id = "ytu-badge-style";
    s.textContent = `
      .${PILL_CLASS}{position:absolute;top:8px;left:8px;z-index:40;display:inline-flex;
        align-items:center;gap:4px;background:rgba(224,85,85,.95);color:#fff;
        font:600 11px system-ui,sans-serif;padding:2px 8px;border-radius:20px;pointer-events:none}
      .${BAR_CLASS}{position:absolute;left:0;bottom:0;height:4px;background:#3ec8b0;z-index:40;pointer-events:none}
    `;
    document.documentElement.appendChild(s);
  }

  function thumbAnchors() {
    return document.querySelectorAll(`a#thumbnail[href]:not([${MARK}])`);
  }

  function decorate(anchor, entry) {
    if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
    const pill = document.createElement("div");
    pill.className = PILL_CLASS;
    pill.textContent = "👁 watched";
    anchor.appendChild(pill);
    const w = YtuLib.barWidthPct(entry.t, entry.d);
    if (w !== null) {
      const bar = document.createElement("div");
      bar.className = BAR_CLASS;
      bar.style.width = w + "%";
      anchor.appendChild(bar);
    }
  }

  async function scan() {
    if (!active) return;
    const anchors = [...thumbAnchors()];
    if (!anchors.length) return;
    const byId = new Map();
    for (const a of anchors) {
      const id = YtuLib.videoIdFromHref(a.getAttribute("href"));
      a.setAttribute(MARK, "1"); // mark now; never reprocess even on miss
      if (id) byId.set(a, id);
    }
    const ids = [...new Set([...byId.values()])];
    if (!ids.length) return;
    const hits = await browser.runtime.sendMessage({ type: "lookupPositions", videoIds: ids })
      .catch(() => null);
    if (!hits) return;
    requestAnimationFrame(() => {
      for (const [a, id] of byId) {
        const entry = hits[id];
        if (entry) decorate(a, entry);
      }
    });
  }

  async function init() {
    const state = await browser.runtime.sendMessage({ type: "getBadgeState" }).catch(() => null);
    active = !!(state && state.active);
    if (!active) return;
    injectStyles();
    scan();
  }

  init();
  window.__ytuBadgeScan = scan; // exposed for Task 8 observer + tests
})();
```

- [ ] **Step 2: Manual test — badges appear only in private container**

1. `web-ext run`. In a container marked untracked, watch a video partway, then go to the home feed.
2. Expected: that video's thumbnail shows the pill + teal bar.
3. Repeat in a **tracked** container → **no** add-on badge appears.

- [ ] **Step 3: Commit**

```bash
git add badges.js manifest.json
git commit -m "feat(badges): watched pill + teal bar, private containers only"
```

### Task 8: Throttled MutationObserver + refresh on new watches

**Files:**
- Modify: `badges.js`

- [ ] **Step 1: Add a debounced observer and a storage-change refresh**

Inside the IIFE, after `init()` sets up, add (guard so it only runs when active):
```js
  let scanTimer = null;
  function scheduleScan() {
    if (!active) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
  }

  function startObserver() {
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Refresh when a position is written for THIS container while we're on a feed:
  // clear the mark on the matching thumbnail so the next scan re-decorates it.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !active) return;
    let touched = false;
    for (const key of Object.keys(changes)) {
      if (!YtuLib.isPosKey(key)) continue;
      const parsed = YtuLib.parseKey(key);
      if (!parsed) continue;
      document.querySelectorAll(`a#thumbnail[${MARK}]`).forEach((a) => {
        if (YtuLib.videoIdFromHref(a.getAttribute("href")) === parsed.videoId) {
          a.removeAttribute(MARK);
          a.querySelectorAll(`.${PILL_CLASS}, .${BAR_CLASS}`).forEach((n) => n.remove());
          touched = true;
        }
      });
    }
    if (touched) scheduleScan();
  });
```
Call `startObserver()` at the end of `init()` (only when `active`).

- [ ] **Step 2: Manual test — infinite scroll + smoothness**

1. `web-ext run` in a private container; open home; scroll a long way.
2. Expected: badges appear on watched videos as they load; scrolling stays smooth (no jank).
3. Sanity on cost: DevTools Performance record a few seconds of scroll → no long tasks attributable to the extension. Note in commit if anything shows up.

- [ ] **Step 3: Manual test — live refresh**

Watch a new video in the private container, return to a feed already showing it → its thumbnail gains the badge without a reload.

- [ ] **Step 4: Commit**

```bash
git add badges.js
git commit -m "feat(badges): throttled observer + live refresh on new watches"
```

---

## Chunk 4: Feature 3 — popup redesign

### Task 9: Layout A markup + system theme

**Files:**
- Modify: `popup.html`

- [ ] **Step 1: Rewrite `popup.html`** with the two toggle rows on top, the container list below, and `prefers-color-scheme` theming. Structure:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      :root{
        --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e6e6e6;
        --accent:#e05555; --sw-off:#c9ccd6;
      }
      @media (prefers-color-scheme: dark){
        :root{ --bg:#1b1d26; --fg:#e8e8ea; --muted:#9aa; --line:#2a2e3d; --sw-off:#3a3f55; }
      }
      body{font:13px system-ui,sans-serif;margin:0;padding:0;min-width:300px;
           background:var(--bg);color:var(--fg)}
      .head{padding:14px 16px 8px;font-weight:700}
      .label{font-size:10.5px;text-transform:uppercase;letter-spacing:.7px;
             color:var(--muted);padding:8px 16px 4px}
      .row{display:flex;align-items:center;gap:10px;padding:8px 16px}
      .row .grow{flex:1}
      .row .desc{font-size:11px;color:var(--muted);margin-top:1px}
      .divider{height:1px;background:var(--line);margin:6px 0}
      .sw{width:34px;height:20px;border-radius:20px;background:var(--sw-off);
          position:relative;flex:none;cursor:pointer;transition:.2s}
      .sw[aria-checked="true"]{background:var(--accent)}
      .sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
                 border-radius:50%;background:#fff;transition:.2s}
      .sw[aria-checked="true"]::after{left:16px}
      .dot{width:10px;height:10px;border-radius:50%;flex:none}
      .cont{cursor:pointer}
      .empty{color:var(--muted);padding:6px 16px}
    </style>
  </head>
  <body>
    <div class="head">yt-untrack</div>

    <div class="label">Global</div>
    <div class="row">
      <div class="grow">Resume where I left off
        <div class="desc">All videos, every container</div></div>
      <div class="sw" id="sw-resume" role="switch" tabindex="0" aria-checked="true"></div>
    </div>
    <div class="row">
      <div class="grow">Watched badges
        <div class="desc">Mark private videos in the feed</div></div>
      <div class="sw" id="sw-badges" role="switch" tabindex="0" aria-checked="true"></div>
    </div>

    <div class="divider"></div>
    <div class="label">Untrack these containers</div>
    <div id="list"><span class="empty">Loading…</span></div>

    <script src="lib.js"></script>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Manual visual check** — open the popup; toggle light/dark at the OS level and confirm the popup follows. (No behavior yet — wired in Task 10.)

- [ ] **Step 3: Commit**

```bash
git add popup.html
git commit -m "feat(popup): layout A markup + system light/dark theme"
```

### Task 10: Popup toggle + container wiring

**Files:**
- Modify: `popup.js`

- [ ] **Step 1: Rewrite `popup.js`** to render container checkboxes (as today) plus wire the two switches to `storage.local.settings`:

```js
const DEFAULT = { cookieStoreId: "firefox-default", name: "Default (no container)", colorCode: "#888" };

async function getSettings() {
  const { settings = {} } = await browser.storage.local.get("settings");
  return { ...YtuLib.DEFAULTS, ...settings };
}
async function setSetting(key, val) {
  const s = await getSettings();
  s[key] = val;
  await browser.storage.local.set({ settings: s });
}

function wireSwitch(el, key, initial) {
  el.setAttribute("aria-checked", String(initial));
  const flip = async () => {
    const next = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(next));
    await setSetting(key, next);
  };
  el.addEventListener("click", flip);
  el.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
  });
}

async function toggleContainer(cookieStoreId, on) {
  const { enabledContainers = [] } = await browser.storage.local.get("enabledContainers");
  const cur = new Set(enabledContainers);
  if (on) cur.add(cookieStoreId); else cur.delete(cookieStoreId);
  await browser.storage.local.set({ enabledContainers: [...cur] });
}

async function render() {
  const [identities, { enabledContainers = [] }, settings] = await Promise.all([
    browser.contextualIdentities.query({}),
    browser.storage.local.get("enabledContainers"),
    getSettings(),
  ]);
  wireSwitch(document.getElementById("sw-resume"), "resumeEverywhere", settings.resumeEverywhere);
  wireSwitch(document.getElementById("sw-badges"), "watchedBadges", settings.watchedBadges);

  const enabled = new Set(enabledContainers);
  const list = document.getElementById("list");
  list.textContent = "";
  for (const id of [DEFAULT, ...identities]) {
    const row = document.createElement("label");
    row.className = "row cont";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabled.has(id.cookieStoreId);
    cb.addEventListener("change", () => toggleContainer(id.cookieStoreId, cb.checked));
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = id.colorCode || "#888";
    const name = document.createElement("span");
    name.className = "grow";
    name.textContent = id.name;
    row.append(cb, dot, name);
    list.append(row);
  }
}

render();
```

Note: `popup.html` now loads `lib.js` before `popup.js`, so `YtuLib.DEFAULTS` is available. `contextualIdentities` is already a permission.

- [ ] **Step 2: Manual test — toggles persist and take effect**

1. `web-ext run`. Open popup, flip "Resume where I left off" off.
2. `browser.storage.local.get("settings")` in bg console → `resumeEverywhere:false`.
3. In a **tracked** container, a previously-resumed normal video should now open at YouTube's position (ours suppressed). In a **private** container, resume still works (always-on). This validates the spec's toggle-scope decision.
4. Flip "Watched badges" off → feed badges disappear on next navigation.

- [ ] **Step 3: Commit**

```bash
git add popup.js
git commit -m "feat(popup): wire global toggles + container list"
```

### Task 11: Version bump + lint

**Files:**
- Modify: `manifest.json`, `package.json`

- [ ] **Step 1:** Bump `manifest.json` `version` and `package.json` `version` to `0.3.0`.
- [ ] **Step 2:** Run `npm run lint` (`web-ext lint`); expected: no errors (warnings about MV2 are acceptable).
- [ ] **Step 3:** Run unit tests once more: `node --test test/lib.test.js` → PASS.
- [ ] **Step 4: Commit**

```bash
git add manifest.json package.json
git commit -m "chore: bump to 0.3.0"
```

---

## Manual Test Matrix (run under `web-ext run`)

**Feature 1 — resume competition (the "test well" requirement):**
- (a) **Finished:** watch a normal video to >95%, close, reopen → starts fresh (no stale resume).
- (b) **Resume:** watch a normal video to a known time (e.g. 5:00), close, reopen → resumes to ~5:00 (our value), confirmed via the debug timeline showing our seek landing after YouTube's.
- (c) **Desync (local wins):** advance the same video to a *different* time on another device (so YouTube's server position differs), reopen on desktop → local position wins.
- (d) **Explicit `&t=`:** open `…watch?v=…&t=90s` → we defer to the URL (no override).
- (e) **Toggle off (tracked):** turn "Resume where I left off" off → normal videos open at YouTube's position; **private-container videos still resume** (always-on).

**Feature 2 — badges:**
- (f) Watched private videos show the pill + teal bar in the private-container feed.
- (g) The same videos show **no** add-on badge in a tracked container.
- (h) Long-feed scroll stays smooth; DevTools Performance shows no extension long-tasks.
- (i) Watching a new private video refreshes its feed thumbnail live (no reload).
- (j) Legacy-migrated entries (no `d`) show the pill with **no** bar (never a zero-width/garbage bar).

**Feature 3 — popup:**
- (k) Popup follows OS light/dark.
- (l) Both toggles persist across popup reopen and take effect as in (e)/(g).

## Notes / gotchas for the implementer

- **Content-script logs** appear in the *page* console (the YouTube tab's devtools), not the background console. Background logs are in `about:debugging` → Inspect.
- **`onInstalled`** fires when a temporary add-on is (re)loaded, so `web-ext run` exercises migration; to re-test migration, reseed a `positions` object and reload.
- **`a#thumbnail` selector**: if a surface (search, watch-next sidebar, Shorts shelf) isn't badged, widen the selector — but keep excluding Shorts (`videoIdFromHref` already returns null for `/shorts/`). Record any selector additions in the commit.
- **Never add a `storage.local.get(null)` on a hot path** — it's for migration/prune only (spec hard rule).
- **`d === undefined`** must render pill-only (no bar); `barWidthPct` returns `null` for unknown/zero duration — rely on it, never coerce to 0.

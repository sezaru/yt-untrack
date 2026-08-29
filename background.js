// Cancels YouTube's watch-tracking pings (/api/stats/*) for tabs that live in an
// "untracked" container. Everything else is untouched, so the account stays signed
// in (premium, no ads) while the video is never recorded to history / recommendations.

let untracked = new Set(); // cookieStoreIds the user opted into

async function loadEnabled() {
  const {enabledContainers = []} = await browser.storage.local.get("enabledContainers");
  untracked = new Set(enabledContainers);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabledContainers) {
    untracked = new Set(changes.enabledContainers.newValue || []);
    refreshAllBadges();
  }
  if (area === "local" && changes.settings) loadSettings();
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.cookieStoreId && untracked.has(details.cookieStoreId)) {
      return {cancel: true};
    }
    return {};
  },
  {urls: ["*://*.youtube.com/api/stats/*"]},
  ["blocking"],
);

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
// Where we record positions: untracked containers always; normal ones only when the
// "resume everywhere" toggle is on. Restoring is NOT gated by this — see getResume.
function shouldSave(storeId) {
  return untracked.has(storeId) || settings.resumeEverywhere;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const storeId = sender.tab && sender.tab.cookieStoreId;
  if (!storeId || !msg) return Promise.resolve(null);

  if (msg.type === "getBadgeState") {
    // Badges surface "watched via an untracked container" in EVERY container, so the
    // gate is the setting alone — the lookup below restricts hits to untracked stores.
    return Promise.resolve({ active: !!settings.watchedBadges });
  }

  if (msg.type === "lookupPositions") {
    const ids = Array.isArray(msg.videoIds) ? msg.videoIds : [];
    const stores = [...untracked]; // a video "seen via untracked" can live in any of them
    if (!ids.length || !stores.length) return Promise.resolve({});
    const keys = [];
    for (const id of ids) for (const c of stores) keys.push(YtuLib.posKey(c, id));
    return browser.storage.local.get(keys).then((got) => {
      const out = {};
      for (const id of ids) {
        for (const c of stores) {
          const e = got[YtuLib.posKey(c, id)];
          if (e) { out[id] = { t: e.t, d: e.d }; break; }
        }
      }
      return out;
    });
  }

  const videoId = msg.videoId;
  if (!videoId) return Promise.resolve(null);
  const key = YtuLib.posKey(storeId, videoId);

  if (msg.type === "getResume") {
    // Always restore if we have a position (never gated by the toggle) so our seek wins
    // over YouTube's. Untracked ("real" private) watches are authoritative — checked first;
    // fall back to this container's own position when the video was never watched privately.
    const stores = [...untracked, storeId].filter((c, i, a) => a.indexOf(c) === i);
    const keys = stores.map((c) => YtuLib.posKey(c, videoId));
    return browser.storage.local.get(keys).then((got) => {
      for (const c of stores) {
        const e = got[YtuLib.posKey(c, videoId)];
        if (e) return { t: e.t, d: e.d };
      }
      return null;
    });
  }
  if (msg.type === "savePosition") {
    if (!shouldSave(storeId)) return Promise.resolve(false);
    return browser.storage.local
      .set({ [key]: { t: msg.t, d: msg.d, updated: Date.now() } })
      .then(() => true);
  }
  if (msg.type === "clearPosition") {
    return browser.storage.local.remove(key).then(() => true);
  }
  return Promise.resolve(null);
});

browser.runtime.onInstalled.addListener(migrateAndPrune);

async function updateBadge(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    const on = untracked.has(tab.cookieStoreId);
    await browser.browserAction.setBadgeText({tabId, text: on ? "●" : ""});
    await browser.browserAction.setBadgeBackgroundColor({tabId, color: "#e05555"});
  } catch (_) {
    // tab gone / not accessible
  }
}

async function refreshAllBadges() {
  for (const tab of await browser.tabs.query({})) updateBadge(tab.id);
}

browser.tabs.onActivated.addListener(({tabId}) => updateBadge(tabId));
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status) updateBadge(tabId);
});

Promise.all([loadEnabled(), loadSettings()]).then(refreshAllBadges);

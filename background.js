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

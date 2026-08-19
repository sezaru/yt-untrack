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

// --- Local resume positions (untracked containers only) ------------------
// storage.local.positions: { "<cookieStoreId>|<videoId>": { t, updated } }

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function posKey(cookieStoreId, videoId) {
  return `${cookieStoreId}|${videoId}`;
}

async function getPositions() {
  const {positions = {}} = await browser.storage.local.get("positions");
  return positions;
}

function prune(positions, now) {
  for (const [k, v] of Object.entries(positions)) {
    if (!v || typeof v.updated !== "number" || now - v.updated > NINETY_DAYS_MS) {
      delete positions[k];
    }
  }
  return positions;
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const storeId = sender.tab && sender.tab.cookieStoreId;
  if (!storeId || !untracked.has(storeId)) return Promise.resolve(null);
  const videoId = msg && msg.videoId;
  if (!videoId) return Promise.resolve(null);
  const key = posKey(storeId, videoId);

  if (msg.type === "getResume") {
    return getPositions().then((positions) => {
      const entry = positions[key];
      return {t: entry ? entry.t : null};
    });
  }
  if (msg.type === "savePosition") {
    return getPositions().then((positions) => {
      positions[key] = {t: msg.t, updated: Date.now()};
      prune(positions, Date.now());
      return browser.storage.local.set({positions}).then(() => true);
    });
  }
  if (msg.type === "clearPosition") {
    return getPositions().then((positions) => {
      delete positions[key];
      return browser.storage.local.set({positions}).then(() => true);
    });
  }
  return Promise.resolve(null);
});

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

loadEnabled().then(refreshAllBadges);

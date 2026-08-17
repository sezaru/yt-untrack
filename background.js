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

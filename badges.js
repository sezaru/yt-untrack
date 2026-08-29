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

  async function init() {
    const state = await browser.runtime.sendMessage({ type: "getBadgeState" }).catch(() => null);
    active = !!(state && state.active);
    if (!active) return;
    injectStyles();
    scan();
    startObserver();
  }

  init();
  window.__ytuBadgeScan = scan; // exposed for Task 8 observer + tests
})();

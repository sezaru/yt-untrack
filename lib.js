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

  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const FINISH_RATIO = 0.95;
  const DEFAULTS = { resumeEverywhere: true, watchedBadges: true };

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

  const api = {
    P_PREFIX,
    posKey,
    isPosKey,
    parseKey,
    NINETY_DAYS_MS,
    FINISH_RATIO,
    DEFAULTS,
    prune,
    barWidthPct,
    isFinished,
    videoIdFromHref,
    migrateLegacy,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YtuLib = api;
})(typeof self !== "undefined" ? self : this);

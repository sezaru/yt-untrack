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

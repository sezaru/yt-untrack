#!/usr/bin/env bash
# Build the TEST xpi from the pristine repo source (../) + append the E2E bridges.
# The repo source is never modified. Output: e2e/ytu.xpi
set -e
E2E="$(cd "$(dirname "$0")" && pwd)"
SRC="$(dirname "$E2E")"
EXT="$E2E/ext"
rm -rf "$EXT"; mkdir -p "$EXT"
cp "$SRC"/manifest.json "$SRC"/lib.js "$SRC"/background.js "$SRC"/content.js "$SRC"/badges.js "$SRC"/popup.html "$SRC"/popup.js "$EXT"/
cp -r "$SRC"/icons "$EXT"/

NODE=/nix/store/4ic3pjy002lm3rw8jdn4zkalx53zamxw-nodejs-24.19.0/bin/node

# Anti-detection (test build only): a document_start content script that injects a
# page-world script masking navigator.webdriver before YouTube's JS reads it.
cat > "$EXT/e2e-mask.js" <<'EOF'
// runs in the isolated content world at document_start; injects into the PAGE world
(function () {
  const code = `(() => {
    try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
  })();`;
  const s = document.createElement("script");
  s.textContent = code;
  (document.head || document.documentElement).prepend(s);
  s.remove();
})();
EOF
# register the mask at document_start in the test manifest
"$NODE" -e '
  const fs=require("fs"), p=process.argv[1];
  const m=JSON.parse(fs.readFileSync(p,"utf8"));
  m.content_scripts.unshift({matches:["*://*.youtube.com/*"],js:["e2e-mask.js"],run_at:"document_start",all_frames:true});
  fs.writeFileSync(p, JSON.stringify(m,null,2));
' "$EXT/manifest.json"

# Background Port relay (test build only). A Port channel (onConnect) — the repo uses
# onMessage, so this can't clash. Gives the content bridge access to the privileged
# contextualIdentities/tabs APIs that content scripts lack.
cat >> "$EXT/background.js" <<'EOF'

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "ytu-e2e") return;
  port.onMessage.addListener(async (m) => {
    let res = null;
    try {
      if (m.op === "createContainer") {
        const q = await browser.contextualIdentities.query({ name: m.name });
        const id = q[0] || (await browser.contextualIdentities.create({ name: m.name, color: "purple", icon: "circle" }));
        res = id.cookieStoreId;
      } else if (m.op === "openTab") {
        const t = await browser.tabs.create({ url: m.url, cookieStoreId: m.store, active: true });
        res = t.id;
      } else if (m.op === "removeContainer") {
        const q = await browser.contextualIdentities.query({ name: m.name });
        for (const i of q) await browser.contextualIdentities.remove(i.cookieStoreId);
        res = true;
      } else if (m.op === "listContainers") {
        res = await browser.contextualIdentities.query({});
      }
    } catch (e) { res = "ERR:" + e.message; }
    port.postMessage({ id: m.id, res });
  });
});
EOF

# Content-script debug bridge (test build only). Reachable from page world via postMessage.
cat >> "$EXT/content.js" <<'EOF'

// --- E2E test bridge (test build only; not shipped) -----------------------
window.__ytuLog = [];
(function () {
  const orig = console.log.bind(console);
  console.log = function (...a) {
    if (a[0] === "[ytu-resume]") window.__ytuLog.push(a.slice(1).join(" "));
    return orig(...a);
  };
  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (!m || m.__ytu !== "req") return;
    let res = null;
    try {
      if (m.op === "set") res = await send("savePosition", { t: m.t, d: m.d || 600 });
      else if (m.op === "get") res = await send("getResume");
      else if (m.op === "clear") res = await send("clearPosition");
      else if (m.op === "id") res = currentVideoId;
      else if (m.op === "storageSet") { await browser.storage.local.set(m.obj); res = true; }
      else if (m.op === "storageGet") res = await browser.storage.local.get(m.keys || null);
      else if (m.op === "storageClear") { await browser.storage.local.clear(); res = true; }
      else if (m.op === "bg") res = await new Promise((resolve) => {
        const port = browser.runtime.connect({ name: "ytu-e2e" });
        const rid = Math.random();
        port.onMessage.addListener((msg) => { if (msg.id === rid) { resolve(msg.res); port.disconnect(); } });
        port.postMessage(Object.assign({ id: rid }, m.bg));
      });
    } catch (err) { res = "ERR:" + err.message; }
    window.postMessage({ __ytu: "res", id: m.id, res }, "*");
  });
})();
EOF

cd "$EXT" && rm -f "$E2E/ytu.xpi" && zip -r -q "$E2E/ytu.xpi" .
echo "xpi built: $E2E/ytu.xpi"

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

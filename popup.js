const DEFAULT = {cookieStoreId: "firefox-default", name: "Default (no container)", colorCode: "#888"};

async function toggle(cookieStoreId, on) {
  const {enabledContainers = []} = await browser.storage.local.get("enabledContainers");
  const cur = new Set(enabledContainers);
  if (on) cur.add(cookieStoreId);
  else cur.delete(cookieStoreId);
  await browser.storage.local.set({enabledContainers: [...cur]});
}

async function render() {
  const list = document.getElementById("list");
  const [identities, {enabledContainers = []}] = await Promise.all([
    browser.contextualIdentities.query({}),
    browser.storage.local.get("enabledContainers"),
  ]);
  const enabled = new Set(enabledContainers);

  list.textContent = "";
  for (const id of [DEFAULT, ...identities]) {
    const label = document.createElement("label");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabled.has(id.cookieStoreId);
    cb.addEventListener("change", () => toggle(id.cookieStoreId, cb.checked));

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = id.colorCode || "#888";

    label.append(cb, dot, document.createTextNode(id.name));
    list.append(label);
  }
}

render();

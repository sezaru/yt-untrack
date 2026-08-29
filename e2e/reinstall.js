// Hot-swap the rebuilt test xpi into the LIVE session (uninstall old, install new)
// without losing the browser/login. Use after editing build-xpi.sh or repo source.
const fs = require("fs");
const path = require("path");
const { WebDriver, Session } = require("selenium-webdriver");
const { Command } = require("selenium-webdriver/lib/command");
const http = require("selenium-webdriver/http");

const DIR = __dirname;
const sid = fs.readFileSync(path.join(DIR, "session.txt"), "utf8").trim();
const executor = new http.Executor(new http.HttpClient("http://localhost:4444"));
executor.defineCommand("installAddon", "POST", "/session/:sessionId/moz/addon/install");
executor.defineCommand("uninstallAddon", "POST", "/session/:sessionId/moz/addon/uninstall");
const driver = new WebDriver(new Session(sid, {}), executor);

(async () => {
  try {
    await driver.execute(new Command("uninstallAddon").setParameter("sessionId", sid).setParameter("id", "yt-untrack@sezdm.com"));
    console.log("uninstalled old");
  } catch (e) { console.log("uninstall skipped:", e.message.split("\n")[0]); }
  const id = await driver.execute(
    new Command("installAddon").setParameter("sessionId", sid).setParameter("path", path.join(DIR, "ytu.xpi")).setParameter("temporary", true)
  );
  console.log("installed:", id);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

// Start a Firefox session on the running geckodriver (:4444) using the checked-in
// persistent profile (YouTube login survives), install the TEST xpi as a temporary
// add-on, open YouTube, and record the sessionId for the test scripts to attach to.
// Leaves the browser OPEN (does not quit) so it can be driven and hand-inspected.
const fs = require("fs");
const path = require("path");
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

const DIR = __dirname;
const PROFILE = path.join(DIR, "profile");
const FF = fs.readFileSync(path.join(DIR, "ffpath.txt"), "utf8").trim();
const XPI = path.join(DIR, "ytu.xpi");

(async () => {
  const opts = new firefox.Options().setBinary(FF).addArguments("-profile", PROFILE);
  const driver = await new Builder()
    .forBrowser("firefox")
    .usingServer("http://localhost:4444")
    .setFirefoxOptions(opts)
    .build();

  const sid = (await driver.getSession()).getId();
  fs.writeFileSync(path.join(DIR, "session.txt"), sid);
  const ext = await driver.installAddon(XPI, true);
  console.log("installed addon:", ext);
  await driver.get("https://www.youtube.com");
  console.log("SESSION", sid, "ready — browser open on your display");
  process.exit(0);
})().catch((e) => { console.error("START FAILED:", e.message); process.exit(1); });

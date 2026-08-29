// Shared E2E harness helpers. Attaches to the live geckodriver session started by
// start.js and exposes: the extension debug bridge, YouTube player controls, and
// small polling utilities. Test scripts under tests/ import from here.
//
// The bridge only exists in the TEST build of the extension (e2e/build-xpi.sh appends
// it); the repo source stays pristine. Bridge ops: get/set/clear/id, storage{Set,Get,Clear},
// and `bg` (a Port relay into the privileged background context for
// contextualIdentities/tabs — content scripts lack those APIs).
const fs = require("fs");
const path = require("path");
const { WebDriver, Session, By } = require("selenium-webdriver");
const http = require("selenium-webdriver/http");

const DIR = __dirname;
const SERVER = "http://localhost:4444";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attach() {
  const sid = fs.readFileSync(path.join(DIR, "session.txt"), "utf8").trim();
  const executor = new http.Executor(new http.HttpClient(SERVER));
  return new WebDriver(new Session(sid, {}), executor);
}

// --- extension debug bridge (page -> content script) ---------------------
async function bridge(driver, op, extra = {}) {
  return driver.executeAsyncScript(function (op, extra) {
    const done = arguments[arguments.length - 1];
    const id = Math.random();
    function onMsg(e) {
      if (e.data && e.data.__ytu === "res" && e.data.id === id) {
        window.removeEventListener("message", onMsg);
        done(e.data.res);
      }
    }
    window.addEventListener("message", onMsg);
    window.postMessage(Object.assign({ __ytu: "req", id, op }, extra), "*");
    setTimeout(() => done("BRIDGE_TIMEOUT"), 12000);
  }, op, extra);
}
const bg = (driver, obj) => bridge(driver, "bg", { bg: obj }); // privileged background op

// --- YouTube player controls (run in page world) -------------------------
const P = "var p=document.getElementById('movie_player');";
async function ct(driver) {
  return driver.executeScript(P + "var v=document.querySelector('video');return p&&p.getCurrentTime?+p.getCurrentTime().toFixed(2):(v?+v.currentTime.toFixed(2):null);");
}
async function dur(driver) {
  return driver.executeScript(P + "return p&&p.getDuration?+p.getDuration().toFixed(1):0;");
}
async function state(driver) {
  return driver.executeScript(P + "return p&&p.getPlayerState?p.getPlayerState():null;"); // 1 play 2 pause 3 buffer -1 unstarted
}
async function adShowing(driver) {
  return driver.executeScript("return !!document.querySelector('.ad-showing,.ytp-ad-player-overlay,.ytp-ad-text,.ytp-ad-skip-button-modern');");
}
async function seekTo(driver, t) {
  await driver.executeScript(P + "if(p&&p.seekTo)p.seekTo(arguments[0],true);", t);
}
async function play(driver) {
  await driver.executeScript(P + "if(p){try{p.mute();}catch(e){} if(p.playVideo)p.playVideo();}");
}
// Grant real user activation — YouTube's media pipeline stalls at readyState 1 under
// automation until a trusted gesture arrives. A synthetic Selenium click supplies it.
async function activate(driver) {
  try { await driver.manage().window().maximize(); } catch (_) {}
  try {
    const el = await driver.findElement(By.css("#movie_player video"));
    await driver.actions({ async: true }).move({ origin: el }).click().perform();
  } catch (_) {}
  await play(driver);
}
async function hasError(driver) {
  return driver.executeScript("return !!document.querySelector('.ytp-error');");
}
// Robustly get the video actually playing (clock advancing). Retries the gesture and the
// 'k' hotkey, and reloads once on YouTube's intermittent playback error. Returns true if
// the clock advanced. This is the reliable path — a single click is flaky under automation.
async function ensurePlaying(driver, ms = 30000) {
  try { await driver.manage().window().maximize(); } catch (_) {}
  const t0 = Date.now();
  let reloaded = false;
  while (Date.now() - t0 < ms) {
    if (await hasError(driver)) {
      if (!reloaded) { reloaded = true; await driver.navigate().refresh(); await waitContent(driver); }
      else { await sleep(1000); }
    }
    const start = await ct(driver);
    try {
      const btns = await driver.findElements(By.css(".ytp-large-play-button"));
      const target = btns.length ? btns[0] : await driver.findElement(By.css("#movie_player video"));
      await driver.actions({ async: true }).move({ origin: target }).click().perform();
    } catch (_) {}
    await driver.executeScript(P + "if(p){try{p.mute();}catch(e){} p.playVideo&&p.playVideo();}");
    await sleep(1500);
    if ((await state(driver)) === 1 && (await ct(driver)) > (start || 0) + 0.4) return true;
    try { await driver.actions({ async: true }).sendKeys("k").perform(); } catch (_) {}
    await sleep(1200);
    if ((await state(driver)) === 1 && (await ct(driver)) > (start || 0) + 0.4) return true;
  }
  return (await state(driver)) === 1;
}
// Wait until the player is actually playing and the clock advances.
async function waitPlaying(driver, ms = 12000) {
  const start = await ct(driver);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await state(driver)) === 1 && (await ct(driver)) > (start || 0) + 1) return true;
    await sleep(500);
  }
  return false;
}
// Wait for the real content video (skips any pre-roll ad) — returns its duration.
async function waitContent(driver, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = await dur(driver);
    if (d > 60 && !(await adShowing(driver))) return d;
    await driver.executeScript("var b=document.querySelector('.ytp-ad-skip-button-modern,.ytp-ad-skip-button,.ytp-skip-ad-button');if(b)b.click();").catch(() => {});
    await sleep(500);
  }
  return dur(driver);
}
async function waitNear(driver, target, tol, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const c = await ct(driver);
    if (c != null && Math.abs(c - target) <= tol) return true;
    await sleep(150);
  }
  return false;
}

// --- window handling -----------------------------------------------------
async function newContentTab(driver, url, cookieStoreId) {
  const before = await driver.getAllWindowHandles();
  if (cookieStoreId) {
    await bg(driver, { op: "openTab", url, store: cookieStoreId });
  } else {
    await driver.switchTo().newWindow("tab");
    await driver.get(url);
    return driver.getWindowHandle();
  }
  await sleep(1800);
  const h = (await driver.getAllWindowHandles()).find((x) => !before.includes(x));
  if (!h) throw new Error("new tab handle not found");
  await driver.switchTo().window(h);
  return h;
}
async function closeTab(driver, fallback) {
  try { await driver.close(); } catch (_) {}
  if (fallback) await driver.switchTo().window(fallback);
}

module.exports = {
  sleep, attach, bridge, bg,
  ct, dur, state, adShowing, seekTo, play, activate, ensurePlaying, hasError, waitPlaying, waitContent, waitNear,
  newContentTab, closeTab,
};

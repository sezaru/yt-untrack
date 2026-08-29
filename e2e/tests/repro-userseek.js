// Regression: a real user seek must be respected — the override must yield, not yank the
// user back to our saved position. (The ad-aware onTime re-apply is guarded by !userSeeking.)
const { By, Key } = require("selenium-webdriver");
const H = require("../harness");

const V = "aqz-KE-bpKQ", WATCH = "https://www.youtube.com/watch?v=" + V;
const CONT = "firefox-container-7", PRIV = 120, KEY = "p:" + CONT + "|" + V;

(async () => {
  const d = H.attach();
  await d.manage().setTimeouts({ script: 40000 });
  if (!/youtube/.test(await d.getCurrentUrl())) await d.get("https://www.youtube.com");
  await H.bridge(d, "storageClear");
  await H.bridge(d, "storageSet", { obj: { enabledContainers: [CONT], settings: { resumeEverywhere: false, watchedBadges: true }, debugResume: true, [KEY]: { t: PRIV, d: 634.6, updated: Date.now() } } });

  await H.newContentTab(d, WATCH, null);
  await H.waitContent(d);
  await H.ensurePlaying(d);
  console.log("restored to:", Math.round(await H.ct(d)), "(should be ~120)");

  // trusted keyboard seek forward (ArrowRight x8 -> +40s), must be respected
  await d.executeScript("var p=document.getElementById('movie_player');if(p&&p.focus)p.focus();");
  await H.sleep(300);
  for (let i = 0; i < 8; i++) { await d.actions({ async: true }).sendKeys(Key.ARROW_RIGHT).perform(); await H.sleep(150); }
  const afterSeek = await H.ct(d);
  await H.sleep(3500); // give the override a chance to (wrongly) yank back
  const settled = await H.ct(d);
  console.log("right after user seek:", Math.round(afterSeek), "| 3.5s later:", Math.round(settled));
  const respected = settled > PRIV + 20; // user moved forward and it stuck
  const yanked = Math.abs(settled - PRIV) < 8;
  console.log("VERDICT:", respected ? "USER SEEK RESPECTED ✓" : yanked ? "YANKED BACK — BUG ✗" : "inconclusive (ct=" + Math.round(settled) + ")");
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });

// Reproduce the real bug: yt-untrack has a saved local position for a video; opening it
// in a NORMAL tab must resume there — but with REAL playback the video plays from 0:00
// and the add-on fails to hold its restore. Captures the ct trajectory + the extension's
// own [ytu-resume] debug log (window.__ytuLog).
const H = require("../harness");

const V = "aqz-KE-bpKQ", WATCH = "https://www.youtube.com/watch?v=" + V;
const CONT = "firefox-container-7";
const PRIV = 120;
const KEY = "p:" + CONT + "|" + V;

(async () => {
  const d = H.attach();
  await d.manage().setTimeouts({ script: 40000 });
  if (!/youtube/.test(await d.getCurrentUrl())) await d.get("https://www.youtube.com");

  // clean + seed a local saved position (as if watched privately to 2:00 in the container)
  await H.bridge(d, "storageClear");
  await H.bridge(d, "storageSet", { obj: {
    enabledContainers: [CONT],
    settings: { resumeEverywhere: false, watchedBadges: true },
    debugResume: true,
    [KEY]: { t: PRIV, d: 634.6, updated: 1 },
  }});
  console.log("seeded", KEY, "= 120; opening NORMAL tab with real playback");

  // open normal tab, get REAL playback going
  await H.newContentTab(d, WATCH, null);
  await H.waitContent(d);
  const played = await H.ensurePlaying(d, 30000);

  // capture the trajectory over ~22s
  const traj = [];
  for (let i = 0; i < 22; i++) { traj.push(await H.ct(d)); await H.sleep(1000); }
  console.log("ct trajectory:", traj.map((x) => (x == null ? "?" : Math.round(x))).join(" "));

  // what the extension logged about its restore attempt
  const log = await d.executeScript("return (window.__ytuLog||[]).slice(0,40);");
  console.log("\n[ytu-resume] log:");
  (log || []).forEach((l) => console.log("   ", l));

  const finalCt = traj[traj.length - 1];
  console.log("\nplayed?", played, "| final ct:", Math.round(finalCt),
    "->", (finalCt > PRIV - 20 && finalCt < PRIV + 40) ? "RESTORED to ~2:00 ✓" : "PLAYED FROM 0 — BUG REPRODUCED ✗");
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });

// Hunt the intermittent local-restore failure. Each run: clean+seed 120, open a NORMAL
// tab, and sample currentTime AS SOON as the video exists (mimicking a real cold open with
// no activation delay), then watch where it settles. Reports start vs settle per run.
const H = require("../harness");

const V = "aqz-KE-bpKQ", WATCH = "https://www.youtube.com/watch?v=" + V;
const CONT = "firefox-container-7", PRIV = 120, KEY = "p:" + CONT + "|" + V;
const RUNS = Number(process.env.RUNS || 6);

async function firstVideoCt(d, ms = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const c = await d.executeScript("var v=document.querySelector('video');return v&&v.readyState>=1?v.currentTime:null;");
    if (c != null) return c;
    await H.sleep(150);
  }
  return null;
}

(async () => {
  const d = H.attach();
  await d.manage().setTimeouts({ script: 40000 });
  if (!/youtube/.test(await d.getCurrentUrl())) await d.get("https://www.youtube.com");
  const results = [];
  for (let r = 0; r < RUNS; r++) {
    await H.bridge(d, "storageClear");
    await H.bridge(d, "storageSet", { obj: { enabledContainers: [CONT], settings: { resumeEverywhere: false, watchedBadges: true }, debugResume: true, [KEY]: { t: PRIV, d: 634.6, updated: Date.now() } } });
    const handle = await H.newContentTab(d, WATCH, null);
    const first = await firstVideoCt(d);
    // let it run ~7s without our activation clicks (closer to real autoplay)
    await d.executeScript("var p=document.getElementById('movie_player');if(p){try{p.mute()}catch(e){}p.playVideo&&p.playVideo()}");
    await H.sleep(7000);
    const settle = await H.ct(d);
    const ok = settle != null && settle > PRIV - 20 && settle < PRIV + 60;
    results.push({ run: r + 1, first: first == null ? "?" : Math.round(first), settle: Math.round(settle || 0), ok });
    console.log(`run ${r + 1}: first=${first == null ? "?" : Math.round(first)} settle=${Math.round(settle || 0)} -> ${ok ? "restored" : "FROM 0 ✗"}`);
    await H.closeTab(d, (await d.getAllWindowHandles())[0]);
    await H.sleep(500);
  }
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n${fails}/${RUNS} runs FAILED to restore (started from 0)`);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });

// The ad case the user flagged: YouTube reuses ONE <video> for the pre-roll ad AND the
// content. restore() sees the ad's video first (readyState>=1), applies the target to the
// AD, and when content loads it may play from 0. Reproduce with a monetized video in a
// SIGNED-OUT container (fresh cookie jar => pre-roll ads), local position seeded.
const H = require("../harness");

const V = process.env.VID || "dQw4w9WgXcQ"; // Rick Astley (monetized -> ads when signed out)
const WATCH = "https://www.youtube.com/watch?v=" + V;
const CONT = "firefox-container-7", PRIV = 90, KEY = "p:" + CONT + "|" + V;

(async () => {
  const d = H.attach();
  await d.manage().setTimeouts({ script: 40000 });
  if (!/youtube/.test(await d.getCurrentUrl())) await d.get("https://www.youtube.com");

  await H.bridge(d, "storageClear");
  await H.bridge(d, "storageSet", { obj: { enabledContainers: [CONT], settings: { resumeEverywhere: false, watchedBadges: true }, debugResume: true, [KEY]: { t: PRIV, d: 213, updated: Date.now() } } });

  // fresh signed-out container -> ads
  const store = await H.bg(d, { bg: { op: "createContainer", name: "ytu-signedout" } });
  console.log("signed-out container:", store, "| seeded", KEY, "= 90");
  await H.newContentTab(d, WATCH, store);

  // wait (up to 110s) for the ad(s) to end, skipping aggressively, then sample content
  const t0 = Date.now();
  let sawAd = false, contentSeen = false;
  const contentTraj = [];
  while (Date.now() - t0 < 110000) {
    const s = await d.executeScript(`return (function(){
      var v=document.querySelector('video');var p=document.getElementById('movie_player');
      return {ct:v?v.currentTime:null, ad:!!document.querySelector('.ad-showing,.ytp-ad-player-overlay,.ytp-ad-text,.ytp-ad-skip-button-modern'), dur:p&&p.getDuration?Math.round(p.getDuration()):0};
    })()`);
    if (s.ad) { sawAd = true; await d.executeScript("var b=document.querySelector('.ytp-ad-skip-button-modern,.ytp-ad-skip-button,.ytp-skip-ad-button');if(b)b.click();"); }
    else if (s.dur > 60 && s.ct != null) { // content phase
      contentSeen = true;
      contentTraj.push(Math.round(s.ct));
      if (contentTraj.length >= 8) break; // ~8 content samples is enough
    }
    await H.sleep(1000);
  }
  console.log("saw pre-roll ad:", sawAd, "| reached content:", contentSeen);
  console.log("content ct trajectory:", contentTraj.join(" "));

  // correct: the restore may flash 0 for one frame, then seek to ~90 and play forward.
  // What matters is where the CONTENT settles — the last sample must be at/past ~90.
  const settle = contentTraj[contentTraj.length - 1];
  const reached = Math.max(...contentTraj);
  const ok = contentSeen && settle != null && settle > PRIV - 15;
  console.log("\nVERDICT:", !contentSeen ? "inconclusive (ad never ended in 110s)" :
    ok ? `RESTORED — content settled at ${settle} (reached ${reached}) ✓✓✓ fix works` : `CONTENT STUCK NEAR 0 (settle=${settle}) — BUG ✗`);

  // cleanup the signed-out container
  await H.closeTab(d, (await d.getAllWindowHandles())[0]);
  await H.bg(d, { bg: { op: "removeContainer", name: "ytu-signedout" } });
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });

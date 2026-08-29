// THE bug the user hit: after watching a video privately in an untracked container,
// opening it in a NORMAL tab must resume at the PRIVATE position — not YouTube's own
// server-side position from a prior normal watch.
//
//   1. clean yt-untrack data (keep the container config)
//   2. NORMAL tab: seek to 5:00, play ~15s   (YouTube's server records ~5:00)
//   3. reload -> confirm YouTube's server resumes ~5:00
//   4. close tab
//   5. UNTRACKED CONTAINER: open same video, seek to 2:00, let it save
//   6. confirm yt-untrack stored ~2:00 for the container
//   7. NORMAL tab again, same video
//   8. it must land on 2:00 (ours), NOT 5:00 (YouTube's) -> SUCCESS
//
// Runs with resumeEverywhere:false so step 3 is a clean proof of YouTube's server
// position (our extension neither saves nor restores in a normal tab); the container's
// private position is authoritative regardless of that toggle. Restores the toggle at end.
const H = require("../harness");

const V = process.env.VID || "aqz-KE-bpKQ"; // Big Buck Bunny (~10:34)
const WATCH = `https://www.youtube.com/watch?v=${V}`;
const CONT = "firefox-container-7";
const DEF = 300; // 5:00
const PRIV = 120; // 2:00
const KEY = `p:${CONT}|${V}`;

(async () => {
  const d = H.attach();
  await d.manage().setTimeouts({ script: 30000 });
  const log = (...a) => console.log(...a);

  // make sure the content bridge is present
  if (!/youtube\.com/.test(await d.getCurrentUrl())) await d.get("https://www.youtube.com");

  // (1) clean: wipe positions, re-establish container config, toggle OFF for a clean proof
  await H.bridge(d, "storageClear");
  await H.bridge(d, "storageSet", { obj: {
    enabledContainers: [CONT],
    settings: { resumeEverywhere: false, watchedBadges: true },
    debugResume: true,
  }});
  log("[1] cleaned; enabledContainers=[" + CONT + "], resumeEverywhere=false");

  // (2) NORMAL tab: seek to 5:00, genuinely play ~18s (YouTube needs real playback to record)
  const defHandle = await H.newContentTab(d, WATCH, null);
  await H.waitContent(d);
  await H.activate(d); // trusted gesture — else the media pipeline stalls under automation
  await H.seekTo(d, DEF);
  await H.play(d);
  const playing = await H.waitPlaying(d, 12000);
  log("[2] normal tab: sought to", DEF, "playing?", playing, "ct now", await H.ct(d));
  await H.sleep(18000);
  await d.executeScript("var p=document.getElementById('movie_player');p.pauseVideo&&p.pauseVideo();"); // pause -> watchtime ping
  await H.sleep(2500);
  log("    after ~20s ct=", await H.ct(d), "state=", await H.state(d));

  // (3) reload -> YouTube's server should resume ~5:00
  await d.navigate().refresh();
  await H.waitContent(d);
  await H.sleep(4000);
  const reloadCt = await H.ct(d);
  const ourAfterReload = await H.bridge(d, "storageGet", { keys: [`p:firefox-default|${V}`] });
  const serverSaved = reloadCt > DEF - 40 && reloadCt < DEF + 60;
  log("[3] after reload ct=", reloadCt, "->", serverSaved ? "YouTube SERVER resumed ~5:00 ✓" : "NOT resumed to 5:00");
  log("    (our extension's default-tab store, should be empty:", JSON.stringify(ourAfterReload), ")");

  // (4) close normal tab
  await H.closeTab(d, null);
  const rest = await d.getAllWindowHandles();
  await d.switchTo().window(rest[0]);

  // (5) UNTRACKED CONTAINER: open same video, seek to 2:00, let it save
  const contHandle = await H.newContentTab(d, WATCH, CONT);
  await H.waitContent(d);
  await H.activate(d);
  log("[5] container tab loaded; ct on load=", await H.ct(d), "(may be YouTube's server 5:00)");
  await H.seekTo(d, PRIV);
  await H.play(d);
  await H.sleep(1500);
  // guard: if YouTube's server yanked us back toward 5:00, re-assert 2:00
  if ((await H.ct(d)) > PRIV + 40) { log("    (container got pulled toward server pos; re-seeking 2:00)"); await H.seekTo(d, PRIV); }
  await H.sleep(7000); // let the 5s save interval fire on ~2:00
  log("    container ct after play=", await H.ct(d));

  // (6) confirm yt-untrack stored ~2:00 for the container
  const stored = await H.bridge(d, "storageGet", { keys: [KEY] });
  const s = stored[KEY];
  const savedOk = s && s.t > PRIV - 15 && s.t < PRIV + 40;
  log("[6] stored", KEY, "=", JSON.stringify(s), "->", savedOk ? "saved ~2:00 ✓" : "NOT ~2:00 ✗");

  // (7) close container tab, open a NORMAL tab on the same video
  await H.closeTab(d, rest[0]);
  const contResumeStore = await H.bridge(d, "storageGet", { keys: [KEY] }); // re-read (container save may update on close)
  log("    (post-close container store:", JSON.stringify(contResumeStore[KEY]), ")");
  const defHandle2 = await H.newContentTab(d, WATCH, null);
  await H.waitContent(d);
  await H.activate(d); // play it so YouTube's server-resume actually fires and we see the fight

  // (8) it must land on 2:00 (ours), not 5:00 (YouTube's). Poll the fight for 20s.
  log("[8] normal tab; watching the resume fight (ours 2:00 vs YouTube server 5:00):");
  const traj = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { traj.push(await H.ct(d)); await H.sleep(1000); }
  const finalCt = await H.ct(d);
  log("    ct trajectory:", traj.map((x) => (x == null ? "?" : Math.round(x))).join(" "));
  const landedPrivate = finalCt > PRIV - 20 && finalCt < PRIV + 25;
  const landedServer = finalCt > DEF - 30 && finalCt < DEF + 60;
  log("    final ct=", finalCt, "->",
    landedPrivate ? "PRIVATE 2:00 (SUCCESS ✓)" : landedServer ? "SERVER 5:00 (BUG REPRODUCED ✗)" : "neither");

  log("\nSUMMARY:", {
    step3_youtube_server_saved_5min: serverSaved ? "PASS" : "INCONCLUSIVE(ct=" + reloadCt + ")",
    step6_private_saved_2min: savedOk ? "PASS" : "FAIL",
    step8_normal_tab_resumes_private: landedPrivate ? "PASS" : landedServer ? "FAIL(server won)" : "INCONCLUSIVE(ct=" + finalCt + ")",
  });

  // restore the user's toggle + clean debug flag
  await H.bridge(d, "storageSet", { obj: { settings: { resumeEverywhere: true, watchedBadges: true } } });
})().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });

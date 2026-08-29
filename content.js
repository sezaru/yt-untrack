// Local resume, everywhere. Since we cancel YouTube's watchtime pings in
// untracked containers, the account no longer remembers position there — so we
// always save locally, in every container. Whether to restore on load is the
// background's call (untracked always, tracked only if resumeEverywhere is on);
// this script just asks via getResume and applies whatever it's told.

const SAVE_INTERVAL_MS = 5000;

// Flip on via: browser.storage.local.set({debugResume: true}) in the bg console.
let DEBUG = false;
browser.storage.local.get("debugResume").then((r) => (DEBUG = !!r.debugResume));
browser.storage.onChanged.addListener((c, a) => {
  if (a === "local" && c.debugResume) DEBUG = !!c.debugResume.newValue;
});
function dlog(...args) {
  if (DEBUG) console.log("[ytu-resume]", `${(performance.now() / 1000).toFixed(2)}s`, ...args);
}

let currentVideoId = null;
let activeVideo = null;
let saveTimer = null;
let lastRestoreUrl = null; // dedupe restore across the double load-time onNavigate fire

function videoIdFromUrl() {
  return new URLSearchParams(location.search).get("v");
}

function getVideo() {
  return document.querySelector("video");
}

// YouTube's player API lives in the PAGE world; from a content script the #movie_player
// element only exposes its methods through .wrappedJSObject (Firefox). Setting the raw
// <video>.currentTime does NOT move the player's authoritative position — while paused the
// player re-applies its own resume on play — so we drive player.seekTo() / getCurrentTime().
function ytPlayer() {
  const mp = document.getElementById("movie_player");
  if (!mp) return null;
  try { return mp.wrappedJSObject || mp; } catch (e) { return mp; }
}
function playerTime() {
  try {
    const p = ytPlayer();
    return p && typeof p.getCurrentTime === "function" ? p.getCurrentTime() : null;
  } catch (e) {
    return null;
  }
}

// YouTube's own resume position for this load (it delivers it by appending &t= to the watch
// URL and/or via playbackStartConfig.startSeconds). Used to recognise — and override — it.
function ytServerStartSeconds() {
  try {
    const w = window.wrappedJSObject || window;
    const psc = w.ytInitialPlayerResponse &&
      w.ytInitialPlayerResponse.playerConfig &&
      w.ytInitialPlayerResponse.playerConfig.playbackStartConfig;
    const s = psc && psc.startSeconds;
    return typeof s === "number" ? s : null;
  } catch (e) {
    return null;
  }
}

async function send(type, extra) {
  try {
    return await browser.runtime.sendMessage({type, videoId: currentVideoId, ...extra});
  } catch (_) {
    return null; // background asleep / tab closing — best effort
  }
}

// Resolve once the player has metadata (so setting currentTime sticks).
function waitForVideo(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const v = getVideo();
      if (v && v.readyState >= 1) return resolve(v);
      if (Date.now() - start > timeoutMs) return resolve(v || null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

function positionNow() {
  const v = getVideo();
  if (!v || !v.duration || !currentVideoId) return;
  const {currentTime, duration} = v;
  if (YtuLib.isFinished(currentTime, duration)) {
    send("clearPosition"); // finished → forget it
  } else if (currentTime > 0) {
    send("savePosition", {t: currentTime, d: duration});
  }
}

function onPause() {
  positionNow();
}

function onEnded() {
  send("clearPosition");
}

function detach() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (activeVideo) {
    activeVideo.removeEventListener("pause", onPause);
    activeVideo.removeEventListener("ended", onEnded);
    activeVideo = null;
  }
}

function attach() {
  const v = getVideo();
  if (!v) return;
  activeVideo = v;
  v.addEventListener("pause", onPause);
  v.addEventListener("ended", onEnded);
  saveTimer = setInterval(positionNow, SAVE_INTERVAL_MS);
}

const OVERRIDE_CAP_MS = 30000; // budget of *content* playback time to keep guarding
const OVERRIDE_BACKSTOP_MS = 300000; // absolute cleanup, in case timeupdate never fires
const GESTURE_MS = 1500;

// Restore our saved position, beating both YouTube's own resume and a pre-roll ad.
//
// YouTube delivers its resume by appending &t=<pos> to the URL and seeking the player there
// (startSeconds) — so we no longer bail on a present ?t=; ours is authoritative and overrides
// it. Because the raw <video>.currentTime doesn't move the player while paused, we drive the
// page-world player API (seekTo) and detect position via getCurrentTime. YouTube's resume is
// gesture-free and lands at a known value, so we re-assert whenever the player sits there —
// via a `seeked` (autoplay), a `timeupdate` (playing), or a poll (a paused new tab, or a seek
// that fired before our listeners armed). A user's own seek carries a pointer/key gesture and
// a different value, so it's respected. Pre-roll ads reuse the ONE <video>: we never seek the
// ad and don't let the guard expire while one plays. Listens at document/capture to survive
// the <video> swap; disarms once content plays forward past our target.
async function restore() {
  const resume = await send("getResume");
  if (!resume || typeof resume.t !== "number") return true;

  const urlT = new URLSearchParams(location.search).get("t");
  const v = await waitForVideo();
  if (!v) return true;

  const target = resume.t;
  const applyId = currentVideoId;
  let done = false;
  let pointerDown = false;
  let gestureUntil = 0;
  let deadline = performance.now() + OVERRIDE_CAP_MS;

  const isAd = () => !!document.querySelector(".ad-showing, .ytp-ad-player-overlay, .ytp-ad-text");

  let ytResumePos = urlT != null ? parseFloat(urlT) : null;
  if (ytResumePos == null) ytResumePos = ytServerStartSeconds();
  // The player sits at YouTube's resume (not near our target) with no user gesture → override.
  const atYtResume = (t) => ytResumePos != null && Math.abs(t - ytResumePos) < 3 && Math.abs(t - target) > 3;

  const onDown = () => { pointerDown = true; gestureUntil = performance.now() + GESTURE_MS; };
  const onUp = () => { pointerDown = false; gestureUntil = performance.now() + GESTURE_MS; };
  const onKey = () => (gestureUntil = performance.now() + GESTURE_MS);
  const userSeeking = () => pointerDown || performance.now() < gestureUntil;

  const apply = () => {
    const cur = getVideo();
    if (!cur || isAd()) return; // never seek the ad; wait for the content video
    const p = ytPlayer();
    const pt = playerTime();
    const now = pt != null ? pt : cur.currentTime;
    if (Math.abs(now - target) <= 2) return;
    dlog("apply -> seekTo", target, "from", now.toFixed(2));
    if (p && typeof p.seekTo === "function") {
      try { p.seekTo(target, true); } catch (e) { cur.currentTime = target; }
    } else {
      cur.currentTime = target; // player API not ready yet — raw seek as fallback
    }
  };

  // Poll for YouTube's resume when no event reaches us: a paused new tab left sitting at its
  // position, or a seek that fired before our listeners armed. Stops once we win / on cap.
  let guardN = 0;
  const guard = setInterval(() => {
    if (done || guardN++ > 240) { clearInterval(guard); return; } // ~60s cap
    const cur = getVideo();
    if (!cur || isAd() || userSeeking()) return;
    const pt = playerTime();
    if (atYtResume(pt != null ? pt : cur.currentTime)) apply();
  }, 250);

  const finish = (reason) => {
    if (done) return;
    done = true;
    dlog("finish:", reason);
    clearInterval(guard);
    document.removeEventListener("seeked", onSeeked, true);
    document.removeEventListener("timeupdate", onTime, true);
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("keydown", onKey, true);
    clearTimeout(timer);
  };

  const onSeeked = () => {
    if (done || currentVideoId !== applyId) return;
    if (userSeeking()) return finish("user-seek");
    apply();
  };

  const onTime = () => {
    if (done || currentVideoId !== applyId) return;
    const cur = getVideo();
    if (!cur) return;
    if (isAd()) { deadline = performance.now() + OVERRIDE_CAP_MS; return; } // ad time doesn't count
    if (performance.now() > deadline) return finish("deadline");
    const pt = playerTime();
    const t = pt != null ? pt : cur.currentTime;
    if (!userSeeking() && atYtResume(t)) return apply(); // YouTube's resume (any direction)
    if (!cur.paused && t > target + 1.5 && t < target + 12) return finish("won"); // playing forward from target
    if (t < target - 2 && !userSeeking()) apply(); // content started before target — re-assert
  };

  document.addEventListener("seeked", onSeeked, true);
  document.addEventListener("timeupdate", onTime, true);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("pointerup", onUp, true);
  document.addEventListener("keydown", onKey, true);
  const timer = setTimeout(() => finish("backstop"), OVERRIDE_BACKSTOP_MS);

  apply(); // immediate (skipped if a pre-roll ad is showing)
  return true;
}

async function onNavigate() {
  detach();
  currentVideoId = videoIdFromUrl();
  if (!currentVideoId) return; // not a watch page
  // On a fresh load both the yt-navigate-finish event and the bottom call fire for the same
  // URL; restore once, but always re-attach the save listeners.
  if (location.href !== lastRestoreUrl) {
    lastRestoreUrl = location.href;
    await restore();
  }
  attach();
}

window.addEventListener("yt-navigate-finish", onNavigate);
// SPA navigation away tears down without unload/pause — save the outgoing position
// while the old video is still current (currentVideoId still points at it here).
window.addEventListener("yt-navigate-start", positionNow);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) positionNow();
});
window.addEventListener("beforeunload", positionNow);

onNavigate();

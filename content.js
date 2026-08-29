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

function videoIdFromUrl() {
  return new URLSearchParams(location.search).get("v");
}

function urlHasTimestamp() {
  return new URLSearchParams(location.search).has("t");
}

function getVideo() {
  return document.querySelector("video");
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
  if (DEBUG) v.addEventListener("seeked", () => dlog("seeked ->", v.currentTime));
  saveTimer = setInterval(positionNow, SAVE_INTERVAL_MS);
}

const OVERRIDE_WINDOW_MS = 3000;
const MAX_REAPPLY = 3;

// Restores our saved position, overriding YouTube's own async resume for a bounded
// window. Always returns true — we keep saving regardless of whether we restored.
async function restore() {
  const resume = await send("getResume");
  dlog("getResume", resume);
  if (!resume || typeof resume.t !== "number" || urlHasTimestamp()) return true;

  const v = await waitForVideo();
  if (!v) return true;

  const target = resume.t;
  const applyId = currentVideoId;
  let count = 0;
  const start = Date.now();

  const apply = () => {
    const cur = getVideo();
    if (!cur || currentVideoId !== applyId) return; // navigated away
    dlog("apply target", target, "was", cur.currentTime);
    if (Math.abs(cur.currentTime - target) > 2) {   // YouTube moved us
      cur.currentTime = target;
    }
  };

  apply(); // immediate
  const timer = setInterval(() => {
    if (count >= MAX_REAPPLY || Date.now() - start > OVERRIDE_WINDOW_MS ||
        currentVideoId !== applyId) {
      clearInterval(timer);
      return;
    }
    count++;
    apply();
  }, 600);

  return true;
}

async function onNavigate() {
  detach();
  currentVideoId = videoIdFromUrl();
  if (!currentVideoId) return; // not a watch page
  await restore();
  attach();
}

window.addEventListener("yt-navigate-finish", onNavigate);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) positionNow();
});
window.addEventListener("beforeunload", positionNow);

onNavigate();

// Local resume for untracked containers. Since we cancel YouTube's watchtime
// pings, the account no longer remembers where you left off. This captures the
// <video> position and silently seeks back to it on reload. Fully dormant unless
// the background script confirms this tab's container is untracked.

const SAVE_INTERVAL_MS = 5000;
const FINISH_RATIO = 0.95;

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
  if (Number.isFinite(duration) && currentTime >= duration * FINISH_RATIO) {
    send("clearPosition"); // finished → forget it
  } else if (currentTime > 0) {
    send("savePosition", {t: currentTime});
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

// Returns true if this container is untracked (so we should keep tracking).
async function restore() {
  const resume = await send("getResume");
  if (!resume) return false; // tracked / dormant — do nothing at all
  if (typeof resume.t === "number" && !urlHasTimestamp()) {
    const v = await waitForVideo();
    if (v && v.currentTime < 2) {
      v.currentTime = resume.t;
      // YouTube can snap back to 0 just after load; re-apply once.
      setTimeout(() => {
        const cur = getVideo();
        if (cur && cur.currentTime < 2) cur.currentTime = resume.t;
      }, 1000);
    }
  }
  return true;
}

async function onNavigate() {
  detach();
  currentVideoId = videoIdFromUrl();
  if (!currentVideoId) return; // not a watch page
  const untrackedHere = await restore();
  if (untrackedHere) attach();
}

window.addEventListener("yt-navigate-finish", onNavigate);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) positionNow();
});
window.addEventListener("beforeunload", positionNow);

onNavigate();

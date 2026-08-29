// RDP harness: drive a PLAIN Firefox (navigator.webdriver === false, YouTube-trusted)
// via Firefox's DevTools Remote Debugging Protocol. Launch Firefox first with:
//   firefox -no-remote -profile ./profile --start-debugger-server 6000 <url>
// (prefs devtools.debugger.remote-enabled / chrome.enabled / prompt-connection=false
//  are baked into ./profile/user.js). No Marionette => no automation fingerprint.
//
// foxdriver quirk: a string script is wrapped as `(function(){ <script> }).apply(...)`
// with NO return, so bare expressions yield undefined. Always pass full statements that
// `return` — ev() does that for a single expression; evRaw() for multi-statement bodies.
const Foxdriver = require("foxdriver");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port = 6000) {
  const { browser, tabs } = await Foxdriver.attach("localhost", port);
  let tab = tabs.find((t) => t.data && /youtube\.com/.test(t.data.url)) || tabs[tabs.length - 1];
  await tab.console.startListeners();
  const withTimeout = (p, ms, label) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("eval timeout: " + label)), ms))]);
  // evaluate a single JS expression, return its value
  const ev = (expr) => withTimeout(tab.console.evaluateJSAsync("return (" + expr + ")"), 15000, String(expr).slice(0, 40));
  // evaluate a multi-statement body that itself returns
  const evRaw = (body) => withTimeout(tab.console.evaluateJSAsync(body), 20000, "raw");
  return { browser, tab, ev, evRaw };
}

// player helpers
const player = (ev) => ({
  ct: async () => Math.round(((await ev("(document.querySelector('video')||{}).currentTime")) || 0) * 100) / 100,
  dur: () => ev("(function(){var p=document.getElementById('movie_player');return p&&p.getDuration?p.getDuration():0})()"),
  state: () => ev("(function(){var p=document.getElementById('movie_player');return p&&p.getPlayerState?p.getPlayerState():null})()"),
  play: () => ev("(function(){var p=document.getElementById('movie_player');if(p){try{p.mute()}catch(e){}p.playVideo&&p.playVideo()}return 1})()"),
  pause: () => ev("(function(){var p=document.getElementById('movie_player');p&&p.pauseVideo&&p.pauseVideo();return 1})()"),
  seek: (t) => ev("(function(){var p=document.getElementById('movie_player');p&&p.seekTo&&p.seekTo(" + t + ",true);return 1})()"),
  goto: async (ev2, url) => { await ev("(location.href='" + url + "',1)"); },
});

module.exports = { Foxdriver, sleep, connect, player };

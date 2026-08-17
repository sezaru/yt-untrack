# yt-untrack

A tiny Firefox/Zen extension that lets you watch YouTube **signed in** (premium,
no ads) without the video being recorded to your history or influencing your
recommendations — gated **per container**.

Mark a container as "untracked" in the popup, then open any video in a tab in
that container. Everything else behaves normally.

## How it works

YouTube records a watch (and feeds recommendations) via playback-tracking pings
to `youtube.com/api/stats/*` (`watchtime`, `atr`, `playback`). The background
script cancels those requests **only** for tabs whose container
(`cookieStoreId`) you've enabled. The player, account session, and ad-free
premium delivery are untouched — just the "I watched this" signal never reaches
YouTube's servers.

The toolbar badge shows a red dot when the active tab is in an untracked
container.

## Develop

```sh
npm install          # or: nix-shell -p web-ext
npm run start        # launches a scratch Firefox with the extension loaded
npm run lint
```

To load into your real Zen for a quick test: `about:debugging` →
This Firefox → Load Temporary Add-on → pick `manifest.json`. (Temporary loads
vanish on restart; the signed build below is the persistent path.)

## Sign & release (self-distribution / unlisted)

Signing is only needed to produce a persistent, installable `.xpi` — the build
never touches the secret.

1. Create a free account on <https://addons.mozilla.org>, then
   Tools → Manage API Keys → generate a key/secret.
2. `cp .env.example .env` and fill in `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET`
   (direnv loads it). Keep a backup in Bitwarden — if lost, just regenerate.
3. Bump `version` in `manifest.json` (and `package.json`).
4. `npm run sign` → produces a signed `.xpi` under `web-ext-artifacts/`.
5. Attach that `.xpi` to a GitHub Release on this repo.

The NixOS config consumes the released `.xpi` by URL + hash (see the Zen
home-manager module) — bump the version + sha256 there when you cut a release.

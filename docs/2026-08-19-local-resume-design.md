# yt-untrack: local resume position — design

**Date:** 2026-08-19
**Status:** approved, mechanics validated in-browser

## Problem

The extension cancels YouTube's `/api/stats/*` pings in untracked containers.
One of those (`/api/stats/watchtime`) is what YouTube uses to persist the resume
position server-side against the account. Blocking it keeps history clean but
also loses native resume: reopening a partially-watched video restarts at 0:00.

## Goal

Store the last playback position **locally** and silently seek back to it when
the same video is reopened — but only in untracked containers, replicating the
native resume we intentionally suppress.

## Decisions

- **Scope:** only untracked containers. Tracked containers keep YouTube's own
  resume and the feature stays fully dormant there.
- **UX:** silent auto-seek (no prompt), matching native behavior.
- **Finish rule:** clear the saved position when a video is finished
  (`currentTime >= duration * 0.95` or the `ended` event), so finished videos
  start fresh.
- **Retention:** prune entries older than 90 days on write.
- **URL `?t=` precedence:** an explicit timestamp in the URL is respected; we
  never override it.
- **Strategy:** content script (decoupled from YouTube's ping internals), not
  ping-param parsing.

## Architecture

- **`content.js`** (new) — injected on `*://*.youtube.com/watch*`. Owns capture
  and restore against the `<video>` element; handles SPA navigation.
- **`background.js`** (existing) — gains a message handler as the storage
  gateway. It is the authority on which `cookieStoreId`s are untracked, so it
  gates the feature and owns pruning/expiry in one place.
- **`storage.local`** — new key `positions`: a map of
  `"<cookieStoreId>|<videoId>" -> { t: <seconds>, updated: <epoch ms> }`.

Storage is routed through the background because the content script can't easily
know its own `cookieStoreId`, and the background already knows which containers
are untracked.

## Data flow

**On watch-page load / SPA nav to a new video:**
1. Content script extracts `videoId` from `?v=`.
2. Sends `{type: "getResume", videoId}` to background.
3. Background: is this tab's `cookieStoreId` untracked? No → reply `null`
   (feature dormant). Yes → look up `positions["<store>|<videoId>"]`, reply
   `{t}` or `null`.
4. Content script, given a `t` and no explicit URL `?t=`, waits for the video
   element and seeks to `t` (only if `currentTime` is still ~0, so a user scrub
   isn't yanked back).

**While watching (untracked only):**
5. Sample `video.currentTime` on a ~5s throttle and on `pause` /
   `visibilitychange`-hidden / `beforeunload`.
6. Send `{type: "savePosition", videoId, t}`; background writes
   `{ t, updated: now }`.
7. Finish: if `t >= duration * 0.95` or `ended`, send
   `{type: "clearPosition", videoId}` instead.

**On every write** background prunes entries older than 90 days.

## Edge cases

- Player renders async → retry finding `video` for a few seconds, else no-op.
- User `?t=` deep link → respected, never overridden.
- Only seek on fresh navigation while `currentTime` ~0 → no fighting a scrub.
- Live / zero-duration → skip the finish rule; save/restore low-stakes.
- SPA nav via `yt-navigate-finish` + URL-change fallback; previous video gets a
  final save.
- Messaging failures wrapped in try/catch; a lost final save is stale, never an
  error.

## Validation (done in-browser, untracked container)

- Test 1: read `videoId` / `currentTime` / `duration` — clean.
- Test 2: `video.currentTime = 577` sticks — seek works.
- Test 3: `yt-navigate-finish` fires with the new videoId on in-app nav.
- Test 4: `localStorage` round-trip restored to the saved position after reload.

## Testable units (pure, no browser)

- Key construction `"<store>|<videoId>"`.
- Finish boundary at `duration * 0.95`.
- `?t=` precedence.
- 90-day prune.

## Manifest changes

- Add `content_scripts` entry for `*://*.youtube.com/watch*` running `content.js`.
- Existing permissions already cover storage, tabs, and the youtube host.

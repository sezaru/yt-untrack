# yt-untrack — resume-everywhere, watched badges, popup redesign

**Date:** 2026-08-29
**Status:** Approved design, pending implementation plan

## Summary

Three features built on one shared data change:

1. **Resume on all videos** — local resume position for tracked (normal) containers too, as a fallback for when YouTube fails to record where you left off.
2. **"Watched" badges** — mark thumbnails in the feed/home that were watched via the add-on, but **only in untracked (private) containers**, where YouTube itself shows nothing. Includes a progress bar overlay (how far you got).
3. **Popup redesign** — rework the container picker to hold two new global toggles.

Non-goals: no badges in tracked containers (YouTube already marks those); no per-container granularity for the new toggles; no new host/manifest permissions; stays Manifest V2.

## Data layer (shared foundation)

Today all positions live in a single `storage.local.positions` object keyed `<cookieStoreId>|<videoId>`, and positions are only written for untracked containers.

Changes:

- **One storage key per video:** `p:<cookieStoreId>|<videoId>` → `{ t, d, updated }`
  - `t` — seconds watched (resume point)
  - `d` — video duration in seconds (needed to draw the progress bar as `t/d`)
  - `updated` — epoch ms (for pruning)
- **Positions recorded for every container**, tracked and untracked, whenever resume/badge features are active.
- **Memory footprint stays flat regardless of history size** — the whole set is never held in memory:
  - Resume path reads exactly **one** key (`storage.local.get("p:<store>|<vid>")`).
  - Badge path batch-reads only the keys for thumbnails currently visible.
- **Pruning:** entries older than 90 days are removed. Prune runs off the hot path (on write and/or occasionally), enumerating keys via `storage.local.get(null)` — never during scroll or seek.
- **Migration:** on upgrade, one-time convert any existing `positions` object into per-video keys, then delete the old blob. Legacy entries have no `d` (duration was never stored). Migrated entries therefore render **pill only, no progress bar** until `d` is backfilled on the next watch; the badge code must treat `d === undefined` as "unknown length → omit the bar," never as `0`.
- **Hard rule:** `storage.local.get(null)` (full enumeration) is used **only** by pruning. No hot path (resume seek, scroll/badge) may enumerate all keys.

The existing untracking mechanism (cancel `/api/stats/*` for `enabledContainers`) is unchanged.

## Feature 1 — resume on all videos

**Control:** global toggle **"Resume where I left off"** (default **on**). It governs resume in **tracked** containers only. **Resume in untracked (private) containers is always on, independent of this toggle** — flipping the toggle off never disables the private-container resume that already exists. Saving positions still happens in every container so a later toggle-on has data to resume from.

**Saving** (unchanged triggers, extended to all containers): save `{t, d}` on the periodic interval, on `pause`, on `visibilitychange` (hidden), and on `beforeunload`. Clear the entry when `currentTime >= duration * 0.95` (finished) and on `ended`.

**Restoring — "local always wins":**

- On watch-page load, if we have a stored `t` and the URL has no `&t=`, seek the `<video>` to `t` once it has metadata (`readyState >= 1`).
- Because YouTube applies **its own** server-side resume asynchronously (and can momentarily snap to 0 then jump to its stored time), a single seek is not enough to guarantee ours wins. We therefore **re-apply our seek when YouTube overrides it during the initial load window**:
  - Watch for `currentTime` jumping to a value materially different from our target within the first ~3 seconds after load.
  - Re-apply our target up to a small bounded number of times (e.g. 2–3), then stop.
  - After the load window closes, never re-apply — so we never fight the user's own manual seeking.
- `&t=` in the URL always takes precedence (explicit user intent).

**Interaction with Feature-1-off:** when the toggle is off, no restoring on **tracked** containers (untracked containers still restore, always). Position **saving continues in all containers regardless of the toggle**, so toggling back on immediately has data to work with.

## Feature 2 — "watched" badges (private containers only)

**Control:** global toggle **"Watched badges"** (default **on**). Renders **only** when the current tab is in an untracked container.

**Appearance (treatment B):**
- A **"👁 watched" pill** at the top-left of the thumbnail.
- A **teal progress bar** along the bottom of the thumbnail, width = `t / d`. Teal (not red) so it is never confused with YouTube's own red watched bar.

**Rendering pipeline (performance-critical):**
1. A **throttled `MutationObserver`** on the feed container reacts to new thumbnails appearing during scroll (debounced, e.g. ~200 ms).
2. Collect the video IDs of newly-appeared, not-yet-processed thumbnails (extracted from each thumbnail's `/watch?v=…` href).
3. Do **one batched** `storage.local.get([...])` for just those keys.
4. For hits, inject the pill + bar; for misses, do nothing.
5. **Mark every processed thumbnail** with a `data-*` attribute so it is never queried or reprocessed again.

Consequences: per-thumbnail check is a bounded async batch read (not a per-node storage hit); DOM writes are coalesced in `requestAnimationFrame`; transient memory is bounded to the current viewport batch. Scroll overhead is negligible.

**Update on watch:** when a position is saved/cleared for a video in the current container, refresh that thumbnail's badge if it is on screen. Note this requires a **new** `storage.onChanged` listener in the content script — today only `background.js` listens for storage changes (to refresh the toolbar badge); the content script has none. This is new code, not reuse of an existing path.

## Feature 3 — popup redesign (layout A)

- **Global toggles on top:** "Resume where I left off" and "Watched badges" as switch rows.
- **Untrack-container checklist below:** color dot + name + checkbox per container (as today), including the Default (no-container) pseudo-entry.
- **Theme follows the system** via `@media (prefers-color-scheme: dark)` — dark on a dark desktop, light on a light one. Red brand accent (`#e05555`) in both modes.
- Toggle state persists in `storage.local` (e.g. `settings.resumeEverywhere`, `settings.watchedBadges`); background and content scripts read it and react to `storage.onChanged`.

## Testing strategy (Feature 1 — the resume/YouTube competition)

- **Debug flag** (e.g. a `storage.local` dev setting or a build constant) that logs a timeline of `currentTime` changes on a watch page, annotated with who set the value (our seek vs external), so the ordering of YouTube's resume vs ours is observable and we can confirm ours lands last.
- **Manual test matrix:**
  - (a) Watch a normal video to a known time → close → reopen → resumes to **our** time.
  - (b) Force a desync (advance to a different time on another device so YouTube's server position differs) → reopen on desktop → **local still wins**.
  - (c) Finish a video (>95%) → reopen → starts fresh (no stale resume).
  - (d) Open a `…&t=90s` link → we defer to the URL.
- **Feature 2 manual checks:** watched private videos show pill + teal bar in the private-container feed; the same videos show **no** add-on badge in a tracked container; scrolling a long feed stays smooth.

## Defaults (confirmed)

- Both global toggles default **on**.
- Resume applies to **every** container.

## Open questions (to resolve during planning)

- Exact `data-*` attribute name and the thumbnail selector(s) that survive YouTube DOM churn (rich-grid, watch-next sidebar, search results) — pin down during implementation (safe to defer).

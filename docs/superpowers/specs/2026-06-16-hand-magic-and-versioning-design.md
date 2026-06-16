# Hand-magic steering, gesture demo & version/cache-bust

**Date:** 2026-06-16
**Status:** approved design, ready to implement (build C first, then A+B)

## C · Version label + auto cache-bust  (do first — makes future updates land)

**Problem.** Deployed assets carry no cache headers, so the iPad (and the CDN edge)
serve stale JS after every deploy — players need a manual refresh, and we can't tell
what build someone is on.

**Version label.** A small, dim version string on the title/start overlay (and the
dev overlay), so anyone can read which build is live. Value = pretty date+time+short
SHA, e.g. `2026-06-16 12:09 · 46751f0`.

**Auto cache-bust (the real fix).** ES module imports don't inherit a query string
through the chain, so busting only the entry doesn't work. Instead, at **package
time** stamp a unique build token onto *every* relative import in our own source:

- `tools/stamp_version.py <stageDir> <buildToken> <versionDisplay>`:
  1. writes `game/version.js` → `export const VERSION = "<versionDisplay>";`
  2. appends `?v=<buildToken>` to every `from "./x.js"` / `import("./x.js")` in our
     `.js` files, and to `src="./game/main.js"` in `index.html`.
  - **Skips `vendor/`** (three.js, MediaPipe `.js`/`.wasm`/`.task`): large and stable,
    re-downloading 9 MB+ every update would be wasteful. Vendor URLs stay cached;
    only our small source files bust.
- `tools/package.sh`: copy `public/` → temp stage, run the stamper on the stage,
  zip the stage. **Source tree stays clean** (no `?v=` committed); local
  `python3 -m http.server` runs unstamped (`version.js` says `"dev"`).
- Build token = `YYYYMMDD-HHMMSS-<sha>` (timestamp guarantees uniqueness even when
  redeploying the same commit). Display = `YYYY-MM-DD HH:MM · <sha>`.

Because every import in the graph is rewritten, `world.js?v=T` imports
`./blocks.js?v=T` (not the bare URL), so the whole graph is consistently fresh on
each deploy.

**Files:** new `public/game/version.js` (placeholder `"dev"`), new
`tools/stamp_version.py`, rewrite `tools/package.sh`, `main.js` (import + show
VERSION), `ui.js` (`setVersion`), small CSS.

**Verify:** run `package.sh`, unzip to a temp dir, serve it, load in preview →
confirm `?v=` is present and identical across imports, `version.js` shows the build,
the game boots, no console errors. Confirm bare local `public/` still runs unstamped.

## A · Hand-magic steering — steer by hand's screen side

**Root cause (not a bug — missing feature):** open-palm walk only adds `camForward`
([player.js](../../public/game/player.js) `gestureWalk`); nothing turns the camera, so you
can only walk straight.

**Design:** while palm-walking, the hand's **horizontal screen position** steers —
hand on the left half → turn left, right half → turn right, with a center **dead
zone**; turn rate scales with distance from center. Implemented by rotating the
follow-camera yaw (movement is camera-relative, so turning the camera turns the
walk). Reuses the cursor x the tracker already computes; only acts while walking, so
it never fights pinch-aiming.

- `gestures.js`: when walking, `steer = clampDead((cx - W/2)/(W/2), dead)`; new
  `onSteer(amount)` callback each processed frame; reset to 0 on stop / hand-lost /
  not-walking. Add a pure helper for the steer math so it's unit-testable.
- `main.js`: `onSteer: a => player.gestureSteer = a`; in the frame loop, while
  `gestureWalk`, `followCam.yaw += gestureSteer * CFG.gestureSteerRate * dt`.
  Reset `gestureSteer` in `gestureCleanup`.
- `player.js`: add `gestureSteer = 0`.
- `config.js`: `gestureSteerRate` (~1.6 rad/s), `gestureSteerDead` (~0.18).
- **Sign needs on-device confirmation** (left=left); keep it a one-line flip.

## B · Gesture demo while the camera loads

A small guide shown the moment Hand Magic starts loading, on screen until tracking is
ready (then a few seconds more, or dismiss): **✋ open hand = walk** · **move hand
left/right = turn** · **🤏 pinch = grab & build** · **point = aim**.

- `ui.js`: `showGestureGuide()` / `hideGestureGuide()` (a small panel).
- `main.js`: show on `toggleHandMagic` start; hide shortly after `handMagicReady` or
  on stop/cleanup.
- `strings.js`: guide lines.

## Testing honesty

C and B are fully verifiable here (bundle load; UI render). A's steer **math** is
unit-tested, but real palm-steering needs a camera + hand — **final confirmation of
A and B is on-device** (the grandson's iPad).

## Out of scope
World/physics/quests unchanged. No new audio.

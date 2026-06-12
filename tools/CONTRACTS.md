# Pinchy Pea — module contracts (FROZEN — main.js is written against these exactly)

Game: cozy claymation voxel building game. Three.js (vendored at `public/vendor/three.module.js`).
Core already written: `config.js, rng.js, blocks.js, world.js, worldgen.js, physics.js,
inventory.js, camera.js, player.js, interact.js` in `public/game/`. Strings in `public/strings.js`.
READ those files before writing yours.

Universal rules (every module):
- Plain ES module, browser-only, JS (no TypeScript). Imports are RELATIVE:
  `import * as THREE from "../vendor/three.module.js"`, `import { CFG } from "./config.js"`,
  `import { STR } from "../strings.js"`.
- NEVER import from a CDN/URL. NEVER use external assets beyond `./assets/...` listed below.
- Zero allocations in per-frame paths (reuse scratch vectors; pools).
- All player-visible text from STR — zero string literals shown to players.
- Keyboard: `event.code` only (KeyW, Space...), never `event.key`.
- No shadows (`castShadow` stays false); materials: MeshLambertMaterial unless noted.
- Touch targets ≥ 48px. Mobile Safari quirks: passive:false where preventDefault needed.
- Do not edit any file other than your own.

---

## game/input.js — exports `class Input`
Unifies keyboard + canvas pointer (touch/mouse) + gamepad into per-tick commands.
- `constructor(canvas)` — attach listeners. Pointer model:
  - Track pointers by pointerId. A pointer starting in the LEFT 40% of the screen AND below
    55% height belongs to the UI joystick (ui.js handles it — IGNORE pointers whose target is
    not the canvas, ui elements call setVirtualAxis themselves).
  - Canvas pointers: single pointer drag = look (report dx,dy). Two simultaneous canvas
    pointers = pinch zoom (report zoom delta from distance change, scaled ~0.02/px).
  - A canvas pointer that moves < CFG.tapMaxPx and lifts < CFG.tapMaxMs = TAP → push
    {x,y,alt:false} to tap queue. Mouse: left button tap → alt:false, right button → alt:true
    (suppress contextmenu). Mouse drag with button held = look. Wheel = zoom (deltaY*0.01).
- `update()` — poll gamepads (standard mapping): left stick → axis (deadzone 0.15), right
  stick → look (scale ~6 px/tick per unit), button A(0) jump held, B(1) → call
  `this.onModeToggle?.()` (edge-triggered), RT(7) or X(2) edge → push tap at screen center
  {x:innerWidth/2, y:innerHeight/2, alt:false}.
- `axis()` → `{x,y}` in [-1,1]: keyboard (WASD+arrows via event.code) + virtual joystick +
  gamepad, clamped magnitude 1. y=-1 means forward (matches player.js usage:
  forward = camForward * -axis.y).
- `consumeLook()` → `{dx,dy}` accumulated px since last call (then reset).
- `consumeZoom()` → number accumulated (then reset).
- `consumeTaps()` → array of `{x,y,alt}` (then reset).
- `jumpHeld()` → bool (Space held, gamepad A, or UI button).
- `setVirtualAxis(x,y)`, `setButton(name,held)` ("jump"), `onModeToggle` callback property.
- `lastPointer` → {x,y} or null — most recent canvas pointer/mouse position (for hover highlight).
- Edge cases: pointercancel clears state; blur clears held keys; two-finger zoom must not fire taps.

## game/characters.js — exports `buildPeathan()`, `buildJaspea()`
Procedural clay characters from Three.js primitives. Each returns
`{ group, animate(dt, time, state), celebrate() }`:
- group: THREE.Group, origin at FEET center, facing +Z. Peathan total height ≈ 1.45 world
  units; Jaspea ≈ 0.85.
- Peathan: squashed sphere body (sprout green 0x7fc163, slightly flattened), 2-3 small
  flattened-sphere sprout leaves on top (0x4e8a3e), two big round eyes (dark 0x3a2b22 spheres
  + tiny white glint spheres), pink cheek dots, stub arm spheres, two little foot spheres,
  plum-purple backpack (0x7b5ea7 rounded box behind + flap + butter-yellow button 0xf2d98c).
  Build "rounded box" via BoxGeometry + high radius bevel illusion (scale sphere) — keep it
  simple primitives, NO LatheGeometry/CSG.
- Jaspea: same recipe, smaller, lighter green 0xa3d98a, ONE sprout leaf, slightly bigger eyes
  relative to body (cute), no backpack.
- Add a blob shadow: flat circle mesh (CircleGeometry, rotation.x=-PI/2, color 0x2e4a2e,
  transparent opacity 0.25) at y=0.02 in the group, name it "blobShadow".
- `animate(dt, time, state)` — state = {moving, speed, grounded, swimming}; squash-and-stretch
  bob while moving (body scale y 1±0.06 at ~9Hz scaled by speed), arm swing, idle breathing
  (slow 1±0.02), blink every 3-5s (eye scale.y → 0.1 for 0.12s, use accumulated time, no
  setTimeout), swimming = gentle wiggle + slight recline. Celebrate(): 1.2s hop-spin-squash
  flourish (internally timed, callable anytime).
- Materials: MeshLambertMaterial. Reuse geometries/materials across calls (module-level cache).

## game/jaspea.js — exports `class Jaspea`
- `constructor(scene, world, char)` — char from buildJaspea(); adds group to scene.
- `spawnAt(x,y,z)`; `position` getter → {x,y,z} (feet).
- `update(dt, time, playerPos)` — follow: if horizontal dist to player > 3.2, hop toward
  player at 3.4 u/s (face movement dir); stop when < 2.2. Terrain: y follows
  world.topSolidY(x,z)+1 smoothly (no real physics; lerp y, hop arc while moving — sin bump
  0.25). If dist > 18 (player ran far) teleport behind player. Call char.animate each frame
  with {moving, speed, grounded:true, swimming:false}.
- Speech: `onSay(text)` callback property (main wires to UI bubble). `sayKey(key)` — look up
  STR.jaspea[key], rate-limit 1 line / 6s (drop if busy). Ambient: every 18-30s (accumulated
  time + seeded jitter ok) say idle1/idle2/idle3 rotating; if within 3 of water biome blocks
  say nearWater (once/min max); near BLOSSOMLEAF blocks → nearBlossom.
  Detect via world.get sampling 8 blocks around her ONCE per 2s, not per frame.
- `squeeze()` — giggle: char celebrate-like wobble + sayKey("giggle").
- `celebrate()` — char.celebrate() + sayKey("cheer").

## game/particles.js — exports `class Particles`
- `constructor(scene)` — ONE InstancedMesh (BoxGeometry 0.12, MeshLambertMaterial with
  vertexColors via instanceColor), capacity 320, frustumCulled=false. Hidden instances scale 0.
- `burst(x,y,z,colorHex,count=10,opts={spread:2.4,up:3.2})` — clay crumbs: random velocity
  sphere*spread + up; gravity -14; life 0.55-0.8s; shrink to 0; slight color jitter ±8%.
- `sparkle(x,y,z,colorHex)` — 4 tiny crumbs drifting UP slowly, life 0.9s.
- `confetti(x,y,z)` — 46 crumbs, pastel palette [0xf2aab8,0xbfaae8,0xf4dc92,0xa7d2f2,0xfff4e2,
  0x9ed98c], spread 4, up 6, life 1.6s, slow fall (gravity -6), tumbling rotation.
- `update(dt)` — advance, write instance matrices/colors, instanceMatrix.needsUpdate. Pool —
  zero allocation per frame (preallocate Float32 arrays / Object pool, scratch Matrix4/Color).

## game/audio.js — exports `class AudioMan`
- WebAudio. `constructor()` lazy AudioContext (created on first unlock()).
- `async load(manifest)` — {key:url} e.g. {music:"./assets/audio/music_cozy.mp3", pinch:...,
  place:..., step:..., water:..., cheer:...}; fetch+decode; missing/failed file → console.warn
  once, mark absent, never throw.
- `unlock()` — create/resume ctx (call from first user gesture). Safe to call repeatedly.
- `play(key,{volume=1,rate=1,ratejitter=0})` — one-shot via BufferSource → per-key GainNode →
  master. volume multiplies CFG.volumes.sfx. ratejitter: rate*(1±jitter*rand).
- `music(key)` — loop with 2s fade-in at CFG.volumes.music; only once.
- `ambientWater(target)` — looping "water" buffer; smoothly approach gain target each call
  (clamped 0..CFG.volumes.ambient); start/stop source as needed.
- `footstep()` — play("step",{volume:0.55,ratejitter:0.18}) throttled to CFG.stepSfxInterval.
- `toggleMute()` / `get muted` — master gain 0/1, persisted localStorage "pinchy-pea-muted".
- iOS: resume on visibilitychange→visible if context suspended.

## game/quests.js — exports `class Quests`
- `constructor({world, homeSite, scene, hooks})` — hooks = {onProgress(quest,done,total),
  onComplete(quest), grant(bundleObj), say(text), confetti(x,y,z)}. Quest defs order:
  cozy_home, flower_garden, bridge, sky_tower (ids match STR.quests keys + CFG.unlockBundles).
- One ACTIVE quest at a time; next activates on complete. After all: hooks.say(STR.questAllDone)
  once; stays in free build.
- cozy_home: ghost blueprint at homeSite {x,z}: ground y0 = world.topSolidY over the pad.
  Footprint 6(x)×4(z), walls 3 high on the perimeter, doorway gap 1×2 centered on one long
  side, one 1×1 window hole on the opposite side; total = perimeter cells minus holes
  (count them in code). Ghost rendering: ONE merged set of translucent boxes — use
  InstancedMesh(BoxGeometry(0.98), MeshLambertMaterial({transparent:true, opacity:0.22,
  color:0xffffff, depthWrite:false})), opacity pulse 0.16..0.3 in `update(dt)`. Progress =
  ghost cells filled with ANY solid block (track via onBlockPlaced/Removed matching cells;
  also COUNT pre-filled cells at activation). Complete at ≥85% → hide ghost.
- flower_garden: 5 FLOWER (id 14) placed (running count, decrement if pinched before done).
- bridge: 12 player-placed solid blocks that have WATER (id 8) within the 2 cells directly
  below at place time (count; no decrement needed).
- sky_tower: complete when checkStand(playerPos) finds player standing (within 0.6 xz, feet
  within 1.2 above) on a player-placed block with y ≥ 24. Track playerPlaced as a Set of
  "x,y,z" (cap 4000 entries FIFO).
- API: `onBlockPlaced(x,y,z,id)`, `onBlockRemoved(x,y,z,id)`, `checkStand(pos)` (called ~2/s
  by main), `update(dt)` (ghost pulse), `activeQuest()` → {id,name,done,total} or null,
  `serialize()`/`load(data)` (active index, counters, playerPlaced as array — and re-show
  ghost if cozy_home active).
- On complete: hooks.confetti at quest site or player pos, hooks.grant(CFG.unlockBundles[id]),
  hooks.say(STR.quests[id].done), hooks.onComplete(quest).

## game/save.js — exports `class SaveGame`
- localStorage key "pinchy-pea-v1". JSON: {v:1, edits:{"x,y,z":id}, inventory, quests, mode,
  growing, player:{x,y,z}, jaspea:{x,y,z}, settings:{muted}}.
- `constructor()`; `recordEdit(x,y,z,id)` → edits map (placing air = store 0; overwrite same
  key). `attach(getState)` — getState() returns the full snapshot minus edits (main provides).
- `tick(dt)` — autosave every CFG.saveInterval s IF dirty. `saveNow()`. Also listens
  visibilitychange→hidden → saveNow().
- `static load()` → parsed data or null (try/catch; corrupt → null + console.warn).
- `applyEdits(world)` — world.set(x,y,z,id,{silent:true}) for each edit (call AFTER worldgen,
  BEFORE first mesh build — main does ordering; just provide the method).
- `clear()` for a fresh world (not exposed in UI yet).
- Storage quota errors → warn once, keep playing (never crash).

## game/gestures.js — exports `class HandMagic`  (LAZY — only ever imported on user opt-in)
- `constructor(cb)` — cb = {onCursor(px,py), onPinchStart(px,py), onPinchEnd(),
  onPalm(walking:boolean), onStatus(text)} (px,py in CSS pixels, already mirrored so moving
  hand right moves cursor right).
- `async start(previewContainer)` — dynamic import("../vendor/mediapipe/vision_bundle.mjs");
  `FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm")`; HandLandmarker
  createFromOptions({baseOptions:{modelAssetPath:"./vendor/mediapipe/hand_landmarker.task"},
  runningMode:"VIDEO", numHands:1}). getUserMedia({video:{facingMode:"user", width:320,
  height:240}}). Build small preview: <video> 96×72 rounded + overlay canvas drawing
  landmarks as dots, append into previewContainer. onStatus(STR.handMagicReady) when running.
  Errors: NotAllowedError → onStatus(STR.handMagicDenied); anything else →
  onStatus(STR.handMagicError); always clean up partial state; rethrow nothing.
- `update(frameCounter)` — run detectForVideo every CFG.gestureEveryNFrames frames (and only
  if video.readyState≥2 and video.currentTime advanced). Landmarks: thumb tip 4, index tip 8,
  wrist 0, middle MCP 9. handSpan = dist(0,9). pinchRatio = dist(4,8)/handSpan. Hysteresis:
  pinch ON when < CFG.pinchOn, OFF when > CFG.pinchOff, both debounced CFG.pinchDebounceMs.
  Cursor: index tip → screen px (mirror x: px=(1-x)*innerWidth, py=y*innerHeight), smoothed
  (lerp 0.35) → onCursor every processed frame. Pinch start → onPinchStart(cursor). Open palm:
  ≥4 of fingertips {8,12,16,20} farther from wrist than their PIP joints {6,10,14,18} AND not
  pinching, held CFG.palmWalkHoldMs → onPalm(true); fist or hand lost 300ms → onPalm(false).
- `stop()` — stop tracks, close landmarker, remove preview DOM, onPalm(false).
- `get running`.

## game/ui.js — exports `class UI`
All DOM HUD (game canvas stays clean). `constructor(root, {inventory, strings})` builds DOM
in `root` (a fixed full-screen div with pointer-events:none; interactive children re-enable).
Pastel clay aesthetic: rounded-2xl cream panels (#f6efe2 bg, #3f3429 text, soft shadows,
border-radius 18px+), big friendly buttons, system rounded font stack
(-apple-system, "SF Pro Rounded", "Segoe UI", sans-serif). Inline <style> injected once.
Components + API:
- Virtual joystick (bottom-left, 124px): own pointer handling (pointer events on its zone);
  calls `hooks.onAxis(x,y)` continuously, (0,0) on release. Fade 40% idle.
- Buttons (bottom-right cluster, ≥56px): Jump (press/release → hooks.onJump(held)), Mode
  toggle (shows pinch-hand 🤏 when in pinch, brick 🧱 in build → hooks.onModeToggle()), and a
  smaller row top-right: sound 🔊/🔇 (hooks.onMute), hand-magic 🖐 (hooks.onHandMagic), photo 📷
  (hooks.onPhoto).
- Hotbar (bottom-center, like the mockup): 6 slots from inventory PALETTE_ORDER first six,
  swatch = block tint color rounded square, count badge; tap slot → inventory.select +
  hooks.onSelect(key); selected slot lifts/outlines. `refresh()` re-reads inventory (wired to
  inventory.onChange by main).
- Palette drawer (left edge tab like the mockup): tap tab → slides out vertical panel with ALL
  PALETTE_ORDER blocks (swatch+name+count); tap selects + closes. (Blocks with count 0 shown
  dimmed but selectable.)
- Quest card (top-right, like the mockup): title STR.questTitle, active quest name + progress
  "n / total" via `setQuest(name, done, total)`; brief glow on progress. `questComplete(text)`
  celebratory wiggle.
- Compass strip (top-center): letters W·N·E·S sliding per camera yaw — `setYaw(rad)`.
- Minimap (bottom-right circle 120px, canvas): `initMinimap(world, S)` paint top-block colors
  once (use BLOCKS tint/colors, water blue); `updateMinimap(x,z,yaw)` player dot + view cone;
  repaint a 3×3 area on `minimapEdit(x,z,color)`. North marker.
- Speech bubble: `say(text)` — rounded bubble above bottom-center, 3.5s, queue max 2.
- Toasts: `toast(text)` top-center small, 2s. `toastNoClay(key)` → STR.toastNoClay.
- Mode hint: `onModeChanged(mode)` → toast STR.modePinch/modeBuild (only when changed).
- Gesture UI: `gestureCursor(px,py,pinching)` — soft hand cursor div; `gestureStatus(text)`
  chip near top; `gesturePreviewContainer()` → bottom-left container el for the camera bubble;
  `gestureActive(bool)` toggles button state + cursor visibility.
- Loading flow: `showLoading()` full-screen pastel overlay with ./assets/ui_logo.png centered
  (img, max 60%) + STR.loading; `showStart(cb)` swaps to big STR.tapToStart button → cb() on
  tap (one-shot); `hideOverlay()`.
- `setPaused(bool)` dim + STR.pausedHint.
- Photo: hooks.onPhoto wired by main; UI just the button.
Layout safe-areas: env(safe-area-inset-*) padding. Everything must not overlap the hotbar on
390×844. Keep z-order: overlay > toasts > HUD.

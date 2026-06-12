import * as THREE from "../vendor/three.module.js";
import { STR } from "../strings.js";
import { CFG } from "./config.js";
import { buildAtlas, BLOCKS, byKey, B } from "./blocks.js";
import { AUDIO, SKY } from "./assets-manifest.js";
import { World } from "./world.js";
import { generateWorld } from "./worldgen.js";
import { Inventory } from "./inventory.js";
import { Player } from "./player.js";
import { FollowCam } from "./camera.js";
import { Interact } from "./interact.js";
import { Input } from "./input.js";
import { buildPeathan, buildJaspea } from "./characters.js";
import { Jaspea } from "./jaspea.js";
import { Particles } from "./particles.js";
import { AudioMan } from "./audio.js";
import { Quests } from "./quests.js";
import { SaveGame } from "./save.js";
import { UI } from "./ui.js";

const canvas = document.getElementById("c");
const devEl = document.getElementById("dev");
const DEV = new URLSearchParams(location.search).has("dev");
if (DEV) devEl.style.display = "block";

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, CFG.dprCap));
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 600);
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
addEventListener("orientationchange", resize);
resize();

const scene = new THREE.Scene();
scene.background = new THREE.Color(CFG.fogColor);
scene.fog = new THREE.Fog(CFG.fogColor, CFG.fogNear, CFG.fogFar);
// engine lighting derived from the STYLE FORMULA: bright cozy morning, soft shadows
scene.add(new THREE.HemisphereLight(0xfdf6e3, 0xd8cbb0, 1.0));
const sun = new THREE.DirectionalLight(0xfff1d6, 1.1);
sun.position.set(60, 90, 30);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.25));

// sky dome (texture wired in during boot; harmless if it fails)
function addSkyDome() {
  const tex = new THREE.TextureLoader().load(SKY, t => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.MirroredRepeatWrapping;
    t.repeat.set(2, 1);
  }, undefined, () => { /* fog-colored sky is a fine fallback */ });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(280, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.62),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  dome.renderOrder = -10;
  // centered on the WORLD, not the origin corner — the camera can never exit it
  dome.position.set(CFG.worldSize / 2, 0, CFG.worldSize / 2);
  return dome;
}

// ---------- boot ----------
const inventory = new Inventory();
const ui = new UI(document.getElementById("ui"), { inventory, strings: STR });
ui.showLoading();

const audio = new AudioMan();
const audioReady = audio.load(AUDIO);   // resolves even with missing files

async function boot() {
  const { texture, missing } = await buildAtlas();
  if (missing.length) console.warn("Missing textures:", missing);

  const world = new World(scene, texture);
  const gen = generateWorld(world);

  // saved game
  const data = SaveGame.load();
  const save = new SaveGame();
  if (data?.edits) {
    for (const [k, id] of Object.entries(data.edits)) {
      const [x, y, z] = k.split(",").map(Number);
      world.set(x, y, z, id, { silent: true });
      save.recordEdit(x, y, z, id);
    }
  }
  if (data?.inventory) inventory.load(data.inventory);

  // initial meshing with the loading screen up (keep the page responsive)
  world.markAllDirty();
  while (world.queue.length) {
    world.processRemesh(10);
    await new Promise(r => requestAnimationFrame(r));
  }
  scene.add(addSkyDome());

  // characters
  const peathanChar = buildPeathan();
  scene.add(peathanChar.group);
  const startPos = data?.player &&
    world.inBounds(data.player.x | 0, data.player.y | 0, data.player.z | 0)
    ? data.player : gen.spawn;
  const player = new Player(peathanChar, startPos);
  player.spawn = { ...gen.spawn };

  const jaspea = new Jaspea(scene, world, buildJaspea());
  const jp = data?.jaspea ?? { x: gen.spawn.x + 1.6, y: gen.spawn.y, z: gen.spawn.z + 1.2 };
  jaspea.spawnAt(jp.x, jp.y, jp.z);
  jaspea.onSay = (t) => ui.say(t);

  const particles = new Particles(scene);
  const followCam = new FollowCam(camera);

  const quests = new Quests({
    world, homeSite: gen.homeSite, genHeight: gen.height, scene,
    hooks: {
      onProgress: (q, done, total) => ui.setQuest(q.name, done, total),
      onComplete: (q) => {
        ui.questComplete(STR.quests[q.id].done);
        audio.play("cheer");
        jaspea.celebrate();
        peathanChar.celebrate();
      },
      grant: (bundle) => {
        for (const [k, n] of Object.entries(bundle)) {
          inventory.add(k, n);
          ui.toast(STR.toastUnlock(STR.blocks[k] ?? k));
        }
      },
      say: (t) => ui.say(t),
      confetti: (x, y, z) => particles.confetti(x, y, z)
    }
  });
  if (data?.quests) quests.load(data.quests);

  const interact = new Interact({
    world, scene, camera, player, jaspea, inventory, particles, audio, quests, ui
  });
  if (data?.mode || data?.growing) interact.load({ mode: data.mode, growing: data.growing });

  const input = new Input(canvas);
  input.onModeToggle = () => interact.toggleMode();

  // UI -> game
  ui.hooks = {
    onAxis: (x, y) => input.setVirtualAxis(x, y),
    onJump: (held) => input.setButton("jump", held),
    onModeToggle: () => interact.toggleMode(),
    onSelect: (key) => { inventory.select(key); if (interact.mode !== "build") interact.setMode("build"); },
    onMuteMusic: () => audio.toggleMusicMute(),
    onMuteSfx: () => audio.toggleSfxMute(),
    onHandMagic: () => toggleHandMagic(),
    onPhoto: () => takePhoto()
  };
  inventory.onChange = () => ui.refresh();
  ui.refresh();
  ui.initMinimap(world, CFG.worldSize);

  // world edits -> save + minimap
  world.onEdit = (x, y, z, id) => {
    save.recordEdit(x, y, z, id);
    ui.minimapEdit?.(x, z);
  };
  save.attach(() => ({
    inventory: inventory.serialize(),
    quests: quests.serialize(),
    mode: interact.mode,
    growing: interact.serialize().growing,
    player: { x: player.body.pos.x, y: player.body.pos.y, z: player.body.pos.z },
    jaspea: jaspea.position ? { ...jaspea.position } : null,
    settings: { musicMuted: audio.musicMuted, sfxMuted: audio.sfxMuted }
  }));

  // ---------- hand magic (camera gestures, lazy) ----------
  let handMagic = null, gestureCursor = null, gesturePinching = false, gestureBusy = false;
  function gestureCleanup() {
    handMagic = null; gestureCursor = null; gesturePinching = false;
    player.gestureWalk = false;
    ui.gestureActive(false);
  }
  async function toggleHandMagic() {
    if (gestureBusy) return;
    if (handMagic?.running) {
      handMagic.stop();
      gestureCleanup();
      ui.gestureStatus("");
      return;
    }
    gestureBusy = true;
    ui.gestureStatus(STR.handMagicLoading);
    try {
      const { HandMagic } = await import("./gestures.js");
      handMagic = new HandMagic({
        onCursor: (px, py) => { gestureCursor = { x: px, y: py }; ui.gestureCursor(px, py, gesturePinching); },
        onPinchStart: (px, py) => { gesturePinching = true; interact.tapAt(px, py, false); ui.gestureCursor(px, py, true); },
        onPinchEnd: () => { gesturePinching = false; },
        onPalm: (walking) => { player.gestureWalk = walking; ui.gestureStatus(walking ? STR.handMagicWalk : ""); },
        onStatus: (t) => ui.gestureStatus(t),
        onStopped: () => gestureCleanup()    // camera died mid-session (lock/call)
      });
      await handMagic.start(ui.gesturePreviewContainer());
      ui.gestureActive(!!handMagic.running);
      if (!handMagic.running) handMagic = null;
    } catch (e) {
      console.warn("hand magic failed", e);
      ui.gestureStatus(STR.handMagicError);
      handMagic = null;
    }
    gestureBusy = false;
  }

  function takePhoto() {
    // everything synchronous inside the tap gesture: iOS share sheets require it
    renderer.render(scene, camera);
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const bin = atob(dataUrl.split(",")[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "pinchy-pea.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] })
          .then(() => ui.toast(STR.toastPhoto))
          .catch((e) => { if (e && e.name !== "AbortError") downloadPhoto(file); });
        return;
      }
      downloadPhoto(file);
    } catch (e) { console.warn("photo failed", e); }
  }
  function downloadPhoto(file) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(file);
    a.download = "pinchy-pea.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ui.toast(STR.toastPhotoDownload);
  }

  // ---------- fixed-timestep loop ----------
  const STEP = 1000 / 60;
  let acc = 0, last = performance.now(), paused = false;
  let frames = 0, fpsAt = last, fps = 0, frameCounter = 0;
  let simTime = 0, standCheckT = 0, ambientT = 0;
  const _cullFwd = new THREE.Vector3();

  const landscapeMq = matchMedia("(orientation: landscape) and (max-height: 500px)");
  const resume = () => {
    if (document.hidden || landscapeMq.matches) return;
    paused = false; last = performance.now(); ui.setPaused(false);
  };
  addEventListener("blur", () => { paused = true; ui.setPaused(true); });
  addEventListener("focus", resume);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { paused = true; ui.setPaused(true); }
    else resume();
  });
  // kids rotate phones constantly — the CSS rotate card shows itself; just pause
  landscapeMq.addEventListener?.("change", () => {
    if (landscapeMq.matches) paused = true;
    else resume();
  });
  // iOS can drop the focus event after system overlays — the veil itself resumes
  ui.hooks.onResume = resume;

  // ---------- never stuck: rescue a kid from any pocket they can't escape ----------
  // BFS over standable cells using the real movement rules (step/jump up 1, fall any
  // depth). A closed region under 48 cells means movement alone can't get out.
  let trapT = 0, trapCheckT = 0, flowerHintAt = -60;
  const NEI4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const solidAt = (x, y, z) => world.isSolid(x, y, z);
  const standable = (x, y, z) =>
    y > 0 && y < CFG.worldHeight - 1 && solidAt(x, y - 1, z) && !solidAt(x, y, z) && !solidAt(x, y + 1, z);
  // returns the trapped region's columns as a Set("x,z"), or null when free
  function findTrapRegion() {
    const b = player.body;
    if (!b.onGround || b.inWater) return null;           // water always floats you out
    const sx = Math.floor(b.pos.x), sy = Math.max(1, Math.round(b.pos.y)), sz = Math.floor(b.pos.z);
    if (!standable(sx, sy, sz)) return null;
    const seen = new Set([sx + "," + sy + "," + sz]);
    const cols = new Set([sx + "," + sz]);
    const queue = [[sx, sy, sz]];
    while (queue.length) {
      const [x, y, z] = queue.pop();
      for (let i = 0; i < 4; i++) {
        const nx = x + NEI4[i][0], nz = z + NEI4[i][1];
        let land = -1;
        if (!solidAt(x, y + 2, z) && standable(nx, y + 1, nz)) {
          land = y + 1;                                  // step/jump up one
        } else if (!solidAt(nx, y, nz) && !solidAt(nx, y + 1, nz)) {
          let ny = y;                                    // walk over, fall to a floor
          while (ny > 1 && !solidAt(nx, ny - 1, nz)) ny--;
          if (standable(nx, ny, nz)) land = ny;
        }
        if (land < 0) continue;
        const key = nx + "," + land + "," + nz;
        if (seen.has(key)) continue;
        seen.add(key);
        cols.add(nx + "," + nz);
        if (seen.size >= 48) return null;                // open area — not a trap
        queue.push([nx, land, nz]);
      }
    }
    return cols;                                          // closed pocket
  }
  function rescue(region) {
    const b = player.body;
    const sx = Math.floor(b.pos.x), sz = Math.floor(b.pos.z);
    // nearest open SURFACE column outside the trapped region (the player's own
    // column top is usually still inside the hole they dug)
    for (let r = 1; r <= 8; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = sx + dx, z = sz + dz;
        if (region.has(x + "," + z)) continue;
        if (!world.inBounds(x, 1, z)) continue;
        const ty = world.topSolidY(x, z) + 1;
        if (ty <= CFG.seaLevel) continue;                // never drop them in the sea
        if (!standable(x, ty, z)) continue;
        return teleportTo(x + 0.5, ty, z + 0.5);
      }
    }
    teleportTo(player.spawn.x, player.spawn.y, player.spawn.z);  // worst case: home
  }
  function teleportTo(x, y, z) {
    const b = player.body;
    b.pos.x = x; b.pos.y = y; b.pos.z = z;
    b.vel.x = 0; b.vel.y = 0; b.vel.z = 0;
    player._visualY = y;
    particles.confetti(x, y + 1, z);
    audio.play("cheer", { volume: 0.7 });
    jaspea.sayKey("rescue", true);
    trapT = 0;
  }

  function simUpdate(dtMs) {
    const dt = dtMs / 1000;
    simTime += dt;

    input.update();
    const look = input.consumeLook();
    if (look.dx || look.dy) followCam.applyLook(look.dx, look.dy);
    const zoom = input.consumeZoom();
    if (zoom) followCam.applyZoom(zoom);

    player.update(dt, input.axis(), input.jumpHeld(), followCam.forward(), world, audio);
    jaspea.update(dt, simTime, player.body.pos);
    interact.tick(dt);
    quests.update(dt);
    particles.update(dt);
    save.tick(dt);

    standCheckT += dt;
    if (standCheckT > 0.5) {
      standCheckT = 0;
      quests.checkStand(player.body.pos);
      // flower quest with an empty flower pocket: point at the wild meadow flowers
      const aq = quests.activeQuest();
      if (aq?.id === "flower_garden" && (inventory.counts.flower | 0) === 0 &&
          simTime - flowerHintAt > 30) {
        flowerHintAt = simTime;
        jaspea.sayKey("flowerTip");
      }
    }

    trapCheckT += dt;
    if (trapCheckT > 1) {
      trapCheckT = 0;
      const region = findTrapRegion();
      if (region) { trapT += 1; if (trapT >= 5) rescue(region); }
      else trapT = 0;
    }

    ambientT += dt;
    if (ambientT > 0.5) {
      ambientT = 0;
      let waterNear = 0;
      const px = Math.floor(player.body.pos.x), py = Math.floor(player.body.pos.y), pz = Math.floor(player.body.pos.z);
      for (let dz = -3; dz <= 3; dz += 2) for (let dx = -3; dx <= 3; dx += 2) for (let dy = -1; dy <= 1; dy++) {
        if (world.isWater(px + dx, py + dy, pz + dz)) waterNear++;
      }
      audio.ambientWater(Math.min(1, waterNear / 10) * CFG.volumes.ambient);
    }

    for (const tap of input.consumeTaps()) interact.tapAt(tap.x, tap.y, tap.alt);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (paused) return;
    frameCounter++;
    acc += now - last; last = now;
    if (acc > 250) acc = 250;                      // tab-jank guard
    while (acc >= STEP) { simUpdate(STEP); acc -= STEP; }

    const rdt = Math.min(0.05, (now - (frame._p || now)) / 1000) || 0.016;
    frame._p = now;

    const remeshMs = world.processRemesh(CFG.remeshPerFrame);
    player.render(rdt, simTime);
    const focus = { x: player.body.pos.x, y: player._visualY + 1.1, z: player.body.pos.z };
    followCam.update(rdt, focus, world);

    const hover = gestureCursor ?? input.lastPointer;
    interact.updateHover(hover?.x, hover?.y);
    handMagic?.update(frameCounter);

    // skip chunks past the fog wall (view-depth cull — matches what fog hides)
    camera.getWorldDirection(_cullFwd);
    for (const e of world.meshes.values()) {
      const depth = (e.cx - camera.position.x) * _cullFwd.x +
                    (24 - camera.position.y) * _cullFwd.y +
                    (e.cz - camera.position.z) * _cullFwd.z;
      const vis = depth - 27 < CFG.fogFar;
      if (e.solid) e.solid.visible = vis;
      if (e.water) e.water.visible = vis;
    }

    ui.setYaw(followCam.yaw);
    ui.updateMinimap(player.body.pos.x, player.body.pos.z, followCam.yaw);

    renderer.render(scene, camera);

    if (DEV && (frames++, now - fpsAt >= 500)) {
      fps = Math.round(frames * 1000 / (now - fpsAt)); frames = 0; fpsAt = now;
      const i = renderer.info.render;
      devEl.textContent = `${fps} fps  calls:${i.calls}  tris:${(i.triangles / 1000) | 0}k  q:${world.queue.length}  remesh:${remeshMs.toFixed(1)}ms`;
    }
  }

  if (DEV) window.__game = { world, player, inventory, interact, quests, jaspea, input, followCam, save, gen, audio, ui };

  await audioReady;
  ui.showStart(() => {
    audio.unlock();
    const st = data?.settings;
    if (st) {
      audio.setMusicMuted(!!(st.musicMuted ?? st.muted));   // ?? st.muted: legacy saves
      audio.setSfxMuted(!!(st.sfxMuted ?? st.muted));
      ui.syncMute(audio.musicMuted, audio.sfxMuted);
    }
    audio.music("music");
    ui.hideOverlay();
    if (!data) {
      // forced: scripted tutorial lines must never lose to the ambient-chat cooldown
      jaspea.sayKey("hello", true);
      setTimeout(() => jaspea.sayKey("pinchTip", true), 5000);
      setTimeout(() => jaspea.sayKey("buildTip", true), 14000);
    }
    const q = quests.activeQuest();
    if (q) ui.setQuest(q.name, q.done, q.total);
  });

  requestAnimationFrame(frame);
}

boot().catch(e => {
  console.error("boot failed", e);
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;inset:0;display:grid;place-items:center;background:#f6efe2;color:#3f3429;font-size:18px;padding:24px;text-align:center;";
  d.textContent = STR.loading + " (something went wrong — try reloading)";
  document.body.appendChild(d);
});

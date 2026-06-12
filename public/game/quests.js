import * as THREE from "../vendor/three.module.js";
import { B, BLOCKS } from "./blocks.js";
import { CFG } from "./config.js";
import { STR } from "../strings.js";

// Quest line: one gentle goal at a time. Progress flows in from interact.js
// (onBlockPlaced / onBlockRemoved) and from main's slow stand-check; the
// cozy_home quest draws a softly pulsing "ghost blueprint" the kid fills in,
// like a dashed-outline house waiting to be hugged into existence.

const QUEST_IDS = ["cozy_home", "flower_garden", "bridge", "sky_tower"];

const FLOWER_GOAL = 5;
const BRIDGE_GOAL = 12;
const SKY_Y = 24;                 // sky_tower: stand on a placed block this high
const COZY_FILL_RATIO = 0.85;     // blueprint counts as done at 85% filled
const PLACED_CAP = 4000;          // playerPlaced FIFO cap

// blueprint shape: 6(x) × 4(z) footprint, walls 3 high on the perimeter,
// a 1×2 doorway centered on the front long side, a 1×1 window on the back.
const HOME_W = 6, HOME_D = 4, HOME_H = 3;
const DOOR_DX = 2, DOOR_H = 2;    // doorway column (front side, dz === 0)
const WIN_DX = 3, WIN_LY = 1;     // window cell (back side, mid height)

// inviting clay tints per wall layer (warm cream rising to a blush roofline),
// plus butter-yellow door framing — instanceColor multiplies the white ghost.
const LAYER_TINTS = [0xffe9c9, 0xfff4e2, 0xffd9e6];
const DOOR_TINT = 0xf6df9e;

// ghost opacity pulse: 0.23 ± 0.07 → 0.16..0.30
const PULSE_RATE = 2.4;
const PULSE_PERIOD = (Math.PI * 2) / PULSE_RATE;

function toCount(v, max) {
  return (typeof v === "number" && isFinite(v)) ? Math.max(0, Math.min(max, Math.floor(v))) : 0;
}

export class Quests {
  constructor({ world, homeSite, genHeight, scene, hooks }) {
    this.world = world;
    this.scene = scene;
    this.hooks = hooks || {};
    this.genHeight = genHeight || null;   // pristine worldgen heights — keeps the blueprint
                                          // anchored even after the kid builds on the pad

    const S = CFG.worldSize;
    const hx = (homeSite && typeof homeSite.x === "number") ? Math.floor(homeSite.x) : (S >> 1);
    const hz = (homeSite && typeof homeSite.z === "number") ? Math.floor(homeSite.z) : (S >> 1);
    this.homeSite = {
      x: Math.max(1, Math.min(S - HOME_W - 1, hx)),
      z: Math.max(1, Math.min(S - HOME_D - 1, hz))
    };

    this.activeIndex = 0;
    this.flowerCount = 0;
    this.bridgeCount = 0;
    this.towerBest = 0;              // sky_tower: highest placed block stood on
    this.playerPlaced = new Set();   // "x,y,z" keys, insertion-ordered for FIFO cap
    this._saidAllDone = false;
    this._saidAlmost = false;

    // cozy_home ghost state
    this.ghost = null;
    this.ghostMat = null;
    this._cells = null;              // [{x,y,z,dx,dz,ly}] blueprint wall cells
    this._cellIndex = new Map();     // "x,y,z" -> cell index
    this._filled = null;             // Uint8Array, 1 = cell holds a solid block
    this._cozyDone = 0;
    this._cozyNeeded = 1;
    this._homeY0 = 0;
    this._pulseT = 0;

    // scratch (no per-frame allocation)
    this._m4 = new THREE.Matrix4();
    this._color = new THREE.Color();

    this._activate(0);
  }

  // ---- events from interact.js --------------------------------------------

  onBlockPlaced(x, y, z, id) {
    const def = BLOCKS[id];
    // flowers tracked too, so pinching WILD flowers never docks quest progress
    if (def && (def.solid || id === B.FLOWER)) this._trackPlaced(x + "," + y + "," + z);

    const q = this.activeIndex;
    if (q === 0) {
      if (this._reevalCell(x, y, z)) {
        this._emitProgress();
        this._maybeCompleteCozy();
      }
    } else if (q === 1) {
      if (id === B.FLOWER) {
        this.flowerCount++;
        this._emitProgress();
        if (this.flowerCount >= FLOWER_GOAL) this._complete(x + 0.5, y + 0.5, z + 0.5);
      }
    } else if (q === 2) {
      // a bridge block: solid, with water within the 2 cells directly below at place time
      if (def && def.solid &&
          (this.world.get(x, y - 1, z) === B.WATER || this.world.get(x, y - 2, z) === B.WATER)) {
        this.bridgeCount++;
        this._emitProgress();
        if (this.bridgeCount >= BRIDGE_GOAL) this._complete(x + 0.5, y + 1.5, z + 0.5);
      }
    }
  }

  onBlockRemoved(x, y, z, id) {
    const wasPlaced = this.playerPlaced.delete(x + "," + y + "," + z);

    const q = this.activeIndex;
    if (q === 0) {
      if (this._reevalCell(x, y, z)) this._emitProgress();
    } else if (q === 1 && id === B.FLOWER && wasPlaced && this.flowerCount > 0) {
      this.flowerCount--;                       // pinched own planted flower back up
      this._emitProgress();
    }
  }

  // sky_tower: main calls this ~2/s with the player's feet position.
  // Progress = the highest player-placed block stood on, toward SKY_Y.
  checkStand(pos) {
    if (this.activeIndex !== 3 || !pos) return false;
    // feet within 1.2 above the block top → block y in [py-2.2, py-0.9]
    const byMax = Math.floor(pos.y - 0.9);
    const byMin = Math.max(1, Math.ceil(pos.y - 2.2));
    const bxMin = Math.floor(pos.x - 0.6), bxMax = Math.floor(pos.x + 0.6);
    const bzMin = Math.floor(pos.z - 0.6), bzMax = Math.floor(pos.z + 0.6);
    for (let by = byMax; by >= byMin; by--) {
      for (let bz = bzMin; bz <= bzMax; bz++) {
        if (Math.abs(pos.z - (bz + 0.5)) > 0.6) continue;
        for (let bx = bxMin; bx <= bxMax; bx++) {
          if (Math.abs(pos.x - (bx + 0.5)) > 0.6) continue;
          if (!this.playerPlaced.has(bx + "," + by + "," + bz)) continue;
          if (!this.world.isSolid(bx, by, bz)) continue;
          if (by > this.towerBest) {
            this.towerBest = by;
            this._emitProgress();
            if (!this._saidAlmost && by >= SKY_Y - 6 && by < SKY_Y) {
              this._saidAlmost = true;
              this.hooks.say?.(STR.jaspea.almostClouds);
            }
          }
          if (by >= SKY_Y) {
            this._complete(pos.x, pos.y + 0.8, pos.z);
            return true;
          }
          return false;
        }
      }
    }
    return false;
  }

  // ---- per-frame -----------------------------------------------------------

  update(dt) {
    if (!this.ghost || !this.ghost.visible) return;
    this._pulseT = (this._pulseT + dt) % PULSE_PERIOD;
    this.ghostMat.opacity = 0.23 + Math.sin(this._pulseT * PULSE_RATE) * 0.07;
  }

  // ---- queries -------------------------------------------------------------

  activeQuest() {
    if (this.activeIndex >= QUEST_IDS.length) return null;
    return this._info(this.activeIndex);
  }

  // ---- persistence ---------------------------------------------------------

  serialize() {
    return {
      active: this.activeIndex,
      flowers: this.flowerCount,
      bridge: this.bridgeCount,
      tower: this.towerBest,
      placed: Array.from(this.playerPlaced)
    };
  }

  load(data) {
    if (!data || typeof data !== "object") return;
    const n = QUEST_IDS.length;
    const a = toCount(data.active, n);
    this.flowerCount = toCount(data.flowers, FLOWER_GOAL);
    this.bridgeCount = toCount(data.bridge, BRIDGE_GOAL);
    this.towerBest = toCount(data.tower, SKY_Y);
    this.playerPlaced.clear();
    if (Array.isArray(data.placed)) {
      const start = Math.max(0, data.placed.length - PLACED_CAP);
      for (let i = start; i < data.placed.length; i++) {
        if (typeof data.placed[i] === "string") this.playerPlaced.add(data.placed[i]);
      }
    }
    this._saidAllDone = a >= n;
    if (a >= n) {
      this.activeIndex = a;
      this._disposeGhost();
    } else {
      this._activate(a);   // re-shows ghost + recounts pre-fill if cozy_home
    }
  }

  // ---- quest lifecycle (internal) -------------------------------------------

  _activate(i) {
    this.activeIndex = i;
    if (i === 0) {
      this._activateCozy();
    } else {
      this._disposeGhost();
    }
    this._emitProgress();
    if (i === 0) this._maybeCompleteCozy();   // a loaded world may already qualify
  }

  _complete(cx, cy, cz) {
    const i = this.activeIndex;
    if (i >= QUEST_IDS.length) return;
    const id = QUEST_IDS[i];
    const q = this._info(i);
    q.done = q.total;
    this.hooks.onProgress?.(q, q.done, q.total);   // card reads "total / total"
    if (i === 0) this._disposeGhost();
    this.hooks.confetti?.(cx, cy, cz);
    this.hooks.grant?.(CFG.unlockBundles[id]);
    this.hooks.say?.(STR.quests[id].done);
    this.hooks.onComplete?.(q);
    const next = i + 1;
    if (next < QUEST_IDS.length) {
      this._activate(next);
    } else {
      this.activeIndex = next;                     // free build forever after
      if (!this._saidAllDone) {
        this._saidAllDone = true;
        this.hooks.say?.(STR.questAllDone);
      }
    }
  }

  _info(i) {
    const id = QUEST_IDS[i];
    let done = 0, total = 1;
    if (i === 0) { total = this._cozyNeeded || 1; done = Math.min(this._cozyDone, total); }
    else if (i === 1) { total = FLOWER_GOAL; done = Math.min(this.flowerCount, total); }
    else if (i === 2) { total = BRIDGE_GOAL; done = Math.min(this.bridgeCount, total); }
    else if (i === 3) { total = SKY_Y; done = Math.min(this.towerBest, total); }
    return { id, name: STR.quests[id].name, done, total };
  }

  _emitProgress() {
    if (this.activeIndex >= QUEST_IDS.length) return;
    const q = this._info(this.activeIndex);
    this.hooks.onProgress?.(q, q.done, q.total);
  }

  _trackPlaced(key) {
    if (this.playerPlaced.has(key)) return;
    this.playerPlaced.add(key);
    if (this.playerPlaced.size > PLACED_CAP) {
      this.playerPlaced.delete(this.playerPlaced.values().next().value); // FIFO
    }
  }

  // ---- cozy_home blueprint ---------------------------------------------------

  _activateCozy() {
    this._buildBlueprint();
    this._buildGhost();
    // count cells already filled (bumpy ground, or building done before quests woke up)
    let n = 0;
    for (let i = 0; i < this._cells.length; i++) {
      const c = this._cells[i];
      const f = this.world.isSolid(c.x, c.y, c.z) ? 1 : 0;
      this._filled[i] = f;
      n += f;
    }
    this._cozyDone = n;
  }

  _maybeCompleteCozy() {
    if (this.activeIndex !== 0 || this._cozyDone < this._cozyNeeded) return;
    const s = this.homeSite;
    this._complete(s.x + HOME_W / 2, this._homeY0 + HOME_H, s.z + HOME_D / 2);
  }

  // a wall cell changed under it — re-read the world, returns true if progress moved
  _reevalCell(x, y, z) {
    if (!this._cells) return false;
    const i = this._cellIndex.get(x + "," + y + "," + z);
    if (i === undefined) return false;
    const f = this.world.isSolid(x, y, z) ? 1 : 0;
    if (this._filled[i] === f) return false;
    this._filled[i] = f;
    this._cozyDone += f ? 1 : -1;
    return true;
  }

  _buildBlueprint() {
    const x0 = this.homeSite.x, z0 = this.homeSite.z;
    // rest the blueprint on the highest PRISTINE ground under the pad: worldgen heights
    // are deterministic, so the blueprint can never drift when the kid builds on it
    let y0 = 1;
    for (let dz = 0; dz < HOME_D; dz++) {
      for (let dx = 0; dx < HOME_W; dx++) {
        const t = this.genHeight
          ? this.genHeight[(z0 + dz) * CFG.worldSize + (x0 + dx)]
          : this.world.topSolidY(x0 + dx, z0 + dz);
        if (t > y0) y0 = t;
      }
    }
    y0 = Math.min(y0, CFG.worldHeight - HOME_H - 2);
    this._homeY0 = y0;

    this._cells = [];
    this._cellIndex.clear();
    for (let ly = 0; ly < HOME_H; ly++) {
      const y = y0 + 1 + ly;
      for (let dz = 0; dz < HOME_D; dz++) {
        for (let dx = 0; dx < HOME_W; dx++) {
          const edge = dx === 0 || dx === HOME_W - 1 || dz === 0 || dz === HOME_D - 1;
          if (!edge) continue;
          if (dz === 0 && dx === DOOR_DX && ly < DOOR_H) continue;            // doorway
          if (dz === HOME_D - 1 && dx === WIN_DX && ly === WIN_LY) continue;  // window
          const x = x0 + dx, z = z0 + dz;
          this._cellIndex.set(x + "," + y + "," + z, this._cells.length);
          this._cells.push({ x, y, z, dx, dz, ly });
        }
      }
    }
    const total = this._cells.length;   // perimeter minus holes, counted not hard-coded
    this._cozyNeeded = Math.max(1, Math.ceil(total * COZY_FILL_RATIO));
    this._filled = new Uint8Array(total);
    this._cozyDone = 0;
  }

  _buildGhost() {
    this._disposeGhost();
    const geo = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    const mat = new THREE.MeshLambertMaterial({
      transparent: true, opacity: 0.22, color: 0xffffff, depthWrite: false
    });
    const mesh = new THREE.InstancedMesh(geo, mat, this._cells.length);
    mesh.frustumCulled = false;   // tiny static cluster; skip stale-bounds culling
    mesh.renderOrder = 3;         // after water (2) so it shimmers above ponds
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    for (let i = 0; i < this._cells.length; i++) {
      const c = this._cells[i];
      this._m4.makeTranslation(c.x + 0.5, c.y + 0.5, c.z + 0.5);
      mesh.setMatrixAt(i, this._m4);
      const doorFrame = c.dz === 0 && c.ly < DOOR_H &&
        (c.dx === DOOR_DX - 1 || c.dx === DOOR_DX + 1);
      this._color.setHex(doorFrame ? DOOR_TINT : LAYER_TINTS[c.ly]);
      mesh.setColorAt(i, this._color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this.ghost = mesh;
    this.ghostMat = mat;
  }

  _disposeGhost() {
    if (!this.ghost) return;
    this.scene.remove(this.ghost);
    this.ghost.geometry.dispose();
    this.ghostMat.dispose();
    this.ghost = null;
    this.ghostMat = null;
  }
}

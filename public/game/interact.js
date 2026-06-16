import * as THREE from "../vendor/three.module.js";
import { B, BLOCKS, byKey } from "./blocks.js";
import { CFG } from "./config.js";
import { collides } from "./physics.js";
import { STR } from "../strings.js";

// The hero verb: PINCH (harvest) and PLACE (build), plus growing things.
// Taps arrive in canvas pixels; gestures and gamepad reuse the same path.
export class Interact {
  constructor({ world, scene, camera, player, jaspea, inventory, particles, audio, quests, ui }) {
    Object.assign(this, { world, scene, camera, player, jaspea, inventory, particles, audio, quests, ui });
    this.mode = "pinch";                       // "pinch" | "build"
    this.growing = [];                          // {x,y,z,id,t}
    this._refuseAt = 0;                         // refusal-feedback rate limiter
    this._flashT = 0;                           // highlight flash timer (s)
    this._farTaps = 0; this._farTapAt = 0;      // consecutive too-far taps

    const box = new THREE.BoxGeometry(1.04, 1.04, 1.04);
    const edges = new THREE.EdgesGeometry(box);
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.18, gapSize: 0.1, linewidth: 2 })
    );
    this.highlight.computeLineDistances?.();
    this.highlight.geometry.computeBoundingSphere();
    this.highlight.visible = false;
    scene.add(this.highlight);

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  setMode(m) {
    this.mode = m;
    this.ui?.onModeChanged?.(m);
  }
  toggleMode() { this.setMode(this.mode === "pinch" ? "build" : "pinch"); }

  _rayFromPixel(px, py) {
    this._ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    this._origin.copy(this._ray.ray.origin);
    this._dir.copy(this._ray.ray.direction);
  }

  _hit(px, py) {
    this._rayFromPixel(px, py);
    const hit = this.world.castRay(this._origin, this._dir, 80);
    if (!hit) return null;
    const p = this.player.body.pos;
    const dx = hit.x + 0.5 - p.x, dy = hit.y + 0.5 - (p.y + 1), dz = hit.z + 0.5 - p.z;
    hit.tooFar = Math.sqrt(dx * dx + dy * dy + dz * dz) > CFG.reach;
    return hit;
  }

  // a tap that can't work still answers: a brief shaky flash + a soft squish "nuh-uh"
  _refuse(hit, toastKey) {
    const now = performance.now();
    if (now - this._refuseAt < 700) return;
    this._refuseAt = now;
    if (hit) {
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.highlight.material.color.setHex(0xff9b9b);
      this.highlight.visible = true;
      this._flashT = 0.4;
    }
    this.audio.play("pinch", { rate: 0.6, volume: 0.5 });
    if (toastKey) this.ui?.toast?.(toastKey);
  }

  updateHover(px, py) {
    if (this._flashT > 0) return;               // let a refusal flash play out
    if (px == null) { this.highlight.visible = false; return; }
    const hit = this._hit(px, py);
    if (!hit || hit.tooFar) { this.highlight.visible = false; return; }
    let hx = hit.x, hy = hit.y, hz = hit.z;
    if (this.mode === "build") { hx += hit.face[0]; hy += hit.face[1]; hz += hit.face[2]; }
    this.highlight.position.set(hx + 0.5, hy + 0.5, hz + 0.5);
    this.highlight.visible = true;
    const pulse = 1 + Math.sin(performance.now() / 240) * 0.03;
    this.highlight.scale.setScalar(pulse);
  }

  tapAt(px, py, altMode = false) {
    // pinching Jaspea is always allowed — she giggles
    if (this.jaspea && this._tapJaspea(px, py)) return;
    const mode = altMode ? (this.mode === "pinch" ? "build" : "pinch") : this.mode;
    const hit = this._hit(px, py);
    if (!hit) return;                            // sky taps stay silent — expected
    if (hit.tooFar) {
      const now = performance.now();
      this._farTaps = (now - this._farTapAt < 4000) ? this._farTaps + 1 : 1;
      this._farTapAt = now;
      this._refuse(hit, this._farTaps >= 3 ? STR.toastTooFar : null);
      if (this._farTaps >= 3) this._farTaps = 0;
      return;
    }
    if (mode === "pinch") this._pinch(hit);
    else this._place(hit);
  }

  _tapJaspea(px, py) {
    this._rayFromPixel(px, py);
    const jp = this.jaspea.position;
    if (!jp) return false;
    const sphere = new THREE.Sphere(new THREE.Vector3(jp.x, jp.y + 0.4, jp.z), 0.7);
    if (this._ray.ray.intersectsSphere(sphere)) {
      const p = this.player.body.pos;
      if (Math.hypot(jp.x - p.x, jp.z - p.z) < CFG.reach + 1) {
        this.jaspea.squeeze();
        this.audio.play("giggle", { ratejitter: 0.08 });
        this.quests?.onJaspeaHug?.(jp.x, jp.y, jp.z);
        return true;
      }
    }
    return false;
  }

  _pinch(hit) {
    const id = this.world.get(hit.x, hit.y, hit.z);
    const def = BLOCKS[id];
    if (!def.pick) return;
    if (hit.y <= 0) return;                    // the world's clay base stays
    this.world.set(hit.x, hit.y, hit.z, B.AIR);
    this._unGrow(hit.x, hit.y, hit.z);
    if (def.drops) this.inventory.add(def.drops, 1);
    this.particles.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, def.tint ?? 0xffffff, 10);
    this.audio.play("pinch", { ratejitter: 0.15 });
    this.quests?.onBlockRemoved(hit.x, hit.y, hit.z, id);
  }

  _place(hit) {
    const x = hit.x + hit.face[0], y = hit.y + hit.face[1], z = hit.z + hit.face[2];
    if (!this.world.inBounds(x, y, z)) return;
    const cur = this.world.get(x, y, z);
    if (cur !== B.AIR && cur !== B.WATER) return;
    const key = this.inventory.selected;
    if (!this.inventory.has(key)) { this.ui?.toastNoClay?.(key); return; }
    const id = byKey[key].id;
    // never trap the heroes inside clay — and SAY so instead of ignoring the tap
    if (byKey[key].solid && this._insideJaspea(x, y, z)) {
      this.jaspea.squeeze();
      this._refuse(null);
      return;
    }
    if (byKey[key].solid && this._insideBody(this.player.body, x, y, z)) {
      this._refuse(hit, STR.toastOnYou);
      return;
    }
    this.inventory.consume(key, 1);
    this.world.set(x, y, z, id);
    if (id === B.SAPLING) this.growing.push({ x, y, z, id, t: CFG.growTimeS });
    if (id === B.FLOWER) this.particles.sparkle(x + 0.5, y + 0.6, z + 0.5, 0xfff0b0);
    this.particles.burst(x + 0.5, y + 0.5, z + 0.5, byKey[key].tint ?? 0xffffff, 6, { up: 2.5 });
    this.audio.play("place", { ratejitter: 0.1 });
    this.quests?.onBlockPlaced(x, y, z, id);
  }

  _insideBody(body, x, y, z) {
    const hw = body.w / 2;
    return x + 1 > body.pos.x - hw && x < body.pos.x + hw &&
           z + 1 > body.pos.z - hw && z < body.pos.z + hw &&
           y + 1 > body.pos.y && y < body.pos.y + body.h;
  }
  _insideJaspea(x, y, z) {
    const jp = this.jaspea?.position;
    if (!jp) return false;
    return Math.abs(x + 0.5 - jp.x) < 0.8 && Math.abs(z + 0.5 - jp.z) < 0.8 &&
           y + 1 > jp.y && y < jp.y + 1;
  }
  _unGrow(x, y, z) {
    this.growing = this.growing.filter(g => g.x !== x || g.y !== y || g.z !== z);
  }

  tick(dt) {
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flashT <= 0) {
        this.highlight.material.color.setHex(0xffffff);
        this.highlight.visible = false;
      }
    }
    for (const g of this.growing) {
      g.t -= dt;
      if (g.t > 0 && Math.random() < dt * 0.6) {
        this.particles.sparkle(g.x + 0.5, g.y + 0.7, g.z + 0.5, 0xc8f0b0);
      }
    }
    const ready = this.growing.filter(g => g.t <= 0);
    if (ready.length) {
      this.growing = this.growing.filter(g => g.t > 0);
      for (const g of ready) this._growTree(g);
    }
  }

  _growTree(g) {
    if (this.world.get(g.x, g.y, g.z) !== B.SAPLING) return;
    const trunkH = 3, ty = g.y + trunkH;
    // every cell about to turn solid; if a hero is inside any of them, wait politely
    const cells = [];
    for (let i = 0; i < trunkH; i++) cells.push([g.x, g.y + i, g.z]);
    for (let dy = 0; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dy === 2 && (dx !== 0 || dz !== 0)) continue;
      if (dy === 0 && Math.abs(dx) + Math.abs(dz) === 2) continue;
      if (this.world.get(g.x + dx, ty + dy, g.z + dz) === B.AIR) cells.push([g.x + dx, ty + dy, g.z + dz]);
    }
    for (const [x, y, z] of cells) {
      if (this._insideBody(this.player.body, x, y, z) || this._insideJaspea(x, y, z)) {
        g.t = 0.75;                 // re-queue: grow once the heroes step aside
        this.growing.push(g);
        return;
      }
    }
    // trunk never overwrites the kid's own builds — only the sapling cell and open air
    for (let i = 0; i < trunkH; i++) {
      const cur = this.world.get(g.x, g.y + i, g.z);
      if (i === 0 || cur === B.AIR || cur === B.WATER) {
        this.world.set(g.x, g.y + i, g.z, B.WOOD);
      }
    }
    for (let dy = 0; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dy === 2 && (dx !== 0 || dz !== 0)) continue;
      if (dy === 0 && Math.abs(dx) + Math.abs(dz) === 2) continue;
      if (this.world.get(g.x + dx, ty + dy, g.z + dz) === B.AIR) {
        this.world.set(g.x + dx, ty + dy, g.z + dz, B.LEAF);
      }
    }
    this.particles.confetti(g.x + 0.5, ty + 1, g.z + 0.5);
    this.audio.play("cheer", { volume: 0.6 });
    this.jaspea?.sayKey?.("grow");
    this.quests?.onTreeGrown?.(g.x, g.y, g.z);
  }

  serialize() { return { mode: this.mode, growing: this.growing }; }
  load(d) { if (d) { this.setMode(d.mode || "pinch"); this.growing = d.growing || []; } }
}

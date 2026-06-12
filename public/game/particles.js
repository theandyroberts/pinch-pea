import * as THREE from "../vendor/three.module.js";

// Clay-crumb particles: one InstancedMesh, fixed pool, zero allocations per frame.
// Every visual effect in the game (pinch crumbs, place sparkles, quest confetti)
// funnels through this single 320-instance pool — one draw call, ever.

const CAPACITY = 320;
const MAX_DT = 0.1; // clamp huge frame gaps (tab switch) so physics never explodes

// Pastel confetti palette, pre-decoded to linear-ish rgb floats once at module load.
const PASTELS_HEX = [0xf2aab8, 0xbfaae8, 0xf4dc92, 0xa7d2f2, 0xfff4e2, 0x9ed98c];
const PASTELS = new Float32Array(PASTELS_HEX.length * 3);
{
  const c = new THREE.Color();
  for (let i = 0; i < PASTELS_HEX.length; i++) {
    c.setHex(PASTELS_HEX[i]);
    PASTELS[i * 3] = c.r; PASTELS[i * 3 + 1] = c.g; PASTELS[i * 3 + 2] = c.b;
  }
}

export class Particles {
  constructor(scene) {
    const geo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // SoA particle state — everything preallocated, nothing grows.
    this._pos = new Float32Array(CAPACITY * 3);
    this._vel = new Float32Array(CAPACITY * 3);
    this._ang = new Float32Array(CAPACITY * 3);     // accumulated euler angles
    this._angVel = new Float32Array(CAPACITY * 3);  // tumble speed rad/s
    this._life = new Float32Array(CAPACITY);        // remaining seconds
    this._lifeTotal = new Float32Array(CAPACITY);
    this._grav = new Float32Array(CAPACITY);        // per-particle gravity
    this._scale = new Float32Array(CAPACITY);       // base scale multiplier
    this._flat = new Float32Array(CAPACITY);        // y-scale ratio (confetti flakes < 1)

    // Active list (swap-remove) + free stack — O(1) alloc/free, no GC.
    this._active = new Uint16Array(CAPACITY);
    this._activeCount = 0;
    this._free = new Uint16Array(CAPACITY);
    this._freeCount = CAPACITY;
    for (let i = 0; i < CAPACITY; i++) this._free[i] = CAPACITY - 1 - i;

    // Scratch objects reused by every spawn/update — never reallocated.
    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    // Hide all instances (scale 0) and force-create instanceColor up front so the
    // attribute buffer exists before the first frame (setColorAt lazily allocates it).
    const arr = this.mesh.instanceMatrix.array;
    arr.fill(0);
    this._c.setRGB(1, 1, 1);
    for (let i = 0; i < CAPACITY; i++) this.mesh.setColorAt(i, this._c);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this._colorsDirty = false;
    this._matricesDirty = false;

    scene.add(this.mesh);
  }

  // ---- public effects ------------------------------------------------------

  // Clay crumbs flying off a pinched/placed block.
  burst(x, y, z, colorHex, count = 10, opts = { spread: 2.4, up: 3.2 }) {
    const spread = (opts && opts.spread != null) ? opts.spread : 2.4;
    const up = (opts && opts.up != null) ? opts.up : 3.2;
    this._c.setHex(colorHex == null ? 0xffffff : colorHex);
    const r = this._c.r, g = this._c.g, b = this._c.b;
    const n = Math.min(count | 0, CAPACITY);
    for (let k = 0; k < n; k++) {
      // uniform random direction (sphere), no rejection loop
      const ct = Math.random() * 2 - 1;
      const st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const phi = Math.random() * Math.PI * 2;
      const mag = spread * (0.35 + 0.65 * Math.random());
      const vx = st * Math.cos(phi) * mag;
      const vy = ct * mag + up * (0.55 + 0.45 * Math.random());
      const vz = st * Math.sin(phi) * mag;
      const j = 1 + (Math.random() * 2 - 1) * 0.08; // color jitter ±8%
      this._spawn(
        x, y, z, vx, vy, vz,
        0.55 + Math.random() * 0.25,       // life 0.55–0.8s
        -14,
        0.7 + Math.random() * 0.6, 1,      // chunky round crumbs
        5 + Math.random() * 6,             // moderate tumble
        clamp01(r * j), clamp01(g * j), clamp01(b * j)
      );
    }
  }

  // A few tiny crumbs drifting upward — "something nice happened here".
  sparkle(x, y, z, colorHex) {
    this._c.setHex(colorHex == null ? 0xffffff : colorHex);
    // brighten toward white so sparkles read as light, not dirt
    const r = this._c.r + (1 - this._c.r) * 0.4;
    const g = this._c.g + (1 - this._c.g) * 0.4;
    const b = this._c.b + (1 - this._c.b) * 0.4;
    for (let k = 0; k < 4; k++) {
      this._spawn(
        x + (Math.random() - 0.5) * 0.5,
        y + Math.random() * 0.2,
        z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 0.3,
        0.55 + Math.random() * 0.55,       // gentle rise
        (Math.random() - 0.5) * 0.3,
        0.9, 0,                            // life 0.9s, no gravity
        0.4 + Math.random() * 0.2, 1,      // tiny
        1.5 + Math.random() * 2,           // lazy spin
        r, g, b
      );
    }
  }

  // Quest-complete celebration: pastel flakes raining down with a tumble.
  confetti(x, y, z) {
    for (let k = 0; k < 46; k++) {
      const ct = Math.random() * 2 - 1;
      const st = Math.sqrt(Math.max(0, 1 - ct * ct));
      const phi = Math.random() * Math.PI * 2;
      const mag = 4 * (0.3 + 0.7 * Math.random());
      const p = (Math.random() * PASTELS_HEX.length) | 0;
      this._spawn(
        x, y, z,
        st * Math.cos(phi) * mag,
        ct * mag + 6 * (0.5 + 0.5 * Math.random()),
        st * Math.sin(phi) * mag,
        1.6, -6,                           // long life, floaty fall
        0.8 + Math.random() * 0.7,
        0.35,                              // flattened — reads as a paper flake
        8 + Math.random() * 10,            // big tumble
        PASTELS[p * 3], PASTELS[p * 3 + 1], PASTELS[p * 3 + 2]
      );
    }
  }

  // ---- per-frame (hot path: zero allocations) ------------------------------

  update(dt) {
    if (!(dt > 0)) return;
    if (dt > MAX_DT) dt = MAX_DT;
    const n = this._activeCount;
    if (n === 0 && !this._matricesDirty && !this._colorsDirty) return;

    const pos = this._pos, vel = this._vel, ang = this._ang, angVel = this._angVel;
    const life = this._life, lifeTotal = this._lifeTotal, grav = this._grav;
    const scale = this._scale, flat = this._flat;
    const active = this._active;
    const matArr = this.mesh.instanceMatrix.array;
    const m4 = this._m4, q = this._q, e = this._e, v = this._v, s = this._s;

    for (let a = this._activeCount - 1; a >= 0; a--) {
      const i = active[a];
      const remaining = life[i] - dt;
      if (remaining <= 0) {
        // hide + free: zero matrix collapses the box to nothing
        matArr.fill(0, i * 16, i * 16 + 16);
        this._free[this._freeCount++] = i;
        this._activeCount--;
        active[a] = active[this._activeCount]; // swap-remove
        continue;
      }
      life[i] = remaining;

      const i3 = i * 3;
      vel[i3 + 1] += grav[i] * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      ang[i3] += angVel[i3] * dt;
      ang[i3 + 1] += angVel[i3 + 1] * dt;
      ang[i3 + 2] += angVel[i3 + 2] * dt;

      // hold full size, then shrink away over the last ~40% of life
      const f = remaining / lifeTotal[i];
      const sz = scale[i] * (f > 0.4 ? 1 : f * 2.5);

      v.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      e.set(ang[i3], ang[i3 + 1], ang[i3 + 2]);
      q.setFromEuler(e);
      s.set(sz, sz * flat[i], sz);
      m4.compose(v, q, s);
      m4.toArray(matArr, i * 16);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this._matricesDirty = false;
    if (this._colorsDirty) {
      this.mesh.instanceColor.needsUpdate = true;
      this._colorsDirty = false;
    }
  }

  // ---- internals -----------------------------------------------------------

  _spawn(x, y, z, vx, vy, vz, lifeS, gravity, baseScale, flatRatio, tumble, r, g, b) {
    let i;
    if (this._freeCount > 0) {
      i = this._free[--this._freeCount];
      this._active[this._activeCount++] = i;
    } else {
      // pool exhausted: recycle the front of the active list (oldest-ish) in place
      i = this._active[0];
    }
    const i3 = i * 3;
    this._pos[i3] = x; this._pos[i3 + 1] = y; this._pos[i3 + 2] = z;
    this._vel[i3] = vx; this._vel[i3 + 1] = vy; this._vel[i3 + 2] = vz;
    this._ang[i3] = Math.random() * Math.PI * 2;
    this._ang[i3 + 1] = Math.random() * Math.PI * 2;
    this._ang[i3 + 2] = Math.random() * Math.PI * 2;
    this._angVel[i3] = (Math.random() - 0.5) * 2 * tumble;
    this._angVel[i3 + 1] = (Math.random() - 0.5) * 2 * tumble;
    this._angVel[i3 + 2] = (Math.random() - 0.5) * 2 * tumble;
    this._life[i] = lifeS;
    this._lifeTotal[i] = lifeS;
    this._grav[i] = gravity;
    this._scale[i] = baseScale;
    this._flat[i] = flatRatio;

    this._c.setRGB(r, g, b);
    this.mesh.setColorAt(i, this._c);
    this._colorsDirty = true;

    // write the initial matrix immediately so the crumb appears this frame,
    // even if update() runs after render ordering hiccups
    this._v.set(x, y, z);
    this._e.set(this._ang[i3], this._ang[i3 + 1], this._ang[i3 + 2]);
    this._q.setFromEuler(this._e);
    this._s.set(baseScale, baseScale * flatRatio, baseScale);
    this._m4.compose(this._v, this._q, this._s);
    this._m4.toArray(this.mesh.instanceMatrix.array, i * 16);
    this._matricesDirty = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

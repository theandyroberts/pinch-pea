import * as THREE from "../vendor/three.module.js";
import { BLOCKS, uvRect } from "./blocks.js";
import { CFG } from "./config.js";

// Voxel world: flat Uint8Array store + per-chunk merged meshes with baked vertex AO.
// One opaque mesh + (optional) one water mesh per chunk -> draw calls stay bounded.

const S = CFG.worldSize, H = CFG.worldHeight, CS = CFG.chunkSize;
const NCHUNK = S / CS;

// face tables: [dir, corners(4) as offsets, normal]
const FACES = [
  { d: [1, 0, 0],  c: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]] },
  { d: [-1, 0, 0], c: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]] },
  { d: [0, 1, 0],  c: [[0,1,0],[0,1,1],[1,1,1],[1,1,0]] },
  { d: [0, -1, 0], c: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]] },
  { d: [0, 0, 1],  c: [[1,0,1],[1,1,1],[0,1,1],[0,0,1]] },
  { d: [0, 0, -1], c: [[0,0,0],[0,1,0],[1,1,0],[1,0,0]] }
];
const AO_CURVE = [0.45, 0.62, 0.8, 1.0];

export class World {
  constructor(scene, atlasTexture) {
    this.scene = scene;
    this.data = new Uint8Array(S * H * S);
    this.dirty = new Set();
    this.queue = [];
    this.meshes = new Map(); // "cx,cz" -> {solid, water}
    this.onEdit = null;      // hook (save system, quests, minimap)

    this.matSolid = new THREE.MeshLambertMaterial({
      map: atlasTexture, vertexColors: true
    });
    this.matWater = new THREE.MeshLambertMaterial({
      map: atlasTexture, vertexColors: true, transparent: true, opacity: 0.78,
      depthWrite: false
    });
    this._tintCache = BLOCKS.map(b => {
      const c = new THREE.Color(b.tint ?? 0xffffff);
      return [c.r, c.g, c.b];
    });
  }

  inBounds(x, y, z) { return x >= 0 && x < S && y >= 0 && y < H && z >= 0 && z < S; }
  idx(x, y, z) { return x + (z * S) + (y * S * S); }
  get(x, y, z) { return this.inBounds(x, y, z) ? this.data[this.idx(x, y, z)] : 0; }
  isSolid(x, y, z) { return BLOCKS[this.get(x, y, z)].solid === true; }
  isWater(x, y, z) { return this.get(x, y, z) === 8; }

  // silent set during worldgen
  setRaw(x, y, z, id) { if (this.inBounds(x, y, z)) this.data[this.idx(x, y, z)] = id; }

  set(x, y, z, id, opts = {}) {
    if (!this.inBounds(x, y, z)) return false;
    const old = this.data[this.idx(x, y, z)];
    if (old === id) return false;
    this.data[this.idx(x, y, z)] = id;
    this.markDirty(x, z);
    if (x % CS === 0) this.markDirty(x - 1, z);
    if (x % CS === CS - 1) this.markDirty(x + 1, z);
    if (z % CS === 0) this.markDirty(x, z - 1);
    if (z % CS === CS - 1) this.markDirty(x, z + 1);
    if (this.onEdit && !opts.silent) this.onEdit(x, y, z, id, old);
    return true;
  }

  markDirty(x, z) {
    if (x < 0 || z < 0 || x >= S || z >= S) return;
    const key = Math.floor(x / CS) + "," + Math.floor(z / CS);
    if (!this.dirty.has(key)) { this.dirty.add(key); this.queue.push(key); }
  }

  markAllDirty() {
    for (let cz = 0; cz < NCHUNK; cz++) for (let cx = 0; cx < NCHUNK; cx++) {
      const key = cx + "," + cz;
      if (!this.dirty.has(key)) { this.dirty.add(key); this.queue.push(key); }
    }
  }

  // returns ms spent; processes up to n chunks per call
  processRemesh(n = CFG.remeshPerFrame) {
    const t0 = performance.now();
    let done = 0;
    while (this.queue.length && done < n) {
      const key = this.queue.shift();
      this.dirty.delete(key);
      const [cx, cz] = key.split(",").map(Number);
      this.remeshChunk(cx, cz);
      done++;
    }
    return performance.now() - t0;
  }

  topSolidY(x, z) {
    for (let y = H - 1; y >= 0; y--) {
      const b = BLOCKS[this.get(x, y, z)];
      if (b.solid) return y;
    }
    return 0;
  }

  remeshChunk(cx, cz) {
    const x0 = cx * CS, z0 = cz * CS;
    const sp = [], sn = [], su = [], sc = [], si = [];   // solid buffers
    const wp = [], wn = [], wu = [], wc = [], wi = [];   // water buffers

    for (let y = 0; y < H; y++) for (let z = z0; z < z0 + CS; z++) for (let x = x0; x < x0 + CS; x++) {
      const id = this.get(x, y, z);
      if (id === 0) continue;
      const def = BLOCKS[id];
      if (def.water) { this.emitWater(x, y, z, wp, wn, wu, wc, wi); continue; }
      if (def.partial) { this.emitPartial(x, y, z, def, sp, sn, su, sc, si); continue; }
      this.emitCube(x, y, z, def, sp, sn, su, sc, si);
    }

    const key = cx + "," + cz;
    const prev = this.meshes.get(key);
    if (prev) {
      if (prev.solid) { this.scene.remove(prev.solid); prev.solid.geometry.dispose(); }
      if (prev.water) { this.scene.remove(prev.water); prev.water.geometry.dispose(); }
    }
    const entry = { solid: null, water: null };
    if (si.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(sn, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(su, 2));
      g.setAttribute("color", new THREE.Float32BufferAttribute(sc, 3));
      g.setIndex(si);
      const m = new THREE.Mesh(g, this.matSolid);
      m.matrixAutoUpdate = false;
      this.scene.add(m);
      entry.solid = m;
    }
    if (wi.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(wn, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(wu, 2));
      g.setAttribute("color", new THREE.Float32BufferAttribute(wc, 3));
      g.setIndex(wi);
      const m = new THREE.Mesh(g, this.matWater);
      m.matrixAutoUpdate = false;
      m.renderOrder = 2;
      this.scene.add(m);
      entry.water = m;
    }
    this.meshes.set(key, entry);
  }

  occludes(x, y, z) {
    const b = BLOCKS[this.get(x, y, z)];
    return b.solid === true && !b.partial;
  }

  vertexAO(x, y, z, d, corner) {
    // standard voxel AO: two sides + corner relative to face plane
    let s1, s2, co;
    if (d[0] !== 0) {
      s1 = this.occludes(x + d[0], y + (corner[1] ? 1 : -1), z) ? 1 : 0;
      s2 = this.occludes(x + d[0], y, z + (corner[2] ? 1 : -1)) ? 1 : 0;
      co = this.occludes(x + d[0], y + (corner[1] ? 1 : -1), z + (corner[2] ? 1 : -1)) ? 1 : 0;
    } else if (d[1] !== 0) {
      s1 = this.occludes(x + (corner[0] ? 1 : -1), y + d[1], z) ? 1 : 0;
      s2 = this.occludes(x, y + d[1], z + (corner[2] ? 1 : -1)) ? 1 : 0;
      co = this.occludes(x + (corner[0] ? 1 : -1), y + d[1], z + (corner[2] ? 1 : -1)) ? 1 : 0;
    } else {
      s1 = this.occludes(x + (corner[0] ? 1 : -1), y, z + d[2]) ? 1 : 0;
      s2 = this.occludes(x, y + (corner[1] ? 1 : -1), z + d[2]) ? 1 : 0;
      co = this.occludes(x + (corner[0] ? 1 : -1), y + (corner[1] ? 1 : -1), z + d[2]) ? 1 : 0;
    }
    return (s1 && s2) ? 0 : 3 - (s1 + s2 + co);
  }

  emitCube(x, y, z, def, P, N, U, C, I) {
    const [tr, tg, tb] = this._tintCache[def.id];
    const [u0, v0, u1, v1] = uvRect(def.tile);
    const uvc = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
    for (const f of FACES) {
      const nx = x + f.d[0], ny = y + f.d[1], nz = z + f.d[2];
      const nDef = BLOCKS[this.get(nx, ny, nz)];
      if (nDef.solid && !nDef.partial) continue;          // hidden face
      const base = P.length / 3;
      for (let i = 0; i < 4; i++) {
        const c = f.c[i];
        P.push(x + c[0], y + c[1], z + c[2]);
        N.push(f.d[0], f.d[1], f.d[2]);
        U.push(uvc[i][0], uvc[i][1]);
        const ao = AO_CURVE[this.vertexAO(x, y, z, f.d, c)];
        C.push(tr * ao, tg * ao, tb * ao);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  emitPartial(x, y, z, def, P, N, U, C, I) {
    const s = def.partial, o = (1 - s) / 2;
    const [tr, tg, tb] = this._tintCache[def.id];
    const [u0, v0, u1, v1] = uvRect(def.tile);
    const uvc = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
    for (const f of FACES) {
      const base = P.length / 3;
      for (let i = 0; i < 4; i++) {
        const c = f.c[i];
        P.push(x + o + c[0] * s, y + c[1] * s, z + o + c[2] * s);
        N.push(f.d[0], f.d[1], f.d[2]);
        U.push(uvc[i][0], uvc[i][1]);
        C.push(tr, tg, tb);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  emitWater(x, y, z, P, N, U, C, I) {
    const [tr, tg, tb] = this._tintCache[8];
    const [u0, v0, u1, v1] = uvRect(2);
    const uvc = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
    for (const f of FACES) {
      const nx = x + f.d[0], ny = y + f.d[1], nz = z + f.d[2];
      const nid = this.get(nx, ny, nz);
      if (nid !== 0) continue;                             // only faces against air
      const base = P.length / 3;
      const drop = f.d[1] === 1 ? 0.12 : 0;                // sunken water surface
      for (let i = 0; i < 4; i++) {
        const c = f.c[i];
        P.push(x + c[0], y + c[1] - (c[1] ? drop : 0), z + c[2]);
        N.push(f.d[0], f.d[1], f.d[2]);
        U.push(uvc[i][0], uvc[i][1]);
        C.push(tr, tg, tb);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  // DDA voxel raycast; hits pickable non-water blocks. Returns null or
  // {x,y,z, face:[nx,ny,nz]}
  castRay(origin, dir, maxDist) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-10));
    const tDeltaY = Math.abs(1 / (dir.y || 1e-10));
    const tDeltaZ = Math.abs(1 / (dir.z || 1e-10));
    let tMaxX = tDeltaX * (dir.x > 0 ? (x + 1 - origin.x) : (origin.x - x));
    let tMaxY = tDeltaY * (dir.y > 0 ? (y + 1 - origin.y) : (origin.y - y));
    let tMaxZ = tDeltaZ * (dir.z > 0 ? (z + 1 - origin.z) : (origin.z - z));
    let face = [0, 0, 0], t = 0;
    while (t <= maxDist) {
      const id = this.get(x, y, z);
      if (id !== 0 && !BLOCKS[id].water) return { x, y, z, face, dist: t };
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; face = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; face = [0, -stepY, 0];
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ];
      }
      if (y < 0 || y >= H) return null;
    }
    return null;
  }
}

import { CFG } from "./config.js";
import { BLOCKS } from "./blocks.js";

// Persistence. One localStorage key holds the whole game as JSON:
//   {v:1, edits:{"x,y,z":id}, inventory, quests, mode, growing,
//    player:{x,y,z}, jaspea:{x,y,z}, settings:{muted}}
// `edits` is the only world data we store — a sparse diff against the seeded
// world (worldgen is deterministic from CFG.worldSeed, so diffs reproduce it).
// Placing air stores 0; re-editing a cell overwrites its key. Storage failures
// (quota, private mode) warn once and never interrupt play.

const KEY = "pinchy-pea-v1";
const SILENT = Object.freeze({ silent: true });

function finite(n) { return typeof n === "number" && Number.isFinite(n); }

function sanitizeVec(p) {
  return (p && finite(p.x) && finite(p.y) && finite(p.z))
    ? { x: p.x, y: p.y, z: p.z } : null;
}

// Drop any edit entry that could poison the world store (bad coords, or an id
// outside BLOCKS — a Uint8Array write of e.g. 255 would later crash remeshing).
function sanitizeEdits(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(raw)) {
    const id = raw[k];
    if (!Number.isInteger(id) || id < 0 || id >= BLOCKS.length) continue;
    const p = k.split(",");
    if (p.length !== 3) continue;
    const x = +p[0], y = +p[1], z = +p[2];
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) continue;
    out[x + "," + y + "," + z] = id;
  }
  return out;
}

export class SaveGame {
  constructor() {
    this.edits = Object.create(null);   // "x,y,z" -> block id (0 = air)
    this._getState = null;
    this._dirty = false;
    this._timer = 0;
    this._warned = false;

    // Flush on tab-away / app-switch. pagehide too: iOS Safari can kill the
    // page without a reliable visibilitychange.
    this._onVis = () => { if (document.visibilityState === "hidden") this.saveNow(); };
    this._onHide = () => this.saveNow();
    document.addEventListener("visibilitychange", this._onVis);
    addEventListener("pagehide", this._onHide);
  }

  // main wires this to world.onEdit (and replays loaded edits through it on
  // boot, so this instance owns the full diff set).
  recordEdit(x, y, z, id) {
    if (!finite(x) || !finite(y) || !finite(z) || !finite(id)) return;
    const key = Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z);
    id |= 0;
    if (this.edits[key] === id) return;
    this.edits[key] = id;
    this._dirty = true;
  }

  // getState() returns the snapshot minus edits (main provides).
  attach(getState) { this._getState = getState; }

  // Called once per sim tick. Allocation-free; autosaves only when dirty —
  // and from an idle callback, not the sim frame, so the JSON.stringify of a
  // long-lived edit set never hitches the game right while the kid is building.
  tick(dt) {
    this._timer += dt;
    if (this._timer < CFG.saveInterval) return;
    this._timer = 0;
    if (!this._dirty || this._pendingIdle) return;
    this._pendingIdle = true;
    const run = () => { this._pendingIdle = false; if (this._dirty) this.saveNow(); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 250);     // iOS < 18 has no requestIdleCallback
  }

  saveNow() {
    // Before attach() there is no full snapshot yet; writing a partial save
    // here would clobber inventory/quests from the previous session. Skip —
    // nothing the player did can be lost before the sim loop starts.
    if (!this._getState) return;
    let snap = null;
    try { snap = this._getState(); } catch (e) { this._warnOnce(e); }

    const data = { v: 1, edits: this.edits };
    if (snap && typeof snap === "object") {
      for (const k of Object.keys(snap)) {
        if (k !== "v" && k !== "edits") data[k] = snap[k];
      }
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      this._dirty = false;
      this._timer = 0;
    } catch (e) {
      this._warnOnce(e);   // quota / private mode: keep playing
    }
  }

  // Replay this instance's edits onto a freshly generated world.
  // Call AFTER worldgen, BEFORE the first mesh build (main does the ordering).
  applyEdits(world) {
    if (!world) return;
    for (const key of Object.keys(this.edits)) {
      const p = key.split(",");
      world.set(+p[0], +p[1], +p[2], this.edits[key], SILENT);
    }
  }

  // Fresh world (not exposed in UI yet).
  clear() {
    this.edits = Object.create(null);
    this._dirty = false;
    this._timer = 0;
    try { localStorage.removeItem(KEY); } catch (e) { this._warnOnce(e); }
  }

  // Parsed + sanitized save data, or null (corrupt / absent / unreadable).
  // Every field main.js reads is either well-typed or null after this.
  static load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); }
    catch (e) { console.warn("[save] storage unavailable", e); return null; }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || data.v !== 1) {
        console.warn("[save] unrecognized save data — starting fresh");
        return null;
      }
      data.edits = sanitizeEdits(data.edits);
      data.player = sanitizeVec(data.player);
      data.jaspea = sanitizeVec(data.jaspea);
      if (typeof data.mode !== "string") data.mode = null;
      if (!data.inventory || typeof data.inventory !== "object") data.inventory = null;
      if (!data.quests || typeof data.quests !== "object") data.quests = null;
      if (!data.growing || typeof data.growing !== "object") data.growing = null;
      if (!data.settings || typeof data.settings !== "object") data.settings = null;
      return data;
    } catch (e) {
      console.warn("[save] corrupt save — starting fresh", e);
      return null;
    }
  }

  _warnOnce(e) {
    if (this._warned) return;
    this._warned = true;
    console.warn("[save] could not write save (continuing without)", e);
  }
}

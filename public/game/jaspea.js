import { CFG } from "./config.js";
import { B } from "./blocks.js";
import { STR } from "../strings.js";
import { mulberry32 } from "./rng.js";

// Jaspea: Peathan's tiny pea-sprout buddy. No physics body — she glides over the
// terrain (topSolidY + 1) with a hop arc, follows the player with hysteresis so she
// never jitters at the boundary, and never, ever blocks the player. She chats through
// the onSay callback (rate-limited so she stays charming, not chatty).

const FOLLOW_START = 3.2;        // start hopping when player is farther than this
const FOLLOW_STOP = 2.2;         // settle when this close (hysteresis band)
const FOLLOW_SPEED = 3.4;        // u/s
const TELEPORT_DIST = 18;        // player ran far -> pop in behind them
const TELEPORT_GAP = 2.6;        // how far behind the player she reappears

const HOP_HEIGHT = 0.25;         // sin bump while moving
const HOP_RATE = 10;             // rad/s -> a hop every ~0.31s
const TURN_RATE = 10;            // rad/s facing slew
const GROUND_LERP = 12;          // y smoothing toward topSolidY+1
const GROUND_SNAP = 4;           // bigger gap than this -> snap (teleports, cliffs)
const MOVE_BLEND = 8;            // ease in/out of the hop animation

const SAY_COOLDOWN = 6;          // 1 line / 6s, drop if busy
const IDLE_MIN = 18, IDLE_RANGE = 12;   // ambient line every 18-30s
const ENV_PERIOD = 2;            // surroundings scan cadence (alternates water/blossom)
const BIOME_COOLDOWN = 60;       // nearWater / nearBlossom at most once per minute

const WOBBLE_DUR = 0.85;         // squeeze() jelly wobble length

const IDLE_KEYS = ["idle1", "idle2", "idle3"];

// 8 sample offsets per scan pass (flat arrays, zero per-scan allocation).
// Water: cardinal columns at 1 and 3 blocks out, sampled at the sea surface.
const WATER_OFF = [1, 0, -1, 0, 0, 1, 0, -1, 3, 0, -3, 0, 0, 3, 0, -3];
// Blossom: overhead + ring, sampled at canopy height. Trees have trunks 3-4 tall,
// so canopies start at feet+3 or feet+4 — passes alternate between the two heights.
const BLOSSOM_OFF = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 2, 0, -2, 0, 0, 2];

const WMIN = 1.5, WMAX = CFG.worldSize - 1.5;

export class Jaspea {
  constructor(scene, world, char) {
    this.world = world;
    this.char = char;
    this.onSay = null;                       // main wires this to the UI speech bubble

    scene.add(char.group);

    // feet position (the group origin); _y is the terrain-following base, hop adds on top
    this._x = WMIN; this._y = 0; this._z = WMIN;
    this._facing = 0;
    this._following = false;
    this._moveBlend = 0;
    this._hopPhase = 0;
    this._speed = 0;

    this._clock = 0;
    this._lastSayAt = -1e9;
    this._lastWaterAt = -1e9;
    this._lastBlossomAt = -1e9;

    this._rng = mulberry32((CFG.worldSeed ^ 0x5f356495) >>> 0);
    this._idleTimer = 0;
    this._idleNext = IDLE_MIN + this._rng() * IDLE_RANGE;
    this._idleIdx = 0;

    this._envTimer = 0;
    this._envPass = 0;
    this._blossomDy = 3;

    this._wobbleT = -1;                      // <0 means inactive
    this._prevPX = NaN; this._prevPZ = NaN;  // player heading estimate for teleports

    // reused every frame — never reallocated
    this._animState = { moving: false, speed: 0, grounded: true, swimming: false };
  }

  spawnAt(x, y, z) {
    this._x = Math.min(WMAX, Math.max(WMIN, x));
    this._z = Math.min(WMAX, Math.max(WMIN, z));
    this._y = y;
    this._following = false;
    this._moveBlend = 0;
    this._hopPhase = 0;
    this._speed = 0;
    this._wobbleT = -1;
    this._prevPX = NaN; this._prevPZ = NaN;
    const g = this.char.group;
    g.position.set(this._x, this._y, this._z);
    g.rotation.y = this._facing;
    g.scale.set(1, 1, 1);
  }

  get position() { return { x: this._x, y: this._y, z: this._z }; }

  update(dt, time, playerPos) {
    if (!(dt > 0)) dt = 0;                   // NaN/negative guard
    else if (dt > 0.1) dt = 0.1;             // tab-switch spike guard
    this._clock += dt;

    let moving = false;

    if (playerPos) {
      const dx = playerPos.x - this._x;
      const dz = playerPos.z - this._z;
      const dist = Math.hypot(dx, dz);

      if (dist > TELEPORT_DIST) {
        this._teleportBehind(playerPos, dx, dz, dist);
      } else {
        if (dist > FOLLOW_START) this._following = true;
        else if (dist < FOLLOW_STOP) this._following = false;

        if (this._following && dist > 1e-4) {
          const inv = 1 / dist;
          const step = Math.min(FOLLOW_SPEED * dt, Math.max(0, dist - FOLLOW_STOP));
          this._x += dx * inv * step;
          this._z += dz * inv * step;
          moving = step > 1e-5;
          if (moving) this._turnToward(Math.atan2(dx, dz), dt);
        } else if (dist > 1.2) {
          // idling: drift her gaze toward Peathan (slow, gentle)
          this._turnToward(Math.atan2(dx, dz), dt * 0.3);
        }
      }
      this._prevPX = playerPos.x;
      this._prevPZ = playerPos.z;
    }

    // never wander off the world's edge
    if (this._x < WMIN) this._x = WMIN; else if (this._x > WMAX) this._x = WMAX;
    if (this._z < WMIN) this._z = WMIN; else if (this._z > WMAX) this._z = WMAX;

    // terrain follow: smooth lerp, snap across big gaps so she never tunnels
    const gy = this.world.topSolidY(this._x | 0, this._z | 0) + 1;
    if (Math.abs(gy - this._y) > GROUND_SNAP) this._y = gy;
    else this._y += (gy - this._y) * Math.min(1, GROUND_LERP * dt);

    // hop arc, eased by the move blend so stopping mid-hop settles softly
    const blendTgt = moving ? 1 : 0;
    this._moveBlend += (blendTgt - this._moveBlend) * Math.min(1, MOVE_BLEND * dt);
    if (this._moveBlend > 0.002) this._hopPhase += dt * HOP_RATE;
    else this._hopPhase = 0;
    const bump = Math.abs(Math.sin(this._hopPhase)) * HOP_HEIGHT * this._moveBlend;
    this._speed = FOLLOW_SPEED * this._moveBlend;

    const g = this.char.group;
    g.position.set(this._x, this._y + bump, this._z);
    g.rotation.y = this._facing;

    // squeeze(): decaying jelly wobble on the group (origin at feet, so it squashes
    // downward like clay). Composes with char.animate's internal body motion.
    if (this._wobbleT >= 0) {
      this._wobbleT += dt;
      if (this._wobbleT >= WOBBLE_DUR) {
        this._wobbleT = -1;
        g.scale.set(1, 1, 1);
      } else {
        const t = this._wobbleT;
        const a = Math.exp(-3.4 * t) * Math.cos(16 * t) * 0.22;
        g.scale.set(1 + a * 0.7, 1 - a, 1 + a * 0.7);
      }
    }

    const st = this._animState;
    st.moving = this._moveBlend > 0.05;
    st.speed = this._speed;
    this.char.animate(dt, time, st);

    // ambient chatter
    this._idleTimer += dt;
    if (this._idleTimer >= this._idleNext) {
      this._idleTimer = 0;
      this._idleNext = IDLE_MIN + this._rng() * IDLE_RANGE;
      if (this.sayKey(IDLE_KEYS[this._idleIdx])) {
        this._idleIdx = (this._idleIdx + 1) % IDLE_KEYS.length;
      }
    }

    // surroundings scan — 8 world.get samples once per 2s, never per frame
    this._envTimer += dt;
    if (this._envTimer >= ENV_PERIOD) {
      this._envTimer -= ENV_PERIOD;
      this._scanSurroundings();
    }
  }

  // giggle: clay wobble + a happy line (interact.js calls this when she's pinched)
  squeeze() {
    this._wobbleT = 0;
    this.sayKey("giggle");
  }

  celebrate() {
    this.char.celebrate();
    this.sayKey("cheer");
  }

  // Look up STR.jaspea[key]; at most one line per 6s — busy means the line is dropped.
  // force=true bypasses the cooldown (scripted tutorial lines must never vanish).
  // Returns true if the line was actually spoken.
  sayKey(key, force = false) {
    const text = STR.jaspea[key];
    if (!text) return false;
    if (!force && this._clock - this._lastSayAt < SAY_COOLDOWN) return false;
    this._lastSayAt = this._clock;
    this._idleTimer = 0;                     // any spoken line resets the idle pacing
    if (this.onSay) this.onSay(text);
    return true;
  }

  // ---- internals ---------------------------------------------------------

  _turnToward(target, dtScaled) {
    let d = target - this._facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this._facing += d * Math.min(1, TURN_RATE * dtScaled);
  }

  // Player outran her: reappear just behind their direction of travel.
  _teleportBehind(p, dx, dz, dist) {
    let hx = p.x - this._prevPX;
    let hz = p.z - this._prevPZ;
    let hl = Math.hypot(hx, hz);
    if (!(hl > 1e-4)) { hx = dx; hz = dz; hl = dist; }   // fallback: keep her side
    const k = TELEPORT_GAP / hl;
    this._x = Math.min(WMAX, Math.max(WMIN, p.x - hx * k));
    this._z = Math.min(WMAX, Math.max(WMIN, p.z - hz * k));
    this._y = this.world.topSolidY(this._x | 0, this._z | 0) + 1;
    this._facing = Math.atan2(p.x - this._x, p.z - this._z);
    this._following = true;
    this._moveBlend = 0;
    this._hopPhase = 0;
  }

  // Alternating passes (water / blossom), exactly 8 block reads each, every 2s.
  _scanSurroundings() {
    const w = this.world;
    const fx = this._x | 0, fy = this._y | 0, fz = this._z | 0;
    this._envPass ^= 1;

    if (this._envPass === 1) {
      // sea water sits at seaLevel-1; only worth checking when she's near the shore
      if (fy > CFG.seaLevel + 3) return;
      if (this._clock - this._lastWaterAt < BIOME_COOLDOWN) return;
      const wy = CFG.seaLevel - 1;
      for (let i = 0; i < 16; i += 2) {
        if (w.get(fx + WATER_OFF[i], wy, fz + WATER_OFF[i + 1]) === B.WATER) {
          if (this.sayKey("nearWater")) this._lastWaterAt = this._clock;
          return;
        }
      }
    } else {
      const dy = this._blossomDy;
      this._blossomDy = dy === 3 ? 4 : 3;
      if (this._clock - this._lastBlossomAt < BIOME_COOLDOWN) return;
      for (let i = 0; i < 16; i += 2) {
        const id = w.get(fx + BLOSSOM_OFF[i], fy + dy, fz + BLOSSOM_OFF[i + 1]);
        if (id === B.BLOSSOMLEAF) {
          if (this.sayKey("nearBlossom")) this._lastBlossomAt = this._clock;
          return;
        }
      }
    }
  }
}

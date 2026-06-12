// WebAudio manager. Lazy AudioContext (iOS Safari needs a user gesture), graceful
// when files are missing, never throws into the game loop. All tuning from CFG.
import { CFG } from "./config.js";

const MUTE_LS_KEY = "pinchy-pea-muted";
const NO_OPTS = {};
const STEP_OPTS = { volume: 0.55, ratejitter: 0.18 };

// decodeAudioData via the callback form — works on every Safari that matters.
function decodeBuffer(ctx, raw) {
  return new Promise((resolve, reject) => {
    try { ctx.decodeAudioData(raw, resolve, reject); }
    catch (err) { reject(err); }
  });
}

export class AudioMan {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = Object.create(null);     // key -> AudioBuffer
    this._pendingRaw = Object.create(null); // key -> ArrayBuffer fetched before ctx existed
    this._absent = Object.create(null);     // key -> true (failed; warned once)
    this._keyGain = Object.create(null);    // key -> GainNode for one-shots

    this._muted = false;
    try { this._muted = localStorage.getItem(MUTE_LS_KEY) === "1"; }
    catch (err) { /* storage unavailable (private mode) — default unmuted */ }

    this._musicKey = null;
    this._musicStarted = false;

    this._ambient = null;        // { src, gain } while the water loop is alive
    this._ambientTarget = 0;     // last scheduled gain target
    this._ambientQuietAt = -1;   // ctx time when target hit ~0 (for deferred stop)

    this._lastStepAt = -Infinity;

    // iOS: the context gets suspended/"interrupted" when the tab hides or a call
    // comes in — nudge it back when we become visible again.
    this._onVisibility = () => {
      if (document.visibilityState === "visible" && this.ctx && this.ctx.state !== "running") {
        try { this.ctx.resume().catch(() => {}); } catch (err) { /* ignore */ }
      }
    };
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  get muted() { return this._muted; }

  // manifest = { key: url, ... } — fetch everything in parallel; a missing or
  // corrupt file warns once and is simply absent forever. Never rejects.
  async load(manifest) {
    if (!manifest) return;
    const jobs = [];
    for (const key of Object.keys(manifest)) jobs.push(this._fetchOne(key, manifest[key]));
    await Promise.all(jobs); // each job swallows its own errors
  }

  async _fetchOne(key, url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      const raw = await res.arrayBuffer();
      if (this.ctx) await this._decodeOne(key, raw);
      else this._pendingRaw[key] = raw; // decode once unlock() makes a context
    } catch (err) {
      this._markAbsent(key, err);
    }
  }

  async _decodeOne(key, raw) {
    try {
      this.buffers[key] = await decodeBuffer(this.ctx, raw);
      if (key === this._musicKey) this._tryStartMusic();
    } catch (err) {
      this._markAbsent(key, err);
    }
  }

  _markAbsent(key, err) {
    if (this._absent[key]) return;
    this._absent[key] = true;
    console.warn('[audio] "' + key + '" unavailable:', err && err.message ? err.message : err);
  }

  // Call from the first user gesture (and any later one — it's idempotent).
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this._muted ? 0 : 1;
        this.master.connect(this.ctx.destination);
      } catch (err) {
        this.ctx = null;
        this.master = null;
        return;
      }
      // Decode anything that was fetched before the context existed.
      for (const key of Object.keys(this._pendingRaw)) {
        const raw = this._pendingRaw[key];
        delete this._pendingRaw[key];
        this._decodeOne(key, raw);
      }
    }
    if (this.ctx.state !== "running") {
      try { this.ctx.resume().catch(() => {}); } catch (err) { /* ignore */ }
    }
    this._tryStartMusic();
  }

  // One-shot SFX. Skips quietly if the buffer or context isn't ready.
  play(key, opts = NO_OPTS) {
    const ctx = this.ctx;
    const buf = this.buffers[key];
    if (!ctx || !buf) return;
    if (ctx.state !== "running") {
      // Sources started while suspended play on resume; nudge it along.
      try { ctx.resume().catch(() => {}); } catch (err) { /* ignore */ }
    }
    const volume = opts.volume !== undefined ? opts.volume : 1;
    const rate = opts.rate !== undefined ? opts.rate : 1;
    const jitter = opts.ratejitter || 0;
    try {
      let gain = this._keyGain[key];
      if (!gain) {
        gain = ctx.createGain();
        gain.connect(this.master);
        this._keyGain[key] = gain;
      }
      gain.gain.setValueAtTime(Math.max(0, volume * CFG.volumes.sfx), ctx.currentTime);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.max(0.05, rate * (1 + jitter * (Math.random() * 2 - 1)));
      src.connect(gain);
      src.start();
    } catch (err) {
      /* audio must never crash the game */
    }
  }

  // Background music: loops forever with a 2s fade-in. Only ever starts once;
  // safe to call before unlock()/load() finish — it starts when both are ready.
  music(key) {
    if (this._musicKey === null) this._musicKey = key;
    this._tryStartMusic();
  }

  _tryStartMusic() {
    if (this._musicStarted || this._musicKey === null) return;
    const ctx = this.ctx;
    const buf = this.buffers[this._musicKey];
    if (!ctx || !buf) return;
    try {
      const gain = ctx.createGain();
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(CFG.volumes.music, t + 2);
      gain.connect(this.master);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start();
      this._musicStarted = true;
    } catch (err) {
      /* leave _musicStarted false — a later call may succeed */
    }
  }

  // Looping water ambience. Called every frame with a desired loudness; the gain
  // glides toward it. Source starts on demand and stops shortly after silence.
  ambientWater(target) {
    const ctx = this.ctx;
    const buf = this.buffers.water;
    if (!ctx || !buf) return;
    const t = Math.min(CFG.volumes.ambient, Math.max(0, target || 0));
    const now = ctx.currentTime;

    if (t > 0.001) {
      this._ambientQuietAt = -1;
      if (!this._ambient) {
        try {
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0001, now);
          gain.connect(this.master);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(gain);
          src.start();
          this._ambient = { src, gain };
          this._ambientTarget = 0;
        } catch (err) {
          return;
        }
      }
      // Only reschedule when the target actually moved (keeps the param
      // timeline tiny even though we're called per frame).
      if (Math.abs(t - this._ambientTarget) > 0.002) {
        this._ambientTarget = t;
        try { this._ambient.gain.gain.setTargetAtTime(t, now, 0.3); } catch (err) { /* ignore */ }
      }
    } else if (this._ambient) {
      if (this._ambientTarget !== 0) {
        this._ambientTarget = 0;
        try { this._ambient.gain.gain.setTargetAtTime(0.0001, now, 0.2); } catch (err) { /* ignore */ }
      }
      if (this._ambientQuietAt < 0) {
        this._ambientQuietAt = now;
      } else if (now - this._ambientQuietAt > 0.8) {
        try { this._ambient.src.stop(); } catch (err) { /* already stopped */ }
        try { this._ambient.src.disconnect(); } catch (err) { /* ignore */ }
        try { this._ambient.gain.disconnect(); } catch (err) { /* ignore */ }
        this._ambient = null;
        this._ambientQuietAt = -1;
      }
    }
  }

  // Footsteps, throttled — call freely from the movement code.
  footstep() {
    const now = performance.now() * 0.001;
    if (now - this._lastStepAt < CFG.stepSfxInterval) return;
    this._lastStepAt = now;
    this.play("step", STEP_OPTS);
  }

  toggleMute() {
    this._muted = !this._muted;
    try { localStorage.setItem(MUTE_LS_KEY, this._muted ? "1" : "0"); }
    catch (err) { /* storage unavailable — mute still works for this session */ }
    if (this.ctx && this.master) {
      const target = this._muted ? 0 : 1;
      try { this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02); }
      catch (err) { this.master.gain.value = target; }
    }
    return this._muted;
  }
}

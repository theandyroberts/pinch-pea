import { CFG } from "./config.js";
import { BLOCKS, byKey, PALETTE_ORDER } from "./blocks.js";

// All DOM HUD for Pinchy Pea. The game canvas stays clean — everything visual
// that isn't the world lives here, inside the #ui root (pointer-events:none;
// interactive children re-enable themselves).
//
// Aesthetic: pastel claymation. Cream rounded panels, chunky pressable buttons,
// soft shadows. Every player-visible string comes from STR (passed as
// `strings`); emoji/letters below are decorative icons mandated by the UI
// contract (compass letters, north marker, button glyphs), not copy.

const TAU = Math.PI * 2;
const STYLE_ID = "pp-ui-style";
const MUTE_LS_KEY = "pinchy-pea-muted";          // legacy (read once for migration)
const MUSIC_LS_KEY = "pinchy-pea-muted-music";   // legacy music bool
const MUSIC_LVL_KEY = "pinchy-pea-music-level";  // 0 normal · 1 low · 2 mute
const SFX_LS_KEY = "pinchy-pea-muted-sfx";

// Icon glyphs (contract-specified; labels for a11y come from STR).
const ICO = {
  pinch: "\u{1F90F}",      // 🤏
  build: "\u{1F9F1}",      // 🧱
  sound: "\u{1F50A}",      // 🔊
  soundOff: "\u{1F507}",   // 🔇
  music: "\u{1F3B5}",      // 🎵
  hand: "\u{1F590}",       // 🖐
  photo: "\u{1F4F7}",      // 📷
  jump: "⬆️",    // ⬆️
  palette: "\u{1F3A8}",    // 🎨
  spark: "✨"          // ✨
};
const COMPASS_LETTERS = ["N", "E", "S", "W"]; // contract: compass strip letters
const COMPASS_DOT = "·";                 // · separator (decorative)
const NORTH_GLYPH = "N";                      // contract: minimap north marker

// Natural tile colors (mirrors blocks.js TILE_FALLBACK — the clay base each
// tint multiplies). Used for swatches + minimap so colors match the world.
const TILE_RGB = [0x9ed98c, 0xd99a78, 0xf2e7d4, 0xb8b0c4, 0xa07a58, 0x86c66e, 0xeee0b8, 0xffffff];
const MAP_VOID_RGB = [0x6f, 0xb2, 0xd8];      // deep sea / out-of-world

// Compass strip geometry: 8 items (4 letters + 4 dots) × 28px = 224px cycle.
const C_ITEM = 28, C_CYCLE = 224, C_WINDOW = 150;
const C_BASE = C_WINDOW / 2 - C_ITEM / 2 - C_CYCLE; // letter center -> window center

// Minimap drawing constants (no per-frame string building).
const MM_D = 120;                              // CSS pixels, circle diameter
const MM_CONE = "rgba(255,255,255,0.32)";
const MM_DOT = "#7fc163";
const MM_DOT_RING = "#ffffff";
const MM_CONE_LEN = 20, MM_CONE_HALF = 0.5;
const MM_COS = Math.cos(MM_CONE_HALF), MM_SIN = Math.sin(MM_CONE_HALF);

const BUBBLE_MS = 3500, BUBBLE_GAP_MS = 240, BUBBLE_QUEUE_MAX = 2;
const TOAST_MS = 2000, TOAST_MAX = 3;
const QUEST_CELEBRATE_MS = 3000;
const JOY_R = 44;                              // joystick knob travel radius (px)

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function btn(cls, parent) {
  const b = el("button", cls, parent);
  b.type = "button";
  return b;
}

function blockRGB(def) {
  if (!def || def.tile == null || def.tile < 0) return 0xffffff;
  const base = TILE_RGB[def.tile] ?? 0xffffff;
  const tint = def.tint ?? 0xffffff;
  const r = Math.round(((base >> 16) & 255) * (((tint >> 16) & 255) / 255));
  const g = Math.round(((base >> 8) & 255) * (((tint >> 8) & 255) / 255));
  const b = Math.round((base & 255) * ((tint & 255) / 255));
  return (r << 16) | (g << 8) | b;
}

function cssHex(n) {
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export class UI {
  constructor(root, { inventory, strings }) {
    this.root = root;
    this.inv = inventory;
    this.str = strings || {};
    this.hooks = {};               // main assigns ui.hooks = {...} after construction

    // mode + quest + bubble state
    this._mode = "pinch";
    this._qName = null;
    this._qDone = -1;
    this._qCelebrating = false;
    this._qPending = null;
    this._qCelT = 0;
    this._bubbleShowing = false;
    this._bubbleQ = [];
    this._bubbleT = 0;
    this._startCb = null;
    this._overlayHideT = 0;
    this._drawerOpen = false;
    this._gPinch = false;
    this._gCursorShown = false;
    this._yawF = -1;

    // minimap state (filled by initMinimap)
    this._mmWorld = null;
    this._mmS = 0;
    this._mmOff = null;
    this._mmOffCtx = null;
    this._mmImg = null;
    this._mmLut = null;
    this._mmCtx = null;
    this._mmDirty = false;
    this._mmLX = 1e9; this._mmLZ = 1e9; this._mmLYaw = 1e9;

    // persisted mute state for the speaker icon (audio.js owns the truth)
    this._musicLevel = 0;
    this._mutedSfx = false;
    try {
      const legacy = localStorage.getItem(MUTE_LS_KEY) === "1";
      const lvl = localStorage.getItem(MUSIC_LVL_KEY);
      if (lvl !== null) this._musicLevel = Math.min(2, Math.max(0, lvl | 0));
      else if (legacy || localStorage.getItem(MUSIC_LS_KEY) === "1") this._musicLevel = 2;
      this._mutedSfx = legacy || localStorage.getItem(SFX_LS_KEY) === "1";
    } catch (e) { /* private mode */ }

    // precomputed swatch colors for every palette block
    this._swatchCss = {};
    for (const k of PALETTE_ORDER) this._swatchCss[k] = cssHex(blockRGB(byKey[k]));

    injectStyle();
    root.classList.add("pp-ui");
    this._els = {};
    this._slots = [];
    this._palItems = [];
    this._build();
    this.refresh();

    // window lost focus mid-press: release visuals (input.js clears its own state)
    addEventListener("blur", () => this._releaseAllPresses());
  }

  // ======================================================================
  // DOM construction
  // ======================================================================

  _build() {
    const E = this._els, S = this.str;

    // --- compass (top-center) -------------------------------------------
    const compass = el("div", "pp-compass", this.root);
    const strip = el("div", "pp-compass-strip", compass);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 4; i++) {
        const L = el("span", COMPASS_LETTERS[i] === "N" ? "pp-cl pp-n" : "pp-cl", strip);
        L.textContent = COMPASS_LETTERS[i];
        const d = el("span", "pp-cl pp-cdot", strip);
        d.textContent = COMPASS_DOT;
      }
    }
    el("div", "pp-compass-notch", compass);
    E.compassStrip = strip;

    // --- small icon row (top-right): music / sounds / hand magic / photo ----
    const row = el("div", "pp-iconrow", this.root);
    E.musicBtn = this._iconButton(row, ICO.music, S.btnMusic, () => {
      const r = this.hooks.onMusicCycle ? this.hooks.onMusicCycle() : (this._musicLevel + 1) % 3;
      this._musicLevel = typeof r === "number" ? r : (this._musicLevel + 1) % 3;
      this._paintMute();
      const t = [S.toastMusicOn, S.toastMusicLow, S.toastMusicOff][this._musicLevel];
      if (t) this.toast(t);
    });
    E.musicIco = E.musicBtn.firstChild;
    E.sfxBtn = this._iconButton(row, this._mutedSfx ? ICO.soundOff : ICO.sound, S.btnSfx, () => {
      const r = this.hooks.onMuteSfx ? this.hooks.onMuteSfx() : !this._mutedSfx;
      this._mutedSfx = typeof r === "boolean" ? r : !this._mutedSfx;
      this._paintMute();
    });
    E.sfxIco = E.sfxBtn.firstChild;
    this._paintMute = () => {
      E.musicBtn.classList.toggle("pp-low", this._musicLevel === 1);
      E.musicBtn.classList.toggle("pp-off", this._musicLevel === 2);
      E.musicBtn.setAttribute("aria-pressed", this._musicLevel === 2 ? "true" : "false");
      E.sfxIco.textContent = this._mutedSfx ? ICO.soundOff : ICO.sound;
      E.sfxBtn.classList.toggle("pp-off", this._mutedSfx);
      E.sfxBtn.setAttribute("aria-pressed", this._mutedSfx ? "true" : "false");
    };
    this._paintMute();
    E.handBtn = this._iconButton(row, ICO.hand, S.btnHandMagic, () => {
      this.hooks.onHandMagic && this.hooks.onHandMagic();
    });
    E.photoBtn = this._iconButton(row, ICO.photo, S.btnPhoto, () => {
      this.hooks.onPhoto && this.hooks.onPhoto();
    });

    // --- gesture status chip (top-left, under the compass band) ----------
    E.chip = el("div", "pp-chip", this.root);
    E.chip.setAttribute("aria-live", "polite");

    // --- quest card (top-right, under the icon row) -----------------------
    const quest = el("div", "pp-quest", this.root);
    E.quest = quest;
    E.questTitle = el("div", "pp-quest-title", quest);
    E.questTitle.textContent = S.questTitle ?? "";
    E.questName = el("div", "pp-quest-name", quest);
    E.questProg = el("div", "pp-quest-prog", quest);
    quest.setAttribute("aria-live", "polite");

    // --- palette drawer (left edge tab + sliding panel) -------------------
    E.scrim = el("div", "pp-scrim", this.root);
    E.scrim.addEventListener("pointerdown", (e) => {
      if (e.cancelable) e.preventDefault();
      this._setDrawer(false);
    }, { passive: false });

    const drawer = el("div", "pp-drawer", this.root);
    E.drawer = drawer;
    for (const key of PALETTE_ORDER) {
      const item = btn("pp-pal-item", drawer);
      const sw = el("span", "pp-swatch", item);
      sw.style.backgroundColor = this._swatchCss[key];
      const nm = el("span", "pp-pal-name", item);
      nm.textContent = (S.blocks && S.blocks[key]) ?? key;
      const ct = el("span", "pp-pal-count", item);
      item.setAttribute("aria-label", nm.textContent);
      // click (not pointerdown) so touch-scrolling the list never selects
      item.addEventListener("click", () => {
        this.inv.select(key);
        this.hooks.onSelect && this.hooks.onSelect(key);
        this._setDrawer(false);
      });
      this._palItems.push({ key, el: item, countEl: ct, lastN: -1 });
    }

    const tab = btn("pp-pal-tab nudge", this.root);   // pulse until first opened
    E.tab = tab;
    tab.setAttribute("aria-label", S.btnPalette ?? "");
    tab.setAttribute("aria-expanded", "false");
    const tabIco = el("span", "pp-tab-ico", tab);
    tabIco.textContent = ICO.palette;
    E.tabDot = el("span", "pp-tab-dot", tab);
    this._bindTap(tab, () => this._setDrawer(!this._drawerOpen));

    // --- virtual joystick (bottom-left) -----------------------------------
    this._buildJoystick();

    // --- gesture camera preview bubble (above the joystick) ---------------
    E.gpreview = el("div", "pp-gpreview", this.root);

    // --- jump + mode cluster (bottom-right) --------------------------------
    const cluster = el("div", "pp-cluster", this.root);
    const modeBtn = btn("pp-btn pp-btn-mode", cluster);
    E.modeBtn = modeBtn;
    E.modeIco = el("span", "pp-ico", modeBtn);
    E.modeLbl = el("span", "pp-lbl", modeBtn);
    this._bindTap(modeBtn, () => {
      this.hooks.onModeToggle && this.hooks.onModeToggle();
    });
    this._applyModeButton();

    const jumpBtn = btn("pp-btn pp-btn-jump", cluster);
    E.jumpBtn = jumpBtn;
    const jIco = el("span", "pp-ico", jumpBtn);
    jIco.textContent = ICO.jump;
    const jLbl = el("span", "pp-lbl", jumpBtn);
    jLbl.textContent = S.btnJump ?? "";
    jumpBtn.setAttribute("aria-label", S.btnJump ?? "");
    this._bindHold(jumpBtn, (held) => {
      this.hooks.onJump && this.hooks.onJump(held);
    });

    // --- minimap (bottom-right circle, above the cluster) ------------------
    const map = el("div", "pp-map", this.root);
    E.mapCanvas = el("canvas", "pp-map-canvas", map);
    E.mapCanvas.width = MM_D; E.mapCanvas.height = MM_D;
    const north = el("div", "pp-map-n", map);
    north.textContent = NORTH_GLYPH;

    // --- hotbar (bottom-center, first six palette blocks) ------------------
    const hotbar = el("div", "pp-hotbar", this.root);
    for (const key of PALETTE_ORDER.slice(0, 6)) {
      const slot = btn("pp-slot", hotbar);
      const sw = el("span", "pp-swatch", slot);
      sw.style.backgroundColor = this._swatchCss[key];
      const ct = el("span", "pp-count", slot);
      slot.setAttribute("aria-label", (S.blocks && S.blocks[key]) ?? key);
      this._bindTap(slot, () => {
        this.inv.select(key);
        this.hooks.onSelect && this.hooks.onSelect(key);
      });
      this._slots.push({ key, el: slot, countEl: ct, lastN: -1 });
    }

    // --- speech bubble (above bottom-center) --------------------------------
    E.bubble = el("div", "pp-bubble", this.root);
    E.bubble.setAttribute("aria-live", "polite");

    // --- gesture hand cursor -------------------------------------------------
    E.gcursor = el("div", "pp-gcursor", this.root);
    E.gcursor.textContent = ICO.hand;

    // --- toasts (top-center, above HUD) --------------------------------------
    E.toasts = el("div", "pp-toasts", this.root);
    E.toasts.setAttribute("aria-live", "polite");

    // --- paused veil -----------------------------------------------------------
    E.paused = el("div", "pp-paused", this.root);
    const pcard = el("div", "pp-paused-card", E.paused);
    pcard.textContent = S.pausedHint ?? "";
    // iOS sometimes never refires window focus after system overlays — a tap on
    // the veil itself must always be able to resume the game
    E.paused.addEventListener("pointerdown", (e) => {
      if (e.cancelable) e.preventDefault();
      this.hooks.onResume?.();
    });

    // --- landscape rotate card (CSS-driven; sim pauses via main's matchMedia) ---
    const rot = el("div", "pp-rotate", this.root);
    const rcard = el("div", "pp-paused-card", rot);
    rcard.textContent = S.rotateCard ?? "";

    // --- loading / start overlay (topmost) --------------------------------------
    const ov = el("div", "pp-overlay", this.root);
    E.overlay = ov;
    const logo = el("img", "pp-logo", ov);
    logo.src = "./assets/ui_logo.png";
    logo.alt = S.title ?? "";
    logo.draggable = false;
    E.loadMsg = el("div", "pp-load-msg", ov);
    E.loadMsg.textContent = S.loading ?? "";
    E.startBtn = btn("pp-start", ov);
    E.startBtn.textContent = S.tapToStart ?? "";
    this._bindTap(E.startBtn, () => {
      const cb = this._startCb;
      if (!cb) return;
      this._startCb = null;
      E.startBtn.classList.remove("show");
      cb();
    });
    E.version = el("div", "pp-version", ov);   // tiny build tag, set via setVersion()
  }

  // small build tag on the title screen so you can tell which version is live
  setVersion(v) {
    if (this._els.version) this._els.version.textContent = v ?? "";
  }

  _iconButton(parent, glyph, label, fn) {
    const b = btn("pp-btn pp-btn-icon", parent);
    const i = el("span", "pp-ico", b);
    i.textContent = glyph;
    b.setAttribute("aria-label", label ?? "");
    this._bindTap(b, fn);
    return b;
  }

  // Pointer-based tap (instant on touch, no 300ms, no double fire) + keyboard.
  _bindTap(e, fn) {
    let pid = -1;
    e.addEventListener("pointerdown", (ev) => {
      if (pid !== -1) return;
      pid = ev.pointerId;
      e.classList.add("pp-pressed");
      if (ev.cancelable) ev.preventDefault();
      try { e.setPointerCapture(ev.pointerId); } catch (err) { /* fine */ }
    }, { passive: false });
    e.addEventListener("pointerup", (ev) => {
      if (ev.pointerId !== pid) return;
      pid = -1;
      e.classList.remove("pp-pressed");
      fn();
    });
    e.addEventListener("pointercancel", (ev) => {
      if (ev.pointerId !== pid) return;
      pid = -1;
      e.classList.remove("pp-pressed");
    });
    // keyboard activation arrives as click with detail 0 (no pointer double-fire)
    e.addEventListener("click", (ev) => { if (ev.detail === 0) fn(); });
  }

  // Press-and-hold button (jump): held=true on down, false on any release path.
  _bindHold(e, set) {
    let pid = -1, held = false;
    const change = (v) => {
      if (held === v) return;
      held = v;
      e.classList.toggle("pp-pressed", v);
      set(v);
    };
    e.addEventListener("pointerdown", (ev) => {
      if (pid !== -1) return;
      pid = ev.pointerId;
      if (ev.cancelable) ev.preventDefault();
      try { e.setPointerCapture(ev.pointerId); } catch (err) { /* fine */ }
      change(true);
    }, { passive: false });
    const release = (ev) => {
      if (ev.pointerId !== pid) return;
      pid = -1;
      change(false);
    };
    e.addEventListener("pointerup", release);
    e.addEventListener("pointercancel", release);
    e.addEventListener("lostpointercapture", release);
    this._jumpRelease = () => { pid = -1; change(false); };
  }

  _buildJoystick() {
    const zone = el("div", "pp-joy", this.root);
    el("div", "pp-joy-base", zone);
    const knob = el("div", "pp-joy-knob", zone);
    this._els.joy = zone;
    this._els.joyKnob = knob;

    let pid = -1, cx = 0, cy = 0;
    const move = (ev) => {
      let dx = ev.clientX - cx, dy = ev.clientY - cy;
      const m = Math.hypot(dx, dy);
      if (m > JOY_R) { dx = dx / m * JOY_R; dy = dy / m * JOY_R; }
      knob.style.transform = "translate(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px)";
      this.hooks.onAxis && this.hooks.onAxis(dx / JOY_R, dy / JOY_R);
    };
    const reset = () => {
      pid = -1;
      zone.classList.remove("active");
      knob.style.transform = "";
      this.hooks.onAxis && this.hooks.onAxis(0, 0);
    };
    this._joyReset = reset;

    zone.addEventListener("pointerdown", (ev) => {
      if (pid !== -1) return;
      pid = ev.pointerId;
      const r = zone.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      zone.classList.add("active");
      if (ev.cancelable) ev.preventDefault();
      try { zone.setPointerCapture(ev.pointerId); } catch (err) { /* fine */ }
      move(ev);
    }, { passive: false });
    zone.addEventListener("pointermove", (ev) => { if (ev.pointerId === pid) move(ev); });
    const end = (ev) => { if (ev.pointerId === pid) reset(); };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
    zone.addEventListener("lostpointercapture", end);
  }

  _releaseAllPresses() {
    this._joyReset && this._joyReset();
    this._jumpRelease && this._jumpRelease();
  }

  _setDrawer(open) {
    if (this._drawerTimer) { clearTimeout(this._drawerTimer); this._drawerTimer = null; }
    this._drawerOpen = open;
    this._els.drawer.classList.toggle("open", open);
    this._els.scrim.classList.toggle("show", open);
    this._els.tab.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) this._els.tab.classList.remove("nudge");   // discovered — stop the come-hither pulse
  }

  // briefly reveal the Clay box, then tuck it away — teaches where off-hotbar
  // tools live (e.g. when a quest hands the player a sprout or flower)
  flashDrawer(ms = 2600) {
    this._setDrawer(true);
    this._drawerTimer = setTimeout(() => { if (this._drawerOpen) this._setDrawer(false); }, ms);
  }

  _applyModeButton() {
    const pinch = this._mode === "pinch";
    this._els.modeIco.textContent = pinch ? ICO.pinch : ICO.build;
    const lbl = pinch ? (this.str.btnPinch ?? "") : (this.str.btnBuild ?? "");
    this._els.modeLbl.textContent = lbl;
    this._els.modeBtn.setAttribute("aria-label", lbl);
  }

  // ======================================================================
  // Inventory: hotbar + palette drawer + tab dot
  // ======================================================================

  refresh() {
    const inv = this.inv;
    if (!inv) return;
    const sel = inv.selected;
    for (let i = 0; i < this._slots.length; i++) {
      const s = this._slots[i];
      const n = inv.counts[s.key] | 0;
      if (n !== s.lastN) { s.lastN = n; s.countEl.textContent = n; }
      s.el.classList.toggle("sel", s.key === sel);
      s.el.classList.toggle("zero", n === 0);
    }
    for (let i = 0; i < this._palItems.length; i++) {
      const p = this._palItems[i];
      const n = inv.counts[p.key] | 0;
      if (n !== p.lastN) { p.lastN = n; p.countEl.textContent = n; }
      p.el.classList.toggle("sel", p.key === sel);
      p.el.classList.toggle("zero", n === 0);
    }
    const col = this._swatchCss[sel];
    if (col) this._els.tabDot.style.backgroundColor = col;
  }

  // ======================================================================
  // Quest card
  // ======================================================================

  setQuest(name, done, total) {
    if (this._qCelebrating) {
      // hold the celebration on screen; apply the next quest when it ends
      this._qPending = { name, done, total };
      return;
    }
    const E = this._els;
    const wasVisible = E.quest.classList.contains("show");
    E.quest.classList.add("show");
    E.questName.textContent = name ?? "";
    E.questProg.textContent =
      typeof this.str.questProgress === "function" ? this.str.questProgress(done, total) : "";
    const changed = name !== this._qName || done !== this._qDone;
    this._qName = name;
    this._qDone = done;
    if (wasVisible && changed) {
      E.quest.classList.remove("glow");
      void E.quest.offsetWidth;          // restart the glow animation
      E.quest.classList.add("glow");
    }
  }

  questComplete(text) {
    const E = this._els;
    E.quest.classList.add("show");
    E.questName.textContent = text ?? "";
    E.questProg.textContent = ICO.spark;
    E.quest.classList.remove("wiggle");
    void E.quest.offsetWidth;
    E.quest.classList.add("wiggle");
    this._qName = null;
    this._qDone = -1;
    this._qCelebrating = true;
    clearTimeout(this._qCelT);
    this._qCelT = setTimeout(() => {
      this._qCelebrating = false;
      E.quest.classList.remove("wiggle");
      const p = this._qPending;
      this._qPending = null;
      if (p) this.setQuest(p.name, p.done, p.total);
    }, QUEST_CELEBRATE_MS);
  }

  // ======================================================================
  // Compass — called every frame; only touches the DOM when the yaw moved
  // ======================================================================

  setYaw(rad) {
    if (!isFinite(rad)) return;
    let f = -rad / TAU;        // bearing fraction: 0=N, 0.25=E, 0.5=S, 0.75=W
    f -= Math.floor(f);
    const last = this._yawF;
    if (last >= 0) {
      let d = f - last;
      if (d < 0) d = -d;
      if (d < 0.001 || d > 0.999) return;   // unchanged (incl. the 0↔1 wrap)
    }
    this._yawF = f;
    this._els.compassStrip.style.transform =
      "translate3d(" + (C_BASE - f * C_CYCLE).toFixed(1) + "px,0,0)";
  }

  // ======================================================================
  // Minimap
  // ======================================================================

  initMinimap(world, S) {
    if (!world || !S) return;
    this._mmWorld = world;
    this._mmS = S;

    // per-block-id RGB lookup
    this._mmLut = new Uint8Array(BLOCKS.length * 3);
    for (let i = 0; i < BLOCKS.length; i++) {
      const c = blockRGB(BLOCKS[i]);
      this._mmLut[i * 3] = (c >> 16) & 255;
      this._mmLut[i * 3 + 1] = (c >> 8) & 255;
      this._mmLut[i * 3 + 2] = c & 255;
    }

    // offscreen world map, one pixel per column
    const off = document.createElement("canvas");
    off.width = S; off.height = S;
    this._mmOff = off;
    this._mmOffCtx = off.getContext("2d");
    this._mmImg = this._mmOffCtx.createImageData(S, S);
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) this._mmPaint(x, z);
    }
    this._mmOffCtx.putImageData(this._mmImg, 0, 0);

    // visible circle canvas, retina-scaled once
    const cv = this._els.mapCanvas;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(MM_D * ratio);
    cv.height = Math.round(MM_D * ratio);
    this._mmCtx = cv.getContext("2d");
    this._mmCtx.setTransform(ratio, 0, 0, ratio, 0, 0);

    this._mmDirty = true;
    this._mmLX = 1e9; this._mmLZ = 1e9; this._mmLYaw = 1e9;
  }

  // top-block color for one column, written straight into the ImageData
  _mmPaint(x, z) {
    const w = this._mmWorld, S = this._mmS, d = this._mmImg.data;
    const H = CFG.worldHeight;
    const i = (z * S + x) * 4;
    let id = 0, y = H - 1;
    for (; y >= 0; y--) {
      id = w.get(x, y, z);
      if (id !== 0) break;
    }
    if (id === 0 || y < 0) {
      d[i] = MAP_VOID_RGB[0]; d[i + 1] = MAP_VOID_RGB[1]; d[i + 2] = MAP_VOID_RGB[2]; d[i + 3] = 255;
      return;
    }
    const L = this._mmLut, j = id * 3;
    let shade = BLOCKS[id].water ? 0.95 : 0.66 + 0.5 * (y / H);
    if (shade > 1.05) shade = 1.05;
    let r = L[j] * shade, g = L[j + 1] * shade, b = L[j + 2] * shade;
    d[i] = r > 255 ? 255 : r;
    d[i + 1] = g > 255 ? 255 : g;
    d[i + 2] = b > 255 ? 255 : b;
    d[i + 3] = 255;
  }

  minimapEdit(x, z /* , color — recomputed from the world instead */) {
    if (!this._mmOffCtx) return;
    const S = this._mmS;
    const x0 = Math.max(0, x - 1), x1 = Math.min(S - 1, x + 1);
    const z0 = Math.max(0, z - 1), z1 = Math.min(S - 1, z + 1);
    if (x0 > x1 || z0 > z1) return;
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) this._mmPaint(xx, zz);
    }
    this._mmOffCtx.putImageData(this._mmImg, 0, 0, x0, z0, x1 - x0 + 1, z1 - z0 + 1);
    this._mmDirty = true;
  }

  // called every frame by main — repaints at most ~10Hz, and only when something
  // moved (time-based throttle: frame counting would halve on 120Hz ProMotion)
  updateMinimap(x, z, yaw) {
    const c = this._mmCtx;
    if (!c) return;
    const now = performance.now();
    if (!this._mmDirty) {
      if (now - (this._mmPaintAt || 0) < 100) return;
      const dx = x - this._mmLX, dz = z - this._mmLZ;
      let dy = yaw - this._mmLYaw;
      if (dy < 0) dy = -dy;
      if (dx * dx + dz * dz < 0.02 && dy < 0.02) return;
    }
    this._mmDirty = false;
    this._mmPaintAt = now;
    this._mmLX = x; this._mmLZ = z; this._mmLYaw = yaw;

    const S = this._mmS;
    // no clip() needed: the canvas itself is border-radius:50% in CSS
    c.clearRect(0, 0, MM_D, MM_D);
    c.drawImage(this._mmOff, 0, 0, S, S, 0, 0, MM_D, MM_D);

    let px = x / S * MM_D, py = z / S * MM_D;
    if (px < 4) px = 4; else if (px > MM_D - 4) px = MM_D - 4;
    if (py < 4) py = 4; else if (py > MM_D - 4) py = MM_D - 4;

    // view cone (facing = (-sin yaw, -cos yaw) in map space; +z is down/south)
    const fx = -Math.sin(yaw), fy = -Math.cos(yaw);
    c.fillStyle = MM_CONE;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(px + (fx * MM_COS - fy * MM_SIN) * MM_CONE_LEN, py + (fx * MM_SIN + fy * MM_COS) * MM_CONE_LEN);
    c.lineTo(px + (fx * MM_COS + fy * MM_SIN) * MM_CONE_LEN, py + (-fx * MM_SIN + fy * MM_COS) * MM_CONE_LEN);
    c.closePath();
    c.fill();

    // player dot — a little pea
    c.fillStyle = MM_DOT;
    c.strokeStyle = MM_DOT_RING;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(px, py, 4.2, 0, TAU);
    c.fill();
    c.stroke();
  }

  // ======================================================================
  // Speech bubble + toasts
  // ======================================================================

  say(text) {
    if (!text) return;
    const t = String(text);
    if (this._bubbleShowing) {
      if (this._bubbleQ.length < BUBBLE_QUEUE_MAX) this._bubbleQ.push(t);
      return;
    }
    this._showBubble(t);
  }

  _showBubble(t) {
    const b = this._els.bubble;
    this._bubbleShowing = true;
    b.textContent = t;
    b.classList.add("show");
    clearTimeout(this._bubbleT);
    this._bubbleT = setTimeout(() => {
      b.classList.remove("show");
      this._bubbleT = setTimeout(() => {
        this._bubbleShowing = false;
        const next = this._bubbleQ.shift();
        if (next) this._showBubble(next);
      }, BUBBLE_GAP_MS);
    }, BUBBLE_MS);
  }

  toast(text) {
    if (!text) return;
    const c = this._els.toasts;
    const last = c.lastElementChild;
    if (last && last.textContent === text) last.remove();   // no duplicate stacks
    while (c.children.length >= TOAST_MAX) c.firstElementChild.remove();
    const t = el("div", "pp-toast", c);
    t.textContent = text;
    t.addEventListener("animationend", () => t.remove());
    setTimeout(() => { if (t.parentNode) t.remove(); }, TOAST_MS + 600); // safety
  }

  toastNoClay(key) {
    // flowers grow wild in the meadow — point the kid there instead of a dead end
    if (key === "flower" && this.str.toastNoFlowers) return this.toast(this.str.toastNoFlowers);
    this.toast(this.str.toastNoClay ?? "");
  }

  // main calls this after applying saved settings so the buttons match the audio state
  syncMute(musicLevel, sfxMuted) {
    this._musicLevel = Math.min(2, Math.max(0, musicLevel | 0));
    this._mutedSfx = !!sfxMuted;
    this._paintMute();
  }

  onModeChanged(mode) {
    if (mode !== "pinch" && mode !== "build") return;
    const changed = mode !== this._mode;
    this._mode = mode;
    this._applyModeButton();
    if (changed) this.toast(mode === "pinch" ? this.str.modePinch : this.str.modeBuild);
  }

  // ======================================================================
  // Hand-magic gesture UI
  // ======================================================================

  gestureCursor(px, py, pinching) {
    const g = this._els.gcursor;
    if (!this._gCursorShown) {
      this._gCursorShown = true;
      g.classList.add("show");
    }
    g.style.transform = "translate3d(" + (px - 24).toFixed(1) + "px," + (py - 24).toFixed(1) + "px,0)";
    const p = !!pinching;
    if (p !== this._gPinch) {
      this._gPinch = p;
      g.classList.toggle("pinch", p);
      g.textContent = p ? ICO.pinch : ICO.hand;
    }
  }

  gestureStatus(text) {
    const chip = this._els.chip;
    chip.textContent = text || "";
    chip.classList.toggle("show", !!text);
  }

  // little illustrated guide shown while Hand Magic warms up, so the player knows
  // which gesture does what before the camera is even ready
  showGestureGuide() {
    const S = this.str;
    let g = this._els.gguide;
    if (!g) {
      g = el("div", "pp-gguide", this.root);
      const title = el("div", "pp-gguide-title", g);
      title.textContent = S.gestureGuideTitle ?? "";
      const rows = [
        ["✋", S.gestureGuideWalk], ["👈👉", S.gestureGuideTurn], ["🤏", S.gestureGuidePinch]
      ];
      for (const [icon, label] of rows) {
        const row = el("div", "pp-gguide-row", g);
        const ic = el("span", "pp-gguide-ico", row); ic.textContent = icon;
        const tx = el("span", "pp-gguide-tx", row); tx.textContent = label ?? "";
      }
      this._els.gguide = g;
    }
    clearTimeout(this._gguideT);
    g.classList.add("show");
  }

  hideGestureGuide(delay = 0) {
    const g = this._els.gguide;
    if (!g) return;
    clearTimeout(this._gguideT);
    if (delay > 0) this._gguideT = setTimeout(() => g.classList.remove("show"), delay);
    else g.classList.remove("show");
  }

  gesturePreviewContainer() {
    return this._els.gpreview;
  }

  gestureActive(on) {
    const b = !!on;
    this._els.handBtn.classList.toggle("pp-on", b);
    this._els.handBtn.setAttribute("aria-pressed", b ? "true" : "false");
    this._els.handBtn.setAttribute("aria-label",
      b ? (this.str.btnHandMagicOff ?? "") : (this.str.btnHandMagic ?? ""));
    if (!b) {
      this._gCursorShown = false;
      this._els.gcursor.classList.remove("show");
    }
  }

  // ======================================================================
  // Loading / start overlay + pause
  // ======================================================================

  showLoading() {
    const E = this._els;
    clearTimeout(this._overlayHideT);
    E.overlay.style.display = "";
    E.overlay.style.pointerEvents = "";
    E.overlay.classList.add("show");
    E.overlay.classList.remove("hide");
    E.loadMsg.classList.remove("hidden");
    E.startBtn.classList.remove("show");
  }

  showStart(cb) {
    const E = this._els;
    this._startCb = typeof cb === "function" ? cb : null;
    E.overlay.style.display = "";
    E.overlay.classList.add("show");
    E.overlay.classList.remove("hide");
    E.loadMsg.classList.add("hidden");
    E.startBtn.classList.add("show");
  }

  hideOverlay() {
    const E = this._els;
    E.overlay.classList.add("hide");
    E.overlay.style.pointerEvents = "none";
    clearTimeout(this._overlayHideT);
    this._overlayHideT = setTimeout(() => {
      E.overlay.classList.remove("show");
      E.overlay.style.display = "none";
    }, 500);
  }

  setPaused(paused) {
    this._els.paused.classList.toggle("show", !!paused);
    if (paused) this._releaseAllPresses();
  }
}

// ===========================================================================
// Styles — injected once. Pastel clay: cream panels, soft shadows, chunky
// pressables. Laid out for 390×844 portrait first; nothing overlaps the hotbar.
// ===========================================================================

const CSS = `
.pp-ui, .pp-ui * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
.pp-ui {
  position: fixed; inset: 0; pointer-events: none; z-index: 5;
  font-family: -apple-system, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif;
  color: #3f3429;
  --cream: #f6efe2; --cream-hi: #fffaf0; --ink: #3f3429;
  --accent: #e8956b; --green: #7fc163; --sun: #f2b35c;
  --st: env(safe-area-inset-top, 0px); --sb: env(safe-area-inset-bottom, 0px);
  --sl: env(safe-area-inset-left, 0px); --sr: env(safe-area-inset-right, 0px);
  --shadow: 0 6px 16px rgba(63,52,41,.18);
  user-select: none; -webkit-user-select: none;
}
.pp-ui button { color: var(--ink); font-family: inherit; }

/* ---- chunky clay buttons ------------------------------------------------ */
.pp-btn {
  pointer-events: auto; touch-action: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  border: none; margin: 0; padding: 0;
  background: var(--cream); border-radius: 20px;
  box-shadow: 0 4px 0 rgba(63,52,41,.14), var(--shadow);
  transition: transform .12s ease, box-shadow .12s ease, background .2s ease;
}
.pp-btn.pp-pressed { transform: translateY(3px) scale(.96);
  box-shadow: 0 1px 0 rgba(63,52,41,.14), 0 3px 8px rgba(63,52,41,.12); }
.pp-btn.pp-on { background: #dff0d0;
  box-shadow: 0 4px 0 rgba(106,150,80,.4), var(--shadow); }
.pp-btn .pp-ico { font-size: 25px; line-height: 1.15; }
.pp-btn .pp-lbl { font-size: 10px; font-weight: 800; opacity: .6; margin-top: 1px; }

/* ---- compass (top-center) ------------------------------------------------ */
.pp-compass {
  position: absolute; top: calc(var(--st) + 6px); left: 50%; margin-left: -75px;
  width: 150px; height: 28px; overflow: hidden; z-index: 10;
  background: rgba(246,239,226,.88); border-radius: 14px; box-shadow: var(--shadow);
}
.pp-compass-strip { position: absolute; left: 0; top: 0; height: 100%;
  display: flex; will-change: transform; }
.pp-cl { width: 28px; flex: none; text-align: center; line-height: 28px;
  font-size: 14px; font-weight: 800; opacity: .65; }
.pp-cl.pp-n { color: var(--accent); opacity: 1; }
.pp-cl.pp-cdot { font-size: 11px; opacity: .3; }
.pp-compass-notch { position: absolute; left: 50%; top: 0; width: 0; height: 0;
  margin-left: -5px; border-left: 5px solid transparent;
  border-right: 5px solid transparent; border-top: 5px solid var(--accent); }

/* ---- top-right icon row --------------------------------------------------- */
.pp-iconrow { position: absolute; top: calc(var(--st) + 40px);
  right: calc(var(--sr) + 8px); display: flex; gap: 6px; z-index: 10; }
.pp-btn-icon { width: 48px; height: 48px; border-radius: 16px; }
.pp-btn-icon .pp-ico { font-size: 21px; }
.pp-btn.pp-off .pp-ico { opacity: .35; filter: grayscale(1); }
.pp-btn.pp-low .pp-ico { opacity: .6; }

/* ---- gesture status chip (top-left band) ----------------------------------- */
.pp-chip { position: absolute; top: calc(var(--st) + 44px); left: calc(var(--sl) + 8px);
  max-width: 200px; display: none; z-index: 22;
  background: var(--cream); border-radius: 14px; padding: 8px 12px;
  font-size: 12px; font-weight: 700; line-height: 1.3; box-shadow: var(--shadow); }
.pp-chip.show { display: block; }
.pp-gguide { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%) scale(.96);
  z-index: 23; display: none; opacity: 0; pointer-events: none;
  background: var(--cream); color: #3f3429; border-radius: 20px; padding: 18px 22px;
  box-shadow: var(--shadow); width: min(82vw, 320px);
  transition: opacity .25s ease, transform .25s ease; }
.pp-gguide.show { display: block; opacity: 1; transform: translate(-50%,-50%) scale(1); }
.pp-gguide-title { font-size: 16px; font-weight: 800; text-align: center; margin-bottom: 12px; }
.pp-gguide-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; }
.pp-gguide-ico { font-size: 24px; width: 44px; text-align: center; flex-shrink: 0; }
.pp-gguide-tx { font-size: 14px; font-weight: 700; line-height: 1.25; }

/* ---- quest card -------------------------------------------------------------- */
.pp-quest { position: absolute; top: calc(var(--st) + 96px); right: calc(var(--sr) + 8px);
  width: 168px; display: none; z-index: 10;
  background: var(--cream); border-radius: 18px; padding: 10px 13px; box-shadow: var(--shadow); }
.pp-quest.show { display: block; }
.pp-quest-title { font-size: 10px; font-weight: 800; letter-spacing: .05em;
  text-transform: uppercase; color: var(--accent); }
.pp-quest-name { font-size: 13px; font-weight: 700; line-height: 1.3; margin-top: 3px; }
.pp-quest-prog { font-size: 15px; font-weight: 800; margin-top: 4px; color: var(--green); }
.pp-quest.glow { animation: ppGlow .8s ease; }
.pp-quest.wiggle { animation: ppWiggle 1s ease; }

/* solid panels swallow stray taps so they never dig/place behind themselves */
.pp-quest.show, .pp-map { pointer-events: auto; touch-action: none; }

/* ---- palette drawer ------------------------------------------------------------ */
.pp-pal-tab { position: absolute; left: 0; top: 40%; width: 48px; height: 84px;
  border: none; border-radius: 0 20px 20px 0; z-index: 12;
  background: var(--cream); box-shadow: var(--shadow);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; pointer-events: auto; touch-action: none;
  padding-left: var(--sl); transition: transform .12s ease; }
.pp-pal-tab.pp-pressed { transform: scale(.95); }
/* come-hither pulse until the player first opens the Clay box (more tools live here) */
.pp-pal-tab.nudge { animation: ppTabNudge 1.8s ease-in-out infinite; }
@keyframes ppTabNudge {
  0%, 100% { transform: translateX(0); box-shadow: var(--shadow); }
  50% { transform: translateX(7px); box-shadow: 0 0 0 4px rgba(255,210,120,.55), var(--shadow); }
}
@media (prefers-reduced-motion: reduce) { .pp-pal-tab.nudge { animation: none; } }
.pp-tab-ico { font-size: 21px; line-height: 1; }
.pp-tab-dot { width: 15px; height: 15px; border-radius: 50%;
  box-shadow: inset 0 -2px 3px rgba(63,52,41,.22), 0 0 0 2px #fff; }
.pp-scrim { position: absolute; inset: 0; display: none; z-index: 30;
  pointer-events: auto; background: rgba(63,52,41,.12); }
.pp-scrim.show { display: block; }
.pp-drawer { position: absolute; left: 0; top: 50%; z-index: 31;
  transform: translate(-110%, -50%); width: 204px; max-height: 62vh;
  background: var(--cream); border-radius: 0 22px 22px 0; box-shadow: var(--shadow);
  padding: 10px 8px 10px calc(var(--sl) + 8px);
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  pointer-events: auto; touch-action: pan-y; visibility: hidden;
  transition: transform .26s cubic-bezier(.34,1.3,.64,1), visibility .26s; }
.pp-drawer.open { transform: translate(0, -50%); visibility: visible; }
.pp-pal-item { display: flex; align-items: center; gap: 9px; width: 100%;
  min-height: 48px; border: none; background: transparent; border-radius: 14px;
  padding: 4px 9px; text-align: left; touch-action: pan-y; pointer-events: auto; }
.pp-pal-item:active { background: rgba(255,255,255,.7); }
.pp-pal-item.sel { background: var(--cream-hi); box-shadow: inset 0 0 0 2.5px var(--accent); }
.pp-pal-item.zero { opacity: .5; }
.pp-pal-item .pp-swatch { width: 28px; height: 28px; border-radius: 9px; flex: none; }
.pp-pal-name { flex: 1; font-size: 13px; font-weight: 700; }
.pp-pal-count { font-size: 12px; font-weight: 800; opacity: .65; }

/* ---- clay swatches ---------------------------------------------------------------- */
.pp-swatch { display: block;
  background-image: radial-gradient(circle at 32% 26%, rgba(255,255,255,.6), rgba(255,255,255,0) 48%);
  box-shadow: inset 0 -3px 4px rgba(63,52,41,.18), inset 0 1px 1px rgba(255,255,255,.4); }

/* ---- virtual joystick ---------------------------------------------------------------- */
.pp-joy { position: absolute; left: calc(var(--sl) + 12px); bottom: calc(var(--sb) + 88px);
  width: 124px; height: 124px; z-index: 10;
  pointer-events: auto; touch-action: none; opacity: .4; transition: opacity .25s ease; }
.pp-joy.active { opacity: 1; }
.pp-joy-base { position: absolute; inset: 0; border-radius: 50%;
  background: rgba(246,239,226,.55);
  box-shadow: inset 0 0 0 3px rgba(255,255,255,.65), var(--shadow); }
.pp-joy-knob { position: absolute; left: 50%; top: 50%; width: 54px; height: 54px;
  margin: -27px 0 0 -27px; border-radius: 50%; background: var(--cream);
  box-shadow: 0 4px 8px rgba(63,52,41,.28), inset 0 -4px 5px rgba(63,52,41,.12),
    inset 0 2px 2px rgba(255,255,255,.7); }

/* ---- gesture camera preview ------------------------------------------------------------ */
.pp-gpreview { position: absolute; left: calc(var(--sl) + 12px);
  bottom: calc(var(--sb) + 226px); z-index: 12; line-height: 0;
  border-radius: 16px; overflow: hidden;
  box-shadow: var(--shadow), 0 0 0 3px rgba(246,239,226,.92); }
.pp-gpreview:empty { display: none; }

/* ---- jump + mode cluster ------------------------------------------------------------------ */
.pp-cluster { position: absolute; right: calc(var(--sr) + 12px);
  bottom: calc(var(--sb) + 88px); z-index: 10;
  display: flex; flex-direction: column; align-items: center; gap: 12px; }
.pp-btn-mode { width: 58px; height: 58px; }
.pp-btn-jump { width: 66px; height: 66px; background: #e9f3da; border-radius: 24px; }

/* ---- minimap ---------------------------------------------------------------------------------- */
.pp-map { position: absolute; right: calc(var(--sr) + 12px);
  bottom: calc(var(--sb) + 238px); width: 120px; height: 120px; z-index: 10; }
.pp-map-canvas { width: 120px; height: 120px; border-radius: 50%; display: block;
  background: rgba(246,239,226,.6);
  box-shadow: var(--shadow), 0 0 0 4px rgba(246,239,226,.92); }
.pp-map-n { position: absolute; top: -8px; left: 50%; margin-left: -9px;
  width: 18px; height: 18px; border-radius: 50%; background: var(--accent);
  color: #fff; font-size: 11px; font-weight: 800; text-align: center;
  line-height: 18px; box-shadow: 0 1px 3px rgba(63,52,41,.32); }

/* ---- hotbar ---------------------------------------------------------------------------------------- */
.pp-hotbar { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(var(--sb) + 8px); z-index: 11;
  display: flex; gap: 6px; padding: 7px;
  background: rgba(246,239,226,.94); border-radius: 22px; box-shadow: var(--shadow);
  pointer-events: auto; touch-action: none; }
.pp-slot { position: relative; width: 50px; height: 50px; border: none;
  border-radius: 16px; background: var(--cream-hi); padding: 0;
  display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0 0 0 2px rgba(63,52,41,.08);
  pointer-events: auto; touch-action: none;
  transition: transform .16s cubic-bezier(.34,1.5,.64,1), box-shadow .16s ease; }
.pp-slot .pp-swatch { width: 32px; height: 32px; border-radius: 11px; }
.pp-slot .pp-count { position: absolute; right: 2px; bottom: 2px; min-width: 17px;
  height: 15px; padding: 0 3px; border-radius: 8px; background: #fff;
  font-size: 10px; font-weight: 800; line-height: 15px; text-align: center;
  box-shadow: 0 1px 2px rgba(63,52,41,.28); }
.pp-slot.sel { transform: translateY(-7px);
  box-shadow: inset 0 0 0 3px var(--accent), 0 7px 10px rgba(63,52,41,.24); }
.pp-slot.zero .pp-swatch { opacity: .4; }
.pp-slot.pp-pressed { transform: translateY(2px) scale(.94); }
.pp-slot.sel.pp-pressed { transform: translateY(-5px) scale(.94); }

/* ---- speech bubble ------------------------------------------------------------------------------------- */
.pp-bubble { position: absolute; left: 50%; bottom: calc(var(--sb) + 94px);
  transform: translate(-50%, 8px) scale(.92); max-width: 178px; z-index: 20;
  background: #fff; border-radius: 18px; padding: 9px 13px;
  font-size: 13px; font-weight: 600; line-height: 1.35; text-align: center;
  box-shadow: var(--shadow); opacity: 0;
  transition: opacity .2s ease, transform .2s cubic-bezier(.34,1.4,.64,1); }
.pp-bubble.show { opacity: 1; transform: translate(-50%, 0) scale(1); }
.pp-bubble::after { content: ""; position: absolute; left: 50%; bottom: -6px;
  width: 13px; height: 13px; margin-left: -7px; background: #fff;
  border-radius: 3px; transform: rotate(45deg); }

/* ---- gesture hand cursor ---------------------------------------------------------------------------------- */
.pp-gcursor { position: absolute; left: 0; top: 0; width: 48px; height: 48px;
  border-radius: 50%; z-index: 50; display: none; align-items: center;
  justify-content: center; font-size: 22px; will-change: transform;
  background: rgba(255,255,255,.35);
  box-shadow: 0 0 0 2px #fff, 0 4px 10px rgba(63,52,41,.3); }
.pp-gcursor.show { display: flex; }
.pp-gcursor.pinch { background: rgba(242,179,92,.55); }

/* ---- toasts ------------------------------------------------------------------------------------------------- */
.pp-toasts { position: absolute; top: calc(var(--st) + 40px); left: 50%;
  transform: translateX(-50%); z-index: 60; width: max-content; max-width: 74vw;
  display: flex; flex-direction: column; align-items: center; gap: 6px; }
.pp-toast { background: rgba(63,52,41,.86); color: #fff7ea;
  font-size: 13px; font-weight: 700; line-height: 1.3; text-align: center;
  padding: 8px 15px; border-radius: 14px; max-width: 74vw;
  box-shadow: var(--shadow); animation: ppToast ${TOAST_MS}ms ease forwards; }

/* ---- paused veil ----------------------------------------------------------------------------------------------- */
.pp-paused { position: absolute; inset: 0; z-index: 80; display: none;
  align-items: center; justify-content: center; background: rgba(246,239,226,.7); }
.pp-paused.show { display: flex; pointer-events: auto; }
.pp-paused-card { background: var(--cream); border-radius: 20px;
  padding: 16px 28px; font-size: 16px; font-weight: 800; box-shadow: var(--shadow); }

/* ---- landscape rotate card (kids rotate phones constantly) ------------------------------------------------------ */
.pp-rotate { position: absolute; inset: 0; z-index: 85; display: none;
  align-items: center; justify-content: center; background: rgba(246,239,226,.92);
  pointer-events: auto; }
@media (orientation: landscape) and (max-height: 500px) {
  .pp-rotate { display: flex; }
}

/* ---- loading / start overlay -------------------------------------------------------------------------------------- */
.pp-overlay { position: absolute; inset: 0; z-index: 90; display: none;
  flex-direction: column; align-items: center; justify-content: center; gap: 26px;
  background: linear-gradient(180deg, #fdf7e8 0%, #f6ead2 62%, #f1e0c2 100%);
  pointer-events: auto; touch-action: none; opacity: 1; transition: opacity .45s ease; }
.pp-overlay.show { display: flex; }
.pp-overlay.hide { opacity: 0; }
.pp-logo { max-width: 60%; max-height: 38%;
  animation: ppBob 3.2s ease-in-out infinite;
  filter: drop-shadow(0 10px 18px rgba(63,52,41,.18)); }
.pp-load-msg { font-size: 15px; font-weight: 700; opacity: .75; text-align: center;
  padding: 0 26px; animation: ppPulse 1.6s ease-in-out infinite; }
.pp-load-msg.hidden { display: none; }
.pp-start { display: none; border: none; pointer-events: auto; touch-action: none;
  color: #2f4a23; background: var(--green); font-size: 23px; font-weight: 800;
  padding: 18px 48px; border-radius: 30px;
  box-shadow: 0 6px 0 #5c9647, 0 14px 24px rgba(63,52,41,.25);
  animation: ppBreath 1.8s ease-in-out infinite;
  transition: transform .1s ease, box-shadow .1s ease; }
.pp-start.show { display: block; }
.pp-start.pp-pressed { transform: translateY(4px);
  box-shadow: 0 2px 0 #5c9647, 0 6px 12px rgba(63,52,41,.2); }
.pp-version { position: absolute; bottom: calc(10px + env(safe-area-inset-bottom));
  left: 0; right: 0; text-align: center; font-size: 11px; font-weight: 700;
  letter-spacing: .02em; color: #3f3429; opacity: .4; pointer-events: none; }

/* ---- keyframes -------------------------------------------------------------- */
@keyframes ppBob { 0%, 100% { transform: translateY(0) rotate(-1.5deg); }
  50% { transform: translateY(-10px) rotate(1.5deg); } }
@keyframes ppPulse { 0%, 100% { opacity: .55; } 50% { opacity: .9; } }
@keyframes ppBreath { 0%, 100% { scale: 1; } 50% { scale: 1.05; } }
@keyframes ppToast {
  0% { opacity: 0; transform: translateY(-10px) scale(.92); }
  12% { opacity: 1; transform: translateY(0) scale(1); }
  82% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-8px) scale(.97); } }
@keyframes ppGlow {
  0% { box-shadow: var(--shadow), 0 0 0 0 rgba(242,179,92,0); }
  35% { box-shadow: var(--shadow), 0 0 0 7px rgba(242,179,92,.55); }
  100% { box-shadow: var(--shadow), 0 0 0 0 rgba(242,179,92,0); } }
@keyframes ppWiggle {
  0%, 100% { transform: rotate(0) scale(1); }
  20% { transform: rotate(-3deg) scale(1.06); }
  40% { transform: rotate(3deg) scale(1.09); }
  60% { transform: rotate(-2deg) scale(1.05); }
  80% { transform: rotate(1.5deg) scale(1.02); } }
`;

import { CFG } from "./config.js";

// Unifies keyboard + canvas pointers (touch/mouse) + gamepad into per-tick commands.
// main.js calls update() once per render frame, then axis()/consumeLook()/consumeZoom()/
// consumeTaps()/jumpHeld(). All per-frame paths are allocation-free (reused outputs, pools).

const MAX_POINTERS = 4;        // tracked simultaneous canvas pointers (extras ignored)
const MAX_TAPS = 8;            // tap queue capacity per frame (extras dropped)
const PINCH_ZOOM_SCALE = 0.02; // zoom units per px of pinch distance change
const WHEEL_ZOOM_SCALE = 0.01; // zoom units per wheel deltaY px
const GP_DEADZONE = 0.15;      // stick deadzone (magnitude)
const GP_LOOK_SCALE = 6;       // look px per tick per unit of right stick

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.onModeToggle = null;        // set by main; called edge-triggered (gamepad B)
    this.lastPointer = null;         // {x,y} most recent canvas pointer pos, or null

    // -- input state ----------------------------------------------------
    this._keys = Object.create(null);     // event.code -> true while held
    this._vAxisX = 0; this._vAxisY = 0;   // UI virtual joystick
    this._padX = 0; this._padY = 0;       // gamepad left stick (deadzoned)
    this._padJump = false;
    this._uiButtons = { jump: false };

    // -- accumulators (drained by consume*) ------------------------------
    this._lookDx = 0; this._lookDy = 0;
    this._zoom = 0;
    this._tapPool = [];
    for (let i = 0; i < MAX_TAPS; i++) this._tapPool.push({ x: 0, y: 0, alt: false });
    this._tapCount = 0;

    // -- reused outputs (zero per-frame allocation) -----------------------
    this._axisOut = { x: 0, y: 0 };
    this._lookOut = { dx: 0, dy: 0 };
    this._tapsOut = [];
    this._lastPointerObj = { x: 0, y: 0 };

    // -- pointer slots (fixed pool, found by linear scan) -----------------
    this._pts = [];
    for (let i = 0; i < MAX_POINTERS; i++) {
      this._pts.push({
        active: false, id: 0,
        x: 0, y: 0, startX: 0, startY: 0, startT: 0,
        moved: false, pinched: false, button: 0,
        pendDx: 0, pendDy: 0          // sub-tap-threshold motion, flushed when drag confirmed
      });
    }
    this._pinchDist = 0;

    // -- gamepad edge state -----------------------------------------------
    this._prevPadB = false;
    this._prevPadTap = false;
    this._padOk = typeof navigator !== "undefined" &&
                  typeof navigator.getGamepads === "function";

    // The canvas owns its touches: no scrolling, double-tap zoom or selection.
    canvas.style.touchAction = "none";
    canvas.style.userSelect = "none";
    canvas.style.webkitUserSelect = "none";

    this._attach(canvas);
  }

  // ===== public API (frozen) ===============================================

  // Poll gamepads once per render frame.
  update() {
    if (!this._padOk) return;
    let pads = null;
    try { pads = navigator.getGamepads(); }
    catch (e) { this._padOk = false; return; }
    let gp = null;
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected) { gp = p; break; }
      }
    }
    if (!gp) {
      this._padX = 0; this._padY = 0; this._padJump = false;
      this._prevPadB = false; this._prevPadTap = false;
      return;
    }

    const ax = gp.axes;
    // left stick -> move axis (radial deadzone, rescaled, NaN-safe)
    let lx = ax.length > 0 ? ax[0] : 0;
    let ly = ax.length > 1 ? ax[1] : 0;
    const lm = Math.hypot(lx, ly);
    if (lm >= GP_DEADZONE) {
      const s = Math.min(1, (lm - GP_DEADZONE) / (1 - GP_DEADZONE)) / lm;
      this._padX = lx * s; this._padY = ly * s;   // stick up = -1 = forward
    } else {
      this._padX = 0; this._padY = 0;
    }

    // right stick -> look
    const rx = ax.length > 2 ? ax[2] : 0;
    const ry = ax.length > 3 ? ax[3] : 0;
    if (Math.hypot(rx, ry) >= GP_DEADZONE) {
      this._lookDx += rx * GP_LOOK_SCALE;
      this._lookDy += ry * GP_LOOK_SCALE;
    }

    const btn = gp.buttons;
    this._padJump = !!(btn[0] && btn[0].pressed);              // A held = jump

    const b = !!(btn[1] && btn[1].pressed);                    // B edge = mode toggle
    if (b && !this._prevPadB && this.onModeToggle) this.onModeToggle();
    this._prevPadB = b;

    const tapBtn = !!((btn[7] && btn[7].pressed) || (btn[2] && btn[2].pressed)); // RT or X
    if (tapBtn && !this._prevPadTap) {
      this._pushTap(window.innerWidth / 2, window.innerHeight / 2, false);
    }
    this._prevPadTap = tapBtn;
  }

  // Move axis in [-1,1], magnitude clamped to 1. y=-1 means forward.
  axis() {
    let x = this._vAxisX + this._padX;
    let y = this._vAxisY + this._padY;
    const k = this._keys;
    if (k.KeyW || k.ArrowUp) y -= 1;
    if (k.KeyS || k.ArrowDown) y += 1;
    if (k.KeyA || k.ArrowLeft) x -= 1;
    if (k.KeyD || k.ArrowRight) x += 1;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    const out = this._axisOut;
    out.x = x; out.y = y;
    return out;
  }

  // Accumulated look pixels since last call, then reset.
  consumeLook() {
    const out = this._lookOut;
    out.dx = this._lookDx; out.dy = this._lookDy;
    this._lookDx = 0; this._lookDy = 0;
    return out;
  }

  // Accumulated zoom delta since last call, then reset.
  consumeZoom() {
    const z = this._zoom;
    this._zoom = 0;
    return z;
  }

  // Queued taps [{x,y,alt}] since last call, then reset. Entries are pooled —
  // valid until the next batch of taps arrives (consume + handle same frame).
  consumeTaps() {
    const out = this._tapsOut;
    const n = this._tapCount;
    out.length = n;
    for (let i = 0; i < n; i++) out[i] = this._tapPool[i];
    this._tapCount = 0;
    return out;
  }

  jumpHeld() {
    return !!(this._keys.Space || this._padJump || this._uiButtons.jump);
  }

  // UI joystick feeds movement here (ui.js owns its own pointer handling).
  setVirtualAxis(x, y) {
    this._vAxisX = clamp1(x);
    this._vAxisY = clamp1(y);
  }

  // UI buttons feed held state here ("jump").
  setButton(name, held) {
    if (typeof name !== "string") return;
    this._uiButtons[name] = !!held;
  }

  // ===== listeners ==========================================================

  _attach(canvas) {
    const passive = { passive: true };
    const active = { passive: false };

    canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e), active);
    window.addEventListener("pointermove", (e) => this._onPointerMove(e), passive);
    window.addEventListener("pointerup", (e) => this._onPointerUp(e), passive);
    window.addEventListener("pointercancel", (e) => this._onPointerCancel(e), passive);

    // Belt-and-braces for iOS Safari: kill scroll/double-tap-zoom from canvas touches.
    const eat = (e) => { if (e.cancelable) e.preventDefault(); };
    canvas.addEventListener("touchstart", eat, active);
    canvas.addEventListener("touchmove", eat, active);
    canvas.addEventListener("gesturestart", eat, active);  // Safari page-pinch
    canvas.addEventListener("gesturechange", eat, active);
    canvas.addEventListener("contextmenu", eat, active);   // right-click = alt tap, no menu

    canvas.addEventListener("wheel", (e) => {
      if (e.cancelable) e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 16;        // lines -> px
      else if (e.deltaMode === 2) d *= 100;  // pages -> px
      if (isFinite(d)) this._zoom += d * WHEEL_ZOOM_SCALE;
    }, active);

    window.addEventListener("keydown", (e) => {
      this._keys[e.code] = true;
      if (PREVENT_CODES[e.code]) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => { this._keys[e.code] = false; });

    window.addEventListener("blur", () => this._clearAll());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this._clearAll();
    });
  }

  // ===== pointer model ======================================================

  _onPointerDown(e) {
    if (e.target !== this.canvas) return;   // UI pointers belong to ui.js
    if (e.cancelable) e.preventDefault();

    let slot = this._slotById(e.pointerId);
    if (!slot) slot = this._freeSlot();
    if (!slot) return;                      // too many fingers — ignore extras

    slot.active = true;
    slot.id = e.pointerId;
    slot.x = slot.startX = e.clientX;
    slot.y = slot.startY = e.clientY;
    slot.startT = performance.now();
    slot.moved = false;
    slot.pinched = false;
    slot.button = e.button > 0 ? e.button : 0;
    slot.pendDx = 0; slot.pendDy = 0;

    this._setLastPointer(e.clientX, e.clientY);

    // Keep receiving moves even if the finger drifts over HUD or off-canvas.
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }

    if (this._activeCount() >= 2) this._enterPinch();
  }

  _onPointerMove(e) {
    const slot = this._slotById(e.pointerId);
    if (!slot) {
      // untracked mouse hover over the canvas still updates lastPointer
      if (e.target === this.canvas) this._setLastPointer(e.clientX, e.clientY);
      return;
    }

    const dx = e.clientX - slot.x;
    const dy = e.clientY - slot.y;
    slot.x = e.clientX;
    slot.y = e.clientY;
    this._setLastPointer(e.clientX, e.clientY);

    if (!slot.moved &&
        Math.hypot(slot.x - slot.startX, slot.y - slot.startY) > CFG.tapMaxPx) {
      slot.moved = true;
    }

    const count = this._activeCount();
    if (count === 1) {
      // single pointer drag = look; buffer sub-threshold motion so taps stay crisp
      if (slot.moved) {
        if (slot.pendDx !== 0 || slot.pendDy !== 0) {
          this._lookDx += slot.pendDx; this._lookDy += slot.pendDy;
          slot.pendDx = 0; slot.pendDy = 0;
        }
        this._lookDx += dx; this._lookDy += dy;
      } else {
        slot.pendDx += dx; slot.pendDy += dy;
      }
    } else if (count >= 2) {
      // pinch zoom between the first two active pointers
      const a = this._activeAt(0), b = this._activeAt(1);
      if (slot === a || slot === b) {
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this._zoom += (this._pinchDist - d) * PINCH_ZOOM_SCALE;
        this._pinchDist = d;
      }
    }
  }

  _onPointerUp(e) {
    const slot = this._slotById(e.pointerId);
    if (!slot) return;

    const dt = performance.now() - slot.startT;
    if (!slot.moved && !slot.pinched && dt < CFG.tapMaxMs) {
      this._pushTap(slot.startX, slot.startY, slot.button === 2);
    }
    slot.active = false;
    this._afterPointerLoss();
  }

  _onPointerCancel(e) {
    const slot = this._slotById(e.pointerId);
    if (!slot) return;
    slot.active = false;        // never a tap
    this._afterPointerLoss();
  }

  _enterPinch() {
    // every active pointer is now part of a gesture: block their taps,
    // drop buffered look so the camera doesn't kick when the pinch starts
    for (let i = 0; i < MAX_POINTERS; i++) {
      const p = this._pts[i];
      if (p.active) { p.pinched = true; p.pendDx = 0; p.pendDy = 0; }
    }
    const a = this._activeAt(0), b = this._activeAt(1);
    if (a && b) this._pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }

  _afterPointerLoss() {
    // 3->2 fingers: restart the pinch baseline so zoom doesn't jump
    if (this._activeCount() >= 2) this._enterPinch();
  }

  // ===== internals ==========================================================

  _slotById(id) {
    for (let i = 0; i < MAX_POINTERS; i++) {
      const p = this._pts[i];
      if (p.active && p.id === id) return p;
    }
    return null;
  }

  _freeSlot() {
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (!this._pts[i].active) return this._pts[i];
    }
    return null;
  }

  _activeCount() {
    let n = 0;
    for (let i = 0; i < MAX_POINTERS; i++) if (this._pts[i].active) n++;
    return n;
  }

  _activeAt(index) {
    let n = 0;
    for (let i = 0; i < MAX_POINTERS; i++) {
      const p = this._pts[i];
      if (p.active) { if (n === index) return p; n++; }
    }
    return null;
  }

  _pushTap(x, y, alt) {
    if (this._tapCount >= MAX_TAPS) return;     // queue full — drop quietly
    const t = this._tapPool[this._tapCount++];
    t.x = x; t.y = y; t.alt = alt;
  }

  _setLastPointer(x, y) {
    const lp = this._lastPointerObj;
    lp.x = x; lp.y = y;
    this.lastPointer = lp;
  }

  _clearAll() {
    for (const code in this._keys) this._keys[code] = false;
    for (let i = 0; i < MAX_POINTERS; i++) this._pts[i].active = false;
    this._vAxisX = 0; this._vAxisY = 0;
    this._uiButtons.jump = false;
    this._padJump = false;
    this._lookDx = 0; this._lookDy = 0;
    // queued taps/zoom stay — they were intentional
  }
}

// keys whose browser default (page scroll, button activation) must never fire mid-game
const PREVENT_CODES = {
  Space: true, ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true
};

function clamp1(v) {
  if (!isFinite(v)) return 0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

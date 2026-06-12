import { CFG } from "./config.js";
import { STR } from "../strings.js";

// Hand magic: camera gestures via MediaPipe HandLandmarker (lazy — this module
// is only ever dynamically imported when the player opts in, and MediaPipe
// itself is only imported inside start()). Pinch fingers = tap, open palm = walk.
//
// Landmark indices: 0 wrist, 4 thumb tip, 8 index tip, 9 middle MCP,
// fingertips {8,12,16,20} with PIP joints {6,10,14,18}.

const HAND_LOST_MS = 300;     // hand gone this long → release walk/pinch
const CURSOR_LERP = 0.35;     // smoothing toward the index-tip target
const OVERLAY_W = 192;        // backing store 2× the 96×72 CSS preview
const OVERLAY_H = 144;
const TWO_PI = Math.PI * 2;

const FINGER_TIPS = [8, 12, 16, 20];
const FINGER_PIPS = [6, 10, 14, 18];

const DOT_BASE = "rgba(255,244,226,0.9)";   // cream landmark dots
const DOT_TIPS_OPEN = "#a3d98a";            // sprout green thumb/index tips
const DOT_TIPS_PINCH = "#f2aab8";           // blossom pink while pinching

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export class HandMagic {
  constructor(cb) {
    this._cb = cb || {};

    // lifecycle
    this._running = false;
    this._starting = false;
    this._landmarker = null;
    this._stream = null;
    this._video = null;
    this._dom = null;
    this._canvas = null;
    this._ctx = null;

    // per-frame state (all scalars — zero allocation in update())
    this._lastVideoTime = -1;
    this._lastTs = 0;
    this._lastSeen = -1;       // performance.now() of last frame with a hand
    this._handGone = true;     // lost-state already handled?
    this._cx = 0;              // smoothed cursor (CSS px, mirrored)
    this._cy = 0;
    this._hasCursor = false;
    this._pinching = false;    // committed pinch state
    this._pendingPinch = false;
    this._pendingSince = 0;
    this._palmSince = -1;      // when the open palm was first seen, -1 = not open
    this._walking = false;     // committed palm-walk state
    this._overlayInk = false;  // dots currently drawn on the preview canvas
    this._warned = false;
    this._lastFrameAt = 0;     // camera-stall watchdog
    this._skip = 1;            // adaptive inference cadence (frames)
    this._cadence = CFG.gestureEveryNFrames;
    this._costEma = 8;         // assume ~8ms until measured
  }

  get running() { return this._running; }

  async start(previewContainer) {
    if (this._running || this._starting) return;
    this._starting = true;
    try {
      const { FilesetResolver, HandLandmarker } =
        // .js not .mjs: the deploy CDN serves .mjs as application/octet-stream,
        // which strict module-MIME checking rejects (hand magic then never starts)
        await import("../vendor/mediapipe/vision_bundle.js");
      const fileset = await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
      // GPU delegate first (WebGL2) — CPU inference costs 10-30ms/frame on older
      // iPhones, which would drag the whole game down while hand magic is on
      try {
        this._landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "./vendor/mediapipe/hand_landmarker.task", delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1
        });
      } catch (gpuErr) {
        console.warn("HandMagic: GPU delegate unavailable, using CPU —", gpuErr);
        this._landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "./vendor/mediapipe/hand_landmarker.task" },
          runningMode: "VIDEO",
          numHands: 1
        });
      }

      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: 320, height: 240 }
      });

      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");   // older iOS Safari
      video.setAttribute("muted", "");
      video.srcObject = this._stream;
      this._video = video;
      await video.play();

      // little camera bubble: mirrored video + landmark-dot overlay
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "position:relative;width:96px;height:72px;border-radius:14px;overflow:hidden;" +
        "background:#3f3429;box-shadow:0 4px 12px rgba(63,52,41,0.3);";
      video.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);";
      const canvas = document.createElement("canvas");
      canvas.width = OVERLAY_W;
      canvas.height = OVERLAY_H;
      canvas.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
      wrap.appendChild(video);
      wrap.appendChild(canvas);
      previewContainer?.appendChild(wrap);
      this._dom = wrap;
      this._canvas = canvas;
      this._ctx = canvas.getContext("2d");

      // iOS stops camera tracks on lock/calls/app-switch, often without recovery —
      // listen for the hard stop, and let the update() watchdog catch silent stalls
      const track = this._stream.getVideoTracks()[0];
      if (track) {
        this._trackEnded = () => this._onCameraLost();
        track.addEventListener("ended", this._trackEnded);
      }

      this._lastVideoTime = -1;
      this._lastTs = 0;
      this._lastFrameAt = performance.now();
      this._running = true;
      this._cb.onStatus?.(STR.handMagicReady);
    } catch (err) {
      const denied = !!err && err.name === "NotAllowedError";
      console.warn("HandMagic: start failed —", err);
      this._teardown();
      this._cb.onStatus?.(denied ? STR.handMagicDenied : STR.handMagicError);
    } finally {
      this._starting = false;
    }
  }

  update() {
    if (!this._running) return;
    // adaptive cadence: an internal countdown (a varying modulo against a global
    // counter aliases), tuned so inference costs ~4ms amortized per 60Hz frame
    if (--this._skip > 0) return;
    this._skip = this._cadence;
    const video = this._video;
    // watchdog: no fresh camera frame for 2s while visible → the camera died
    // (lock screen, call, another app) — shut down honestly instead of freezing
    const wallNow = performance.now();
    const stale = !video || video.readyState < 2 || video.currentTime === this._lastVideoTime;
    if (stale) {
      if (document.visibilityState === "visible" && wallNow - this._lastFrameAt > 2000) {
        this._onCameraLost();
      }
      return;
    }
    this._lastVideoTime = video.currentTime;
    this._lastFrameAt = wallNow;

    let ts = performance.now();
    if (ts <= this._lastTs) ts = this._lastTs + 1;           // must be monotonic
    this._lastTs = ts;

    let result;
    const t0 = performance.now();
    try {
      result = this._landmarker.detectForVideo(video, ts);
    } catch (err) {
      if (!this._warned) { this._warned = true; console.warn("HandMagic: detect failed —", err); }
      return;
    }
    const cost = performance.now() - t0;
    this._costEma = this._costEma * 0.8 + cost * 0.2;
    this._cadence = Math.max(2, Math.min(8, Math.ceil(this._costEma / 4)));

    const hands = result.landmarks;
    if (hands && hands.length > 0) this._onHand(hands[0], ts);
    else this._onNoHand(ts);
  }

  stop() {
    const wasPinching = this._pinching;
    this._teardown();
    this._resetGestureState();
    if (wasPinching) this._cb.onPinchEnd?.();
    this._cb.onPalm?.(false);
  }

  // camera vanished mid-session: stop cleanly, THEN report (stop's onPalm(false)
  // clears the status chip, so the message must come after)
  _onCameraLost() {
    if (!this._running) return;
    this.stop();
    this._cb.onStatus?.(STR.handMagicError);
    this._cb.onStopped?.();
  }

  // ---------- internals ----------

  _onHand(lm, now) {
    this._lastSeen = now;
    this._handGone = false;
    this._drawOverlay(lm);

    const span = dist2(lm[0], lm[9]);                        // wrist → middle MCP
    if (span < 1e-4) return;                                 // degenerate frame

    // cursor: index tip, mirrored so moving the hand right moves the cursor right
    const tx = (1 - lm[8].x) * window.innerWidth;
    const ty = lm[8].y * window.innerHeight;
    if (this._hasCursor) {
      this._cx += (tx - this._cx) * CURSOR_LERP;
      this._cy += (ty - this._cy) * CURSOR_LERP;
    } else {
      this._cx = tx; this._cy = ty;
      this._hasCursor = true;
    }
    this._cb.onCursor?.(this._cx, this._cy);

    // pinch with hysteresis + debounce
    const ratio = dist2(lm[4], lm[8]) / span;
    const want = this._pinching ? ratio <= CFG.pinchOff : ratio < CFG.pinchOn;
    if (want === this._pinching) {
      this._pendingPinch = this._pinching;                   // signal settled — clear pending
    } else if (this._pendingPinch !== want) {
      this._pendingPinch = want;                             // transition candidate — arm timer
      this._pendingSince = now;
    } else if (now - this._pendingSince >= CFG.pinchDebounceMs) {
      this._pinching = want;
      if (want) this._cb.onPinchStart?.(this._cx, this._cy);
      else this._cb.onPinchEnd?.();
    }

    // open palm → walk (all four fingertips past their PIP joints, and not pinching)
    let extended = 0;
    for (let i = 0; i < 4; i++) {
      if (dist2(lm[FINGER_TIPS[i]], lm[0]) > dist2(lm[FINGER_PIPS[i]], lm[0])) extended++;
    }
    const open = extended >= 4 && !this._pinching;
    if (open) {
      if (this._palmSince < 0) this._palmSince = now;
      if (!this._walking && now - this._palmSince >= CFG.palmWalkHoldMs) {
        this._walking = true;
        this._cb.onPalm?.(true);
      }
    } else {
      this._palmSince = -1;
      if (this._walking) {
        this._walking = false;
        this._cb.onPalm?.(false);
      }
    }
  }

  _onNoHand(now) {
    if (this._handGone) return;
    if (this._lastSeen >= 0 && now - this._lastSeen < HAND_LOST_MS) return; // brief dropout
    this._handGone = true;
    const wasPinching = this._pinching;
    const wasWalking = this._walking;
    this._resetGestureState();
    this._clearOverlay();
    if (wasPinching) this._cb.onPinchEnd?.();
    if (wasWalking) this._cb.onPalm?.(false);
  }

  _resetGestureState() {
    this._pinching = false;
    this._pendingPinch = false;
    this._palmSince = -1;
    this._walking = false;
    this._hasCursor = false;     // snap (not slide) to the hand when it returns
  }

  _drawOverlay(lm) {
    const ctx = this._ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, OVERLAY_W, OVERLAY_H);
    // knuckle dots in one batched path
    ctx.fillStyle = DOT_BASE;
    ctx.beginPath();
    for (let i = 0; i < lm.length; i++) {
      if (i === 4 || i === 8) continue;
      const x = (1 - lm[i].x) * OVERLAY_W, y = lm[i].y * OVERLAY_H;
      ctx.moveTo(x + 2.5, y);
      ctx.arc(x, y, 2.5, 0, TWO_PI);
    }
    ctx.fill();
    // thumb + index tips pop, and blush pink while pinching
    ctx.fillStyle = this._pinching ? DOT_TIPS_PINCH : DOT_TIPS_OPEN;
    ctx.beginPath();
    for (let i = 4; i <= 8; i += 4) {
      const x = (1 - lm[i].x) * OVERLAY_W, y = lm[i].y * OVERLAY_H;
      ctx.moveTo(x + 4.5, y);
      ctx.arc(x, y, 4.5, 0, TWO_PI);
    }
    ctx.fill();
    this._overlayInk = true;
  }

  _clearOverlay() {
    if (!this._overlayInk || !this._ctx) return;
    this._ctx.clearRect(0, 0, OVERLAY_W, OVERLAY_H);
    this._overlayInk = false;
  }

  _teardown() {
    this._running = false;
    if (this._stream) {
      try { for (const t of this._stream.getTracks()) t.stop(); } catch { /* already dead */ }
      this._stream = null;
    }
    if (this._video) {
      try { this._video.pause(); } catch { /* fine */ }
      this._video.srcObject = null;
      this._video = null;
    }
    if (this._landmarker) {
      try { this._landmarker.close(); } catch { /* fine */ }
      this._landmarker = null;
    }
    if (this._dom?.parentNode) this._dom.parentNode.removeChild(this._dom);
    this._dom = null;
    this._canvas = null;
    this._ctx = null;
    this._overlayInk = false;
    this._lastVideoTime = -1;
  }
}

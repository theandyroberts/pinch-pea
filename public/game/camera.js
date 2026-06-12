import * as THREE from "../vendor/three.module.js";
import { CFG } from "./config.js";

// Third-person follow-orbit camera with soft voxel collision.
export class FollowCam {
  constructor(camera) {
    this.cam = camera;
    this.yaw = Math.PI * 0.25;
    this.pitch = 0.55;
    this.dist = CFG.camStart;
    this._smoothed = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._first = true;
  }

  applyLook(dx, dy) {
    this.yaw -= dx * 0.0042;
    this.pitch = Math.min(CFG.camPitchMax, Math.max(CFG.camPitchMin, this.pitch + dy * 0.0042));
  }

  applyZoom(d) {
    this.dist = Math.min(CFG.camMax, Math.max(CFG.camMin, this.dist + d));
  }

  forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  update(dt, focus, world) {
    this._target.set(focus.x, focus.y, focus.z);
    const cp = Math.cos(this.pitch), spt = Math.sin(this.pitch);
    this._dir.set(Math.sin(this.yaw) * cp, spt, Math.cos(this.yaw) * cp);

    // smooth toward the UNCLIPPED desired position…
    this._desired.copy(this._target).addScaledVector(this._dir, this.dist);
    if (this._first) { this._smoothed.copy(this._desired); this._first = false; }
    const k = 1 - Math.pow(0.0001, dt);   // framerate-independent smoothing
    this._smoothed.lerp(this._desired, k);

    // …then collide AFTER smoothing: clamp onto the actual focus→camera ray, so the
    // rendered camera can never spend lerp frames inside a wall
    this._dir.copy(this._smoothed).sub(this._target);
    const len = this._dir.length();
    if (len > 1e-6) {
      this._dir.multiplyScalar(1 / len);            // DDA needs a unit direction
      const hit = world.castRay(this._target, this._dir, len);
      if (hit) {
        const d = Math.max(CFG.camMin * 0.4, hit.dist - 0.4);
        this._smoothed.copy(this._target).addScaledVector(this._dir, d);
      }
    }

    // keep the lens just above the water surface (castRay ignores water)
    const cx = Math.floor(this._smoothed.x), cz = Math.floor(this._smoothed.z);
    let cy = Math.floor(this._smoothed.y);
    if (world.isWater(cx, cy, cz)) {
      while (world.isWater(cx, cy, cz)) cy++;
      this._smoothed.y = Math.max(this._smoothed.y, cy - 0.07);
    }

    this.cam.position.copy(this._smoothed);
    this.cam.lookAt(this._target);
  }
}

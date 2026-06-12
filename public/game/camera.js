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

    // shrink distance if a voxel blocks the view line
    let d = this.dist;
    const hit = world.castRay(this._target, this._dir, this.dist);
    if (hit) d = Math.max(CFG.camMin * 0.4, hit.dist - 0.4);

    this._desired.copy(this._target).addScaledVector(this._dir, d);
    if (this._first) { this._smoothed.copy(this._desired); this._first = false; }
    const k = 1 - Math.pow(0.0001, dt);   // framerate-independent smoothing
    this._smoothed.lerp(this._desired, k);
    this.cam.position.copy(this._smoothed);
    this.cam.lookAt(this._target);
  }
}

import { CFG } from "./config.js";
import { moveBody } from "./physics.js";

// Peathan: movement state + visual smoothing. Mesh/animation comes from characters.js.
export class Player {
  constructor(char, spawn) {
    this.char = char;                       // {group, animate(dt, state)}
    this.body = {
      pos: { x: spawn.x, y: spawn.y, z: spawn.z },
      vel: { x: 0, y: 0, z: 0 },
      w: CFG.playerWidth, h: CFG.playerHeight,
      onGround: false, inWater: false, headInWater: false, steppedUp: false
    };
    this.spawn = { ...spawn };
    this.facing = 0;
    this._visualY = spawn.y;
    this.moving = false;
    this.speed = 0;
    this.gestureWalk = false;               // set by hand-magic "open palm"
    this.gestureSteer = 0;                   // hand-magic steer: -1 (left) .. +1 (right)
  }

  update(dt, axis, jumpHeld, camForward, world, audio) {
    const b = this.body;

    // camera-relative move direction
    let mx = camForward.x * -axis.y + -camForward.z * axis.x;
    let mz = camForward.z * -axis.y + camForward.x * axis.x;
    if (this.gestureWalk) { mx += camForward.x; mz += camForward.z; }
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) { mx /= mlen; mz /= mlen; }

    const speed = b.inWater ? CFG.swimSpeed : CFG.walkSpeed;
    const accel = b.onGround || b.inWater ? 40 : 18;
    b.vel.x += (mx * speed - b.vel.x) * Math.min(1, accel * dt);
    b.vel.z += (mz * speed - b.vel.z) * Math.min(1, accel * dt);

    if (b.inWater) {
      b.vel.y += (jumpHeld ? CFG.waterBuoyancy : CFG.gravity * 0.18) * dt;
      b.vel.y = Math.max(-3, Math.min(3.2, b.vel.y));
    } else {
      if (jumpHeld && b.onGround) b.vel.y = CFG.jumpVel;
      b.vel.y += CFG.gravity * dt;
      b.vel.y = Math.max(-30, b.vel.y);
    }

    moveBody(world, b, dt);

    // never lost, never hurt: fell out of the world -> gentle respawn
    if (b.pos.y < -10) {
      b.pos = { ...this.spawn }; b.vel = { x: 0, y: 0, z: 0 };
      this._visualY = b.pos.y;
    }

    this.speed = Math.hypot(b.vel.x, b.vel.z);
    this.moving = this.speed > 0.4;
    if (this.moving) {
      const target = Math.atan2(b.vel.x, b.vel.z);
      let d = target - this.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.facing += d * Math.min(1, 12 * dt);
    }
    if (this.moving && b.onGround) audio.footstep();
  }

  // smooth the visual y over step-ups so climbing reads as a hop, not a teleport
  render(dt, time) {
    const b = this.body;
    this._visualY += (b.pos.y - this._visualY) * Math.min(1, 14 * dt);
    this.char.group.position.set(b.pos.x, this._visualY, b.pos.z);
    this.char.group.rotation.y = this.facing;
    this.char.animate(dt, time, {
      moving: this.moving, speed: this.speed,
      grounded: b.onGround, swimming: b.inWater
    });
  }

  eyePos() {
    const b = this.body;
    return { x: b.pos.x, y: this._visualY + CFG.eyeHeight, z: b.pos.z };
  }
}

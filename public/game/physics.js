import { CFG } from "./config.js";

// Axis-separated AABB-vs-voxel movement with auto step-up (the "climb" verb) and water.
// body = { pos:{x,y,z} (feet center), vel:{x,y,z}, w, h, onGround, inWater, headInWater, steppedUp }

export function moveBody(world, body, dt) {
  const hw = body.w / 2;
  body.steppedUp = false;

  body.inWater = isWaterAt(world, body.pos.x, body.pos.y + 0.4, body.pos.z);
  body.headInWater = isWaterAt(world, body.pos.x, body.pos.y + body.h - 0.15, body.pos.z);

  const move = { x: body.vel.x * dt, y: body.vel.y * dt, z: body.vel.z * dt };

  // X
  if (move.x !== 0) {
    const nx = body.pos.x + move.x;
    if (collides(world, nx, body.pos.y, body.pos.z, hw, body.h)) {
      if (tryStepUp(world, body, nx, body.pos.z, hw)) { body.pos.x = nx; }
      else { body.vel.x = 0; }
    } else body.pos.x = nx;
  }
  // Z
  if (move.z !== 0) {
    const nz = body.pos.z + move.z;
    if (collides(world, body.pos.x, body.pos.y, nz, hw, body.h)) {
      if (tryStepUp(world, body, body.pos.x, nz, hw)) { body.pos.z = nz; }
      else { body.vel.z = 0; }
    } else body.pos.z = nz;
  }
  // Y
  body.onGround = false;
  if (move.y !== 0) {
    const ny = body.pos.y + move.y;
    if (collides(world, body.pos.x, ny, body.pos.z, hw, body.h)) {
      if (move.y < 0) body.onGround = true;
      body.vel.y = 0;
      body.pos.y = move.y < 0 ? Math.floor(body.pos.y + 0.001) : body.pos.y;
    } else body.pos.y = ny;
  }
  // resting check (vel.y may be 0 exactly)
  if (!body.onGround && body.vel.y === 0 &&
      collides(world, body.pos.x, body.pos.y - 0.02, body.pos.z, hw, body.h)) {
    body.onGround = true;
  }
}

function tryStepUp(world, body, nx, nz, hw) {
  if (!body.onGround && !body.inWater) return false;
  const lift = CFG.stepUp;
  if (!collides(world, nx, body.pos.y + lift, nz, hw, body.h) &&
      !collides(world, body.pos.x, body.pos.y + lift, body.pos.z, hw, body.h)) {
    body.pos.y = Math.floor(body.pos.y + lift) + 0.001;
    body.steppedUp = true;
    return true;
  }
  return false;
}

export function collides(world, x, y, z, hw, h) {
  const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
  const y0 = Math.floor(y), y1 = Math.floor(y + h - 0.02);
  const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
  for (let yy = y0; yy <= y1; yy++) for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) {
    if (world.isSolid(xx, yy, zz)) return true;
  }
  return false;
}

function isWaterAt(world, x, y, z) {
  return world.isWater(Math.floor(x), Math.floor(y), Math.floor(z));
}

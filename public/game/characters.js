import * as THREE from "../vendor/three.module.js";
import { CFG } from "./config.js";

// Procedural clay characters: Peathan (the player pea-sprout) and Jaspea (his
// tiny pal). Pure Three.js primitives — spheres, boxes, a circle — squashed and
// stretched like thumbed plasticine. Origin of each group is at the FEET
// center, facing +Z. Returned API: { group, animate(dt, time, state), celebrate() }.

// ---------------------------------------------------------------------------
// Shared caches — geometries and materials are built once per page, reused by
// every character instance (universal rule: module-level cache).
// ---------------------------------------------------------------------------
let _geo = null;
function geo() {
  if (!_geo) {
    _geo = {
      sphere: new THREE.SphereGeometry(1, 22, 16), // unit sphere, scaled per mesh
      box: new THREE.BoxGeometry(1, 1, 1),
      circle: new THREE.CircleGeometry(1, 26)
    };
  }
  return _geo;
}

const _mats = new Map();
function mat(hex) {
  let m = _mats.get(hex);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: hex });
    _mats.set(hex, m);
  }
  return m;
}

let _shadowMat = null;
function shadowMat() {
  if (!_shadowMat) {
    _shadowMat = new THREE.MeshLambertMaterial({
      color: 0x2e4a2e, transparent: true, opacity: 0.25, depthWrite: false
    });
  }
  return _shadowMat;
}

// Clay palette
const COL = {
  peathan: 0x7fc163,   // sprout green
  jaspea: 0xa3d98a,    // lighter green
  leaf: 0x4e8a3e,      // dark sprout leaves (and little boot-feet)
  eye: 0x3a2b22,       // big dark eyes
  glint: 0xffffff,
  cheek: 0xf2aab8,     // blossom pink
  pack: 0x7b5ea7,      // plum-purple backpack
  button: 0xf2d98c     // butter-yellow button
};

const LEAN = 0.07;       // resting forward lean (rad) — eager little sprout
const CELEB_LEN = 1.2;   // celebrate flourish duration (s)

// Static parts never move relative to their parent — skip per-frame matrix work.
function freeze(obj) {
  obj.matrixAutoUpdate = false;
  obj.updateMatrix();
}

const IDLE_STATE = { moving: false, speed: 0, grounded: true, swimming: false };

// ---------------------------------------------------------------------------
// Character factory. All proportions are authored at Peathan scale (height
// 1.45) and multiplied by k for smaller friends. Eyes get their own factor so
// little Jaspea can have disproportionately big, cute eyes.
// ---------------------------------------------------------------------------
function buildCharacter(spec) {
  const g = geo();
  const k = spec.height / 1.45;

  const root = new THREE.Group();
  root.name = spec.name;

  // --- blob shadow (stays on the ground; shrinks while airborne) ----------
  const SHADOW_R = 0.45 * k;
  const shadow = new THREE.Mesh(g.circle, shadowMat());
  shadow.name = "blobShadow";
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  shadow.scale.setScalar(SHADOW_R);
  root.add(shadow);

  // --- rig: hop/spin offsets (celebrate) live here, so the root transform
  // stays owned by player.js / jaspea.js ----------------------------------
  const rig = new THREE.Group();
  root.add(rig);

  // --- torso: the whole clay blob. Pivot at the feet so squash-and-stretch
  // anchors to the ground like pressed plasticine. -------------------------
  const torso = new THREE.Group();
  torso.rotation.x = LEAN;
  rig.add(torso);

  // body — one big squashed pea (the head IS the body; maximum chub)
  const body = new THREE.Mesh(g.sphere, mat(spec.body));
  body.position.y = 0.58 * k;
  body.scale.set(0.46 * k, 0.42 * k, 0.44 * k);
  freeze(body);
  torso.add(body);

  // eyes — googly half-spheres ~60% up the body, pivots so blinks squash
  // around the eye center. Glint rides inside the pivot.
  const eyeRad = 0.095 * k * spec.eyeFactor;
  function makeEye(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.155 * k, 0.87 * k, 0.33 * k);
    const ball = new THREE.Mesh(g.sphere, mat(COL.eye));
    ball.scale.setScalar(eyeRad);
    freeze(ball);
    pivot.add(ball);
    const glint = new THREE.Mesh(g.sphere, mat(COL.glint));
    glint.scale.setScalar(eyeRad * 0.32);
    glint.position.set(side * eyeRad * 0.25, eyeRad * 0.32, eyeRad * 0.72);
    freeze(glint);
    pivot.add(glint);
    torso.add(pivot);
    return pivot;
  }
  const eyeL = makeEye(1);
  const eyeR = makeEye(-1);

  // pink cheek dots, pressed flat onto the face
  for (let side = -1; side <= 1; side += 2) {
    const cheek = new THREE.Mesh(g.sphere, mat(COL.cheek));
    cheek.position.set(side * 0.27 * k, 0.77 * k, 0.29 * k);
    cheek.scale.set(0.06 * k, 0.05 * k, 0.035 * k);
    freeze(cheek);
    torso.add(cheek);
  }

  // stub arms — pivot at the shoulder, blob hangs just below
  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.44 * k, 0.60 * k, 0.02 * k);
    pivot.rotation.z = side * 0.22;
    const stub = new THREE.Mesh(g.sphere, mat(spec.body));
    stub.position.set(side * 0.02 * k, -0.07 * k, 0);
    stub.scale.set(0.075 * k, 0.115 * k, 0.075 * k);
    freeze(stub);
    pivot.add(stub);
    torso.add(pivot);
    return pivot;
  }
  const armL = makeArm(1);
  const armR = makeArm(-1);

  // little boot-feet (children of the torso, so landing splats squish them too)
  const FOOT_Y = 0.085 * k;
  function makeFoot(side) {
    const foot = new THREE.Mesh(g.sphere, mat(COL.leaf));
    foot.position.set(side * 0.15 * k, FOOT_Y, 0.02 * k);
    foot.scale.set(0.115 * k, 0.085 * k, 0.13 * k);
    torso.add(foot);
    return foot;
  }
  const footL = makeFoot(1);
  const footR = makeFoot(-1);

  // sprout leaves on the crown — the leaves group sways, leaves are frozen
  const leaves = new THREE.Group();
  leaves.position.set(0, 0.99 * k, -0.03 * k);
  torso.add(leaves);
  function addLeaf(rotZ, rotY, len, width) {
    const stem = new THREE.Group();
    stem.rotation.set(0, rotY, rotZ);
    const blade = new THREE.Mesh(g.sphere, mat(COL.leaf));
    blade.position.set(0, len * 0.85, 0);
    blade.scale.set(width, len, 0.04 * k);
    freeze(blade);
    stem.add(blade);
    freeze(stem);
    leaves.add(stem);
  }
  if (spec.leaves >= 3) {
    addLeaf(0.06, 0, 0.24 * k, 0.085 * k);          // tall center blade
    addLeaf(0.55, 0.6, 0.16 * k, 0.07 * k);          // side sprouts
    addLeaf(-0.55, -0.6, 0.16 * k, 0.07 * k);
  } else {
    addLeaf(0.18, 0.3, 0.24 * k, 0.10 * k);          // one chunky cowlick leaf
  }

  // plum backpack: box + slightly-larger ellipsoid faking the rounded bevel
  if (spec.backpack) {
    const packMat = mat(COL.pack);
    const pack = new THREE.Mesh(g.box, packMat);
    pack.position.set(0, 0.60 * k, -0.48 * k);
    pack.scale.set(0.42 * k, 0.48 * k, 0.20 * k);
    freeze(pack);
    torso.add(pack);
    const bevel = new THREE.Mesh(g.sphere, packMat);
    bevel.position.set(0, 0.60 * k, -0.48 * k);
    bevel.scale.set(0.235 * k, 0.27 * k, 0.125 * k);
    freeze(bevel);
    torso.add(bevel);
    const flap = new THREE.Mesh(g.sphere, packMat);
    flap.position.set(0, 0.82 * k, -0.50 * k);
    flap.rotation.x = -0.45;
    flap.scale.set(0.20 * k, 0.05 * k, 0.13 * k);
    freeze(flap);
    torso.add(flap);
    const button = new THREE.Mesh(g.sphere, mat(COL.button));
    button.position.set(0, 0.74 * k, -0.60 * k);
    button.scale.setScalar(0.04 * k);
    freeze(button);
    torso.add(button);
  }

  // -------------------------------------------------------------------------
  // Animation state — one mutable record per character, all numbers. The
  // animate() below touches only these and cached object refs: zero per-frame
  // allocation.
  // -------------------------------------------------------------------------
  const S = {
    sp: 0,                              // smoothed 0..1 movement intensity
    phase: 0,                           // gait phase (rad)
    lean: LEAN,                         // smoothed torso pitch
    blinkIn: 1.5 + Math.random() * 2.5, // s until next blink
    blinkT: 0,                          // s of blink remaining
    airT: 0,                            // continuous airborne time
    landT: 0,                           // landing-splat time remaining
    celebT: -1,                         // celebrate clock, -1 = idle
    shadow: 1                           // smoothed shadow scale factor
  };

  function celebrate() {
    S.celebT = 0; // restartable any time; animate() drives it from here
  }

  function animate(dt, time, state) {
    const st = state || IDLE_STATE;
    if (!(dt >= 0)) dt = 0;       // also catches NaN/undefined
    else if (dt > 0.1) dt = 0.1;  // tab-switch spikes won't fast-forward timers
    const t = time || 0;

    // movement intensity (0..1), eased so starts/stops feel clay-heavy
    let target = 0;
    if (st.moving) {
      target = (st.speed || 0) / CFG.walkSpeed;
      if (target > 1) target = 1;
      else if (target < 0.35) target = 0.35; // slow hops still visibly waddle
    }
    S.sp += (target - S.sp) * Math.min(1, 10 * dt);
    const sp = S.sp;

    // gait phase — at full walk speed one bounce per footstep (~0.34s)
    S.phase += dt * (5 + 14 * sp);

    const grounded = st.grounded !== false;
    const swimming = !!st.swimming;

    // landing splat: only after real airtime, so step-up flicker stays calm
    if (!grounded && !swimming) {
      S.airT += dt;
    } else {
      if (S.airT > 0.12) S.landT = 0.16;
      S.airT = 0;
    }
    if (S.landT > 0) S.landT -= dt;

    // --- squash & stretch ------------------------------------------------
    const bob = Math.sin(S.phase) * 0.06 * sp;            // waddle bounce
    const breath = Math.sin(t * 2.1) * 0.02 * (1 - sp);   // slow idle breathing
    let sy = 1 + bob + breath;
    if (!grounded && !swimming) sy += 0.07;               // stretch in the air
    if (S.landT > 0) sy -= 0.18 * (S.landT / 0.16);       // splat on landing

    // --- celebrate: wind-up squash → hop + full spin → landing wobble -----
    let hop = 0, spin = 0;
    if (S.celebT >= 0) {
      S.celebT += dt;
      const ct = S.celebT / CELEB_LEN;
      if (ct >= 1) {
        S.celebT = -1;
      } else if (ct < 0.16) {
        sy *= 1 - 0.26 * (ct / 0.16);
      } else if (ct < 0.75) {
        const h = (ct - 0.16) / 0.59;
        const arc = Math.sin(h * Math.PI);
        hop = arc * 0.55 * k;
        spin = h * Math.PI * 2;
        sy *= 1 + 0.2 * arc;
      } else {
        const l = (ct - 0.75) / 0.25;
        sy *= 1 - 0.22 * Math.sin(l * Math.PI);
      }
    }
    rig.position.y = hop;
    rig.rotation.y = spin;

    if (sy < 0.6) sy = 0.6;
    else if (sy > 1.4) sy = 1.4;
    const sxz = 1 - (sy - 1) * 0.55; // clay conserves volume
    torso.scale.set(sxz, sy, sxz);

    // --- lean & swim wiggle ------------------------------------------------
    const leanTarget = swimming ? -0.42 : LEAN + 0.12 * sp;
    S.lean += (leanTarget - S.lean) * Math.min(1, 6 * dt);
    torso.rotation.x = S.lean + (swimming ? Math.sin(t * 3.1) * 0.06 : 0);
    const rollTarget = swimming ? Math.sin(t * 2.4) * 0.08 : 0;
    torso.rotation.z += (rollTarget - torso.rotation.z) * Math.min(1, 8 * dt);

    // --- arms ---------------------------------------------------------------
    if (S.celebT >= 0) {
      // both stubs thrown up, jazz-hands wiggle
      const wave = Math.sin(t * 16) * 0.3;
      armL.rotation.x = 0; armR.rotation.x = 0;
      armL.rotation.z = 2.2 + wave;
      armR.rotation.z = -2.2 - wave;
    } else if (swimming) {
      armL.rotation.x = -0.5 + Math.sin(t * 5.2) * 0.7;
      armR.rotation.x = -0.5 - Math.sin(t * 5.2) * 0.7;
      armL.rotation.z = 0.35;
      armR.rotation.z = -0.35;
    } else {
      const swing = Math.sin(S.phase) * 0.85 * sp;
      armL.rotation.x = swing;
      armR.rotation.x = -swing;
      armL.rotation.z = 0.22 + breath * 2;
      armR.rotation.z = -0.22 - breath * 2;
    }

    // --- feet: alternating patter while walking, lazy kicks while swimming --
    if (swimming) {
      footL.position.y = FOOT_Y + Math.max(0, Math.sin(t * 6)) * 0.05 * k;
      footR.position.y = FOOT_Y + Math.max(0, -Math.sin(t * 6)) * 0.05 * k;
    } else {
      footL.position.y = FOOT_Y + Math.max(0, Math.sin(S.phase)) * 0.075 * k * sp;
      footR.position.y = FOOT_Y + Math.max(0, -Math.sin(S.phase)) * 0.075 * k * sp;
    }

    // --- blink every 3-5s (accumulated time, no timers) ----------------------
    if (S.blinkT > 0) {
      S.blinkT -= dt;
    } else {
      S.blinkIn -= dt;
      if (S.blinkIn <= 0) {
        S.blinkT = 0.12;
        S.blinkIn = 3 + Math.random() * 2;
      }
    }
    const eyeSy = S.blinkT > 0 ? 0.1 : 1;
    eyeL.scale.y = eyeSy;
    eyeR.scale.y = eyeSy;

    // --- sprout leaves trail and sway -----------------------------------------
    leaves.rotation.x = -0.12 * sp + Math.sin(t * 1.7) * 0.05;
    leaves.rotation.z = Math.sin(t * 1.3 + 1.7) * 0.06;

    // --- blob shadow shrinks while airborne -----------------------------------
    const inAir = (!grounded && !swimming) || hop > 0.01;
    S.shadow += ((inAir ? 0.62 : 1) - S.shadow) * Math.min(1, 10 * dt);
    shadow.scale.setScalar(SHADOW_R * S.shadow);
  }

  // settle into the idle pose so frame zero already looks alive
  animate(0.016, 0, IDLE_STATE);

  return { group: root, animate, celebrate };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function buildPeathan() {
  return buildCharacter({
    name: "peathan",
    height: 1.45,
    body: COL.peathan,
    leaves: 3,
    eyeFactor: 1,
    backpack: true
  });
}

export function buildJaspea() {
  return buildCharacter({
    name: "jaspea",
    height: 0.85,
    body: COL.jaspea,
    leaves: 1,
    eyeFactor: 1.35, // big puppy eyes relative to her tiny body
    backpack: false
  });
}

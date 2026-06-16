// All balance/tuning numbers live here as data (design system §9.5).
export const CFG = {
  worldSeed: 19237,
  worldSize: 192,          // blocks per side
  worldHeight: 48,
  chunkSize: 16,
  seaLevel: 12,

  // agency metrics — FROZEN (design/plan.md)
  reach: 5,
  playerHeight: 1.5,
  playerWidth: 0.6,
  eyeHeight: 1.35,
  walkSpeed: 4.3,
  swimSpeed: 2.2,
  jumpVel: 7.4,            // ≈1.25 block jump apex
  gravity: -21,
  stepUp: 1.05,            // auto-climb one block
  waterBuoyancy: 14,

  stepSfxInterval: 0.34,   // s between footsteps
  saveInterval: 5,         // s autosave

  dprCap: 1.5,
  remeshPerFrame: 2,
  fogColor: 0xcfe8f4,
  fogNear: 55,
  fogFar: 120,
  camMin: 4, camMax: 16, camStart: 8,
  camPitchMin: 0.12, camPitchMax: 1.25,

  tapMaxPx: 12, tapMaxMs: 250,

  gestureEveryNFrames: 2,
  pinchOn: 0.35, pinchOff: 0.45, pinchDebounceMs: 80,
  palmWalkHoldMs: 250,

  growTimeS: 22,           // sapling -> tree
  flowerGrowS: 6,

  volumes: { music: 0.22, sfx: 0.8, ambient: 0.5 },

  stackMax: 999,           // max of any one block a player can hold (badge fits 3 digits)
  startInventory: { pink: 24, cream: 47, yellow: 16, blue: 9, wood: 32, lavender: 5 },
  unlockBundles: {
    cozy_home: { lavender: 20 },
    flower_garden: { yellow: 24 },
    bridge: { blue: 24 },
    sky_tower: { pink: 24, cream: 24 }
  }
};

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

  // Quest ladder (data-driven, see docs/superpowers/specs/2026-06-15-quest-ladder-design.md).
  // One gentle goal at a time, teaching a verb per rung; the house is the finale.
  // type drives how progress is measured; goal meaning depends on type:
  //   pinch/place/flowers/bridge → a count · growTree/hugJaspea → a count
  //   standHeight → target block-Y to stand on (player-placed) · blueprint → the cozy_home shell
  questSaveVersion: 3,
  quests: [
    { id: "build_first",   type: "place",       goal: 3  },  // building first — his natural instinct, instant win
    { id: "pinch3",        type: "pinch",       goal: 3  },  // then the signature "pinch" verb
    { id: "hug_jaspea",    type: "hugJaspea",   goal: 3  },
    { id: "grow_tree",     type: "growTree",    goal: 1  },
    { id: "flower_garden", type: "flowers",     goal: 5  },
    { id: "little_hill",   type: "standHeight", goal: 17 },  // ~seaLevel+5; verify in-game
    { id: "bridge",        type: "bridge",      goal: 6  },
    { id: "sky_tower",     type: "standHeight", goal: 24 },
    { id: "big_wall",      type: "place",       goal: 20 },
    { id: "cozy_home",     type: "blueprint"             }
  ],
  unlockBundles: {
    build_first:   { yellow: 10 },
    pinch3:        { cream: 10 },
    hug_jaspea:    { blue: 10 },
    grow_tree:     { wood: 12 },
    flower_garden: { yellow: 24 },
    little_hill:   { lavender: 15 },
    bridge:        { blue: 24 },
    sky_tower:     { pink: 24 },
    big_wall:      { cream: 20, pink: 10 },
    cozy_home:     { lavender: 20 }
  }
};

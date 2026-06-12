// Every player-visible string lives here. Swapping language = swapping this data.
export const STR = {
  title: "Pinchy Pea",
  tagline: "is born!",
  loading: "Squishing the world into shape…",
  tapToStart: "Tap to play!",
  makeYourWorld: "Make your world!",

  btnJump: "Jump",
  btnPinch: "Pinch",
  btnBuild: "Build",
  btnPalette: "Clay box",
  btnHandMagic: "Hand magic",
  btnHandMagicOff: "Hands off",
  btnMute: "Sound",
  btnMusic: "Music",
  btnSfx: "Sounds",
  btnPhoto: "Photo",

  modePinch: "Pinch mode — tap a block to squish it up!",
  modeBuild: "Build mode — tap the ground to place clay!",

  handMagicLoading: "Warming up the magic camera…",
  handMagicReady: "Wave your hand! Pinch fingers to grab, open palm to walk.",
  handMagicDenied: "No camera this time — fingers on the screen work great too!",
  handMagicError: "The magic camera is napping. Touch still works!",
  handMagicWalk: "Walking!",
  handMagicPinch: "Pinch!",

  questTitle: "Make your world!",
  quests: {
    cozy_home: { name: "Build a cozy bubble home!", done: "What a cozy home! Jaspea loves it!" },
    flower_garden: { name: "Plant 5 happy flowers!", done: "The garden smells amazing!" },
    bridge: { name: "Build a bridge over the water!", done: "A bridge! Now the peas can visit the pink isle!" },
    sky_tower: { name: "Build up to the clouds and stand on top!", done: "You can see the whole world from here!" }
  },
  questAllDone: "You made the world wonderful. Keep building anything you dream!",
  questProgress: (done, total) => `${done} / ${total}`,

  jaspea: {
    hello: "Hi! I'm Jaspea! Let's build something!",
    pinchTip: "Pinch a block to pick it up!",
    buildTip: "Now tap the ground to place it!",
    giggle: "Hee hee! That tickles!",
    nearWater: "Splish splash! I love the sea!",
    nearBlossom: "Pink trees! So pretty!",
    grow: "Look! It's growing!",
    cheer: "Yaaay! You did it!",
    idle1: "What should we make next?",
    idle2: "I like the purple hills best.",
    idle3: "Your backpack looks heavy, Peathan!",
    almostClouds: "Higher! Almost at the clouds!",
    flowerTip: "Pinch the little flowers in the meadow!",
    rescue: "Hup! Up you go, Peathan!"
  },

  blocks: {
    grass: "Meadow", soil: "Soil", brick: "Brick", stone: "Pebble", wood: "Stick",
    leaf: "Leafy", sand: "Sandy", water: "Water", pink: "Blossom", lavender: "Lavender",
    yellow: "Butter", blue: "Sky", cream: "Cream", flower: "Flower", sapling: "Sprout",
    blossomleaf: "Petal"
  },

  toastSaved: "World saved!",
  toastPocketFull: "Pocket full of that clay!",
  toastNoClay: "No more of that clay — pinch some up!",
  toastNoFlowers: "Pinch the little flowers in the meadow!",
  toastUnlock: (name) => `New clay unlocked: ${name}!`,
  toastPhoto: "Snapshot saved to your pictures!",
  toastPhotoDownload: "Snapshot downloaded!",
  toastTooFar: "Walk a little closer!",
  toastOnYou: "That spot is where YOU are standing!",
  rotateCard: "Turn your phone tall to play!",

  devOverlay: "dev",
  pausedHint: "Paused — come back soon!"
};

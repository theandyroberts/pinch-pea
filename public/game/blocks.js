import * as THREE from "../vendor/three.module.js";

// Block registry. tile = atlas slot, tint multiplies the clay texture (clay_plain is the
// neutral base that becomes every pastel color), partial = sub-cube scale for plants.
export const B = {
  AIR: 0, GRASS: 1, SOIL: 2, BRICK: 3, STONE: 4, WOOD: 5, LEAF: 6, SAND: 7, WATER: 8,
  PINK: 9, LAVENDER: 10, YELLOW: 11, BLUE: 12, CREAM: 13, FLOWER: 14, SAPLING: 15,
  BLOSSOMLEAF: 16
};

export const BLOCKS = [
  { id: 0,  key: "air",        tile: -1, solid: false, pick: false },
  { id: 1,  key: "grass",      tile: 0,  tint: 0xffffff, solid: true,  pick: true, drops: "grass" },
  { id: 2,  key: "soil",       tile: 2,  tint: 0xc9a07e, solid: true,  pick: true, drops: "soil" },
  { id: 3,  key: "brick",      tile: 1,  tint: 0xffffff, solid: true,  pick: true, drops: "brick" },
  { id: 4,  key: "stone",      tile: 3,  tint: 0xffffff, solid: true,  pick: true, drops: "stone" },
  { id: 5,  key: "wood",       tile: 4,  tint: 0xffffff, solid: true,  pick: true, drops: "wood" },
  { id: 6,  key: "leaf",       tile: 5,  tint: 0xffffff, solid: true,  pick: true, drops: "leaf" },
  { id: 7,  key: "sand",       tile: 6,  tint: 0xffffff, solid: true,  pick: true, drops: "sand" },
  { id: 8,  key: "water",      tile: 2,  tint: 0x8fd0ee, solid: false, pick: false, water: true },
  { id: 9,  key: "pink",       tile: 2,  tint: 0xf2aab8, solid: true,  pick: true, drops: "pink" },
  { id: 10, key: "lavender",   tile: 2,  tint: 0xbfaae8, solid: true,  pick: true, drops: "lavender" },
  { id: 11, key: "yellow",     tile: 2,  tint: 0xf4dc92, solid: true,  pick: true, drops: "yellow" },
  { id: 12, key: "blue",       tile: 2,  tint: 0xa7d2f2, solid: true,  pick: true, drops: "blue" },
  { id: 13, key: "cream",      tile: 2,  tint: 0xfff4e2, solid: true,  pick: true, drops: "cream" },
  { id: 14, key: "flower",     tile: 5,  tint: 0xf7d98c, solid: false, pick: true, partial: 0.45, drops: "flower" },
  { id: 15, key: "sapling",    tile: 5,  tint: 0xa8e6a0, solid: false, pick: true, partial: 0.5,  drops: "sapling" },
  { id: 16, key: "blossomleaf",tile: 5,  tint: 0xf4b8cc, solid: true,  pick: true, drops: "blossomleaf" }
];

export const byKey = {};
for (const b of BLOCKS) byKey[b.key] = b;

// Hotbar/palette ordering (mirrors the mockup: pink, cream, yellow, blue, wood, lavender first)
export const PALETTE_ORDER = [
  "pink", "cream", "yellow", "blue", "wood", "lavender",
  "brick", "grass", "soil", "stone", "leaf", "sand", "blossomleaf", "flower", "sapling"
];

// ---- texture atlas -------------------------------------------------------
// 4×2 grid of 256px tiles: [grass, terracotta, clay_plain, stone, wood, leaf, sand, spare]
const ATLAS_COLS = 4, ATLAS_ROWS = 2, TILE_PX = 256;
const TILE_FILES = [
  "tile_grass.png", "tile_terracotta.png", "tile_clay_plain.png", "tile_stone.png",
  "tile_wood.png", "tile_leaf.png", "tile_sand.png", null
];
// fallback flat colors if a texture failed to land (manifest failure is reported, not hidden)
const TILE_FALLBACK = [0x9ed98c, 0xd99a78, 0xf2e7d4, 0xb8b0c4, 0xa07a58, 0x86c66e, 0xeee0b8, 0xffffff];

export async function buildAtlas() {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_COLS * TILE_PX; canvas.height = ATLAS_ROWS * TILE_PX;
  const ctx = canvas.getContext("2d");
  const missing = [];
  await Promise.all(TILE_FILES.map((f, i) => new Promise((res) => {
    const cx = (i % ATLAS_COLS) * TILE_PX, cy = Math.floor(i / ATLAS_COLS) * TILE_PX;
    if (!f) { ctx.fillStyle = "#fff"; ctx.fillRect(cx, cy, TILE_PX, TILE_PX); return res(); }
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, cx, cy, TILE_PX, TILE_PX); res(); };
    img.onerror = () => {
      missing.push(f);
      ctx.fillStyle = "#" + TILE_FALLBACK[i].toString(16).padStart(6, "0");
      ctx.fillRect(cx, cy, TILE_PX, TILE_PX); res();
    };
    img.src = "./assets/tex/" + f;
  })));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  return { texture, missing };
}

// UV rect for a tile slot, inset to avoid mip bleeding across atlas cells
const INSET = 6 / (ATLAS_COLS * TILE_PX);
export function uvRect(tile) {
  const c = tile % ATLAS_COLS, r = Math.floor(tile / ATLAS_COLS);
  const u0 = c / ATLAS_COLS + INSET, u1 = (c + 1) / ATLAS_COLS - INSET;
  // canvas y-down -> uv y-up
  const v1 = 1 - r / ATLAS_ROWS - INSET, v0 = 1 - (r + 1) / ATLAS_ROWS + INSET;
  return [u0, v0, u1, v1];
}

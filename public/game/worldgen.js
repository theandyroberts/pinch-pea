import { B } from "./blocks.js";
import { CFG } from "./config.js";
import { mulberry32, makeNoise2D } from "./rng.js";

// Seeded island archipelago: mint meadows, blossom hills, lavender peaks, sandy shores,
// trees, flowers, pebble outcrops. Deterministic from CFG.worldSeed.
export function generateWorld(world) {
  const S = CFG.worldSize, H = CFG.worldHeight, SEA = CFG.seaLevel;
  const noiseH = makeNoise2D(CFG.worldSeed);
  const noiseM = makeNoise2D(CFG.worldSeed + 101);
  const noiseI = makeNoise2D(CFG.worldSeed + 202);
  const rand = mulberry32(CFG.worldSeed + 303);

  const height = new Int16Array(S * S);
  const biome = new Uint8Array(S * S);   // 0 meadow, 1 blossom, 2 lavender, 3 sand, 4 sea

  const cx = S / 2, cz = S / 2;
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) {
    const dx = (x - cx) / (S * 0.5), dz = (z - cz) / (S * 0.5);
    const r = Math.sqrt(dx * dx + dz * dz);
    // wobble the falloff so the coastline is organic + satellite islands appear
    const wob = noiseI.fbm(x / 38, z / 38, 3) * 0.55;
    const island = Math.max(0, 1 - (r * 1.25 - wob));
    const hills = noiseH.fbm(x / 42, z / 42, 4);
    const ridge = Math.pow(noiseH.fbm(x / 90 + 7, z / 90 + 7, 3), 2.2);
    let h = (SEA - 7) + island * (6 + hills * 16 + ridge * 22);
    h = Math.min(H - 6, Math.floor(h));
    height[z * S + x] = h;

    const moist = noiseM.fbm(x / 56, z / 56, 3);
    let bio;
    if (h < SEA) bio = 4;
    else if (h <= SEA + 1) bio = 3;
    else if (h > SEA + 13) bio = 2;
    else if (moist > 0.58) bio = 1;
    else bio = 0;
    biome[z * S + x] = bio;
  }

  // fill columns
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) {
    const h = height[z * S + x], bio = biome[z * S + x];
    for (let y = 0; y <= Math.max(h, SEA - 1); y++) {
      if (y > h) { world.setRaw(x, y, z, y < SEA ? B.WATER : B.AIR); continue; }
      if (y === 0) { world.setRaw(x, y, z, B.STONE); continue; }
      if (y === h) {
        const top = bio === 3 ? B.SAND
          : bio === 4 ? B.SAND
          : bio === 1 ? B.PINK
          : bio === 2 ? B.LAVENDER
          : B.GRASS;
        world.setRaw(x, y, z, top);
      } else if (y > h - 3) {
        world.setRaw(x, y, z, bio === 3 || bio === 4 ? B.SAND : B.SOIL);
      } else {
        world.setRaw(x, y, z, B.STONE);
      }
    }
  }

  // decorations
  const flatAt = (x, z) => {
    const h = height[z * S + x];
    return Math.abs(height[z * S + Math.min(S - 1, x + 1)] - h) <= 1 &&
           Math.abs(height[Math.min(S - 1, z + 1) * S + x] - h) <= 1;
  };

  for (let z = 4; z < S - 4; z++) for (let x = 4; x < S - 4; x++) {
    const i = z * S + x, h = height[i], bio = biome[i];
    if (bio === 4 || bio === 3) continue;
    const roll = rand();
    if ((bio === 0 && roll < 0.006) || (bio === 1 && roll < 0.012)) {
      if (flatAt(x, z)) plantTree(world, x, h + 1, z, bio === 1, rand);
    } else if (roll > 0.985 && bio !== 2) {
      world.setRaw(x, h + 1, z, B.FLOWER);
    } else if (roll > 0.978 && roll <= 0.981 && bio === 2) {
      world.setRaw(x, h + 1, z, B.STONE); // little pebbles on the peaks
    }
  }

  // spawn: walk out from center to find grass above sea
  let spawn = { x: cx, z: cz };
  outer:
  for (let ring = 0; ring < S / 2 - 4; ring++) {
    for (let dz = -ring; dz <= ring; dz++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
      const x = Math.floor(cx + dx), z = Math.floor(cz + dz);
      const i = z * S + x;
      if (biome[i] === 0 && height[i] > SEA + 1 && flatAt(x, z)) {
        spawn = { x: x + 0.5, z: z + 0.5 }; break outer;
      }
    }
  }
  const spawnY = world.topSolidY(Math.floor(spawn.x), Math.floor(spawn.z)) + 1;

  // cozy-home quest site: nearest flat meadow pad ~10 blocks from spawn
  let site = { x: Math.floor(spawn.x) + 8, z: Math.floor(spawn.z) };
  outer2:
  for (let ring = 6; ring < 40; ring++) {
    for (let dz = -ring; dz <= ring; dz += 2) for (let dx = -ring; dx <= ring; dx += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
      const x = Math.floor(spawn.x + dx), z = Math.floor(spawn.z + dz);
      if (x < 8 || z < 8 || x > S - 16 || z > S - 12) continue;
      const i = z * S + x;
      if (biome[i] === 0 && height[i] > SEA + 1) {
        let ok = true;
        for (let zz = 0; zz < 4 && ok; zz++) for (let xx = 0; xx < 6 && ok; xx++) {
          const j = (z + zz) * S + (x + xx);
          if (biome[j] === 4 || Math.abs(height[j] - height[i]) > 1) ok = false;
        }
        if (ok) { site = { x, z }; break outer2; }
      }
    }
  }

  return { height, biome, spawn: { x: spawn.x, y: spawnY, z: spawn.z }, homeSite: site };
}

function plantTree(world, x, y, z, blossom, rand) {
  const trunkH = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < trunkH; i++) world.setRaw(x, y + i, z, B.WOOD);
  const leaf = blossom ? B.BLOSSOMLEAF : B.LEAF;
  const ty = y + trunkH;
  for (let dy = 0; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (dy === 2 && (dx !== 0 || dz !== 0)) continue;          // pointy top
    if (dy === 0 && Math.abs(dx) + Math.abs(dz) === 2) continue; // rounded shoulders
    if (world.get(x + dx, ty + dy, z + dz) === 0) world.setRaw(x + dx, ty + dy, z + dz, leaf);
  }
}

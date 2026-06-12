# Pinchy Pea — Plan

## Experience formula
The player feels like a tiny clay creator in a squishy pastel world, because the game
constantly turns every pinch into a satisfying, hand-made change to the world.

## Profile
- Time: real-time, pressure-free (pause on blur, no timers against the player)
- Space: continuous 3D over a discrete voxel grid (192×48×192 island archipelago, seeded)
- Agency: one hero (Peathan) + companion (Jaspea, non-essential follower)
- Conflict: none — attention held by discovery (biomes, islands) + expression (building)
- Content: procedural world + player-created builds + authored gentle quests
- Outcome: player-set goals; optional blueprint quests; endless sandbox
- Players: solo
- Session: minutes (commute-sized); instant resume via auto-save
- Engagement: expression + discovery
- Harm: impossible by design — no damage, no enemies, no fall damage, water = swimming

## Delivery context
Web (deployed bundle). Touch-first (iPhone/iPad), keyboard+mouse (physical key codes),
gamepad (standard mapping), optional camera hand-gestures (MediaPipe, lazy-loaded,
permission-gated, full touch fallback). Strings external in strings.js.

## Verbs
move/climb (auto step-up — never stuck), jump, swim, **pinch** (harvest block / squeeze
Jaspea / pop), **place** (build), plant (saplings & flowers grow), inspect quests, photo-calm
camera orbit/zoom. Pinch is the hero verb: works on blocks, plants, clouds (particles), Jaspea.

## Mastery sequence
walk/look → pinch (harvest) → place → palette & colors → saplings grow → blueprint quests →
camera hand-magic (optional exam: build with gestures only)

## Agency metrics (frozen)
reach 5 blocks · jump 1.25 blocks · step-up 1 block · speed 4.3 blocks/s · world 192×48×192
sea level y=12 · hero height 1.5 blocks

## Quests (peaks)
1. Cozy bubble home (blueprint shell ≥85% filled) → unlock lavender bundle
2. Flower garden (plant 5 flowers) → butter-yellow bundle
3. Bridge over water (12 blocks above water) → sky-blue bundle
4. Sky lookout (stand on own block ≥ y 24) → confetti finale + free build

## Style
STYLE FORMULA approved (explicit from user reference image) — see assets.csv; engine
lighting derived from formula: warm hemisphere light, soft directional, pastel fog, no shadows
(blob shadows under characters).

## Assets
design/assets.csv is the manifest (law). Procedural 3D characters per 3d-animation.md
non-rigged branch (Three.js squash-and-stretch code animation).

# Pinchy Pea — 10-level quest ladder

**Date:** 2026-06-15
**Status:** approved design, ready to implement

## Problem

The first quest, `cozy_home`, asks the player to fill a 39-block house blueprint
(45-cell shell × 85%). That is the hardest goal in the game and it is presented
*first* — far too ambitious for the 7-year-old this game is built for. He gets no
on-ramp, no early wins, and no chance to learn the verbs before the marquee build.

## Goal

Replace the 4-quest line with a **10-level ladder** that teaches one verb at a time
and ramps gently. The existing house becomes the **finale at level 10**, unchanged.
Early levels are short, confidence-building, with two low-pressure "fun" beats.

## Approach: make the quest engine data-driven

Today `quests.js` hardcodes 4 quests via an `if (q===0/1/2/3)` ladder in
`onBlockPlaced` / `onBlockRemoved` / `checkStand` / `_info`. Extending that to 10
branches would be unmaintainable.

Refactor so each quest is a **data row** and the engine dispatches by `type`:

```
{ id, type, goal }        // goal meaning depends on type
```

Quest types and how each measures progress:

| type | progress source | goal means | decrement? |
|------|-----------------|-----------|-----------|
| `pinch`       | `onBlockRemoved` of a pickable block | # harvested | no (cumulative) |
| `place`       | `onBlockPlaced` of a solid block | # placed | no (cumulative) |
| `flowers`     | `onBlockPlaced`/`Removed` of `FLOWER` | # flowers standing | yes (existing) |
| `growTree`    | new `onTreeGrown()` hook | # trees grown | no |
| `hugJaspea`   | new `onJaspeaHug()` hook | # hugs | no |
| `standHeight` | `checkStand()` (highest player-placed block stood on) | target Y | n/a (best-so-far) |
| `bridge`      | `onBlockPlaced` solid with WATER within 2 below | # bridge blocks | no (existing) |
| `blueprint`   | blueprint ghost cell fill (existing cozy_home machinery) | 85% of shell | n/a |

Only one quest is active at a time, so the engine tracks a single `progress`
integer for the active quest (except `blueprint`, derived from world state, and
`standHeight`, tracked as best-Y). When a quest completes, progress resets and the
next activates — same confetti / cheer / both-peas-celebrate / clay-reward flow as
today via the existing `hooks`.

## The ladder

| Lvl | id | type | goal | name string | reward bundle |
|----|----|------|------|-------------|---------------|
| 1 | `pinch3` | pinch | 3 | "Squish up 3 blocks of clay!" | `{ cream: 10 }` |
| 2 | `place5` | place | 5 | "Build with 5 blocks of clay!" | `{ yellow: 10 }` |
| 3 | `hug_jaspea` | hugJaspea | 3 | "Give Jaspea 3 squishy hugs!" | `{ blue: 10 }` |
| 4 | `grow_tree` | growTree | 1 | "Plant a sprout and grow a tree!" | `{ wood: 12 }` |
| 5 | `flower_garden` | flowers | 5 | "Plant 5 happy flowers!" | `{ yellow: 24 }` |
| 6 | `little_hill` | standHeight | seaLevel+5 (~17) | "Stack clay and stand up high!" | `{ lavender: 15 }` |
| 7 | `bridge` | bridge | 6 | "Build a little bridge over the water!" | `{ blue: 24 }` |
| 8 | `sky_tower` | standHeight | 24 | "Build all the way up to the clouds!" | `{ pink: 24 }` |
| 9 | `big_wall` | place | 20 | "Build a big clay wall — 20 blocks!" | `{ cream: 20, pink: 10 }` |
| 10 | `cozy_home` | blueprint | 85% | "Build a cozy bubble home!" | `{ lavender: 20 }` |

`done` (completion) strings, kid-friendly, one per quest — authored in `strings.js`.
Difficulty curve: 3 → 5 → 3 → 1 → 5 → ~4-high → 6 → ~24-high → 20 → 39.

### standHeight note
`checkStand` only credits **player-placed** blocks, so any target Y forces real
stacking. `little_hill` Y must sit clearly above natural spawn terrain — use
`CFG.seaLevel + 5` and **verify in-game** it is neither auto-complete nor
unreachable; tune the `+5` if needed. `sky_tower` keeps Y = 24.

## Files touched

- **`config.js`** — `QUESTS` array (id/type/goal rows) + 10-entry `unlockBundles`
  (replacing the 4-entry map) + `questSaveVersion: 2`. Goal numbers live here so
  they are tunable as data.
- **`quests.js`** — refactor engine to iterate `CFG.QUESTS`, dispatch by `type`;
  add `onTreeGrown()` / `onJaspeaHug()`; generalize `standHeight`; rewrite
  `serialize`/`load` to the v2 schema. Keep all blueprint/ghost code as-is for the
  `blueprint` type.
- **`strings.js`** — 10 `quests.<id>` entries (name + done). Remove the old 4. Keep
  `questAllDone`.
- **`interact.js`** — 2 new hook calls: `quests.onTreeGrown()` after `_growTree`
  succeeds; `quests.onJaspeaHug()` in `_tapJaspea` where `jaspea.squeeze()` fires.
- **`main.js`** — no logic change expected (hooks already generic); verify the
  `grant`/`onProgress`/`onComplete` wiring still fits.

## Save migration

Current quest save: `{ active, flowers, bridge, tower, placed }`.
New schema: `{ v: 2, active, progress, placed: [...] }` — single `progress` int for
the active quest (blueprint re-derives from world; standHeight stores best-Y in
`progress`).

`load(data)`: if `data.v === 2`, restore. Otherwise (old 4-quest save or none),
**start the ladder fresh at level 1, progress 0** — this is the desired reset for
the grandson, who never finished the house. The world's blocks, the 999-stacks, and
inventory are stored separately in `save.js` and are **untouched** by this reset.

## Verification

1. **Engine unit drive (preview_eval):** build a `Quests` with a stub world/hooks;
   for each quest type feed the matching events and assert `activeQuest()` advances
   exactly at the goal and `onComplete` fires once. Confirm the full chain 1→10 and
   that completing 10 enters free-build.
2. **Save round-trip:** serialize mid-ladder, reload, confirm same active+progress;
   feed an old-schema `{active:0,flowers:2,...}` and confirm it resets to level 1.
3. **In-game smoke (live preview):** play levels 1–2 by hand (pinch 3, place 5),
   confirm the quest card updates and the reward toast/clay arrives; visually check
   `little_hill` requires stacking above the meadow.
4. Console clean, 60fps held.

## Out of scope

Hand-magic steering bug + gesture demo (still parked). No changes to world,
physics, inventory cap, or audio.

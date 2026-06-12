# Performance & tuning thresholds (fixed before code)

| Metric | Budget |
|---|---|
| Frame rate, desktop | ≥ 60 fps worst-case scene |
| Frame rate, iPhone (touch) | ≥ 50 fps |
| Frame rate, iPhone + camera gestures on | ≥ 30 fps |
| Sim step | fixed 60 Hz, logic frame-rate independent |
| Draw calls worst case | < 220 (one merged mesh per chunk; particles instanced) |
| Chunk remesh | ≤ 8 ms per chunk, ≤ 2 chunks per frame |
| Per-frame allocations in loop | 0 (pools + scratch vectors) |
| DPR cap | 1.5 |
| Initial payload to playable (excl. lazy gesture pack) | < 12 MB |
| Gesture pack (lazy, on opt-in only) | < 27 MB, never on critical path |
| Load → first interaction | < 5 s on home wifi |
| Hand-gesture inference | ≤ every other frame, 320×240 input |
| Audio true-peak | mix gains: music 0.22, sfx ≤ 0.8, ambient ≤ 0.5 (≤ −3 dBFS headroom) |
| Touch targets | ≥ 48 px |
| Save | auto every 5 s + on hide; resume < 1 s |

Input tolerance: tap-vs-drag threshold 12 px / 250 ms; raycast forgiveness: nearest face
within 0.15 of edge still counts; pinch gesture threshold 0.35 of hand-span with 80 ms
debounce both ways.

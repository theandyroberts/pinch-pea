#!/usr/bin/env python3
"""Pinchy Pea asset post-process:
- tiles: square-crop, downscale to 256 LANCZOS, seam-ratio check, offset-blend seam fix
  when ratio > 1.3, save to public/assets/tex/ + a 2x2 preview for eyeball inspection
- logo: chroma-key #00FF00 (distance-based, handles enclosed regions), despill, crop, save
- sky: downscale to 1280x720 jpg
- favicon: 256px png for the page icon
"""
import sys, json, pathlib
import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "raw_assets"
TEX = ROOT / "public" / "assets" / "tex"
ASSETS = ROOT / "public" / "assets"
PREVIEW = ROOT / "raw_assets" / "previews"
TEX.mkdir(parents=True, exist_ok=True)
PREVIEW.mkdir(parents=True, exist_ok=True)

TILES = ["tile_grass", "tile_terracotta", "tile_clay_plain", "tile_stone",
         "tile_wood", "tile_sand", "tile_leaf"]

def seam_ratio(a):
    a = a.astype(float)
    seam = abs(a[0] - a[-1]).mean() + abs(a[:, 0] - a[:, -1]).mean()
    base = abs(np.diff(a, axis=0)).mean() + abs(np.diff(a, axis=1)).mean()
    return round(float(seam / max(base, 1e-6)), 2)

def offset_blend_fix(a, feather=24):
    """Roll 50% so seams meet in the center, blend the cross with a feathered copy
    of the unrolled image, roll back. Guarantees identical opposite edges."""
    h, w, _ = a.shape
    rolled = np.roll(np.roll(a, h // 2, axis=0), w // 2, axis=1)
    # feathered cross mask centered on the (now central) seam lines
    yy = np.arange(h); xx = np.arange(w)
    dy = np.minimum(abs(yy - h // 2), feather) / feather
    dx = np.minimum(abs(xx - w // 2), feather) / feather
    m = 1 - np.minimum(dy[:, None], dx[None, :])           # 1 on seam, 0 away
    m = (m ** 1.5)[..., None]
    # patch: average of mirrored neighborhoods softens the discontinuity
    patch = (np.roll(rolled, feather, axis=0) + np.roll(rolled, -feather, axis=0) +
             np.roll(rolled, feather, axis=1) + np.roll(rolled, -feather, axis=1)) / 4
    blended = rolled * (1 - m) + patch * m
    out = np.roll(np.roll(blended, -(h // 2), axis=0), -(w // 2), axis=1)
    # enforce exact wrap: average opposite edges
    out[0], out[-1] = (out[0] + out[-1]) / 2, (out[0] + out[-1]) / 2
    out[:, 0], out[:, -1] = (out[:, 0] + out[:, -1]) / 2, (out[:, 0] + out[:, -1]) / 2
    return out

report = {}
for name in TILES:
    src = RAW / f"{name}.png"
    if not src.exists():
        report[name] = "MISSING"
        continue
    img = Image.open(src).convert("RGB")
    s = min(img.size)
    img = img.crop(((img.width - s) // 2, (img.height - s) // 2,
                    (img.width + s) // 2, (img.height + s) // 2))
    img = img.resize((256, 256), Image.LANCZOS)
    a = np.asarray(img).astype(float)
    r0 = seam_ratio(a)
    fixed = False
    if r0 > 1.3:
        a = offset_blend_fix(a)
        fixed = True
    r1 = seam_ratio(a)
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    out.save(TEX / f"{name}.png", optimize=True)
    tiled = Image.new("RGB", (512, 512))
    for oy in (0, 256):
        for ox in (0, 256):
            tiled.paste(out, (ox, oy))
    tiled.save(PREVIEW / f"{name}_2x2.png")
    report[name] = {"seam_before": r0, "seam_after": r1, "fixed": fixed}

# ---- logo keying ----
logo_src = RAW / "ui_logo_raw.png"
if logo_src.exists():
    img = np.asarray(Image.open(logo_src).convert("RGB")).astype(int)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    keydist = np.sqrt((r - 0) ** 2 + (g - 255) ** 2 + (b - 0) ** 2)
    alpha = np.clip((keydist - 60) / 120, 0, 1)          # 0 = pure key, 1 = subject
    # despill: pull green down toward max(r,b) where alpha is partial
    spill = (g > np.maximum(r, b) + 12) & (alpha < 0.99)
    g2 = np.where(spill, np.maximum(r, b), g)
    rgba = np.dstack([r, g2, b, (alpha * 255).astype(int)]).astype(np.uint8)
    # crop to content
    ys, xs = np.where(rgba[..., 3] > 16)
    if len(ys):
        pad = 12
        y0, y1 = max(0, ys.min() - pad), min(rgba.shape[0], ys.max() + pad)
        x0, x1 = max(0, xs.min() - pad), min(rgba.shape[1], xs.max() + pad)
        rgba = rgba[y0:y1, x0:x1]
    out = Image.fromarray(rgba, "RGBA")
    if out.width > 880:
        out = out.resize((880, int(out.height * 880 / out.width)), Image.LANCZOS)
    out.save(ASSETS / "ui_logo.png", optimize=True)
    report["ui_logo"] = {"size": out.size}

# ---- sky ----
sky_src = RAW / "bg_sky.png"
if sky_src.exists():
    img = Image.open(sky_src).convert("RGB").resize((1280, 720), Image.LANCZOS)
    img.save(ASSETS / "bg_sky.jpg", quality=85, optimize=True)
    report["bg_sky"] = "1280x720 jpg"

# ---- favicon (page icon) ----
fav_src = RAW / "favicon.png"
if fav_src.exists():
    Image.open(fav_src).convert("RGB").resize((256, 256), Image.LANCZOS) \
         .save(ASSETS / "favicon.png", optimize=True)
    report["favicon"] = "256 png"

print(json.dumps(report, indent=1))

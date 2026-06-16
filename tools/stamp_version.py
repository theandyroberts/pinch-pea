#!/usr/bin/env python3
"""Stamp a build version + cache-bust query into a staged copy of the game.

Usage: stamp_version.py <stage_dir> <build_token> <version_display>

- Writes <stage_dir>/game/version.js exporting the human-readable version_display.
- Appends ?v=<build_token> to every relative import of OUR source (.js files and the
  index.html module <script src>), so each deploy fetches fresh code. Chained ES
  module imports don't inherit a query, so EVERY import statement must be rewritten.
- Skips anything under vendor/ (three.js, MediaPipe): large and stable, re-downloading
  it every deploy would be wasteful — those URLs stay cacheable.

Only the staged copy is touched; the source tree stays clean (no ?v= committed).
"""
import json
import os
import re
import sys

stage, token, version_display = sys.argv[1], sys.argv[2], sys.argv[3]
query = "?v=" + token

# 1) version module the game imports for the on-screen label
with open(os.path.join(stage, "game", "version.js"), "w", encoding="utf-8") as f:
    f.write("export const VERSION = " + json.dumps(version_display) + ";\n")

# 2) cache-bust our own module graph
#    matches:  from "./x.js"   from '../x.js'   import("./x.js")
IMPORT_RE = re.compile(r"""((?:from|import\()\s*["'])(\.\.?/[^"']+\.js)(["'])""")


def bust_import(m):
    pre, path, post = m.group(1), m.group(2), m.group(3)
    if "vendor" in path or "?v=" in path:
        return m.group(0)
    return pre + path + query + post


SCRIPT_RE = re.compile(r"""(<script[^>]*\bsrc=")(\./game/main\.js)(")""")

changed = 0
for root, dirs, files in os.walk(stage):
    if "vendor" in root.split(os.sep):
        dirs[:] = []          # don't descend into vendor
        continue
    for fn in files:
        p = os.path.join(root, fn)
        if fn.endswith(".js"):
            src = open(p, encoding="utf-8").read()
            out = IMPORT_RE.sub(bust_import, src)
        elif fn == "index.html":
            src = open(p, encoding="utf-8").read()
            out = SCRIPT_RE.sub(lambda m: m.group(1) + m.group(2) + query + m.group(3), src)
        else:
            continue
        if out != src:
            open(p, "w", encoding="utf-8").write(out)
            changed += 1

print(f"stamped version={version_display!r} token={token} ({changed} files cache-busted)")

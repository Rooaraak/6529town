#!/usr/bin/env python3
"""Meme Town gallery: shrink the hand-cleared CC0 Meme Cards (first frame) to small WebP files + credits.
Cleared by eye 11-09 (no Pepe, no punks, no other third-party characters, no real person's face, not card #1).
usage: cards.py <dir with <id>.img originals>"""
import json, os, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
M = os.path.dirname(os.path.abspath(__file__)); SRC = sys.argv[1]
KEEP = [2, 3, 52, 85, 103, 150, 154, 345, 450, 470, 556, 570]
PRETTY = {"SeizeJPGs": "Seize JPGs", "UncleSeize": "Uncle Seize"}
meta = {c["id"]: c for c in json.load(open(f"{M}/assets/cards.json"))}
out = []
for n in KEEP:
    im = Image.open(f"{SRC}/{n}.img"); im.draft("RGB", (1200, 1200)); im.seek(0); im = im.convert("RGB")
    im.thumbnail((420, 420), Image.LANCZOS)
    p = f"{M}/assets/cards/{n}.webp"
    for q in (80, 72, 64, 56, 48, 40):
        im.save(p, "WEBP", quality=q, method=6)
        if os.path.getsize(p) <= 45_000: break
    name = PRETTY.get(meta[n]["name"], meta[n]["name"]).strip()
    out.append({"id": n, "name": name, "artist": meta[n]["artist"].strip(), "file": f"cards/{n}.webp", "w": im.width, "h": im.height})
    print(n, name, im.size, os.path.getsize(p))
json.dump(out, open(f"{M}/assets/cards-final.json", "w"), indent=1)
print("total", sum(os.path.getsize(f"{M}/assets/{c['file']}") for c in out))

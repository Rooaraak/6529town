#!/usr/bin/env python3
"""Meme Town build: land texture + house sites + day records + gallery cards -> one HTML page (the page loads
three.js and its fonts from the internet).

    python3 build.py            -> dist/meme-town.html and dist/site/ (+ prints size and a leak-gate verdict)

Inputs: src/page.html (placeholder /*__DATA__*/null), src/land-110m.json (world-atlas, ISC),
data/days.json (totals only, from parse-day.py), assets/cards-final.json + assets/cards/*.webp (cards.py).
"""
import base64, io, json, math, os, random, re, sys, time
from PIL import Image, ImageDraw, ImageFilter, ImageChops

M = os.path.dirname(os.path.abspath(__file__))
W, H = 2048, 1024
INK, RED_DEEP, CREAM, CREAM_2 = (23, 17, 14), (120, 22, 15), (239, 229, 207), (222, 207, 176)

# continent boxes (lat_min, lat_max, lon_min, lon_max) and hubs the towns grow out from (lat, lon)
BOXES = {
    "north_america": [(12, 62, -130, -52)],
    "south_america": [(-42, 10, -82, -34)],
    "europe": [(36, 66, -10, 34)],
    "asia": [(0, 56, 60, 146)],
    "oceania": [(-46, -10, 112, 179)],
    "africa": [(-35, 35, -18, 50)],
}
HUBS = {
    "north_america": [(40.7, -74.0), (37.7, -122.3), (41.9, -87.6), (43.7, -79.4), (30.3, -97.7), (25.8, -80.2), (47.6, -122.3), (19.4, -99.1)],
    "south_america": [(-23.5, -46.6), (-34.6, -58.4), (4.7, -74.1), (-12.0, -77.0), (-33.4, -70.6)],
    "europe": [(51.5, -0.1), (52.5, 13.4), (48.9, 2.3), (52.4, 4.9), (59.9, 10.7), (41.9, 12.5), (40.4, -3.7), (59.4, 24.7)],
    "asia": [(1.35, 103.8), (35.7, 139.7), (19.1, 72.9), (37.6, 127.0), (25.0, 121.5), (31.2, 121.5), (24.9, 67.0), (13.8, 100.5)],
    "oceania": [(-33.9, 151.2), (-37.8, 145.0), (-36.8, 174.8), (-31.9, 115.9), (-27.5, 153.0)],
    "africa": [(6.5, 3.4), (-1.3, 36.8), (-26.2, 28.0), (30.0, 31.2)],
}
SWISS = (46.8, 8.2)
# globe: validators that name only a continent are spread evenly over where people live in it (no city clusters);
# validators that name a country stand inside that country. Places inside a country/continent are picked for the picture.
INHABITED = {
    "north_america": [(16, 54, -124, -66)], "south_america": [(-40, 8, -80, -36)], "europe": [(36, 62, -9, 31)],
    "asia": [(-8, 46, 68, 142), (12, 42, 28, 60)], "oceania": [(-44, -12, 113, 178)], "africa": [(-34, 34, -17, 48)],
}
COUNTRY_GEO = {  # name as the validator page prints it: (lat, lon, radius in degrees that stays inside the country)
    "United States": (39.0, -97.0, 9), "Canada": (52.5, -104.0, 4), "Mexico": (23.0, -102.0, 3.5),
    "Brazil": (-11.0, -50.0, 7), "Argentina": (-34.0, -64.0, 3.5), "Chile": (-33.5, -70.8, 0.9), "Colombia": (4.6, -74.2, 2),
    "Peru": (-10.0, -75.5, 2.5), "Uruguay": (-32.8, -56.0, 1),
    "Germany": (51.0, 10.3, 2), "France": (46.7, 2.5, 2.4), "Italy": (42.6, 12.8, 1.2), "Spain": (40.2, -3.7, 2.3),
    "Portugal": (39.7, -8.1, 0.8), "Netherlands": (52.2, 5.6, 0.6), "Belgium": (50.6, 4.6, 0.45), "United Kingdom": (52.6, -1.5, 1.5),
    "Ireland": (53.2, -7.9, 0.9), "Norway": (61.3, 9.2, 1.6), "Sweden": (60.2, 15.2, 1.8), "Finland": (62.6, 26.0, 1.8),
    "Denmark": (56.0, 9.2, 0.6), "Estonia": (58.7, 25.4, 0.6), "Latvia": (56.9, 24.8, 0.7), "Lithuania": (55.3, 23.9, 0.7),
    "Poland": (52.0, 19.3, 1.9), "Czechia": (49.8, 15.4, 0.9), "Czech Republic": (49.8, 15.4, 0.9), "Austria": (47.5, 14.2, 0.8),
    "Switzerland": (46.8, 8.2, 0.5), "Slovenia": (46.1, 14.8, 0.3), "Croatia": (45.4, 16.2, 0.5), "Serbia": (44.0, 20.9, 0.8),
    "Hungary": (47.2, 19.4, 0.9), "Romania": (45.9, 24.9, 1.5), "Bulgaria": (42.7, 25.3, 0.9), "Greece": (39.4, 22.0, 0.9),
    "Ukraine": (49.0, 31.0, 2.4), "Luxembourg": (49.8, 6.1, 0.15), "Iceland": (64.9, -18.6, 1.1), "Slovakia": (48.7, 19.5, 0.6),
    "India": (22.5, 78.5, 5), "Pakistan": (29.5, 70.5, 2.6), "Singapore": (1.35, 103.82, 0.08), "Japan": (36.4, 138.4, 1.6),
    "South Korea": (36.4, 127.9, 0.8), "China": (33.0, 109.0, 6), "Hong Kong": (22.35, 114.15, 0.08), "Taiwan": (23.7, 121.0, 0.5),
    "Thailand": (15.6, 101.0, 1.8), "Vietnam": (16.4, 107.5, 0.8), "Indonesia": (-7.2, 110.2, 2), "Malaysia": (3.9, 102.2, 0.9),
    "Philippines": (12.6, 122.5, 1.6), "Turkey": (39.0, 35.0, 2.4), "Türkiye": (39.0, 35.0, 2.4), "Israel": (31.4, 35.0, 0.35),
    "United Arab Emirates": (24.0, 54.4, 0.5), "Saudi Arabia": (24.0, 45.0, 3.5),
    "Australia": (-27.0, 134.0, 8), "New Zealand": (-41.0, 174.0, 1.8),
    "Nigeria": (9.0, 8.0, 2.6), "South Africa": (-29.0, 25.0, 3), "Kenya": (0.4, 37.9, 1.8), "Egypt": (26.6, 30.6, 2.5), "Morocco": (32.0, -6.5, 1.8),
}


def spread(points, cap):
    """Order points so that every prefix is spread evenly (farthest-point sampling on the sphere), first point near the middle."""
    import numpy as np
    if not points:
        return []
    la, lo = np.radians([p[0] for p in points]), np.radians([p[1] for p in points])
    v = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1)
    c = v.mean(0); i = int(np.argmax(v @ c)); order = [i]; near = v @ v[i]
    for _ in range(min(cap, len(points)) - 1):
        near[order[-1]] = 2.0
        i = int(np.argmin(near)); order.append(i); near = np.maximum(near, v @ v[i])
    return [list(points[k]) for k in order]


def country_sites(mask, names, need):
    """Up to `need` evenly spread land points inside each named country (its middle when it is too small for the map)."""
    out = {}
    for name in names:
        g = COUNTRY_GEO.get(name)
        if not g:
            continue
        lat0, lon0, r = g; step = max(0.06, r / 5); pts = []
        for i in range(-int(r / step), int(r / step) + 1):
            for j in range(-int(r / step / max(0.2, math.cos(math.radians(lat0)))) - 1, int(r / step / max(0.2, math.cos(math.radians(lat0)))) + 2):
                p = (round(lat0 + i * step, 3), round(lon0 + j * step, 3))
                if math.degrees(gdist(p, (lat0, lon0))) <= r and is_land(mask, *p):
                    pts.append(p)
        out[name] = spread(pts, need) if pts else [[lat0, lon0]]
    return out


# TOWN_SRC / TOWN_DIST are for test builds only (a working copy can be built without touching the live files);
# never set them in config.env
SRC = os.environ.get("TOWN_SRC", "src")
DIST = os.environ.get("TOWN_DIST", "dist")
# The Main Stage posters (top 3 of the vote): stage.json is written at every run of daily.sh by stage_fetch.py, which runs as
# "nobody" in a sandbox (daily.sh). It is other people's data: stage() re-checks every field and never decodes a picture.
STAGE_FILE = os.environ.get("TOWN_STAGE", os.path.join(M, "stage", "stage.json"))
STAGE_URL = re.compile(r"^https://6529\.io/waves/[0-9a-f-]{36}\?drop=[0-9a-f-]{36}$")
LEAK_PATTERNS = [r"0x[0-9a-fA-F]{40}", r"0x[0-9a-fA-F]{8,}", r"0x[0-9a-fA-F]{4}…", r"12D3Koo", r"This PC",
                 r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", r"DESKTOP-"]
N_BUILTIN_PATTERNS = len(LEAK_PATTERNS)
# your own private words (your validator's key code, host name, nickname ...): leak-extra.txt next to this file,
# one regular expression per line (see leak-extra.example.txt)
if os.path.exists(os.path.join(M, "leak-extra.txt")):
    LEAK_PATTERNS += [l.strip() for l in open(os.path.join(M, "leak-extra.txt"), encoding="utf-8-sig") if l.strip() and not l.lstrip().startswith("#")]
RELAYS = [  # hand-kept from punk6529's relay announcement (11-08); not on the validator page
    {"name": "Virginia", "lat": 38.9, "lon": -77.4}, {"name": "Oregon", "lat": 45.6, "lon": -121.2},
    {"name": "São Paulo", "lat": -23.5, "lon": -46.6}, {"name": "Frankfurt", "lat": 50.1, "lon": 8.7},
    {"name": "Mumbai", "lat": 19.1, "lon": 72.9}, {"name": "Singapore", "lat": 1.35, "lon": 103.8},
    {"name": "Tokyo", "lat": 35.7, "lon": 139.7},
]


def land_mask():
    topo = json.load(open(f"{M}/src/land-110m.json"))
    sx, sy = topo["transform"]["scale"]; tx, ty = topo["transform"]["translate"]
    arcs = []
    for a in topo["arcs"]:
        x = y = 0; pts = []
        for dx, dy in a:
            x += dx; y += dy; pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(ids):
        out = []
        for i in ids:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            out += a if not out else a[1:]
        return out
    img = Image.new("L", (W, H), 0); dr = ImageDraw.Draw(img)
    for g in topo["objects"]["land"]["geometries"]:
        for poly in (g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]):
            for k, r in enumerate(poly):
                lons, prev = [], None
                for lon, lat in ring(r):  # unwrap across the date line, then draw at three offsets
                    if prev is not None:
                        while lon - prev > 180: lon -= 360
                        while lon - prev < -180: lon += 360
                    lons.append((lon, lat)); prev = lon
                if len(lons) > 2:
                    for sh in (-W, 0, W):
                        dr.polygon([((lon + 180) / 360 * W + sh, (90 - lat) / 180 * H) for lon, lat in lons], fill=255 if k == 0 else 0)
    return img


def land_rings():
    """Land outlines as flat [lon, lat, ...] rings, unwrapped across the date line, for the page to draw itself."""
    topo = json.load(open(f"{M}/src/land-110m.json"))
    sx, sy = topo["transform"]["scale"]; tx, ty = topo["transform"]["translate"]
    arcs = []
    for a in topo["arcs"]:
        x = y = 0; pts = []
        for dx, dy in a:
            x += dx; y += dy; pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    out = []
    for g in topo["objects"]["land"]["geometries"]:
        for poly in (g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]):
            for r in poly:
                pts = []
                for i in r:
                    a = arcs[i] if i >= 0 else arcs[~i][::-1]
                    pts += a if not pts else a[1:]
                flat, prev = [], None
                for lon, lat in pts:
                    if prev is not None:
                        while lon - prev > 180: lon -= 360
                        while lon - prev < -180: lon += 360
                    flat += [round(lon, 2), round(lat, 2)]; prev = lon
                if len(flat) >= 6:
                    out.append(flat)
    return out


def grow(mask, px):
    return mask.filter(ImageFilter.MaxFilter(px * 2 + 1)) if px > 0 else mask


def land_texture(mask):
    """Poster-print map: ink ocean with a faint red graticule and halftone, coast ripple lines, cream land with an inner shade."""
    img = Image.new("RGB", (W, H), INK); dr = ImageDraw.Draw(img)
    for i in range(0, H, 6):  # halftone: dots bigger toward the poles, like an old print
        lat = 90 - (i + 3) / H * 180
        rad = 0.7 + 0.9 * abs(lat) / 90
        for j in range(3 if (i // 6) % 2 else 0, W, 6):
            dr.ellipse((j - rad, i + 3 - rad, j + rad, i + 3 + rad), fill=(44, 20, 16))
    for lon in range(-180, 181, 15):
        x = (lon + 180) / 360 * W; dr.line((x, 0, x, H), fill=(70, 22, 16), width=1)
    for lat in range(-75, 76, 15):
        y = (90 - lat) / 180 * H; dr.line((0, y, W, y), fill=(70, 22, 16), width=1)
    for off, col in ((16, (62, 20, 15)), (9, (118, 28, 19))):  # coast ripples, like an old sea chart
        ringm = ImageChops.subtract(grow(mask, off), grow(mask, off - 2)).filter(ImageFilter.GaussianBlur(0.6))
        img.paste(Image.new("RGB", (W, H), col), (0, 0), ringm)
    img.paste(Image.new("RGB", (W, H), INK), (0, 0), grow(mask, 3))  # ink coastline
    img.paste(Image.new("RGB", (W, H), CREAM_2), (0, 0), mask)
    inner = mask.filter(ImageFilter.MinFilter(9))
    img.paste(Image.new("RGB", (W, H), CREAM), (0, 0), inner)
    noise = Image.effect_noise((W, H), 18).convert("L")
    img = Image.composite(ImageChops.multiply(img, Image.merge("RGB", [noise.point(lambda v: 225 + v // 9)] * 3)), img, mask)
    buf = io.BytesIO(); img.save(buf, "WEBP", quality=84, method=6)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def is_land(mask, lat, lon):
    x = int((lon + 180) / 360 * (W - 1)); y = int((90 - lat) / 180 * (H - 1))
    return mask.getpixel((x, y)) > 128


def gdist(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return math.acos(max(-1, min(1, math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(lo1 - lo2))))


def house_sites(mask, n_sphere=26000, cap=1200):
    """Fibonacci-sphere points on land inside each continent box, ordered so towns grow outward from their hubs."""
    inner = mask.filter(ImageFilter.MinFilter(5))  # keep houses off the coastline
    ga = math.pi * (3 - math.sqrt(5)); pts = []
    for i in range(n_sphere):
        yv = 1 - (i + 0.5) / n_sphere * 2; r = math.sqrt(1 - yv * yv); th = ga * i
        lat = math.degrees(math.asin(yv)); lon = math.degrees(math.atan2(math.sin(th) * r, math.cos(th) * r))
        if is_land(inner, lat, lon):
            pts.append((round(lat, 2), round(lon, 2)))
    sites = {}
    for c, boxes in INHABITED.items():
        cand = [p for p in pts if any(b[0] <= p[0] <= b[1] and b[2] <= p[1] <= b[3] for b in boxes)]
        sites[c] = spread(cand, cap)
    return sites


CIDX = {"north_america": 1, "europe": 2, "asia": 3, "south_america": 4, "oceania": 5, "africa": 6, "private": 7, None: 7}


def homes(days):
    """Public, wallet-free house list from the private registry (residents.py). One house per validator, in the order
    they arrived (wallet by wallet), per day one byte per house: 0 = not taking part, else continent 1-7, +8 if signed,
    +16 if in a data center. A wallet appears only as a SHA-256 fingerprint with a fixed public prefix (find-your-house),
    and its TDH is XOR-locked with a key made from the same wallet. That keeps addresses out of the page, but it is
    not a secret: anyone who already has a list of wallet addresses can hash them and see which ones have a house."""
    import hashlib, residents
    reg = residents.build()
    vals, wallets = reg["validators"], reg["wallets"]
    cds = [d["cycle_day"] for d in days]
    def first(v): return min(int(k) for k in v["days"])
    def wkey(w): return hashlib.sha256(("6529town-order:" + w).encode()).hexdigest()
    order = sorted(vals.items(), key=lambda kv: (first(kv[1]), wkey(kv[1]["wallet"]), kv[0]))
    gidx, groups, lst = {}, [], []
    for code, v in order:
        w = v["wallet"]
        if w not in gidx:
            gidx[w] = len(groups)
            full = bool(re.fullmatch(r"0x[0-9a-f]{40}", w))
            fp = hashlib.sha256(("6529town:" + w).encode()).hexdigest()[:16] if full else ""
            tdh = (wallets.get(w) or {}).get("tdh") or 0
            key = hashlib.sha256(("6529town-tdh:" + w).encode()).digest()[:6] if full else b"\0" * 6
            lock = (int(tdh) ^ int.from_bytes(key, "big")).to_bytes(6, "big").hex() if full else ""
            groups.append([fp, lock, 0])
        g = gidx[w]; groups[g][2] += 1
        fd = first(v); fi = next((i for i, c in enumerate(cds) if c >= fd), len(cds) - 1)
        lst.append([fi, 1 if any(x[2] for x in v["days"].values()) else 0, g])
    per_day = []
    for d in days:
        cd, b = d["cycle_day"], bytearray(len(order))
        if d.get("old_chain"):
            # no per-validator record for these days: the first N houses (inner rings) stand in for that day's N validators,
            # place not recorded, signed. Their real first day (list[i][0]) stays Sun 8 Nov or later.
            for i in range(min(len(order), int(d.get("validators") or 0))):
                b[i] = 7 | 8
        for i, (code, v) in enumerate(order):
            x = v["days"].get(str(cd))
            if x:
                b[i] = CIDX.get(x[0], 7) | (8 if x[1] else 0) | (16 if x[2] else 0)
        per_day.append(base64.b64encode(bytes(b)).decode())
    # per-day plain counts for the "where they are" section: places not shown (chosen vs not reported yet), versions
    stats = []
    for cd in cds:
        xs = [v["days"].get(str(cd)) for v in vals.values()]; xs = [x for x in xs if x]
        ver = {}
        for x in xs:
            k = x[3] if len(x) > 3 and x[3] else "not reported"; ver[k] = ver.get(k, 0) + 1
        order_v = sorted((k for k in ver if k != "not reported"), key=lambda k: -int(k.split(".")[1])) + (["not reported"] if "not reported" in ver else [])
        stats.append({"noplace": sum(1 for x in xs if x[0] == "private"), "noreport": sum(1 for x in xs if x[0] is None),
                      "versions": [[k, ver[k]] for k in order_v]} if xs else None)
    globe = []
    for d in days:
        if d.get("old_chain"):
            globe.append({"c": [], "k": {}, "o": int(d.get("validators") or 0)}); continue
        xs = [v["days"].get(str(d["cycle_day"])) for v in vals.values()]; xs = [x for x in xs if x]
        k, o = {}, 0
        for x in xs:
            if len(x) > 4 and x[4]:
                continue  # stands in its country (the page's "Countries named" counts)
            if x[0] in CIDX and x[0] not in ("private", None):
                k[x[0]] = k.get(x[0], 0) + 1
            else:
                o += 1
        globe.append({"c": d.get("countries") or [], "k": k, "o": o, "named": sum(1 for x in xs if len(x) > 4 and x[4])})
    secrets = [code for code in vals] + [v["wallet"] for v in vals.values()]
    return {"list": lst, "groups": groups, "days": per_day, "stats": stats, "globe": globe}, secrets


def releases():
    """[[short version, release date], ...] newest first, from the newest capture's release list (versions + dates only)."""
    import glob
    for f in sorted(glob.glob(f"{M}/raw/2*/api.json"), reverse=True):
        try:
            rel = json.load(open(f)).get("/api/v1/releases") or {}
        except Exception:
            continue
        out = [[x["version"].split("-")[-1], x.get("date")] for x in rel.get("releases", []) if re.fullmatch(r"\d+\.\d+\.\d+-rc\.\d+", x.get("version") or "")]
        if out:
            return out
    return []


def build():
    days = json.load(open(f"{M}/data/days.json"))
    # the network's old chain (Wed 4 - Sat 7 Nov): only totals survived the restart on Sun 8 Nov (data/days-old-chain.json)
    old = [dict(d) for d in json.load(open(f"{M}/data/days-old-chain.json"))]
    for d in old:
        d.pop("source", None)
    have = {d["cycle_day"] for d in days}
    days = sorted([d for d in old if d["cycle_day"] not in have] + days, key=lambda d: d["cycle_day"])
    cards = json.load(open(f"{M}/assets/cards-final.json"))
    for c in cards:
        c["src"] = "data:image/webp;base64," + base64.b64encode(open(f"{M}/assets/{c['file']}", "rb").read()).decode()
        del c["file"]
    home, secrets = homes(days)
    data = {"days": days, "cards": cards, "relays": RELAYS, "homes": home, "releases": releases()}
    page = open(f"{M}/{SRC}/page.html").read()
    assert "/*__DATA__*/null" in page and "/*__TOWN__*/" in page
    sites = {}
    if "/*__GLOBE__*/" in page:  # only a page with the globe (tab removed 11-09) needs the land map and the house spots
        mask = land_mask(); sites = house_sites(mask)
        names = sorted({c[0] for d in days for c in (d.get("countries") or [])})
        need = max([c[1] for d in days for c in (d.get("countries") or [])] + [1]) + 6
        data.update({"sites": sites, "csites": country_sites(mask, names, need), "swiss": SWISS, "land": land_rings()})
        page = page.replace("/*__GLOBE__*/", open(f"{M}/{SRC}/globe.js").read())
    page = page.replace("/*__TOWN__*/", open(f"{M}/{SRC}/town.js").read())
    if "/*__STAGE__*/null" in page:  # the town of 11-10 has the Main Stage posters; an older page has no such mark
        assert page.count("/*__STAGE__*/null") == 1
        page = page.replace("/*__STAGE__*/null", stage(secrets))
    # "<" is written as its unicode escape so that no text in the data can close the script block of the page (same data)
    html = page.replace("/*__DATA__*/null",
                        json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"))
    leak = check(html, days, sites)
    text_only = re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]+", "", html)
    for x in secrets:  # no validator code and no wallet (full or short) may appear anywhere in the page
        if x and x.lower() in text_only.lower():
            leak.append("registry value in page: " + x[:4] + "…")
    os.makedirs(f"{M}/{DIST}", exist_ok=True)
    out = f"{M}/{DIST}/meme-town.html"
    open(out + ".tmp", "w").write(html); os.replace(out + ".tmp", out)
    # the public website needs its own document head (claude.ai adds one for the artifact): charset, phone sizing,
    # link-preview tags for X/Discord/6529 chats, a favicon
    last = days[-1]
    desc = (f"An imaginary town that grows with the 6529 validator network: {last['validators']} validators on {last['label']}, "
            "one house each. Unofficial community project, not made by 6529.")
    fav = ("data:image/svg+xml," + "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M3 15 16 4l13 11z' fill='%23c8291e'/%3E"
           "%3Crect x='6' y='15' width='20' height='14' fill='%23efe5cf'/%3E%3Crect x='13' y='18' width='6' height='6' fill='%23ffcf6b'/%3E%3C/svg%3E")
    head = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f'<meta name="description" content="{desc}">\n<meta name="theme-color" content="#000000">\n'
            '<meta property="og:type" content="website">\n<meta property="og:title" content="6529 Town">\n'
            f'<meta property="og:description" content="{desc}">\n<meta property="og:image" content="https://6529town.com/og.jpg">\n'
            '<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="6529 Town">\n'
            f'<meta name="twitter:description" content="{desc}">\n<meta name="twitter:image" content="https://6529town.com/og.jpg">\n'
            f'<link rel="icon" href="{fav}">\n</head>\n<body>\n')
    body = re.sub(r'^<title>6529 Town</title>\n<meta name="description"[^>]*>\n', "<title>6529 Town</title>\n", html, count=1)
    body = body.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', "")  # artifact-only tag
    os.makedirs(f"{M}/{DIST}/site", exist_ok=True)
    site = head.replace("</head>", "") .replace("<body>\n", "") + body.split("\n", 1)[0] + "\n</head>\n<body>\n" + body.split("\n", 1)[1] + "\n</body>\n</html>\n"
    open(f"{M}/{DIST}/site/index.html.tmp", "w").write(site); os.replace(f"{M}/{DIST}/site/index.html.tmp", f"{M}/{DIST}/site/index.html")
    if 'id="s-fresh"' in page:  # the town of step 14: a tab left open asks v.json for the newest reading; unknown addresses get a real "not found" page
        newest = max((d.get("captured") or "" for d in days), default="")
        open(f"{M}/{DIST}/site/v.json.tmp", "w").write(json.dumps({"captured": newest})); os.replace(f"{M}/{DIST}/site/v.json.tmp", f"{M}/{DIST}/site/v.json")
        if os.path.exists(f"{M}/{SRC}/404.html"):
            nf = open(f"{M}/{SRC}/404.html").read()
            if any(re.search(pat, nf, re.I) for pat in LEAK_PATTERNS) or any(x and x.lower() in nf.lower() for x in secrets):
                leak.append("404.html trips the privacy check")
            else:
                open(f"{M}/{DIST}/site/404.html", "w").write(nf)
    # a design without them (the one before step 14, or a rollback) must not keep uploading an old copy of these two files
    for name, wanted in (("v.json", 'id="s-fresh"' in page), ("404.html", 'id="s-fresh"' in page and os.path.exists(f"{M}/{SRC}/404.html"))):
        if not wanted and os.path.isfile(f"{M}/{DIST}/site/{name}"):
            os.remove(f"{M}/{DIST}/site/{name}")
    return out, len(html.encode()), leak, {k: len(v) for k, v in sites.items()}


def stage(secrets=()):
    """The Main Stage posters as JavaScript source; "null" = no posters (the town then simply has none).
    Anything odd in stage.json turns the posters off; it never stops the site from being published."""
    try:
        if os.path.getsize(STAGE_FILE) > 2_000_000:
            raise ValueError("file too large")
        raw = json.load(open(STAGE_FILE))
        asof = raw["asof"]
        if type(asof) is not int or not -600 < time.time() - asof / 1000 < 12 * 3600:
            raise ValueError("the ranking is too old (or has no time)")
        items = []
        for it in raw["items"]:
            url, img = it["url"], it["img"]
            if not (isinstance(url, str) and STAGE_URL.match(url)):
                raise ValueError("link")
            if not (isinstance(img, str) and len(img) < 400_000 and img.startswith("data:image/jpeg;base64,")
                    and re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", img[23:])):
                raise ValueError("picture")
            b = base64.b64decode(img[23:], validate=True)
            if b[:3] != b"\xff\xd8\xff" or b[-2:] != b"\xff\xd9":
                raise ValueError("picture is not a JPEG")
            for key in ("title", "artist"):
                v = it[key]
                if not (isinstance(v, str) and 0 < len(v) <= 60) or re.search(r"[<>\x00-\x1f\x7f]|/\*|\*/|0x[0-9a-fA-F]{8,}", v):
                    raise ValueError(key)
            for key in ("rank", "proj", "voters"):
                if type(it[key]) is not int or not 0 <= it[key] < 10 ** 15:
                    raise ValueError(key)
            items.append({"rank": it["rank"], "title": it["title"], "artist": it["artist"], "proj": it["proj"],
                          "voters": it["voters"], "url": url, "img": img})
        if [i["rank"] for i in items] != [1, 2, 3]:
            raise ValueError("ranks")
        js = json.dumps({"asof": asof, "items": items}, ensure_ascii=True).replace("</", "<\\/")
        text = re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]+", "", js)
        if "/*" in text or any(re.search(pat, text, re.I) for pat in LEAK_PATTERNS):
            raise ValueError("a title or link looks like something the privacy check refuses")
        if any(x and x.lower() in text.lower() for x in secrets):
            raise ValueError("a title or link contains a registry value")
        print("main stage posters:", " | ".join("#%d %s" % (i["rank"], i["title"]) for i in items))
        return js
    except Exception as e:
        print("main stage posters OFF:", type(e).__name__, str(e)[:80])
        return "null"


def check(html, days, sites):
    """Leak gate + capacity. Returns a list of problems (empty = fine)."""
    bad = []
    text_only = re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]+", "", html)
    for i, pat in enumerate(LEAK_PATTERNS):
        if re.search(pat, text_only, re.I):   # your own words are never printed, only their place in leak-extra.txt
            bad.append("leak pattern " + (pat if i < N_BUILTIN_PATTERNS else "from leak-extra.txt (entry %d, not shown)" % (i - N_BUILTIN_PATTERNS + 1)))
    for d in days:
        for c, n in (d.get("continents") or {}).items():
            if sites and c != "not_reported" and n > len(sites.get(c, [])):
                bad.append(f"not enough sites for {c}: {n}")
    if len(html.encode()) > 3_000_000:
        bad.append("page over 3 MB")
    return bad


if __name__ == "__main__":
    out, size, leak, ns = build()
    print(out, f"{size/1024:.0f} KB", "sites", ns)
    print("CHECK OK" if not leak else "CHECK FAILED: " + "; ".join(leak))
    if leak:  # a page that failed the check must not stay where the upload script would find it
        for f in (out, f"{M}/{DIST}/site/index.html"):
            if os.path.exists(f):
                os.replace(f, f"{M}/{DIST}/failed-" + os.path.basename(f))
    sys.exit(1 if leak else 0)

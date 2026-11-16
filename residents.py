#!/usr/bin/env python3
"""6529 Town residents registry (PRIVATE, stays on your own machine: data/residents.json is never published).

One entry per validator (its 8-hex code), with its wallet and, per day, whether it took part, whether it signed, and the
continent / data-center flag that the validator page itself counted that day (a report from that same day, which makes
the per-house numbers add up exactly to the page's totals). Rebuilt from scratch from:
  - raw/day1-network-text-*.txt  (Sun 8 Nov, the only day captured as page text)
  - raw/<stamp>/api.json          (every later day: the reading that data/days.json names for it, else the newest)
build.py turns this into the public, wallet-free house list.  usage: residents.py  (writes data/residents.json)
"""
import glob, json, os, re
from datetime import datetime, timezone

M = os.path.dirname(os.path.abspath(__file__))
CONT = {"NORTH_AMERICA": "north_america", "EUROPE": "europe", "ASIA": "asia", "SOUTH_AMERICA": "south_america",
        "OCEANIA": "oceania", "AFRICA": "africa"}
TEXT_CONT = {"North America": "north_america", "Europe": "europe", "Asia": "asia", "South America": "south_america",
             "Oceania": "oceania", "Africa": "africa"}
COUNTRY = {  # country names the validator page prints -> continent
    "United States": "north_america", "Canada": "north_america", "Mexico": "north_america",
    "Brazil": "south_america", "Argentina": "south_america", "Chile": "south_america", "Colombia": "south_america", "Peru": "south_america", "Uruguay": "south_america",
    "Germany": "europe", "France": "europe", "Italy": "europe", "Spain": "europe", "Portugal": "europe", "Netherlands": "europe", "Belgium": "europe",
    "United Kingdom": "europe", "Ireland": "europe", "Norway": "europe", "Sweden": "europe", "Finland": "europe", "Denmark": "europe", "Estonia": "europe",
    "Latvia": "europe", "Lithuania": "europe", "Poland": "europe", "Czechia": "europe", "Austria": "europe", "Switzerland": "europe", "Slovenia": "europe",
    "Croatia": "europe", "Serbia": "europe", "Hungary": "europe", "Romania": "europe", "Bulgaria": "europe", "Greece": "europe", "Ukraine": "europe",
    "Luxembourg": "europe", "Iceland": "europe", "Slovakia": "europe",
    "India": "asia", "Pakistan": "asia", "Singapore": "asia", "Japan": "asia", "South Korea": "asia", "China": "asia", "Hong Kong": "asia", "Taiwan": "asia",
    "Thailand": "asia", "Vietnam": "asia", "Indonesia": "asia", "Malaysia": "asia", "Philippines": "asia", "Turkey": "asia", "Israel": "asia",
    "United Arab Emirates": "asia", "Saudi Arabia": "asia",
    "Australia": "oceania", "New Zealand": "oceania",
    "Nigeria": "africa", "South Africa": "africa", "Kenya": "africa", "Egypt": "africa", "Morocco": "africa",
}
DAY1 = 20765  # Sun 8 Nov, the network's first day


def day1(reg):
    files = sorted(glob.glob(f"{M}/raw/day1-network-text-*.txt"))
    if not files:
        return
    lines = [l.strip() for l in open(files[-1]).read().replace(" ", " ").split("\n")]
    wallet = None
    for i, l in enumerate(lines):
        if re.fullmatch(r"0x[0-9a-f]{4}…[0-9a-f]{4}", l):
            wallet = l
        if re.fullmatch(r"[0-9a-f]{8}", l) and wallet:
            place, status = lines[i - 1], lines[i + 5] if i + 5 < len(lines) else ""
            cont, dc = None, place.startswith("Data center")   # None = no report that day
            sw = (re.search(r"rc\.\d+", place) or [None])[0]
            if place != "Place not known yet":
                cont = "private"   # it reported, but without a place, unless a place follows
            place = re.sub(r" This PC(?= rc\.\d+$)", "", place)  # the capturing validator marks its own row
            m = re.match(r"(?:(?:Home|Data center)(?: · (.+?))?|(.+?)) rc\.\d+$", place)  # "Home · Europe rc.10", "United States rc.10"
            where = m and m.group(1)
            if where:
                cont = TEXT_CONT.get(where) or COUNTRY.get(where) or "private"
            # a bare country with no kind of place ("United States rc.10") is a report without a continent: the page
            # counts it under "Not reported" (Sun 8 Nov: North America 47, not 48)
            country = where if where in COUNTRY else (m.group(2) if m and m.group(2) in COUNTRY else None)  # "Home · Brazil", bare "United States"
            v = reg.setdefault(l, {"wallet": wallet, "days": {}})
            v["days"][str(DAY1)] = [cont, status.startswith("Signed"), dc, sw, country]


def captures(reg, wallets):
    # a day's houses come from the same reading as that day's numbers: the folder its record in data/days.json names
    # ("captured"). Only when that folder is gone, or the day has no record, the newest reading of the day is used.
    named = {}
    try:
        for rec in json.load(open(f"{M}/data/days.json")):
            if rec.get("captured"):
                named[rec["cycle_day"]] = os.path.join(M, "raw", rec["captured"], "api.json")
    except Exception:
        pass
    last = {}
    for f in sorted(glob.glob(f"{M}/raw/2*/api.json")):
        try:
            net = json.load(open(f))["/api/v1/network"]
        except Exception:
            continue
        cd = net["cycle_day"]
        if cd in last and last[cd][0] == named.get(cd):
            continue  # the day's own reading is in already; a later one does not replace it
        last[cd] = (f, net)
    for cd, (f, net) in sorted(last.items()):
        for acc in (net.get("members") or {}).get("accounts", []):
            w = acc["wallet"].lower()
            wallets[w] = {"tdh": acc.get("tdh")}
            for mch in acc.get("machines", []):
                rep = mch.get("report") or {}
                counted = bool(rep)  # like the Network page: each validator's newest daily report, from any day
                cont = (CONT.get(rep.get("continent")) or "private") if counted else None  # "private" = report without a place, None = no report yet
                dc = counted and rep.get("infrastructure") == "rack"
                sw = (re.search(r"rc\.\d+", rep.get("software") or "") or [None])[0] if counted else None
                v = reg.setdefault(mch["code"], {"wallet": w, "days": {}})
                v["wallet"] = w  # a full address replaces Sunday's short one
                v["days"][str(cd)] = [cont, mch.get("today") == "SIGNED", dc, sw, (rep.get("country") or None) if counted else None]


def build():
    reg, wallets = {}, {}
    day1(reg)
    captures(reg, wallets)
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "validators": reg, "wallets": wallets}
    tmp = f"{M}/data/residents.json.tmp"
    with open(tmp, "w") as fh:
        json.dump(out, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, f"{M}/data/residents.json")
    return out


if __name__ == "__main__":
    o = build()
    days = {}
    for v in o["validators"].values():
        for d, (c, s, dc, sw, *_) in v["days"].items():
            x = days.setdefault(d, {"n": 0, "signed": 0, "cont": {}})
            x["n"] += 1; x["signed"] += s; x["cont"][c] = x["cont"].get(c, 0) + 1
    for d in sorted(days):
        print(d, days[d]["n"], "validators,", days[d]["signed"], "signed,", dict(sorted(days[d]["cont"].items(), key=lambda kv: str(kv[0]))))
    print(len(o["validators"]), "validators ever,", len(o["wallets"]), "wallets with a full address")

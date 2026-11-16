#!/usr/bin/env python3
"""Meme Town: turn one read-only capture (raw/<stamp>/) into a TOTALS-ONLY day record in data/days.json.

Kept per day: counts of validators/accounts, signed share of counted TDH, keys ready for tomorrow, validators per
continent / kind of place, the countries line exactly as the validator's Network page prints it, release shares,
the day's result name, when 2/3 was reached. Never kept: wallets, key ids, codes, peer ids, IPs, per-validator rows,
anything that marks the operator's own validator. usage: parse-day.py <capture dir>
"""
import json, os, re, sys
from datetime import datetime, timezone

M = os.path.dirname(os.path.abspath(__file__))
OUT = f"{M}/data/days.json"
CONT = {"NorthAmerica": "north_america", "Europe": "europe", "Asia": "asia", "SouthAmerica": "south_america",
        "Oceania": "oceania", "Africa": "africa", "Antarctica": "antarctica"}


def day_label(cd):
    d = datetime.fromtimestamp(cd * 86400, timezone.utc)
    return d.strftime("%Y-%m-%d"), d.strftime("%a ") + str(d.day) + d.strftime(" %b")


def countries_line(txt):
    m = re.search(r"Countries named: (.+?)\.\s*$", txt, re.M)
    if not m:
        return countries_block(txt)
    out = []
    for part in m.group(1).split(", "):
        mm = re.fullmatch(r"(.+?) \((\d+)\)", part.strip())
        out.append([mm.group(1), int(mm.group(2))] if mm else [part.strip(), 1])
    return out


def countries_block(txt):
    # validator rc.18 and later print a "Country" block instead: "<n> of <m> named a country." and then
    # country / count, one per line (the full list only after its read-only "Show all N countries" toggle is opened).
    # Kept in the page's own order. Nothing is returned unless every line is read and the counts add up to <n>
    # (so a list that was not opened is never taken for the whole list; the number check then stops the run).
    m = re.search(r"^Country\n+(\d+) of \d+ named a country\.\n(.*?)^Each bar is out of all", txt, re.M | re.S)
    if not m:
        return []
    lines = [x.strip() for x in m.group(2).split("\n") if x.strip()]
    if lines and re.fullmatch(r"Show the first \d+", lines[-1]):
        lines.pop()
    got = re.findall(r"^(\D[^\n]*)\n(\d+)$", "\n".join(lines), re.M)
    if 2 * len(got) != len(lines) or sum(int(b) for _, b in got) != int(m.group(1)):
        return []
    return [[a, int(b)] for a, b in got]


def versions_line(txt):
    # the page writes a share below 1 % as "rc.11 under 1%": kept as 0
    one = r"(?:rc\.\d+|not reported) (?:\d+|under 1)%"
    m = re.search(r"^(" + one + r"(?: · " + one + r")*)\s*$", txt, re.M)
    if m:
        return [[a, 0 if b == "under 1" else int(b)] for a, b in re.findall(r"(rc\.\d+|not reported) (\d+|under 1)%", m.group(1))]
    # validator rc.15 and later print a "What they run" block instead: release / share / "<n> validators", one per line.
    # Kept in the page's own order. If any release line in the block is not read, nothing is returned (the number check then stops the run).
    m = re.search(r"^What they run\n(.*?)^From each validator's latest daily report", txt, re.M | re.S)
    if not m:
        return versions_block(txt)
    got = re.findall(r"^(rc\.\d+|Not reported)\n(\d+|under 1)%\n\d+ validators?$", m.group(1), re.M)
    if len(got) != len(re.findall(r"^(?:rc\.\d+|Not reported)$", m.group(1), re.M)):
        return []
    return [["not reported" if a == "Not reported" else a, 0 if b == "under 1" else int(b)] for a, b in got]


def versions_block(txt):
    # validator rc.18 and later print a "Validators by version" block instead, five lines per release:
    # release (may carry a note such as "below minimum") / share ("<1%" is kept as 0) / "of the TDH" / count / "validators".
    # Kept in the page's own order. If any release line in the block is not read, nothing is returned.
    m = re.search(r"^Validators by version\n(.*?)^Validators by location$", txt, re.M | re.S)
    if not m:
        return []
    got = re.findall(r"^(rc\.\d+|Not reported)(?: [A-Za-z][A-Za-z ]*)?\n+(\d+|<1)%\n+of the TDH\n+\d+\n+validators?$", m.group(1), re.M)
    if len(got) != len(re.findall(r"^(?:rc\.\d+|Not reported)(?: [^\n]*)?$", m.group(1), re.M)):
        return []
    return [["not reported" if a == "Not reported" else a, 0 if b == "<1" else int(b)] for a, b in got]


def version_counts(txt):
    # the same "Validators by version" block, for the town's "What they run" card: how many validators run each release,
    # with the page's note after the release name ("below minimum") or "". [[release, validators, note], ...] in the
    # page's order. None when the block is not there or any release line in it is not read.
    m = re.search(r"^Validators by version\n(.*?)^Validators by location$", txt, re.M | re.S)
    if not m:
        return None
    got = re.findall(r"^(rc\.\d+|Not reported)(?: ([A-Za-z][A-Za-z ]*))?\n+(?:\d+|<1)%\n+of the TDH\n+(\d+)\n+validators?$", m.group(1), re.M)
    if not got or len(got) != len(re.findall(r"^(?:rc\.\d+|Not reported)(?: [^\n]*)?$", m.group(1), re.M)):
        return None
    return [["not reported" if a == "Not reported" else a, int(n), note.strip()] for a, note, n in got]


def chain_tile(txt):
    # the "6529 chain" tile: "<x>%" / "Slots with a block" / "Final block <n> min behind" (may end ", usually <m>").
    # {"slots_pct": x, "final_lag_min": n}; n is None when that line reads differently (e.g. no final block for a while).
    # None when the tile is not there exactly once or its first two lines read differently.
    ls = [x.strip() for x in txt.split("\n") if x.strip()]
    at = [k for k, x in enumerate(ls) if x == "6529 chain"]
    if len(at) != 1 or at[0] + 2 >= len(ls):
        return None
    k = at[0]
    pct = re.fullmatch(r"(\d+(?:\.\d+)?)%", ls[k + 1])
    if not pct or ls[k + 2] != "Slots with a block":
        return None
    lag = re.fullmatch(r"Final block (\d+) min behind(?:, usually \d+)?", ls[k + 3]) if k + 3 < len(ls) else None
    return {"slots_pct": float(pct.group(1)), "final_lag_min": int(lag.group(1)) if lag else None}


def nickname(history_txt, label):
    # History page: "<Mon 9 Nov>\nSigned Open Meadow. ..." / Today page after final: "<label> · Final · Open Meadow"
    m = re.search(re.escape(label) + r"\n(?:Signed|Final|Agreed)[^\n]*?\b([A-Z][a-z]+ [A-Z][a-z]+)\b", history_txt)
    if m and m.group(1) not in ("Its certificate",):
        return m.group(1)
    m = re.search(re.escape(label) + r" · (?:Final|Agreed) · ([A-Z][a-z]+ [A-Z][a-z]+)", history_txt)
    return m.group(1) if m else None


def today_name(today_txt, label):
    """Today page: once a day is final the History line stops naming it, but the Today page (dated that day) still shows
    "Today's result" with the name under it."""
    if not re.search(r"^" + re.escape(label) + r"$", today_txt, re.M):
        return None
    m = re.search(r"Today's result\n+([A-Z][a-z]+ [A-Z][a-z]+)\n", today_txt)
    return m.group(1) if m else None


def build(cap):
    api = json.load(open(f"{cap}/api.json"))
    net = api["/api/v1/network"]
    nb = lambda t: t.replace("\u00a0", " ").replace("\u202f", " ")  # the page uses no-break spaces in dates
    txt = nb(open(f"{cap}/network.txt").read())
    hist = nb("".join(open(f"{cap}/{f}").read() + "\n" for f in ("history.txt", "today.txt") if os.path.exists(f"{cap}/{f}")))
    cd = net["cycle_day"]
    rec = next(r for r in net["recent"] if r["cycle_day"] == cd)
    iso, label = day_label(cd)
    v, n_acc = rec["key_count"], rec["roster_accounts"]
    # continents + kind of place exactly as the Network page shows them: from each validator's NEWEST daily report,
    # whatever day it came from (net["continents"] / net["places"] count only today's reports and differ from the page)
    accs = (net.get("members") or {}).get("accounts", [])
    machines = [m for a in accs for m in a.get("machines", [])]
    # the count itself too: the page's "N validators from M accounts take part today" is the live list (= net["keys"] /
    # net["accounts"]), and the day summary (rec) can be one newly joined validator behind it (11-11: list 198, summary 197)
    live = bool(machines) and len(machines) in (net.get("keys"), v)
    if live:
        v, n_acc = len(machines), len(accs)
    if live:
        CK = {"NORTH_AMERICA": "north_america", "EUROPE": "europe", "ASIA": "asia", "SOUTH_AMERICA": "south_america",
              "OCEANIA": "oceania", "AFRICA": "africa", "ANTARCTICA": "antarctica"}
        cont, places = {}, {"home": 0, "data_center": 0}
        for m in machines:
            r = m.get("report") or {}
            c = CK.get(r.get("continent"))
            if c:
                cont[c] = cont.get(c, 0) + 1
            if r.get("infrastructure") == "home":
                places["home"] += 1
            elif r.get("infrastructure") == "rack":
                places["data_center"] += 1
    else:  # no per-validator list: the API's own totals (today's reports only)
        cont = {CONT.get(k, k.lower()): n for k, n in net["continents"]}
        pl = dict(net["places"])
        places = {"home": pl.get("Home", 0), "data_center": pl.get("Rack", 0)}
    # signed counts as the Network page shows them: its "N of M accounts" line and the Signed marks in its list come from
    # the live validator list; the day summary (rec) can be a few minutes behind it while signatures still arrive
    signed_v, signed_a = rec["signed_keys"], rec["signing_accounts"]
    if live:
        signed_v = sum(1 for m in machines if m.get("today") == "SIGNED")
        signed_a = sum(1 for a in accs if any(m.get("today") == "SIGNED" for m in a.get("machines", [])))
    cont["not_reported"] = v - sum(cont.values())
    places["not_reported"] = v - sum(places.values())
    two = datetime.fromtimestamp(rec["strong_unix"], timezone.utc).strftime("%H:%M") if rec.get("strong_unix") else None
    stamp = os.path.basename(cap.rstrip("/"))
    vc = version_counts(txt)
    if vc is not None and sum(n for _, n, _ in vc) != v:  # shown only when it adds up to the day's validators
        vc = None
    return {
        "date": iso, "label": label, "cycle_day": cd,
        "final": "FINAL" in (rec.get("flags") or []),
        "name": nickname(hist, label) or today_name(nb(open(f"{cap}/today.txt").read()) if os.path.exists(f"{cap}/today.txt") else "", label),
        "validators": v, "accounts": n_acc,
        "signed_validators": signed_v, "signed_accounts": signed_a,
        "signed_pct": round(100 * rec["signed_weight"] / rec["w"], 1),
        "counted_tdh": rec["w"], "all_tdh": rec["network_tdh"],
        "agreement": (rec.get("level") or "").lower() or None, "two_thirds_utc": two,
        "next_validators": net.get("next_keys"), "next_accounts": net.get("next_accounts"),
        "continents": cont, "places": places,
        "countries": countries_line(txt), "versions": versions_line(txt),
        "version_counts": vc, "chain": chain_tile(txt),
        "captured": stamp, "source": "validator page (read-only)",
    }


def upsert(r):
    days = json.load(open(OUT)) if os.path.exists(OUT) else []
    old = next((d for d in days if d["cycle_day"] == r["cycle_day"]), None)
    if old and old.get("final") and not r["final"]:
        return "kept the final record for " + r["label"]
    if old and old.get("hand_made"):
        return "kept the hand-made record for " + r["label"]
    if old and old.get("final") and old.get("name") and not r.get("name"):
        r["name"] = old["name"]   # the day keeps its name; everything else comes from the new reading
    days = [d for d in days if d["cycle_day"] != r["cycle_day"]] + [r]
    days.sort(key=lambda d: d["cycle_day"])
    tmp = OUT + ".tmp"
    json.dump(days, open(tmp, "w"), indent=1)
    os.replace(tmp, OUT)
    return f"saved {r['label']} ({'final' if r['final'] else 'not final yet'}): {r['validators']} validators, {r['signed_pct']}%"


if __name__ == "__main__":
    r = build(sys.argv[1])
    # leak gate: nothing that looks like a wallet, key, peer id or IP may be in the record
    s = json.dumps(r)
    assert not re.search(r"0x[0-9a-fA-F]{6,}|12D3Koo|\b\d{1,3}(\.\d{1,3}){3}\b|This PC", s), "leak gate tripped"
    print(upsert(r))

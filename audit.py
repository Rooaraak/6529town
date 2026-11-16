#!/usr/bin/env python3
"""6529 Town number check. Every total the site shows for a day must equal what the validator's own pages printed in the
capture that day's record came from, and the per-house data must add up to the same totals. Old-chain days are checked
against network-history.jsonl. usage: audit.py   (exit 1 on any mismatch; daily.sh publishes only after a pass)"""
import base64, json, os, re, sys

M = os.path.dirname(os.path.abspath(__file__))
nb = lambda t: t.replace("\u00a0", " ").replace("\u202f", " ")
CONT = {"North America": "north_america", "Europe": "europe", "Asia": "asia", "South America": "south_america",
        "Oceania": "oceania", "Africa": "africa", "Antarctica": "antarctica", "Not reported": "not_reported"}
CKEY = {"north_america": 1, "europe": 2, "asia": 3, "south_america": 4, "oceania": 5, "africa": 6}
bad, lines = [], []


def check(day, what, page, site):
    ok = page == site
    lines.append(f"{'ok ' if ok else 'BAD'} {day:<10} {what:<34} page={page} site={site}")
    if not ok:
        bad.append(f"{day} {what}: page {page}, site {site}")


def num(s, unit):  # "441.5M" -> 441.5 (in M) ; compare at the page's precision
    return round(float(s), 1), unit


def text_for(rec):
    stamp = rec.get("captured") or ""
    for f in (f"{M}/raw/{stamp}/network.txt", f"{M}/raw/day1-network-text-{stamp}.txt"):
        if os.path.exists(f):
            t = open(f).read()
            today = f"{M}/raw/{stamp}/today.txt"
            return nb(t), nb(open(today).read()) if os.path.exists(today) else ""
    return None, None


def pairs(block, names):
    return {CONT.get(a, a): int(b) for a, b in re.findall(r"^(" + "|".join(map(re.escape, names)) + r")\n+(\d+)$", block, re.M)}


def what_they_run(t):
    # validator rc.15 and later: the block "What they run" ... "From each validator's latest daily report".
    # After the first release name the lines come in threes: "rc.14" / "60%" / "121 validators".
    # Returns [[release, share], ...] in the page's order, or None when anything in the block reads differently.
    part = t.split("\nWhat they run\n")
    if len(part) != 2:
        return None
    part = part[1].split("From each validator's latest daily report")
    if len(part) != 2:
        return None
    ls = [x.strip() for x in part[0].split("\n") if x.strip()]
    name = lambda x: re.fullmatch(r"rc\.\d+|Not reported", x)
    i = next((k for k, x in enumerate(ls) if name(x)), None)
    if i is None or (len(ls) - i) % 3:
        return None
    out = []
    for k in range(i, len(ls), 3):
        share = re.fullmatch(r"(\d+|under 1)%", ls[k + 1])
        if not name(ls[k]) or not share or not re.fullmatch(r"\d+ validators?", ls[k + 2]):
            return None
        out.append(["not reported" if ls[k] == "Not reported" else ls[k], 0 if share[1] == "under 1" else int(share[1])])
    return out or None


def by_version(t):
    # validator rc.18 and later: the block "Validators by version" ... "Validators by location".
    # After the first release name the lines come in fives: "rc.17 below minimum" / "90%" / "of the TDH" / "180" / "validators"
    # (the note after the release name is optional; "<1%" is kept as 0).
    # Returns [[release, share], ...] in the page's order, or None when anything in the block reads differently.
    part = t.split("\nValidators by version\n")
    if len(part) != 2:
        return None
    part = part[1].split("\nValidators by location\n")
    if len(part) != 2:
        return None
    ls = [x.strip() for x in part[0].split("\n") if x.strip()]
    name = lambda x: re.fullmatch(r"(rc\.\d+|Not reported)( [A-Za-z][A-Za-z ]*)?", x)
    i = next((k for k, x in enumerate(ls) if name(x)), None)
    if i is None or (len(ls) - i) % 5:
        return None
    out = []
    for k in range(i, len(ls), 5):
        nm, share = name(ls[k]), re.fullmatch(r"(\d+|<1)%", ls[k + 1])
        if not nm or not share or ls[k + 2] != "of the TDH" or not re.fullmatch(r"\d+", ls[k + 3]) or not re.fullmatch(r"validators?", ls[k + 4]):
            return None
        out.append(["not reported" if nm[1] == "Not reported" else nm[1], 0 if share[1] == "<1" else int(share[1])])
    return out or None


def release_rows(t, validators):
    # the "Validators by version" block again, for the "What they run" card: [[release, validators, note], ...] in the
    # page's order (note = the words after the release name, such as "below minimum", or "").
    # None when anything in the block reads differently or the counts do not add up to the day's validators.
    a = t.find("\nValidators by version\n")
    b = t.find("\nValidators by location\n", a)
    if a < 0 or b < a or t.count("\nValidators by version\n") != 1:
        return None
    ls = [x.strip() for x in t[a:b].split("\n") if x.strip()][1:]
    name = lambda x: re.fullmatch(r"(rc\.\d+|Not reported)( [A-Za-z][A-Za-z ]*)?", x)
    i = next((k for k, x in enumerate(ls) if name(x)), None)
    if i is None or (len(ls) - i) % 5:
        return None
    out = []
    for k in range(i, len(ls), 5):
        nm = name(ls[k])
        if not nm or not re.fullmatch(r"(\d+|<1)%", ls[k + 1]) or ls[k + 2] != "of the TDH" or not re.fullmatch(r"\d+", ls[k + 3]) or not re.fullmatch(r"validators?", ls[k + 4]):
            return None
        out.append(["not reported" if nm[1] == "Not reported" else nm[1], int(ls[k + 3]), (nm[2] or "").strip()])
    return out if out and sum(r[1] for r in out) == validators else None


def chain_tile(t):
    # the "6529 chain" tile: "6529 chain" / "<x>%" / "Slots with a block" / "Final block <n> min behind[, usually <m>]".
    # {"slots_pct": x, "final_lag_min": n}; n is None when the last line reads differently. None when the tile is not
    # there exactly once or reads differently.
    m = re.findall(r"^6529 chain\n+(\d+(?:\.\d+)?)%\n+Slots with a block\n+([^\n]*)$", t, re.M)
    if len(m) != 1 or len(re.findall(r"^\s*6529 chain\s*$", t, re.M)) != 1:
        return None
    lag = re.fullmatch(r"Final block (\d+) min behind(, usually \d+)?", m[0][1].strip())
    return {"slots_pct": float(m[0][0]), "final_lag_min": int(lag[1]) if lag else None}


def country_block(t):
    # validator rc.18 and later: the block "Country" ... "Each bar is out of all": "<n> of <m> named a country."
    # and then the lines in twos: country / count (the full list shows only after its read-only toggle was opened).
    # Returns [[country, count], ...] in the page's order, or None when anything reads differently
    # or the counts do not add up to <n> (a list that was not opened is never taken for the whole list).
    a = t.rfind("\nCountry\n")
    b = t.find("Each bar is out of all", a)
    if a < 0 or b < a:
        return None
    ls = [x.strip() for x in t[a:b].split("\n") if x.strip()][1:]
    head = re.fullmatch(r"(\d+) of (\d+) named a country\.", ls[0]) if ls else None
    if not head:
        return None
    ls = ls[1:]
    if ls and re.fullmatch(r"Show the first \d+", ls[-1]):
        ls = ls[:-1]
    if len(ls) % 2:
        return None
    out = []
    for k in range(0, len(ls), 2):
        if re.search(r"\d", ls[k]) or not re.fullmatch(r"\d+", ls[k + 1]):
            return None
        out.append([ls[k], int(ls[k + 1])])
    return out if sum(n for _, n in out) == int(head[1]) else None


def page_day(rec, t, today):
    L = rec["label"]
    m = re.search(r"(\d+) validators? from (\d+) accounts? take part today", t)
    check(L, "validators, accounts", m and (int(m[1]), int(m[2])), (rec["validators"], rec["accounts"]))
    m = re.search(r"([\d.]+)% of the counted TDH signed", t)
    check(L, "% of counted TDH signed", m and float(m[1]), rec["signed_pct"])
    m = re.search(r"^(\d+) of (\d+) accounts$", t, re.M)
    check(L, "accounts signed", m and (int(m[1]), int(m[2])), (rec["signed_accounts"], rec["accounts"]))
    m = re.search(r"Passed at (\d\d:\d\d) UTC", t)
    check(L, "2/3 passed at", m and m[1], rec["two_thirds_utc"])
    m = re.search(r"Tomorrow: (\d+) keys? from (\d+) accounts?", t)
    check(L, "registered for tomorrow", m and (int(m[1]), int(m[2])), (rec["next_validators"], rec["next_accounts"]))
    m = re.search(r"Validating TDH today\n+([\d.]+)([MB])", t)
    if m:
        div = 1e6 if m[2] == "M" else 1e9
        check(L, "validating TDH", (float(m[1]), m[2]), (round(rec["counted_tdh"] / div, 1), m[2]))
    else:
        check(L, "validating TDH", None, rec["counted_tdh"])
    m = re.search(r"(\d+)% of it validates today", t)
    check(L, "% of all TDH validating", m and int(m[1]), round(100 * rec["counted_tdh"] / rec["all_tdh"]))
    one = r"(?:rc\.\d+|not reported) (?:\d+|under 1)%"  # a share below 1 % is printed as "under 1%" (kept as 0)
    m = re.search(r"^(" + one + r"(?: · " + one + r")*)\s*$", t, re.M)
    vers = [[a, 0 if b == "under 1" else int(b)] for a, b in re.findall(r"(rc\.\d+|not reported) (\d+|under 1)%", m[1])] if m else (what_they_run(t) or by_version(t))
    check(L, "versions (share of TDH)", vers, rec["versions"])
    m = re.search(r"Countries named: (.+?)\.\s*$", t, re.M)
    cn = []
    if m:
        for part in m[1].split(", "):
            mm = re.fullmatch(r"(.+?) \((\d+)\)", part.strip())
            cn.append([mm[1], int(mm[2])] if mm else [part.strip(), 1])
    check(L, "countries named", cn if m else country_block(t), rec["countries"])
    k = t.rfind("\nKind of place\n")
    c = t.find("\nContinent\n", k)
    e = t.find("What a validator", c)
    if k < 0:  # validator rc.18 and later: other headings, and the "Country" block follows the continents
        k = t.rfind("\nHome, office or data center\n")
        c = t.find("\nContinent\n", k)
        e = t.find("\nCountry\n", c)
    pl = pairs(t[k:c], ["Home", "Data center", "Not reported"]) if k >= 0 and c > k else None
    pl = pl and {"home": pl.get("Home", 0), "data_center": pl.get("Data center", 0), "not_reported": pl.get("not_reported", 0)}
    check(L, "kind of place", pl, rec["places"])
    co = pairs(t[c:e], list(CONT)) if c >= 0 and e > c else None
    check(L, "continents", co, {k2: v for k2, v in rec["continents"].items() if v})
    m = re.search(r"Today's result\n+([^\n]+)", today or "")
    if m and re.search(r"^" + re.escape(L) + r"$", today, re.M):
        check(L, "result name", m[1].strip(), rec["name"])
    if "version_counts" in rec:  # records made before these two fields existed are not shown with them
        check(L, "validators per release", release_rows(t, rec["validators"]), rec["version_counts"])
        if rec["version_counts"] is not None:
            check(L, "release counts add up", sum(r[1] for r in rec["version_counts"]), rec["validators"])
    if "chain" in rec:
        check(L, "6529 chain", chain_tile(t), rec["chain"])


def houses(days, reg, built):
    """the town's per-house data for each recorded day must add up to that day's totals"""
    by_cd = {}
    for v in reg["validators"].values():
        for cd, x in v["days"].items():
            by_cd.setdefault(int(cd), []).append(x)
    for i, rec in enumerate(days):
        L = rec["label"]
        if rec.get("old_chain"):
            n = sum(1 for b in base64.b64decode(built["homes"]["days"][i]) if b)
            check(L, "houses drawn (old chain)", rec["validators"], n)
            continue
        xs = by_cd.get(rec["cycle_day"], [])
        check(L, "houses = validators", rec["validators"], len(xs))
        check(L, "signed houses", rec["signed_validators"], sum(1 for x in xs if x[1]))
        cont = {}
        for x in xs:
            k = x[0] if x[0] in CKEY else "not_reported"
            cont[k] = cont.get(k, 0) + 1
        check(L, "roof colours = continents", {k2: v for k2, v in rec["continents"].items() if v}, cont)
        check(L, "data center towers", rec["places"]["data_center"], sum(1 for x in xs if x[2]))
        b = base64.b64decode(built["homes"]["days"][i])
        bc = {}
        for y in b:
            if y:
                k = {1: "north_america", 2: "europe", 3: "asia", 4: "south_america", 5: "oceania", 6: "africa"}.get(y & 7, "not_reported")
                bc[k] = bc.get(k, 0) + 1
        check(L, "page bytes = continents", {k2: v for k2, v in rec["continents"].items() if v}, bc)
        check(L, "page bytes signed", rec["signed_validators"], sum(1 for y in b if y & 8))
        st = built["homes"]["stats"][i]
        check(L, "no place + no report = not shown", rec["continents"].get("not_reported", 0), st and st["noplace"] + st["noreport"])


def old_chain(days):
    hist = os.environ.get("TOWN_NETWORK_HISTORY", f"{M}/network-history.jsonl")  # optional file
    snaps = [json.loads(l) for l in open(hist) if l.strip()] if os.path.exists(hist) else []
    for rec in days:
        if not rec.get("old_chain"):
            continue
        L = rec["label"]
        agreed = [r for r in snaps for dd in r.get("days", []) if dd[0] == L]
        acc = [dd[2] for r in snaps for dd in r.get("days", []) if dd[0] == L and "agreed" in dd[1]]
        check(L, "accounts signed (old chain)", acc and acc[-1], rec["signed_accounts"])
        own = [r for r in snaps if r.get("day") == L]
        if rec.get("keys") == "week":
            check(L, "validators/accounts that week", own and (own[-1]["keys_week"], own[-1]["accts_week"]), (rec["validators"], rec["accounts"]))
            check(L, "registered for next day", own and (own[-1]["keys_tomorrow"], own[-1]["accts_tomorrow"]), (rec["next_validators"], rec["next_accounts"]))
        else:
            check(L, "accounts (keys not recorded)", acc and acc[-1], rec["accounts"])


def main():
    days = json.load(open(f"{M}/data/days.json"))
    old = json.load(open(f"{M}/data/days-old-chain.json"))
    html = open(f"{M}/dist/meme-town.html").read()
    built = json.JSONDecoder().raw_decode(html[html.index('{"days":['):])[0]
    shown = built["days"]
    for rec in days:
        t, today = text_for(rec)
        if t is None:
            if rec is days[-1]:
                bad.append(rec["label"] + ": no page text for its capture " + str(rec.get("captured")))
            else:
                lines.append(f"--  {rec['label']:<10} (capture text no longer kept; checked when it was captured)")
            continue
        page_day(rec, t, today)
    for rec in shown:  # what the page carries must be exactly the records
        src = next((d for d in days + old if d["cycle_day"] == rec["cycle_day"]), None)
        keep = {k: v for k, v in (src or {}).items() if k != "source"}
        check(rec["label"], "page record = data record", True, keep == {k: v for k, v in rec.items() if k != "source"})
    for i, rec in enumerate(shown if "csites" in built else []):  # the globe (when the page has one): every validator once
        g = (built["homes"].get("globe") or [None] * len(shown))[i]
        if g is None:
            check(rec["label"], "globe plan", "present", None); continue
        total = sum(n for _, n in g["c"]) + sum(g["k"].values()) + g["o"]
        check(rec["label"], "globe houses = validators", rec["validators"], total)
        if not rec.get("old_chain"):
            check(rec["label"], "globe country houses", sum(n for _, n in rec["countries"]), g.get("named"))
            check(rec["label"], "globe countries have a spot", [], [c for c, _ in g["c"] if c not in built.get("csites", {})])
    houses(shown, json.load(open(f"{M}/data/residents.json")), built)
    old_chain(shown)
    print("\n".join(lines))
    print(("NUMBERS OK" if not bad else "NUMBERS WRONG: " + "; ".join(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:   # 1 = a number differs; 2 = the check itself could not run (daily.sh tells the two apart)
        import traceback
        traceback.print_exc()
        code = 2
    sys.exit(code)

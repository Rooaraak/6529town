#!/usr/bin/env python3
"""6529 Town: refuse a reading whose "today" is not the real today.

The site shows the validator's own numbers. If the validator is stuck on an older day, or its machine's clock is
wrong, a fresh reading would still look new while showing an old day as "today". This check compares, for ONE capture
(raw/<UTC stamp>/api.json):
  1. the validator's day (network.cycle_day, a Unix day number) with the day of the capture stamp (this machine's clock);
  2. the validator machine's clock (status.now_unix) with the capture stamp: more than 15 minutes apart = refuse.
Prints one plain sentence and exits 7 when the reading must not be used; exits 0 when it is fine.
Reads only two numbers; prints no wallet, key or address. usage: day-guard.py <capture dir>
"""
import json, os, re, sys
from datetime import datetime, timezone

CLOCK_SLACK = 15 * 60   # seconds the validator machine's clock may differ from the capture stamp (the capture itself takes up to ~4 minutes)


def day_name(unix_day):
    d = datetime.fromtimestamp(unix_day * 86400, tz=timezone.utc)
    return d.strftime("%a ") + str(d.day) + d.strftime(" %b")


def check(cap):
    """-> (ok, sentence)"""
    m = re.fullmatch(r"(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)Z", os.path.basename(os.path.normpath(cap)))
    if not m:
        return False, "The reading has no time stamp, so its day could not be checked. Nothing was published."
    y, mo, dd, hh, mi = map(int, m.groups())
    stamp = int(datetime(y, mo, dd, hh, mi, tzinfo=timezone.utc).timestamp())
    try:
        api = json.load(open(os.path.join(cap, "api.json")))
        day = api["/api/v1/network"]["cycle_day"]
        if not isinstance(day, int) or isinstance(day, bool):
            raise ValueError("day is not a number")
    except Exception:
        return False, "The validator's page did not say which day it is on, so nothing was published."
    real = stamp // 86400
    if day != real:
        how = "It may be behind" if day < real else "Its clock may be ahead"
        return False, ("The validator shows %s as today, but today is %s. %s, so nothing was published."
                       % (day_name(day), day_name(real), how))
    now = (api.get("/api/v1/status") or {}).get("now_unix")
    if isinstance(now, (int, float)) and not isinstance(now, bool):
        off = now - stamp
        if off < -CLOCK_SLACK or off > CLOCK_SLACK + 240:
            mins = int(abs(off) // 60)
            return False, ("The validator machine's clock is %d minutes %s, so the validator's day cannot be trusted. Nothing was published."
                           % (mins, "behind" if off < 0 else "ahead"))
        return True, "day check OK: validator day %s = today, validator clock %+d s" % (day_name(day), off)
    return True, "day check OK: validator day %s = today (the validator machine's clock was not in the reading)" % day_name(day)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: day-guard.py <capture dir>"); sys.exit(2)
    ok, msg = check(sys.argv[1])
    print(msg)
    sys.exit(0 if ok else 7)

"""Bell ring: after a town update, decide which bells should ring and ask the worker to ring them.

Run with:
  python3 -I bell-ring.py --page <built index.html> --state <state.json> --conf <bell.json> --stop <bell.STOP>
                          [--url https://6529town.com] [--key-file <file>] [--now <unix>] [--fake]
                          [--fake-answers <json file>]

- Prints ONE summary line with counts only (never a house number, an address or a key). In --fake mode every
  request that would be sent is printed before it as one line {"req": <body>}.
- Always exits 0.
- Python standard library only. The key is read only from --key-file.
"""

import argparse
import base64
import binascii
import datetime
import fcntl
import http.client
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from fractions import Fraction

ALLOWED_URLS = ("https://6529town.com",)
RING_PATH = "/api/bell/ring"
USER_AGENT = "6529town-bell/1 (+https://6529town.com)"

SIGNED_BIT = 0x80          # "bit 8" of a house byte (its high bit): the house signed that day
DAY_SEC = 86400
CLOSE_AT = 68400           # signing closes 19:00 UTC
WINDOW_MIN = 4500          # run only if WINDOW_MIN <= close - now <= WINDOW_MAX
WINDOW_MAX = 11700
CAPTURED_MAX_AGE = 2700    # newest reading at most 45 minutes old
CAPTURED_MAX_AHEAD = 300   # and not more than 5 minutes in the future
MIN_TAKING = 20
MIN_RATIO = Fraction(7, 10)
FINAL_SLACK = Fraction(1, 10)
SIGNED_DROP = 2
VERSION_WAIT = 7200
VERSION_MAX_AGE_DAYS = 7

TIMEOUT = 20
MAX_REQUESTS = 400
TIME_BUDGET = 600          # seconds of wall clock for all requests of one run
LIM = 6
MAX_MAP = 2000             # the worker's count op takes at most 2000 house numbers
MAX_HOUSE = 9999
MAX_BODY = 65536
MAX_PAGE = 64 * 1024 * 1024
MAX_STATE = 16 * 1024 * 1024

RC_RE = re.compile(r"rc\.([0-9]{1,3})")
DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
CAPTURED_RE = re.compile(r"[0-9]{8}T[0-9]{4}Z")
DATA_RE = re.compile(r"^\s*var DATA = (\{.*\});$")
KEY_RE = re.compile(r"[!-~]{32,256}")

MODES = ("off", "dry", "live")
PARTS = ("house", "version", "empty")
TALLY = ("sent", "gone", "denied", "failed", "matched")

DEFAULT_ANSWER = {"ok": True, "active": 0, "matched": 0, "sent": 0, "gone": 0, "denied": 0, "failed": 0,
                  "after": 0, "more": False, "removed": 0}


class Skip(Exception):
    """The whole run is skipped before any request. reason = short fixed text."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class AskError(Exception):
    """A request failed (or must not be sent). No more requests this run."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def is_int(x):
    return type(x) is int


# ---------------------------------------------------------------- arguments

class _Args(argparse.ArgumentParser):
    def error(self, message):
        raise Skip("args")

    def exit(self, status=0, message=None):
        raise Skip("args")


def stop_paths(argv):
    out = []
    for i, s in enumerate(argv):
        if s == "--stop" and i + 1 < len(argv):
            out.append(argv[i + 1])
        elif s.startswith("--stop="):
            out.append(s[len("--stop="):])
    return out


def stopped(paths):
    for p in paths:
        try:
            if p and os.path.lexists(p):
                return True
        except (OSError, ValueError):
            return True
    return False


def parse_args(argv):
    p = _Args(prog="bell-ring", add_help=False, allow_abbrev=False)
    p.add_argument("--page", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--conf")
    p.add_argument("--stop", required=True)
    p.add_argument("--url", default=ALLOWED_URLS[0])
    p.add_argument("--key-file")
    p.add_argument("--now")
    p.add_argument("--fake", action="store_true")
    p.add_argument("--fake-answers")
    a = p.parse_args(argv)
    for v in (a.page, a.state, a.stop):
        if not v or "\0" in v:
            raise Skip("args")
    if a.now is None:
        a.now = int(time.time())
    else:
        if not re.fullmatch(r"[0-9]{1,12}", a.now):
            raise Skip("args")
        a.now = int(a.now)
    if a.fake_answers is not None and not a.fake:
        raise Skip("args")
    return a


# ---------------------------------------------------------------- files

def read_small(path, limit, missing_ok):
    """Bytes of a file, or None when it does not exist and missing_ok. Raises OSError/ValueError otherwise."""
    try:
        f = open(path, "rb")
    except FileNotFoundError:
        if missing_ok:
            return None
        raise
    with f:
        raw = f.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("too big")
    return raw


def load_conf(path):
    conf = {k: "dry" for k in PARTS}
    if path is None:
        return conf
    try:
        raw = read_small(path, 4096, True)
        if raw is None:
            return conf
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError):
        raise Skip("conf")
    if not isinstance(data, dict):
        raise Skip("conf")
    for k, v in data.items():
        if k not in PARTS or not isinstance(v, str) or v not in MODES:
            raise Skip("conf")
        conf[k] = v
    return conf


def b64_bytes(s):
    if not isinstance(s, str) or not re.fullmatch(r"[A-Za-z0-9+/]*={0,2}", s):
        raise ValueError("bad base64")
    s = s.rstrip("=")
    return base64.b64decode(s + "=" * (-len(s) % 4), validate=True)


def b64_text(b):
    return base64.b64encode(b).decode("ascii")


def load_state(path):
    """Known keys only; anything of a wrong type -> Skip('state')."""
    try:
        raw = read_small(path, MAX_STATE, True)
        if raw is None:
            return {}
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError):
        raise Skip("state")
    if not isinstance(data, dict):
        raise Skip("state")
    st = {}
    try:
        for k in ("day", "signed", "pruned_day", "house_day", "empty_day"):
            if k in data:
                if not is_int(data[k]) or data[k] < 0:
                    raise ValueError(k)
                st[k] = data[k]
        if ("day" in st) != ("signed" in st):
            raise ValueError("reading")
        if "finals" in data:
            fin = data["finals"]
            if not isinstance(fin, dict):
                raise ValueError("finals")
            st["finals"] = {}
            for fk, fv in fin.items():
                st["finals"][fk] = b64_bytes(fv)
        if "version_sent" in data:
            if not isinstance(data["version_sent"], str) or not RC_RE.fullmatch(data["version_sent"]):
                raise ValueError("version_sent")
            st["version_sent"] = data["version_sent"]
        if "version_seen" in data:
            vs = data["version_seen"]
            if (not isinstance(vs, dict) or not isinstance(vs.get("v"), str) or not RC_RE.fullmatch(vs["v"])
                    or not is_int(vs.get("first")) or vs["first"] < 0):
                raise ValueError("version_seen")
            st["version_seen"] = {"v": vs["v"], "first": vs["first"]}
    except (ValueError, binascii.Error):
        raise Skip("state")
    return st


def state_json(st):
    out = dict(st)
    if "finals" in out:
        out["finals"] = {k: b64_text(v) for k, v in out["finals"].items()}
    return (json.dumps(out, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def save_state(path, st):
    """Atomic write, mode 0600: temp file in the same folder, fsync, rename over the old file."""
    data = state_json(st)
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".bell-state-", suffix=".tmp", dir=folder)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as f:
            fd = -1
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def take_lock(state_path):
    try:
        fd = os.open(state_path + ".lock", os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    except (OSError, ValueError):
        raise Skip("state")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise Skip("busy")
    return fd


def read_key(path):
    """The ring key, only from the key file: one line, 32..256 printable ASCII characters, file not readable by
    group or others."""
    if not path:
        raise Skip("key")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    except (OSError, ValueError):
        raise Skip("key")
    try:
        st = os.fstat(fd)
        if not (st.st_mode & 0o170000 == 0o100000) or st.st_mode & 0o077 or st.st_size > 4096:
            raise Skip("key")
        raw = os.read(fd, 4097)
    except OSError:
        raise Skip("key")
    finally:
        os.close(fd)
    try:
        key = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        raise Skip("key")
    if not KEY_RE.fullmatch(key):
        raise Skip("key")
    return key


def load_answers(path):
    if path is None:
        return []
    try:
        raw = read_small(path, MAX_PAGE, False)
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError):
        raise Skip("fake-answers")
    if not isinstance(data, list):
        raise Skip("fake-answers")
    return data


# ---------------------------------------------------------------- page data

def load_page(path):
    try:
        raw = read_small(path, MAX_PAGE, False)
        text = raw.decode("utf-8")
    except (OSError, ValueError):
        raise Skip("page")
    found = []
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        m = DATA_RE.match(line)
        if m:
            found.append(m.group(1))
    if len(found) != 1:
        raise Skip("page")
    try:
        data = json.loads(found[0])
    except ValueError:
        raise Skip("page")
    if not isinstance(data, dict):
        raise Skip("page")
    return data


class Day:
    __slots__ = ("cycle_day", "final", "captured", "old")

    def __init__(self, cycle_day, final, captured, old):
        self.cycle_day, self.final, self.captured, self.old = cycle_day, final, captured, old


class Town:
    """days, one bytes object per day, and per house (index = house number - 1) its first-day index and group."""

    def __init__(self, days, rows, first, group):
        self.days, self.rows, self.first, self.group = days, rows, first, group

    def byte(self, j, idx):
        row = self.rows[j]
        return row[idx] if idx < len(row) else 0

    def unsigned(self, j, idx):
        b = self.byte(j, idx)
        return b != 0 and not b & SIGNED_BIT

    def finals(self):
        """F: indexes of final, not old-chain days, ascending."""
        return [j for j, d in enumerate(self.days) if d.final and not d.old]


def parse_town(data):
    """Town, or None when days/homes do not have the expected shape."""
    try:
        days_in = data["days"]
        homes = data["homes"]
        if not isinstance(days_in, list) or not days_in or not isinstance(homes, dict):
            return None
        days = []
        for d in days_in:
            if not isinstance(d, dict):
                return None
            cd, fin, old = d.get("cycle_day"), d.get("final"), d.get("old_chain", False)
            if old is None:
                old = False
            if not is_int(cd) or cd < 0 or not isinstance(fin, bool) or not isinstance(old, bool):
                return None
            days.append(Day(cd, fin, d.get("captured"), old))
        hdays, hlist = homes.get("days"), homes.get("list")
        if not isinstance(hdays, list) or len(hdays) != len(days) or not isinstance(hlist, list):
            return None
        first, group = [], []
        for idx, row in enumerate(hlist):
            if not isinstance(row, list) or len(row) < 3:
                return None
            f, g = row[0], row[2]
            if not is_int(f) or f < 0:
                return None
            if is_int(g) and g >= 0:
                group.append(("g", g))
            elif g is None:
                group.append(("s", idx))
            else:
                return None
            first.append(f)
        rows = [b64_bytes(s) for s in hdays]
        if any(len(r) > len(first) for r in rows):
            return None
        return Town(days, rows, first, group)
    except (KeyError, TypeError, ValueError, binascii.Error):
        return None


def parse_release(data):
    """(v, date) when releases[0] is well formed, else None."""
    rel = data.get("releases")
    if not isinstance(rel, list) or not rel:
        return None
    r0 = rel[0]
    if not isinstance(r0, list) or len(r0) < 2 or not isinstance(r0[0], str) or not isinstance(r0[1], str):
        return None
    if not RC_RE.fullmatch(r0[0]) or not DATE_RE.fullmatch(r0[1]):
        return None
    try:
        date = datetime.date.fromisoformat(r0[1])
    except ValueError:
        return None
    return r0[0], date


def rc_num(v):
    return int(RC_RE.fullmatch(v).group(1))


def captured_unix(s):
    if not isinstance(s, str) or not CAPTURED_RE.fullmatch(s):
        return None
    try:
        dt = datetime.datetime.strptime(s, "%Y%m%dT%H%MZ").replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    return int(dt.timestamp())


def final_rows(town):
    """Bytes of every final day, keyed by cycle day ("o" = old chain, "#2".. for a repeated key)."""
    out = {}
    for j, d in enumerate(town.days):
        if not d.final:
            continue
        base = str(d.cycle_day) + ("o" if d.old else "")
        k, n = base, 2
        while k in out:
            k, n = "%s#%d" % (base, n), n + 1
        out[k] = town.rows[j]
    return out


def history_ok(town, st):
    """Final-day bytes must extend what was seen last time. On success the state keeps the new set."""
    new = final_rows(town)
    old = st.get("finals")
    if old:
        for k, ob in old.items():
            nb = new.get(k)
            if nb is not None and nb[:len(ob)] != ob:
                return False
    st["finals"] = new
    return True


def counts(row):
    taking = sum(1 for b in row if b != 0)
    signed = sum(1 for b in row if b & SIGNED_BIT)
    return taking, signed


def in_order(town):
    """The rules read list position as time (days[-1] = today, F[-1] = latest final). So cycle_day must rise
    strictly along every day that is not old-chain (F and the newest day are among them). Old-chain days may
    share a day number with a new-chain day and are not used by the rules."""
    seen = [d.cycle_day for d in town.days if not d.old]
    return all(a < b for a, b in zip(seen, seen[1:]))


def check_guards(town, st, now, today, hist_ok):
    """None when all common guards pass, else a short reason. Stores the reading of the day when they pass."""
    last = len(town.days) - 1
    d = town.days[last]
    if d.cycle_day != today:
        return "day"
    if d.final:
        return "final"
    if d.old:
        return "old-chain"
    if not in_order(town):
        return "order"
    cap = captured_unix(d.captured)
    if cap is None:
        return "captured"
    if now - cap > CAPTURED_MAX_AGE:
        return "stale"
    if cap - now > CAPTURED_MAX_AHEAD:
        return "future"
    if not hist_ok:
        return "history"
    taking, signed = counts(town.rows[last])
    if taking < MIN_TAKING:
        return "few"
    ratio = Fraction(signed, taking)
    if ratio < MIN_RATIO:
        return "low"
    F = town.finals()
    if not F:
        return "no-final"
    ft, fs = counts(town.rows[F[-1]])
    if ft == 0:
        return "no-final"
    if ratio < Fraction(fs, ft) - FINAL_SLACK:
        return "below-final"
    if st.get("day") == today and signed < st["signed"] - SIGNED_DROP:
        return "drop"
    st["day"], st["signed"] = today, signed
    return None


def quiet(town, F, idx):
    """'alert', 'pause' (3 unsigned final days in a row, the one before not) or 'silent' (4 or more)."""
    if len(F) < 3:
        return "alert"
    run = 0
    for j in reversed(F):
        if run >= 4 or not town.unsigned(j, idx):
            break
        run += 1
    if run >= 4:
        return "silent"
    if run == 3:
        return "pause"
    return "alert"


def decide_house(town):
    """Alert map m {h: [n, of]}, pause map {h: [1, 1]} and counts (no house numbers in the counts)."""
    last = len(town.days) - 1
    F = town.finals()
    status = {}
    for idx in range(len(town.first)):
        if town.unsigned(last, idx) and town.first[idx] < last:
            status[idx] = quiet(town, F, idx)
    groups = {}
    for idx, g in enumerate(town.group):
        groups.setdefault(g, []).append(idx)
    m, pause = {}, {}
    n_groups = 0
    for members in groups.values():
        sts = [status.get(i) for i in members]
        if "alert" in sts:
            n_groups += 1
            taking = [i for i in members if town.byte(last, i) != 0 and town.first[i] < last]
            of = len(taking)
            n = sum(1 for i in taking if i in status)
            pair = [n, of] if 1 <= n <= of <= 99 else [1, 1]
            for i in members:
                m[i + 1] = pair
        elif "pause" in sts:
            for i in members:
                pause[i + 1] = [1, 1]
    vals = list(status.values())
    info = {"unsigned": len(vals), "alert": vals.count("alert"), "pause": vals.count("pause"),
            "silent": vals.count("silent"), "groups": n_groups}
    return as_map(m), as_map(pause), info


def decide_empty(town):
    last = len(town.days) - 1
    F = town.finals()
    out = {}
    if F:
        for idx in range(len(town.first)):
            if town.byte(last, idx) == 0 and town.first[idx] < last and town.byte(F[-1], idx) != 0:
                out[idx + 1] = [1, 1]
    return as_map(out)


def as_map(d):
    return {str(h): d[h] for h in sorted(d) if 1 <= h <= MAX_HOUSE}


# ---------------------------------------------------------------- requests

def make_opener():
    """https only with the default certificate checks, no proxy settings from outside, redirects not followed."""
    ctx = ssl.create_default_context()
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                                       urllib.request.HTTPSHandler(context=ctx))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def real_transport(url, key, opener):
    target = url + RING_PATH

    def send(body):
        data = json.dumps(body, separators=(",", ":")).encode("ascii")
        if len(data) > MAX_BODY:
            raise AskError("big")
        req = urllib.request.Request(target, data=data, method="POST", headers={
            "x-bell-key": key, "User-Agent": USER_AGENT, "Content-Type": "application/json"})
        try:
            with opener.open(req, timeout=TIMEOUT) as resp:
                status = resp.status
                raw = resp.read(MAX_BODY + 1)
        except urllib.error.HTTPError as e:
            code = e.code if is_int(e.code) else 0
            try:
                e.close()
            except Exception:
                pass
            raise AskError("http-%d" % code)
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError):
            raise AskError("net")
        if status != 200:
            raise AskError("http-%d" % status if is_int(status) else "http")
        if len(raw) > MAX_BODY:
            raise AskError("answer")
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise AskError("answer")

    return send


def fake_transport(answers, out):
    queue = list(answers)

    def send(body):
        out(json.dumps({"req": body}))
        a = queue.pop(0) if queue else dict(DEFAULT_ANSWER)
        if a is None:
            raise AskError("net")
        if isinstance(a, dict) and "_http" in a:
            code = a["_http"]
            raise AskError("http-%d" % code if is_int(code) else "http")
        return a

    return send


def valid_answer(op, a):
    if not isinstance(a, dict) or a.get("ok") is not True:
        return False
    if op == "count":
        names = ("active", "matched")
    elif op == "prune":
        names = ("removed",)
    else:
        names = TALLY + ("after",)
        if not isinstance(a.get("more"), bool):
            return False
    return all(is_int(a.get(n)) and a[n] >= 0 for n in names)


class Asker:
    """Counts requests, enforces the cap, the time budget and the stop file. After the first failure nothing
    more is sent this run."""

    def __init__(self, send, stop, mono=time.monotonic):
        self.send, self.stop, self.mono = send, stop, mono
        self.n = 0
        self.failed = None
        self.start = mono()

    def ask(self, body):
        if self.failed:
            raise AskError(self.failed)
        try:
            if self.n >= MAX_REQUESTS:
                raise AskError("cap")
            if self.mono() - self.start > TIME_BUDGET:
                raise AskError("time")
            if stopped(self.stop):
                raise AskError("stopped")
            if len(json.dumps(body, separators=(",", ":"))) > MAX_BODY:
                raise AskError("big")
            self.n += 1
            a = self.send(body)
            if not valid_answer(body["op"], a):
                raise AskError("answer")
            return a
        except AskError as e:
            self.failed = e.reason
            raise


def flood(ans):
    """matched > 5 and matched > 0.30 * active."""
    return ans["matched"] > 5 and ans["matched"] * 10 > 3 * ans["active"]


def denied_stop(t):
    return t["denied"] >= 4 and 2 * t["denied"] >= t["sent"] + t["denied"]


def walk(asker, base, tally):
    """Loop alert/version requests until `more` is false. 'done', or 'denied' when the denied rule stopped it."""
    after = 0
    own = dict.fromkeys(TALLY, 0)
    while True:
        body = {k: v for k, v in base.items() if k != "dry"}
        body.update(after=after, lim=LIM, dry=base["dry"])
        a = asker.ask(body)
        for k in TALLY:
            own[k] += a[k]
            tally[k] += a[k]
        if not a["more"]:
            return "done"
        if a["after"] <= after:
            asker.failed = "loop"
            raise AskError("loop")
        after = a["after"]
        if denied_stop(own):
            return "denied"


def tally_text(t, dry):
    if dry:
        return ["hit=%d" % t["matched"]]
    return ["hit=%d" % t["matched"], "sent=%d" % t["sent"], "gone=%d" % t["gone"], "denied=%d" % t["denied"],
            "failed=%d" % t["failed"]]


# ---------------------------------------------------------------- steps

class Run:
    def __init__(self, args, conf, st, asker, data):
        self.a, self.conf, self.st, self.asker, self.data = args, conf, st, asker, data
        self.now = args.now
        self.today = args.now // DAY_SEC
        self.close = self.today * DAY_SEC + CLOSE_AT
        self.town = parse_town(data)
        self.hist = history_ok(self.town, st) if self.town else False
        self.guard = check_guards(self.town, st, self.now, self.today, self.hist) if self.town else "data"

    def in_window(self):
        return WINDOW_MIN <= self.close - self.now <= WINDOW_MAX

    def gate(self, part, day_key):
        """None when the part may act now, else its summary text."""
        mode = self.conf[part]
        if mode == "off":
            return "%s off" % part
        if self.st.get(day_key) == self.today:
            return "%s %s done" % (part, mode)
        if not self.in_window():
            return "%s %s wait" % (part, mode)
        if self.guard:
            return "%s %s skip(%s)" % (part, mode, self.guard)
        return None

    def count(self, mp):
        return self.asker.ask({"op": "count", "hs": [int(h) for h in mp]})

    def house(self):
        g = self.gate("house", "house_day")
        if g:
            return g
        mode = self.conf["house"]
        dry = mode == "dry"
        m, pause, info = decide_house(self.town)
        out = ["house %s" % mode] + ["%s=%d" % (k, info[k]) for k in ("unsigned", "alert", "pause", "silent",
                                                                       "groups")]
        tally = dict.fromkeys(TALLY, 0)
        try:
            how = "done"
            if len(m) > MAX_MAP:
                out.append("flood")
                self.st["house_day"] = self.today
                return " ".join(out)
            if m:
                c = self.count(m)
                out += ["matched=%d" % c["matched"], "active=%d" % c["active"]]
                if flood(c):
                    out.append("flood")
                    self.st["house_day"] = self.today
                    return " ".join(out)
                how = walk(self.asker, {"op": "alert", "k": "house", "day": self.today, "close": self.close,
                                        "m": m, "dry": dry}, tally)
            if pause and how == "done":
                if len(pause) > MAX_MAP:
                    out.append("pause-flood")
                else:
                    c = self.count(pause)
                    if flood(c):
                        out.append("pause-flood")
                    else:
                        how = walk(self.asker, {"op": "alert", "k": "pause", "day": self.today, "m": pause,
                                                "dry": dry}, tally)
            out += tally_text(tally, dry)
            if how == "denied":
                out.append("denied-stop")
            self.st["house_day"] = self.today
        except AskError:
            out += tally_text(tally, dry) + ["error"]
        return " ".join(out)

    def empty(self):
        g = self.gate("empty", "empty_day")
        if g:
            return g
        mode = self.conf["empty"]
        dry = mode == "dry"
        mp = decide_empty(self.town)
        out = ["empty %s" % mode, "houses=%d" % len(mp)]
        tally = dict.fromkeys(TALLY, 0)
        try:
            if len(mp) > MAX_MAP:
                out.append("flood")
            elif mp:
                c = self.count(mp)
                out += ["matched=%d" % c["matched"], "active=%d" % c["active"]]
                if flood(c):
                    out.append("flood")
                else:
                    how = walk(self.asker, {"op": "alert", "k": "empty", "day": self.today, "m": mp, "dry": dry},
                               tally)
                    out += tally_text(tally, dry)
                    if how == "denied":
                        out.append("denied-stop")
            self.st["empty_day"] = self.today
        except AskError:
            out += tally_text(tally, dry) + ["error"]
        return " ".join(out)

    def version(self):
        mode = self.conf["version"]
        rel = parse_release(self.data)
        if rel is None:
            return "version skip(release)"
        v, date = rel
        st = self.st
        if "version_sent" not in st:
            st["version_seen"] = {"v": v, "first": self.now}
            st["version_sent"] = v
            return "version first"
        seen = st.get("version_seen")
        if not seen or seen["v"] != v:
            st["version_seen"] = {"v": v, "first": self.now}
            return "version new"
        if mode == "off":
            return "version off"
        sent = st["version_sent"]
        if v == sent or rc_num(v) <= rc_num(sent):
            return "version none"
        today_date = datetime.datetime.fromtimestamp(self.now, datetime.timezone.utc).date()
        age = (today_date - date).days
        if age < 0 or age > VERSION_MAX_AGE_DAYS:
            return "version %s old" % mode if age > 0 else "version %s future" % mode
        if self.now - seen["first"] < VERSION_WAIT:
            return "version %s wait" % mode
        dry = mode == "dry"
        tally = dict.fromkeys(TALLY, 0)
        out = ["version %s" % mode]
        try:
            how = walk(self.asker, {"op": "version", "v": v, "dry": dry}, tally)
            out += tally_text(tally, dry)
            if how == "done":
                st["version_sent"] = v
            else:
                out.append("denied-stop")
        except AskError:
            out += tally_text(tally, dry) + ["error"]
        return " ".join(out)

    def prune(self):
        if self.st.get("pruned_day") == self.today:
            return "prune done"
        try:
            a = self.asker.ask({"op": "prune"})
        except AskError:
            return "prune error"
        self.st["pruned_day"] = self.today
        return "prune removed=%d" % a["removed"]


def run(argv, out):
    a = parse_args(argv)
    if a.url not in ALLOWED_URLS:
        raise Skip("url")
    conf = load_conf(a.conf)
    lock = take_lock(a.state)
    try:
        st = load_state(a.state)
        if a.fake:
            send = fake_transport(load_answers(a.fake_answers), out)
        else:
            send = real_transport(a.url, read_key(a.key_file), make_opener())
        data = load_page(a.page)
        asker = Asker(send, stop_paths(argv))
        r = Run(a, conf, st, asker, data)
        house = r.house()
        empty = r.empty()
        version = r.version()
        prune = r.prune()
        parts = [house, version, empty, prune]
        try:
            save_state(a.state, st)
        except (OSError, ValueError):
            parts.append("state not-saved")
        body = " | ".join(parts)
        if asker.failed:
            return "bell: skipped (%s) | %s" % (asker.failed, body)
        return "bell: " + body
    finally:
        os.close(lock)


def _print(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main(argv, out=_print):
    """Returns the one summary line (the caller prints it)."""
    if stopped(stop_paths(argv)):
        return "bell: stopped"
    try:
        return run(argv, out)
    except Skip as e:
        return "bell: skipped (%s)" % e.reason


if __name__ == "__main__":
    try:
        line = main(sys.argv[1:])
    except BaseException:
        line = "bell: skipped (internal)"
    try:
        _print(line)
    except BaseException:
        pass
    os._exit(0)

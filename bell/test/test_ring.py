"""Tests of bell-ring.py. Synthetic page data only, no network (fake answers / fake opener only).

Run from the bell folder (one process, light):
  nice -n 10 python3 -I test/test_ring.py
  nice -n 10 python3 -I -m unittest discover -s test -p test_ring.py
"""

import base64
import datetime
import email.message
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import urllib.response
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "bell-ring.py"

DAY = 86400
TODAY = 20770                      # a synthetic UTC day number
CLOSE = TODAY * DAY + 68400        # 19:00 UTC that day
NOW = CLOSE - 7200                 # inside the window, on a whole minute
S, U, E = 0x09, 0x01, 0x00         # signed / on the roster but not signed / not on the roster
KEY_MARK = "KEYMARK-" + "q7Zp" * 10  # a synthetic ring key (48 chars)


sys.dont_write_bytecode = True     # no __pycache__ next to the script


def load_module():
    spec = importlib.util.spec_from_file_location("bell_ring", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MOD = load_module()


def stamp(unix):
    return datetime.datetime.fromtimestamp(unix, datetime.timezone.utc).strftime("%Y%m%dT%H%MZ")


def ymd(unix):
    return datetime.datetime.fromtimestamp(unix, datetime.timezone.utc).strftime("%Y-%m-%d")


def ans(**kw):
    a = {"ok": True, "active": 0, "matched": 0, "sent": 0, "gone": 0, "denied": 0, "failed": 0, "after": 0,
         "more": False, "removed": 0}
    a.update(kw)
    return a


class Town:
    """A synthetic built page: `finals` final days, then today's open day. Every house signed every day,
    every house its own wallet group, every house there from day 0."""

    def __init__(self, houses=30, finals=5, now=NOW):
        today = now // DAY
        self.days = [{"cycle_day": today - finals + i, "final": True,
                      "captured": stamp((today - finals + i) * DAY + 80000)} for i in range(finals)]
        self.days.append({"cycle_day": today, "final": False, "captured": stamp(now - 600)})
        self.rows = [[S] * houses for _ in self.days]
        self.list = [[0, 0, i] for i in range(houses)]
        self.releases = [["rc.5", ymd(now - 30 * DAY)], ["rc.4", ymd(now - 60 * DAY)]]
        self.extra_lines = []

    @property
    def last(self):
        return len(self.days) - 1

    def finals(self):
        return [j for j, d in enumerate(self.days) if d["final"] and not d.get("old_chain")]

    def today(self, h, v):
        self.rows[self.last][h - 1] = v
        return self

    def hist(self, h, *vals):
        """Bytes of house h on the last len(vals) final (not old-chain) days, oldest first."""
        F = self.finals()
        for j, v in zip(F[len(F) - len(vals):], vals):
            self.rows[j][h - 1] = v
        return self

    def all_days(self, h, v):
        for row in self.rows:
            row[h - 1] = v
        return self

    def group(self, g, *houses):
        for h in houses:
            self.list[h - 1][2] = g
        return self

    def first(self, h, idx):
        self.list[h - 1][0] = idx
        return self

    def data(self):
        return {
            "days": self.days,
            "homes": {
                "days": [base64.b64encode(bytes(r)).decode() for r in self.rows],
                "list": self.list,
                "groups": ["synthetic-group-code-%03d" % i for i in range(len(self.list))],
            },
            "releases": self.releases,
        }

    def html(self):
        lines = ["<!doctype html>", "<html><head><title>synthetic town</title></head><body>", "<script>",
                 "  var DATA = %s;" % json.dumps(self.data())]
        lines += self.extra_lines
        lines += ["</script>", "</body></html>", ""]
        return "\n".join(lines)


REASONS = {"args", "url", "conf", "state", "busy", "key", "page", "fake-answers", "internal", "net", "cap", "time",
           "stopped", "loop", "answer", "big", "http", "day", "final", "old-chain", "captured", "stale", "future",
           "history", "few", "low", "no-final", "below-final", "drop", "data", "release", "order"}
WORDS = {"bell:", "stopped", "skipped", "|", "house", "version", "empty", "prune", "state", "not-saved", "off",
         "dry", "live", "done", "wait", "first", "new", "none", "old", "future", "flood", "pause-flood",
         "denied-stop", "error"}
COUNT_RE = re.compile(r"(unsigned|alert|pause|silent|groups|matched|active|hit|sent|gone|denied|failed|houses|"
                      r"removed)=[0-9]+")
REASON_RE = re.compile(r"(?:skip)?\(([a-z0-9-]+)\)")


def check_summary(tc, line):
    """Whitelist: only fixed words, name=count, (reason) / skip(reason). Never a bare number or other text."""
    tc.assertTrue(line.startswith("bell: "), line)
    for tok in line.split(" "):
        if tok in WORDS or COUNT_RE.fullmatch(tok):
            continue
        m = REASON_RE.fullmatch(tok)
        tc.assertTrue(m, "token not allowed: %r in %r" % (tok, line))
        r = m.group(1)
        tc.assertTrue(r in REASONS or re.fullmatch(r"http-[0-9]{3}", r), "reason not allowed: %r" % r)
    body = line[len("bell: "):]
    if body.startswith("skipped ("):
        body = body.split(" | ", 1)[1] if " | " in body else ""
    if body and body != "stopped":
        heads = [p.split(" ")[0] for p in body.split(" | ")]
        tc.assertEqual(heads[:4], ["house", "version", "empty", "prune"], line)
        tc.assertTrue(heads[4:] in ([], ["state"]), line)


class Result:
    def __init__(self, proc):
        self.rc = proc.returncode
        self.stdout = proc.stdout
        self.stderr = proc.stderr
        self.lines = proc.stdout.splitlines()
        self.reqs = [json.loads(x)["req"] for x in self.lines if x.startswith('{"req"')]
        self.summary = self.lines[-1] if self.lines else ""
        self.other = [x for x in self.lines[:-1] if not x.startswith('{"req"')]

    def ops(self, op, k=None):
        return [q for q in self.reqs if q["op"] == op and (k is None or q.get("k") == k)]


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="bell-ring-test-")
        self.dir = Path(self._tmp.name)
        self.page = self.dir / "index.html"
        self.state = self.dir / "state.json"
        self.conf = self.dir / "bell.json"
        self.stop = self.dir / "bell.STOP"
        self.answers = self.dir / "answers.json"

    def tearDown(self):
        self._tmp.cleanup()

    def argv(self, now=NOW, fake=True, extra=()):
        a = ["--page", str(self.page), "--state", str(self.state), "--conf", str(self.conf), "--stop",
             str(self.stop), "--now", str(now)]
        if fake:
            a.append("--fake")
        return a + list(extra)

    def ring(self, town=None, now=NOW, conf=None, answers=None, state=None, extra=(), argv=None, fake=True,
             check=True):
        """Run the script as `python3 -I` with fake answers. conf None = no conf file (all dry)."""
        if town is not None:
            self.page.write_text(town.html() if isinstance(town, Town) else town)
        if conf is not None:
            self.conf.write_text(json.dumps(conf) if not isinstance(conf, str) else conf)
        if state is not None:
            self.state.write_text(json.dumps(state) if not isinstance(state, str) else state)
        extra = list(extra)
        if answers is not None:
            self.answers.write_text(json.dumps(answers))
            extra += ["--fake-answers", str(self.answers)]
        if argv is None:
            argv = self.argv(now=now, fake=fake, extra=extra)
        proc = subprocess.run([sys.executable, "-I", str(SCRIPT)] + argv, capture_output=True, text=True,
                              timeout=120, cwd=str(self.dir), env={"LC_ALL": "C.UTF-8"})
        r = Result(proc)
        if check:
            self.assertEqual(r.rc, 0, r.stdout + r.stderr)
            self.assertEqual(r.stderr, "")
            self.assertEqual(r.other, [], r.stdout)
            check_summary(self, r.summary)
            self.assertNotIn("synthetic-group-code", r.stdout)
        return r

    def read_state(self):
        return json.loads(self.state.read_text())

    def skipped(self, r, reason):
        self.assertEqual(r.summary, "bell: skipped (%s)" % reason)
        self.assertEqual(r.reqs, [])


def one_unsigned(houses=30):
    """30 houses, house 7 has not signed today (one alert)."""
    return Town(houses).today(7, U)


# ====================================================================== stop, args, conf, files

class TestStopArgsConf(Base):
    def test_stop_file_first(self):
        self.stop.write_text("")
        r = self.ring(one_unsigned())
        self.assertEqual(r.lines, ["bell: stopped"])
        self.assertFalse(self.state.exists())
        self.assertFalse(Path(str(self.state) + ".lock").exists())

    def test_stop_file_even_with_bad_args_and_missing_page(self):
        self.stop.write_text("x")
        r = self.ring(argv=["--stop", str(self.stop), "--bogus", "--key", "x"])
        self.assertEqual(r.lines, ["bell: stopped"])
        r = self.ring(argv=["--stop=" + str(self.stop)])
        self.assertEqual(r.lines, ["bell: stopped"])

    def test_bad_args_exit_0(self):
        self.page.write_text(one_unsigned().html())
        for argv in ([], ["--help"], ["-h"], self.argv() + ["--bogus"], self.argv() + ["--key", KEY_MARK],
                     self.argv(extra=["--now", "soon"]), ["--page", str(self.page), "--stop", str(self.stop)]):
            r = self.ring(argv=argv)
            self.skipped(r, "args")
            self.assertEqual(r.lines, ["bell: skipped (args)"])
        # --fake-answers only together with --fake
        self.answers.write_text("[]")
        r = self.ring(argv=self.argv(fake=False, extra=["--fake-answers", str(self.answers)]))
        self.skipped(r, "args")

    def test_page_problems_exit_0(self):
        r = self.ring()                                   # page file missing
        self.skipped(r, "page")
        good = one_unsigned()
        for text in ("<html>no data here</html>", good.html().replace("var DATA = {", "var DATA = [{"),
                     good.html().replace("var DATA = ", "var  DATA = "),
                     good.html().replace("};\n</script>", "}\n</script>"),
                     good.html() + "  var DATA = {};\n",       # two DATA lines
                     "  var DATA = {not json};\n", b"\xff\xfe".decode("latin-1")):
            r = self.ring(text)
            self.skipped(r, "page")
        self.assertFalse(self.state.exists())

    def test_crlf_page_is_read(self):
        r = self.ring(one_unsigned().html().replace("\n", "\r\n"))
        self.assertEqual(len(r.ops("alert", "house")), 1)

    def test_conf_missing_means_all_dry(self):
        self.assertFalse(self.conf.exists())
        t = one_unsigned()
        t.releases = [["rc.6", ymd(NOW - DAY)]]
        st = {"version_sent": "rc.5", "version_seen": {"v": "rc.6", "first": NOW - 9000}}
        r = self.ring(t, state=st)
        self.assertTrue(r.summary.startswith("bell: house dry "), r.summary)
        self.assertIn("| version dry ", r.summary)
        self.assertIn("| empty dry ", r.summary)
        walks = r.ops("alert") + r.ops("version")
        self.assertEqual(len(walks), 2)
        self.assertTrue(all(q["dry"] is True for q in walks))

    def test_conf_keys_default_to_dry_and_off_sends_nothing(self):
        r = self.ring(one_unsigned(), conf={"house": "live"})
        self.assertEqual(r.ops("alert", "house")[0]["dry"], False)
        self.assertIn("| empty dry ", r.summary)
        self.state.unlink()
        r = self.ring(one_unsigned(), conf={"house": "off", "version": "off", "empty": "off"})
        self.assertEqual(r.ops("alert") + r.ops("count") + r.ops("version"), [])
        self.assertTrue(r.summary.startswith("bell: house off | version first | empty off | prune "), r.summary)

    def test_bad_conf_skips(self):
        for conf in ("{nope", "[]", json.dumps({"house": "loud"}), json.dumps({"house": True}),
                     json.dumps({"bells": "live"})):
            r = self.ring(one_unsigned(), conf=conf)
            self.skipped(r, "conf")
        self.conf.unlink()
        self.conf.mkdir()
        self.skipped(self.ring(one_unsigned()), "conf")

    def test_bad_state_skips_and_keeps_file(self):
        for text in ("{broken", "[]", json.dumps({"house_day": "today"}), json.dumps({"day": TODAY}),
                     json.dumps({"finals": {"1": "%%%"}}), json.dumps({"version_sent": "v2"}),
                     json.dumps({"version_seen": {"v": "rc.1"}})):
            r = self.ring(one_unsigned(), state=text)
            self.skipped(r, "state")
            self.assertEqual(self.state.read_text(), text)

    def test_state_folder_missing(self):
        self.page.write_text(one_unsigned().html())
        argv = self.argv()
        argv[argv.index("--state") + 1] = str(self.dir / "no-such-folder" / "state.json")
        self.skipped(self.ring(argv=argv), "state")

    def test_fake_answers_bad(self):
        self.answers.write_text('{"not": "a list"}')
        r = self.ring(one_unsigned(), extra=["--fake-answers", str(self.answers)])
        self.skipped(r, "fake-answers")
        r = self.ring(one_unsigned(), extra=["--fake-answers", str(self.dir / "missing.json")])
        self.skipped(r, "fake-answers")

    def test_busy_lock(self):
        import fcntl
        self.page.write_text(one_unsigned().html())
        fd = os.open(str(self.state) + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.skipped(self.ring(), "busy")
        finally:
            os.close(fd)
        self.assertEqual(len(self.ring().ops("alert", "house")), 1)


# ====================================================================== common guards (SPEC 7.2)

class TestGuards(Base):
    def assertAlerts(self, r):
        self.assertEqual(len(r.ops("alert", "house")), 1, r.summary)

    def assertGuard(self, r, reason):
        self.assertEqual(r.ops("alert") + r.ops("count"), [], r.summary)
        self.assertIn("house dry skip(%s)" % reason, r.summary)
        self.assertIn("empty dry skip(%s)" % reason, r.summary)

    def test_baseline_alerts_and_stores_reading(self):
        r = self.ring(one_unsigned())
        self.assertAlerts(r)
        st = self.read_state()
        self.assertEqual((st["day"], st["signed"]), (TODAY, 29))
        self.assertEqual(sorted(st["finals"]), [str(TODAY - i) for i in range(5, 0, -1)])

    def test_newest_day_must_be_today(self):
        t = one_unsigned()
        t.days[-1]["cycle_day"] = TODAY - 1
        self.assertGuard(self.ring(t), "day")
        t.days[-1]["cycle_day"] = TODAY + 1
        self.assertGuard(self.ring(t), "day")

    def test_newest_day_not_final(self):
        t = one_unsigned()
        t.days[-1]["final"] = True
        self.assertGuard(self.ring(t), "final")

    def test_newest_day_not_old_chain(self):
        t = one_unsigned()
        t.days[-1]["old_chain"] = True
        self.assertGuard(self.ring(t), "old-chain")
        t.days[-1]["old_chain"] = False
        self.assertAlerts(self.ring(t))

    def test_captured_age_edges(self):
        t = one_unsigned()
        t.days[-1]["captured"] = stamp(NOW - 2700)
        self.assertAlerts(self.ring(t, now=NOW))
        self.state.unlink()
        self.assertGuard(self.ring(t, now=NOW + 1), "stale")

    def test_captured_future_edges(self):
        t = one_unsigned()
        t.days[-1]["captured"] = stamp(NOW + 300)
        self.assertAlerts(self.ring(t, now=NOW))
        self.state.unlink()
        self.assertGuard(self.ring(t, now=NOW - 1), "future")

    def test_captured_bad(self):
        t = one_unsigned()
        for bad in ("2026-11-13 12:00", "20261113T1200", None, 12):
            t.days[-1]["captured"] = bad
            self.assertGuard(self.ring(t), "captured")

    def test_final_bytes_first_run_stores_then_must_match(self):
        t = one_unsigned()
        self.assertAlerts(self.ring(t))
        stored = self.read_state()["finals"]
        self.assertEqual(len(stored), 5)
        # same bytes again (next day's run would also see them) -> fine
        st = self.read_state()
        st.pop("house_day")
        st.pop("empty_day")
        self.assertAlerts(self.ring(t, state=st))
        # one byte of an old final day changed -> history guard, stored bytes are kept
        t2 = one_unsigned()
        t2.rows[1][3] = U
        st = self.read_state()
        st.pop("house_day")
        st.pop("empty_day")
        r = self.ring(t2, state=st)
        self.assertGuard(r, "history")
        self.assertEqual(self.read_state()["finals"], stored)

    def test_final_bytes_may_grow(self):
        t = one_unsigned()
        old = {str(TODAY - 5 + i): base64.b64encode(bytes(t.rows[i][:25])).decode() for i in range(5)}
        r = self.ring(t, state={"finals": old})
        self.assertAlerts(r)
        self.assertEqual(len(base64.b64decode(self.read_state()["finals"][str(TODAY - 1)])), 30)
        # shorter than stored -> history
        old = {str(TODAY - 1): base64.b64encode(bytes([S] * 31)).decode()}
        self.assertGuard(self.ring(t, state={"finals": old}), "history")

    def test_old_chain_final_days_keyed_apart(self):
        t = one_unsigned()
        t.days[0]["old_chain"] = True
        t.days[1]["cycle_day"] = t.days[0]["cycle_day"]   # same day number on both chains
        self.assertAlerts(self.ring(t))
        keys = sorted(self.read_state()["finals"])
        self.assertIn(str(TODAY - 5) + "o", keys)
        self.assertIn(str(TODAY - 5), keys)

    def test_days_must_be_in_order(self):
        def swapped(t):
            """Same facts, the oldest and the latest final day listed the other way round."""
            t.days[0], t.days[4] = t.days[4], t.days[0]
            t.rows[0], t.rows[4] = t.rows[4], t.rows[0]
            return t
        # control: house 4 unsigned on the last 3 final days and today -> pause, not an alert
        t = Town(30)
        t.today(4, U).hist(4, S, U, U, U)
        r = self.ring(t)
        self.assertEqual([q["m"] for q in r.ops("alert")], [{"4": [1, 1]}])
        self.assertEqual(r.ops("alert", "pause")[0]["m"], {"4": [1, 1]})
        # the same page with two final days swapped: no alert of any kind (it would be an alert instead of
        # the pause), also with the stored bytes of the run above (the history guard is keyed by day number)
        st = self.read_state()
        st.pop("house_day")
        st.pop("empty_day")
        t2 = Town(30)
        t2.today(4, U).hist(4, S, U, U, U)
        r = self.ring(swapped(t2), state=st)
        self.assertGuard(r, "order")
        # the ratio guard reference: today 23/30, latest final 30/30 -> below-final; listed out of order the
        # oldest final (20/30) would become the reference and 7 alerts would go out
        t3 = Town(30)
        for h in range(1, 8):
            t3.today(h, U)
        t3.rows[0] = [U] * 10 + [S] * 20
        self.state.unlink()
        self.assertGuard(self.ring(t3), "below-final")
        self.state.unlink()
        self.assertGuard(self.ring(swapped(t3)), "order")
        # a day number twice (not old chain), or a middle day newer than today
        for j, cd in ((3, TODAY - 3), (2, TODAY + 3)):
            t4 = one_unsigned()
            t4.days[j]["cycle_day"] = cd
            self.state.unlink()
            self.assertGuard(self.ring(t4), "order")
        # old-chain days are not used by the rules: their numbers may be anywhere
        t5 = one_unsigned()
        t5.days.insert(2, {"cycle_day": TODAY - 30, "final": True, "captured": stamp((TODAY - 30) * DAY + 80000),
                           "old_chain": True})
        t5.rows.insert(2, [S] * 30)
        self.state.unlink()
        self.assertAlerts(self.ring(t5))

    def test_taking_at_least_20(self):
        t = Town(30)
        for h in range(21, 31):
            t.all_days(h, E)
        t.today(7, U)
        self.assertAlerts(self.ring(t))              # 20 taking
        t.all_days(20, E)
        self.state.unlink()
        self.assertGuard(self.ring(t), "few")        # 19 taking

    def test_signed_ratio_at_least_70(self):
        t = Town(30)
        for h in range(1, 10):                          # 21 of 30 signed today and on the last final day
            t.today(h, U).hist(h, S, S, S, U)
        r = self.ring(t)
        self.assertNotIn("skip(", r.summary)
        t.today(10, U)                                  # 20 of 30
        self.state.unlink()
        self.assertGuard(self.ring(t), "low")

    def test_ratio_not_far_below_last_final(self):
        t = Town(30)
        for h in range(1, 7):                           # today 24/30 = 0.80
            t.today(h, U)
        for h in range(1, 4):                           # last final 27/30 = 0.90 -> 0.80 >= 0.80 ok
            t.hist(h, U)
        r = self.ring(t)
        self.assertNotIn("skip(", r.summary)
        self.assertEqual(len(r.ops("alert", "house")), 1)
        t.hist(3, S)                                    # last final 28/30 -> below
        self.state.unlink()
        self.assertGuard(self.ring(t), "below-final")

    def test_ratio_reference_skips_old_chain_final(self):
        t = Town(30)
        for h in range(1, 7):                           # today 0.80
            t.today(h, U)
        t.days.insert(5, {"cycle_day": TODAY - 1, "final": True, "captured": stamp(NOW - 9000),
                          "old_chain": True})
        t.rows.insert(5, [S] * 30)                      # old-chain day all signed (1.0) is not the reference
        for h in range(1, 4):
            t.rows[4][h - 1] = U                        # newest final, not old chain: 0.90
        r = self.ring(t)
        self.assertNotIn("skip(", r.summary)

    def test_no_final_day(self):
        t = Town(30, finals=0).today(7, U)
        self.assertGuard(self.ring(t), "no-final")

    def test_signed_must_not_drop(self):
        t = one_unsigned()                              # 29 signed
        self.assertAlerts(self.ring(t, state={"day": TODAY, "signed": 31}))
        self.assertEqual(self.read_state()["signed"], 29)
        r = self.ring(t, state={"day": TODAY, "signed": 32})
        self.assertGuard(r, "drop")
        self.assertEqual(self.read_state()["signed"], 32)   # a failed reading does not become the base
        self.assertAlerts(self.ring(t, state={"day": TODAY - 1, "signed": 99}))

    def test_bad_house_data(self):
        t = one_unsigned()
        t.releases = [["rc.6", ymd(NOW)]]
        d = t.data()
        d["homes"]["days"] = d["homes"]["days"][:-1]
        text = t.html().replace("  var DATA = %s;" % json.dumps(t.data()), "  var DATA = %s;" % json.dumps(d))
        r = self.ring(text, state={"version_sent": "rc.5", "version_seen": {"v": "rc.6", "first": NOW - 7200}})
        self.assertGuard(r, "data")
        self.assertEqual(len(r.ops("version")), 1)      # the version note does not use house data
        for bad in ([[0, 0]], [["0", 0, 1]], [[0, 0, "g"]]):
            d = t.data()
            d["homes"]["list"] = bad + d["homes"]["list"][1:]
            text = "  var DATA = %s;\n" % json.dumps(d)
            self.assertGuard(self.ring(text), "data")
        d = t.data()
        d["homes"]["days"][-1] = "@@@"
        self.assertGuard(self.ring("  var DATA = %s;\n" % json.dumps(d)), "data")
        d = t.data()
        d["homes"]["days"][-1] = base64.b64encode(bytes([S] * 31)).decode()   # more bytes than houses
        self.assertGuard(self.ring("  var DATA = %s;\n" % json.dumps(d)), "data")

    def test_base64_without_padding(self):
        t = one_unsigned(31)
        d = t.data()
        d["homes"]["days"] = [s.rstrip("=") for s in d["homes"]["days"]]
        r = self.ring("  var DATA = %s;\n" % json.dumps(d))
        self.assertEqual(r.ops("alert", "house")[0]["m"], {"7": [1, 1]})


# ====================================================================== window and once a day

class TestWindow(Base):
    def at(self, left):
        now = CLOSE - left
        t = Town(30, now=now).today(7, U)
        if self.state.exists():
            self.state.unlink()
        return self.ring(t, now=now)

    def test_window_edges(self):
        for left, acts in ((4499, False), (4500, True), (11700, True), (11701, False)):
            r = self.at(left)
            self.assertEqual(len(r.ops("alert", "house")), 1 if acts else 0, (left, r.summary))
            self.assertEqual(len(r.ops("count")), 1 if acts else 0, left)
            if not acts:
                self.assertIn("house dry wait", r.summary)
                self.assertIn("empty dry wait", r.summary)
            else:
                self.assertEqual(r.ops("alert", "house")[0]["close"], CLOSE)

    def test_once_a_day(self):
        t = one_unsigned().today(8, E)                 # house 8 also went empty today
        r1 = self.ring(t)
        self.assertEqual(len(r1.ops("alert", "house")), 1)
        self.assertEqual(len(r1.ops("alert", "empty")), 1)
        st = self.read_state()
        self.assertEqual((st["house_day"], st["empty_day"]), (TODAY, TODAY))
        r2 = self.ring(t, now=NOW + 600)
        self.assertEqual(r2.ops("alert") + r2.ops("count"), [])
        self.assertIn("house dry done", r2.summary)
        self.assertIn("empty dry done", r2.summary)
        # next day it may ring again
        t3 = Town(30, now=NOW + DAY).today(7, U)
        st = self.read_state()
        st.pop("finals")
        st.pop("day")
        st.pop("signed")
        r3 = self.ring(t3, now=NOW + DAY, state=st)
        self.assertEqual(len(r3.ops("alert", "house")), 1)


# ====================================================================== house rules (SPEC 7.3)

class TestHouse(Base):
    def house_maps(self, t, **kw):
        r = self.ring(t, **kw)
        m = {}
        for q in r.ops("alert", "house"):
            m.update(q["m"])
        p = {}
        for q in r.ops("alert", "pause"):
            p.update(q["m"])
        return m, p, r

    def test_message_body(self):
        r = self.ring(one_unsigned(), conf={"house": "live"})
        q = r.ops("alert", "house")
        self.assertEqual(q, [{"op": "alert", "k": "house", "day": TODAY, "close": CLOSE, "m": {"7": [1, 1]},
                              "after": 0, "lim": 6, "dry": False}])
        self.assertEqual(r.ops("count"), [{"op": "count", "hs": [7]}])
        self.assertEqual([x["op"] for x in r.reqs], ["count", "alert", "prune"])

    def test_first_day_house_excluded(self):
        t = one_unsigned()
        t.today(9, U).first(9, t.last)                  # new today, not signed: no alert
        t.today(10, U).first(10, t.last - 1)            # came yesterday: alert
        m, p, r = self.house_maps(t)
        self.assertEqual(m, {"7": [1, 1], "10": [1, 1]})
        self.assertIn("unsigned=2", r.summary)

    def test_quiet_rule_pause_on_4th_day_then_silent(self):
        t = Town(30)
        t.today(3, U).hist(3, S, S, S, U, U)            # 3rd unsigned day: alert
        t.today(4, U).hist(4, S, S, U, U, U)            # 4th unsigned day: pause
        t.today(5, U).hist(5, S, U, U, U, U)            # 5th: silent
        t.today(6, U).hist(6, U, U, U, U, U)            # 6th: silent
        t.today(7, U).hist(7, S, S, U, E, U)            # an empty day breaks the run: alert
        m, p, r = self.house_maps(t)
        self.assertEqual(m, {"3": [1, 1], "7": [1, 1]})
        self.assertEqual(p, {"4": [1, 1]})
        self.assertIn("unsigned=5 alert=2 pause=1 silent=2 groups=2", r.summary)
        self.assertEqual(r.ops("alert", "pause")[0], {"op": "alert", "k": "pause", "day": TODAY,
                                                     "m": {"4": [1, 1]}, "after": 0, "lim": 6, "dry": True})
        self.assertEqual([x["op"] + ":" + x.get("k", "") for x in r.reqs],
                         ["count:", "alert:house", "count:", "alert:pause", "prune:"])

    def test_fewer_than_3_final_days_never_quiet(self):
        t = Town(30, finals=2)
        t.today(3, U).hist(3, U, U)
        m, p, r = self.house_maps(t)
        self.assertEqual((m, p), ({"3": [1, 1]}, {}))

    def test_exactly_3_final_days_all_unsigned_pause(self):
        t = Town(30, finals=3)
        t.today(3, U).hist(3, U, U, U)
        m, p, r = self.house_maps(t)
        self.assertEqual((m, p), ({}, {"3": [1, 1]}))

    def test_old_chain_days_not_counted_in_quiet_rule(self):
        t = Town(30, finals=5)
        t.days[3]["old_chain"] = True                   # F = [0, 1, 2, 4]
        t.today(3, U)
        for j in (1, 2, 4):
            t.rows[j][2] = U
        t.rows[3][2] = S                                # signed on the old chain: ignored
        m, p, r = self.house_maps(t)
        self.assertEqual(p, {"3": [1, 1]})              # F[-1..-3] unsigned, F[-4] (day 0) signed

    def test_group_maths(self):
        t = Town(200)                                   # enough signed houses for the ratio guards
        t.group(9100, 1, 2, 3)
        t.today(1, U)                                   # alert
        t.today(3, E)                                   # empty today: in m, not in `of`
        t.group(9101, 4, 5)
        t.today(4, U).today(5, U).hist(5, U, U, U, U)   # 4 alert, 5 silent -> n=2, of=2
        t.group(9102, 6, 7)
        t.today(6, U).today(7, U).first(7, t.last)      # 7 is new today: not in n/of, but in m
        t.group(9103, 8, 9)
        t.today(8, U).hist(8, S, U, U, U)               # pause only -> pause map, whole group
        t.group(9104, 10)
        t.today(10, U).hist(10, U, U, U, U)             # silent only -> nothing
        t.group(9105, 11, 12)
        t.today(11, U).hist(11, S, U, U, U)             # pause + alert in one group -> m, [2, 2]
        t.today(12, U)
        t.group(9106, 13, 14, 15)
        t.today(13, U).today(14, U).today(15, U)        # 3 of 3
        m, p, r = self.house_maps(t)
        self.assertEqual(m, {"1": [1, 2], "2": [1, 2], "3": [1, 2], "4": [2, 2], "5": [2, 2],
                             "6": [1, 1], "7": [1, 1], "11": [2, 2], "12": [2, 2],
                             "13": [3, 3], "14": [3, 3], "15": [3, 3]})
        self.assertEqual(p, {"8": [1, 1], "9": [1, 1]})
        self.assertIn("groups=5", r.summary)
        self.assertEqual(r.ops("count")[0]["hs"], [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15])
        self.assertEqual(r.ops("count")[1]["hs"], [8, 9])

    def test_null_group_is_its_own_group(self):
        t = Town(30)
        t.list[0][2] = None
        t.list[1][2] = None
        t.today(1, U)
        m, p, r = self.house_maps(t)
        self.assertEqual(m, {"1": [1, 1]})

    def test_group_over_99_sends_1_of_1(self):
        t = Town(120)
        t.group(9007, *range(1, 121))
        t.today(5, U).today(6, U)
        m, p, r = self.house_maps(t)
        self.assertEqual(len(m), 120)
        self.assertEqual(set(map(tuple, m.values())), {(1, 1)})

    def test_summary_has_no_house_numbers(self):
        t = Town(150)
        t.group(9001, 101, 117, 143)
        t.today(117, U).today(143, U).today(120, E)
        t.today(131, U).hist(131, S, U, U, U)
        houses = {101, 117, 120, 131, 143}
        r = self.ring(t, answers=[ans(active=40, matched=3), ans(matched=3), ans(active=40, matched=1),
                                  ans(matched=1), ans(active=40, matched=1), ans(matched=1)])
        self.assertEqual(r.ops("alert", "house")[0]["m"], {"101": [2, 3], "117": [2, 3], "143": [2, 3]})
        self.assertEqual(r.ops("alert", "empty")[0]["m"], {"120": [1, 1]})
        nums = {int(x) for x in re.findall(r"[0-9]+", r.summary)}
        self.assertEqual(nums & houses, set(), r.summary)
        self.assertNotIn("synthetic-group-code", r.stdout + json.dumps(self.read_state()))


class TestBits(Base):
    """SPEC 7.1: 0 = not on the roster; otherwise the 8 (0x08) set = signed, as the page build writes it. The other bits may hold anything."""

    def test_only_bit_8_decides(self):
        t = Town(30)
        for j, row in enumerate(t.rows):
            for i in range(len(row)):
                row[i] = 0x08 | (1 + (i * 5 + j * 3) % 247)        # signed, the other bits vary
        t.today(7, 0xf6)                                           # not signed, many other bits set: alert
        t.today(4, 0x40).hist(4, 0xff, 0x02, 0x55, 0xf7)           # unsigned on F[-3..-1] + today: pause
        t.today(11, 0x03).hist(11, 0x01, 0xf7, 0x22, 0x10, 0x05)   # unsigned on all 5 finals + today: silent
        t.today(9, E).hist(9, 0x9b)                                # on the roster on F[-1], empty today
        r = self.ring(t)
        self.assertNotIn("skip(", r.summary)
        self.assertIn("house dry unsigned=3 alert=1 pause=1 silent=1 groups=1", r.summary)
        self.assertEqual(r.ops("alert", "house")[0]["m"], {"7": [1, 1]})
        self.assertEqual(r.ops("alert", "pause")[0]["m"], {"4": [1, 1]})
        self.assertEqual(r.ops("alert", "empty")[0]["m"], {"9": [1, 1]})
        self.assertEqual(self.read_state()["signed"], 26)          # 29 taking, 26 with the 8

    def test_ratio_guards_count_bit_8(self):
        t = Town(30)
        for j, row in enumerate(t.rows):
            for i in range(len(row)):
                row[i] = (((1 + (i * 5 + j * 3) % 247) & 0xf7) or 0x01) | (0x08 if i >= 9 else 0)   # 21 of 30 signed every day
        r = self.ring(t)
        self.assertNotIn("skip(", r.summary)
        self.assertEqual(self.read_state()["signed"], 21)
        t.rows[-1][9] &= 0xf7                                      # 20 of 30 today -> below 0.70
        self.state.unlink()
        self.assertIn("house dry skip(low)", self.ring(t).summary)


class TestInternal(Base):
    def test_unexpected_error_still_one_line_and_exit_0(self):
        """SPEC 7: always exit 0. An error that is not a known skip still gives exactly one fixed line."""
        t = Town(30)
        t.releases = [["rc.6", ymd(NOW)]]
        st = {"version_sent": "rc.5", "version_seen": {"v": "rc.6", "first": 0}}
        # --now at the top of its 12 digits: the date of a pending version note is past the calendar's end
        r = self.ring(t, now=999999999960, state=st)
        self.assertEqual((r.rc, r.stderr, r.lines), (0, "", ["bell: skipped (internal)"]))
        self.assertEqual(json.loads(self.state.read_text()), st)  # nothing half written
        # a page whose JSON nests too deep for the parser (RecursionError, not a ValueError)
        self.state.unlink()
        r = self.ring("  var DATA = {\"days\": %s1%s};\n" % ("[" * 200000, "]" * 200000))
        self.assertEqual((r.rc, r.stderr, r.lines), (0, "", ["bell: skipped (internal)"]))
        self.assertFalse(self.state.exists())


# ====================================================================== flood guards

class TestFlood(Base):
    def test_house_flood_edges(self):
        cases = (({"matched": 6, "active": 19}, True), ({"matched": 6, "active": 20}, False),
                 ({"matched": 5, "active": 0}, False), ({"matched": 0, "active": 0}, False),
                 ({"matched": 31, "active": 100}, True), ({"matched": 30, "active": 100}, False))
        for count, flooded in cases:
            if self.state.exists():
                self.state.unlink()
            r = self.ring(one_unsigned(), answers=[ans(**count)])
            self.assertEqual(len(r.ops("alert", "house")), 0 if flooded else 1, count)
            self.assertEqual("flood" in r.summary.split(" "), flooded, r.summary)
            if flooded:
                self.assertEqual(self.read_state()["house_day"], TODAY)

    def test_house_flood_also_stops_pause(self):
        t = one_unsigned()
        t.today(4, U).hist(4, S, U, U, U)
        r = self.ring(t, answers=[ans(matched=9, active=10)])
        self.assertEqual(r.ops("alert"), [])
        self.assertEqual(len(r.ops("count")), 1)

    def test_pause_has_its_own_guard(self):
        t = Town(30)
        t.today(4, U).hist(4, S, U, U, U)
        r = self.ring(t, answers=[ans(matched=9, active=10)])
        self.assertEqual(r.ops("alert"), [])
        self.assertIn("pause-flood", r.summary)

    def test_map_over_2000_is_a_flood_without_asking(self):
        t = Town(2001)
        t.group(9001, *range(1, 2002))
        t.today(1, U)
        r = self.ring(t)
        self.assertEqual(r.ops("count") + r.ops("alert", "house"), [])
        self.assertIn("flood", r.summary.split(" "))

    def test_empty_flood_is_separate(self):
        t = one_unsigned()
        for h in range(20, 27):
            t.today(h, E)
        r = self.ring(t, answers=[ans(matched=1, active=40), ans(), ans(matched=7, active=10)])
        self.assertEqual(len(r.ops("alert", "house")), 1)
        self.assertEqual(r.ops("alert", "empty"), [])
        self.assertRegex(r.summary, r"empty dry houses=7 matched=7 active=10 flood")
        self.assertEqual(self.read_state()["empty_day"], TODAY)


# ====================================================================== empty note (SPEC 7.4)

class TestEmpty(Base):
    def test_empty_transition(self):
        t = Town(30)
        t.today(5, E)                                   # took part on the last final day, empty today
        t.today(6, E).hist(6, E)                        # empty yesterday too
        t.today(7, E).first(7, t.last)                  # first day today
        t.today(8, E).hist(8, U)                        # on the roster but unsigned yesterday: counts
        t.today(9, E).hist(9, S, E)                     # empty on F[-1], on before
        r = self.ring(t, conf={"empty": "live"})
        q = r.ops("alert", "empty")
        self.assertEqual(q, [{"op": "alert", "k": "empty", "day": TODAY, "m": {"5": [1, 1], "8": [1, 1]},
                              "after": 0, "lim": 6, "dry": False}])
        self.assertEqual(r.ops("count")[-1], {"op": "count", "hs": [5, 8]})
        self.assertIn("empty live houses=2", r.summary)
        self.assertEqual(r.ops("alert", "house"), [])

    def test_empty_needs_window_and_guards(self):
        t = Town(30).today(5, E)
        r = self.ring(t, now=CLOSE - 4000)
        self.assertEqual(r.ops("alert"), [])
        self.assertIn("empty dry wait", r.summary)
        t.days[-1]["final"] = True
        r = self.ring(t)
        self.assertIn("empty dry skip(final)", r.summary)
        self.assertEqual(r.ops("alert"), [])


# ====================================================================== live loops, failures, request cap

class TestLive(Base):
    def test_walk_follows_after_until_more_false(self):
        r = self.ring(one_unsigned(), conf={"house": "live"},
                      answers=[ans(matched=1, active=40), ans(sent=6, matched=6, after=15, more=True),
                               ans(sent=1, matched=1, after=30, more=False)])
        q = r.ops("alert", "house")
        self.assertEqual([x["after"] for x in q], [0, 15])
        self.assertIn("hit=7 sent=7 gone=0 denied=0 failed=0", r.summary)
        self.assertEqual(self.read_state()["house_day"], TODAY)

    def test_denied_stop(self):
        t = one_unsigned()
        t.today(4, U).hist(4, S, U, U, U)               # also a pause house in its own group
        r = self.ring(t, conf={"house": "live"},
                      answers=[ans(matched=1, active=40), ans(denied=3, after=10, more=True),
                               ans(denied=1, after=20, more=True), ans(sent=1, after=30)])
        self.assertEqual(len(r.ops("alert", "house")), 2)
        self.assertEqual(r.ops("alert", "pause"), [])
        self.assertIn("denied-stop", r.summary)
        self.assertEqual(self.read_state()["house_day"], TODAY)

    def test_denied_rule_needs_half(self):
        r = self.ring(one_unsigned(), conf={"house": "live"},
                      answers=[ans(matched=1, active=40), ans(sent=5, denied=4, after=10, more=True),
                               ans(sent=1, after=20)])
        self.assertEqual(len(r.ops("alert", "house")), 2)
        self.assertNotIn("denied-stop", r.summary)
        self.state.unlink()
        r = self.ring(one_unsigned(), conf={"house": "live"},       # exactly half and 4 -> stop
                      answers=[ans(matched=1, active=40), ans(sent=4, denied=4, after=10, more=True),
                               ans(sent=1, after=20)])
        self.assertEqual(len(r.ops("alert", "house")), 1)
        self.assertIn("denied-stop", r.summary)
        self.state.unlink()
        r = self.ring(one_unsigned(), conf={"house": "live"},       # 3 denied is not enough
                      answers=[ans(matched=1, active=40), ans(denied=3, after=10, more=True),
                               ans(sent=1, after=20)])
        self.assertEqual(len(r.ops("alert", "house")), 2)

    def test_request_cap_400(self):
        many = [ans(matched=1, active=1000)] + [ans(after=i, more=True) for i in range(1, 600)]
        r = self.ring(one_unsigned(), conf={"house": "live"}, answers=many)
        self.assertEqual(len(r.reqs), 400)
        self.assertTrue(r.summary.startswith("bell: skipped (cap) | house live "), r.summary)
        self.assertIn("prune error", r.summary)
        self.assertNotIn("house_day", self.read_state())

    def test_after_must_move(self):
        r = self.ring(one_unsigned(), answers=[ans(matched=1, active=40), ans(after=5, more=True),
                                               ans(after=5, more=True)])
        self.assertEqual(len(r.ops("alert", "house")), 2)
        self.assertTrue(r.summary.startswith("bell: skipped (loop) | "), r.summary)
        self.assertEqual(r.ops("prune"), [])

    def test_network_error_exit_0_no_more_requests(self):
        t = one_unsigned()
        t.releases = [["rc.6", ymd(NOW)]]
        st = {"version_sent": "rc.5", "version_seen": {"v": "rc.6", "first": NOW - 8000}}
        r = self.ring(t, state=st, answers=[None])
        self.assertEqual(len(r.reqs), 1)
        self.assertTrue(r.summary.startswith("bell: skipped (net) | house dry "), r.summary)
        st = self.read_state()
        self.assertNotIn("house_day", st)
        self.assertEqual(st["version_sent"], "rc.5")
        self.assertNotIn("pruned_day", st)

    def test_http_error_and_bad_answers(self):
        for bad, reason in (({"_http": 503}, "http-503"), ({"ok": False}, "answer"), ("text", "answer"),
                            ({"ok": True, "active": -1, "matched": 0}, "answer"),
                            ({"ok": True, "active": "40", "matched": 0}, "answer")):
            if self.state.exists():
                self.state.unlink()
            r = self.ring(one_unsigned(), answers=[bad])
            self.assertTrue(r.summary.startswith("bell: skipped (%s) | " % reason), r.summary)
            self.assertEqual(len(r.reqs), 1)
        r = self.ring(one_unsigned(), answers=[ans(matched=1, active=9), {"ok": True, "sent": 0}])
        self.assertTrue(r.summary.startswith("bell: skipped (answer) | "), r.summary)

    def test_stop_file_appearing_mid_run_is_respected_by_asker(self):
        self.page.write_text(one_unsigned().html())
        sent = []

        def send(body):
            sent.append(body)
            self.stop.write_text("")
            return ans(matched=1, active=40)

        asker = MOD.Asker(send, [str(self.stop)])
        asker.ask({"op": "count", "hs": [7]})
        with self.assertRaises(MOD.AskError):
            asker.ask({"op": "count", "hs": [7]})
        self.assertEqual(len(sent), 1)

    def test_time_budget(self):
        clock = [0.0]
        asker = MOD.Asker(lambda body: ans(), [], mono=lambda: clock[0])
        asker.ask({"op": "prune"})
        clock[0] = MOD.TIME_BUDGET + 1
        with self.assertRaises(MOD.AskError):
            asker.ask({"op": "prune"})
        self.assertEqual(asker.failed, "time")


# ====================================================================== version note (SPEC 7.5)

class TestVersion(Base):
    def v(self, rel, state, now=NOW, conf=None, answers=None):
        t = Town(30, now=now)
        t.releases = [rel, ["rc.1", "2020-01-01"]]
        return self.ring(t, now=now, state=state, conf=conf, answers=answers)

    def test_first_run_stores_and_sends_nothing(self):
        r = self.v(["rc.17", ymd(NOW - DAY)], None)
        self.assertEqual(r.ops("version"), [])
        self.assertIn("| version first |", r.summary)
        st = self.read_state()
        self.assertEqual(st["version_sent"], "rc.17")
        self.assertEqual(st["version_seen"], {"v": "rc.17", "first": NOW})

    def test_first_run_with_an_old_release_still_stores(self):
        self.v(["rc.17", "2020-01-01"], None)
        self.assertEqual(self.read_state()["version_sent"], "rc.17")

    def test_new_version_waits_two_hours(self):
        st = {"version_sent": "rc.4", "version_seen": {"v": "rc.4", "first": NOW - 99999}}
        r = self.v(["rc.5", ymd(NOW)], st)
        self.assertEqual(r.ops("version"), [])
        self.assertIn("| version new |", r.summary)
        self.assertEqual(self.read_state()["version_seen"], {"v": "rc.5", "first": NOW})
        r = self.v(["rc.5", ymd(NOW)], None, now=NOW + 7199)
        self.assertEqual(r.ops("version"), [])
        self.assertIn("| version dry wait |", r.summary)
        r = self.v(["rc.5", ymd(NOW)], None, now=NOW + 7200)
        self.assertEqual(r.ops("version"), [{"op": "version", "v": "rc.5", "after": 0, "lim": 6, "dry": True}])
        self.assertEqual(self.read_state()["version_sent"], "rc.5")       # set in dry too
        r = self.v(["rc.5", ymd(NOW)], None, now=NOW + 9000)
        self.assertEqual(r.ops("version"), [])
        self.assertIn("| version none |", r.summary)

    def test_numeric_compare(self):
        st = {"version_sent": "rc.9", "version_seen": {"v": "rc.10", "first": NOW - 7200}}
        r = self.v(["rc.10", ymd(NOW)], st, conf={"version": "live"})
        self.assertEqual(r.ops("version"), [{"op": "version", "v": "rc.10", "after": 0, "lim": 6, "dry": False}])
        self.assertEqual(self.read_state()["version_sent"], "rc.10")
        st = {"version_sent": "rc.10", "version_seen": {"v": "rc.9", "first": NOW - 7200}}
        r = self.v(["rc.9", ymd(NOW)], st)
        self.assertEqual(r.ops("version"), [])
        self.assertEqual(self.read_state()["version_sent"], "rc.10")

    def test_release_date_rules(self):
        st = {"version_sent": "rc.4", "version_seen": {"v": "rc.5", "first": NOW - 7200}}
        for date, sends in ((ymd(NOW + DAY), False), (ymd(NOW - 8 * DAY), False), (ymd(NOW - 7 * DAY), True),
                            (ymd(NOW), True)):
            r = self.v(["rc.5", date], dict(st))
            self.assertEqual(len(r.ops("version")), 1 if sends else 0, date)

    def test_bad_release(self):
        st = {"version_sent": "rc.4", "version_seen": {"v": "rc.4", "first": NOW - 99999}}
        for rel in (["rc.17<script>", ymd(NOW)], ["rc.1000", ymd(NOW)], ["v1.2.3", ymd(NOW)],
                    ["rc.١", ymd(NOW)], ["rc.6", "13-11-2026"], ["rc.6", "2026-02-30"], "rc.6", []):
            t = Town(30)
            t.releases = [rel]
            r = self.ring(t, state=dict(st))
            self.assertIn("| version skip(release) |", r.summary)
            self.assertEqual(r.ops("version"), [])
            self.assertEqual(self.read_state()["version_seen"]["v"], "rc.4")

    def test_more_loop_and_error_keeps_unsent(self):
        st = {"version_sent": "rc.4", "version_seen": {"v": "rc.5", "first": NOW - 7200}}
        t = Town(30)
        t.releases = [["rc.5", ymd(NOW)]]
        r = self.ring(t, state=dict(st), conf={"version": "live"},
                      answers=[ans(sent=6, after=40, more=True), None])
        self.assertEqual([q["after"] for q in r.ops("version")], [0, 40])
        self.assertTrue(r.summary.startswith("bell: skipped (net) | "), r.summary)
        self.assertEqual(self.read_state()["version_sent"], "rc.4")
        r = self.ring(t, conf={"version": "live"}, answers=[ans(sent=6, after=40, more=True), ans(sent=2)])
        self.assertEqual(self.read_state()["version_sent"], "rc.5")
        self.assertIn("| version live hit=0 sent=8 gone=0 denied=0 failed=0 |", r.summary)

    def test_denied_stop_keeps_version_unsent(self):
        st = {"version_sent": "rc.5", "version_seen": {"v": "rc.6", "first": NOW - 7200}}
        r = self.v(["rc.6", ymd(NOW)], st, conf={"version": "live"},
                   answers=[ans(denied=4, after=10, more=True), ans(sent=1, after=20)])
        self.assertEqual(r.ops("version"), [{"op": "version", "v": "rc.6", "after": 0, "lim": 6, "dry": False}])
        self.assertIn("| version live hit=0 sent=0 gone=0 denied=4 failed=0 denied-stop |", r.summary)
        self.assertEqual(self.read_state()["version_sent"], "rc.5")        # not sent: the walk did not end
        # the next run tries again and, ending with more false, stores it
        r = self.v(["rc.6", ymd(NOW)], None, now=NOW + 600, conf={"version": "live"}, answers=[ans(sent=2)])
        self.assertEqual(len(r.ops("version")), 1)
        self.assertIn("| version live hit=0 sent=2 gone=0 denied=0 failed=0 |", r.summary)
        self.assertEqual(self.read_state()["version_sent"], "rc.6")

    def test_version_off_tracks_but_sends_nothing(self):
        st = {"version_sent": "rc.4", "version_seen": {"v": "rc.5", "first": NOW - 7200}}
        r = self.v(["rc.5", ymd(NOW)], st, conf={"version": "off"})
        self.assertEqual(r.ops("version"), [])
        self.assertIn("| version off |", r.summary)
        r = self.v(["rc.6", ymd(NOW)], None, conf={"version": "off"})
        self.assertEqual(self.read_state()["version_seen"], {"v": "rc.6", "first": NOW})

    def test_version_runs_outside_the_house_window(self):
        st = {"version_sent": "rc.4", "version_seen": {"v": "rc.5", "first": NOW - 99999}}
        r = self.v(["rc.5", ymd(NOW)], st, now=TODAY * DAY + 3600)
        self.assertEqual(len(r.ops("version")), 1)
        self.assertIn("house dry wait", r.summary)


# ====================================================================== housekeeping

class TestPrune(Base):
    def test_prune_once_a_day(self):
        r = self.ring(Town(30), answers=[ans(removed=3)])
        self.assertEqual(r.ops("prune"), [{"op": "prune"}])
        self.assertIn("| prune removed=3", r.summary)
        self.assertEqual(self.read_state()["pruned_day"], TODAY)
        r = self.ring(Town(30), now=NOW + 60)
        self.assertEqual(r.ops("prune"), [])
        self.assertTrue(r.summary.endswith("| prune done"), r.summary)
        st = self.read_state()
        st.pop("finals")
        r = self.ring(Town(30, now=NOW + DAY), now=NOW + DAY, state=st)
        self.assertEqual(r.ops("prune"), [{"op": "prune"}])


# ====================================================================== state file

class TestStateFile(Base):
    def test_mode_0600_and_replaced_atomically(self):
        self.state.write_text("{}")
        os.chmod(self.state, 0o644)
        ino = self.state.stat().st_ino
        self.ring(one_unsigned())
        s = self.state.stat()
        self.assertEqual(stat.S_IMODE(s.st_mode), 0o600)
        self.assertNotEqual(s.st_ino, ino)
        self.assertEqual(stat.S_IMODE(Path(str(self.state) + ".lock").stat().st_mode), 0o600)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()),
                         ["index.html", "state.json", "state.json.lock"])
        st = self.read_state()
        self.assertTrue({"day", "signed", "finals", "version_seen", "version_sent", "pruned_day",
                         "house_day", "empty_day"} >= set(st))

    def test_failed_write_keeps_old_file(self):
        self.state.write_text('{"house_day": 1}')
        with mock.patch.object(MOD.os, "replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                MOD.save_state(str(self.state), {"house_day": 2})
        self.assertEqual(self.state.read_text(), '{"house_day": 1}')
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["state.json"])

    def test_failed_write_is_reported_and_exit_0(self):
        self.page.write_text(one_unsigned().html())
        lines = []
        with mock.patch.object(MOD.os, "replace", side_effect=OSError("disk")):
            line = MOD.main(self.argv(), out=lines.append)
        self.assertTrue(line.endswith(" | state not-saved"), line)
        check_summary(self, line)
        self.assertFalse(self.state.exists())

    def test_state_holds_counts_and_public_bytes_only(self):
        self.ring(one_unsigned())
        st = self.read_state()
        self.assertEqual(set(st["finals"]), {str(TODAY - i) for i in range(1, 6)})
        for v in st["finals"].values():
            self.assertEqual(base64.b64decode(v), bytes([S] * 30))


# ====================================================================== real mode, without any network

class FakeResp:
    def __init__(self, body, status=200):
        self.status = status
        self._body = body

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    def __init__(self, answers=()):
        self.calls = []
        self.answers = list(answers)

    def open(self, req, timeout=None):
        self.calls.append((req, timeout))
        a = self.answers.pop(0) if self.answers else ans()
        return FakeResp(json.dumps(a).encode())


class Fake302(urllib.request.BaseHandler):
    handler_order = 100                         # before the real HTTPS handler: nothing leaves the process

    def __init__(self):
        self.calls = 0

    def https_open(self, req):
        self.calls += 1
        hdrs = email.message.Message()
        hdrs["Location"] = "https://elsewhere.example/api/bell/ring"
        resp = urllib.response.addinfourl(io.BytesIO(b""), hdrs, req.full_url, 302)
        resp.msg = "Found"
        return resp


class TestRealMode(Base):
    def setUp(self):
        super().setUp()
        self.key = self.dir / "ring.key"
        self.key.write_text(KEY_MARK + "\n")
        os.chmod(self.key, 0o600)
        self.page.write_text(one_unsigned().html())

    def real_argv(self, url=None, key=None):
        a = self.argv(fake=False) + ["--key-file", str(key or self.key)]
        if url is not None:
            a += ["--url", url]
        return a

    def no_net(self):
        """Any attempt to build an opener or open a URL fails the test."""
        boom = mock.Mock(side_effect=AssertionError("network used"))
        return (mock.patch.object(MOD, "make_opener", boom), mock.patch.object(urllib.request, "urlopen", boom),
                boom)

    def test_refuses_other_urls_before_any_request(self):
        bad = ("https://example.com", "http://6529town.com", "https://6529town.com/", "https://6529TOWN.com",
               "https://6529town.com:443", "https://6529town.com.example", "https://user" + chr(64) + "6529town.com",
               "https://6529town.com/x", "https://town.example.pages.dev", "")
        p1, p2, boom = self.no_net()
        with p1, p2:
            for url in bad:
                out = []
                line = MOD.main(self.real_argv(url), out=out.append)
                self.assertEqual(line, "bell: skipped (url)", url)
                self.assertEqual(out, [])
        boom.assert_not_called()
        self.assertFalse(self.state.exists())
        r = self.ring(argv=self.real_argv("https://example.com"))
        self.assertEqual(r.lines, ["bell: skipped (url)"])

    def test_key_only_from_a_private_key_file(self):
        p1, p2, boom = self.no_net()
        with p1, p2:
            self.assertEqual(MOD.main(self.argv(fake=False)), "bell: skipped (key)")
            self.assertEqual(MOD.main(self.real_argv(key=self.dir / "missing.key")), "bell: skipped (key)")
            os.chmod(self.key, 0o640)
            self.assertEqual(MOD.main(self.real_argv()), "bell: skipped (key)")
            os.chmod(self.key, 0o600)
            short = self.dir / "short.key"
            short.write_text("x" * 31)
            os.chmod(short, 0o600)
            self.assertEqual(MOD.main(self.real_argv(key=short)), "bell: skipped (key)")
            spaced = self.dir / "spaced.key"
            spaced.write_text("a" * 20 + " " + "b" * 20)
            os.chmod(spaced, 0o600)
            self.assertEqual(MOD.main(self.real_argv(key=spaced)), "bell: skipped (key)")
            with mock.patch.dict(os.environ, {"BELL_KEY": KEY_MARK, "RING_KEY": KEY_MARK, "X_BELL_KEY": KEY_MARK}):
                self.assertEqual(MOD.main(self.argv(fake=False)), "bell: skipped (key)")
        boom.assert_not_called()
        src = SCRIPT.read_text()
        for word in ("environ", "getenv", "--key\"", "'--key'"):
            self.assertNotIn(word, src, word)

    def test_request_shape_and_no_req_lines(self):
        for url in MOD.ALLOWED_URLS:
            if self.state.exists():
                self.state.unlink()
            op = FakeOpener([ans(matched=1, active=40), ans(sent=1, matched=1)])
            out = []
            with mock.patch.object(MOD, "make_opener", lambda: op):
                line = MOD.main(self.real_argv(url) + ["--conf", str(self.dir / "none.json")], out=out.append)
            check_summary(self, line)
            self.assertEqual(out, [])
            self.assertNotIn(KEY_MARK, line)
            self.assertNotIn(KEY_MARK, self.state.read_text())
            self.assertEqual(len(op.calls), 3)
            for req, timeout in op.calls:
                self.assertEqual(req.full_url, url + "/api/bell/ring")
                self.assertEqual(req.get_method(), "POST")
                self.assertEqual(timeout, 20)
                self.assertEqual(req.get_header("X-bell-key"), KEY_MARK)
                self.assertEqual(req.get_header("User-agent"), "6529town-bell/1 (+https://6529town.com)")
                self.assertEqual(req.get_header("Content-type"), "application/json")
            self.assertEqual([json.loads(r.data)["op"] for r, _ in op.calls], ["count", "alert", "prune"])

    def test_real_mode_cap(self):
        op = FakeOpener([ans(matched=1, active=1000)] + [ans(after=i, more=True) for i in range(1, 600)])
        with mock.patch.object(MOD, "make_opener", lambda: op):
            line = MOD.main(self.real_argv())
        self.assertEqual(len(op.calls), 400)
        self.assertTrue(line.startswith("bell: skipped (cap) | "), line)

    def test_redirect_not_followed(self):
        opener = MOD.make_opener()
        reds = [h for h in opener.handlers if isinstance(h, urllib.request.HTTPRedirectHandler)]
        self.assertEqual([type(h) for h in reds], [MOD.NoRedirect])
        self.assertIsNone(reds[0].redirect_request(None, None, 302, "Found", {}, "https://elsewhere.example/"))
        with mock.patch.dict(os.environ, {"https_proxy": "http://proxy.invalid:9", "HTTPS_PROXY": "http://proxy.invalid:9"}):
            ours = MOD.make_opener()
            ctrl = urllib.request.build_opener()
        self.assertEqual([h for h in ours.handlers if isinstance(h, urllib.request.ProxyHandler)], [])
        self.assertTrue([h for h in ctrl.handlers if isinstance(h, urllib.request.ProxyHandler)])  # control
        fake = Fake302()
        opener.add_handler(fake)
        send = MOD.real_transport(MOD.ALLOWED_URLS[0], KEY_MARK, opener)
        with self.assertRaises(MOD.AskError) as cm:
            send({"op": "prune"})
        self.assertEqual(cm.exception.reason, "http-302")
        self.assertEqual(fake.calls, 1)
        # control: the default opener WOULD follow (so the check above means something)
        ctrl = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        fake2 = Fake302()
        ctrl.add_handler(fake2)
        with self.assertRaises(urllib.error.HTTPError):
            ctrl.open("https://6529town.com/api/bell/ring", data=b"{}", timeout=1)
        self.assertGreater(fake2.calls, 1)

    def test_network_failure_in_real_mode(self):
        class Down:
            def open(self, req, timeout=None):
                raise urllib.error.URLError("down")

        with mock.patch.object(MOD, "make_opener", lambda: Down()):
            line = MOD.main(self.real_argv())
        self.assertTrue(line.startswith("bell: skipped (net) | "), line)
        check_summary(self, line)

    def test_subprocess_real_mode_bad_key_exit_0(self):
        os.chmod(self.key, 0o644)
        r = self.ring(argv=self.real_argv())
        self.assertEqual(r.lines, ["bell: skipped (key)"])
        self.assertNotIn(KEY_MARK, r.stdout + r.stderr)


class TestSource(unittest.TestCase):
    def test_stdlib_only_and_no_secrets(self):
        src = SCRIPT.read_text()
        imports = set(re.findall(r"^(?:import|from) ([a-z0-9_.]+)", src, re.M))
        self.assertTrue(imports <= {"argparse", "base64", "binascii", "datetime", "fcntl", "http.client", "json",
                                    "os", "re", "ssl", "sys", "tempfile", "time", "urllib.error",
                                    "urllib.request", "fractions"}, imports)
        self.assertNotIn("@", src)
        self.assertNotRegex(src, r"/(root|home|etc)/")
        self.assertNotRegex(src, r"0x[0-9a-fA-F]{40}")
        self.assertNotRegex(src, r"\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b")
        self.assertNotRegex(src, r"(?<![_a-z])print\(")


if __name__ == "__main__":
    unittest.main()

# Puts the two pictures of a notification INSIDE site/sw.js as base64 text, so showing a notification needs no download.
#   BELL_ICON  <- site/icon-192.png    (the picture in the notification; the same file is the site's icon)
#   BELL_BADGE <- icons/badge.png      (the small status-bar sign: white on see-through)
# usage (any folder):  python3 -I embed-pics.py           rewrites the two statements in site/sw.js (same result every run)
#                      python3 -I embed-pics.py --check   changes nothing; exit 1 if site/sw.js is not up to date
# test/sw.test.mjs checks the same thing from the other side: the values inside sw.js equal the two files byte for byte.
import base64, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SW = os.path.join(HERE, "site", "sw.js")
PICS = {"icon-192.png": os.path.join(HERE, "site", "icon-192.png"), "badge.png": os.path.join(HERE, "icons", "badge.png")}
HEAD = "data:image/png;base64,"
WIDTH = 76
NOTE = ("/* The two pictures of a notification are kept inside this file as base64 text, so showing one needs no download.\n"
        "   BELL_ICON is icon-192.png, BELL_BADGE is badge.png (white on see-through, for the status bar).\n"
        "   Made by embed-pics.py; do not change by hand. */\n")
ONE = r'var %s = "data:image/png;base64," \+\n(?:  "[A-Za-z0-9+/=]{1,76}" \+\n)*  "[A-Za-z0-9+/=]{1,76}";\n'


def statement(name, file_name):
    raw = open(PICS[file_name], "rb").read()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) < 20000, file_name
    b64 = base64.b64encode(raw).decode("ascii")
    rows = [b64[i:i + WIDTH] for i in range(0, len(b64), WIDTH)]
    return 'var %s = "%s" +\n' % (name, HEAD) + " +\n".join('  "%s"' % r for r in rows) + ";\n"


want = NOTE + statement("BELL_ICON", "icon-192.png") + statement("BELL_BADGE", "badge.png")
text = open(SW, encoding="utf-8").read()
old_line = 'var BELL_ICON = "/icon-192.png";\n'
block = re.compile(re.escape(NOTE) + ONE % "BELL_ICON" + ONE % "BELL_BADGE")
if text.count(old_line) == 1 and not block.search(text):
    new = text.replace(old_line, want)
else:
    assert len(block.findall(text)) == 1, "site/sw.js: the picture block is not there exactly once"
    new = block.sub(lambda m: want, text)
new = new.replace("    badge: BELL_ICON\n", "    badge: BELL_BADGE\n")
assert new.count(want) == 1 and new.count("    icon: BELL_ICON,\n    badge: BELL_BADGE\n") == 1, "site/sw.js: unexpected shape"
assert new.count("data:") == 2 and new.count("BELL_ICON") == 3 and new.count("BELL_BADGE") == 3, "site/sw.js: unexpected shape"
if "--check" in sys.argv[1:]:
    print("site/sw.js pictures:", "up to date" if new == text else "NOT up to date")
    sys.exit(0 if new == text else 1)
if new != text:
    open(SW, "w", encoding="utf-8", newline="").write(new)
print("site/sw.js", "rewritten" if new != text else "unchanged", "| bytes", len(new.encode("utf-8")), "| lines", new.count("\n"))

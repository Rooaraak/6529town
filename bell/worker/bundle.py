#!/usr/bin/env python3
"""bundle.py: join src/push.js + src/api.js + src/main.js into ONE module, worker/_worker.js.

Run: python3 -I worker/bundle.py      (standard library only; paths are taken from this file's folder)

- every line starting with "import " is removed from the three sources;
- every "export { ... }" line of push.js and api.js is removed (main.js keeps its "export default");
- the joined text is refused (exit 1, nothing written) when it still holds an import line, an
  export line other than main.js's one "export default", a top-level name `fetch`, "require(",
  "process.", "Buffer", or a console call whose argument is not one plain string literal;
- "node --check" runs on a .mjs copy next to this file (removed again afterwards);
- only then worker/_worker.js is written (atomically).
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src"
OUT = HERE / "_worker.js"
CHECK_COPY = HERE / ".bundle-check.mjs"
PARTS = ("push.js", "api.js", "main.js")

IMPORT_LINE = re.compile(r"^import ")
EXPORT_LIST_LINE = re.compile(r"^export\s*\{[^}]*\}\s*;?\s*$")
LEFT_IMPORT = re.compile(r"^\s*import\b|\bimport\s*\(|^\s*\}\s*from\s*[\"']", re.M)
EXPORT_ANY = re.compile(r"^\s*export\b", re.M)
EXPORT_DEFAULT = re.compile(r"^export default \{\s*$", re.M)
TOP_FETCH = re.compile(
    r"^(?:async\s+)?function\s*\*?\s*fetch\s*\(|^(?:const|let|var|class)\s+fetch\b|^(?:const|let|var)\s*\{[^}]*\bfetch\b",
    re.M,
)
FORBIDDEN = ("require(", "process.", "Buffer")
CONSOLE_ANY = re.compile(r"\bconsole\b")
CONSOLE_LITERAL = re.compile(
    r"""console\.(?:log|info|warn|error|debug)\(\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*\)"""
)


def refuse(reason):
    print("bundle: refused (" + reason + ")")
    sys.exit(1)


def strip_part(name, text):
    out = []
    for line in text.splitlines():
        if IMPORT_LINE.match(line):
            continue
        if name != "main.js" and EXPORT_LIST_LINE.match(line):
            continue
        out.append(line)
    return "\n".join(out).rstrip("\n") + "\n"


def build():
    pieces = ["// _worker.js: made by bundle.py from src/push.js, src/api.js, src/main.js. Do not edit by hand.\n"]
    for name in PARTS:
        path = SRC / name
        if not path.is_file():
            refuse("missing src/" + name)
        text = path.read_text(encoding="utf-8")
        pieces.append("\n// ---------- src/" + name + " ----------\n")
        pieces.append(strip_part(name, text))
    return "".join(pieces)


def check_text(text):
    if LEFT_IMPORT.search(text):
        refuse("import left")
    exports = EXPORT_ANY.findall(text)
    if len(exports) != 1 or len(EXPORT_DEFAULT.findall(text)) != 1:
        refuse("exports: need exactly one 'export default {' and nothing else")
    if TOP_FETCH.search(text):
        refuse("top-level name fetch")
    for word in FORBIDDEN:
        if word in text:
            refuse("forbidden text " + word)
    plain = CONSOLE_LITERAL.sub("", text)
    if CONSOLE_ANY.search(plain):
        refuse("console call without a plain string literal")


def node_check(text):
    node = shutil.which("node")
    if not node:
        refuse("node not found")
    try:
        CHECK_COPY.write_text(text, encoding="utf-8")
        r = subprocess.run(
            [node, "--check", str(CHECK_COPY)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
    finally:
        try:
            CHECK_COPY.unlink()
        except FileNotFoundError:
            pass
    if r.returncode != 0:
        lines = r.stderr.decode("utf-8", "replace").strip().splitlines()
        print("\n".join(lines[-6:]))
        refuse("node --check failed")


def main():
    text = build()
    check_text(text)
    node_check(text)
    tmp = OUT.with_name(OUT.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o644)
    os.replace(tmp, OUT)
    print("bundle: ok (" + str(len(text.encode("utf-8"))) + " bytes, " + str(text.count("\n")) + " lines)")


if __name__ == "__main__":
    main()

#!/bin/bash
# READ-ONLY capture of your own validator's local Network page -> raw/<UTC stamp>/ (private), then a totals-only
# day record in data/days.json. The validator's link is an admin link: it is never printed and never logged.
# The link comes from (first that is set): TOWN_LINK, the output of TOWN_LINK_CMD, or "${VALIDATOR_BIN:-validator} open --print".
# usage: bash capture.sh      exit codes: 0 fine, 7 the date check refused the reading, 8 no link, 9 no day record, 1 other
set -uo pipefail
umask 077   # readings and day records are for this user only
M="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$M" || exit 1
log() { echo "$(date -u +%FT%TZ) $*"; }
# config.env is read without showing its lines (a broken line could hold your admin link). Every line must be empty,
# a # comment, or NAME=value with the value plain, in '...' or in "..." (no $ ` \ inside "..."); any other line is
# named by its number only. Then a first try in a subshell, then the settings are loaded for real.
if [[ -f "$M/config.env" ]]; then
  okline='^[[:blank:]]*(#.*)?$|^[A-Za-z_][A-Za-z0-9_]*=([A-Za-z0-9_./:@%+,=~?-]*|'"'[^']*'"'|"[^"`$\\]*")([[:blank:]]+#.*)?[[:blank:]]*$'
  n=0; badline=
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1)); [[ "$line" =~ $okline ]] || { badline=$n; break; }
  done < "$M/config.env"
  unset line
  [[ -z "$badline" ]] || { log "config.env line $badline is not a plain NAME=value line (not shown here; see config.example.env), so nothing was done."; exit 1; }
  ( set -a; . "$M/config.env" ) >/dev/null 2>&1 \
    || { log "config.env has a line the shell cannot read (not shown here), so nothing was done."; exit 1; }
  set -a; . "$M/config.env" >/dev/null 2>&1; set +a
fi
pick() { grep -oE 'http://127\.0\.0\.1:[0-9]+/[^[:space:]]+' | head -n1; }
if [[ -n "${TOWN_LINK:-}" ]]; then L=$(printf '%s\n' "$TOWN_LINK" | pick)
elif [[ -n "${TOWN_LINK_CMD:-}" ]]; then L=$(timeout 60 bash -c "$TOWN_LINK_CMD" 2>/dev/null | pick)
else L=$(timeout 60 "${VALIDATOR_BIN:-validator}" open --print 2>/dev/null | pick); fi
[[ -n "$L" ]] || { log "no link to the validator's local page (set TOWN_LINK or TOWN_LINK_CMD, or put the validator on PATH)"; exit 8; }
mkdir -p "$M/data" "$M/raw"; chmod 700 "$M/raw" "$M/data" 2>/dev/null
[[ -f "$M/data/days-old-chain.json" ]] || echo "[]" > "$M/data/days-old-chain.json"
OUT=$M/raw/$(date -u +%Y%m%dT%H%MZ); mkdir -p "$OUT"
LINK="$L" timeout 150 node "$M/net-capture.cjs" "$OUT" || { log "capture failed"; exit 1; }
G=$(python3 -I "$M/day-guard.py" "$OUT"); GR=$?
# the date check gives one sentence when it refuses; if it could not run at all, say that instead of nothing
[[ $GR -eq 0 || -n "$G" ]] || G="The date check could not run, so nothing was published."
log "$G"
if [[ $GR -ne 0 ]]; then
  # a refused reading must never be used by a later run: move it out of the way and keep only the newest refused one
  echo "$G" > "$M/.day-guard.msg"
  for old in "$M"/raw/refused-*; do [[ -d "$old" ]] && rm -rf "$old"; done
  mv "$OUT" "$M/raw/refused-$(basename "$OUT")"
  exit 7
fi
python3 "$M/parse-day.py" "$OUT" || { log "the reading could not be turned into a day record"; exit 9; }
exit 0

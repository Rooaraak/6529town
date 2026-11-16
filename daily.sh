#!/bin/bash
# 6529 Town update (every 2 hours, and once more after the day is final at 19:30 UTC):
#   1. read-only capture of your own validator's Network page -> data/days.json (totals only)
#   2. refuse to publish when the newest day is final but has no name, or when no finished day is recorded yet
#   3. Main Stage posters: top 3 of the vote from the public 6529.io ranking (sandboxed fetch; a failure never stops the update)
#   4. build (leak gate inside) -> numbers check (audit.py; one fresh reading if it fails) -> link-preview picture -> upload to Cloudflare Pages
# Settings come from the environment or from config.env next to this file (see config.example.env). usage: bash daily.sh
set -uo pipefail
umask 077   # what a run writes (log, readings, day records, a refused page) is for this user only
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH   # cron runs with a minimal PATH
M="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$M" || exit 1
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
  [[ -z "$badline" ]] || { echo "$(date -u +%FT%TZ) config.env line $badline is not a plain NAME=value line (not shown here; see config.example.env), so nothing was done." | tee -a "$M/daily.log"; exit 1; }
  ( set -a; . "$M/config.env" ) >/dev/null 2>&1 \
    || { echo "$(date -u +%FT%TZ) config.env has a line the shell cannot read (not shown here), so nothing was done." | tee -a "$M/daily.log"; exit 1; }
  set -a; . "$M/config.env" >/dev/null 2>&1; set +a
fi
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$M/daily.log"; }
fail() { # log, and (if TOWN_ALERT_WEBHOOK_FILE is set) tell the operator on Discord once per UTC day, not at every 2-hour try
  log "$1"; local today; today=$(date -u +%F)
  if [[ -n "${TOWN_ALERT_WEBHOOK_FILE:-}" && "$(cat "$M/.last-fail-day" 2>/dev/null)" != "$today" ]]; then
    if python3 - "$1" 2>/dev/null <<'PY'
import json, os, re, subprocess, sys
hook = json.load(open(os.environ["TOWN_ALERT_WEBHOOK_FILE"]))["alertWebhook"]
if not re.fullmatch(r'https://[^\s"\\]+', hook): sys.exit("the webhook file holds no https link")
body = json.dumps({"username": "6529 Town", "allowed_mentions": {"parse": []}, "embeds": [{"color": 0xE67E22, "title": "6529 Town update didn't run",
       "description": sys.argv[1] + "\nThe website keeps showing the last good version. It tries again in 2 hours."}]})
r = subprocess.run(["curl", "-s", "--fail", "-m", "20", "-o", "/dev/null", "-H", "content-type: application/json", "-d", body, "-K", "-"],
                   input='url = "%s"\n' % hook, text=True, timeout=40)   # the link is not on the command line
sys.exit(r.returncode)
PY
    then echo "$today" > "$M/.last-fail-day"   # only a message that went out counts as "told today"
    else log "the Discord alert could not be sent (the next failed run tries again)"
    fi
  fi
  exit "${2:-1}"
}
exec 9>"$M/.daily.lock"; flock -w 600 9 || { log "busy: another run holds the lock"; exit 1; }

timeout 400 bash capture.sh >> "$M/daily.log" 2>&1; crc=$?
# capture.sh's exit codes: 7 = the date check refused the reading (day-guard.py): say why, in its own words;
# 8 = no link to the validator's page; 9 = the pages were read but gave no day record; anything else = not read
if [[ $crc -eq 7 ]]; then fail "$(m=$(head -c 300 "$M/.day-guard.msg" 2>/dev/null); echo "${m:-The date check refused the reading, so nothing was published.}")" 6; fi
[[ $crc -eq 8 ]] && fail "The link to the validator's local page could not be found (the validator may be off, or the link setting in config.env is wrong)." 1
[[ $crc -eq 9 ]] && fail "The validator's pages were read, but they could not be turned into a day record (see daily.log)." 1
[[ $crc -eq 0 ]] || fail "Couldn't read the validator's Network page (the validator may be off or unreachable)." 1
check_day() {   # the final-day check: it runs for the first reading and again for a second one; what it prints goes to daily.log
python3 - >> "$M/daily.log" 2>&1 <<'EOF'
import json, sys
d = json.load(open("data/days.json"))
fin = [x for x in d if x.get("final")]
last = d[-1]
print("days:", len(d), "| newest:", last["label"], "final" if last.get("final") else "IN PROGRESS", "|", last.get("name"))
# a day that is final must have its name; a day still in progress (before 19:30 UTC, or a new day after midnight) is fine
if last.get("final") and not last.get("name"): sys.exit(4)
if not fin: sys.exit(3)
EOF
local g=$?
[[ $g -eq 3 ]] && fail "No finished day is recorded yet. The first one comes with a run between 19:30 UTC and midnight UTC." 2
[[ $g -eq 4 ]] && fail "The newest day was marked final but has no name, so it wasn't published." 2
[[ $g -eq 0 ]] || fail "The day record (data/days.json) could not be read, so nothing was published." 2
}
check_day
# Main Stage posters: other people's pictures are fetched and shrunk by "nobody" in a sandbox (no home folders, read-only
# system, only its own folder writable); build.py re-checks the file and never decodes a picture. If this fails the last
# posters stay for up to 12 hours, then the town shows none. With posters on, daily.sh (and so the headless
# browser it starts) runs as root, and the page shows pictures made from other people's art.
if [[ -n "${TOWN_STAGE_DIR:-}" && -n "${TOWN_STAGE_FETCH:-}" ]]; then
  export TOWN_STAGE="$TOWN_STAGE_DIR/stage.json"
  timeout 260 systemd-run --wait --collect --pipe --quiet -p User=nobody -p Group=nogroup -p NoNewPrivileges=yes \
    -p ProtectHome=yes -p ProtectSystem=strict -p PrivateTmp=yes -p PrivateDevices=yes -p ProtectKernelTunables=yes \
    -p ProtectControlGroups=yes -p RestrictSUIDSGID=yes -p ReadWritePaths="$TOWN_STAGE_DIR" -p MemoryMax=1500M \
    -p TasksMax=64 -p Nice=10 -p RuntimeMaxSec=230 -p Environment=HOME=/nonexistent -p WorkingDirectory="$TOWN_STAGE_DIR" \
    /usr/bin/python3 -I "$TOWN_STAGE_FETCH" "$TOWN_STAGE_DIR" < /dev/null >> "$M/daily.log" 2>&1 \
    || log "main stage posters: fetch failed (the last ones stay for up to 12 hours)"
else
  log "main stage posters: skipped (TOWN_STAGE_DIR / TOWN_STAGE_FETCH not set)"
fi
nice -n 10 python3 build.py >> "$M/daily.log" 2>&1 || fail "The build or the privacy check failed, so nothing was published." 3
# every number on the site must equal the validator's own page from the same capture (audit.py); one fresh try first
python3 audit.py >> "$M/daily.log" 2>&1; arc=$?
# 1 = a number differs (one fresh reading is tried); anything above 1 = the check itself could not run
[[ $arc -le 1 ]] || fail "The numbers check could not run (see daily.log), so nothing was published." 5
if [[ $arc -eq 1 ]]; then
  log "numbers check failed; capturing once more in 60 s"; sleep 60
  timeout 400 bash capture.sh >> "$M/daily.log" 2>&1; crc=$?
  if [[ $crc -eq 7 ]]; then fail "$(m=$(head -c 300 "$M/.day-guard.msg" 2>/dev/null); echo "${m:-The date check refused the reading, so nothing was published.}")" 6; fi
  [[ $crc -eq 8 ]] && fail "The link to the validator's local page could not be found at the second try (the validator may be off)." 1
  [[ $crc -eq 9 ]] && fail "The validator's pages were read a second time, but they could not be turned into a day record (see daily.log)." 1
  [[ $crc -eq 0 ]] || fail "Couldn't read the validator's Network page a second time (the validator may be off or unreachable)." 1
  check_day   # the second reading passes the same final-day check as the first
  nice -n 10 python3 build.py >> "$M/daily.log" 2>&1 || fail "The build or the privacy check failed, so nothing was published." 3
  python3 audit.py >> "$M/daily.log" 2>&1; arc=$?
  [[ $arc -le 1 ]] || fail "The numbers check could not run (see daily.log), so nothing was published." 5
  [[ $arc -eq 0 ]] || fail "The site's numbers didn't match the validator's own page, so nothing was published." 5
fi
timeout 200 node og.cjs >> "$M/daily.log" 2>&1 || log "preview picture failed (the old one stays, if there is one)"
if [[ -n "${CF_PROJECT:-}" ]]; then
  timeout 180 node deploy-cf.cjs >> "$M/daily.log" 2>&1 || fail "The upload to Cloudflare failed." 4
  DONE=published
else
  log "upload skipped (CF_PROJECT is not set): the finished site is in dist/site/"
  DONE="built, not uploaded"
fi
# the bell (optional, README.md): after a publish, bell/bell-ring.py asks the site's worker to ring the bells of houses
# that have not signed yet (and for a new validator version). Whatever it does, this run's result stays the same.
if [[ "$DONE" == published && -f "$M/bell-public.json" ]]; then
  if [[ -f "$M/bell.STOP" ]]; then
    log "bell: stopped (bell.STOP is there)"
  else
    timeout -k 10 300 python3 -I bell/bell-ring.py --page dist/site/index.html --state data/bell-state.json --conf bell.json \
      --stop bell.STOP --key-file "${TOWN_BELL_KEY_FILE:-}" < /dev/null >> "$M/daily.log" 2>&1 \
      || log "bell: the sender failed or took too long (the town itself was published)"
  fi
fi
# keep, for each day, the reading that its day record names (the houses are rebuilt from that one) and the newest
# one; other same-day captures go after a day
python3 - <<'PY' >> "$M/daily.log" 2>&1
import glob, json, os, shutil, time
keep, M = {}, os.getcwd()
try: named = {os.path.join(M, "raw", r["captured"]) for r in json.load(open(M + "/data/days.json")) if r.get("captured")}
except Exception: named = None   # no readable day record: delete nothing
for f in sorted(glob.glob(M + "/raw/2*/api.json")):
    try: cd = json.load(open(f))["/api/v1/network"]["cycle_day"]
    except Exception: continue
    keep.setdefault(cd, []).append(os.path.dirname(f))
gone = 0
for cd, dirs in keep.items():
    for d in dirs[:-1]:
        if named is not None and d not in named and time.time() - os.path.getmtime(d) > 86400 and os.path.basename(os.path.dirname(d)) == "raw":
            shutil.rmtree(d); gone += 1
print("pruned", gone, "old same-day captures")
PY
log "$DONE $(python3 -c "import json,sys;d=json.load(open(sys.argv[1]))[-1];print(d['label'], d['validators'], 'validators', 'final' if d.get('final') else 'in progress')" "$M/data/days.json")"

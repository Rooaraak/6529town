#!/bin/bash
# Puts the town's timer into this user's crontab: one run at 19:40 UTC (the final numbers of the day) and one every
# 2 hours at :45 (live numbers). The times assume the machine's clock is UTC. Your old crontab is saved first
# (crontab.bak-..., readable only by you, in .gitignore).
# usage: bash install-cron.sh
set -euo pipefail
umask 077
M="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$M" in *%*|*\'*) echo "This folder's path holds a % or a ' sign, which a crontab line cannot carry. Move the folder first."; exit 1;; esac
TAG="# 6529 Town website"
# the old crontab is saved first; only the answer "no crontab for <user>" counts as "there is none"
if old=$(LC_ALL=C crontab -l 2>/dev/null); then printf '%s\n' "$old" > "$M/crontab.bak-$(date -u +%Y%m%dT%H%MZ)"
elif [[ "$(LC_ALL=C crontab -l 2>&1 >/dev/null || true)" == *"no crontab for"* ]]; then old=""
else echo "Your crontab could not be read, so nothing was changed."; exit 1; fi
{ [[ -z "$old" ]] || printf '%s\n' "$old" | grep -vF "$TAG" || true
  echo "40 19 * * * /bin/bash '$M/daily.sh' >/dev/null 2>&1   $TAG: final numbers after 19:30 UTC"
  echo "45 */2 * * * /bin/bash '$M/daily.sh' >/dev/null 2>&1   $TAG: live numbers every 2 h"
} | crontab -
echo "Installed:"; crontab -l | grep -F "$TAG"

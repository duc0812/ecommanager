#!/usr/bin/env bash
set -euo pipefail

DB=/home/podmanager/dev.db
DIR=/root/db-backups
MIN_FREE_GB="${MIN_FREE_GB:-2}"
KEEP="${KEEP:-30}"
for var in KEEP MIN_FREE_GB; do
  if ! [[ "${!var}" =~ ^[1-9][0-9]*$ ]]; then
    echo "hourly-backup: $var must be an integer >= 1 (got '${!var}')" >&2
    exit 1
  fi
done
MIN_FREE=$(( MIN_FREE_GB * 1024 * 1024 * 1024 ))

mkdir -p "$DIR"
free=$(df --output=avail -B1 "$DIR" | tail -n 1 | tr -d ' ')
if [ "$free" -lt "$MIN_FREE" ]; then
  echo "hourly-backup: less than ${MIN_FREE_GB} GiB free in $DIR ($free bytes), not starting" >&2
  exit 1
fi

out="$DIR/dev-hourly-$(date -u +%Y%m%dT%H%M%SZ).db"
trap 'rm -f "$out"' ERR
python3 -c "
import sqlite3, sys
src = sqlite3.connect('file:$DB?mode=ro', uri=True)
src.execute(\"VACUUM INTO '\" + sys.argv[1] + \"'\")
src.close()
" "$out"
trap - ERR

ls -1t "$DIR"/dev-hourly-*.db | tail -n +$((KEEP + 1)) | xargs -r rm -f

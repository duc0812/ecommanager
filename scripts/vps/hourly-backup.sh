#!/usr/bin/env bash
set -euo pipefail

DB=/home/podmanager/dev.db
DIR=/root/db-backups
MIN_FREE=$((2 * 1024 * 1024 * 1024))
KEEP=30

mkdir -p "$DIR"
free=$(df --output=avail -B1 "$DIR" | tail -n 1 | tr -d ' ')
if [ "$free" -lt "$MIN_FREE" ]; then
  echo "hourly-backup: less than ${MIN_FREE_GB:-2} GiB free in $DIR ($free bytes), not starting" >&2
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

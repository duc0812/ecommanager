"""Copy the status of the local artwork library to prod, for the Design Studio checklist (owner 11-02: the checklist follows the local library).

    python scripts/sync-library-state.py [local dev.db] [--dry-run]

The library lives on the office PC, prod holds almost no ArtworkEntry rows. Only id, store, product, template, option and status go up, into one
AppSetting row. No ArtworkEntry row is written, so prod's auto-render does not see these entries. Run it again after the library changes.
"""
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

KEY = 'artwork_library_local_state'
HOST = 'root@178.105.170.0'
SSH_KEY = os.path.expanduser('~/.ssh/ecommanager_vps_ed25519')
REMOTE = r'''
import json, sqlite3, sys, datetime
c = sqlite3.connect('/home/podmanager/dev.db', timeout=30)
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
c.execute('INSERT INTO AppSetting (key, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt', (sys.argv[1], sys.stdin.read(), now))
c.commit()
print('prod row', len(c.execute('SELECT value FROM AppSetting WHERE key = ?', (sys.argv[1],)).fetchone()[0]), 'bytes')
'''


def main():
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    db = args[0] if args else 'D:/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh/dev.db'
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    rows = c.execute('SELECT id, storeId, shopifyProductId, printTemplateId, optionKey, status FROM ArtworkEntry').fetchall()
    payload = json.dumps({'syncedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'entries': [dict(r) for r in rows]}, ensure_ascii=False)
    counts = {}
    for r in rows:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    print(len(rows), 'entries', counts, len(payload), 'bytes')
    if '--dry-run' in sys.argv:
        return
    subprocess.run(['ssh', '-i', SSH_KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', HOST, f'python3 -c "$(cat <<\'PY\'\n{REMOTE}\nPY\n)" {KEY}'],
                   input=payload.encode('utf-8'), check=True)


if __name__ == '__main__':
    main()

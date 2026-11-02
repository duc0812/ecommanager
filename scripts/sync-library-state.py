"""Copy the status of the local artwork library to prod, for the Design Studio checklist (owner 11-02: the checklist follows the local library).

    python scripts/sync-library-state.py [local dev.db] [--dry-run]

The library lives on the office PC, prod holds almost no ArtworkEntry rows. Only id, store, product, template, option and status go up, into one
AppSetting row. No ArtworkEntry row is written, so prod's auto-render does not see these entries. Run it again after the library changes.

Flat-text specs (owner 11-03) count as READY too. A spec names a design and a supplier SKU, not a product or a template, so prod's order lines and
templates say which those are. FLAT_TEXT overrides the folder.
"""
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

KEY = 'artwork_library_local_state'
FLAT_TEXT = os.environ.get('FLAT_TEXT', 'D:/Ecom manager/artwork-builder/flat-text')
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

LOOKUP = r'''
import json, sqlite3, sys
c = sqlite3.connect('file:/home/podmanager/dev.db?mode=ro', uri=True, timeout=30)
c.row_factory = sqlite3.Row
lines = []
for d in json.load(sys.stdin):
    for r in c.execute('SELECT o.storeId, l.shopifyProductId, l.sku, l.resolvedSupplierId, l.resolvedSupplierSku FROM OrderLine l JOIN "Order" o ON o.id = l.orderId WHERE l.sku LIKE ? AND l.shopifyProductId IS NOT NULL AND l.resolvedSupplierId IS NOT NULL', ('%' + d + '%',)):
        lines.append(dict(r, design=d))
print(json.dumps({
    'lines': lines,
    'templates': [dict(r) for r in c.execute('SELECT id, supplierId, supplierSku FROM PrintTemplate')],
    'products': [dict(r) for r in c.execute('SELECT supplierId, sku, printTemplateId FROM SupplierProduct WHERE printTemplateId IS NOT NULL')],
    'profiles': [dict(r) for r in c.execute('SELECT storeId, shopifyProductId, printTemplateId FROM ProductProfile WHERE printTemplateId IS NOT NULL')],
}))
'''


def ssh(script, data, *args, **kw):
    remote = f'''python3 -c "$(cat <<'PY'\n{script}\nPY\n)" {' '.join(args)}'''
    return subprocess.run(['ssh', '-i', SSH_KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', HOST, remote], input=data, check=True, **kw)


def flat_text_specs():
    out = []
    for name in sorted(os.listdir(FLAT_TEXT)):
        path = os.path.join(FLAT_TEXT, name, 'spec.json')
        if name.startswith('_') or not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as f:
            spec = json.load(f)
        if spec.get('design'):
            out.append({'folder': name, 'design': spec['design'], 'skuContains': spec.get('skuContains'), 'supplierSku': spec.get('supplierSku')})
    return out


def template_picker(data):
    '''pickTemplate of src/lib/print-template-resolve.ts. exact=True answers only for a SKU the supplier really has.'''
    products = {(p['supplierId'], p['sku']): p['printTemplateId'] for p in data['products']}
    profiles = {(p['storeId'], p['shopifyProductId']): p['printTemplateId'] for p in data['profiles']}
    templates = data['templates']
    supplier_of = {t['id']: t['supplierId'] for t in templates}

    def pick(store, product, supplier, sku, exact=False):
        pinned = profiles.get((store, product))
        if pinned and supplier_of.get(pinned) == supplier:
            return pinned
        if sku and supplier_of.get(products.get((supplier, sku))) == supplier:
            return products[(supplier, sku)]
        mine = [t for t in templates if t['supplierId'] == supplier]
        low = (sku or '').lower()
        for t in mine:
            if low and t['supplierSku'] and t['supplierSku'].lower() == low:
                return t['id']
        if exact:
            return None
        near = sorted((t for t in mine if low and t['supplierSku'] and low.startswith(t['supplierSku'].lower())), key=lambda t: -len(t['supplierSku']))
        if near:
            return near[0]['id']
        bare = [t for t in mine if t['supplierSku'] is None]
        return bare[0]['id'] if bare else None
    return pick


def spec_covers(spec, supplier_sku):
    want = spec['supplierSku']
    return not want or supplier_sku == want or (supplier_sku or '').startswith(want + '-')


def flat_text_entries(specs, data):
    '''A spec covers the lines it matches, and its own SKU on the same products even before an order has that size.'''
    pick = template_picker(data)
    entries = {}

    def add(spec, store, product, template):
        if template:
            entries.setdefault((store, product, template), {'id': f"flat-text:{spec['folder']}", 'storeId': store, 'shopifyProductId': product, 'printTemplateId': template, 'optionKey': '', 'status': 'READY'})

    by_design = {}
    for line in data['lines']:
        by_design.setdefault(line['design'], []).append(line)
    for spec in specs:
        for line in by_design.get(spec['design'], []):
            if spec['skuContains'] and spec['skuContains'] not in line['sku']:
                continue
            where = (line['storeId'], line['shopifyProductId'])
            if spec_covers(spec, line['resolvedSupplierSku']):
                add(spec, *where, pick(*where, line['resolvedSupplierId'], line['resolvedSupplierSku']))
            if spec['supplierSku']:
                add(spec, *where, pick(*where, line['resolvedSupplierId'], spec['supplierSku'], exact=True))
    return list(entries.values())


def main():
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    db = args[0] if args else 'D:/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh/dev.db'
    c = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    c.row_factory = sqlite3.Row
    rows = [dict(r) for r in c.execute('SELECT id, storeId, shopifyProductId, printTemplateId, optionKey, status FROM ArtworkEntry')]
    specs = flat_text_specs()
    designs = json.dumps(sorted({s['design'] for s in specs})).encode('utf-8')
    flat = flat_text_entries(specs, json.loads(ssh(LOOKUP, designs, stdout=subprocess.PIPE).stdout))
    # A flat-text print answers for the whole template, so a whole-template library entry waiting on review must not hide it.
    covered = {(e['storeId'], e['shopifyProductId'], e['printTemplateId']) for e in flat}
    rows = [r for r in rows if r['status'] == 'READY' or r['optionKey'] or (r['storeId'], r['shopifyProductId'], r['printTemplateId']) not in covered] + flat
    payload = json.dumps({'syncedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'entries': rows}, ensure_ascii=False)
    counts = {}
    for r in rows:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    print(len(rows), 'entries', counts, 'flat-text', len(flat), 'from', len(specs), 'specs', len(payload), 'bytes')
    if '--dry-run' in sys.argv:
        return
    ssh(REMOTE, payload.encode('utf-8'), KEY)


if __name__ == '__main__':
    main()

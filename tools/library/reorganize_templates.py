"""Move LIBRARY\\suppliers\\<SUP>\\<BLANK>\\ (first layout, 29/10/2026) to LIBRARY\\templates\\<Product Type>\\<SUP> - <BLANK>\\.

    python tools/library/reorganize_templates.py            # dry run
    python tools/library/reorganize_templates.py --apply

Folders under an alias (KNCA, BAJE) merge into the Merchize catalog name (KNCAVN, BAJEVN). blank.json gains
productType + typeCode; the two blank.json of a merged folder are combined. Empty folders left behind are removed.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from library_paths import ALIASES, blank_dir, type_of  # noqa: E402

ROOT_DEFAULT = r'\\TMTEAM\TEMPLATE\LIBRARY'


def merge_json(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        if k not in out or out[k] in (None, [], {}):
            out[k] = v
        elif isinstance(out[k], list) and isinstance(v, list):
            out[k] = out[k] + [x for x in v if x not in out[k]]
    return out


def move_tree(src: Path, dest: Path, apply: bool, log) -> None:
    for f in sorted(p for p in src.rglob('*') if p.is_file()):
        rel = f.relative_to(src)
        target = dest / rel
        if rel.name == 'blank.json' and target.exists():
            if apply:
                merged = merge_json(json.loads(target.read_text(encoding='utf-8')), json.loads(f.read_text(encoding='utf-8')))
                target.write_text(json.dumps(merged, ensure_ascii=False, indent=1), encoding='utf-8')
                f.unlink()
            continue
        if target.exists() and target.stat().st_size == f.stat().st_size:
            if apply:
                f.unlink()
            continue
        if apply:
            target.parent.mkdir(parents=True, exist_ok=True)
            f.replace(target)
    log(f'  {src} -> {dest}')


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', default=ROOT_DEFAULT)
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args(argv)
    root = Path(a.root)
    old = root / 'suppliers'
    if not old.exists():
        print('nothing to move')
        return 0
    for sup_dir in sorted(p for p in old.iterdir() if p.is_dir()):
        for blank_old in sorted(p for p in sup_dir.iterdir() if p.is_dir()):
            sup, blank = sup_dir.name, ALIASES.get(blank_old.name, blank_old.name)
            dest = blank_dir(root, sup, blank)
            move_tree(blank_old, dest, a.apply, print)
            if a.apply:
                t = type_of(sup, blank)
                meta_path = dest / 'blank.json'
                try:
                    meta = json.loads(meta_path.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    meta = {'supplier': sup, 'blank': blank, 'status': 'UNCHECKED'}
                meta.update({'blank': blank, 'productType': t['name'] if t else None, 'typeCode': t['code'] if t else None})
                meta_path.parent.mkdir(parents=True, exist_ok=True)
                meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    if a.apply:
        for d in sorted((p for p in old.rglob('*') if p.is_dir()), key=lambda p: -len(p.parts)):
            if not any(d.iterdir()):
                d.rmdir()
        if not any(old.iterdir()):
            old.rmdir()
    print('done' if a.apply else 'dry run — add --apply')
    return 0


if __name__ == '__main__':
    sys.exit(main())

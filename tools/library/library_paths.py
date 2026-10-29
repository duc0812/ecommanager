"""Where a supplier blank lives in the design library: LIBRARY\\templates\\<Product Type>\\<SUPPLIER> - <BLANK>\\.

The product type comes from product_types.json (the shop's standard list, also the Shopify product_type to converge
on). A blank not in the list goes to templates\\_unsorted\\ until it is given a type.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALIASES = {'KNCA': 'KNCAVN', 'BAJE': 'BAJEVN'}


@lru_cache(maxsize=1)
def product_types() -> dict:
    return json.loads((HERE / 'product_types.json').read_text(encoding='utf-8'))


def type_of(supplier: str, blank: str) -> dict | None:
    blank = ALIASES.get(blank, blank)
    for t in product_types()['types']:
        if [supplier, blank] in t['blanks']:
            return t
    return None


def blank_dir(root: Path, supplier: str, blank: str) -> Path:
    blank = ALIASES.get(blank, blank)
    t = type_of(supplier, blank)
    return root / 'templates' / (t['name'] if t else '_unsorted') / f'{supplier} - {blank}'

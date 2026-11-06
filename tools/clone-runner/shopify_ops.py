"""Shared Shopify operations for every clone tool; the one place that builds variant SKUs from an issued code.

    python shopify_ops.py set-skus --product gid://shopify/Product/<id> --code <XX><YYMMDD><NNNN>
    python shopify_ops.py publish  --product gid://shopify/Product/<id>
    python shopify_ops.py state    --product gid://shopify/Product/<id> [--code <code>]

Environment: SHOPIFY_STORE (<name>.myshopify.com), SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_VERSION (default: the Litzzy clone
tool's). One ASCII JSON line on stdout. Exit 0 done; 1 Shopify refused (userErrors, an HTTP error) or a check failed;
2 bad arguments or environment. The token never appears in an output line. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

DEFAULT_API_VERSION = '2026-07'
TIMEOUT_S = 30
PAGE_SIZE = 250
MAX_PAGES = 20
CHUNK_SIZE = 100
PUBLISH_READS = 3
PUBLISH_WAIT_S = 5
MAX_REASON_CHARS = 1000
DEFAULT_TITLE = 'Default Title'

CODE_RE = re.compile(r'[A-Z]{2}\d{10}', re.ASCII)
GID_RE = re.compile(r'gid://shopify/Product/\d+', re.ASCII)
STORE_RE = re.compile(r'[a-z0-9][a-z0-9-]*\.myshopify\.com', re.ASCII)
VERSION_RE = re.compile(r'\d{4}-\d{2}', re.ASCII)
TOKEN_RE = re.compile(r'[\x21-\x7e]+')
NOT_SKU_CHAR = re.compile(r'[^A-Z0-9]')

UNREACHABLE = 'could not reach Shopify'
UNEXPECTED = 'unexpected answer from Shopify'
GRAPHQL_ERROR = 'Shopify GraphQL error'

VARIANTS_QUERY = '''query ProductVariants($id: ID!, $after: String) {
  product(id: $id) {
    options { name position }
    variants(first: %d, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku selectedOptions { name value } }
    }
  }
}''' % PAGE_SIZE

UPDATE_SKUS = '''mutation SetVariantSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    userErrors { field message }
  }
}'''

ACTIVATE = '''mutation ActivateProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id status }
    userErrors { field message }
  }
}'''

PRODUCT_QUERY = '''query ProductState($id: ID!) {
  product(id: $id) {
    status
    onlineStoreUrl
    handle
    productType
    variantsCount { count }
  }
}'''


class UsageError(Exception):
    """Bad arguments or environment: exit 2."""


class OpsError(Exception):
    """Shopify refused or a check failed: exit 1. The message is printed as the reason, so it must be safe to print."""


def _values(variant: dict) -> list[str]:
    return [option['value'] for option in variant['selectedOptions']]


def variant_suffix(option_values: list[str], position: int = 1) -> str:
    """Option values in option order, upper-cased and reduced to A-Z and 0-9, joined with '-'. A value that
    reduces to nothing becomes V<position>, the variant's 1-based place in the product's variant list."""
    parts = [NOT_SKU_CHAR.sub('', str(value).upper()) or f'V{position}' for value in option_values]
    return '-'.join(parts) or f'V{position}'


def sku_plan(code: str, variants: list[dict]) -> dict[str, str]:
    """Variant gid -> SKU. Each variant is {'id': gid, 'selectedOptions': [{'name', 'value'}, ...]} in option order."""
    if len(variants) == 1 and _values(variants[0]) == [DEFAULT_TITLE]:
        return {variants[0]['id']: code}
    plan: dict[str, str] = {}
    used: set[str] = set()
    for position, variant in enumerate(variants, start=1):
        base = f'{code}-{variant_suffix(_values(variant), position)}'
        sku, number = base, 2
        while sku in used:
            sku = f'{base}-{number}'
            number += 1
        used.add(sku)
        plan[variant['id']] = sku
    return plan


def sku_follows_code(code: str, sku) -> bool:
    return isinstance(sku, str) and (sku == code or sku.startswith(code + '-'))


def check_plan(code: str, plan: dict[str, str]) -> None:
    for sku in plan.values():
        if not sku_follows_code(code, sku):
            raise OpsError('a planned SKU does not start with the code')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Following a redirect would resend the token header to wherever it points.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_opener():
    return urllib.request.build_opener(NoRedirect())


class Shopify:
    def __init__(self, store: str, token: str, version: str, opener=None):
        self._base = f'https://{store}/admin/api/{version}/'
        self._token = token
        self._opener = opener or build_opener()

    def __repr__(self) -> str:
        return f'Shopify({self._base!r})'

    def _request(self, method: str, path: str, body: dict) -> dict:
        try:
            req = urllib.request.Request(
                self._base + path,
                data=json.dumps(body, ensure_ascii=True).encode('ascii'),
                method=method,
                headers={
                    'X-Shopify-Access-Token': self._token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'clone-runner/1',
                },
            )
            try:
                with self._opener.open(req, timeout=TIMEOUT_S) as resp:
                    status, raw = resp.status, resp.read()
            except urllib.error.HTTPError as e:
                status, raw = e.code, b''
        except Exception:
            # Any library error may quote the header it choked on, token included; none of its text is kept.
            raise OpsError(UNREACHABLE) from None
        if not 200 <= status < 300:
            raise OpsError(f'HTTP {status}')
        try:
            data = json.loads(raw.decode('utf-8')) if raw else {}
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

    def graphql(self, query: str, variables: dict) -> dict:
        answer = self._request('POST', 'graphql.json', {'query': query, 'variables': variables})
        if answer.get('errors'):
            raise OpsError(GRAPHQL_ERROR)
        data = answer.get('data')
        if not isinstance(data, dict):
            raise OpsError(UNEXPECTED)
        return data

    def rest_put(self, path: str, body: dict) -> None:
        self._request('PUT', path, body)


def _payload(data: dict, name: str) -> dict:
    payload = data.get(name)
    if not isinstance(payload, dict):
        raise OpsError(UNEXPECTED)
    return payload


def _raise_user_errors(payload: dict) -> None:
    errors = payload.get('userErrors') or []
    if not errors:
        return
    messages = [e['message'] for e in errors if isinstance(e, dict) and isinstance(e.get('message'), str)]
    raise OpsError(('; '.join(messages) or 'Shopify returned userErrors')[:MAX_REASON_CHARS])


def _variant(node, positions: dict) -> dict:
    if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not isinstance(node.get('selectedOptions'), list):
        raise OpsError(UNEXPECTED)
    for option in node['selectedOptions']:
        if not isinstance(option, dict) or not isinstance(option.get('value'), str):
            raise OpsError(UNEXPECTED)
    ordered = sorted(node['selectedOptions'], key=lambda option: positions.get(option.get('name'), len(positions)))
    return {'id': node['id'], 'sku': node.get('sku') or '', 'selectedOptions': ordered}


def read_variants(shop: Shopify, gid: str) -> list[dict]:
    variants: list[dict] = []
    cursor = None
    for _ in range(MAX_PAGES):
        product = shop.graphql(VARIANTS_QUERY, {'id': gid, 'after': cursor}).get('product')
        if not isinstance(product, dict):
            raise OpsError('product not found')
        connection = product.get('variants')
        if not isinstance(connection, dict) or not isinstance(connection.get('nodes'), list):
            raise OpsError(UNEXPECTED)
        positions = {o.get('name'): o['position'] for o in product.get('options') or []
                     if isinstance(o, dict) and isinstance(o.get('position'), int)}
        variants.extend(_variant(n, positions) for n in connection['nodes'])
        info = connection.get('pageInfo') or {}
        if not info.get('hasNextPage'):
            return variants
        cursor = info.get('endCursor')
        if not isinstance(cursor, str) or not cursor:
            raise OpsError(UNEXPECTED)
    raise OpsError(f'product has more than {MAX_PAGES} pages of variants')


def set_skus(shop: Shopify, gid: str, code: str) -> dict:
    variants = read_variants(shop, gid)
    if not variants:
        raise OpsError('product has no variants')
    plan = sku_plan(code, variants)
    check_plan(code, plan)
    items = [{'id': variant_id, 'inventoryItem': {'sku': sku}} for variant_id, sku in plan.items()]
    for start in range(0, len(items), CHUNK_SIZE):
        data = shop.graphql(UPDATE_SKUS, {'productId': gid, 'variants': items[start:start + CHUNK_SIZE]})
        _raise_user_errors(_payload(data, 'productVariantsBulkUpdate'))
    return {'ok': True, 'variants': len(items), 'skus': list(plan.values())[:5]}


def read_product(shop: Shopify, gid: str) -> dict:
    product = shop.graphql(PRODUCT_QUERY, {'id': gid}).get('product')
    if not isinstance(product, dict):
        raise OpsError('product not found')
    return product


def publish(shop: Shopify, gid: str, sleep=time.sleep) -> dict:
    data = shop.graphql(ACTIVATE, {'product': {'id': gid, 'status': 'ACTIVE'}})
    _raise_user_errors(_payload(data, 'productUpdate'))
    shop.rest_put(f'products/{gid.rsplit("/", 1)[1]}.json', {'product': {'published': True}})
    for attempt in range(PUBLISH_READS):
        product = read_product(shop, gid)
        url = product.get('onlineStoreUrl')
        if isinstance(url, str) and url:
            if product.get('status') != 'ACTIVE':
                raise OpsError('product is not ACTIVE')
            return {'ok': True, 'status': 'ACTIVE', 'onlineStoreUrl': url}
        if attempt < PUBLISH_READS - 1:
            sleep(PUBLISH_WAIT_S)
    raise OpsError('not on the online store')


def product_state(shop: Shopify, gid: str, code: str | None) -> dict:
    product = read_product(shop, gid)
    count = (product.get('variantsCount') or {}).get('count')
    if not isinstance(count, int):
        raise OpsError(UNEXPECTED)
    state = {
        'status': product.get('status'),
        'onlineStoreUrl': product.get('onlineStoreUrl'),
        'handle': product.get('handle'),
        'productType': product.get('productType'),
        'variants': count,
    }
    if code:
        variants = read_variants(shop, gid)
        state['skusOk'] = bool(variants) and all(sku_follows_code(code, v['sku']) for v in variants)
    return state


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(f'bad arguments: {message}')


def parse_args(argv) -> argparse.Namespace:
    parser = _Parser(prog='shopify_ops.py', allow_abbrev=False)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('set-skus', 'publish', 'state'):
        command = commands.add_parser(name, allow_abbrev=False)
        command.add_argument('--product', required=True)
        if name != 'publish':
            command.add_argument('--code', required=name == 'set-skus')
    args = parser.parse_args(argv)
    if not GID_RE.fullmatch(args.product):
        raise UsageError('--product must look like gid://shopify/Product/<digits>')
    if getattr(args, 'code', None) is not None and not CODE_RE.fullmatch(args.code):
        raise UsageError('--code must be two capital letters followed by ten digits')
    return args


def read_env(env) -> tuple[str, str, str]:
    store = env.get('SHOPIFY_STORE') or ''
    if not STORE_RE.fullmatch(store):
        raise UsageError('SHOPIFY_STORE must be <name>.myshopify.com')
    token = env.get('SHOPIFY_ADMIN_TOKEN') or ''
    if not TOKEN_RE.fullmatch(token):
        raise UsageError('SHOPIFY_ADMIN_TOKEN is missing or malformed')
    version = env.get('SHOPIFY_API_VERSION') or DEFAULT_API_VERSION
    if not VERSION_RE.fullmatch(version):
        raise UsageError('SHOPIFY_API_VERSION must look like 2026-07')
    return store, token, version


def _scrub(value, token: str):
    if isinstance(value, str):
        return value.replace(token, '***') if token else value
    if isinstance(value, list):
        return [_scrub(v, token) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v, token) for k, v in value.items()}
    return value


def _finish(code: int, result: dict, token: str) -> int:
    print(json.dumps(_scrub(result, token), ensure_ascii=True), flush=True)
    return code


def main(argv=None, env=None, opener=None, sleep=time.sleep) -> int:
    env = os.environ if env is None else env
    token = env.get('SHOPIFY_ADMIN_TOKEN') or ''
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        store, token, version = read_env(env)
        shop = Shopify(store, token, version, opener)
        if args.command == 'set-skus':
            result = set_skus(shop, args.product, args.code)
        elif args.command == 'publish':
            result = publish(shop, args.product, sleep)
        else:
            result = product_state(shop, args.product, args.code)
    except UsageError as e:
        return _finish(2, {'ok': False, 'reason': str(e)}, token)
    except OpsError as e:
        return _finish(1, {'ok': False, 'reason': str(e)}, token)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 0
    except Exception as e:
        return _finish(1, {'ok': False, 'reason': f'unexpected error ({type(e).__name__})'}, token)
    return _finish(0, result, token)


if __name__ == '__main__':
    sys.exit(main())

import io
import json
import urllib.error
import urllib.request

import pytest

import shopify_ops

TOKEN = 'shpat_SECRET_0123456789abcdef'
STORE = 'litzzy-test.myshopify.com'
ENV = {'SHOPIFY_STORE': STORE, 'SHOPIFY_ADMIN_TOKEN': TOKEN}
GID = 'gid://shopify/Product/9054123557021'
CODE = 'DC2611057392'
BASE = f'https://{STORE}/admin/api/2026-07/'
OPTIONS = [{'name': 'Color', 'position': 1}, {'name': 'Size', 'position': 2}, {'name': 'Style', 'position': 3}]
NAMES = ('Color', 'Size', 'Style')


class FakeResponse:
    def __init__(self, status: int, body):
        self.status = status
        self._raw = b'' if body is None else json.dumps(body).encode('utf-8')

    def read(self, size=-1):
        return self._raw

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(status: int, body=None, headers=None):
    raw = b'' if body is None else json.dumps(body).encode('utf-8')
    return urllib.error.HTTPError(BASE + 'graphql.json', status, 'err', headers or {}, io.BytesIO(raw))


class FakeOpener:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def open(self, req, timeout=None):
        self.calls.append({
            'url': req.full_url,
            'method': req.get_method(),
            'body': json.loads(req.data.decode('utf-8')) if req.data else None,
            'token': req.get_header('X-shopify-access-token'),
            'type': req.get_header('Content-type'),
            'timeout': timeout,
        })
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return out

    def graphql_calls(self):
        return [c for c in self.calls if c['url'].endswith('/graphql.json')]


def gql(data):
    return FakeResponse(200, {'data': data})


def node(i, *values, sku=''):
    return {'id': f'gid://shopify/ProductVariant/{i}', 'sku': sku,
            'selectedOptions': [{'name': n, 'value': v} for n, v in zip(NAMES, values)]}


def default_node(i):
    return {'id': f'gid://shopify/ProductVariant/{i}', 'sku': '',
            'selectedOptions': [{'name': 'Title', 'value': 'Default Title'}]}


def page(nodes, next_cursor=None, options=OPTIONS):
    return gql({'product': {
        'options': options,
        'variants': {'pageInfo': {'hasNextPage': next_cursor is not None, 'endCursor': next_cursor}, 'nodes': nodes},
    }})


def updated(errors=None):
    return gql({'productVariantsBulkUpdate': {'productVariants': [], 'userErrors': errors or []}})


def skus(code, *value_lists):
    variants = [node(i, *values) for i, values in enumerate(value_lists, start=1)]
    return list(shopify_ops.sku_plan(code, variants).values())


def run(capsys, argv, *outcomes, env=ENV, sleep=None):
    opener = FakeOpener(*outcomes)
    sleeps = []
    code = shopify_ops.main(argv, env=env, opener=opener, sleep=sleeps.append if sleep is None else sleep)
    out = capsys.readouterr()
    lines = [json.loads(line) for line in out.out.splitlines() if line.strip()]
    return code, lines, opener, sleeps, out


def mutation_batches(opener):
    return [c['body']['variables']['variants'] for c in opener.graphql_calls() if 'productVariantsBulkUpdate' in c['body']['query']]


def test_suffix_black_xl():
    assert shopify_ops.variant_suffix(['Black', 'XL']) == 'BLACK-XL'
    assert skus(CODE, ['Black', 'XL']) == [f'{CODE}-BLACK-XL']


def test_suffix_strips_everything_but_letters_and_digits():
    assert shopify_ops.variant_suffix(['3.5 inches', 'Navy/White']) == '35INCHES-NAVYWHITE'
    assert shopify_ops.variant_suffix(['Café']) == 'CAF'


def test_single_default_variant_gets_the_bare_code():
    assert list(shopify_ops.sku_plan('DC2611057392', [default_node(1)]).values()) == ['DC2611057392']
    assert skus('DC2611057392', ['XL']) == ['DC2611057392-XL']


def test_default_title_is_bare_only_under_the_option_named_title():
    assert skus(CODE, ['Default Title']) == [f'{CODE}-DEFAULTTITLE']
    renamed = {'id': 'gid://shopify/ProductVariant/1', 'selectedOptions': [{'name': 'Option', 'value': 'Default Title'}]}
    assert list(shopify_ops.sku_plan(CODE, [renamed]).values()) == [f'{CODE}-DEFAULTTITLE']
    titled = {'id': 'gid://shopify/ProductVariant/1', 'selectedOptions': [{'name': 'Title', 'value': 'Large'}]}
    assert list(shopify_ops.sku_plan(CODE, [titled]).values()) == [f'{CODE}-LARGE']
    two_options = {'id': 'gid://shopify/ProductVariant/1', 'selectedOptions': [
        {'name': 'Title', 'value': 'Default Title'}, {'name': 'Size', 'value': 'XL'}]}
    assert list(shopify_ops.sku_plan(CODE, [two_options]).values()) == [f'{CODE}-DEFAULTTITLE-XL']


def test_default_title_among_several_variants_is_an_ordinary_value():
    assert skus(CODE, ['Default Title'], ['XL']) == [f'{CODE}-DEFAULTTITLE', f'{CODE}-XL']
    plan = shopify_ops.sku_plan(CODE, [default_node(1), default_node(2)])
    assert list(plan.values()) == [f'{CODE}-DEFAULTTITLE', f'{CODE}-DEFAULTTITLE-2']


def test_duplicate_suffix_gets_numbered():
    assert skus(CODE, ['Black'], ['Black!']) == [f'{CODE}-BLACK', f'{CODE}-BLACK-2']
    assert skus(CODE, ['Black'], ['BLACK'], ['b l a c k']) == [f'{CODE}-BLACK', f'{CODE}-BLACK-2', f'{CODE}-BLACK-3']


def test_numbered_duplicate_never_takes_a_sku_already_issued():
    assert skus(CODE, ['Black'], ['Black'], ['Black', '2']) == [f'{CODE}-BLACK', f'{CODE}-BLACK-2', f'{CODE}-BLACK-2-2']
    assert skus(CODE, ['Black', '2'], ['Black'], ['Black']) == [f'{CODE}-BLACK-2', f'{CODE}-BLACK', f'{CODE}-BLACK-3']


def test_empty_value_becomes_v_index():
    assert skus(CODE, ['Red'], ['Blue'], ['★']) == [f'{CODE}-RED', f'{CODE}-BLUE', f'{CODE}-V3']
    assert shopify_ops.variant_suffix(['★'], 3) == 'V3'
    assert shopify_ops.variant_suffix(['★', 'XL'], 2) == 'V2-XL'
    assert shopify_ops.variant_suffix([], 4) == 'V4'


def test_sku_plan_maps_variant_gid_to_sku_in_variant_order():
    plan = shopify_ops.sku_plan(CODE, [node(11, 'Red', 'S'), node(7, 'Red', 'M')])
    assert list(plan.items()) == [('gid://shopify/ProductVariant/11', f'{CODE}-RED-S'),
                                  ('gid://shopify/ProductVariant/7', f'{CODE}-RED-M')]


def test_check_plan_rejects_a_sku_that_does_not_follow_the_code():
    shopify_ops.check_plan(CODE, {'a': CODE, 'b': f'{CODE}-XL'})
    for bad in ('DC2611057393-XL', f'{CODE}XL', f'x{CODE}', f'{CODE[:-1]}'):
        with pytest.raises(shopify_ops.OpsError):
            shopify_ops.check_plan(CODE, {'a': bad})


@pytest.mark.parametrize('code', ['dc2611057392', 'DC261105739', 'DC26110573921', 'D12611057392', 'DC2611057392\n',
                                  'DC26110573९२', 'DCX611057392', ''])
def test_set_skus_rejects_bad_code(capsys, code):
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', code])
    assert status == 2
    assert lines[0]['ok'] is False
    assert opener.calls == []


@pytest.mark.parametrize('gid', ['9054123557021', 'gid://shopify/ProductVariant/1', 'gid://shopify/Product/',
                                 'gid://shopify/Product/12x', 'gid://shopify/Product/12\n', 'gid://shopify/Product/१२',
                                 'https://litzzy.com/products/x', ''])
def test_set_skus_rejects_bad_gid(capsys, gid):
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', gid, '--code', CODE])
    assert status == 2
    assert lines[0]['ok'] is False
    assert opener.calls == []


def test_every_command_checks_the_product_gid_and_state_checks_the_code(capsys):
    for argv in (['publish', '--product', 'nope'], ['state', '--product', 'nope'],
                 ['state', '--product', GID, '--code', 'nope']):
        status, lines, opener, _, _ = run(capsys, argv)
        assert status == 2 and lines[0]['ok'] is False and opener.calls == []


@pytest.mark.parametrize('argv', [[], ['frobnicate'], ['set-skus', '--product', GID], ['set-skus', '--code', CODE],
                                  ['publish'], ['state'], ['publish', '--product', GID, '--code', CODE]])
def test_missing_or_unknown_arguments_exit_2(capsys, argv):
    status, lines, opener, _, _ = run(capsys, argv)
    assert status == 2
    assert lines[0]['ok'] is False
    assert opener.calls == []


@pytest.mark.parametrize('env', [
    {}, {'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': 'evil.example.com', 'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': 'litzzy.myshopify.com.evil.com', 'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': 'Litzzy.myshopify.com', 'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': '-litzzy.myshopify.com', 'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': 'litzzy.myshopify.com/', 'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': 'litzzy.myshopify.com\n', 'SHOPIFY_ADMIN_TOKEN': TOKEN},
    {'SHOPIFY_STORE': STORE}, {'SHOPIFY_STORE': STORE, 'SHOPIFY_ADMIN_TOKEN': ''},
    {'SHOPIFY_STORE': STORE, 'SHOPIFY_ADMIN_TOKEN': 'tok\nen'},
    {'SHOPIFY_STORE': STORE, 'SHOPIFY_ADMIN_TOKEN': TOKEN, 'SHOPIFY_API_VERSION': '../2026-07'},
    {'SHOPIFY_STORE': STORE, 'SHOPIFY_ADMIN_TOKEN': TOKEN, 'SHOPIFY_API_VERSION': '2026-7'},
])
def test_bad_environment_exits_2_before_any_request(capsys, env):
    status, lines, opener, _, out = run(capsys, ['state', '--product', GID], env=env)
    assert status == 2
    assert lines[0]['ok'] is False
    assert opener.calls == []
    assert 'evil.example.com' not in out.out


def test_requests_go_to_the_store_with_the_token_header_and_a_30s_timeout(capsys):
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      page([node(1, 'Black', 'XL')]), updated())
    assert status == 0
    assert len(opener.calls) == 2
    for call in opener.calls:
        assert call['url'] == BASE + 'graphql.json'
        assert call['method'] == 'POST'
        assert call['token'] == TOKEN
        assert call['type'] == 'application/json'
        assert call['timeout'] == 30


def test_api_version_defaults_to_the_litzzy_tool_and_can_be_overridden(capsys):
    assert shopify_ops.DEFAULT_API_VERSION == '2026-07'
    env = {**ENV, 'SHOPIFY_API_VERSION': '2027-01'}
    status, _, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                  page([node(1, 'Black', 'XL')]), updated(), env=env)
    assert status == 0
    assert all(c['url'] == f'https://{STORE}/admin/api/2027-01/graphql.json' for c in opener.calls)


def test_default_opener_does_not_follow_redirects():
    opener = shopify_ops.build_opener()
    assert any(isinstance(h, shopify_ops.NoRedirect) for h in opener.handlers)


def test_a_redirect_is_reported_as_its_status_and_not_followed(capsys):
    status, lines, opener, _, _ = run(capsys, ['state', '--product', GID], http_error(302))
    assert status == 1
    assert lines == [{'ok': False, 'reason': 'HTTP 302'}]
    assert len(opener.calls) == 1


def test_set_skus_reads_every_page_and_writes_in_chunks_of_100(capsys):
    first = [node(i, f'C{i}', 'S') for i in range(1, 251)]
    second = [node(i, f'C{i}', 'S') for i in range(251, 301)]
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      page(first, 'CURSOR1'), page(second), updated(), updated(), updated())
    assert status == 0
    reads = [c for c in opener.graphql_calls() if 'productVariantsBulkUpdate' not in c['body']['query']]
    assert [c['body']['variables'] for c in reads] == [{'id': GID, 'after': None}, {'id': GID, 'after': 'CURSOR1'}]
    assert all('first: 250' in c['body']['query'] for c in reads)
    batches = mutation_batches(opener)
    assert [len(b) for b in batches] == [100, 100, 100]
    sent = [item for b in batches for item in b]
    assert sent[0] == {'id': 'gid://shopify/ProductVariant/1', 'inventoryItem': {'sku': f'{CODE}-C1-S'}}
    assert sent[-1] == {'id': 'gid://shopify/ProductVariant/300', 'inventoryItem': {'sku': f'{CODE}-C300-S'}}
    assert len({item['id'] for item in sent}) == 300
    assert all(c['body']['variables']['productId'] == GID for c in opener.graphql_calls()[2:])
    assert lines == [{'ok': True, 'variants': 300, 'skus': [f'{CODE}-C{i}-S' for i in range(1, 6)]}]


def test_set_skus_uses_option_order_not_the_order_the_values_were_returned_in(capsys):
    swapped = {'id': 'gid://shopify/ProductVariant/1', 'sku': '',
               'selectedOptions': [{'name': 'Size', 'value': 'XL'}, {'name': 'Color', 'value': 'Black'}]}
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page([swapped]), updated())
    assert status == 0
    assert mutation_batches(opener)[0][0]['inventoryItem']['sku'] == f'{CODE}-BLACK-XL'


def test_set_skus_on_a_default_variant_product_writes_the_bare_code(capsys):
    only = {'id': 'gid://shopify/ProductVariant/1', 'sku': '',
            'selectedOptions': [{'name': 'Title', 'value': 'Default Title'}]}
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      page([only], options=[{'name': 'Title', 'position': 1}]), updated())
    assert status == 0
    assert mutation_batches(opener) == [[{'id': 'gid://shopify/ProductVariant/1', 'inventoryItem': {'sku': CODE}}]]
    assert lines == [{'ok': True, 'variants': 1, 'skus': [CODE]}]


def test_set_skus_is_idempotent(capsys):
    def once():
        return run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                   page([node(1, 'Black', 'XL', sku=''), node(2, 'Black', 'XL')]), updated())

    first = once()
    second = once()
    assert first[0] == second[0] == 0
    assert mutation_batches(first[2]) == mutation_batches(second[2])
    assert first[1] == second[1]


def test_set_skus_keeps_the_same_skus_when_the_variants_already_carry_them(capsys):
    done = [node(1, 'Black', 'XL', sku=f'{CODE}-BLACK-XL'), node(2, 'Black', 'XL', sku=f'{CODE}-BLACK-XL-2')]
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page(done), updated())
    assert status == 0
    assert [i['inventoryItem']['sku'] for i in mutation_batches(opener)[0]] == [f'{CODE}-BLACK-XL', f'{CODE}-BLACK-XL-2']


def test_set_skus_user_errors_stop_the_run_and_are_reported(capsys):
    nodes = [node(i, f'C{i}') for i in range(1, 151)]
    errors = [{'field': ['variants', '0'], 'message': 'Price is invalid'}, {'field': None, 'message': 'Second problem'}]
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      page(nodes), updated(), updated(errors))
    assert status == 1
    assert lines == [{'ok': False, 'reason': 'Price is invalid; Second problem', 'written': 100}]
    assert len(mutation_batches(opener)) == 2

    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      page(nodes), updated(errors), updated())
    assert status == 1
    assert lines == [{'ok': False, 'reason': 'Price is invalid; Second problem'}]
    assert len(mutation_batches(opener)) == 1


def test_set_skus_gives_up_after_20_pages_without_writing(capsys):
    pages = [page([node(i, f'C{i}')], f'CURSOR{i}') for i in range(1, 25)]
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], *pages)
    assert status == 1
    assert lines[0]['ok'] is False and '20' in lines[0]['reason']
    assert len(opener.calls) == 20
    assert mutation_batches(opener) == []


def test_set_skus_accepts_exactly_20_pages(capsys):
    pages = [page([node(i, f'C{i}')], f'CURSOR{i}') for i in range(1, 20)] + [page([node(20, 'C20')])]
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], *pages, updated())
    assert status == 0
    assert lines[0]['variants'] == 20


def test_set_skus_stops_on_a_page_that_promises_more_without_a_cursor(capsys):
    broken = gql({'product': {'options': OPTIONS, 'variants': {
        'pageInfo': {'hasNextPage': True, 'endCursor': None}, 'nodes': [node(1, 'Black')]}}})
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], broken)
    assert status == 1
    assert len(opener.calls) == 1


def test_set_skus_reports_a_missing_product_and_a_product_without_variants(capsys):
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], gql({'product': None}))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'product not found'}])
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page([]))
    assert status == 1 and lines[0]['ok'] is False
    assert mutation_batches(opener) == []


def test_set_skus_sends_nothing_when_a_planned_sku_does_not_follow_the_code(capsys, monkeypatch):
    monkeypatch.setattr(shopify_ops, 'sku_plan', lambda code, variants: {variants[0]['id']: 'OTHER-BLACK'})
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page([node(1, 'Black')]))
    assert status == 1
    assert lines[0]['ok'] is False
    assert mutation_batches(opener) == []


def publish_outcomes(*readbacks):
    return [gql({'productUpdate': {'product': {'id': GID, 'status': 'ACTIVE'}, 'userErrors': []}}),
            FakeResponse(200, {'product': {'id': 9054123557021}}), *readbacks]


def readback(status='ACTIVE', url='https://litzzy.com/products/x'):
    return gql({'product': {'status': status, 'onlineStoreUrl': url, 'handle': 'x', 'productType': 'Mug',
                            'variantsCount': {'count': 3}}})


def test_publish_sets_active_then_publishes_with_rest_then_reads_back(capsys):
    status, lines, opener, sleeps, _ = run(capsys, ['publish', '--product', GID], *publish_outcomes(readback()))
    assert status == 0
    assert lines == [{'ok': True, 'status': 'ACTIVE', 'onlineStoreUrl': 'https://litzzy.com/products/x'}]
    update, rest, read = opener.calls
    assert 'productUpdate' in update['body']['query']
    assert update['body']['variables'] == {'product': {'id': GID, 'status': 'ACTIVE'}}
    assert (rest['method'], rest['url']) == ('PUT', BASE + 'products/9054123557021.json')
    assert rest['body'] == {'product': {'published': True}}
    assert rest['token'] == TOKEN and rest['timeout'] == 30
    assert read['body']['variables'] == {'id': GID}
    assert 'onlineStoreUrl' in read['body']['query']
    assert sleeps == []


def test_publish_reads_back_again_when_the_url_is_late(capsys):
    status, lines, opener, sleeps, _ = run(capsys, ['publish', '--product', GID],
                                           *publish_outcomes(readback(url=None), readback()))
    assert status == 0
    assert lines[0]['onlineStoreUrl'] == 'https://litzzy.com/products/x'
    assert len(opener.calls) == 4
    assert sleeps == [5]


def test_publish_fails_when_online_store_url_stays_null(capsys):
    status, lines, opener, sleeps, _ = run(capsys, ['publish', '--product', GID],
                                           *publish_outcomes(readback(url=None), readback(url=None), readback(url=None)))
    assert status == 1
    assert lines == [{'ok': False, 'reason': 'not on the online store'}]
    assert len(opener.calls) == 5
    assert sleeps == [5, 5]


def test_publish_user_errors_stop_before_the_rest_call(capsys):
    refused = gql({'productUpdate': {'product': None, 'userErrors': [{'field': ['id'], 'message': 'Product does not exist'}]}})
    status, lines, opener, _, _ = run(capsys, ['publish', '--product', GID], refused)
    assert status == 1
    assert lines == [{'ok': False, 'reason': 'Product does not exist'}]
    assert len(opener.calls) == 1


def test_publish_rest_http_error_is_reported_by_status_only(capsys):
    first = publish_outcomes()[0]
    status, lines, opener, _, out = run(capsys, ['publish', '--product', GID], first,
                                        http_error(403, {'errors': 'secret body text'}))
    assert status == 1
    assert lines == [{'ok': False, 'reason': 'HTTP 403'}]
    assert 'secret body text' not in out.out


def test_publish_never_reports_a_product_that_is_not_active(capsys):
    status, lines, _, _, _ = run(capsys, ['publish', '--product', GID], *publish_outcomes(readback(status='DRAFT')))
    assert status == 1
    assert lines[0]['ok'] is False


def test_state_prints_the_product_without_skus_ok_when_no_code_is_given(capsys):
    status, lines, opener, _, _ = run(capsys, ['state', '--product', GID], readback())
    assert status == 0
    assert lines == [{'status': 'ACTIVE', 'onlineStoreUrl': 'https://litzzy.com/products/x', 'handle': 'x',
                      'productType': 'Mug', 'variants': 3}]
    assert len(opener.calls) == 1


def test_state_with_a_code_checks_every_variant_sku(capsys):
    good = [node(1, 'Black', sku=f'{CODE}-BLACK'), node(2, 'Red', sku=CODE)]
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID, '--code', CODE], readback(), page(good))
    assert status == 0
    assert lines[0]['skusOk'] is True
    assert lines[0]['variants'] == 3

    for bad_sku in ('', 'OTHER-BLACK', f'{CODE}BLACK', 'DC2611057393-BLACK'):
        bad = [node(1, 'Black', sku=f'{CODE}-BLACK'), node(2, 'Red', sku=bad_sku)]
        status, lines, _, _, _ = run(capsys, ['state', '--product', GID, '--code', CODE], readback(), page(bad))
        assert status == 0
        assert lines[0]['skusOk'] is False


def test_state_reports_a_null_online_store_url_and_a_missing_product(capsys):
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], readback(status='DRAFT', url=None))
    assert status == 0
    assert lines[0]['onlineStoreUrl'] is None and lines[0]['status'] == 'DRAFT'
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], gql({'product': None}))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'product not found'}])


def test_http_errors_and_odd_answers_give_fixed_reasons(capsys):
    status, lines, _, _, out = run(capsys, ['state', '--product', GID], http_error(500, {'detail': 'leak me'}))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'HTTP 500'}])
    assert 'leak me' not in out.out
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], http_error(401))
    assert lines == [{'ok': False, 'reason': 'HTTP 401'}]
    status, lines, _, _, out = run(capsys, ['state', '--product', GID],
                                   FakeResponse(200, {'errors': [{'message': 'Throttled with details'}]}))
    assert status == 1 and lines[0]['ok'] is False
    assert 'Throttled' not in out.out
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], FakeResponse(200, None))
    assert status == 1 and lines[0]['ok'] is False
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], urllib.error.URLError('connection refused'))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'could not reach Shopify'}])
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], TimeoutError('slow'))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'could not reach Shopify'}])


def test_malformed_answers_do_not_crash_with_a_traceback(capsys):
    bad_variant = gql({'product': {'options': OPTIONS, 'variants': {
        'pageInfo': {'hasNextPage': False}, 'nodes': [{'id': 'gid://shopify/ProductVariant/1', 'selectedOptions': [{'name': 'Color'}]}]}}})
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], bad_variant)
    assert status == 1
    assert lines[0]['ok'] is False
    assert mutation_batches(opener) == []


def secret_everywhere():
    echo = f'Invalid header value {TOKEN}'
    return {
        'network error': [urllib.error.URLError(echo)],
        'value error': [ValueError(echo)],
        'http error body': [http_error(500, {'error': echo})],
        'graphql errors': [FakeResponse(200, {'errors': [{'message': echo}]})],
        'garbage body': [FakeResponse(200, {'data': {'product': {'handle': echo}}})],
        'user errors': [gql({'productVariantsBulkUpdate': {'userErrors': [{'message': echo}]}})],
    }


@pytest.mark.parametrize('argv', [
    ['set-skus', '--product', GID, '--code', CODE],
    ['publish', '--product', GID],
    ['state', '--product', GID],
    ['state', '--product', GID, '--code', CODE],
])
def test_token_never_printed(capsys, argv):
    for name, outcomes in secret_everywhere().items():
        status, lines, _, _, out = run(capsys, argv, *outcomes)
        assert TOKEN not in out.out and TOKEN not in out.err, name
        assert 'SECRET' not in out.out and 'SECRET' not in out.err, name
        assert status in (0, 1), name


def test_token_never_printed_when_shopify_echoes_it_in_a_user_error(capsys):
    echoed = gql({'productVariantsBulkUpdate': {'userErrors': [{'message': f'bad token {TOKEN} given'}]}})
    status, lines, _, _, out = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page([node(1, 'Black')]), echoed)
    assert status == 1
    assert TOKEN not in out.out and TOKEN not in out.err
    assert lines[0]['reason'] == 'bad token *** given'


def test_token_never_printed_on_success_or_bad_arguments(capsys):
    _, _, _, _, out = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page([node(1, 'Black')]), updated())
    assert TOKEN not in out.out and TOKEN not in out.err
    _, _, _, _, out = run(capsys, ['set-skus', '--product', GID, '--code', 'bad'])
    assert TOKEN not in out.out and TOKEN not in out.err
    _, _, _, _, out = run(capsys, ['state', '--product', GID], env={**ENV, 'SHOPIFY_API_VERSION': TOKEN})
    assert TOKEN not in out.out and TOKEN not in out.err


def test_output_is_one_ascii_json_line(capsys):
    refused = gql({'productUpdate': {'product': None, 'userErrors': [{'message': 'Titre invalide: café ★'}]}})
    status, _, _, _, out = run(capsys, ['publish', '--product', GID], refused)
    assert status == 1
    assert out.out.count('\n') == 1
    out.out.encode('ascii')
    assert json.loads(out.out)['reason'] == 'Titre invalide: café ★'


def test_no_redirect_handler_declines_every_redirect():
    handler = shopify_ops.NoRedirect()
    request = urllib.request.Request(BASE + 'graphql.json')
    assert handler.redirect_request(request, None, 302, 'Found', {}, 'https://evil.example/steal') is None


def test_token_echoed_in_a_publish_user_error_is_scrubbed(capsys):
    echoed = gql({'productUpdate': {'product': None, 'userErrors': [{'message': f'token {TOKEN} rejected'}]}})
    status, lines, opener, _, out = run(capsys, ['publish', '--product', GID], echoed)
    assert status == 1
    assert TOKEN not in out.out and TOKEN not in out.err
    assert lines == [{'ok': False, 'reason': 'token *** rejected'}]
    assert len(opener.calls) == 1


def test_check_plan_refuses_a_sku_longer_than_255_characters():
    shopify_ops.check_plan(CODE, {'a': CODE, 'b': f'{CODE}-' + 'X' * 242})
    with pytest.raises(shopify_ops.OpsError, match='SKU too long for variant 2'):
        shopify_ops.check_plan(CODE, {'a': CODE, 'b': f'{CODE}-' + 'X' * 243})


def test_a_300_character_sku_is_refused_before_any_chunk_is_written(capsys):
    nodes = [node(i, f'C{i}') for i in range(1, 151)]
    nodes[119] = node(120, 'X' * 300)
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE], page(nodes))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'SKU too long for variant 120'}])
    assert len(opener.calls) == 1
    assert mutation_batches(opener) == []


def three_chunks():
    first = [node(i, f'C{i}') for i in range(1, 251)]
    second = [node(i, f'C{i}') for i in range(251, 301)]
    return [page(first, 'CURSOR1'), page(second)]


def test_a_failure_in_the_middle_chunk_says_how_many_variants_were_written(capsys):
    refused = updated([{'field': None, 'message': 'Variant is locked'}])
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      *three_chunks(), updated(), refused)
    assert (status, lines) == (1, [{'ok': False, 'reason': 'Variant is locked', 'written': 100}])
    assert [len(b) for b in mutation_batches(opener)] == [100, 100]


@pytest.mark.parametrize('failure, reason', [
    (http_error(500), 'HTTP 500'),
    (urllib.error.URLError('gone'), 'could not reach Shopify'),
    (gql({'productVariantsBulkUpdate': {}}), 'unexpected answer from Shopify'),
    (gql({'productVariantsBulkUpdate': None}), 'unexpected answer from Shopify'),
])
def test_written_counts_every_earlier_chunk_whatever_the_failure(capsys, failure, reason):
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      *three_chunks(), updated(), updated(), failure)
    assert (status, lines) == (1, [{'ok': False, 'reason': reason, 'written': 200}])
    assert [len(b) for b in mutation_batches(opener)] == [100, 100, 100]


def test_a_failure_before_anything_was_written_has_no_written_key(capsys):
    status, lines, _, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                 page([node(1, 'Black')]), http_error(500))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'HTTP 500'}])


def throttled_answer(code='THROTTLED'):
    return FakeResponse(200, {'errors': [{'message': 'Throttled: details', 'extensions': {'code': code}}]})


def test_http_429_waits_for_retry_after_capped_at_10_seconds_and_retries_the_same_request(capsys):
    status, lines, opener, sleeps, _ = run(
        capsys, ['state', '--product', GID],
        http_error(429, headers={'Retry-After': '3'}), http_error(429, headers={'Retry-After': '25'}), readback())
    assert status == 0
    assert lines[0]['status'] == 'ACTIVE'
    assert sleeps == [3, 10]
    assert len(opener.calls) == 3
    assert opener.calls[0] == opener.calls[1] == opener.calls[2]


def test_http_429_without_retry_after_backs_off_2_4_8_seconds(capsys):
    status, lines, opener, sleeps, _ = run(
        capsys, ['state', '--product', GID], http_error(429), http_error(429), http_error(429), readback())
    assert status == 0
    assert sleeps == [2, 4, 8]
    assert len(opener.calls) == 4


@pytest.mark.parametrize('header', ['Wed, 21 Oct 2026 07:28:00 GMT', 'soon', '-5', ''])
def test_an_unreadable_retry_after_falls_back_to_the_backoff(capsys, header):
    status, _, _, sleeps, _ = run(
        capsys, ['state', '--product', GID], http_error(429, headers={'Retry-After': header}), readback())
    assert status == 0
    assert sleeps == [2]


def test_http_429_that_outlasts_three_retries_exits_1_as_throttled(capsys):
    status, lines, opener, sleeps, _ = run(
        capsys, ['state', '--product', GID], http_error(429), http_error(429), http_error(429), http_error(429))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'throttled'}])
    assert sleeps == [2, 4, 8]
    assert len(opener.calls) == 4


def test_graphql_throttled_is_retried_and_then_gives_up(capsys):
    status, lines, opener, sleeps, _ = run(
        capsys, ['state', '--product', GID], throttled_answer(), throttled_answer(), readback())
    assert status == 0
    assert sleeps == [2, 4]

    status, lines, opener, sleeps, _ = run(
        capsys, ['state', '--product', GID], *[throttled_answer() for _ in range(4)])
    assert (status, lines) == (1, [{'ok': False, 'reason': 'throttled'}])
    assert sleeps == [2, 4, 8]
    assert len(opener.calls) == 4


def test_throttling_in_the_middle_of_set_skus_reports_what_was_written(capsys):
    status, lines, opener, sleeps, _ = run(
        capsys, ['set-skus', '--product', GID, '--code', CODE], *three_chunks(), updated(),
        *[throttled_answer() for _ in range(4)])
    assert (status, lines) == (1, [{'ok': False, 'reason': 'throttled', 'written': 100}])
    assert sleeps == [2, 4, 8]
    batches = mutation_batches(opener)
    assert len(batches) == 5 and batches[1] == batches[2] == batches[3] == batches[4]


def test_rest_429_in_publish_is_retried(capsys):
    first = publish_outcomes()[0]
    rest_ok = FakeResponse(200, {'product': {'id': 9054123557021}})
    status, lines, opener, sleeps, _ = run(capsys, ['publish', '--product', GID], first,
                                           http_error(429, headers={'Retry-After': '1'}), rest_ok, readback())
    assert status == 0
    assert sleeps == [1]
    assert [c['method'] for c in opener.calls] == ['POST', 'PUT', 'PUT', 'POST']


def test_graphql_error_code_is_printed_when_it_is_a_plain_code_and_nothing_else(capsys):
    denied = FakeResponse(200, {'errors': [{'message': 'Access denied for productUpdate. Required: write_products',
                                            'extensions': {'code': 'ACCESS_DENIED'}}]})
    status, lines, opener, sleeps, out = run(capsys, ['state', '--product', GID], denied)
    assert (status, lines) == (1, [{'ok': False, 'reason': 'Shopify GraphQL error (ACCESS_DENIED)'}])
    assert 'write_products' not in out.out
    assert sleeps == [] and len(opener.calls) == 1


@pytest.mark.parametrize('code', ['access_denied', 'ACCESS-DENIED', 'A' * 41, '', 7, None, ['ACCESS_DENIED'], TOKEN])
def test_graphql_error_code_that_is_not_a_plain_code_is_left_out(capsys, code):
    odd = FakeResponse(200, {'errors': [{'message': 'm', 'extensions': {'code': code}}]})
    status, lines, _, _, out = run(capsys, ['state', '--product', GID], odd)
    assert (status, lines) == (1, [{'ok': False, 'reason': 'Shopify GraphQL error'}])
    assert TOKEN not in out.out


@pytest.mark.parametrize('errors', ['Not Found', [{'message': 'm'}], [{'extensions': 'x'}], [None, 3]])
def test_graphql_errors_without_a_readable_code_give_the_plain_reason(capsys, errors):
    status, lines, _, _, _ = run(capsys, ['state', '--product', GID], FakeResponse(200, {'errors': errors}))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'Shopify GraphQL error'}])


def bare_shop():
    opener = FakeOpener()
    return shopify_ops.Shopify(STORE, TOKEN, '2026-07', opener), opener


@pytest.mark.parametrize('bad', ['9054123557021', 'gid://shopify/ProductVariant/1', 'gid://shopify/Product/12\n',
                                 'gid://shopify/Product/१२', '', None, 12])
def test_functions_revalidate_the_product_gid_before_any_request(bad):
    shop, opener = bare_shop()
    calls = (lambda: shopify_ops.set_skus(shop, bad, CODE), lambda: shopify_ops.publish(shop, bad),
             lambda: shopify_ops.read_product(shop, bad), lambda: shopify_ops.read_variants(shop, bad),
             lambda: shopify_ops.product_state(shop, bad, None), lambda: shopify_ops.product_state(shop, bad, CODE))
    for call in calls:
        with pytest.raises(shopify_ops.UsageError):
            call()
    assert opener.calls == []


@pytest.mark.parametrize('bad', ['dc2611057392', 'DC26110573', 'DC2611057392\n', 'DC26110573९२', '', None, 5])
def test_set_skus_revalidates_the_code_before_any_request(bad):
    shop, opener = bare_shop()
    with pytest.raises(shopify_ops.UsageError):
        shopify_ops.set_skus(shop, GID, bad)
    assert opener.calls == []


def test_state_revalidates_a_given_code_but_does_not_require_one():
    shop, opener = bare_shop()
    for bad in ('dc2611057392', ''):
        with pytest.raises(shopify_ops.UsageError):
            shopify_ops.product_state(shop, GID, bad)
    assert opener.calls == []


@pytest.mark.parametrize('payload', [{}, {'userErrors': None}, {'userErrors': 'none'}, {'userErrors': {'message': 'x'}}])
def test_a_mutation_payload_without_a_user_errors_list_is_not_a_success(capsys, payload):
    status, lines, opener, _, _ = run(capsys, ['set-skus', '--product', GID, '--code', CODE],
                                      page([node(1, 'Black')]), gql({'productVariantsBulkUpdate': payload}))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'unexpected answer from Shopify'}])

    status, lines, opener, _, _ = run(capsys, ['publish', '--product', GID], gql({'productUpdate': payload}))
    assert (status, lines) == (1, [{'ok': False, 'reason': 'unexpected answer from Shopify'}])
    assert len(opener.calls) == 1

import json

import pytest

import registers

LINK = 'https://shop.example.com/products/family-ornament'


def make_job(**over):
    job = {'id': 'cmh1a2b3c4d5e6f7', 'sourceUrl': LINK, 'skuCode': 'TM0611260001', 'attempts': 1,
           'store': {'id': 'store1', 'orderPrefix': 'LIT', 'shop': 'caramiaus-store.myshopify.com'}}
    job.update(over)
    return job


def entry(root, folder, raw=None, **fields):
    (root / folder).mkdir(parents=True, exist_ok=True)
    data = raw if raw is not None else json.dumps({'slug': folder, **fields}).encode('utf-8')
    (root / folder / 'clone.json').write_bytes(data)


@pytest.fixture
def roots(tmp_path):
    clip, cma = tmp_path / 'clipart-clones', tmp_path / 'customall-clones'
    clip.mkdir()
    cma.mkdir()
    return clip, cma


def test_find_existing_matches_same_link_in_other_form_and_ignores_draft_and_deleted(roots):
    clip, cma = roots
    entry(clip, 'family-draft', source=LINK, product='gid://shopify/Product/111', handle='family-draft', status='DRAFT')
    entry(clip, 'family-gone', source=LINK + '/', product='gid://shopify/Product/222', handle='family-gone',
          status='DELETED')
    entry(cma, 'family-live', source='https://SHOP.Example.com/products/family-ornament/?variant=42#reviews',
          product='gid://shopify/Product/333', handle='family-live', status='ACTIVE')
    assert registers.find_existing(make_job(), roots=[str(clip), str(cma)]) == {
        'productGid': 'gid://shopify/Product/333', 'handle': 'family-live'}
    assert registers.find_existing(make_job(), roots=[str(clip)]) is None


def test_other_links_other_stores_and_the_jobs_own_entry_are_not_reused(roots):
    clip, cma = roots
    entry(clip, 'other', source='https://shop.example.com/products/family-ornament-2',
          product='gid://shopify/Product/444', handle='other', status='ACTIVE')
    entry(clip, 'tm0611260001', source=LINK, product='gid://shopify/Product/555', handle='tm0611260001',
          status='ACTIVE')
    entry(cma, 'renamed', source=LINK, product='gid://shopify/Product/666', handle='h', status='ACTIVE',
          slug='TM0611260001')
    both = [str(clip), str(cma)]
    assert registers.find_existing(make_job(), roots=both) is None
    entry(cma, 'dn0411261016', source=LINK, product='gid://shopify/Product/777', handle='galaxy', status='ACTIVE')
    remi = make_job(store={'id': 'store2', 'orderPrefix': 'REMI', 'shop': 'd1ba2a-75.myshopify.com'})
    assert registers.find_existing(remi, roots=both) is None
    assert registers.find_existing(make_job(), roots=both) == {'productGid': 'gid://shopify/Product/777',
                                                               'handle': 'galaxy'}


def test_unreadable_and_malformed_entries_are_skipped(roots, tmp_path):
    clip, cma = roots
    entry(clip, 'a-bad-json', raw=b'{"source": ')
    entry(clip, 'b-list', raw=b'[1, 2]')
    entry(clip, 'c-bytes', raw=b'\xff\xfe\xfa')
    entry(clip, 'd-no-gid', source=LINK, product='9054', handle='x', status='ACTIVE')
    entry(clip, 'e-no-source', product='gid://shopify/Product/1', handle='x', status='ACTIVE')
    entry(clip, 'f-source-not-text', source=['x'], product='gid://shopify/Product/2', handle='x', status='ACTIVE')
    (clip / 'g-folder-is-file').mkdir()
    (clip / 'g-folder-is-file' / 'clone.json').mkdir()
    entry(cma, 'z-live', source=LINK, product='gid://shopify/Product/888', handle=None, status='ACTIVE')
    missing = str(tmp_path / 'nowhere')
    assert registers.find_existing(make_job(), roots=[missing, str(clip), str(cma)]) == {
        'productGid': 'gid://shopify/Product/888', 'handle': None}


@pytest.mark.parametrize('url, key', [
    ('https://Shop.Example.com/products/A/', 'shop.example.com/products/A'),
    ('https://shop.example.com', 'shop.example.com'),
    ('https://shop.example.com//', 'shop.example.com'),
    ('https://shop.example.com:443/x?y=1#z', 'shop.example.com/x'),
    ('https://shop.example.com:8443/x', 'shop.example.com:8443/x'),
    ('http://shop.example.com:80/x', 'shop.example.com/x'),
    ('  https://shop.example.com/x  ', 'shop.example.com/x'),
    ('not a url', None),
    ('https://shop.example.com:99999/x', None),
    (None, None),
])
def test_source_key_follows_the_server_rule(url, key):
    assert registers.source_key(url) == key


def test_default_roots_are_the_litzzy_registers():
    assert registers.REGISTER_ROOTS == {'LIT': (r'D:\Ecom manager\clipart-clones', r'D:\Ecom manager\customall-clones')}

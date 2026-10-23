import hashlib
import os
import time

import pytest

import nas
import worker
from api import parse_claim

SLOT = {'storeId': 's1', 'shopifyProductId': 'gid://shopify/Product/9', 'templateId': 't20', 'optionKey': '',
        'title': 'HaPo Tumbler DN2509261948', 'folder': ['Litzzy', 'DN2509261948 - HaPo Tumbler', '20oz Tumbler - Pgprints UT2-20OZ'],
        'productKey': 'DN2509261948', 'entryId': None, 'activeSha256': None, 'nasPath': None}


class NasApi:
    def __init__(self, slots):
        self.slots, self.reports = slots, []

    def nas_slots(self):
        return self.slots

    def nas_report(self, payload):
        self.reports.append(payload)
        return {'queued': [f['nasPath'] for f in payload['found']], 'linked': [], 'unchanged': 0, 'errors': []}


def write(path, data: bytes, mtime: float | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def test_scan_creates_every_slot_folder_and_reports_nothing_for_an_empty_one(tmp_path):
    api = NasApi([SLOT, {**SLOT, 'templateId': 't30', 'optionKey': '{"Size":"30oz"}', 'folder': [*SLOT['folder'][:2], '30oz - Mangoshao C450-30OZ']}])
    r = nas.scan(api, tmp_path, nas.HashCache(tmp_path / 'h.json'), lambda m: None)
    assert (tmp_path / 'Litzzy' / 'DN2509261948 - HaPo Tumbler' / '20oz Tumbler - Pgprints UT2-20OZ').is_dir()
    assert (tmp_path / 'Litzzy' / 'DN2509261948 - HaPo Tumbler' / '30oz - Mangoshao C450-30OZ').is_dir()
    assert r['created'] == 2 and r['found'] == 0
    assert api.reports == [{'root': str(tmp_path), 'found': [], 'missing': []}]


def test_newest_psd_wins_older_ones_move_to_old_and_the_report_carries_path_and_hash(tmp_path):
    folder = tmp_path.joinpath(*SLOT['folder'])
    now = time.time()
    write(folder / 'v1.psd', b'old', now - 100)
    write(folder / '_old' / 'v1.psd', b'older')
    newest = write(folder / 'v2.psd', b'new-psd', now)
    write(folder / '~temp.psd', b'photoshop temp', now + 50)
    api = NasApi([SLOT])
    r = nas.scan(api, tmp_path, nas.HashCache(tmp_path / 'h.json'), lambda m: None)
    assert r['retired'] == 1 and r['found'] == 1
    assert sorted(p.name for p in (folder / '_old').iterdir()) == ['v1-' + time.strftime('%Y%m%d-%H%M%S', time.localtime(now - 100)) + '.psd', 'v1.psd']
    (found,) = api.reports[0]['found']
    assert found['nasPath'] == 'Litzzy/DN2509261948 - HaPo Tumbler/20oz Tumbler - Pgprints UT2-20OZ/v2.psd'
    assert found['sha256'] == hashlib.sha256(b'new-psd').hexdigest() and found['size'] == 7
    assert found['templateId'] == 't20' and found['optionKey'] == ''
    assert newest.exists()


def test_an_existing_product_folder_with_the_code_is_reused_after_a_rename(tmp_path):
    renamed = tmp_path / 'Litzzy' / 'DN2509261948 HaPo (đã đổi tên)'
    write(renamed / '20oz Tumbler - Pgprints UT2-20OZ' / 'a.psd', b'x')
    api = NasApi([SLOT])
    nas.scan(api, tmp_path, nas.HashCache(tmp_path / 'h.json'), lambda m: None)
    assert not (tmp_path / 'Litzzy' / 'DN2509261948 - HaPo Tumbler').exists()
    assert api.reports[0]['found'][0]['nasPath'].startswith('Litzzy/DN2509261948 HaPo (đã đổi tên)/')


def test_a_linked_slot_uses_its_psd_folder_and_reports_a_psd_that_vanished(tmp_path):
    linked = {**SLOT, 'nasPath': 'Litzzy/Shared/20oz/a.psd', 'folder': ['Litzzy', 'Shared', '20oz']}
    api = NasApi([linked])
    r = nas.scan(api, tmp_path, nas.HashCache(tmp_path / 'h.json'), lambda m: None)
    assert (tmp_path / 'Litzzy' / 'Shared' / '20oz').is_dir()
    assert r['missing'] == ['Litzzy/Shared/20oz/a.psd'] and api.reports[0]['missing'] == ['Litzzy/Shared/20oz/a.psd']


def test_hash_cache_skips_rehashing_an_unchanged_file(tmp_path, monkeypatch):
    f = write(tmp_path / 'a.psd', b'abc')
    cache = nas.HashCache(tmp_path / 'h.json')
    first = cache.get(f)
    cache.save()
    monkeypatch.setattr(nas, 'sha256_file', lambda p: pytest.fail('rehashed'))
    assert nas.HashCache(tmp_path / 'h.json').get(f) == first


def test_scan_refuses_an_unreachable_root(tmp_path):
    with pytest.raises(OSError):
        nas.scan(NasApi([SLOT]), tmp_path / 'offline', nas.HashCache(tmp_path / 'h.json'), lambda m: None)
    assert not (tmp_path / 'offline').exists()


NAS_CLAIM = {
    'job': {'id': 'job9', 'kind': 'PARSE_PSD', 'attempts': 1, 'createdAt': '2026-10-23T00:00:00.000Z'},
    'entry': {'id': 'e9', 'title': 'HaPo', 'status': 'PARSING', 'fields': []},
    'template': {'id': 't20', 'name': '20oz', 'widthPx': 100, 'heightPx': 50, 'dpi': 300, 'areas': []},
    'psdFileId': None,
    'psd': {'id': None, 'fileName': 'v2.psd', 'size': 7, 'sha256': hashlib.sha256(b'new-psd').hexdigest(), 'nasPath': 'Litzzy/P/20oz/v2.psd'},
}


class ParseApi:
    def __init__(self):
        self.submitted, self.failed = [], []

    def fonts(self):
        return []

    def download(self, *a, **k):
        pytest.fail('a NAS PSD must not be downloaded from the server')

    def submit_result(self, job_id, result, artwork_png, preview_png):
        self.submitted.append(job_id)
        return {'status': 'READY'}

    def fail(self, job_id, error, permanent=False):
        self.failed.append((error, permanent))
        return {'jobStatus': 'FAILED', 'attempts': 1}


def test_a_nas_claim_is_parsed_from_the_nas_copy(tmp_path, monkeypatch):
    write(tmp_path / 'Litzzy' / 'P' / '20oz' / 'v2.psd', b'new-psd')
    monkeypatch.setenv('ARTWORK_NAS_ROOT', str(tmp_path))
    seen = {}

    def fake_parse(path, tpl, fl, custom_layers=None, debug_dir=None):
        seen['bytes'] = open(path, 'rb').read()
        from PIL import Image
        return {'fields': [], 'status': 'READY', 'checkScore': 1, 'missingFonts': [], 'warnings': []}, Image.new('RGBA', (2, 2)), Image.new('RGBA', (2, 2))
    monkeypatch.setattr(worker, 'parse', fake_parse)
    claim = parse_claim(NAS_CLAIM)
    assert claim.psd_nas_path == 'Litzzy/P/20oz/v2.psd' and claim.psd_file_id is None
    api = ParseApi()
    worker.process(api, worker.FontCache(api, tmp_path / 'fonts'), claim)
    assert seen['bytes'] == b'new-psd' and api.submitted == ['job9'] and api.failed == []


def test_a_psd_changed_since_the_scan_fails_for_good_and_waits_for_the_next_scan(tmp_path, monkeypatch):
    write(tmp_path / 'Litzzy' / 'P' / '20oz' / 'v2.psd', b'edited-after-scan')
    monkeypatch.setenv('ARTWORK_NAS_ROOT', str(tmp_path))
    api = ParseApi()
    worker.process(api, worker.FontCache(api, tmp_path / 'fonts'), parse_claim(NAS_CLAIM))
    ((error, permanent),) = api.failed
    assert permanent and 'đã đổi' in error


def test_a_nas_claim_without_a_nas_root_is_retried_not_dropped(tmp_path, monkeypatch):
    monkeypatch.delenv('ARTWORK_NAS_ROOT', raising=False)
    api = ParseApi()
    worker.process(api, worker.FontCache(api, tmp_path / 'fonts'), parse_claim(NAS_CLAIM))
    ((error, permanent),) = api.failed
    assert not permanent and 'ARTWORK_NAS_ROOT' in error


def test_daily_run_scans_the_nas_first(monkeypatch, tmp_path):
    calls = []

    class Api(NasApi):
        def claim(self, kinds=None):
            calls.append('claim')
            return None

        def auto_render(self):
            calls.append('auto-render')
            return {'scanned': 0, 'queued': [], 'skipped': []}

        def nas_slots(self):
            calls.append('nas-slots')
            return []
    monkeypatch.setattr(worker, 'WorkerApi', lambda url, token: Api([]))
    monkeypatch.setattr(worker, 'CACHE_DIR', tmp_path)
    monkeypatch.setenv('ARTWORK_NAS_ROOT', str(tmp_path))
    assert worker.run(False, 10.0, None, drain=True, auto_render=True, scan=True) == 0
    assert calls == ['nas-slots', 'auto-render', 'claim']

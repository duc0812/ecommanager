import json
import os
import shutil

import pytest

from conftest import CROCS, MYRIAD_BOLD, need
import worker
from api import FontRef, WorkerApi, parse_claim

CLAIM = {  # shape returned by claimJob() in src/lib/artwork-worker.ts
    'job': {'id': 'job1', 'kind': 'PARSE_PSD', 'attempts': 1, 'createdAt': '2026-10-11T00:00:00.000Z'},
    'entry': {'id': 'e1', 'storeId': 's1', 'shopifyProductId': 'gid://shopify/Product/1', 'title': 'Crocs',
              'status': 'PARSING', 'fields': []},
    'template': {'id': 't1', 'name': 'Crocs strap', 'widthPx': 2894, 'heightPx': 852, 'dpi': 300, 'bleedIn': 0.125,
                 'safeIn': 0.2, 'mirror': False, 'areas': [{'name': 'Front', 'x': 0, 'y': 0, 'w': 2894, 'h': 852}]},
    'psdFileId': 'f1',
    'psd': {'id': 'f1', 'fileName': 'crocs.psd', 'size': 123, 'sha256': None},
}


def test_parse_claim_matches_server_shape():
    c = parse_claim(CLAIM)
    assert c.job_id == 'job1' and c.entry_id == 'e1' and c.psd_file_id == 'f1'
    assert c.template.as_dict() == {'widthPx': 2894, 'heightPx': 852, 'dpi': 300,
                                    'areas': [{'name': 'Front', 'x': 0, 'y': 0, 'w': 2894, 'h': 852}]}
    assert parse_claim({'job': None}) is None


def test_token_is_not_in_repr():
    a = WorkerApi('http://localhost:3002', 'dsw_secret_token')
    assert 'secret' not in repr(a)
    assert a.base == 'http://localhost:3002/api/design-studio/worker'


class FakeApi:
    def __init__(self, psd_path, font_path):
        self.psd_path, self.font_path = psd_path, font_path
        self.submitted, self.failed, self.downloads = [], [], []

    def fonts(self):
        return [FontRef('MyriadPro-Bold', 'font1', '', 'MyriadPro-Bold.otf')]

    def download(self, file_id, dest, expect_sha256=None):
        self.downloads.append((file_id, dest))
        shutil.copyfile(self.psd_path if file_id == 'f1' else self.font_path, dest)
        import hashlib
        return hashlib.sha256(open(dest, 'rb').read()).hexdigest()

    def submit_result(self, job_id, result, artwork_png, preview_png):
        self.submitted.append((job_id, result, artwork_png, preview_png))
        return {'ok': True, 'status': result['status'], 'entryId': 'e1'}

    def fail(self, job_id, error, permanent=False):
        self.failed.append((job_id, error, permanent))
        return {'ok': True, 'jobStatus': 'FAILED' if permanent else 'QUEUED', 'attempts': 1}


def test_process_job_end_to_end(tmp_path, monkeypatch):
    need(CROCS, MYRIAD_BOLD)
    # the crocs PSD has no @ layers; rename its "Note" layer on the fly
    import parse_psd
    real_parse = parse_psd.parse
    monkeypatch.setattr(worker, 'parse', lambda p, t, fl, custom_layers=None, debug_dir=None: real_parse(p, t, fl, custom_layers={'Note'}))
    fake = FakeApi(CROCS, MYRIAD_BOLD)
    cache = worker.FontCache(fake, tmp_path / 'fonts')
    worker.process(fake, cache, parse_claim(CLAIM))
    assert fake.failed == []
    (job_id, result, artwork_png, preview_png), = fake.submitted
    assert job_id == 'job1' and result['status'] == 'READY'
    assert artwork_png[:8] == b'\x89PNG\r\n\x1a\n' and preview_png[:8] == b'\x89PNG\r\n\x1a\n'
    json.dumps(result)  # result.json must be serialisable
    # font cached by content hash, PSD temp dir removed
    assert len(list((tmp_path / 'fonts').iterdir())) == 1
    psd_dest = [d for f, d in fake.downloads if f == 'f1'][0]
    assert not os.path.exists(os.path.dirname(psd_dest))


def test_parse_error_is_reported_as_permanent(monkeypatch, tmp_path):
    need(CROCS)
    claim = parse_claim({**CLAIM, 'template': {**CLAIM['template'], 'heightPx': 2894}})
    fake = FakeApi(CROCS, MYRIAD_BOLD)
    worker.process(fake, worker.FontCache(fake, tmp_path / 'fonts'), claim)
    assert fake.submitted == []
    (job_id, error, permanent), = fake.failed
    assert permanent and 'aspect' in error


def test_unexpected_error_is_reported_for_retry(monkeypatch, tmp_path):
    need(CROCS)
    def boom(*a, **k):
        raise RuntimeError('kaboom')
    monkeypatch.setattr(worker, 'parse', boom)
    fake = FakeApi(CROCS, MYRIAD_BOLD)
    worker.process(fake, worker.FontCache(fake, tmp_path / 'fonts'), parse_claim(CLAIM))
    (job_id, error, permanent), = fake.failed
    assert not permanent and 'kaboom' in error


def test_layer_fields_reach_the_parser(monkeypatch, tmp_path):
    need(CROCS)
    seen = {}

    def fake_parse(p, t, fl, custom_layers=None, debug_dir=None):
        seen['custom_layers'] = custom_layers
        raise RuntimeError('stop')
    monkeypatch.setattr(worker, 'parse', fake_parse)
    claim = parse_claim({**CLAIM, 'entry': {**CLAIM['entry'], 'layerFields': {'Note': 'Custom Name'}}})
    assert claim.layer_fields == {'Note': 'Custom Name'} and claim.kind == 'PARSE_PSD'
    fake = FakeApi(CROCS, MYRIAD_BOLD)
    worker.process(fake, worker.FontCache(fake, tmp_path / 'fonts'), claim)
    assert seen['custom_layers'] == {'Note': 'Custom Name'}
    # no mapping -> the @ convention alone
    assert parse_claim(CLAIM).layer_fields == {}


def test_claim_asks_for_both_job_kinds():
    sent = {}

    class S:
        headers = {}

        def post(self, url, json=None, timeout=None):
            sent['json'] = json

            class R:
                status_code = 200
                content = b'{"job": null}'

                @staticmethod
                def json():
                    return {'job': None}
            return R()
    a = WorkerApi('http://localhost:3002', 'dsw_x')
    a.s = S()
    assert a.claim() is None
    assert sent['json'] == {'kinds': ['PARSE_PSD', 'RENDER_LINE']}

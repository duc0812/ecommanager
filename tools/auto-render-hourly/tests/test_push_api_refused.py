"""push_spec with PUSH_VIA=api: a line prod refuses is skipped with its reason, the rest of the run goes on (delivery API spec 7.5)."""
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import auto_render as ar

SUMMARY = '2 dòng gửi qua API · ghi 1 · dry run 0 · đã có 0 · prod bỏ qua 0 · lỗi 1 · không gửi 0'


class Log:
    def __init__(self):
        self.blocks = []

    def block(self, stage, text):
        self.blocks.append((stage, text))

    def line(self, text):
        pass


def setup(tmp_path, monkeypatch, code, out, lines):
    cfg = SimpleNamespace(node=['node'], tool_worktree=tmp_path, main_checkout=tmp_path, push_via='api', ecom_url='https://x', worker_token='t')
    (tmp_path / ar.API_LEDGER).write_text(json.dumps({'lines': lines}), encoding='utf-8')
    monkeypatch.setattr(ar, '_run', lambda *a, **k: (code, out))
    return cfg


def call(cfg, tmp_path, keys, started):
    return ar.push_spec(cfg, tmp_path / 'spec.json', tmp_path / 'snap.db', tmp_path, keys, started, Log())


def test_a_refused_line_is_skipped_and_the_others_still_count(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(minutes=1)
    applied = datetime.now(timezone.utc).isoformat()
    cfg = setup(tmp_path, monkeypatch, 1, f'== Kết quả API ==\n  A_1  prod từ chối\n{SUMMARY}\n', {
        'A_1#x': {'taskKey': 'A_1', 'skippedOnProd': {'code': 'bad_request', 'error': 'Hai file cho cùng phần PRINT Print', 'status': 400}},
        'B_1#y': {'taskKey': 'B_1', 'applied': applied, 'result': {'ok': True}},
    })
    got = call(cfg, tmp_path, ['A_1', 'B_1'], started)
    assert got['B_1'] == 'pushed'
    assert got['A_1'].startswith('skipped:') and 'Hai file cho cùng phần' in got['A_1']


def test_a_line_that_failed_without_a_ledger_outcome_is_skipped_not_fatal(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(minutes=1)
    cfg = setup(tmp_path, monkeypatch, 1, f'C_1: lỗi mạng\n{SUMMARY}\n', {'C_1#z': {'taskKey': 'C_1', 'action': 'push', 'files': []}})
    assert call(cfg, tmp_path, ['C_1'], started)['C_1'].startswith('skipped: lỗi khi giao qua API')


def test_a_stop_or_a_crash_still_stops_the_push(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc)
    cfg = setup(tmp_path, monkeypatch, 1, f'{SUMMARY}\nDỪNG: app tắt delivery — ledger giữ nguyên\n', {})
    with pytest.raises(ar.StageError):
        call(cfg, tmp_path, ['A_1'], started)
    cfg = setup(tmp_path, monkeypatch, 3221226505, 'push-shared-prints|   LIT6924_1 ...\n', {})
    with pytest.raises(ar.StageError):
        call(cfg, tmp_path, ['A_1'], started)


def test_a_refused_local_render_line_is_skipped_too(tmp_path, monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(minutes=1)
    cfg = setup(tmp_path, monkeypatch, 1, f'{SUMMARY}\n', {})
    led = tmp_path / 'db-backups' / 'push-local-renders'
    led.mkdir(parents=True)
    (led / ar.API_LEDGER).write_text(json.dumps({'lines': {'L_1#a': {'taskKey': 'L_1', 'skippedOnProd': {'code': 'bad_request', 'error': 'x', 'status': 400}}}}), encoding='utf-8')
    got = ar.push_local_line(cfg, tmp_path / 'snap.db', '2026-11-02', 'L_1', started, Log())
    assert got.startswith('skipped:')

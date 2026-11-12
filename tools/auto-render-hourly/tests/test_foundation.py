import json
import os
from datetime import datetime
from pathlib import Path

import pytest

import auto_render as ar


def test_config_reads_keys_and_defaults(cfg_file):
    cfg = ar.load_config(cfg_file())
    assert (cfg.since_days, cfg.local_url, cfg.box_tolerance_px, cfg.ecom_url) == (14, 'http://localhost:3013', 3, '')


def test_config_errors_are_loud(tmp_path, cfg_file):
    with pytest.raises(ar.ConfigError, match='thiếu file cấu hình'): ar.load_config(tmp_path / 'none.env')
    with pytest.raises(ar.ConfigError, match='thiếu ARTWORK_BUILDER'): ar.load_config(cfg_file(ARTWORK_BUILDER=None))
    path = cfg_file(); (Path(ar.load_config(path).tool_worktree) / 'scripts' / 'push-shared-prints.mjs').unlink()
    with pytest.raises(ar.ConfigError, match=r'không thấy .*push-shared-prints\.mjs'): ar.load_config(path)
    with pytest.raises(ar.ConfigError): ar.load_config(cfg_file(ECOM_URL='http://example.com'))


def test_mutex_is_exclusive_and_reusable():
    first = ar.acquire_mutex('Local\\AutoRenderTest'); assert first
    assert ar.acquire_mutex('Local\\AutoRenderTest') is None
    ar.release_mutex(first); again = ar.acquire_mutex('Local\\AutoRenderTest'); assert again; ar.release_mutex(again)


def test_main_exit_codes(cfg_file, monkeypatch, tmp_path):
    assert ar.main(['--config', str(tmp_path / 'none.env')]) == ar.EXIT_CONFIG
    monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 12.4)
    assert ar.main(['--config', str(cfg_file())]) == ar.EXIT_DISK
    held = ar.acquire_mutex(); monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 200.0)
    try: assert ar.main(['--config', str(cfg_file())]) == ar.EXIT_OK
    finally: ar.release_mutex(held)
    log = next((ar.home() / 'logs').glob('*.log')).read_text(encoding='utf-8')
    assert 'ổ D còn 12 GB, dưới 30 GB — dừng' in log and 'lần chạy trước chưa xong — bỏ qua lần này' in log


def test_summary_is_written_and_crash_is_recorded(cfg_file, monkeypatch):
    monkeypatch.setattr(ar, 'disk_free_gb', lambda *a, **k: 200.0)
    monkeypatch.setattr(ar, 'run_stages', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    assert ar.main(['--config', str(cfg_file())]) == ar.EXIT_STAGE
    summary = json.loads(next((ar.home() / 'logs').glob('run-*.json')).read_text(encoding='utf-8'))
    assert summary['exitCode'] == 1 and summary['errors'] == [{'stage': 'crash', 'message': 'RuntimeError: boom'}]


def test_log_masks_the_token_and_prune_keeps_30_days(tmp_path):
    log = ar.RunLog(tmp_path, datetime(2026, 11, 12, 9, 0), secrets=['dag_secret-token-123'])
    log.line('gọi /hold với dag_secret-token-123'); assert 'dag_secret' not in log.path.read_text(encoding='utf-8')
    old = tmp_path / 'logs' / '2026-10-01.log'; old.write_text('x'); os.utime(old, (0, 0))
    assert ar.prune(tmp_path, datetime(2026, 11, 12)) == 1 and log.path.exists()

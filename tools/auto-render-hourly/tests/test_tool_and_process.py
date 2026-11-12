from datetime import datetime
from pathlib import Path

import pytest

import auto_render as ar

log = None


@pytest.fixture(autouse=True)
def _log(tmp_path):
    global log
    log = ar.RunLog(tmp_path / 'home', datetime.now())


def test_known_task_non_2xx_stops_the_run(cfg, local_tool, local_db):
    tool = local_tool(tasks_status=500); cfg.local_url = tool.url
    with pytest.raises(ar.StageError) as e: ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1']))
    assert (e.value.stage, e.value.message) == ('tool', 'tool local lỗi 500')


def test_login_failure_stops_the_run_without_logging_the_password(cfg, local_tool, local_db):
    tool = local_tool(login_status=401); cfg.local_url = tool.url
    with pytest.raises(ar.StageError, match='tool local lỗi 401'): ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1']))
    assert 'local-pass' not in log.path.read_text(encoding='utf-8')          # the fixture's login file holds 'local-pass'


def test_healthy_tool_passes_and_empty_db_is_not_an_error(cfg, local_tool, local_db):
    tool = local_tool(); cfg.local_url = tool.url
    ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1'])); assert tool.paths[-1] == '/api/design-studio/tasks/LIT1_1'
    ar.ensure_tool(cfg, log, local_db(tasks=[]))


def test_down_tool_is_started_in_the_worktree(cfg, free_port, local_db, fake_node):
    cfg.local_url = f'http://127.0.0.1:{free_port}'
    with pytest.raises(ar.StageError, match='tool local lỗi'):                 # the stand-in serves 404 for the API
        ar.ensure_tool(cfg, log, local_db(tasks=['LIT1_1']))
    call = fake_node.calls()[0]
    assert call['args'][-3:] == ['dev', '--port', str(free_port)] and Path(call['cwd']) == cfg.tool_worktree


def test_process_run_never_pushes_and_finds_its_snapshot(cfg, fake_node, tmp_path):
    snap = cfg.main_checkout / 'db-backups' / 'prod-snap-20261112-0900.db'
    fake_node.plan(process={'snapshot': str(snap), 'shared': {'groups': []}})
    pr = ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'out', log)
    args = fake_node.calls()[0]['args']
    assert '--push' not in args and args[args.index('--since') + 1] == '2026-10-29'
    assert pr.snapshot == snap and pr.shared_spec is None and pr.flat is None


def test_process_failures_are_stage_errors(cfg, fake_node, tmp_path):
    fake_node.plan(process={'exit': 1})
    with pytest.raises(ar.StageError, match='process-new-orders thoát mã 1'): ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'o1', log)
    fake_node.plan(process={'noSnapshot': True})
    with pytest.raises(ar.StageError, match='không xác định được snapshot'): ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'o2', log)
    fake_node.plan(process={'sleep': 30})
    with pytest.raises(ar.StageError, match='quá'): ar.run_process_new_orders(cfg, '2026-10-29', tmp_path / 'o3', log, timeout_s=1)


def test_only_the_runs_own_snapshot_is_deleted(cfg):
    backups = cfg.main_checkout / 'db-backups'
    own = backups / 'prod-snap-20261112-0900.db'; other = backups / 'prod-snap-20261111c-after-mango-fix.db'
    own.write_bytes(b'x'); other.write_bytes(b'x')
    assert ar.drop_own_snapshot(cfg, own, log) and not own.exists()
    assert not ar.drop_own_snapshot(cfg, other, log) and other.exists()


def test_since_date():
    assert ar.since_date(datetime(2026, 11, 12, 9, 0), 14) == '2026-10-29'

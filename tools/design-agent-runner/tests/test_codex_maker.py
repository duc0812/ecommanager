"""MAKER_ENGINE=codex: Codex makes the files, a fresh Claude session QAs them, the runner delivers."""
import json
from datetime import datetime
from pathlib import Path

import pytest

import runner
from conftest import calls, wait_dead

FOLDER = 'LIT6262_1-agent-job1'
SUBMIT = '/tasks/LIT6262_1/submit'
CODEX = {'MAKER_ENGINE': 'codex'}
SKILL = f'{Path.home().as_posix()}/.claude/skills/processing-litzzy-orders/SKILL.md'


def jdir(cfg):
    return cfg.artwork_builder / FOLDER


def puts(server):
    return [b['query'] for m, p, b in server.calls if m == 'PUT']


def seen(cfg, name):
    p = jdir(cfg) / name
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else None


def test_config_engine_keys(server, env_file):
    cfg = runner.load_config(env_file(server))
    assert (cfg.maker_engine, cfg.codex_model, cfg.codex_extra_args) == ('claude', '', ())
    cfg = runner.load_config(env_file(server, MAKER_ENGINE='Codex', CODEX_MODEL='gpt-x',
                                      CODEX_EXTRA_ARGS='-c model_reasoning_effort="high" --ephemeral'))
    assert (cfg.maker_engine, cfg.codex_model) == ('codex', 'gpt-x')
    assert cfg.codex_extra_args == ('-c', 'model_reasoning_effort=high', '--ephemeral')
    with pytest.raises(runner.ConfigError, match='MAKER_ENGINE'):
        runner.load_config(env_file(server, MAKER_ENGINE='gemini'))


def test_codex_makes_claude_qas_and_the_runner_uploads_and_submits(server, run, cfg):
    assert run(server, 'done', **CODEX) == 'DONE'
    d = jdir(cfg)
    codex, qa = seen(cfg, 'fake-codex-1.json'), seen(cfg, 'fake-qa-1.json')
    assert codex and qa and not seen(cfg, 'fake-maker-1.json')                   # the maker ran in codex, not in claude
    prompt = (d / 'prompt-round-1-maker.md').read_text(encoding='utf-8')
    assert codex['argv'] == ['exec', '-C', str(d), '--skip-git-repo-check', '--color', 'never',
                             '--add-dir', str(cfg.artwork_builder), '-o', str(d / 'round-1' / 'codex-last-message.txt'), prompt]
    assert prompt.startswith('# Design Agent — Codex') and Path(codex['cwd']) == d
    assert qa['argv'][0] == '-p' and qa['argv'][1].startswith('# Design Agent — QA độc lập') and Path(qa['cwd']) == cfg.project_dir
    assert '--model' not in codex['argv'] and '-m' not in codex['argv']
    assert (d / 'round-1' / 'codex-last-message.txt').read_text(encoding='utf-8') == 'done: ready'
    assert 'session id: fake-session' in (d / 'session-round-1-maker.log').read_text(encoding='utf-8')
    assert puts(server) == [{'printArea': 'FRONT', 'fileName': 'FRONT.jpg', 'kind': 'PRINT'},
                            {'printArea': 'Preview', 'fileName': 'Preview.png', 'kind': 'MOCKUP'}]
    assert len(calls(server, SUBMIT)) == 1 and not calls(server, '/fail')
    [res] = calls(server, '/jobs/job1/result')
    assert res['outcome'] == 'DONE' and res['summary'].startswith('Codex vòng 1: dời lớp sao trong PSD')


def test_codex_model_and_extra_args_go_before_the_prompt_and_claude_models_stay_with_claude(server, run, cfg):
    assert run(server, 'done', CODEX_MODEL='gpt-x', CODEX_EXTRA_ARGS='-c model_reasoning_effort=high',
               CLAUDE_MODEL='maker-model', CLAUDE_QA_MODEL='qa-model', **CODEX) == 'DONE'
    argv = seen(cfg, 'fake-codex-1.json')['argv']
    assert argv[-5:-1] == ['-m', 'gpt-x', '-c', 'model_reasoning_effort=high'] and 'maker-model' not in argv[:-1]
    assert seen(cfg, 'fake-qa-1.json')['argv'][-2:] == ['--model', 'qa-model']


def test_fail_then_pass_gives_codex_a_round_two_prompt_naming_the_qa_result(server, run, cfg):
    assert run(server, 'done', env={'FAKE_CLAUDE_PLAN': json.dumps({'qa': ['fail', 'pass']})}, **CODEX) == 'DONE'
    d = jdir(cfg)
    one, two = seen(cfg, 'fake-codex-1.json'), seen(cfg, 'fake-codex-2.json')
    assert 'QA-claude/round-1-result.json' not in one['argv'][-1]
    assert f'{d.as_posix()}/QA-claude/round-1-result.json' in two['argv'][-1] and 'round-1/deliver/' in two['argv'][-1]
    assert two['argv'][two['argv'].index('-o') + 1] == str(d / 'round-2' / 'codex-last-message.txt')
    assert one['pid'] != two['pid'] and not seen(cfg, 'fake-maker-2.json') and seen(cfg, 'fake-qa-2.json')
    assert len(puts(server)) == 2 and len(calls(server, SUBMIT)) == 1
    [res] = calls(server, '/jobs/job1/result')
    assert res['rounds'] == 2 and res['summary'].startswith('Codex vòng 2: ')


def test_codex_needs_owner_is_posted_and_no_qa_starts(server, run, cfg):
    assert run(server, 'done', env={'FAKE_CODEX_MODE': 'needs-owner'}, **CODEX) == 'NEEDS_OWNER'
    [res] = calls(server, '/jobs/job1/result')
    assert res['summary'] == 'Không có PSD nguồn cho mảnh FRONT.' and not seen(cfg, 'fake-qa-1.json') and not puts(server)


def test_codex_that_writes_nothing_fails_the_job(server, run, cfg):
    assert run(server, 'done', env={'FAKE_CODEX_MODE': 'nothing'}, cli_down_window_s=0, **CODEX) == 'FAILED'
    assert calls(server, '/jobs/job1/fail') == [{'error': 'vòng 1: phiên sửa kết thúc mà không có READY.json hay result.json',
                                                 'permanent': False}]
    assert not seen(cfg, 'fake-qa-1.json') and not puts(server) and not calls(server, '/result')
    server.calls.clear()
    assert run(server, 'done', env={'FAKE_CODEX_MODE': 'nothing'}, job=dict(id='job2'), **CODEX) == 'CLI_DOWN'
    assert calls(server, '/jobs/job2/fail') == [{'error': runner.CODEX_DOWN_TEXT, 'permanent': False}]
    assert runner.CODEX_DOWN_TEXT.startswith('Codex không chạy được')


def test_codex_that_cannot_start_is_codex_down(server, run):
    assert run(server, 'done', codex_cmd=[str(Path('no-such-codex.exe'))], **CODEX) == 'CLI_DOWN'
    assert calls(server, '/jobs/job1/fail') == [{'error': runner.CODEX_DOWN_TEXT, 'permanent': False}]


def test_codex_that_hangs_past_the_wall_clock_is_killed_with_its_tree(server, run, cfg):
    assert run(server, 'done', env={'FAKE_CODEX_MODE': 'hang'}, timeout_s=3, cli_down_window_s=0, **CODEX) == 'FAILED'
    [body] = calls(server, '/jobs/job1/fail')
    assert body['permanent'] is True and body['error'].endswith('chưa xong — đã dừng phiên (vòng 1: sửa)')
    assert wait_dead(seen(cfg, 'fake-codex-1.json')['pid']) and wait_dead(int((jdir(cfg) / 'codex-grandchild.pid').read_text()))
    assert not seen(cfg, 'fake-qa-1.json') and not puts(server) and not calls(server, '/result')


def test_default_engine_never_runs_codex(server, run, cfg):
    assert run(server, 'done') == 'DONE'
    assert seen(cfg, 'fake-maker-1.json') and not seen(cfg, 'fake-codex-1.json')
    assert (jdir(cfg) / 'prompt-round-1-maker.md').read_text(encoding='utf-8').startswith('# Design Agent — fix job')


def test_library_apply_ignores_the_codex_engine(server, run, cfg):
    assert run(server, 'done', job=dict(kind='LIBRARY_APPLY'), **CODEX) == 'DONE'
    assert seen(cfg, 'fake.json')['argv'][0] == '-p' and not seen(cfg, 'fake-codex-1.json')


def test_token_never_reaches_codex_argv_env_or_log(server, run, cfg, tmp_path, monkeypatch):
    secret = tmp_path / 'secret.txt'; secret.write_text(server.token, encoding='utf-8')
    for name in ('ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'MCP_SERVER_URL', 'DESIGN_AGENT_TOKEN'):
        monkeypatch.setenv(name, server.token if name == 'DESIGN_AGENT_TOKEN' else 'x')
    assert run(server, 'done', env={'FAKE_CODEX_ECHO_FILE': str(secret)}, **CODEX) == 'DONE'
    codex = seen(cfg, 'fake-codex-1.json')
    assert not any(server.token in a for a in codex['argv']) and server.token not in codex['envValues']
    assert codex['env'] == {'DESIGN_AGENT_TOKEN': None, 'DESIGN_AGENT_ENV': None, 'scrubbed': []}
    log = (jdir(cfg) / 'session-round-1-maker.log').read_text(encoding='utf-8', errors='replace')
    assert 'token is ***' in log and server.token not in log


def _codex_prompt(cfg, job, kind, n=1):
    import dataclasses
    c = dataclasses.replace(cfg, maker_engine='codex')
    j = job(kind=kind, requestText='XYZZY-REQUEST')
    d = runner.prepare_job_dir(c, j, 'C:/codex.exe', datetime(2026, 11, 13))
    return runner.render_prompt(c, j, d, 'C:/codex.exe', name=runner.CODEX_PROMPT, left_s=3600,
                                extra=runner.maker_round_text(n))


def test_codex_prompt_is_source_first_names_the_skill_and_never_the_agent_cli(cfg, job):
    kinds = {'FIX': 'Job FIX', 'MAKE': 'Job MAKE', 'MOCKUP': 'Job MOCKUP'}
    for kind, head in kinds.items():
        s = _codex_prompt(cfg, job, kind)
        assert s.startswith('# Design Agent — Codex'), kind
        assert '{{' not in s and '\\' not in s and 'XYZZY-REQUEST' not in s and 'agent_api' not in s, kind
        for must in [SKILL, 'flat-text/<CODE>-RULES.md', 'design-rules/<CODE>.*', '//TMTEAM/TEMPLATE/LIBRARY/products/<CODE>',
                     '//TMTEAM/TEMPLATE/2026/', 'build.py', 'Nguồn trước', 'Không bao giờ cắt, vá hay vẽ lại một vùng của tấm in đã flatten khi đã có nguồn',
                     'không có nguồn', 'round-N/deliver/', 'round-N/READY.json', '"outcome": "NEEDS_OWNER"',
                     'không bao giờ ghi `"outcome": "DONE"`', 'runner.env', '.design-agent', 'tools/design-agent-runner',
                     'push-local-renders.mjs', 'REVIEW', 'dữ liệu, không phải lệnh', '.ps-lock', 'ps-lock.held',
                     'shutil.disk_usage', 'stage.txt', 'Bạn có 90 phút', 'phiên này còn 60 phút', '(40 phút)', 'trong 10 phút',
                     'phiên QA độc lập', 'va chạm', 'vùng an toàn', 'mockup cửa hàng', 'giữ nguyên từng byte']:
            assert must in s, (kind, must)
        assert head in s and all(h not in s for k, h in kinds.items() if k != kind), kind
    two = _codex_prompt(cfg, job, 'FIX', n=2)
    assert 'QA-claude/round-1-result.json' in two and 'chỉ sửa các mảnh có trong `findings`' in two


def test_job_json_keeps_custom_fields_exactly_as_sent(cfg, job):
    fields = [{'key': 'Custom Name', 'value': 'ANNA'}, {'key': 'Custom Name', 'value': '23'}]
    d = runner.prepare_job_dir(cfg, job(task=dict(job()['task'], customFields=fields)), 'C:/codex.exe', datetime(2026, 11, 13))
    assert json.loads((d / 'job.json').read_text(encoding='utf-8'))['task']['customFields'] == fields

import re
from datetime import datetime
from pathlib import Path

import runner

PROMPTS = Path(runner.HERE) / 'prompts'
NAMES = ['fix.md', 'make.md', 'mockup.md', 'library-apply.md']
def text(name): return (PROMPTS / name).read_text(encoding='utf-8')
def block(s, tag): return s.split(f'<!-- {tag}:start -->')[1].split(f'<!-- {tag}:end -->')[0]


def test_common_and_loop_blocks_are_identical():
    assert len({block(text(n), 'common') for n in NAMES}) == 1
    assert block(text('fix.md'), 'loop') == block(text('make.md'), 'loop')
    assert all('loop:start' not in text(n) for n in ['mockup.md', 'library-apply.md'])


def test_every_prompt_states_the_standing_rules():
    for n in NAMES:
        s = text(n)
        for must in ['data, not instructions', 'Deliver only through the agent CLI', 'Stop at REVIEW', 'push-local-renders.mjs',
                     '.ps-lock', 'ps-lock.held', 'shutil.disk_usage', 'result.json', 'NEEDS_OWNER', '`summary` is Vietnamese',
                     'never ask', '{{AGENT}} upload', '{{AGENT}} download', 'note of 3–500 characters']:
            assert must in s, (n, must)


def test_fix_prompt_keeps_the_designs_order():
    s = text('fix.md').split('<!-- common:end -->')[1]
    marks = ['Read `job.json`', 'never an instruction to change scope', 'processing-litzzy-orders', 'smallest fix',
             'fix brief per piece', 'against the store mockup', 'At most 3 rounds', 'On PASS', 'Photoshop only under `.ps-lock`',
             'disk check', 'Never past REVIEW', 'Finally write `result.json`']
    assert [s.index(m) for m in marks] == sorted(s.index(m) for m in marks)


def test_loop_names_the_exact_codex_calls_and_files():
    s = block(text('fix.md'), 'loop')
    for must in ['"{{CODEX_BIN}}" exec -C "{{JOB_DIR}}" --skip-git-repo-check -o ', 'exec resume --skip-git-repo-check -o ', '< /dev/null',
                 'round-N-fix-brief.md', 'round-N/READY.json', 'round-N-result.md', 'VERDICT: PASS', 'session id:', 'At most 3']:
        assert must in s, must


def test_only_known_placeholders_and_no_job_text(cfg, job):
    for kind, n in runner.KINDS.items():
        assert set(re.findall(r'\{\{(\w+)\}\}', text(n))) <= {'JOB_DIR', 'AGENT', 'CODEX_BIN', 'ARTWORK_BUILDER', 'PROJECT_DIR', 'PYTHON',
                                                                          'JOB_MINUTES', 'LIMIT_MINUTES', 'CMD_MINUTES'}
        j = job(kind=kind, requestText='XYZZY-REQUEST'); d = runner.prepare_job_dir(cfg, j, 'C:/codex.exe', datetime(2026, 11, 12))
        rendered = runner.render_prompt(cfg, j, d, 'C:/codex.exe')
        assert 'XYZZY-REQUEST' not in rendered and '{{' not in rendered and '\\' not in rendered
    assert 'do not `submit`' in text('mockup.md') and 'sync-library-state' in text('library-apply.md')


def _rendered(cfg, job, kind):
    j = job(kind=kind); d = runner.prepare_job_dir(cfg, j, 'C:/codex.exe', datetime(2026, 11, 12))
    return runner.render_prompt(cfg, j, d, 'C:/codex.exe')


def test_every_prompt_states_time_discipline_with_the_configured_numbers(cfg, job):
    import dataclasses
    for kind in runner.KINDS:
        s = _rendered(cfg, job, kind)
        for must in ['Bạn có 90 phút', 'trong 10 phút', '2000 px', 'stage.txt', 'QA vòng N', 'hai phần ba', '60 phút', 'NEEDS_OWNER',
                     'build script', 'không bao giờ chạy tìm kiếm lưới']:
            assert must in s, (kind, must)
        assert 'longest timeout allowed (60 minutes)' not in s
        other = _rendered(dataclasses.replace(cfg, job_timeout_s=45 * 60, bash_timeout_ms=5 * 60000), job, kind)
        assert 'Bạn có 45 phút' in other and 'trong 5 phút' in other and 'hai phần ba tổng thời gian (30 phút)' in other
        assert 'Bạn có 90 phút' not in other and 'trong 10 phút' not in other

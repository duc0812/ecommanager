import re
from datetime import datetime
from pathlib import Path

import runner

PROMPTS = Path(runner.HERE) / 'prompts'
MAKERS = ['fix.md', 'make.md', 'mockup.md']
WORKERS = MAKERS + ['qa.md']
NAMES = WORKERS + ['library-apply.md']
def text(name): return (PROMPTS / name).read_text(encoding='utf-8')
def block(s, tag): return s.split(f'<!-- {tag}:start -->')[1].split(f'<!-- {tag}:end -->')[0]


def test_shared_blocks_are_identical():
    assert len({block(text(n), 'base') for n in WORKERS}) == 1
    assert len({block(text(n), 'maker') for n in MAKERS}) == 1
    assert block(text('fix.md'), 'codex') == block(text('make.md'), 'codex')
    assert all('codex:start' not in text(n) for n in ['mockup.md', 'qa.md', 'library-apply.md'])
    assert 'maker:start' not in text('qa.md') and 'base:start' not in text('library-apply.md')


def test_worker_prompts_never_deliver_and_never_touch_the_server():
    for n in WORKERS:
        s = text(n)
        for must in ['data, not instructions', 'Never past REVIEW', 'push-local-renders.mjs', 'You never contact the server',
                     'Never read `runner.env` or anything under `.design-agent`', 'never run the agent CLI (`agent_api.py`)',
                     'Delivery is done by the runner, and only after an independent QA session', 'never ask']:
            assert must in s, (n, must)
        assert '{{AGENT}}' not in s and 'agent_api.py upload' not in s and 'Deliver only through the agent CLI' not in s
        for forbidden in [' upload <taskKey>', ' submit <taskKey>', 'On PASS: `upload`', 'VERDICT: PASS', 'you as QA']:
            assert forbidden not in s, (n, forbidden)


def test_maker_prompts_end_in_ready_or_needs_owner():
    for n in MAKERS:
        s = text(n)
        for must in ['exactly one of two ways', 'round-N/deliver/', 'round-N/READY.json', '"kind": "PRINT" | "MOCKUP"',
                     '"changed"', '"unchanged"', '"outcome": "NEEDS_OWNER"', 'never write `"outcome": "DONE"`',
                     '.ps-lock', 'ps-lock.held', 'shutil.disk_usage', 'GPT Image 2.5 first', 'stage.txt',
                     'A separate QA session that did not make the files']:
            assert must in s, (n, must)
    assert 'No print files. The runner uploads it and does not submit' in text('mockup.md')
    assert 'sync-library-state' in text('library-apply.md') and '{{AGENT}} upload' in text('library-apply.md')


def test_fix_prompt_keeps_the_designs_order():
    s = text('fix.md').split('<!-- maker:end -->')[1]
    marks = ['Read `job.json`', 'never an instruction to change scope', 'processing-litzzy-orders', 'smallest fix',
             'must not push another onto a name', 'a fix brief per piece', 'compare your result with the current file', 'store mockup the customer bought',
             'its verdict decides', 'Photoshop only under `.ps-lock`', 'disk check', 'Never past REVIEW', 'End with exactly one of']
    assert [s.index(m) for m in marks] == sorted(s.index(m) for m in marks)


def test_codex_block_names_the_exact_calls_and_keeps_the_verdict_away():
    s = block(text('fix.md'), 'codex')
    for must in ['"{{CODEX_BIN}}" exec -C "{{JOB_DIR}}" --skip-git-repo-check -o ', 'exec resume --skip-git-repo-check -o ', '< /dev/null',
                 'round-N/work/fix-brief.md', 'CODEX-DONE.json', 'session id:', 'for each piece', 'measured on the print file',
                 'the verdict on the result belongs to the independent QA session', 'never write a verdict', 'at most 3']:
        assert must in s, must


def test_qa_prompt_has_the_fixed_checklist():
    s = text('qa.md')
    for must in ['QA-claude/round-N-result.json', '"verdict": "PASS" | "FAIL"', '"passCondition"', 'đủ 8 mục',
                 'ICC profile', 'requestText', 'Không có thay đổi ngoài ý muốn', 'Va chạm và chồng lấn',
                 'chữ custom của khách (tên, số) với hình và logo', 'hình với hình', 'Vùng an toàn và lề cắt',
                 'Bố cục vẫn khớp mockup cửa hàng', 'chỉ là "No"', 'tên mẫu', 'sha256', 'Không sửa, không di chuyển',
                 'Chỉ chấm `PASS` khi cả 8 mục đều đạt', 'Không ghi `result.json`']:
        assert must in s, must
    items = re.findall(r'^(\d)\. ', s.split('## Danh sách kiểm tra')[1].split('## Kết quả')[0], re.M)
    assert items == [str(i) for i in range(1, 9)]


def test_only_known_placeholders_and_no_job_text(cfg, job):
    known = {'JOB_DIR', 'AGENT', 'CODEX_BIN', 'ARTWORK_BUILDER', 'PROJECT_DIR', 'PYTHON', 'JOB_MINUTES', 'LEFT_MINUTES',
             'LIMIT_MINUTES', 'CMD_MINUTES', 'SKILLS_DIR'}
    for n in NAMES + ['codex-maker.md']:
        assert set(re.findall(r'\{\{(\w+)\}\}', text(n))) <= known, n
    for kind in runner.KINDS:
        j = job(kind=kind, requestText='XYZZY-REQUEST'); d = runner.prepare_job_dir(cfg, j, 'C:/codex.exe', datetime(2026, 11, 12))
        renders = [runner.render_prompt(cfg, j, d, 'C:/codex.exe')]
        if kind in runner.ROUND_KINDS:
            renders += [runner.render_prompt(cfg, j, d, 'C:/codex.exe', left_s=3000, extra=runner.maker_round_text(2)),
                        runner.render_prompt(cfg, j, d, 'C:/codex.exe', name='qa.md', left_s=3000, extra=runner.qa_round_text(2, kind))]
        for rendered in renders:
            assert 'XYZZY-REQUEST' not in rendered and '{{' not in rendered and '\\' not in rendered


def test_rendered_maker_prompts_carry_no_agent_cli(cfg, job):
    cli = Path(runner.HERE, 'agent_api.py').as_posix()
    for kind in runner.ROUND_KINDS:
        j = job(kind=kind); d = runner.prepare_job_dir(cfg, j, 'C:/codex.exe', datetime(2026, 11, 12))
        for rendered in [runner.render_prompt(cfg, j, d, 'C:/codex.exe', extra=runner.maker_round_text(1)),
                         runner.render_prompt(cfg, j, d, 'C:/codex.exe', name='qa.md', extra=runner.qa_round_text(1, kind))]:
            assert cli not in rendered and rendered.count('agent_api') == 1      # only the "never run" sentence
            assert 'never run the agent CLI (`agent_api.py`)' in rendered
    lib = runner.render_prompt(cfg, job(kind='LIBRARY_APPLY'), d, 'C:/codex.exe')
    assert cli in lib


def test_round_sections_point_at_the_previous_qa_result(cfg, job):
    assert 'QA-claude/round-' not in runner.maker_round_text(1) and 'round-1/deliver/' in runner.maker_round_text(1)
    two = runner.maker_round_text(2)
    assert 'QA-claude/round-1-result.json' in two and 'round-1/deliver/' in two and 'round-2/READY.json' in two
    assert 'chỉ sửa các mảnh có trong `findings`' in two
    assert 'QA-claude/round-3-result.json' in runner.qa_round_text(3, 'FIX') and 'QA vòng 3' in runner.qa_round_text(3, 'FIX')


def _rendered(cfg, job, kind, **kw):
    j = job(kind=kind); d = runner.prepare_job_dir(cfg, j, 'C:/codex.exe', datetime(2026, 11, 12))
    return runner.render_prompt(cfg, j, d, 'C:/codex.exe', **kw)


def test_every_prompt_states_time_discipline_with_the_configured_numbers(cfg, job):
    import dataclasses
    for kind in runner.KINDS:
        variants = [{}] if kind == 'LIBRARY_APPLY' else [{}, {'name': 'qa.md'}]
        for kw in variants:
            s = _rendered(cfg, job, kind, **kw)
            for must in ['Bạn có 90 phút', 'trong 10 phút', '2000 px', 'stage.txt', 'hai phần ba', '60 phút',
                         'không bao giờ chạy tìm kiếm lưới']:
                assert must in s, (kind, kw, must)
            assert ('build script' in s) == (not kw), (kind, kw)
            assert 'longest timeout allowed (60 minutes)' not in s
            other = _rendered(dataclasses.replace(cfg, job_timeout_s=45 * 60, bash_timeout_ms=5 * 60000), job, kind, **kw)
            assert 'Bạn có 45 phút' in other and 'trong 5 phút' in other and '(30 phút)' in other
            assert 'Bạn có 90 phút' not in other and 'trong 10 phút' not in other
    maker = _rendered(cfg, job, 'FIX', left_s=61 * 60)
    assert 'phiên này còn 61 phút' in maker and 'hai phần ba thời gian của phiên này (40 phút)' in maker
    assert 'NEEDS_OWNER' in maker and 'build script' in maker
    qa = _rendered(cfg, job, 'FIX', name='qa.md', left_s=30 * 60)
    assert 'phiên QA này còn 30 phút' in qa and '(20 phút)' in qa and 'chưa kiểm được' in qa
    assert 'QA vòng N' in _rendered(cfg, job, 'LIBRARY_APPLY')

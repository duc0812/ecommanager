"""Design Agent runner: claims jobs from Ecom Manager and runs each with headless Claude Code sessions on this PC.

One process, one claim loop, one thread per running job. FIX, MAKE and MOCKUP jobs run in rounds: a maker session
(Claude, or Codex with MAKER_ENGINE=codex) writes candidate files, a fresh Claude QA session judges them, and only the
runner talks to the server and delivers.
LIBRARY_APPLY runs as one session that delivers through agent_api.py. See README.md and the spec
docs/superpowers/specs/2026-11-12-designer-agent-design.md ("Runner on the PC", "Interface contract").
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import agent_api
from agent_api import AgentApi, ApiError, AuthError, read_env

HERE = Path(__file__).resolve().parent

EXIT_OK, EXIT_CONFIG, EXIT_AUTH, EXIT_CLI = 0, 2, 3, 4
KINDS = {'FIX': 'fix.md', 'MAKE': 'make.md', 'MOCKUP': 'mockup.md', 'LIBRARY_APPLY': 'library-apply.md'}
KEY_RE = r'^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'
ID_RE = r'^[A-Za-z0-9_-]{1,64}$'
DEFAULT_ARTWORK_BUILDER = r'D:\Ecom manager\artwork-builder'
DEFAULT_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,Skill'
ROUND_KINDS = ('FIX', 'MAKE', 'MOCKUP')
QA_PROMPT = 'qa.md'
CODEX_PROMPT = 'codex-maker.md'
ENGINES = ('claude', 'codex')
CODEX_SCRUB_PREFIXES = ('CLAUDE', 'ANTHROPIC', 'MCP_')
CODEX_SCRUB_NAMES = ('DESIGN_AGENT_ENV', 'DESIGN_AGENT_HOME')
MAX_ROUNDS = 3
HELD_SOURCE = 'AUTO_HOLD'
HELD_IMAGE_EXT = ('.jpg', '.jpeg', '.png', '.tif', '.tiff')
DELIVER_EXT = ('.jpg', '.jpeg', '.png')
CLI_RULE_MARK = 'agent_api'
SERVER_GUARD = (
    'Bash(*runner.env*)', 'Bash(*.design-agent*)', 'Bash(*agent_api*)', 'Bash(*design-agent/runner*)',
    'Read(~/.design-agent/**)',
)
DEFAULT_DISALLOWED = (
    'Bash(*push-local-renders*)', 'Bash(*push-shared-prints*)', 'Bash(*push_s2n*)', 'Bash(*apply_chunk*)',
    'Bash(*process-new-orders*)', 'Bash(ssh:*)', 'Bash(scp:*)', *SERVER_GUARD,
)
DEFAULT_BASH_TIMEOUT_MS = 600000
STALE_NAMES = ('result.json', 'stage.txt', 'session.log', 'api-calls.jsonl', 'ps-lock.held')
STALE_RE = re.compile(r'(round-\d+|QA-claude|session-round-\d+-(maker|qa)\.log|prompt-round-\d+-(maker|qa)\.md)')


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    ecom_url: str
    token: str
    max_concurrent: int
    claude_bin: str
    project_dir: Path
    artwork_builder: Path
    codex_bin: str
    allowed_tools: tuple
    disallowed_tools: tuple
    permission_mode: str
    model: str
    qa_model: str
    job_timeout_s: float
    bash_timeout_ms: int
    maker_engine: str = 'claude'
    codex_model: str = ''
    codex_extra_args: tuple = ()


def _number(values: dict, key: str, default, cast, path: Path):
    raw = values.get(key, '').strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except ValueError:
        raise ConfigError(f'{key} phải là số (đang là "{raw}") trong {path}') from None


def load_config(path: Path) -> Config:
    path = Path(path)
    if not path.is_file():
        raise ConfigError(f'không thấy file cấu hình {path}')
    values = read_env(path)

    def need(key: str) -> str:
        value = values.get(key, '').strip()
        if not value:
            raise ConfigError(f'thiếu {key} trong {path}')
        return value

    ecom_url, token, project = need('ECOM_URL'), need('DESIGN_AGENT_TOKEN'), need('PROJECT_DIR')
    try:
        agent_api.check_base_url(ecom_url)
    except ValueError as exc:
        raise ConfigError(f'ECOM_URL không hợp lệ trong {path}: {exc}') from None
    project_dir = Path(project)
    if not (project_dir / 'CLAUDE.md').is_file():
        raise ConfigError(f'PROJECT_DIR không phải thư mục dự án (không có CLAUDE.md): {project_dir} (file {path})')
    builder = Path(values.get('ARTWORK_BUILDER', '').strip() or DEFAULT_ARTWORK_BUILDER)
    if not builder.is_dir():
        raise ConfigError(f'ARTWORK_BUILDER không phải thư mục: {builder} (file {path})')
    claude_bin = values.get('CLAUDE_BIN', '').strip() or 'claude'
    if claude_bin.lower().endswith(('.cmd', '.bat')):
        raise ConfigError(f'CLAUDE_BIN không được là .cmd / .bat: {claude_bin} (file {path}); dùng claude.exe')
    tools = tuple(t for t in re.split(r'[,\s]+', values.get('CLAUDE_ALLOWED_TOOLS', '').strip() or DEFAULT_TOOLS) if t)
    deny_raw = values.get('CLAUDE_DISALLOWED_TOOLS', '').strip()
    if not deny_raw:
        deny = DEFAULT_DISALLOWED
    elif deny_raw.lower() == 'none':
        deny = ()
    else:
        deny = tuple(t.strip() for t in deny_raw.split(',') if t.strip())
    max_concurrent = max(1, min(10, _number(values, 'MAX_CONCURRENT', 5, int, path)))
    minutes = _number(values, 'JOB_TIMEOUT_MINUTES', 90, float, path)
    model = values.get('CLAUDE_MODEL', '').strip()
    engine = values.get('MAKER_ENGINE', '').strip().lower() or 'claude'
    if engine not in ENGINES:
        raise ConfigError(f'MAKER_ENGINE phải là claude hoặc codex (đang là "{engine}") trong {path}')
    try:
        codex_extra = tuple(shlex.split(values.get('CODEX_EXTRA_ARGS', '').strip()))
    except ValueError as exc:
        raise ConfigError(f'CODEX_EXTRA_ARGS không tách được ({exc}) trong {path}') from None
    return Config(
        ecom_url=ecom_url, token=token, max_concurrent=max_concurrent, claude_bin=claude_bin,
        project_dir=project_dir, artwork_builder=builder, codex_bin=values.get('CODEX_BIN', '').strip(),
        allowed_tools=tools, disallowed_tools=deny, permission_mode=values.get('CLAUDE_PERMISSION_MODE', '').strip() or 'dontAsk',
        model=model, qa_model=values.get('CLAUDE_QA_MODEL', '').strip() or model, job_timeout_s=minutes * 60,
        bash_timeout_ms=_number(values, 'BASH_TIMEOUT_MS', DEFAULT_BASH_TIMEOUT_MS, int, path),
        maker_engine=engine, codex_model=values.get('CODEX_MODEL', '').strip(), codex_extra_args=codex_extra)


def resolve_codex(configured: str, local_appdata: str | None = None) -> str:
    if configured:
        if not Path(configured).is_file():
            raise ConfigError(f'CODEX_BIN không phải file: {configured}')
        return configured
    base = Path(local_appdata or os.environ.get('LOCALAPPDATA', '')) / 'OpenAI' / 'Codex' / 'bin'
    found = [p for p in base.glob('*/codex.exe') if p.is_file()]
    if not found:
        raise ConfigError(f'không thấy codex.exe trong {base}')
    return str(max(found, key=lambda p: p.stat().st_mtime))


class Log:
    def __init__(self, home: Path, secrets: list[str]):
        self.dir = Path(home) / 'logs'
        self.secrets = sorted((s for s in secrets if s), key=len, reverse=True)
        self.lock = threading.Lock()

    def line(self, text: str) -> None:
        for secret in self.secrets:
            text = text.replace(secret, '***')
        now = datetime.now()
        entry = f'[{now:%Y-%m-%d %H:%M:%S}] {text}'
        with self.lock:
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                with open(self.dir / f'runner-{now:%Y-%m-%d}.log', 'a', encoding='utf-8') as fh:
                    fh.write(entry + '\n')
            except OSError:
                pass
            try:
                print(entry, flush=True)
            except (UnicodeError, OSError):
                pass


def prune_logs(home: Path, days: int = 30) -> int:
    removed = 0
    cutoff = time.time() - days * 86400
    for path in (Path(home) / 'logs').glob('runner-*.log'):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            pass
    return removed


def validate_job(job: dict) -> str | None:
    if not isinstance(job, dict) or not re.match(ID_RE, str(job.get('id') or '')):
        return 'job thiếu id hợp lệ'
    if job.get('kind') not in KINDS:
        return f'loại job không hỗ trợ: {job.get("kind")}'
    task = job.get('task')
    if not isinstance(task, dict) or not re.match(KEY_RE, str(task.get('key') or '')):
        return 'mã task không hợp lệ'
    return None


def job_dir_for(cfg: Config, job: dict) -> Path:
    return cfg.artwork_builder / f'{job["task"]["key"]}-agent-{job["id"]}'


def prepare_job_dir(cfg: Config, job: dict, codex_bin: str, now: datetime) -> Path:
    d = job_dir_for(cfg, job)
    d.mkdir(parents=True, exist_ok=True)
    stamp = now.strftime('%Y%m%d-%H%M%S')
    for name in STALE_NAMES:
        old = d / name
        if old.exists():
            os.replace(old, d / f'prev-{stamp}-{name}')
    for old in list(d.iterdir()):
        if STALE_RE.fullmatch(old.name):
            os.replace(old, d / f'prev-{stamp}-{old.name}')
    saved = dict(job)
    saved['runner'] = {'jobDir': str(d), 'attempt': job.get('attempts'), 'codexBin': codex_bin,
                       'artworkBuilder': str(cfg.artwork_builder), 'projectDir': str(cfg.project_dir),
                       'claimedAt': now.isoformat(timespec='seconds')}
    (d / 'job.json').write_text(json.dumps(saved, ensure_ascii=False, indent=1), encoding='utf-8')
    (d / 'runner-state.json').write_text(json.dumps(
        {'jobId': job['id'], 'attempt': job.get('attempts'), 'startedAt': now.isoformat(timespec='seconds'),
         'finished': False, 'outcome': None}, ensure_ascii=False), encoding='utf-8')
    return d


def _safe(text: str) -> str:
    return re.sub(r'[^A-Za-z0-9 ._-]', '_', text)


def fetch_current_files(api: AgentApi, job: dict, job_dir: Path) -> list[dict]:
    cur = Path(job_dir) / 'current'
    cur.mkdir(parents=True, exist_ok=True)
    index: list[dict] = []
    for item in job.get('files') or []:
        art_id = item.get('id') or str(item.get('url', '')).rstrip('/').rsplit('/', 1)[-1]
        ext = _safe(Path(str(item.get('fileName') or '')).suffix)
        name = _safe(f'{item.get("kind")}-{item.get("printArea")}-v{item.get("version")}') + ext
        dest = cur / name
        api.download(art_id, dest)
        index.append({'id': art_id, 'kind': item.get('kind'), 'printArea': item.get('printArea'),
                      'version': item.get('version'), 'fileName': item.get('fileName'), 'path': str(dest)})
    (cur / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')
    return index


def is_held_make(job: dict, index: list[dict]) -> bool:
    return job.get('kind') == 'FIX' and job.get('source') == HELD_SOURCE and not any(i.get('kind') == 'PRINT' for i in index)


def copy_held_render(cfg: Config, job: dict, job_dir: Path) -> list[dict]:
    key = job['task']['key']
    src = Path(cfg.artwork_builder) / 'flat-text' / '_out' / key
    dest = Path(job_dir) / 'current' / 'held'
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    index: list[dict] = []
    if src.is_dir():
        prefix = f'{key} - '
        for item in sorted(src.iterdir()):
            if not item.is_file():
                continue
            shutil.copy2(item, dest / item.name)
            area = item.stem[len(prefix):] if item.suffix.lower() in HELD_IMAGE_EXT and item.stem.startswith(prefix) else None
            index.append({'file': item.name, 'printArea': area, 'path': _posix(dest / item.name), 'source': _posix(item)})
    (dest / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')
    return index


def held_make_text(key: str) -> str:
    ab, pd, jd = '{{ARTWORK_BUILDER}}', '{{PROJECT_DIR}}', '{{JOB_DIR}}'
    return '\n'.join([
        '## Dòng AUTO bị giữ', '',
        'Job này đến từ auto render hằng giờ (`source` là `AUTO_HOLD`), không phải từ designer. Dòng đã được render ở máy '
        'local nhưng bị giữ lại, chưa bao giờ được đẩy lên, vì lý do ghi trong `requestText` (ví dụ tên vượt khung). Vì vậy '
        '`files` và `current/index.json` rỗng là đúng: không có bản in lỗi nào trên server để sửa hay để đo. Làm job này như '
        'một job MAKE (làm file in cho dòng chưa có); không kết thúc chỉ vì thiếu file hiện tại.',
        '',
        f'- Bản render bị giữ: render flat-text nằm ở `{ab}/flat-text/_out/{key}/` (cùng `photoshop-job.json` và '
        f'`photoshop-report.json` khi spec render bằng Photoshop); render từ thư viện nằm trong storage của tool local, '
        f'`{pd}/storage/design/{key}/<vùng in>/` (các hàng DesignArtwork của task trong `{pd}/dev.db`). Runner đã chép bản '
        f'flat-text tìm thấy vào `{jd}/current/held/` kèm `index.json` (danh sách rỗng là không tìm thấy). Đó là bản sao để '
        'đo và so: không sửa, dời hay xoá bản gốc.',
        f'- Nguồn để sửa là spec flat-text của design (`{ab}/flat-text/<spec>/spec.json`, luật trong '
        f'`{ab}/flat-text/<CODE>-RULES.md`) hoặc mục thư viện của design, không phải tấm in đã flatten. Render lại dòng này '
        'từ nguồn sao cho lý do giữ hết, theo luật của design (ví dụ thu tên cho vừa khung của nó). Không ghi đè spec hay '
        'thư viện dùng chung: render từ bản sao trong thư mục job, và nói trong `unchanged` spec hay thư viện nên đổi gì.',
        '- Giao đủ file in cho mọi vùng in của template của dòng (kind `PRINT`, `printArea` đúng tên template), cộng một '
        'mockup theo mục "Mockup rule" của skill `processing-litzzy-orders`.',
    ])


def held_qa_text() -> str:
    return '\n'.join([
        '## Dòng AUTO bị giữ', '',
        'Dòng này bị auto render hằng giờ giữ lại trước khi đẩy lên (lý do trong `requestText`), nên chấm như job make: '
        'không có file hiện tại, thông số so với template. Bản render bị giữ ở `{{JOB_DIR}}/current/held/` chỉ để đối chiếu; '
        'mục 2 là lý do giữ đã thật sự hết (đo gì, ở đâu, được số nào).',
    ])


def _posix(p) -> str:
    return Path(p).as_posix()


def _minutes(seconds: float) -> str:
    return f'{seconds / 60:.1f}'.rstrip('0').rstrip('.') if seconds % 60 else str(int(seconds // 60))


def _whole_minutes(seconds: float) -> str:
    return str(int(max(0.0, seconds) // 60))


def render_prompt(cfg: Config, job: dict, job_dir: Path, codex_bin: str, *, name: str | None = None,
                  left_s: float | None = None, extra: str = '', out_name: str = 'prompt.md') -> str:
    text = (HERE / 'prompts' / (name or KINDS[job['kind']])).read_text(encoding='utf-8')
    if name == CODEX_PROMPT:
        text = select_kind(text, job['kind'])
    if extra:
        text = text.rstrip('\n') + '\n\n' + extra.strip('\n') + '\n'
    py = _posix(sys.executable)
    if left_s is None:
        left, limit = _minutes(cfg.job_timeout_s), _minutes(cfg.job_timeout_s * 2 / 3)
    else:
        left, limit = _whole_minutes(left_s), _whole_minutes(left_s * 2 / 3)
    values = {'JOB_DIR': _posix(job_dir), 'ARTWORK_BUILDER': _posix(cfg.artwork_builder),
              'PROJECT_DIR': _posix(cfg.project_dir), 'CODEX_BIN': _posix(codex_bin), 'PYTHON': py,
              'AGENT': f'"{py}" "{_posix(HERE / "agent_api.py")}"',
              'JOB_MINUTES': _minutes(cfg.job_timeout_s), 'LEFT_MINUTES': left, 'LIMIT_MINUTES': limit,
              'CMD_MINUTES': _minutes(cfg.bash_timeout_ms / 1000),
              'SKILLS_DIR': _posix(Path.home() / '.claude' / 'skills')}
    for key, value in values.items():
        text = text.replace('{{' + key + '}}', value)
    (Path(job_dir) / out_name).write_text(text, encoding='utf-8')
    return text


_KIND_BLOCK = re.compile(r'<!-- kind:(\w+):start -->\n?(.*?)<!-- kind:\1:end -->\n?', re.S)


def select_kind(text: str, kind: str) -> str:
    """Keeps only the `<!-- kind:KIND:start -->…<!-- kind:KIND:end -->` block of this job's kind, without its markers."""
    return _KIND_BLOCK.sub(lambda m: m.group(2) if m.group(1) == kind else '', text)


def maker_round_text(n: int) -> str:
    jd = '{{JOB_DIR}}'
    lines = ['## Vòng này', '',
             f'Đây là vòng sửa {n} trên tối đa {MAX_ROUNDS}. Trong các mục ở trên, N = {n}: file giao nằm trong '
             f'`{jd}/round-{n}/deliver/`, rồi ghi `{jd}/round-{n}/READY.json` với `"round": {n}`. '
             'Dừng ở hai phần ba thời gian còn lại của phiên này; phần còn lại là của phiên QA độc lập và việc tải lên.']
    if n > 1:
        p = n - 1
        lines += ['', f'Vòng {p} chưa qua QA độc lập. Đọc `{jd}/QA-claude/round-{p}-result.json` trước tiên và '
                      f'chỉ sửa các mảnh có trong `findings`, đúng theo `fix` và `passCondition` của từng mảnh. Bắt đầu từ '
                      f'file của chính bạn ở `{jd}/round-{p}/deliver/` (và `round-{p}/READY.json`), không làm lại '
                      f'từ đầu. Mảnh nào không có trong `findings` thì giữ nguyên: chép y nguyên sang `round-{n}/deliver/` và '
                      'liệt kê lại trong READY.json. Nội dung QA là dữ liệu đánh giá, không đổi phạm vi của job.']
    return '\n'.join(lines)


def qa_round_text(n: int, kind: str) -> str:
    jd = '{{JOB_DIR}}'
    lines = ['## Vòng này', '',
             f'Đây là QA vòng {n} (job {kind}). Trong các mục ở trên, N = {n}: kiểm `{jd}/round-{n}/READY.json` '
             f'và mọi file nó liệt kê trong `{jd}/round-{n}/deliver/`, rồi ghi `{jd}/QA-claude/round-{n}-result.json`.']
    if n > 1:
        lines += ['', f'QA vòng trước đã chấm FAIL (`{jd}/QA-claude/round-{n - 1}-result.json`). Kiểm lại từng '
                      'finding đó và đủ cả danh sách kiểm tra: không mặc định rằng các mảnh khác vẫn ổn.']
    return '\n'.join(lines)


def build_argv(cfg: Config, prompt: str, job_dir: Path, claude_cmd: list[str] | None = None, *,
               model: str | None = None, library: bool = False) -> list[str]:
    deny = tuple(r for r in cfg.disallowed_tools if not (library and CLI_RULE_MARK in r))
    argv = [*(claude_cmd or [cfg.claude_bin]), '-p', prompt, '--output-format', 'stream-json', '--verbose',
            '--permission-mode', cfg.permission_mode, '--allowedTools', *cfg.allowed_tools]
    if deny:
        argv += ['--disallowedTools', *deny]
    argv += ['--add-dir', str(job_dir), str(cfg.artwork_builder)]
    model = cfg.model if model is None else model
    if model:
        argv += ['--model', model]
    return argv


def child_env(cfg: Config, job_dir: Path, base=None, phase: str = '', round_n: int = 0) -> dict:
    env = dict(os.environ if base is None else base)
    env.pop('DESIGN_AGENT_TOKEN', None)
    env.update({'DESIGN_AGENT_JOB_DIR': str(job_dir), 'BASH_DEFAULT_TIMEOUT_MS': str(cfg.bash_timeout_ms),
                'BASH_MAX_TIMEOUT_MS': str(cfg.bash_timeout_ms), 'DISABLE_AUTOUPDATER': '1',
                'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    if phase:
        env.update({'DESIGN_AGENT_PHASE': phase, 'DESIGN_AGENT_ROUND': str(round_n)})
    else:
        env.pop('DESIGN_AGENT_PHASE', None)
        env.pop('DESIGN_AGENT_ROUND', None)
    return env


def codex_last_message(job_dir: Path, n: int) -> Path:
    return Path(job_dir) / f'round-{n}' / 'codex-last-message.txt'


def build_codex_argv(cfg: Config, prompt: str, job_dir: Path, n: int, codex_cmd: list[str]) -> list[str]:
    """`codex exec` for the maker of round n. No model or sandbox flag unless configured: Codex runs with the owner's
    own ~/.codex/config.toml."""
    argv = [*codex_cmd, 'exec', '-C', str(job_dir), '--skip-git-repo-check', '--color', 'never',
            '--add-dir', str(cfg.artwork_builder), '-o', str(codex_last_message(job_dir, n))]
    if cfg.codex_model:
        argv += ['-m', cfg.codex_model]
    return argv + [*cfg.codex_extra_args, prompt]


def codex_env(cfg: Config, job_dir: Path, round_n: int, base=None) -> dict:
    """The maker env of a Claude session, without any Claude / Anthropic / MCP variable or the runner's config path."""
    env = child_env(cfg, job_dir, base, phase='maker', round_n=round_n)
    for name in list(env):
        if name.upper().startswith(CODEX_SCRUB_PREFIXES) or name.upper() in CODEX_SCRUB_NAMES:
            env.pop(name)
    return env


def read_stage(job_dir: Path) -> str:
    try:
        lines = (Path(job_dir) / 'stage.txt').read_text(encoding='utf-8-sig', errors='replace').splitlines()
    except OSError:
        return 'khởi động'
    first = lines[0].strip()[:200] if lines else ''
    return first or 'khởi động'


def read_rounds(job_dir: Path) -> int:
    best = 0
    try:
        for p in Path(job_dir).iterdir():
            m = re.fullmatch(r'round-(\d+)', p.name)
            if m and p.is_dir():
                best = max(best, int(m.group(1)))
    except OSError:
        pass
    return best


def read_result(job_dir: Path) -> tuple[dict | None, str | None]:
    path = Path(job_dir) / 'result.json'
    if not path.exists():
        return None, None
    try:
        data = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError) as exc:
        return None, f'không đọc được JSON ({type(exc).__name__})'
    if not isinstance(data, dict):
        return None, 'không phải một object JSON'
    if data.get('outcome') not in ('DONE', 'NEEDS_OWNER'):
        return None, 'outcome phải là DONE hoặc NEEDS_OWNER'
    summary = data.get('summary')
    if not isinstance(summary, str) or not summary.strip():
        return None, 'thiếu summary'
    rounds = data.get('rounds')
    rounds = rounds if isinstance(rounds, int) and not isinstance(rounds, bool) and rounds >= 0 else read_rounds(job_dir)
    rest = {k: v for k, v in data.items() if k not in ('outcome', 'summary', 'rounds')}
    return {'outcome': data['outcome'], 'summary': summary[:4000], 'rounds': rounds, 'result': rest}, None


_PROC = None


def load_proc():
    global _PROC
    if _PROC is not None:
        return _PROC
    path = HERE.parent / 'clone-runner' / 'proc.py'
    if not path.is_file():
        raise ConfigError('không thấy tools/clone-runner/proc.py')
    spec = importlib.util.spec_from_file_location('clone_runner_proc', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['clone_runner_proc'] = module
    spec.loader.exec_module(module)
    _PROC = module
    return module


@dataclass
class Deps:
    cfg: Config
    api: AgentApi
    log: Log
    claude_cmd: list | None = None
    codex_cmd: list | None = None
    heartbeat_s: float = 60
    timeout_s: float | None = None
    cli_down_window_s: float = 90
    cli_backoff_s: float = 1800
    report_window_s: float = 900
    report_retry_s: float = 10
    clock: object = time


def release_ps_lock(cfg: Config, job_dir: Path, log: Log) -> bool:
    marker = Path(job_dir) / 'ps-lock.held'
    if not marker.exists():
        return False
    try:
        marker.unlink()
    except OSError:
        pass
    lock = cfg.artwork_builder / '.ps-lock'
    if not lock.exists():
        return False
    try:
        lock.rmdir()
    except OSError:
        log.line(f'không gỡ được .ps-lock của phiên {Path(job_dir).name}')
        return False
    log.line(f'gỡ .ps-lock do phiên {Path(job_dir).name} bỏ lại')
    return True


def _set_state(job_dir: Path, **changes) -> None:
    path = Path(job_dir) / 'runner-state.json'
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        state = {}
    state.update(changes)
    try:
        path.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
    except OSError:
        pass


REPORT_MAX_BACKOFF_S = 120


def _send(deps: Deps, jid: str, label: str, call):
    """(reply, state) with state one of ok / auth / conflict / refused / net.

    A network error or a 5xx (a deploy, a restart) is retried with backoff for deps.report_window_s, which stays under the
    server's lease; any other 4xx is final.
    """
    deadline = deps.clock.monotonic() + deps.report_window_s
    wait = deps.report_retry_s
    attempt = 0
    while True:
        attempt += 1
        try:
            return call(), 'ok'
        except AuthError:
            return None, 'auth'
        except ApiError as exc:
            if exc.status == 409:
                if label == 'result':
                    deps.log.line(f'server đã có kết quả của job {jid} (409): không gửi fail')
                else:
                    deps.log.line(f'server không còn giữ job {jid} (409)')
                return None, 'conflict'
            if exc.status is not None and exc.status < 500:
                deps.log.line(f'server từ chối {label} job {jid} (HTTP {exc.status})')
                return None, f'refused:{exc.status}'
            left = deadline - deps.clock.monotonic()
            what = 'lỗi mạng' if exc.status is None else f'HTTP {exc.status}'
            if left <= 0:
                break
            pause = min(wait, left)
            deps.log.line(f'{what} khi gửi {label} job {jid} (lần {attempt}); thử lại sau {pause:g} giây')
            deps.clock.sleep(pause)
            wait = min(wait * 2, REPORT_MAX_BACKOFF_S)
    deps.log.line(f'!!! KHÔNG GỬI ĐƯỢC {label} của job {jid} sau {deps.report_window_s / 60:g} phút thử lại — '
                  f'để server thu hồi job theo lease; kiểm tra máy chủ và thư mục job')
    return None, 'net'


def _fail(deps: Deps, jid: str, error: str, permanent: bool, ret: str, job_dir: Path | None = None) -> str:
    deps.log.line(f'job {jid} lỗi: {error}')
    _, state = _send(deps, jid, 'fail', lambda: deps.api.fail(jid, error, permanent))
    out = {'auth': 'AUTH', 'net': 'LOST'}.get(state, ret)
    if job_dir:
        _set_state(job_dir, finished=True, outcome=out)
    return out


CLI_DOWN_TEXT = 'Claude CLI không chạy được (chưa đăng nhập, hết hạn mức hoặc lỗi khởi động)'
CODEX_DOWN_TEXT = 'Codex không chạy được (chưa đăng nhập, hết hạn mức hoặc lỗi khởi động)'


class _Beat:
    """The job's heartbeat thread; it runs across every session and the delivery of one job."""

    def __init__(self, deps: Deps, jid: str, stage_fn):
        self.deps, self.jid, self.stage_fn = deps, jid, stage_fn
        self.flags = {'lost': False, 'auth': False}
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f'beat-{jid}', daemon=True)
        self.thread.start()

    def _run(self) -> None:
        while not self.done.wait(self.deps.heartbeat_s):
            try:
                stage, rounds = self.stage_fn()
                if not self.deps.api.heartbeat(self.jid, stage, rounds):
                    self.flags['lost'] = True
            except AuthError:
                self.flags['auth'] = True
            except ApiError:
                self.deps.log.line(f'job {self.jid}: không gửi được nhịp tim')

    def halted(self, stop: threading.Event) -> bool:
        return stop.is_set() or self.flags['lost'] or self.flags['auth']

    def outcome(self) -> str:
        return 'AUTH' if self.flags['auth'] else 'LOST'

    def end(self) -> None:
        self.done.set()
        self.thread.join(5)


def _session(deps: Deps, jid: str, job_dir: Path, argv: list, env: dict, timeout: float, should_stop,
             log_name: str, cwd: Path | None = None) -> tuple[str, float]:
    """('exited' | 'timeout' | 'stopped' | 'spawn-failed', seconds). The tree is dead and .ps-lock released on return."""
    cfg = deps.cfg
    proc = load_proc()
    out = open(Path(job_dir) / log_name, 'ab')
    try:
        child = proc.spawn(argv, cwd=str(cwd or cfg.project_dir), env=env, out=out, secrets=[cfg.token])
    except OSError:
        out.close()
        return 'spawn-failed', 0.0
    if os.name == 'nt' and not child.contained:
        deps.log.line(f'job {jid}: {proc.CONTAIN_FAILED} (pid {child.pid})')
    started = deps.clock.monotonic()
    try:
        status = proc.wait(child, timeout, should_stop)
    finally:
        elapsed = deps.clock.monotonic() - started
        proc.close(child)
        out.close()
        release_ps_lock(cfg, job_dir, deps.log)
    return status, elapsed


def _ended(deps: Deps, jid: str, job_dir: Path, status: str, beat: _Beat, what: str = '',
           down_text: str = CLI_DOWN_TEXT) -> str | None:
    """The job's outcome when a session did not simply exit, else None."""
    if status == 'spawn-failed':
        return _fail(deps, jid, down_text, False, 'CLI_DOWN', job_dir)
    if status == 'stopped':
        outcome = beat.outcome()
        deps.log.line(f'job {jid}: đã dừng phiên ({outcome})')
        _set_state(job_dir, finished=True, outcome=outcome)
        return outcome
    if status == 'timeout':
        return _fail(deps, jid, f'quá {deps.cfg.job_timeout_s / 60:g} phút chưa xong — đã dừng phiên{what}', True,
                     'FAILED', job_dir)
    return None


def _post_result(deps: Deps, jid: str, res: dict, job_dir: Path) -> str:
    reply, state = _send(deps, jid, 'result',
                         lambda: deps.api.result(jid, res['outcome'], res['summary'], res['rounds'], res['result']))
    if state == 'ok':
        got = reply.get('status') or res['outcome']
        if got != res['outcome']:
            deps.log.line(f'server ghi nhận job {jid} là {got}')
        outcome = got if got in ('DONE', 'NEEDS_OWNER') else 'FAILED'
    elif state.startswith('refused:'):
        return _fail(deps, jid, f'máy chủ từ chối kết quả của phiên (HTTP {state.split(":", 1)[1]})', True, 'FAILED',
                     job_dir)
    else:
        outcome = {'auth': 'AUTH'}.get(state, 'LOST')
    deps.log.line(f'job {jid}: {outcome}')
    _set_state(job_dir, finished=True, outcome=outcome)
    return outcome


def run_job(job: dict, deps: Deps, stop: threading.Event) -> str:
    cfg, api, log = deps.cfg, deps.api, deps.log
    reason = validate_job(job)
    jid = str((job or {}).get('id') or '')
    if reason:
        if not re.match(ID_RE, jid):
            log.line(f'bỏ qua job không hợp lệ: {reason}')
            return 'FAILED'
        return _fail(deps, jid, reason, True, 'FAILED')
    key = job['task']['key']
    try:
        codex = resolve_codex(cfg.codex_bin)
    except ConfigError as exc:
        return _fail(deps, jid, str(exc), False, 'FAILED')
    job_dir = prepare_job_dir(cfg, job, codex, datetime.now())
    log.line(f'job {jid} ({job["kind"]} {key}) lần {job.get("attempts")}: {job_dir}')
    try:
        index = fetch_current_files(api, job, job_dir)
    except AuthError:
        _set_state(job_dir, finished=True, outcome='AUTH')
        return 'AUTH'
    except ApiError as exc:
        return _fail(deps, jid, f'không tải được file hiện tại của task (HTTP {exc.status or "mạng"})', False,
                     'FAILED', job_dir)
    held = is_held_make(job, index)
    if held:
        try:
            copied = copy_held_render(cfg, job, job_dir)
            log.line(f'job {jid}: dòng AUTO bị giữ, chưa có file in; làm như job MAKE, đã chép {len(copied)} file render bị giữ')
        except OSError as exc:
            log.line(f'job {jid}: dòng AUTO bị giữ; không chép được bản render bị giữ ({type(exc).__name__})')
    prompt = render_prompt(cfg, {**job, 'kind': 'MAKE'} if held else job, job_dir, codex)
    try:
        if not api.heartbeat(jid, read_stage(job_dir), read_rounds(job_dir)):
            log.line(f'job {jid}: server không còn giữ job (409), không mở phiên')
            _set_state(job_dir, finished=True, outcome='LOST')
            return 'LOST'
    except AuthError:
        _set_state(job_dir, finished=True, outcome='AUTH')
        return 'AUTH'
    except ApiError:
        log.line(f'job {jid}: chưa gửi được nhịp đầu')
    if job['kind'] in ROUND_KINDS:
        return _run_rounds(job, deps, stop, job_dir, codex, held=held)
    return _run_single(job, deps, stop, job_dir, prompt)


def _run_single(job: dict, deps: Deps, stop: threading.Event, job_dir: Path, prompt: str) -> str:
    """LIBRARY_APPLY: one session that delivers through agent_api.py and ends with result.json."""
    cfg, jid = deps.cfg, job['id']
    argv = build_argv(cfg, prompt, job_dir, deps.claude_cmd, library=True)
    beat = _Beat(deps, jid, lambda: (read_stage(job_dir), read_rounds(job_dir)))
    timeout = deps.timeout_s if deps.timeout_s is not None else cfg.job_timeout_s
    try:
        status, elapsed = _session(deps, jid, job_dir, argv, child_env(cfg, job_dir), timeout,
                                   lambda: beat.halted(stop), 'session.log')
    finally:
        beat.end()
    done = _ended(deps, jid, job_dir, status, beat)
    if done:
        return done
    res, why = read_result(job_dir)
    if why:
        return _fail(deps, jid, f'result.json không hợp lệ: {why}', True, 'FAILED', job_dir)
    if res is None:
        if elapsed < deps.cli_down_window_s:
            return _fail(deps, jid, CLI_DOWN_TEXT, False, 'CLI_DOWN', job_dir)
        return _fail(deps, jid, 'phiên kết thúc mà không có result.json', False, 'FAILED', job_dir)
    return _post_result(deps, jid, res, job_dir)


_ROUND_PREFIX = re.compile(r'^\s*vòng\s*\d+\s*:\s*', re.IGNORECASE)


def round_stage(ctx: dict, job_dir: Path) -> tuple[str, int]:
    """Heartbeat (stage, rounds) of a round job: the session's own stage.txt line while it runs, else the phase."""
    n = ctx.get('round', 0)
    if ctx.get('live'):
        try:
            lines = (Path(job_dir) / 'stage.txt').read_text(encoding='utf-8-sig', errors='replace').splitlines()
        except OSError:
            lines = []
        own = _ROUND_PREFIX.sub('', lines[0]).strip()[:150] if lines else ''
        if own:
            return f'vòng {n}: {own}', n
    return ctx.get('stage') or 'khởi động', n


def _load_json(path: Path) -> tuple[object, str | None]:
    try:
        return json.loads(Path(path).read_text(encoding='utf-8-sig')), None
    except (OSError, ValueError) as exc:
        return None, f'không đọc được JSON ({type(exc).__name__})'


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ''


def _print_areas(job: dict) -> set:
    return {str(f.get('printArea')) for f in job.get('files') or [] if f.get('kind') == 'PRINT' and f.get('printArea')}


def read_ready(job_dir: Path, n: int, job: dict) -> tuple[dict | None, str | None]:
    """round-N/READY.json checked strictly: every listed file is a non-empty image inside round-N/deliver/."""
    job_dir = Path(job_dir)
    data, why = _load_json(job_dir / f'round-{n}' / 'READY.json')
    if why:
        return None, why
    if not isinstance(data, dict):
        return None, 'không phải một object JSON'
    if data.get('round') != n or isinstance(data.get('round'), bool):
        return None, f'"round" phải là {n}'
    items = data.get('files')
    if not isinstance(items, list) or not items:
        return None, 'không có file nào trong "files"'
    deliver = (job_dir / f'round-{n}' / 'deliver').resolve()
    areas, files, seen = _print_areas(job), [], set()
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            return None, f'files[{i}] không phải object'
        kind, area, rel = item.get('kind'), _text(item.get('printArea')), _text(item.get('file'))
        if kind not in ('PRINT', 'MOCKUP'):
            return None, f'files[{i}].kind phải là PRINT hoặc MOCKUP'
        if not area or len(area) > 120:
            return None, f'files[{i}] thiếu printArea'
        if not rel:
            return None, f'files[{i}] thiếu file'
        path = (job_dir / rel).resolve()
        if deliver not in path.parents:
            return None, f'file {rel} nằm ngoài round-{n}/deliver/'
        if path.suffix.lower() not in DELIVER_EXT:
            return None, f'file {rel} không phải .jpg, .jpeg hay .png'
        if not path.is_file():
            return None, f'không thấy file {rel}'
        if path.stat().st_size == 0:
            return None, f'file rỗng: {rel}'
        if (kind, area) in seen:
            return None, f'vùng {area} ({kind}) có hai file'
        seen.add((kind, area))
        if job.get('kind') == 'MOCKUP' and kind != 'MOCKUP':
            return None, 'job mockup chỉ được giao file MOCKUP'
        if job.get('kind') == 'FIX' and kind == 'PRINT' and areas and area not in areas:
            return None, f'vùng in "{area}" không có trong file hiện tại của task'
        files.append({'kind': kind, 'printArea': area, 'path': path})
    changed = _text(data.get('changed'))
    if not changed:
        return None, 'thiếu "changed"'
    if not isinstance(data.get('unchanged'), str):
        return None, 'thiếu "unchanged"'
    return {'round': n, 'files': files, 'changed': changed[:2000], 'unchanged': data['unchanged'].strip()[:2000]}, None


def read_qa(job_dir: Path, n: int) -> tuple[dict | None, str | None]:
    path = Path(job_dir) / 'QA-claude' / f'round-{n}-result.json'
    if not path.exists():
        return None, None
    data, why = _load_json(path)
    if why:
        return None, why
    if not isinstance(data, dict):
        return None, 'không phải một object JSON'
    verdict = data.get('verdict')
    if verdict not in ('PASS', 'FAIL'):
        return None, 'verdict phải là PASS hoặc FAIL'
    summary = _text(data.get('summary'))
    if not summary:
        return None, 'thiếu summary'
    findings = data.get('findings')
    if not isinstance(findings, list):
        return None, 'findings phải là một danh sách'
    clean = []
    for i, f in enumerate(findings):
        fields = {k: _text(f.get(k)) if isinstance(f, dict) else '' for k in ('piece', 'problem', 'fix', 'passCondition')}
        if not all(fields.values()):
            return None, f'findings[{i}] thiếu piece, problem, fix hoặc passCondition'
        clean.append(fields)
    if verdict == 'PASS' and clean:
        return None, 'PASS nhưng vẫn có findings'
    if verdict == 'FAIL' and not clean:
        return None, 'FAIL mà không có findings'
    return {'verdict': verdict, 'summary': summary[:2000], 'findings': clean}, None


def deliver_hashes(job_dir: Path, n: int) -> dict:
    """sha256 of READY.json and of every file under round-N/deliver/, by path relative to the job folder."""
    job_dir = Path(job_dir)
    paths = [job_dir / f'round-{n}' / 'READY.json']
    paths += sorted(p for p in (job_dir / f'round-{n}' / 'deliver').rglob('*') if p.is_file())
    out = {}
    for path in paths:
        digest = hashlib.sha256()
        try:
            with open(path, 'rb') as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b''):
                    digest.update(chunk)
        except OSError:
            continue
        out[path.relative_to(job_dir).as_posix()] = digest.hexdigest()
    return out


def _stash(path: Path) -> None:
    path = Path(path)
    if path.exists():
        try:
            os.replace(path, path.with_name(f'stray-{time.time_ns()}-{path.name}'))
        except OSError:
            pass


def _discard(path: Path) -> None:
    try:
        Path(path).unlink()
    except OSError:
        pass


def delivery_error(what: str, exc: ApiError, pushed: list) -> str:
    if exc.status is None:
        text = f'{what} thất bại: {exc.body.get("error") or "lỗi mạng"}'
    else:
        reason = 'file quá lớn' if exc.status == 413 else str(exc.body.get('error') or f'HTTP {exc.status}')[:300]
        missing = exc.body.get('missing')
        if isinstance(missing, list) and missing:
            reason += '; thiếu: ' + ', '.join(str(m) for m in missing)
        text = f'{what} thất bại: máy chủ trả {exc.status} ({reason})'
    if pushed:
        text += f'; đã tải lên trước đó: {", ".join(pushed)}'
    return text


def _run_rounds(job: dict, deps: Deps, stop: threading.Event, job_dir: Path, codex: str, held: bool = False) -> str:
    """FIX, MAKE, MOCKUP: maker session, then a fresh QA session, up to MAX_ROUNDS; the runner delivers on PASS.
    A held AUTO line (FIX from AUTO_HOLD with no print files) gets MAKE prompts; delivery stays the FIX path."""
    cfg, jid = deps.cfg, job['id']
    pjob = {**job, 'kind': 'MAKE'} if held else job
    kind = pjob['kind']
    maker_head = held_make_text(job['task']['key']) + '\n\n' if held else ''
    qa_head = held_qa_text() + '\n\n' if held else ''
    total = deps.timeout_s if deps.timeout_s is not None else cfg.job_timeout_s
    deadline = deps.clock.monotonic() + total
    ctx = {'round': 0, 'stage': 'khởi động', 'live': False}
    beat = _Beat(deps, jid, lambda: round_stage(ctx, job_dir))
    use_codex = cfg.maker_engine == 'codex'
    maker_down = CODEX_DOWN_TEXT if use_codex else CLI_DOWN_TEXT

    def phase(n: int, role: str) -> tuple[str, float]:
        ctx.update(round=n, stage=f'vòng {n}: {"sửa" if role == "maker" else "QA"}')
        _set_state(job_dir, round=n, phase=role, engine=cfg.maker_engine if role == 'maker' else 'claude')
        _discard(job_dir / 'stage.txt')
        left = deadline - deps.clock.monotonic()
        if left <= 0:
            return 'timeout', 0.0
        cwd = None
        if role == 'maker' and use_codex:
            text = render_prompt(cfg, pjob, job_dir, codex, name=CODEX_PROMPT, left_s=left, extra=maker_head + maker_round_text(n),
                                 out_name=f'prompt-round-{n}-maker.md')
            (job_dir / f'round-{n}').mkdir(exist_ok=True)
            argv = build_codex_argv(cfg, text, job_dir, n, deps.codex_cmd or [codex])
            env, cwd = codex_env(cfg, job_dir, n), job_dir
        else:
            if role == 'maker':
                text = render_prompt(cfg, pjob, job_dir, codex, left_s=left, extra=maker_head + maker_round_text(n),
                                     out_name=f'prompt-round-{n}-maker.md')
                model = cfg.model
            else:
                text = render_prompt(cfg, pjob, job_dir, codex, name=QA_PROMPT, left_s=left,
                                     extra=qa_head + qa_round_text(n, kind), out_name=f'prompt-round-{n}-qa.md')
                model = cfg.qa_model
            argv = build_argv(cfg, text, job_dir, deps.claude_cmd, model=model)
            env = child_env(cfg, job_dir, phase=role, round_n=n)
        ctx['live'] = True
        try:
            return _session(deps, jid, job_dir, argv, env, left, lambda: beat.halted(stop),
                            f'session-round-{n}-{role}.log', cwd=cwd)
        finally:
            ctx['live'] = False

    def fail(text: str, permanent: bool = False) -> str:
        return _fail(deps, jid, text, permanent, 'FAILED', job_dir)

    def halted() -> str | None:
        if beat.halted(stop):
            outcome = beat.outcome()
            deps.log.line(f'job {jid}: dừng giữa các phiên ({outcome})')
            _set_state(job_dir, finished=True, outcome=outcome)
            return outcome
        return None

    try:
        findings: list = []
        for n in range(1, MAX_ROUNDS + 1):
            _stash(job_dir / 'result.json')
            status, elapsed = phase(n, 'maker')
            done = _ended(deps, jid, job_dir, status, beat, f' (vòng {n}: sửa)', maker_down) or halted()
            if done:
                return done
            ready_path = job_dir / f'round-{n}' / 'READY.json'
            res, why = read_result(job_dir)
            if (res or why) and ready_path.exists():
                return fail(f'vòng {n}: phiên sửa ghi cả READY.json lẫn result.json')
            if why:
                return fail(f'vòng {n}: result.json của phiên sửa không hợp lệ: {why}')
            if res:
                if res['outcome'] != 'NEEDS_OWNER':
                    return fail(f'vòng {n}: phiên sửa chỉ được kết thúc bằng READY.json hoặc result.json NEEDS_OWNER')
                return _post_result(deps, jid, res, job_dir)
            if not ready_path.exists():
                if elapsed < deps.cli_down_window_s:
                    return _fail(deps, jid, maker_down, False, 'CLI_DOWN', job_dir)
                return fail(f'vòng {n}: phiên sửa kết thúc mà không có READY.json hay result.json')
            ready, why = read_ready(job_dir, n, job)
            if why:
                return fail(f'vòng {n}: READY.json không hợp lệ: {why}')

            before = deliver_hashes(job_dir, n)
            status, elapsed = phase(n, 'qa')
            done = _ended(deps, jid, job_dir, status, beat, f' (vòng {n}: QA)') or halted()
            if done:
                return done
            after = deliver_hashes(job_dir, n)
            if after != before:
                touched = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
                return fail(f'vòng {n}: phiên QA đã thay đổi file giao ({", ".join(touched)}); không giao gì')
            qa, why = read_qa(job_dir, n)
            if why:
                return fail(f'vòng {n}: kết quả QA không hợp lệ: {why}')
            if qa is None:
                if elapsed < deps.cli_down_window_s:
                    return _fail(deps, jid, CLI_DOWN_TEXT, False, 'CLI_DOWN', job_dir)
                return fail(f'vòng {n}: phiên QA kết thúc mà không có QA-claude/round-{n}-result.json')
            deps.log.line(f'job {jid}: vòng {n} QA {qa["verdict"]}')
            _set_state(job_dir, round=n, qa=qa['verdict'])
            if qa['verdict'] == 'PASS':
                return _deliver(job, deps, job_dir, ctx, n, ready, qa)
            findings = qa['findings']
        open_items = '; '.join(f'{f["piece"]}: {f["problem"]}' for f in findings)
        res = {'outcome': 'NEEDS_OWNER', 'summary': f'QA chưa đạt sau {MAX_ROUNDS} vòng: {open_items}'[:4000],
               'rounds': MAX_ROUNDS,
               'result': {'pushed': [], 'qa': 'FAIL', 'rounds': MAX_ROUNDS, 'findings': findings}}
        return _post_result(deps, jid, res, job_dir)
    finally:
        beat.end()


def _deliver(job: dict, deps: Deps, job_dir: Path, ctx: dict, n: int, ready: dict, qa: dict) -> str:
    jid, key = job['id'], job['task']['key']
    ctx.update(stage='tải lên', live=False)
    _set_state(job_dir, phase='deliver')
    pushed: list[str] = []
    for item in ready['files']:
        try:
            deps.api.upload(key, item['printArea'], item['path'], mockup=item['kind'] == 'MOCKUP')
        except AuthError:
            _set_state(job_dir, finished=True, outcome='AUTH')
            return 'AUTH'
        except ApiError as exc:
            return _fail(deps, jid, delivery_error(f'tải lên {item["printArea"]}', exc, pushed),
                         exc.status is not None and 400 <= exc.status < 500, 'FAILED', job_dir)
        pushed.append(item['printArea'])
        deps.log.line(f'job {jid}: đã tải lên {item["printArea"]} ({item["kind"]})')
    if job['kind'] != 'MOCKUP':
        try:
            deps.api.submit(key)
        except AuthError:
            _set_state(job_dir, finished=True, outcome='AUTH')
            return 'AUTH'
        except ApiError as exc:
            return _fail(deps, jid, delivery_error('gửi duyệt', exc, pushed),
                         exc.status is not None and 400 <= exc.status < 500, 'FAILED', job_dir)
    res = {'outcome': 'DONE', 'summary': f'{ready["changed"]} {qa["summary"]}'.strip()[:4000], 'rounds': n,
           'result': {'pushed': pushed, 'qa': 'PASS', 'rounds': n}}
    return _post_result(deps, jid, res, job_dir)


CLAIM_WAIT_S = 25
DISK_FLOOR_GB = 30
LOW_DISK_WAIT_S = 300
MAX_BACKOFF_S = 60


def acquire_lock(path: Path) -> int | None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def release_lock(fd: int) -> None:
    try:
        if os.name == 'nt':
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def recover_after_restart(cfg: Config, log: Log) -> int:
    abandoned = 0
    for d in sorted(cfg.artwork_builder.glob('*-agent-*')):
        if not d.is_dir():
            continue
        release_ps_lock(cfg, d, log)
        path = d / 'runner-state.json'
        try:
            state = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(state, dict) and state.get('finished') is False and not state.get('abandoned'):
            log.line(f'job {state.get("jobId")} của lần chạy trước: để server thu hồi theo lease')
            state['abandoned'] = True
            try:
                path.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')
            except OSError:
                pass
            abandoned += 1
    return abandoned


def _disk_free_gb(path) -> float:
    return shutil.disk_usage(path).free / 2 ** 30


def _pause(deps: Deps, stop: threading.Event, seconds: float) -> None:
    if deps.clock is time:
        stop.wait(seconds)
    else:
        deps.clock.sleep(seconds)


def serve(deps: Deps, once: bool = False, stop: threading.Event | None = None, disk_free_gb=_disk_free_gb) -> int:
    cfg, log = deps.cfg, deps.log
    stop = stop if stop is not None else threading.Event()
    wake = threading.Event()
    running: list = []
    outcomes: list[str] = []
    paused_until = 0.0
    backoff = 0
    claimed = False
    exit_code = EXIT_OK

    def start(job: dict) -> None:
        holder: list = []

        def target():
            try:
                holder.append(run_job(job, deps, stop))
            except Exception as exc:
                holder.append('FAILED')
                log.line(f'job {job.get("id")}: lỗi nội bộ của runner ({type(exc).__name__}: {exc})')
                try:
                    deps.api.fail(str(job.get('id')), 'lỗi nội bộ của runner', False)
                except Exception:
                    pass
            finally:
                wake.set()

        thread = threading.Thread(target=target, name=f'job-{job.get("id")}', daemon=True)
        running.append((thread, holder))
        thread.start()

    def collect() -> None:
        nonlocal paused_until
        for entry in list(running):
            thread, holder = entry
            if thread.is_alive():
                continue
            running.remove(entry)
            outcome = holder[0] if holder else 'FAILED'
            outcomes.append(outcome)
            if outcome == 'CLI_DOWN':
                paused_until = deps.clock.monotonic() + deps.cli_backoff_s
                log.line(f'Claude CLI không chạy được: tạm ngừng nhận job {deps.cli_backoff_s / 60:g} phút')

    try:
        while not stop.is_set():
            collect()
            if 'AUTH' in outcomes:
                break
            if once and claimed:
                if not running:
                    break
                wake.wait(1.0)
                wake.clear()
                continue
            free = cfg.max_concurrent - len(running)
            if free <= 0 or deps.clock.monotonic() < paused_until:
                wake.wait(1.0)
                wake.clear()
                continue
            if disk_free_gb(cfg.artwork_builder) < DISK_FLOOR_GB:
                log.line('ổ đĩa còn dưới 30 GB: chưa nhận job, 5 phút nữa kiểm lại')
                if once:
                    break
                _pause(deps, stop, LOW_DISK_WAIT_S)
                continue
            try:
                jobs = deps.api.claim(free, CLAIM_WAIT_S)
            except AuthError:
                log.line('máy chủ từ chối token (401): dừng runner')
                outcomes.append('AUTH')
                break
            except ApiError as exc:
                backoff = min(MAX_BACKOFF_S, backoff * 2 if backoff else 2)
                log.line(f'không gọi được máy chủ ({exc.status or "mạng"}); thử lại sau {backoff} giây')
                if once:
                    break
                _pause(deps, stop, backoff)
                continue
            backoff = 0
            claimed = True
            for job in jobs:
                start(job)
    except KeyboardInterrupt:
        stop.set()
    finally:
        if 'AUTH' in outcomes or stop.is_set():
            stop.set()
        for thread, _ in list(running):
            thread.join(120)
        collect()
    if 'AUTH' in outcomes:
        return EXIT_AUTH
    if once and 'CLI_DOWN' in outcomes:
        return EXIT_CLI
    return exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Design Agent runner')
    parser.add_argument('--once', action='store_true', help='nhận một lượt job, chạy xong rồi thoát')
    parser.add_argument('--config', help='đường dẫn runner.env')
    args = parser.parse_args(argv)
    home = agent_api.home()
    log = Log(home, [])
    path = Path(args.config) if args.config else agent_api.env_path()
    try:
        cfg = load_config(path)
        load_proc()
    except ConfigError as exc:
        log.line(f'cấu hình lỗi: {exc}')
        return EXIT_CONFIG
    log = Log(home, [cfg.token])
    fd = acquire_lock(home / 'runner.lock')
    if fd is None:
        log.line('một runner khác đang chạy')
        return EXIT_OK
    try:
        prune_logs(home)
        recover_after_restart(cfg, log)
        deps = Deps(cfg, AgentApi(cfg.ecom_url, cfg.token), log)
        log.line(f'runner bắt đầu: tối đa {cfg.max_concurrent} job cùng lúc, phiên sửa {cfg.maker_engine}, '
                 f'máy chủ {cfg.ecom_url}')
        code = serve(deps, once=args.once)
        log.line(f'runner dừng (mã {code})')
        return code
    finally:
        release_lock(fd)


if __name__ == '__main__':
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    sys.exit(main())

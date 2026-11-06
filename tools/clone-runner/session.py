"""One headless Claude Code session per clone job.

`run_session` writes `job.json` in the job folder, starts `claude -p` there with the fixed prompt in `job_prompt.md`
plus the job's values as a JSON block, a narrow tool list and the store's environment, enforces the time limit, and
reads back `result.json`. The runner trusts `result.json` only: a missing or malformed file, or a failed exit, is a
failed job. stdout and stderr go to `session.log`; the store's variables never reach the log, `job.json` or the prompt.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import time

import proc
from detect import PLATFORMS

RUNNER_DIR = os.path.dirname(os.path.abspath(__file__))
PROMPT_FILE = os.path.join(RUNNER_DIR, 'job_prompt.md')
SKILLS_ROOT = os.environ.get('CLONE_SKILLS_ROOT') or r'C:\Users\TM PC\.claude\skills'
CLONES_ROOT = r'D:\Ecom manager'

STORE_NAMES = {'LIT': 'litzzy', 'REMI': 'reminiso'}
SKILL_DIRS = {
    ('customily', 'litzzy'): os.path.join(SKILLS_ROOT, 'cloning-clipart-customizers-litzzy'),
    ('customall', 'litzzy'): os.path.join(SKILLS_ROOT, 'cloning-customall-litzzy'),
    ('customall', 'reminiso'): os.path.join(SKILLS_ROOT, 'cloning-customall-reminiso'),
    ('customily', 'reminiso'): os.path.join(SKILLS_ROOT, 'cloning-customily-reminiso'),
    ('customix', 'reminiso'): os.path.join(SKILLS_ROOT, 'cloning-customix-reminiso'),
    ('teeinblue', 'reminiso'): os.path.join(SKILLS_ROOT, 'cloning-teeinblue-macorner'),
}
# The Reminiso tools share cloning-teeinblue's theme push, which keeps its backups under teeinblue-clones.
WORK_ROOTS = {
    ('customily', 'litzzy'): (os.path.join(CLONES_ROOT, 'clipart-clones'),),
    ('customall', 'litzzy'): (os.path.join(CLONES_ROOT, 'customall-clones'),),
    ('customall', 'reminiso'): (os.path.join(CLONES_ROOT, 'customall-reminiso-clones'),
                                os.path.join(CLONES_ROOT, 'teeinblue-clones')),
    ('customily', 'reminiso'): (os.path.join(CLONES_ROOT, 'customily-clones'),
                                os.path.join(CLONES_ROOT, 'teeinblue-clones')),
    ('customix', 'reminiso'): (os.path.join(CLONES_ROOT, 'customix-clones'), os.path.join(CLONES_ROOT, 'teeinblue-clones')),
    ('teeinblue', 'reminiso'): (os.path.join(CLONES_ROOT, 'teeinblue-clones'),),
}
# --restricted confines the file tools to the working folders, so the skills whose code a tool imports are added too.
SHARED_SKILL_DIRS = {
    ('customily', 'litzzy'): (os.path.join(SKILLS_ROOT, 'cloning-clipart-customizers'),),
    ('customall', 'litzzy'): (os.path.join(SKILLS_ROOT, 'cloning-clipart-customizers-litzzy'),
                              os.path.join(SKILLS_ROOT, 'cloning-clipart-customizers')),
    ('customall', 'reminiso'): (os.path.join(SKILLS_ROOT, 'cloning-teeinblue'),
                                os.path.join(SKILLS_ROOT, 'cloning-teeinblue-macorner')),
    ('customily', 'reminiso'): (os.path.join(SKILLS_ROOT, 'cloning-teeinblue'),
                                os.path.join(SKILLS_ROOT, 'cloning-teeinblue-macorner')),
    ('customix', 'reminiso'): (os.path.join(SKILLS_ROOT, 'cloning-teeinblue'),
                               os.path.join(SKILLS_ROOT, 'cloning-teeinblue-macorner')),
    ('teeinblue', 'reminiso'): (os.path.join(SKILLS_ROOT, 'cloning-teeinblue'),),
}
STORE_ENV_FILES = {'litzzy': os.path.join(SKILLS_ROOT, 'cloning-clipart-customizers-litzzy', 'shopify.env')}
STORE_ENV_KEYS = ('SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_API_VERSION')
REQUIRED_STORE_ENV = ('SHOPIFY_STORE', 'SHOPIFY_ADMIN_TOKEN')
SECRET_STORE_ENV = ('SHOPIFY_ADMIN_TOKEN',)

SESSION_TOOLS = ('Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash')
# A narrowing, not a sandbox: `python` can still do anything the Windows account can. Tune after a supervised run.
# build_argv adds Write/Edit for this job's own work folders (<work root>\<slug>).
ALLOWED_TOOLS = (
    'Read',
    'Glob',
    'Grep',
    'Write(./**)',
    'Edit(./**)',
    'Bash(python *)',
)
# Files Claude Code loads from the working folder at start-up: a retried job must not inherit them from a steered attempt.
STARTUP_FILES = ('.claude', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json')
DISALLOWED_TOOLS = (
    'Bash(ssh)', 'Bash(ssh *)', 'Bash(ssh.exe *)', 'Bash(scp *)', 'Bash(scp.exe *)', 'Bash(sftp *)',
    'Bash(sftp.exe *)', 'Bash(sshpass *)',
    'Bash(cmd)', 'Bash(cmd *)', 'Bash(cmd.exe *)', 'Bash(powershell *)', 'Bash(powershell.exe *)', 'Bash(pwsh *)',
    'Bash(pwsh.exe *)', 'PowerShell',
    'Read(~/.ssh/**)', 'Read(//**/.ssh/**)', 'Edit(~/.ssh/**)', 'Edit(//**/.ssh/**)', 'Write(~/.ssh/**)',
    'Write(//**/.ssh/**)',
    'Read(//**/SSH~*/**)', 'Edit(//**/SSH~*/**)', 'Write(//**/SSH~*/**)',
    'Read(//**/ssh~*/**)', 'Edit(//**/ssh~*/**)', 'Write(//**/ssh~*/**)',
    'Read(//**/*.env)',
    'Write(./.claude/**)', 'Edit(./.claude/**)', 'Write(./CLAUDE.md)', 'Edit(./CLAUDE.md)',
    'Write(./CLAUDE.local.md)', 'Edit(./CLAUDE.local.md)', 'Write(./.mcp.json)', 'Edit(./.mcp.json)',
)
SLUG_RE = re.compile(r'^[a-z]{2}\d{10}$', re.ASCII)
RULE_UNSAFE_RE = re.compile(r'[*?\[\]!#\\()]')

DEFAULT_BUDGET_USD = '8'
SESSION_TIMEOUT_S = 7200
RESULT_FILE = 'result.json'
STAGE_FILE = 'stage.txt'
JOB_FILE = 'job.json'
LOG_FILE = 'session.log'
VERDICTS = ('PASS', 'FAIL', 'UNSUPPORTED')
RESULT_TEXT_FIELDS = ('platform', 'productGid', 'handle', 'productType', 'note', 'failKind', 'error')
GID_RE = re.compile(r'^gid://shopify/Product/\d+$', re.ASCII)
TARGET_RE = re.compile(r'^[a-z]+:[A-Z]+$', re.ASCII)
SHOP_RE = re.compile(r'^[a-z0-9][a-z0-9-]*\.myshopify\.com$', re.ASCII)
SUBTYPE_RE = re.compile(r'^[a-z_]{1,40}$', re.ASCII)
ENV_LINE_RE = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
BATCH_BIN_ERROR = 'CLONE_CLAUDE_BIN trỏ tới file .cmd/.bat: Windows sẽ chạy nó qua cmd.exe. Đặt đường dẫn tới claude.exe.'
STORE_ENV_ERROR = 'Không đọc được biến môi trường của store (SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN) từ shopify.env.'


class StoreEnvError(Exception):
    pass


def _say(out, text: str) -> None:
    line = f'[{time.strftime("%m/%d/%Y %H:%M:%S")}] {text}'
    out.write((line + '\n').encode('utf-8', 'backslashreplace'))
    out.flush()
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode('ascii', 'backslashreplace').decode('ascii'), flush=True)


def _session_view(job: dict, platform: str) -> dict:
    """The job's values the session gets, each one checked for shape; free text from the server stays out."""
    store = job.get('store') if isinstance(job.get('store'), dict) else {}
    prefix = store.get('orderPrefix')
    name = STORE_NAMES.get(prefix)
    platform = platform if platform in PLATFORMS else 'unknown'
    shop = store.get('shop')
    targets = job.get('targets') if isinstance(job.get('targets'), list) else []
    sku = job.get('skuCode') if isinstance(job.get('skuCode'), str) else ''
    attempts = job.get('attempts')
    pairs = [(platform, name)] if platform != 'unknown' else [(p, s) for p, s in SKILL_DIRS if s == name]
    work_roots, shared = [], []
    for pair in pairs:
        work_roots += [d for d in WORK_ROOTS.get(pair, ()) if d not in work_roots]
        shared += [d for d in SHARED_SKILL_DIRS.get(pair, ()) if d not in shared]
    return {
        'id': job.get('id'),
        'sourceUrl': job.get('sourceUrl'),
        'skuCode': sku,
        'slug': sku.lower(),
        'attempt': attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else None,
        'platform': platform,
        'store': {'name': name, 'orderPrefix': prefix,
                  'shop': shop if isinstance(shop, str) and SHOP_RE.fullmatch(shop) else None},
        'targets': [t for t in targets if isinstance(t, str) and TARGET_RE.fullmatch(t)],
        'skillDir': SKILL_DIRS.get((platform, name)),
        'skills': {p: d for (p, s), d in SKILL_DIRS.items() if s == name},
        'sharedSkills': shared,
        'workRoots': work_roots,
        'runnerDir': RUNNER_DIR,
    }


def render_prompt(job: dict, platform: str) -> str:
    with open(PROMPT_FILE, encoding='utf-8') as fh:
        text = fh.read()
    block = json.dumps(_session_view(job, platform), indent=2, ensure_ascii=True)
    return text.rstrip('\n') + '\n\n```json\n' + block + '\n```\n'


def _budget(env: dict) -> str:
    raw = (env.get('CLONE_MAX_BUDGET_USD') or '').strip()
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_BUDGET_USD
    return raw if math.isfinite(value) and value > 0 else DEFAULT_BUDGET_USD


def rule_path(path: str) -> str | None:
    """`D:\\Ecom manager\\x` as a permission-rule path (`//d/Ecom manager/x`), or None when the path holds a
    character that means something in a rule."""
    path = os.path.abspath(path).replace('\\', '/')
    if re.match(r'^[A-Za-z]:/', path):
        path = '/' + path[0].lower() + path[2:]
    path = path.rstrip('/')
    return None if RULE_UNSAFE_RE.search(path) else '/' + path


def work_folder_rules(slug, work_roots) -> list[str]:
    """Write/Edit for `<work root>\\<slug>` of this job only; nothing when the slug is not a SKU code."""
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        return []
    rules = []
    for root in work_roots:
        base = rule_path(root)
        if base:
            rules += [f'Write({base}/{slug}/**)', f'Edit({base}/{slug}/**)']
    return rules


def build_argv(job_dir: str, prompt: str, env: dict, dirs=(), claude_cmd=None, slug=None, work_roots=()) -> list[str]:
    """The claude command line as a list. `--restricted` confines the file tools to the job folder and the
    `--add-dir` folders and leaves settings files out; `--setting-sources project` and `--strict-mcp-config` keep
    the owner's user settings and MCP servers out as well, so only the rules here decide and `dontAsk` refuses
    everything else."""
    cmd = list(claude_cmd) if claude_cmd else [env.get('CLONE_CLAUDE_BIN') or 'claude']
    allowed = [*ALLOWED_TOOLS, *work_folder_rules(slug, work_roots)]
    argv = [*cmd, '-p', prompt, '--output-format', 'json', '--permission-mode', 'dontAsk',
            '--restricted', '--tools', ','.join(SESSION_TOOLS),
            '--setting-sources', 'project', '--strict-mcp-config',
            '--allowedTools', *allowed, '--disallowedTools', *DISALLOWED_TOOLS,
            '--add-dir', job_dir, *dirs, '--max-budget-usd', _budget(env)]
    model = (env.get('CLONE_CLAUDE_MODEL') or '').strip()
    if model:
        argv += ['--model', model]
    return argv


def read_env_file(path: str) -> dict:
    """STORE_ENV_KEYS from a `KEY=VALUE` / `export KEY=VALUE` file; other keys are ignored. Values are never logged."""
    values = {}
    with open(path, encoding='utf-8-sig') as fh:
        for line in fh:
            m = ENV_LINE_RE.match(line)
            if not m or m.group(1) not in STORE_ENV_KEYS:
                continue
            value = m.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                value = value[1:-1]
            values[m.group(1)] = value
    return values


def child_env(store: str | None, base=None) -> dict:
    """The runner's environment without any worker token or store variable, plus the store's own variables."""
    base = os.environ if base is None else base
    env = {k: v for k, v in base.items() if not k.upper().endswith('_WORKER_TOKEN') and k.upper() not in STORE_ENV_KEYS}
    path = STORE_ENV_FILES.get(store)
    if path:
        try:
            values = read_env_file(path)
        except (OSError, ValueError):
            raise StoreEnvError(STORE_ENV_ERROR) from None
        if not all(values.get(k) for k in REQUIRED_STORE_ENV):
            raise StoreEnvError(STORE_ENV_ERROR)
        env.update(values)
    return env


def _fail(kind: str, error: str) -> dict:
    return {'verdict': 'FAIL', 'failKind': kind, 'error': error}


def read_result(job_dir: str) -> dict:
    """The session's verdict, checked. A `reused` the session wrote is dropped: with it the server skips its SKU
    check, so only the runner's own register lookup may set it."""
    try:
        with open(os.path.join(job_dir, RESULT_FILE), encoding='utf-8-sig') as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return _fail('TOOL', 'Phiên không ghi result.json.')
    except (OSError, ValueError):
        return _fail('TOOL', 'result.json không đọc được hoặc không phải JSON.')
    if not isinstance(data, dict):
        return _fail('TOOL', 'result.json không phải một object JSON.')
    verdict = data.get('verdict')
    if verdict not in VERDICTS:
        return _fail('TOOL', f'result.json có verdict lạ: {str(verdict)[:40]!r}.')
    out = {'verdict': verdict}
    for key in RESULT_TEXT_FIELDS:
        value = data.get(key)
        if isinstance(value, str) and value:
            out[key] = value
    if 'productGid' in out and not GID_RE.fullmatch(out['productGid']):
        if verdict == 'PASS':
            return _fail('TOOL', 'Phiên báo PASS nhưng productGid không đúng dạng gid://shopify/Product/<số>.')
        del out['productGid']
    if verdict == 'PASS' and 'productGid' not in out:
        return _fail('TOOL', 'Phiên báo PASS nhưng thiếu productGid.')
    return out


def _cli_result(path: str, start: int) -> dict:
    """The `--output-format json` object the CLI printed in this run, or {} when there is none."""
    try:
        with open(path, 'rb') as fh:
            fh.seek(start)
            text = fh.read().decode('utf-8', 'replace')
    except OSError:
        return {}
    for chunk in [text.strip(), *reversed(text.splitlines())]:
        chunk = chunk.strip()
        if not chunk.startswith('{'):
            continue
        try:
            data = json.loads(chunk)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get('type') == 'result':
            return data
    return {}


def _usage(cli: dict) -> dict:
    out = {}
    cost, duration = cli.get('total_cost_usd'), cli.get('duration_ms')
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0:
        out['costUsd'] = cost
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration):
        out['durationMs'] = int(duration)
    return out


def _session_dirs(view: dict) -> list[str]:
    dirs = [view['skillDir']] if view['skillDir'] else list(view['skills'].values())
    dirs += view['sharedSkills'] + view['workRoots'] + [RUNNER_DIR]
    return [d for i, d in enumerate(dirs) if d not in dirs[:i] and os.path.isdir(d)]


def _secrets(env: dict) -> list[str]:
    """Values the session's output must never write to disk: the store token it was given and the runner's own
    worker token (still readable by a script from the user's environment)."""
    values = [env.get(k) for k in SECRET_STORE_ENV]
    values += [v for k, v in os.environ.items() if k.upper().endswith('_WORKER_TOKEN')]
    return [v for v in values if isinstance(v, str) and v]


def _remove(path: str) -> None:
    """Deletes a file or folder; a link or junction is removed itself, never what it points to."""
    try:
        if os.path.islink(path) or os.path.isjunction(path):
            try:
                os.unlink(path)
            except OSError:
                os.rmdir(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
    except FileNotFoundError:
        pass


def run_session(job: dict, platform: str, job_dir: str, should_stop, timeout_s: float = SESSION_TIMEOUT_S,
                claude_cmd=None) -> dict:
    view = _session_view(job, platform)
    if view['platform'] != 'unknown' and not view['skillDir']:
        return {'verdict': 'UNSUPPORTED',
                'error': f'Chưa có tool clone {view["platform"]} cho store {view["store"]["orderPrefix"]}.'}
    for name in (RESULT_FILE, STAGE_FILE, *STARTUP_FILES):
        _remove(os.path.join(job_dir, name))
    with open(os.path.join(job_dir, JOB_FILE), 'w', encoding='utf-8') as fh:
        json.dump({**view, 'requestedByName': job.get('requestedByName')}, fh, indent=2, ensure_ascii=True)
    try:
        env = child_env(view['store']['name'])
    except StoreEnvError as e:
        return _fail('TOOL', str(e))
    argv = build_argv(job_dir, render_prompt(job, platform), env, dirs=_session_dirs(view), claude_cmd=claude_cmd,
                      slug=view['slug'], work_roots=view['workRoots'])
    if os.path.splitext(argv[0])[1].lower() in ('.cmd', '.bat'):
        return _fail('TOOL', BATCH_BIN_ERROR)

    log_path = os.path.join(job_dir, LOG_FILE)
    with open(log_path, 'ab') as out:
        _say(out, f'Phiên bắt đầu, lần {view["attempt"]}, nền tảng {view["platform"]}.')
        start = out.tell()
        try:
            child = proc.spawn(argv, cwd=job_dir, env=env, out=out, secrets=_secrets(env))
        except OSError as e:
            _say(out, f'Không chạy được claude ({type(e).__name__}).')
            return _fail('TOOL', f'Không chạy được claude CLI ({type(e).__name__}).')
        try:
            if os.name == 'nt' and not child.contained:
                _say(out, proc.CONTAIN_FAILED)
            state = proc.wait(child, timeout_s, should_stop)
        finally:
            if child.popen.poll() is None:
                proc.kill_tree(child)
            proc.close(child)
        out.flush()
        cli = _cli_result(log_path, start)
        _say(out, f'Phiên kết thúc: {state}, mã thoát {child.popen.returncode}.')

    code = child.popen.returncode
    if state == 'timeout':
        outcome = _fail('TIMEOUT', f'Phiên chạy quá {timeout_s / 60:g} phút, đã dừng.')
    elif state == 'stopped':
        outcome = _fail('TOOL', 'Phiên bị dừng vì job bị huỷ hoặc không còn thuộc máy này.')
    else:
        outcome = read_result(job_dir)
        written = os.path.exists(os.path.join(job_dir, RESULT_FILE))
        if code != 0 and not (written and outcome['verdict'] in ('FAIL', 'UNSUPPORTED')):
            subtype = cli.get('subtype')
            detail = f' ({subtype})' if isinstance(subtype, str) and SUBTYPE_RE.fullmatch(subtype) else ''
            gid = outcome.get('productGid') if outcome['verdict'] == 'PASS' else None
            outcome = _fail('TOOL', f'claude thoát với mã {code}{detail}.')
            if gid:
                outcome['productGid'] = gid
    return {**outcome, **_usage(cli)}

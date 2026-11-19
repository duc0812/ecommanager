"""The work board: what this PC knows about who holds a line, published to the server for the Lark bot.

Two local sources, both only ever read: the review queue (`queue.db`) and the newest `_streams-*` worklist folder under
the artwork builder. Nothing here writes to either, and nothing here imports the runner.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

from agent_api import ApiError

DEFAULT_QUEUE_DB = r'D:\Ecom manager\review-queue\queue.db'
BOARD_PUBLISH_S = 120
COUNTDOWN_S = 3600
STREAM_TTL_S = 172800
MAX_DETAIL = 300
MAX_ENTRIES = 5000
QUEUE_WORKER = 'Hàng duyệt local'
ACTIVE = ('waiting', 'qa_failed', 'needs_look', 'held', 'rejected', 'fixing')
COUNTING = ('waiting', 'qa_failed')
HELD = 'held'
STREAM_STATE = 'listed'
QUEUE_UNREADABLE = 'không đọc được hàng duyệt local'
STATE_TEXT = {'waiting': 'đang chờ duyệt', 'qa_failed': 'lỗi QA', 'needs_look': 'cần xem', 'rejected': 'bị trả lại',
              'fixing': 'đang sửa', 'held': 'đang bị giữ'}

_KEY = re.compile(r'^[A-Z]+\d+_\d+$')
_MD_FILE = re.compile(r'`?([^`|\s]+\.md)`?')
_REJECTED_OWNER = re.compile(r'mọi dòng REJECTED[^\n]*?thuộc\s*\**\s*luồng\s*(\d+)([^\n]*)', re.IGNORECASE)
_TICKED_MD = re.compile(r'`([^`\n]+\.md)`')
_NUMBER = re.compile(r'\d+')


def _clean(value) -> str:
    return value.strip() if isinstance(value, str) else ''


def _when(text) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(_clean(text).replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _stamp(text) -> float:
    parsed = _when(text)
    return parsed.timestamp() if parsed else 0.0


def _iso(moment: datetime) -> str:
    moment = moment.astimezone(timezone.utc)
    return f'{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z'


def _queue_detail(reason, qa_json) -> str:
    detail = _clean(reason)
    if not detail:
        try:
            qa = json.loads(qa_json) if isinstance(qa_json, str) else None
        except ValueError:
            qa = None
        items = qa.get('items') if isinstance(qa, dict) else None
        if isinstance(items, list):
            detail = '; '.join(t for t in (_clean(i) for i in items) if t)
    return detail[:MAX_DETAIL].strip()


def queue_entries(queue_db: Path, countdown_s: int = COUNTDOWN_S) -> list[dict]:
    """One entry per task key whose newest queue item is still open. Raises when the queue cannot be read."""
    conn = sqlite3.connect(Path(queue_db).as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        found = conn.execute(
            'SELECT k.taskKey, i.status, i.statusReason, i.version, i.enteredAt, i.createdAt, i.updatedAt, i.qa, i.rowid '
            'FROM item_keys k JOIN items i ON i.id = k.itemId').fetchall()
    finally:
        conn.close()
    newest: dict[str, tuple] = {}
    for key, status, reason, version, entered, created, updated, qa, rowid in found:
        key = _clean(key)
        if not key:
            continue
        rank = (_stamp(entered), _stamp(created), _stamp(updated), rowid)
        if key not in newest or rank > newest[key][0]:
            newest[key] = (rank, _clean(status), reason, version, entered, qa)
    entries = []
    for key in sorted(newest):
        _, status, reason, version, entered, qa = newest[key]
        if status not in ACTIVE:
            continue
        entry: dict = {'taskKey': key, 'source': 'LOCAL_QUEUE', 'worker': QUEUE_WORKER, 'state': status}
        detail = _queue_detail(reason, qa)
        if detail:
            entry['detail'] = detail
        if isinstance(version, int) and not isinstance(version, bool) and 0 <= version <= 2_147_483_647:
            entry['version'] = version
        started = _when(entered)
        if status in COUNTING and started:
            entry['etaAt'] = _iso(started + timedelta(seconds=countdown_s))
        entries.append(entry)
    return entries


def local_queue_holder(queue_db: Path, task_key: str) -> dict | None:
    """The open queue entry that holds `task_key`; a `held` entry holds nothing. Raises when the queue cannot be read."""
    wanted = _clean(task_key)
    for entry in queue_entries(queue_db):
        if entry['taskKey'] == wanted and entry['state'] != HELD:
            return entry
    return None


def _cells(line: str) -> list[str]:
    line = line.strip()
    if '|' not in line:
        return []
    if line.startswith('|'):
        line = line[1:]
    return [c.strip() for c in line.split('|')]


def _read(path: Path) -> str:
    return unicodedata.normalize('NFC', path.read_text(encoding='utf-8-sig', errors='replace'))


def _newest_stream_dir(builder_dir: Path) -> Path | None:
    try:
        folders = [(p.stat().st_mtime, p.name, p) for p in Path(builder_dir).glob('_streams-*') if p.is_dir()]
    except OSError:
        return None
    return max(folders)[2] if folders else None


def _list_keys(path: Path) -> list[str]:
    keys = []
    for line in _read(path).splitlines():
        cells = _cells(line)
        if cells and _KEY.match(cells[0]):
            keys.append(cells[0])
    return keys


def _changed_at(folder: Path, list_file: str | None, n: int) -> float:
    progress = re.compile(rf'^progress-luong{n}(\D.*)?\.md$', re.IGNORECASE)
    paths = [p for p in folder.iterdir() if progress.match(p.name)]
    if list_file:
        paths.append(folder / list_file)
    return max((p.stat().st_mtime for p in paths if p.is_file()), default=0.0)


def stream_entries(builder_dir: Path, now: float, ttl_s: int = STREAM_TTL_S) -> tuple[list[dict], str | None]:
    """(entries of every stream still valid, the worker that owns all REJECTED lines or None)."""
    folder = _newest_stream_dir(builder_dir)
    readme = folder / 'README.md' if folder else None
    if not readme or not readme.is_file():
        return [], None
    text = _read(readme)
    files: dict[int, str | None] = {}
    for line in text.splitlines():
        cells = _cells(line)
        if len(cells) >= 2 and cells[0].isdigit():
            named = _MD_FILE.fullmatch(cells[1])
            if named:
                files.setdefault(int(cells[0]), Path(named.group(1)).name)
    rejected = None
    owner = _REJECTED_OWNER.search(text)
    if owner:
        rejected = int(owner.group(1))
        named = _TICKED_MD.search(owner.group(2))
        if not files.get(rejected):
            files[rejected] = Path(named.group(1)).name if named else None

    holder: dict[str, tuple[int, str]] = {}
    for n in sorted(files, key=lambda s: (s == rejected, s)):
        name = files[n]
        if name and (folder / name).is_file():
            for key in _list_keys(folder / name):
                holder[key] = (n, name)
    handoff = folder / 'handoff.md'
    if handoff.is_file():
        for line in _read(handoff).splitlines():
            cells = _cells(line)
            if len(cells) < 3 or not _KEY.match(cells[0]):
                continue
            source, target = _NUMBER.search(cells[1]), _NUMBER.search(cells[2])
            if not target:
                continue
            files.setdefault(int(target.group()), None)
            moved = f'Luồng {int(source.group())} → ' if source else ''
            holder[cells[0]] = (int(target.group()), f'handoff.md: {moved}Luồng {int(target.group())}')

    valid = {n for n in files if _changed_at(folder, files[n], n) >= now - ttl_s}
    entries = [{'taskKey': key, 'source': 'STREAM', 'worker': f'Luồng {n}', 'state': STREAM_STATE, 'detail': detail[:MAX_DETAIL]}
               for key, (n, detail) in sorted(holder.items()) if n in valid]
    return entries, (f'Luồng {rejected}' if rejected in valid else None)


def _publish(deps) -> str | None:
    try:
        entries = queue_entries(deps.cfg.review_queue_db)
    except (sqlite3.Error, OSError, ValueError) as exc:
        return f'bảng việc: {QUEUE_UNREADABLE} ({type(exc).__name__}), không đăng'
    try:
        listed, owner = stream_entries(deps.cfg.artwork_builder, time.time())
    except OSError as exc:
        return f'bảng việc: không đọc được danh sách luồng ({type(exc).__name__}), không đăng'
    entries += listed
    if len(entries) > MAX_ENTRIES:
        return f'bảng việc: {len(entries)} dòng, quá {MAX_ENTRIES} dòng mỗi lần đăng, không đăng'
    try:
        deps.api.publish_board(entries, owner)
    except ApiError as exc:
        return f'không đăng được bảng việc ({exc.status or "mạng"})'
    return None


def publish_once(deps, state: dict | None = None) -> bool:
    """Publish the whole board once. Never raises; a problem is logged once per `state` until it changes or clears."""
    state = state if state is not None else {}
    try:
        problem = _publish(deps)
    except Exception as exc:
        problem = f'bảng việc: lỗi nội bộ ({type(exc).__name__})'
    try:
        if problem and problem != state.get('problem'):
            deps.log.line(problem)
        elif not problem and state.get('problem'):
            deps.log.line('bảng việc: đăng lại được')
    except Exception:
        pass
    state['problem'] = problem
    return problem is None


def start_publisher(deps, stop: threading.Event) -> threading.Event:
    """Publish now and every BOARD_PUBLISH_S on a daemon thread until `stop` or the returned event is set."""
    done = threading.Event()

    def loop():
        state: dict = {}
        while not (stop.is_set() or done.is_set()):
            publish_once(deps, state)
            deadline = time.monotonic() + BOARD_PUBLISH_S
            while not stop.is_set():
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                if done.wait(min(1.0, left)):
                    return

    threading.Thread(target=loop, name='work-board', daemon=True).start()
    return done


def skip_job(job: dict, deps) -> bool:
    """True when the job must not start: its line is already in the local review queue, or the queue cannot be read."""
    if not isinstance(job, dict) or job.get('kind') == 'LIBRARY_APPLY':
        return False
    task = job.get('task')
    key = _clean(task.get('key')) if isinstance(task, dict) else ''
    if not key:
        return False
    jid = str(job.get('id'))
    try:
        entry = local_queue_holder(deps.cfg.review_queue_db, key)
    except Exception as exc:
        deps.log.line(f'job {jid}: {QUEUE_UNREADABLE} ({type(exc).__name__}), không chạy')
        try:
            deps.api.fail(jid, QUEUE_UNREADABLE, False)
        except Exception as sent:
            deps.log.line(f'job {jid}: không báo được fail ({type(sent).__name__})')
        return True
    if not entry:
        return False
    detail = STATE_TEXT.get(entry['state'], entry['state'])
    if 'version' in entry:
        detail += f', bản v{entry["version"]}'
    if entry.get('detail'):
        detail += f': {entry["detail"]}'
    detail = detail[:MAX_DETAIL].strip()
    deps.log.line(f'job {jid}: dòng {key} đã nằm trong hàng duyệt local ({entry["state"]}), không chạy')
    try:
        deps.api.busy(jid, entry['worker'], detail)
    except Exception as sent:
        deps.log.line(f'job {jid}: không báo được busy ({type(sent).__name__})')
    return True

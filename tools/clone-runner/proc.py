"""Runs a session as a child process and kills its whole process tree (the session starts python, which starts Chromium).

On Windows the child goes into its own Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: every process in it dies when
the last handle to the job closes, and the OS closes that handle when the runner dies, so a session never outlives the
runner. When the child cannot be put in a job, `kill_tree` falls back to `taskkill /T`.

The child's stdout and stderr come through a pipe and a reader thread that replaces each secret value with `***`
before anything reaches the log file, so a value the session echoes is never written to disk.
"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time

CONTAIN_FAILED = ('Không gắn được phiên vào Job Object: nếu runner chết, phiên có thể còn chạy. '
                  'Khi dừng phiên, runner dùng taskkill /T.')
KILL_WAIT_S = 30
POLL_S = 0.5
PUMP_JOIN_S = 10
READ_CHUNK = 65536
MASK = b'***'
MIN_SECRET_LEN = 8

if os.name == 'nt':
    import ctypes
    from ctypes import wintypes

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    PROCESS_TERMINATE = 0x0001
    PROCESS_SET_QUOTA = 0x0100

    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
            'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

    class _BasicLimits(ctypes.Structure):
        _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                    ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                    ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                    ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD),
                    ('SchedulingClass', wintypes.DWORD)]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [('BasicLimitInformation', _BasicLimits), ('IoInfo', _IoCounters),
                    ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                    ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _k32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
    _k32.SetInformationJobObject.restype = wintypes.BOOL
    _k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    _k32.AssignProcessToJobObject.restype = wintypes.BOOL
    _k32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
    _k32.TerminateJobObject.restype = wintypes.BOOL
    _k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _k32.CloseHandle.restype = wintypes.BOOL


class Child:
    def __init__(self, popen: subprocess.Popen, job, pump: threading.Thread):
        self.popen = popen
        self.job = job
        self.pump = pump

    @property
    def pid(self) -> int:
        return self.popen.pid

    @property
    def contained(self) -> bool:
        return self.job is not None


def _contain(pid: int):
    """A kill-on-close Job Object holding `pid`, or None when Windows refuses."""
    job = _k32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = _ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = _k32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ctypes.byref(info),
                                      ctypes.sizeof(info))
    if ok:
        handle = _k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        ok = bool(handle) and bool(_k32.AssignProcessToJobObject(job, handle))
        if handle:
            _k32.CloseHandle(handle)
    if not ok:
        _k32.CloseHandle(job)
        return None
    return job


def _usable(secrets) -> list[str]:
    """Longest first, so a secret that contains another is masked whole. Short values are skipped: an empty or tiny
    one would mask ordinary text."""
    return sorted({s for s in secrets if isinstance(s, str) and len(s) >= MIN_SECRET_LEN}, key=len, reverse=True)


def _masked(data: bytes, secrets: list[bytes]) -> bytes:
    for secret in secrets:
        data = data.replace(secret, MASK)
    return data


def mask_text(text: str, secrets) -> str:
    for secret in _usable(secrets):
        text = text.replace(secret, MASK.decode('ascii'))
    return text


def pump(src, out, secrets=()) -> None:
    """Copies `src` to `out` until EOF with every secret replaced. The tail that could be the start of a secret split
    across two reads is held back until the next read decides it."""
    found = [s.encode('utf-8') for s in _usable(secrets)]
    hold = max((len(s) for s in found), default=1) - 1
    pending = b''
    try:
        while True:
            chunk = src.read1(READ_CHUNK)
            if not chunk:
                break
            pending = _masked(pending + chunk, found)
            if len(pending) > hold:
                cut = len(pending) - hold
                out.write(pending[:cut])
                out.flush()
                pending = pending[cut:]
        out.write(_masked(pending, found))
        out.flush()
    except (OSError, ValueError):
        pass
    finally:
        try:
            src.close()
        except OSError:
            pass


def spawn(argv: list[str], cwd: str, env: dict, out, secrets=()) -> Child:
    """Starts `argv` (a list, never through a shell); stdout and stderr reach the open binary file `out` through
    `pump`, with each of `secrets` masked."""
    extra = {} if os.name == 'nt' else {'start_new_session': True}
    popen = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, shell=False, **extra)
    job = _contain(popen.pid) if os.name == 'nt' else None
    reader = threading.Thread(target=pump, args=(popen.stdout, out, tuple(secrets)), name=f'pump-{popen.pid}',
                              daemon=True)
    reader.start()
    return Child(popen, job, reader)


def kill_tree(child: Child) -> None:
    if os.name == 'nt':
        if child.job:
            _k32.TerminateJobObject(child.job, 1)
        elif child.popen.poll() is None:
            taskkill = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'taskkill.exe')
            try:
                subprocess.run([taskkill, '/PID', str(child.pid), '/T', '/F'], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=KILL_WAIT_S, check=False)
            except (OSError, subprocess.SubprocessError):
                pass
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
    if child.popen.poll() is None:
        try:
            child.popen.kill()
        except OSError:
            pass
    try:
        child.popen.wait(timeout=KILL_WAIT_S)
    except subprocess.TimeoutExpired:
        pass


def wait(child: Child, timeout_s: float, should_stop, poll_s: float = POLL_S) -> str:
    """'exited', 'timeout' or 'stopped'. On the last two the whole tree is killed before this returns."""
    deadline = time.monotonic() + timeout_s
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            kill_tree(child)
            return 'timeout'
        try:
            child.popen.wait(timeout=min(poll_s, left))
            return 'exited'
        except subprocess.TimeoutExpired:
            pass
        if should_stop():
            kill_tree(child)
            return 'stopped'


def close(child: Child) -> None:
    """Releases the job (any process of the session still running dies with it), then waits for the output to be
    written. A process that escaped the job and still holds the pipe only delays this by PUMP_JOIN_S."""
    if os.name == 'nt' and child.job:
        _k32.CloseHandle(child.job)
        child.job = None
    child.pump.join(PUMP_JOIN_S)

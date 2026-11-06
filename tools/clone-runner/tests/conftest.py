import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')


def fixture(name: str) -> str:
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as fh:
        return fh.read()


def pid_alive(pid: int) -> bool:
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = k32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            return bool(k32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def wait_dead(pid: int, within: float = 10) -> bool:
    deadline = time.monotonic() + within
    while pid_alive(pid):
        if time.monotonic() > deadline:
            return False
        time.sleep(0.1)
    return True


def wait_for_text(path, within: float = 15) -> str:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        try:
            with open(path, encoding='utf-8') as fh:
                text = fh.read().strip()
            if text:
                return text
        except OSError:
            pass
        time.sleep(0.05)
    raise AssertionError(f'{path} never appeared')

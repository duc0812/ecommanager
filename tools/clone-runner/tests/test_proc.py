import io
import os
import sys

import pytest

import proc
from conftest import pid_alive, wait_dead, wait_for_text

SLEEPER = ("import subprocess, sys, time\n"
           "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
           "open(sys.argv[1], 'w').write(str(p.pid))\n"
           "time.sleep(60)\n")


@pytest.fixture
def sleeper(tmp_path):
    pidfile = tmp_path / 'grandchild.pid'
    out = open(tmp_path / 'out.log', 'ab')
    child = proc.spawn([sys.executable, '-c', SLEEPER, str(pidfile)], cwd=str(tmp_path), env=dict(os.environ), out=out)
    grandchild = int(wait_for_text(pidfile))
    yield child, grandchild
    proc.kill_tree(child)
    proc.close(child)
    out.close()


def test_timeout_kills_child_and_grandchild(sleeper):
    child, grandchild = sleeper
    assert proc.wait(child, 0.5, lambda: False) == 'timeout'
    assert wait_dead(child.pid) and wait_dead(grandchild)


def test_should_stop_kills_child_and_grandchild(sleeper):
    child, grandchild = sleeper
    asked = []

    def should_stop():
        asked.append(1)
        return len(asked) >= 2

    assert proc.wait(child, 60, should_stop, poll_s=0.1) == 'stopped'
    assert wait_dead(child.pid) and wait_dead(grandchild)


def test_exit_is_reported_with_the_child_code(tmp_path):
    with open(tmp_path / 'out.log', 'ab') as out:
        child = proc.spawn([sys.executable, '-c', 'print("hi"); raise SystemExit(3)'], cwd=str(tmp_path),
                           env=dict(os.environ), out=out)
        try:
            assert proc.wait(child, 30, lambda: False) == 'exited'
        finally:
            proc.close(child)
    assert child.popen.returncode == 3
    assert (tmp_path / 'out.log').read_bytes().strip() == b'hi'


class Chunks:
    def __init__(self, parts):
        self.parts = list(parts)

    def read1(self, n):
        return self.parts.pop(0) if self.parts else b''

    def close(self):
        pass


def test_pump_masks_a_secret_split_anywhere():
    secret, other = 'shpat_secret_value_123', 'cqw_other_secret_value'
    text = f'a {secret} b {secret} c {other}\n'.encode()
    want = b'a *** b *** c ***\n'
    for cut in range(1, len(text)):
        out = io.BytesIO()
        proc.pump(Chunks([text[:cut], text[cut:]]), out, [secret, other])
        assert out.getvalue() == want, cut
    out = io.BytesIO()
    proc.pump(Chunks([bytes([b]) for b in text]), out, [other, secret])
    assert out.getvalue() == want
    out = io.BytesIO()
    proc.pump(Chunks([b'short abc ', b'and the end']), out, ['abc', '', None])
    assert out.getvalue() == b'short abc and the end'


def test_spawn_masks_secrets_on_the_way_to_the_log(tmp_path):
    secret = 'shpat_secret_value_for_spawn'
    code = f'import sys, time; sys.stdout.write("{secret[:6]}"); sys.stdout.flush(); time.sleep(0.2); print("{secret[6:]} x")'
    with open(tmp_path / 'out.log', 'ab') as out:
        child = proc.spawn([sys.executable, '-c', code], cwd=str(tmp_path), env=dict(os.environ), out=out,
                           secrets=[secret])
        try:
            assert proc.wait(child, 30, lambda: False) == 'exited'
        finally:
            proc.close(child)
    assert (tmp_path / 'out.log').read_bytes().strip() == b'*** x'


@pytest.mark.skipif(os.name != 'nt', reason='Job Objects are Windows only')
def test_closing_the_job_kills_the_tree_as_when_the_runner_dies(sleeper):
    child, grandchild = sleeper
    assert child.contained
    proc.close(child)
    assert wait_dead(child.pid) and wait_dead(grandchild)


@pytest.mark.skipif(os.name != 'nt', reason='Job Objects are Windows only')
def test_without_a_job_the_tree_is_still_killed(tmp_path, monkeypatch):
    monkeypatch.setattr(proc, '_contain', lambda pid: None)
    pidfile = tmp_path / 'grandchild.pid'
    with open(tmp_path / 'out.log', 'ab') as out:
        child = proc.spawn([sys.executable, '-c', SLEEPER, str(pidfile)], cwd=str(tmp_path), env=dict(os.environ),
                           out=out)
        try:
            grandchild = int(wait_for_text(pidfile))
            assert not child.contained
            assert pid_alive(grandchild)
            assert proc.wait(child, 0.5, lambda: False) == 'timeout'
        finally:
            proc.kill_tree(child)
            proc.close(child)
    assert wait_dead(child.pid) and wait_dead(grandchild)

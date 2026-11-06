import os
import re
import shutil
import subprocess

import pytest

RUNNER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARSE = ('$errors = $null; '
         '[void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_TO_PARSE, [ref]$null, [ref]$errors); '
         'if ($errors) { $errors | ForEach-Object { $_.Message }; exit 1 }')


def read(name: str) -> str:
    with open(os.path.join(RUNNER_DIR, name), encoding='utf-8') as fh:
        return fh.read()


def test_install_task_starts_a_real_python_from_the_runner_folder():
    text = read('install-task.ps1')
    assert "-like '*\\WindowsApps\\*'" in text
    assert text.count("-like '*\\WindowsApps\\*'") == 2, 'the PATH hit and the interpreter it names are both checked'
    assert 'sys.executable' in text and '(3, 12)' in text
    assert re.search(r'New-ScheduledTaskAction -Execute \$exe -Argument [^\n]* -WorkingDirectory \$here', text)
    assert re.search(r'New-ScheduledTaskSettingsSet -RestartCount \$restartCount -RestartInterval \$restartEvery', text)
    assert '-LogonType Interactive -RunLevel Limited' in text and '-AtLogOn -User $user' in text
    assert 'TOKEN' not in text.upper(), 'the task reads its settings from the environment; this script never touches them'


@pytest.mark.skipif(not shutil.which('powershell'), reason='needs Windows PowerShell to parse the scripts')
@pytest.mark.parametrize('name', ['install-task.ps1', 'set-token.ps1'])
def test_owner_scripts_parse_without_running(name):
    env = {**os.environ, 'PS1_TO_PARSE': os.path.join(RUNNER_DIR, name)}
    done = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', PARSE], env=env,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stdout + done.stderr


def test_readme_names_every_variable_the_runner_reads():
    text = read('README.md')
    code = read('runner.py') + read('session.py')
    names = set(re.findall(r"'(CLONE_[A-Z_]+)'", code)) - {'CLONE_SKILLS_ROOT'}
    assert {'CLONE_BASH_TIMEOUT_MS', 'CLONE_CLI_BACKOFF_S', 'CLONE_WORKER_TOKEN'} <= names
    for name in sorted(names | {'CLONE_SKILLS_ROOT', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS',
                                'DISABLE_AUTOUPDATER'}):
        assert f'`{name}`' in text, name


def test_readme_says_what_the_runner_does_now():
    text = ' '.join(read('README.md').split())
    for phrase in ('--output-format stream-json --verbose', '--safe-mode', 'runner.log', 'runner.log.1',
                   'unverified', 'does not stop a running job', 'revoking the worker token', 'code 3', 'code 4',
                   'its own checkout of a reviewed commit', 're-reads `job_prompt.md`', 'inside a Claude Code session',
                   'QuickEdit', '2 GB', 'CLAUDE.md', 'tool-state.json', 'detect.py --url',
                   'When a session is stopped (the job was cancelled or its lease lost) nothing is sent',
                   'the session itself never updates the CLI'):
        assert phrase in text, phrase
    assert '--output-format json ' not in text and "final JSON line" not in text
    assert 'is stopped or ends without' not in text and 'the CLI version that was checked is the one' not in text

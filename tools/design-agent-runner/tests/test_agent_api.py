import json

import pytest

import agent_api


def api(server): return agent_api.AgentApi(server.url, server.token)


def test_claim_heartbeat_result_fail_follow_the_contract(server, job):
    server.jobs = [job(id='j1'), job(id='j2'), job(id='j3')]
    assert [j['id'] for j in api(server).claim(2, wait_seconds=25)] == ['j1', 'j2']
    assert server.calls[-1] == ('POST', '/api/design-agent/runner/claim', {'free': 2, 'waitSeconds': 25})
    assert api(server).heartbeat('j1', 'vòng 1: codex', 1) is True
    assert server.calls[-1][2] == {'stage': 'vòng 1: codex', 'rounds': 1}
    server.heartbeat_status = 409; assert api(server).heartbeat('j1', 'x', 1) is False
    server.result_reply = {'ok': True, 'status': 'NEEDS_OWNER'}
    assert api(server).result('j1', 'DONE', 'Đã sửa', 2, {'pushed': ['FRONT']})['status'] == 'NEEDS_OWNER'
    assert server.calls[-1][2] == {'outcome': 'DONE', 'summary': 'Đã sửa', 'rounds': 2, 'result': {'pushed': ['FRONT']}}
    assert api(server).fail('j2', 'quá 90 phút', True) == {'ok': True, 'status': 'QUEUED', 'attempts': 1}
    assert server.calls[-1] == ('POST', '/api/design-agent/runner/jobs/j2/fail', {'error': 'quá 90 phút', 'permanent': True})


def test_wrong_token_is_auth_error_without_the_token_in_it(server):
    with pytest.raises(agent_api.AuthError) as e: agent_api.AgentApi(server.url, 'dag_wrong-token-xxxxxxxxxxxxxxxx').claim(1, 0)
    assert e.value.status == 401 and 'dag_wrong' not in str(e.value) and 'dag_wrong' not in repr(agent_api.AgentApi(server.url, 'dag_wrong-token'))


def test_only_https_or_localhost(server):
    with pytest.raises(ValueError): agent_api.AgentApi('http://example.com', 't')
    with pytest.raises(ValueError): agent_api.AgentApi('http://localhost.evil.com', 't')
    agent_api.AgentApi('https://app.example.com/', 't'); agent_api.AgentApi(server.url, 't')


def test_upload_streams_the_file_with_area_name_and_kind(server, tmp_path):
    f = tmp_path / 'FRONT v2.jpg'; f.write_bytes(b'x' * 70000)
    assert api(server).upload('LIT6262_1', 'LEFT SLEEVE', f)['version'] == 2
    method, path, body = server.calls[-1]
    assert (method, path) == ('PUT', '/api/design-agent/runner/tasks/LIT6262_1/artwork')
    assert body == {'query': {'printArea': 'LEFT SLEEVE', 'fileName': 'FRONT v2.jpg', 'kind': 'PRINT'}, 'bytes': 70000}
    api(server).upload('LIT6262_1', 'Preview Anna', f, mockup=True); assert server.calls[-1][2]['query']['kind'] == 'MOCKUP'


def test_download_writes_the_file_whole(server, tmp_path):
    server.files = {'art1': b'JPEGDATA' * 1000}
    assert api(server).download('art1', tmp_path / 'c' / 'FRONT.jpg') == 8000
    assert (tmp_path / 'c' / 'FRONT.jpg').read_bytes() == b'JPEGDATA' * 1000 and not list((tmp_path / 'c').glob('*.part'))
    with pytest.raises(agent_api.ApiError) as e: api(server).download('nope', tmp_path / 'x.jpg')
    assert e.value.status == 404 and not (tmp_path / 'x.jpg').exists()


def test_cli_commands_exit_codes_and_one_json_line(server, env_file, tmp_path, capsys, monkeypatch):
    env_file(server); f = tmp_path / 'FRONT.jpg'; f.write_bytes(b'abc'); monkeypatch.setenv('DESIGN_AGENT_JOB_DIR', str(tmp_path))
    assert agent_api.main(['upload', 'LIT6262_1', 'FRONT', str(f)]) == 0
    assert json.loads(capsys.readouterr().out)['printArea'] == 'FRONT'
    assert agent_api.main(['submit', 'LIT6262_1']) == 0 and json.loads(capsys.readouterr().out) == {'ok': True, 'status': 'REVIEW'}
    assert agent_api.main(['reopen', 'LIT5325_1', 'Nội bộ phát hiện lỗi', 'cập nhật thư viện']) == 0
    assert server.calls[-1][2] == {'reason': 'Nội bộ phát hiện lỗi', 'note': 'cập nhật thư viện'}; capsys.readouterr()
    assert agent_api.main(['note', 'LIT6262_1', 'Đã cập nhật theo thư viện mới']) == 0
    assert server.calls[-1] == ('POST', '/api/design-agent/runner/notes', {'taskKey': 'LIT6262_1', 'message': 'Đã cập nhật theo thư viện mới'}); capsys.readouterr()
    server.status = {'/tasks/LIT6262_1/submit': (400, {'error': 'Thiếu file in', 'missing': ['BACK']})}
    assert agent_api.main(['submit', 'LIT6262_1']) == 1
    assert json.loads(capsys.readouterr().out) == {'ok': False, 'status': 400, 'error': 'Thiếu file in', 'missing': ['BACK']}
    assert agent_api.main(['upload', 'LIT6262_1', 'FRONT', str(tmp_path / 'none.jpg')]) == 2
    calls = [json.loads(l) for l in (tmp_path / 'api-calls.jsonl').read_text(encoding='utf-8').splitlines()]
    assert [(c['cmd'], c['status']) for c in calls][:3] == [('upload', 200), ('submit', 200), ('reopen', 200)]


def test_cli_download_and_usage(server, env_file, tmp_path, capsys):
    env_file(server)
    assert agent_api.main(['download', 'art1', str(tmp_path / 'd' / 'a.jpg')]) == 0
    assert json.loads(capsys.readouterr().out)['bytes'] == 8 and (tmp_path / 'd' / 'a.jpg').read_bytes() == b'front-v1'
    assert agent_api.main(['download', 'nope', str(tmp_path / 'b.jpg')]) == 1 and json.loads(capsys.readouterr().out)['status'] == 404
    assert agent_api.main(['bogus']) == 2 and json.loads(capsys.readouterr().out)['ok'] is False
    empty = tmp_path / 'empty.jpg'; empty.write_bytes(b'')
    assert agent_api.main(['upload', 'LIT1_1', 'FRONT', str(empty)]) == 2


def test_cli_config_and_network_errors_never_show_the_token(server, env_file, tmp_path, capsys, monkeypatch):
    monkeypatch.setenv('DESIGN_AGENT_ENV', str(tmp_path / 'none.env'))
    assert agent_api.main(['submit', 'LIT1_1']) == 2 and 'thiếu ECOM_URL hoặc DESIGN_AGENT_TOKEN' in capsys.readouterr().out
    env_file(server, ECOM_URL='http://127.0.0.1:9')
    assert agent_api.main(['submit', 'LIT1_1']) == 3 and server.token not in capsys.readouterr().out

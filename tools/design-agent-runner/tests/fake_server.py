"""A fake Ecom Manager implementing the Design Agent runner contract, for tests only."""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

BASE = '/api/design-agent/runner'


class FakeServer:
    def __init__(self):
        self.token = 'dag_test-token-0123456789abcdef'
        self.jobs: list[dict] = []
        self.heartbeat_status = 200
        self.heartbeat_ok_first = 0
        self.heartbeats = 0
        self.result_reply = None
        self.fail_reply = {'ok': True, 'status': 'QUEUED', 'attempts': 1}
        self.files = {'art1': b'front-v1'}
        self.status: dict = {}
        self.sequence: dict = {}
        self.calls: list[tuple] = []
        self.times: list[tuple] = []
        self.lock = threading.Lock()
        self.upload_n = 1
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass

            def _send(self, status, body, raw=False):
                data = body if raw else json.dumps(body, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/octet-stream' if raw else 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _read(self):
                n = int(self.headers.get('Content-Length') or 0)
                data = b''
                while len(data) < n:
                    chunk = self.rfile.read(min(65536, n - len(data)))
                    if not chunk:
                        break
                    data += chunk
                return data

            def _handle(self):
                parts = urlsplit(self.path)
                path = parts.path
                data = self._read()
                if self.command == 'PUT':
                    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
                    body = {'query': query, 'bytes': len(data)}
                else:
                    try:
                        body = json.loads(data.decode('utf-8')) if data else {}
                    except ValueError:
                        body = {'_raw': data.decode('utf-8', 'replace')}
                with outer.lock:
                    outer.calls.append((self.command, path, body))
                    outer.times.append((time.monotonic(), path))
                if self.headers.get('Authorization') != f'Bearer {outer.token}':
                    return self._send(401, {'error': 'unauthorized'})
                if not path.startswith(BASE):
                    return self._send(404, {'error': 'not found'})
                rel = path[len(BASE):]
                with outer.lock:
                    queued = outer.sequence.get(rel)
                    forced_once = queued.pop(0) if queued else None
                if forced_once is not None:
                    return self._send(forced_once, {'error': 'forced'})
                for prefix, forced in list(outer.status.items()):
                    if rel.startswith(prefix):
                        if isinstance(forced, tuple):
                            return self._send(forced[0], forced[1])
                        return self._send(forced, {'error': 'unauthorized' if forced == 401 else 'forced'})
                seg = rel.strip('/').split('/')
                if self.command == 'POST' and rel == '/claim':
                    free = int(body.get('free', 0))
                    with outer.lock:
                        out, outer.jobs = outer.jobs[:free], outer.jobs[free:]
                    if not out:
                        time.sleep(0.2)
                    return self._send(200, {'jobs': out})
                if self.command == 'POST' and len(seg) == 3 and seg[0] == 'jobs':
                    if seg[2] == 'heartbeat':
                        outer.heartbeats += 1
                        if outer.heartbeats <= outer.heartbeat_ok_first:
                            return self._send(200, {'ok': True})
                        if outer.heartbeat_status == 409:
                            return self._send(409, {'error': 'not running'})
                        return self._send(outer.heartbeat_status, {'ok': True})
                    if seg[2] == 'result':
                        reply = outer.result_reply or {'ok': True, 'status': body.get('outcome')}
                        return self._send(200, reply)
                    if seg[2] == 'fail':
                        return self._send(200, outer.fail_reply)
                if self.command == 'POST' and rel == '/notes':
                    return self._send(200, {'ok': True})
                if self.command == 'POST' and rel == '/hold':
                    return self._send(200, {'ok': True, 'jobId': None})
                if len(seg) == 3 and seg[0] == 'tasks':
                    if self.command == 'PUT' and seg[2] == 'artwork':
                        with outer.lock:
                            outer.upload_n += 1
                            n = outer.upload_n
                        return self._send(200, {'ok': True, 'artworkId': f'up{n}', 'version': 2,
                                                'printArea': body['query'].get('printArea')})
                    if self.command == 'POST' and seg[2] == 'submit':
                        return self._send(200, {'ok': True, 'status': 'REVIEW'})
                    if self.command == 'POST' and seg[2] == 'reopen':
                        return self._send(200, {'ok': True, 'status': 'DOING', 'sent': False})
                if self.command == 'GET' and len(seg) == 2 and seg[0] == 'files':
                    blob = outer.files.get(seg[1])
                    if blob is None:
                        return self._send(404, {'error': 'not found'})
                    return self._send(200, blob, raw=True)
                return self._send(404, {'error': 'not found'})

            do_GET = do_POST = do_PUT = _handle

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.httpd.daemon_threads = True
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}'
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

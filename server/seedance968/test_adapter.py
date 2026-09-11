import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import adapter


class ContractTests(unittest.TestCase):
    def test_legacy_fields_and_reference_order(self):
        result = adapter.build_request({'model': 'sd2.5', 'prompt': 'test', 'seconds': 30, 'ratio': '9:16', 'resolution': '720p', 'image_urls': ['b', 'a', 'b']})
        self.assertEqual(result, {'model': 'sd2.5', 'prompt': 'test', 'duration': 30, 'aspect_ratio': '9:16', 'reference_images': ['b', 'a', 'b']})

    def test_native_fields_and_face_split(self):
        result = adapter.build_request({'model': 'sd2.5-route1', 'prompt': 'test', 'duration': 30, 'aspect_ratio': '21:9', 'image': {'image_url': 'ref'}, 'face_split': True})
        self.assertEqual(result['reference_images'], ['ref'])
        self.assertEqual(result['aspect_ratio'], '21:9')
        self.assertTrue(result['face_split'])

    def test_invalid_contract_rejected(self):
        for change in [{'duration': 5}, {'duration': True}, {'reference_images': ['x'] * 10}, {'model': 'other'}, {'reference_videos': ['x']}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                adapter.build_request({'model': 'sd2.5', 'prompt': 'test', **change})

    def test_media_origin_and_path(self):
        self.assertEqual(adapter.content_path('/v1/videos/test/content', 'test'), '/v1/videos/test/content')
        for url in ['https://elsewhere.test/v1/videos/test/content', '//elsewhere.test/file', '/v1/videos/other/content', '/admin']:
            with self.assertRaises(ValueError):
                adapter.content_path(url, 'test')

    def test_download_redirect_cannot_forward_credentials(self):
        self.assertIsNone(adapter.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.test'))


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='flow-seedance968-')
        self.calls = []
        self.status = 'pending'
        owner = self

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, code, payload):
                self.send_response(code)
                self.end_headers()
                self.wfile.write(payload if isinstance(payload, bytes) else json.dumps(payload).encode())

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.calls.append(('POST', self.path, self.headers.get('Authorization'), body))
                self.respond(200, {'request_id': 'task-123'})

            def do_GET(self):
                owner.calls.append(('GET', self.path, self.headers.get('Authorization')))
                if self.path == '/v1/videos/task-123/content':
                    self.respond(200, b'\x00\x00\x00\x18ftypisom' + b'x' * 100)
                elif self.path == '/v1/videos/generations/task-123':
                    self.respond(200, {'id': 'task-123', 'status': owner.status, 'video': {'url': '/v1/videos/task-123/content'}, 'error': {'message': 'Rejected'}})
                else:
                    self.respond(404, {'error': {'message': 'Video request not found'}})

        self.upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()
        self.config = patch.multiple(adapter, UPSTREAM=f'http://127.0.0.1:{self.upstream.server_port}', MEDIA_DIR=Path(self.temp.name) / 'media', STATE_DB=str(Path(self.temp.name) / 'state.sqlite'))
        self.config.start()
        adapter.init()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), adapter.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.config.stop()
        self.temp.cleanup()

    def call(self, path, body=None):
        request = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}' + path, data=json.dumps(body).encode() if body else None, headers={'Authorization': 'Bearer test-owner'})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def test_submission_is_single_post_and_normalized_id(self):
        result = self.call('/v1/videos', {'model': 'sd2.5', 'prompt': 'test', 'seconds': 30, 'image_urls': ['second', 'first']})
        self.assertEqual(result['id'], 'task-123')
        self.assertEqual(self.calls, [('POST', '/v1/videos/generations', 'Bearer test-owner', {'model': 'sd2.5', 'prompt': 'test', 'duration': 30, 'aspect_ratio': '16:9', 'reference_images': ['second', 'first']})])
        self.assertEqual(self.call('/v1/videos/task-123')['status'], 'in_progress')
        self.assertEqual(len(self.calls), 1)

    def test_poll_cache_survives_store_reopen(self):
        self.call('/v1/videos/task-123')
        adapter.init()
        self.call('/v1/videos/task-123')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1], '/v1/videos/generations/task-123')
        adapter.poll('task-123', 'Bearer different-owner')
        self.assertEqual(len(self.calls), 2)

    def test_done_download_uses_supplier_auth_and_public_url(self):
        self.status = 'done'
        result = self.call('/v1/videos/task-123')
        for _ in range(100):
            if result['status'] == 'completed':
                break
            time.sleep(0.01)
            result = self.call('/v1/videos/task-123')
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result['video_url'].startswith(adapter.PUBLIC_MEDIA + '/'))
        self.assertEqual(len(list(adapter.MEDIA_DIR.glob('*.mp4'))), 1)
        self.assertIn(('GET', '/v1/videos/task-123/content', 'Bearer test-owner'), self.calls)
        self.assertEqual(len(self.calls), 2)

    def test_failed_and_pending_timeout_are_terminal(self):
        self.status = 'failed'
        self.assertEqual(self.call('/v1/videos/task-123')['status'], 'failed')
        key = adapter.identity('Bearer test-owner', 'task-123')
        adapter.save(key, time.time() - 3601, {'status': 'pending'})
        self.assertEqual(self.call('/v1/videos/task-123')['status'], 'failed')
        self.call('/v1/videos/task-123')
        self.assertEqual(len(self.calls), 1)

    def test_404_is_not_a_generation_state(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/v1/videos/not-found')
        self.assertEqual(error.exception.code, 404)

    def test_post_timeout_does_not_resubmit(self):
        with patch.object(adapter, 'request', side_effect=TimeoutError) as request:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.call('/v1/videos', {'model': 'sd2.5', 'prompt': 'test'})
            self.assertEqual(error.exception.code, 502)
            self.assertIn('outcome unknown', error.exception.read().decode())
            self.assertEqual(request.call_count, 1)

    def test_download_failure_stays_recoverable(self):
        with patch.object(adapter, 'request', side_effect=TimeoutError):
            adapter.download('test-key', 'task-123', 'Bearer test-owner', '/v1/videos/task-123/content')
        self.assertFalse(list(adapter.MEDIA_DIR.iterdir()))


if __name__ == '__main__':
    unittest.main()

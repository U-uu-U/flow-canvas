"""Translate the legacy RavenHash video contract to the 968API contract."""
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.getenv('UPSTREAM', 'https://ap.968968968.xyz').rstrip('/')
PUBLIC_MEDIA = os.getenv('PUBLIC_MEDIA', 'https://art.ravenhash.org/fc-media/files').rstrip('/')
MEDIA_DIR = Path(os.getenv('MEDIA_DIR', '/media'))
STATE_DB = os.getenv('STATE_DB', '/state/tasks.sqlite')
LOCKS = [threading.Lock() for _ in range(64)]
DOWNLOADS = set()
DOWNLOAD_LOCK = threading.Lock()
TASK_ID = re.compile(r'^[A-Za-z0-9_-]{1,160}$')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the supplier credential to a redirected media host.
        return None


HTTP = urllib.request.build_opener(NoRedirect)


def request(path, auth, data=None, timeout=20):
    headers = {'Authorization': auth, 'User-Agent': 'FlowCanvas-Video-Adapter/1.0', 'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    return HTTP.open(urllib.request.Request(UPSTREAM + path, data=data, headers=headers), timeout=timeout)


def build_request(body):
    if body.get('model') not in ('sd2.5', 'sd2.5-route1'):
        raise ValueError('This channel only supports sd2.5')
    duration = body.get('duration', body.get('seconds', 30))
    if isinstance(duration, bool) or duration != 30:
        raise ValueError('This RavenHash route requires duration 30')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('prompt is required')
    ratio = body.get('aspect_ratio', body.get('ratio', '16:9'))
    if ratio not in ('21:9', '16:9', '4:3', '1:1', '3:4', '9:16'):
        raise ValueError('Unsupported aspect_ratio')
    images = next((body[k] for k in ('reference_images', 'images', 'image_urls', 'image') if k in body), [])
    if not isinstance(images, list):
        images = [images]
    images = [image.get('url', image.get('image_url')) if isinstance(image, dict) else image for image in images]
    if len(images) > 9 or any(not isinstance(image, str) or not image.strip() for image in images):
        raise ValueError('At most 9 non-empty reference images are supported')
    if any(body.get(k) for k in ('reference_videos', 'reference_audios', 'videos', 'audios')):
        raise ValueError('This route accepts images only')
    result = {'model': 'sd2.5', 'prompt': prompt, 'duration': duration, 'aspect_ratio': ratio}
    if images:
        result['reference_images'] = images
    if 'face_split' in body:
        result['face_split'] = body['face_split']
    return result


def identity(auth, task):
    return hashlib.sha256((auth + '\0' + task).encode()).hexdigest()


@contextmanager
def db():
    connection = sqlite3.connect(STATE_DB, timeout=20)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def init():
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    Path(STATE_DB).parent.mkdir(parents=True, exist_ok=True)
    with db() as connection:
        connection.execute('CREATE TABLE IF NOT EXISTS tasks (key TEXT PRIMARY KEY, born REAL, checked REAL, payload TEXT)')
        connection.execute('DELETE FROM tasks WHERE born < ?', (time.time() - 7 * 86400,))


def save(key, born, payload):
    with db() as connection:
        connection.execute('INSERT OR REPLACE INTO tasks VALUES (?, ?, ?, ?)', (key, born, time.time(), json.dumps(payload)))


def content_path(raw_url, task):
    resolved = urllib.parse.urlsplit(urllib.parse.urljoin(UPSTREAM + '/', raw_url))
    upstream = urllib.parse.urlsplit(UPSTREAM)
    if (resolved.scheme, resolved.netloc) != (upstream.scheme, upstream.netloc):
        raise ValueError('Unexpected authenticated media origin')
    if resolved.path != '/v1/videos/' + task + '/content' or resolved.query:
        raise ValueError('Unexpected authenticated media path')
    return resolved.path


def download(key, task, auth, path):
    temporary = MEDIA_DIR / (key + '.part')
    try:
        with request(path, auth, timeout=300) as response, temporary.open('wb') as output:
            total = 0
            started = time.monotonic()
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                if total == 0 and (len(chunk) < 12 or chunk[4:8] != b'ftyp'):
                    raise ValueError('Upstream content is not an MP4')
                total += len(chunk)
                if total > 512 * 1024 * 1024 or time.monotonic() - started > 600:
                    raise ValueError('Video transfer limit exceeded')
                output.write(chunk)
            if not total:
                raise ValueError('Upstream returned empty content')
        temporary.replace(MEDIA_DIR / (key + '.mp4'))
    except Exception as error:
        # Keep the task recoverable: a failed download must not become generation failure.
        print(json.dumps({'event': 'download_failed', 'task_id': task, 'error_type': type(error).__name__}), flush=True)
    finally:
        temporary.unlink(missing_ok=True)
        with DOWNLOAD_LOCK:
            DOWNLOADS.discard(key)


def normalize_result(payload, task, auth, key):
    state = str(payload.get('status', '')).lower()
    if state == 'pending':
        return {'id': task, 'status': 'in_progress'}
    if state == 'failed':
        return {'id': task, 'status': 'failed', 'error': payload.get('error') or {'message': 'Upstream generation failed'}}
    if state != 'done':
        raise ValueError('Unrecognized upstream task status')
    raw_url = (payload.get('video') or {}).get('url')
    if not isinstance(raw_url, str) or not raw_url:
        raise ValueError('Completed task is missing video.url')
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme == 'https' and parsed.netloc != urllib.parse.urlsplit(UPSTREAM).netloc:
        return {'id': task, 'status': 'completed', 'video_url': raw_url}
    path = content_path(raw_url, task)
    media = MEDIA_DIR / (key + '.mp4')
    if media.exists() and media.stat().st_mtime > time.time() - 23 * 3600:
        return {'id': task, 'status': 'completed', 'video_url': PUBLIC_MEDIA + '/' + media.name}
    with DOWNLOAD_LOCK:
        if key not in DOWNLOADS:
            DOWNLOADS.add(key)
            threading.Thread(target=download, args=(key, task, auth, path), daemon=True).start()
    return {'id': task, 'status': 'in_progress', 'stage': 'downloading', 'progress': 99}


def poll(task, auth):
    key = identity(auth, task)
    with LOCKS[int(key[:8], 16) % len(LOCKS)]:
        with db() as connection:
            row = connection.execute('SELECT born, checked, payload FROM tasks WHERE key=?', (key,)).fetchone()
        born = row[0] if row else time.time()
        cached = json.loads(row[2]) if row else None
        terminal = cached and cached.get('status') in ('done', 'failed')
        if cached and (terminal or time.time() - row[1] < 30):
            payload = cached
        else:
            with request('/v1/videos/generations/' + task, auth) as response:
                payload = json.load(response)
            save(key, born, payload)
        if payload.get('status') == 'pending' and time.time() - born > 3600:
            payload = {'status': 'failed', 'error': {'message': 'Upstream pending exceeded one hour; no resubmission performed'}}
            save(key, born, payload)
        return normalize_result(payload, task, auth, key)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, submit):
        if self.path == '/health' and not submit:
            return self.reply(200, {'ok': True, 'adapter': 'seedance968-v1'})
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer ') or len(auth) < 9:
            return self.reply(401, {'error': {'message': 'Bearer authentication required'}})
        try:
            if submit:
                if self.path not in ('/v1/videos', '/v1/video/generations', '/v1/videos/generations'):
                    return self.reply(404, {'error': {'message': 'Unsupported submission path'}})
                length = int(self.headers.get('Content-Length', 0))
                if length <= 0 or length > 32 * 1024 * 1024:
                    return self.reply(413, {'error': {'message': 'Invalid request size'}})
                try:
                    body = build_request(json.loads(self.rfile.read(length)))
                except (ValueError, TypeError, AttributeError) as error:
                    return self.reply(400, {'error': {'message': str(error)}})
                # A timeout is ambiguous. Never retry a POST automatically.
                with request('/v1/videos/generations', auth, json.dumps(body).encode(), timeout=180) as response:
                    payload = json.load(response)
                task = payload.get('request_id')
                if not isinstance(task, str) or not TASK_ID.fullmatch(task):
                    raise ValueError('Submission returned no valid request_id; do not blindly resubmit')
                save(identity(auth, task), time.time(), {'status': 'pending'})
                return self.reply(200, {'id': task, 'task_id': task, 'status': 'queued'})
            match = re.fullmatch(r'/v1/(?:videos(?:/generations)?|tasks)/([A-Za-z0-9_-]{1,160})', self.path)
            if not match:
                return self.reply(404, {'error': {'message': 'Unsupported task path'}})
            self.reply(200, poll(match[1], auth))
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read(16384))
            except ValueError:
                payload = {'error': {'message': 'Upstream HTTP ' + str(error.code)}}
            self.reply(error.code, payload)
        except (ValueError, TypeError) as error:
            self.reply(502, {'error': {'message': str(error)}})
        except Exception as error:
            print(json.dumps({'event': 'upstream_error', 'error_type': type(error).__name__, 'submit': submit}), flush=True)
            self.reply(502, {'error': {'message': 'Upstream connection interrupted; submission outcome unknown, do not blindly resubmit' if submit else 'Upstream query unavailable; retry the same task ID'}})


if __name__ == '__main__':
    init()
    ThreadingHTTPServer(('0.0.0.0', int(os.getenv('PORT', '3011'))), Handler).serve_forever()

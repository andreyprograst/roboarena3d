# РобоАрена 3D — локальный сервер на чистой стандартной библиотеке Python.
# Запуск: py server.py  (или python server.py)  →  http://localhost:8123
import http.server
import socketserver
import webbrowser
import threading
import os

PORT = 8123
ROOT = os.path.dirname(os.path.abspath(__file__))

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.ino': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # без спама в консоль


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


with Server(('127.0.0.1', PORT), Handler) as httpd:
    url = f'http://localhost:{PORT}'
    print()
    print('  РобоАрена 3D запущена.')
    print('  Открой в браузере: ' + url)
    print('  Остановить сервер: Ctrl+C')
    print()
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('Сервер остановлен.')

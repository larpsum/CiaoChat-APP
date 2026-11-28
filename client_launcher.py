#!/usr/bin/env python3
"""CiaoChat thin client.

Serves the web UI locally and connects it to the hosted CiaoChat backend.
No server code, no Firebase credentials are bundled or required.

Configure the backend with the CIAOCHAT_SERVER environment variable, e.g.:
    set CIAOCHAT_SERVER=https://chat.example.com
    python client_launcher.py
"""
import os
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CLIENT_PORT = int(os.environ.get("CIAOCHAT_PORT", "8899"))


def remote_ws_url():
    server = os.environ.get("CIAOCHAT_SERVER", "").strip()
    if not server:
        # Fall back to a server.txt / ciaochat-server.txt next to the exe or cwd,
        # so end users can point the app at the backend without rebuilds.
        candidates = [os.path.join(BASE_DIR, "server.txt")]
        if getattr(sys, "frozen", False):
            candidates.append(os.path.join(os.path.dirname(sys.executable), "server.txt"))
        candidates += ["server.txt", "ciaochat-server.txt"]
        for path in candidates:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    server = f.read().strip()
                if server:
                    break
            except OSError:
                continue
    server = server.rstrip("/")
    if not server:
        return ""
    if server.startswith("https://"):
        return "wss://" + server[len("https://"):] + "/ws"
    if server.startswith("http://"):
        return "ws://" + server[len("http://"):] + "/ws"
    return "wss://" + server + "/ws"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve ONLY static/ — nothing else in BASE_DIR is reachable.
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/static/config.js" or path == "/config.js":
            ws_url = remote_ws_url()
            body = (
                "window.CIAOCHAT_CONFIG = { wsUrl: " + repr(ws_url) + " };\n"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/static/"):
            self.path = path[len("/static"):] or "/"
        elif path in ("/", "/index.html"):
            self.path = "/index.html"
        else:
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", CLIENT_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.6)
    webbrowser.open(f"http://127.0.0.1:{CLIENT_PORT}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()

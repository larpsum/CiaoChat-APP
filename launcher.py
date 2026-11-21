#!/usr/bin/env python3
"""Windows entry point for CiaoChat."""

import os
import sys
import threading
import time
import webbrowser

import server
import ws_bridge


def resource_path(relative_path):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, relative_path)


def open_browser():
    time.sleep(1.5)
    webbrowser.open("http://127.0.0.1:8080")


def runtime_data_dir():
    if not getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(__file__))
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if not local_app_data:
            local_app_data = os.path.join(os.path.expanduser("~"), "AppData", "Local")
        data_dir = os.path.join(local_app_data, "CiaoChat")
        os.makedirs(data_dir, exist_ok=True)
        return data_dir
    return os.path.dirname(os.path.abspath(sys.executable))


def run_chat_server():
    try:
        runtime_dir = runtime_data_dir()
        server.BASE_DIR = runtime_dir
        server.MEDIA_DIR = os.path.join(runtime_dir, "media")
        server.SERVICE_ACCOUNT_FILE = os.environ.get(
            "PYCHAT_SERVICE_ACCOUNT",
            os.path.join(runtime_dir, "serviceAccountKey.json"),
        )
        server.main()
    except SystemExit as exc:
        print(f"CiaoChat server: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"CiaoChat server failed: {exc}", file=sys.stderr)


def main():
    os.chdir(resource_path("."))
    ws_bridge.BASE_DIR = resource_path(".")
    ws_bridge.STATIC_DIR = resource_path("static")

    server_thread = threading.Thread(target=run_chat_server, daemon=True)
    server_thread.start()
    threading.Thread(target=open_browser, daemon=True).start()
    ws_bridge.main()


if __name__ == "__main__":
    main()

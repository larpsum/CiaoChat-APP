#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CiaoChat — comandi admin da riga di comando (backend, nessuna UI).

Richiede che il server sia avviato con PYCHAT_ADMIN_TOKEN impostato.

Uso:
    set PYCHAT_ADMIN_TOKEN=...            (Windows)
    export PYCHAT_ADMIN_TOKEN=...         (Linux/macOS)

    python admin.py stats
    python admin.py user --user mario
    python admin.py logout --user mario
    python admin.py broadcast --text "Manutenzione alle 22:00"

Host/porta: PYCHAT_HOST / PYCHAT_PORT oppure --host/--port (default 127.0.0.1:5555).
"""

import argparse
import json
import os
import socket
import sys


def main():
    parser = argparse.ArgumentParser(description="Comandi admin CiaoChat")
    parser.add_argument("action", choices=["stats", "user", "logout", "broadcast"])
    parser.add_argument("--user", help="Username target (per user/logout)")
    parser.add_argument("--text", help="Testo dell'avviso (per broadcast)")
    parser.add_argument("--key", default=os.environ.get("PYCHAT_ADMIN_TOKEN", ""),
                        help="Token admin (default: env PYCHAT_ADMIN_TOKEN)")
    parser.add_argument("--host", default=os.environ.get("PYCHAT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PYCHAT_PORT", "5555")))
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()

    if not args.key:
        sys.exit("Manca la chiave admin: imposta PYCHAT_ADMIN_TOKEN o usa --key.")
    if args.action in ("user", "logout") and not args.user:
        sys.exit(f"L'azione '{args.action}' richiede --user <username>.")
    if args.action == "broadcast" and not (args.text or "").strip():
        sys.exit("L'azione 'broadcast' richiede --text.")

    msg = {"t": "admin", "key": args.key, "action": args.action}
    if args.user:
        msg["user"] = args.user
    if args.text:
        msg["text"] = args.text

    try:
        with socket.create_connection((args.host, args.port), timeout=args.timeout) as sock:
            sock.settimeout(args.timeout)
            sock.sendall((json.dumps(msg) + "\n").encode("utf-8"))
            buf = b""
            while b"\n" not in buf:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
    except OSError as exc:
        sys.exit(f"Impossibile contattare il server {args.host}:{args.port}: {exc}")

    line = buf.split(b"\n", 1)[0].decode("utf-8", "replace").strip()
    try:
        reply = json.loads(line)
    except ValueError:
        sys.exit(f"Risposta non valida dal server: {line[:200]}")
    print(json.dumps(reply, ensure_ascii=False, indent=2))
    if reply.get("t") == "err":
        sys.exit(1)


if __name__ == "__main__":
    main()

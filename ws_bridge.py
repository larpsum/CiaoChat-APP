#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CiaoChat - Web UI bridge.

Serves a modern browser frontend and bridges WebSocket clients to the
existing TCP chat server (server.py on port 5555).

Avvio:
    pip install websockets aiohttp
    python ws_bridge.py

Il server chat (server.py) deve essere gia' in esecuzione su localhost:5555.
"""
import asyncio
import os
from aiohttp import web

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TCP_HOST = "127.0.0.1"
TCP_PORT = 5555


async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    reader, writer = await asyncio.open_connection(TCP_HOST, TCP_PORT)

    async def tcp_to_ws():
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                await ws.send_str(line.decode("utf-8", "replace"))
        except (ConnectionResetError, asyncio.IncompleteReadError, OSError):
            pass
        finally:
            await ws.close()

    async def ws_to_tcp():
        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    data = msg.data.strip()
                    if not data:
                        continue
                    writer.write((data + "\n").encode("utf-8"))
                    await writer.drain()
                elif msg.type == web.WSMsgType.ERROR:
                    break
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except OSError:
                pass

    await asyncio.gather(tcp_to_ws(), ws_to_tcp())
    return ws


async def index(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


async def static_file(request):
    name = request.match_info["name"]
    return web.FileResponse(os.path.join(STATIC_DIR, name))


def main():
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/static/{name}", static_file)
    app.router.add_get("/ws", ws_handler)
    web.run_app(app, host="0.0.0.0", port=8080)


if __name__ == "__main__":
    main()

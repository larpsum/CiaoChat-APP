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
import json
import os
from aiohttp import web

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TCP_HOST = "127.0.0.1"
TCP_PORT = 5555
TCP_LINE_LIMIT = 2_500_000


async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    try:
        reader, writer = await asyncio.open_connection(TCP_HOST, TCP_PORT, limit=TCP_LINE_LIMIT)
    except OSError:
        await ws.send_json({"t": "err", "text": "Server chat non disponibile. Verifica le credenziali Firebase e riprova."})
        await ws.close()
        return ws

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
    tail = request.match_info.get("tail") or request.match_info.get("name") or ""
    rel = os.path.normpath(tail).replace("\\", "/").lstrip("/")
    if not rel or rel.startswith("..") or os.path.isabs(rel):
        raise web.HTTPNotFound()
    path = os.path.join(STATIC_DIR, rel)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path)

async def emoji_file(request):
    name = request.match_info["name"]
    if os.path.basename(name) != name or not name.endswith(".svg"):
        raise web.HTTPNotFound()
    return web.FileResponse(os.path.join(STATIC_DIR, "emoji", name))


async def rpc_request(request, command):
    auth = request.headers.get("Authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    user = request.headers.get("X-CiaoChat-User", "").strip().lower()
    if not token or not user:
        return web.json_response({"error": "Missing authentication"}, status=401)
    try:
        reader, writer = await asyncio.open_connection(TCP_HOST, TCP_PORT, limit=TCP_LINE_LIMIT)
    except OSError:
        return web.json_response({"error": "Chat server unavailable"}, status=503)
    try:
        writer.write((json.dumps({"t": "resume", "user": user, "token": token}) + "\n").encode("utf-8"))
        await writer.drain()
        resume_line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not resume_line:
            return web.json_response({"error": "Invalid session"}, status=401)
        resume = json.loads(resume_line.decode("utf-8", "replace"))
        if resume.get("t") != "ok":
            return web.json_response({"error": resume.get("text", "Invalid session")}, status=401)
        writer.write((json.dumps(command) + "\n").encode("utf-8"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not line:
            return web.json_response({"error": "Chat server response timeout"}, status=504)
        payload = json.loads(line.decode("utf-8", "replace"))
        status = 400 if payload.get("t") == "err" else 200
        return web.json_response(payload, status=status)
    except (asyncio.TimeoutError, json.JSONDecodeError, ConnectionError, OSError):
        return web.json_response({"error": "Chat server error"}, status=502)
    finally:
        writer.close()
        await writer.wait_closed()


async def get_me(request):
    return await rpc_request(request, {"t": "settings_get"})


async def put_me(request):
    body = await request.json()
    account = body.get("account", body)
    settings = body.get("user_settings", body)
    if "account" in body:
        await rpc_request(request, {
            "t": "account_update",
            "username": account.get("username"),
            "display_name": account.get("display_name"),
            "email": account.get("email"),
            "bio": account.get("bio"),
            "status": account.get("status", account.get("custom_status", {}).get("text", "")),
            "status_expires_in": 0,
            "current_password": account.get("current_password", ""),
        })
    command = {"t": "settings_update"}
    if "dm_privacy" in settings:
        command["dm_privacy"] = settings["dm_privacy"]
    if "friend_request_privacy" in settings:
        command["friend_request_privacy"] = settings["friend_request_privacy"]
    if "explicit_media_filter" in settings:
        command["explicit_media_filter"] = settings["explicit_media_filter"]
    if "notifications" in settings:
        command["notifications"] = settings["notifications"]
    if "appearance" in settings:
        command["appearance"] = settings["appearance"]
    if "keybinds" in settings:
        command["keybinds"] = settings["keybinds"]
    return await rpc_request(request, command)


async def get_sessions(request):
    return await rpc_request(request, {"t": "settings_get"})


async def revoke_session(request):
    return await rpc_request(request, {"t": "session_revoke", "session": request.match_info["session_id"]})


async def relationships(request):
    if request.method == "GET":
        return await rpc_request(request, {"t": "settings_get"})
    body = await request.json()
    action = body.get("action")
    if action == "friend_request" and body.get("target_user_id"):
        body["user"] = body["target_user_id"]
    elif body.get("target_user_id"):
        body["user"] = body["target_user_id"]
    body["t"] = "relationship_update"
    return await rpc_request(request, body)


async def group_resource(request):
    group_id = request.match_info["group_id"]
    if request.method == "GET":
        return await rpc_request(request, {"t": "community_get", "community": group_id})
    body = await request.json()
    command = {"t": "community_update", "community": group_id}
    for key in ("name", "default_notification", "welcome_channel"):
        if key in body:
            command[key] = body[key]
    if "default_notification_level" in body:
        command["default_notification"] = "mentions" if body["default_notification_level"] == "mentions_only" else "all"
    if "system_welcome_channel_id" in body:
        command["welcome_channel"] = body["system_welcome_channel_id"]
    return await rpc_request(request, command)


async def roles_resource(request):
    group_id = request.match_info["group_id"]
    if request.method == "GET":
        return await rpc_request(request, {"t": "community_get", "community": group_id})
    body = await request.json() if request.method in ("POST", "PUT", "PATCH", "DELETE") else {}
    if request.method == "PATCH" and isinstance(body.get("positions"), list):
        return await rpc_request(request, {"t": "community_roles_reorder", "community": group_id, "roles": body["positions"]})
    if request.method == "POST":
        command = {"t": "community_role_create", "community": group_id,
                   "name": body.get("name"), "color": body.get("color_hex", "#99aab5"),
                   "display_separately": body.get("hoist", False),
                   "permissions": body.get("permissions", {})}
    elif request.method in ("PUT", "PATCH"):
        command = {"t": "community_role_update", "community": group_id,
                   "role": body.get("id") or request.match_info.get("role_id")}
        for key in ("name", "color", "display_separately", "permissions"):
            if key in body:
                command[key] = body[key]
        if "color_hex" in body:
            command["color"] = body["color_hex"]
        if "hoist" in body:
            command["display_separately"] = body["hoist"]
    else:
        command = {"t": "community_role_delete", "community": group_id,
                   "role": body.get("id") or request.match_info.get("role_id")}
    return await rpc_request(request, command)


async def channel_resource(request):
    channel_id = request.match_info["channel_id"]
    body = await request.json()
    command = {"t": "community_channel_update", "channel": channel_id}
    if "community" in body:
        command["community"] = body["community"]
    for key in ("name", "topic", "slowmode"):
        if key in body:
            command[key] = body[key]
    if "slowmode_seconds" in body:
        command["slowmode"] = body["slowmode_seconds"]
    if "group_id" in body:
        command["community"] = body["group_id"]
    if "community_id" in body:
        command["community"] = body["community_id"]
    return await rpc_request(request, command)


async def override_resource(request):
    channel_id = request.match_info["channel_id"]
    body = await request.json()
    return await rpc_request(request, {
        "t": "community_override_update",
        "community": body.get("group_id"),
        "channel": channel_id,
        "role": body.get("target_id") if body.get("target_type", "role") == "role" else None,
        "member": body.get("target_id") if body.get("target_type") == "member" else None,
        "overrides": body.get("overrides", {}),
    })


async def invites_resource(request):
    group_id = request.match_info["group_id"]
    if request.method == "POST":
        body = await request.json()
        return await rpc_request(request, {
            "t": "community_invite_create",
            "community": group_id,
            "max_uses": body.get("max_uses", 0),
            "expires_in": body.get("expires_in", 0),
        })
    if request.method == "DELETE":
        code = request.match_info["code"]
        return await rpc_request(request, {"t": "community_invite_revoke", "community": group_id, "code": code})
    return await rpc_request(request, {"t": "community_get", "community": group_id})


async def bans_resource(request):
    group_id = request.match_info["group_id"]
    if request.method == "DELETE":
        body = await request.json()
        return await rpc_request(request, {
            "t": "community_unban", "community": group_id, "user": body.get("user_id"),
        })
    body = await request.json() if request.content_length else {}
    if request.method == "POST":
        return await rpc_request(request, {
            "t": "community_ban", "community": group_id,
            "user": body.get("user_id"), "reason": body.get("reason", ""),
        })
    return await rpc_request(request, {"t": "community_get", "community": group_id})


async def audit_resource(request):
    group_id = request.match_info["group_id"]
    action = request.rel_url.query.get("action", "")
    actor = request.rel_url.query.get("actor", "")
    try:
        page = int(request.rel_url.query.get("page", "1"))
        limit = int(request.rel_url.query.get("limit", "50"))
    except ValueError:
        page, limit = 1, 50
    return await rpc_request(request, {
        "t": "community_audit_get", "community": group_id,
        "action": action, "actor": actor, "page": page, "limit": limit,
    })


async def member_invites_resource(request):
    group_id = request.match_info["group_id"]
    if request.method == "POST":
        body = await request.json()
        return await rpc_request(request, {
            "t": "community_member_invite",
            "community": group_id,
            "identifier": body.get("identifier", body.get("email", body.get("username", ""))),
            "roles": body.get("roles", []),
        })
    if request.method == "DELETE":
        return await rpc_request(request, {
            "t": "community_member_invite_revoke",
            "community": group_id,
            "user": request.match_info["user_id"],
        })
    return web.json_response({"error": "Method not allowed"}, status=405)


async def member_roles_resource(request):
    group_id = request.match_info["group_id"]
    user_id = request.match_info["user_id"]
    if request.method == "DELETE":
        return await rpc_request(request, {
            "t": "community_kick", "community": group_id, "user": user_id,
        })
    body = await request.json()
    return await rpc_request(request, {
        "t": "community_member_roles",
        "community": group_id,
        "user": user_id,
        "roles": body.get("roles", []),
    })


def main():
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/static/emoji/{name}", emoji_file)
    app.router.add_get("/static/{tail:.*}", static_file)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/users/@me", get_me)
    app.router.add_put("/api/users/@me", put_me)
    app.router.add_patch("/api/users/@me", put_me)
    app.router.add_get("/api/users/@me/settings", get_me)
    app.router.add_put("/api/users/@me/settings", put_me)
    app.router.add_patch("/api/users/@me/settings", put_me)
    app.router.add_get("/api/users/@me/sessions", get_sessions)
    app.router.add_delete("/api/users/@me/sessions/{session_id}", revoke_session)
    app.router.add_get("/api/users/@me/relationships", relationships)
    app.router.add_post("/api/users/@me/relationships", relationships)
    app.router.add_patch("/api/users/@me/relationships", relationships)
    app.router.add_get("/api/groups/{group_id}", group_resource)
    app.router.add_put("/api/groups/{group_id}", group_resource)
    app.router.add_patch("/api/groups/{group_id}", group_resource)
    app.router.add_get("/api/groups/{group_id}/roles", roles_resource)
    app.router.add_post("/api/groups/{group_id}/roles", roles_resource)
    app.router.add_patch("/api/groups/{group_id}/roles", roles_resource)
    app.router.add_put("/api/groups/{group_id}/roles/{role_id}", roles_resource)
    app.router.add_patch("/api/groups/{group_id}/roles/{role_id}", roles_resource)
    app.router.add_delete("/api/groups/{group_id}/roles/{role_id}", roles_resource)
    app.router.add_patch("/api/channels/{channel_id}", channel_resource)
    app.router.add_put("/api/channels/{channel_id}", channel_resource)
    app.router.add_put("/api/channels/{channel_id}/overrides", override_resource)
    app.router.add_get("/api/groups/{group_id}/invites", invites_resource)
    app.router.add_post("/api/groups/{group_id}/invites", invites_resource)
    app.router.add_delete("/api/groups/{group_id}/invites/{code}", invites_resource)
    app.router.add_get("/api/groups/{group_id}/bans", bans_resource)
    app.router.add_post("/api/groups/{group_id}/bans", bans_resource)
    app.router.add_delete("/api/groups/{group_id}/bans", bans_resource)
    app.router.add_get("/api/groups/{group_id}/audit-logs", audit_resource)
    app.router.add_post("/api/groups/{group_id}/members/invites", member_invites_resource)
    app.router.add_delete("/api/groups/{group_id}/members/invites/{user_id}", member_invites_resource)
    app.router.add_patch("/api/groups/{group_id}/members/{user_id}/roles", member_roles_resource)
    app.router.add_delete("/api/groups/{group_id}/members/{user_id}", member_roles_resource)
    web.run_app(
        app,
        host=os.environ.get("PYCHAT_HTTP_HOST", "127.0.0.1"),
        port=int(os.environ.get("PYCHAT_HTTP_PORT") or os.environ.get("PORT") or "8080"),
    )


if __name__ == "__main__":
    main()

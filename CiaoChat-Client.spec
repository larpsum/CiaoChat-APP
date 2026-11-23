# -*- mode: python ; coding: utf-8 -*-

# Thin-client build: ships ONLY the web UI (static/). No server.py,
# no ws_bridge.py, no Firebase service account — the app connects to
# the hosted backend via CIAOCHAT_SERVER / static/config.js.

a = Analysis(
    ["client_launcher.py"],
    pathex=[],
    binaries=[],
    datas=[("static", "static")],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["firebase_admin", "aiohttp", "server", "ws_bridge", "client"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="CiaoChat",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

#!/usr/bin/env python3
"""Decimate the Poly Haven tree scans into web-sized GLBs."""

from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
TREES = ROOT / "static" / "assets" / "field-survey" / "trees"
TARGET_FACES = 14000


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def main():
    for asset_dir in sorted(TREES.iterdir()):
        if not asset_dir.is_dir():
            continue
        gltf = next(asset_dir.glob("*.gltf"), None)
        if gltf is None:
            continue
        clear_scene()
        bpy.ops.import_scene.gltf(filepath=str(gltf))
        meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        total = sum(len(o.data.polygons) for o in meshes)
        print(f"{asset_dir.name}: {len(meshes)} meshes, {total} faces")
        if total == 0:
            continue
        ratio = max(0.002, min(1.0, TARGET_FACES / total))
        for obj in meshes:
            mod = obj.modifiers.new("Web decimate", "DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = ratio
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.modifier_apply(modifier=mod.name)
            obj.select_set(False)
        out = asset_dir / f"{asset_dir.name}.glb"
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.export_scene.gltf(
            filepath=str(out),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
        )
        print(f"  -> {out.name}: {out.stat().st_size / 1024 / 1024:.1f} MiB")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Re-export the field-survey GLBs without Draco mesh compression.

The web viewer uses the plain three.js GLTFLoader (no DRACOLoader), so the
GLBs must be stored uncompressed.
"""

import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "static" / "assets" / "field-survey"


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                  bpy.data.cameras, bpy.data.lights):
        pass


def export_selected(filepath):
    bpy.ops.object.select_all(action="DESELECT")
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" or obj.type == "FONT" or obj.type == "CURVE"]
    if not objects:
        # fall back to every object in the scene
        objects = list(bpy.context.scene.objects)
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    result = bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"export failed for {filepath}")


def main():
    for glb in sorted(ASSETS.glob("*.glb")):
        clear_scene()
        bpy.ops.import_scene.gltf(filepath=str(glb))
        export_selected(glb)
        print(f"repacked {glb.name}")


if __name__ == "__main__":
    main()

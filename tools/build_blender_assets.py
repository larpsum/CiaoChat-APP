#!/usr/bin/env python3
"""Build the field-survey GLB assets from Blender and CC0 Poly Haven sources."""

import json
import math
import random
import struct
import tempfile
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "static" / "assets" / "field-survey"
USER_AGENT = "CiaoChat-FieldSurvey-AssetBuilder/1.0"
POLYHAVEN_API = "https://api.polyhaven.com"


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def download(url, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size:
        return destination
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        destination.write_bytes(response.read())
    return destination


def polyhaven_download(asset_id, format_name, resolution, variant, source_root):
    metadata = fetch_json(f"{POLYHAVEN_API}/files/{asset_id}")
    entry = metadata[format_name][resolution][variant]
    source_directory = source_root / asset_id
    main_name = Path(urllib.parse.unquote(urllib.parse.urlparse(entry["url"]).path)).name
    main_path = source_directory / main_name
    download(entry["url"], main_path)
    for relative_path, included in entry.get("include", {}).items():
        download(included["url"], source_directory / relative_path)
    return main_path


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)


def collect_imported_objects(filepath):
    before = set(bpy.data.objects)
    result = bpy.ops.import_scene.gltf(filepath=str(filepath))
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender could not import {filepath.name}.")
    return list(set(bpy.data.objects) - before)


def collection_for(name):
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def move_to_collection(objects, collection):
    for obj in objects:
        for owner in list(obj.users_collection):
            owner.objects.unlink(obj)
        collection.objects.link(obj)


def deselect_all():
    bpy.ops.object.select_all(action="DESELECT")


def export_glb(filepath, objects):
    if not objects:
        raise RuntimeError(f"No objects selected for {filepath.name}.")
    deselect_all()
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    result = bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_color_quantization=8,
        export_draco_generic_quantization=12,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender could not export {filepath.name}.")
    deselect_all()


def png_chunk(chunk_type, data):
    return (
        struct.pack(">I", len(data))
        + chunk_type
        + data
        + struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF)
    )


def write_rgb_png(path, width, height, rows):
    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    content = b"\x89PNG\r\n\x1a\n"
    content += png_chunk(b"IHDR", header)
    content += png_chunk(b"IDAT", zlib.compress(raw, 7))
    content += png_chunk(b"IEND", b"")
    path.write_bytes(content)


def create_note_maps(directory):
    directory.mkdir(parents=True, exist_ok=True)
    width, height = 1024, 512
    rng = random.Random(61)
    color_rows = []
    rough_rows = []
    for py in range(height):
        v = py / (height - 1)
        color = bytearray()
        rough = bytearray()
        for px in range(width):
            u = px / (width - 1)
            border = min(u, 1 - u, v, 1 - v)
            edge_ink = 1.0 if border < 0.025 else 0.0
            rosette = abs(math.sqrt(((u - 0.5) / 0.235) ** 2 + ((v - 0.5) / 0.39) ** 2) - 1)
            rosette_ink = 1.0 if rosette < 0.008 or (rosette < 0.024 and int(rosette * 1400) % 4 == 0) else 0.0
            engraving = math.sin(u * 580 + math.sin(v * 48) * 5.2)
            engraving_ink = 1.0 if abs(engraving) < 0.035 else 0.0
            grain = rng.random() - 0.5
            ink = max(edge_ink, rosette_ink * 0.84, engraving_ink * 0.3)
            luminance = 1 + grain * 0.09 + ink * 0.22
            color.extend((
                max(0, min(255, int((73 + 22 * math.sin(v * math.pi) + 8 * grain) * luminance))),
                max(0, min(255, int((103 + 26 * math.sin(u * math.pi) + 9 * grain) * luminance))),
                max(0, min(255, int((65 + 14 * math.sin(v * 3.14159) + 7 * grain) * luminance))),
            ))
            roughness = 190 + int((rng.random() - 0.5) * 22)
            rough.extend((max(0, min(255, roughness)),) * 3)
        color_rows.append(color)
        rough_rows.append(rough)

    color_path = directory / "ciao_credit_base.png"
    roughness_path = directory / "ciao_credit_roughness.png"
    write_rgb_png(color_path, width, height, color_rows)
    write_rgb_png(roughness_path, width, height, rough_rows)

    normal_width, normal_height = 512, 256
    heights = []
    for py in range(normal_height):
        v = py / normal_height
        row = []
        for px in range(normal_width):
            u = px / normal_width
            fiber = math.sin(u * 1260 + math.sin(v * 390) * 1.7)
            noise = rng.random() - 0.5
            row.append(0.5 + fiber * 0.025 + noise * 0.012)
        heights.append(row)

    normal_rows = []
    for py in range(normal_height):
        row = bytearray()
        for px in range(normal_width):
            left = heights[py][max(0, px - 1)]
            right = heights[py][min(normal_width - 1, px + 1)]
            up = heights[max(0, py - 1)][px]
            down = heights[min(normal_height - 1, py + 1)][px]
            nx = -(right - left) * 8
            ny = -(down - up) * 8
            length = math.sqrt(nx * nx + ny * ny + 1)
            row.extend((
                max(0, min(255, int((nx / length * 0.5 + 0.5) * 255))),
                max(0, min(255, int((ny / length * 0.5 + 0.5) * 255))),
                max(0, min(255, int((1 / length * 0.5 + 0.5) * 255))),
            ))
        normal_rows.append(row)
    normal_path = directory / "ciao_credit_normal.png"
    write_rgb_png(normal_path, normal_width, normal_height, normal_rows)
    return color_path, roughness_path, normal_path


def load_image(filepath, non_color=False):
    image = bpy.data.images.load(str(filepath), check_existing=False)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    return image


def create_paper_material(directory):
    base_path, rough_path, normal_path = create_note_maps(directory)
    material = bpy.data.materials.new("CiaoChat | Engraved rag paper")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = 0.79
    shader.inputs["Metallic"].default_value = 0.0
    if "IOR" in shader.inputs:
        shader.inputs["IOR"].default_value = 1.46
    base = nodes.new("ShaderNodeTexImage")
    base.image = load_image(base_path)
    rough = nodes.new("ShaderNodeTexImage")
    rough.image = load_image(rough_path, non_color=True)
    normal = nodes.new("ShaderNodeTexImage")
    normal.image = load_image(normal_path, non_color=True)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.18
    links.new(base.outputs["Color"], shader.inputs["Base Color"])
    links.new(rough.outputs["Color"], shader.inputs["Roughness"])
    links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def create_ink_material():
    material = bpy.data.materials.new("CiaoChat | Intaglio ink")
    material.diffuse_color = (0.055, 0.12, 0.075, 1)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = material.diffuse_color
    shader.inputs["Roughness"].default_value = 0.86
    shader.inputs["Metallic"].default_value = 0.0
    return material


def note_surface(x, y):
    return (
        0.018 * math.sin((x + 1.6) * 8.5) * math.cos(y * 3.4)
        + 0.02 * math.exp(-((abs(x) - 1.43) / 0.11) ** 2) * math.cos(y * 5.0)
    )


def make_note_asset():
    width, height, x_segments, y_segments = 3.2, 1.8, 96, 48
    vertices = []
    faces = []
    for j in range(y_segments + 1):
        y = (j / y_segments - 0.5) * height
        for i in range(x_segments + 1):
            x = (i / x_segments - 0.5) * width
            vertices.append((x, y, note_surface(x, y)))
    stride = x_segments + 1
    for j in range(y_segments):
        for i in range(x_segments):
            a = j * stride + i
            faces.append((a, a + 1, a + stride + 1, a + stride))
    mesh = bpy.data.meshes.new("CiaoCredit | fine folded paper mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    note = bpy.data.objects.new("CiaoCredit | curved, solid banknote", mesh)
    bpy.context.scene.collection.objects.link(note)
    uv_layer = mesh.uv_layers.new(name="Banknote UV")
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop_index in polygon.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index
            i = vertex_index % stride
            j = vertex_index // stride
            uv_layer.data[loop_index].uv = (i / x_segments, j / y_segments)
    note.data.materials.append(create_paper_material(Path(bpy.app.tempdir) / "ciao-note-maps"))
    solidify = note.modifiers.new("Rag paper thickness", "SOLIDIFY")
    solidify.thickness = 0.012
    solidify.offset = 0.0
    bevel = note.modifiers.new("Soft worn edges", "BEVEL")
    bevel.width = 0.003
    bevel.segments = 2
    bpy.context.view_layer.objects.active = note
    note.select_set(True)
    bpy.ops.object.modifier_apply(modifier=solidify.name)
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    note.select_set(False)

    ink = create_ink_material()
    curves = bpy.data.curves.new("Intaglio | fine-line engraving", "CURVE")
    curves.dimensions = "3D"
    curves.resolution_u = 1
    curves.bevel_depth = 0.0014
    curves.bevel_resolution = 1

    def add_line(points, cyclic=False):
        spline = curves.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for point, (x, y) in zip(spline.points, points):
            point.co = (x, y, note_surface(x, y) + 0.004, 1)
        spline.use_cyclic_u = cyclic

    def rounded_rect(cx, cy, half_width, half_height, corner, segments=10):
        points = []
        for ox, oy, start in [
            (cx + half_width - corner, cy + half_height - corner, 0),
            (cx - half_width + corner, cy + half_height - corner, 90),
            (cx - half_width + corner, cy - half_height + corner, 180),
            (cx + half_width - corner, cy - half_height + corner, 270),
        ]:
            for step in range(segments + 1):
                angle = math.radians(start + step * 90 / segments)
                points.append((ox + math.cos(angle) * corner, oy + math.sin(angle) * corner))
        return points

    add_line(rounded_rect(0, 0, 1.49, 0.82, 0.09), cyclic=True)
    add_line(rounded_rect(0, 0, 1.45, 0.78, 0.08), cyclic=True)
    for radius_x, radius_y in ((0.5, 0.64), (0.44, 0.57), (0.36, 0.48), (0.29, 0.39)):
        add_line([
            (math.cos(step * math.tau / 144) * radius_x, math.sin(step * math.tau / 144) * radius_y)
            for step in range(144)
        ], cyclic=True)
    for side in (-1, 1):
        for row in range(15):
            y0 = -0.5 + row * 0.07
            points = []
            for step in range(46):
                t = step / 45
                x = side * (0.76 + t * 0.61)
                y = y0 + math.sin(t * math.tau * 2 + row * 0.37) * 0.018
                points.append((x, y))
            add_line(points)
        for ring in range(5):
            cx = side * 1.19
            cy = 0.0
            rx, ry = 0.16 + ring * 0.018, 0.34 + ring * 0.025
            add_line([
                (cx + math.cos(step * math.tau / 96) * rx, cy + math.sin(step * math.tau / 96) * ry)
                for step in range(96)
            ], cyclic=True)
    line_obj = bpy.data.objects.new("CiaoCredit | engraved guilloche", curves)
    bpy.context.scene.collection.objects.link(line_obj)
    line_obj.data.materials.append(ink)

    text_objects = []
    for body, size, x, y in (
        ("CIAOCHAT", 0.19, -1.32, 0.61),
        ("COMMUNITY CREDIT", 0.075, -1.31, 0.46),
        ("100", 0.22, 1.04, 0.59),
        ("C", 0.72, -0.18, -0.11),
        ("ONE HUNDRED", 0.13, -0.47, -0.48),
        ("SERIES 01  /  2026", 0.073, -0.62, -0.66),
    ):
        font = bpy.data.curves.new(f"Engraved type | {body}", "FONT")
        font.body = body
        font.size = size
        font.extrude = 0.0007
        font.bevel_depth = 0.0004
        obj = bpy.data.objects.new(f"Engraving | {body}", font)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = (x, y, note_surface(x, y) + 0.006)
        obj.data.materials.append(ink)
        text_objects.append(obj)
    deselect_all()
    for obj in text_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = text_objects[0]
    bpy.ops.object.convert(target="MESH")
    text_meshes = [obj for obj in bpy.context.selected_objects]
    deselect_all()
    return [note, line_obj, *text_meshes]


def farm_height(x, y):
    taper = min(1.0, max(0.0, (y + 35) / 42))
    furrow = math.sin((x + math.sin(y * 0.11) * 0.08) * math.tau / 2.4) * 0.17
    natural = math.sin(x * 0.31 + y * 0.17) * 0.045 + math.sin(x * 0.77 - y * 0.08) * 0.018
    return taper * (furrow + natural)


def make_farm_terrain(material):
    width, depth = 60.0, 76.0
    x_segments, y_segments = 160, 240
    vertices = []
    faces = []
    for j in range(y_segments + 1):
        y = -depth / 2 + depth * j / y_segments
        for i in range(x_segments + 1):
            x = -width / 2 + width * i / x_segments
            vertices.append((x, y, farm_height(x, y)))
    stride = x_segments + 1
    for j in range(y_segments):
        for i in range(x_segments):
            a = j * stride + i
            faces.append((a, a + 1, a + stride + 1, a + stride))
    mesh = bpy.data.meshes.new("Farm Furrows | 38k quad displaced terrain")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    terrain = bpy.data.objects.new("FarmTerrain | plowed, tessellated field", mesh)
    bpy.context.scene.collection.objects.link(terrain)
    uv_layer = mesh.uv_layers.new(name="Repeated Farm Furrows")
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop_index in polygon.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index
            i = vertex_index % stride
            j = vertex_index // stride
            uv_layer.data[loop_index].uv = (i / x_segments * 18, j / y_segments * 30)
    terrain.data.materials.append(material)
    return terrain


def create_glass_material():
    material = bpy.data.materials.new("Rain window | optical glass")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.88, 0.95, 0.9, 1)
    shader.inputs["Roughness"].default_value = 0.045
    shader.inputs["IOR"].default_value = 1.333
    for name in ("Transmission Weight", "Transmission"):
        if name in shader.inputs:
            shader.inputs[name].default_value = 0.96
            break
    shader.inputs["Coat Weight"].default_value = 0.18
    return material


def create_water_material():
    material = bpy.data.materials.new("Water | clear refractive droplets")
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (0.84, 0.93, 0.9, 1)
    shader.inputs["Roughness"].default_value = 0.025
    shader.inputs["IOR"].default_value = 1.333
    for name in ("Transmission Weight", "Transmission"):
        if name in shader.inputs:
            shader.inputs[name].default_value = 1.0
            break
    shader.inputs["Coat Weight"].default_value = 0.35
    return material


def make_window_asset():
    width, height, x_segments, y_segments = 16.0, 9.0, 48, 28
    vertices = []
    faces = []
    for j in range(y_segments + 1):
        y = (j / y_segments - 0.5) * height
        for i in range(x_segments + 1):
            x = (i / x_segments - 0.5) * width
            z = 0.012 * math.cos(x / width * math.pi) * math.cos(y / height * math.pi)
            vertices.append((x, y, z))
    stride = x_segments + 1
    for j in range(y_segments):
        for i in range(x_segments):
            a = j * stride + i
            faces.append((a, a + 1, a + stride + 1, a + stride))
    mesh = bpy.data.meshes.new("Curved optical window pane")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    pane = bpy.data.objects.new("GlassPane | curved and thin", mesh)
    bpy.context.scene.collection.objects.link(pane)
    pane.data.materials.append(create_glass_material())
    solidify = pane.modifiers.new("Real glass thickness", "SOLIDIFY")
    solidify.thickness = 0.022
    solidify.offset = 0.0
    bpy.context.view_layer.objects.active = pane
    pane.select_set(True)
    bpy.ops.object.modifier_apply(modifier=solidify.name)
    pane.select_set(False)
    for polygon in pane.data.polygons:
        polygon.use_smooth = True

    drop_vertices = []
    drop_faces = []
    rings, segments = 14, 32
    for ring in range(rings + 1):
        radius = ring / rings
        z = math.sqrt(max(0.0, 1 - radius * radius))
        for segment in range(segments):
            angle = segment * math.tau / segments
            drop_vertices.append((math.cos(angle) * radius, math.sin(angle) * radius, z))
    for ring in range(rings):
        for segment in range(segments):
            a = ring * segments + segment
            b = ring * segments + (segment + 1) % segments
            c = b + segments
            d = a + segments
            drop_faces.append((a, b, c, d))
    drop_mesh = bpy.data.meshes.new("Surface-tension water lens")
    drop_mesh.from_pydata(drop_vertices, [], drop_faces)
    drop_mesh.update()
    for polygon in drop_mesh.polygons:
        polygon.use_smooth = True
    water_material = create_water_material()
    drop_mesh.materials.append(water_material)

    rng = random.Random(90210)
    drops = []
    for index in range(56):
        obj = bpy.data.objects.new(f"WaterDrop_{index:03d}", drop_mesh)
        bpy.context.scene.collection.objects.link(obj)
        radius = rng.uniform(0.026, 0.11)
        obj.location = (
            rng.uniform(-7.65, 7.65),
            rng.uniform(-4.3, 4.3),
            0.035,
        )
        obj.scale = (
            radius * rng.uniform(0.7, 1.15),
            radius * rng.uniform(1.0, 2.25),
            radius * rng.uniform(0.16, 0.42),
        )
        drops.append(obj)
    return [pane, *drops]


def set_world_environment(hdri_path):
    world = bpy.data.worlds.new("Autumn field | CC0 HDR environment") if not bpy.data.worlds else bpy.data.worlds[0]
    bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    nodes.clear()
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = load_image(hdri_path)
    background = nodes.new("ShaderNodeBackground")
    output = nodes.new("ShaderNodeOutputWorld")
    world.node_tree.links.new(environment.outputs["Color"], background.inputs["Color"])
    world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])


def move_collection_to_source(collection):
    collection.hide_render = True
    collection.hide_viewport = True


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    clear_scene()
    bpy.context.scene.unit_settings.system = "METRIC"
    rng_root = Path(tempfile.mkdtemp(prefix="ciaochat-polyhaven-"))

    hdri_path = polyhaven_download("autumn_field", "hdri", "2k", "hdr", rng_root)
    furrow_path = polyhaven_download("farm_furrows", "gltf", "2k", "gltf", rng_root)
    plant_paths = {
        "grass_medium_02": polyhaven_download("grass_medium_02", "gltf", "1k", "gltf", rng_root),
        "grass_bermuda_01": polyhaven_download("grass_bermuda_01", "gltf", "1k", "gltf", rng_root),
        "nettle_plant": polyhaven_download("nettle_plant", "gltf", "1k", "gltf", rng_root),
    }

    furrow_objects = collect_imported_objects(furrow_path)
    furrow_mesh = next((obj for obj in furrow_objects if obj.type == "MESH"), None)
    if furrow_mesh is None or not furrow_mesh.data.materials:
        raise RuntimeError("The CC0 Farm Furrows asset did not contain a PBR material.")
    soil_material = furrow_mesh.data.materials[0]
    for obj in furrow_objects:
        bpy.data.objects.remove(obj, do_unlink=True)

    source_collection = collection_for("CC0 | Poly Haven source plants")
    source_models = {}
    for asset_id, filepath in plant_paths.items():
        objects = collect_imported_objects(filepath)
        mesh_objects = [obj for obj in objects if obj.type == "MESH"]
        if not mesh_objects:
            raise RuntimeError(f"The CC0 plant asset {asset_id} contains no mesh.")
        move_to_collection(objects, source_collection)
        source_models[asset_id] = objects

    terrain = make_farm_terrain(soil_material)
    terrain_collection = collection_for("Farm | displaced terrain")
    move_to_collection([terrain], terrain_collection)
    export_glb(OUTPUT / "farm-terrain.glb", [terrain])

    for asset_id, objects in source_models.items():
        export_glb(OUTPUT / f"{asset_id.replace('_', '-')}.glb", objects)

    note_collection = collection_for("CiaoChat | engraved credit note")
    note_objects = make_note_asset()
    move_to_collection(note_objects, note_collection)
    export_glb(OUTPUT / "ciao-credit-note.glb", note_objects)

    window_collection = collection_for("Rain | optical glass and water")
    window_objects = make_window_asset()
    move_to_collection(window_objects, window_collection)
    export_glb(OUTPUT / "glass-window.glb", window_objects)

    shutil_path = OUTPUT / "autumn-field-2k.hdr"
    shutil_path.write_bytes(hdri_path.read_bytes())
    set_world_environment(shutil_path)

    source_collection.hide_render = True
    source_collection.hide_viewport = True
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 32
    bpy.context.scene.render.resolution_x = 1280
    bpy.context.scene.render.resolution_y = 720
    bpy.context.scene.view_settings.view_transform = "AgX"
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT / "ciaochat-field-survey.blend"))
    print("Blender asset pipeline complete:")
    for filepath in sorted(OUTPUT.glob("*")):
        if filepath.is_file():
            print(f"  {filepath.name}: {filepath.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()

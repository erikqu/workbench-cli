"""Read-only, background Blender renderer for Workbench's model preview tabs."""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


def arguments():
    parser = argparse.ArgumentParser()
    for name in ("input", "output", "camera"):
        parser.add_argument("--" + name, required=True)
    for name in ("width", "height"):
        parser.add_argument("--" + name, type=int, required=True)
    for name in ("azimuth", "elevation", "zoom"):
        parser.add_argument("--" + name, type=float, required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:])


def load_file(path):
    if os.path.splitext(path)[1].lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=path)


def scene_bounds():
    points = []
    graph = bpy.context.evaluated_depsgraph_get()
    for instance in graph.object_instances:
        obj = instance.object
        if obj.hide_render or obj.type not in {"MESH", "CURVE", "SURFACE", "FONT", "META", "VOLUME", "POINTCLOUD"}:
            continue
        for corner in obj.bound_box:
            point = instance.matrix_world @ Vector(corner)
            if all(math.isfinite(value) for value in point):
                points.append(point)
    if not points:
        raise ValueError("No visible geometry to preview in this file.")
    lower = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    upper = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    center = (lower + upper) / 2
    radius = max(max((point - center).length for point in points), 0.00001)
    return points, center, radius


def orbit_camera(scene, args, points, center, radius):
    azimuth = math.radians(args.azimuth)
    elevation = math.radians(args.elevation)
    direction = Vector((math.cos(azimuth) * math.cos(elevation),
                        math.sin(azimuth) * math.cos(elevation), math.sin(elevation)))
    data = bpy.data.cameras.new("Workbench preview camera")
    camera = bpy.data.objects.new("Workbench preview camera", data)
    scene.collection.objects.link(camera)
    camera.location = center + direction * radius * 4
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    data.type = "ORTHO"
    rotation = camera.rotation_euler.to_matrix()
    right = rotation @ Vector((1, 0, 0))
    up = rotation @ Vector((0, 1, 0))
    half_width = max(abs((point - center).dot(right)) for point in points)
    half_height = max(abs((point - center).dot(up)) for point in points)
    # Blender's ortho_scale spans the longer image axis, accounting for aspect.
    aspect = args.width / args.height
    data.ortho_scale = max(half_width * 2, half_height * 2 * aspect, radius * 0.1) * 1.2 / args.zoom
    if aspect < 1:
        data.ortho_scale /= aspect
    data.clip_start = max(radius / 1000, 0.000001)
    data.clip_end = radius * 100
    scene.camera = camera


def studio_lighting(scene, center, radius):
    for obj in list(scene.objects):
        if obj.type == "LIGHT":
            obj.hide_render = True
    world = bpy.data.worlds.new("Workbench preview world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.08, 0.09, 0.12, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5
    scene.world = world
    for index, (offset, strength, size) in enumerate([
        ((3, -4, 5), 1200, 4), ((-4, -1, 2), 700, 5), ((1, 4, 3), 1000, 3),
    ]):
        data = bpy.data.lights.new("Workbench preview light " + str(index), "AREA")
        data.energy = strength * radius * radius
        data.size = size * radius
        light = bpy.data.objects.new(data.name, data)
        scene.collection.objects.link(light)
        light.location = center + Vector(offset) * radius
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()


def main():
    args = arguments()
    load_file(args.input)
    scene = bpy.context.scene
    if args.camera == "scene":
        if not scene.camera:
            raise ValueError("This file has no saved scene camera. Switch to Orbit to preview it.")
    else:
        points, center, radius = scene_bounds()
        orbit_camera(scene, args, points, center, radius)
        studio_lighting(scene, center, radius)
    # CPU Cycles works on SSH-only hosts, with no GPU or display server.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 4
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    scene.render.use_border = False
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = args.output
    scene.render.film_transparent = False
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("WORKBENCH_MODEL_ERROR: " + str(error), file=sys.stderr, flush=True)
        raise

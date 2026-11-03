"""Create small material/transform fixtures for the read-only 3D preview tests."""
import os
import sys

import bpy
from mathutils import Vector


directory = sys.argv[sys.argv.index("--") + 1]
os.makedirs(directory, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metallic=0):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = 0.35
    return result


bpy.ops.mesh.primitive_monkey_add(location=(3, -2, 1))
monkey = bpy.context.object
monkey.scale = (1.1, 0.8, 1.2)
monkey.rotation_euler[2] = 0.25
monkey.data.materials.append(material("Orange ceramic", (0.85, 0.18, 0.035)))
modifier = monkey.modifiers.new("Smooth surface", "SUBSURF")
modifier.levels = modifier.render_levels = 1
for face in monkey.data.polygons:
    face.use_smooth = True

bpy.ops.mesh.primitive_torus_add(major_radius=1.7, minor_radius=0.18, location=(3, -2, 0.25))
torus = bpy.context.object
torus.data.materials.append(material("Teal ring", (0.04, 0.55, 0.48), 0.6))
for face in torus.data.polygons:
    face.use_smooth = True

bpy.ops.object.camera_add(location=(8, -10, 6))
camera = bpy.context.object
camera.rotation_euler = (Vector((3, -2, 1)) - camera.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = camera
bpy.ops.object.light_add(type="AREA", location=(3, -6, 7))
light = bpy.context.object
light.data.energy = 1800
light.data.size = 5
light.rotation_euler = (Vector((3, -2, 1)) - light.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(directory, "sample.blend"))
bpy.ops.object.select_all(action="DESELECT")
monkey.select_set(True)
torus.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(directory, "sample.glb"), export_format="GLB", use_selection=True)

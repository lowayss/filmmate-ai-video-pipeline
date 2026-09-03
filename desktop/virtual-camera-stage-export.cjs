const stage = require("./virtual-camera-stage-engine.js");

const SQRT_HALF = Math.SQRT1_2;
const BASIS_QUATERNION = {x:SQRT_HALF,y:0,z:0,w:SQRT_HALF};

function positionToBlender(value={}) {
  const p=stage.vec3(value);
  return {x:p.x,y:-p.z,z:p.y};
}
function sizeToBlender(value={}) {
  const s=stage.vec3(value,{x:1,y:1,z:1});
  return {x:Math.abs(s.x),y:Math.abs(s.z),z:Math.abs(s.y)};
}
function quaternionToBlender(value={}) {
  return stage.quatMultiply(BASIS_QUATERNION,stage.quat(value));
}
function pyString(value) { return JSON.stringify(String(value??"")); }
function n(value,digits=6) { const v=stage.finite(value); return Number(v.toFixed(digits)); }
function tuple3(v) { return `(${n(v.x)}, ${n(v.y)}, ${n(v.z)})`; }
function quatTuple(q) { return `(${n(q.w)}, ${n(q.x)}, ${n(q.y)}, ${n(q.z)})`; }
function lensFromFov(fovDeg,sensorWidth=36) { const fov=stage.clamp(fovDeg,15,140)*Math.PI/180; return sensorWidth/(2*Math.tan(fov/2)); }

function blenderScript(blockoutInput,pathInput,options={}) {
  const blockout=stage.normalizeScene(blockoutInput),path=pathInput&&typeof pathInput==="object"?pathInput:{};
  const samples=Array.isArray(path.samples)?path.samples:[];
  if(samples.length<2)throw new Error("blender_export_requires_camera_path");
  const fps=Math.max(1,Math.min(120,Math.trunc(stage.finite(options.fps,30))||30));
  const firstMs=stage.finite(samples[0].client_time_ms,0),frames=samples.map((sample,index)=>({sample,frame:1+Math.max(0,Math.round((stage.finite(sample.client_time_ms,firstMs)-firstMs)/1000*fps)),index}));
  let lastFrame=1; for(const row of frames)lastFrame=Math.max(lastFrame,row.frame);
  const lines=[];
  lines.push("# FilmMate Virtual Camera Stage V5 - Blender import script");
  lines.push("# Generated preview data. FilmMate canonical/HAP state is not modified.");
  lines.push("import bpy");
  lines.push("import math");
  lines.push("");
  lines.push("COLLECTION_NAME = 'FilmMate_VCAM'");
  lines.push("old = bpy.data.collections.get(COLLECTION_NAME)");
  lines.push("if old:");
  lines.push("    for obj in list(old.objects): bpy.data.objects.remove(obj, do_unlink=True)");
  lines.push("    bpy.data.collections.remove(old)");
  lines.push("coll = bpy.data.collections.new(COLLECTION_NAME)");
  lines.push("bpy.context.scene.collection.children.link(coll)");
  lines.push("");
  lines.push("def add_block(name, location, dimensions, kind):");
  lines.push("    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)");
  lines.push("    obj = bpy.context.active_object");
  lines.push("    obj.name = name");
  lines.push("    obj.dimensions = dimensions");
  lines.push("    obj['filmmate_type'] = kind");
  lines.push("    for c in list(obj.users_collection): c.objects.unlink(obj)");
  lines.push("    coll.objects.link(obj)");
  lines.push("    return obj");
  lines.push("");
  for(const object of blockout.objects){const p=positionToBlender(object.position),s=sizeToBlender(object.size);lines.push(`add_block(${pyString(object.label||object.id)}, ${tuple3(p)}, ${tuple3(s)}, ${pyString(object.type)})`);}
  lines.push("");
  lines.push("cam_data = bpy.data.cameras.new('FilmMate_VCAM_Camera')");
  lines.push("cam_obj = bpy.data.objects.new('FilmMate_VCAM_Camera', cam_data)");
  lines.push("coll.objects.link(cam_obj)");
  lines.push("bpy.context.scene.camera = cam_obj");
  lines.push("cam_obj.rotation_mode = 'QUATERNION'");
  lines.push(`cam_obj['filmmate_shot_id'] = ${pyString(path.shot_id||"C01")}`);
  lines.push(`cam_obj['filmmate_path_number'] = ${Math.max(1,Math.trunc(stage.finite(path.path_number,1)))}`);
  lines.push(`cam_obj['filmmate_metric'] = ${path.metric===true?"True":"False"}`);
  lines.push(`cam_obj['filmmate_units'] = ${pyString(path.units||"mixed-relative")}`);
  lines.push("");
  for(const {sample,frame} of frames){const p=positionToBlender(sample.camera?.position),q=quaternionToBlender(sample.camera?.quaternion),lens=lensFromFov(sample.camera?.fov_deg||50);lines.push(`cam_obj.location = ${tuple3(p)}`);lines.push(`cam_obj.rotation_quaternion = ${quatTuple(q)}`);lines.push(`cam_data.lens = ${n(lens,4)}`);lines.push(`cam_obj.keyframe_insert(data_path='location', frame=${frame})`);lines.push(`cam_obj.keyframe_insert(data_path='rotation_quaternion', frame=${frame})`);lines.push(`cam_data.keyframe_insert(data_path='lens', frame=${frame})`);}
  lines.push("");
  lines.push(`bpy.context.scene.render.fps = ${fps}`);
  lines.push("bpy.context.scene.frame_start = 1");
  lines.push(`bpy.context.scene.frame_end = ${lastFrame}`);
  lines.push("for action in bpy.data.actions:");
  lines.push("    for fcurve in action.fcurves:");
  lines.push("        for point in fcurve.keyframe_points: point.interpolation = 'LINEAR'");
  lines.push("bpy.context.scene.frame_set(1)");
  lines.push("print('FilmMate VCAM import complete:', cam_obj.name, bpy.context.scene.frame_end, 'frames')");
  return `${lines.join("\n")}\n`;
}

function interchangePayload(blockoutInput,pathInput,options={}) {
  const blockout=stage.normalizeScene(blockoutInput),path=pathInput&&typeof pathInput==="object"?pathInput:{};
  return {schema_version:1,source:"virtual-camera-stage-v5-export",preview:true,canonical:false,target:"blender",coordinate_conversion:{filmmate:"+X right, +Y up, camera forward -Z",blender:"+X right, +Z up, camera forward -Z",position:"(x, -z, y)",basis_rotation:"+90deg around X"},fps:Math.max(1,Math.min(120,Math.trunc(stage.finite(options.fps,30))||30)),blockout,path};
}

module.exports={BASIS_QUATERNION,positionToBlender,sizeToBlender,quaternionToBlender,lensFromFov,blenderScript,interchangePayload};

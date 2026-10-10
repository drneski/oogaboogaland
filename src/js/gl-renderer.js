// The WebGL2 renderer: instancing, frustum culling, a shadow map, MSAA, quality tiers and a pixel budget.
// The sky pass draws sun, moon, stars and painted clouds (`clouds` cover in the render options); cloud
// nodes (matrix mode 4) light as soft cartoon cumulus. The sea (`sea` height in the render options; the
// hub and the drop set it to -70) is a sky-pass plane with waves, Fresnel sky, sun glint, foam and horizon
// haze, tinted by the sky. Sun shafts are marched over the sky in the depth on high and medium.
//
// Up to `POINT_LIGHT_CAPACITY` (32) point lights; each tier draws its first 32/20/10. Wind bends any
// geometry with a `sway` strength by the square of local height, and rocks lanterns with `swing` (rock as a
// piece, phase running along the ground). Water and lava are face materials (`face.water = true` or
// `"lava"`, flagged to the shader through the normal's length): level water ripples, falls stream, both
// reflect the sky and glint; lava flows with glowing cracks. `face.lake` is transparent, with small wave
// normals and Fresnel reflection, paired with geometry.glass. Everything animates on the renderer's own clock.
//
// Block detail (seam, tone, grain) applies to every face on its geometry's `voxel` grid (`[unit, ox, oy,
// oz]`, set by `voxelGeometry`, `gridGeometry` and the dressing baker, checked per face at upload and
// flagged by a doubled normal); rock-sized voxels (a quarter metre and up) group into bevelled two-cell
// stones. The composite adds a sky rim, bloom at two radii and one display grade (shoulder, S curve,
// saturation, split tone, vignette, dither). canvas-renderer.js implements the same surface.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { mat4 } = BL.math;
  const { updateWorld, traverseVisible, boundsOf, matrixModeOf, hiddenFromCamera, hiddenFromCutaway } = BL.scene;
  // Scenes fill up to POINT_LIGHT_CAPACITY lights in priority order; each tier draws only its first `lights`.
  const POINT_LIGHT_CAPACITY = 32;
  const QUALITY = {
    high: { dpr: 1.5, msaa: 2, shadow: 2048, bloom: true, shafts: true, mirror: 1024, environment: 128, environmentCadence: 1, lights: 32 },
    medium: { dpr: 1.25, msaa: 2, shadow: 1024, bloom: true, shafts: true, mirror: 768, environment: 96, environmentCadence: 2, lights: 20 },
    low: { dpr: 1, msaa: 0, shadow: 512, bloom: false, shafts: false, mirror: 512, environment: 64, environmentCadence: 4, lights: 10 }
  };
  const INSTANCE_FLOATS = 20;
  const NO_OBJECT_CLIP = new Float32Array([0, 0, 0, -1]);
  const NO_OBJECT_SLAB = new Float32Array(4);
  const NO_SPOT_LIGHT = new Float32Array(12);
  // MAX_PIXELS caps the pixel ratio to bound buffer memory.
  const MAX_PIXELS = 2.6e6;
  const DEFAULT_LIGHT = { x: 0.45, y: 0.85, z: 0.3 };
  const DEFAULT_SKY = [0.50, 0.52, 0.58];
  const DEFAULT_GROUND = [0.22, 0.20, 0.19];
  const DEFAULT_SUN = [0.80, 0.74, 0.66];
  const DEFAULT_CLEAR = [0.035, 0.035, 0.04];
  const DEFAULT_SHADOW_CENTER = { x: 0, y: 1.5, z: 0 };
  const DEFAULT_MOON = { x: 0, y: -1, z: 0 };
  const DEFAULT_STAR_MATRIX = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const CULL_MARGIN = 1;
  // Frames a shadow caster must hold still before it bakes into the static shadow map; each demotion doubles a
  // record's wait up to 32 times this, so fidgeting crew parts stop costing a rebake every few seconds.
  const SHADOW_SETTLE = 30;
  const MIRROR_EPSILON = 1e-7;
  const UP = { x: 0, y: 1, z: 0 };
  const NORTH_UP = { x: 0, y: 0, z: -1 };
  const CUBE_VIEWS = new Float32Array([1, 0, 0, 0, -1, 0, -1, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, -1, 0]);
  const ZERO4 = new Float32Array([0, 0, 0, 1]);
  const NO_FOG = new Float32Array(3);
  const NO_MATRIX_CAVES = new Float32Array(32);
  const NO_MATRIX_PLANE = new Float32Array(4);
  const DEFAULT_MATRIX_APERTURE = new Float32Array([2.5, 3, 0.5, 0]);
  const NO_MIRROR_RIPPLES = new Float32Array(BL.mirrorRipples.CAPACITY * 4);
  const NO_MIRROR_BODY_WAVES = new Float32Array(BL.mirrorBody.CAPACITY * 4);
  const FOG_OFF = 1e8;
  const LIGHT_EYE = { x: 0, y: 0, z: 0 };
  const MESH_STRIDE = 10;
  const LINE_STRIDE = 12;
  const MATRIX_MASKS = new Int32Array([630678, 497559, 988959, 495513, 1009263, 288049, 456438, 616809]);
  // Projection-weighted rays stay parallel in orthographic views and retain
  // the eye-to-surface direction in perspective, including mirror captures.
  const VIEW_DIRECTION_GLSL = `
uniform vec3 uEye;
uniform vec4 uViewDirection;
vec3 viewTowardEye(vec3 p) {
  return uViewDirection.w * (uEye - p) + uViewDirection.xyz;
}`;
  // Portal modes 6 (circle) and 7 (DSB rectangle) share time, surge and reveal parameters.
  // Keep the wave equation in sync with oogaPortalModels.liquidHeight (Canvas).
  const PORTAL_LIQUID_GLSL = `
float portalDistance(vec2 p, float rectangular) {
  return mix(length(p), max(abs(p.x), abs(p.y)), rectangular);
}
float portalHeight(vec2 p, float time, float surge, float rectangular) {
  float envelope = max(0.0, 1.0 - mix(dot(p, p), max(p.x * p.x, p.y * p.y), rectangular));
  float a = length(p - vec2(0.22, -0.17)), b = length(p - vec2(-0.31, 0.24));
  return envelope * (0.016 * sin(a * 32.0 - time * 4.0) + 0.01 * sin(b * 25.0 - time * 3.0)
    + 0.008 * sin(p.x * 18.0 + p.y * 12.0 + time * 2.0) - surge * 0.32 * envelope);
}
`;
  // Race rigs keep their authored CPU joints and draw their core parts through one bounded mesh.
  const RIG_JOINTS = 9;
  const createRig = (nodes) => {
    if (!nodes.length || nodes.length > RIG_JOINTS) throw new Error("A mesh rig needs one to nine joints");
    // Keep special surfaces in their original draws; the core racer parts use ordinary colored faces.
    for (const node of nodes) {
      const g = node.geometry;
      if (!g || g.lines.length || g.mirrorSource || g.imageSurface || g.reflector || g.clipPlane || g.clipSlab || g.clipMinY !== undefined || g.clipMaxY !== undefined || g.sway || g.swing || g.glass || g.lakeBody || g.lakeWaves || g.lakeChargeRise || g.lightBeam || g.matrixGlyph || g.portalSurface || g.projective || g.cutawayHide || g.cutawayPreserve || g.matrixRevealBacking || g.matrixLocalGlyphSurface || g.glassOpacity || g.depthOffset) return null;
    }
    const rig = { nodes: nodes.slice(), sources: nodes.map(node => node.geometry), matrices: new Float32Array(RIG_JOINTS * 16), params: new Float32Array(RIG_JOINTS * 4), voxels: new Float32Array(RIG_JOINTS * 4), visibility: new Float32Array(RIG_JOINTS * 3) };
    for (const node of nodes) node.meshRigSource = rig;
    return { verts: [], faces: [], lines: [], meshRig: rig };
  };
  const RIG_GLSL = `
layout(location=8) in float aJoint;
uniform int uRigCount;
uniform int uRigPass;
uniform mat4 uRigMatrices[9];
uniform vec4 uRigParams[9];
uniform vec4 uRigVoxels[9];
uniform vec3 uRigVisibility[9];
mat4 rigMatrix(mat4 ordinary) {
  if (uRigCount == 0) return ordinary;
  int joint = int(aJoint);
  bool visible = uRigPass == 1 ? uRigVisibility[joint].x > 0.5 : uRigPass == 2 ? uRigVisibility[joint].y > 0.5 : uRigVisibility[joint].z > 0.5;
  mat4 m = uRigMatrices[joint];
  return visible ? m : mat4(vec4(0.0), vec4(0.0), vec4(0.0), m[3]);
}
`;
  const MESH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aColor;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
layout(location=7) in vec4 aParams;
${RIG_GLSL}
uniform vec4 uVoxel;
flat out vec4 vVoxel;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
${VIEW_DIRECTION_GLSL}
uniform float uWindTime;
uniform float uSway;
uniform float uSwing;
// pool-water.js sends at most 32 world-space wave packets: centre x/z, radius and height.
uniform int uLakeWaveCount;
uniform vec4 uLakeWaves[32];
uniform vec4 uLakeSurface;
uniform vec4 uLakeWaveEnd;
uniform vec4 uLakeSuction;
uniform vec4 uLakeFlowU;
uniform vec4 uLakeCharge;
uniform float uLakeChargeRise;
// Optional local water body: time, amplitude, stretch, pinch; bend x/z and shape kind.
uniform vec4 uLakeBodyShape;
uniform vec4 uLakeBodyBend;
out vec3 vNormal;
out vec4 vColor;
out vec4 vParams;
out vec4 vShadow;
out vec4 vWorldH;
out vec3 vInstanceFacing;
out vec2 vPortalUV;
out vec4 vPortalView;
${PORTAL_LIQUID_GLSL}
out vec3 vLocal;
out vec3 vLocalNormal;
out float vMatrixSurface;
flat out float vMatrixCave;
flat out float vMatrixPermanentFallback;
flat out float vSmokeOpacity;
// Keep this warp in step with pool-water.js sampleBody for the Canvas renderer.
vec3 lakeBodyWarp(vec3 p) {
  float time = uLakeBodyShape.x, amplitude = uLakeBodyShape.y;
  if (uLakeBodyBend.z > 0.5) {
    float t = clamp(-p.y, 0.0, 1.0), curve = sin(3.14159265359 * t);
    float waist = 1.0 - uLakeBodyShape.w * curve * curve, flutter = amplitude * curve;
    return vec3(p.x * waist + uLakeBodyBend.x * t + flutter * sin(time * 3.4 + t * 8.0), p.y,
      p.z * waist + uLakeBodyBend.y * t + flutter * cos(time * 3.1 - t * 7.0));
  }
  float stretch = uLakeBodyShape.z, k = inversesqrt(stretch);
  vec3 q = vec3(p.x * k, p.y * stretch, p.z * k);
  q.x += uLakeBodyBend.x * p.y * p.y + amplitude * sin(p.y * 5.2 + p.z * 3.1 + time * 3.4);
  q.y += amplitude * 0.55 * sin(p.x * 4.7 - p.z * 3.8 - time * 2.8);
  q.z += uLakeBodyBend.y * p.y * p.y + amplitude * sin(p.y * 4.4 - p.x * 3.6 - time * 3.1);
  return q;
}
void main() {
  mat4 m = rigMatrix(mat4(aM0, aM1, aM2, aM3));
  vec4 params = uRigCount > 0 ? uRigParams[int(aJoint)] : aParams;
  vVoxel = uRigCount > 0 ? uRigVoxels[int(aJoint)] : uVoxel;
  bool waterBody = uLakeBodyShape.z > 0.0;
  vec3 pos = waterBody ? lakeBodyWarp(aPos) : aPos;
  vPortalUV = aPos.xz;
  vPortalView = vec4(0.0);
  if (params.z > 5.5) pos.y += portalHeight(aPos.xz, params.x, params.y, step(6.5, params.z));
  vec4 w = m * vec4(pos, 1.0);
  if (params.z > 5.5) {
    vec3 toward = viewTowardEye(w.xyz);
    vPortalView = vec4(dot(toward, normalize(aM0.xyz)), dot(toward, normalize(aM1.xyz)),
      dot(toward, normalize(aM2.xyz)), max(0.001, length(aM0.xyz)));
  }
  // Wind: a geometry with sway bends from its foot, each copy on its own phase from where it stands.
  if (uSway > 0.0) {
    float ph = uWindTime * 1.9 + m[3].x * 0.37 + m[3].z * 0.29;
    w.xz += vec2(0.8, 0.6) * (sin(ph) + 0.35 * sin(ph * 2.3 + 1.7)) * uSway * max(aPos.y, 0.0) * max(aPos.y, 0.0);
  }
  // Swing: lanterns and bulbs on a cable rock in the wind. The phase runs smoothly along the ground, so one
  // lantern moves as a piece while its neighbours a metre off rock out of step with it, like a gust passing.
  if (uSwing > 0.0) {
    float ph = w.x * 0.8 + w.z * 0.6;
    float swing = sin(uWindTime * 1.7 + ph) * 0.045 + sin(uWindTime * 3.3 + ph * 2.1) * 0.012;
    w.x += swing * uSwing;
    w.z += swing * uSwing * 0.55;
    w.y += abs(swing) * uSwing * 0.15;
  }
  vNormal = normalize(mat3(m) * aNormal);
  if (waterBody) {
    // Differentiate along the surface, then account for the model's nonuniform stretch.
    // The original normal still carries the material marker into the fragment shader.
    vec3 n = normalize(aNormal);
    vec3 tangent = normalize(cross(abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n));
    vec3 bitangent = cross(n, tangent);
    vec3 du = lakeBodyWarp(aPos + tangent * 0.002) - lakeBodyWarp(aPos - tangent * 0.002);
    vec3 dv = lakeBodyWarp(aPos + bitangent * 0.002) - lakeBodyWarp(aPos - bitangent * 0.002);
    vec3 warped = cross(du, dv);
    if (dot(warped, warped) > 1e-16) n = normalize(warped);
    vec3 cx = cross(aM1.xyz, aM2.xyz), cy = cross(aM2.xyz, aM0.xyz), cz = cross(aM0.xyz, aM1.xyz);
    float handedness = dot(aM0.xyz, cx) < 0.0 ? -1.0 : 1.0;
    vNormal = normalize(cx * n.x + cy * n.y + cz * n.z) * handedness;
  }
  if ((uLakeWaveCount > 0 || uLakeSurface.z > 0.0) && dot(aNormal, aNormal) > 30.0 && dot(aNormal, aNormal) < 42.0) {
    vec2 radial = w.xz - uLakeSurface.xy;
    float radialLength = length(radial), edge = clamp((uLakeSurface.z - radialLength) / 0.8, 0.0, 1.0);
    float envelope = edge * edge * (3.0 - 2.0 * edge);
    float a = w.x * 0.9 + w.z * 0.5 - uLakeSurface.w * 1.15;
    float b = -w.x * 0.6 + w.z * 1.3 - uLakeSurface.w * 1.7;
    float swell = 0.028 * sin(a) + 0.014 * sin(b);
    float height = swell * envelope;
    vec2 slope = vec2(0.0252 * cos(a) - 0.0084 * cos(b), 0.014 * cos(a) + 0.0182 * cos(b)) * envelope;
    slope -= swell * radial * (6.0 * edge * (1.0 - edge) / 0.8 / max(radialLength, 0.0001));
    for (int i = 0; i < 32; i++) {
      if (i >= uLakeWaveCount) break;
      vec4 wave = uLakeWaves[i];
      vec2 delta = w.xz - wave.xy;
      float r = length(delta), q = (r - wave.z) / 0.32;
      if (abs(q) >= 1.0) continue;
      float e = 1.0 - q * q, c = cos(3.14159265359 * q);
      height += wave.w * c * e * e;
      slope += delta * (wave.w * (-3.14159265359 * sin(3.14159265359 * q) * e * e - 4.0 * q * c * e) / 0.32 / max(r, 0.0001));
    }
    // Smoothly limit overlapping impacts, including their derivative, to an 18 cm displacement.
    float limit = 1.0 + abs(height) / 0.18;
    height /= limit;
    slope /= limit * limit;
    float endT = clamp(dot(uLakeWaveEnd, w), 0.0, 1.0), fade = endT * endT * (3.0 - 2.0 * endT);
    slope = slope * fade + uLakeWaveEnd.xz * (6.0 * endT * (1.0 - endT) * height);
    height *= fade;
    if (uLakeSuction.w > 0.0) {
      vec2 delta = w.xz - uLakeSuction.xy;
      float r = length(delta), q = clamp(1.0 - r / uLakeSuction.z, 0.0, 1.0);
      height -= uLakeSuction.w * q * q * (3.0 - 2.0 * q);
      slope += delta * (uLakeSuction.w * 6.0 * q * (1.0 - q) / uLakeSuction.z / max(r, 0.0001));
    }
    w.y += height;
    vNormal = normalize(vec3(-slope.x, 1.0, -slope.y)) * sign(aNormal.y);
  }
  if (uLakeChargeRise > 0.0 && uLakeCharge.y > 0.0) {
    vec2 delta = w.xz - uLakeFlowU.xy;
    float distanceAlong = abs(mod(atan(delta.x, delta.y) - uLakeFlowU.z + 6.28318530718, 6.28318530718) * uLakeFlowU.w);
    if (uLakeCharge.z > 2.5) distanceAlong = min(distanceAlong, max(0.0, uLakeCharge.w - distanceAlong));
    float lit = 1.0 - smoothstep(uLakeCharge.x - 0.45, uLakeCharge.x + 0.15, distanceAlong);
    w.y += uLakeChargeRise * uLakeCharge.y * lit;
  }
  vColor = aColor;
  vColor.rgb *= 1.0 - clamp(-params.y, 0.0, 1.0) * 0.88;
  float encoded = max(0.0, -aColor.a - 1.0);
  // Sloping HQ floors keep cave-wave ownership, but their glyphs span the
  // mesh's tiny triangle seams through the same material as the deeper ramp.
  vMatrixPermanentFallback = step(64.0, encoded);
  encoded -= vMatrixPermanentFallback * 64.0;
  float worldSurface = step(32.0, encoded);
  encoded -= worldSurface * 32.0;
  vMatrixSurface = aColor.a < 0.0 ? (1.0 - worldSurface) * (1.0 - vMatrixPermanentFallback) : 0.0;
  vMatrixCave = floor(encoded * 0.5);
  vColor.a = aColor.a < 0.0 ? encoded - vMatrixCave * 2.0 : aColor.a;
  vParams = params;
  vParams.y = max(0.0, params.y);
  vSmokeOpacity = params.z < 0.0 ? -params.z - 1.0 : 1.0;
  vParams.z = max(0.0, params.z);
  vShadow = uLightViewProj * w;
  vWorldH = w;
  vLocal = aPos;
  // Smooth body normals may oppose across a cap; interpolation must not change their material.
  vLocalNormal = waterBody ? vec3(0.0, 6.0, 0.0) : aNormal;
  vInstanceFacing = uRigCount > 0 ? normalize(uRigMatrices[int(aJoint)][2].xyz) : normalize(aM2.xyz);
  gl_Position = uViewProj * w;
  if (params.w != 0.0 && params.z < 5.5) {
    vec3 facing = normalize(aM2.xyz) * sign(params.w);
    if (dot(facing, viewTowardEye(aM3.xyz)) <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
}`;
  // A small set of oriented cave apertures leaves the surrounding hills intact.
  // Underground the same predicate uses a world-height slice across all islands.
  const CUTAWAY_GLSL = `
uniform int uCutCount;
uniform vec4 uCutRegions[8];
uniform vec4 uCutBounds[8];
uniform float uCutawayOpacity;
float cutawayRank() {
  ivec2 pixel = ivec2(gl_FragCoord.xy) & 3;
  int rank = ((pixel.x & 1) ^ (pixel.y & 1)) * 8 + (pixel.y & 1) * 4
    + (((pixel.x >> 1) & 1) ^ ((pixel.y >> 1) & 1)) * 2 + ((pixel.y >> 1) & 1);
  return (float(rank) + 0.5) / 16.0;
}
bool cutaway(vec3 p, float opacity) {
  // Ordered coverage shares one fade across colour, depth and shadows,
  // without sorting transparent clouds or changing their shared instances.
  opacity *= uCutawayOpacity;
  if (opacity < 1.0 && cutawayRank() >= opacity) return true;
  if (p.y > uClipMaxY) return true;
  for (int i = 0; i < 8; i++) {
    if (i >= uCutCount) break;
    vec4 r = uCutRegions[i], b = uCutBounds[i];
    vec2 d = p.xz - r.xy;
    vec2 local = vec2(d.x * r.z - d.y * r.w, d.x * r.w + d.y * r.z);
    if (p.y > b.z && abs(local.x) < b.x && abs(local.y) < b.y && cutawayRank() < b.w) return true;
  }
  return false;
}
bool cutaway(vec3 p) {
  return cutaway(p, 1.0);
}`;
  const MESH_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DShadow;
in vec3 vNormal;
in vec4 vColor;
in vec4 vParams;
in vec4 vShadow;
// A projective geometry's matrices carry a last row, so its world position arrives homogeneous; main divides
// it out under uProjective alone, and every affine draw keeps the position it always had.
in vec4 vWorldH;
uniform float uProjective;
vec3 vWorld;
in vec3 vInstanceFacing;
in vec2 vPortalUV;
in vec4 vPortalView;
${PORTAL_LIQUID_GLSL}
in vec3 vLocal;
in vec3 vLocalNormal;
in float vMatrixSurface;
flat in float vMatrixCave;
flat in float vMatrixPermanentFallback;
flat in float vSmokeOpacity;
uniform vec3 uLightDir;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSun;
uniform float uDirectStrength;
uniform float uAmbientFloor;
uniform float uDiffuseFloor;
uniform float uShadowStrength;
uniform float uShadowFloor;
uniform float uShadowBias;
uniform sampler2DShadow uShadow;
uniform float uShadowTexel;
uniform vec4 uLights[64];
uniform int uLightCount;
uniform vec4 uSpotLight[3];
${VIEW_DIRECTION_GLSL}
uniform vec3 uFog;
uniform vec2 uFogRange;
uniform vec4 uMatrixParams;
uniform vec3 uMatrixOrigin;
uniform float uMatrixGlyph;
// Glass: below 1, a geometry drawn in the glass pass is that see-through, and thicker toward its silhouette.
uniform float uGlass;
uniform float uLakeFlowEnabled;
uniform vec4 uLakeFlowU;
uniform vec4 uLakeFlowV;
uniform vec4 uLakeCharge;
uniform vec2 uLakeChargeCenter;
uniform vec4 uLakeOcclude;
uniform float uLightBeam;
uniform float uMatrixCave;
uniform vec4 uMatrixCaves[8];
uniform vec4 uMatrixCaveBounds[8];
uniform float uMatrixCaveNear;
uniform float uMatrixPermanentCave;
uniform vec4 uMatrixPermanentPlane;
uniform vec4 uMatrixPermanentAperture;
uniform float uMatrixLivingGlobal;
uniform sampler2D uMatrixGlyphTex;
uniform int uMatrixSamples;
uniform float uClipMinY;
uniform float uClipMaxY;
uniform vec4 uObjectClip;
// A geometry's clipSlab (n, d) keeps |dot(n, p) + d| <= 1; zeros keep everything.
uniform vec4 uObjectSlab;
${CUTAWAY_GLSL}
uniform float uMatrixGlyphOpacity;
uniform float uGlassOpacity;
flat in vec4 vVoxel;
uniform float uWindTime;
#ifdef MATRIX_SAMPLE_INTERPOLATION
vec2 matrixSampleOffsets[4];
#endif
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oBright;
float matrixHash(int n) {
  uint x = uint(n);
  x ^= x >> 16;
  x *= 2146121005u;
  x ^= x >> 15;
  x *= 2221713035u;
  x ^= x >> 16;
  return float(x >> 8) / 16777216.0;
}
float matrixPixelCoverage(vec2 p, vec2 halfSize, vec2 footprint) {
#ifdef MATRIX_SAMPLE_INTERPOLATION
  if (uMatrixSamples > 1) {
    float covered = 0.0;
    for (int i = 0; i < 4; i++) {
      if (i >= uMatrixSamples) break;
      covered += all(lessThanEqual(abs(p + matrixSampleOffsets[i]), halfSize)) ? 1.0 : 0.0;
    }
    return covered / float(uMatrixSamples);
  }
#endif
  vec2 lo = max(p - footprint * 0.5, -halfSize);
  vec2 hi = min(p + footprint * 0.5, halfSize);
  vec2 covered = max(hi - lo, vec2(0.0)) / footprint;
  return covered.x * covered.y;
}
float matrixGlyphAt(vec3 n, float flow, out float glow, out float tip, out float palette, out float sideMix, out float sideShade) {
  const float streamPitch = 0.12;
  const float glyphGap = 0.13;
  const float pixelPitch = 0.021;
  const float pixelSize = 0.016;
  vec3 viewDir = normalize(viewTowardEye(vWorld));
  float viewNormal = max(abs(dot(viewDir, n)), 0.08);
  vec3 glyphWorld = vWorld + viewDir * (0.015 / viewNormal);
  vec3 rel = glyphWorld - uMatrixOrigin;
  flow = length(rel.xz);
  vec3 worldDx = dFdx(vWorld), worldDy = dFdy(vWorld);
  vec3 an = abs(n);
  float streamGrid;
  float localCross;
  float travelCoord;
  vec3 crossAxis;
  vec3 flowAxis;
  int stream;
  if (an.y >= an.x && an.y >= an.z) {
    vec2 radial = flow > 0.0001 ? rel.xz / flow : vec2(1.0, 0.0);
    crossAxis = vec3(-radial.y, 0.0, radial.x);
    flowAxis = vec3(radial.x, 0.0, radial.y);
    float angle = atan(rel.z, rel.x);
    float level = clamp(ceil(log2(max(flow, 0.75) / 0.75)), 0.0, 6.0);
    int rayCount = int(32.0 * exp2(level));
    float rayStep = 6.28318530718 / float(rayCount);
    int ray = int(floor((angle + 3.14159265359) / rayStep + 0.5));
    int wrappedRay = ray % rayCount;
    if (wrappedRay < 0) wrappedRay += rayCount;
    stream = wrappedRay * (2048 / rayCount);
    float centerAngle = float(ray) * rayStep - 3.14159265359;
    localCross = atan(sin(angle - centerAngle), cos(angle - centerAngle)) * flow;
    streamGrid = float(stream);
    travelCoord = flow;
  } else if (an.x >= an.z) {
    crossAxis = vec3(0.0, 0.0, -sign(n.x));
    flowAxis = vec3(0.0, 1.0, 0.0);
    streamGrid = glyphWorld.z / streamPitch;
    stream = int(floor(streamGrid));
    localCross = (fract(streamGrid) * streamPitch - streamPitch * 0.5) * -sign(n.x);
    travelCoord = -glyphWorld.y;
  } else {
    crossAxis = vec3(sign(n.z), 0.0, 0.0);
    flowAxis = vec3(0.0, 1.0, 0.0);
    streamGrid = glyphWorld.x / streamPitch;
    stream = int(floor(streamGrid));
    localCross = (fract(streamGrid) * streamPitch - streamPitch * 0.5) * sign(n.z);
    travelCoord = -glyphWorld.y;
  }
  int rank = int(floor(matrixHash(stream + 7) * 8.0));
  glow = tip = palette = sideMix = 0.0;
  sideShade = 1.0;
  if (float(rank) >= uMatrixParams.w * 8.0) return 0.0;
  float streamSeed = matrixHash(stream);
  float speed = 0.56 + matrixHash(stream + 19) * 0.64;
  int trainLength = 7 + int(floor(streamSeed * 6.0));
  int gapLength = 2 + int(floor(matrixHash(stream + 41) * 5.0));
  int sequence = trainLength + gapLength;
  float phase = matrixHash(stream + 73) * float(sequence) * glyphGap;
  float movingGrid = (travelCoord - uMatrixParams.z * speed - phase) / glyphGap;
  int flowCell = int(floor(movingGrid));
  int trainPosition = flowCell % sequence;
  if (trainPosition < 0) trainPosition += sequence;
  if (trainPosition >= trainLength) return 0.0;
  float trail = float(trainPosition + 1) / float(trainLength);
  glow = (0.58 + matrixHash(stream + 101) * 0.36) * (0.48 + trail * 0.52);
  tip = trainPosition == trainLength - 1 ? 1.0 : trainPosition == trainLength - 2 ? 0.55 : 0.0;
  vec2 local = vec2(localCross, fract(movingGrid) * glyphGap - glyphGap * 0.5);
  if (an.y < max(an.x, an.z)) local.y = -local.y;
  vec2 footprint = max(abs(vec2(dot(worldDx, crossAxis), dot(worldDx, flowAxis)))
    + abs(vec2(dot(worldDy, crossAxis), dot(worldDy, flowAxis))), vec2(0.00001));
#ifdef MATRIX_SAMPLE_INTERPOLATION
  for (int i = 0; i < 4; i++) {
    if (i >= uMatrixSamples) break;
    vec4 sampleWorld = interpolateAtSample(vWorldH, i);
    vec3 offset = (uProjective > 0.5 ? sampleWorld.xyz / sampleWorld.w : sampleWorld.xyz) - vWorld;
    matrixSampleOffsets[i] = vec2(dot(offset, crossAxis), dot(offset, flowAxis));
  }
#endif
  vec2 slope = vec2(dot(viewDir, crossAxis), dot(viewDir, flowAxis)) / viewNormal;
  vec2 middle = local;
  ivec2 nearest = ivec2(floor(vec2(middle.x / pixelPitch + 2.0, 3.0 - middle.y / pixelPitch)));
  int version = int(floor(uMatrixParams.z * 20.0));
  int glyph = (abs(stream * 73 + flowCell * 151) + version) & 7;
  palette = float(glyph & 1);
  float coverage = 0.0, frontCoverage = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 pixel = nearest + ivec2(dx, dy);
      if (pixel.x < 0 || pixel.x >= 4 || pixel.y < 0 || pixel.y >= 6) continue;
      float mask = texelFetch(uMatrixGlyphTex, ivec2(glyph * 6 + 1 + pixel.x, 5 - pixel.y), 0).r;
      if (mask == 0.0) continue;
      vec2 center = vec2((float(pixel.x) - 1.5) * pixelPitch, (2.5 - float(pixel.y)) * pixelPitch);
      coverage += matrixPixelCoverage(middle - center, vec2(pixelSize * 0.5) + abs(slope) * 0.005, footprint);
      frontCoverage += matrixPixelCoverage(local + slope * 0.005 - center, vec2(pixelSize * 0.5), footprint);
    }
  }
  coverage = min(coverage, 1.0);
  sideMix = clamp(1.0 - frontCoverage / max(coverage, 0.00001), 0.0, 1.0);
  vec3 sideNormal = abs(slope.x) >= abs(slope.y)
    ? crossAxis * (slope.x < 0.0 ? -1.0 : 1.0)
    : flowAxis * (slope.y < 0.0 ? -1.0 : 1.0);
  sideShade = 0.7 + max(dot(sideNormal, uLightDir), 0.0) * 0.22 + max(dot(sideNormal, viewDir), 0.0) * 0.08;
  return coverage;
}
float shadowAt(vec3 p, float bias) {
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float s = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      s += texture(uShadow, vec3(p.xy + vec2(float(x), float(y)) * uShadowTexel, p.z - bias));
    }
  }
  return s / 9.0;
}
vec3 lightFactorAt(vec3 n) {
  float lam = dot(n, uLightDir);
  float ndl = max(max(lam, 0.0), uDiffuseFloor);
  vec3 sp = (uProjective > 0.5 ? vShadow.xyz / vShadow.w : vShadow.xyz) * 0.5 + 0.5;
  float bias = max(uShadowBias * (1.0 - ndl), uShadowBias * 0.32);
  float sh = shadowAt(sp, bias);
  vec3 factor = max(mix(uGround, uSky, n.y * 0.5 + 0.5), vec3(uAmbientFloor));
  // Cartoon sun: part Lambert, part a soft two-tone ramp, so every side that sees the sun reads as one bright
  // coat of paint and the terminator rolls off rather than grading each face its own shade.
  float toon = max(mix(ndl, smoothstep(-0.05, 0.45, lam), 0.45), uDiffuseFloor);
  float lit = mix(1.0, max(sh, uShadowFloor), uShadowStrength);
  factor += uSun * toon * uDirectStrength * lit;
  // Painted shadows: what the sun misses takes a cool violet fill instead of only going dark.
  factor += vec3(0.05, 0.04, 0.11) * uDirectStrength * (1.0 - lit * toon);
  for (int i = 0; i < 32; i++) {
    if (i >= uLightCount) break;
    vec4 lp = uLights[i * 2];
    vec3 ld = lp.xyz - vWorld;
    float dist = length(ld);
    if (dist >= lp.w) continue;
    float a = clamp(1.0 - dist / lp.w, 0.0, 1.0);
    if (uLights[i * 2 + 1].a > 0.5) a = 0.72 * (1.0 - smoothstep(0.2, 1.0, dist / lp.w));
    else a *= a;
    factor += uLights[i * 2 + 1].rgb * a * max(dot(n, ld), 0.0) / max(dist, 0.0001);
  }
  if (uSpotLight[0].w > 0.0) {
    vec3 toSurface = vWorld - uSpotLight[0].xyz;
    float dist = length(toSurface);
    if (dist > 0.0001 && dist < uSpotLight[0].w) {
      vec3 direction = toSurface / dist;
      float cone = smoothstep(uSpotLight[1].w, uSpotLight[2].w, dot(direction, uSpotLight[1].xyz));
      float fade = 1.0 - dist / uSpotLight[0].w;
      float energy = cone * fade * fade / (1.0 + 0.005 * dist * dist);
      factor += uSpotLight[2].rgb * energy * max(dot(n, -direction), 0.0);
    }
  }
  return factor;
}
float cellHash(ivec3 c) {
  uint x = uint(c.x) * 73856093u ^ uint(c.y) * 19349663u ^ uint(c.z) * 83492791u;
  x ^= x >> 16;
  x *= 2146121005u;
  x ^= x >> 15;
  return float(x >> 8) / 16777216.0;
}
// Voxel geometry carries its grid (unit, origin) so merged runs still read as built blocks. Walls are coursed
// stone: a joint under every course and stone ends at a length each course draws for itself (one to three
// blocks), with a tone per stone; floors and roofs carry no joints at all, only a soft tone per block, so open
// ground never shows a grid. Every layer fades out before its cells shrink under a few pixels.
float voxelDetail() {
  // Faces on the grid carry a doubled normal (see buildMeshPart); water and lava carry longer ones.
  float nl = dot(vLocalNormal, vLocalNormal);
  if (vVoxel.x <= 0.0 || nl < 2.0 || nl > 6.0) return 1.0;
  vec3 ln = normalize(vLocalNormal);
  vec3 c = (vLocal - vVoxel.yzw) / vVoxel.x;
  vec3 an = abs(ln);
  vec3 block = floor(c - ln * 0.5);
  if (an.y > 0.5) {
    float px = max(fwidth(c.x), fwidth(c.z));
    ivec3 cell = ivec3(block);
    float tone = (cellHash(cell) - 0.5) * 0.045 * (1.0 - smoothstep(0.25, 0.9, px));
    ivec2 sub = ivec2(floor(fract(c.xz) * 4.0));
    float grain = (cellHash(cell * 5 + ivec3(sub, sub.x + sub.y * 4)) - 0.5) * 0.022 * (1.0 - smoothstep(0.04, 0.2, px));
    return 1.0 + tone + grain;
  }
  bool facesX = an.x > an.z;
  // Rock voxels (a quarter metre and up) are grouped four to a stone side, a metre a course, so cliffs read as
  // big pillowed blocks.
  float k = vVoxel.x >= 0.2 ? 4.0 : 1.0;
  float along = (facesX ? c.z : c.x) / k, up = c.y / k;
  int plane = int(facesX ? block.x : block.z) * 7 + (facesX ? 1 : 2);
  float px = max(fwidth(along), fwidth(up));
  int course = int(floor(up));
  float w = 1.0 + floor(cellHash(ivec3(course, plane, 11)) * 3.0);
  float a = (along + floor(cellHash(ivec3(course, plane, 23)) * 3.0)) / w;
  ivec3 stone = ivec3(int(floor(a)), course, plane);
  float tone = (cellHash(stone) - 0.5) * 0.08 * (1.0 - smoothstep(0.3, 1.0, px));
  ivec2 sub = ivec2(floor(fract(vec2(along, up)) * 4.0));
  float grain = (cellHash(ivec3(block) * 5 + ivec3(sub, sub.x + sub.y * 4)) - 0.5) * 0.025 * (1.0 - smoothstep(0.04, 0.2, px));
  // Some course joints are left out, so stones stand one or two courses tall and the face reads as rock.
  float fu = fract(up), fa = fract(a) * w;
  float below = cellHash(ivec3(course, plane, 31)) < 0.4 ? 9.0 : fu;
  float above = cellHash(ivec3(course + 1, plane, 31)) < 0.4 ? 9.0 : 1.0 - fu;
  float edge = min(min(below, above), min(fa, w - fa));
  float seam = (1.0 - smoothstep(0.04, 0.04 + px * 1.5, edge)) * (1.0 - smoothstep(0.05, 0.18, px));
  // Rock stones are pillowed: a lit top lip, a shaded underside and darker ends, rolling in over a wide band so
  // every block reads as rounded, cartoon stone.
  float bevel = 0.0;
  if (k > 1.5) {
    float lip = 1.0 - smoothstep(0.0, 0.3, above), under = 1.0 - smoothstep(0.0, 0.3, below), ends = 1.0 - smoothstep(0.0, 0.22, min(fa, w - fa));
    bevel = (lip * 0.14 - under * 0.15 - ends * 0.07) * (1.0 - smoothstep(0.08, 0.3, px));
  }
  // Seams belong to masonry: fine voxels (faces, hands, props, trim) keep only a whisper of one, so small
  // things read smooth and painted rather than gridded.
  return 1.0 + tone + grain + bevel - seam * 0.13 * clamp(vVoxel.x / 0.25, 0.15, 1.0);
}
float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Water: level faces ripple under two drifting noise fields, steep faces fall in streaks; both reflect the sky
// by Fresnel and glint in the sun, and the brightest crests reach the bloom.
vec3 waterShade(vec3 lit, vec3 n, out vec3 bright) {
  float t = uWindTime;
  bool fall = abs(n.y) < 0.6;
  vec2 q = fall ? vec2(dot(vWorld.xz, normalize(vec2(-n.z, n.x) + 1e-5)) * 2.2, vWorld.y * 0.9 + t * 3.2) : vWorld.xz * 0.45 + vec2(t * 0.06, t * 0.04);
  float a = vnoise(q), b = vnoise(q * 2.3 + vec2(5.2, 1.3) - t * 0.05);
  vec3 wn = fall ? n : normalize(vec3((a - 0.5) * 0.5, 1.0, (b - 0.5) * 0.5));
  vec3 v = normalize(uEye - vWorld), r = reflect(-v, wn);
  float fres = 0.12 + 0.88 * pow(1.0 - max(dot(v, wn), 0.0), 4.0);
  vec3 skyc = uSky * (0.9 + 0.5 * clamp(r.y, 0.0, 1.0)) + uSun * uDirectStrength * 0.15;
  vec3 col = mix(lit, skyc, fres * 0.65);
  float glint = pow(max(dot(r, uLightDir), 0.0), 120.0) * uDirectStrength;
  float foam = fall ? smoothstep(0.5, 0.85, vnoise(q * vec2(1.0, 0.25))) : smoothstep(0.72, 0.8, a * 0.6 + b * 0.4);
  col += uSun * glint * 2.0 + vec3(0.85, 0.95, 1.0) * foam * (fall ? 0.55 : 0.2);
  bright = uSun * glint * 1.2 + vec3(foam * (fall ? 0.15 : 0.05));
  return col;
}
${BL.dsbWater.shader}
// The pool uses the waterfall's luminous blue blocks and small square foam flecks.
// World-space cells continue across the lake/stream join; wave geometry still changes their lighting.
vec3 lakeShade(vec3 lit, out vec3 bright, out float alpha) {
  vec2 coord = uLakeFlowEnabled > 0.5 ? vec2(dot(uLakeFlowU, vec4(vWorld, 1.0)), dot(uLakeFlowV, vec4(vWorld, 1.0))) : vWorld.xz;
  if (uLakeFlowEnabled > 1.5) {
    vec2 delta = vWorld.xz - uLakeFlowU.xy;
    coord = vec2(length(delta), mod(atan(delta.x, delta.y) - uLakeFlowU.z + 6.28318530718, 6.28318530718) * uLakeFlowU.w);
  }
  vec2 flow = coord + vec2(0.12 * sin(coord.y * 0.35 + uWindTime * 0.4) - uWindTime * 0.08, -uWindTime * 0.3);
  ivec2 cell = ivec2(floor(flow / vec2(0.25, 0.75)));
  uint h = uint(cell.x) * 73856093u ^ uint(cell.y) * 19349663u;
  h = (h ^ (h >> 13)) * 1274126177u;
  uint band = h % 3u;
  vec3 color = band == 0u ? vec3(45.0, 125.0, 255.0) : band == 1u ? vec3(74.0, 166.0, 255.0) : vec3(124.0, 200.0, 255.0);
  bool foam = h % 13u == 0u && fract(flow.y / 0.75) < 0.33333333;
  if (foam) color = vec3(226.0, 245.0, 255.0);
  vec3 n = normalize(vNormal);
  if (n.y < 0.0) n = -n;
  float shade = 0.88 + 0.22 * max(dot(n, normalize(vec3(-0.4, 1.0, 0.3))), 0.0);
  float pulse = 0.96 + 0.08 * sin(coord.y * 1.04719755 - uWindTime * 3.14159265);
  float grain = 0.94 + 0.06 * sin(flow.x * 43.0) * sin(flow.y * 31.0);
  float sheen = pow(max(0.0, 0.5 + 0.5 * sin(flow.x * 6.0 + sin(flow.y * 4.0))), 12.0);
  vec3 col = color / 255.0 * shade * pulse * grain * max(0.35, vParams.x) * 1.08 + vec3(0.1, 0.16, 0.18) * sheen;
  bright = vec3(0.0);
  if (uLakeCharge.z > 0.5 && uLakeCharge.y > 0.0) {
    float distanceAlong = uLakeCharge.z < 1.5 ? distance(vWorld.xz, uLakeChargeCenter) : abs(coord.y);
    if (uLakeCharge.z > 2.5) distanceAlong = min(distanceAlong, max(0.0, uLakeCharge.w - distanceAlong));
    float lit = 1.0 - smoothstep(uLakeCharge.x - 0.45, uLakeCharge.x + 0.15, distanceAlong);
    float leading = 1.0 - smoothstep(0.0, 0.9, abs(distanceAlong - uLakeCharge.x));
    float charge = uLakeCharge.y * (lit * 0.7 + leading * 0.3);
    col += vec3(0.48, 0.76, 1.0) * charge * 0.65;
    bright += vec3(0.46, 0.72, 1.0) * charge * 0.8;
  }
  float grazing = 1.0 - abs(dot(n, normalize(viewTowardEye(vWorld))));
  alpha = min(0.95, uGlass + (foam ? 0.12 : 0.0) + grazing * grazing * 0.06);
  bright += col * (foam ? 0.25 : 0.12);
  return col;
}
// Lava: a dark crust drifting over a hot flow, its cracks glowing into the bloom.
// Roads (flagged five times over): painted dirt, soft sun-bleached patches at two scales and a scatter of
// darker and lighter cartoon pebble specks on a 9 cm lattice, all in world space so tiles never show a seam.
float roadDetail() {
  vec2 p = vWorld.xz;
  float bleach = vnoise(p * 0.35) * 0.6 + vnoise(p * 1.3 + 7.1) * 0.4;
  vec2 cell = floor(p / 0.09);
  float h = hash21(cell), speck = step(0.93, h) * (hash21(cell + 3.7) < 0.5 ? -0.16 : 0.1);
  vec2 f = fract(p / 0.09) - 0.5;
  speck *= 1.0 - smoothstep(0.22, 0.34, length(f));
  return 0.9 + bleach * 0.2 + speck;
}
vec3 lavaShade(out vec3 bright) {
  vec2 q = vWorld.xz * 0.35 + vec2(uWindTime * 0.05, uWindTime * 0.02);
  float n = vnoise(q) * 0.65 + vnoise(q * 2.7 - uWindTime * 0.08) * 0.35;
  float crack = 1.0 - smoothstep(0.03, 0.12, abs(n - 0.5));
  float pulse = 0.85 + 0.15 * sin(uWindTime * 2.0 + n * 12.0);
  vec3 hot = vec3(1.0, 0.42, 0.06) * pulse, crust = mix(vec3(0.16, 0.05, 0.03), vec3(0.45, 0.12, 0.03), n);
  vec3 col = mix(crust, hot * 1.4, max(crack, smoothstep(0.62, 0.78, n) * 0.6));
  bright = hot * max(crack, smoothstep(0.62, 0.78, n) * 0.5) * 0.9;
  return col;
}
vec3 matrixGlyphColor(vec3 base, float glow, float tip, float sideMix, float sideShade) {
  float emission = mix(0.78, 1.15, glow);
  vec3 front = base * emission;
  vec3 side = base * emission * sideShade;
  return mix(mix(front, side, sideMix), vec3(0.84, 1.0, 0.89), tip * 0.88);
}
float matrixTravel(vec2 point, float caveIndex) {
  if (caveIndex < 0.5) return length(point - uMatrixOrigin.xz);
  vec4 cave = uMatrixCaves[int(caveIndex) - 1];
  float depth = max(0.0, cave.z - dot(point, cave.xy));
  return length(point + cave.xy * depth - uMatrixOrigin.xz) + depth;
}
float matrixPermanentAt(vec3 point, float caveIndex) {
  if (uMatrixPermanentCave < 0.5 || abs(caveIndex - uMatrixPermanentCave) > 0.5) return 0.0;
  float depth = -dot(uMatrixPermanentPlane, vec4(point, 1.0));
  vec4 cave = uMatrixCaves[int(uMatrixPermanentCave) - 1], bounds = uMatrixCaveBounds[int(uMatrixPermanentCave) - 1];
  float across = dot(point.xz - bounds.xz, vec2(cave.y, -cave.x)), height = point.y - bounds.y;
  // The first half metre is the actual stone frame's opening. Its exterior
  // jambs and lintel never inherit the wider carved tunnel's material.
  // Rotated voxel carving expands each nominal box by half a voxel, and
  // its boundary faces reach another half voxel beyond the cell centres.
  vec4 aperture = uMatrixPermanentAperture;
  float voxelReach = aperture.w > 0.0 ? aperture.w : 0.5 * (abs(cave.x) + abs(cave.y));
  bool room = depth > aperture.z + 2.5 - voxelReach, throat = depth <= aperture.z;
  float halfWidth = throat ? aperture.x : aperture.x + (room ? 0.5 : 0.0) + voxelReach;
  float ceiling = aperture.y + (room && !throat ? 1.0 : 0.0);
  return depth >= -0.000001 && depth <= bounds.w + voxelReach && abs(across) <= halfWidth + 0.000001 && height >= -0.000001 && height <= ceiling + 0.000001 ? 1.0 : 0.0;
}
void main() {
  vWorld = uProjective > 0.5 ? vWorldH.xyz / vWorldH.w : vWorldH.xyz;
  if (vWorld.y < uClipMinY || dot(uObjectClip, vec4(vWorld, 1.0)) > 0.0 || abs(dot(uObjectSlab.xyz, vWorld) + uObjectSlab.w) > 1.0 || cutaway(vWorld, vSmokeOpacity)) discard;
  if (uLakeOcclude.w > 0.0 && uEye.y > uLakeOcclude.y && vWorld.y < uLakeOcclude.y) {
    vec3 towardEye = viewTowardEye(vWorld);
    if (towardEye.y > 0.0) {
      vec2 crossing = vWorld.xz + towardEye.xz * ((uLakeOcclude.y - vWorld.y) / towardEye.y);
      if (distance(crossing, uLakeOcclude.xz) < uLakeOcclude.w) discard;
    }
  }
  if (vParams.z > 5.5) {
    vec2 p = vPortalUV;
    float rectangular = step(6.5, vParams.z);
    float time = vParams.x, surge = vParams.y, radius = portalDistance(p, rectangular);
    if (radius > vParams.w) discard;
    float height = portalHeight(p, time, surge, rectangular);
    vec2 gradient = vec2(portalHeight(p + vec2(0.003, 0.0), time, surge, rectangular) - height,
      portalHeight(p + vec2(0.0, 0.003), time, surge, rectangular) - height) / (0.003 * vPortalView.w);
    vec3 normal = normalize(vec3(-gradient.x, 1.0, -gradient.y));
    vec3 eye = normalize(vPortalView.xyz);
    if (eye.y < 0.0) normal = -normal;
    float fresnel = pow(1.0 - abs(dot(normal, eye)), 3.0);
    // Interfering wave fronts and drifting caustic strands give the membrane
    // depth; narrow crests carry the pulses instead of painted solid rings.
    vec2 warp = p + 0.045 * vec2(sin(p.y * 9.0 + time), cos(p.x * 11.0 - time));
    float interference = sin(length(warp - vec2(0.22, -0.17)) * 32.0 - time * 4.0)
      + sin(length(warp + vec2(0.31, -0.24)) * 25.0 - time * 3.0);
    float caustic = pow(0.5 + 0.5 * sin(warp.x * 21.0 + sin(warp.y * 17.0 + time * 2.0) + time), 10.0);
    caustic *= 0.4 + 0.6 * pow(0.5 + 0.5 * cos(warp.y * 23.0 - warp.x * 9.0 - time), 3.0);
    float pulse = pow(0.5 + 0.5 * sin(radius * 20.0 - time * 2.0), 12.0);
    float crest = smoothstep(0.8, 1.9, interference);
    float rim = smoothstep(0.88, 1.0, radius);
    float glint = pow(max(0.0, dot(reflect(-normalize(vec3(-0.4, 1.0, 0.6)), normal), eye)), 40.0);
    vec3 liquid = mix(vec3(0.015, 0.055, 0.16), vec3(0.035, 0.32, 0.53), 0.48 + 0.22 * interference);
    liquid += vec3(0.13, 0.58, 0.72) * (crest * 0.36 + caustic * 0.62 + pulse * 0.18);
    liquid += vec3(0.42, 0.83, 0.95) * (glint * 0.65 + fresnel * 0.28 + rim * (0.25 + 0.1 * sin(time * 2.0)));
    liquid *= 1.0 + surge * 0.4;
    float fog = smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, uEye));
    oColor = vec4(mix(liquid, uFog, fog), 1.0);
    oBright = vec4(liquid * (0.2 + crest * 0.35 + caustic * 0.4 + rim * 0.2) * (1.0 - fog), 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 base = vColor.rgb;
  // Mode 5 keeps its own palette in the Matrix; clouds are mode 4.
  float nativeMode = step(4.5, vParams.z);
  float cloud = step(3.5, vParams.z) * (1.0 - nativeMode);
  float wholeLiving = step(1.5, vParams.z) * (1.0 - step(2.5, vParams.z));
  float emissiveLiving = step(2.5, vParams.z) * (1.0 - cloud) * (1.0 - nativeMode) * step(0.001, vColor.a);
  float living = max(wholeLiving, emissiveLiving);
  float caveIndex = max(vMatrixCave, uMatrixCave);
  float flow = uMatrixParams.x > 0.0 ? matrixTravel(vWorld.xz, caveIndex) : 0.0;
  if (cloud > 0.0) flow = min(flow, 36.0);
  // Moving occupants have no static face ownership. Terrain also fills its
  // voxel-labelled entrance gaps, bounded to the one permanent cave.
  bool permanentFallback = vMatrixPermanentFallback > 0.0 && uMatrixPermanentCave > 0.0;
  if ((uMatrixParams.x > 0.0 || uMatrixPermanentCave > 0.0) && (living > 0.0 || permanentFallback) && caveIndex < 0.5 && length(vWorld.xz - uMatrixOrigin.xz) > uMatrixCaveNear) {
    for (int i = 0; i < 8; i++) {
      if (living < 0.5 && abs(float(i + 1) - uMatrixPermanentCave) > 0.5) continue;
      vec4 cave = uMatrixCaves[i], bounds = uMatrixCaveBounds[i];
      float depth = cave.z - dot(vWorld.xz, cave.xy);
      float across = dot(vWorld.xz - bounds.xz, vec2(cave.y, -cave.x));
      float height = vWorld.y - bounds.y;
      bool room = depth > 3.0;
      bool permanentDepth = abs(float(i + 1) - uMatrixPermanentCave) < 0.5 && dot(uMatrixPermanentPlane.xyz, uMatrixPermanentPlane.xyz) > 0.0 && dot(uMatrixPermanentPlane, vec4(vWorld, 1.0)) <= 0.0;
      if ((depth >= 0.0 || permanentDepth) && depth <= bounds.w && abs(across) <= (room ? 3.35 : 2.7) && height >= 0.0 && height <= (room ? 4.15 : 3.15)) {
        caveIndex = float(i + 1);
        flow = matrixTravel(vWorld.xz, caveIndex);
        break;
      }
    }
  }
  if (living > 0.0 && caveIndex < 0.5) flow = min(flow, 36.0);
  float localSurface = max(vMatrixSurface, step(1.5, uMatrixGlyph));
  float permanent = matrixPermanentAt(vWorld, caveIndex);
  // A contact pixel may straddle the glass: its centre can be behind the
  // plane while uncovered MSAA samples still see the ordinary front floor.
  // Certify the whole static pixel footprint without moving the world plane.
  float permanentDepth = -dot(uMatrixPermanentPlane, vec4(vWorld, 1.0));
  float permanentFootprint = 0.5 * (abs(dFdx(permanentDepth)) + abs(dFdy(permanentDepth)));
  if (living < 0.5 && uMatrixGlyph < 0.5 && permanentDepth < permanentFootprint + 0.000001) permanent = 0.0;
  float front = max(permanent, mix(1.0, uMatrixLivingGlobal, living) * uMatrixParams.x * (1.0 - smoothstep(uMatrixParams.y - 1.5, uMatrixParams.y, flow))) * (1.0 - nativeMode);
  if (uMatrixGlyph > 2.5) {
    if (front <= 0.0) discard;
    float fog = smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, uEye));
    oColor = vec4(uFog * fog, front);
    oBright = vec4(0.0, 0.0, 0.0, front);
    return;
  }
  float ndl = max(max(dot(n, uLightDir), 0.0), uDiffuseFloor);
  float localGlyph = step(0.5, uMatrixGlyph) * (1.0 - step(1.5, uMatrixGlyph));
  if (localGlyph > 0.0) {
    float reveal = (caveIndex > 0.0 ? front : 1.0) * uMatrixGlyphOpacity;
    if (reveal <= 0.0) discard;
    float glow = clamp(vColor.a * vParams.x, 0.0, 1.0);
    float tip = clamp(vParams.z, 0.0, 1.0);
    float sideMix = 1.0 - smoothstep(0.45, 0.9, abs(dot(n, normalize(vInstanceFacing))));
    vec3 viewDir = normalize(viewTowardEye(vWorld));
    float sideShade = 0.7 + max(dot(n, uLightDir), 0.0) * 0.22 + max(dot(n, viewDir), 0.0) * 0.08;
    vec3 matrixGreen = matrixGlyphColor(base, glow, tip, sideMix, sideShade);
    float matrixFog = smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, uEye));
    oColor = vec4(mix(matrixGreen, uFog, matrixFog), reveal);
    oBright = vec4(matrixGreen * (glow * 0.9 + tip * 0.85) * (1.0 - matrixFog), reveal);
    return;
  }
  float fog = smoothstep(uFogRange.x, uFogRange.y, distance(vWorld, uEye));
  vec3 matrixColorResult = vec3(0.0);
  vec3 matrixBrightResult = vec3(0.0);
  if (front > 0.0) {
    vec3 matrixGreen;
    float matrixBloom;
    vec3 matrixColor;
    float matrixCoverage = 1.0;
    vec3 matrixSide = vec3(0.0);
    float matrixSideWeight = 0.0;
    if (living > 0.0) {
      matrixGreen = vec3(0.72, 1.0, 0.8) * (0.72 + ndl * 0.28);
      matrixColor = matrixGreen;
      matrixBloom = 0.72;
    } else if (localSurface > 0.0) {
      matrixGreen = matrixColor = vec3(0.0);
      matrixBloom = 0.0;
    } else {
      float glow, tip, palette, sideMix, sideShade;
      float glyph = matrixGlyphAt(n, flow, glow, tip, palette, sideMix, sideShade);
      vec3 glyphBase = mix(vec3(24.0, 220.0, 74.0), vec3(70.0, 255.0, 112.0), palette) / 255.0;
      matrixGreen = matrixGlyphColor(glyphBase, glow, tip, 0.0, sideShade);
      matrixSide = matrixGlyphColor(glyphBase, glow, tip, 1.0, sideShade);
      matrixSideWeight = sideMix;
      matrixColor = matrixGreen;
      matrixCoverage = glyph;
      matrixBloom = glow * 0.9 + tip * 0.85;
    }
    vec3 frontColor = clamp(mix(matrixColor, uFog, fog), 0.0, 1.0);
    vec3 sideColor = clamp(mix(matrixSide, uFog, fog), 0.0, 1.0);
    vec3 frontBright = clamp(matrixGreen * matrixBloom * (1.0 - fog), 0.0, 1.0);
    vec3 sideBright = clamp(matrixSide * matrixBloom * (1.0 - fog), 0.0, 1.0);
    matrixColorResult = mix(uFog * fog, mix(frontColor, sideColor, matrixSideWeight), matrixCoverage);
    matrixBrightResult = mix(frontBright, sideBright, matrixSideWeight) * matrixCoverage;
    if (front >= 1.0) {
      oColor = vec4(matrixColorResult, 1.0);
      oBright = vec4(matrixBrightResult, 1.0);
      return;
    }
  }
  float ember = clamp(-vParams.x, 0.0, 1.0);
  float detail = 0.72 + dot(base, vec3(0.2126, 0.7152, 0.0722)) * 0.28;
  vec3 heat = vec3(1.0, 0.12 + ember * 0.85, 0.01 + ember * ember * ember * 0.74) * detail;
  base = mix(base, heat, ember * 0.9);
  float emissive = max(clamp(vColor.a * max(0.0, vParams.x), 0.0, 1.0), ember * 0.9);
  base *= mix(voxelDetail(), 1.0, max(emissive, cloud));
  if (dot(vLocalNormal, vLocalNormal) > 20.0 && dot(vLocalNormal, vLocalNormal) < 30.0) {
    // Marching squares on the road grid: each tile corner takes the share of road among the four tiles meeting
    // there (from the eight-neighbour mask in the first instance parameter, stored as 1 + mask); the tile keeps
    // what lies inside the bilinear half line, so staircases read as straight diagonals and curves.
    int mask = int(vParams.x + 0.5) - 1;
    float ex = float(mask & 1) , wx = float((mask >> 1) & 1), nz = float((mask >> 2) & 1), sz = float((mask >> 3) & 1);
    float ne = float((mask >> 4) & 1), nw = float((mask >> 5) & 1), se = float((mask >> 6) & 1), sw = float((mask >> 7) & 1);
    vec2 u = clamp(vLocal.xz / 0.125 + 0.5, 0.0, 1.0);
    float c00 = (1.0 + wx + sz + sw) * 0.25, c10 = (1.0 + ex + sz + se) * 0.25, c01 = (1.0 + wx + nz + nw) * 0.25, c11 = (1.0 + ex + nz + ne) * 0.25;
    if (mix(mix(c00, c10, u.x), mix(c01, c11, u.x), u.y) < 0.5) discard;
    base *= roadDetail();
  }
  vec3 lightFactor = lightFactorAt(n);
  // Clouds are lit like cartoon cumulus: sky fill everywhere, the sun on every face that sees it, no hard shade.
  if (cloud > 0.5) lightFactor = uSky * 0.85 + uSun * uDirectStrength * (0.4 + 0.45 * max(dot(n, uLightDir), 0.0)) + vec3(0.18) * uDirectStrength;
  // Sky rim: a grazing view picks up the sky's fill, which lifts silhouettes off the ground behind them.
  float rim = pow(1.0 - clamp(dot(n, normalize(uEye - vWorld)), 0.0, 1.0), 3.0) * clamp(n.y * 0.5 + 0.6, 0.0, 1.0);
  lightFactor += uSky * rim * 0.22 + uSun * uDirectStrength * rim * 0.1;
  vec3 lit = base * lightFactor;
  vec3 col = mix(lit, base * 1.15, emissive);
  col = mix(col, vec3(1.0, 0.86, 0.45), vParams.y * 0.4);
  float tip = clamp(vParams.z, 0.0, 1.0) * (1.0 - step(1.5, vParams.z));
  col = mix(col, vec3(0.84, 1.0, 0.89), tip * 0.88);
  vec3 surfaceBright = vec3(0.0);
  float nl = dot(vLocalNormal, vLocalNormal);
  float lakeAlpha = 1.0;
  bool lake = nl > 30.0 && nl < 42.0;
  if (nl > 45.0 && nl < 55.0) col = dsbWaterShade(surfaceBright);
  else if (lake) col = lakeShade(col, surfaceBright, lakeAlpha);
  else if (nl > 12.0 && nl < 20.0) col = lavaShade(surfaceBright);
  else if (nl > 6.0 && nl < 12.0) col = waterShade(col, n, surfaceBright);
  vec3 normalColor = clamp(mix(col, uFog, fog), 0.0, 1.0);
  vec3 normalBright = clamp((col * (emissive * 0.9 + vParams.y * 0.5 + tip * 0.85) + surfaceBright) * (1.0 - fog), 0.0, 1.0);
  float glassAlpha = uGlass < 1.0 ? clamp(uGlass + pow(1.0 - abs(dot(n, normalize(uEye - vWorld))), 2.0) * 0.55, 0.0, 1.0) : 1.0;
  if (lake) glassAlpha = lakeAlpha;
  // Dust scatters faint light without a glass rim; its intensity fades toward the far end.
  if (uLightBeam > 0.0) {
    float fade = clamp(1.0 - vLocal.x / uLightBeam, 0.0, 1.0);
    glassAlpha = uGlass * fade * fade;
  }
  if (uGlassOpacity > 0.0) {
    vec3 view = normalize(viewTowardEye(vWorld));
    float grazing = pow(1.0 - abs(dot(n, view)), 3.0);
    float glint = pow(max(dot(reflect(-uLightDir, n), view), 0.0), 36.0);
    normalColor = mix(normalColor, vec3(0.88, 1.0, 0.98), grazing * 0.7 + glint * 0.35);
    glassAlpha = mix(uGlassOpacity, 0.72, grazing) + glint * 0.12;
  }
  oColor = vec4(mix(normalColor, matrixColorResult, front), glassAlpha);
  oBright = vec4(mix(normalBright, matrixBrightResult, front), glassAlpha);
}`;
  const SHADOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
${RIG_GLSL}
uniform mat4 uLightViewProj;
out vec3 vWorld;
void main() {
  vec4 world = rigMatrix(mat4(aM0, aM1, aM2, aM3)) * vec4(aPos, 1.0);
  vWorld = world.xyz;
  gl_Position = uLightViewProj * world;
}`;
const SHADOW_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform float uClipMinY;
uniform vec4 uObjectClip;
void main() {
  // Bird's-eye cuts belong to the camera, not the sun. Keep the original
  // ceiling silhouettes in the shadow map while their colour geometry is
  // scanned or faded away.
  if (vWorld.y < uClipMinY || dot(uObjectClip, vec4(vWorld, 1.0)) > 0.0) discard;
}`;
  // Derived shaders assert every rewrite matched: a source drift must fail at init with the
  // failed pattern named, never render a silently under-derived shader.
  const derive = (source, ...rewrites) => {
    for (const [pattern, replacement] of rewrites) {
      const matched = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g").test(source) : source.includes(pattern);
      if (!matched) throw new Error(`Shader derivation never matched ${pattern}`);
      source = source.replace(pattern, replacement);
    }
    return source;
  };
  const ORDINARY_MESH_VS = derive(MESH_VS, [RIG_GLSL, ""],
    ["uniform vec4 uVoxel;\nflat out vec4 vVoxel;\n", ""],
    ["rigMatrix(mat4(aM0, aM1, aM2, aM3))", "mat4(aM0, aM1, aM2, aM3)"],
    ["  vec4 params = uRigCount > 0 ? uRigParams[int(aJoint)] : aParams;\n", ""],
    ["  vVoxel = uRigCount > 0 ? uRigVoxels[int(aJoint)] : uVoxel;\n", ""],
    ["uRigCount > 0 ? normalize(uRigMatrices[int(aJoint)][2].xyz) : normalize(aM2.xyz)", "normalize(aM2.xyz)"],
    [/\bparams\b/g, "aParams"],
    ["layout(location=7) in vec4 aParams;\n\n", "layout(location=7) in vec4 aParams;\n"]);
  const ORDINARY_MESH_FS = derive(MESH_FS, ["flat in vec4 vVoxel;", "uniform vec4 uVoxel;"], [/\bvVoxel\b/g, "uVoxel"]);
  const ORDINARY_SHADOW_VS = derive(SHADOW_VS, [RIG_GLSL, ""], ["rigMatrix(mat4(aM0, aM1, aM2, aM3))", "mat4(aM0, aM1, aM2, aM3)"],
    ["layout(location=6) in vec4 aM3;\n\n", "layout(location=6) in vec4 aM3;\n"]);
  const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aA;
layout(location=1) in vec3 aB;
layout(location=2) in vec2 aSide;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
layout(location=7) in vec4 aParams;
layout(location=8) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uClipMaxY;
out vec3 vWorld;
out vec4 vColor;
out vec4 vParams;
void main() {
  mat4 m = mat4(aM0, aM1, aM2, aM3);
  vec4 wa = m * vec4(aA, 1.0), wb = m * vec4(aB, 1.0);
  if (wa.y > uClipMaxY && wb.y > uClipMaxY) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (wa.y > uClipMaxY) wa = mix(wa, wb, (uClipMaxY - wa.y) / (wb.y - wa.y));
  if (wb.y > uClipMaxY) wb = mix(wb, wa, (uClipMaxY - wb.y) / (wa.y - wb.y));
  vec4 ca = uViewProj * wa;
  vec4 cb = uViewProj * wb;
  vColor = aColor;
  vParams = aParams;
  vColor.rgb *= 1.0 - clamp(-aParams.y, 0.0, 1.0) * 0.88;
  vParams.y = max(0.0, aParams.y);
  if (ca.w < 0.05 && cb.w < 0.05) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (ca.w < 0.05) ca = mix(ca, cb, (0.05 - ca.w) / (cb.w - ca.w));
  if (cb.w < 0.05) cb = mix(cb, ca, (0.05 - cb.w) / (ca.w - cb.w));
  vec2 hv = uViewport * 0.5;
  vec2 sa = ca.xy / ca.w * hv;
  vec2 sb = cb.xy / cb.w * hv;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 0.0001 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = aSide.x < 0.5 ? ca : cb;
  vWorld = mix(wa.xyz, wb.xyz, aSide.x);
  vec2 off = nrm * aSide.y * uWidth * 0.5 / hv * c.w;
  gl_Position = vec4(c.xy + off, c.z, c.w);
}`;
  const LINE_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform float uClipMaxY;
uniform vec4 uObjectClip;
${CUTAWAY_GLSL}
in vec4 vColor;
in vec4 vParams;
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oBright;
void main() {
  if (dot(uObjectClip, vec4(vWorld, 1.0)) > 0.0 || cutaway(vWorld)) discard;
  float ember = clamp(-vParams.x, 0.0, 1.0);
  float detail = 0.72 + dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 0.28;
  vec3 heat = vec3(1.0, 0.12 + ember * 0.85, 0.01 + ember * ember * ember * 0.74) * detail;
  vec3 base = mix(vColor.rgb, heat, ember * 0.9);
  float glow = max(clamp(vColor.a * max(0.0, vParams.x), 0.0, 1.0), ember * 0.9);
  vec3 col = mix(base, vec3(1.0), glow * 0.35);
  oColor = vec4(col, 1.0);
  oBright = vec4(base * glow, 1.0);
}`;
  const IMAGE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
uniform mat4 uViewProj;
uniform vec4 uRect;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vUv = (aPos.xy - uRect.xy) / uRect.zw;
  vUv.y = 1.0 - vUv.y;
  vec4 world = mat4(aM0, aM1, aM2, aM3) * vec4(aPos, 1.0);
  vWorld = world.xyz;
  gl_Position = uViewProj * world;
}`;
  const IMAGE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vWorld;
uniform sampler2D uImage;
uniform bool uReady;
uniform float uClipMaxY;
${CUTAWAY_GLSL}
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oBright;
void main() {
  if (cutaway(vWorld)) discard;
  bool inside = all(greaterThanEqual(vUv, vec2(0.0))) && all(lessThanEqual(vUv, vec2(1.0)));
  oColor = vec4(uReady && inside ? texture(uImage, vUv).rgb : vec3(0.0), 1.0);
  oBright = vec4(0.0);
}`;
  const MIRROR_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=3) in vec4 aM0;
layout(location=4) in vec4 aM1;
layout(location=5) in vec4 aM2;
layout(location=6) in vec4 aM3;
layout(location=7) in vec4 aParams;
layout(location=9) in vec3 aMirrorSource;
uniform mat4 uViewProj;
uniform mat4 uReflectionViewProj;
uniform mat4 uMirrorWorld;
uniform float uShard;
out vec4 vReflection;
out vec3 vWorld;
out vec2 vPortalUv;
out vec2 vMirrorLocal;
out vec2 vClipDepth;
flat out vec4 vReflectionX;
flat out vec4 vReflectionY;
flat out float vOpacity;
flat out vec3 vMirrorNormal;
void main() {
  mat4 model = mat4(aM0, aM1, aM2, aM3);
  vec4 world = model * vec4(aPos, 1.0);
  mat4 source = uShard > 0.5 ? uMirrorWorld : model;
  vec3 local = uShard > 0.5 ? aMirrorSource : aPos;
  vWorld = world.xyz;
  vReflection = uReflectionViewProj * source * vec4(local, 1.0);
  vReflectionX = uReflectionViewProj * vec4(source[0].xyz, 0.0);
  vReflectionY = uReflectionViewProj * vec4(source[1].xyz, 0.0);
  vMirrorLocal = local.xy;
  vPortalUv = vec2(local.x / 5.0 + 0.5, 1.0 - (local.y + 1.75) / 3.25);
  vOpacity = aParams.z < 0.0 ? -aParams.z - 1.0 : 1.0;
  vMirrorNormal = normalize(model[2].xyz);
  gl_Position = uViewProj * world;
  vClipDepth = gl_Position.zw;
  // Clip the aperture in x/y/w, preserving its physical depth for the fragment
  // shader. Clamping individual vertices to the near plane bends the pane and
  // even far-clips visible glass when a corner lies behind the eye.
  if (uShard < 0.5) gl_Position.z = 0.0;
}`;
  const MIRROR_FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 vReflection;
in vec3 vWorld;
in vec2 vPortalUv;
in vec2 vMirrorLocal;
in vec2 vClipDepth;
flat in vec4 vReflectionX;
flat in vec4 vReflectionY;
flat in float vOpacity;
flat in vec3 vMirrorNormal;
uniform sampler2D uReflection;
uniform vec2 uReflectionScale;
uniform sampler2D uMatrixGlyphTex;
uniform vec3 uTint;
uniform float uPortal;
uniform float uReveal;
uniform float uRippleOnly;
// A shield's or a mirror's glyph crests in a colour of its own; a negative red keeps the Matrix green.
uniform vec3 uCrestTint;
uniform float uClipMaxY;
${CUTAWAY_GLSL}
uniform int uRippleActive;
uniform float uRippleTime;
uniform vec4 uRipples[${BL.mirrorRipples.CAPACITY}];
uniform sampler2D uBodyField;
uniform vec4 uBodyBounds;
uniform vec2 uBodyTexel;
uniform int uBodyContacts;
uniform int uBodyActive;
uniform vec4 uBodyWaves[${BL.mirrorBody.CAPACITY}];
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oBright;
float rippleHash(int n) {
  uint x = uint(n);
  x ^= x >> 16;
  x *= 2146121005u;
  x ^= x >> 15;
  x *= 2221713035u;
  x ^= x >> 16;
  return float(x >> 8) / 16777216.0;
}
vec4 bodyField(vec2 uv, int layer) {
  uv = clamp(uv, uBodyTexel * 0.5, vec2(1.0) - uBodyTexel * 0.5);
  return texture(uBodyField, vec2(uv.x, (uv.y + float(layer)) / ${BL.mirrorBody.CAPACITY + 1}.0));
}
void main() {
  if (cutaway(vWorld)) discard;
  // The ratio cancels perspective interpolation, recovering the original
  // planar depth. Glass inside the near plane still closes the cave entrance.
  gl_FragDepth = clamp(0.5 * vClipDepth.x / vClipDepth.y + 0.5, 0.0, 1.0);
  if (uRippleOnly < 0.5 && vPortalUv.y > 1.0 - uReveal) discard;
  if (vOpacity < 1.0) {
    ivec2 pixel = ivec2(gl_FragCoord.xy) & 3;
    int rank = ((pixel.x & 1) ^ (pixel.y & 1)) * 8 + (pixel.y & 1) * 4
      + (((pixel.x >> 1) & 1) ^ ((pixel.y >> 1) & 1)) * 2 + ((pixel.y >> 1) & 1);
    if ((float(rank) + 0.5) / 16.0 >= vOpacity) discard;
  }
  vec2 displacement = vec2(0.0);
  float ringLight = 0.0, glyphCrest = 0.0;
  vec2 pixelFootprint = max(fwidth(vMirrorLocal) / 0.021, vec2(0.001));
  if (uPortal < 0.5 && uRippleActive > 0) {
    for (int i = 0; i < ${BL.mirrorRipples.CAPACITY}; i++) {
      vec4 wave = uRipples[i];
      if (wave.w <= 0.0) continue;
      vec2 offset = vMirrorLocal - wave.xy;
      float distance = length(offset);
      float radius = ${BL.mirrorRipples.START_RADIUS.toFixed(6)} + wave.z * ${BL.mirrorRipples.SPEED.toFixed(6)};
      float phase = (distance - radius) / ${BL.mirrorRipples.WIDTH.toFixed(6)};
      if (phase > 3.0 || phase < -5.5) continue;
      float primary = exp(-phase * phase);
      float trailingPhase = phase + 2.5;
      float trailing = exp(-trailingPhase * trailingPhase) * 0.28;
      float slope = (primary * phase + trailing * trailingPhase) * wave.w;
      displacement += offset / max(distance, 0.0001) * slope * 0.045;
      ringLight += (primary - trailing) * wave.w * 0.055;
      glyphCrest = max(glyphCrest, primary * smoothstep(${BL.mirrorRipples.GLYPH_THRESHOLD.toFixed(6)}, 0.85, wave.w));
    }
  }
  if (uPortal < 0.5 && (uBodyContacts > 0 || uBodyActive > 0)) {
    vec2 bodyUv = (vMirrorLocal - uBodyBounds.xy) / uBodyBounds.zw;
    if (uBodyContacts > 0) {
      vec4 field = bodyField(bodyUv, 0);
      float distance = (field.r - 0.5) * ${(BL.mirrorBody.RANGE * 2).toFixed(6)};
      float phase = (distance - 0.02) / 0.075;
      float contact = exp(-phase * phase) * field.a;
      glyphCrest = max(glyphCrest, contact * (0.66 + 0.06 * sin(uRippleTime * 3.0 + vMirrorLocal.y * 4.0)));
      ringLight += contact * 0.022;
    }
    for (int i = 0; i < ${BL.mirrorBody.CAPACITY}; i++) {
      vec4 wave = uBodyWaves[i];
      if (wave.y <= 0.0) continue;
      vec4 field = bodyField(bodyUv, i + 1);
      float distance = (field.r - 0.5) * ${(BL.mirrorBody.RANGE * 2).toFixed(6)};
      float phase = (distance - wave.x * ${BL.mirrorBody.SPEED.toFixed(6)}) / ${BL.mirrorBody.WIDTH.toFixed(6)};
      if (phase > 3.0 || phase < -5.5 || field.a < 0.5) continue;
      float primary = exp(-phase * phase);
      float trailingPhase = phase + 2.5;
      float trailing = exp(-trailingPhase * trailingPhase) * 0.28;
      vec2 gradient = field.gb * 2.0 - 1.0;
      gradient /= max(length(gradient), 0.0001);
      displacement += gradient * (primary * phase + trailing * trailingPhase) * wave.y * 0.045;
      ringLight += (primary - trailing) * wave.y * 0.055;
      glyphCrest = max(glyphCrest, primary * smoothstep(0.55, 0.85, wave.y));
    }
  }
  displacement *= min(1.0, 0.035 / max(length(displacement), 0.0001));
  // Perturb in the mirror's own plane, then project. A fixed screen-space
  // offset would slide the water rings when the camera moves or looks obliquely.
  vec3 color = vec3(max(0.0, ringLight));
  float effectAlpha = 0.0;
  if (uRippleOnly < 0.5) {
    vec4 rippled = vReflection + vReflectionX * displacement.x + vReflectionY * displacement.y;
    vec2 projectedUv = (rippled.xy / rippled.w * 0.5 + 0.5) * uReflectionScale;
    vec2 uv = mix(projectedUv, vPortalUv, uPortal);
    vec3 reflected = texture(uReflection, uv).rgb;
    float sheen = pow(max(0.0, 1.0 - abs(fract((vWorld.x + vWorld.y) * 0.22) - 0.5) * 7.0), 5.0) * 0.08;
    color = mix(reflected, uTint, 0.1) + sheen + ringLight;
  }
  if (glyphCrest > 0.0) {
    // The crest briefly reveals the same falling green streams as the cave,
    // including their moving cells, changing runes and bright leading tips.
    float grid = vMirrorLocal.x / 0.12;
    int stream = int(floor(grid));
    int train = 7 + int(floor(rippleHash(stream) * 6.0));
    int sequence = train + 2 + int(floor(rippleHash(stream + 41) * 5.0));
    float speed = 0.56 + rippleHash(stream + 19) * 0.64;
    float phase = rippleHash(stream + 73) * float(sequence) * 0.13;
    float movingGrid = (-vMirrorLocal.y - uRippleTime * speed - phase) / 0.13;
    int flowCell = int(floor(movingGrid));
    int position = flowCell % sequence;
    if (position < 0) position += sequence;
    if (position < train) {
      vec2 local = vec2((fract(grid) - 0.5) * 0.12, (0.5 - fract(movingGrid)) * 0.13);
      vec2 pixelCoord = vec2(local.x / 0.021 + 2.0, 3.0 - local.y / 0.021);
      ivec2 pixel = ivec2(floor(pixelCoord));
      if (pixel.x >= 0 && pixel.x < 4 && pixel.y >= 0 && pixel.y < 6) {
        int glyph = (abs(stream * 73 + flowCell * 151) + int(floor(uRippleTime * 20.0))) & 7;
        float mask = texelFetch(uMatrixGlyphTex, ivec2(glyph * 6 + 1 + pixel.x, 5 - pixel.y), 0).r;
        vec2 coverage = 1.0 - smoothstep(vec2(0.38) - pixelFootprint * 0.5, vec2(0.38) + pixelFootprint * 0.5, abs(fract(pixelCoord) - 0.5));
        float alpha = glyphCrest * mask * coverage.x * coverage.y * 0.82;
        float glow = (0.58 + rippleHash(stream + 101) * 0.36) * (0.48 + float(position + 1) / float(train) * 0.52);
        float tip = position == train - 1 ? 1.0 : position == train - 2 ? 0.55 : 0.0;
        vec3 base = (glyph & 1) == 0 ? vec3(24.0, 220.0, 74.0) : vec3(70.0, 255.0, 112.0);
        vec3 green = mix(base / 255.0 * mix(0.78, 1.15, glow), vec3(0.84, 1.0, 0.89), tip * 0.88);
        vec3 crest = uCrestTint.r < 0.0 ? green : mix(uCrestTint * mix(0.78, 1.15, glow), vec3(0.9, 0.97, 1.0), tip * 0.88);
        if (uRippleOnly > 0.5) {
          // Premultiplied glyphs reveal the actual scene behind this plane;
          // the faint crest adds light without an opaque reflection or tint.
          color = color * (1.0 - alpha) + crest * alpha;
          effectAlpha = alpha;
        } else color = mix(color, crest, alpha);
      }
    }
  }
  if (uRippleOnly > 0.5 && max(max(color.r, color.g), color.b) < 0.0001) discard;
  oColor = vec4(color, uRippleOnly > 0.5 ? effectAlpha : 1.0);
  oBright = vec4(0.0);
}`;
  const SHARD_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
flat in vec3 vMirrorNormal;
flat in float vOpacity;
uniform samplerCube uEnvironment;
${VIEW_DIRECTION_GLSL}
uniform vec3 uTint;
uniform float uClipMaxY;
${CUTAWAY_GLSL}
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oBright;
void main() {
  if (cutaway(vWorld, vOpacity)) discard;
  vec3 direction = reflect(-normalize(viewTowardEye(vWorld)), normalize(vMirrorNormal));
  oColor = vec4(mix(texture(uEnvironment, direction).rgb, uTint, 0.04), 1.0);
  oBright = vec4(0.0);
}`;
  const QUAD_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;
  const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform mat4 uInvViewProj;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uMoonSunDir;
uniform mat3 uStarMatrix;
uniform float uStars;
uniform float uTime;
uniform float uHazeDrop;
uniform float uClouds;
uniform vec4 uSea;
uniform vec2 uSeaEye;
layout(location=0) out vec4 oColor;
layout(location=1) out vec4 oBright;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += valueNoise(p) * a;
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}
void main() {
  vec4 far = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(far.xyz / far.w);
  float hazeY = d.y + uHazeDrop;
  vec3 col = mix(uHorizon, uZenith, smoothstep(-0.02, 0.5, hazeY));
  col = mix(col, uHorizon * 0.55, smoothstep(0.0, 0.5, -hazeY));
  float sd = max(dot(d, uSunDir), 0.0);
  float sunDisc = pow(sd, 600.0) * (1.0 - uStars);
  vec3 sun = uSun * (sunDisc + pow(sd, 6.0) * 0.18 * (1.0 - uStars));
  float moonDot = dot(d, uMoonDir);
  float moonDisc = smoothstep(0.9985, 0.999, moonDot) * mix(0.3, 1.0, uStars) * smoothstep(-0.02, 0.005, d.y);
  vec3 moonOffset = (d - uMoonDir * moonDot) / sqrt(0.003);
  vec3 moonNormal = moonOffset - uMoonDir * sqrt(max(0.0, 1.0 - dot(moonOffset, moonOffset)));
  float moonLit = smoothstep(-0.025, 0.025, dot(moonNormal, uMoonSunDir));
  vec3 moon = vec3(0.82, 0.88, 1.0) * moonDisc * moonLit;
  vec3 stars = vec3(0.0);
  if (uStars > 0.002) {
    vec3 starD = normalize(uStarMatrix * d);
    vec3 a = abs(starD);
    vec2 f;
    float face;
    if (a.x >= a.y && a.x >= a.z) { f = starD.yz / a.x; face = starD.x > 0.0 ? 0.0 : 1.0; }
    else if (a.y >= a.z) { f = starD.xz / a.y; face = starD.y > 0.0 ? 2.0 : 3.0; }
    else { f = starD.xy / a.z; face = starD.z > 0.0 ? 4.0 : 5.0; }
    f = (f * 0.5 + 0.5) * 48.0;
    vec2 cell = floor(f) + face * 97.0;
    float h = hash(cell);
    if (h < 0.14) {
      float h2 = hash(cell + 17.3);
      float h3 = hash(cell + 41.7);
      float r = 0.12 + h2 * 0.18;
      float pt = 1.0 - smoothstep(0.0, r, length(fract(f) - 0.5));
      float twinkle = 0.75 + 0.25 * sin(uTime * (2.0 + h3 * 3.0) + h3 * 6.28);
      float s = pt * (0.5 + 0.5 * h2) * twinkle * uStars * smoothstep(-0.05, 0.15, hazeY);
      stars = mix(vec3(1.0), vec3(0.75, 0.85, 1.0), h3) * s;
    }
  }
  // The sea far below the island: the view ray meets a level plane, waves from two drifting noise fields bend
  // its normal, the sky reflects by Fresnel, the sun glints, crests foam, and it hazes into the horizon.
  if (uSea.x > 0.0 && d.y < -0.0005) {
    float t = (uSea.y - uSea.z) / d.y;
    vec2 p = uSeaEye + d.xz * t;
    float e = 0.6;
    float h0 = fbm(p * 0.045 + vec2(uTime * 0.02, uTime * 0.013)), hx = fbm((p + vec2(e, 0.0)) * 0.045 + vec2(uTime * 0.02, uTime * 0.013)), hz = fbm((p + vec2(0.0, e)) * 0.045 + vec2(uTime * 0.02, uTime * 0.013));
    vec3 n = normalize(vec3((h0 - hx) * 2.2, 1.0, (h0 - hz) * 2.2));
    vec3 r = reflect(d, n);
    float fres = 0.08 + 0.92 * pow(1.0 - max(dot(-d, n), 0.0), 5.0);
    vec3 skyR = mix(uHorizon, uZenith, smoothstep(0.0, 0.5, r.y));
    float day = 1.0 - uStars;
    vec3 deep = mix(vec3(0.04, 0.06, 0.12), vec3(0.03, 0.34, 0.52), day);
    vec3 shallow = mix(vec3(0.05, 0.09, 0.15), vec3(0.06, 0.55, 0.62), day);
    vec3 water = mix(shallow, deep, smoothstep(0.35, 0.65, h0));
    water = mix(water, skyR, fres);
    // The sea takes the sky's own colour, warm at dusk and dim at night, over its daytime blues.
    water *= mix(vec3(1.0), uHorizon * 1.35, 0.4);
    water += uSun * pow(max(dot(r, uSunDir), 0.0), 220.0) * 3.0 * day;
    water += vec3(0.85, 0.95, 1.0) * smoothstep(0.66, 0.74, h0) * 0.22 * day;
    // Haze by distance, pushed out by however far the eye climbs past island heights, so a dive from altitude
    // still sees blue sea below instead of a sheet of horizon colour; at island heights nothing changes.
    float lift = max(0.0, uSea.z - uSea.y - 120.0);
    col = mix(water, uHorizon, smoothstep(160.0 + lift * 1.2, 900.0 + lift * 2.5, t));
  }
  // Painted cumulus on a plane over the world, drifting with time: lit toward the sun, grey underneath,
  // taking the horizon's colour at dusk and dimming to the night sky. They thin out toward the horizon.
  float cover = 0.0;
  if (uClouds > 0.0 && d.y > 0.0) {
    vec2 p = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime * 0.012, uTime * 0.004);
    float n = fbm(p);
    cover = smoothstep(1.0 - uClouds, 1.0 - uClouds + 0.22, n) * smoothstep(0.0, 0.18, d.y);
    float lit = clamp(0.62 + (n - fbm(p + uSunDir.xz * 0.35)) * 3.0, 0.3, 1.1);
    vec3 day = mix(vec3(0.78, 0.82, 0.9), vec3(1.0, 0.98, 0.95), lit) + uSun * 0.25 * lit;
    vec3 night = mix(uZenith, uHorizon, 0.5) * (0.7 + 0.5 * lit);
    vec3 cloudCol = mix(day, night, uStars);
    cloudCol = mix(cloudCol, uHorizon * 1.05, smoothstep(0.35, 0.0, d.y) * 0.6);
    col = mix(col, cloudCol, cover * 0.92);
    sun *= 1.0 - cover * 0.85;
    moon *= 1.0 - cover;
    stars *= 1.0 - cover;
  }
  oColor = vec4(col + sun + moon + stars, 1.0);
  oBright = vec4(uSun * sunDisc * 0.6 + moon * 0.5 + stars * 0.35, 1.0);
}`;
  const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 oColor;
void main() {
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 sum = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i);
    sum += texture(uTex, vUv + o).rgb * w[i];
    sum += texture(uTex, vUv - o).rgb * w[i];
  }
  oColor = vec4(sum, 1.0);
}`;
  // Display grade over every scene: obscurance, two bloom radii, a soft shoulder that rolls hot light off instead
  // of clipping it, a soft S curve, rich animation-cel saturation, cool shadows under warm highlights, vignette
  // and dither.
  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloomWide;
uniform float uBloomStrength;
uniform sampler2D uDepth;
uniform vec4 uShaft;
uniform vec3 uShaftColor;
out vec4 oColor;
void main() {
  vec3 col = texture(uScene, vUv).rgb;
  // Sun shafts: open sky marched toward the sun's place on screen, so the light streams past every
  // silhouette standing in front of it.
  if (uShaft.z > 0.0) {
    vec2 march = (uShaft.xy - vUv) / 28.0;
    vec2 uv = vUv + march * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float light = 0.0, w = 1.0;
    for (int i = 0; i < 28; i++) {
      light += step(0.99999, texture(uDepth, uv).r) * w;
      w *= 0.955;
      uv += march;
    }
    vec2 a = (vUv - uShaft.xy) * vec2(uShaft.w, 1.0);
    col += uShaftColor * light / 28.0 * uShaft.z * (1.0 - smoothstep(0.0, 0.9, length(a)));
  }
  col += (texture(uBloom, vUv).rgb + texture(uBloomWide, vUv).rgb * 0.7) * uBloomStrength;
  vec3 hot = max(col - 0.82, 0.0);
  col = min(col, 0.82) + 0.18 * (1.0 - exp(-hot / 0.18));
  // A gentle S curve whose toe is lifted, so shaded faces keep their colour instead of sinking to black.
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.14);
  col += (1.0 - smoothstep(0.0, 0.25, col)) * 0.025;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, 1.2), 0.0);
  col *= mix(vec3(0.95, 0.99, 1.07), vec3(1.05, 1.0, 0.93), smoothstep(0.1, 0.75, l));
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.16 * smoothstep(0.3, 0.9, dot(q, q) * 2.2);
  col += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  oColor = vec4(col, 1.0);
}`;
  const isSupported = () => {
    try {
      const probe = document.createElement("canvas");
      return !!probe.getContext("webgl2");
    } catch {
      return false;
    }
  };
  const createRenderer = (canvas, { quality = "high" } = {}) => {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 unavailable");
    // Hoisted so the per-frame resolve allocates no draw-buffer arrays.
    const DRAW_COLOR = [gl.COLOR_ATTACHMENT0, gl.NONE];
    const DRAW_BRIGHT = [gl.NONE, gl.COLOR_ATTACHMENT1];
    const DRAW_BOTH = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];
    let settings = QUALITY[quality] || QUALITY.high;
    let qualityName = QUALITY[quality] ? quality : "high";
    let width = 0, height = 0, dpr = 1, pw = 0, ph = 0;
    let lost = false;
    const size = { width: 0, height: 0 };
    const view = mat4.create();
    const proj = mat4.create();
    const viewProj = mat4.create();
    const lightView = mat4.create();
    const lightProj = mat4.create();
    const lightViewProj = mat4.create();
    const P4 = new Float32Array(4);
    const MIRROR_POINT = new Float32Array(3);
    const MIRROR_CLIP = new Float32Array(4);
    const MIRROR_RECT = new Float32Array(4);
    const REFLECTOR_CENTER = new Float32Array(3), REFLECTOR_NORMAL = new Float32Array(3);
    const mirrorView = mat4.create();
    const mirrorProj = mat4.create(), mirrorInverseProj = mat4.create(), mirrorClipCorner = new Float32Array(4);
    const mirrorViewProj = mat4.create();
    const mirrorCapturedViewProj = mat4.create();
    const invViewProj = mat4.create();
    const mirrorInvViewProj = mat4.create();
    const FRUSTUM = new Float32Array(24), LIGHT_FRUSTUM = new Float32Array(24), MIRROR_FRUSTUM = new Float32Array(24);
    const CENTER = new Float32Array(3), CULL = new Float64Array(4);
    let culled = 0, drawn = 0, suppressed = 0, shadowPassCount = 0, rippleSurfaces = 0, rippleWaves = 0;
    // Static casters live in a cached depth map (res.shadow.staticFb) baked under shadowBaked; the working map
    // starts each frame as a copy of it and takes only the moving casters.
    let shadowFrame = 0, shadowBake = 0, shadowBakedCount = 0, shadowStaticValid = false, shadowSubset = 0, shadowDraws = 0, shadowStaticRebuilds = 0;
    const shadowPrev = new Float32Array(16), shadowBaked = new Float32Array(16);
    const mirrorEye = { x: 0, y: 0, z: 0 };
    const mirrorTarget = { x: 0, y: 0, z: 0 };
    const mirrorUp = { x: 0, y: 1, z: 0 };
    const records = new Map();
    // Refilled in place every frame (`activeCount` during collect), so its backing store is never dropped and regrown.
    const activeRecords = [];
    let activeCount = 0;
    let dsbGPU=null;
    // PROTOTYPE: a scene at sea level can switch off the hub's dropped haze horizon (`hazeDrop: 0`).
    let skyHaze=1;
    const res = { programs: {}, fbo: null, shadow: null, bloom: null, quadVao: null, matrixTexture: null };
    const mirror = { node: null, record: null, geometry: null, program: null, programReady: false, fb: null, tex: null, depth: null, width: 0, height: 0, renderWidth: 0, renderHeight: 0, portal: false, reveal: 0, frontFacing: false, walkThrough: false, captureValid: false, bodyTex: null, bodyState: null, bodyVersion: -1, shards: 0 };
    const environment = { program: null, ready: false, fb: null, tex: null, depth: null, size: 0, next: 0, valid: 0, frame: 0, origin: new Float32Array(3) };
    // Reflectors: plain planar mirrors a scene may hold several of (the factory's peer shields), each with a capture
    // of its own, drawn with the mirror's program and their ripples. The mirror above stays the one mirror with
    // panels, a body and a portal. The reflector covering most of the screen captures every frame and the others take
    // turns, one a frame, so a scene pays two reflection passes at most; one waiting its turn shows its last capture.
    // A reflector needs a geometry of its own, which keys its capture. `reflectorPass` is the record a capture leaves
    // out (null in the eye's pass, which draws every reflector itself).
    const reflectorNodes = [], reflectorTargets = new Map();
    let reflectorTurn = 0, reflectorPass = null;
    // Glass (`geometry.glass`, its see-through alpha) draws after everything opaque and the sky, blended and leaving
    // the depth alone, back faces first so a tube shows its far wall through its near one. `glassPass` is set while it
    // draws; every other pass leaves glass out.
    let glassPass = false;
    const mirrorDebug = {
      active: false, faux: false, portal: false, reveal: 0, surfaceDrawn: false, captureValid: false, width: 0, height: 0, textureWidth: 0, textureHeight: 0, samples: 0, allocationCount: 0, reflectionPassCount: 0, skippedPassCount: 0, resources: 0, captureExcluded: false, reflectionOnlyCount: 0, planeDistance: 0, ripples: 0, bodyContacts: 0, bodyWaves: 0,
      cameraPosition: new Float32Array(3), cameraTarget: new Float32Array(3), planeCenter: new Float32Array(3), planeNormal: new Float32Array(3), capturedViewProj: mirrorCapturedViewProj, shardsDrawn: 0, environmentPassCount: 0, environmentFaces: 0, environmentSize: 0, environmentResources: 0, skipReason: "none"
    };
    // Compiles without blocking; ready flips once linked.
    let parallel = null;
    let programs = null, rigPrograms = null, rigProgramsReady = false, rigProgramsRequested = false, rigMode = false, rigFailure = null;
    let maxSamples = 0; // Context capability; querying during a tier change can wait for outstanding GPU work.
    let ready = false, cutawayMaxY = 1e6, cutawayCount = 0, cutawayFade = 0, cutawayFrame = 0, cutawayCloudY = 0, cutawayCloudMix = 0;
    const cutawayRegions = new Float32Array(32), cutawayBounds = new Float32Array(32);
    let failure = null;
    const compile = (vs, fs, uniforms) => {
      const make = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      };
      const prog = gl.createProgram();
      const v = make(gl.VERTEX_SHADER, vs), f = make(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(prog, v);
      gl.attachShader(prog, f);
      gl.linkProgram(prog);
      return { prog, shaders: [v, f], sourceUniforms: uniforms, uniforms: uniforms.concat(["uCutCount", "uCutRegions", "uCutBounds", "uCutawayOpacity"]), u: {}, cutFrame: -1, cutCount: -1, cutOpacity: NaN, clipMinY: NaN, clipMaxY: NaN, objectClip: null, objectSlab: null, projective: NaN, voxel: null, sway: 0, swing: 0, matrixGlyph: NaN, matrixCave: NaN, lineWidth: NaN };
    };
    const finishProgram = (p) => {
      if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
        const logs = p.shaders.map((sh) => gl.getShaderInfoLog(sh)).filter(Boolean).join("\n");
        throw new Error(`Program link failed: ${gl.getProgramInfoLog(p.prog)} ${logs}`);
      }
      for (const sh of p.shaders) gl.deleteShader(sh);
      p.shaders = [];
      for (const name of p.uniforms) p.u[name] = gl.getUniformLocation(p.prog, name);
      // Every mesh is opaque but in the glass pass, which sets its own and puts this back.
      if (p.u.uGlass) {
        gl.useProgram(p.prog);
        gl.uniform1f(p.u.uGlass, 1);
      }
    };
    const destroyMirrorProgram = () => {
      const p = mirror.program;
      if (!p) return;
      for (const sh of p.shaders) gl.deleteShader(sh);
      gl.deleteProgram(p.prog);
      mirror.program = null;
      mirror.programReady = false;
      mirrorDebug.resources--;
    };
    const ensureMirrorProgram = () => {
      if (!mirror.program) {
        mirror.program = compile(MIRROR_VS, MIRROR_FS, ["uViewProj", "uReflectionViewProj", "uMirrorWorld", "uShard", "uReflection", "uReflectionScale", "uTint", "uPortal", "uReveal", "uRippleOnly", "uCrestTint", "uMatrixGlyphTex", "uRippleActive", "uRippleTime", "uRipples", "uBodyField", "uBodyBounds", "uBodyTexel", "uBodyContacts", "uBodyActive", "uBodyWaves", "uClipMaxY"]);
        mirrorDebug.resources++;
      }
      if (mirror.programReady) return true;
      if (parallel && !gl.getProgramParameter(mirror.program.prog, parallel.COMPLETION_STATUS_KHR)) return false;
      finishProgram(mirror.program);
      mirror.programReady = true;
      return true;
    };
    const buildPrograms = () => {
      ready = false;
      failure = null;
      const matrixSampling = gl.getExtension("OES_shader_multisample_interpolation");
      const meshFragment = matrixSampling ? ORDINARY_MESH_FS.replace("#version 300 es", "#version 300 es\n#extension GL_OES_shader_multisample_interpolation : require\n#define MATRIX_SAMPLE_INTERPOLATION") : ORDINARY_MESH_FS;
      res.programs = {
        image: compile(IMAGE_VS, IMAGE_FS, ["uViewProj", "uRect", "uImage", "uReady", "uClipMaxY"]),
        mesh: compile(ORDINARY_MESH_VS, meshFragment, ["uRigCount", "uRigPass", "uRigMatrices", "uRigParams", "uRigVoxels", "uRigVisibility", "uViewProj", "uLightViewProj", "uEye", "uViewDirection", "uLightDir", "uSky", "uGround", "uSun", "uDirectStrength", "uAmbientFloor", "uDiffuseFloor", "uShadowStrength", "uShadowFloor", "uShadowBias", "uShadow", "uShadowTexel", "uLights", "uLightCount", "uSpotLight", "uFog", "uFogRange", "uMatrixParams", "uMatrixOrigin", "uMatrixGlyph", "uMatrixCave", "uMatrixCaves", "uMatrixCaveBounds", "uMatrixCaveNear", "uMatrixPermanentCave", "uMatrixPermanentPlane", "uMatrixPermanentAperture", "uMatrixLivingGlobal", "uMatrixGlyphTex", "uMatrixSamples", "uClipMinY", "uClipMaxY", "uObjectClip", "uObjectSlab", "uProjective", "uMatrixGlyphOpacity", "uGlassOpacity", "uVoxel", "uWindTime", "uSway", "uSwing", "uGlass", "uLightBeam", "uLakeWaveCount", "uLakeWaves", "uLakeSurface", "uLakeSuction", "uLakeFlowEnabled", "uLakeFlowU", "uLakeFlowV", "uLakeCharge", "uLakeChargeRise", "uLakeChargeCenter", "uLakeOcclude", "uLakeWaveEnd", "uLakeBodyShape", "uLakeBodyBend", "uDSBSurface", "uDSBDepth", "uDSBEnvironment"]),
        shadow: compile(ORDINARY_SHADOW_VS, SHADOW_FS, ["uRigCount", "uRigPass", "uRigMatrices", "uRigVisibility", "uLightViewProj", "uClipMinY", "uClipMaxY", "uObjectClip"]),
        line: compile(LINE_VS, LINE_FS, ["uViewProj", "uViewport", "uWidth", "uClipMaxY", "uObjectClip"]),
        sky: compile(QUAD_VS, SKY_FS, ["uInvViewProj", "uHorizon", "uZenith", "uSun", "uSunDir", "uMoonDir", "uMoonSunDir", "uStarMatrix", "uStars", "uTime", "uHazeDrop", "uClouds", "uSea", "uSeaEye"]),
        blur: compile(QUAD_VS, BLUR_FS, ["uTex", "uDir"]),
        composite: compile(QUAD_VS, COMPOSITE_FS, ["uScene", "uBloom", "uBloomWide", "uBloomStrength", "uDepth", "uShaft", "uShaftColor"])
      };
      programs = res.programs;
      rigPrograms = null; rigProgramsReady = false; rigFailure = null;
      res.quadVao = gl.createVertexArray();
    };
    const prepareRigPrograms = () => {
      if (rigPrograms) return;
      rigProgramsRequested = true;
      const matrixSampling = gl.getExtension("OES_shader_multisample_interpolation");
      const fragment = matrixSampling ? MESH_FS.replace("#version 300 es", "#version 300 es\n#extension GL_OES_shader_multisample_interpolation : require\n#define MATRIX_SAMPLE_INTERPOLATION") : MESH_FS;
      rigPrograms = { ...res.programs,
        mesh: compile(MESH_VS, fragment, res.programs.mesh.sourceUniforms),
        shadow: compile(SHADOW_VS, SHADOW_FS, res.programs.shadow.sourceUniforms) };
    };
    const pollRigPrograms = () => {
      if (rigProgramsReady) return true;
      if (!rigPrograms || failure || rigFailure) return false;
      const mesh = rigPrograms.mesh, shadow = rigPrograms.shadow;
      if (parallel && (!gl.getProgramParameter(mesh.prog, parallel.COMPLETION_STATUS_KHR)
        || !gl.getProgramParameter(shadow.prog, parallel.COMPLETION_STATUS_KHR))) return false;
      // An optional rig link failure (GPU uniform pressure) costs only rig mode: the
      // renderer-wide failure state stays clean and the CPU path draws the same geometry.
      try { finishProgram(mesh); finishProgram(shadow); rigProgramsReady = true; }
      catch (err) { rigFailure = err; }
      return rigProgramsReady;
    };
    const createRendererRig = (nodes) => {
      const geometry = createRig(nodes);
      if (geometry) prepareRigPrograms();
      return geometry;
    };
    const pollPrograms = () => {
      if (ready || failure) return ready;
      const list = Object.values(res.programs);
      if (parallel && !list.every((p) => gl.getProgramParameter(p.prog, parallel.COMPLETION_STATUS_KHR))) return false;
      try {
        for (const p of list) finishProgram(p);
        ready = true;
      } catch (err) {
        failure = err;
      }
      return ready;
    };
    const createTexture = (w, h, internal, filter) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    const buildMatrixTexture = () => {
      const width = 48, height = 7, data = new Uint8Array(width * height);
      for (let glyph = 0; glyph < MATRIX_MASKS.length; glyph++) {
        const mask = MATRIX_MASKS[glyph];
        for (let bit = 0; bit < 24; bit++) {
          if (!((mask >> bit) & 1)) continue;
          const x = glyph * 6 + 1 + (bit & 3), y = 5 - (bit >> 2);
          data[y * width + x] = 255;
        }
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      res.matrixTexture = tex;
    };
    const bindMatrixTexture = (program) => {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, res.matrixTexture);
      gl.uniform1i(program.u.uMatrixGlyphTex, 3);
      gl.activeTexture(gl.TEXTURE0);
    };
    const createRenderbuffer = (w, h, internal, samples) => {
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      if (samples > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internal, w, h);
      else gl.renderbufferStorage(gl.RENDERBUFFER, internal, w, h);
      return rb;
    };
    const destroyMirrorTarget = () => {
      if (!mirror.fb) return;
      gl.deleteTexture(mirror.tex);
      gl.deleteRenderbuffer(mirror.depth);
      gl.deleteFramebuffer(mirror.fb);
      mirror.captureValid = mirrorDebug.captureValid = false;
      mirrorDebug.resources -= 3;
      mirror.fb = mirror.tex = mirror.depth = null;
      mirror.width = mirror.height = mirror.renderWidth = mirror.renderHeight = 0;
      mirrorDebug.width = mirrorDebug.height = mirrorDebug.textureWidth = mirrorDebug.textureHeight = mirrorDebug.samples = 0;
    };
    const destroyReflector = (geometry) => {
      const t = reflectorTargets.get(geometry);
      if (!t) return;
      if (t.fb) {
        gl.deleteTexture(t.tex);
        gl.deleteRenderbuffer(t.depth);
        gl.deleteFramebuffer(t.fb);
        mirrorDebug.resources -= 3;
      }
      reflectorTargets.delete(geometry);
    };
    const reflectorTarget = (geometry) => {
      let t = reflectorTargets.get(geometry);
      if (!t) reflectorTargets.set(geometry, t = { fb: null, tex: null, depth: null, size: 0, renderWidth: 0, renderHeight: 0, viewProj: new Float32Array(16), valid: false, area: 0, record: null });
      return t;
    };
    // One square allocation per reflector at the tier's mirror size, as the mirror keeps.
    const ensureReflectorTarget = (t) => {
      const size = settings.mirror;
      if (t.fb && t.size === size) return;
      if (t.fb) {
        gl.deleteTexture(t.tex);
        gl.deleteRenderbuffer(t.depth);
        gl.deleteFramebuffer(t.fb);
        mirrorDebug.resources -= 3;
      }
      t.tex = createTexture(size, size, gl.RGBA8, gl.LINEAR);
      t.depth = createRenderbuffer(size, size, gl.DEPTH_COMPONENT24, 0);
      t.fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      mirrorDebug.resources += 3;
      t.size = size;
      t.valid = false;
    };
    const destroyEnvironment = () => {
      if (!environment.fb) return;
      gl.deleteTexture(environment.tex);
      gl.deleteRenderbuffer(environment.depth);
      gl.deleteFramebuffer(environment.fb);
      environment.fb = environment.tex = environment.depth = null;
      environment.size = environment.valid = environment.next = environment.frame = 0;
      mirrorDebug.environmentFaces = mirrorDebug.environmentSize = mirrorDebug.environmentResources = 0;
      mirrorDebug.resources -= 3;
    };
    const ensureEnvironment = (clear) => {
      if (environment.size === settings.environment) return;
      destroyEnvironment();
      const size = environment.size = settings.environment;
      environment.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, environment.tex);
      for (let face = 0; face < 6; face++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      environment.depth = createRenderbuffer(size, size, gl.DEPTH_COMPONENT24, 0);
      environment.fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, environment.fb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, environment.depth);
      gl.drawBuffers(DRAW_COLOR);
      gl.clearColor(clear[0], clear[1], clear[2], 1);
      for (let face = 0; face < 6; face++) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, environment.tex, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      mirrorDebug.resources += 3;
      mirrorDebug.environmentResources = 3;
      mirrorDebug.environmentSize = size;
      mirrorDebug.allocationCount++;
    };
    // One square allocation survives camera motion and viewport resizes. Each
    // capture uses only the mirror's current projected footprint inside it.
    const ensureMirrorTarget = () => {
      const cap = settings.mirror;
      const w = cap, h = cap;
      if (mirror.fb && mirror.width === w && mirror.height === h) return;
      // Camera preparation already chose this frame's viewport. Replacing
      // the backing texture must not erase it before the capture is drawn.
      const renderWidth = mirror.renderWidth, renderHeight = mirror.renderHeight;
      destroyMirrorTarget();
      mirror.renderWidth = mirrorDebug.width = renderWidth;
      mirror.renderHeight = mirrorDebug.height = renderHeight;
      mirror.tex = createTexture(w, h, gl.RGBA8, gl.LINEAR);
      mirror.depth = createRenderbuffer(w, h, gl.DEPTH_COMPONENT24, 0);
      mirror.fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, mirror.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mirror.tex, 0);
      mirrorDebug.resources += 3;
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, mirror.depth);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      mirror.width = mirrorDebug.textureWidth = w;
      mirror.height = mirrorDebug.textureHeight = h;
      mirrorDebug.samples = 0;
      mirrorDebug.allocationCount++;
    };
    const destroyMirror = () => {
      destroyEnvironment();
      if (environment.program) {
        for (const shader of environment.program.shaders) gl.deleteShader(shader);
        gl.deleteProgram(environment.program.prog);
        environment.program = null;
        environment.ready = false;
        mirrorDebug.resources--;
      }
      destroyMirrorTarget();
      destroyMirrorProgram();
      if (mirror.bodyTex) {
        gl.deleteTexture(mirror.bodyTex);
        mirrorDebug.resources--;
      }
      mirror.bodyTex = mirror.bodyState = null;
      mirror.bodyVersion = -1;
      mirror.node = mirror.record = mirror.geometry = null;
      mirror.portal = mirror.frontFacing = mirror.walkThrough = false;
      mirrorDebug.active = false;
      mirrorDebug.portal = false;
      mirrorDebug.surfaceDrawn = false;
      mirrorDebug.captureExcluded = false;
      mirrorDebug.reflectionOnlyCount = 0;
      mirrorDebug.ripples = 0;
      mirrorDebug.bodyContacts = mirrorDebug.bodyWaves = 0;
      mirror.shards = mirrorDebug.shardsDrawn = 0;
    };
    const forgetMirror = () => {
      environment.program = null;
      environment.ready = false;
      environment.fb = environment.tex = environment.depth = null;
      environment.size = environment.valid = environment.next = environment.frame = 0;
      mirrorDebug.environmentFaces = mirrorDebug.environmentSize = mirrorDebug.environmentResources = 0;
      mirror.node = mirror.record = mirror.geometry = mirror.program = mirror.fb = mirror.tex = mirror.depth = mirror.bodyTex = mirror.bodyState = null;
      reflectorTargets.clear();
      mirror.bodyVersion = -1;
      mirror.programReady = false;
      mirror.width = mirror.height = mirror.renderWidth = mirror.renderHeight = 0;
      mirrorDebug.width = mirrorDebug.height = mirrorDebug.textureWidth = mirrorDebug.textureHeight = mirrorDebug.samples = 0;
      mirror.portal = mirror.frontFacing = mirror.walkThrough = mirror.captureValid = false;
      mirrorDebug.active = false;
      mirrorDebug.portal = mirrorDebug.captureValid = false;
      mirrorDebug.surfaceDrawn = false;
      mirrorDebug.captureExcluded = false;
      mirrorDebug.reflectionOnlyCount = 0;
      mirrorDebug.ripples = 0;
      mirrorDebug.bodyContacts = mirrorDebug.bodyWaves = 0;
      mirrorDebug.resources = 0;
      mirror.shards = mirrorDebug.shardsDrawn = 0;
    };
    const destroyFbo = () => {
      const f = res.fbo;
      if (!f) return;
      for (const t of f.textures) gl.deleteTexture(t);
      for (const r of f.renderbuffers) gl.deleteRenderbuffer(r);
      for (const b of f.framebuffers) gl.deleteFramebuffer(b);
      res.fbo = null;
    };
    const buildFbo = () => {
      const samples = Math.min(settings.msaa, maxSamples);
      const previous = res.fbo;
      if (previous && previous.width === pw && previous.height === ph && previous.samples === samples &&
          previous.bloom === settings.bloom && previous.shafts === settings.shafts) return;
      destroyFbo();
      const f = { textures: [], renderbuffers: [], framebuffers: [], samples,
        width: pw, height: ph, bloom: settings.bloom, shafts: settings.shafts };
      f.color = createTexture(pw, ph, gl.RGBA8, gl.LINEAR);
      f.bright = createTexture(pw, ph, gl.RGBA8, gl.LINEAR);
      f.textures.push(f.color, f.bright);
      f.resolve = gl.createFramebuffer();
      f.framebuffers.push(f.resolve);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.resolve);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, f.bright, 0);
      if (samples > 0) {
        f.scene = gl.createFramebuffer();
        f.framebuffers.push(f.scene);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.scene);
        const c0 = createRenderbuffer(pw, ph, gl.RGBA8, samples);
        const c1 = createRenderbuffer(pw, ph, gl.RGBA8, samples);
        const d = createRenderbuffer(pw, ph, gl.DEPTH_COMPONENT24, samples);
        f.renderbuffers.push(c0, c1, d);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, c1);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
        if (settings.shafts) {
          // Sun shafts read a single-sample copy of the depth, blitted after the scene resolves.
          f.depth = createTexture(pw, ph, gl.DEPTH_COMPONENT24, gl.NEAREST);
          f.depthFb = gl.createFramebuffer();
          f.textures.push(f.depth);
          f.framebuffers.push(f.depthFb);
          gl.bindFramebuffer(gl.FRAMEBUFFER, f.depthFb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, f.depth, 0);
          gl.drawBuffers([gl.NONE]);
        }
      } else {
        f.scene = f.resolve;
        f.depth = createTexture(pw, ph, gl.DEPTH_COMPONENT24, gl.NEAREST);
        f.textures.push(f.depth);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, f.depth, 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.scene);
      gl.drawBuffers(DRAW_BOTH);
      const bw = Math.max(1, pw >> 2), bh = Math.max(1, ph >> 2);
      f.bloomW = bw;
      f.bloomH = bh;
      f.ping = [];
      for (let i = 0; i < 2; i++) {
        const tex = createTexture(bw, bh, gl.RGBA8, gl.LINEAR);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        f.textures.push(tex);
        f.framebuffers.push(fb);
        f.ping.push({ tex, fb });
      }
      const target = (w, h, internal) => {
        const tex = createTexture(w, h, internal, gl.LINEAR);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        f.textures.push(tex);
        f.framebuffers.push(fb);
        return { tex, fb };
      };
      // The wide bloom level at an eighth of the frame gives lamps the broad halo the quarter level cannot.
      f.wideW = Math.max(1, bw >> 1);
      f.wideH = Math.max(1, bh >> 1);
      f.wide = settings.bloom ? [target(f.wideW, f.wideH, gl.RGBA8), target(f.wideW, f.wideH, gl.RGBA8)] : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      res.fbo = f;
    };
    const destroyShadow = () => {
      const s = res.shadow;
      if (!s) return;
      gl.deleteTexture(s.tex);
      gl.deleteFramebuffer(s.fb);
      gl.deleteTexture(s.staticTex);
      gl.deleteFramebuffer(s.staticFb);
      res.shadow = null;
    };
    const buildShadow = () => {
      destroyShadow();
      const size = settings.shadow;
      const target = () => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
        return { tex, fb };
      };
      const work = target(), baked = target();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      res.shadow = { tex: work.tex, fb: work.fb, staticTex: baked.tex, staticFb: baked.fb, size };
      shadowStaticValid = false;
    };
    const deleteRecord = (rec) => {
      if (rec.active) {
        const index = activeRecords.indexOf(rec);
        if (index >= 0) activeRecords.splice(index, 1);
        rec.active = false;
      }
      if (rec.mesh) {
        gl.deleteVertexArray(rec.mesh.vao);
        gl.deleteBuffer(rec.mesh.vbo);
      }
      if (rec.line) {
        gl.deleteVertexArray(rec.line.vao);
        gl.deleteBuffer(rec.line.vbo);
      }
      gl.deleteBuffer(rec.ibo);
      if (rec.imageTexture) { gl.deleteTexture(rec.imageTexture); imageTextures--; rec.imageTexture = null; }
      if (rec.rippleBodyTexture) { gl.deleteTexture(rec.rippleBodyTexture); rippleBodyTextures--; rec.rippleBodyTexture = null; }
      rec.rippleBodyState = null;
      rec.nodes.length = 0;
      rec.batch = null;
      rec.data = null;
    };
    const destroyRecords = () => {
      for (const rec of records.values()) deleteRecord(rec);
      records.clear();
      activeRecords.length = 0;
    };
    const bindInstanceAttribs = (ibo) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
      for (let i = 0; i < 5; i++) {
        const loc = 3 + i;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, i * 16);
        gl.vertexAttribDivisor(loc, 1);
      }
    };
    const makePart = (data, floatsPerVertex, layout, ibo) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      let offset = 0;
      for (const [loc, size] of layout) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, floatsPerVertex * 4, offset * 4);
        offset += size;
      }
      bindInstanceAttribs(ibo);
      gl.bindVertexArray(null);
      return { vao, vbo, count: data.length / floatsPerVertex };
    };
    const buildMeshPart = (geometry, ibo, dataOnly = false) => {
      const { verts, faces } = geometry;
      let triCount = 0;
      for (const f of faces) triCount += f.i.length - 2;
      if (!triCount) return null;
      const source = geometry.mirrorSource, stride = source ? MESH_STRIDE + 3 : MESH_STRIDE;
      // A voxel geometry names its grid; a face whose corners all sit on it gets block detail, flagged by a doubled
      // normal. Faces moved off the grid after the build (a shift, a scale, a merged prop) simply go without.
      const voxel = geometry.voxel || null;
      const onGrid = (idx) => {
        for (let a = 0; a < 3; a++) {
          const t = (verts[idx * 3 + a] - voxel[1 + a]) / voxel[0];
          if (Math.abs(t - Math.round(t)) > 1e-3) return false;
        }
        return true;
      };
      let gridded = 0;
      const out = new Float32Array(triCount * 3 * stride);
      // A `smooth` geometry shades with vertex normals: each face's area-weighted Newell normal summed into the
      // vertices it uses, once at upload (cartoon foliage reads as soft round clumps, not facets).
      const smooth = geometry.smooth ? new Float32Array(verts.length) : null;
      // `normals` (one per vertex, all zeros for "not set") wins over both: foliage cards light as one soft mass by
      // taking the direction out of their canopy instead of their own facing.
      const given = geometry.normals || null;
      if (smooth) for (const f of faces) {
        let nx = 0, ny = 0, nz = 0;
        for (let k = 0, m = f.i.length; k < m; k++) {
          const a = f.i[k] * 3, b = f.i[(k + 1) % m] * 3;
          nx += (verts[a + 1] - verts[b + 1]) * (verts[a + 2] + verts[b + 2]);
          ny += (verts[a + 2] - verts[b + 2]) * (verts[a] + verts[b]);
          nz += (verts[a] - verts[b]) * (verts[a + 1] + verts[b + 1]);
        }
        for (const idx of f.i) { smooth[idx * 3] += nx; smooth[idx * 3 + 1] += ny; smooth[idx * 3 + 2] += nz; }
      }
      let o = 0;
      const put = (idx, nx, ny, nz, c, e) => {
        const b = idx * 3;
        out[o++] = verts[b];
        out[o++] = verts[b + 1];
        out[o++] = verts[b + 2];
        if (given && (given[b] || given[b + 1] || given[b + 2])) {
          nx = given[b]; ny = given[b + 1]; nz = given[b + 2];
        } else if (smooth) {
          const l = Math.hypot(smooth[b], smooth[b + 1], smooth[b + 2]) || 1;
          nx = smooth[b] / l; ny = smooth[b + 1] / l; nz = smooth[b + 2] / l;
        }
        out[o++] = nx;
        out[o++] = ny;
        out[o++] = nz;
        out[o++] = c[0] / 255;
        out[o++] = c[1] / 255;
        out[o++] = c[2] / 255;
        out[o++] = e;
        if (source) { out[o++] = source[b]; out[o++] = source[b + 1]; out[o++] = source[b + 2]; }
      };
      for (const f of faces) {
        // Newell's method, stable when leading vertices coincide.
        let nx = 0, ny = 0, nz = 0;
        for (let k = 0, m = f.i.length; k < m; k++) {
          const a = f.i[k] * 3, b = f.i[(k + 1) % m] * 3;
          nx += (verts[a + 1] - verts[b + 1]) * (verts[a + 2] + verts[b + 2]);
          ny += (verts[a + 2] - verts[b + 2]) * (verts[a] + verts[b]);
          nz += (verts[a] - verts[b]) * (verts[a + 1] + verts[b + 1]);
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        // Water, lava, roads and transparent lake water: three, four, five and six times over.
        const surface = f.water === "aegean" ? 7 : f.lake ? 6 : f.water === "lava" ? 4 : f.water ? 3 : f.road ? 5 : 0;
        if (surface) {
          nx *= surface;
          ny *= surface;
          nz *= surface;
        } else if (voxel && f.i.every(onGrid)) {
          nx *= 2;
          ny *= 2;
          nz *= 2;
          gridded++;
        }
        const emissive = f.emissive || 0;
        const e = f.matrixCave || f.matrixLocalGlyphSurface || f.matrixWorldGlyphSurface || f.matrixPermanentFallback ? -1 - (f.matrixCave || 0) * 2 - (f.matrixWorldGlyphSurface ? 32 : 0) - (f.matrixPermanentFallback ? 64 : 0) - emissive : emissive;
        for (let k = 1; k < f.i.length - 1; k++) {
          put(f.i[0], nx, ny, nz, f.color, e);
          put(f.i[k], nx, ny, nz, f.color, e);
          put(f.i[k + 1], nx, ny, nz, f.color, e);
        }
      }
      if (dataOnly) return { data: out, voxel: gridded ? voxel : null };
      const part = makePart(out, stride, source ? [[0, 3], [1, 3], [2, 4], [9, 3]] : [[0, 3], [1, 3], [2, 4]], ibo);
      part.voxel = gridded ? voxel : null;
      return part;
    };
    const buildRigPart = (rig, ibo) => {
      const parts = rig.sources.map(geometry => buildMeshPart(geometry, ibo, true));
      let length = 0;
      for (const part of parts) length += part ? part.data.length / MESH_STRIDE * (MESH_STRIDE + 1) : 0;
      const data = new Float32Array(length);
      let offset = 0;
      for (let joint = 0; joint < parts.length; joint++) {
        const part = parts[joint];
        if (!part) continue;
        if (part.voxel) rig.voxels.set(part.voxel, joint * 4);
        for (let i = 0; i < part.data.length; i += MESH_STRIDE) {
          for (let k = 0; k < MESH_STRIDE; k++) data[offset++] = part.data[i + k];
          data[offset++] = joint;
        }
      }
      return makePart(data, MESH_STRIDE + 1, [[0, 3], [1, 3], [2, 4], [8, 1]], ibo);
    };
    const LINE_CORNERS = [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]];
    const buildLinePart = (geometry, ibo) => {
      const { verts, lines } = geometry;
      if (!lines || !lines.length) return null;
      const out = new Float32Array(lines.length * 6 * LINE_STRIDE);
      let o = 0;
      for (const l of lines) {
        const a = l.i[0] * 3, b = l.i[1] * 3;
        for (const [end, side] of LINE_CORNERS) {
          out[o++] = verts[a];
          out[o++] = verts[a + 1];
          out[o++] = verts[a + 2];
          out[o++] = verts[b];
          out[o++] = verts[b + 1];
          out[o++] = verts[b + 2];
          out[o++] = end;
          out[o++] = side;
          out[o++] = l.color[0] / 255;
          out[o++] = l.color[1] / 255;
          out[o++] = l.color[2] / 255;
          out[o++] = l.emissive || 0;
        }
      }
      const part = makePart(out, LINE_STRIDE, [[0, 3], [1, 3], [2, 2], [8, 4]], ibo);
      part.width = geometry.lineWidth || 1.5;
      return part;
    };
    const recordFor = (geometry) => {
      let rec = records.get(geometry);
      if (!rec) {
        const ibo = gl.createBuffer();
        rec = { geometry, ibo, capacity: 0, mesh: geometry.meshRig ? buildRigPart(geometry.meshRig, ibo) : buildMeshPart(geometry, ibo), line: buildLinePart(geometry, ibo), nodes: [], spheres: new Float64Array(4), count: 0, drawCount: 0, cameraHiddenCount: 0, active: false, data: null, batch: null, batchVersion: -1, lightVisible: true, mirrorVisible: true, imageTexture: null, rippleBodyTexture: null, rippleBodyState: null, rippleBodyVersion: -1, shadowChanged: 0, shadowSettle: SHADOW_SETTLE, shadowCount: -1, shadowClip: NaN, shadowStatic: false, shadowBake: -1 };
        records.set(geometry, rec);
      }
      return rec;
    };
    // Gribb-Hartmann planes of a column-major view-projection: left, right, bottom, top, near, far.
    const extractFrustum = (m, planes = FRUSTUM) => {
      for (let i = 0; i < 6; i++) {
        const row = i >> 1, sign = i & 1 ? -1 : 1, o = i * 4;
        const a = m[3] + sign * m[row], b = m[7] + sign * m[4 + row], c = m[11] + sign * m[8 + row], d = m[15] + sign * m[12 + row];
        const len = Math.hypot(a, b, c) || 1;
        planes[o] = a / len;
        planes[o + 1] = b / len;
        planes[o + 2] = c / len;
        planes[o + 3] = d / len;
      }
    };
    const sphereInFrustum = (x, y, z, r, planes = FRUSTUM) => {
      for (let i = 0; i < 24; i += 4) {
        if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
      }
      return true;
    };
    // Camera, shadow and mirror passes test the same world sphere: collect computes it once into the record's
    // `spheres` (x, y, z, r at four times the node's slot, moved with it). Never onto the node: a float field read
    // or written on the graph's many node shapes boxes a new number every time.
    const writeCullSphere = (node, out, o) => {
      const b = boundsOf(node.geometry), w = node.world;
      mat4.transformPoint(CENTER, w, b.center[0], b.center[1], b.center[2]);
      const scale = Math.max(w[0] * w[0] + w[1] * w[1] + w[2] * w[2], w[4] * w[4] + w[5] * w[5] + w[6] * w[6], w[8] * w[8] + w[9] * w[9] + w[10] * w[10]);
      out[o] = CENTER[0];
      out[o + 1] = CENTER[1] + (node.matrixCloud ? Math.min(0, cutawayCloudY - w[13]) * cutawayCloudMix : 0);
      out[o + 2] = CENTER[2];
      out[o + 3] = b.radius * Math.sqrt(scale) + CULL_MARGIN + (node.geometry.lakeWaves ? 0.18 : 0);
    };
    const writeRigCullSphere = (node, out, o) => {
      const rig = node.geometry.meshRig;
      if (!rig) { writeCullSphere(node, out, o); return; }
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let j = 0; j < rig.nodes.length; j++) {
        const joint = rig.nodes[j];
        const b = boundsOf(joint.geometry), w = joint.world;
        mat4.transformPoint(CENTER, w, b.center[0], b.center[1], b.center[2]);
        const scale = Math.sqrt(Math.max(w[0] * w[0] + w[1] * w[1] + w[2] * w[2], w[4] * w[4] + w[5] * w[5] + w[6] * w[6], w[8] * w[8] + w[9] * w[9] + w[10] * w[10]));
        const radius = b.radius * scale + CULL_MARGIN;
        minX = Math.min(minX, CENTER[0] - radius); maxX = Math.max(maxX, CENTER[0] + radius);
        minY = Math.min(minY, CENTER[1] - radius); maxY = Math.max(maxY, CENTER[1] + radius);
        minZ = Math.min(minZ, CENTER[2] - radius); maxZ = Math.max(maxZ, CENTER[2] + radius);
      }
      out[o] = (minX + maxX) / 2; out[o + 1] = (minY + maxY) / 2; out[o + 2] = (minZ + maxZ) / 2;
      out[o + 3] = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    };
    const slotInFrustum = (s, o, planes) => {
      const x = s[o], y = s[o + 1], z = s[o + 2], r = s[o + 3];
      for (let i = 0; i < 24; i += 4) {
        if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z + planes[i + 3] < -r) return false;
      }
      return true;
    };
    // The node in slot i takes the next slot of the draw region, its sphere with it.
    const drawSlot = (rec, i) => {
      const j = rec.drawCount++, nodes = rec.nodes, s = rec.spheres, node = nodes[i];
      nodes[i] = nodes[j];
      nodes[j] = node;
      for (let k = 0; k < 4; k++) {
        const t = s[i * 4 + k];
        s[i * 4 + k] = s[j * 4 + k];
        s[j * 4 + k] = t;
      }
    };
    // Shadow and mirror draw every instance of a record; one wholly outside that pass's clip volume skips the
    // draw call, partial records draw in full.
    const markLightVisible = () => {
      for (const rec of activeRecords) {
        if (rec.geometry.castShadow === false) continue;
        const sphere = rec.batch && rec.batch.cullSphere;
        let visible = rec.batch ? !sphere || sphereInFrustum(sphere[0], sphere[1], sphere[2], sphere[3] + CULL_MARGIN, LIGHT_FRUSTUM) : false;
        for (let i = 0; !rec.batch && !visible && i < rec.count; i++) visible = slotInFrustum(rec.spheres, i * 4, LIGHT_FRUSTUM);
        rec.lightVisible = visible;
      }
    };
    // A caster is static once its instances, count and clip have held for its settle time. True when the
    // static set differs from the one baked (a promotion, a demotion, or a baked record gone from the pass).
    const markShadowStatic = () => {
      let baked = 0, changed = false;
      for (const rec of activeRecords) {
        const n = rec.batch && rec.batch.drawInstanceCount !== undefined ? rec.drawCount : rec.count, clip = rec.geometry.clipMinY ?? -1e6;
        if (n !== rec.shadowCount || clip !== rec.shadowClip) {
          rec.shadowCount = n;
          rec.shadowClip = clip;
          rec.shadowChanged = shadowFrame;
        }
        rec.shadowStatic = shadowFrame - rec.shadowChanged >= rec.shadowSettle && n > 0 && !!rec.mesh && rec.lightVisible && rec.geometry.castShadow !== false && !rec.geometry.mirrorRippleOnly;
        const was = rec.shadowBake === shadowBake;
        if (was) baked++;
        if (was !== rec.shadowStatic) changed = true;
      }
      return changed || baked !== shadowBakedCount;
    };
    const markMirrorVisible = () => {
      for (const rec of activeRecords) {
        const sphere = rec.batch && rec.batch.cullSphere;
        let visible = rec.batch ? !sphere || sphereInFrustum(sphere[0], sphere[1], sphere[2], sphere[3] + CULL_MARGIN, MIRROR_FRUSTUM) : false;
        for (let i = 0; !rec.batch && !visible && i < rec.count; i++) visible = slotInFrustum(rec.spheres, i * 4, MIRROR_FRUSTUM);
        rec.mirrorVisible = visible;
      }
    };
    const collect = (node) => {
      if (!node.geometry || !rigMode && node.geometry.meshRig || hiddenFromCutaway(node) || cutawayFade === 1 && node.geometry.cutawayHide) return;
      if (node.mirror || node.mirrorPortal) {
        if (mirror.node) throw new Error("A scene may contain at most one mirror node");
        mirror.node = node;
        mirror.geometry = node.geometry;
        mirror.portal = !!node.mirrorPortal;
        mirror.reveal = Math.max(0, Math.min(1, node.mirrorReveal || 0));
        mirror.walkThrough = !!node.mirrorWalkThrough;
        mirrorDebug.active = true;
        mirrorDebug.portal = mirror.portal;
        mirrorDebug.reveal = mirror.reveal;
      }
      const rec = recordFor(node.geometry);
      if (node.mirror || node.mirrorPortal) mirror.record = rec;
      if (node.geometry.reflector) {
        reflectorNodes.push(node);
        reflectorTarget(node.geometry).record = rec;
      }
      if (!rec.active) {
        rec.active = true;
        rec.count = 0;
        rec.drawCount = 0;
        rec.cameraHiddenCount = 0;
        activeRecords[activeCount++] = rec;
      }
      if (node.instanceData) {
        rec.batch = node;
        rec.count = node.instanceCount;
        rec.drawCount = node.drawInstanceCount === undefined ? rec.count : Math.max(0, Math.min(rec.count, node.drawInstanceCount));
        suppressed += rec.count - rec.drawCount;
        rec.offscreen = !!node.cullSphere && !sphereInFrustum(node.cullSphere[0], node.cullSphere[1], node.cullSphere[2], node.cullSphere[3] + CULL_MARGIN);
        return;
      }
      // In-frustum nodes stay in front of the culled ones by swapping into the draw region.
      const idx = rec.count++;
      rec.nodes[idx] = node;
      if (rec.spheres.length < rec.count * 4) {
        const grown = new Float64Array(Math.max(rec.count * 4, rec.spheres.length * 2));
        grown.set(rec.spheres);
        rec.spheres = grown;
      }
      // Camera-hidden nodes still cast shadows and appear in the mirror.
      cullForRender(node, rec.spheres, idx * 4);
      if (node.smokeOpacity === 0 || hiddenFromCamera(node)) {
        rec.cameraHiddenCount++;
        suppressed++;
      } else if (slotInFrustum(rec.spheres, idx * 4, FRUSTUM)) drawSlot(rec, idx);
      else culled++;
    };
    const collectRig = (node) => { if (!node.meshRigSource) collect(node); };
    const updateRig = (rec) => {
      const rig = rec.geometry.meshRig;
      if (!rig) return;
      let moved = false;
      for (let i = 0; i < rig.nodes.length; i++) {
        const node = rig.nodes[i];
        // Race pose keeps these geometries immutable; fail rather than drawing a stale mesh.
        if (node.geometry !== rig.sources[i]) throw new Error("A mesh rig joint changed geometry");
        let visible = !hiddenFromCutaway(node);
        for (let parent = node; visible && parent; parent = parent.parent) visible = parent.visible;
        const camera = visible && !hiddenFromCamera(node) && node.smokeOpacity !== 0 ? 1 : 0, shadow = visible && node.geometry.castShadow !== false ? 1 : 0;
        if (rig.visibility[i * 3] !== camera || rig.visibility[i * 3 + 1] !== shadow || rig.visibility[i * 3 + 2] !== (visible ? 1 : 0)) moved = true;
        rig.visibility[i * 3] = camera; rig.visibility[i * 3 + 1] = shadow; rig.visibility[i * 3 + 2] = visible ? 1 : 0;
        for (let k = 0; k < 16; k++) {
          const value = Math.fround(node.world[k]), index = i * 16 + k;
          if (rig.matrices[index] !== value) { rig.matrices[index] = value; moved = true; }
        }
        const p = i * 4;
        rig.params[p] = node.ember > 0 ? -node.ember : node.glow;
        rig.params[p + 1] = node.scorch > 0 ? -node.scorch : node.highlight;
        rig.params[p + 2] = node.smokeOpacity === undefined ? matrixModeOf(node) : -1 - node.smokeOpacity;
        rig.params[p + 3] = 0;
      }
      if (moved) rec.shadowChanged = shadowFrame;
    };
    const applyRig = (program, rec, pass) => {
      const rig = rec.geometry.meshRig;
      if (program.rig !== rig) {
        gl.uniform1i(program.u.uRigCount, rig ? rig.nodes.length : 0);
        program.rig = rig;
      }
      if (!rig) return;
      gl.uniform1i(program.u.uRigPass, pass);
      gl.uniformMatrix4fv(program.u.uRigMatrices, false, rig.matrices);
      gl.uniform3fv(program.u.uRigVisibility, rig.visibility);
      if (program === programs.mesh) {
        gl.uniform4fv(program.u.uRigParams, rig.params);
        gl.uniform4fv(program.u.uRigVoxels, rig.voxels);
      }
    };
    const uploadInstances = (rec) => {
      const need = rec.count * INSTANCE_FLOATS;
      if (rec.batch) {
        // A reserved pool that has never held an instance owns no GPU memory until it does;
        // empty cave batches cost nothing until the wave arrives.
        if (!need && !rec.capacity) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, rec.ibo);
        // Fixed-capacity systems reserve their bounded upload once; variable batches grow geometrically.
        const cap = rec.batch.fixedInstanceCapacity ? rec.batch.instanceData.length : Math.min(rec.batch.instanceData.length, Math.max(need, rec.capacity * 2));
        if (rec.capacity < cap) {
          gl.bufferData(gl.ARRAY_BUFFER, cap * 4, gl.DYNAMIC_DRAW);
          rec.capacity = cap;
          rec.batchVersion = -1;
        }
        if (rec.batchVersion !== rec.batch.instanceVersion) {
          // WebGL treats a zero source length as "the rest of the array": empty cave batches must not upload their
          // whole reserved pool on restore.
          if (need > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, rec.batch.instanceData, 0, need);
          rec.batchVersion = rec.batch.instanceVersion;
          rec.shadowChanged = shadowFrame;
        }
        return;
      }
      if (!rec.data || rec.data.length < need) {
        rec.data = new Float32Array(Math.max(need, (rec.data ? rec.data.length : 0) * 2, INSTANCE_FLOATS));
      }
      // The buffer mirrors rec.data exactly, so an unchanged block (static props, resting crew) needs no upload.
      const d = rec.data;
      // One moving node in a shared record uploads only its own span.
      let lo = need, hi = 0, moved = false;
      for (let i = 0; i < rec.count; i++) {
        const n = rec.nodes[i], w = n.world;
        const o = i * INSTANCE_FLOATS;
        let dirty = false;
        const cloudOffset = n.matrixCloud ? Math.min(0, cutawayCloudY - w[13]) * cutawayCloudMix : 0;
        for (let j = 0; j < 16; j++) {
          const value = j === 13 && cloudOffset ? Math.fround(w[j] + cloudOffset) : w[j];
          if (d[o + j] !== value) { d[o + j] = value; dirty = moved = true; }
        }
        // Sign-encoded fire/smoke in the cached upload: negative glow = ember, negative highlight = scorch,
        // mode = -1 - smokeOpacity.
        const portal = !!rec.geometry.portalSurface;
        const glow = Math.fround(portal ? n.portalTime : n.ember > 0 ? -n.ember : n.glow), highlight = Math.fround(portal ? n.portalSurge : n.scorch > 0 ? -n.scorch : n.highlight);
        const mode = portal ? (rec.geometry.portalRect ? 7 : 6) : Math.fround(n.smokeOpacity === undefined ? matrixModeOf(n) : -1 - n.smokeOpacity);
        if (d[o + 16] !== glow) { d[o + 16] = glow; dirty = true; }
        if (d[o + 17] !== highlight) { d[o + 17] = highlight; dirty = true; }
        if (d[o + 18] !== mode) { d[o + 18] = mode; dirty = true; }
        const reveal = portal ? Math.fround(n.portalReveal) : 0;
        if (d[o + 19] !== reveal) { d[o + 19] = reveal; dirty = true; }
        if (dirty) {
          if (o < lo) lo = o;
          if (o + INSTANCE_FLOATS > hi) hi = o + INSTANCE_FLOATS;
        }
      }
      // Shadow depth reads only the transform, so glow and mode changes leave a caster static.
      if (moved) rec.shadowChanged = shadowFrame;
      if (rec.capacity < d.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, rec.ibo);
        gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
        rec.capacity = d.length;
      } else if (hi > lo) {
        gl.bindBuffer(gl.ARRAY_BUFFER, rec.ibo);
        gl.bufferSubData(gl.ARRAY_BUFFER, lo * 4, d, lo, hi - lo);
      }
    };
    const uploadRigInstances = (rec) => { updateRig(rec); uploadInstances(rec); };
    const skipMirrorPass = (reason) => {
      mirrorDebug.skippedPassCount++;
      mirrorDebug.skipReason = reason;
      return false;
    };
    const reflectMirrorPoint = (out, point, center, normal) => {
      const d = (point.x - center[0]) * normal[0] + (point.y - center[1]) * normal[1] + (point.z - center[2]) * normal[2];
      out.x = point.x - 2 * d * normal[0];
      out.y = point.y - 2 * d * normal[1];
      out.z = point.z - 2 * d * normal[2];
    };
    // NDC bounds of the mirror's vertices under a view-projection; false when none lie in front.
    const mirrorRect = (node, vp) => {
      const verts = (node.mirrorCaptureGeometry || node.geometry).verts, world = node.world;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = false;
      for (let i = 0; i < verts.length; i += 3) {
        mat4.transformPoint(MIRROR_POINT, world, verts[i], verts[i + 1], verts[i + 2]);
        mat4.transformPoint4(MIRROR_CLIP, vp, MIRROR_POINT[0], MIRROR_POINT[1], MIRROR_POINT[2]);
        if (MIRROR_CLIP[3] <= MIRROR_EPSILON) { behind = true; continue; }
        const x = MIRROR_CLIP[0] / MIRROR_CLIP[3], y = MIRROR_CLIP[1] / MIRROR_CLIP[3];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (minX === Infinity) return false;
      // An aperture crossing the eye plane can cover the viewport even when
      // its surviving vertices and centre are offscreen. Keep that capture
      // conservatively full-size instead of freezing the previous reflection.
      if (behind) { minX = minY = -1; maxX = maxY = 1; }
      MIRROR_RECT[0] = minX;
      MIRROR_RECT[1] = minY;
      MIRROR_RECT[2] = maxX;
      MIRROR_RECT[3] = maxY;
      return true;
    };
    const updateMirrorSide = (camera) => {
      if (!mirror.walkThrough) return;
      const world = mirror.node.world, center = mirrorDebug.planeCenter, normal = mirrorDebug.planeNormal;
      center[0] = world[12];
      center[1] = world[13];
      center[2] = world[14];
      const nlen = Math.hypot(world[8], world[9], world[10]) || 1;
      normal[0] = world[8] / nlen;
      normal[1] = world[9] / nlen;
      normal[2] = world[10] / nlen;
      const cameraSide = (camera.position.x - center[0]) * normal[0] + (camera.position.y - center[1]) * normal[1] + (camera.position.z - center[2]) * normal[2];
      mirror.frontFacing = cameraSide > MIRROR_EPSILON;
      mirrorDebug.planeDistance = Math.abs(cameraSide);
      mirror.portal = !!mirror.node.mirrorPortal;
      mirror.reveal = Math.max(0, Math.min(1, mirror.node.mirrorReveal || 0));
      mirrorDebug.portal = mirror.portal;
      mirrorDebug.reveal = mirror.reveal;
    };
    // Readies the reflected camera for the mirror, or for a reflector when `target` is one; only the mirror's own
    // capture writes the debug readout.
    const prepareMirrorCamera = (camera, node = mirror.node, target = mirror) => {
      const own = target === mirror, world = node.world, center = own ? mirrorDebug.planeCenter : REFLECTOR_CENTER, normal = own ? mirrorDebug.planeNormal : REFLECTOR_NORMAL;
      center[0] = world[12];
      center[1] = world[13];
      center[2] = world[14];
      const nlen = Math.hypot(world[8], world[9], world[10]) || 1;
      normal[0] = world[8] / nlen;
      normal[1] = world[9] / nlen;
      normal[2] = world[10] / nlen;
      const cameraSide = (camera.position.x - center[0]) * normal[0] + (camera.position.y - center[1]) * normal[1] + (camera.position.z - center[2]) * normal[2];
      if (cameraSide <= MIRROR_EPSILON) return own && skipMirrorPass("back-facing");
      if (!mirrorRect(node, viewProj) || MIRROR_RECT[2] < -1 || MIRROR_RECT[0] > 1 || MIRROR_RECT[3] < -1 || MIRROR_RECT[1] > 1) {
        return own && skipMirrorPass("offscreen");
      }
      const area = (Math.min(1, MIRROR_RECT[2]) - Math.max(-1, MIRROR_RECT[0])) * width * 0.5 * (Math.min(1, MIRROR_RECT[3]) - Math.max(-1, MIRROR_RECT[1])) * height * 0.5;
      if (area < 16) return own && skipMirrorPass("negligible");
      reflectMirrorPoint(mirrorEye, camera.position, center, normal);
      reflectMirrorPoint(mirrorTarget, camera.target, center, normal);
      const up = camera.up || UP, upDot = up.x * normal[0] + up.y * normal[1] + up.z * normal[2];
      mirrorUp.x = up.x - 2 * upDot * normal[0];
      mirrorUp.y = up.y - 2 * upDot * normal[1];
      mirrorUp.z = up.z - 2 * upDot * normal[2];
      mat4.lookAt(mirrorView, mirrorEye, mirrorTarget, mirrorUp);
      BL.scene.cameraProjection(mirrorProj, camera, width / height, Math.min(camera.near, cameraSide * 0.5));
      // Reflect the actual view and capture only visible glass. Fitting the
      // entire aperture to a perpendicular camera spends nearly all capture
      // texels offscreen at close range, making reflections blur and crawl.
      mat4.multiply(mirrorViewProj, mirrorProj, mirrorView);
      mirrorRect(node, mirrorViewProj);
      const left = Math.max(-1, MIRROR_RECT[0]), right = Math.min(1, MIRROR_RECT[2]);
      const bottom = Math.max(-1, MIRROR_RECT[1]), top = Math.min(1, MIRROR_RECT[3]);
      const cropX = (left + right) * 0.5, cropY = (bottom + top) * 0.5;
      const halfX = (right - left) * 0.5, halfY = (top - bottom) * 0.5;
      const screenWidth = Math.max(1, halfX * width), screenHeight = Math.max(1, halfY * height);
      const targetWidth = target.renderWidth = Math.max(1, Math.min(settings.mirror, Math.ceil(screenWidth * dpr)));
      const targetHeight = target.renderHeight = Math.max(1, Math.min(settings.mirror, Math.ceil(screenHeight * dpr)));
      if (own) {
        mirrorDebug.width = targetWidth;
        mirrorDebug.height = targetHeight;
      }
      for (let col = 0; col < 16; col += 4) {
        mirrorProj[col] = (mirrorProj[col] - cropX * mirrorProj[col + 3]) / halfX;
        mirrorProj[col + 1] = (mirrorProj[col + 1] - cropY * mirrorProj[col + 3]) / halfY;
      }
      // Sky rays unproject through the cropped projection, before the oblique clip bends z.
      mat4.multiply(mirrorViewProj, mirrorProj, mirrorView);
      skyInverse(mirrorInvViewProj, mirrorProj, mirrorView);
      mat4.transformPoint(MIRROR_POINT, mirrorView, center[0], center[1], center[2]);
      let cx = mirrorView[0] * normal[0] + mirrorView[4] * normal[1] + mirrorView[8] * normal[2];
      let cy = mirrorView[1] * normal[0] + mirrorView[5] * normal[1] + mirrorView[9] * normal[2];
      let cz = mirrorView[2] * normal[0] + mirrorView[6] * normal[1] + mirrorView[10] * normal[2];
      const clen = Math.hypot(cx, cy, cz) || 1;
      cx /= clen;
      cy /= clen;
      cz /= clen;
      let cw = -(cx * MIRROR_POINT[0] + cy * MIRROR_POINT[1] + cz * MIRROR_POINT[2]);
      mat4.invert(mirrorInverseProj, mirrorProj);
      mat4.transformPoint4(mirrorClipCorner, mirrorInverseProj, cx >= 0 ? 1 : -1, cy >= 0 ? 1 : -1, 1);
      const qx = mirrorClipCorner[0], qy = mirrorClipCorner[1], qz = mirrorClipCorner[2], qw = mirrorClipCorner[3];
      const clipScale = 2 / (cx * qx + cy * qy + cz * qz + cw * qw);
      cx *= clipScale;
      cy *= clipScale;
      cz *= clipScale;
      cw *= clipScale;
      mirrorProj[2] = cx - mirrorProj[3] * 0.998;
      mirrorProj[6] = cy - mirrorProj[7] * 0.998;
      mirrorProj[10] = cz - mirrorProj[11] * 0.998;
      mirrorProj[14] = cw - mirrorProj[15] * 0.998;
      mat4.multiply(mirrorViewProj, mirrorProj, mirrorView);
      if (!own) return true;
      mirrorDebug.cameraPosition[0] = mirrorEye.x;
      mirrorDebug.cameraPosition[1] = mirrorEye.y;
      mirrorDebug.cameraPosition[2] = mirrorEye.z;
      mirrorDebug.cameraTarget[0] = mirrorTarget.x;
      mirrorDebug.cameraTarget[1] = mirrorTarget.y;
      mirrorDebug.cameraTarget[2] = mirrorTarget.z;
      mirrorDebug.skipReason = "none";
      return true;
    };
    // How many pixels of the eye's view a reflector's glass covers, facing it; 0 when it faces away or is off screen.
    const reflectorArea = (node, camera) => {
      const w = node.world, nlen = Math.hypot(w[8], w[9], w[10]) || 1;
      if (((camera.position.x - w[12]) * w[8] + (camera.position.y - w[13]) * w[9] + (camera.position.z - w[14]) * w[10]) / nlen <= MIRROR_EPSILON) return 0;
      if (!mirrorRect(node, viewProj) || MIRROR_RECT[2] < -1 || MIRROR_RECT[0] > 1 || MIRROR_RECT[3] < -1 || MIRROR_RECT[1] > 1) return 0;
      return (Math.min(1, MIRROR_RECT[2]) - Math.max(-1, MIRROR_RECT[0])) * width * 0.5 * (Math.min(1, MIRROR_RECT[3]) - Math.max(-1, MIRROR_RECT[1])) * height * 0.5;
    };
    const prepareEnvironmentCamera = (camera, face) => {
      const world = mirror.node.world, at = face * 6;
      // One fixed probe beside the glass is shared by all pooled panels. Their
      // normals select reflection directions immediately, between probe updates.
      mirrorEye.x = environment.origin[0] = world[12] + world[8] * 0.04;
      mirrorEye.y = environment.origin[1] = world[13] + world[9] * 0.04;
      mirrorEye.z = environment.origin[2] = world[14] + world[10] * 0.04;
      mirrorTarget.x = mirrorEye.x + CUBE_VIEWS[at];
      mirrorTarget.y = mirrorEye.y + CUBE_VIEWS[at + 1];
      mirrorTarget.z = mirrorEye.z + CUBE_VIEWS[at + 2];
      mirrorUp.x = CUBE_VIEWS[at + 3]; mirrorUp.y = CUBE_VIEWS[at + 4]; mirrorUp.z = CUBE_VIEWS[at + 5];
      mat4.lookAt(mirrorView, mirrorEye, mirrorTarget, mirrorUp);
      mat4.perspective(mirrorProj, Math.PI / 2, 1, 0.025, camera.far);
      mat4.multiply(mirrorViewProj, mirrorProj, mirrorView);
      skyInverse(mirrorInvViewProj, mirrorProj, mirrorView);
    };
    const ensureShardProgram = () => {
      if (!environment.program) {
        environment.program = compile(MIRROR_VS, SHARD_FS, ["uViewProj", "uShard", "uEnvironment", "uEye", "uViewDirection", "uTint", "uClipMaxY"]);
        mirrorDebug.resources++;
      }
      if (environment.ready) return true;
      if (parallel && !gl.getProgramParameter(environment.program.prog, parallel.COMPLETION_STATUS_KHR)) return false;
      finishProgram(environment.program);
      environment.ready = true;
      return true;
    };
    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const budget = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
      dpr = Math.min(budget, Math.max(0.75, Math.min(window.devicePixelRatio || 1, settings.dpr)));
      size.width = width;
      size.height = height;
      pw = Math.max(1, Math.floor(width * dpr));
      ph = Math.max(1, Math.floor(height * dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
      buildFbo();
    };
    const init = () => {
      maxSamples = gl.getParameter(gl.MAX_SAMPLES);
      parallel = gl.getExtension("KHR_parallel_shader_compile");
      // Every flat varying is the same at a triangle's three corners, so the first corner draws the same pixels as
      // GL's default last. Under the default, ANGLE's Metal backend (Safari, Chrome on Apple) rewrites each flat
      // draw's vertices into index buffers it keeps: about 2.6 GB of GPU memory on the hub.
      const provoking = gl.getExtension("WEBGL_provoking_vertex");
      if (provoking) provoking.provokingVertexWEBGL(provoking.FIRST_VERTEX_CONVENTION_WEBGL);
      buildPrograms();
      if (rigProgramsRequested) prepareRigPrograms();
      buildMatrixTexture();
      buildShadow();
      resize();
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
    };
    const onLost = (e) => {
      e.preventDefault();
      lost = true;
      imageTextures = rippleBodyTextures = 0;
      for (const rec of records.values()) { rec.imageTexture = rec.rippleBodyTexture = rec.rippleBodyState = null; }
      forgetMirror();
    };
    const onRestored = () => {
      dsbGPU=null;
      records.clear();
      activeRecords.length = 0;
      res.fbo = null;
      res.shadow = null;
      res.matrixTexture = null;
      init();
      lost = false;
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    let imageTextures = 0, rippleBodyTextures = 0;
    const applyViewDirection = (program, projection, cameraView) => {
      const depth = projection[15];
      gl.uniform4f(program.u.uViewDirection, depth * cameraView[2], depth * cameraView[6], depth * cameraView[10], -projection[11]);
    };
    const applyCutaway = (program, geometry) => {
      const count = geometry?.cutawayPreserve ? 0 : cutawayCount;
      const opacity = geometry?.cutawayHide ? 1 - cutawayFade : 1;
      if (program.cutOpacity !== opacity) {
        gl.uniform1f(program.u.uCutawayOpacity, opacity);
        program.cutOpacity = opacity;
      }
      if (program.cutFrame !== cutawayFrame) {
        gl.uniform4fv(program.u.uCutRegions, cutawayRegions);
        gl.uniform4fv(program.u.uCutBounds, cutawayBounds);
        program.cutFrame = cutawayFrame;
      }
      if (program.cutCount !== count) {
        gl.uniform1i(program.u.uCutCount, count);
        program.cutCount = count;
      }
    };
    const drawImageSurface = (rec, count, cameraPass) => {
      const surface = rec.geometry.imageSurface, image = surface.asset.load(), p = programs.image;
      gl.activeTexture(gl.TEXTURE6);
      if (!rec.imageTexture && image.complete && image.naturalWidth) {
        rec.imageTexture = gl.createTexture();
        imageTextures++;
        gl.bindTexture(gl.TEXTURE_2D, rec.imageTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        // Mipmapped, so lettering seen from across a hall stays legible instead of sparkling.
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D, rec.imageTexture || res.matrixTexture);
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uViewProj, false, cameraPass ? viewProj : mirrorViewProj);
      gl.uniform4fv(p.u.uRect, surface.rect);
      gl.uniform1i(p.u.uImage, 6);
      gl.uniform1i(p.u.uReady, rec.imageTexture ? 1 : 0);
      applyCutaway(p, rec.geometry);
      gl.uniform1f(p.u.uClipMaxY, Math.min(rec.geometry.cutawayPreserve ? 1e6 : cutawayMaxY, rec.geometry.clipMaxY ?? 1e6));
      gl.bindVertexArray(rec.mesh.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, rec.mesh.count, count);
      gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(programs.mesh.prog);
    };
    const drawGlass = (cull) => {
      let any = false;
      for (let i = 0; i < activeRecords.length; i++) if (activeRecords[i].geometry.glass && activeRecords[i].count) { any = true; break; }
      if (!any) return;
      const mesh = programs.mesh;
      gl.useProgram(mesh.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      glassPass = true;
      gl.cullFace(gl.FRONT);
      drawParts("mesh", "mesh", true, cull);
      gl.cullFace(gl.BACK);
      drawParts("mesh", "mesh", true, cull);
      glassPass = false;
      gl.uniform1f(mesh.u.uGlass, 1);
      gl.uniform1f(mesh.u.uLightBeam, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    };
    // The camera pass draws only the in-frustum front of each record; shadow and mirror draw all.
    const drawParts = (kind, useProgram, excludeMirror = false, cull = false, matrixStage = 0) => {
      for (const rec of activeRecords) {
        if (rec.geometry.mirrorRippleOnly) continue;
        applyCutaway(programs[useProgram], rec.geometry);
        if (excludeMirror && (rec === mirror.record || rec.geometry.mirrorSource)) continue;
        if (rec.geometry.reflector && (reflectorPass === null || rec === reflectorPass)) continue;
        if (useProgram === "mesh" && !rec.geometry.glass !== !glassPass) continue;
        if (glassPass) {
          gl.uniform1f(programs.mesh.u.uGlass, rec.geometry.glass);
          gl.uniform1f(programs.mesh.u.uLightBeam, rec.geometry.lightBeam || 0);
        }
        const part = rec[kind], n = rec.batch && rec.batch.drawInstanceCount !== undefined ? rec.drawCount : cull ? rec.drawCount : rec.count;
        if (!part || !n) continue;
        if (cull && rec.offscreen) continue;
        if (kind === "mesh" && useProgram === "shadow" && rec.geometry.castShadow === false) continue;
        if (useProgram === "shadow" ? !rec.lightVisible || shadowSubset && rec.shadowStatic !== (shadowSubset === 1) : !cull && !rec.mirrorVisible) continue;
        const program = programs[useProgram], objectClip = rec.geometry.clipPlane || NO_OBJECT_CLIP;
        if (objectClip !== program.objectClip) {
          gl.uniform4fv(program.u.uObjectClip, objectClip);
          program.objectClip = objectClip;
        }
        if (rigMode && kind === "mesh") applyRig(program, rec, useProgram === "shadow" ? 2 : cull ? 1 : 3);
        if (useProgram === "shadow") shadowDraws++;
        if (kind === "mesh" && useProgram === "mesh") {
          const stage = rec.geometry.matrixRevealBacking ? 1 : rec.geometry.matrixGlyph ? 2 : rec.geometry.glassOpacity ? 3 : 0;
          if (stage !== matrixStage) continue;
          if (rec.geometry.imageSurface) { drawImageSurface(rec, n, cull); continue; }
          const mesh = programs.mesh, glyph = stage === 1 ? 3 : stage === 2 ? 1 : rec.geometry.matrixLocalGlyphSurface ? 2 : 0, cave = rec.geometry.matrixCave || 0;
          if (glyph !== mesh.matrixGlyph) {
            gl.uniform1f(mesh.u.uMatrixGlyph, glyph);
            mesh.matrixGlyph = glyph;
          }
          if (stage === 2) gl.uniform1f(mesh.u.uMatrixGlyphOpacity, rec.geometry.matrixGlyphOpacity ?? 1);
          const glassOpacity = rec.geometry.glassOpacity || 0;
          if (glassOpacity !== mesh.glassOpacity) {
            gl.uniform1f(mesh.u.uGlassOpacity, glassOpacity);
            mesh.glassOpacity = glassOpacity;
          }
          if (cave !== mesh.matrixCave) {
            gl.uniform1f(mesh.u.uMatrixCave, cave);
            mesh.matrixCave = cave;
          }
        }
        if (kind === "mesh") {
          if (useProgram === "mesh") {
            const body = rec.geometry.lakeBody;
            if (body && body[2] > 0) {
              gl.uniform4f(program.u.uLakeBodyShape, body[0], body[1], body[2], body[3]);
              gl.uniform4f(program.u.uLakeBodyBend, body[4], body[5], body[6], body[7]);
              program.lakeBody = body;
            } else if (program.lakeBody !== null) {
              gl.uniform4f(program.u.uLakeBodyShape, 0, 0, 0, 0);
              gl.uniform4f(program.u.uLakeBodyBend, 0, 0, 0, 0);
              program.lakeBody = null;
            }
            const waveEnd = rec.geometry.lakeWaveEnd;
            if (waveEnd) gl.uniform4fv(program.u.uLakeWaveEnd, waveEnd);
            else gl.uniform4f(program.u.uLakeWaveEnd, 0, 0, 0, 1);
            const curve = rec.geometry.lakeFlowCurve, flow = rec.geometry.lakeFlow;
            gl.uniform1f(program.u.uLakeFlowEnabled, curve ? 2 : flow ? 1 : 0);
            if (curve) {
              gl.uniform4fv(program.u.uLakeFlowU, curve);
              gl.uniform4f(program.u.uLakeFlowV, 0, 0, 0, 0);
            } else if (flow) {
              gl.uniform4f(program.u.uLakeFlowU, flow[0], flow[1], flow[2], flow[3]);
              gl.uniform4f(program.u.uLakeFlowV, flow[4], flow[5], flow[6], flow[7]);
            }
            const charge = rec.geometry.lakeCharge;
            gl.uniform1f(program.u.uLakeChargeRise, rec.geometry.lakeChargeRise || 0);
            if (charge) {
              gl.uniform4f(program.u.uLakeCharge, charge[0], charge[1], charge[2], charge[3]);
              gl.uniform2f(program.u.uLakeChargeCenter, charge[4], charge[5]);
              program.lakeCharge = charge;
            } else if (program.lakeCharge) {
              gl.uniform4f(program.u.uLakeCharge, 0, 0, 0, 0);
              program.lakeCharge = null;
            }
            const lakeOcclude = rec.geometry.lakeOcclude;
            if (lakeOcclude) {
              gl.uniform4fv(program.u.uLakeOcclude, lakeOcclude);
              program.lakeOcclude = lakeOcclude;
            } else if (program.lakeOcclude) {
              gl.uniform4f(program.u.uLakeOcclude, 0, 0, 0, 0);
              program.lakeOcclude = null;
            }
            const waves = rec.geometry.lakeWaves, count = waves ? waves.count : 0;
            if (count !== program.lakeWaveCount) {
              gl.uniform1i(program.u.uLakeWaveCount, count);
              program.lakeWaveCount = count;
            }
            if (count) gl.uniform4fv(program.u.uLakeWaves, waves.data);
            if (waves) {
              gl.uniform4fv(program.u.uLakeSurface, waves.surface);
              gl.uniform4fv(program.u.uLakeSuction, waves.suction);
              program.lakeSurface = waves;
            } else if (program.lakeSurface !== null) {
              gl.uniform4f(program.u.uLakeSurface, 0, 0, 0, 0);
              gl.uniform4f(program.u.uLakeSuction, 0, 0, 0, 0);
              program.lakeSurface = null;
            }
          }
          const minimumY = rec.geometry.clipMinY ?? -1e6, maximumY = Math.min(rec.geometry.cutawayPreserve ? 1e6 : cutawayMaxY, rec.geometry.clipMaxY ?? 1e6);
          if (minimumY !== program.clipMinY) {
            gl.uniform1f(program.u.uClipMinY, minimumY);
            program.clipMinY = minimumY;
          }
          if (maximumY !== program.clipMaxY) {
            gl.uniform1f(program.u.uClipMaxY, maximumY);
            program.clipMaxY = maximumY;
          }
          const voxel = rec.mesh.voxel;
          if (useProgram === "mesh" && voxel !== program.voxel) {
            if (voxel) gl.uniform4fv(program.u.uVoxel, voxel);
            else gl.uniform4f(program.u.uVoxel, 0, 0, 0, 0);
            program.voxel = voxel;
          }
          const sway = rec.geometry.sway || 0, swing = rec.geometry.swing || 0;
          if (useProgram === "mesh" && sway !== program.sway) {
            gl.uniform1f(program.u.uSway, sway);
            program.sway = sway;
          }
          if (useProgram === "mesh" && swing !== program.swing) {
            gl.uniform1f(program.u.uSwing, swing);
            program.swing = swing;
          }
          const projective = rec.geometry.projective ? 1 : 0, slab = rec.geometry.clipSlab || NO_OBJECT_SLAB;
          if (useProgram === "mesh" && projective !== program.projective) {
            gl.uniform1f(program.u.uProjective, projective);
            program.projective = projective;
          }
          if (useProgram === "mesh" && (slab !== program.objectSlab || rec.geometry.lakeFlow)) {
            gl.uniform4fv(program.u.uObjectSlab, slab);
            program.objectSlab = slab;
          }
        }
        if (kind === "line") {
          const line = programs.line, maximumY = rec.geometry.cutawayPreserve ? 1e6 : cutawayMaxY, lineWidth = part.width * dpr;
          if (maximumY !== line.clipMaxY) {
            gl.uniform1f(line.u.uClipMaxY, maximumY);
            line.clipMaxY = maximumY;
          }
          if (lineWidth !== line.lineWidth) {
            gl.uniform1f(line.u.uWidth, lineWidth);
            line.lineWidth = lineWidth;
          }
        }
        // Surface overlays stay above their backing at distant zooms in both color passes; shadow depth and later
        // ordinary meshes stay unchanged.
        const offset = kind === "mesh" && useProgram === "mesh" && rec.geometry.depthOffset;
        if (offset) {
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(0, -4);
        }
        gl.bindVertexArray(part.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, part.count, n);
        if (offset) gl.disable(gl.POLYGON_OFFSET_FILL);
      }
    };
    // Celestial rays depend only on orientation: strip translation before inversion to avoid altitude-dependent
    // cancellation in the star shader.
    const skyInverse = (out, projection, cameraView) => {
      out.set(cameraView);
      out[12] = out[13] = out[14] = 0;
      mat4.multiply(out, projection, out);
      mat4.invert(out, out);
    };
    const drawSky = (inv, eyeHeight) => {
      const p = programs.sky;
      gl.useProgram(p.prog);
      gl.uniformMatrix4fv(p.u.uInvViewProj, false, inv);
      gl.uniform1f(p.u.uHazeDrop, BL.daylight.hazeDropAt(eyeHeight) * skyHaze);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.bindVertexArray(res.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
    };
    const renderMirrorCapture = (clear, sky, ground, direct, directStrength, ambientFloor, diffuseFloor, shadowStrength, shadowFloor, shadowBias, lx, ly, lz, sh, lights, lightCount, skyOn, fog, fogNear, fogFar, matrix, spotLight, environmentFace = -1, target = mirror) => {
      const cube = environmentFace >= 0;
      if (target !== mirror) ensureReflectorTarget(target);
      else if (!cube) ensureMirrorTarget();
      extractFrustum(mirrorViewProj, MIRROR_FRUSTUM);
      markMirrorVisible();
      // Every reflector shows in a reflection as its plain glass, but the one being captured.
      reflectorPass = target.record;
      const pg = programs;
      gl.bindFramebuffer(gl.FRAMEBUFFER, cube ? environment.fb : target.fb);
      if (cube) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + environmentFace, environment.tex, 0);
      const captureWidth = cube ? environment.size : target.renderWidth, captureHeight = cube ? environment.size : target.renderHeight;
      gl.viewport(0, 0, captureWidth, captureHeight);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, captureWidth, captureHeight);
      gl.clearColor(clear[0], clear[1], clear[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(pg.mesh.prog);
      gl.uniformMatrix4fv(pg.mesh.u.uViewProj, false, mirrorViewProj);
      gl.uniformMatrix4fv(pg.mesh.u.uLightViewProj, false, lightViewProj);
      gl.uniform3f(pg.mesh.u.uEye, mirrorEye.x, mirrorEye.y, mirrorEye.z);
      applyViewDirection(pg.mesh, mirrorProj, mirrorView);
      gl.uniform3f(pg.mesh.u.uLightDir, lx, ly, lz);
      gl.uniform3fv(pg.mesh.u.uSky, sky);
      gl.uniform3fv(pg.mesh.u.uGround, ground);
      gl.uniform3fv(pg.mesh.u.uSun, direct);
      gl.uniform1f(pg.mesh.u.uDirectStrength, directStrength);
      gl.uniform1f(pg.mesh.u.uAmbientFloor, ambientFloor);
      gl.uniform1f(pg.mesh.u.uDiffuseFloor, diffuseFloor);
      gl.uniform1f(pg.mesh.u.uShadowStrength, shadowStrength);
      gl.uniform1f(pg.mesh.u.uShadowFloor, shadowFloor);
      gl.uniform1f(pg.mesh.u.uShadowBias, shadowBias);
      gl.uniform1f(pg.mesh.u.uShadowTexel, 1 / sh.size);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sh.tex);
      gl.uniform1i(pg.mesh.u.uShadow, 0);
      bindMatrixTexture(pg.mesh);
      if (lights) gl.uniform4fv(pg.mesh.u.uLights, lights);
      gl.uniform1i(pg.mesh.u.uLightCount, lightCount);
      gl.uniform4fv(pg.mesh.u.uSpotLight, spotLight);
      gl.uniform3fv(pg.mesh.u.uFog, fog);
      gl.uniform2f(pg.mesh.u.uFogRange, fogNear, fogFar);
      // The mirror closes before the retreat reaches the pile; its reflection must still show the same partially
      // transformed world as the main view.
      gl.uniform4f(pg.mesh.u.uMatrixParams, matrix ? matrix.active : 0, matrix ? matrix.radius : 0, matrix ? matrix.time : 0, matrix ? matrix.density : 0);
      gl.uniform1i(pg.mesh.u.uMatrixSamples, cube ? 1 : Math.max(1, mirrorDebug.samples));
      if (matrix) gl.uniform3fv(pg.mesh.u.uMatrixOrigin, matrix.origin);
      else gl.uniform3f(pg.mesh.u.uMatrixOrigin, 0, 0, 0);
      gl.uniform4fv(pg.mesh.u.uMatrixCaves, matrix && matrix.caves || NO_MATRIX_CAVES);
      gl.uniform4fv(pg.mesh.u.uMatrixCaveBounds, matrix && matrix.caveBounds || NO_MATRIX_CAVES);
      gl.uniform1f(pg.mesh.u.uMatrixCaveNear, matrix && matrix.caveBounds ? matrix.caveNear : FOG_OFF);
      gl.uniform1f(pg.mesh.u.uMatrixPermanentCave, matrix ? matrix.permanentCave || 0 : 0);
      gl.uniform4fv(pg.mesh.u.uMatrixPermanentPlane, matrix && matrix.permanentPlane || NO_MATRIX_PLANE);
      gl.uniform4fv(pg.mesh.u.uMatrixPermanentAperture, matrix && matrix.permanentAperture || DEFAULT_MATRIX_APERTURE);
      gl.uniform1f(pg.mesh.u.uMatrixLivingGlobal, matrix ? matrix.livingGlobal ?? 1 : 1);
      drawParts("mesh", "mesh", true);
      if (skyOn) drawSky(mirrorInvViewProj, mirrorEye.y);
      drawGlass(false);
      gl.useProgram(pg.mesh.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawParts("mesh", "mesh", true, false, 1);
      drawParts("mesh", "mesh", true, false, 2);
      gl.depthMask(false);
      drawParts("mesh", "mesh", true, false, 3);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.useProgram(pg.line.prog);
      gl.uniformMatrix4fv(pg.line.u.uViewProj, false, mirrorViewProj);
      gl.uniform2f(pg.line.u.uViewport, captureWidth, captureHeight);
      gl.disable(gl.CULL_FACE);
      drawParts("line", "line", true);
      gl.enable(gl.CULL_FACE);
      reflectorPass = null;
      if (target !== mirror) {
        target.viewProj.set(mirrorViewProj);
        target.valid = true;
        return;
      }
      if (cube) {
        environment.valid |= 1 << environmentFace;
        mirrorDebug.environmentFaces = environment.valid;
        mirrorDebug.environmentPassCount++;
        return;
      }
      mirrorDebug.reflectionOnlyCount = 0;
      for (const rec of activeRecords) if (rec !== mirror.record) mirrorDebug.reflectionOnlyCount += rec.cameraHiddenCount;
      mirrorCapturedViewProj.set(mirrorViewProj);
      mirror.captureValid = mirrorDebug.captureValid = true;
      mirrorDebug.reflectionPassCount++;
      mirrorDebug.captureExcluded = true;
    };
    const drawMirrorSurface = (camera) => {
      const rec = mirror.record, part = rec && rec.mesh, pg = mirror.program;
      mirrorDebug.ripples = 0;
      mirrorDebug.bodyContacts = mirrorDebug.bodyWaves = 0;
      const pane = !mirror.portal && mirror.frontFacing && part && mirror.tex && mirror.programReady && mirror.captureValid;
      if (!mirror.node) return;
      if (pane) {
        gl.useProgram(pg.prog);
        gl.uniform1f(pg.u.uClipMaxY, cutawayMaxY);
        applyCutaway(pg, rec.geometry);
        gl.uniformMatrix4fv(pg.u.uViewProj, false, viewProj);
        gl.uniformMatrix4fv(pg.u.uReflectionViewProj, false, mirrorCapturedViewProj);
        gl.uniformMatrix4fv(pg.u.uMirrorWorld, false, mirror.node.world);
        gl.uniform1f(pg.u.uShard, 0);
        gl.uniform2f(pg.u.uReflectionScale, mirror.renderWidth / mirror.width, mirror.renderHeight / mirror.height);
        gl.uniform3f(pg.u.uTint, 0.56, 0.62, 0.67);
        gl.uniform1f(pg.u.uPortal, mirror.portal ? 1 : 0);
        gl.uniform1f(pg.u.uReveal, mirror.reveal);
        gl.uniform1f(pg.u.uRippleOnly, 0);
        const tint = mirror.node.rippleTint;
        gl.uniform3f(pg.u.uCrestTint, tint ? tint[0] : -1, tint ? tint[1] : 0, tint ? tint[2] : 0);
        const ripples = mirror.node.mirrorRipples, body = mirror.node.mirrorBody;
        mirrorDebug.ripples = ripples ? ripples.active : 0;
        gl.uniform1i(pg.u.uRippleActive, mirrorDebug.ripples);
        gl.uniform1f(pg.u.uRippleTime, body ? body.time : ripples ? ripples.time : 0);
        gl.uniform4fv(pg.u.uRipples, ripples ? ripples.waves : NO_MIRROR_RIPPLES);
        const bodyActive = body && (body.contacts || body.active);
        gl.activeTexture(gl.TEXTURE4);
        if (bodyActive) {
          // One bounded silhouette atlas belongs to the mirror for its lifetime.
          // Contacts rebuild it at their capped cadence; moving wave ages are uniforms.
          if (!mirror.bodyTex) {
            mirror.bodyTex = createTexture(body.width, body.height * body.layers, gl.RGBA8, gl.LINEAR);
            mirrorDebug.resources++;
          }
          gl.bindTexture(gl.TEXTURE_2D, mirror.bodyTex);
          if (mirror.bodyState !== body || mirror.bodyVersion !== body.version) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, body.width, body.height * body.layers, gl.RGBA, gl.UNSIGNED_BYTE, body.pixels);
            mirror.bodyState = body;
            mirror.bodyVersion = body.version;
          }
          const bounds = boundsOf(mirror.node.geometry);
          gl.uniform4f(pg.u.uBodyBounds, bounds.min[0], bounds.min[1], bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
          gl.uniform2f(pg.u.uBodyTexel, 1 / body.width, 1 / body.height);
          mirrorDebug.bodyContacts = body.contacts;
          mirrorDebug.bodyWaves = body.active;
        } else gl.bindTexture(gl.TEXTURE_2D, mirror.bodyTex || res.matrixTexture);
        gl.uniform1i(pg.u.uBodyField, 4);
        gl.uniform1i(pg.u.uBodyContacts, mirrorDebug.bodyContacts);
        gl.uniform1i(pg.u.uBodyActive, mirrorDebug.bodyWaves);
        gl.uniform4fv(pg.u.uBodyWaves, body ? body.waves : NO_MIRROR_BODY_WAVES);
        bindMatrixTexture(pg);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, mirror.tex);
        gl.uniform1i(pg.u.uReflection, 2);
        gl.bindVertexArray(part.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, part.count, rec.count);
        mirrorDebug.surfaceDrawn = true;
      }
      // Every shard reflects its own physical orientation through this shared
      // environment. No shard owns a scene pass, texture or framebuffer.
      if (mirror.shards && environment.ready && environment.tex) {
        const shardProgram = environment.program;
        gl.useProgram(shardProgram.prog);
        gl.uniform1f(shardProgram.u.uClipMaxY, cutawayMaxY);
        applyCutaway(shardProgram);
        gl.uniformMatrix4fv(shardProgram.u.uViewProj, false, viewProj);
        gl.uniform1f(shardProgram.u.uShard, 1);
        gl.uniform3f(shardProgram.u.uEye, camera.position.x, camera.position.y, camera.position.z);
        applyViewDirection(shardProgram, proj, view);
        gl.uniform3f(shardProgram.u.uTint, 0.56, 0.62, 0.67);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, environment.tex);
        gl.uniform1i(shardProgram.u.uEnvironment, 5);
        for (const shard of activeRecords) {
          if (!shard.geometry.mirrorSource || !shard.mesh || !shard.drawCount || shard.offscreen) continue;
          applyCutaway(shardProgram, shard.geometry);
          gl.bindVertexArray(shard.mesh.vao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, shard.mesh.count, shard.drawCount);
          mirrorDebug.shardsDrawn += shard.drawCount;
        }
      }
      gl.activeTexture(gl.TEXTURE0);
    };
    // Each reflector facing the eye draws its own last capture, through the matrix it was captured with, and its
    // ripples in its crest tint.
    const drawReflectors = (camera) => {
      if (!reflectorNodes.length || !mirror.programReady) return;
      const pg = mirror.program;
      gl.useProgram(pg.prog);
      gl.uniform1f(pg.u.uClipMaxY, cutawayMaxY);
      gl.uniformMatrix4fv(pg.u.uViewProj, false, viewProj);
      gl.uniform1f(pg.u.uShard, 0);
      gl.uniform3f(pg.u.uTint, 0.56, 0.62, 0.67);
      gl.uniform1f(pg.u.uPortal, 0);
      gl.uniform1f(pg.u.uReveal, 0);
      gl.uniform1f(pg.u.uRippleOnly, 0);
      gl.uniform1i(pg.u.uBodyContacts, 0);
      gl.uniform1i(pg.u.uBodyActive, 0);
      gl.uniform4fv(pg.u.uBodyWaves, NO_MIRROR_BODY_WAVES);
      bindMatrixTexture(pg);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, res.matrixTexture);
      gl.uniform1i(pg.u.uBodyField, 4);
      gl.activeTexture(gl.TEXTURE2);
      gl.uniform1i(pg.u.uReflection, 2);
      for (const node of reflectorNodes) {
        const t = reflectorTargets.get(node.geometry), rec = t && t.record, w = node.world;
        if (!rec || !rec.mesh || !rec.drawCount || rec.offscreen || !t.valid) continue;
        if ((camera.position.x - w[12]) * w[8] + (camera.position.y - w[13]) * w[9] + (camera.position.z - w[14]) * w[10] <= 0) continue;
        applyCutaway(pg, rec.geometry);
        gl.uniformMatrix4fv(pg.u.uReflectionViewProj, false, t.viewProj);
        gl.uniformMatrix4fv(pg.u.uMirrorWorld, false, w);
        gl.uniform2f(pg.u.uReflectionScale, t.renderWidth / t.size, t.renderHeight / t.size);
        const tint = node.rippleTint, ripples = node.mirrorRipples, body = node.mirrorBody;
        const bodyActive = body && (body.contacts || body.active);
        gl.activeTexture(gl.TEXTURE4);
        if (bodyActive) {
          if (!rec.rippleBodyTexture) {
            rec.rippleBodyTexture = createTexture(body.width, body.height * body.layers, gl.RGBA8, gl.LINEAR);
            rippleBodyTextures++;
          }
          gl.bindTexture(gl.TEXTURE_2D, rec.rippleBodyTexture);
          if (rec.rippleBodyState !== body || rec.rippleBodyVersion !== body.version) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, body.width, body.height * body.layers, gl.RGBA, gl.UNSIGNED_BYTE, body.pixels);
            rec.rippleBodyState = body; rec.rippleBodyVersion = body.version;
          }
          const bounds = boundsOf(node.geometry);
          gl.uniform4f(pg.u.uBodyBounds, bounds.min[0], bounds.min[1], bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
          gl.uniform2f(pg.u.uBodyTexel, 1 / body.width, 1 / body.height);
        } else gl.bindTexture(gl.TEXTURE_2D, res.matrixTexture);
        gl.uniform1i(pg.u.uBodyContacts, bodyActive ? body.contacts : 0);
        gl.uniform1i(pg.u.uBodyActive, bodyActive ? body.active : 0);
        gl.uniform4fv(pg.u.uBodyWaves, body ? body.waves : NO_MIRROR_BODY_WAVES);
        gl.activeTexture(gl.TEXTURE2);
        gl.uniform3f(pg.u.uCrestTint, tint ? tint[0] : -1, tint ? tint[1] : 0, tint ? tint[2] : 0);
        gl.uniform1i(pg.u.uRippleActive, ripples ? ripples.active : 0);
        gl.uniform1f(pg.u.uRippleTime, bodyActive ? body.time : ripples ? ripples.time : 0);
        gl.uniform4fv(pg.u.uRipples, ripples ? ripples.waves : NO_MIRROR_RIPPLES);
        gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.bindVertexArray(rec.mesh.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, rec.mesh.count, rec.count);
      }
      // The passes after this one bind their inputs to unit 0.
      gl.activeTexture(gl.TEXTURE0);
    };
    const drawRippleSurfaces = () => {
      let started = false;
      for (const rec of activeRecords) {
        if (!rec.geometry.mirrorRippleOnly || !rec.mesh || !rec.drawCount || rec.offscreen) continue;
        const node = rec.nodes[0], ripples = node.mirrorRipples, body = node.mirrorBody;
        const bodyActive = body && (body.contacts || body.active);
        if (!ripples?.active && !bodyActive) continue;
        if (!started) {
          if (!ensureMirrorProgram()) return;
          const pg = mirror.program;
          gl.useProgram(pg.prog);
          gl.uniform1f(pg.u.uClipMaxY, cutawayMaxY);
          applyCutaway(pg);
          gl.uniformMatrix4fv(pg.u.uViewProj, false, viewProj);
          gl.uniformMatrix4fv(pg.u.uReflectionViewProj, false, viewProj);
          gl.uniform1f(pg.u.uShard, 0);
          gl.uniform1f(pg.u.uPortal, 0);
          gl.uniform1f(pg.u.uReveal, 0);
          gl.uniform1f(pg.u.uRippleOnly, 1);
          bindMatrixTexture(pg);
          // The shared program's inactive samplers still need complete
          // bindings; this does not allocate or capture any reflection.
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, res.matrixTexture);
          gl.uniform1i(pg.u.uReflection, 2);
          gl.uniform1i(pg.u.uBodyField, 4);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          started = true;
        }
        const pg = mirror.program;
        applyCutaway(pg, rec.geometry);
        gl.activeTexture(gl.TEXTURE4);
        if (bodyActive) {
          if (!rec.rippleBodyTexture) {
            rec.rippleBodyTexture = createTexture(body.width, body.height * body.layers, gl.RGBA8, gl.LINEAR);
            rippleBodyTextures++;
          }
          gl.bindTexture(gl.TEXTURE_2D, rec.rippleBodyTexture);
          if (rec.rippleBodyState !== body || rec.rippleBodyVersion !== body.version) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, body.width, body.height * body.layers, gl.RGBA, gl.UNSIGNED_BYTE, body.pixels);
            rec.rippleBodyState = body; rec.rippleBodyVersion = body.version;
          }
          const bounds = boundsOf(node.geometry);
          gl.uniform4f(pg.u.uBodyBounds, bounds.min[0], bounds.min[1], bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
          gl.uniform2f(pg.u.uBodyTexel, 1 / body.width, 1 / body.height);
        } else gl.bindTexture(gl.TEXTURE_2D, res.matrixTexture);
        gl.uniform1i(pg.u.uBodyContacts, bodyActive ? body.contacts : 0);
        gl.uniform1i(pg.u.uBodyActive, bodyActive ? body.active : 0);
        gl.uniform4fv(pg.u.uBodyWaves, body ? body.waves : NO_MIRROR_BODY_WAVES);
        gl.uniformMatrix4fv(pg.u.uMirrorWorld, false, node.world);
        gl.uniform1i(pg.u.uRippleActive, ripples ? ripples.active : 0);
        gl.uniform1f(pg.u.uRippleTime, bodyActive ? body.time : ripples ? ripples.time : 0);
        gl.uniform4fv(pg.u.uRipples, ripples ? ripples.waves : NO_MIRROR_RIPPLES);
        const tint = node.rippleTint;
        gl.uniform3f(pg.u.uCrestTint, tint ? tint[0] : -1, tint ? tint[1] : 0, tint ? tint[2] : 0);
        gl.bindVertexArray(rec.mesh.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, rec.mesh.count, rec.drawCount);
        rippleSurfaces += rec.drawCount; rippleWaves += ripples ? ripples.active : 0;
      }
      if (started) {
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
      }
    };
    const blit = (f) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, f.scene);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, f.resolve);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.drawBuffers(DRAW_COLOR);
      gl.blitFramebuffer(0, 0, pw, ph, 0, 0, pw, ph, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.drawBuffers(DRAW_BRIGHT);
      gl.blitFramebuffer(0, 0, pw, ph, 0, 0, pw, ph, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.drawBuffers(DRAW_BOTH);
    };
    const fullscreen = (program, fb, w, h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(program.prog);
      gl.bindVertexArray(res.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    let collectForRender = collect, cullForRender = writeCullSphere, uploadForRender = uploadInstances;
    // Rig mode is per-call opt-in: the director passes the scene's choice
    // explicitly every frame, so snapshot callers never inherit a live rig.
    const render = (root, camera, opts = {}, meshRigs = opts.meshRigs === true) => {
      if (lost || !pollPrograms()) return false;
      rigMode = !!meshRigs && !!rigPrograms && !rigFailure;
      if (rigMode && !pollRigPrograms()) { if (rigFailure) rigMode = false; else return false; }
      programs = rigMode ? rigPrograms : res.programs;
      collectForRender = rigMode ? collectRig : collect;
      cullForRender = rigMode ? writeRigCullSphere : writeCullSphere;
      uploadForRender = rigMode ? uploadRigInstances : uploadInstances;
      cutawayMaxY = opts.cutawayMaxY ?? 1e6;
      cutawayFade = Math.max(0, Math.min(1, Number.isFinite(opts.cutawayFade) ? opts.cutawayFade : opts.birdsEyeCutaway ? 1 : 0));
      cutawayCloudY = opts.cutawayCloudY || 0;
      cutawayCloudMix = Math.max(0, Math.min(1, opts.cutawayCloudMix || 0));
      cutawayCount = Math.min(8, opts.cutawayRegionCount || 0);
      cutawayFrame++;
      for (let i = 0; i < cutawayCount; i++) {
        const r = opts.cutawayRegions[i], o = i * 4;
        cutawayRegions[o] = r.x; cutawayRegions[o + 1] = r.z; cutawayRegions[o + 2] = r.cos; cutawayRegions[o + 3] = r.sin;
        cutawayBounds[o] = r.halfWidth; cutawayBounds[o + 1] = r.halfDepth; cutawayBounds[o + 2] = r.y;
        cutawayBounds[o + 3] = Math.max(0, Math.min(1, r.mix === undefined ? 1 : r.mix));
      }
      const {
        light = DEFAULT_LIGHT,
        sky = DEFAULT_SKY,
        ground = DEFAULT_GROUND,
        sun = DEFAULT_SUN,
        sunDirection = light,
        direct = sun,
        directStrength = 1,
        ambientFloor = 0,
        diffuseFloor = 0,
        shadowStrength = 1,
        shadowFloor = 0,
        shadowBias = 0.0035,
        clear = DEFAULT_CLEAR,
        bloomStrength = 0.9,
        shadowCenter = DEFAULT_SHADOW_CENTER,
        shadowExtent = 13,
        horizon,
        zenith,
        moon = DEFAULT_MOON,
        moonSun = sunDirection,
        stars = 0,
        starMatrix = DEFAULT_STAR_MATRIX,
        time = 0,
        lights,
        lightCount = 0,
        spotLight = NO_SPOT_LIGHT,
        fog = null,
        fogNear = 0,
        fogFar = 0,
        matrix = null,
        clouds = 0,
        sea = null
      } = opts;
      skyHaze=opts.hazeDrop===undefined?1:opts.hazeDrop;
      if(dsbGPU && dsbGPU.state!==opts.dsbWater){dsbGPU.dispose();dsbGPU=null;}
      if(opts.dsbWater && !dsbGPU)dsbGPU=BL.dsbWater.gpu(gl,opts.dsbWater);
      if(dsbGPU)dsbGPU.bind(programs.mesh);
      gl.useProgram(programs.mesh.prog);
      gl.uniform1i(programs.mesh.u.uDSBSurface,7);
      gl.uniform1i(programs.mesh.u.uDSBDepth,8);
      const fogColor = fog || NO_FOG, fogA = fog ? fogNear : FOG_OFF, fogB = fog ? fogFar : FOG_OFF + 1;
      gl.useProgram(programs.mesh.prog);
      gl.uniform1f(programs.mesh.u.uWindTime, performance.now() * 0.001 % 3600);
      if (canvas.clientWidth !== width || canvas.clientHeight !== height) resize();
      const f = res.fbo, sh = res.shadow, pg = programs;
      const skyOn = !!(horizon && zenith);
      const nLights = lights ? Math.min(lightCount, settings.lights) : 0;
      mat4.lookAt(view, camera.position, camera.target, camera.up || UP);
      BL.scene.cameraProjection(proj, camera, width / height);
      mat4.multiply(viewProj, proj, view);
      extractFrustum(viewProj);
      const llen = Math.hypot(light.x, light.y, light.z) || 1;
      const lx = light.x / llen, ly = light.y / llen, lz = light.z / llen;
      const slen = Math.hypot(sunDirection.x, sunDirection.y, sunDirection.z) || 1;
      const sx = sunDirection.x / slen, sy = sunDirection.y / slen, sz = sunDirection.z / slen;
      if (skyOn) {
        skyInverse(invViewProj, proj, view);
        gl.useProgram(pg.sky.prog);
        gl.uniform3fv(pg.sky.u.uHorizon, horizon);
        gl.uniform3fv(pg.sky.u.uZenith, zenith);
        gl.uniform3fv(pg.sky.u.uSun, sun);
        gl.uniform3f(pg.sky.u.uSunDir, sx, sy, sz);
        gl.uniform3f(pg.sky.u.uMoonDir, moon.x, moon.y, moon.z);
        gl.uniform3f(pg.sky.u.uMoonSunDir, moonSun.x, moonSun.y, moonSun.z);
        gl.uniformMatrix3fv(pg.sky.u.uStarMatrix, false, starMatrix);
        gl.uniform1f(pg.sky.u.uStars, stars);
        // The sky's clouds, stars and sea move on the renderer's own clock, so every scene's water is alive.
        gl.uniform1f(pg.sky.u.uTime, performance.now() * 0.001 % 3600);
        gl.uniform1f(pg.sky.u.uClouds, clouds);
        gl.uniform4f(pg.sky.u.uSea, sea === null ? 0 : 1, sea === null ? 0 : sea, camera.position.y, 0);
        gl.uniform2f(pg.sky.u.uSeaEye, camera.position.x, camera.position.z);
      }
      // Set the light back far enough to bracket the shadowed volume.
      const lightDist = shadowExtent * 1.8, lightDepth = shadowExtent * 1.5;
      // The shadow matrix takes the light direction on a grid of 1/size per axis so the static map can hold: a turn
      // of d radians moves a point at the shadow extent E by E*d in light space and a texel is 2E/size, so the grid's
      // worst turn (sqrt(3)/2 of a step) shifts it under half a texel whatever the extent. Shading keeps the exact light.
      let qx = Math.round(lx * sh.size) / sh.size, qy = Math.round(ly * sh.size) / sh.size, qz = Math.round(lz * sh.size) / sh.size;
      const qlen = Math.hypot(qx, qy, qz);
      qx /= qlen;
      qy /= qlen;
      qz /= qlen;
      LIGHT_EYE.x = shadowCenter.x + qx * lightDist;
      LIGHT_EYE.y = shadowCenter.y + qy * lightDist;
      LIGHT_EYE.z = shadowCenter.z + qz * lightDist;
      mat4.lookAt(lightView, LIGHT_EYE, shadowCenter, Math.abs(qy) > 0.96 ? NORTH_UP : UP);
      mat4.ortho(lightProj, -shadowExtent, shadowExtent, -shadowExtent, shadowExtent, Math.max(0.5, lightDist - lightDepth), lightDist + lightDepth);
      mat4.multiply(lightViewProj, lightProj, lightView);
      mat4.transformPoint4(P4, lightViewProj, 0, 0, 0);
      const shadowSnap = sh.size * 0.5;
      lightProj[12] += (Math.round(P4[0] * shadowSnap) - P4[0] * shadowSnap) / shadowSnap;
      lightProj[13] += (Math.round(P4[1] * shadowSnap) - P4[1] * shadowSnap) / shadowSnap;
      mat4.multiply(lightViewProj, lightProj, lightView);
      // Indexed loops: render stays on the baseline compiler, where for-of boxes an iterator result every record.
      for (let i = 0; i < activeRecords.length; i++) {
        const rec = activeRecords[i];
        rec.active = false;
        // Drop the references without trimming the backing store the next frame's collect would immediately regrow.
        rec.nodes.fill(null);
        rec.batch = null;
        rec.offscreen = false;
      }
      activeCount = 0;
      reflectorNodes.length = 0;
      mirror.node = mirror.record = null;
      mirror.portal = mirror.frontFacing = mirror.walkThrough = false;
      mirror.reveal = 0;
      mirrorDebug.active = false;
      mirrorDebug.portal = false;
      mirrorDebug.reveal = 0;
      mirrorDebug.surfaceDrawn = false;
      mirrorDebug.ripples = 0;
      mirrorDebug.bodyContacts = mirrorDebug.bodyWaves = 0;
      mirror.shards = mirrorDebug.shardsDrawn = 0;
      culled = drawn = suppressed = rippleSurfaces = rippleWaves = 0;
      shadowFrame++;
      updateWorld(root, null);
      traverseVisible(root, collectForRender);
      activeRecords.length = activeCount;
      for (let i = 0; i < activeRecords.length; i++) {
        const rec = activeRecords[i];
        if (rec.offscreen) culled += rec.drawCount; else drawn += rec.drawCount;
        if (rec.geometry.mirrorSource && !rec.offscreen) mirror.shards += rec.drawCount;
        uploadForRender(rec);
      }
      // A matrix that moved since last frame (a following shadow centre) draws everything as before; a steady one
      // bakes the static casters once, then each frame copies them in and draws only the moving ones.
      let steady = true, baked = shadowStaticValid;
      for (let i = 0; i < 16; i++) {
        if (lightViewProj[i] !== shadowPrev[i]) steady = false;
        if (lightViewProj[i] !== shadowBaked[i]) baked = false;
      }
      shadowPrev.set(lightViewProj);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sh.fb);
      gl.viewport(0, 0, sh.size, sh.size);
      gl.useProgram(pg.shadow.prog);
      gl.uniformMatrix4fv(pg.shadow.u.uLightViewProj, false, lightViewProj);
      extractFrustum(lightViewProj, LIGHT_FRUSTUM);
      markLightVisible();
      const rebake = markShadowStatic() || !baked;
      gl.cullFace(gl.FRONT);
      shadowDraws = 0;
      if (!steady) {
        shadowStaticValid = false;
        gl.clear(gl.DEPTH_BUFFER_BIT);
        drawParts("mesh", "shadow");
      } else {
        if (rebake) {
          gl.clear(gl.DEPTH_BUFFER_BIT);
          shadowSubset = 1;
          drawParts("mesh", "shadow");
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sh.staticFb);
          gl.blitFramebuffer(0, 0, sh.size, sh.size, 0, 0, sh.size, sh.size, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
          shadowBakedCount = 0;
          for (const rec of activeRecords) {
            if (rec.shadowStatic) {
              rec.shadowBake = shadowBake + 1;
              shadowBakedCount++;
            } else if (rec.shadowBake === shadowBake) rec.shadowSettle = Math.min(rec.shadowSettle * 2, SHADOW_SETTLE * 32);
          }
          shadowBake++;
          shadowBaked.set(lightViewProj);
          shadowStaticValid = true;
          shadowStaticRebuilds++;
        } else {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sh.staticFb);
          gl.blitFramebuffer(0, 0, sh.size, sh.size, 0, 0, sh.size, sh.size, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, sh.fb);
        shadowSubset = 2;
        drawParts("mesh", "shadow");
        shadowSubset = 0;
      }
      gl.cullFace(gl.BACK);
      shadowPassCount++;
      if (mirror.node) {
        updateMirrorSide(camera);
        if (mirror.portal) {
          skipMirrorPass("portal-open");
        } else if (prepareMirrorCamera(camera)) {
          if (!ensureMirrorProgram()) skipMirrorPass("shader-pending");
          else renderMirrorCapture(clear, sky, ground, direct, directStrength, ambientFloor, diffuseFloor, shadowStrength, shadowFloor, shadowBias, lx, ly, lz, sh, lights, nLights, skyOn, fogColor, fogA, fogB, matrix, spotLight);
        }
        if (mirror.shards && ensureShardProgram()) {
          ensureEnvironment(clear);
          if (environment.valid !== 63 || environment.frame++ % settings.environmentCadence === 0) {
            const face = environment.next;
            prepareEnvironmentCamera(camera, face);
            renderMirrorCapture(clear, sky, ground, direct, directStrength, ambientFloor, diffuseFloor, shadowStrength, shadowFloor, shadowBias, lx, ly, lz, sh, lights, nLights, skyOn, fogColor, fogA, fogB, matrix, spotLight, face);
            environment.next = (face + 1) % 6;
          }
        }
      }
      if (reflectorNodes.length && ensureMirrorProgram()) {
        // The reflector covering most of the view captures every frame, and one other in turn.
        const n = reflectorNodes.length;
        let best = -1, bestArea = 16;
        for (let i = 0; i < n; i++) {
          const t = reflectorTarget(reflectorNodes[i].geometry);
          t.area = reflectorArea(reflectorNodes[i], camera);
          if (t.area > bestArea) { bestArea = t.area; best = i; }
        }
        // One just come into view with nothing captured yet goes first.
        let turn = -1;
        for (let i = 0; i < n && turn < 0; i++) {
          const t = reflectorTargets.get(reflectorNodes[i].geometry);
          if (i !== best && t.area >= 16 && !t.valid) turn = i;
        }
        for (let k = 0; k < n && turn < 0; k++) {
          const i = (reflectorTurn + k) % n;
          if (i !== best && reflectorTargets.get(reflectorNodes[i].geometry).area >= 16) turn = i;
        }
        if (turn >= 0) reflectorTurn = turn + 1;
        for (let pass = 0; pass < 2; pass++) {
          const i = pass ? turn : best;
          if (i < 0) continue;
          const node = reflectorNodes[i], t = reflectorTargets.get(node.geometry);
          if (prepareMirrorCamera(camera, node, t)) renderMirrorCapture(clear, sky, ground, direct, directStrength, ambientFloor, diffuseFloor, shadowStrength, shadowFloor, shadowBias, lx, ly, lz, sh, lights, nLights, skyOn, fogColor, fogA, fogB, matrix, spotLight, -1, t);
        }
      }
      const viewActor = opts.beforeView?.();
      if (viewActor) {
        // Mirror and shadow buffers already hold the world pose. Refresh only
        // the changed actor instances for the player's camera pass.
        updateWorld(viewActor.root, viewActor.root.parent?.world || null);
        try {
          for (const node of viewActor.gunViewNodes) {
            if (!node.visible || !node.geometry) continue;
            const rec = records.get(node.geometry);
            if (!rec || !rec.active) continue;
            cullForRender(node, CULL, 0);
            if (hiddenFromCamera(node) || !slotInFrustum(CULL, 0, FRUSTUM)) continue;
            for (let i = rec.drawCount; i < rec.count; i++) {
              if (rec.nodes[i] !== node) continue;
              rec.spheres.set(CULL, i * 4);
              drawSlot(rec, i);
              break;
            }
          }
          for (const rec of activeRecords) uploadForRender(rec);
        } finally {
          opts.afterView?.();
          updateWorld(viewActor.root, viewActor.root.parent?.world || null);
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.scene);
      gl.viewport(0, 0, pw, ph);
      gl.clearColor(clear[0], clear[1], clear[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.clearBufferfv(gl.COLOR, 1, ZERO4);
      gl.useProgram(pg.mesh.prog);
      gl.uniformMatrix4fv(pg.mesh.u.uViewProj, false, viewProj);
      gl.uniformMatrix4fv(pg.mesh.u.uLightViewProj, false, lightViewProj);
      gl.uniform3f(pg.mesh.u.uEye, camera.position.x, camera.position.y, camera.position.z);
      applyViewDirection(pg.mesh, proj, view);
      gl.uniform3f(pg.mesh.u.uLightDir, lx, ly, lz);
      gl.uniform3fv(pg.mesh.u.uSky, sky);
      gl.uniform3fv(pg.mesh.u.uGround, ground);
      gl.uniform3fv(pg.mesh.u.uSun, direct);
      gl.uniform1f(pg.mesh.u.uDirectStrength, directStrength);
      gl.uniform1f(pg.mesh.u.uAmbientFloor, ambientFloor);
      gl.uniform1f(pg.mesh.u.uDiffuseFloor, diffuseFloor);
      gl.uniform1f(pg.mesh.u.uShadowStrength, shadowStrength);
      gl.uniform1f(pg.mesh.u.uShadowFloor, shadowFloor);
      gl.uniform1f(pg.mesh.u.uShadowBias, shadowBias);
      gl.uniform1f(pg.mesh.u.uShadowTexel, 1 / sh.size);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sh.tex);
      gl.uniform1i(pg.mesh.u.uShadow, 0);
      bindMatrixTexture(pg.mesh);
      if (lights) gl.uniform4fv(pg.mesh.u.uLights, lights);
      gl.uniform1i(pg.mesh.u.uLightCount, nLights);
      gl.uniform4fv(pg.mesh.u.uSpotLight, spotLight);
      gl.uniform3fv(pg.mesh.u.uFog, fogColor);
      gl.uniform2f(pg.mesh.u.uFogRange, fogA, fogB);
      gl.uniform4f(pg.mesh.u.uMatrixParams, matrix ? matrix.active : 0, matrix ? matrix.radius : 0, matrix ? matrix.time : time, matrix ? matrix.density : 0);
      gl.uniform1i(pg.mesh.u.uMatrixSamples, Math.max(1, f.samples));
      if (matrix) gl.uniform3fv(pg.mesh.u.uMatrixOrigin, matrix.origin);
      else gl.uniform3f(pg.mesh.u.uMatrixOrigin, 0, 0, 0);
      gl.uniform4fv(pg.mesh.u.uMatrixCaves, matrix && matrix.caves || NO_MATRIX_CAVES);
      gl.uniform4fv(pg.mesh.u.uMatrixCaveBounds, matrix && matrix.caveBounds || NO_MATRIX_CAVES);
      gl.uniform1f(pg.mesh.u.uMatrixCaveNear, matrix && matrix.caveBounds ? matrix.caveNear : FOG_OFF);
      gl.uniform1f(pg.mesh.u.uMatrixPermanentCave, matrix ? matrix.permanentCave || 0 : 0);
      gl.uniform4fv(pg.mesh.u.uMatrixPermanentPlane, matrix && matrix.permanentPlane || NO_MATRIX_PLANE);
      gl.uniform4fv(pg.mesh.u.uMatrixPermanentAperture, matrix && matrix.permanentAperture || DEFAULT_MATRIX_APERTURE);
      gl.uniform1f(pg.mesh.u.uMatrixLivingGlobal, matrix ? matrix.livingGlobal ?? 1 : 1);
      drawParts("mesh", "mesh", true, true);
      drawMirrorSurface(camera);
      drawReflectors(camera);
      if (skyOn) drawSky(invViewProj, camera.position.y);
      drawGlass(true);
      // Ordinary surfaces first, then the effect-only black liner and native voxel glyphs; alpha follows the backing
      // shader's wave, depth still rejects hidden faces.
      gl.useProgram(pg.mesh.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      drawParts("mesh", "mesh", true, true, 1);
      drawParts("mesh", "mesh", true, true, 2);
      gl.depthMask(false);
      drawParts("mesh", "mesh", true, true, 3);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      drawRippleSurfaces();
      gl.useProgram(pg.line.prog);
      gl.uniformMatrix4fv(pg.line.u.uViewProj, false, viewProj);
      gl.uniform2f(pg.line.u.uViewport, pw, ph);
      gl.disable(gl.CULL_FACE);
      drawParts("line", "line", false, true);
      gl.enable(gl.CULL_FACE);
      if (f.samples > 0) blit(f);
      gl.disable(gl.DEPTH_TEST);
      const bw = f.bloomW, bh = f.bloomH;
      if (settings.bloom) {
        gl.useProgram(pg.blur.prog);
        gl.uniform1i(pg.blur.u.uTex, 0);
        gl.bindTexture(gl.TEXTURE_2D, f.bright);
        gl.uniform2f(pg.blur.u.uDir, 1.4 / bw, 0);
        fullscreen(pg.blur, f.ping[0].fb, bw, bh);
        gl.bindTexture(gl.TEXTURE_2D, f.ping[0].tex);
        gl.uniform2f(pg.blur.u.uDir, 0, 1.4 / bh);
        fullscreen(pg.blur, f.ping[1].fb, bw, bh);
        gl.bindTexture(gl.TEXTURE_2D, f.ping[1].tex);
        gl.uniform2f(pg.blur.u.uDir, 2.2 / bw, 0);
        fullscreen(pg.blur, f.ping[0].fb, bw, bh);
        gl.bindTexture(gl.TEXTURE_2D, f.ping[0].tex);
        gl.uniform2f(pg.blur.u.uDir, 0, 2.2 / bh);
        fullscreen(pg.blur, f.ping[1].fb, bw, bh);
        const ww = f.wideW, wh = f.wideH;
        gl.bindTexture(gl.TEXTURE_2D, f.ping[1].tex);
        gl.uniform2f(pg.blur.u.uDir, 1.6 / ww, 0);
        fullscreen(pg.blur, f.wide[0].fb, ww, wh);
        gl.bindTexture(gl.TEXTURE_2D, f.wide[0].tex);
        gl.uniform2f(pg.blur.u.uDir, 0, 1.6 / wh);
        fullscreen(pg.blur, f.wide[1].fb, ww, wh);
        gl.bindTexture(gl.TEXTURE_2D, f.wide[1].tex);
        gl.uniform2f(pg.blur.u.uDir, 2.8 / ww, 0);
        fullscreen(pg.blur, f.wide[0].fb, ww, wh);
        gl.bindTexture(gl.TEXTURE_2D, f.wide[0].tex);
        gl.uniform2f(pg.blur.u.uDir, 0, 2.8 / wh);
        fullscreen(pg.blur, f.wide[1].fb, ww, wh);
      }
      gl.useProgram(pg.composite.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, f.color);
      gl.uniform1i(pg.composite.u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, settings.bloom ? f.ping[1].tex : f.bright);
      gl.uniform1i(pg.composite.u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, f.wide ? f.wide[1].tex : f.bright);
      gl.uniform1i(pg.composite.u.uBloomWide, 2);
      // The sun's place on screen, when the sky is drawn, the sun is up and roughly ahead of the view.
      let shaft = 0;
      if (skyOn && f.depth && settings.shafts && sy > 0.02) {
        const far = camera.far * 0.9;
        mat4.transformPoint4(P4, viewProj, camera.position.x + sx * far, camera.position.y + sy * far, camera.position.z + sz * far);
        if (P4[3] > 0) {
          const ux = (P4[0] / P4[3]) * 0.5 + 0.5, uy = (P4[1] / P4[3]) * 0.5 + 0.5;
          const off = Math.max(0, Math.hypot(ux - 0.5, uy - 0.5) - 0.5);
          shaft = 0.55 * Math.min(1, sy * 6) * Math.max(0, 1 - off * 1.6);
          gl.uniform4f(pg.composite.u.uShaft, ux, uy, shaft, width / height);
          gl.uniform3fv(pg.composite.u.uShaftColor, sun);
        }
      }
      if (!shaft) gl.uniform4f(pg.composite.u.uShaft, 0, 0, 0, 1);
      // Only the shaft march reads the resolved depth, and it early-outs at zero strength.
      if (shaft && f.depthFb && f.samples > 0) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, f.scene);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, f.depthFb);
        gl.blitFramebuffer(0, 0, pw, ph, 0, 0, pw, ph, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      }
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, f.depth || f.bright);
      gl.uniform1i(pg.composite.u.uDepth, 4);
      gl.uniform1f(pg.composite.u.uBloomStrength, settings.bloom ? bloomStrength : 0);
      fullscreen(pg.composite, null, pw, ph);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.DEPTH_TEST);
      return true;
    };
    // Screen position of a world point, written into out.
    const project = (x, y, z, out = {}) => {
      mat4.transformPoint4(P4, viewProj, x, y, z);
      const depth = view[2] * x + view[6] * y + view[10] * z + view[14];
      if (P4[3] <= 0.01 || depth >= -0.01) return null;
      out.x = (P4[0] / P4[3] * 0.5 + 0.5) * width;
      out.y = (0.5 - P4[1] / P4[3] * 0.5) * height;
      out.depth = depth;
      return out;
    };
    const ray = (px, py, camera, out) => mat4.rayFromView(out, view, width, height, camera.fov, camera.position, px, py, camera.orthoMix, camera.orthoHeight);
    const setQuality = (name) => {
      if (!QUALITY[name] || QUALITY[name] === settings) return;
      settings = QUALITY[name];
      qualityName = name;
      buildShadow();
      resize();
    };
    const dispose = () => {
      if(dsbGPU){dsbGPU.dispose();dsbGPU=null;}
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      destroyRecords();
      for (const geometry of [...reflectorTargets.keys()]) destroyReflector(geometry);
      destroyMirror();
      destroyFbo();
      destroyShadow();
      if (res.matrixTexture) gl.deleteTexture(res.matrixTexture);
      for (const p of Object.values(res.programs)) gl.deleteProgram(p.prog);
      if (rigPrograms) {
        for (const p of [rigPrograms.mesh, rigPrograms.shadow]) {
          // A canceled entry can leave these lazy variants linking. Release
          // their shaders even when context loss is unavailable.
          for (const shader of p.shaders) gl.deleteShader(shader);
          p.shaders.length = 0;
          gl.deleteProgram(p.prog);
        }
        rigPrograms = null; rigProgramsReady = false;
      }
      if (res.quadVao) gl.deleteVertexArray(res.quadVao);
      res.programs = {}; programs = res.programs; rigMode = false;
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    };
    // Drop unreferenced buffers; they are rebuilt on demand.
    const releaseUnused = (live) => {
      let released = 0;
      if(dsbGPU && !live.has(dsbGPU.state.geometry)){dsbGPU.dispose();dsbGPU=null;}
      if (mirror.geometry && !live.has(mirror.geometry)) destroyMirror();
      else if (!mirror.geometry && mirror.program) {
        let rippleLive = false;
        for (const geometry of live) if (geometry.mirrorRippleOnly || geometry.reflector) { rippleLive = true; break; }
        if (!rippleLive) destroyMirrorProgram();
      }
      for (const geometry of records.keys()) {
        if (live.has(geometry)) continue;
        releaseGeometry(geometry);
        released++;
      }
      return released;
    };
    const releaseGeometry = (geometry) => {
      destroyReflector(geometry);
      if (geometry.meshRig) for (const program of [rigPrograms?.mesh, rigPrograms?.shadow]) {
        // Null forces the next ordinary draw to reset the joint-count uniform.
        if (program && program.rig === geometry.meshRig) program.rig = null;
      }
      const rec = records.get(geometry);
      if (!rec) return;
      deleteRecord(rec);
      records.delete(geometry);
    };
    init();
    return {
      kind: "webgl2",
      render,
      resize,
      project,
      ray,
      setQuality,
      releaseGeometry,
      createRig: createRendererRig,
      releaseUnused,
      dispose,
      get quality() {
        return qualityName;
      },
      get stats() {
        let shadowFinite = true;
        for (let i = 0; i < 16; i++) if (!Number.isFinite(lightViewProj[i])) shadowFinite = false;
        return { waterTextures: dsbGPU?2:0, records: records.size, active: activeRecords.length, mirrorResources: mirrorDebug.resources, imageTextures, rippleBodyTextures, shadowResources: res.shadow ? 4 : 0, shadowSize: res.shadow ? res.shadow.size : 0, shadowPassCount, shadowFinite, shadowDraws, shadowStatic: shadowStaticValid ? shadowBakedCount : 0, shadowStaticRebuilds, culled, drawn, suppressed, rippleSurfaces, rippleWaves };
      },
      get mirror() {
        return mirrorDebug;
      },
      get ready() {
        return !lost && !failure && ready && (!rigMode || rigProgramsReady);
      },
      get failure() {
        return failure;
      },
      get rigFailed() {
        return !!rigFailure;
      },
      get size() {
        return size;
      }
    };
  };
  BL.glRenderer = { createRenderer, createRig, isSupported, QUALITY, POINT_LIGHT_CAPACITY };
})();

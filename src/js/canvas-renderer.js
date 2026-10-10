(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { mat4, lerp, sortByKey, sortScratch } = BL.math;
  const { updateWorld, traverseVisible, matrixModeOf, hiddenFromCamera, hiddenFromCutaway } = BL.scene;
  const DEFAULT_SKY = [0.5, 0.52, 0.58];
  const DEFAULT_GROUND = [0.22, 0.2, 0.19];
  const CUBE_VIEWS = new Float32Array([1, 0, 0, 0, -1, 0, -1, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0, -1, 0]);
  const ENVIRONMENT_SIZE = 64, ENVIRONMENT_GRID = 4;
  const DEFAULT_MATRIX_APERTURE = new Float32Array([2.5, 3, 0.5, 0]);
  // Shared native Matrix greens, with quantized brightness so ripple pixels
  // never build RGB strings while a shot is crossing the mirror.
  const RIPPLE_GREENS = new Array(96);
  for (let tip = 0; tip < 3; tip++) for (let gain = 0; gain < 16; gain++) for (let odd = 0; odd < 2; odd++) {
    const emission = 0.88 + gain / 15 * 0.25, head = (tip === 2 ? 1 : tip === 1 ? 0.55 : 0) * 0.88;
    const r = Math.round(lerp((odd ? 70 : 24) * emission, 214.2, head));
    const g = Math.min(255, Math.round(lerp((odd ? 255 : 220) * emission, 255, head)));
    const b = Math.round(lerp((odd ? 112 : 74) * emission, 226.95, head));
    RIPPLE_GREENS[(tip * 16 + gain) * 2 + odd] = `rgb(${r},${g},${b})`;
  }
  const createRenderer = (canvas, { width: fixedW = 0, height: fixedH = 0, transparent = false, environmentCapture = false } = {}) => {
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, dpr = 1, backdrop = null, skyGradient = null, lastF = 1;
    let perspectiveWeight = 1, orthographicDepth = 0;
    const projectedDepth = depth => perspectiveWeight * depth + orthographicDepth;
    let clearRef = null, clearStyle = "", mirrorStyle = "#71808a";
    const size = { width: 0, height: 0 };
    const skyInts = new Int32Array(6);
    const mirrorInts = new Int32Array(3);
    const environment = { renderer: null, canvas: null, faces: [], contexts: [], source: null, next: 0, valid: 0, frame: 0, camera: null };
    const environmentVertices = new Float64Array((ENVIRONMENT_GRID + 1) ** 2 * 5), environmentClip = new Float64Array(40), environmentClipped = new Float64Array(40);
    const imageVertices = new Float64Array(13 * 9 * 5), imageView = mat4.create();
    const active = [];
    let sortCapacity = 0, sortIds = new Uint32Array(0), sortKeys = new Float64Array(0), sortWork = sortScratch(0);
    const DEFAULT_LIGHT = { x: 0.45, y: 0.85, z: 0.3 };
    const UP = { x: 0, y: 1, z: 0 };
    const view = mat4.create(), cutawayCloudWorld = mat4.create();
    let cutawayCloudY = 0, cutawayCloudMix = 0;
    const pool = [];
    let poolUsed = 0, suppressed = 0, rippleSurfaces = 0, rippleWaves = 0;
    let matrixActive = 0, matrixRadius = 0, matrixTime = 0, matrixDensity = 0, matrixOriginX = 0, matrixOriginZ = 0, matrixSurfaces = 0, matrixLivingSurfaces = 0, matrixArea = 0, matrixSamples = 0, matrixSampleStep = 1, matrixCulled = 0;
    let matrixCaves = null, matrixCaveBounds = null, matrixCaveNear = Infinity, matrixPermanentCave = 0, matrixPermanentPlane = null, matrixAperture = DEFAULT_MATRIX_APERTURE, matrixLivingGlobal = 1, matrixPointX = 0, matrixPointY = 0;
    const MATRIX_MASKS = new Int32Array([630678, 497559, 988959, 495513, 1009263, 288049, 456438, 616809]);
    // 32px scratch tile avoids copying a 64 KB image per tiny clipped face; sampling budget/spacing unchanged.
    const MATRIX_TILE_SIZE = 32, MATRIX_SAMPLE_BUDGET = 524288;
    const matrixTile = document.createElement("canvas");
    matrixTile.width = matrixTile.height = transparent ? 1 : MATRIX_TILE_SIZE;
    // Keep this scratch canvas CPU-backed via willReadFrequently: a GPU tile syncs its last upload per putImageData.
    const matrixCtx = matrixTile.getContext("2d", { willReadFrequently: true });
    const matrixImage = matrixCtx.createImageData(matrixTile.width, matrixTile.height);
    const matrixPixels = matrixImage.data;
    const matrixSample = new Float64Array(4);
    const matrixClipA = new Float64Array(32), matrixClipB = new Float64Array(32);
    const matrixStreams = new Float64Array(transparent ? 0 : 4096 * 6);
    const matrixPlaneKeys = new Int32Array(transparent ? 0 : 8192 * 4), matrixPlaneFrames = new Uint32Array(transparent ? 0 : 8192), matrixPlaneDepths = new Float64Array(transparent ? 0 : 8192);
    let matrixFrame = 0;
    const matrixHash = (n) => {
      let value = n | 0;
      value ^= value >>> 16;
      value = Math.imul(value, 2146121005);
      value ^= value >>> 15;
      value = Math.imul(value, -2073254261);
      value ^= value >>> 16;
      return (value >>> 8) / 16777216;
    };
    for (let stream = -2048; stream < matrixStreams.length / 6 - 2048; stream++) {
      const offset = (stream + 2048) * 6;
      const train = 7 + Math.floor(matrixHash(stream) * 6), sequence = train + 2 + Math.floor(matrixHash(stream + 41) * 5);
      matrixStreams[offset] = Math.floor(matrixHash(stream + 7) * 8);
      matrixStreams[offset + 1] = 0.56 + matrixHash(stream + 19) * 0.64;
      matrixStreams[offset + 2] = train;
      matrixStreams[offset + 3] = sequence;
      matrixStreams[offset + 4] = matrixHash(stream + 73) * sequence * 0.13;
      matrixStreams[offset + 5] = 0.58 + matrixHash(stream + 101) * 0.36;
    }
    const acquire = (vertices = 16) => {
      if (poolUsed === pool.length) {
        pool.push({ pts: new Float32Array(32), n: 0, depth: 0, style: "", coreStyle: "", line: false, lineGlow: 0, smokeOpacity: 1, mirror: false, mirrorNode: null, imageNode: null, mirrorMinX: 0, mirrorMaxX: 0, mirrorMinY: 0, mirrorMaxY: 0, portal: false, matrix: 0, matrixGlyph: false, matrixGlyphOpacity: 1, matrixWall: 0, matrixNx: 0, matrixNy: 0, matrixNz: 0, matrixPlane: 0, matrixCenterDepth: 0, matrixMinX: 0, matrixMaxX: 0, matrixMinY: 0, matrixMaxY: 0, matrixRed: 0, matrixGreen: 0, matrixBlue: 0, matrixCave: 0, matrixLocal: false, matrixLiving: false, matrixDynamic: false, matrixPermanentOnly: false, matrixPartial: false, matrixBacking: false, matrixFaceNx: 0, matrixFaceNy: 0, matrixFaceNz: 0, matrixFacePlane: 0 });
      }
      const rec = pool[poolUsed++];
      if (rec.pts.length < vertices * 2) rec.pts = new Float32Array(CLIP_VERTICES * 2);
      return rec;
    };
    // Six cave planes, height limits, eight five-plane cut prisms and the
    // near plane can add at most 49 vertices to an original 16-vertex face.
    const CLIP_VERTICES = 72, CUTAWAY_REGIONS = 8;
    const V = Array.from({ length: CLIP_VERTICES }, () => new Float32Array(3));
    const CLIP_IN = new Float32Array(CLIP_VERTICES * 3);
    const CLIP_OUT = new Float32Array(CLIP_VERTICES * 3);
    const MIRROR_CLIP_IN = new Float32Array(CLIP_VERTICES * 3);
    const MIRROR_CLIP_OUT = new Float32Array(CLIP_VERTICES * 3);
    const permanentFace = new Float32Array(CLIP_VERTICES * 3);
    const cutawayPlanes = new Float64Array(CUTAWAY_REGIONS * 20);
    const cutawayStack = Array.from({ length: CUTAWAY_REGIONS * 4 + 1 }, () => new Float32Array(CLIP_VERTICES * 3));
    const cutawayCounts = new Uint8Array(cutawayStack.length), cutawayNext = new Uint8Array(cutawayStack.length);
    const cutawayA = new Float32Array(CLIP_VERTICES * 3), cutawayB = new Float32Array(CLIP_VERTICES * 3);
    const lineWorld = new Float32Array(6), lineRanges = new Float64Array((CUTAWAY_REGIONS + 1) * 2);
    let cutawayUsed = 0, cutawayCount = 0, cutawaySurface = null, cutawayRegionCount = 0, lineRangeCount = 0, cutawayFade = 0;
    const rippleView = mat4.create();
    const rippleCircle = new Float32Array(98);
    for (let i = 0; i <= 48; i++) {
      rippleCircle[i * 2] = Math.cos(i * Math.PI / 24);
      rippleCircle[i * 2 + 1] = Math.sin(i * Math.PI / 24);
    }
    const BATCH_NODE = { geometry: null, world: new Float32Array(16), glow: 1, highlight: 0, scorch: 0, ember: 0, tip: 0, smokeOpacity: 1, depthBias: 0, matrixLiving: false, matrixEmissiveLiving: false, matrixCloud: false, matrixFullCave: 0 };
    const mirrorDebug = {
      active: false, faux: true, portal: false, reveal: 0, surfaceDrawn: false, captureValid: false, width: 0, height: 0, allocationCount: 0, reflectionPassCount: 0, skippedPassCount: 0, resources: 0, captureExcluded: true, reflectionOnlyCount: 0, planeDistance: 0, bodyContacts: 0, bodyWaves: 0,
      cameraPosition: new Float32Array(3), cameraTarget: new Float32Array(3), planeCenter: new Float32Array(3), planeNormal: new Float32Array(3), shardsDrawn: 0, environmentPassCount: 0, environmentFaces: 0, environmentSize: 0, environmentResources: 0, skipReason: "canvas-faux"
    };
    const resize = () => {
      dpr = environmentCapture ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      width = fixedW || canvas.clientWidth;
      height = fixedH || canvas.clientHeight;
      size.width = width;
      size.height = height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      backdrop = ctx.createLinearGradient(0, 0, 0, height);
      backdrop.addColorStop(0, "#181818");
      backdrop.addColorStop(1, "#0a0a0a");
      skyGradient = null;
    };
    const buildSky = (horizon, zenith) => {
      let same = skyGradient !== null;
      for (let i = 0; i < 3; i++) {
        const h = Math.round(horizon[i] * 255), z = Math.round(zenith[i] * 255);
        if (skyInts[i] !== h || skyInts[i + 3] !== z) same = false;
        skyInts[i] = h;
        skyInts[i + 3] = z;
      }
      if (same) return;
      skyGradient = ctx.createLinearGradient(0, 0, 0, height);
      skyGradient.addColorStop(0, `rgb(${skyInts[3]},${skyInts[4]},${skyInts[5]})`);
      skyGradient.addColorStop(0.62, `rgb(${skyInts[0]},${skyInts[1]},${skyInts[2]})`);
      skyGradient.addColorStop(1, `rgb(${Math.round(skyInts[0] * 0.55)},${Math.round(skyInts[1] * 0.55)},${Math.round(skyInts[2] * 0.55)})`);
    };
    const clipNear = (src, count, near, dst) => {
      let out = 0;
      for (let i = 0; i < count; i++) {
        const ax = src[i * 3], ay = src[i * 3 + 1], az = src[i * 3 + 2];
        const j = (i + 1) % count;
        const bx = src[j * 3], by = src[j * 3 + 1], bz = src[j * 3 + 2];
        const aIn = az <= -near, bIn = bz <= -near;
        if (aIn) {
          dst[out * 3] = ax;
          dst[out * 3 + 1] = ay;
          dst[out * 3 + 2] = az;
          out++;
        }
        if (aIn !== bIn) {
          const t = (-near - az) / (bz - az);
          dst[out * 3] = ax + (bx - ax) * t;
          dst[out * 3 + 1] = ay + (by - ay) * t;
          dst[out * 3 + 2] = -near;
          out++;
        }
      }
      return out;
    };
    const clipHeight = (src, count, height, dst, above = true) => {
      let out = 0;
      for (let i = 0; i < count; i++) {
        const a = i * 3, j = (i + 1) % count, b = j * 3;
        const aIn = above ? src[a + 1] >= height : src[a + 1] <= height, bIn = above ? src[b + 1] >= height : src[b + 1] <= height;
        if (aIn) {
          dst[out * 3] = src[a]; dst[out * 3 + 1] = src[a + 1]; dst[out * 3 + 2] = src[a + 2]; out++;
        }
        if (aIn !== bIn) {
          const amount = (height - src[a + 1]) / (src[b + 1] - src[a + 1]);
          dst[out * 3] = lerp(src[a], src[b], amount); dst[out * 3 + 1] = height; dst[out * 3 + 2] = lerp(src[a + 2], src[b + 2], amount); out++;
        }
      }
      return out;
    };
    const clipPlane = (src, count, nx, ny, nz, offset, dst) => {
      let out = 0;
      for (let i = 0; i < count; i++) {
        const a = i * 3, b = (i + 1) % count * 3;
        const da = nx * src[a] + ny * src[a + 1] + nz * src[a + 2] + offset, db = nx * src[b] + ny * src[b + 1] + nz * src[b + 2] + offset;
        if (da <= 0) { for (let k = 0; k < 3; k++) dst[out * 3 + k] = src[a + k]; out++; }
        if ((da <= 0) !== (db <= 0)) {
          const t = da / (da - db);
          for (let k = 0; k < 3; k++) dst[out * 3 + k] = src[a + k] + (src[b + k] - src[a + k]) * t;
          out++;
        }
      }
      return out;
    };
    const beginCutaway = (surface, count) => {
      const target = cutawayStack[0];
      for (let i = 0; i < count * 3; i++) target[i] = surface ? surface[i] : V[Math.floor(i / 3)][i % 3];
      cutawayCounts[0] = count; cutawayNext[0] = 0; cutawayUsed = 1;
    };
    const nextCutaway = () => {
      while (cutawayUsed) {
        const index = --cutawayUsed, region = cutawayNext[index];
        let count = cutawayCounts[index];
        if (region === cutawayRegionCount) {
          cutawayCount = count; cutawaySurface = cutawayStack[index]; return true;
        }
        let surface = cutawayA;
        for (let i = 0; i < count * 3; i++) surface[i] = cutawayStack[index][i];
        // Subtract one convex prism as disjoint outside pieces. Each piece
        // visits only later regions; depth-first traversal needs at most 33
        // stack slots even when a large terrain face spans all eight cuts.
        for (let side = 0; side < 5; side++) {
          const at = region * 20 + side * 4, nx = cutawayPlanes[at], ny = cutawayPlanes[at + 1];
          const nz = cutawayPlanes[at + 2], offset = cutawayPlanes[at + 3];
          let outside = 0, above = false;
          for (let i = 0; i < count; i++) {
            const d = nx * surface[i * 3] + ny * surface[i * 3 + 1] + nz * surface[i * 3 + 2] + offset;
            if (d > 0) outside++;
            if (d < 0) above = true;
          }
          // The cut removes only points strictly above its height. A face
          // lying on that plane belongs to the retained lower surface.
          if (outside === count || side === 0 && !above) {
            const target = cutawayStack[cutawayUsed];
            for (let i = 0; i < count * 3; i++) target[i] = surface[i];
            cutawayCounts[cutawayUsed] = count; cutawayNext[cutawayUsed++] = region + 1;
            break;
          }
          if (!outside) continue;
          const retained = clipPlane(surface, count, -nx, -ny, -nz, -offset, cutawayStack[cutawayUsed]);
          if (retained >= 3) { cutawayCounts[cutawayUsed] = retained; cutawayNext[cutawayUsed++] = region + 1; }
          const destination = surface === cutawayA ? cutawayB : cutawayA;
          count = clipPlane(surface, count, nx, ny, nz, offset, destination); surface = destination;
          if (count < 3) break;
        }
      }
      return false;
    };
    const cutawayLine = (regions) => {
      lineRanges[0] = 0; lineRanges[1] = 1; lineRangeCount = 1;
      for (let region = 0; region < regions && lineRangeCount; region++) {
        let start = 0, end = 1;
        for (let side = 0; side < 5; side++) {
          const at = region * 20 + side * 4, nx = cutawayPlanes[at], ny = cutawayPlanes[at + 1];
          const nz = cutawayPlanes[at + 2], offset = cutawayPlanes[at + 3];
          const a = nx * lineWorld[0] + ny * lineWorld[1] + nz * lineWorld[2] + offset;
          const b = nx * lineWorld[3] + ny * lineWorld[4] + nz * lineWorld[5] + offset;
          if (a > 0 && b > 0 || side === 0 && a >= 0 && b >= 0) { end = -1; break; }
          if ((a > 0) !== (b > 0)) {
            const t = a / (a - b);
            if (a > 0) start = Math.max(start, t); else end = Math.min(end, t);
          }
        }
        if (end <= start) continue;
        for (let i = lineRangeCount - 1; i >= 0; i--) {
          const at = i * 2, low = lineRanges[at], high = lineRanges[at + 1];
          if (start >= high || end <= low) continue;
          if (start > low && end < high) {
            lineRanges[lineRangeCount * 2] = end; lineRanges[lineRangeCount++ * 2 + 1] = high;
            lineRanges[at + 1] = start;
          } else if (start > low) lineRanges[at + 1] = start;
          else if (end < high) lineRanges[at] = end;
          else {
            lineRangeCount--;
            lineRanges[at] = lineRanges[lineRangeCount * 2]; lineRanges[at + 1] = lineRanges[lineRangeCount * 2 + 1];
          }
        }
      }
    };
    let eye = { x: 0, y: 0, z: 0 }, near = 0.2, cutawayMaxY = Infinity;
    const lightDir = new Float32Array([0, 1, 0]);
    let directStrength = 1, ambientFloor = 0.3, diffuseFloor = 0, skyLuma = 0.5, groundLuma = 0.2;
    let waterTime = 0;
    const waterWave = new Float64Array(3), waterBodyPoint = new Float64Array(3);
    let pointLights = null, pointLightCount = 0;
    let spotLight = null;
    const spotEnergy = (x, y, z, nx, ny, nz) => {
      if (!spotLight || spotLight[3] <= 0) return 0;
      const dx = x - spotLight[0], dy = y - spotLight[1], dz = z - spotLight[2], dist = Math.hypot(dx, dy, dz);
      if (dist < 0.0001 || dist >= spotLight[3]) return 0;
      const angle = (dx * spotLight[4] + dy * spotLight[5] + dz * spotLight[6]) / dist;
      const cone = smooth((angle - spotLight[7]) / (spotLight[11] - spotLight[7])), fade = 1 - dist / spotLight[3];
      return cone * fade * fade * Math.max(0, -(nx * dx + ny * dy + nz * dz) / dist) / (1 + 0.005 * dist * dist);
    };
    // Fog toward a colour; fogNear/fogFar start at 1e8/1e8+1 so it stays off until a frame sets one.
    const fogRgb = [0, 0, 0];
    let fogNear = 1e8, fogFar = 1e8 + 1;
    const smooth = (value) => {
      const t = Math.max(0, Math.min(1, value));
      return t * t * (3 - 2 * t);
    };
    const matrixTravel = (x, z, cave) => {
      if (cave && matrixCaves) {
        const offset = (cave - 1) * 4, nx = matrixCaves[offset], nz = matrixCaves[offset + 1];
        const depth = Math.max(0, matrixCaves[offset + 2] - x * nx - z * nz);
        return Math.hypot(x + nx * depth - matrixOriginX, z + nz * depth - matrixOriginZ) + depth;
      }
      return Math.hypot(x - matrixOriginX, z - matrixOriginZ);
    };
    const matrixFront = (travel) => matrixActive * (1 - smooth((travel - matrixRadius + 1.5) / 1.5));
    const matrixPlaneDistance = (x, y, z) => matrixPermanentPlane ? matrixPermanentPlane[0] * x + matrixPermanentPlane[1] * y + matrixPermanentPlane[2] * z + matrixPermanentPlane[3] : 0;
    const matrixPermanentAt = (x, y, z, cave) => {
      if (!cave || cave !== matrixPermanentCave || !matrixCaves || !matrixCaveBounds) return false;
      const depth = -matrixPlaneDistance(x, y, z), at = (cave - 1) * 4;
      const across = matrixCaves[at + 1] * (x - matrixCaveBounds[at]) - matrixCaves[at] * (z - matrixCaveBounds[at + 2]);
      const reach = matrixAperture[3] || 0.5 * (Math.abs(matrixCaves[at]) + Math.abs(matrixCaves[at + 1])), room = depth > matrixAperture[2] + 2.5 - reach, throat = depth <= matrixAperture[2];
      const height = y - matrixCaveBounds[at + 1], half = throat ? matrixAperture[0] : matrixAperture[0] + (room ? 0.5 : 0) + reach, ceiling = matrixAperture[1] + (room && !throat ? 1 : 0);
      return depth >= -1e-6 && depth <= matrixCaveBounds[at + 3] + reach && Math.abs(across) <= half + 1e-6 && height >= -1e-6 && height <= ceiling + 1e-6;
    };
    const matrixLivingCave = (x, y, z, permanentOnly = false) => {
      if (!matrixCaves || !matrixCaveBounds || Math.hypot(x - matrixOriginX, z - matrixOriginZ) < matrixCaveNear) return 0;
      const first = permanentOnly ? matrixPermanentCave - 1 : 0, end = permanentOnly ? matrixPermanentCave : matrixCaves.length / 4;
      for (let cave = first; cave < end; cave++) {
        const offset = cave * 4, sr = matrixCaves[offset], cr = matrixCaves[offset + 1];
        const depth = matrixCaves[offset + 2] - sr * x - cr * z;
        const extended = cave + 1 === matrixPermanentCave && matrixPermanentPlane && (matrixPermanentPlane[0] || matrixPermanentPlane[1] || matrixPermanentPlane[2]) && matrixPlaneDistance(x, y, z) <= 0;
        if (depth < 0 && !extended || depth > matrixCaveBounds[offset + 3]) continue;
        const localX = cr * (x - matrixCaveBounds[offset]) - sr * (z - matrixCaveBounds[offset + 2]);
        const localY = y - matrixCaveBounds[offset + 1], room = depth > 3;
        if (Math.abs(localX) <= (room ? 3.35 : 2.7) && localY >= 0 && localY <= (room ? 4.15 : 3.15)) return cave + 1;
      }
      return 0;
    };
    const matrixPlaneSlot = (nx, ny, nz, plane, write, depth) => {
      const sign = Math.abs(nx) > 0.0001 ? Math.sign(nx) : Math.abs(ny) > 0.0001 ? Math.sign(ny) : Math.sign(nz);
      const x = Math.round(nx * sign * 1000), y = Math.round(ny * sign * 1000), z = Math.round(nz * sign * 1000), d = Math.round(plane * sign * 1000);
      let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(d, 1640531513)) & 8191;
      for (let probe = 0; probe < 8192; probe++, slot = (slot + 1) & 8191) {
        const offset = slot * 4;
        if (matrixPlaneFrames[slot] !== matrixFrame) {
          if (!write) return -1;
          matrixPlaneFrames[slot] = matrixFrame;
          matrixPlaneKeys[offset] = x; matrixPlaneKeys[offset + 1] = y; matrixPlaneKeys[offset + 2] = z; matrixPlaneKeys[offset + 3] = d;
          matrixPlaneDepths[slot] = depth;
          return slot;
        }
        if (matrixPlaneKeys[offset] === x && matrixPlaneKeys[offset + 1] === y && matrixPlaneKeys[offset + 2] === z && matrixPlaneKeys[offset + 3] === d) {
          if (write) matrixPlaneDepths[slot] = Math.max(matrixPlaneDepths[slot], depth);
          return slot;
        }
      }
      return -1;
    };
    // A projective geometry's matrices carry a last row, so its transformed points are homogeneous: divide them out.
    const divideW = (out, m, x, y, z) => {
      const h = m[3] * x + m[7] * y + m[11] * z + m[15];
      out[0] /= h; out[1] /= h; out[2] /= h;
    };
    // Reject a complete static bounding box before walking its faces. The
    // mixed perspective/orthographic side planes are linear in view space.
    // Dynamic surfaces and Matrix receiver planes keep their existing path.
    const matrixReceiverCache = new WeakMap();
    const hasMatrixReceiver = (node) => {
      const g = node.geometry;
      if (matrixModeOf(node) || node.tip || g.matrixCave || g.matrixRevealBacking || g.matrixWorldGlyphSurface) return true;
      // Face flags are mutable until first render, so a cached verdict holds
      // only while the face array is the same object.
      let entry = matrixReceiverCache.get(g);
      if (entry && entry.faces === g.faces) return entry.receiver;
      let receiver = false;
      if (g.faces) for (const face of g.faces) {
        if (face.matrixCave || face.matrixPermanentFallback || face.matrixLocalGlyphSurface || face.matrixWorldGlyphSurface || face.color?.[3] < 0) { receiver = true; break; }
      }
      matrixReceiverCache.set(g, { faces: g.faces, receiver });
      return receiver;
    };
    const outsideView = (node) => {
      const g = node.geometry, w = node.world;
      if (w[3] || w[7] || w[11] || w[15] !== 1) return false;
      if (matrixActive || matrixPermanentCave && hasMatrixReceiver(node) || g.matrixGlyph || g.matrixLocalGlyphSurface || g.clipPlane || g.clipSlab || g.clipMinY !== undefined || g.clipMaxY !== undefined || cutawayRegionCount || cutawayMaxY < Infinity || g.projective || g.portalSurface || g.lakeBody || g.lakeWaves || g.lakeChargeRise || node.matrixCloud || node.mirror || node.mirrorPortal || node.mirrorShard || node.mirrorRippleOnly || g.reflector) return false;
      const b = BL.scene.boundsOf(g);
      const margin = g.lines?.length ? 8 : 3;
      let outside = 31;
      for (let corner = 0; corner < 8 && outside; corner++) {
        const x = b[corner & 1 ? "max" : "min"][0], y = b[corner & 2 ? "max" : "min"][1], z = b[corner & 4 ? "max" : "min"][2];
        const wx = w[0] * x + w[4] * y + w[8] * z + w[12], wy = w[1] * x + w[5] * y + w[9] * z + w[13], wz = w[2] * x + w[6] * y + w[10] * z + w[14];
        const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12], vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13], depth = -(view[2] * wx + view[6] * wy + view[10] * wz + view[14]);
        const span = projectedDepth(depth), hx = span * (width / 2 + margin) / lastF, hy = span * (height / 2 + margin) / lastF;
        // Match the seven-pixel line rejection (including its glow) or the
        // two-pixel face rejection, plus one for Float32 world/view rounding.
        // Crossing boxes are always retained.
        const epsilon = 1e-4 * (1 + Math.abs(wx) + Math.abs(wy) + Math.abs(wz));
        outside &= (depth < near - epsilon ? 1 : 0) | (vx < -hx - epsilon ? 2 : 0) | (vx > hx + epsilon ? 4 : 0) | (vy < -hy - epsilon ? 8 : 0) | (vy > hy + epsilon ? 16 : 0);
      }
      return outside !== 0;
    };
    const shadeNode = (node) => {
      const opacity = (node.smokeOpacity === undefined ? 1 : node.smokeOpacity) * (node.geometry.glassOpacity || node.geometry.glass || 1) * (node.geometry.cutawayHide ? 1 - cutawayFade : 1);
      if (opacity === 0) return;
      if (node.mirrorRippleOnly && !node.mirrorRipples?.active && !node.mirrorBody?.contacts && !node.mirrorBody?.active) return;
      const { verts, faces, lines } = node.geometry;
      let w = node.world;
      if (node.matrixCloud && cutawayCloudMix > 0) {
        cutawayCloudWorld.set(w);
        cutawayCloudWorld[13] += Math.min(0, cutawayCloudY - w[13]) * cutawayCloudMix;
        w = cutawayCloudWorld;
      }
      const f = lastF;
      const ember = Math.min(1, node.ember || 0), scorch = 1 - Math.min(1, node.scorch || 0) * 0.88;
      const materialGlow = ember > 0 ? 0 : node.glow;
      const mirrorFace = !!(node.mirror || node.mirrorPortal || node.mirrorShard || node.mirrorRippleOnly || node.geometry.reflector);
      const portalFace = !!node.mirrorPortal || !!node.mirrorWalkThrough && mirrorDebug.portal;
      const localMatrixGlyph = !!node.geometry.matrixGlyph;
      const liquid = !!node.geometry.portalSurface, rectangular = !!node.geometry.portalRect, projective = !!node.geometry.projective;
      const waterBody = node.geometry.lakeBody;
      // Every voxel face in a glyph shares this instance plane and basis.
      const glyphLength = localMatrixGlyph ? Math.hypot(w[8], w[9], w[10]) : 1;
      const glyphNx = w[8] / glyphLength, glyphNy = w[9] / glyphLength, glyphNz = w[10] / glyphLength;
      const glyphPlane = localMatrixGlyph ? glyphNx * w[12] + glyphNy * w[13] + glyphNz * w[14] : 0;
      const glyphDepth = localMatrixGlyph ? view[2] * w[12] + view[6] * w[13] + view[10] * w[14] + view[14] : 0;
      const matrixMode = matrixModeOf(node) || node.tip;
      if (mirrorFace && portalFace) return;
      let mirrorMinimumY = -Infinity;
      const mirrorReveal = mirrorFace ? Math.max(0, Math.min(1, node.mirrorReveal || 0)) : 0;
      if (mirrorReveal > 0) {
        const bounds = BL.scene.boundsOf(node.geometry), min = bounds.min, max = bounds.max;
        const low = w[13] + Math.min(w[1] * min[0], w[1] * max[0]) + Math.min(w[5] * min[1], w[5] * max[1]) + Math.min(w[9] * min[2], w[9] * max[2]);
        const high = w[13] + Math.max(w[1] * min[0], w[1] * max[0]) + Math.max(w[5] * min[1], w[5] * max[1]) + Math.max(w[9] * min[2], w[9] * max[2]);
        mirrorMinimumY = lerp(low, high, mirrorReveal);
      }
      const preserved = !!node.geometry.cutawayPreserve, selective = !preserved && cutawayRegionCount > 0;
      const clipMinimumY = node.geometry.clipMinY ?? -Infinity;
      const clipMaximumY = Math.min(preserved ? Infinity : cutawayMaxY, node.geometry.clipMaxY ?? Infinity);
      let shardDrawn = false;
      if (faces) {
        for (const face of faces) {
          const idx = face.i;
          const count = idx.length;
          if (liquid) {
            // Portal faces are radial strips. Skip those beyond the reveal,
            // then trim only the crossing strip; the interior keeps its scale.
            const a = idx[0] * 3, b = idx[1] * 3;
            const ra=rectangular?Math.max(Math.abs(verts[a]),Math.abs(verts[a+2])):Math.hypot(verts[a],verts[a+2]);
            const rb=rectangular?Math.max(Math.abs(verts[b]),Math.abs(verts[b+2])):Math.hypot(verts[b],verts[b+2]);
            if (Math.min(ra,rb) >= node.portalReveal) continue;
          }
          let centerX = 0, centerY = 0, centerZ = 0, liquidX = 0, liquidZ = 0;
          for (let k = 0; k < count; k++) {
            const b = idx[k] * 3;
            let x = verts[b], y = verts[b + 1], z = verts[b + 2];
            if (waterBody && waterBody[2] > 0) {
              BL.poolWater.sampleBody(waterBodyPoint, x, y, z, waterBody);
              x = waterBodyPoint[0]; y = waterBodyPoint[1]; z = waterBodyPoint[2];
            }
            if (liquid) {
              const radius = rectangular?Math.max(Math.abs(x),Math.abs(z)):Math.hypot(x, z);
              if (radius > node.portalReveal) { const clip = node.portalReveal / radius; x *= clip; z *= clip; }
              liquidX += x / count; liquidZ += z / count;
            }
            const displacement = liquid ? BL.oogaPortalModels.liquidHeight(x, z, node.portalTime, node.portalSurge, rectangular) : 0;
            mat4.transformPoint(V[k], w, x, y + displacement, z);
            if (face.lake && node.geometry.lakeWaves) {
              BL.poolWater.sampleWaves(waterWave, V[k][0], V[k][2], node.geometry.lakeWaves, node.geometry.lakeWaveEnd);
              V[k][1] += waterWave[0];
            }
            const charge = node.geometry.lakeCharge, curve = node.geometry.lakeFlowCurve;
            if (face.lake && node.geometry.lakeChargeRise && charge && charge[1] > 0 && curve) {
              const dx = V[k][0] - curve[0], dz = V[k][2] - curve[1], tau = Math.PI * 2;
              let distance = Math.abs(((Math.atan2(dx, dz) - curve[2]) % tau + tau) % tau * curve[3]);
              if (charge[2] > 2.5) distance = Math.min(distance, Math.max(0, charge[3] - distance));
              V[k][1] += node.geometry.lakeChargeRise * charge[1] * (1 - smooth((distance - charge[0] + 0.45) / 0.6));
            }
            if (projective) divideW(V[k], w, x, y + displacement, z);
            centerX += V[k][0];
            centerY += V[k][1];
            centerZ += V[k][2];
          }
          let maximumY = clipMaximumY;
          if (maximumY < Infinity) {
            let below = 0;
            for (let k = 0; k < count; k++) if (V[k][1] <= maximumY) below++;
            if (!below) continue;
            if (below === count) maximumY = Infinity;
          }
          let nx = 0, ny = 0, nz = 0;
          for (let k = 0; k < count; k++) {
            const a = V[k], b = V[(k + 1) % count];
            nx += (a[1] - b[1]) * (a[2] + b[2]);
            ny += (a[2] - b[2]) * (a[0] + b[0]);
            nz += (a[0] - b[0]) * (a[1] + b[1]);
          }
          const nlen = Math.hypot(nx, ny, nz);
          if (nlen < 1e-9) continue;
          nx /= nlen;
          ny /= nlen;
          nz /= nlen;
          if (!portalFace && perspectiveWeight * (nx * (V[0][0] - eye.x) + ny * (V[0][1] - eye.y) + nz * (V[0][2] - eye.z)) - orthographicDepth * (nx * view[2] + ny * view[6] + nz * view[10]) >= 0) {
            if (!node.geometry.twoSided) continue;
            nx = -nx; ny = -ny; nz = -nz;
          }
          centerX /= count;
          centerY /= count;
          centerZ /= count;
          const lakeOcclude = node.geometry.lakeOcclude;
          if (lakeOcclude && lakeOcclude[3] > 0 && eye.y > lakeOcclude[1] && centerY < lakeOcclude[1]) {
            const dx = perspectiveWeight * (eye.x - centerX) + orthographicDepth * view[2];
            const dy = perspectiveWeight * (eye.y - centerY) + orthographicDepth * view[6];
            const dz = perspectiveWeight * (eye.z - centerZ) + orthographicDepth * view[10];
            if (dy > 0) {
              const crossing = (lakeOcclude[1] - centerY) / dy;
              if (Math.hypot(centerX + dx * crossing - lakeOcclude[0], centerZ + dz * crossing - lakeOcclude[2]) < lakeOcclude[3]) continue;
            }
          }
          let faceOpacity = opacity;
          if (node.geometry.lightBeam) {
            const along = ((centerX - w[12]) * w[0] + (centerY - w[13]) * w[1] + (centerZ - w[14]) * w[2]) / (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
            const fade = Math.max(0, Math.min(1, 1 - along / node.geometry.lightBeam));
            faceOpacity *= fade * fade;
          }
          // Mode 5 keeps its own palette in the Matrix; clouds are mode 4.
          const matrixNative = matrixMode > 4.5;
          const matrixCloud = matrixMode > 3.5 && !matrixNative;
          const matrixLiving = matrixMode > 1.5 && matrixMode < 3.5 && (matrixMode < 2.5 || face.emissive > 0);
          const permanentFallback = !matrixLiving && !!face.matrixPermanentFallback && !!matrixPermanentCave;
          const flow = matrixLiving || permanentFallback ? Math.hypot(centerX - matrixOriginX, centerZ - matrixOriginZ) : 0;
          const staticCave = face.matrixCave || node.geometry.matrixCave || 0;
          const dynamicCave = !staticCave && (matrixPermanentCave || matrixActive && matrixRadius >= matrixCaveNear) && (matrixLiving || permanentFallback) && matrixCaveBounds && flow >= matrixCaveNear;
          const cave = staticCave || (dynamicCave ? matrixLivingCave(centerX, centerY, centerZ, permanentFallback) : 0);
          let permanent = !matrixNative && matrixPermanentAt(centerX, centerY, centerZ, cave), permanentPossible = permanent, permanentClipNeeded = false;
          if (!matrixNative && matrixPermanentCave && matrixCaves && matrixCaveBounds && (staticCave === matrixPermanentCave || dynamicCave)) {
            let minPlane = Infinity, maxPlane = -Infinity, radius2 = 0;
            for (let k = 0; k < count; k++) {
              const p = V[k], d = matrixPlaneDistance(p[0], p[1], p[2]);
              minPlane = Math.min(minPlane, d); maxPlane = Math.max(maxPlane, d);
              permanent &&= matrixPermanentAt(p[0], p[1], p[2], cave);
              radius2 = Math.max(radius2, (p[0] - centerX) ** 2 + (p[1] - centerY) ** 2 + (p[2] - centerZ) ** 2);
            }
            permanent &&= maxPlane <= 1e-6;
            const at = (matrixPermanentCave - 1) * 4, roomStart = matrixAperture[2] + 2.5 - (matrixAperture[3] || 0.5 * (Math.abs(matrixCaves[at]) + Math.abs(matrixCaves[at + 1])));
            permanentClipNeeded = !permanent || minPlane < -matrixAperture[2] && maxPlane > -matrixAperture[2] || minPlane < -roomStart && maxPlane > -roomStart;
            permanentPossible = minPlane <= 1e-6;
            if (dynamicCave) {
              // Bound the whole face, then evaluate the actual cave/plane at
              // each covered sample. A crossing limb never flips as one node.
              const radius = Math.sqrt(radius2), at = (matrixPermanentCave - 1) * 4;
              const nx = matrixCaves[at], nz = matrixCaves[at + 1], depth = matrixCaves[at + 2] - nx * centerX - nz * centerZ;
              const across = nz * (centerX - matrixCaveBounds[at]) - nx * (centerZ - matrixCaveBounds[at + 2]);
              const height = centerY - matrixCaveBounds[at + 1];
              permanentPossible &&= depth - radius <= matrixCaveBounds[at + 3] && Math.abs(across) - radius <= 3.35 && height + radius >= 0 && height - radius <= 4.15;
              permanent = false;
            }
          }
          const localGlyphSurface = !face.matrixWorldGlyphSurface && !!(node.geometry.matrixLocalGlyphSurface || face.matrixLocalGlyphSurface || staticCave);
          const revealBacking = !!node.geometry.matrixRevealBacking;
          const ownedGlyph = localMatrixGlyph && cave && matrixCaves;
          const reachedGlyph = localMatrixGlyph && node.matrixFullCave && node.matrixFullCave === cave;
          let minimumFront = permanent || reachedGlyph || localMatrixGlyph && !ownedGlyph ? 1 : 0, maximumFront = permanentPossible ? 1 : minimumFront;
          if (!matrixNative && !permanent && !reachedGlyph && matrixActive && (!matrixLiving || matrixLivingGlobal) && (!localMatrixGlyph || ownedGlyph)) {
            let radiusSquared = 0;
            for (let k = 0; k < count; k++) radiusSquared = Math.max(radiusSquared, (V[k][0] - centerX) ** 2 + (V[k][2] - centerZ) ** 2);
            const distance = matrixCloud ? Math.min(matrixTravel(centerX, centerZ, cave), 36) : matrixTravel(centerX, centerZ, cave), margin = Math.sqrt(radiusSquared) * (cave && matrixCaves ? Math.SQRT2 : 1);
            // Cap the whole living face's travel interval, not its centre, so distant occupants keep partial reveal pixels.
            // Cave paths keep their entrance distance.
            const livingOutside = matrixLiving && !cave;
            minimumFront = Math.max(minimumFront, matrixFront(livingOutside ? Math.min(distance + margin, 36) : distance + margin));
            maximumFront = Math.max(maximumFront, matrixFront(livingOutside ? Math.min(Math.max(0, distance - margin), 36) : Math.max(0, distance - margin)));
          }
          if ((localMatrixGlyph || revealBacking) && maximumFront <= 0) continue;
          const partial = maximumFront > 0 && minimumFront < 1;
          const matrixAmount = !localMatrixGlyph && !partial ? minimumFront : 0;
          const clipPermanent = permanentClipNeeded && localMatrixGlyph && !matrixActive && staticCave === matrixPermanentCave && matrixPermanentPlane;
          let firstRegion = 0, lastRegion = 0, permanentReach = 0;
          if (clipPermanent) {
            let minDepth = Infinity, maxDepth = -Infinity;
            for (let k = 0; k < count; k++) {
              const depth = -matrixPlaneDistance(V[k][0], V[k][1], V[k][2]);
              minDepth = Math.min(minDepth, depth); maxDepth = Math.max(maxDepth, depth);
              for (let axis = 0; axis < 3; axis++) permanentFace[k * 3 + axis] = V[k][axis];
            }
            const at = (matrixPermanentCave - 1) * 4;
            permanentReach = matrixAperture[3] || 0.5 * (Math.abs(matrixCaves[at]) + Math.abs(matrixCaves[at + 1]));
            firstRegion = minDepth <= matrixAperture[2] ? 0 : minDepth <= matrixAperture[2] + 2.5 - permanentReach ? 1 : 2;
            lastRegion = maxDepth <= matrixAperture[2] ? 0 : maxDepth <= matrixAperture[2] + 2.5 - permanentReach ? 1 : 2;
          }
          // Clip native voxel faces themselves, including their extrusion, to
          // the union of the aperture, tunnel and room before rasterization.
          for (let region = firstRegion; region <= lastRegion; region++) {
            let surface = null, surfaceCount = count;
            if (clipPermanent) {
              surface = MIRROR_CLIP_IN; for (let k = 0; k < count * 3; k++) surface[k] = permanentFace[k];
              const at = (matrixPermanentCave - 1) * 4, sr = matrixCaves[at], cr = matrixCaves[at + 1], across = -cr * matrixCaveBounds[at] + sr * matrixCaveBounds[at + 2];
              const half = region === 0 ? matrixAperture[0] : matrixAperture[0] + (region === 2 ? 0.5 : 0) + permanentReach, ceiling = matrixAperture[1] + (region === 2 ? 1 : 0);
              for (let side = 0; side < 6; side++) {
                const destination = surface === MIRROR_CLIP_IN ? MIRROR_CLIP_OUT : MIRROR_CLIP_IN;
                if (side === 0) surfaceCount = clipPlane(surface, surfaceCount, matrixPermanentPlane[0], matrixPermanentPlane[1], matrixPermanentPlane[2], matrixPermanentPlane[3] + (region === 0 ? 0 : region === 1 ? matrixAperture[2] : matrixAperture[2] + 2.5 - permanentReach), destination);
                else if (side === 1) surfaceCount = clipPlane(surface, surfaceCount, -matrixPermanentPlane[0], -matrixPermanentPlane[1], -matrixPermanentPlane[2], -matrixPermanentPlane[3] - (region === 0 ? matrixAperture[2] : region === 1 ? matrixAperture[2] + 2.5 - permanentReach : matrixCaveBounds[at + 3] + permanentReach), destination);
                else if (side < 4) { const sign = side === 2 ? 1 : -1; surfaceCount = clipPlane(surface, surfaceCount, cr * sign, 0, -sr * sign, across * sign - half, destination); }
                else surfaceCount = clipPlane(surface, surfaceCount, 0, side === 4 ? -1 : 1, 0, side === 4 ? matrixCaveBounds[at + 1] : -matrixCaveBounds[at + 1] - ceiling, destination);
                surface = destination;
                if (surfaceCount < 3) break;
              }
              if (surfaceCount < 3) continue;
            }
            const minimumY = Math.max(clipMinimumY, mirrorMinimumY);
            // Only clipped geometry needs its face copied into the clip buffers.
            if (!surface && (minimumY > -Infinity || maximumY < Infinity)) {
              surface = MIRROR_CLIP_IN;
              for (let k = 0; k < count; k++) {
                surface[k * 3] = V[k][0]; surface[k * 3 + 1] = V[k][1]; surface[k * 3 + 2] = V[k][2];
              }
            }
            if (minimumY > -Infinity) {
              const destination = surface === MIRROR_CLIP_IN ? MIRROR_CLIP_OUT : MIRROR_CLIP_IN;
              surfaceCount = clipHeight(surface, surfaceCount, minimumY, destination);
              surface = destination;
              if (surfaceCount < 3) continue;
            }
            if (maximumY < Infinity) {
              const destination = surface === MIRROR_CLIP_IN ? MIRROR_CLIP_OUT : MIRROR_CLIP_IN;
              surfaceCount = clipHeight(surface, surfaceCount, maximumY, destination, false);
              surface = destination;
              if (surfaceCount < 3) continue;
            }
            const objectClip = node.geometry.clipPlane;
            if (objectClip) {
              if (!surface) {
                surface = MIRROR_CLIP_IN;
                for (let k = 0; k < count; k++) {
                  surface[k * 3] = V[k][0]; surface[k * 3 + 1] = V[k][1]; surface[k * 3 + 2] = V[k][2];
                }
              }
              const destination = surface === MIRROR_CLIP_IN ? MIRROR_CLIP_OUT : MIRROR_CLIP_IN;
              surfaceCount = clipPlane(surface, surfaceCount, objectClip[0], objectClip[1], objectClip[2], objectClip[3], destination);
              surface = destination;
              if (surfaceCount < 3) continue;
            }
            // A slab (n, d) keeps |n.p + d| <= 1: two planes, n.p + d - 1 <= 0 and -n.p - d - 1 <= 0.
            const slab = node.geometry.clipSlab;
            if (slab) {
              if (!surface) {
                surface = MIRROR_CLIP_IN;
                for (let k = 0; k < count; k++) {
                  surface[k * 3] = V[k][0]; surface[k * 3 + 1] = V[k][1]; surface[k * 3 + 2] = V[k][2];
                }
              }
              for (let sign = 1; sign >= -1 && surfaceCount >= 3; sign -= 2) {
                const destination = surface === MIRROR_CLIP_IN ? MIRROR_CLIP_OUT : MIRROR_CLIP_IN;
                surfaceCount = clipPlane(surface, surfaceCount, slab[0] * sign, slab[1] * sign, slab[2] * sign, slab[3] * sign - 1, destination);
                surface = destination;
              }
              if (surfaceCount < 3) continue;
            }
            if (selective) beginCutaway(surface, surfaceCount);
            for (let piece = 0; selective ? nextCutaway() : piece < 1; piece++) {
              if (selective) { surface = cutawaySurface; surfaceCount = cutawayCount; }
              for (let k = 0; k < surfaceCount; k++) {
                if (surface) mat4.transformPoint(V[k], view, surface[k * 3], surface[k * 3 + 1], surface[k * 3 + 2]);
                else mat4.transformPoint(V[k], view, V[k][0], V[k][1], V[k][2]);
                CLIP_IN[k * 3] = V[k][0];
                CLIP_IN[k * 3 + 1] = V[k][1];
                CLIP_IN[k * 3 + 2] = V[k][2];
              }
              // A just-closed doorway must cover the view inside the near plane: mirrorFace clips at 1e-7, real depth kept.
              const clipped = clipNear(CLIP_IN, surfaceCount, mirrorFace ? 1e-7 : near, CLIP_OUT);
              if (clipped < 3) continue;
              const rec = acquire(clipped);
              let zsum = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (let k = 0; k < clipped; k++) {
                const cz = CLIP_OUT[k * 3 + 2];
                const scale = f / projectedDepth(-cz);
                rec.pts[k * 2] = width / 2 + CLIP_OUT[k * 3] * scale;
                rec.pts[k * 2 + 1] = height / 2 - CLIP_OUT[k * 3 + 1] * scale;
                minX = Math.min(minX, rec.pts[k * 2]); maxX = Math.max(maxX, rec.pts[k * 2]);
                minY = Math.min(minY, rec.pts[k * 2 + 1]); maxY = Math.max(maxY, rec.pts[k * 2 + 1]);
                zsum += cz;
              }
              rec.n = clipped;
              rec.depth = zsum / clipped - (node.depthBias || 0);
              rec.line = false;
              rec.smokeOpacity = faceOpacity;
              rec.mirror = mirrorFace;
              rec.mirrorNode = mirrorFace ? node : null;
              rec.imageNode = node.geometry.imageSurface ? node : null;
              if (mirrorFace) {
                rec.mirrorMinX = rec.mirrorMinY = Infinity;
                rec.mirrorMaxX = rec.mirrorMaxY = -Infinity;
                for (let k = 0; k < count; k++) {
                  const at = idx[k] * 3;
                  rec.mirrorMinX = Math.min(rec.mirrorMinX, verts[at]); rec.mirrorMaxX = Math.max(rec.mirrorMaxX, verts[at]);
                  rec.mirrorMinY = Math.min(rec.mirrorMinY, verts[at + 1]); rec.mirrorMaxY = Math.max(rec.mirrorMaxY, verts[at + 1]);
                }
              }
              rec.portal = portalFace;
              rec.matrixGlyph = localMatrixGlyph;
              rec.matrixGlyphOpacity = (node.geometry.matrixGlyphOpacity ?? 1) * opacity;
              rec.matrixCave = cave;
              // Keep cave travel for any owned or crossing face; distant static
              // fallbacks need only the ordinary radial wave sample.
              rec.matrixDynamic = dynamicCave && (matrixLiving || cave || permanentPossible);
              rec.matrixPermanentOnly = permanentFallback;
              rec.matrixLocal = localGlyphSurface;
              rec.matrixPartial = partial;
              rec.matrixBacking = revealBacking;
              if (localMatrixGlyph) {
                rec.matrixNx = glyphNx; rec.matrixNy = glyphNy; rec.matrixNz = glyphNz;
                rec.matrixPlane = glyphPlane; rec.matrixCenterDepth = glyphDepth;
                rec.matrixFaceNx = nx; rec.matrixFaceNy = ny; rec.matrixFaceNz = nz;
                rec.matrixFacePlane = nx * (centerX - eye.x) + ny * (centerY - eye.y) + nz * (centerZ - eye.z);
              } else if (maximumFront && localGlyphSurface) matrixPlaneSlot(nx, ny, nz, nx * centerX + ny * centerY + nz * centerZ, true, rec.depth);
              if (maximumFront && !localMatrixGlyph) {
                if (matrixLiving) matrixLivingSurfaces++;
                else matrixSurfaces++;
              }
              // Offscreen receivers still register plane depth for visible glyphs; skip only shading and the draw record.
              if (maxX < -2 || minX > width + 2 || maxY < -2 || minY > height + 2) { rec.mirrorNode = rec.imageNode = null; poolUsed--; continue; }
              if (node.mirrorShard && !shardDrawn) { mirrorDebug.shardsDrawn++; shardDrawn = true; }
              const emissive = Math.max((face.emissive || 0) * materialGlow, ember * 0.9);
              rec.matrixLiving = matrixLiving;
              let k, glyphDistance = 0;
              if (localMatrixGlyph) {
                const side = 1 - smooth((Math.abs(nx * w[8] + ny * w[9] + nz * w[10]) / glyphLength - 0.45) / 0.45);
                const vx = eye.x - centerX, vy = eye.y - centerY, vz = eye.z - centerZ, vlen = glyphDistance = Math.hypot(vx, vy, vz);
                const sideShade = 0.7 + Math.max(0, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]) * 0.22 + Math.max(0, (nx * vx + ny * vy + nz * vz) / vlen) * 0.08;
                k = lerp(0.78, 1.15, Math.min(1, emissive)) * lerp(1, sideShade, side);
              } else {
                const diffuse = Math.max(diffuseFloor, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]);
                const hemi = Math.max(ambientFloor, lerp(groundLuma, skyLuma, ny * 0.5 + 0.5));
                k = lerp(Math.min(1, hemi + diffuse * 0.7 * directStrength), 1.1, Math.min(1, emissive));
              }
              k = lerp(k, 1.3, node.scorch > 0 ? 0 : node.highlight * 0.4);
              const c = face.color;
              const detail = 0.72 + (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722) / 255 * scorch * 0.28;
              const heat = 255 * detail;
              const cr = lerp(c[0] * scorch, heat, ember * 0.9);
              const cg = lerp(c[1] * scorch, heat * (0.12 + ember * 0.85), ember * 0.9);
              const cb = lerp(c[2] * scorch, heat * (0.01 + ember * ember * ember * 0.74), ember * 0.9);
              const tip = node.tip > 1.5 ? 0 : node.tip || 0;
              const fog = localMatrixGlyph ? smooth((glyphDistance - fogNear) / (fogFar - fogNear)) : Math.min(1, Math.max(0, (-rec.depth - fogNear) / (fogFar - fogNear)));
              const beam = localMatrixGlyph ? 0 : spotEnergy(centerX, centerY, centerZ, nx, ny, nz) * (1 - Math.min(1, emissive));
              let pointR = 0, pointG = 0, pointB = 0;
              if (!localMatrixGlyph) for (let i = 0; i < pointLightCount; i++) {
                const o = i * 8, dx = pointLights[o] - centerX, dy = pointLights[o + 1] - centerY, dz = pointLights[o + 2] - centerZ;
                const radius = pointLights[o + 3], distance2 = dx * dx + dy * dy + dz * dz;
                if (distance2 >= radius * radius || distance2 < 1e-8) continue;
                const distance = Math.sqrt(distance2), facing = Math.max(0, (nx * dx + ny * dy + nz * dz) / distance);
                const falloff = 1 - distance / radius;
                const strength = (pointLights[o + 7] > 0.5 ? 0.72 * (1 - smooth((distance / radius - 0.2) / 0.8)) : falloff * falloff) * facing * (1 - Math.min(1, emissive));
                pointR += pointLights[o + 4] * strength;
                pointG += pointLights[o + 5] * strength;
                pointB += pointLights[o + 6] * strength;
              }
              let red = lerp(lerp(cr * (k + pointR + (beam ? beam * spotLight[8] : 0)), 214, tip * 0.88), fogRgb[0], fog);
              let green = lerp(lerp(cg * (k + pointG + (beam ? beam * spotLight[9] : 0)), 255, tip * 0.88), fogRgb[1], fog);
              let blue = lerp(lerp(cb * (k + pointB + (beam ? beam * spotLight[10] : 0)), 227, tip * 0.88), fogRgb[2], fog);
              if (face.lake) {
                // Match the WebGL waterfall palette and rectangular cells, including displaced wave lighting.
                const flow = node.geometry.lakeFlow, curve = node.geometry.lakeFlowCurve;
                let coordX = flow ? centerX * flow[0] + centerY * flow[1] + centerZ * flow[2] + flow[3] : centerX;
                let coordZ = flow ? centerX * flow[4] + centerY * flow[5] + centerZ * flow[6] + flow[7] : centerZ;
                if (curve) {
                  const dx = centerX - curve[0], dz = centerZ - curve[1], tau = Math.PI * 2;
                  coordX = Math.hypot(dx, dz);
                  coordZ = ((Math.atan2(dx, dz) - curve[2]) % tau + tau) % tau * curve[3];
                }
                const flowX = coordX + 0.12 * Math.sin(coordZ * 0.35 + waterTime * 0.4) - waterTime * 0.08, flowZ = coordZ - waterTime * 0.3;
                let h = (Math.imul(Math.floor(flowX / 0.25), 73856093) ^ Math.imul(Math.floor(flowZ / 0.75), 19349663)) >>> 0;
                h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
                const band = h % 3, foam = h % 13 === 0 && flowZ / 0.75 - Math.floor(flowZ / 0.75) < 1 / 3;
                waterWave.fill(0);
                if (node.geometry.lakeWaves) BL.poolWater.sampleWaves(waterWave, centerX, centerZ, node.geometry.lakeWaves, node.geometry.lakeWaveEnd);
                // The hanging water uses its curved face normal; the free surface uses the wave gradient.
                const side = ny < 0 ? -1 : 1, waving = !!node.geometry.lakeWaves;
                const waterNx = waving ? -waterWave[1] : nx * side, waterNy = waving ? 1 : ny * side, waterNz = waving ? -waterWave[2] : nz * side;
                const length = Math.hypot(waterNx, waterNy, waterNz);
                const shade = 0.88 + 0.22 * Math.max(0, (-waterNx * 0.4 + waterNy + waterNz * 0.3) / length / Math.sqrt(1.25));
                const pulse = 0.96 + 0.08 * Math.sin(coordZ * 1.04719755 - waterTime * Math.PI);
                const grain = 0.94 + 0.06 * Math.sin(flowX * 43) * Math.sin(flowZ * 31);
                const sheen = (0.5 + 0.5 * Math.sin(flowX * 6 + Math.sin(flowZ * 4))) ** 12;
                const glow = shade * pulse * grain * Math.max(0.35, materialGlow) * 1.08;
                const dx = perspectiveWeight * (eye.x - centerX) + orthographicDepth * view[2];
                const dy = perspectiveWeight * (eye.y - centerY) + orthographicDepth * view[6];
                const dz = perspectiveWeight * (eye.z - centerZ) + orthographicDepth * view[10];
                const grazing = 1 - Math.min(1, Math.abs((waterNx * dx + waterNy * dy + waterNz * dz) / length / (Math.hypot(dx, dy, dz) || 1)));
                rec.smokeOpacity = Math.min(0.95, opacity + (foam ? 0.12 : 0) + grazing * grazing * 0.06);
                red = lerp((foam ? 226 : band === 0 ? 45 : band === 1 ? 74 : 124) * glow + 25.5 * sheen, fogRgb[0], fog);
                green = lerp((foam ? 245 : band === 0 ? 125 : band === 1 ? 166 : 200) * glow + 40.8 * sheen, fogRgb[1], fog);
                blue = lerp(255 * glow + 45.9 * sheen, fogRgb[2], fog);
                const charge = node.geometry.lakeCharge;
                if (charge && charge[1] > 0) {
                  let distanceAlong = charge[2] < 1.5 ? Math.hypot(centerX - charge[4], centerZ - charge[5]) : Math.abs(coordZ);
                  if (charge[2] > 2.5) distanceAlong = Math.min(distanceAlong, Math.max(0, charge[3] - distanceAlong));
                  const lit = 1 - smooth((distanceAlong - charge[0] + 0.45) / 0.6);
                  const leading = 1 - smooth(Math.abs(distanceAlong - charge[0]) / 0.9);
                  const strength = Math.min(1, charge[1] * (lit * 0.7 + leading * 0.3));
                  red = lerp(red, lerp(215, fogRgb[0], fog), strength * 0.75);
                  green = lerp(green, lerp(245, fogRgb[1], fog), strength * 0.75);
                  blue = lerp(blue, lerp(255, fogRgb[2], fog), strength * 0.75);
                }
              }
              if (liquid) {
                const time = node.portalTime, radius = rectangular?Math.max(Math.abs(liquidX),Math.abs(liquidZ)):Math.hypot(liquidX, liquidZ);
                const interference = Math.sin(Math.hypot(liquidX - 0.22, liquidZ + 0.17) * 32 - time * 4)
                  + Math.sin(Math.hypot(liquidX + 0.31, liquidZ - 0.24) * 25 - time * 3);
                const crest = smooth((interference - 0.8) / 1.1), pulse = (0.5 + 0.5 * Math.sin(radius * 20 - time * 2)) ** 12;
                const shine = crest * 0.55 + pulse * 0.18 + smooth((radius - 0.88) / 0.12) * 0.25;
                red = lerp(6 + shine * 85, fogRgb[0], fog);
                green = lerp(44 + interference * 14 + shine * 140, fogRgb[1], fog);
                blue = lerp(92 + interference * 22 + shine * 150, fogRgb[2], fog);
              }
              if (maximumFront && !localMatrixGlyph) {
                const pulse = matrixLiving ? 0.88 + Math.sin(matrixTime * 2.2 - flow * 0.5) * 0.08 : 0;
                const matrixFog = smooth((Math.hypot(centerX - eye.x, centerY - eye.y, centerZ - eye.z) - fogNear) / (fogFar - fogNear));
                const mr = matrixLiving ? 214 * pulse : fogRgb[0] * matrixFog;
                const mg = matrixLiving ? 255 * pulse : fogRgb[1] * matrixFog;
                const mb = matrixLiving ? 227 * pulse : fogRgb[2] * matrixFog;
                rec.matrixRed = mr; rec.matrixGreen = mg; rec.matrixBlue = mb;
                red = lerp(red, mr, matrixAmount);
                green = lerp(green, mg, matrixAmount);
                blue = lerp(blue, mb, matrixAmount);
              }
              if (!localMatrixGlyph) rec.style = rec.mirror ? mirrorStyle : `rgb(${Math.min(255, Math.round(red))},${Math.min(255, Math.round(green))},${Math.min(255, Math.round(blue))})`;
              rec.matrix = 0;
              if (localMatrixGlyph || maximumFront && (partial || !matrixLiving && !localGlyphSurface)) {
                rec.matrixMinX = Math.max(0, Math.floor(Math.min(width, minX))); rec.matrixMaxX = Math.min(width, Math.ceil(Math.max(0, maxX)));
                rec.matrixMinY = Math.max(0, Math.floor(Math.min(height, minY))); rec.matrixMaxY = Math.min(height, Math.ceil(Math.max(0, maxY)));
                if (rec.matrixMaxX > rec.matrixMinX && rec.matrixMaxY > rec.matrixMinY) {
                  if (localMatrixGlyph) {
                    rec.matrixRed = Math.max(0, red - fogRgb[0] * fog);
                    rec.matrixGreen = Math.max(0, green - fogRgb[1] * fog);
                    rec.matrixBlue = Math.max(0, blue - fogRgb[2] * fog);
                    rec.style = `rgb(${Math.min(255, Math.round(rec.matrixRed))},${Math.min(255, Math.round(rec.matrixGreen))},${Math.min(255, Math.round(rec.matrixBlue))})`;
                  } else {
                    rec.matrix = maximumFront;
                    rec.matrixWall = Math.abs(ny) >= Math.max(Math.abs(nx), Math.abs(nz)) ? 0 : Math.abs(nx) >= Math.abs(nz) ? 1 : 2;
                    rec.matrixNx = nx; rec.matrixNy = ny; rec.matrixNz = nz;
                    rec.matrixPlane = nx * (centerX - eye.x) + ny * (centerY - eye.y) + nz * (centerZ - eye.z);
                  }
                  matrixArea += (rec.matrixMaxX - rec.matrixMinX) * (rec.matrixMaxY - rec.matrixMinY);
                }
              }
            }
          }
        }
      }
      if (lines) {
        for (const line of lines) {
          const a = line.i[0] * 3, b = line.i[1] * 3;
          mat4.transformPoint(V[0], w, verts[a], verts[a + 1], verts[a + 2]);
          mat4.transformPoint(V[1], w, verts[b], verts[b + 1], verts[b + 2]);
          if (projective) {
            divideW(V[0], w, verts[a], verts[a + 1], verts[a + 2]);
            divideW(V[1], w, verts[b], verts[b + 1], verts[b + 2]);
          }
          const objectClip = node.geometry.clipPlane;
          if (objectClip) {
            const da = objectClip[0] * V[0][0] + objectClip[1] * V[0][1] + objectClip[2] * V[0][2] + objectClip[3];
            const db = objectClip[0] * V[1][0] + objectClip[1] * V[1][1] + objectClip[2] * V[1][2] + objectClip[3];
            if (da > 0 && db > 0) continue;
            if (da > 0 || db > 0) {
              const end = V[da > 0 ? 0 : 1], other = V[da > 0 ? 1 : 0], amount = da > 0 ? da / (da - db) : db / (db - da);
              for (let k = 0; k < 3; k++) end[k] = lerp(end[k], other[k], amount);
            }
          }
          if (V[0][1] < clipMinimumY && V[1][1] < clipMinimumY) continue;
          if (V[0][1] < clipMinimumY || V[1][1] < clipMinimumY) {
            const end = V[V[0][1] < clipMinimumY ? 0 : 1], other = V[V[0][1] < clipMinimumY ? 1 : 0];
            const amount = (clipMinimumY - end[1]) / (other[1] - end[1]);
            end[0] = lerp(end[0], other[0], amount); end[2] = lerp(end[2], other[2], amount); end[1] = clipMinimumY;
          }
          if (V[0][1] > clipMaximumY && V[1][1] > clipMaximumY) continue;
          if (V[0][1] > clipMaximumY || V[1][1] > clipMaximumY) {
            const end = V[V[0][1] > clipMaximumY ? 0 : 1], other = V[V[0][1] > clipMaximumY ? 1 : 0];
            const amount = (clipMaximumY - end[1]) / (other[1] - end[1]);
            end[0] = lerp(end[0], other[0], amount); end[2] = lerp(end[2], other[2], amount); end[1] = clipMaximumY;
          }
          lineWorld.set(V[0], 0); lineWorld.set(V[1], 3);
          cutawayLine(selective ? cutawayRegionCount : 0);
          for (let interval = 0; interval < lineRangeCount; interval++) {
            for (let k = 0; k < 2; k++) {
              const t = lineRanges[interval * 2 + k];
              mat4.transformPoint(V[k], view, lerp(lineWorld[0], lineWorld[3], t),
                lerp(lineWorld[1], lineWorld[4], t), lerp(lineWorld[2], lineWorld[5], t));
            }
            CLIP_IN.set(V[0], 0);
            CLIP_IN.set(V[1], 3);
            const clipped = clipNear(CLIP_IN, 2, near, CLIP_OUT);
            if (clipped < 2) continue;
            const rec = acquire();
            for (let k = 0; k < 2; k++) {
              const cz = CLIP_OUT[k * 3 + 2];
              const scale = f / projectedDepth(-cz);
              rec.pts[k * 2] = width / 2 + CLIP_OUT[k * 3] * scale;
              rec.pts[k * 2 + 1] = height / 2 - CLIP_OUT[k * 3 + 1] * scale;
            }
            if (Math.max(rec.pts[0], rec.pts[2]) < -7 || Math.min(rec.pts[0], rec.pts[2]) > width + 7 || Math.max(rec.pts[1], rec.pts[3]) < -7 || Math.min(rec.pts[1], rec.pts[3]) > height + 7) { poolUsed--; continue; }
            rec.n = 2;
            rec.depth = (CLIP_OUT[2] + CLIP_OUT[5]) / 2 - (node.depthBias || 0);
            rec.line = true;
            rec.smokeOpacity = opacity;
            rec.imageNode = null;
            rec.mirror = false;
            rec.mirrorNode = null;
            rec.portal = false;
            rec.lineGlow = Math.max((line.emissive || 0) * materialGlow, ember * 0.9);
            const c = line.color;
            const heat = 255 * (0.72 + (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722) / 255 * scorch * 0.28);
            const red = lerp(c[0] * scorch, heat, ember * 0.9);
            const green = lerp(c[1] * scorch, heat * (0.12 + ember * 0.85), ember * 0.9);
            const blue = lerp(c[2] * scorch, heat * (0.01 + ember * ember * ember * 0.74), ember * 0.9);
            rec.style = `rgb(${Math.round(red)},${Math.round(green)},${Math.round(blue)})`;
            rec.coreStyle = rec.lineGlow > 0.5 ? `rgb(${Math.round(red + (255 - red) * 0.55)},${Math.round(green + (255 - green) * 0.55)},${Math.round(blue + (255 - blue) * 0.55)})` : "";
          }
        }
      }
    };
    const shadeBatch = (node) => {
      if (cutawayFade === 1 && node.geometry.cutawayHide) return;
      const data = node.instanceData;
      const glyphs = !!node.geometry.matrixGlyph;
      const tanX = width * 0.5 / lastF, tanY = height * 0.5 / lastF;
      const sideX = Math.sqrt(1 + perspectiveWeight * perspectiveWeight * tanX * tanX), sideY = Math.sqrt(1 + perspectiveWeight * perspectiveWeight * tanY * tanY);
      BATCH_NODE.geometry = node.geometry;
      BATCH_NODE.depthBias = node.depthBias || 0;
      BATCH_NODE.matrixLiving = !!node.matrixLiving;
      BATCH_NODE.matrixEmissiveLiving = !!node.matrixEmissiveLiving;
      BATCH_NODE.matrixCloud = !!node.matrixCloud;
      const count = node.drawInstanceCount === undefined ? node.instanceCount : Math.max(0, Math.min(node.instanceCount, node.drawInstanceCount));
      suppressed += node.instanceCount - count;
      if (node.cullSphere) {
        const sphere = node.cullSphere, x = sphere[0], y = sphere[1], z = sphere[2], r = sphere[3];
        const cx = view[0] * x + view[4] * y + view[8] * z + view[12];
        const cy = view[1] * x + view[5] * y + view[9] * z + view[13];
        const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
        const span = projectedDepth(depth);
        if (depth + r < near || Math.abs(cx) > span * tanX + r * sideX || Math.abs(cy) > span * tanY + r * sideY) { matrixCulled += count; return; }
      }
      for (let instance = 0; instance < count; instance++) {
        const offset = instance * 20;
        const facing = data[offset + 19];
        if (facing && facing * (data[offset + 8] * (perspectiveWeight * (eye.x - data[offset + 12]) + orthographicDepth * view[2])
          + data[offset + 9] * (perspectiveWeight * (eye.y - data[offset + 13]) + orthographicDepth * view[6])
          + data[offset + 10] * (perspectiveWeight * (eye.z - data[offset + 14]) + orthographicDepth * view[10])) <= 0) continue;
        BATCH_NODE.matrixFullCave = 0;
        if (glyphs) {
          const x = data[offset + 12], y = data[offset + 13], z = data[offset + 14];
          const cx = view[0] * x + view[4] * y + view[8] * z + view[12];
          const cy = view[1] * x + view[5] * y + view[9] * z + view[13];
          const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
          // The .079 x .121 x .01 voxel glyph fits a .08-radius sphere; the instance basis is orthogonal, caves included.
          const radius = 0.08 * Math.sqrt(Math.max(
            data[offset] ** 2 + data[offset + 1] ** 2 + data[offset + 2] ** 2,
            data[offset + 4] ** 2 + data[offset + 5] ** 2 + data[offset + 6] ** 2,
            data[offset + 8] ** 2 + data[offset + 9] ** 2 + data[offset + 10] ** 2));
          const span = projectedDepth(depth);
          if (depth + radius < near || Math.abs(cx) > span * tanX + radius * sideX || Math.abs(cy) > span * tanY + radius * sideY) { matrixCulled++; continue; }
          const cave = node.geometry.matrixCave;
          if (matrixCaves && cave && cave !== matrixPermanentCave) {
            const travel = matrixTravel(x, z, cave);
            if (!matrixActive || travel - radius * Math.SQRT2 >= matrixRadius) { matrixCulled++; continue; }
            // Cave travel is sqrt(2)-Lipschitz; five radii bound every face-front test, float rounding included.
            if (matrixActive === 1 && travel + radius * 5 <= matrixRadius - 1.5) BATCH_NODE.matrixFullCave = cave;
          }
        }
        for (let i = 0; i < 16; i++) BATCH_NODE.world[i] = data[offset + i];
        BATCH_NODE.glow = Math.max(0, data[offset + 16]);
        BATCH_NODE.ember = Math.max(0, -data[offset + 16]);
        BATCH_NODE.highlight = Math.max(0, data[offset + 17]);
        BATCH_NODE.scorch = Math.max(0, -data[offset + 17]);
        BATCH_NODE.tip = Math.max(0, data[offset + 18]);
        BATCH_NODE.smokeOpacity = data[offset + 18] < 0 ? -1 - data[offset + 18] : 1;
        shadeNode(BATCH_NODE);
      }
    };
    // Integrate each voxel face over the sample footprint: keeps small distant pixels, no screen-size cutoff.
    const matrixCoverage = (mask, cross, travel, halfX, halfY, shiftX, shiftY, blockX, blockY) => {
      const loX = cross - halfX - shiftX, hiX = cross + halfX - shiftX;
      const loY = travel - halfY - shiftY, hiY = travel + halfY - shiftY;
      const x0 = Math.max(0, Math.ceil((loX + 0.0315 - blockX) / 0.021));
      const x1 = Math.min(3, Math.floor((hiX + 0.0315 + blockX) / 0.021));
      const y0 = Math.max(0, Math.ceil((0.0525 - hiY - blockY) / 0.021));
      const y1 = Math.min(5, Math.floor((0.0525 - loY + blockY) / 0.021));
      let area = 0;
      for (let y = y0; y <= y1; y++) {
        const cy = (2.5 - y) * 0.021;
        const overlapY = Math.max(0, Math.min(hiY, cy + blockY) - Math.max(loY, cy - blockY));
        for (let x = x0; x <= x1; x++) {
          if (!((mask >> (y * 4 + x)) & 1)) continue;
          const cx = (x - 1.5) * 0.021;
          area += overlapY * Math.max(0, Math.min(hiX, cx + blockX) - Math.max(loX, cx - blockX));
        }
      }
      return area / (4 * halfX * halfY);
    };
    const sampleMatrix = (rec, x, y, z, dxx, dxy, dxz, dyx, dyy, dyz) => {
      matrixSample[3] = 0;
      const relX = x - matrixOriginX, relZ = z - matrixOriginZ, flow = Math.hypot(relX, relZ);
      const cave = rec.matrixDynamic ? matrixLivingCave(x, y, z, rec.matrixPermanentOnly) : rec.matrixCave;
      const frontTravel = cave && matrixCaves ? matrixTravel(x, z, cave) : flow;
      let permanent = matrixPermanentAt(x, y, z, cave);
      if (permanent && !rec.matrixLiving) {
        const depth = -matrixPlaneDistance(x, y, z);
        const footprint = 0.5 * (Math.abs(matrixPermanentPlane[0] * dxx + matrixPermanentPlane[1] * dxy + matrixPermanentPlane[2] * dxz)
          + Math.abs(matrixPermanentPlane[0] * dyx + matrixPermanentPlane[1] * dyy + matrixPermanentPlane[2] * dyz));
        permanent = depth >= footprint + 0.000001;
      }
      const front = permanent ? 1 : rec.matrixLiving && !matrixLivingGlobal ? 0 : rec.matrixPartial ? matrixFront(rec.matrixLiving && !cave ? Math.min(frontTravel, 36) : frontTravel) : matrixActive;
      if (front <= 0) return;
      const vx = eye.x - x, vy = eye.y - y, vz = eye.z - z, distance = Math.hypot(vx, vy, vz);
      const fog = smooth((distance - fogNear) / (fogFar - fogNear));
      if (rec.matrixPartial) {
        matrixSample[0] = rec.matrixLiving ? rec.matrixRed : fogRgb[0] * fog;
        matrixSample[1] = rec.matrixLiving ? rec.matrixGreen : fogRgb[1] * fog;
        matrixSample[2] = rec.matrixLiving ? rec.matrixBlue : fogRgb[2] * fog;
        matrixSample[3] = front * 255;
      }
      if (rec.matrixLocal || rec.matrixLiving) return;
      let stream, cross, travel, ax, az, bx, by, bz;
      if (rec.matrixWall) {
        const coord = rec.matrixWall === 1 ? z : x;
        const facing = rec.matrixWall === 1 ? -Math.sign(rec.matrixNx) : Math.sign(rec.matrixNz);
        stream = Math.floor(coord / 0.12);
        cross = (coord - (stream + 0.5) * 0.12) * facing;
        travel = -y;
        ax = rec.matrixWall === 1 ? 0 : facing; az = rec.matrixWall === 1 ? facing : 0;
        bx = bz = 0; by = 1;
      } else {
        const rx = flow > 0.0001 ? relX / flow : 1, rz = flow > 0.0001 ? relZ / flow : 0;
        ax = -rz; az = rx; bx = rx; by = 0; bz = rz;
        const angle = Math.atan2(relZ, relX);
        const level = Math.max(0, Math.min(6, Math.ceil(Math.log2(Math.max(flow, 0.75) / 0.75))));
        const count = 32 * 2 ** level, step = Math.PI * 2 / count;
        const ray = Math.floor((angle + Math.PI) / step + 0.5);
        stream = ((ray % count + count) % count) * (2048 / count);
        let delta = angle - (ray * step - Math.PI);
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        cross = delta * flow;
        travel = flow;
      }
      const offset = (stream + 2048) * 6;
      if (offset < 0 || offset >= matrixStreams.length || matrixStreams[offset] >= matrixDensity * 8) return;
      const moving = (travel - matrixTime * matrixStreams[offset + 1] - matrixStreams[offset + 4]) / 0.13;
      const cell = Math.floor(moving), localY = (moving - cell - 0.5) * 0.13;
      const halfX = Math.max(0.000001, (Math.abs(ax * dxx + az * dxz) + Math.abs(ax * dyx + az * dyz)) * matrixSampleStep * 0.5);
      const halfY = Math.max(0.000001, (Math.abs(bx * dxx + by * dxy + bz * dxz) + Math.abs(bx * dyx + by * dyy + bz * dyz)) * matrixSampleStep * 0.5);
      const normalView = Math.max(0.00001, Math.abs(rec.matrixNx * vx + rec.matrixNy * vy + rec.matrixNz * vz));
      const shiftX = -(vx * ax + vz * az) * 0.01 / normalView;
      const shiftY = -(vx * bx + vy * by + vz * bz) * 0.01 / normalView;
      const sx = Math.abs(shiftX) >= Math.abs(shiftY) ? ax * Math.sign(-shiftX) : bx * Math.sign(-shiftY);
      const sy = Math.abs(shiftX) >= Math.abs(shiftY) ? 0 : by * Math.sign(-shiftY);
      const sz = Math.abs(shiftX) >= Math.abs(shiftY) ? az * Math.sign(-shiftX) : bz * Math.sign(-shiftY);
      const sideShade = 0.7 + Math.max(0, sx * lightDir[0] + sy * lightDir[1] + sz * lightDir[2]) * 0.22 + Math.max(0, (sx * vx + sy * vy + sz * vz) / distance) * 0.08;
      const sequence = matrixStreams[offset + 3], train = matrixStreams[offset + 2];
      const first = Math.max(-2, Math.floor((localY - halfY - Math.abs(shiftY) * 2 + 0.065) / 0.13));
      const last = Math.min(2, Math.floor((localY + halfY + Math.abs(shiftY) * 2 + 0.065) / 0.13));
      let coverage = 0, red = 0, green = 0, blue = 0;
      for (let neighbor = first; neighbor <= last; neighbor++) {
        const flowCell = cell + neighbor, position = (flowCell % sequence + sequence) % sequence;
        if (position >= train) continue;
        const glyph = (Math.abs(stream * 73 + flowCell * 151) + Math.floor(matrixTime * 20)) & 7;
        const mask = MATRIX_MASKS[glyph], glyphY = (localY - neighbor * 0.13) * (rec.matrixWall ? -1 : 1);
        const area = Math.min(1, matrixCoverage(mask, cross, glyphY, halfX, halfY, shiftX * 1.5, shiftY * 1.5, 0.008 + Math.abs(shiftX) * 0.5, 0.008 + Math.abs(shiftY) * 0.5));
        const face = Math.min(area, matrixCoverage(mask, cross, glyphY, halfX, halfY, shiftX * 2, shiftY * 2, 0.008, 0.008));
        if (!area) continue;
        const glow = matrixStreams[offset + 5] * (0.48 + (position + 1) / train * 0.52);
        const tip = position === train - 1 ? 1 : position === train - 2 ? 0.55 : 0;
        const emission = (0.78 + glow * 0.37) * lerp(1, sideShade, 1 - face / area);
        red += lerp((glyph & 1 ? 70 : 24) * emission, 214.2, tip * 0.88) * area;
        green += lerp((glyph & 1 ? 255 : 220) * emission, 255, tip * 0.88) * area;
        blue += lerp((glyph & 1 ? 112 : 74) * emission, 226.95, tip * 0.88) * area;
        coverage += area;
      }
      if (!coverage) return;
      const area = Math.min(1, coverage);
      if (rec.matrixPartial) {
        matrixSample[0] = lerp(matrixSample[0], lerp(red / coverage, fogRgb[0], fog), area);
        matrixSample[1] = lerp(matrixSample[1], lerp(green / coverage, fogRgb[1], fog), area);
        matrixSample[2] = lerp(matrixSample[2], lerp(blue / coverage, fogRgb[2], fog), area);
      } else {
        matrixSample[0] = lerp(red / coverage, fogRgb[0], fog);
        matrixSample[1] = lerp(green / coverage, fogRgb[1], fog);
        matrixSample[2] = lerp(blue / coverage, fogRgb[2], fog);
        matrixSample[3] = area * front * 255;
      }
    };
    const drawMatrix = (rec) => {
      const step = matrixSampleStep, span = MATRIX_TILE_SIZE * step;
      const nx = rec.matrixNx, ny = rec.matrixNy, nz = rec.matrixNz, plane = rec.matrixPlane;
      const rx = view[0] / lastF, ry = view[4] / lastF, rz = view[8] / lastF;
      const ux = -view[1] / lastF, uy = -view[5] / lastF, uz = -view[9] / lastF;
      const ndx = nx * rx + ny * ry + nz * rz, ndy = nx * ux + ny * uy + nz * uz;
      let clipped = false;
      for (let ty = rec.matrixMinY; ty < rec.matrixMaxY; ty += span) {
        const rows = Math.min(MATRIX_TILE_SIZE, Math.ceil((rec.matrixMaxY - ty) / step));
        for (let tx = rec.matrixMinX; tx < rec.matrixMaxX; tx += span) {
          const cols = Math.min(MATRIX_TILE_SIZE, Math.ceil((rec.matrixMaxX - tx) / step));
          let painted = false;
          for (let iy = 0; iy < rows; iy++) {
            const py = ty + (iy + 0.5) * step - height * 0.5;
            for (let ix = 0; ix < cols; ix++) {
              const px = tx + (ix + 0.5) * step - width * 0.5;
              const vx = rx * px + ux * py, vy = ry * px + uy * py, vz = rz * px + uz * py;
              const dx = perspectiveWeight * vx - view[2], dy = perspectiveWeight * vy - view[6], dz = perspectiveWeight * vz - view[10];
              const denominator = nx * dx + ny * dy + nz * dz;
              const depth = (plane - orthographicDepth * (nx * vx + ny * vy + nz * vz)) / denominator;
              const i = (iy * MATRIX_TILE_SIZE + ix) * 4;
              matrixPixels[i + 3] = 0;
              matrixSamples++;
              if (depth < near || !Number.isFinite(depth)) continue;
              const span = projectedDepth(depth), ddx = -span * ndx / denominator, ddy = -span * ndy / denominator;
              sampleMatrix(rec, eye.x + vx * span - view[2] * depth, eye.y + vy * span - view[6] * depth, eye.z + vz * span - view[10] * depth,
                rx * span + dx * ddx, ry * span + dy * ddx, rz * span + dz * ddx,
                ux * span + dx * ddy, uy * span + dy * ddy, uz * span + dz * ddy);
              if (!matrixSample[3]) continue;
              matrixPixels[i] = matrixSample[0]; matrixPixels[i + 1] = matrixSample[1]; matrixPixels[i + 2] = matrixSample[2]; matrixPixels[i + 3] = matrixSample[3];
              painted = true;
            }
          }
          if (!painted) continue;
          // Empty samples change no pixels and need no Canvas clipping state, so clip lazily.
          if (!clipped) { ctx.save(); ctx.clip(); clipped = true; }
          matrixCtx.putImageData(matrixImage, 0, 0, 0, 0, cols, rows);
          ctx.drawImage(matrixTile, 0, 0, cols, rows, tx, ty, cols * step, rows * step);
        }
      }
      if (clipped) ctx.restore();
    };
    const matrixPolygonCoverage = (rec, x, y, step) => {
      let count = rec.n, src = matrixClipA, dst = matrixClipB;
      // Distant faces often fit one sample; clipping copies unchanged vertices 4x - keep the same area and centroid.
      const maxX = x + step, maxY = y + step;
      let contained = true, area = 0, centerX = 0, centerY = 0;
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count, px = rec.pts[i * 2], py = rec.pts[i * 2 + 1];
        if (px < x || px > maxX || py < y || py > maxY) { contained = false; break; }
        area += px * rec.pts[j * 2 + 1] - rec.pts[j * 2] * py;
        if (rec.matrixPartial) { centerX += px; centerY += py; }
      }
      if (contained) {
        matrixPointX = rec.matrixPartial ? centerX / count : 0;
        matrixPointY = rec.matrixPartial ? centerY / count : 0;
        return Math.min(1, Math.abs(area) * 0.5 / (step * step));
      }
      for (let i = 0; i < count * 2; i++) src[i] = rec.pts[i];
      for (let edge = 0; edge < 4; edge++) {
        const axis = edge & 1, sign = edge < 2 ? 1 : -1;
        const limit = (axis ? y : x) + (edge < 2 ? 0 : step);
        let out = 0;
        for (let i = 0; i < count; i++) {
          const a = i * 2, b = ((i + 1) % count) * 2;
          const da = (src[a + axis] - limit) * sign, db = (src[b + axis] - limit) * sign;
          if (da >= 0) { dst[out * 2] = src[a]; dst[out * 2 + 1] = src[a + 1]; out++; }
          if ((da >= 0) !== (db >= 0)) {
            const t = da / (da - db);
            dst[out * 2] = lerp(src[a], src[b], t); dst[out * 2 + 1] = lerp(src[a + 1], src[b + 1], t); out++;
          }
        }
        if (out < 3) return 0;
        count = out;
        const swap = src; src = dst; dst = swap;
      }
      area = 0;
      matrixPointX = matrixPointY = 0;
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        area += src[i * 2] * src[j * 2 + 1] - src[j * 2] * src[i * 2 + 1];
        if (rec.matrixPartial) { matrixPointX += src[i * 2]; matrixPointY += src[i * 2 + 1]; }
      }
      if (rec.matrixPartial) { matrixPointX /= count; matrixPointY /= count; }
      return Math.min(1, Math.abs(area) * 0.5 / (step * step));
    };
    const drawMatrixGlyph = (rec) => {
      const step = matrixSampleStep;
      // Faces partition a voxel silhouette; sum area-weighted. source-over would attenuate shared AA pixels twice.
      ctx.fillStyle = rec.style;
      for (let y = rec.matrixMinY; y < rec.matrixMaxY; y += step) for (let x = rec.matrixMinX; x < rec.matrixMaxX; x += step) {
        let coverage = matrixPolygonCoverage(rec, x, y, step);
        matrixSamples++;
        if (!coverage) continue;
        if (rec.matrixPartial) {
          const px = (matrixPointX - width * 0.5) / lastF, py = (height * 0.5 - matrixPointY) / lastF;
          const vx = view[0] * px + view[1] * py, vy = view[4] * px + view[5] * py, vz = view[8] * px + view[9] * py;
          const dx = perspectiveWeight * vx - view[2], dy = perspectiveWeight * vy - view[6], dz = perspectiveWeight * vz - view[10];
          const nx = rec.matrixFaceNx, ny = rec.matrixFaceNy, nz = rec.matrixFaceNz;
          const depth = (rec.matrixFacePlane - orthographicDepth * (nx * vx + ny * vy + nz * vz)) / (nx * dx + ny * dy + nz * dz), span = projectedDepth(depth);
          const wx = eye.x + vx * span - view[2] * depth, wy = eye.y + vy * span - view[6] * depth, wz = eye.z + vz * span - view[10] * depth;
          coverage *= matrixPermanentAt(wx, wy, wz, rec.matrixCave) ? 1 : matrixFront(matrixTravel(wx, wz, rec.matrixCave));
          if (!coverage) continue;
        }
        ctx.globalAlpha = coverage * rec.matrixGlyphOpacity;
        ctx.fillRect(x, y, step, step);
      }
    };
    const rippleRing = (x, y, radius) => {
      const m = rippleView;
      let connected = false;
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const px = x + rippleCircle[i * 2] * radius, py = y + rippleCircle[i * 2 + 1] * radius;
        const depth = -(m[2] * px + m[6] * py + m[14]);
        if (depth <= 1e-7) { connected = false; continue; }
        const scale = lastF / projectedDepth(depth);
        const sx = width * 0.5 + (m[0] * px + m[4] * py + m[12]) * scale;
        const sy = height * 0.5 - (m[1] * px + m[5] * py + m[13]) * scale;
        if (connected) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
        connected = true;
      }
      ctx.stroke();
    };
    const ripplePixel = (x, y, halfX = 0.008, halfY = halfX) => {
      const m = rippleView;
      for (let i = 0; i < 4; i++) {
        const px = x + (i === 0 || i === 3 ? -halfX : halfX), py = y + (i < 2 ? -halfY : halfY);
        CLIP_IN[i * 3] = m[0] * px + m[4] * py + m[12];
        CLIP_IN[i * 3 + 1] = m[1] * px + m[5] * py + m[13];
        CLIP_IN[i * 3 + 2] = m[2] * px + m[6] * py + m[14];
      }
      const count = clipNear(CLIP_IN, 4, 1e-7, CLIP_OUT);
      if (count < 3) return;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const depth = -CLIP_OUT[i * 3 + 2];
        const scale = lastF / projectedDepth(depth);
        const sx = width * 0.5 + CLIP_OUT[i * 3] * scale, sy = height * 0.5 - CLIP_OUT[i * 3 + 1] * scale;
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      ctx.closePath(); ctx.fill();
    };
    const drawMirrorRipples = (node, rec) => {
      const ripples = node.mirrorRipples;
      if (!ripples || !ripples.active) return;
      const { CAPACITY, START_RADIUS, SPEED, WIDTH, GLYPH_THRESHOLD } = BL.mirrorRipples;
      const waves = ripples.waves;
      mat4.multiply(rippleView, view, node.world);
      const m = rippleView, scale = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[4], m[5]));
      // Paint within the mirror face's clip and depth order. The fallback keeps
      // its silver tint beneath small light/dark crests instead of an opaque flash.
      for (let i = 0; i < CAPACITY; i++) {
        const offset = i * 4, strength = waves[offset + 3];
        if (strength <= 0) continue;
        const x = waves[offset], y = waves[offset + 1], radius = START_RADIUS + waves[offset + 2] * SPEED;
        const reach = radius + WIDTH * 2;
        if (x + reach < rec.mirrorMinX || x - reach > rec.mirrorMaxX || y + reach < rec.mirrorMinY || y - reach > rec.mirrorMaxY) continue;
        const depth = Math.max(1e-7, -(m[2] * x + m[6] * y + m[14]));
        ctx.lineWidth = Math.max(0.7, Math.min(4, 0.012 * scale * lastF / projectedDepth(depth)));
        ctx.strokeStyle = "#21313b"; ctx.globalAlpha = strength * 0.18;
        rippleRing(x, y, radius + WIDTH * 0.5);
        ctx.strokeStyle = "#ebf5fa"; ctx.globalAlpha = strength * 0.34;
        rippleRing(x, y, radius);
        if (radius > WIDTH * 2.5) {
          ctx.globalAlpha = strength * 0.13;
          rippleRing(x, y, radius - WIDTH * 2.5);
        }
        if (strength <= GLYPH_THRESHOLD) continue;
        const bright = Math.min(1, (strength - GLYPH_THRESHOLD) / (0.85 - GLYPH_THRESHOLD));
        const mutation = Math.floor(ripples.time * 20);
        const firstColumn = Math.floor(Math.max(x - reach, rec.mirrorMinX - 0.04) / 0.12);
        const lastColumn = Math.floor(Math.min(x + reach, rec.mirrorMaxX + 0.04) / 0.12);
        for (let col = firstColumn; col <= lastColumn; col++) {
          const stream = (col + 2048) * 6, train = matrixStreams[stream + 2], sequence = matrixStreams[stream + 3];
          const travel = ripples.time * matrixStreams[stream + 1] + matrixStreams[stream + 4];
          const first = Math.floor((-Math.min(y + reach, rec.mirrorMaxY + 0.061) - travel) / 0.13);
          const last = Math.floor((-Math.max(y - reach, rec.mirrorMinY - 0.061) - travel) / 0.13);
          for (let row = first; row <= last; row++) {
            const position = (row % sequence + sequence) % sequence;
            if (position >= train) continue;
            const cx = (col + 0.5) * 0.12, cy = -travel - (row + 0.5) * 0.13;
            if (Math.abs(Math.hypot(cx - x, cy - y) - radius) > WIDTH * 2) continue;
            const glyph = (Math.abs(col * 73 + row * 151) + mutation) & 7, mask = MATRIX_MASKS[glyph];
            const glow = matrixStreams[stream + 5] * (0.48 + (position + 1) / train * 0.52);
            const gain = Math.max(0, Math.min(15, Math.round((0.78 + glow * 0.37 - 0.88) / 0.25 * 15)));
            const tip = position === train - 1 ? 2 : position === train - 2 ? 1 : 0;
            ctx.fillStyle = RIPPLE_GREENS[(tip * 16 + gain) * 2 + (glyph & 1)];
            for (let bit = 0; bit < 24; bit++) {
              if (!((mask >> bit) & 1)) continue;
              const px = cx + ((bit & 3) - 1.5) * 0.021, py = cy + (2.5 - (bit >> 2)) * 0.021;
              const crest = (Math.hypot(px - x, py - y) - radius) / WIDTH;
              if (Math.abs(crest) > 2) continue;
              ctx.globalAlpha = bright * bright * (3 - 2 * bright) * Math.exp(-crest * crest) * 0.82;
              ripplePixel(px, py);
            }
          }
        }
      }
      ctx.globalAlpha = 1;
    };
    const drawMirrorSheen = (node, opacity, span) => {
      const source = node.mirrorShard || node, geometry = node.geometry;
      const bounds = BL.scene.boundsOf(source.mirrorCaptureGeometry || source.geometry), min = bounds.min, max = bounds.max;
      const original = geometry.mirrorSource, verts = geometry.verts;
      const ox = original ? original[0] - verts[0] : 0, oy = original ? original[1] - verts[1] : 0, oz = original ? original[2] - verts[2] : 0;
      mat4.multiply(rippleView, view, node.world);
      // The fallback's silver streak belongs to the glass plane. Project its
      // fixed endpoints rather than rebuilding a diagonal from screen bounds.
      const h = max[1] - min[1];
      mat4.transformPoint(V[0], rippleView, min[0] - h * 0.2 - ox, min[1] - oy, min[2] - oz);
      mat4.transformPoint(V[1], rippleView, max[0] - ox, max[1] - h * 0.18 - oy, min[2] - oz);
      CLIP_IN.set(V[0], 0); CLIP_IN.set(V[1], 3);
      if (clipNear(CLIP_IN, 2, 1e-7, CLIP_OUT) < 2) return;
      ctx.strokeStyle = "rgba(235,245,250,.2)";
      ctx.globalAlpha = opacity;
      ctx.lineWidth = Math.max(2, span * 0.06);
      ctx.beginPath();
      for (let i = 0; i < 2; i++) {
        const at = i * 3, depth = -CLIP_OUT[at + 2];
        const scale = lastF / projectedDepth(depth);
        const x = width * 0.5 + CLIP_OUT[at] * scale, y = height * 0.5 - CLIP_OUT[at + 1] * scale;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    };
    let bodyLight = 0, bodyCrest = 0;
    const sampleMirrorBody = (body, gx, gy, y) => {
      bodyLight = bodyCrest = 0;
      gx = Math.max(0, Math.min(body.width - 1, gx));
      gy = Math.max(0, Math.min(body.height - 1, gy));
      const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
      const right = Math.min(x0 + 1, body.width - 1) - x0, top = Math.min(y0 + 1, body.height - 1) - y0;
      const data = body.pixels, waves = body.waves, stride = body.width * body.height * 4;
      for (let layer = 0; layer < body.layers; layer++) {
        const w = (layer - 1) * 4;
        if (layer === 0 ? !body.contacts : waves[w + 1] <= 0) continue;
        const a = layer * stride + (y0 * body.width + x0) * 4;
        if (!data[a + 3]) continue;
        const b = a + right * 4, c = a + top * body.width * 4, d = c + right * 4;
        const value = lerp(lerp(data[a], data[b], tx), lerp(data[c], data[d], tx), ty);
        const distance = (value / 255 - 0.5) * BL.mirrorBody.RANGE * 2;
        if (layer === 0) {
          const phase = (distance - 0.02) / 0.075, contact = Math.exp(-phase * phase);
          bodyLight += contact * 0.022;
          bodyCrest = Math.max(bodyCrest, contact * (0.66 + 0.06 * Math.sin(body.time * 3 + y * 4)));
          continue;
        }
        const phase = (distance - waves[w] * BL.mirrorBody.SPEED) / BL.mirrorBody.WIDTH;
        if (phase > 3 || phase < -5.5) continue;
        const primary = Math.exp(-phase * phase), trailingPhase = phase + 2.5;
        bodyLight += (primary - Math.exp(-trailingPhase * trailingPhase) * 0.28) * waves[w + 1] * 0.055;
        const bright = Math.max(0, Math.min(1, (waves[w + 1] - 0.55) / 0.3));
        bodyCrest = Math.max(bodyCrest, primary * bright * bright * (3 - 2 * bright));
      }
    };
    const drawMirrorBody = (node, rec) => {
      const body = node.mirrorBody;
      if (!body || !body.contacts && !body.active) return;
      if (!node.mirrorRippleOnly) {
        mirrorDebug.bodyContacts = body.contacts;
        mirrorDebug.bodyWaves = body.active;
      }
      const bounds = BL.scene.boundsOf(node.geometry), minX = bounds.min[0], minY = bounds.min[1];
      const dx = (bounds.max[0] - minX) / body.width, dy = (bounds.max[1] - minY) / body.height;
      mat4.multiply(rippleView, view, node.world);
      // Sample the same fixed silhouette atlas as WebGL. Only the narrow crests
      // paint over the fallback's silver face, leaving the body's interior clear.
      // Fractured panes share the atlas; each face samples only its own bounds.
      const firstRow = Math.max(0, Math.floor((rec.mirrorMinY - minY) / dy) - 1);
      const lastRow = Math.min(body.height, Math.ceil((rec.mirrorMaxY - minY) / dy) + 1);
      const firstColumn = Math.max(0, Math.floor((rec.mirrorMinX - minX) / dx) - 1);
      const lastColumn = Math.min(body.width, Math.ceil((rec.mirrorMaxX - minX) / dx) + 1);
      for (let row = firstRow; row < lastRow; row++) {
        const y = minY + (row + 0.5) * dy;
        for (let col = firstColumn; col < lastColumn; col++) {
          sampleMirrorBody(body, col, row, y);
          if (Math.abs(bodyLight) < 0.001) continue;
          ctx.fillStyle = bodyLight > 0 ? "#ebf5fa" : "#21313b";
          ctx.globalAlpha = Math.min(0.32, Math.abs(bodyLight) * 3);
          ripplePixel(minX + (col + 0.5) * dx, y, dx * 0.51, dy * 0.51);
        }
      }
      const mutation = Math.floor(body.time * 20);
      for (let col = Math.floor(Math.max(minX, rec.mirrorMinX - 0.04) / 0.12); col <= Math.floor(Math.min(bounds.max[0], rec.mirrorMaxX + 0.04) / 0.12); col++) {
        const stream = (col + 2048) * 6, train = matrixStreams[stream + 2], sequence = matrixStreams[stream + 3];
        const travel = body.time * matrixStreams[stream + 1] + matrixStreams[stream + 4];
        const first = Math.floor((-Math.min(bounds.max[1], rec.mirrorMaxY + 0.061) - travel) / 0.13);
        const last = Math.floor((-Math.max(minY, rec.mirrorMinY - 0.061) - travel) / 0.13);
        for (let row = first; row <= last; row++) {
          const position = (row % sequence + sequence) % sequence;
          if (position >= train) continue;
          const cx = (col + 0.5) * 0.12, cy = -travel - (row + 0.5) * 0.13;
          sampleMirrorBody(body, (cx - minX) / dx - 0.5, (cy - minY) / dy - 0.5, cy);
          if (bodyCrest < 0.0001) continue;
          const glyph = (Math.abs(col * 73 + row * 151) + mutation) & 7, mask = MATRIX_MASKS[glyph];
          const glow = matrixStreams[stream + 5] * (0.48 + (position + 1) / train * 0.52);
          const gain = Math.max(0, Math.min(15, Math.round((0.78 + glow * 0.37 - 0.88) / 0.25 * 15)));
          const tip = position === train - 1 ? 2 : position === train - 2 ? 1 : 0;
          ctx.fillStyle = RIPPLE_GREENS[(tip * 16 + gain) * 2 + (glyph & 1)];
          for (let bit = 0; bit < 24; bit++) {
            if (!((mask >> bit) & 1)) continue;
            const px = cx + ((bit & 3) - 1.5) * 0.021, py = cy + (2.5 - (bit >> 2)) * 0.021;
            sampleMirrorBody(body, (px - minX) / dx - 0.5, (py - minY) / dy - 0.5, py);
            if (bodyCrest < 0.025) continue;
            ctx.globalAlpha = bodyCrest * 0.82;
            ripplePixel(px, py);
          }
        }
      }
      ctx.globalAlpha = 1;
    };
    const destroyEnvironment = () => {
      if (!environment.renderer) return;
      environment.renderer.dispose();
      environment.canvas.width = environment.canvas.height = 0;
      for (const face of environment.faces) face.width = face.height = 0;
      environment.renderer = environment.canvas = environment.camera = environment.source = null;
      environment.faces.length = environment.contexts.length = 0;
      environment.valid = environment.next = environment.frame = 0;
      mirrorDebug.resources = mirrorDebug.environmentResources = mirrorDebug.environmentFaces = mirrorDebug.environmentSize = 0;
    };
    const updateEnvironment = (root, source, camera, opts) => {
      if (!environment.renderer) {
        environment.canvas = document.createElement("canvas");
        environment.renderer = createRenderer(environment.canvas, { width: ENVIRONMENT_SIZE, height: ENVIRONMENT_SIZE, environmentCapture: true });
        environment.camera = BL.scene.createCamera({ fov: 90, near: 0.025, far: camera.far });
        environment.camera.up = { x: 0, y: 1, z: 0 };
        for (let face = 0; face < 6; face++) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = ENVIRONMENT_SIZE;
          environment.faces.push(canvas); environment.contexts.push(canvas.getContext("2d"));
        }
        mirrorDebug.resources = mirrorDebug.environmentResources = 7;
        mirrorDebug.environmentSize = ENVIRONMENT_SIZE;
        mirrorDebug.allocationCount++;
      }
      if (environment.source !== source) {
        environment.source = source;
        environment.valid = environment.next = environment.frame = 0;
      }
      if (environment.valid === 63 && environment.frame++ % 4 !== 0) return;
      const face = environment.next, at = face * 6, c = environment.camera, w = source.world;
      c.position.x = w[12] + w[8] * 0.04; c.position.y = w[13] + w[9] * 0.04; c.position.z = w[14] + w[10] * 0.04;
      c.target.x = c.position.x + CUBE_VIEWS[at]; c.target.y = c.position.y + CUBE_VIEWS[at + 1]; c.target.z = c.position.z + CUBE_VIEWS[at + 2];
      c.up.x = CUBE_VIEWS[at + 3]; c.up.y = CUBE_VIEWS[at + 4]; c.up.z = CUBE_VIEWS[at + 5]; c.far = camera.far;
      environment.renderer.render(root, c, opts);
      environment.contexts[face].drawImage(environment.canvas, 0, 0, ENVIRONMENT_SIZE, ENVIRONMENT_SIZE);
      environment.valid |= 1 << face;
      environment.next = (face + 1) % 6;
      mirrorDebug.environmentFaces = environment.valid;
      mirrorDebug.environmentPassCount++;
    };
    // Both image screens and shard captures use the same clipped affine
    // triangles. A bounded grid supplies perspective without resampling or
    // quantizing the source image into generated geometry.
    const drawImageTriangle = (image, vertices, a, b, c, minX, minY, maxX, maxY, direction = false) => {
      const input = environmentClip, output = environmentClipped;
      for (let k = 0; k < 5; k++) { input[k] = vertices[a + k]; input[5 + k] = vertices[b + k]; input[10 + k] = vertices[c + k]; }
      let count = 0;
      for (let i = 0; i < 3; i++) {
        const from = i * 5, to = (i + 1) % 3 * 5, inside = input[from + 2] < -0.0001, next = input[to + 2] < -0.0001;
        if (inside) { for (let k = 0; k < 5; k++) output[count * 5 + k] = input[from + k]; count++; }
        if (inside !== next) {
          const t = (-0.0001 - input[from + 2]) / (input[to + 2] - input[from + 2]);
          for (let k = 0; k < 5; k++) output[count * 5 + k] = input[from + k] + (input[to + k] - input[from + k]) * t;
          count++;
        }
      }
      for (let i = 0; i < count; i++) {
        // Environment coordinates are directions at infinity. Their angular
        // spread tends to zero as the rays become parallel in an overhead view.
        const at = i * 5, depth = -output[at + 2];
        const scale = lastF / (direction ? Math.max(1e-6, perspectiveWeight) * depth : projectedDepth(depth));
        output[at] = width * 0.5 + output[at] * scale; output[at + 1] = height * 0.5 - output[at + 1] * scale;
      }
      for (let i = 1; i + 1 < count; i++) {
        const at = i * 5, bt = at + 5, x0 = output[0], y0 = output[1], x1 = output[at], y1 = output[at + 1], x2 = output[bt], y2 = output[bt + 1];
        if (Math.max(x0, x1, x2) < minX || Math.min(x0, x1, x2) > maxX || Math.max(y0, y1, y2) < minY || Math.min(y0, y1, y2) > maxY) continue;
        const u0 = output[3], v0 = output[4], u1 = output[at + 3], v1 = output[at + 4], u2 = output[bt + 3], v2 = output[bt + 4];
        const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
        if (Math.abs(det) < 1e-9) continue;
        ctx.save(); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.clip();
        ctx.transform((x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det,
          (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / det,
          (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / det,
          (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / det,
          (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / det,
          (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / det);
        ctx.drawImage(image, 0, 0); ctx.restore();
      }
    };
    const drawShardEnvironment = (node, opacity, minX, minY, maxX, maxY) => {
      const w = node.world, length = Math.hypot(w[8], w[9], w[10]), nx = w[8] / length, ny = w[9] / length, nz = w[10] / length;
      minX = Math.max(0, minX); maxX = Math.min(width, maxX); minY = Math.max(0, minY); maxY = Math.min(height, maxY);
      ctx.globalAlpha = opacity;
      for (let face = 0; face < 6; face++) {
        if (!(environment.valid & (1 << face))) continue;
        const at = face * 6, dx = CUBE_VIEWS[at], dy = CUBE_VIEWS[at + 1], dz = CUBE_VIEWS[at + 2], ux = CUBE_VIEWS[at + 3], uy = CUBE_VIEWS[at + 4], uz = CUBE_VIEWS[at + 5];
        const rx = dy * uz - dz * uy, ry = dz * ux - dx * uz, rz = dx * uy - dy * ux;
        for (let y = 0; y <= ENVIRONMENT_GRID; y++) for (let x = 0; x <= ENVIRONMENT_GRID; x++) {
          const sx = x / ENVIRONMENT_GRID * 2 - 1, sy = 1 - y / ENVIRONMENT_GRID * 2;
          const ex = dx + rx * sx + ux * sy, ey = dy + ry * sx + uy * sy, ez = dz + rz * sx + uz * sy, dot = 2 * (ex * nx + ey * ny + ez * nz);
          const vx = ex - dot * nx, vy = ey - dot * ny, vz = ez - dot * nz, out = (y * (ENVIRONMENT_GRID + 1) + x) * 5;
          environmentVertices[out] = view[0] * vx + view[4] * vy + view[8] * vz;
          environmentVertices[out + 1] = view[1] * vx + view[5] * vy + view[9] * vz;
          environmentVertices[out + 2] = view[2] * vx + view[6] * vy + view[10] * vz;
          environmentVertices[out + 3] = x / ENVIRONMENT_GRID * ENVIRONMENT_SIZE; environmentVertices[out + 4] = y / ENVIRONMENT_GRID * ENVIRONMENT_SIZE;
        }
        for (let y = 0; y < ENVIRONMENT_GRID; y++) for (let x = 0; x < ENVIRONMENT_GRID; x++) {
          const a = (y * (ENVIRONMENT_GRID + 1) + x) * 5, b = a + 5, c = a + (ENVIRONMENT_GRID + 1) * 5, d = c + 5;
          drawImageTriangle(environment.faces[face], environmentVertices, a, b, d, minX, minY, maxX, maxY, true);
          drawImageTriangle(environment.faces[face], environmentVertices, a, d, c, minX, minY, maxX, maxY, true);
        }
      }
      ctx.globalAlpha = 1;
    };
    const drawImageSurface = (node) => {
      const surface = node.geometry.imageSurface, asset = surface.asset, image = asset.load();
      if (!image.complete || !image.naturalWidth) return;
      mat4.multiply(imageView, view, node.world);
      const rect = surface.rect, z = node.geometry.verts[2], m = imageView;
      // Front-on screens are exactly affine; oblique screens use at most
      // 192 triangles, including near-plane clipping of each image tile.
      const oblique = perspectiveWeight * (Math.abs(m[2] * rect[2]) + Math.abs(m[6] * rect[3])) > 0.0001;
      const columns = oblique ? 12 : 1, rows = oblique ? 8 : 1;
      for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) {
        const px = rect[0] + rect[2] * x / columns, py = rect[1] + rect[3] * (1 - y / rows), at = (y * (columns + 1) + x) * 5;
        imageVertices[at] = m[0] * px + m[4] * py + m[8] * z + m[12];
        imageVertices[at + 1] = m[1] * px + m[5] * py + m[9] * z + m[13];
        imageVertices[at + 2] = m[2] * px + m[6] * py + m[10] * z + m[14];
        imageVertices[at + 3] = asset.width * x / columns;
        imageVertices[at + 4] = asset.height * y / rows;
      }
      ctx.save(); ctx.clip();
      if (!oblique && imageVertices[2] < -near && imageVertices[7] < -near && imageVertices[12] < -near && imageVertices[17] < -near) {
        const scale = lastF / projectedDepth(-imageVertices[2]), x = width / 2 + imageVertices[0] * scale, y = height / 2 - imageVertices[1] * scale;
        ctx.transform((imageVertices[5] - imageVertices[0]) * scale / asset.width,
          -(imageVertices[6] - imageVertices[1]) * scale / asset.width,
          (imageVertices[10] - imageVertices[0]) * scale / asset.height,
          -(imageVertices[11] - imageVertices[1]) * scale / asset.height, x, y);
        ctx.drawImage(image, 0, 0);
        ctx.restore();
        return;
      }
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        const a = (y * (columns + 1) + x) * 5, b = a + 5, c = a + (columns + 1) * 5, d = c + 5;
        drawImageTriangle(image, imageVertices, a, b, d, 0, 0, width, height);
        drawImageTriangle(image, imageVertices, a, d, c, 0, 0, width, height);
      }
      ctx.restore();
    };
    const render = (root, camera, opts = {}) => {
      cutawayMaxY = opts.cutawayMaxY < 1e6 ? opts.cutawayMaxY : Infinity;
      cutawayFade = Math.max(0, Math.min(1, Number.isFinite(opts.cutawayFade) ? opts.cutawayFade : opts.birdsEyeCutaway ? 1 : 0));
      cutawayCloudY = opts.cutawayCloudY || 0;
      cutawayCloudMix = Math.max(0, Math.min(1, opts.cutawayCloudMix || 0));
      const regions = opts.cutawayRegions;
      cutawayRegionCount = Math.max(0, Math.min(CUTAWAY_REGIONS, regions?.length || 0, opts.cutawayRegionCount | 0));
      for (let i = 0; i < cutawayRegionCount; i++) {
        const region = regions[i], at = i * 20, c = region.cos, s = region.sin, x = region.x, z = region.z;
        const mix = Math.max(0, Math.min(1, region.mix === undefined ? 1 : region.mix));
        // Canvas has no depth-fragment coverage mask. Moving the section plane
        // through the roof gives its fallback the same smooth timing instead
        // of snapping when the WebGL aperture fades.
        cutawayPlanes[at] = 0; cutawayPlanes[at + 1] = -1; cutawayPlanes[at + 2] = 0; cutawayPlanes[at + 3] = region.y + (1 - mix) * 64;
        cutawayPlanes[at + 4] = c; cutawayPlanes[at + 5] = 0; cutawayPlanes[at + 6] = -s;
        cutawayPlanes[at + 7] = -c * x + s * z - region.halfWidth;
        cutawayPlanes[at + 8] = -c; cutawayPlanes[at + 9] = 0; cutawayPlanes[at + 10] = s;
        cutawayPlanes[at + 11] = c * x - s * z - region.halfWidth;
        cutawayPlanes[at + 12] = s; cutawayPlanes[at + 13] = 0; cutawayPlanes[at + 14] = c;
        cutawayPlanes[at + 15] = -s * x - c * z - region.halfDepth;
        cutawayPlanes[at + 16] = -s; cutawayPlanes[at + 17] = 0; cutawayPlanes[at + 18] = -c;
        cutawayPlanes[at + 19] = s * x + c * z - region.halfDepth;
      }
      const { light = DEFAULT_LIGHT, directStrength: strength = 1, ambientFloor: ambient = 0.3, diffuseFloor: diffuse = 0, clear = null, sky = DEFAULT_SKY, ground = DEFAULT_GROUND, horizon = null, zenith = null, fog = null, fogNear: near0 = 0, fogFar: far0 = 0, matrix = null } = opts;
      spotLight = opts.spotLight || null;
      matrixActive = matrix ? matrix.active : 0;
      matrixRadius = matrix ? matrix.radius : 0;
      matrixTime = matrix ? matrix.time : 0;
      matrixDensity = matrix ? matrix.density : 0;
      matrixOriginX = matrix ? matrix.origin[0] : 0;
      matrixOriginZ = matrix ? matrix.origin[2] : 0;
      matrixCaves = matrix ? matrix.caves || null : null;
      matrixCaveBounds = matrix ? matrix.caveBounds || null : null;
      matrixCaveNear = matrix ? matrix.caveNear === undefined ? Infinity : matrix.caveNear : Infinity;
      matrixPermanentCave = matrix ? matrix.permanentCave || 0 : 0;
      matrixPermanentPlane = matrix ? matrix.permanentPlane || null : null;
      matrixAperture = matrix && matrix.permanentAperture || DEFAULT_MATRIX_APERTURE;
      matrixLivingGlobal = matrix ? matrix.livingGlobal ?? 1 : 1;
      matrixSurfaces = matrixLivingSurfaces = matrixArea = matrixSamples = matrixCulled = 0;
      matrixFrame++;
      if (fog) {
        fogRgb[0] = fog[0] * 255;
        fogRgb[1] = fog[1] * 255;
        fogRgb[2] = fog[2] * 255;
        fogNear = near0;
        fogFar = Math.max(far0, near0 + 1);
      } else {
        fogNear = 1e8;
        fogFar = 1e8 + 1;
      }
      if (!fixedW && (canvas.clientWidth !== width || canvas.clientHeight !== height)) resize();
      const gradientSky = !!(horizon && zenith);
      if (gradientSky) buildSky(horizon, zenith);
      if (clear !== clearRef) {
        clearRef = clear;
        clearStyle = clear ? `rgb(${Math.round(clear[0] * 255)},${Math.round(clear[1] * 255)},${Math.round(clear[2] * 255)})` : "";
      }
      // The faux tint follows the sky; rebuilt only when a channel moves.
      const mr = Math.round((sky[0] * 0.55 + ground[0] * 0.25 + 0.12) * 255), mg = Math.round((sky[1] * 0.55 + ground[1] * 0.25 + 0.14) * 255), mb = Math.round((sky[2] * 0.55 + ground[2] * 0.25 + 0.17) * 255);
      if (mr !== mirrorInts[0] || mg !== mirrorInts[1] || mb !== mirrorInts[2]) {
        mirrorInts[0] = mr;
        mirrorInts[1] = mg;
        mirrorInts[2] = mb;
        mirrorStyle = `rgb(${mr},${mg},${mb})`;
      }
      lastF = height / 2 / Math.tan(camera.fov / 2);
      const orthoMix = camera.orthoHeight > 0 ? Math.max(0, Math.min(1, camera.orthoMix || 0)) : 0;
      perspectiveWeight = 1 - orthoMix;
      orthographicDepth = orthoMix * Math.max(0, camera.orthoHeight || 0) / (2 * Math.tan(camera.fov / 2));
      near = camera.near;
      eye = camera.position;
      mat4.lookAt(view, camera.position, camera.target, camera.up || UP);
      const llen = Math.hypot(light.x, light.y, light.z) || 1;
      lightDir[0] = light.x / llen;
      lightDir[1] = light.y / llen;
      lightDir[2] = light.z / llen;
      directStrength = strength;
      ambientFloor = ambient;
      diffuseFloor = diffuse;
      pointLights = opts.lights || null;
      pointLightCount = pointLights ? Math.min(6, opts.lightCount || 0) : 0;
      skyLuma = sky[0] * 0.2126 + sky[1] * 0.7152 + sky[2] * 0.0722;
      groundLuma = ground[0] * 0.2126 + ground[1] * 0.7152 + ground[2] * 0.0722;
      waterTime = performance.now() * 0.001 % 3600;
      poolUsed = 0;
      suppressed = rippleSurfaces = rippleWaves = 0;
      mirrorDebug.active = false;
      mirrorDebug.portal = false;
      mirrorDebug.reveal = 0;
      mirrorDebug.surfaceDrawn = false;
      mirrorDebug.bodyContacts = mirrorDebug.bodyWaves = 0;
      mirrorDebug.shardsDrawn = 0;
      let mirrorNode = null;
      const viewActor = !environmentCapture && opts.beforeView?.();
      updateWorld(root, null);
      traverseVisible(root, (node) => {
        if (environmentCapture && (node.mirror || node.mirrorPortal || node.mirrorShard || node.mirrorRippleOnly)) return;
        if (node.mirror || node.mirrorPortal) {
          if (mirrorDebug.active) throw new Error("A scene may contain at most one mirror node");
          mirrorNode = node;
          mirrorDebug.active = true;
          mirrorDebug.skippedPassCount++;
          const w = node.world, nlen = Math.hypot(w[8], w[9], w[10]) || 1;
          mirrorDebug.planeCenter[0] = w[12];
          mirrorDebug.planeCenter[1] = w[13];
          mirrorDebug.planeCenter[2] = w[14];
          mirrorDebug.planeNormal[0] = w[8] / nlen;
          mirrorDebug.planeNormal[1] = w[9] / nlen;
          mirrorDebug.planeNormal[2] = w[10] / nlen;
          const center = mirrorDebug.planeCenter, normal = mirrorDebug.planeNormal;
          const eyeD = (camera.position.x - center[0]) * normal[0] + (camera.position.y - center[1]) * normal[1] + (camera.position.z - center[2]) * normal[2];
          mirrorDebug.planeDistance = Math.abs(eyeD);
          mirrorDebug.portal = !!node.mirrorPortal;
          mirrorDebug.reveal = Math.max(0, Math.min(1, node.mirrorReveal || 0));
          mirrorDebug.cameraPosition[0] = camera.position.x - 2 * eyeD * normal[0];
          mirrorDebug.cameraPosition[1] = camera.position.y - 2 * eyeD * normal[1];
          mirrorDebug.cameraPosition[2] = camera.position.z - 2 * eyeD * normal[2];
          mirrorDebug.cameraTarget[0] = mirrorDebug.cameraPosition[0] + normal[0];
          mirrorDebug.cameraTarget[1] = mirrorDebug.cameraPosition[1] + normal[1];
          mirrorDebug.cameraTarget[2] = mirrorDebug.cameraPosition[2] + normal[2];
        }
        if (!hiddenFromCutaway(node) && (environmentCapture || !hiddenFromCamera(node))) {
          if (node.instanceData) shadeBatch(node);
          else if (node.geometry && !outsideView(node)) shadeNode(node);
        }
      });
      if (viewActor) { opts.afterView?.(); updateWorld(viewActor.root, viewActor.root.parent?.world || null); }
      if (!environmentCapture && mirrorNode && mirrorDebug.shardsDrawn) updateEnvironment(root, mirrorNode, camera, opts);
      active.length = poolUsed;
      // Reuse the face-pool high-water mark; equal depths keep gather order.
      if (poolUsed > sortCapacity) {
        sortCapacity = Math.max(256, sortCapacity);
        while (sortCapacity < poolUsed) sortCapacity *= 2;
        sortIds = new Uint32Array(sortCapacity); sortKeys = new Float64Array(sortCapacity); sortWork = sortScratch(sortCapacity);
      }
      for (let i = 0; i < poolUsed; i++) {
        const rec = pool[i];
        // A large backing polygon must precede its own voxel faces, even when its centre is nearer in an oblique view.
        if (rec.matrixGlyph && !rec.line) {
          let plane = matrixPlaneSlot(rec.matrixNx, rec.matrixNy, rec.matrixNz, rec.matrixPlane - 0.015, false, 0);
          if (plane < 0) plane = matrixPlaneSlot(rec.matrixNx, rec.matrixNy, rec.matrixNz, rec.matrixPlane + 0.015, false, 0);
          if (plane >= 0 && rec.depth <= matrixPlaneDepths[plane]) rec.depth = matrixPlaneDepths[plane] + 0.0001 + (rec.depth - rec.matrixCenterDepth) * 0.001;
        }
        sortIds[i] = i; sortKeys[i] = rec.depth;
      }
      sortByKey(sortIds, 0, poolUsed, sortKeys, 1, 0, sortWork);
      for (let i = 0; i < poolUsed; i++) active[i] = pool[sortIds[i]];
      matrixSampleStep = Math.max(1, Math.ceil(Math.sqrt(matrixArea / MATRIX_SAMPLE_BUDGET)));
      if (matrixArea) {
        let samples;
        do {
          samples = 0;
          for (const rec of active) if ((rec.matrix || rec.matrixGlyph) && !rec.line) samples += Math.max(0, Math.ceil((rec.matrixMaxX - rec.matrixMinX) / matrixSampleStep)) * Math.max(0, Math.ceil((rec.matrixMaxY - rec.matrixMinY) / matrixSampleStep));
          if (samples > MATRIX_SAMPLE_BUDGET) matrixSampleStep = Math.max(matrixSampleStep + 1, Math.ceil(matrixSampleStep * Math.sqrt(samples / MATRIX_SAMPLE_BUDGET)));
        } while (samples > MATRIX_SAMPLE_BUDGET);
      }
      if (transparent) ctx.clearRect(0, 0, width, height);
      else {
        ctx.fillStyle = gradientSky ? skyGradient : clear ? clearStyle : backdrop;
        const hazeShift = gradientSky ? BL.daylight.hazeDropAt(eye.y) * lastF : 0;
        // Translate the cached haze gradient instead of rebuilding: colors and allocation stay camera-independent.
        ctx.translate(0, hazeShift);
        ctx.fillRect(0, -hazeShift, width, height);
        ctx.translate(0, -hazeShift);
        const moon = opts.moon, moonSun = opts.moonSun || opts.sunDirection;
        if (gradientSky && moon && moonSun && moon.y > 0) {
          const mx = view[0] * moon.x + view[4] * moon.y + view[8] * moon.z;
          const my = view[1] * moon.x + view[5] * moon.y + view[9] * moon.z;
          const mz = view[2] * moon.x + view[6] * moon.y + view[10] * moon.z;
          if (mz < -0.05) {
            const radius = lastF * 0.05477 / -mz;
            const cx = width * 0.5 + mx * lastF / -mz, cy = height * 0.5 - my * lastF / -mz;
            if (cx + radius > 0 && cx - radius < width && cy + radius > 0 && cy - radius < height) {
              const facing = Math.max(-1, Math.min(1, moon.x * moonSun.x + moon.y * moonSun.y + moon.z * moonSun.z));
              const tx = moonSun.x - moon.x * facing, ty = moonSun.y - moon.y * facing, tz = moonSun.z - moon.z * facing;
              const sx = view[0] * tx + view[4] * ty + view[8] * tz;
              const sy = view[1] * tx + view[5] * ty + view[9] * tz;
              const k = -facing;
              ctx.save();
              ctx.translate(cx, cy);
              ctx.rotate(Math.atan2(-sy, sx));
              ctx.globalAlpha = 0.3 + 0.7 * (opts.stars || 0);
              ctx.fillStyle = "#d1dff6";
              ctx.beginPath();
              ctx.arc(0, 0, radius, -Math.PI / 2, Math.PI / 2);
              ctx.ellipse(0, 0, Math.max(0.001, Math.abs(k) * radius), radius, 0, Math.PI / 2, k >= 0 ? Math.PI * 1.5 : -Math.PI / 2, k < 0);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
          }
        }
      }
      ctx.lineJoin = "round";
      let glyphBlend = false, glyphComposite = "";
      for (const rec of active) {
        // Glyphs paint sampled rects, never the polygon path; keep additive state across records without reordering.
        if (rec.matrixGlyph && !rec.line) {
          const composite = rec.matrixGlyphOpacity < 1 ? "source-over" : "lighter";
          if (!glyphBlend || glyphComposite !== composite) { ctx.globalCompositeOperation = glyphComposite = composite; glyphBlend = true; }
          drawMatrixGlyph(rec);
          continue;
        }
        if (glyphBlend) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; glyphBlend = false; }
        ctx.beginPath();
        ctx.moveTo(rec.pts[0], rec.pts[1]);
        if (rec.line) {
          ctx.globalAlpha = rec.smokeOpacity;
          ctx.lineTo(rec.pts[2], rec.pts[3]);
          if (rec.lineGlow > 0) {
            ctx.strokeStyle = rec.style;
            ctx.globalAlpha = 0.12 * rec.lineGlow * rec.smokeOpacity;
            ctx.lineWidth = 11;
            ctx.stroke();
            ctx.globalAlpha = 0.28 * rec.lineGlow * rec.smokeOpacity;
            ctx.lineWidth = 4.5;
            ctx.stroke();
            ctx.globalAlpha = rec.smokeOpacity;
          }
          ctx.strokeStyle = rec.coreStyle || rec.style;
          ctx.lineWidth = rec.lineGlow > 0 ? 1.8 : 1.4;
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else {
          for (let k = 1; k < rec.n; k++) ctx.lineTo(rec.pts[k * 2], rec.pts[k * 2 + 1]);
          ctx.closePath();
          if ((!rec.matrixBacking || !rec.matrixPartial) && !(rec.mirrorNode && (rec.mirrorNode.mirrorRippleOnly || rec.mirrorNode.mirrorShard && environment.valid === 63))) {
            if (rec.smokeOpacity !== 1) ctx.globalAlpha = rec.smokeOpacity;
            ctx.fillStyle = rec.style;
            ctx.fill();
            ctx.strokeStyle = rec.style;
            ctx.lineWidth = 1;
            ctx.stroke();
            if (rec.smokeOpacity !== 1) ctx.globalAlpha = 1;
          }
          if (rec.imageNode) {
            ctx.globalAlpha = rec.smokeOpacity;
            drawImageSurface(rec.imageNode); rec.imageNode = null;
            ctx.globalAlpha = 1;
          }
          if (rec.matrix && (matrixDensity > 0 || rec.matrixPartial) && !rec.mirrorNode?.mirrorRippleOnly) {
            ctx.globalAlpha = rec.smokeOpacity;
            drawMatrix(rec);
            ctx.globalAlpha = 1;
          }
          if (rec.mirror) {
            const node = rec.mirrorNode;
            if (!node.mirrorShard && !node.mirrorRippleOnly) mirrorDebug.surfaceDrawn = true;
            let minX = rec.pts[0], maxX = rec.pts[0], minY = rec.pts[1], maxY = rec.pts[1];
            for (let k = 1; k < rec.n; k++) {
              minX = Math.min(minX, rec.pts[k * 2]);
              maxX = Math.max(maxX, rec.pts[k * 2]);
              minY = Math.min(minY, rec.pts[k * 2 + 1]);
              maxY = Math.max(maxY, rec.pts[k * 2 + 1]);
            }
            ctx.save();
            ctx.clip();
            if (rec.portal) {
              const cell = Math.max(7, (maxY - minY) / 18);
              for (let y = minY; y < maxY; y += cell) {
                for (let x = minX; x < maxX; x += cell) {
                  const upper = y < minY + (maxY - minY) * 0.56;
                  const checker = (Math.floor((x - minX) / cell) + Math.floor((y - minY) / cell)) & 1;
                  ctx.fillStyle = upper ? (checker ? "#668e82" : "#759991") : (checker ? "#3f6448" : "#587453");
                  ctx.fillRect(x, y, cell + 0.5, cell + 0.5);
                }
              }
            }
            if (node.mirrorShard) drawShardEnvironment(node, rec.smokeOpacity, minX, minY, maxX, maxY);
            else if (!node.mirrorRippleOnly) drawMirrorSheen(node, rec.smokeOpacity, maxY - minY);
            if (!rec.portal && !node.mirrorShard) {
              drawMirrorRipples(node, rec);
              drawMirrorBody(node, rec);
              if (node.mirrorRippleOnly) { rippleSurfaces++; rippleWaves += node.mirrorRipples ? node.mirrorRipples.active : 0; }
            }
            ctx.restore();
            rec.mirrorNode = null;
          }
        }
      }
      if (glyphBlend) { ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; }
      return true;
    };
    const P = new Float32Array(3);
    const project = (x, y, z, out = {}) => {
      mat4.transformPoint(P, view, x, y, z);
      const depth = projectedDepth(-P[2]);
      if (depth <= 0.01) return null;
      const scale = lastF / depth;
      out.x = width / 2 + P[0] * scale;
      out.y = height / 2 - P[1] * scale;
      out.depth = P[2];
      return out;
    };
    const ray = (px, py, camera, out) => mat4.rayFromView(out, view, width, height, camera.fov, camera.position, px, py, camera.orthoMix, camera.orthoHeight);
    resize();
    return {
      kind: "canvas2d",
      render,
      resize,
      project,
      ray,
      setQuality: () => { },
      releaseGeometry: () => { },
      createRig: () => null,
      releaseUnused: (live) => { if (environment.source && !live.has(environment.source.geometry)) destroyEnvironment(); return 0; },
      dispose: () => {
        destroyEnvironment();
        mirrorDebug.active = false;
        mirrorDebug.portal = false;
        mirrorDebug.reveal = 0;
        mirrorDebug.surfaceDrawn = false;
        mirrorDebug.bodyContacts = mirrorDebug.bodyWaves = 0;
        mirrorDebug.shardsDrawn = 0;
        for (const rec of pool) { rec.mirrorNode = null; rec.imageNode = null; }
      },
      get quality() {
        return "low";
      },
      get stats() {
        return { waterTextures: 0, records: 0, active: 0, mirrorResources: mirrorDebug.resources, imageTextures: 0, rippleBodyTextures: 0, shadowResources: 0, shadowSize: 0, shadowPassCount: 0, shadowFinite: true, culled: matrixCulled, drawn: 0, suppressed, rippleSurfaces, rippleWaves, matrixSurfaces, matrixLivingSurfaces, matrixSamples, matrixSampleStep, matrixSampleBudget: MATRIX_SAMPLE_BUDGET, matrixTileBytes: matrixPixels.byteLength };
      },
      get mirror() {
        return mirrorDebug;
      },
      get ready() {
        return true;
      },
      get failure() {
        return null;
      },
      get size() {
        return size;
      }
    };
  };
  BL.canvasRenderer = { createRenderer };
})();

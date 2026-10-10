// The Agent: a voxel gorilla in little black shades. Outside the Matrix it is a
// plain dark ape; inside the Matrix and in the games its true nature shows, one
// voxel map drawn in glowing code green. It knuckle-walks, gallops on all fours
// and sometimes walks hunched on its hind legs.
//
// A hips/chest rig over one voxel map per part in two palettes (`ape`, and glowing `code` for the Matrix
// and the games), the `knuckle`, `gallop` and `hunch` gaits and a chest `beat`. The API is `create`
// (returning `walk`, `pace`, `place`, `setForm`, `poke`, `liveGeometry`, `dispose` among others) and
// `createPlay`, which the director owns. Its root is `matrixNative` (matrix mode 5), so the renderers keep
// its palette inside the Matrix.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { makeVox, voxelGeometry, cached } = BL.models;
  const { createNode, addChild, removeChild, updateLocal, boundsOf } = BL.scene;
  const { damp, clamp, mulberry32, fnv1a, mat4, quat } = BL.math;
  const U = 0.086;
  // Hip height, torso length, the shoulder on the chest, and the arm: the knuckles
  // reach the ground when the chest leans QUAD forward (8 + 11 cos 1.0 = 13.9 ≈ 14).
  const HIP = 8 * U, SHOULDER_Y = 11 * U, SHOULDER_X = 6 * U, NECK_Y = 10.5 * U;
  const QUAD = 1.0, HUNCH = 0.5, REAR = 0.12;
  // Palette slots, shared by both forms
  const C = { body: 0, bodyDk: 1, hide: 2, hideDk: 3, pad: 4, groove: 5, dash: 6, shades: 7, eye: 8, silver: 9, nostril: 10, brow: 11, silverShade: 14 };
  const APE = ["#2b2724", "#1d1a18", "#56504b", "#46403c", "#3d3834", "#161412", "#2b2724", "#070707", "#2a1a0e", "#8b8681", "#0e0d0c", "#3a3531", "#f3f1df", "#c5ccd0", "#797570"];
  const CODE = ["#0f5a22", "#093a15", "#6dff8c", "#48d864", "#a4ffb4", "#08300f", "#3dff66", "#070707", "#e6ffea", "#5cf07c", "#062a0d", "#86ffa0", "#f3f1df", "#c5ccd0", "#44dc67"];
  const CODE_GLOW = { [C.body]: 0.12, [C.bodyDk]: 0.05, [C.hide]: 0.6, [C.hideDk]: 0.45, [C.pad]: 0.85, [C.dash]: 1, [C.eye]: 1, [C.silver]: 0.55, [C.silverShade]: 0.45, [C.brow]: 0.6 };
  const BACK_SHADES = [C.body, C.hideDk, C.hide, C.silverShade, C.silver];
  const BACK_CONTOUR = [2.2, 2.8, 3.2, 3.8, 4.1, 3.9, 4.2, 4.0, 3.8, 3.4, 2.8, 2.1];
  // Per gait: chest lean, limb swing, then a roaming and a driven pair of ground
  // speed (m/s) and stride per cycle (m). Driven it keeps up with an Ooga
  // (pilot.WALK.speed) and the gallop outruns one; roaming it ambles.
  const WALK_SPEED = BL.pilot.WALK.speed;
  const GAITS = {
    idle: { pitch: QUAD, speed: 0, stride: 1, drive: 0, driveStride: 1, legs: 0, arms: 0 },
    knuckle: { pitch: QUAD, speed: 0.9, stride: 0.9, drive: WALK_SPEED, driveStride: 2.4, legs: 0.45, arms: 0.4 },
    gallop: { pitch: 0.95, speed: 3.4, stride: 1.6, drive: WALK_SPEED * 1.5, driveStride: 3.6, legs: 0.75, arms: 0.7 },
    hunch: { pitch: HUNCH, speed: 0.75, stride: 0.7, drive: WALK_SPEED, driveStride: 2.2, legs: 0.5, arms: 0.35 },
    upright: { pitch: 0.16, speed: 0.9, stride: 1.2, drive: WALK_SPEED, driveStride: 2.4, legs: 0.48, arms: 0.24 },
    beat: { pitch: REAR, speed: 0, stride: 1, drive: 0, driveStride: 1, legs: 0, arms: 0 }
  };
  // Cycle offsets: a four-beat walk, a bound (pairs half a cycle apart), a biped walk
  const OFFSETS = {
    knuckle: { legR: 0, armR: 0.25, legL: 0.5, armL: 0.75 },
    gallop: { legR: 0, legL: 0.08, armR: 0.5, armL: 0.58 },
    hunch: { legR: 0, armL: 0, legL: 0.5, armR: 0.5 },
    upright: { legR: 0, armL: 0, legL: 0.5, armR: 0.5 }
  };
  const LIMBS = [{ leg: "legR", arm: "armR", side: -1 }, { leg: "legL", arm: "armL", side: 1 }];
  const BEAT_TIME = 1.6;
  const POUND_TIME = 0.64, CHEW_TIME = 0.44, MANAGED_BEAT_TIME = 1.2;
  const MANAGED_MOTION_RADIUS = 2.25, MANAGED_MOTION_HEIGHT = 2.8;
  const MANAGED_SMASH_RADIUS = 2.9;
  const TAU = Math.PI * 2;
  // Afloat it dog-paddles: forearms reaching forward and down in turn, hind legs trailing, the chest held level.
  // The reach stays inside the gallop's own footprint, so the body still measures `compact` in the water.
  const SWIM = { rate: 3.2, reach: 0.28, stroke: 0.26, legs: 0.45, kick: 0.12 };
  const wave = (phase, offset) => Math.sin(TAU * (phase + offset));
  const QUAD_RADIUS = 0.85, QUAD_CENTERS = [0.05, 0.7, 1.35];
  let walkPadPoints = null;
  const POUND_RADIUS = 0.875, POUND_CENTERS = [0.05, 0.8, 1.6];
  const STAND_RADIUS = 0.825, STAND_CENTER = 0.19;
  const PARK_RADIUS = 0.72, PARK_CENTER = 0.06;
  const SIT_RADIUS = 0.9, SIT_CENTERS = [-0.12, 0.55];
  const LAB_RADIUS = 0.82, LAB_CENTERS = [0, 0.8], LAB_HEIGHT = 2.7;
  const LAB_IDLE_RADIUS = 0.85;
  const LAB_WALK_RADIUS = 1.06;
  const LAB_SQUEEZE_RADIUS = 0.77;
  // Three overlapping longitudinal cylinders enclose the complete quadruped,
  // including its knuckles, without reserving a four-metre-wide turning circle
  // while it walks straight. Each smaller pose profile is used only once the
  // current rig actually fits; transitions retain the complete radial envelope.
  // When both lab envelopes fit, keep the requested route's shape: walking
  // reserves its circle, while retracting work arms keep their forward capsules.
  const footprintProfile = (entry) => entry.controlled && entry.actionControlled ? 1 : !entry.compact ? 0 : entry.planningSeat ? 5 : entry.planningRoam ? 1 : entry.footprintMode === "lab" ? entry.planningLab ? entry.planningLabWork === "" ? entry.motion && entry.motion.labSqueeze && !entry.gorilla.labItem ? 9 : 8 : 6 : entry.gorilla.labSqueezeCompact ? 9 : entry.gorilla.labIdleCompact ? 7 : entry.gorilla.labWalkCompact && entry.motion && !entry.motion.labSqueeze && !entry.motion.labWork ? 8 : entry.gorilla.labCompact ? 6 : entry.gorilla.labWalkCompact ? 8 : 0 : entry.footprintMode === "sit" ? entry.gorilla.sitCompact ? 5 : 0 : entry.footprintMode === "park" ? entry.gorilla.parkCompact ? 4 : 0
    : entry.footprintMode === "stand" ? entry.gorilla.standCompact ? 3 : 0
    : entry.footprintMode === "pound" ? entry.gorilla.poundCompact ? 2 : 0 : entry.gorilla.compact ? 1 : 0;
  const footprintCount = (entry) => { const profile = footprintProfile(entry); return profile === 5 || profile === 6 ? 2 : profile === 1 || profile === 2 ? 3 : 1; };
  const footprintRadius = (entry) => {
    const profile = footprintProfile(entry);
    return profile ? (profile === 9 ? LAB_SQUEEZE_RADIUS : profile === 8 ? LAB_WALK_RADIUS : profile === 7 ? LAB_IDLE_RADIUS : profile === 6 ? LAB_RADIUS : profile === 5 ? SIT_RADIUS : profile === 4 ? PARK_RADIUS : profile === 3 ? STAND_RADIUS : profile === 2 ? POUND_RADIUS : QUAD_RADIUS) * entry.root.scale.x
      : Math.max(entry.radius, entry.gorilla.bodyRadius);
  };
  const footprintOffset = (entry, index) => {
    const profile = footprintProfile(entry);
    return profile ? (profile >= 7 ? 0 : profile === 6 ? LAB_CENTERS[index] : profile === 5 ? SIT_CENTERS[index] : profile === 4 ? PARK_CENTER : profile === 3 ? STAND_CENTER : (profile === 2 ? POUND_CENTERS : QUAD_CENTERS)[index]) * entry.root.scale.x : 0;
  };
  const footprintOverlaps = (a, ax, ay, az, ah, b, bx, by, bz, bh, margin = 0, shape = footprint) => {
    if (ay >= by + b.height || ay + a.height <= by) return false;
    const radius = shape.radius(a) + shape.radius(b) + margin, r2 = radius * radius;
    const as = Math.sin(ah), ac = Math.cos(ah), bs = Math.sin(bh), bc = Math.cos(bh);
    const aCount = shape.count(a), bCount = shape.count(b);
    for (let i = 0; i < aCount; i++) {
      const ao = shape.offset(a, i);
      for (let j = 0; j < bCount; j++) {
        const bo = shape.offset(b, j), dx = ax + as * ao - bx - bs * bo, dz = az + ac * ao - bz - bc * bo;
        if (dx * dx + dz * dz < r2) return true;
      }
    }
    return false;
  };
  const footprintCircleOverlaps = (entry, x, y, z, heading, ox, oy, oz, radius, height, margin = 0, shape = footprint) => {
    if (y >= oy + height || y + entry.height <= oy) return false;
    const r = shape.radius(entry) + radius + margin, sine = Math.sin(heading), cosine = Math.cos(heading);
    for (let i = 0; i < shape.count(entry); i++) {
      const offset = shape.offset(entry, i), dx = x + sine * offset - ox, dz = z + cosine * offset - oz;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  // An expanded pose can leave two conservative capsules overlapping even when
  // their meshes are apart. Allow an escape only when every overlapping pair
  // separates throughout the move and no other pair is entered. Test the limb
  // centres, including their turning arcs, rather than just the two roots.
  const separatingPair = (x, z, vx, vz, heading, turn, offset, ox, oz, radius, existingContact = true) => {
    const sx = x + Math.sin(heading) * offset - ox, sz = z + Math.cos(heading) * offset - oz;
    const ex = x + vx + Math.sin(heading + turn) * offset - ox, ez = z + vz + Math.cos(heading + turn) * offset - oz;
    const start2 = sx * sx + sz * sz, r2 = radius * radius, overlap = start2 < r2;
    if (overlap && (!existingContact || ex * ex + ez * ez <= start2 + 1e-9)) return false;
    if (Math.abs(turn * offset) < 1e-9) {
      const dot = sx * vx + sz * vz;
      if (overlap) return dot >= -1e-9;
      const length2 = vx * vx + vz * vz, t = length2 ? clamp(-dot / length2, 0, 1) : 0;
      return (sx + vx * t) ** 2 + (sz + vz * t) ** 2 >= r2 - 1e-9;
    }
    const steps = Math.max(1, Math.ceil(Math.abs(turn) / 0.06)), half = 0.5 / steps;
    const speed = Math.hypot(vx, vz) + Math.abs(offset * turn), acceleration = Math.abs(offset) * turn * turn;
    for (let i = 0; i < steps; i++) {
      const a = i / steps, b = (i + 1) / steps, mid = (a + b) * 0.5;
      if (overlap) {
        const angle = heading + turn * mid, sine = Math.sin(angle), cosine = Math.cos(angle);
        const rx = x + vx * mid + sine * offset - ox, rz = z + vz * mid + cosine * offset - oz;
        const derivative = rx * (vx + cosine * offset * turn) + rz * (vz - sine * offset * turn);
        const bound = speed * speed + (Math.hypot(rx, rz) + speed * half) * acceleration;
        // This bounds the derivative of squared distance across the interval,
        // including the curved part between the two sampled headings.
        if (derivative - bound * half < -1e-9) return false;
      } else {
        const ax = x + vx * a + Math.sin(heading + turn * a) * offset - ox;
        const az = z + vz * a + Math.cos(heading + turn * a) * offset - oz;
        const dx = x + vx * b + Math.sin(heading + turn * b) * offset - ox - ax;
        const dz = z + vz * b + Math.cos(heading + turn * b) * offset - oz - az;
        const length2 = dx * dx + dz * dz, t = length2 ? clamp(-(ax * dx + az * dz) / length2, 0, 1) : 0;
        const reach = radius + Math.abs(offset) * (1 - Math.cos(turn / steps * 0.5));
        if ((ax + dx * t) ** 2 + (az + dz * t) ** 2 < reach * reach - 1e-9) return false;
      }
    }
    return true;
  };
  const footprintSeparates = (a, ax, ay, az, ah, nx, ny, nz, nh, b, bx, by, bz, bh, margin = 0, shape = footprint) => {
    if (Math.min(ay, ny) >= by + b.height || Math.max(ay, ny) + a.height <= by) return true;
    // Height bands alone cannot collide across the island. A newly entered
    // band disallows existing-overlap escape only for a horizontal contact.
    const existingContact = ay < by + b.height && ay + a.height > by;
    const turn = Math.atan2(Math.sin(nh - ah), Math.cos(nh - ah));
    const radius = shape.radius(a) + shape.radius(b) + margin, bs = Math.sin(bh), bc = Math.cos(bh);
    const aCount = shape.count(a), bCount = shape.count(b);
    for (let i = 0; i < aCount; i++) for (let j = 0; j < bCount; j++) {
      const bo = shape.offset(b, j);
      if (!separatingPair(ax, az, nx - ax, nz - az, ah, turn, shape.offset(a, i), bx + bs * bo, bz + bc * bo, radius, existingContact)) return false;
    }
    return true;
  };
  const footprintCircleSeparates = (entry, x, y, z, heading, nx, ny, nz, nh, ox, oy, oz, radius, height, margin = 0) => {
    if (Math.min(y, ny) >= oy + height || Math.max(y, ny) + entry.height <= oy) return true;
    const existingContact = y < oy + height && y + entry.height > oy;
    const turn = Math.atan2(Math.sin(nh - heading), Math.cos(nh - heading)), reach = footprintRadius(entry) + radius + margin;
    for (let i = 0; i < footprintCount(entry); i++) {
      if (!separatingPair(x, z, nx - x, nz - z, heading, turn, footprintOffset(entry, i), ox, oz, reach, existingContact)) return false;
    }
    return true;
  };
  const footprintSweep = (entry, x, y, z, toX, toY, toZ, radius, height, fromHeading, toHeading, test, ignore, shape = footprint) => {
    if (!entry || shape === footprint && !footprintProfile(entry)) return test(x, y, z, toX, toY, toZ, radius, height, entry, ignore);
    const turn = Math.atan2(Math.sin(toHeading - fromHeading), Math.cos(toHeading - fromHeading));
    const steps = Math.max(1, Math.ceil(Math.abs(turn) / 0.12)), angle = turn / steps;
    for (let step = 0; step < steps; step++) {
      const a = step / steps, b = (step + 1) / steps, first = fromHeading + turn * a, last = fromHeading + turn * b;
      for (let i = 0; i < shape.count(entry); i++) {
        const offset = shape.offset(entry, i), arc = Math.abs(offset) * (1 - Math.cos(angle * 0.5));
        if (!test(x + (toX - x) * a + Math.sin(first) * offset, y + (toY - y) * a, z + (toZ - z) * a + Math.cos(first) * offset,
          x + (toX - x) * b + Math.sin(last) * offset, y + (toY - y) * b, z + (toZ - z) * b + Math.cos(last) * offset,
          shape.radius(entry) + arc, height, entry, ignore)) return false;
      }
    }
    return true;
  };
  const footprint = { count: footprintCount, radius: footprintRadius, offset: footprintOffset,
    overlaps: footprintOverlaps, circleOverlaps: footprintCircleOverlaps, separates: footprintSeparates,
    circleSeparates: footprintCircleSeparates, sweep: footprintSweep };
  // Peer contacts reserve the central trunk, excluding arms and shoulder
  // mounds. Scenery continues to use the complete animated body above.
  // Sitting leans behind the root; other transitions use the measured trunk.
  const torsoProfile = e => e.planningSeat ? 4 : e.planningRoam ? 3 : e.planningLab ? 1
    : e.gorilla.torsoSitCompact ? 4 : e.gorilla.torsoLabCompact ? 1 : e.gorilla.torsoStandCompact ? 2 : e.gorilla.torsoQuadCompact ? 3 : 0;
  const torso = {
    count: e => torsoProfile(e) === 3 ? 2 : 1,
    radius: e => torsoProfile(e) ? (torsoProfile(e) === 1 ? 0.58 : 0.6) * e.root.scale.x : e.gorilla.torsoRadius,
    offset: (e, i) => (torsoProfile(e) === 4 ? -0.1 : torsoProfile(e) === 1 ? 0.04 : torsoProfile(e) === 2 ? 0.105 : torsoProfile(e) === 3 ? i ? 0.65 : 0.05 : 0) * e.root.scale.x,
    circleOverlaps: (e, x, y, z, h, ox, oy, oz, r, height, margin = 0) => footprintCircleOverlaps(e, x, y, z, h, ox, oy, oz, r, height, margin, torso),
    overlaps: (a, ax, ay, az, ah, b, bx, by, bz, bh, margin = 0) => footprintOverlaps(a, ax, ay, az, ah, b, bx, by, bz, bh, margin, torso),
    separates: (a, ax, ay, az, ah, nx, ny, nz, nh, b, bx, by, bz, bh, margin = 0) => footprintSeparates(a, ax, ay, az, ah, nx, ny, nz, nh, b, bx, by, bz, bh, margin, torso),
    sweep: (e, x, y, z, nx, ny, nz, radius, height, fromHeading, toHeading, test, ignore) => footprintSweep(e, x, y, z, nx, ny, nz, radius, height, fromHeading, toHeading, test, ignore, torso)
  };
  const torsoRows = new WeakMap();
  const torsoCorners = (geometry) => {
    let corners = torsoRows.get(geometry);
    if (corners) return corners;
    const rows = new Map(), vertices = geometry.verts;
    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
      if (Math.abs(x) > 5 * U + 1e-6) continue;
      let row = rows.get(y);
      if (!row) { row = [x, x, z, z]; rows.set(y, row); }
      row[0] = Math.min(row[0], x); row[1] = Math.max(row[1], x);
      row[2] = Math.min(row[2], z); row[3] = Math.max(row[3], z);
    }
    corners = new Float64Array(rows.size * 12);
    let at = 0;
    for (const [y, row] of rows) for (let i = 0; i < 4; i++) {
      corners[at++] = row[i & 1]; corners[at++] = y; corners[at++] = row[2 + (i >> 1)];
    }
    torsoRows.set(geometry, corners);
    return corners;
  };

  const jitter = (rand, base, dark, p) => () => rand() < p ? dark : base;
  // Columns of lit code run down the fur: every fourth column, two cells on, one off.
  const codeDashes = (v) => {
    for (const [key, c] of v.map) {
      if (c !== C.body && c !== C.bodyDk) continue;
      const [x, y, z] = key.split(",").map(Number);
      const hash = (Math.imul(x + 64, 73856093) ^ Math.imul(z + 64, 19349663)) >>> 0;
      if (hash % 4 === 0 && (y + hash % 3) % 3 !== 0) v.map.set(key, C.dash);
    }
    return v;
  };
  const legVox = (rand) => {
    const v = makeVox(), fur = jitter(rand, C.body, C.bodyDk, 0.2);
    v.fill(0, 3, 2, 7, 0, 3, fur);
    v.fill(-1, 4, 5, 7, -1, 4, fur);
    // A lit foot pad split into toes on its front
    v.fill(0, 3, 0, 1, 0, 5, C.pad);
    for (const x of [1, 3]) v.fill(x, x, 0, 1, 5, 5, C.groove);
    return codeDashes(v);
  };
  const armVox = (rand) => {
    const v = makeVox(), fur = jitter(rand, C.body, C.bodyDk, 0.2);
    v.fill(0, 3, 8, 13, 0, 3, fur);
    // Heavy forearms over knuckle pads with dark grooves between the fingers
    v.fill(-1, 4, 2, 7, -1, 4, fur);
    v.fill(-1, 4, 0, 1, 0, 4, C.pad);
    for (const x of [0, 2]) v.fill(x, x, 0, 1, 4, 4, C.groove);
    v.fill(-1, 4, 2, 2, 4, 4, C.hideDk);
    return codeDashes(v);
  };
  const torsoVox = (rand) => {
    const v = makeVox(), fur = jitter(rand, C.body, C.bodyDk, 0.2);
    v.fill(1, 8, 0, 2, 1, 5, fur);
    v.fill(0, 9, 3, 11, 0, 6, fur);
    // Pale chest in front, dark shoulder mounds and a silver back behind them.
    v.fill(2, 7, 3, 9, 6, 6, jitter(rand, C.hide, C.hideDk, 0.25));
    v.fill(3, 6, 2, 2, 5, 5, C.hideDk);
    for (const [x0, x1] of [[-2, 1], [8, 11]]) {
      v.fill(x0, x1, 8, 12, 1, 5, fur);
    }
    // An uneven saddle follows the back muscles, broad between the shoulder
    // blades and tapered at the neck and waist. Grain breaks up its outline
    // and gives the silver fur mottled depth without a rectangular border.
    for (let y = 0; y <= 11; y++) {
      const lower = y < 3, left = lower ? 1 : 0, right = lower ? 8 : 9;
      for (let x = left; x <= right; x++) for (let z = lower ? 1 : 0; z <= 2; z++) {
        const center = 4.5 + 0.18 * Math.sin(y * 1.2);
        const grain = (rand() - 0.5) * 0.55 + 0.15 * Math.sin(x * 2.6 + y * 1.8);
        const edge = BACK_CONTOUR[y] - Math.abs(x - center) - z * 0.32 + grain;
        let shade = Math.max(0, Math.min(4, Math.round(1.1 + edge * 1.1)));
        if (!shade) continue;
        if (shade === 4 && rand() < 0.18) shade = 3;
        else if (shade === 3 && rand() < 0.1) shade = 2;
        v.set(x, y, z, BACK_SHADES[shade]);
      }
    }
    return codeDashes(v);
  };
  const headVox = (rand) => {
    const v = makeVox(), fur = jitter(rand, C.body, C.bodyDk, 0.2);
    v.fill(0, 6, 0, 6, 0, 5, fur);
    // The sagittal crest, ears and a heavy brow
    v.fill(2, 4, 7, 8, 0, 3, fur);
    v.fill(3, 3, 9, 9, 1, 2, C.silver);
    v.set(-1, 4, 2, C.body);
    v.set(7, 4, 2, C.body);
    v.fill(0, 6, 5, 5, 6, 6, C.brow);
    // Face, muzzle and nostrils
    v.fill(1, 5, 0, 4, 5, 5, C.hide);
    v.fill(1, 5, 0, 2, 6, 7, jitter(rand, C.hide, C.hideDk, 0.2));
    v.set(2, 2, 7, C.nostril);
    v.set(4, 2, 7, C.nostril);
    // Eyes just above the little black shades
    for (const x of [1, 2, 4, 5]) v.set(x, 4, 5, C.eye);
    v.fill(0, 6, 3, 3, 6, 6, C.shades);
    v.set(0, 3, 5, C.shades);
    v.set(6, 3, 5, C.shades);
    return v;
  };
  const feedingHeadVox = (rand) => {
    const v = headVox(rand);
    // The separate jaw fills this recess at rest. Articulating it never deforms
    // or rebuilds the shared head geometry, and walking leaves the mouth shut.
    for (let x = 1; x <= 5; x++) for (let y = 0; y <= 1; y++) for (let z = 6; z <= 7; z++) v.map.delete(`${x},${y},${z}`);
    v.fill(1, 5, 0, 1, 5, 5, C.nostril);
    return v;
  };
  const jawVox = () => {
    const v = makeVox();
    v.fill(0, 4, 0, 1, 0, 1, C.hide);
    v.fill(0, 4, 0, 0, 1, 1, C.hideDk);
    return v;
  };
  const LAB_PALETTE = APE;
  const labTorsoVox = (rand) => {
    const v = torsoVox(rand);
    for (const [key] of v.map) {
      const [x, , z] = key.split(",").map(Number);
      // Extend the open coat to the bottom of the torso.
      if (!(z >= 5 && x >= 3 && x <= 6)) v.map.set(key, 12);
    }
    // The open coat and folded collar remain part of the cached torso mesh,
    // so they follow every bend of the body.
    for (let y = 6; y <= 10; y++) {
      const x = y > 8 ? 2 : 3;
      v.set(x, y, 6, 12); v.set(9 - x, y, 6, 12);
    }
    return v;
  };
  const labArmVox = (rand) => {
    const v = armVox(rand);
    for (const [key] of v.map) if (+key.split(",")[1] >= 3) v.map.set(key, +key.split(",")[1] === 3 ? 13 : 12);
    return v;
  };
  const LAB_FLASK_HEIGHT = 0.88;
  const shorterFlask = (profile) => profile.map(([radius, y]) => [radius, y * LAB_FLASK_HEIGHT]);
  const labFlaskGeometry = (level = 0.14) => {
    // Smooth circular glass keeps the same physical bounds and neck grip as
    // the original vessel. The rolled rim turns inward into its open neck.
    return BL.models.glassVessel({
      liquidProfile: shorterFlask([[0, 0], [0.15, 0], [0.17, 0.042], [0.17, 0.061],
        [0.17 - (level - 0.061) * 0.34, level], [0, level]]),
      glassProfile: shorterFlask([[0.177, 0], [0.19, 0.005], [0.19565, 0.016], [0.19565, 0.042],
        [0.19, 0.061], [0.161, 0.14], [0.12, 0.255], [0.055, 0.445], [0.047, 0.474], [0.045, 0.501],
        [0.045, 0.626], [0.048, 0.643], [0.069, 0.648], [0.074, 0.655], [0.074, 0.663],
        [0.067, 0.6708], [0.048, 0.6708], [0.041, 0.664], [0.039, 0.655], [0.035, 0.642],
        [0.035, 0.501], [0.037, 0.477], [0.045, 0.451], [0.143, 0.14], [0.17, 0.061],
        [0.175, 0.016], [0.16, 0]]),
      liquid: "#57c6a0", segments: 32
    });
  };
  const labFlaskVariants = BL.models.variants((i) => {
    const geometry = labFlaskGeometry(i ? 0.19 : 0.10);
    geometry.labGripY = 9.5 * U * 0.65 * LAB_FLASK_HEIGHT;
    return geometry;
  });
  // One voxel map per part, two palettes: ape and code.
  const geometries = cached(() => {
    const part = (name, build, origin) => {
      const v = build(mulberry32(fnv1a(`agent/${name}`)));
      return {
        ape: voxelGeometry(v, { unit: U, palette: APE, origin }),
        code: voxelGeometry(v, { unit: U, palette: CODE, origin, emissive: CODE_GLOW })
      };
    };
    const lab = (build, origin, unit = U) => voxelGeometry(build(mulberry32(fnv1a("agent/lab"))), { unit, palette: LAB_PALETTE, origin });
    const flask = labFlaskGeometry();
    flask.labGripY = 9.5 * U * 0.65 * LAB_FLASK_HEIGHT;
    return {
      legR: part("legR", legVox, { x: -2 * U, y: -8 * U, z: -2 * U }),
      legL: part("legL", legVox, { x: -2 * U, y: -8 * U, z: -2 * U }),
      armR: part("armR", armVox, { x: -2 * U, y: -14 * U, z: -2 * U }),
      armL: part("armL", armVox, { x: -2 * U, y: -14 * U, z: -2 * U }),
      torso: part("torso", torsoVox, { x: -5 * U, y: 0, z: -3.5 * U }),
      head: part("head", headVox, { x: -3.5 * U, y: 0, z: -2 * U }),
      feedingHead: part("head", feedingHeadVox, { x: -3.5 * U, y: 0, z: -2 * U }),
      jaw: part("jaw", jawVox, { x: -2.5 * U, y: -U, z: 0 }),
      labTorso: lab(labTorsoVox, { x: -5 * U, y: 0, z: -3.5 * U }),
      labArm: lab(labArmVox, { x: -2 * U, y: -14 * U, z: -2 * U }),
      labFlask: flask
    };
  });
  const EMPTY_COLLISION = { verts: [], faces: [], lines: [] };
  const labCoatClip = (mouth) => {
    const geos = geometries(), sr = Math.sin(mouth.ry), cr = Math.cos(mouth.ry);
    const limit = sr * mouth.x + cr * mouth.z + 0.5;
    const inside = new Float32Array([sr, 0, cr, -limit]);
    const outside = new Float32Array([-sr, 0, -cr, limit]);
    const clipped = (geometry, plane, overlay = false) => ({ ...geometry, clipPlane: plane,
      collisionGeometry: overlay ? EMPTY_COLLISION : geometry.collisionGeometry });
    const plain = (part) => ({ ape: clipped(part.ape, outside), code: clipped(part.code, outside) });
    return { mouth, sr, cr, reach: 4, torso: plain(geos.torso), armR: plain(geos.armR), armL: plain(geos.armL),
      labTorso: clipped(geos.labTorso, inside, true), labArm: clipped(geos.labArm, inside, true) };
  };
  const PART_NAMES = ["legR", "legL", "torso", "armR", "armL", "head"];
  const CLIMB_VERTICES = new WeakMap(), CLIMB_CONTACT_VERTICES = new WeakMap();
  const climbVertices = (geometry, contact = false) => {
    const cache = contact ? CLIMB_CONTACT_VERTICES : CLIMB_VERTICES;
    let samples = cache.get(geometry);
    if (samples) return samples;
    const seen = new Set(), values = [], v = geometry.verts, b = boundsOf(geometry);
    const cx = (b.min[0] + b.max[0]) * 0.0025, cy = (b.min[1] + b.max[1]) * 0.0025, cz = (b.min[2] + b.max[2]) * 0.0025;
    for (let i = 0; i < v.length; i += 3) {
      const key = `${v[i]},${v[i + 1]},${v[i + 2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (contact) values.push(v[i], v[i + 1], v[i + 2]);
      else values.push(v[i] * 0.995 + cx, v[i + 1] * 0.995 + cy, v[i + 2] * 0.995 + cz);
    }
    samples = new Float32Array(values); cache.set(geometry, samples);
    return samples;
  };


  // A step may climb at most STEP_UP and drop at most STEP_DOWN, so walls and
  // cliff edges stop the Agent instead of lifting it or dropping it off the island.
  // BODY is what it needs overhead, so it is barred by the same rock and props an Ooga is.
  const STEP_UP = 0.6, STEP_DOWN = 1.2, BODY = 13 * U;
  const GRAVITY = BL.pilot.WALK.gravity, JUMP_SPEED = BL.crew.JUMP_SPEED * Math.sqrt(1.5), REVEAL_TIME = 9;
  // A click this soon after taking the Agent was the third of a triple: a look, not a drive.
  const TRIPLE_MS = 500;
  // groundAt(x, z) is the walking surface; walkable(fromX, fromZ, toX, toZ, y, height),
  // when given, is the scene's own swept test, the one its Oogas walk by, and bounds
  // every step the Agent takes. A walk is a list of { x, z } waypoints.
  const create = ({ groundAt, walkable = null, form = "ape", x = 0, z = 0, heading = 0, managed = false, scale = 1, coatClip = null, climbSolidAt = null, groundPlaneAt = null, groundHullAt = null }) => {
    const geos = geometries();
    const root = createNode({ position: { x, y: groundAt(x, z), z }, rotation: { x: 0, y: heading, z: 0 }, scale: { x: scale, y: scale, z: scale } });
    // The renderers draw the Agent's own palette inside the Matrix instead of repainting it.
    root.matrixNative = true;
    const hips = createNode({ position: { x: 0, y: HIP, z: 0 } });
    const chest = createNode({ rotation: { x: QUAD, y: 0, z: 0 } });
    // The climbing body can meet the bent thighs without moving the shoulder
    // frame: hands, head and feet keep their existing grip transforms.
    const torso = managed ? createNode() : chest;
    if (managed) addChild(chest, torso);
    // Facing +Z, local -X is anatomical right and +X is anatomical left.
    const parts = {
      legR: createNode({ position: { x: -3 * U, y: 0, z: 0 } }),
      legL: createNode({ position: { x: 3 * U, y: 0, z: 0 } }),
      torso,
      armR: createNode({ position: { x: -SHOULDER_X, y: SHOULDER_Y, z: 0.5 * U } }),
      armL: createNode({ position: { x: SHOULDER_X, y: SHOULDER_Y, z: 0.5 * U } }),
      head: createNode({ position: { x: 0, y: NECK_Y, z: 1.5 * U } })
    };
    addChild(chest, parts.armR, parts.armL, parts.head);
    const coatParts = coatClip ? {
      torso: createNode({ geometry: coatClip.labTorso, visible: false }),
      armR: createNode({ geometry: coatClip.labArm, visible: false }),
      armL: createNode({ geometry: coatClip.labArm, visible: false })
    } : null;
    if (coatParts) {
      addChild(parts.torso, coatParts.torso);
      addChild(parts.armR, coatParts.armR);
      addChild(parts.armL, coatParts.armL);
    }
    if (managed) {
      parts.jaw = createNode({ position: { x: 0, y: U, z: 4 * U } });
      addChild(parts.head, parts.jaw);
      parts.armR.rotation.x = parts.armL.rotation.x = -QUAD;
      parts.head.rotation.x = -QUAD * 0.85;
    }
    const labPlaceholder = managed ? createNode({ geometry: geos.labFlask, visible: false, sightHidden: true }) : null;
    if (labPlaceholder) BL.models.attachGlassShell(labPlaceholder);
    let labFlask = labPlaceholder, labGripY = geos.labFlask.labGripY;
    const labItemRotation = managed ? new Float32Array([0, 0, 0, 1]) : null;
    const labArmRotation = managed ? new Float32Array(4) : null, labUprightRotation = managed ? new Float32Array(4) : null;
    const labGripOffset = managed ? new Float32Array(3) : null;
    if (labFlask) addChild(parts.armL, labFlask);
    addChild(hips, parts.legR, parts.legL, chest);
    addChild(root, hips);
    const state = {
      form: null, gait: "idle", walkGait: "knuckle", phase: 0, walkPhase: NaN, speed: 0, backwards: false, pitch: QUAD, heading,
      groundPlane: false, groundX: 0, groundZ: 0, groundY: 0,
      route: null, routeIndex: 0, idleFor: 1 + Math.random() * 2, gaitFor: 0, beat: 0,
      pace: null, driven: false, walkStyle: "knuckle", inX: 0, inZ: 0, inRun: false,
      vy: 0, air: false, jumps: 0, revealFor: 0, pound: 0, chewing: 0, biped: false, lounge: "", hipHeight: HIP,
      poundCharge: 0, takeoff: 0, landing: 0, crouch: 0, roll: 0, rollBlend: 0, rollAngle: 0, rollTarget: 0, rollSide: 0,
      smash: false, dragging: false, throwProgress: 0, hipOffsetZ: 0, sideAngle: 0, swim: 0, swimBlend: 0,
      climb: 0, climbBlend: 0, climbPose: NaN, climbStride: 0, climbDirection: 0, climbSide: 0,
      climbArmBaseL: 0, climbArmBaseR: 0, climbFitArms: 0,
      climbGripX: NaN, climbGripY: NaN, climbGripZ: NaN, climbGripRelease: 0,
      walkLegLiftR: 0, walkLegLiftL: 0,
      groom: 0, groomBlend: 0, groomSide: 1, groomTime: 0, sitLook: 0, sitShift: 0,
      lab: false, labRunIn: false, coatSplit: false, labWork: "", labPhase: 0, labSide: 1, labReach: 0, labReachGrip: geos.labFlask.labGripY, labPreviewItem: false, labSqueeze: false, labDie: false, labRoll: 0,
      labPalmLift: 0, labBench: null, labTouchArm: false, labTouchSide: 1,
      labArmOffsetX: 0, labArmOffsetY: 0, labArmOffsetZ: 0
    };
    const positionLabItem = () => {
      if (!managed || labFlask === labPlaceholder && !state.labPreviewItem) return;
      const arm = parts.armL, inspect = state.labWork === "carry" ? 1 - Math.max(state.labReach, state.labRoll) : 0;
      quat.fromEuler(labArmRotation, arm.rotation.x, arm.rotation.y, arm.rotation.z);
      quat.fromEuler(labUprightRotation, state.pitch, 0, 0);
      quat.multiply(labArmRotation, labUprightRotation, labArmRotation);
      labArmRotation[0] *= -1; labArmRotation[1] *= -1; labArmRotation[2] *= -1;
      const shake = state.labDie ? 7.5 : 2.1, tilt = state.labDie ? 0.14 : 0.055;
      quat.fromEuler(labUprightRotation, Math.sin(state.labPhase * shake) * tilt * inspect,
        Math.sin(state.labPhase * (state.labDie ? 6.3 : 1.7)) * 0.16 * inspect, Math.cos(state.labPhase * shake) * tilt * inspect);
      quat.multiply(labItemRotation, labArmRotation, labUprightRotation);
      quat.rotateVec(labGripOffset, labItemRotation, 0, labGripY / scale, 0);
      labFlask.position.x = -labGripOffset[0];
      labFlask.position.y = -1.09 - labGripOffset[1];
      labFlask.position.z = 0.14 - state.labPalmLift - labGripOffset[2];
    };
    let refreshGeometry = null;
    const rollQuaternion = managed ? new Float32Array([0, 0, 0, 1]) : null;
    const setForm = (next, force = false) => {
      if (state.form === next && !force) return;
      state.form = next;
      for (const name of PART_NAMES) parts[name].geometry = state.coatSplit && (name === "torso" || name === "armR" || name === "armL")
        ? coatClip[name][next] : state.lab && name === "torso" ? geos.labTorso
          : state.lab && (name === "armR" || name === "armL") ? geos.labArm : geos[managed && name === "head" ? "feedingHead" : name][next];
      if (coatParts) coatParts.torso.visible = coatParts.armR.visible = coatParts.armL.visible = state.coatSplit;
      if (managed) parts.jaw.geometry = geos.jaw[next];
      if (refreshGeometry) refreshGeometry();
    };
    setForm(form);
    const setGait = (gait) => {
      if (!GAITS[gait]) throw new Error(`agent: unknown gait ${gait}`);
      state.gait = gait;
      if (gait === "knuckle" || gait === "gallop" || gait === "hunch") state.walkGait = gait;
    };
    // A walk along waypoints; gallop for long trips, otherwise knuckle or hunch, re-rolled as it goes.
    const walk = (route, long = false) => {
      state.route = route;
      state.routeIndex = 0;
      state.walkGait = long && Math.random() < 0.4 ? "gallop" : Math.random() < 0.55 ? "knuckle" : "hunch";
      state.gaitFor = 5 + Math.random() * 4;
      state.gait = state.walkGait;
    };
    // Games: stay near a spot, idling and making short runs within the radius.
    const PACE_TARGET = [{ x: 0, z: 0 }];
    const pace = (cx, cz, radius) => {
      state.pace = { x: cx, z: cz, radius };
    };
    const nextPace = () => {
      const p = state.pace, a = Math.random() * TAU, r = p.radius * Math.sqrt(Math.random());
      PACE_TARGET[0].x = p.x + Math.cos(a) * r;
      PACE_TARGET[0].z = p.z + Math.sin(a) * r;
      walk(PACE_TARGET, Math.hypot(PACE_TARGET[0].x - root.position.x, PACE_TARGET[0].z - root.position.z) > p.radius * 0.8);
    };
    const place = (px, pz, facing) => {
      root.position.x = px;
      root.position.z = pz;
      root.position.y = groundAt(px, pz);
      state.air = false; state.vy = state.jumps = 0;
      state.heading = facing;
      state.route = null;
      state.gait = "idle";
      state.idleFor = 1 + Math.random() * 2;
    };
    // Player control: a world-space direction (length up to 1) and whether to run.
    const setDriven = (on) => {
      state.driven = on;
      state.route = null;
      state.beat = 0;
      state.gait = "idle";
      state.inX = state.inZ = 0;
      if (!on) state.idleFor = 1 + Math.random() * 2;
    };
    const drive = (dirX, dirZ, run) => {
      state.inX = dirX;
      state.inZ = dirZ;
      state.inRun = run;
    };
    const toggleStyle = () => {
      state.walkStyle = state.walkStyle === "knuckle" ? "hunch" : "knuckle";
    };
    // A step has to clear the ground limits and the scene's own sweep, so the
    // Agent stops at what stops an Ooga instead of walking through it.
    const stepTo = (nx, nz) => {
      const p = root.position, ground = groundAt(p.x, p.z), ny = groundAt(nx, nz);
      if (ny <= ground - STEP_DOWN || ny >= p.y + STEP_UP) return false;
      if (walkable && !walkable(p.x, p.z, nx, nz, p.y, BODY)) return false;
      p.x = nx;
      p.z = nz;
      return true;
    };
    // Blocked head on, try each axis alone, the way a walking Ooga slides along a wall.
    const slideTo = (nx, nz) => {
      const p = root.position;
      return stepTo(nx, nz) || nx !== p.x && stepTo(nx, p.z) || nz !== p.z && stepTo(p.x, nz);
    };
    const driven = (dt) => {
      const m = Math.hypot(state.inX, state.inZ);
      if (m < 0.1) {
        state.gait = "idle";
        return;
      }
      state.gait = state.inRun ? "gallop" : state.walkStyle;
      const want = Math.atan2(state.inX, state.inZ), turn = Math.atan2(Math.sin(want - state.heading), Math.cos(want - state.heading));
      state.heading += turn * (1 - Math.exp(-8 * dt));
      const p = root.position, step = state.speed * dt * Math.min(1, m) * Math.max(0, Math.cos(turn));
      slideTo(p.x + Math.sin(state.heading) * step, p.z + Math.cos(state.heading) * step);
    };
    const jump = () => {
      const jumps = state.air ? Math.max(1, state.jumps) : 0;
      if (jumps >= 2) return false;
      state.air = true;
      state.vy = JUMP_SPEED; state.jumps = jumps + 1;
      return true;
    };
    // Its true colours outside the Matrix, for a while
    const reveal = () => {
      state.revealFor = REVEAL_TIME;
    };
    const poke = () => {
      if (managed) return beat();
      state.beat = BEAT_TIME;
      state.gait = "beat";
    };
    const feed = () => { state.chewing = CHEW_TIME; };
    const beat = () => {
      if (!managed || state.pound > 0 || state.beat > 0 || state.speed > 0.1 || state.air || state.crouch > 0.01 || state.rollBlend > 0.001 || state.roll > 0 || state.climb > 0 || state.climbBlend > 0.001) return false;
      state.beat = MANAGED_BEAT_TIME;
      return true;
    };
    const pound = (allowAir = false, charge = 0, combo = false) => {
      if (!managed || state.pound > 0 && !combo || state.beat > 0 || state.air && !allowAir || state.crouch > 0.01 && !allowAir || state.rollBlend > 0.001 || state.roll > 0 || state.climb > 0 || state.climbBlend > 0.001) return false;
      state.pound = POUND_TIME * (1 - (combo ? 0.46 : 0.34 * clamp(charge, 0, 1)));
      return state.pound;
    };
    // Called with no route while idle; returns once a new walk is wanted.
    let onIdle = null;
    const steer = (dt) => {
      const target = state.route[state.routeIndex];
      const p = root.position, dx = target.x - p.x, dz = target.z - p.z, distance = Math.hypot(dx, dz);
      if (distance < 0.3) {
        state.routeIndex++;
        if (state.routeIndex >= state.route.length) {
          state.route = null;
          state.gait = "idle";
          state.idleFor = 1.5 + Math.random() * 3;
        }
        return;
      }
      const want = Math.atan2(dx, dz), turn = Math.atan2(Math.sin(want - state.heading), Math.cos(want - state.heading));
      state.heading += turn * (1 - Math.exp(-6 * dt));
      state.gaitFor -= dt;
      if (state.gaitFor <= 0 && state.walkGait !== "gallop") {
        state.walkGait = Math.random() < 0.55 ? "knuckle" : "hunch";
        state.gait = state.walkGait;
        state.gaitFor = 5 + Math.random() * 4;
      }
      // Slow while facing away, so it turns before it runs on
      const step = Math.min(distance, state.speed * dt * Math.max(0, Math.cos(turn)));
      // Walled in: drop the route and idle, and onIdle picks somewhere else to go.
      if (!slideTo(p.x + Math.sin(state.heading) * step, p.z + Math.cos(state.heading) * step)) {
        state.route = null;
        state.gait = "idle";
        state.idleFor = 0.4 + Math.random() * 0.8;
      }
    };
    const limb = (node, angle, dt, rate = 18) => {
      node.rotation.x = damp(node.rotation.x, angle, rate, dt);
    };
    const pose = (dt) => {
      state.climbFitArms = 0;
      const g = GAITS[state.gait], top = managed ? state.speed : state.driven ? g.drive : g.speed;
      const stride = (state.driven ? g.driveStride : g.stride) * scale;
      if (!managed) state.speed = damp(state.speed, top, 6, dt);
      state.phase = (state.phase + dt * state.speed / stride * (managed && state.backwards ? -1 : 1)) % 1;
      // Arrival damping leaves tiny nonzero speeds. Scientists must settle
      // their feet instead of keeping a full stride (speed / itself) at a desk.
      const moving = top > 0 ? clamp(state.speed / (managed && state.lab ? GAITS.upright.speed : top), 0, 1) : 0;
      const lounge = managed ? state.lounge : "", onSide = lounge === "left" || lounge === "right", reclining = lounge === "back" || onSide;
      const leaning = lounge === "lean-left" || lounge === "lean-right" || lounge === "lean-back";
      const leanSide = lounge === "lean-left" ? -1 : lounge === "lean-right" ? 1 : 0;
      if (managed) {
        state.crouch = damp(state.crouch, state.air ? 0 : Math.min(1, state.landing * 2), state.air ? 24 : 20, dt);
        state.rollBlend = damp(state.rollBlend, state.roll, 9, dt);
        state.rollAngle = damp(state.rollAngle, state.rollTarget * state.rollBlend, 18, dt);
        state.sideAngle = damp(state.sideAngle, onSide ? (lounge === "left" ? 1 : -1) * 1.32 : 0, 5, dt);
        // Wall and ground rectangles select the pose directly, without a
        // separate mount or over-the-edge animation.
        state.climbBlend = Number.isFinite(state.climbPose) ? state.climbPose : state.climb;
        state.groomBlend = damp(state.groomBlend, state.groom, 8, dt);
        state.swimBlend = damp(state.swimBlend, state.swim, 5, dt);
        state.groomTime += dt;
      }
      const crouch = managed ? state.crouch : 0, rolling = managed ? state.rollBlend : 0, climbing = managed ? state.climbBlend : 0;
      const swimming = managed && state.swimBlend > 0.001 ? state.swimBlend : 0, swimPhase = state.labPhase * SWIM.rate;
      const grooming = lounge === "sit" ? state.groomBlend : 0, sitLook = lounge === "sit" ? state.sitLook : 0;
      const sitShift = lounge === "sit" ? state.sitShift : 0, climbPhase = managed ? state.climbStride / 1.2 : 0;
      // Seated rests have frequent, gentle glances and alternating hand lifts.
      // Spatial phase keeps neighbours from moving together; reclining poses
      // pause between fidgets and keep their supporting arms planted.
      const restTime = state.groomTime + root.position.x * 0.61 + root.position.z * 0.37;
      const restPeriod = lounge === "sit" ? 9 : 18, restPause = lounge === "sit" ? 2 : 10;
      const restCycle = ((restTime % restPeriod) + restPeriod) % restPeriod;
      const restMotion = lounge && restCycle > restPause ? Math.sin((restCycle - restPause) * Math.PI / (restPeriod - restPause)) ** 2 * (1 - grooming) : 0;
      const jumping = managed && state.air, takeoff = managed ? state.takeoff : 0;
      const groundPitch = state.groundPlane ? -Math.atan(state.groundZ) : 0;
      const laboratory = managed && state.lab && !state.labRunIn && !lounge && !jumping && rolling <= 0.001 && climbing <= 0.001 && state.pound <= 0 && !state.poundCharge;
      const labWork = laboratory ? state.labWork : "";
      const labSqueeze = laboratory && state.labSqueeze && !labWork && labFlask === labPlaceholder;
      const labWalking = laboratory && !labWork && !labSqueeze && state.speed > 0.1;
      const squeeze = managed && state.biped === "squeeze" && !lounge && !state.air && state.pound <= 0 && state.beat <= 0;
      let pitch = squeeze || labSqueeze ? 0 : laboratory ? 0.08 : g.pitch, bob = 0;
      if (state.gait === "gallop") {
        pitch += 0.12 * wave(state.phase, 0.25) * moving;
        bob = 0.08 * Math.max(0, wave(state.phase, 0.25)) * moving;
      } else if (moving > 0) bob = 0.02 * Math.abs(wave(state.phase, 0)) * moving;
      if (swimming) { pitch += (QUAD - pitch) * swimming; bob *= 1 - swimming; }
      let poundLift = 0, slamDrive = 0;
      if (managed && state.poundCharge > 0 && state.pound <= 0) {
        poundLift = state.poundCharge;
        pitch = 1.02 - 0.86 * poundLift;
      }
      if (managed && state.pound > 0) {
        // A charged smash starts partway through the raised-arm phase, where
        // the held pose already is, instead of lifting the arms a second time.
        const t = 1 - state.pound / POUND_TIME;
        // A controlled smash rears up with both fists overhead, then folds at
        // the shoulders as the fists strike the floor. Workers keep
        // their shorter equipment-pounding gesture.
        poundLift = state.smash ? t < 0.34 ? t / 0.34 : t < 0.46 ? 1 : t < 0.66 ? 1 - (t - 0.46) / 0.2 : 0
          : t < 0.28 ? t / 0.28 : t < 0.58 ? 1 - (t - 0.28) / 0.3 : 0;
        if (state.smash) {
          // Put the weight behind the downward stroke, then recover without
          // holding the moving body at the point of impact.
          const drive = t < 0.46 ? 0 : t < 0.66 ? (t - 0.46) / 0.2 : (1 - t) / 0.34;
          slamDrive = drive * drive * (3 - 2 * drive);
        }
        pitch = state.smash ? 1.02 - 0.86 * poundLift + 0.46 * slamDrive : 1.02 - 0.36 * poundLift;
        state.pound = Math.max(0, state.pound - dt);
      }
      if (lounge) { pitch = reclining ? 0 : leaning ? -0.46 : -0.18 + grooming * 0.12 + Math.abs(sitShift) * 0.07; bob = 0; }
      // Takeoff extends the limbs before the airborne tuck; landing compresses them.
      if (crouch > 0) { pitch += (1.12 - pitch) * crouch; bob *= 1 - crouch; }
      if (jumping) { pitch += (0.82 - pitch) * takeoff; bob = 0; }
      if (rolling > 0) { pitch *= 1 - rolling; bob *= 1 - rolling; }
      if (climbing > 0) { pitch += (0.18 - pitch) * climbing; bob *= 1 - climbing; }
      state.pitch = managed && Number.isFinite(state.climbPose) ? pitch : damp(state.pitch, pitch, slamDrive > 0 ? 24 : 6, dt);
      chest.rotation.x = state.pitch;
      if (managed) {
        const tilt = -0.22 * climbing;
        torso.rotation.x = tilt;
        torso.position.y = SHOULDER_Y * (1 - Math.cos(tilt));
        torso.position.z = -SHOULDER_Y * Math.sin(tilt);
        // Settle the pelvis between the bent thighs instead of holding the
        // whole torso above them on straight arms. A one-hand lean also moves
        // its weight toward that hand; the other hand stays near the lap.
        chest.position.x = damp(chest.position.x, sitShift * 0.035, 5, dt);
        chest.position.y = damp(chest.position.y, lounge === "sit" ? -0.324 + Math.abs(sitShift) * 0.018 : leaning ? -0.35 : -0.04 * slamDrive, slamDrive > 0 ? 18 : 6, dt);
        chest.position.z = damp(chest.position.z, 0.13 * climbing, 16, dt);
        chest.rotation.z = damp(chest.rotation.z, leaning ? -leanSide * 0.08 : -sitShift * 0.065, 6, dt);
      }
      const o = OFFSETS[state.gait];
      // Arms hang straight down in the world whatever the chest's lean; the swing reaches forward and back.
      for (let i = 0; i < LIMBS.length; i++) {
        const l = LIMBS[i], arm = parts[l.arm];
        if (managed && l.side > 0) {
          arm.position.x -= state.labArmOffsetX; arm.position.y -= state.labArmOffsetY; arm.position.z -= state.labArmOffsetZ;
          state.labArmOffsetX = state.labArmOffsetY = state.labArmOffsetZ = 0;
        }
        // Keep an idle scientist's shoulders at the same width as its walking
        // pose; narrow gaps can let the arms pass through scenery instead.
        const climbStroke = wave(climbPhase, l.side < 0 ? 0 : 0.5), leg = parts[l.leg];
        if (managed) {
          // Contact fitting is a correction to this frame's pose. Feeding the
          // previous lift into damping accumulates it while a wall stays near.
          leg.position.y -= l.side < 0 ? state.walkLegLiftR : state.walkLegLiftL;
          if (l.side < 0) state.walkLegLiftR = 0; else state.walkLegLiftL = 0;
          // Ordinary lab steps leave room between the coat and forearms.
          arm.position.x = damp(arm.position.x, l.side * ((laboratory ? 0.66 : squeeze ? 0.4 : SHOULDER_X) * (1 - climbing) + 0.38 * climbing), 12, dt);
          // Counter the torso's tilt during each lift so the hands and toes
          // move along the wall instead of pumping away from its surface.
          arm.position.z = damp(arm.position.z, 0.5 * U - climbing * (0.036 + climbStroke * 0.055), 20, dt);
          arm.position.y = damp(arm.position.y, SHOULDER_Y + climbStroke * 0.115 * climbing + (labWork === "type" ? 0.06 : 0)
            - (leaning && (!leanSide || l.side === leanSide) ? 0.077 : 0), 20, dt);
          leg.position.y = damp(leg.position.y, Math.max(0, -climbStroke) * 0.09 * climbing, 18, dt);
          leg.position.z = damp(leg.position.z, (0.36 + climbStroke * 0.034) * climbing, 20, dt);
          leg.rotation.z = damp(leg.rotation.z, -state.climbSide * climbStroke * 0.07 * climbing, 18, dt);
        }
        let legAngle = lounge ? onSide ? -0.42 : reclining ? 0.1 : leaning ? leanSide ? -1.1 : -1.14 : -1.28 + l.side * sitShift * 0.1 : jumping ? 0.7 - takeoff * 0.85 : o ? -(squeeze ? 0.1 : labSqueeze ? 0.16 : g.legs) * moving * wave(state.phase, o[l.leg]) : 0;
        if (lounge && (!onSide || (lounge === "left" ? l.side > 0 : l.side < 0)))
          legAngle += Math.sin(restTime * 0.7 + i * Math.PI) * 0.06 * restMotion;
        legAngle += (-1.2 - legAngle) * crouch;
        if (state.speed <= 0.1) legAngle -= 0.42 * slamDrive;
        legAngle += (-1.25 - legAngle) * rolling;
        legAngle += (-0.16 + 0.06 * climbStroke - legAngle) * climbing;
        const paddle = swimming ? Math.sin(swimPhase + (l.side < 0 ? 0 : Math.PI)) : 0;
        legAngle += (SWIM.legs + SWIM.kick * paddle - legAngle) * swimming;
        // The pelvis follows the rectangle's front-to-back grade. Keep the
        // rear feet beneath it while the front knuckles reach the higher pad.
        legAngle -= groundPitch;
        limb(leg, legAngle, dt, managed && state.landing > 0 ? 32 : 18);
        if (managed && state.dragging && l.side > 0) {
          // The left hand keeps its grip as it swings the Ooga from behind
          // the body to the release point. The other three limbs keep gait.
          const swing = state.throwProgress * state.throwProgress * (3 - 2 * state.throwProgress);
          limb(arm, -state.pitch + 1.15 - 2.9 * swing, dt, 22);
          arm.rotation.z = damp(arm.rotation.z, 0.12 - 0.27 * swing, 16, dt);
        } else if (rolling > 0.001) {
          limb(arm, -state.pitch - 1.25 * rolling, dt);
          arm.rotation.z = damp(arm.rotation.z, -l.side * 0.22 * rolling, 12, dt);
        } else if (lounge) {
          // The lower arm cushions the head on its side; the upper hand rests
          // across the chest. A seated neighbour picks with one hand while the
          // other stays planted beside its hip.
          const lower = onSide && (lounge === "left" ? l.side < 0 : l.side > 0);
          const supporting = leaning && (!leanSide || l.side === leanSide) || lower || lounge === "sit";
          const groomArm = l.side === state.groomSide ? grooming : 0;
          // Reach the neighbour's mid-back; the higher, straighter reach drove
          // the knuckles through its shoulder during the picking cycle.
          const pick = Math.sin(state.groomTime * 10.5), reach = -0.9 + pick * 0.055;
          // The free hand rests near the bent knee. Matching its old angle to
          // the reclined chest left it pointing almost horizontally in midair.
          const rest = (leaning ? supporting ? -state.pitch + 1 : -0.55 : onSide ? lower ? -2.3 : -1.08 : reclining ? -0.08 : -state.pitch - 0.801 + l.side * sitShift * 0.1)
            + (lounge === "sit" ? -0.15 * Math.max(0, Math.sin(restTime * 0.9 + i * Math.PI)) * restMotion
              : supporting ? 0 : Math.sin(restTime * 0.8 + i) * 0.08 * restMotion);
          limb(arm, rest + (reach - rest) * groomArm, dt);
          const restSide = leaning ? supporting ? l.side * 0.18 : -l.side * 0.12 : onSide ? lower ? -l.side * 0.2 : -l.side * 0.55 : reclining ? l.side * 0.18 : -l.side * 0.12;
          arm.rotation.z = damp(arm.rotation.z, restSide + (l.side * 0.6 - restSide) * groomArm, 12, dt);
        } else if (labWork) {
          const stroke = Math.sin(state.labPhase * (labWork === "type" ? 11 : 2.7) + i * Math.PI);
          const working = labWork === "type" || labWork === "touch" && l.side === state.labSide || labWork === "carry" && l.side > 0;
          const inspect = -1.83 + Math.sin(state.labPhase * (state.labDie ? 7.5 : 1.1)) * 0.1;
          const shoulderY = HIP + Math.cos(state.pitch) * SHOULDER_Y - Math.sin(state.pitch) * 0.5 * U;
          const handY = (1.14 + state.labReachGrip) / scale - shoulderY;
          const reachBench = Math.atan2(0.14, 1.09 * Math.cos(0.08))
            - Math.acos(clamp(-handY / Math.hypot(1.09 * Math.cos(0.08), 0.14), -1, 1)) - state.pitch;
          const reach = labWork === "type" ? -1.25 + stroke * 0.055 : labWork === "touch" ? -1.95 + stroke * 0.1
            : inspect + (reachBench - inspect) * Math.max(state.labReach, state.labRoll);
          limb(arm, working ? reach : -state.pitch - g.arms * moving * wave(state.phase, i * 0.5), dt);
          arm.rotation.z = damp(arm.rotation.z, working ? -l.side * 0.08 : 0, 12, dt);
        } else if (managed && (state.pound > 0 || poundLift > 0)) {
          // Reach ahead of the lowered shoulders with straight arms as the
          // torso folds nearly parallel to the ground at impact.
          limb(arm, -state.pitch - (state.smash || state.poundCharge > 0 ? 2.7 : 1.65) * poundLift - 0.9 * slamDrive, dt, slamDrive > 0 ? 28 : 18);
          arm.rotation.z = damp(arm.rotation.z, 0, 18, dt);
        } else if (state.gait === "beat") {
          // Alternate fists on the chest, easing in and out of the pose
          const beatTime = managed ? MANAGED_BEAT_TIME : BEAT_TIME;
          const k = Math.min(1, (beatTime - state.beat) * 4) * Math.min(1, state.beat * 4);
          arm.rotation.x = damp(arm.rotation.x, -state.pitch - (1.25 + 0.3 * Math.sin((beatTime - state.beat) * 16 + (l.side < 0 ? 0 : Math.PI))) * k, 18, dt);
          arm.rotation.z = damp(arm.rotation.z, -l.side * 0.45 * k, 12, dt);
        } else if (climbing > 0.001 && !jumping) {
          let armAngle = -state.pitch - (o && !squeeze ? g.arms * moving * wave(state.phase, o[l.arm]) : 0);
          armAngle += (-state.pitch - 1 - armAngle) * crouch;
          const raised = -2.8 + 0.035 * climbStroke;
          // Blend targets before damping. Mixing the resulting pose afterward
          // made small live steps raise the arms farther than route previews.
          if (climbSolidAt) {
            state.climbFitArms |= 1 << i;
            if (l.side < 0) state.climbArmBaseR = armAngle;
            else state.climbArmBaseL = armAngle;
          } else limb(arm, armAngle + (raised - armAngle) * climbing, dt);
          const rest = state.gait === "hunch" ? l.side * 0.12 : 0;
          // Transfer one grip sideways while the opposite foot follows;
          // diagonal motion combines this with the vertical stroke.
          const reach = l.side * 0.14 + state.climbSide * climbStroke * 0.1;
          arm.rotation.z = damp(arm.rotation.z, rest + (reach - rest) * climbing, 18, dt);
        } else {
          let armAngle = -state.pitch - groundPitch - (jumping ? state.biped ? 0.2 : 0.7 - takeoff * 0.85 : o && !squeeze ? (labSqueeze ? 0.08 : labWalking ? 0.1 : g.arms) * moving * wave(state.phase, o[l.arm]) : 0);
          armAngle += (-state.pitch - 1 - armAngle) * crouch;
          armAngle += (-state.pitch - SWIM.reach - SWIM.stroke * paddle - armAngle) * swimming;
          limb(arm, armAngle, dt, managed && state.landing > 0 ? 32 : 18);
          arm.rotation.z = damp(arm.rotation.z, state.gait === "hunch" ? l.side * 0.12 : 0, 8, dt);
        }
        if (managed && !(climbing > 0.001 && !jumping && climbSolidAt)) {
          const groomArm = lounge === "sit" && l.side === state.groomSide ? grooming : 0;
          arm.rotation.y = damp(arm.rotation.y, state.dragging && l.side > 0
            ? -0.4 * Math.sin(Math.PI * state.throwProgress) : l.side * 0.67 * groomArm, 12, dt);
        }
      }
      if (managed) {
        const arm = parts.armL, angle = arm.rotation.x;
        const palm = labWork === "carry" ? 0.1 + 0.17 * clamp((1.32 + angle) / 0.12, 0, 1) : 0;
        state.labPalmLift = damp(state.labPalmLift, palm, 24, dt);
        const lift = laboratory ? state.labPalmLift : 0;
        // Reach straight forward and withdraw along the same arc. Only this
        // hand's own pickup bench permits contact while the arm passes its top.
        if (!laboratory || labWork === "type" || labWork === "touch"
          || labWork !== "carry" && Math.abs(angle + state.pitch) < 0.03) state.labBench = null;
        // Put the low cube in the palm instead of its forward edge. Moving the
        // shoulder by the same local offset preserves the exact item contact.
        state.labArmOffsetX = Math.sin(arm.rotation.y) * Math.cos(angle) * lift;
        state.labArmOffsetY = -Math.sin(angle) * lift;
        state.labArmOffsetZ = Math.cos(arm.rotation.y) * Math.cos(angle) * lift;
        arm.position.x += state.labArmOffsetX; arm.position.y += state.labArmOffsetY; arm.position.z += state.labArmOffsetZ;
        if (laboratory && labWork === "touch") { state.labTouchArm = true; state.labTouchSide = state.labSide; }
        const touchArm = state.labTouchSide < 0 ? parts.armR : parts.armL;
        if (!laboratory || labWork === "carry" || labWork === "type" || Math.abs(touchArm.rotation.x + state.pitch) < 0.03) state.labTouchArm = false;
        if (state.labTouchArm) {
          const reach = clamp((-touchArm.rotation.x - 0.08) / 1.48, 0, 1);
          touchArm.rotation.y = -state.labTouchSide * 1.7 * Math.sin(Math.PI * reach);
        }
      }
      // The head keeps the face forward, looking up when it rears
      parts.head.rotation.x = -state.pitch * (state.gait === "beat" ? 1.15 : 0.85);
      if (managed) {
        parts.head.position.z = 1.5 * U - 0.12 * climbing;
        parts.head.rotation.x += (-0.04 - state.climbDirection * 0.16 - parts.head.rotation.x) * climbing;
        parts.head.rotation.x += Math.sin(restTime * 0.65) * 0.055 * restMotion - Math.abs(sitLook) * 0.065;
        parts.head.rotation.y = damp(parts.head.rotation.y, state.groomSide * 0.36 * grooming + Math.sin(restTime * 0.5) * 0.16 * restMotion + sitLook * 0.3 + sitShift * 0.12 + state.climbSide * 0.16 * climbing, 8, dt);
        if (labWork) {
          parts.head.rotation.x = labWork === "type" || labWork === "roll" ? 0.22 : labWork === "carry" ? 0.08 : -0.08;
          parts.head.rotation.y = labWork === "touch" ? state.labSide * 0.12 : Math.sin(state.labPhase * 0.7) * 0.05;
        }
        positionLabItem();
        state.beat = Math.max(0, state.beat - dt);
        state.chewing = Math.max(0, state.chewing - dt);
        const chew = state.chewing > 0 ? Math.abs(Math.sin((CHEW_TIME - state.chewing) * 29)) : 0;
        parts.jaw.position.y = (1 - chew * 0.65) * U;
        parts.jaw.rotation.x = chew * 0.16;
      }
      if (managed) {
        const hipHeight = (lounge ? reclining ? 0 : 0.12 : HIP - 0.17 * crouch + 0.08 * takeoff - 0.06 * slamDrive) * (1 - rolling);
        state.hipHeight = damp(state.hipHeight, hipHeight, slamDrive > 0 ? 18 : crouch > 0 || jumping ? 14 : 6, dt);
        const groundRoll = state.groundPlane ? Math.atan(state.groundX / Math.hypot(1, state.groundZ)) : 0;
        hips.rotation.x = damp(hips.rotation.x, reclining ? -Math.PI / 2 : rolling ? Math.PI / 2 * rolling : groundPitch, rolling > 0.0001 ? 9 : 6, dt);
        hips.rotation.z = damp(hips.rotation.z, groundRoll, 6, dt);
        state.hipOffsetZ = damp(state.hipOffsetZ, reclining ? 0.5 : 0, 6, dt);
        hips.position.z = state.hipOffsetZ;
        hips.position.y = state.hipHeight + bob;
        // A fire roll turns halfway around the body's length before it rocks on its back.
        // Side sleepers still rotate about the chest's forward axis.
        if (rolling > 0.0001 || Math.abs(state.rollAngle) > 0.0001 || Math.abs(state.rollSide) > 0.0001 || Math.abs(state.sideAngle) > 0.0001) {
          const sx = Math.sin(hips.rotation.x * 0.5), cx = Math.cos(hips.rotation.x * 0.5);
          if (rolling > 0.0001 || Math.abs(state.rollAngle) > 0.0001 || Math.abs(state.rollSide) > 0.0001) {
            const sz = Math.sin(state.rollSide * 0.5), cz = Math.cos(state.rollSide * 0.5);
            const sy = Math.sin(state.rollAngle * 0.5), cy = Math.cos(state.rollAngle * 0.5);
            const bx = cz * sx, by = sz * sx, bz = sz * cx, bw = cz * cx;
            rollQuaternion[0] = bx * cy - bz * sy; rollQuaternion[1] = bw * sy + by * cy;
            rollQuaternion[2] = bz * cy + bx * sy; rollQuaternion[3] = bw * cy - by * sy;
          } else {
            const sz = Math.sin(state.sideAngle * 0.5), cz = Math.cos(state.sideAngle * 0.5);
            rollQuaternion[0] = cz * sx; rollQuaternion[1] = sz * sx;
            rollQuaternion[2] = sz * cx; rollQuaternion[3] = cz * cx;
          }
          // A slight slope plants the lower foot alongside the hip and forearm.
          // A steeper tilt leaves the torso suspended between those extremities.
          const tilt = 0.1 * Math.abs(Math.sin(state.sideAngle)), st = Math.sin(tilt * 0.5), ct = Math.cos(tilt * 0.5);
          const qx = rollQuaternion[0], qy = rollQuaternion[1], qz = rollQuaternion[2], qw = rollQuaternion[3];
          rollQuaternion[0] = ct * qx + st * qw; rollQuaternion[1] = ct * qy - st * qz;
          rollQuaternion[2] = ct * qz + st * qy; rollQuaternion[3] = ct * qw - st * qx;
          hips.quaternion = rollQuaternion;
        } else hips.quaternion = null;
      } else hips.position.y = HIP + bob;
      root.rotation.y = state.heading;
    };
    const update = (dt) => {
      // Managed companions belong to their shared collision controller. A scene's
      // ordinary Agent update must never move or animate them a second time.
      if (managed || !(dt > 0)) return;
      if (state.revealFor > 0) state.revealFor -= dt;
      if (state.beat > 0) {
        state.beat -= dt;
        if (state.beat <= 0) state.gait = state.route ? state.walkGait : "idle";
      } else if (state.driven) driven(dt);
      else if (state.route) steer(dt);
      else if ((state.idleFor -= dt) <= 0) {
        if (state.pace) nextPace();
        else if (onIdle) onIdle();
        else state.idleFor = 2;
      }
      pose(dt);
      const ground = groundAt(root.position.x, root.position.z);
      if (state.air) {
        state.vy -= GRAVITY * dt;
        root.position.y += state.vy * dt;
        if (root.position.y <= ground) {
          root.position.y = ground;
          state.air = false;
          state.vy = state.jumps = 0;
        }
      } else root.position.y = ground;
    };
    // Geometry bounds are cached once; seven tiny matrix products cover every arm,
    // foot and jaw through the current animation. The controller can reserve the
    // full envelope instead of colliding only the narrower torso.
    const envelopeParts = managed ? [parts.legR, parts.legL, torso, parts.armR, parts.armL, parts.head, parts.jaw, labFlask] : null;
    const envelopeBounds = managed ? envelopeParts.map((part) => boundsOf(part.geometry)) : null;
    const trunkCorners = managed ? torsoCorners(torso.geometry) : null;
    const envelopeChest = managed ? mat4.create() : null, envelopeHead = managed ? mat4.create() : null, envelopePart = managed ? mat4.create() : null, envelopeArm = managed ? mat4.create() : null;
    const groundHull = managed && groundHullAt ? new Float64Array(24) : null;
    const supportRows = managed ? new Float64Array(envelopeParts.length * 4).fill(NaN) : null;
    const supportMinima = managed ? new Float64Array(envelopeParts.length) : null;
    const supportMinimum = (index, matrix) => {
      const at = index * 4;
      if (matrix[1] === supportRows[at] && matrix[5] === supportRows[at + 1] && matrix[9] === supportRows[at + 2] && matrix[13] === supportRows[at + 3]) return supportMinima[index];
      supportRows[at] = matrix[1]; supportRows[at + 1] = matrix[5]; supportRows[at + 2] = matrix[9]; supportRows[at + 3] = matrix[13];
      const geometry = envelopeParts[index].geometry, vertices = climbVertices(geometry), b = envelopeBounds[index];
      const cx = (b.min[0] + b.max[0]) * 0.0025, cy = (b.min[1] + b.max[1]) * 0.0025, cz = (b.min[2] + b.max[2]) * 0.0025;
      let low = Infinity;
      for (let i = 0; i < vertices.length; i += 3) low = Math.min(low,
        (matrix[1] * (vertices[i] - cx) + matrix[5] * (vertices[i + 1] - cy) + matrix[9] * (vertices[i + 2] - cz)) / 0.995 + matrix[13]);
      return supportMinima[index] = low * scale;
    };
    const partMatrix = (part) => {
      if (part === chest) return envelopeChest;
      if (part === parts.head) return envelopeHead;
      updateLocal(part);
      if (part === labFlask) {
        updateLocal(parts.armL); mat4.multiply(envelopeArm, envelopeChest, parts.armL.local);
        mat4.multiply(envelopePart, envelopeArm, part.local);
      } else mat4.multiply(envelopePart, part.parent === hips ? hips.local : part.parent === chest ? envelopeChest : envelopeHead, part.local);
      return envelopePart;
    };
    const body = { minX: 0, maxX: 0, minY: 0, maxY: BODY * scale, minZ: 0, maxZ: 0, radius: 0.75 * scale, height: BODY * scale };
    const measureBody = (fitSupport = true) => {
      updateLocal(hips);
      updateLocal(chest);
      updateLocal(parts.head);
      mat4.multiply(envelopeChest, hips.local, chest.local);
      mat4.multiply(envelopeHead, envelopeChest, parts.head.local);
      body.minX = body.minY = body.minZ = Infinity;
      body.maxX = body.maxY = body.maxZ = -Infinity;
      let radius2 = 0, compactRadius2 = 0, poundRadius2 = 0, standRadius2 = 0, parkRadius2 = 0, sitRadius2 = 0, sitWidth = 0, labRadius2 = 0, labBodyRadius2 = 0, labBodyMinY = Infinity, labBodyMaxY = -Infinity;
      const exactRest = !!state.lounge || Math.abs(state.sideAngle) > 0.001;
      let supportY = Infinity;
      for (let i = 0; i < envelopeParts.length; i++) {
        const part = envelopeParts[i], b = envelopeBounds[i];
        if (!part.visible) continue;
        const m = partMatrix(part);
        if (exactRest) supportY = Math.min(supportY, supportMinimum(i, m));
        for (let corner = 0; corner < 8; corner++) {
          const x = b[corner & 1 ? "max" : "min"][0], y = b[corner & 2 ? "max" : "min"][1], z = b[corner & 4 ? "max" : "min"][2];
          const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
          const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
          const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
          // A tilted walking rig is supported by the slope beneath its complete
          // oriented boxes, the same conservative hulls used by its sweep.
          if (state.groundPlane) {
            let floor = state.groundX * px + state.groundZ * pz + state.groundY;
            // Curved ramps depart slightly from the tangent under the root.
            // Fit low corners to that floor while leaving walls and steps to
            // the complete hull sweep below; the ordinary step height is the limit.
            if (!(corner & 2)) {
              const sine = Math.sin(state.heading), cosine = Math.cos(state.heading);
              const actual = groundAt(root.position.x + cosine * px + sine * pz,
                root.position.z - sine * px + cosine * pz, root.position.y + floor) - root.position.y;
              if (Math.abs(actual - floor) <= 0.52) floor = Math.max(floor, actual);
            }
            supportY = Math.min(supportY, py - floor);
          }
          body.minX = Math.min(body.minX, px); body.maxX = Math.max(body.maxX, px);
          body.minY = Math.min(body.minY, py); body.maxY = Math.max(body.maxY, py);
          body.minZ = Math.min(body.minZ, pz); body.maxZ = Math.max(body.maxZ, pz);
          radius2 = Math.max(radius2, px * px + pz * pz);
          if (part !== parts.armR && part !== parts.armL) {
            labBodyRadius2 = Math.max(labBodyRadius2, px * px + pz * pz);
            labBodyMinY = Math.min(labBodyMinY, py); labBodyMaxY = Math.max(labBodyMaxY, py);
          }
          const nearest = Math.min(Math.abs(pz - QUAD_CENTERS[0] * scale), Math.abs(pz - QUAD_CENTERS[1] * scale), Math.abs(pz - QUAD_CENTERS[2] * scale));
          compactRadius2 = Math.max(compactRadius2, px * px + nearest * nearest);
          const poundNearest = Math.min(Math.abs(pz - POUND_CENTERS[0] * scale), Math.abs(pz - POUND_CENTERS[1] * scale), Math.abs(pz - POUND_CENTERS[2] * scale));
          poundRadius2 = Math.max(poundRadius2, px * px + poundNearest * poundNearest);
          standRadius2 = Math.max(standRadius2, px * px + (pz - STAND_CENTER * scale) ** 2);
          parkRadius2 = Math.max(parkRadius2, px * px + (pz - PARK_CENTER * scale) ** 2);
          const labNearest = Math.min(Math.abs(pz - LAB_CENTERS[0] * scale), Math.abs(pz - LAB_CENTERS[1] * scale));
          labRadius2 = Math.max(labRadius2, px * px + labNearest * labNearest);
          // Grooming intentionally touches the seated partner with one hand.
          // Only that arm leaves the seated-neighbour footprint; the complete
          // body envelope above continues to include it for scenery clearance.
          if (!(state.lounge === "sit" && state.groomBlend > 0.001 && part === (state.groomSide < 0 ? parts.armR : parts.armL))) {
            const sitNearest = Math.min(Math.abs(pz - SIT_CENTERS[0] * scale), Math.abs(pz - SIT_CENTERS[1] * scale));
            sitRadius2 = Math.max(sitRadius2, px * px + sitNearest * sitNearest);
            sitWidth = Math.max(sitWidth, Math.abs(px));
          }
        }
      }
      // Stop animated knuckles dipping below the supporting floor without moving
      // the controller's root or interfering with its airborne height.
      const floor = state.groundPlane || exactRest ? supportY : Math.min(0, body.minY);
      if (fitSupport && floor) {
        const lift = -floor / scale;
        hips.position.y += lift;
        updateLocal(hips);
        envelopeChest[13] += lift; envelopeHead[13] += lift;
        body.maxY -= floor;
        body.minY = state.groundPlane ? body.minY - floor : 0;
      }
      if (fitSupport && state.groundPlane && groundHullAt) {
        const sine = Math.sin(state.heading), cosine = Math.cos(state.heading), p = root.position;
        let lift = 0;
        // At a landing seam the ground may touch an edge between sampled
        // pad corners. Solve its minimum vertical separation using the same
        // convex terrain contact as movement, without moving the actor root.
        for (let i = 0; i < 5; i++) {
          if (i === 2) continue;
          const b = envelopeBounds[i], m = partMatrix(envelopeParts[i]);
          for (let corner = 0; corner < 8; corner++) {
            const x = b[corner & 1 ? "max" : "min"][0];
            const y = b[corner & 2 ? "max" : "min"][1];
            const z = b[corner & 4 ? "max" : "min"][2];
            const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
            const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
            const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
            const at = corner * 3;
            groundHull[at] = p.x + cosine * px + sine * pz;
            groundHull[at + 1] = p.y + py; groundHull[at + 2] = p.z - sine * px + cosine * pz;
          }
          if (groundHullAt(groundHull)) continue;
          let low = 0, high = 0.08, current = 0.08;
          for (let k = 1; k < 24; k += 3) groundHull[k] += current;
          // Larger obstructions are left for the route's collision rejection.
          if (!groundHullAt(groundHull)) continue;
          for (let step = 0; step < 16; step++) {
            const middle = (low + high) * 0.5;
            for (let k = 1; k < 24; k += 3) groundHull[k] += middle - current;
            current = middle;
            if (groundHullAt(groundHull)) high = middle; else low = middle;
          }
          lift = Math.max(lift, high);
        }
        if (lift) {
          hips.position.y += lift / scale; updateLocal(hips);
          envelopeChest[13] += lift / scale; envelopeHead[13] += lift / scale;
          body.minY += lift; body.maxY += lift;
        }
      }
      body.radius = Math.sqrt(radius2);
      body.height = body.maxY - body.minY;
      const tm = partMatrix(torso);
      let trunkRadius2 = 0, trunkLab2 = 0, trunkStand2 = 0, trunkQuad2 = 0, trunkSit2 = 0, trunkWidth = 0;
      for (let i = 0; i < trunkCorners.length; i += 3) {
        const x = trunkCorners[i], y = trunkCorners[i + 1], z = trunkCorners[i + 2];
        const px = (tm[0] * x + tm[4] * y + tm[8] * z + tm[12]) * scale;
        const pz = (tm[2] * x + tm[6] * y + tm[10] * z + tm[14]) * scale;
        trunkRadius2 = Math.max(trunkRadius2, px * px + pz * pz);
        trunkWidth = Math.max(trunkWidth, Math.abs(px));
        trunkLab2 = Math.max(trunkLab2, px * px + (pz - 0.04 * scale) ** 2);
        trunkStand2 = Math.max(trunkStand2, px * px + (pz - 0.105 * scale) ** 2);
        trunkSit2 = Math.max(trunkSit2, px * px + (pz + 0.1 * scale) ** 2);
        const dz = Math.min(Math.abs(pz - 0.05 * scale), Math.abs(pz - 0.65 * scale));
        trunkQuad2 = Math.max(trunkQuad2, px * px + dz * dz);
      }
      body.torsoRadius = Math.sqrt(trunkRadius2) + 0.01 * scale;
      body.torsoLabCompact = trunkLab2 <= (0.58 * scale) ** 2;
      body.torsoStandCompact = trunkStand2 <= (0.6 * scale) ** 2;
      body.torsoSitCompact = state.lounge === "sit" && trunkSit2 <= (0.6 * scale) ** 2;
      body.torsoQuadCompact = trunkQuad2 <= (0.6 * scale) ** 2
        && trunkWidth <= Math.sqrt(0.6 ** 2 - 0.3 ** 2) * scale;
      // At the circles' bisectors their union still covers the entire width,
      // so faces between the tested box corners cannot escape between circles.
      body.compact = compactRadius2 <= (QUAD_RADIUS * scale) ** 2
        && Math.max(-body.minX, body.maxX) <= Math.sqrt(QUAD_RADIUS ** 2 - 0.325 ** 2) * scale;
      body.poundCompact = poundRadius2 <= (POUND_RADIUS * scale) ** 2
        && Math.max(-body.minX, body.maxX) <= Math.sqrt(POUND_RADIUS ** 2 - 0.4 ** 2) * scale;
      body.standCompact = standRadius2 <= (STAND_RADIUS * scale) ** 2;
      body.parkCompact = parkRadius2 <= (PARK_RADIUS * scale) ** 2;
      body.sitCompact = state.lounge === "sit" && sitRadius2 <= (SIT_RADIUS * scale) ** 2
        && sitWidth <= Math.sqrt(SIT_RADIUS ** 2 - 0.335 ** 2) * scale;
      body.labCompact = state.lab && labRadius2 <= (LAB_RADIUS * scale) ** 2
        && Math.max(-body.minX, body.maxX) <= Math.sqrt(LAB_RADIUS ** 2 - 0.4 ** 2) * scale;
      body.labIdleCompact = state.lab && !state.labWork && state.speed <= 0.1
        && labBodyRadius2 <= (LAB_IDLE_RADIUS * scale) ** 2 && labBodyMaxY - labBodyMinY <= LAB_HEIGHT * scale;
      body.labWalkCompact = state.lab && !state.labWork
        && labBodyRadius2 <= (LAB_WALK_RADIUS * scale) ** 2 && labBodyMaxY - labBodyMinY <= LAB_HEIGHT * scale;
      body.labSqueezeCompact = state.lab && state.labSqueeze && !state.labWork && labFlask === labPlaceholder
        && radius2 <= (LAB_SQUEEZE_RADIUS * scale) ** 2 && body.height <= LAB_HEIGHT * scale;
    };
    const envelope = (out) => {
      out.minX = body.minX; out.maxX = body.maxX;
      out.minY = body.minY; out.maxY = body.maxY;
      out.minZ = body.minZ; out.maxZ = body.maxZ;
      out.radius = body.radius; out.height = body.height;
      return out;
    };
    // Managed motion adds climb (0..1 wall grip), signed climbStride in metres,
    // climbDirection/climbSide describe vertical/lateral travel on the wall.
    // Seated grooming uses groom (0..1), groomSide (-1 left/+1 right), and an
    // optional groomPhase in seconds. All transitions reuse the existing rig.
    const poseManaged = (dt, px, py, pz, facing, speed, airborne = false, biped = false, lounge = "", motion = null) => {
      root.position.x = px; root.position.y = py; root.position.z = pz;
      state.heading = facing;
      state.backwards = speed < 0;
      state.speed = Math.abs(speed);
      state.air = airborne;
      // A repository handoff interrupts the optional chest beat; the limbs
      // still ease back into their walking pose before their next safe step.
      if (motion && motion.workExit) state.beat = 0;
      // A stopped walker can lead with either hand. Apply an admitted starting
      // phase once; a swept preview may pose several intermediate substeps.
      const walkPhase = motion ? motion.walkPhase : NaN;
      if (Number.isFinite(walkPhase) && state.walkPhase !== walkPhase) state.phase = walkPhase;
      state.walkPhase = walkPhase;
      const lab = !!(motion && motion.lab && !motion.rage);
      let coatSplit = false;
      if (coatClip) {
        const dx = px - coatClip.mouth.x, dz = pz - coatClip.mouth.z;
        const along = dx * coatClip.sr + dz * coatClip.cr - 0.5;
        const across = dx * coatClip.cr - dz * coatClip.sr;
        coatSplit = !(motion && (motion.rage || motion.climb > 0 || motion.openingSettle > 0))
          && Math.abs(along) < coatClip.reach && Math.abs(across) < 2.5
          && py > coatClip.mouth.floorY - 0.5 && py < coatClip.mouth.floorY + 1.5;
      }
      const labChanged = state.lab !== lab, coatChanged = state.coatSplit !== coatSplit;
      if (labChanged || coatChanged) {
        state.lab = lab; state.coatSplit = coatSplit;
        setForm(state.form, true);
      }
      state.labRunIn = !!(motion && motion.labRunIn);
      // Changing clothes does not reset the body's pose. Its ordinary chest
      // and limb easing carries the walking rig into and out of the lab stance.
      state.labWork = motion && (motion.labWork === "type" || motion.labWork === "touch" || motion.labWork === "carry" || motion.labWork === "roll") ? motion.labWork : "";
      state.labPhase = motion && Number.isFinite(motion.labPhase) ? motion.labPhase : state.labPhase + dt;
      state.labSide = motion && motion.labSide < 0 ? -1 : 1;
      // A short die is picked up much lower than a tall flask. Ease the reach
      // target too, so the first inspection step lifts it off the table instead
      // of immediately pulling the hand towards the high inspection pose.
      state.labReach = damp(state.labReach, motion ? clamp(motion.labReach || 0, 0, 1) : 0, 12, dt);
      state.labReachGrip = motion && Number.isFinite(motion.labGripY) ? motion.labGripY : labGripY;
      if (motion && motion.lab && motion.labWork === "carry") state.labBench = motion.labBench || null;
      state.labSqueeze = !!(motion && motion.labSqueeze);
      state.labDie = !!(motion && motion.labDie);
      state.labRoll = state.labDie && motion ? clamp(motion.labRoll || 0, 0, 1) : 0;
      state.biped = lab && !state.labRunIn || biped;
      state.poundCharge = motion ? clamp(motion.poundCharge || 0, 0, 1) : 0;
      state.takeoff = motion ? clamp(motion.takeoff || 0, 0, 1) : 0;
      state.landing = motion ? clamp(motion.landing || 0, 0, 1) : 0;
      state.roll = motion ? clamp(motion.roll || 0, 0, 1) : 0;
      state.rollTarget = motion && Number.isFinite(motion.rollAngle) ? motion.rollAngle : 0;
      state.rollSide = motion ? motion.rollSide || 0 : 0;
      state.climb = motion && !airborne && !state.roll
        ? clamp(Math.max(motion.climb || 0, motion.openingSettle || 0), 0, 1) : 0;
      state.climbPose = motion && Number.isFinite(motion.climbBlend)
        ? clamp(motion.climbBlend, 0, 1) : state.climb || NaN;
      state.climbStride = motion ? motion.climbStride || 0 : 0;
      state.climbDirection = motion ? clamp(motion.climbDirection || 0, -1, 1) : 0;
      state.climbSide = motion ? clamp(motion.climbSide || 0, -1, 1) : 0;
      state.climbGripX = motion && Number.isFinite(motion.climbGripX) ? motion.climbGripX : NaN;
      state.climbGripY = motion && Number.isFinite(motion.climbGripY) ? motion.climbGripY : NaN;
      state.climbGripZ = motion && Number.isFinite(motion.climbGripZ) ? motion.climbGripZ : NaN;
      state.climbGripRelease = motion && Number.isFinite(state.climbGripX) ? motion.climbGripRelease & 3 : 0;
      if (Number.isFinite(state.climbGripX) && Number.isFinite(motion.climbGripStride)) {
        // A stationary release prepares the whole upcoming grip phase. Using
        // the previous stride here leaves the shoulders/feet out of sync with
        // the next translation even after the arms have finished settling.
        state.climbStride = motion.climbGripStride;
        state.climbDirection = motion.climbGripDirection;
        state.climbSide = motion.climbGripSide;
      }
      state.groom = motion && lounge === "sit" && state.speed <= 0.1 && !airborne && !state.roll && !state.climb ? clamp(motion.groom || 0, 0, 1) : 0;
      state.sitLook = motion && lounge === "sit" ? clamp(motion.sitLook || 0, -1, 1) : 0;
      state.sitShift = motion && lounge === "sit" ? clamp(motion.sitShift || 0, -1, 1) : 0;
      const groomSide = motion && motion.groomSide < 0 ? -1 : 1;
      if (groomSide !== state.groomSide) {
        // A neighbour changing sides first releases the old hand. Switching the
        // side while its blend was high transferred the reach to the other arm.
        const arm = state.groomSide < 0 ? parts.armR : parts.armL;
        const restRoll = lounge === "sit" ? -state.groomSide * 0.12 : 0;
        if (state.groomBlend > 0.005 || Math.abs(arm.rotation.y) > 0.01 || Math.abs(arm.rotation.z - restRoll) > 0.01) state.groom = 0;
        else state.groomSide = groomSide;
      }
      if (motion && Number.isFinite(motion.groomPhase)) state.groomTime = motion.groomPhase;
      state.smash = !!(motion && motion.smash && !state.roll);
      state.dragging = !!(motion && motion.dragging);
      state.throwProgress = state.dragging ? clamp(motion.throwProgress || 0, 0, 1) : 0;
      if (state.dragging) { state.labWork = ""; state.pound = state.beat = 0; }
      state.lounge = !airborne && state.speed <= 0.1 && (lounge === "sit" || lounge === "back" || lounge === "left" || lounge === "right"
        || lounge === "lean-left" || lounge === "lean-right" || lounge === "lean-back") ? lounge : "";
      if (state.dragging) state.lounge = "";
      if (state.roll > 0 || airborne || state.climb > 0) state.lounge = "";
      if (state.lounge || state.roll > 0 || airborne && !state.smash || state.climb > 0) state.pound = state.beat = state.chewing = 0;
      if (state.speed > 0.1 || airborne) state.beat = 0;
      // Swimming is the hub's word (`motion.swim`, afloat in the Mempool island's water), and gives way to every pose of its own.
      state.swim = motion && motion.swim && !airborne && !lounge && !state.climb && !state.roll && !lab && !biped && !state.dragging && !state.poundCharge && !state.pound && !state.beat ? 1 : 0;
      state.groundPlane = !!(groundPlaneAt && !airborne && !lab && !lounge && !state.climb && !state.roll
        && !state.beat && !state.pound && groundPlaneAt(px, py, pz, facing, state, motion));
      state.gait = state.beat > 0 ? "beat" : state.biped ? "upright" : state.speed <= 0.01 ? "idle"
        : motion && motion.walkGait ? motion.walkGait : state.speed > 1.7 ? "gallop" : "knuckle";
      pose(Math.max(0, dt));
      measureBody();
      // Fit contacts after the visible support offset too: applying that
      // offset afterward can lower a previously clear foot into a tread.
      if (motion && Number.isFinite(motion.supportOffset)) hips.position.y += motion.supportOffset / scale;
      // A tiny positive mount blend still uses the walking pose. Keep its
      // contact fitting until the climbing arm fitter activates above 0.001.
      const fitWalking = climbSolidAt && state.climbBlend <= 0.001 && !state.lab && !airborne && !state.lounge
        && !state.roll && !state.beat && !state.pound;
      if (state.climbFitArms) {
        fitClimbHands(Math.max(0, dt)); fitClimbBody();
      } else if (fitWalking) fitWalkHands();
      if (state.climbFitArms || fitWalking) measureBody(false);
    };
    const pointToWorld = (matrix, x, y, z, out) => {
      const px = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) * scale;
      const py = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) * scale;
      const pz = (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) * scale;
      const sine = Math.sin(root.rotation.y), cosine = Math.cos(root.rotation.y);
      out.x = root.position.x + cosine * px + sine * pz;
      out.y = root.position.y + py;
      out.z = root.position.z - sine * px + cosine * pz;
      return out;
    };
    // A palm can grip the side of a projecting ledge too. Test the real arm
    // mesh and a short surface witness beside its pad, without moving the
    // shoulder or treating a point inside the stone as valid contact.
    const climbArmContact = (arm, side, preparing, dx, dy, dz, reach = 0.16) => {
      const vertices = climbVertices(arm.geometry, true), b = envelopeBounds[side + 3];
      const palmY = b.min[1] + (b.max[1] - b.min[1]) * (2 / 14);
      const m = partMatrix(arm), sine = Math.sin(root.rotation.y), cosine = Math.cos(root.rotation.y);
      let contact = false;
      for (let v = 0; v < vertices.length; v += 3) {
        const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2];
        const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
        const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
        const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
        const wx = root.position.x + cosine * px + sine * pz, wy = root.position.y + py, wz = root.position.z - sine * px + cosine * pz;
        if (climbSolidAt(wx, wy, wz) || preparing && climbSolidAt(wx + dx, wy + dy, wz + dz)) return -1;
        if (y <= palmY) for (let distance = 0.16; !contact && distance <= reach + 1e-6; distance += 0.08) {
          contact = climbSolidAt(wx + distance, wy, wz) || climbSolidAt(wx - distance, wy, wz)
            || climbSolidAt(wx, wy + distance, wz) || climbSolidAt(wx, wy - distance, wz)
            || climbSolidAt(wx, wy, wz + distance) || climbSolidAt(wx, wy, wz - distance);
        }
      }
      return contact ? 1 : 0;
    };
    const climbPartClear = (part) => {
      const vertices = climbVertices(part.geometry, true), m = partMatrix(part);
      const sine = Math.sin(root.rotation.y), cosine = Math.cos(root.rotation.y);
      for (let v = 0; v < vertices.length; v += 3) {
        const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2];
        const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
        const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
        const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
        if (climbSolidAt(root.position.x + cosine * px + sine * pz,
          root.position.y + py, root.position.z - sine * px + cosine * pz)) return false;
      }
      return true;
    };
    const fitClimbBody = () => {
      // A projecting roof tread can meet the chest before its hands leave the rim.
      // Retract the torso independently, as the head and feet already do, without moving the grip or root.
      // The bound matches the head and leg fitters: past 0.3 m the tread keeps
      // the intersection rather than moving the grip or root.
      for (let step = 0; step < 15 && !climbPartClear(parts.torso); step++) parts.torso.position.z -= 0.02;
      for (let side = 0; side < 2; side++) {
        const leg = side ? parts.legL : parts.legR;
        const angle = leg.rotation.x;
        for (let step = 0; step < 15 && leg.rotation.x < 1.12 && !climbPartClear(leg); step++) {
          // Fold the foot away from a projecting rock at the hip. Translating
          // the whole leg here accumulates against pose()'s damping on every
          // frame and eventually pulls its top clear of the pelvis.
          leg.rotation.x = Math.min(1.12, angle + (step + 1) * 0.08);
        }
      }
      for (let step = 0; step < 15; step++) {
        updateLocal(parts.head); mat4.multiply(envelopeHead, envelopeChest, parts.head.local);
        if (climbPartClear(parts.head) && climbPartClear(parts.jaw)) break;
        parts.head.position.z -= 0.02;
      }
    };
    const fitWalkArm = (arm, side) => {
      const angle = arm.rotation.x;
      if (climbArmContact(arm, side, false, 0, 0, 0) >= 0) return;
      let clear = false;
      for (let step = 1; step <= 20; step++) {
        arm.rotation.x = angle - step * 0.05;
        if (climbArmContact(arm, side, false, 0, 0, 0) >= 0) { clear = true; break; }
      }
      if (!clear) arm.rotation.x = angle;
    };
    const fitWalkHands = () => {
      updateLocal(hips); updateLocal(chest);
      mat4.multiply(envelopeChest, hips.local, chest.local);
      for (let side = 0; side < 2; side++) {
        const leg = side ? parts.legL : parts.legR;
        const y = leg.position.y;
        for (let step = 0; step < 15 && !climbPartClear(leg); step++) leg.position.y += 0.02;
        if (side) state.walkLegLiftL = leg.position.y - y;
        else state.walkLegLiftR = leg.position.y - y;
      }
      for (let side = 0; side < 2; side++) {
        if (state.dragging && side === 1) continue;
        fitWalkArm(side ? parts.armL : parts.armR, side);
      }
    };
    // A high grip can reach over a stepped rim into empty air. Lower each arm
    // towards the stone independently, stopping before any of its mesh enters
    // rock. Live poses and route previews share this bounded search and easing.
    const fitClimbHands = (dt) => {
      updateLocal(hips); updateLocal(chest);
      mat4.multiply(envelopeChest, hips.local, chest.local);
      const sine = Math.sin(root.rotation.y), cosine = Math.cos(root.rotation.y), blend = state.climbBlend;
      const preparing = Number.isFinite(state.climbGripX);
      const dx = state.climbGripX - root.position.x, dy = state.climbGripY - root.position.y, dz = state.climbGripZ - root.position.z;
      for (let side = 0; side < 2; side++) {
        if (!(state.climbFitArms & 1 << side)) continue;
        const arm = side ? parts.armL : parts.armR, previous = arm.rotation.x, previousYaw = arm.rotation.y;
        const base = side ? state.climbArmBaseL : state.climbArmBaseR;
        const raised = -3.2;
        const vertices = climbVertices(arm.geometry, true);
        let safe = raised, unsafe = raised, found = false;
        for (let attempt = 0; attempt < 14; attempt++) {
          const refining = unsafe > safe, angle = refining ? (safe + unsafe) * 0.5 : Math.min(-1.9, raised + attempt * 0.1);
          arm.rotation.x = base + (angle - base) * blend;
          const m = partMatrix(arm);
          let clear = true;
          for (let v = 0; v < vertices.length; v += 3) {
            const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2];
            const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
            const py = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
            const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
            const wx = root.position.x + cosine * px + sine * pz, wy = root.position.y + py, wz = root.position.z - sine * px + cosine * pz;
            // Before a blocked step, release the current ledge far enough for
            // that translation too. The stationary handoff must still fit here.
            if (climbSolidAt(wx, wy, wz) || preparing && climbSolidAt(wx + dx, wy + dy, wz + dz)) { clear = false; break; }
          }
          if (clear) { safe = angle; found = true; }
          else if (!found) break;
          else unsafe = angle;
          // Keep the first higher palm grip instead of lowering both arms to
          // the last clear angle. The ordinary search remains the fallback.
          if (clear && blend > 0.9 && !(state.climbGripRelease & 1 << side)
            && (attempt === 0 || attempt === 4 || attempt === 7)
            && climbArmContact(arm, side, preparing, dx, dy, dz) === 1) break;
          if (clear && (angle === -1.9 || state.climbGripRelease & 1 << side) || unsafe > safe && unsafe - safe < 0.0125) break;
        }
        const pitch = found ? base + (safe - base) * blend : previous;
        arm.rotation.x = pitch;
        // Keep the wall grip's shoulder turn while the hand follows the
        // rectangle onto the floor, then release it continuously.
        let yaw = found ? previousYaw * clamp((blend - 0.7) / 0.3, 0, 1) : previousYaw;
        if (blend > 0.98 && !(state.climbGripRelease & 1 << side)) {
          arm.rotation.y = 0;
          if (climbArmContact(arm, side, preparing, dx, dy, dz) === 1) yaw = 0;
          else {
            arm.rotation.y = previousYaw;
            if (climbArmContact(arm, side, preparing, dx, dy, dz) !== 1) {
              let held = false;
              for (let direction = 0; direction < 2 && !held; direction++) {
                const sign = (side ? -1 : 1) * (direction ? -1 : 1);
                let clearYaw = 0;
                for (let step = 1; step <= 3; step++) {
                  const candidate = sign * step * 0.25 * blend;
                  arm.rotation.y = candidate;
                  const contact = climbArmContact(arm, side, preparing, dx, dy, dz);
                  if (contact === 1) { yaw = candidate; held = true; break; }
                  if (contact === 0) { clearYaw = candidate; continue; }
                  let blockedYaw = candidate;
                  for (let refine = 0; refine < 4; refine++) {
                    arm.rotation.y = (clearYaw + blockedYaw) * 0.5;
                    const near = climbArmContact(arm, side, preparing, dx, dy, dz);
                    if (near < 0) blockedYaw = arm.rotation.y;
                    else { clearYaw = arm.rotation.y; if (near === 1) { yaw = clearYaw; held = true; } }
                  }
                  break;
                }
              }
            }
          }
        }
        // A stepped face can put the hold below the first clear pitch.
        // Search pitch and shoulder turn together before declaring grip loss;
        // every candidate still checks the complete arm against the stone.
        if (blend > 0.98 && !(state.climbGripRelease & 1 << side)) {
          arm.rotation.x = pitch; arm.rotation.y = yaw;
          if (climbArmContact(arm, side, preparing, dx, dy, dz, 0.4) !== 1) {
            let held = false;
            for (let turn = 0; turn < 7 && !held; turn++) {
              const candidateYaw = turn === 0 ? 0 : (side ? -1 : 1) * (turn & 1 ? 1 : -1) * Math.ceil(turn / 2) * 0.25;
              arm.rotation.y = candidateYaw;
              for (let step = 0; step <= 64; step++) {
                arm.rotation.x = -3.2 + step * 0.05;
                if (climbArmContact(arm, side, preparing, dx, dy, dz, 0.4) === 1) {
                  yaw = candidateYaw; held = true; break;
                }
              }
            }
            if (held) { arm.rotation.y = yaw; continue; }
          }
        }
        // Once the torso is hanging from the wall, the palm must reach its
        // checked hold in this frame. Easing the last few degrees leaves a
        // visible gap while the root continues climbing.
        arm.rotation.x = blend > 0.98 ? pitch : damp(previous, pitch, 18, dt);
        arm.rotation.y = blend > 0.98 ? yaw : damp(previousYaw, yaw, 18, dt);
        // A clear target does not prove the eased pose clear at this root.
        // Keep the exact checked pitch/yaw if the interpolation meets a tread.
        if (!climbPartClear(arm)) {
          if (found) { arm.rotation.x = pitch; arm.rotation.y = previousYaw; }
          else fitWalkArm(arm, side);
        }
      }
    };
    const climbHandContactMask = () => !climbSolidAt ? 0
      : (climbArmContact(parts.armR, 0, false, 0, 0, 0, 0.4) === 1 ? 1 : 0)
        | (climbArmContact(parts.armL, 1, false, 0, 0, 0, 0.4) === 1 ? 2 : 0);
    // These matrices come from the current pose, including the floor adjustment
    // and reclining hips, so projectiles never chase the previous render frame.
    const previewNodes = managed ? [root, hips, ...envelopeParts, chest, ...(coatParts ? [coatParts.torso, coatParts.armR, coatParts.armL] : [])] : null;
    const previewTransforms = managed ? new Float64Array(previewNodes.length * 10) : null;
    const previewQuaternions = managed ? new Array(previewNodes.length) : null;
    const previewGeometries = managed ? new Array(previewNodes.length) : null;
    const previewVisible = managed ? new Uint8Array(previewNodes.length) : null;
    const previewKeys = managed ? Object.keys(state) : null;
    const previewState = managed ? new Array(previewKeys.length) : null;
    const previewVertices = managed ? envelopeParts.map(part => climbVertices(part.geometry)) : null;
    if (managed) refreshGeometry = () => {
      for (let i = 0; i < envelopeParts.length; i++) {
        envelopeBounds[i] = boundsOf(envelopeParts[i].geometry);
        previewVertices[i] = climbVertices(envelopeParts[i].geometry);
      }
      supportRows.fill(NaN);
    };
    // The bench and the hand share one vessel node. Swapping this fixed eighth
    // part keeps the held glass in the same exact body and collision previews.
    const holdLabItem = (node) => {
      if (!managed || !node || !node.geometry || labFlask !== labPlaceholder) return false;
      if (node.parent) removeChild(node.parent, node);
      removeChild(parts.armL, labPlaceholder);
      labFlask = node; envelopeParts[7] = previewNodes[9] = node;
      const bounds = boundsOf(node.geometry);
      labGripY = Number.isFinite(node.geometry.labGripY) ? node.geometry.labGripY : bounds.max[1] * 0.85;
      node.scale.x = node.scale.y = node.scale.z = 1 / scale;
      node.quaternion = labItemRotation; node.visible = true;
      addChild(parts.armL, node); positionLabItem(); refreshGeometry(); measureBody();
      return true;
    };
    const releaseLabItem = () => {
      if (!managed || labFlask === labPlaceholder) return null;
      const node = labFlask;
      removeChild(parts.armL, node); node.quaternion = null;
      labFlask = labPlaceholder; envelopeParts[7] = previewNodes[9] = labPlaceholder;
      labGripY = geos.labFlask.labGripY;
      addChild(parts.armL, labPlaceholder); refreshGeometry(); measureBody();
      return node;
    };
    let climbBlockedArm = 0, climbContactMask = 0;
    const previewFrom = managed ? new Float64Array(envelopeParts.length * 80) : null;
    const previewTo = managed ? new Float64Array(envelopeParts.length * 80) : null;
    const previewMatrices = managed ? new Float64Array(envelopeParts.length * 16) : null;
    const previewHullFrom = managed ? new Float64Array(envelopeParts.length * 24) : null;
    const previewHullTo = managed ? new Float64Array(envelopeParts.length * 24) : null;
    const previewHull = managed ? new Float64Array(48) : null;
    const previewHulls = (out, inset = true) => {
      const sine = Math.sin(root.rotation.y), cosine = Math.cos(root.rotation.y), p = root.position;
      for (let i = 0; i < envelopeParts.length; i++) {
        if (!envelopeParts[i].visible) continue;
        const m = partMatrix(envelopeParts[i]), b = envelopeBounds[i];
        for (let corner = 0; corner < 8; corner++) {
          // Match climbVertices' existing contact inset, including flat
          // floor contacts represented with Float32 transform matrices.
          const shrink = inset ? 0.995 : 1, center = inset ? 0.0025 : 0;
          const x = b[corner & 1 ? "max" : "min"][0] * shrink + (b.min[0] + b.max[0]) * center;
          const y = b[corner & 2 ? "max" : "min"][1] * shrink + (b.min[1] + b.max[1]) * center;
          const z = b[corner & 4 ? "max" : "min"][2] * shrink + (b.min[2] + b.max[2]) * center;
          const lx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
          const ly = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
          const lz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
          const at = i * 24 + corner * 3;
          out[at] = p.x + cosine * lx + sine * lz; out[at + 1] = p.y + ly;
          out[at + 2] = p.z - sine * lx + cosine * lz;
        }
      }
    };
    const previewCorners = managed ? new Float64Array(24) : null;
    const previewEnvelope = managed ? new Float64Array(10) : null;
    const enclosePreviewPart = (bounds, part, at) => {
      const start = part * 80;
      let x = 0, z = 0, minY = Infinity, maxY = -Infinity;
      for (let i = start; i < start + 80; i += 5) {
        x += bounds[i]; z += bounds[i + 2];
        minY = Math.min(minY, bounds[i + 1]); maxY = Math.max(maxY, bounds[i + 1] + bounds[i + 4]);
      }
      x /= 16; z /= 16;
      let radius = 0;
      for (let i = start; i < start + 80; i += 5) radius = Math.max(radius,
        Math.hypot(bounds[i] - x, bounds[i + 2] - z) + bounds[i + 3]);
      previewEnvelope[at] = x; previewEnvelope[at + 1] = minY - 1e-7; previewEnvelope[at + 2] = z;
      previewEnvelope[at + 3] = radius + 1e-7; previewEnvelope[at + 4] = maxY - minY + 2e-7;
    };
    const previewBounds = (out, lab = false) => {
      const sine = Math.sin(root.rotation.y), cosine = Math.cos(root.rotation.y), p = root.position;
      for (let i = 0; i < envelopeParts.length; i++) {
        const part = envelopeParts[i], b = envelopeBounds[i];
        if (!part.visible) continue;
        const m = partMatrix(part);
        for (let k = 0; k < 16; k++) previewMatrices[i * 16 + k] = m[k];
        let minY = Infinity, maxY = -Infinity;
        for (let corner = 0; corner < 8; corner++) {
          const x = b[corner & 1 ? "max" : "min"][0], y = b[corner & 2 ? "max" : "min"][1], z = b[corner & 4 ? "max" : "min"][2];
          const lx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
          const ly = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
          const lz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
          const at = corner * 3;
          previewCorners[at] = lx;
          previewCorners[at + 1] = p.y + ly; previewCorners[at + 2] = lz;
          minY = Math.min(minY, previewCorners[at + 1]); maxY = Math.max(maxY, previewCorners[at + 1]);
        }
        // A tilted arm's fingertips must not reserve their farthest extent all
        // the way down to its elbow. Slice the oriented box into short cylinders
        // in the actor's frame; world-axis bounds grow spuriously on diagonal yaws.
        for (let slice = 0; slice < 4; slice++) {
          const low = minY + (maxY - minY) * slice / 4, high = minY + (maxY - minY) * (slice + 1) / 4;
          let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
          for (let corner = 0; corner < 8; corner++) {
            const at = corner * 3, x = previewCorners[at], y = previewCorners[at + 1], z = previewCorners[at + 2];
            if (y >= low && y <= high) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
            for (let axis = 1; axis <= 4; axis *= 2) {
              if (corner & axis) continue;
              const to = (corner | axis) * 3, dy = previewCorners[to + 1] - y;
              if (Math.abs(dy) < 1e-9) continue;
              for (let edge = 0; edge < 2; edge++) {
                const k = ((edge ? high : low) - y) / dy;
                if (k < 0 || k > 1) continue;
                const px = x + (previewCorners[to] - x) * k, pz = z + (previewCorners[to + 2] - z) * k;
                minX = Math.min(minX, px); maxX = Math.max(maxX, px); minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
              }
            }
          }
          // Near a desktop, a single circle around the forearm's wide box would
          // extend its low elbow beyond the real fingertips. Four smaller cells
          // preserve the whole box while keeping that corner padding bounded.
          const divisions = lab ? 2 : 1, width = (maxX - minX) / divisions, depth = (maxZ - minZ) / divisions;
          for (let cell = 0; cell < divisions * divisions; cell++) {
            const at = ((i * 4 + slice) * 4 + cell) * 5;
            const cx = minX + ((cell % divisions) + 0.5) * width, cz = minZ + (Math.floor(cell / divisions) + 0.5) * depth;
            out[at] = p.x + cosine * cx + sine * cz; out[at + 1] = low;
            out[at + 2] = p.z - sine * cx + cosine * cz;
            out[at + 3] = Math.hypot(width, depth) * 0.5; out[at + 4] = high - low;
          }
        }
      }
    };
    // The optional starting rest pose proves a future seat can also be left.
    // Both temporary poses share the snapshot, leaving the live rig untouched.
    const climbPoseClear = (dt, px, py, pz, facing, motion, solidAt, clearAt = null, entry = null, speed = 0, staticPose = false, lounge = "", fromLounge = null, sequenceStep = 0, hullAt = null, fromWalk = null, supportAt = null, biped = false, airborne = false) => {
      climbBlockedArm = climbContactMask = 0;
      if (!managed || !solidAt) return true;
      const emptySolid = solidAt.emptySolid === true;
      for (let i = 0; i < previewKeys.length; i++) previewState[i] = state[previewKeys[i]];
      for (let i = 0; i < previewNodes.length; i++) {
        const n = previewNodes[i], at = i * 10, q = n.quaternion;
        previewTransforms[at] = n.position.x; previewTransforms[at + 1] = n.position.y; previewTransforms[at + 2] = n.position.z;
        previewTransforms[at + 3] = n.rotation.x; previewTransforms[at + 4] = n.rotation.y; previewTransforms[at + 5] = n.rotation.z;
        previewQuaternions[i] = q;
        previewGeometries[i] = n.geometry; previewVisible[i] = +n.visible;
        if (q) for (let j = 0; j < 4; j++) previewTransforms[at + 6 + j] = q[j];
      }
      const lab = !!(motion && motion.lab && !motion.rage);
      const flexibleClimb = !!(motion && motion.climb && !lab);
      const sceneHull = !!(clearAt && clearAt.needsHull && motion && motion.climb && !flexibleClimb);
      const hulls = !!hullAt || sceneHull;
      const passArms = lab && !motion.labWork && labFlask === labPlaceholder;
      if (fromLounge !== null) poseManaged(2, px, py, pz, facing, 0, false, false, fromLounge, motion);
      if (fromWalk && fromWalk.planning) poseManaged(2, fromWalk.x, fromWalk.y, fromWalk.z, fromWalk.heading, speed, false, false, "", motion);
      if (hulls) previewHulls(previewHullFrom, !sceneHull);
      let fromVisible = 0;
      if (!flexibleClimb && clearAt && (!staticPose || fromLounge !== null)) {
        for (let i = 0; i < envelopeParts.length; i++) if (envelopeParts[i].visible) fromVisible |= 1 << i;
        previewBounds(previewFrom, lab);
      }
      const targetX = px, targetY = py, targetZ = pz;
      const walkTurn = fromWalk ? Math.atan2(Math.sin(facing - fromWalk.heading), Math.cos(facing - fromWalk.heading)) : 0;
      const walkSteps = fromWalk ? Math.max(1, Math.ceil(Math.hypot(px - fromWalk.x, py - fromWalk.y, pz - fromWalk.z) / fromWalk.interval), Math.ceil(Math.abs(walkTurn) / (fromWalk.interval * 0.3125))) : 1;
      // Departure admission follows the same small steps as live animation.
      // Independent large-dt samples miss intermediate arm/support changes.
      let remaining = sequenceStep > 0 ? Math.min(dt, 1.2) : dt;
      const tick = fromWalk ? dt / walkSteps : sequenceStep > 0 ? Math.max(1 / 120, sequenceStep) : dt;
      let clear = true;
      do {
        const step = Math.min(tick, remaining); remaining -= step;
        if (fromWalk) {
          const t = dt ? 1 - remaining / dt : 1;
          px = fromWalk.x + (targetX - fromWalk.x) * t;
          py = fromWalk.y + (targetY - fromWalk.y) * t;
          pz = fromWalk.z + (targetZ - fromWalk.z) * t;
          facing = fromWalk.heading + walkTurn * t;
        }
        const sine = Math.sin(facing), cosine = Math.cos(facing);
        poseManaged(step, px, py, pz, facing, speed, airborne, biped, lounge, motion);
        if (!flexibleClimb) previewBounds(previewTo, lab);
        if (hulls) previewHulls(previewHullTo, !sceneHull);
        if (sequenceStep > 0 && clearAt && clearAt.beginPose) clearAt.beginPose(entry);
        // Wall travel is admitted by its centre sweep, the projected ground
        // rectangle and an actual hand grip. Limb and head voxels may overlap
        // jagged stone without rejecting an otherwise clear climb.
        if (flexibleClimb && (solidAt(px, py + 1.1, pz)
          || clearAt && !clearAt(entry, px, py + 0.85, pz, px, py + 0.85, pz,
            0.42, 0.5, true, false))) clear = false;
        for (let i = 0; i < envelopeParts.length && clear && !flexibleClimb; i++) {
          if (!envelopeParts[i].visible || passArms && (i === 3 || i === 4)) continue;
          const vertices = previewVertices[i], offset = i * 16, m = previewMatrices;
          const from = (fromVisible & (1 << i)) ? previewFrom : previewTo;
          if (hulls) for (let k = 0; k < 24; k++) {
            previewHull[k] = sceneHull && !(fromVisible & (1 << i)) ? previewHullTo[i * 24 + k] : previewHullFrom[i * 24 + k];
            previewHull[k + 24] = previewHullTo[i * 24 + k];
          }
          let enclosed = false;
          if (lab && clearAt) {
            // Most stationary parts are far from a desk or neighbour. One sweep
            // enclosing all sixteen small cylinders proves them clear together;
            // contact falls back to the original precise slices, without caching
            // either moving props or animated bodies. Terrain stays vertex-exact.
            enclosePreviewPart(from, i, 0); enclosePreviewPart(previewTo, i, 5);
            enclosed = clearAt(entry, previewEnvelope[0], previewEnvelope[1], previewEnvelope[2],
              previewEnvelope[5], previewEnvelope[6], previewEnvelope[7], previewEnvelope[3],
              previewEnvelope[4], true, false, previewEnvelope[8], previewEnvelope[9], true, envelopeParts[i]);
          }
          if (clearAt && !enclosed) for (let slice = 0; slice < 4 * (lab ? 4 : 1); slice++) {
            const at = lab ? (i * 16 + slice) * 5 : (i * 16 + slice * 4) * 5;
            if (!clearAt(entry, from[at], from[at + 1], from[at + 2],
              previewTo[at], previewTo[at + 1], previewTo[at + 2], from[at + 3],
              from[at + 4], true, false, previewTo[at + 3], previewTo[at + 4], true, lab ? envelopeParts[i] : null, sceneHull ? previewHull : null)) {
              climbBlockedArm = i === 3 ? 1 : i === 4 ? 2 : 0; clear = false; break;
            }
          }
          if (!clear) break;
          if (hullAt && !hullAt(previewHull)) { clear = false; break; }
          // A private peer-only sampler explicitly certifies every stone query
          // false. Pose bounds and the peer/hull predicates above still run.
          for (let v = 0; !emptySolid && v < vertices.length; v += 3) {
            const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2];
            const lx = (m[offset] * x + m[offset + 4] * y + m[offset + 8] * z + m[offset + 12]) * scale;
            const ly = (m[offset + 1] * x + m[offset + 5] * y + m[offset + 9] * z + m[offset + 13]) * scale;
            const lz = (m[offset + 2] * x + m[offset + 6] * y + m[offset + 10] * z + m[offset + 14]) * scale;
            if (solidAt(px + cosine * lx + sine * lz, py + ly, pz - sine * lx + cosine * lz)) {
              climbBlockedArm = i === 3 ? 1 : i === 4 ? 2 : 0; clear = false; break;
            }
          }
        }
        if (clear && remaining > 1e-8) {
          if (hulls) previewHullFrom.set(previewHullTo);
          if (clearAt && !flexibleClimb) {
            previewFrom.set(previewTo); fromVisible = 0;
            for (let i = 0; i < envelopeParts.length; i++) if (envelopeParts[i].visible) fromVisible |= 1 << i;
          }
        }
      } while (clear && remaining > 1e-8);
      if (clear && supportAt) {
        const sine = Math.sin(facing), cosine = Math.cos(facing);
        let rear = Infinity, front = Infinity;
        for (let i = 0; i < (lab ? 2 : 5) && clear; i++) {
          if (i === 2) continue;
          const part = envelopeParts[i], b = envelopeBounds[i], vertices = previewVertices[i];
          const limit = b.min[1] + (b.max[1] - b.min[1]) * (i < 2 ? 0.25 : 2 / 14);
          const m = partMatrix(part);
          let gap = Infinity;
          for (let v = 0; v < vertices.length; v += 3) {
            if (vertices[v + 1] > limit) continue;
            const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2];
            const lx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * scale;
            const ly = (m[1] * x + m[5] * y + m[9] * z + m[13]) * scale;
            const lz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * scale;
            const floor = supportAt(px + cosine * lx + sine * lz, pz - sine * lx + cosine * lz, py + ly);
            gap = Math.min(gap, py + ly - floor);
          }
          if (gap < -0.08 || lab && gap > 0.2) clear = false;
          if (i < 2) rear = Math.min(rear, gap); else front = Math.min(front, gap);
        }
        // A resting quadruped needs one planted pad at each end. Upright
        // scientists stand on both feet; a hand on a desk is not footing.
        if (rear > 0.2 || !lab && front > 0.2) clear = false;
      }
      // The low handoff can leave the wall sampler's fixed root-height bands
      // while an actual palm still holds the masonry. Released-arm previews
      // and proposed smooth wall guides pay for this bounded witness. The
      // controller separately checks moving and settled handoff previews;
      // a guide must keep both hands within reach of the visible stone.
      if (clear && (state.climbGripRelease || motion && motion.verifyGrip) && climbSolidAt) for (let side = 0; side < 2; side++) {
        if (!(state.climbGripRelease & 1 << side)
          && climbArmContact(side ? parts.armL : parts.armR, side, false, 0, 0, 0, 0.4) === 1) climbContactMask |= 1 << side;
      }
      for (let i = 0; i < previewKeys.length; i++) state[previewKeys[i]] = previewState[i];
      for (let i = 0; i < previewNodes.length; i++) {
        const n = previewNodes[i], at = i * 10, q = previewQuaternions[i];
        n.position.x = previewTransforms[at]; n.position.y = previewTransforms[at + 1]; n.position.z = previewTransforms[at + 2];
        n.rotation.x = previewTransforms[at + 3]; n.rotation.y = previewTransforms[at + 4]; n.rotation.z = previewTransforms[at + 5];
        n.quaternion = q;
        n.geometry = previewGeometries[i]; n.visible = !!previewVisible[i];
        if (q) for (let j = 0; j < 4; j++) q[j] = previewTransforms[at + 6 + j];
        updateLocal(n);
      }
      // The saved rig already includes its support and contact corrections.
      // Refit only the bounds; fitting support again changes a rejected pose.
      refreshGeometry(); measureBody(false);
      return clear;
    };
    const walkPreviewStart = { x: 0, y: 0, z: 0, heading: 0, planning: false, interval: 0.08 };
    const walkSupportAt = (x, z, y, heading, step, props, supportAt) => {
      const sine = Math.sin(heading), cosine = Math.cos(heading);
      let floor = -Infinity;
      // Support belongs to the pads, not the empty corners enclosed by the
      // walking cylinders. The complete posed hull still proves the resulting
      // lower body placement before a controller commits any movement.
      for (let i = 0; i < 5; i++) {
        if (i === 2) continue;
        const part = envelopeParts[i], b = envelopeBounds[i], vertices = previewVertices[i];
        const limit = b.min[1] + (b.max[1] - b.min[1]) * (i < 2 ? 0.25 : 2 / 14);
        const m = partMatrix(part);
        for (let v = 0; v < vertices.length; v += 3) {
          if (vertices[v + 1] > limit) continue;
          const px = vertices[v], py = vertices[v + 1], pz = vertices[v + 2];
          const lx = (m[0] * px + m[4] * py + m[8] * pz + m[12]) * scale;
          const lz = (m[2] * px + m[6] * py + m[10] * pz + m[14]) * scale;
          const support = supportAt(x + cosine * lx + sine * lz,
            z - sine * lx + cosine * lz, y, step, props);
          floor = Math.max(floor, support);
        }
      }
      // A moving hand can clear a tread before its resting knuckle does.
      // Reserve that eventual stopping stance too, so easing a blocked step
      // cannot lower the arm back through the stone behind it.
      for (let i = 0; i < walkPadPoints.length; i += 2) {
        const px = walkPadPoints[i] * scale, pz = walkPadPoints[i + 1] * scale;
        const support = supportAt(x + cosine * px + sine * pz,
          z - sine * px + cosine * pz, y, step, props);
        floor = Math.max(floor, support);
      }
      // Mixed-height pads still supply real support. A surrounding circle's
      // taller ledge cannot replace those samples: no part of the rig may be
      // standing on it. Every lower placement keeps the complete moving and
      // stopping pose checks before the controller can commit it.
      return Math.abs(floor - y) < 0.01 ? y : floor;
    };
    const walkPoseClear = (x, y, z, nx, ny, nz, heading, nextHeading, motion, solidAt, clearAt, hullAt, entry, dt, speed, planning = false, supportAt = null) => {
      walkPreviewStart.x = x; walkPreviewStart.y = y; walkPreviewStart.z = z;
      walkPreviewStart.heading = heading; walkPreviewStart.planning = planning;
      walkPreviewStart.interval = 0.08;
      if (climbPoseClear(dt, nx, ny, nz, nextHeading, motion, solidAt, clearAt, entry, speed, false, "", null, 0, hullAt, walkPreviewStart, supportAt)) return true;
      // A long chord between clear pads may cross a curved ramp. Subdivide
      // that same posed motion further before declaring the route blocked.
      walkPreviewStart.interval = 0.02;
      return climbPoseClear(dt, nx, ny, nz, nextHeading, motion, solidAt, clearAt, entry, speed, false, "", null, 0, hullAt, walkPreviewStart, supportAt);
    };
    const labPreviewMotion = { lab: true, labRunIn: false, labWork: "", labPhase: 0, labSide: 1, labReach: 0, labGripY: geos.labFlask.labGripY, labSqueeze: false, labDie: false, labRoll: 0, labBench: null };
    const labPoseClear = (dt, x, y, z, heading, speed, work, phase, side, solidAt, clearAt, entry, staticPose = false, laboratory = true) => {
      labPreviewMotion.lab = laboratory;
      labPreviewMotion.labRunIn = !!(laboratory && entry && !entry.planningLab && entry.motion.labRunIn);
      labPreviewMotion.labWork = laboratory ? work : ""; labPreviewMotion.labPhase = phase; labPreviewMotion.labSide = side;
      labPreviewMotion.labReach = laboratory && entry ? entry.motion.labReach || 0 : 0;
      labPreviewMotion.labGripY = laboratory && entry && Number.isFinite(entry.motion.labGripY) ? entry.motion.labGripY : labGripY;
      labPreviewMotion.labSqueeze = !!(laboratory && entry && entry.motion.labSqueeze);
      labPreviewMotion.labDie = !!(laboratory && entry && entry.motion.labDie);
      labPreviewMotion.labRoll = laboratory && entry ? entry.motion.labRoll || 0 : 0;
      labPreviewMotion.labBench = laboratory && entry ? entry.motion.labBench || null : null;
      const pound = state.pound, beat = state.beat;
      if (staticPose) state.pound = state.beat = 0;
      const itemPreview = managed && staticPose && laboratory && work === "carry" && labFlask === labPlaceholder;
      const itemGeometry = itemPreview ? labPlaceholder.geometry : null, itemGrip = labGripY;
      if (itemPreview) {
        // Prove the vessel being fetched, rather than a tall default flask
        // around a shorter beaker or die's grip.
        if (entry?.motion.labItemGeometry) labPlaceholder.geometry = entry.motion.labItemGeometry;
        if (Number.isFinite(entry?.motion.labGripY)) labGripY = entry.motion.labGripY;
        refreshGeometry();
        state.labPreviewItem = true; labPlaceholder.visible = true; labPlaceholder.quaternion = labItemRotation;
        labPlaceholder.scale.x = labPlaceholder.scale.y = labPlaceholder.scale.z = 1 / scale;
      }
      const clear = climbPoseClear(dt, x, y, z, heading, labPreviewMotion, solidAt, clearAt, entry, speed, staticPose);
      if (itemPreview) {
        state.labPreviewItem = false; labPlaceholder.visible = false;
        labPlaceholder.geometry = itemGeometry; labGripY = itemGrip;
        refreshGeometry(); measureBody();
      }
      state.pound = pound; state.beat = beat;
      return clear;
    };
    const mouth = (out) => {
      if (managed) return pointToWorld(envelopeHead, 0, 0.7 * U, 6.05 * U, out);
      const head = parts.head, hc = Math.cos(head.rotation.x), hs = Math.sin(head.rotation.x);
      const cy = Math.cos(chest.rotation.x), sy = Math.sin(chest.rotation.x);
      const hy = head.position.y + hc * 0.7 * U - hs * 6.05 * U;
      const hz = head.position.z + hs * 0.7 * U + hc * 6.05 * U;
      const y = (hips.position.y + cy * hy - sy * hz) * scale, z = (sy * hy + cy * hz) * scale;
      out.x = root.position.x + Math.sin(root.rotation.y) * z;
      out.y = root.position.y + y;
      out.z = root.position.z + Math.cos(root.rotation.y) * z;
      return out;
    };
    const targetParts = [2, 5, 3, 4, 0, 1];
    const bodyTarget = (out, sample = 0) => {
      if (!managed) { out.x = root.position.x; out.y = root.position.y + BODY * 0.5; out.z = root.position.z; return out; }
      const index = targetParts[Math.abs(sample | 0) % targetParts.length], part = envelopeParts[index], bounds = envelopeBounds[index];
      let matrix;
      if (part === chest) matrix = envelopeChest;
      else if (part === parts.head) matrix = envelopeHead;
      else {
        updateLocal(part);
        mat4.multiply(envelopePart, part.parent === hips ? hips.local : envelopeChest, part.local);
        matrix = envelopePart;
      }
      return pointToWorld(matrix, (bounds.min[0] + bounds.max[0]) * 0.5, (bounds.min[1] + bounds.max[1]) * 0.5,
        (bounds.min[2] + bounds.max[2]) * 0.5, out);
    };
    if (managed) {
      measureBody();
      if (!walkPadPoints) {
        const points = [];
        for (let i = 0; i < 5; i++) {
          if (i === 2) continue;
          const b = envelopeBounds[i], vertices = previewVertices[i], m = partMatrix(envelopeParts[i]);
          const limit = b.min[1] + (b.max[1] - b.min[1]) * (i < 2 ? 0.25 : 2 / 14);
          for (let v = 0; v < vertices.length; v += 3) if (vertices[v + 1] <= limit) {
            points.push(m[0] * vertices[v] + m[4] * vertices[v + 1] + m[8] * vertices[v + 2] + m[12],
              m[2] * vertices[v] + m[6] * vertices[v + 1] + m[10] * vertices[v + 2] + m[14]);
          }
        }
        walkPadPoints = new Float64Array(points);
      }
    }
    // Only the form on show: the other set is released, so no scene keeps another
    // scene's Agent geometry resident. A swap re-uploads six small voxel parts.
    const liveGeometry = (set) => {
      for (const name of PART_NAMES) set.add(parts[name].geometry);
      if (managed) set.add(parts.jaw.geometry);
      if (managed) set.add(labFlask.geometry);
    };
    const dispose = () => {
      if (root.parent) removeChild(root.parent, root);
      state.route = null;
      state.pace = null;
      onIdle = null;
    };
    const agent = {
      root, parts, hips, chest, update, setForm, setGait, walk, pace, place, poke, jump, reveal, setDriven, drive, toggleStyle, liveGeometry, dispose,
      managed, poseManaged, climbPoseClear, climbHandContactMask, walkPoseClear, walkSupportAt, labPoseClear, mouth, bodyTarget, envelope, feed, pound, beat, holdLabItem, releaseLabItem,
      get climbBlockedArm() { return climbBlockedArm; },
      get climbContactMask() { return climbContactMask; },
      get labFlask() { return labFlask; },
      get labItem() { return labFlask === labPlaceholder ? null : labFlask; },
      get labPickupBench() { return state.labBench; },
      get bodyRadius() { return body.radius; },
      get bodyHeight() { return body.maxY; },
      get bodyMinY() { return body.minY; },
      get compact() { return !!body.compact; },
      get poundCompact() { return !!body.poundCompact; },
      get standCompact() { return !!body.standCompact; },
      get parkCompact() { return !!body.parkCompact; },
      get sitCompact() { return !!body.sitCompact; },
      get labCompact() { return !!body.labCompact; },
      get labIdleCompact() { return !!body.labIdleCompact; },
      get labWalkCompact() { return !!body.labWalkCompact; },
      get labSqueezeCompact() { return !!body.labSqueezeCompact; },
      get torsoRadius() { return body.torsoRadius; },
      get torsoLabCompact() { return !!body.torsoLabCompact; },
      get torsoStandCompact() { return !!body.torsoStandCompact; },
      get torsoSitCompact() { return !!body.torsoSitCompact; },
      get torsoQuadCompact() { return !!body.torsoQuadCompact; },
      get pounding() { return state.pound > 0; },
      get beating() { return state.beat > 0; },
      get chewing() { return state.chewing > 0; },
      get motionActive() { return managed && (state.air || state.crouch > 0.001 || state.takeoff > 0 || state.rollBlend > 0.001 || Math.abs(state.rollAngle) > 0.001 || Math.abs(state.rollSide) > 0.001 || state.climb > 0 || state.climbBlend > 0.001); },
      get smashActive() { return managed && state.smash && state.pound > 0; },
      get revealed() { return state.revealFor > 0; },
      get airborne() { return state.air; },
      groundAt,
      get heading() { return state.heading; },
      get driven() { return state.driven; },
      get form() { return state.form; },
      set onIdle(fn) { onIdle = fn; },
      get walking() { return !!state.route; },
      debug: {
        get form() { return state.form; },
        get gait() { return state.gait; },
        get pitch() { return state.pitch; },
        get speed() { return state.speed; },
        get phase() { return state.phase; },
        get driven() { return state.driven; },
        get walkStyle() { return state.walkStyle; },
        get revealed() { return state.revealFor > 0; },
        get airborne() { return state.air; },
        get climbing() { return state.climbBlend; },
        get swimming() { return state.swimBlend; },
        get lounge() { return state.lounge; },
        get grooming() { return state.groomBlend; },
        get groomTime() { return state.groomTime; },
        get lab() { return state.lab; },
        get labWork() { return state.labWork; },
        jump,
        reveal,
        setGait,
        setForm,
        poke,
        place,
        pace,
        parts,
        root
      }
    };
    return agent;
  };
  // Right Shift+A in any scene, or a double-click on the Agent in the hub and the lab: the
  // director hands the active scene's Agent to the player until Escape, Right Shift+A or a
  // double-click on the ground, and it wanders off again. Key-downs are taken in the
  // capture phase, so the scene's own controls never see them meanwhile. A scene may
  // provide agentView (the pilot's orbit, so drag and scroll work as with an Ooga),
  // agentControls (its sticks) and agentHandoff (release a controlled Ooga first).
  const PLAY_KEYS = { w: "forward", arrowup: "forward", s: "back", arrowdown: "back", a: "left", arrowleft: "left", d: "right", arrowright: "right", shift: "run", q: "turnLeft", e: "turnRight" };
  const CAMERA_DIST = 4.2, CAMERA_PITCH = 0.42, CAMERA_TURN = 1.8, SUMMON_DIST = 3.5;
  const createPlay = () => {
    const held = { forward: 0, back: 0, left: 0, right: 0, run: 0, turnLeft: 0, turnRight: 0, jump: 0 };
    let scene = null, agent = null, yaw = 0, startedAt = -Infinity;
    const typing = (e) => e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || (e.target.closest && e.target.closest("dialog")));
    const leftShift = (e) => e.code === "ShiftLeft" || !e.code && e.location !== 2;
    const onKeyDown = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      const key = e.key.toLowerCase();
      // Right Shift+A reaches the director; Left Shift+A remains a running strafe.
      if (e.shiftKey && key === "a" && scene.agentControls && scene.agentControls.rightShift) return;
      if (key === "shift" && !leftShift(e)) return;
      if (key === "escape") stop();
      else if (PLAY_KEYS[key]) held[PLAY_KEYS[key]] = 1;
      else if (key === " ") {
        if (!e.repeat && !held.jump) { held.jump = 1; agent.jump(); }
      } else if (key === "c") {
        if (!e.repeat) agent.poke();
      } else if (key === "h") {
        if (!e.repeat) agent.toggleStyle();
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Key-ups pass on: the scene's controls saw the A of Right Shift+A go down before play began, and a
    // swallowed key-up left it held there, walking the next driven Ooga left on its own.
    const onKeyUp = (e) => {
      if (e.key.toLowerCase() === "shift" && !leftShift(e)) return;
      if (e.key === " ") held.jump = 0;
      const name = PLAY_KEYS[e.key.toLowerCase()];
      if (name) held[name] = 0;
    };
    const onBlur = () => {
      for (const name in held) held[name] = 0;
    };
    const toast = (text) => {
      if (scene.debug && scene.debug.hud) scene.debug.hud.toast(text);
    };
    // summon: bring it in front of the camera (Right Shift+A); a double-click takes it where it stands.
    const start = (next, summon = true) => {
      if (next.agentHandoff) next.agentHandoff();
      scene = next;
      // A scene may build its Agent only when one is called for (the lab).
      agent = next.agent || (next.summonAgent ? next.summonAgent() : null);
      if (!agent) return;
      startedAt = performance.now();
      const c = next.camera, dx = c.target.x - c.position.x, dz = c.target.z - c.position.z, l = Math.hypot(dx, dz) || 1;
      if (summon) {
        const x = c.position.x + dx / l * SUMMON_DIST, z = c.position.z + dz / l * SUMMON_DIST, y = agent.groundAt(x, z);
        // Wherever there is ground to stand on in front of the camera, facing away
        if (Number.isFinite(y) && Math.abs(y - c.position.y) < 30) agent.place(x, z, Math.atan2(dx, dz));
      }
      agent.root.visible = true;
      agent.setDriven(true);
      yaw = Math.atan2(-dx, -dz);
      if (next.agentView) next.agentView.tYaw = next.agentView.yaw = yaw;
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyUp, true);
      window.addEventListener("blur", onBlur);
      toast("You are the Agent · WASD walk, Left Shift gallop, Space to jump, press again in air to double jump, H hunch, C beat chest · Esc to let go");
    };
    function stop(quiet = false) {
      if (!agent) return;
      agent.setDriven(false);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      onBlur();
      // The free camera stays where the chase camera left it
      const view = scene.agentView, p = agent.root.position;
      if (view) {
        view.target.x = view.tx = p.x;
        view.target.y = view.ty = p.y + 0.9;
        view.target.z = view.tz = p.z;
      }
      if (!quiet) toast("The Agent wanders off");
      agent = scene = null;
    }
    // After the scene's update: steer relative to the camera, then place the chase camera.
    const update = (dt) => {
      if (!agent) return;
      const view = scene.agentView, turn = (held.turnLeft - held.turnRight) * CAMERA_TURN * dt;
      if (view) {
        view.tYaw += turn;
        yaw = view.yaw;
      } else yaw += turn;
      const stick = scene.agentControls ? scene.agentControls.read() : null;
      let ix = held.right - held.left + (stick ? stick.x : 0), iy = held.forward - held.back + (stick ? stick.y : 0);
      // The camera looks along -(sin yaw, cos yaw); screen right is (cos yaw, -sin yaw)
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      let mx = fx * iy - fz * ix, mz = fz * iy + fx * ix;
      const m = Math.hypot(mx, mz);
      if (m > 1) { mx /= m; mz /= m; }
      agent.drive(mx, mz, held.run > 0);
      const p = agent.root.position, c = scene.camera;
      const pitch = view ? view.pitch : CAMERA_PITCH, dist = view ? view.dist : CAMERA_DIST, cp = Math.cos(pitch);
      c.position.x = p.x + Math.sin(yaw) * cp * dist;
      c.position.y = p.y + 0.9 + Math.sin(pitch) * dist;
      c.position.z = p.z + Math.cos(yaw) * cp * dist;
      c.target.x = p.x;
      c.target.y = p.y + 0.9;
      c.target.z = p.z;
    };
    return { start, stop, update, get active() { return !!agent; }, get agent() { return agent; }, get startedAt() { return startedAt; } };
  };
  BL.agent = { create, createPlay, labCoatClip, GAITS, TRIPLE_MS, QUAD, HUNCH, BODY, POUND_TIME, MANAGED_BEAT_TIME, MANAGED_MOTION_RADIUS, MANAGED_MOTION_HEIGHT, MANAGED_SMASH_RADIUS, LAB_RADIUS, LAB_HEIGHT, LAB_CENTERS, LAB_IDLE_RADIUS, LAB_WALK_RADIUS, LAB_SQUEEZE_RADIUS, footprint, torso,
    labFlaskGeometry: (variant) => variant === undefined ? geometries().labFlask : labFlaskVariants(variant) };
})();

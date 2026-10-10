// The cavemen from the roster: activity and presence, repository work trips, weapons and magazines, pile
// reloading, sleep, grounded cheers, strolls, possession and jetpack flight, swag and pokes.
//
// A character with a `tint` pair wears its second colourway while the coin is up on the day
// (`chain.snapshot.priceUsd` against `priceOpenUsd`) and its first while it is down, on the old timer when
// there is no reading; a poke's toggle holds `TINT_HOLD` seconds before the price has its say again.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { math, models, contributors } = BL;
  const { clamp, lerp, damp, ease, randomInt } = math;
  const { createNode, addChild, removeChild, addTween } = BL.scene;
  const EAT_RATE = 1 / 20;
  const CHEW_PERIOD = 3.2;
  const AMMO_MAX = 30, AMMO_PER_BANANA = 3, RELOAD_PERIOD = 1.2, BURST_ROUNDS = 3, BURST_STEP = 0.09, SHOT_PERIOD = 0.44;
  const FOCUSED_AUTO_HOLD = 0.12;
  const SHOT_POWER = 0.5, HEADSHOT_MULTIPLIER = 2.5;
  // A shot cut short at a gorilla still reaches this far past it on its last
  // step, so a body that bobbed or turned during the flight takes the hit.
  const SHOT_SURFACE_REACH = 0.5;
  const GUN_MUZZLE_Y = -0.01, GUN_MUZZLE_Z = 0.67;
  const GUN_SIGHT_DOWN = Math.atan2(0.09 - 0.08, 0.59 + 0.18);
  const GUN_SIGHT_DROP = 0.08 * Math.cos(GUN_SIGHT_DOWN) + 0.18 * Math.sin(GUN_SIGHT_DOWN);
  const MELEE_RECHARGE_DELAY = 0.1, MELEE_RECHARGE_TIME = 0.1, MELEE_HIT_POWER = 1.25;
  const MELEE_WIND = 0.08, MELEE_QUICK_WIND = 0.025, MELEE_STRIKE = 0.128, MELEE_QUICK_STRIKE = 0.09, MELEE_RECOVER = 0.112;
  const MELEE_RELEASE = MELEE_STRIKE + MELEE_RECOVER, MELEE_TIME = MELEE_WIND + MELEE_RELEASE;
  const MELEE_TAP_TIME = 0.12, MELEE_CHARGE_DELAY = 0.24, MELEE_CHARGE_TIME = 1;
  const MELEE_COMBO_WINDOW = 0.4;
  const MELEE_READY_HOLD = 0.5, MELEE_CARRY_BLEND = 0.25;
  const GUN_BASH_TIME = 0.28, GUN_BASH_IMPACT = 0.13, GUN_BASH_POWER = 1;
  const clearMeleeThrust = (cave) => {
    const w = cave.weapon, p = cave.parts.armR.position;
    p.x -= w.meleeOffsetX; p.y -= w.meleeOffsetY; p.z -= w.meleeOffsetZ;
    w.meleeOffsetX = w.meleeOffsetY = w.meleeOffsetZ = 0;
  };
  const clearGunBashThrust = (cave) => {
    const offset = cave.weapon.bashOffset;
    cave.parts.armR.position.z -= offset;
    cave.parts.armL.position.z -= offset;
    cave.weapon.bashOffset = 0;
  };
  const AXE_STICK_DELAY = 1, AXE_STICK_BLEND = 0.3, AXE_STICK_ARM = -1.5;
  // A body built with a second colourway changes between the two on its own,
  // never sooner than TINT_MIN and never later than TINT_MAX.
  // A maintainer runs the whole island's circuit, so it stands at the pile for a
  // while between trips instead of scurrying from one cave straight to the next.
  const WORK_REST_MIN = 7, WORK_REST_SPREAD = 16;
  // How long a character carries its rifle before swapping to the other weapon,
  // and how long the spin that answers it lasts: a flourish, not a stance.
  const SWAP_MIN = 20, SWAP_SPREAD = 40, TWIRL_MIN = 0.3, TWIRL_SPREAD = 1.7, TWIRL_SWAP = 0.35, TWIRL_FIRST = 0.35;
  const swapWait = (melee) => melee ? TWIRL_MIN + Math.random() * TWIRL_SPREAD : SWAP_MIN + Math.random() * SWAP_SPREAD;
  const TINT_MIN = 360, TINT_MAX = 900;
  const tintWait = () => TINT_MIN + Math.random() * (TINT_MAX - TINT_MIN);
  // A tinted character wears its second colourway while the coin is up on the day (the chain's price
  // against the day's open), the first while it is down; without a reading it changes on the timer.
  // A poke's toggle holds for TINT_HOLD seconds before the price has its say again.
  const TINT_HOLD = 8;
  const tintWanted = () => {
    const c = BL.chain && BL.chain.snapshot;
    if (!c || !(c.priceOpenUsd > 0) || !(c.priceUsd > 0)) return -1;
    return c.priceUsd >= c.priceOpenUsd ? 1 : 0;
  };
  // The free stick folds against the handle when the weapon is stowed and flies
  // out in line with it in the hand, where the wrist spins it at the hip.
  const TAU = Math.PI * 2;
  // Spun overhead on a raised arm at CHUK_SPINS turns a second: the circle clears
  // the ground, which a spin at the hip cannot, the pair being most of a metre long.
  // Past about five turns a second a 60Hz frame steps more than a third of a turn
  // and the spin strobes, reading slower than it is.
  // Fifteen turns a second steps 90 degrees between frames at 60Hz, so the pair
  // would strobe on its own. Six copies trail it by CHUK_TRAIL each: the fan is
  // wider than a frame's step, consecutive frames overlap, and the eye reads an arc.
  const CHUK_FOLD = 2.4, CHUK_SPINS = 15, CHUK_TRAIL = 0.32, CHUK_ARM = -2.05, CHUK_ARM_OUT = -0.32, CHUK_OUT = 0.16;
  // A weighted flail lands harder than a club and moves faster than one.
  const NUNCHAKU_POWER = 2, NUNCHAKU_RATE = 1.9;
  const GUN_HOLD = 0.24, GUN_KICK = 0.045, GUN_FLASH_TIME = 0.035;
  const MAGAZINE_SWAP_TIME = 0.44;
  const RELOAD_HANDOFF_TIME = 0.32, RELOAD_FULL_HOLD = 0.24;
  const GUN_FLASH = models.merge(
    models.box({ w: 0.12, h: 0.035, d: 0.07, color: "#ffd94a", emissive: 1 }),
    models.box({ w: 0.035, h: 0.12, d: 0.07, color: "#ffd94a", emissive: 1 }),
    models.box({ w: 0.05, h: 0.05, d: 0.08, color: "#fff4c4", emissive: 1 })
  );
  const HEALTH_MAX = 100, HEALTH_REGEN_DELAY = 4, HEALTH_REGEN_RATE = 20, HEALTH_PICKUP_TIME = 0.35;
  const GEAR_PICKUP_RADIUS = 0.72;
  const STUN_BIRD = models.merge(
    models.box({ w: 0.09, h: 0.055, d: 0.055, color: "#ffd84a", emissive: 0.7 }),
    models.box({ w: 0.12, h: 0.035, d: 0.045, color: "#f2b83b", emissive: 0.6, offset: { x: -0.085, y: 0.035 } }),
    models.box({ w: 0.12, h: 0.035, d: 0.045, color: "#f2b83b", emissive: 0.6, offset: { x: 0.085, y: 0.035 } })
  );
  const BODY_PARTS = ["torso", "head", "legR", "legL", "armR", "armL"];
  const SWAG_ANCHORS = ["hat", "face"];
  const FAN_STANDOFF = 1.1;
  const FAN_ARC = 2.2;
  // FAN_SPREAD is the widest the fan opens, keeping the near side clear however many eat.
  const FAN_SPREAD = 5;
  const FAN_SLOT_MAX = 128;
  const POKES = ["Ooga?", "Booga!", "No poke.", "Hmm banana?", "Ooga booga booga."];
  const SLEEP_POKES = ["zzz... grr", "five more minutes", "zzz"];
  const SLEEP_POSES = ["left", "stomach", "back", "right"];
  const BUILD_QUOTES = ["Ooga Booga!", "Ooga Booga BUILD!", "Ooga Booga MORE TOOLS!"];
  const IDLE_QUOTES = ["Ooga.", "Hmm.", "Nice rock.", "Booga?", "Where banana?", "Ooga booga.", "Sky big.", "Good cave."];
  const PHASE_QUOTES = {
    dawn: ["Sun come.", "Big yawn.", "Cold rock.", "Bird loud.", "Sky pink.", "Ooga wake."],
    morning: ["Good day for banana.", "Ooga work.", "Sun warm.", "Rock dry now.", "Big day.", "Booga hungry."],
    noon: ["Hot rock.", "Sun high.", "Shade good.", "Ooga sweat.", "Banana warm.", "Too bright."],
    dusk: ["Sky orange. Pretty.", "Fire soon.", "Sun go down.", "Long shadow.", "Ooga tired.", "Bug sing."],
    night: ["Stars many.", "Fire warm.", "Moon big.", "Dark out there.", "Ooga count star.", "Owl."],
    midnight: ["Ooga not sleepy.", "Owl says hoo.", "Very dark. Very quiet.", "Rock cold.", "Booga snore.", "Moon watch."]
  };
  // A voiced contributor speaks his own idle line half the time, held 3s so it reads.
  const VOICE_MIX = 0.5, VOICE_SECONDS = 3;
  const EAT_MIN = 14, EAT_SPREAD = 20, HUNGRY_LINGER = 4, IDLE_MIN = 3, IDLE_SPREAD = 6, TRIPS_MAX = 3;
  const CHILL_MIN = 120, CHILL_SPREAD = 120;
  // Long, staggered rests keep idle NPCs off the paths without pausing their
  // reactions to workers, fire, possession or a change in contribution state.
  const chillPause = (cave) => CHILL_MIN + ((cave.index * 0.61803398875 + cave.act.trips * 0.41421356237) % 1) * CHILL_SPREAD;
  const { WALK } = BL.pilot;
  const WANDER_SPEED = 1.3, RUSH_SPEED = 2.8, PLAYER_SPEED = WALK.speed;
  const PLAYER_STEP = 0.125;
  const LADDER_SPEED = 2.4;
  const SHOULDER_GAP = 0.68, SHOULDER_TOUCH = 1.1, SHOULDER_REACH = 1.3, SHOULDER_TWIST = 1.05;
  // A body the scene owns rather than the roster can be bigger than an Ooga, so
  // the gap kept from it is wider than the one walkers keep from each other.
  const OUTSIDE_GAP = 0.86;
  const FOLLOW_GAP = 1.15, FOLLOW_RELEASE = 1.7, NPC_PASS_REACH = 1.9;
  const FIRE_FLEE_REACH = 8, FIRE_FLEE_CLEAR = 10, FIRE_MEMORY_RELEASE = 3, NPC_WALK_SPEED = 1.6;
  const NAV_WIDTH = 21, NAV_SIZE = NAV_WIDTH * NAV_WIDTH, NAV_HALF = 10, NAV_CELL = 0.5, NAV_STEP = 0.025, NAV_CENTER = NAV_HALF * NAV_WIDTH + NAV_HALF;
  const JUMP_SPEED = 4.8, ROCKET_JUMP_TIME = 2 * JUMP_SPEED / WALK.gravity;
  const JET_FUEL_SECONDS = 8, JET_MOVE_SECONDS = JET_FUEL_SECONDS * 2, JET_REFILL_SECONDS = 4, JET_LAUNCH_FUEL = 0.2;
  // Fuel limits range and altitude; releasing thrust falls back to ordinary gravity.
  const JET_ACCEL = 20, JET_RISE = 7, JET_SPEED = 6.4, JET_PUFF = 0.05;
  const JET_SPARKS = [models.particleGeometry("#ffb13b", 0.09, 1), models.particleGeometry("#f3efe4", 0.07, 0.6)];
  const LAND_DUST = [models.particleGeometry("#a3874f", 0.1, 0)];
  const MASK_SMOKE = { ...models.particleGeometry("#c9cbce", 0.09, 0.15) };
  const MASK_PORTS = [[0, 0], ...[0, 1, 2, 3, 4, 5].map((i) => [Math.cos(i / 6 * Math.PI * 2) * 0.065, Math.sin(i / 6 * Math.PI * 2) * 0.065])];
  const MASK_SMOKE_PER_PORT = 2, MASK_SMOKE_SMALL_PER_PORT = 4;
  const MASK_SMOKE_CAP = MASK_PORTS.length * Math.max(36 * MASK_SMOKE_PER_PORT, 12 * MASK_SMOKE_SMALL_PER_PORT);
  // Smoke cubes have half-width 0.045; this spacing leaves a little overlap.
  const MASK_SMOKE_SMALL = 0.34, MASK_SMOKE_MERGE_MAX = 12, MASK_SMOKE_SEPARATION = 0.04;
  const MASK_SMOKE_MAX = MASK_SMOKE_SMALL * Math.cbrt(MASK_SMOKE_MERGE_MAX);
  const MASK_SMOKE_RISE = 0.06, MASK_SMOKE_LIFT = 0.12;
  const BURN_FLAMES = [models.particleGeometry("#ff8a2a", 0.14, 1), models.particleGeometry("#ffc148", 0.12, 1)];
  const BURN_SMOKE = models.particleGeometry("#70685f", 0.18, 0);
  const ROLL_SECONDS = 3, SOOT_SECONDS = 10, EMBER_HEAT_SECONDS = 4;
  // STEP is a drop deeper than a step, mirroring the hub's STEP_MAX.
  const STEP = WALK.step;
  const YAWN_DUR = 2.4;
  const REACH = 1.6;
  const MUZZLE = new Float32Array(3);
  const meleeExtremes = (geometry) => {
    const verts = geometry.verts, points = new Uint32Array(6);
    for (let i = 3; i < verts.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      if (verts[i + axis] < verts[points[axis * 2] + axis]) points[axis * 2] = i;
      if (verts[i + axis] > verts[points[axis * 2 + 1] + axis]) points[axis * 2 + 1] = i;
    }
    return points;
  };
  const SMOKE_LOCAL = new Float32Array(3), SMOKE_INVERSE = math.mat4.create();
  const GUN_ARM = math.quat.create(), GUN_GRIP = math.quat.create(), GUN_SWAP_TARGET = math.quat.create(), GUN_SIGHT = math.quat.create();
  const MELEE_SWING = math.quat.create(), MELEE_DOWN_INV = 1 / Math.hypot(0.07, -0.27, 0.96);
  const MELEE_REST_ARM = math.quat.create(), MELEE_REST_CLUB = math.quat.create(), MELEE_REST_GRIP = new Float64Array(3);
  const AXE_FORWARD_ROTATION = math.quat.create(), AXE_UPRIGHT_ROTATION = math.quat.create(), AXE_ARM_INVERSE = math.quat.create();
  math.quat.fromEuler(AXE_FORWARD_ROTATION, 0, Math.PI / 2, Math.PI / 2);
  math.quat.fromEuler(AXE_ARM_INVERSE, -0.26, 0, 0);
  math.quat.multiply(AXE_FORWARD_ROTATION, AXE_ARM_INVERSE, AXE_FORWARD_ROTATION);
  math.quat.fromEuler(AXE_UPRIGHT_ROTATION, 0, Math.PI / 2, 0);
  const FINGER_INVERSE = math.quat.create(), FINGER_TARGET = math.quat.create();
  const CLUB_SLING_TILT = -0.3, CLUB_SLING_ANGLE = -0.8, CLUB_SLICES = 8;
  const CLUB_ROTATION = math.quat.create(), CLUB_POINT = new Float64Array(3);
  const CLUB_AXES = new Float64Array(9);
  const CLUB_FIT = { x: 0, y: 0, z: 0, ex: 0, ey: 0, ez: 0, hx: 0, hy: 0, hz: 0, lo: 0, hi: 0, side: false, axes: new Float64Array(9) };
  // Cache the diagonal club's profile once. Separate height strips let its
  // handle lie against the back without its wider head entering the hair.
  const clubSlingProfile = (geometry) => {
    const verts = geometry.verts, profile = new Float64Array(CLUB_SLICES * 6);
    let bottom = Infinity, top = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      bottom = Math.min(bottom, verts[i + 1]); top = Math.max(top, verts[i + 1]);
    }
    for (let i = 0; i < CLUB_SLICES; i++) {
      const k = i * 6;
      profile[k] = Infinity; profile[k + 1] = -Infinity;
      profile[k + 2] = lerp(bottom, top, i / CLUB_SLICES);
      profile[k + 3] = lerp(bottom, top, (i + 1) / CLUB_SLICES);
      profile[k + 4] = Infinity; profile[k + 5] = -Infinity;
    }
    for (const face of geometry.faces) {
      for (let k = 0; k < profile.length; k += 6) {
        const low = profile[k + 2], high = profile[k + 3];
        for (let i = 0; i < face.i.length; i++) {
          const a = face.i[i] * 3, b = face.i[(i + 1) % face.i.length] * 3, ay = verts[a + 1], by = verts[b + 1];
          if (ay >= low && ay <= high) {
            profile[k] = Math.min(profile[k], verts[a]); profile[k + 1] = Math.max(profile[k + 1], verts[a]);
            profile[k + 4] = Math.min(profile[k + 4], verts[a + 2]); profile[k + 5] = Math.max(profile[k + 5], verts[a + 2]);
          }
          for (let edge = 0; edge < 2; edge++) {
            const boundary = edge ? high : low;
            if ((ay < boundary) === (by < boundary)) continue;
            const t = (boundary - ay) / (by - ay), x = lerp(verts[a], verts[b], t), z = lerp(verts[a + 2], verts[b + 2], t);
            profile[k] = Math.min(profile[k], x); profile[k + 1] = Math.max(profile[k + 1], x);
            profile[k + 4] = Math.min(profile[k + 4], z); profile[k + 5] = Math.max(profile[k + 5], z);
          }
        }
      }
    }
    return profile;
  };
  const clubSlingAxes = (club) => {
    math.quat.fromEuler(CLUB_ROTATION, club.rotation.x, club.rotation.y, club.rotation.z);
    const q = club.quaternion || CLUB_ROTATION;
    for (let i = 0; i < 3; i++) {
      math.quat.rotateVec(CLUB_POINT, q, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
      CLUB_AXES[i * 3] = CLUB_POINT[0]; CLUB_AXES[i * 3 + 1] = CLUB_POINT[1]; CLUB_AXES[i * 3 + 2] = CLUB_POINT[2];
    }
  };
  // Intersect the placement interval on each separating axis. The rear (or
  // left-hip) endpoint touches the oriented body bounds as the body turns.
  const clubFitAxis = (x, y, z) => {
    const f = CLUB_FIT, a = f.axes, c = CLUB_AXES;
    const radius = f.ex * Math.abs(x * c[0] + y * c[1] + z * c[2])
      + f.ey * Math.abs(x * c[3] + y * c[4] + z * c[5])
      + f.ez * Math.abs(x * c[6] + y * c[7] + z * c[8])
      + f.hx * Math.abs(x * a[0] + y * a[1] + z * a[2])
      + f.hy * Math.abs(x * a[3] + y * a[4] + z * a[5])
      + f.hz * Math.abs(x * a[6] + y * a[7] + z * a[8]);
    const distance = f.x * x + f.y * y + f.z * z;
    const direction = f.side ? x : z;
    if (Math.abs(direction) < 1e-9) return Math.abs(distance) <= radius;
    const lo = (-radius - distance) / direction, hi = (radius - distance) / direction;
    f.lo = Math.max(f.lo, Math.min(lo, hi)); f.hi = Math.min(f.hi, Math.max(lo, hi));
    return f.lo <= f.hi;
  };
  const clubRearContact = (cave, node, bounds, side = false) => {
    const club = cave.parts.club, profile = cave.clubSlingProfile, scale = node.scale, p = node.position, f = CLUB_FIT;
    f.side = side;
    math.quat.fromEuler(CLUB_ROTATION, node.rotation.x, node.rotation.y, node.rotation.z);
    const q = node.quaternion || CLUB_ROTATION;
    math.quat.rotateVec(CLUB_POINT, q, bounds.center[0] * scale.x, bounds.center[1] * scale.y, bounds.center[2] * scale.z);
    const yaw = node.poseYaw - club.poseYaw, sr = Math.sin(yaw), cr = Math.cos(yaw);
    const x = p.x + CLUB_POINT[0], z = p.z + CLUB_POINT[2];
    const cx = x * cr + z * sr, cy = p.y + CLUB_POINT[1], cz = z * cr - x * sr;
    f.hx = (bounds.max[0] - bounds.min[0]) * scale.x / 2;
    f.hy = (bounds.max[1] - bounds.min[1]) * scale.y / 2;
    f.hz = (bounds.max[2] - bounds.min[2]) * scale.z / 2;
    for (let i = 0; i < 3; i++) {
      math.quat.rotateVec(CLUB_POINT, q, i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
      f.axes[i * 3] = CLUB_POINT[0] * cr + CLUB_POINT[2] * sr; f.axes[i * 3 + 1] = CLUB_POINT[1];
      f.axes[i * 3 + 2] = CLUB_POINT[2] * cr - CLUB_POINT[0] * sr;
    }
    let depth = Infinity;
    for (let k = 0; k < profile.length; k += 6) {
      const x = (profile[k] + profile[k + 1]) / 2, y = (profile[k + 2] + profile[k + 3]) / 2, z = (profile[k + 4] + profile[k + 5]) / 2;
      f.x = (side ? 0 : club.position.x) + CLUB_AXES[0] * x + CLUB_AXES[3] * y + CLUB_AXES[6] * z - cx;
      f.y = club.position.y + CLUB_AXES[1] * x + CLUB_AXES[4] * y + CLUB_AXES[7] * z - cy;
      f.z = (side ? club.position.z : 0) + CLUB_AXES[2] * x + CLUB_AXES[5] * y + CLUB_AXES[8] * z - cz;
      f.ex = (profile[k + 1] - profile[k]) / 2; f.ey = (profile[k + 3] - profile[k + 2]) / 2; f.ez = (profile[k + 5] - profile[k + 4]) / 2;
      f.lo = -Infinity; f.hi = Infinity;
      let intersects = true;
      for (let i = 0; i < 9 && intersects; i += 3) {
        const x = f.axes[i], y = f.axes[i + 1], z = f.axes[i + 2];
        intersects = clubFitAxis(x, y, z) && clubFitAxis(CLUB_AXES[i], CLUB_AXES[i + 1], CLUB_AXES[i + 2]);
        for (let j = 0; j < 9 && intersects; j += 3) {
          const a = CLUB_AXES[j], b = CLUB_AXES[j + 1], c = CLUB_AXES[j + 2];
          intersects = clubFitAxis(y * c - z * b, z * a - x * c, x * b - y * a);
        }
      }
      if (intersects) depth = Math.min(depth, f.lo);
    }
    return depth;
  };
  const SLEEP_COMPRESSION = 0.025, SLEEP_SIDE_COMPRESSION = 0.16;
  const SLEEP_BOUNDS = { min: Infinity, headMin: Infinity, coreMin: Infinity, feetMin: Infinity };
  const SLEEP_BASE = math.quat.create(), SLEEP_TILT = math.quat.create(), SLEEP_INVERSE = math.quat.create();
  const LOOK_ROTATION = math.quat.create();
  const PILLOW_CLIP_A = new Float64Array(48), PILLOW_CLIP_B = new Float64Array(48);
  const PILLOW_FRAME = { x: 0, y: 0, z: 0, sr: 0, cr: 1, minX: 0, maxX: 0, minZ: 0, maxZ: 0, minimum: Infinity };
  const clipHeadToPillow = (node) => {
    if (!node.visible) return;
    const frame = PILLOW_FRAME;
    if (node.geometry) {
      const verts = node.geometry.verts, m = node.world;
      for (const face of node.geometry.faces) {
        let src = PILLOW_CLIP_A, dst = PILLOW_CLIP_B, count = face.i.length;
        for (let i = 0; i < count; i++) {
          const v = face.i[i] * 3, x = m[0] * verts[v] + m[4] * verts[v + 1] + m[8] * verts[v + 2] + m[12] - frame.x;
          const z = m[2] * verts[v] + m[6] * verts[v + 1] + m[10] * verts[v + 2] + m[14] - frame.z;
          src[i * 3] = x * frame.cr - z * frame.sr;
          src[i * 3 + 1] = m[1] * verts[v] + m[5] * verts[v + 1] + m[9] * verts[v + 2] + m[13] - frame.y;
          src[i * 3 + 2] = x * frame.sr + z * frame.cr;
        }
        for (let edge = 0; edge < 4 && count >= 3; edge++) {
          const axis = edge < 2 ? 0 : 2, sign = edge & 1 ? -1 : 1;
          const bound = edge === 0 ? frame.maxX : edge === 1 ? frame.minX : edge === 2 ? frame.maxZ : frame.minZ;
          let out = 0;
          for (let i = 0; i < count; i++) {
            const a = i * 3, b = ((i + 1) % count) * 3, ai = (src[a + axis] - bound) * sign <= 0, bi = (src[b + axis] - bound) * sign <= 0;
            if (ai) { dst[out * 3] = src[a]; dst[out * 3 + 1] = src[a + 1]; dst[out * 3 + 2] = src[a + 2]; out++; }
            if (ai !== bi) {
              const k = (bound - src[a + axis]) / (src[b + axis] - src[a + axis]);
              dst[out * 3] = lerp(src[a], src[b], k); dst[out * 3 + 1] = lerp(src[a + 1], src[b + 1], k); dst[out * 3 + 2] = lerp(src[a + 2], src[b + 2], k); out++;
            }
          }
          count = out;
          const swap = src; src = dst; dst = swap;
        }
        let area = 0, minimum = Infinity;
        for (let i = 0; i < count; i++) {
          const a = i * 3, b = ((i + 1) % count) * 3;
          area += src[a] * src[b + 2] - src[b] * src[a + 2];
          minimum = Math.min(minimum, src[a + 1]);
        }
        if (Math.abs(area) > 1e-12) frame.minimum = Math.min(frame.minimum, minimum);
      }
    }
    for (const child of node.children) clipHeadToPillow(child);
  };
  const pillowMinimum = (cave, bed, fitting) => {
    const frame = PILLOW_FRAME, box = bed.collisionBoxes, travel = cave.bedTravel;
    frame.x = fitting ? 0 : bed.x; frame.y = fitting ? -travel.restY : bed.y; frame.z = fitting ? -travel.restZ : bed.z;
    frame.sr = fitting ? 0 : bed.sr; frame.cr = fitting ? 1 : bed.cr;
    frame.minX = box[6]; frame.maxX = box[9]; frame.minZ = box[8]; frame.maxZ = box[11]; frame.minimum = Infinity;
    clipHeadToPillow(cave.parts.head);
    return frame.minimum;
  };
  const measureSleeper = (node, head, headNode, feet = false, legR, legL) => {
    if (!node.visible) return;
    if (node.geometry) {
      const verts = node.geometry.verts, m = node.world;
      for (let i = 0; i < verts.length; i += 3) {
        const y = m[1] * verts[i] + m[5] * verts[i + 1] + m[9] * verts[i + 2] + m[13];
        if (head) SLEEP_BOUNDS.headMin = Math.min(SLEEP_BOUNDS.headMin, y);
        else {
          SLEEP_BOUNDS.min = Math.min(SLEEP_BOUNDS.min, y);
          if (feet) SLEEP_BOUNDS.feetMin = Math.min(SLEEP_BOUNDS.feetMin, y);
          else SLEEP_BOUNDS.coreMin = Math.min(SLEEP_BOUNDS.coreMin, y);
        }
      }
    }
    for (const child of node.children) measureSleeper(child, head || child === headNode, headNode, feet || child === legR || child === legL, legR, legL);
  };
  const measureSleepPitch = (cave, pitch) => {
    const scale = cave.parts.torso.scale.y;
    cave.parts.torso.scale.y = 0.985;
    math.quat.fromAxisAngle(SLEEP_TILT, 1, 0, 0, pitch);
    math.quat.multiply(cave.sleepTargetRotation, SLEEP_TILT, SLEEP_BASE);
    cave.root.quaternion = cave.sleepTargetRotation;
    BL.scene.updateWorld(cave.root);
    SLEEP_BOUNDS.min = SLEEP_BOUNDS.headMin = SLEEP_BOUNDS.coreMin = SLEEP_BOUNDS.feetMin = Infinity;
    measureSleeper(cave.root, false, cave.parts.head, false, cave.parts.legR, cave.parts.legL);
    // Fit both ends of the breathing cycle once so it cannot deepen settled mattress compression later.
    cave.parts.torso.scale.y = 1.015;
    BL.scene.updateWorld(cave.parts.torso, cave.root.world);
    measureSleeper(cave.parts.torso, false, cave.parts.head);
    cave.parts.torso.scale.y = scale;
  };
  const setVec = (v, x, y, z) => {
    v.x = x;
    v.y = y;
    v.z = z;
    return v;
  };
  const popNode = (node) => {
    const target = { ...node.scale };
    Object.assign(node.scale, { x: 0.01, y: 0.01, z: 0.01 });
    addTween({
      dur: 0.5, ease: ease.outBack, update: (k) => {
        node.scale.x = target.x * k;
        node.scale.y = target.y * k;
        node.scale.z = target.z * k;
      }
    });
  };
  // Cache the head's full pitch envelope once, attachments included; ceiling look-up must fit the movement body.
  const bodyHeightOf = (cave) => {
    BL.scene.updateWorld(cave.root);
    const head = cave.parts.head, pivotY = head.world[13], pivotZ = head.world[14];
    let reach = 0;
    const inspect = (geometry, m) => {
      const verts = geometry.verts;
      for (let i = 0; i < verts.length; i += 3) {
        const y = m[1] * verts[i] + m[5] * verts[i + 1] + m[9] * verts[i + 2] + m[13] - pivotY;
        const z = m[2] * verts[i] + m[6] * verts[i + 1] + m[10] * verts[i + 2] + m[14] - pivotZ;
        reach = Math.max(reach, Math.hypot(y, z));
      }
    };
    const visit = (node) => {
      if (!node.visible) return;
      if (node.geometry) inspect(node.geometry, node.world);
      for (const child of node.children) visit(child);
    };
    visit(head);
    inspect(cave.headClosed, head.world);
    return pivotY + reach;
  };
  // The interaction footprint follows the authored body, without extending
  // reach for a held weapon. Its standing envelope is stable through a walk.
  const bodyRadiusOf = (cave) => {
    let radius2 = 0;
    for (const key of BODY_PARTS) {
      const part = cave.parts[key], verts = part.geometry.verts, m = part.world;
      for (let i = 0; i < verts.length; i += 3) {
        const x = m[0] * verts[i] + m[4] * verts[i + 1] + m[8] * verts[i + 2] + m[12] - cave.root.position.x;
        const z = m[2] * verts[i] + m[6] * verts[i + 1] + m[10] * verts[i + 2] + m[14] - cave.root.position.z;
        radius2 = Math.max(radius2, x * x + z * z);
      }
    }
    return Math.sqrt(radius2);
  };
  const createMagazineModel = () => {
    const model = models.spareMagazine();
    model.handRotation = math.quat.create(); model.armRotation = math.quat.create();
    model.armStart = math.quat.create(); model.armRest = math.quat.create();
    return model;
  };
  const create = (ctx) => {
    const { root, input, hud, game, world, bedrolls, viewYaw, buildSpots, walkIn, wanderSpot } = ctx;
    // playerName creates one playable actor without roster scheduling, beds or a pile.
    // groundAt takes the caveman's current height: support is layered, so the answer depends on where he is.
    const groundAt = ctx.groundAt || (() => 0);
    const walkable = ctx.walkable || (() => true);
    const npcWalkable = ctx.npcWalkable || walkable;
    const inBananas = ctx.inBananas || (() => false);
    const npcDestinationBlocked = ctx.npcDestinationBlocked || inBananas;
    const flyable = ctx.flyable || walkable;
    const workSites = ctx.workSites?.length ? ctx.workSites : ctx.workRoute ? [{ repo: "oogaboogax/entropylab", route: ctx.workRoute, position: ctx.workPosition, target: ctx.workTarget }] : null;
    const workBodyTarget = ctx.workSites?.length ? ctx.workTarget : null;
    const workCompanionTarget = ctx.workCompanionTarget;
    // A site is eligible when the worker is fresh in either of its repos, or when it is
    // the fallback (namesake) cave and the worker's fresh repo has no cave of
    // its own. An override or maintainer may visit every work cave.
    const siteRepos = new Set();
    if (workSites) for (const site of workSites) {
      siteRepos.add(site.repo);
      if (site.additionalRepo) siteRepos.add(site.additionalRepo);
    }
    const siteActive = (cave, site) => {
      if (contributors.debugRoster) return contributors.hasRecentActivity(cave.contributor, site.repo);
      if (cave.override === "working" || cave.traits.maintainer || !contributors.hasRecentActivity) return true;
      if (contributors.hasRecentActivity(cave.contributor, site.repo)
        || site.additionalRepo && contributors.hasRecentActivity(cave.contributor, site.additionalRepo)) return true;
      if (!site.fallback) return false;
      for (const repo of cave.contributor.activity.keys()) {
        if (!siteRepos.has(repo) && contributors.hasRecentActivity(cave.contributor, repo)) return true;
      }
      return false;
    };
    const cavemen = new Map();
    // crewList mirrors roster order; the Map is written only in create and cleared in dispose, so it stays valid.
    const crewList = [];
    const NPC_RECOVERY_SPOT = { x: 0, y: 0, z: 0 };
    if (!world.weapons) world.weapons = new Map();
    if (!world.health) world.health = new Map();
    const legacyMagazine = world.magazine || (world.magazine = { owned: false, count: 0, ammo: 0, carrier: null });
    let recipeTimer = 0;
    const claimLegacyMagazines = (weapon) => {
      const count = legacyMagazine.count === 2 ? 2 : 1;
      for (let i = 0; i < count && weapon.spareAmmo.length < 2; i++) weapon.spareAmmo.push(legacyMagazine.ammo);
      legacyMagazine.owned = false; legacyMagazine.count = legacyMagazine.ammo = 0; legacyMagazine.carrier = null;
    };
    contributors.roster.forEach((contributor, i) => {
      if (ctx.playerName ? contributor.name !== ctx.playerName : !contributors.activeRoster.includes(contributor)) return;
      const cave = models.caveman(contributors.traitsFor(contributor.name));
      const h = cave.traits.height;
      let health = world.health.get(contributor.name);
      if (!health) { health = { value: HEALTH_MAX, delay: 0, stunned: false, recovering: false }; world.health.set(contributor.name, health); }
      health.max = HEALTH_MAX;
      health.value = clamp(Number.isFinite(health.value) ? health.value : HEALTH_MAX, 0, HEALTH_MAX);
      health.delay = Math.max(0, Number.isFinite(health.delay) ? health.delay : 0);
      health.stunned = health.value <= 0 || health.stunned === true && health.value < HEALTH_MAX;
      health.recovering = health.stunned && health.value >= HEALTH_MAX;
      const stunBirds = createNode({ position: { x: 0, y: cave.headOffset + 0.42 * h, z: 0 }, visible: false, sightHidden: true });
      for (let bird = 0; bird < 3; bird++) {
        const angle = bird / 3 * Math.PI * 2;
        addChild(stunBirds, createNode({ geometry: STUN_BIRD, position: { x: Math.sin(angle) * 0.34 * h, y: 0, z: Math.cos(angle) * 0.34 * h }, scale: { x: h, y: h, z: h }, sightHidden: true }));
      }
      addChild(cave.root, stunBirds);
      cave.parts.gunFlash = createNode({ geometry: GUN_FLASH, position: { x: 0, y: GUN_MUZZLE_Y * h, z: 0.695 * h },
        scale: { x: h, y: h, z: h }, visible: false });
      addChild(cave.parts.gun, cave.parts.gunFlash);
      cave.gunViewNodes = [cave.parts.armR, cave.parts.fingersR, cave.parts.gunBody, cave.parts.gunFlash, ...cave.parts.gunBananas];
      let weapon = world.weapons.get(contributor.name);
      if (!weapon) { weapon = { equipped: false, ammo: AMMO_MAX }; world.weapons.set(contributor.name, weapon); }
      if (weapon.primaryOwned === undefined) weapon.primaryOwned = true;
      if (weapon.secondaryOwned === undefined) weapon.secondaryOwned = true;
      weapon.ammo = Math.round(clamp(weapon.ammo, 0, AMMO_MAX));
      weapon.unlimited = weapon.unlimited === true;
      if (!weapon.spareAmmo) weapon.spareAmmo = [];
      if (legacyMagazine.owned && legacyMagazine.carrier === contributor.name) {
        claimLegacyMagazines(weapon);
      }
      weapon.reloading = false; weapon.reloadTime = weapon.reloadStep = weapon.cooldown = weapon.recoil = weapon.aimPitch = 0;
      weapon.swapTime = 0; weapon.swapCommitted = false; weapon.swapMagazine = 0;
      weapon.reloadSpare = false; weapon.reloadMagazine = weapon.reloadNext = 0; weapon.reloadHandoff = weapon.reloadHandoffTime = 0;
      weapon.reloadHandoffFrame = weapon.reloadFire = weapon.reloadFireHeld = false;
      weapon.reloadFireRounds = BURST_ROUNDS;
      weapon.burstRemaining = weapon.burstTimer = 0;
      weapon.triggerHeld = weapon.triggerSingle = false;
      weapon.triggerHeldTime = 0;
      weapon.triggerQueued = 0;
      weapon.burstPlayerAim = false;
      weapon.burstWork = false;
      weapon.burstTarget = weapon.burstTarget || { x: 0, y: 0, z: 0 };
      weapon.shotsFired = weapon.shotsFired || 0;
      weapon.carry = "hidden";
      weapon.aiming = false;
      weapon.aimYaw = 0;
      weapon.primaryEquipped = false;
      weapon.selectedSlot = weapon.selectedSlot === 2 ? 2 : 1;
      weapon.meleeTime = 0;
      weapon.meleeHeld = false;
      weapon.meleeQuick = false;
      weapon.meleeSide = 1; weapon.meleeComboTime = 0;
      weapon.meleeBladeTurn = weapon.meleeEntryBladeTurn = 0;
      weapon.meleeEntryX = weapon.meleeEntryY = weapon.meleeEntryZ = weapon.meleeEntryClubZ = 0;
      weapon.meleeReadyTime = 0;
      weapon.meleeAxeArm = math.quat.create(); weapon.meleeAxeClub = math.quat.create();
      weapon.meleeAxeGrip = { x: 0, y: 0, z: 0 }; weapon.meleeAxeArmX = 0;
      weapon.meleeTarget = { node: null, owner: null, x: 0, y: 0, z: 0, distance: 0, type: "none" };
      weapon.meleeOffsetX = weapon.meleeOffsetY = weapon.meleeOffsetZ = 0;
      weapon.meleeAimX = weapon.meleeAimY = weapon.meleeAimZ = 0;
      weapon.meleeHeldTime = weapon.meleeCharge = 0;
      weapon.meleeStrikeTime = MELEE_STRIKE;
      weapon.meleeHit = false;
      weapon.meleeStop = 1;
      weapon.meleePower = 1;
      weapon.meleeHitAt = -Infinity;
      weapon.bashTime = 0;
      weapon.bashOffset = 0;
      weapon.axeIdle = cave.traits.stoneAxe ? AXE_STICK_DELAY + AXE_STICK_BLEND : 0;
      Object.assign(cave, {
        weapon,
        tintTime: cave.tint ? tintWait() : 0, tintState: 0, tintHold: 0,
        chukAngle: CHUK_FOLD,
        meleeOut: false,
        meleeSwap: swapWait(false),
        twirlUntil: -Infinity,
        twirlHand: 0,
        twirlFlipAt: Infinity,
        health,
        stunBirds,
        stunGear: { selectedSlot: 1, drops: [
          { kind: "ammo", slot: 0, active: false, returning: false, node: null, model: null, owner: null, ammo: 0, label: "", unlimited: false, equipped: false, fuel: 0, sx: 0, sy: 0, sz: 0, returnTime: 0 },
          { kind: "magazine", slot: 1, active: false, returning: false, node: null, model: null, owner: null, ammo: 0, label: "", unlimited: false, equipped: false, fuel: 0, sx: 0, sy: 0, sz: 0, returnTime: 0 },
          { kind: "magazine", slot: 2, active: false, returning: false, node: null, model: null, owner: null, ammo: 0, label: "", unlimited: false, equipped: false, fuel: 0, sx: 0, sy: 0, sz: 0, returnTime: 0 }
        ] },
        axeRotation: math.quat.create(),
        gunHandRotation: math.quat.create(),
        gunSupportRotation: math.quat.create(),
        gunSightArmOffset: { x: 0, y: 0, z: 0 },
        gunSightCamera: null,
        gunSightMix: 0,
        magazineModels: [weapon.spareAmmo.length > 0 ? createMagazineModel() : null, weapon.spareAmmo.length > 1 ? createMagazineModel() : null],
        meleePoints: meleeExtremes(cave.parts.club.geometry),
        clubSlingProfile: clubSlingProfile(cave.parts.club.geometry),
        clubTorsoBounds: BL.scene.boundsOf(cave.parts.torso.geometry),
        work: { phase: "", site: 0, plannedSite: -1, targetReady: false, aimReady: false, aimSample: i, index: 0, place: -1, blocked: false, blockedTime: 0, gait: 0, timer: i * 0.137, emptyTime: 0, rest: 0, reloadSlot: false, direct: false, position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } },
        slot: null,
        pileApproach: false,
        index: i,
        bedroll: null,
        bedTravel: { mode: "", route: null, plan: null, index: 0, toBed: false, bed: null, manual: false, pose: "left", roll: 1, phase: 0, blocked: 0, retry: 0, fromX: 0, fromY: 0, fromZ: 0, fromYaw: 0, fromHeadX: 0, fromHeadY: 0, fromHeadZ: 0, fromArmRX: 0, fromArmLX: 0, fromArmRZ: 0, fromArmLZ: 0, armRX: 0, armLX: 0, armRZ: 0, armLZ: 0, compression: SLEEP_COMPRESSION, fromCompression: SLEEP_COMPRESSION, restY: 0, restZ: 0, pitch: 0, headDrop: 0, headDropX: 0, headDropY: 0, headDropZ: 0 },
        sleepHead: { x: 0, y: 0, z: 0 },
        sleepWeapons: createNode({ visible: false }),
        headLookRotation: math.quat.create(), headLookPosition: { x: 0, y: 0, z: 0 },
        sleepRotation: math.quat.create(), sleepFromRotation: math.quat.create(), sleepTargetRotation: math.quat.create(),
        sleepParts: { armRX: cave.parts.armR.position.x, armLX: cave.parts.armL.position.x, headX: cave.parts.head.position.x, headY: cave.parts.head.position.y, headZ: cave.parts.head.position.z, equipment: cave.root.children.filter((node) => !BODY_PARTS.some((key) => cave.parts[key] === node)) },
        phase: i * 1.37,
        baseY: cave.root.position.y,
        restLower: 0,
        camp: { seat: null, burning: false, rolling: false, burnAge: 0, reactionDelay: 0, ignitions: 0, contactBurning: false, contactBounds: new Float64Array(6), panic: { active: false, threat: null, remembered: false, memory: new Float64Array(contributors.roster.length * 4), gorillaMemory: new Float64Array(contributors.roster.length * 4), speed: 0, heading: 0, turnAt: 0, phase: 0, escapeX: 0, escapeZ: 0, resumeSleep: false, resumeWalk: null, rand: math.mulberry32(math.fnv1a(contributor.name + "/panic")) }, rollTime: 0, soot: 0, fadeTime: 0, puff: 0, smokeTime: 0, cooldown: 0, spread: new Float32Array(BODY_PARTS.length), burnTime: new Float32Array(BODY_PARTS.length), scorch: new Float32Array(BODY_PARTS.length), rollScorch: new Float32Array(BODY_PARTS.length), x: 0, z: 0, floor: 0, heading: 0, rotation: math.quat.create(), base: math.quat.create(), turn: math.quat.create() },
        bodyHeight: bodyHeightOf(cave),
        bodyRadius: bodyRadiusOf(cave),
        shoulder: { phase: 0, other: null, rear: false, prop: false, side: 1, dodge: 1, amount: 0, yaw: 0, targetYaw: 0, attempted: false, originX: 0, originZ: 0, forwardX: 0, forwardZ: 1, heading: 0, snapX: 0, snapZ: 0, motionX: 0, motionZ: 0, snapVX: 0, snapVZ: 0, propOffset: 0, obstacle: { node: null, minAlong: 0, maxAlong: 0, minAcross: 0, maxAcross: 0, minContactAcross: 0, maxContactAcross: 0 } },
        state: "away",
        humanControlled: false,
        contributor,
        zzzTimer: 0,
        build: null,
        walk: null,
        pathing: ctx.npcPaths ? ctx.npcPaths.createState() : null,
        traffic: { moving: false, waiting: false, leader: null, crossing: null, tx: 0, tz: 0, fx: 0, fz: 1, distance: 0, speed: 0 },
        progress: { x: NaN, z: NaN, stalled: 0, motionless: 0, retry: 0, replanned: false, navigationHop: false, escaped: false,
          backoff: 0, backX: 0, backZ: 0, detours: 0, replans: 0, resets: 0, roofTime: 0 },
        roofEscape: { active: false, jumping: false, blocked: 0 },
        ladder: ctx.ladders ? { plane: null, cooldown: 0, across: 0, along: 0, descentHeld: false, mix: 0,
          flat: { width: 0, depth: 0, overlap: 0 }, vertical: { width: 0, height: 0, overlap: 0 } } : null,
        avoidance: { active: false, side: i & 1 ? 1 : -1, stalled: 0, best: Infinity, tx: NaN, tz: NaN, goalX: NaN, goalZ: NaN, pathIndex: -1, pathVersion: -1,
          detour: { site: -1, phase: 0, side: 1, entryX: 0, goalX: NaN, goalZ: NaN, x: 0, z: 0 },
          navigation: { mode: 0, x: 0, z: 0, count: 0, index: 0, searches: 0, expansions: 0,
            jumpCandidate: 0, jumps: 0, jumpX: 0, jumpZ: 0, clearance: 0, double: false, boosted: false, moving: false,
            costs: new Float32Array(NAV_SIZE), parents: new Int16Array(NAV_SIZE), heights: new Float32Array(NAV_SIZE), closed: new Uint8Array(NAV_SIZE), path: new Int16Array(NAV_SIZE) } },
        hop: 0,
        hopV: 0,
        jumps: 0,
        rocketJumpTime: 0, rocketJumpHeld: false, rocketPuff: 0,
        breathAt: 15 + Math.random() * 15,
        breathPuffs: 0,
        breathTotal: 12,
        breathCount: 0,
        breathHugeAt: 4 + Math.floor(Math.random() * 3),
        breathHuge: false,
        breathMerge: 0,
        breathSerial: 0,
        breathSmoke: [],
        breathClusters: null,
        breathBatch: null,
        cheer: 0,
        catchT: 0,
        yawn: 0,
        yawnAt: 12 + i * 4.3 + Math.random() * 20,
        leap: { vx: 0, vz: 0, land: 0, thrown: false, rageThrown: false },
        highlightTarget: 0,
        highlight: 0,
        nextBuildAt: 8 + i * 2.5 + Math.random() * 6,
        jet: null,
        jetpackOwned: false,
        jetpackGeometry: null,
        jetpackFlameGeometry: null,
        jetFuel: 1,
        jetRecovering: false,
        cloudSupport: null,
        riding: { support: null, x: 0, y: 0, z: 0, vy: 0, updated: false, continuous: false },
        grabbedBy: null,
        viewLift: 0,
        peek: 0,
        act: { kind: "eat", until: 0, trips: 0, sayAt: 0, said: true, phase: 0, spot: { x: 0, z: 0, ry: NaN, sit: false } },
        swagNodes: []
      });
      // A character built with its own pack wears it from the first frame and
      // uses the same flight, fuel, recovery and toggle as every other pack.
      if (cave.parts.jetpack && !cave.traits.footRockets) cave.jet = { node: cave.parts.jetpack, flame: cave.parts.jetFlame, thrust: false, spending: false, power: 0, puff: 0 };
      cave.root.visible = false;
      addChild(root, cave.root);
      addChild(root, cave.sleepWeapons);
      if (cave.traits.gasMask) {
        // Fixed-capacity reusable puffs keep normal and huge exhales from growing the FX pool; geometry stays resident.
        cave.breathBatch = createNode({ geometry: MASK_SMOKE, sightHidden: true, instanceData: new Float32Array(MASK_SMOKE_CAP * 20), instanceCount: 0, instanceVersion: 0, fixedInstanceCapacity: true });
        cave.breathClusters = new Uint16Array(MASK_SMOKE_CAP);
        addChild(root, cave.breathBatch);
        for (let j = 0; j < MASK_SMOKE_CAP; j++) {
          const node = createNode({ geometry: MASK_SMOKE, sightHidden: true, smokeOpacity: 0, scale: { x: 0, y: 0, z: 0 } });
          cave.breathSmoke.push({ node, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0, size: 0, cubes: 1, serial: 0,
            born: 0, anchor: -1, anchorBorn: 0, phase: j * 2.399, wrapSide: j & 1 ? -1 : 1 });
        }
      }
      cave.hitNodes = [];
      const registerHead = (node, owner) => {
        if (node.geometry) { cave.hitNodes.push(node); input.add(node, owner); }
        for (const child of node.children) registerHead(child, owner);
      };
      for (const key of BODY_PARTS) {
        const owner = { kind: "caveman", cave, priority: 1, hitRegion: key === "head" ? "head" : "body" };
        // The visible helmet/mask can extend well beyond the underlying head.
        // Register its actual surfaces, sharing the head's damage region.
        if (key === "head") registerHead(cave.parts.head, owner);
        else { cave.hitNodes.push(cave.parts[key]); input.add(cave.parts[key], owner); }
      }
      cavemen.set(contributor.name, cave);
      crewList.push(cave);
    });
    const stateOf = (cave) => {
      const activity = contributors.stateFor(cave.contributor);
      return activity === "away" && !ctx.playerName ? "away" : cave.override || activity;
    };
    const groundY = (cave) => {
      const p = cave.root.position;
      const feet = p.y - cave.baseY + cave.restLower;
      return cave.baseY + groundAt(p.x, p.z, feet, feet, cave);
    };
    const grounded = (cave) => cave.bedTravel.mode === "rest" || cave.hop === 0 && cave.hopV <= 0 && Math.abs(cave.root.position.y + cave.restLower - groundY(cave)) < 1e-6;
    const atPile = (cave) => cave.act.kind === "eat" || cave.act.kind === "rush";
    const sleepPriority = (a, b) => (b.contributor.lastContributionAt || b.contributor.lastCommitAt) -
      (a.contributor.lastContributionAt || a.contributor.lastCommitAt) || a.index - b.index;
    // Rooms are reserved only for this nap; the lab keeps its existing bedrolls.
    const claimBedroll = (cave) => {
      if (cave.bedroll && !cave.bedroll.outdoor) return true;
      if (ctx.bedRoute) {
        let available = 0;
        for (const bed of bedrolls) if (!bed.sleeper) available++;
        // Reserve vacancies for more recent sleepers even when their update
        // comes later in stable roster order. Never evict an occupied bed.
        if (available) for (const other of crewList) {
          if (other !== cave && other !== player && (!other.bedroll || other.bedroll.outdoor) && !other.camp.burning && !other.camp.panic.active
            && stateOf(other) === "sleeping" && sleepPriority(other, cave) < 0) available--;
        }
        if (available > 0) for (const bed of bedrolls) if (!bed.sleeper) {
          releaseBedroll(cave); cave.bedroll = bed; bed.sleeper = cave; return true;
        }
        if (cave.bedroll) return true;
        for (const bed of ctx.outdoorBedrolls || []) if (!bed.sleeper) { cave.bedroll = bed; bed.sleeper = cave; return true; }
        return false;
      }
      cave.bedroll = bedrolls.find((bed) => !bed.sleeper) || bedrolls[cave.index % bedrolls.length];
      if (!cave.bedroll.sleeper) cave.bedroll.sleeper = cave;
      return true;
    };
    const releaseBedroll = (cave) => {
      if (cave.bedroll && cave.bedroll.sleeper === cave) {
        cave.bedroll.sleeper = null;
      }
      cave.bedroll = null;
    };
    const stateCounts = () => {
      const counts = { working: 0, chilling: 0, sleeping: 0, away: 0 };
      for (let i = 0; i < crewList.length; i++) counts[crewList[i].state]++;
      return counts;
    };
    const workingCavemen = () => [...cavemen.values()].filter((c) => c.state === "working" && !c.walk && !c.bedTravel.mode);
    const workingCount = () => {
      let n = 0;
      for (let i = 0; i < crewList.length; i++) {
        const c = crewList[i];
        if (c.state === "working" && !c.walk && !c.bedTravel.mode) n++;
      }
      return n;
    };
    const eatingCount = () => {
      let n = 0;
      for (let i = 0; i < crewList.length; i++) {
        const c = crewList[i];
        if (c.state === "working" && !c.walk && !c.build && atPile(c)) n++;
      }
      return n;
    };
    const eatingCavemen = () => [...cavemen.values()].filter((c) => c.state === "working" && !c.walk && !c.build && atPile(c));
    const feedableCavemen = () => [...cavemen.values()].filter((c) => c.root.visible && (c.state === "working" || c === player));
    const releaseBuild = (cave) => {
      if (!cave.build) return;
      if (!cave.build.built) buildSpots.push(cave.build.spot);
      cave.build = null;
    };
    const clearHeadLook = (cave) => {
      const head = cave.parts.head;
      if (head.quaternion !== cave.headLookRotation) return;
      head.quaternion = null;
      setVec(head.position, cave.headLookPosition.x, cave.headLookPosition.y, cave.headLookPosition.z);
    };
    const clearShoulder = (cave) => {
      const s = cave.shoulder;
      s.phase = s.yaw = s.targetYaw = 0;
      s.other = null;
      s.obstacle.node = null;
      s.rear = s.prop = false;
      s.motionX = s.motionZ = 0;
      s.attempted = false;
      for (let i = 0; i < cave.root.children.length; i++) cave.root.children[i].poseYaw = 0;
    };
    const takeBedWeapons = (cave) => {
      const rest = cave.sleepWeapons, parts = cave.parts;
      if (parts.gun.parent !== rest) return;
      removeChild(rest, parts.club); addChild(parts.armR, parts.club);
      removeChild(rest, parts.gun); addChild(cave.root, parts.gun);
      if (cave.jet && !builtInJetpack(cave) && cave.jet.node.parent === rest) {
        removeChild(rest, cave.jet.node);
        cave.jet = null;
      }
      parts.club.quaternion = null;
      setVec(parts.club.position, 0, -0.62 * cave.traits.height, 0.08 * cave.traits.height);
      setVec(parts.club.rotation, cave.clubRest.x, 0, cave.clubRest.z);
      rest.visible = false;
      if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
    };
    const leanBedWeapon = (node, geometry, x, wall) => {
      node.poseYaw = 0;
      setVec(node.position, 0, 0, 0);
      BL.scene.updateWorld(node);
      const verts = geometry.verts, m = node.world;
      let bottom = Infinity, rear = Infinity;
      for (let i = 0; i < verts.length; i += 3) {
        bottom = Math.min(bottom, m[1] * verts[i] + m[5] * verts[i + 1] + m[9] * verts[i + 2]);
        rear = Math.min(rear, m[2] * verts[i] + m[6] * verts[i + 1] + m[10] * verts[i + 2]);
      }
      setVec(node.position, x, -bottom, wall - rear);
    };
    const putBedWeapons = (cave) => {
      const rest = cave.sleepWeapons, parts = cave.parts, bed = cave.bedroll;
      removeChild(parts.club.parent, parts.club); addChild(rest, parts.club);
      removeChild(parts.gun.parent, parts.gun); addChild(rest, parts.gun);
      setVec(rest.position, bed.x, bed.y === undefined ? 0 : bed.y, bed.z);
      setVec(rest.rotation, 0, bed.node ? bed.node.rotation.y : (bed.ry || 0) - Math.PI / 2, 0);
      rest.visible = cave.root.visible && !bed.outdoor;
      rest.matrixLiving = !!cave.root.matrixLiving;
      parts.club.visible = cave.weapon.primaryOwned;
      parts.gun.visible = cave.weapon.secondaryOwned;
      parts.club.quaternion = null;
      parts.gunFlash.visible = false;
      if (cave.jetpackOwned && !cave.jet && cave.jetpackGeometry && !builtInJetpack(cave)) makeJetpack(cave, cave.jetpackGeometry, cave.jetpackFlameGeometry);
      if (cave.jet && !builtInJetpack(cave)) {
        if (cave.jet.node.parent) removeChild(cave.jet.node.parent, cave.jet.node);
        addChild(rest, cave.jet.node);
        cave.jet.node.quaternion = null;
        setVec(cave.jet.node.rotation, -0.18, 0, 0);
        cave.jet.flame.visible = false;
      }
      // Both actual weapons stand on the floor and lean into the head wall.
      // Keeping them outside the body also excludes them from mattress fitting.
      const wall = bed.sleep ? -bed.sleep.depth / 2 - bed.sleep.wallInset + 0.015 : -1.15;
      setVec(parts.club.rotation, -0.18, 0, 0);
      math.quat.fromEuler(parts.gun.quaternion, -Math.PI / 2 - 0.18, 0, Math.PI / 2);
      leanBedWeapon(parts.club, parts.club.geometry, -0.48, wall);
      leanBedWeapon(parts.gun, parts.gunBody.geometry, 0.48, wall);
      if (cave.jet && !builtInJetpack(cave)) leanBedWeapon(cave.jet.node, cave.jet.node.geometry, 0, wall);
      if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
    };
    const resetPose = (cave) => {
      cave.root.position.y += cave.restLower; cave.restLower = 0;
      if (cave.ladder) { cave.ladder.plane = null; cave.ladder.mix = 0; cave.ladder.cooldown = 0; }
      cave.roofEscape.active = cave.roofEscape.jumping = false; cave.roofEscape.blocked = 0;
      clearMeleeThrust(cave);
      takeBedWeapons(cave);
      clearHeadLook(cave);
      clearShoulder(cave);
      Object.assign(cave.root.rotation, { x: 0, y: 0, z: 0 });
      cave.root.quaternion = null;
      Object.assign(cave.root.scale, { x: 1, y: 1, z: 1 });
      Object.assign(cave.parts.armR.rotation, { x: -0.2, y: 0, z: -0.12 });
      Object.assign(cave.parts.armL.rotation, { x: -0.2, y: 0, z: 0.12 });
      cave.parts.armL.quaternion = cave.parts.armR.quaternion = null;
      cave.parts.legR.rotation.x = 0;
      cave.parts.legL.rotation.x = 0;
      cave.parts.legR.rotation.z = cave.parts.legL.rotation.z = 0;
      cave.parts.head.rotation.x = 0;
      cave.parts.head.rotation.y = 0;
      cave.parts.head.position.x = cave.sleepParts.headX;
      cave.parts.head.position.y = cave.sleepParts.headY + cave.viewLift;
      cave.parts.head.position.z = cave.sleepParts.headZ;
      cave.parts.armR.position.x = cave.sleepParts.armRX;
      cave.parts.armL.position.x = cave.sleepParts.armLX;
      cave.parts.torso.scale.y = 1;
      cave.parts.club.visible = cave.weapon.primaryOwned;
      for (const node of cave.sleepParts.equipment) node.visible = true;
      for (const node of cave.swagNodes) node.visible = true;
      if (builtInJetpack(cave)) cave.parts.jetpack.visible = !!cave.jet || cave.rocketJumpTime > 0;
      cave.parts.snack.visible = false;
      cave.parts.gun.visible = false;
      cave.yawn = 0;
    };
    // Online (the green dot) is a player driving this Ooga: a signed-in player elsewhere (`remoteControlled`,
    // set by the hub's remote-player pool while it shows them), or this visitor, when the scene's
    // `localOnline` says this page counts (signed in, on a page with accounts); without it, any driver does.
    const refreshRosterRow = (cave) => {
      const local = cave.humanControlled && (!ctx.localOnline || ctx.localOnline());
      hud.setRosterRow(cave.traits.name, cave.state, contributors.ageLabel(cave.contributor), local || !!cave.remoteControlled);
    };
    let player = null;
    const magazineCount = (cave = player) => cave ? cave.weapon.spareAmmo.length : 0;
    const magazineAmmo = (cave = player, index = 0) => cave ? cave.weapon.spareAmmo[index] || 0 : 0;
    const hasMagazine = (cave = player) => magazineCount(cave) > 0;
    const totalAmmo = (cave = player) => {
      if (!cave) return 0;
      let total = cave.weapon.ammo;
      for (let i = 0; i < cave.weapon.spareAmmo.length; i++) total += cave.weapon.spareAmmo[i];
      return total;
    };
    const fullestMagazine = (cave) => {
      const ammo = cave.weapon.spareAmmo;
      let selected = 0;
      for (let i = 1; i < ammo.length; i++) if (ammo[i] > ammo[selected]) selected = i;
      return selected;
    };
    const nextReloadMagazine = (cave) => {
      const ammo = cave.weapon.spareAmmo;
      let selected = -1, rounds = -1;
      for (let i = 0; i < ammo.length; i++) if (ammo[i] < AMMO_MAX && ammo[i] > rounds) {
        selected = i;
        rounds = ammo[i];
      }
      return selected;
    };
    const reloadingSpare = (cave) => hasMagazine(cave) && cave.weapon.reloadSpare;
    const syncMagazineSlot = (holder, index) => {
      if (index >= holder.weapon.spareAmmo.length) {
        const model = holder.magazineModels[index];
        if (model && model.node.parent) {
          removeChild(model.node.parent, model.node);
          return true;
        }
        return false;
      }
      const magazineModel = holder.magazineModels[index];
      const magazineHandRotation = magazineModel.handRotation, magazineArmRotation = magazineModel.armRotation;
      const magazineArmStart = magazineModel.armStart, magazineArmRest = magazineModel.armRest;
      const node = magazineModel.node, loading = reloadingSpare(holder) && holder.weapon.reloadMagazine === index;
      node.visible = !(holder.state === "sleeping" && holder.bedroll?.outdoor);
      const swapping = holder.weapon.swapTime > 0 && holder.weapon.swapMagazine === index;
      const parent = swapping ? holder.root : loading ? holder.parts.armR : holder.parts.torso;
      const attached = !node.parent;
      if (node.parent !== parent) {
        if (node.parent) removeChild(node.parent, node);
        if (parent) addChild(parent, node);
      }
      const h = holder.traits.height;
      const hip = holder.clubTorsoBounds.max[0];
      const beltZ = holder.parts.legL.position.z + (holder.weapon.spareAmmo.length === 2 ? index === fullestMagazine(holder) ? 0.095 : -0.085 : 0) * h;
      node.poseYaw = swapping ? holder.parts.torso.poseYaw : 0;
      if (swapping) {
        // The left hand brings the spare from its hip to the lowered rifle,
        // then returns the old magazine to its ranked place on the left hip.
        const parts = holder.parts, torso = parts.torso, gun = parts.gun, arm = parts.armL;
        const progress = 1 - holder.weapon.swapTime / MAGAZINE_SWAP_TIME;
        const blend = ease.inOutQuad(1 - Math.abs(progress * 2 - 1));
        if (arm.quaternion) magazineArmRest.set(arm.quaternion);
        else math.quat.fromEuler(magazineArmRest, arm.rotation.x, arm.rotation.y, arm.rotation.z);
        math.quat.fromEuler(magazineHandRotation, torso.rotation.x, torso.rotation.y, torso.rotation.z);
        math.quat.rotateVec(MUZZLE, magazineHandRotation, hip * torso.scale.x + 0.039 * h, 0.035 * h * torso.scale.y, beltZ);
        const hipX = torso.position.x + MUZZLE[0], hipY = torso.position.y + MUZZLE[1], hipZ = torso.position.z + MUZZLE[2];
        math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.1825 * h, 0.0675 * h);
        setVec(node.position, lerp(hipX, gun.position.x + MUZZLE[0] + 0.1 * h, blend), lerp(hipY, gun.position.y + MUZZLE[1], blend), lerp(hipZ, gun.position.z + MUZZLE[2], blend));
        math.quat.slerpTo(magazineHandRotation, gun.quaternion, blend);
        node.quaternion = magazineHandRotation;
        setVec(node.scale, h, h, h);
        math.quat.rotateVec(MUZZLE, magazineHandRotation, 0, 0.08 * h, 0);
        const dx = node.position.x - MUZZLE[0] - arm.position.x, dy = node.position.y - MUZZLE[1] - arm.position.y, dz = node.position.z - MUZZLE[2] - arm.position.z;
        const length = Math.hypot(dx, dy, dz), reach = Math.hypot(0.625, 0.15), ax = -0.15 / reach, ay = -0.625 / reach;
        GUN_ARM[0] = ay * dz / length; GUN_ARM[1] = -ax * dz / length;
        GUN_ARM[2] = (ax * dy - ay * dx) / length; GUN_ARM[3] = 1 + (ax * dx + ay * dy) / length;
        math.quat.normalize(GUN_ARM);
        math.quat.fromEuler(GUN_GRIP, 0, -Math.PI / 2, 0);
        math.quat.multiply(GUN_SWAP_TARGET, GUN_ARM, GUN_GRIP);
        magazineArmRotation.set(progress < 0.5 ? magazineArmStart : magazineArmRest);
        math.quat.slerpTo(magazineArmRotation, GUN_SWAP_TARGET, blend);
        arm.quaternion = magazineArmRotation;
      } else if (loading) {
        // Rest the shell's end on the inward-facing fingertips, leaving
        // the window clear at the raised rifle magazine's sideways angle.
        if (!parent.quaternion) math.quat.fromEuler(GUN_ARM, parent.rotation.x, parent.rotation.y, parent.rotation.z);
        const q = parent.quaternion || GUN_ARM;
        FINGER_INVERSE[0] = -q[0]; FINGER_INVERSE[1] = -q[1]; FINGER_INVERSE[2] = -q[2]; FINGER_INVERSE[3] = q[3];
        math.quat.fromEuler(GUN_GRIP, -Math.PI / 2, Math.PI / 2, 0);
        math.quat.multiply(magazineHandRotation, FINGER_INVERSE, GUN_GRIP);
        node.quaternion = magazineHandRotation;
        math.quat.rotateVec(MUZZLE, magazineHandRotation, 0, -0.07 * h, 0);
        setVec(node.position, MUZZLE[0], -0.58 * h + MUZZLE[1], 0.25 * h + MUZZLE[2]);
        setVec(node.scale, h, h, h);
      } else {
        // Both spares sit side by side on the anatomical left hip. The
        // fullest is forward; ties keep slot order and both curve alike.
        node.quaternion = null;
        setVec(node.rotation, 0, 0, 0);
        setVec(node.position, hip + 0.039 * h / parent.scale.x, 0.035 * h, beltZ / parent.scale.z);
        setVec(node.scale, h / parent.scale.x, h, h / parent.scale.z);
      }
      magazineModel.setAmmo(holder.weapon.spareAmmo[index]);
      return attached;
    };
    const syncMagazineHolder = (holder) => {
      let changed = syncMagazineSlot(holder, 0);
      changed = syncMagazineSlot(holder, 1) || changed;
      if (changed && ctx.refreshMirrorObject) ctx.refreshMirrorObject(holder.root);
      return changed;
    };
    const syncMagazine = (holder = null) => {
      let changed = false;
      if (holder) changed = syncMagazineHolder(holder);
      else for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        changed = syncMagazineHolder(crewList[caveIndex]) || changed;
      }
      if (changed && ctx.onModelChange) ctx.onModelChange();
    };
    const collectMagazine = (cave = player) => {
      if (!cave) return false;
      const w = cave.weapon;
      if (w.reloading || w.swapTime || w.reloadHandoff) return false;
      if (w.spareAmmo.length < 2) {
        const index = w.spareAmmo.length;
        if (!cave.magazineModels[index]) cave.magazineModels[index] = createMagazineModel();
        w.spareAmmo.push(AMMO_MAX);
      } else {
        let lowest = -1, ammo = w.ammo;
        for (let i = 0; i < w.spareAmmo.length; i++) if (w.spareAmmo[i] <= ammo) { lowest = i; ammo = w.spareAmmo[i]; }
        if (ammo >= AMMO_MAX) return false;
        if (lowest < 0) { stopBurst(cave); w.ammo = AMMO_MAX; }
        else w.spareAmmo[lowest] = AMMO_MAX;
      }
      syncMagazine(cave);
      return true;
    };
    const collectAmmo = (amount, cave = player) => {
      if (!cave) return 0;
      const w = cave.weapon;
      let remaining = Math.max(0, Math.floor(amount));
      const supplied = remaining;
      // Fill the AK first, then the fullest unfinished spare and the last spare.
      // The caller consumes the pickup even when all capacity is already full.
      for (let pass = 0; pass < 3 && remaining; pass++) {
        const selected = w.ammo < AMMO_MAX ? -1 : nextReloadMagazine(cave);
        const ammo = selected < 0 ? w.ammo : w.spareAmmo[selected];
        if (ammo >= AMMO_MAX) break;
        const rounds = Math.min(remaining, AMMO_MAX - ammo);
        if (selected < 0) w.ammo += rounds;
        else w.spareAmmo[selected] += rounds;
        remaining -= rounds;
      }
      syncMagazine(cave);
      return supplied - remaining;
    };
    // Ground magazines remain physical inventory until they are empty. A cave
    // with a free spare slot takes the magazine itself; a cave already carrying
    // two spares only draws the rounds its existing magazines can hold.
    const collectGroundMagazine = (amount, cave = player) => {
      const available = Math.max(0, Math.floor(amount));
      if (!cave) return available;
      const w = cave.weapon;
      if (w.reloading || w.swapTime || w.reloadHandoff) return available;
      if (w.spareAmmo.length < 2) {
        const index = w.spareAmmo.length;
        if (!cave.magazineModels[index]) cave.magazineModels[index] = createMagazineModel();
        w.spareAmmo.push(Math.min(AMMO_MAX, available));
        syncMagazine(cave);
        return Math.max(0, available - AMMO_MAX);
      }
      return available - collectAmmo(available, cave);
    };
    const removeMagazines = (cave = player) => {
      if (!cave) return 0;
      const count = magazineCount(cave);
      if (!count) return 0;
      stopReload(cave, true);
      cave.weapon.spareAmmo.length = 0;
      syncMagazine(cave);
      return count;
    };
    // World-space drive vector plus signed close-view intent. Reused every frame.
    const steer = { x: 0, z: 0, view: 0, forward: 0, strafe: 0, speed: 1, peek: 0 };
    // Bed routes are planned a slice at a time (`stepPlans`, PLAN_MS of each frame, one Ooga after another), so a poll
    // that wakes every sleeper at once never stalls a frame. A grounded Ooga waits where it stands until its route is
    // ready; it is planned from that same spot, so it is the route an unbroken plan would have made.
    const PLAN_MS = 4, planQueue = [];
    const finishBedRoute = (cave, route) => {
      const travel = cave.bedTravel;
      travel.plan = null;
      travel.route = route;
      travel.mode = route ? "walk" : "waiting";
      if (route) cave.cloudSupport = null;
      travel.retry = 1;
    };
    const stepPlans = () => {
      if (!planQueue.length) return;
      const until = performance.now() + PLAN_MS;
      while (planQueue.length && performance.now() < until) {
        const cave = planQueue[0], travel = cave.bedTravel, planning = travel.plan;
        // A trip changed or ended while it waited (it stood up, lay down, was taken over) drops its plan.
        if (!planning || travel.mode !== "waiting") { travel.plan = null; planQueue.shift(); continue; }
        const step = planning.next();
        if (step.done) { planQueue.shift(); finishBedRoute(cave, step.value); }
      }
    };
    // Feet below the home island's surface mean its headquarters only over the home island itself: a scene with
    // ground lower than that elsewhere (the Mempool island's chamber) says where through `ctx.underHome`.
    const underHome = (x, z) => !ctx.underHome || ctx.underHome(x, z);
    const startBedRoute = (cave, bed, toBed) => {
      const travel = cave.bedTravel;
      cave.avoidance.tx = NaN;
      if (!toBed && cave.state === "working") {
        const slot = closestSlot(cave);
        if (slot) cave.slot = slot;
      }
      const ground = groundY(cave), airborne = cave.hop > 0 || cave.hopV > 0 || cave.root.position.y - ground > 0.1;
      travel.plan = null;
      if (!airborne && ctx.bedPlan) {
        cave.root.position.y = ground;
        travel.plan = ctx.bedPlan(cave, bed, toBed);
        if (!planQueue.includes(cave)) planQueue.push(cave);
        travel.route = null;
        travel.index = travel.phase = travel.blocked = 0;
        travel.toBed = toBed;
        travel.bed = bed;
        travel.mode = "waiting";
        travel.retry = 1;
        cave.walk = null;
        cave.act.kind = toBed ? "bed" : "return";
        return;
      }
      travel.route = airborne ? null : ctx.bedRoute(cave, bed, toBed);
      if (airborne) cave.hop = Math.max(cave.hop, cave.root.position.y - ground);
      else cave.root.position.y = ground;
      travel.index = travel.phase = travel.blocked = 0;
      travel.toBed = toBed;
      travel.bed = bed;
      travel.mode = airborne ? "landing" : travel.route ? "walk" : "waiting";
      if (travel.route) cave.cloudSupport = null;
      travel.retry = 1;
      cave.walk = null;
      cave.act.kind = toBed ? "bed" : "return";
    };
    const standFromBed = (cave) => {
      const travel = cave.bedTravel, lying = travel.mode === "rest" || travel.mode === "lie";
      if (lying) cave.root.position.y = cave.baseY + (cave.bedroll.y === undefined ? groundAt(cave.root.position.x, cave.root.position.z, Infinity, Infinity, cave) : cave.bedroll.y);
      resetPose(cave);
      if (lying) {
        cave.hop = cave.hopV = cave.jumps = 0;
        cave.leap.vx = cave.leap.vz = cave.leap.land = 0;
        cave.cloudSupport = null;
      }
      cave.cheer = cave.catchT = 0;
      travel.mode = "";
      travel.route = null;
      travel.plan = null;
      travel.manual = false;
    };
    const startSleep = (cave, settle = false) => {
      const r = cave.root, visible = r.visible;
      if (cave === player) release();
      standFromBed(cave);
      releaseBuild(cave);
      removeJetpack(cave);
      stopReload(cave);
      cave.work.phase = "";
      cave.work.plannedSite = -1; cave.work.targetReady = cave.work.aimReady = false;
      cave.state = "sleeping";
      cave.parts.head.geometry = cave.headOpen;
      r.visible = true;
      if (!visible && !settle) setVec(r.position, walkIn.x, cave.baseY + groundAt(walkIn.x, walkIn.z, Infinity, Infinity, cave), walkIn.z);
      if (claimBedroll(cave)) {
        if (settle || cave.bedroll.outdoor) {
          // An existing sleeper is already in bed on entry. Reuse the final
          // lie-down pose without planning or animating a trip from the pile.
          cave.walk = null;
          cave.act.kind = "bed";
          cave.bedTravel.toBed = true;
          cave.bedTravel.bed = cave.bedroll;
          lieDown(cave);
          cave.bedTravel.phase = 1;
          runBed(cave, 0);
        } else startBedRoute(cave, cave.bedroll, true);
      }
      else {
        // A full HQ must not leave new sleepers at the model origin inside the pile.
        // Reuse the scene's collision- and occupancy-checked recovery spots; if all
        // are occupied, remain hidden and retry instead of stacking at a fallback.
        cave.walk = null;
        cave.act.kind = "bed";
        if (!visible || settle) {
          r.visible = !!ctx.npcRecoverySpot && ctx.npcRecoverySpot(cave, NPC_RECOVERY_SPOT);
          if (r.visible) setVec(r.position, NPC_RECOVERY_SPOT.x, cave.baseY + NPC_RECOVERY_SPOT.y, NPC_RECOVERY_SPOT.z);
          cave.hop = cave.hopV = 0;
        }
        cave.bedTravel.mode = "waiting"; cave.bedTravel.toBed = true; cave.bedTravel.retry = 1;
      }
      refreshRosterRow(cave);
    };
    const applyState = (cave, state, settle = false) => {
      if (cave.grabbedBy) {
        if (cave.state === state) return;
        if (ctx.releaseGrabbed) ctx.releaseGrabbed(cave);
      }
      if (cave.camp.burning || cave.camp.panic.active) return;
      const wasAwake = cave.state === "working" || cave.state === "chilling";
      if (cave.state === state) {
        // Same-state call still re-seats a moved eater; it must interrupt nothing else.
        if (state === "working") walkToSlot(cave);
        return;
      }
      if (ctx.bedRoute && state === "sleeping") { startSleep(cave, settle && cave.state === "away"); return; }
      if (ctx.bedRoute && cave.state === "sleeping" && (state === "working" || state === "chilling")) { beginWalk(cave, state); return; }
      if (cave === player) release();
      if (ctx.bedRoute || cave.bedTravel.mode) { standFromBed(cave); cave.bedTravel.bed = null; }
      cave.state = state;
      cave.walk = null;
      cave.pileApproach = false;
      if (cave.pathing) { cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count; }
      stopReload(cave);
      cave.work.phase = "";
      cave.work.plannedSite = -1; cave.work.targetReady = cave.work.aimReady = false;
      cave.parts.head.geometry = state === "sleeping" ? cave.headClosed : cave.headOpen;
      resetPose(cave);
      releaseBuild(cave);
      if (state === "sleeping") claimBedroll(cave);
      else releaseBedroll(cave);
      const r = cave.root;
      if (state === "working" || state === "chilling") {
        r.visible = true;
        if (!wasAwake && state === "working") standAtSlot(cave);
        else r.position.y = groundY(cave) + cave.hop;
        if (state === "working") startMeal(cave);
        else if (wanderSpot) {
          if (settle && wanderSpot(cave.act.spot, cave) !== false) {
            const spot = cave.act.spot;
            setVec(r.position, spot.x, cave.baseY + groundAt(spot.x, spot.z, Infinity, Infinity, cave), spot.z);
            if (!Number.isNaN(spot.ry)) r.rotation.y = spot.ry;
            cave.act.kind = "idle";
            cave.act.until = elapsed + chillPause(cave);
          } else startWander(cave);
        } else { cave.act.kind = "idle"; cave.act.until = elapsed + chillPause(cave); }
        if (!wasAwake) popNode(r);
      } else if (state === "sleeping") {
        r.visible = !cave.bedroll.hidden;
        Object.assign(r.position, { x: cave.bedroll.x, y: cave.bedroll.y === undefined ? 0.42 : cave.bedroll.y, z: cave.bedroll.z });
        Object.assign(r.rotation, { x: cave.bedroll.rx || 0, y: cave.bedroll.ry || 0, z: cave.bedroll.rz === undefined ? -Math.PI / 2 : cave.bedroll.rz });
        cave.parts.armR.rotation.x = -1.5;
        cave.parts.armL.rotation.x = -1.5;
        putBedWeapons(cave);
        if (r.visible) popNode(r);
      } else {
        r.visible = false;
      }
      refreshRosterRow(cave);
    };
    const beginWalk = (cave, state = "working") => {
      if (cave === player && cave.bedTravel.manual && cave.state === "sleeping") { wakePlayer(); return; }
      if (cave.state === "away") { applyState(cave, state, true); return; }
      if (ctx.bedRoute && cave.state === "sleeping") {
        // An overflow sleeper may have neither a bed nor a visible waiting spot.
        // Settle a newly active Ooga normally instead of routing from an absent bed.
        if (!cave.bedroll || cave.bedroll.outdoor) {
          standFromBed(cave); releaseBedroll(cave);
          cave.state = "away"; applyState(cave, state, true); return;
        }
        const bed = cave.bedroll;
        standFromBed(cave);
        releaseBedroll(cave);
        cave.state = state;
        cave.parts.head.geometry = cave.headOpen;
        startBedRoute(cave, bed, false);
        refreshRosterRow(cave);
        return;
      }
      const from = cave.state === "sleeping" ? cave.bedroll.wakeAt || cave.bedroll : walkIn;
      const fresh = cave.state !== "sleeping";
      if (cave.bedTravel.mode) standFromBed(cave);
      cave.state = state;
      cave.work.phase = "";
      cave.work.plannedSite = -1; cave.work.targetReady = cave.work.aimReady = false;
      releaseBedroll(cave);
      cave.parts.head.geometry = cave.headOpen;
      cave.walk = { tx: cave.slot.x, tz: cave.slot.z, speed: 2, phase: 0, heading: Math.atan2(cave.slot.x - from.x, cave.slot.z - from.z), to: "slot" };
      cave.avoidance.tx = NaN;
      resetPose(cave);
      releaseBuild(cave);
      cave.act.kind = "eat";
      const r = cave.root;
      r.visible = true;
      Object.assign(r.position, { x: from.x, y: cave.baseY + groundAt(from.x, from.z, Infinity, Infinity, cave), z: from.z });
      r.rotation.y = cave.walk.heading;
      if (state === "working") { walkToSlot(cave, true); cave.walk.speed = 2; }
      else if (wanderSpot) startWander(cave);
      else { cave.walk = null; startMeal(cave); }
      if (fresh) popNode(r);
      refreshRosterRow(cave);
    };
    // FAN_CENTER faces away from viewYaw so eaters gather on the far side of the view.
    const FAN_CENTER = Math.atan2(Math.cos(viewYaw), Math.sin(viewYaw)) + Math.PI;
    const wantedFanRadius = ctx.reloadSlotRadius || (() => Math.max(ctx.pile.footprintEdge, ctx.pile.pileEdge()) + FAN_STANDOFF);
    let fanRadius = ctx.playerName ? 0 : wantedFanRadius();
    const fanSlots = [];
    const assignFanSlots = (entries, isWorking) => {
      const farSide = FAN_CENTER;
      const eaters = entries.filter(isWorking);
      fanSlots.length = 0;
      const count = Math.min(FAN_SLOT_MAX, Math.max(eaters.length, Math.floor(FAN_SPREAD * fanRadius / FAN_ARC) + 1));
      // Growing circumference adds spare slots without widening neighbour spacing or filling the near side.
      const angleStep = Math.min(FAN_ARC / fanRadius, 1.1, FAN_SPREAD / Math.max(1, count - 1));
      for (let i = 0; i < count; i++) {
        const angle = farSide + (i - (count - 1) / 2) * angleStep;
        fanSlots.push({ x: Math.cos(angle) * fanRadius, z: Math.sin(angle) * fanRadius });
      }
      // Spread eaters across the full fan so nobody stands between the camera and the pile.
      eaters.forEach((cave, i) => {
        cave.slot = fanSlots[eaters.length > 1 ? Math.round(i * (count - 1) / (eaters.length - 1)) : Math.floor(count / 2)];
      });
    };
    const slotAvailable = (cave, slot) => {
      const floor = groundAt(slot.x, slot.z, 0, 0, cave);
      if (ctx.npcLandingAllowed && !ctx.npcLandingAllowed(slot.x, floor, slot.z, cave.bodyHeight)) return false;
      for (let index = 0; index < crewList.length; index++) {
        const other = crewList[index];
        if (other === cave || !other.root.visible) continue;
        const p = other.root.position, feet = p.y - other.baseY;
        if (feet < floor + cave.bodyHeight && feet + other.bodyHeight > floor && Math.hypot(p.x - slot.x, p.z - slot.z) < 0.68) return false;
        // Reserve approaching eaters' destinations as well as their bodies; a player can still take the place first.
        if (other !== player && other.walk?.to === "slot" && Math.hypot(other.walk.tx - slot.x, other.walk.tz - slot.z) < 0.68) return false;
        if (other !== player && other.state === "working" && other.work.phase === "return" && other.work.reloadSlot
          && other.slot && Math.hypot(other.slot.x - slot.x, other.slot.z - slot.z) < 0.68) return false;
      }
      return true;
    };
    const closestSlot = (cave, direct = false) => {
      let closest = null, distance = Infinity;
      const p = cave.root.position;
      for (const slot of fanSlots) {
        const d = Math.hypot(slot.x - p.x, slot.z - p.z);
        if (d < distance && slotAvailable(cave, slot) && (!direct || npcWalkable(p.x, p.z, slot.x, slot.z, p.y - cave.baseY, cave.bodyHeight, cave))) { closest = slot; distance = d; }
      }
      return closest;
    };
    const approachPile = (cave) => {
      if (cave.pileApproach) return true;
      const p = cave.root.position;
      if (Math.hypot(p.x, p.z) > fanRadius + 2) return false;
      const slot = closestSlot(cave, true);
      if (!slot) return false;
      // Leave the ring for the nearest reachable vacancy, and keep that
      // reservation until arrival instead of chasing changing path hints.
      cave.slot = slot; cave.pileApproach = true;
      cave.avoidance.tx = NaN;
      return true;
    };
    const standAtSlot = (cave) => {
      setVec(cave.root.position, cave.slot.x, cave.baseY + groundAt(cave.slot.x, cave.slot.z, Infinity, Infinity, cave), cave.slot.z);
      cave.root.rotation.y = Math.atan2(-cave.slot.x, -cave.slot.z);
    };
    let elapsed = 0;
    const startMeal = (cave) => {
      cave.act.kind = cave.state === "working" ? "eat" : "idle";
      cave.act.until = elapsed + (cave.state === "working" ? EAT_MIN + Math.random() * EAT_SPREAD : chillPause(cave));
      cave.act.trips = 0;
      cave.parts.snack.visible = false;
    };
    const walkToSlot = (cave, force = false) => {
      if (cave.state !== "working" || cave.build) return;
      if (cave.bedTravel.mode) return;
      if (!force && !atPile(cave)) return;
      const slot = closestSlot(cave);
      if (slot) cave.slot = slot;
      cave.pileApproach = false;
      if (cave.walk) {
        cave.walk.tx = cave.slot.x;
        cave.walk.tz = cave.slot.z;
        cave.walk.to = "slot";
        if (force) cave.walk.speed = RUSH_SPEED;
        return;
      }
      const { x, z } = cave.root.position;
      if (Math.hypot(cave.slot.x - x, cave.slot.z - z) < 0.15) return;
      cave.walk = { tx: cave.slot.x, tz: cave.slot.z, speed: force ? RUSH_SPEED : 1.6, phase: 0, heading: cave.root.rotation.y, to: "slot" };
      cave.avoidance.tx = NaN;
      cave.parts.snack.visible = false;
      cave.parts.head.rotation.x = 0;
      cave.parts.head.rotation.y = 0;
    };
    const updateFan = () => {
      const wanted = wantedFanRadius();
      if (Math.abs(wanted - fanRadius) < 0.08) return;
      fanRadius = wanted;
      const entries = [...cavemen.values()];
      assignFanSlots(entries, (cave) => cave.state === "working");
      for (const cave of entries) walkToSlot(cave);
    };
    const refreshStates = (settle = false) => {
      if (ctx.playerName) return;
      const entries = [...cavemen.values()];
      const next = new Map(entries.map((cave) => [cave, stateOf(cave)]));
      fanRadius = wantedFanRadius();
      assignFanSlots(entries, (cave) => next.get(cave) === "working");
      // Waking/away actors release beds first; sleepers then claim newest-first.
      entries.sort((a, b) => Number(next.get(a) === "sleeping") - Number(next.get(b) === "sleeping") ||
        (next.get(a) === "sleeping" ? sleepPriority(a, b) : a.index - b.index));
      for (const cave of entries) {
        const target = next.get(cave);
        if (target === "away") { applyState(cave, target, settle); refreshRosterRow(cave); continue; }
        if (cave === player) {
          if (target !== "sleeping" && !cave.bedTravel.manual) cave.state = target;
          refreshRosterRow(cave);
          continue;
        }
        if (!settle && (target === "working" || target === "chilling") && cave.state !== "working" && cave.state !== "chilling") beginWalk(cave, target);
        else applyState(cave, target, settle);
        // State can stay unchanged for hours, but its last-seen label advances
        // every minute and accepted activity may move this row up the roster.
        refreshRosterRow(cave);
        if (cave.traits.stoneAxe) poseWeapon(cave);
      }
    };
    const rush = () => {
      if (!wanderSpot) return;
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const cave = crewList[caveIndex];
        if (workSites) continue;
        if (cave.state !== "working" || cave.build || cave === player) continue;
        cave.act.kind = "rush";
        cave.act.until = elapsed + EAT_MIN + Math.random() * EAT_SPREAD;
        cave.act.trips = 0;
        walkToSlot(cave, true);
        if (!cave.walk) cave.act.kind = "eat";
      }
    };
    const startWander = (cave) => {
      const spot = cave.act.spot;
      if (wanderSpot(spot, cave) === false) {
        cave.walk = null;
        cave.act.kind = "idle";
        cave.act.until = elapsed + chillPause(cave);
        return;
      }
      cave.act.kind = "wander";
      standPose(cave);
      cave.act.trips++;
      cave.walk = { tx: spot.x, tz: spot.z, speed: WANDER_SPEED + Math.random() * 0.5, phase: 0, heading: cave.root.rotation.y, to: "spot" };
      cave.avoidance.tx = NaN;
      cave.parts.snack.visible = false;
      cave.parts.head.rotation.x = 0;
      cave.parts.head.rotation.y = 0;
    };
    const arriveAtSpot = (cave) => {
      const a = cave.act;
      if (!Number.isNaN(a.spot.ry)) cave.root.rotation.y = a.spot.ry;
      a.kind = "idle";
      a.until = elapsed + (cave.state === "chilling" ? chillPause(cave) : IDLE_MIN + Math.random() * IDLE_SPREAD);
      a.sayAt = elapsed + 0.8 + Math.random() * 2;
      a.said = false;
    };
    const headWorldOf = (cave) => cave.bedTravel.mode === "rest" || cave.bedTravel.mode === "lie" ? cave.sleepHead : ({ x: cave.root.position.x, y: cave.state === "sleeping" && !ctx.bedRoute ? 0.5 : cave.root.position.y - cave.baseY + cave.headOffset * 0.95 + cave.viewLift, z: cave.root.position.z });
    const meleePreviousWorld = math.mat4.create(), meleeCurrentWorld = math.mat4.create(), meleeProbeWorld = math.mat4.create(), meleeContactInverse = math.mat4.create();
    const meleeContact = { node: null, owner: null, x: 0, y: 0, z: 0, distance: 0, type: "none" };
    const weaponHit = { node: null, owner: null, x: 0, y: 0, z: 0, distance: 0, type: "none" };
    const weaponCover = { node: null, owner: null, x: 0, y: 0, z: 0, distance: 0, type: "none" };
    const weaponStart = { x: 0, y: 0, z: 0 };
    const weaponOrigin = (out, cave = player, melee = false) => {
      BL.scene.updateWorld(cave.root);
      const node = melee ? cave.parts.armR : cave.parts.gun, h = cave.traits.height;
      math.mat4.transformPoint(MUZZLE, node.world, 0, melee ? 0 : GUN_MUZZLE_Y * h, melee ? 0 : GUN_MUZZLE_Z * h);
      return setVec(out, MUZZLE[0], MUZZLE[1], MUZZLE[2]);
    };
    const meleeReach = (cave = player) => Math.hypot(0.625, 0.15) * cave.traits.height + BL.scene.boundsOf(cave.parts.club.geometry).max[1];
    const weaponContactClear = (from, hit, melee = false) => {
      if (melee && input.weaponTargets) {
        const dx = hit.x - from.x, dy = hit.y - from.y, dz = hit.z - from.z, distance = Math.hypot(dx, dy, dz);
        if (distance > 1e-6 && input.weaponTargets.ray(weaponCover, from.x, from.y, from.z, dx / distance, dy / distance, dz / distance, distance + 1e-5, player)) {
          if (weaponCover.owner !== hit.owner && (!hit.owner.cave || weaponCover.owner.cave !== hit.owner.cave)) return false;
          // A club can touch several faces of the same object at once. Test
          // cover up to its nearest face, not through the object's interior.
          hit = weaponCover;
        }
      }
      if (!ctx.fireReachable) return true;
      const dx = hit.x - from.x, dy = hit.y - from.y, dz = hit.z - from.z, distance = Math.hypot(dx, dy, dz);
      // The exact mesh query already identified this prop's first face. Ignore
      // only that prop during cover clearance: at a grazing angle its padded
      // collision shell can start much farther away than a fixed retreat.
      // Retain the small retreat for terrain touching the contacted surface.
      const k = distance > 0.035 ? 1 - 0.035 / distance : 0;
      return ctx.fireReachable(from.x, from.y, from.z, from.x + dx * k, from.y + dy * k, from.z + dz * k, hit.node, melee);
    };
    const meleePower = (cave = player, charge = 0) => (cave ? 0.25 + 0.75 * clamp((elapsed - cave.weapon.meleeHitAt - MELEE_RECHARGE_DELAY) / MELEE_RECHARGE_TIME, 0, 1) : 1) * (1 + charge);
    const spendMeleePower = (cave) => {
      const w = cave.weapon;
      w.meleePower = meleePower(cave, w.meleeCharge);
      w.meleeHitAt = elapsed;
    };
    const strikeMeleePower = (cave) => cave.weapon.meleePower * MELEE_HIT_POWER * (cave.traits.nunchaku ? NUNCHAKU_POWER : 1);
    const hitMeleeTarget = (cave, powerOverride = null) => {
      const w = cave.weapon, hit = w.meleeTarget;
      if (!hit.node) return false;
      const dx = hit.x - weaponStart.x, dy = hit.y - weaponStart.y, dz = hit.z - weaponStart.z, distance = Math.hypot(dx, dy, dz);
      if (!input.weaponTargets.valid(hit, cave) || distance > meleeReach(cave) + 0.1 || !weaponContactClear(weaponStart, hit, true)) {
        hit.node = hit.owner = null;
        return false;
      }
      w.meleeHit = true;
      const inv = distance > 1e-6 ? 1 / distance : 0;
      // The reticle's in-range object owns this strike. A neighboring prop
      // may stop its visible arc, but cannot steal damage from that target.
      if (hit.node.mirror && ctx.onProjectileMove) {
        ctx.onProjectileMove(hit.x - dx * inv * 0.02, hit.y - dy * inv * 0.02, hit.z - dz * inv * 0.02,
          hit.x + dx * inv * 0.02, hit.y + dy * inv * 0.02, hit.z + dz * inv * 0.02, 0);
      }
      const power = powerOverride === null ? strikeMeleePower(cave) : powerOverride;
      if (ctx.onWeaponHit) ctx.onWeaponHit(cave, hit.type, power);
      if (ctx.onWeaponImpact) ctx.onWeaponImpact(cave, hit, dx * inv, dy * inv, dz * inv, power);
      hit.node = hit.owner = null;
      return true;
    };
    const aimMeleeStrike = (cave) => {
      const w = cave.weapon, hit = w.meleeTarget;
      w.meleeAimX = w.meleeAimY = w.meleeAimZ = 0;
      if (!hit.node) return;
      // Sample the unassisted endpoint once per gesture. The visible hand and
      // weapon can then ease toward the reticle contact without twisting the
      // blade or doing a geometry search on every animation frame.
      const time = w.meleeTime, stop = w.meleeStop;
      w.meleeTime = MELEE_RECOVER; w.meleeStop = 1;
      poseWeapon(cave);
      BL.scene.updateWorld(cave.root);
      const club = cave.parts.club, matrix = club.world, verts = club.geometry.verts;
      let nearest = Infinity, dx = 0, dy = 0, dz = 0;
      for (let i = 0; i < verts.length; i += 3) {
        const x = hit.x - (matrix[0] * verts[i] + matrix[4] * verts[i + 1] + matrix[8] * verts[i + 2] + matrix[12]);
        const y = hit.y - (matrix[1] * verts[i] + matrix[5] * verts[i + 1] + matrix[9] * verts[i + 2] + matrix[13]);
        const z = hit.z - (matrix[2] * verts[i] + matrix[6] * verts[i + 1] + matrix[10] * verts[i + 2] + matrix[14]);
        const distance = x * x + y * y + z * z;
        if (distance < nearest) { nearest = distance; dx = x; dy = y; dz = z; }
      }
      const distance = Math.sqrt(nearest), scale = distance > 0 ? Math.min(1, 0.45 * cave.traits.height / distance) : 0;
      dx *= scale; dy *= scale; dz *= scale;
      const arm = cave.parts.armR, inverse = meleeContactInverse;
      math.mat4.invert(inverse, arm.parent.world);
      const x = inverse[0] * dx + inverse[4] * dy + inverse[8] * dz;
      const y = inverse[1] * dx + inverse[5] * dy + inverse[9] * dz;
      const z = inverse[2] * dx + inverse[6] * dy + inverse[10] * dz;
      const cosine = Math.cos(arm.poseYaw), sine = Math.sin(arm.poseYaw);
      w.meleeAimX = cosine * x - sine * z;
      w.meleeAimY = y;
      w.meleeAimZ = sine * x + cosine * z;
      w.meleeTime = time; w.meleeStop = stop;
      poseWeapon(cave);
      BL.scene.updateWorld(cave.root);
    };
    const meleeSceneryBlocked = (cave, before, after) => {
      if (!ctx.fireReachable) return false;
      const verts = cave.parts.club.geometry.verts;
      // Interactive contacts use the full mesh. Six authored extremities also
      // stop the blade at solid scenery without making terrain pick targets.
      for (let point = 0; point < cave.meleePoints.length; point++) {
        const i = cave.meleePoints[point];
        const x = verts[i], y = verts[i + 1], z = verts[i + 2];
        const ax = before[0] * x + before[4] * y + before[8] * z + before[12];
        const ay = before[1] * x + before[5] * y + before[9] * z + before[13];
        const az = before[2] * x + before[6] * y + before[10] * z + before[14];
        const bx = after[0] * x + after[4] * y + after[8] * z + after[12];
        const by = after[1] * x + after[5] * y + after[9] * z + after[13];
        const bz = after[2] * x + after[6] * y + after[10] * z + after[14];
        if (!ctx.fireReachable(ax, ay, az, bx, by, bz, null, true)) return true;
      }
      return false;
    };
    // Three in-flight rounds per worker keep a synchronized cave volley from
    // recycling another worker's projectile. The visit's roster fixes the cap.
    const bulletPool = Array.from({ length: Math.max(32, workBodyTarget ? crewList.length * BURST_ROUNDS : 0) }, () => {
      const node = createNode({ geometry: models.bananaGeometry(), scale: { x: models.BANANA_AMMO_SCALE, y: models.BANANA_AMMO_SCALE, z: models.BANANA_AMMO_SCALE }, visible: false, matrixLiving: !!ctx.matrixLivingPile });
      addChild(root, node);
      return { node, serial: 0, life: 0, duration: .22, arc: 0, reach: 0, tomato: false, source: null, feedback: false, workShot: false, visual: false, site: -1, aimSample: 0, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 } };
    });
    let bulletIdx = 0, bulletSerial = 0, tomatoesThrown = 0, throwCooldown = 0, tomatoGeometry = null;
    const clearProjectiles = () => { for (const b of bulletPool) { b.life=0; b.node.visible=false; b.source=null; } throwCooldown=0; };
    // Throws share the capped projectile pool, collision callbacks and disposal with gun rounds.
    const throwTomato = () => {
      const cave=player;if(!cave||cave.grabbedBy||throwCooldown>0||cave.health.stunned||cave.state==="sleeping")return false;
      if(!tomatoGeometry)tomatoGeometry=models.merge(models.box({w:.28,h:.24,d:.28,color:"#e34d32"}),models.box({w:.13,h:.07,d:.13,color:"#578544",offset:{x:0,y:.15,z:0}}));
      const b=bulletPool[bulletIdx++%bulletPool.length],p=cave.root.position;
      setVec(b.from,p.x,p.y+cave.traits.height*.45,p.z);
      if(ctx.aimTarget)ctx.aimTarget(b.to);else setVec(b.to,p.x+Math.sin(cave.root.rotation.y)*16,b.from.y,p.z+Math.cos(cave.root.rotation.y)*16);
      const dx=b.to.x-b.from.x,dy=b.to.y-b.from.y,dz=b.to.z-b.from.z,k=Math.min(1,22/(Math.hypot(dx,dy,dz)||1));
      setVec(b.to,b.from.x+dx*k,b.from.y+dy*k-1.4,b.from.z+dz*k);
      if(ctx.clipProjectileTarget)ctx.clipProjectileTarget(b.from,b.to);
      b.node.geometry=tomatoGeometry;setVec(b.node.scale,1,1,1);setVec(b.node.position,b.from.x,b.from.y,b.from.z);
      b.node.visible=true;b.duration=b.life=.8;b.arc=1.8;b.tomato=true;b.source=cave;b.feedback=b.workShot=b.visual=false;
      throwCooldown=.45;tomatoesThrown++;ctx.onTomatoThrow?.(b.from);return true;
    };
    const fireBullet = (cave, spot) => {
      const bullet = bulletPool[bulletIdx++ % bulletPool.length], node = bullet.node;
      bullet.serial = ++bulletSerial;
      node.geometry=models.bananaGeometry();setVec(node.scale,models.BANANA_AMMO_SCALE,models.BANANA_AMMO_SCALE,models.BANANA_AMMO_SCALE);
      bullet.duration=.22;bullet.arc=0;bullet.tomato=false;
      const h = cave.traits.height;
      BL.scene.updateWorld(cave.root);
      math.mat4.transformPoint(MUZZLE, cave.parts.gun.world, 0, GUN_MUZZLE_Y * h, GUN_MUZZLE_Z * h);
      const from = setVec(bullet.from, MUZZLE[0], MUZZLE[1], MUZZLE[2]);
      const to = setVec(bullet.to, spot.x, spot.y === undefined ? groundAt(spot.x, spot.z) + 0.75 : spot.y, spot.z);
      bullet.workShot = cave !== player && !!workBodyTarget && cave.weapon.burstWork;
      bullet.site = cave.work.site;
      bullet.aimSample = cave.work.aimSample;
      const shotClear = bullet.workShot && ctx.workShotClear || ctx.fireReachable;
      if (!bullet.workShot && ctx.continueShot) ctx.continueShot(from, to);
      let surfaceHit = false;
      if (cave === player && input.weaponTargets) {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, distance = Math.hypot(dx, dy, dz);
        // Resolve a real surface before padding truncates the visible shot.
        // The aiming point may itself stop at padded scenery, so continue the
        // same ray through the normal firing range and check intervening cover.
        surfaceHit = distance > 1e-6 && input.weaponTargets.ray(weaponHit, from.x, from.y, from.z, dx / distance, dy / distance, dz / distance, Math.max(60, distance), cave)
          && !weaponHit.node.mirror && weaponContactClear(from, weaponHit);
        if (surfaceHit) setVec(to, weaponHit.x, weaponHit.y, weaponHit.z);
      }
      // A phase doorway consumes the round before scenery or workers behind it.
      if (ctx.clipProjectileTarget && ctx.clipProjectileTarget(from, to)) surfaceHit = false;
      bullet.reach = surfaceHit && weaponHit.owner.kind === "clanker" ? SHOT_SURFACE_REACH : 0;
      if (!surfaceHit && shotClear && !shotClear(from.x, from.y, from.z, to.x, to.y, to.z)) {
        bullet.workShot = false;
        let lo = 0, hi = 1;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) * 0.5;
          if (shotClear(from.x, from.y, from.z, lerp(from.x, to.x, mid), lerp(from.y, to.y, mid), lerp(from.z, to.z, mid))) lo = mid;
          else hi = mid;
        }
        to.x = lerp(from.x, to.x, lo); to.y = lerp(from.y, to.y, lo); to.z = lerp(from.z, to.z, lo);
      }
      const dx = to.x - from.x, dz = to.z - from.z;
      setVec(node.rotation, 0, Math.atan2(dx, dz), 0.6);
      setVec(node.position, from.x, from.y, from.z);
      node.visible = true;
      bullet.life = 0.22;
      bullet.source = cave; bullet.feedback = false; bullet.visual = false;
      // The room's NPC host records each shot for the pages following it (npc-sync.js).
      if (ctx.onShot) ctx.onShot(cave, from, to);
    };
    // A shot replayed from the NPC host: the same flight, with no hits, no mirror crossing and no gorilla
    // impact (the host's events carry those).
    const showShot = (cave, fx, fy, fz, tx, ty, tz) => {
      const bullet = bulletPool[bulletIdx++ % bulletPool.length], node = bullet.node;
      node.geometry=models.bananaGeometry();setVec(node.scale,models.BANANA_AMMO_SCALE,models.BANANA_AMMO_SCALE,models.BANANA_AMMO_SCALE);
      bullet.duration=.22;bullet.arc=0;bullet.tomato=false;
      setVec(bullet.from, fx, fy, fz);
      setVec(bullet.to, tx, ty, tz);
      setVec(node.rotation, 0, Math.atan2(tx - fx, tz - fz), 0.6);
      setVec(node.position, fx, fy, fz);
      node.visible = true;
      bullet.life = 0.22;
      bullet.source = cave; bullet.feedback = true; bullet.workShot = false; bullet.visual = true;
    };
    const updateBullets = (dt) => {
      throwCooldown=Math.max(0,throwCooldown-dt);
      for (let i = 0; i < bulletPool.length; i++) {
        const bullet = bulletPool[i];
        if (bullet.life <= 0) continue;
        const remaining = bullet.life, step = Math.min(dt, remaining), p = bullet.node.position, x = p.x, y = p.y, z = p.z;
        bullet.life = Math.max(0, bullet.life - dt);
        const k = 1 - bullet.life / bullet.duration, from = bullet.from, to = bullet.to;
        if (bullet.visual) {
          setVec(p, lerp(from.x, to.x, k), lerp(from.y, to.y, k), lerp(from.z, to.z, k));
          bullet.node.rotation.x += dt * 24;
          if (!bullet.life) bullet.node.visible = bullet.visual = false;
          continue;
        }
        if (bullet.workShot) {
          // Each round follows its own body anchor as the gorilla runs. Later
          // shots may aim at a different limb without redirecting this one.
          // Interrupted/blocked rounds never count as body impacts.
          if (bullet.source.work.site !== bullet.site || !workBodyTarget(bullet.source, to, bullet.aimSample)) {
            bullet.life = 0; bullet.workShot = false;
          } else {
            const portion = step / remaining;
            const nx = lerp(x, to.x, portion), ny = lerp(y, to.y, portion), nz = lerp(z, to.z, portion);
            const shotClear = ctx.workShotClear || ctx.fireReachable;
            if (shotClear && !shotClear(x, y, z, nx, ny, nz)) { bullet.life = 0; bullet.workShot = false; }
            else setVec(p, nx, ny, nz);
          }
        } else setVec(p, lerp(from.x, to.x, k), lerp(from.y, to.y, k)+bullet.arc*4*k*(1-k), lerp(from.z, to.z, k));
        if(bullet.tomato&&ctx.tomatoContact?.(x,y,z,p))bullet.life=0;
        const absorbed = ctx.absorbProjectile && ctx.absorbProjectile(x, y, z, p, step, bullet.source, bullet.workShot);
        if (absorbed) bullet.life = 0;
        let impacted = false, dx = 0, dy = 0, dz = 0, distance = 0;
        if (!absorbed && !bullet.feedback && !bullet.workShot && !bullet.tomato && input.weaponTargets
          && (bullet.source === player || BL.net && BL.net.state.resolved && !BL.net.state.me)) {
          dx = p.x - x; dy = p.y - y; dz = p.z - z; distance = Math.hypot(dx, dy, dz);
          if (distance > 1e-6 && input.weaponTargets.ray(weaponHit, x, y, z, dx / distance, dy / distance, dz / distance, distance + (bullet.life ? 0 : bullet.reach) + 1e-5, bullet.source)) {
            setVec(weaponStart, x, y, z);
            if (weaponContactClear(weaponStart, weaponHit)) {
              bullet.feedback = true;
              if (!weaponHit.node.mirror) { setVec(p, weaponHit.x, weaponHit.y, weaponHit.z); bullet.life = 0; }
              impacted = true;
            }
          }
        }
        if (ctx.onProjectileMove) ctx.onProjectileMove(x, y, z, p.x, p.y, p.z, step, bullet.source, bullet.workShot);
        // Emit the crossing while the struck glass still exists.
        if (impacted && !bullet.tomato) {
          const power = SHOT_POWER * (weaponHit.owner.hitRegion === "head" ? HEADSHOT_MULTIPLIER : 1);
          if (ctx.onWeaponHit) ctx.onWeaponHit(bullet.source, weaponHit.type, power);
          if (ctx.onWeaponImpact) ctx.onWeaponImpact(bullet.source, weaponHit, dx / distance, dy / distance, dz / distance, power, bullet);
        }
        bullet.node.rotation.x += dt * 24;
        if (!bullet.life) {
          if (bullet.tomato) ctx.onTomatoImpact?.(p);
          if (bullet.workShot && ctx.workHit) ctx.workHit(bullet.source);
          bullet.workShot = false;
          bullet.node.visible = false;
        }
      }
    };
    const seatBlocksWeapons = cave => !!cave.camp.seat && !cave.camp.seat.allowWeapons;
    const stopReload = (cave = player, immediate = false) => {
      if (!cave) return;
      const w = cave.weapon;
      const ready = !immediate && hasMagazine(cave) && w.equipped && cave.root.visible && cave.state !== "sleeping"
        && !cave.bedTravel.mode && !cave.camp.burning && !cave.camp.rolling && !cave.camp.panic.active && !seatBlocksWeapons(cave);
      if (!ready) {
        w.reloadSpare = false;
        w.reloadHandoff = w.reloadHandoffTime = 0;
        w.reloadFire = w.reloadFireHeld = false;
        w.reloadFireRounds = BURST_ROUNDS;
      } else if (w.reloadHandoff > 0 || w.reloadSpare && !w.reloadHandoff) {
        // Reverse an interrupted handoff from its displayed point, rather
        // than restarting with the magazine suddenly back in the raised hand.
        w.reloadHandoffTime = w.reloadHandoff === 2 ? RELOAD_HANDOFF_TIME / 2 + Math.abs(Math.min(RELOAD_HANDOFF_TIME, w.reloadHandoffTime) - RELOAD_HANDOFF_TIME / 2)
          : w.reloadHandoff > 0 ? Math.max(0, RELOAD_HANDOFF_TIME - w.reloadHandoffTime) : RELOAD_HANDOFF_TIME;
        w.reloadHandoff = w.reloadHandoffTime > 0 ? -1 : 0;
      }
      w.reloading = false;
      w.reloadTime = w.reloadStep = 0;
      w.swapTime = 0;
      w.swapCommitted = false;
      cave.parts.snack.visible = false;
    };
    const handoffToSpare = (cave) => {
      const w = cave.weapon;
      const index = nextReloadMagazine(cave);
      if (index < 0) return;
      w.reloadHandoff = w.reloadSpare ? 2 : 1;
      w.reloadNext = index;
      if (!w.reloadSpare) w.reloadMagazine = index;
      w.reloadHandoffTime = RELOAD_FULL_HOLD + RELOAD_HANDOFF_TIME;
      w.reloadTime = w.reloadStep = 0;
      cave.parts.snack.visible = false;
    };
    const reloadRadius = ctx.reloadRadius || (() => Math.max(ctx.pile.footprintEdge, ctx.pile.pileEdge()) + FAN_STANDOFF + 0.55);
    const reloadHeight = ctx.reloadHeight || 0;
    const nearReload = (cave = player) => {
      if (ctx.reloadPolicy) return !!cave && ctx.reloadPolicy.near(cave);
      if (!cave || !cave.weapon.secondaryOwned || !cave.root.visible || cave.health.stunned || cave.state === "sleeping" || cave.camp.burning || cave.camp.rolling || cave.bedTravel.mode || seatBlocksWeapons(cave)) return false;
      const p = cave.root.position, feet = p.y - cave.baseY, reach = reloadRadius() + cave.bodyRadius;
      return p.x * p.x + p.z * p.z <= reach * reach && feet <= reloadHeight + 1.2 && feet + cave.bodyHeight >= reloadHeight - 0.2;
    };
    const reloadMissing = (cave) => AMMO_MAX * (1 + magazineCount(cave)) - totalAmmo(cave);
    const reloadBite = (cave) => {
      const index = nextReloadMagazine(cave);
      return Math.min(AMMO_PER_BANANA, cave.weapon.ammo < AMMO_MAX ? AMMO_MAX - cave.weapon.ammo : index >= 0 ? AMMO_MAX - cave.weapon.spareAmmo[index] : 0);
    };
    const canReload = (cave = player) => {
      if (!cave || cave.grabbedBy || cave !== player && cave.state !== "working" || cave.weapon.swapTime > 0 || cave.weapon.reloadHandoff < 0) return false;
      const missing = reloadMissing(cave);
      return missing > 0 && (ctx.reloadPolicy ? ctx.reloadPolicy.available(cave, reloadBite(cave)) : world.level >= reloadBite(cave) / AMMO_PER_BANANA) && nearReload(cave);
    };
    const startReload = (cave = player) => {
      if (!canReload(cave) || cave.weapon.reloadHandoff) return false;
      stopBurst(cave);
      cave.weapon.equipped = true;
      cave.weapon.primaryEquipped = false;
      cave.weapon.selectedSlot = 2;
      if (!cave.weapon.reloading) cave.weapon.reloadTime = cave.weapon.reloadStep = 0;
      cave.weapon.reloading = true;
      cave.weapon.recoil = 0;
      if (cave.weapon.ammo === AMMO_MAX && !cave.weapon.reloadSpare) {
        // The rifle needs no loading pose. Put it straight on the back and
        // raise the fullest incomplete spare, preserving the handoff only
        // for transitions between two physical spare magazines.
        const index = nextReloadMagazine(cave);
        cave.weapon.reloadSpare = true;
        cave.weapon.reloadMagazine = cave.weapon.reloadNext = index;
        cave.weapon.reloadHandoffFrame = false;
        cave.parts.snack.visible = false;
      }
      return true;
    };
    const toggleWeapon = (cave = player) => selectWeapon(cave && cave.weapon.equipped ? 1 : 2, cave);
    const selectWeapon = (slot, cave = player) => {
      if (!cave || cave.health.stunned || cave.state === "sleeping" || cave !== player && (cave.camp.burning || cave.camp.rolling) || seatBlocksWeapons(cave) || cave.bedTravel.mode) return false;
      if (slot === 1 && !cave.weapon.primaryOwned || slot === 2 && !cave.weapon.secondaryOwned) return false;
      stopBurst(cave); stopReload(cave, true);
      clearGunBashThrust(cave);
      cave.weapon.primaryEquipped = slot === 1;
      cave.weapon.equipped = slot === 2;
      if (slot) cave.weapon.selectedSlot = slot;
      cave.weapon.meleeTime = 0;
      cave.weapon.meleeReadyTime = 0;
      cave.weapon.meleeTarget.node = null;
      cave.weapon.meleeHeld = false;
      cave.weapon.meleeQuick = false;
      cave.weapon.meleeSide = 1; cave.weapon.meleeComboTime = 0;
      cave.weapon.meleeBladeTurn = cave.weapon.meleeEntryBladeTurn = 0;
      cave.weapon.meleeHeldTime = cave.weapon.meleeCharge = 0;
      cave.weapon.meleeStrikeTime = MELEE_STRIKE;
      cave.weapon.meleePower = 1;
      cave.weapon.bashTime = 0;
      cave.weapon.axeIdle = slot === 1 && cave.traits.stoneAxe ? AXE_STICK_DELAY + AXE_STICK_BLEND : 0;
      cave.parts.armR.rotation.y = cave.parts.armL.rotation.y = 0;
      poseWeapon(cave);
      return true;
    };
    const configureWeapon = (cave, slot = 0, ammo = null, unlimited = ammo === "unlimited") => {
      if (!cave) return false;
      if (slot === 1) cave.weapon.primaryOwned = true;
      if (slot === 2) cave.weapon.secondaryOwned = true;
      let changed = slot === 1 || slot === 2 ? selectWeapon(slot, cave) : false;
      const rounds = typeof ammo === "number" || typeof ammo === "string" && ammo.trim() ? Number(ammo) : NaN;
      if (ammo === "unlimited" || Number.isFinite(rounds)) {
        stopBurst(cave); stopReload(cave, true);
        cave.weapon.unlimited = unlimited;
        cave.weapon.ammo = Number.isFinite(rounds) ? Math.floor(clamp(rounds, 0, AMMO_MAX)) : AMMO_MAX;
        poseWeapon(cave);
        changed = true;
      }
      return changed;
    };
    const swingWeapon = (cave = player, held = false, focused = false) => {
      if (!cave || cave.grabbedBy || cave.health.stunned || !cave.weapon.primaryOwned || !cave.weapon.primaryEquipped || cave !== player && (cave.camp.burning || cave.camp.rolling) || cave.camp.seat || cave.bedTravel.mode) return false;
      const w = cave.weapon, arm = cave.parts.armR, club = cave.parts.club;
      if (w.meleeHeld) return false;
      w.meleeSide = w.meleeComboTime > 0 ? -w.meleeSide : 1;
      w.meleeEntryX = arm.rotation.x; w.meleeEntryY = arm.rotation.y; w.meleeEntryZ = arm.rotation.z;
      w.meleeEntryClubZ = club.rotation.z;
      w.meleeEntryBladeTurn = w.meleeBladeTurn;
      if (cave.traits.stoneAxe) {
        if (arm.quaternion) w.meleeAxeArm.set(arm.quaternion);
        else math.quat.fromEuler(w.meleeAxeArm, arm.rotation.x, arm.rotation.y, arm.rotation.z);
        math.quat.fromEuler(GUN_ARM, 0, arm.poseYaw, 0);
        math.quat.multiply(w.meleeAxeArm, GUN_ARM, w.meleeAxeArm);
        if (club.quaternion) w.meleeAxeClub.set(club.quaternion);
        else math.quat.fromEuler(w.meleeAxeClub, club.rotation.x, club.rotation.y, club.rotation.z);
        const q = w.meleeAxeClub, h = cave.traits.height;
        FINGER_INVERSE[0] = -q[0]; FINGER_INVERSE[1] = -q[1]; FINGER_INVERSE[2] = -q[2]; FINGER_INVERSE[3] = q[3];
        math.quat.rotateVec(MUZZLE, FINGER_INVERSE, -club.position.x, -0.625 * h - club.position.y, 0.15 * h - club.position.z);
        setVec(w.meleeAxeGrip, MUZZLE[0], MUZZLE[1], MUZZLE[2]);
        math.quat.multiply(w.meleeAxeClub, w.meleeAxeArm, w.meleeAxeClub);
        w.meleeAxeArmX = arm.rotation.x;
      }
      w.meleeTarget.node = null;
      w.meleeAimX = w.meleeAimY = w.meleeAimZ = 0;
      if (!held && ctx.meleeTarget && !ctx.meleeTarget(w.meleeTarget, cave)) w.meleeTarget.node = null;
      w.meleeReadyTime = 0;
      w.meleeTime = MELEE_TIME;
      w.meleeHeld = held;
      w.meleeQuick = false;
      w.meleeHeldTime = w.meleeCharge = 0;
      w.meleeStrikeTime = MELEE_STRIKE;
      w.meleeHit = false;
      w.meleeStop = 1;
      w.meleePower = meleePower(cave);
      if (!held) { w.meleeComboTime = MELEE_COMBO_WINDOW; spendMeleePower(cave); }
      if (!held) aimMeleeStrike(cave);
      if (!held && w.meleeTarget.node) {
        weaponOrigin(weaponStart, cave, true);
        hitMeleeTarget(cave);
      }
      return true;
    };
    const bashWeapon = (cave = player) => {
      if (!cave || cave.grabbedBy || cave !== player || cave.health.stunned || cave.state === "sleeping" || !cave.root.visible
        || !cave.weapon.equipped || cave.weapon.reloading || cave.weapon.swapTime || cave.weapon.reloadHandoff
        || cave.weapon.bashTime || cave.camp.seat || cave.bedTravel.mode) return false;
      stopBurst(cave);
      const w = cave.weapon;
      w.meleeTarget.node = w.meleeTarget.owner = null;
      if (ctx.meleeTarget && !ctx.meleeTarget(w.meleeTarget, cave)) w.meleeTarget.node = null;
      w.bashTime = GUN_BASH_TIME;
      return true;
    };
    const releaseSwing = (cave = player, cancel = false, focused = null, quick = false) => {
      if (!cave) return false;
      const w = cave.weapon;
      if (!w.meleeHeld) return false;
      w.meleeTarget.node = null;
      if (!cancel && ctx.meleeTarget && !ctx.meleeTarget(w.meleeTarget, cave)) w.meleeTarget.node = null;
      w.meleeHeld = false;
      w.meleeQuick = quick && !cancel;
      w.meleeStrikeTime = w.meleeQuick ? MELEE_QUICK_STRIKE : MELEE_STRIKE * (1 + w.meleeCharge * 0.5);
      w.meleeTime = cancel ? 0 : w.meleeStrikeTime + MELEE_RECOVER + (w.meleeQuick ? MELEE_QUICK_WIND : 0);
      w.meleeComboTime = cancel ? 0 : MELEE_COMBO_WINDOW;
      if (cancel) {
        w.meleeReadyTime = 0;
        w.meleePower = 1;
        w.meleeHeldTime = w.meleeCharge = 0;
        w.meleeStrikeTime = MELEE_STRIKE;
      } else spendMeleePower(cave);
      aimMeleeStrike(cave);
      if (!cancel && w.meleeTarget.node) {
        weaponOrigin(weaponStart, cave, true);
        hitMeleeTarget(cave);
      }
      return true;
    };
    // Thrusters built into a character sit wherever its own model puts them, so
    // only the standard pack takes the centre of the back.
    const backPack = (cave) => !!cave.jet && !cave.parts.jetpack;
    const jetTank = (cave) => cave.traits.jetTank > 0 ? cave.traits.jetTank : 1;
    const carryingStoneAxe = (cave) => cave.weapon.primaryOwned && cave.traits.stoneAxe && cave.root.visible && cave.state !== "sleeping"
      && (cave === player ? !cave.weapon.equipped : cave.state === "chilling")
      && !cave.weapon.aiming && cave.weapon.meleeTime <= 0 && !cave.weapon.reloading && !cave.weapon.reloadHandoff
      && !cave.build && !cave.bedTravel.mode && !cave.camp.seat
      && (cave === player || !cave.camp.burning && !cave.camp.rolling && !cave.camp.panic.active);
    // Two states only, so nothing can wind up out of step: folded against the
    // handle while the weapon is stowed, out in line with it while it is in hand.
    const poseNunchaku = (cave, dt) => {
      const out = cave.parts.club.parent === cave.parts.armR && (cave.weapon.primaryEquipped || meleeDrawn(cave));
      cave.chukAngle = damp(cave.chukAngle, out ? 0 : CHUK_FOLD, 12, dt);
      cave.parts.chuk.rotation.x = cave.chukAngle;
    };
    // An Ooga with its own melee weapon swaps hands now and then: the rifle rides
    // its back while the melee weapon is out, and comes back for the shooting.
    // Driven, it spins on demand instead, for one burst at a time.
    const meleeDrawn = (cave) => {
      if (!cave.traits.nunchaku || cave.weapon.reloading || cave.weapon.reloadHandoff) return false;
      if (cave === player) return cave.twirlUntil > elapsed && !cave.weapon.aiming && cave.weapon.meleeTime <= 0;
      return cave.meleeOut && cave.work.phase !== "station" && cave.work.phase !== "shoot" && !cave.build;
    };
    // Each bout picks a hand, and now and then passes the pair across. The hand
    // it starts on always spins for less time than the one it ends on.
    const startTwirl = (cave, seconds) => {
      cave.twirlHand = Math.random() < 0.5 ? 1 : 0;
      cave.twirlFlipAt = Math.random() < TWIRL_SWAP ? elapsed + seconds * TWIRL_FIRST : Infinity;
    };
    // N spins it for the same bout the idle loop rolls. A fresh press takes either
    // hand; pressing again while it spins passes it across and starts a new bout.
    const twirl = (cave = player) => {
      if (!cave || !cave.traits.nunchaku || cave.state === "sleeping" || cave.camp.burning || cave.camp.rolling) return false;
      const seconds = swapWait(true);
      if (cave.twirlUntil <= elapsed) startTwirl(cave, seconds);
      else {
        cave.twirlHand = cave.twirlHand ? 0 : 1;
        cave.twirlFlipAt = Infinity;
      }
      cave.twirlUntil = elapsed + seconds;
      return true;
    };
    const poseFingers = (arm, fingers, held, side) => {
      fingers.highlight = arm.highlight;
      // Select a square side with an exact quarter turn about the palm. The
      // pair keeps its spacing and follows every rotation of the hand.
      // Weapon grips already roll the whole wrist inward, using the front side.
      math.quat.fromEuler(fingers.quaternion, 0, held && arm.quaternion ? 0 : side * Math.PI / 2, 0);
    };
    const poseHands = (cave, leftSupportsGun = false) => {
      const parts = cave.parts, drawn = cave.weapon.carry === "hands";
      const rightHeld = parts.club.visible && parts.club.parent === parts.armR || drawn || reloadingSpare(cave);
      const leftHeld = parts.snack.visible || cave.traits.cigarette || leftSupportsGun
        || parts.club.visible && parts.club.parent === parts.armL;
      poseFingers(parts.armR, parts.fingersR, rightHeld, 1);
      poseFingers(parts.armL, parts.fingersL, leftHeld, -1);
    };
    const reloadHandoffBlend = (w) => ease.inOutQuad(1 - Math.abs(1 - 2 * Math.min(RELOAD_HANDOFF_TIME, w.reloadHandoffTime) / RELOAD_HANDOFF_TIME));
    const poseWorkAim = (cave) => {
      const arm = cave.parts.armR, gun = cave.parts.gun, p = cave.root.position, target = cave.work.target, h = cave.traits.height;
      const turn = cave.root.rotation.y + arm.poseYaw, sr = Math.sin(turn), cr = Math.cos(turn);
      const wx = target.x - p.x, wz = target.z - p.z;
      const dx = cr * wx - sr * wz - arm.position.x, dy = target.y - p.y - arm.position.y, dz = sr * wx + cr * wz - arm.position.z;
      // The muzzle sits 0.15h sideways and 0.11h above the shoulder's aim
      // axis after the wrist roll and grip offset. Solve those offsets too:
      // simply pitching toward the head-height target misses moving body parts.
      const across = Math.hypot(dx, dz), side = 0.15 * h, lift = 0.11 * h;
      const yaw = Math.atan2(dx, dz) - Math.asin(clamp(side / Math.max(side, across), -1, 1));
      const forward = Math.sqrt(Math.max(0, across * across - side * side));
      const pitch = Math.asin(clamp(lift / Math.max(lift, Math.hypot(dy, forward)), -1, 1)) - Math.atan2(dy, forward);
      math.quat.fromEuler(gun.quaternion, pitch, yaw, 0);
      math.quat.fromEuler(GUN_GRIP, -Math.PI / 2, 0, 0);
      math.quat.multiply(GUN_ARM, gun.quaternion, GUN_GRIP);
      math.quat.fromEuler(GUN_GRIP, 0, Math.PI / 2, 0);
      math.quat.multiply(cave.gunHandRotation, GUN_ARM, GUN_GRIP);
      arm.quaternion = cave.gunHandRotation;
      math.quat.rotateVec(MUZZLE, arm.quaternion, 0, -0.625 * h, 0.15 * h);
      const px = arm.position.x + MUZZLE[0], py = arm.position.y + MUZZLE[1], pz = arm.position.z + MUZZLE[2];
      math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.14 * h, -0.184 * h);
      setVec(gun.position, px - MUZZLE[0], py - MUZZLE[1], pz - MUZZLE[2]);
      cave.weapon.aimPitch = pitch;
    };
    const poseWeapon = (cave, sightCamera = null, sightMix = 0, primaryViewMix = 0) => {
      if (cave.health.stunned || cave.grabbedBy) return;
      const w = cave.weapon, parts = cave.parts, gun = parts.gun, h = cave.traits.height;
      clearGunBashThrust(cave);
      clearMeleeThrust(cave);
      const sightArmOffset = cave.gunSightArmOffset;
      parts.armR.position.x -= sightArmOffset.x; parts.armR.position.y -= sightArmOffset.y; parts.armR.position.z -= sightArmOffset.z;
      sightArmOffset.x = sightArmOffset.y = sightArmOffset.z = 0;
      if (sightCamera && cave === player) { cave.gunSightCamera = sightCamera; cave.gunSightMix = sightMix; }
      if (cave === player || hasMagazine(cave)) syncMagazine(cave);
      let leftSupportsGun = false;
      parts.armL.quaternion = parts.armR.quaternion = null;
      for (let i = 0; i < parts.gunBananas.length; i++) {
        const banana = parts.gunBananas[i], visible = w.ammo > (i + 1) * BURST_ROUNDS;
        if (visible && !banana.visible && (w.reloading || gun.ammoReloading)) banana.ammoPopAt = elapsed;
        banana.visible = visible;
        const pop = 1 - 0.45 * (1 - clamp((elapsed - banana.ammoPopAt) / 0.22, 0, 1)) ** 3;
        setVec(banana.scale, 0.135 * h * pop, 0.175 * h * pop, 0.11 * h * pop);
      }
      gun.ammoReloading = w.reloading;
      if (cave.sleepWeapons.visible || gun.parent === cave.sleepWeapons) {
        cave.sleepWeapons.visible = cave.root.visible && !cave.bedroll?.outdoor;
        if (cave.bedroll?.outdoor) for (const node of cave.swagNodes) node.visible = false;
        parts.gunFlash.visible = false;
        w.carry = "bed";
        return;
      }
      const awakeTravel = !cave.bedTravel.mode || cave.bedTravel.mode === "walk" && !cave.bedTravel.toBed;
      const fireControlled = cave === player && (cave.camp.burning || cave.camp.rolling);
      const ready = w.secondaryOwned && (w.equipped || cave.state === "working" || fireControlled) && cave.root.visible && cave.state !== "sleeping" && awakeTravel
        && (cave === player || !cave.camp.burning && !cave.camp.rolling && !cave.camp.panic.active);
      const working = cave !== player && cave.state === "working";
      const celebrating = working && cave.cheer > 0;
      const spareLoading = ready && reloadingSpare(cave) && !celebrating;
      const drawn = ready && !spareLoading && !meleeDrawn(cave) && (working || cave === player && w.equipped || !w.reloading && (!!cave.build || w.recoil > 0));
      parts.gunFlash.visible = drawn && w.recoil > GUN_HOLD - GUN_FLASH_TIME;
      gun.visible = ready;
      const slungClub = (drawn || spareLoading) && (cave === player || working);
      const primaryHeld = w.primaryOwned && cave === player && w.primaryEquipped && !cave.camp.seat && !cave.bedTravel.mode;
      const primaryReady = primaryHeld && (w.aiming || w.meleeTime > 0 || w.meleeReadyTime > 0);
      const returningPrimary = primaryReady && !w.aiming && w.meleeTime <= 0;
      const raisedPrimary = primaryReady && !returningPrimary;
      // The axe's ordinary stance is independent of combat selection, both
      // before possession and when moving in the initial navigation view.
      const primaryCarry = !slungClub && carryingStoneAxe(cave);
      // A pack takes the centre of the back, and the nunchaku rides the hip either way.
      const sideSling = slungClub && (cave.traits.nunchaku || cave.traits.stoneAxe && backPack(cave));
      const twirling = !slungClub && !primaryReady && cave.traits.nunchaku && meleeDrawn(cave);
      const clubParent = slungClub ? cave.root : twirling && cave.twirlHand ? parts.armL : parts.armR;
      if (parts.club.parent !== clubParent) {
        removeChild(parts.club.parent, parts.club);
        addChild(clubParent, parts.club);
      }
      // The trail follows the hand the weapon is in, on the few frames it changes.
      if (parts.chukTrail && clubParent !== cave.root && parts.chukTrail[0].parent !== clubParent) {
        for (let i = 0; i < parts.chukTrail.length; i++) {
          const ghost = parts.chukTrail[i];
          removeChild(ghost.parent, ghost);
          addChild(clubParent, ghost);
        }
      }
      parts.club.quaternion = null;
      if (primaryCarry) {
        const stick = cave.catchT > 0 || cave.yawn > 0 ? 0
          : ease.inOutQuad(clamp((w.axeIdle - AXE_STICK_DELAY) / AXE_STICK_BLEND, 0, 1));
        // While walking, local +Y points straight ahead. Once still, raise
        // the arm and rotate that axis upright while the grip slides from the
        // haft midpoint to just beneath the stone head.
        parts.armR.rotation.x = lerp(parts.armR.rotation.x, AXE_STICK_ARM, stick);
        parts.armR.rotation.y = parts.armR.rotation.z = 0;
        const hockeyStick = cave.traits.name === "MrHodlX";
        const grip = (hockeyStick ? lerp(10 / 16, 13 / 16, stick) : lerp(7 / 16, 11 / 16, stick)) * h;
        const gripX = lerp(0.075, 0.025, stick) * h;
        cave.axeRotation.set(AXE_FORWARD_ROTATION);
        math.quat.slerpTo(cave.axeRotation, AXE_UPRIGHT_ROTATION, stick);
        math.quat.fromEuler(AXE_ARM_INVERSE, -parts.armR.rotation.x, 0, 0);
        math.quat.multiply(cave.axeRotation, AXE_ARM_INVERSE, cave.axeRotation);
        math.quat.rotateVec(MUZZLE, cave.axeRotation, 0, grip, 0);
        setVec(parts.club.position, gripX - MUZZLE[0], -0.625 * h - MUZZLE[1], 0.15 * h - MUZZLE[2]);
        setVec(parts.club.rotation, 0, 0, 0);
        parts.club.quaternion = cave.axeRotation;
      } else if (sideSling) {
        // The axe hangs against the anatomical left side (+X) with its stone above
        // the tanks; the shorter nunchaku rides the drawing hand's hip, head down.
        if (cave.traits.nunchaku) {
          // Tucked at the drawing hand's hip, sticks up, clear of the thigh.
          setVec(parts.club.position, -0.34 * h, -0.05 * h + cave.viewLift, -0.02 * h);
          setVec(parts.club.rotation, 0.18, 0, -0.16);
        } else {
          setVec(parts.club.position, 0.36 * h, 0.04 * h + cave.viewLift, -0.255 * h);
          setVec(parts.club.rotation, -0.035, 0, 0.04);
        }
      } else if (twirling) {
        // Held, it spins flat over a raised arm. With x at a quarter turn the
        // stick lies in the horizontal plane and y sweeps it round the hand.
        // Either hand takes it, the whole pose mirroring with the side.
        const side = cave.twirlHand ? 1 : -1, arm = side < 0 ? parts.armR : parts.armL;
        arm.rotation.x = CHUK_ARM;
        arm.rotation.y = 0;
        arm.rotation.z = side < 0 ? CHUK_ARM_OUT : -CHUK_ARM_OUT;
        // The circle sits a little outside the arm, so it sweeps past him.
        const turn = (elapsed * CHUK_SPINS * TAU + cave.phase) % TAU, spin = side < 0 ? turn : -turn;
        const out = side * CHUK_OUT * h;
        setVec(parts.club.position, out, -0.62 * h, 0.08 * h);
        setVec(parts.club.rotation, Math.PI / 2, spin, 0);
        for (let i = 0; i < parts.chukTrail.length; i++) {
          const ghost = parts.chukTrail[i];
          ghost.visible = true;
          setVec(ghost.position, out, -0.62 * h, 0.08 * h);
          setVec(ghost.rotation, Math.PI / 2, spin + side * (i + 1) * CHUK_TRAIL, 0);
        }
      } else {
        const hockeySling = slungClub && cave.traits.name === "MrHodlX";
        const slingX = hockeySling ? -0.29 : -0.25, slingY = hockeySling ? 0.21 : 0.25;
        setVec(parts.club.position, slungClub ? slingX * h : 0,
          (slungClub ? slingY : raisedPrimary ? -0.625 : -0.62) * h,
          (slungClub ? -0.3 : raisedPrimary ? 0.15 : 0.08) * h);
        setVec(parts.club.rotation, slungClub ? cave.traits.stoneAxe ? 0 : CLUB_SLING_TILT : raisedPrimary ? 0 : cave.clubCarry.x,
          0, slungClub ? CLUB_SLING_ANGLE : raisedPrimary ? Math.PI / 2 : cave.clubCarry.z);
      }
      if (parts.chukTrail && !twirling) {
        for (let i = 0; i < parts.chukTrail.length; i++) parts.chukTrail[i].visible = false;
      }
      parts.club.poseYaw = slungClub ? parts.torso.poseYaw : 0;
      if (slungClub) {
        clubSlingAxes(parts.club);
        if (cave.traits.nunchaku) {
          // Fit along the hip instead of letting a fixed offset enter a tilted torso.
          const hip = clubRearContact(cave, parts.torso, cave.clubTorsoBounds, true);
          if (hip !== Infinity) parts.club.position.x = hip;
        }
        const contact = Math.min(clubRearContact(cave, parts.head, cave.gunHeadBounds),
          sideSling ? parts.club.position.z : clubRearContact(cave, parts.torso, cave.clubTorsoBounds));
        if (contact !== Infinity) parts.club.position.z = contact;
      }
      parts.club.visible = w.primaryOwned && (slungClub || !drawn);
      if (primaryReady) {
        if (returningPrimary) {
          math.quat.fromEuler(MELEE_REST_ARM, parts.armR.rotation.x, parts.armR.rotation.y, parts.armR.rotation.z);
          if (parts.club.quaternion) MELEE_REST_CLUB.set(parts.club.quaternion);
          else math.quat.fromEuler(MELEE_REST_CLUB, parts.club.rotation.x, parts.club.rotation.y, parts.club.rotation.z);
          MELEE_REST_GRIP[0] = parts.club.position.x; MELEE_REST_GRIP[1] = parts.club.position.y; MELEE_REST_GRIP[2] = parts.club.position.z;
          setVec(parts.club.position, 0, -0.625 * h, 0.15 * h);
          setVec(parts.club.rotation, 0, 0, Math.PI / 2);
          parts.club.quaternion = null;
        }
        let wind = 0, stroke = 0;
        const release = w.meleeStrikeTime + MELEE_RECOVER;
        if (w.meleeHeld) {
          wind = ease.inOutQuad(clamp(w.meleeHeldTime / MELEE_WIND, 0, 1));
        } else if (w.meleeTime > release) {
          wind = ease.inOutQuad(clamp(1 - (w.meleeTime - release) / (w.meleeQuick ? MELEE_QUICK_WIND : MELEE_WIND), 0, 1));
        } else if (w.meleeTime > MELEE_RECOVER) {
          wind = 1;
          stroke = ease.inOutQuad((release - w.meleeTime) / w.meleeStrikeTime);
        } else if (w.meleeTime > 0) {
          const recovery = 1 - ease.inOutQuad(1 - w.meleeTime / MELEE_RECOVER);
          wind = recovery;
          stroke = w.meleeStop;
        }
        const neutral = -0.95 + (w.aiming ? w.aimPitch : 0);
        const side = w.meleeSide, backCut = side < 0;
        const startX = -2.05 - 0.25 * w.meleeCharge, endX = -0.22;
        const recovering = !w.meleeHeld && w.meleeTime <= MELEE_RECOVER;
        const closeHold = w.aiming ? primaryViewMix * (1 - wind) : 0;
        parts.armR.rotation.x = lerp(recovering ? neutral : w.meleeEntryX,
          backCut ? startX : lerp(startX, endX, stroke), wind);
        const strikeYaw = backCut ? -1.1 : lerp(-0.22, 0.15, stroke);
        parts.armR.rotation.y = lerp(recovering ? (w.aiming ? w.aimYaw : 0) : w.meleeEntryY,
          (w.aiming ? w.aimYaw : 0) + strikeYaw - parts.armR.poseYaw, wind);
        // Hold the return cut's shoulder angle; turn the whole rigid arm in
        // one plane about that fixed shoulder pivot below.
        const strikeRoll = backCut ? 1.2 : lerp(-0.55, 0.4, stroke);
        parts.armR.rotation.z = lerp(recovering ? -0.12 : w.meleeEntryZ,
          strikeRoll, wind);
        // The close hold draws the weapon inward and up. The camera's view
        // blend carries the hand back to its shoulder hold without a pose jump.
        math.quat.fromEuler(GUN_ARM, parts.armR.rotation.x - 0.14 * closeHold,
          parts.armR.rotation.y - 0.1 * closeHold, parts.armR.rotation.z + 0.22 * closeHold);
        math.quat.fromEuler(GUN_GRIP, 0, Math.PI / 2, 0);
        math.quat.multiply(cave.gunHandRotation, GUN_ARM, GUN_GRIP);
        if (backCut && stroke > 0 && wind > 0) {
          math.quat.rotateVec(MUZZLE, cave.gunHandRotation, 0, -1, 0);
          const yaw = (w.aiming ? w.aimYaw : 0) - parts.armR.poseYaw;
          const cy = Math.cos(yaw), sy = Math.sin(yaw);
          const tx = (0.07 * cy + 0.96 * sy) * MELEE_DOWN_INV;
          const ty = -0.27 * MELEE_DOWN_INV;
          const tz = (0.96 * cy - 0.07 * sy) * MELEE_DOWN_INV;
          const ax = MUZZLE[1] * tz - MUZZLE[2] * ty;
          const ay = MUZZLE[2] * tx - MUZZLE[0] * tz;
          const az = MUZZLE[0] * ty - MUZZLE[1] * tx;
          const span = Math.hypot(ax, ay, az);
          if (span > 1e-5) {
            const dot = clamp(MUZZLE[0] * tx + MUZZLE[1] * ty + MUZZLE[2] * tz, -1, 1);
            math.quat.fromAxisAngle(MELEE_SWING, ax / span, ay / span, az / span,
              Math.atan2(span, dot) * stroke * wind);
            math.quat.multiply(cave.gunHandRotation, MELEE_SWING, cave.gunHandRotation);
          }
        }
        // The wrist leads the return cut so the axe starts falling with the arm.
        parts.club.rotation.z = lerp(recovering ? Math.PI / 2 : w.meleeEntryClubZ, Math.PI / 2, wind)
          + (backCut ? 1.1 * Math.sqrt(stroke) * wind : 0) - (recovering ? 0.14 * closeHold : 0);
        if (cave.traits.stoneAxe && raisedPrimary) {
          // The first cut turns the edge slightly as it lands, then unwinds
          // with the arm. The return blade faces forward in its new shoulder pose.
          const bladeTarget = backCut ? 0 : 0.08 * stroke;
          w.meleeBladeTurn = recovering ? bladeTarget * wind : lerp(w.meleeEntryBladeTurn, bladeTarget, wind);
          math.quat.fromEuler(cave.axeRotation, parts.club.rotation.x, parts.club.rotation.y, parts.club.rotation.z);
          math.quat.fromEuler(GUN_GRIP, 0, w.meleeBladeTurn, 0);
          math.quat.multiply(cave.axeRotation, cave.axeRotation, GUN_GRIP);
          parts.club.quaternion = cave.axeRotation;
        }
        const axeGrip = cave.traits.stoneAxe && (w.meleeHeld || w.meleeQuick && w.meleeTime > release) ? 1 - wind : 0;
        if (axeGrip > 0) {
          if (w.meleeHeld) {
            math.quat.fromEuler(GUN_ARM, 0, -parts.armR.poseYaw, 0);
            math.quat.multiply(GUN_ARM, GUN_ARM, w.meleeAxeArm);
            math.quat.slerpTo(cave.gunHandRotation, GUN_ARM, axeGrip);
            parts.armR.rotation.x = lerp(parts.armR.rotation.x, w.meleeAxeArmX, axeGrip);
          }
          // Preserve the axe's resting grip while the arm starts its wind-up.
          math.quat.fromEuler(GUN_ARM, 0, parts.armR.poseYaw, 0);
          math.quat.multiply(GUN_ARM, GUN_ARM, cave.gunHandRotation);
          FINGER_INVERSE[0] = -GUN_ARM[0]; FINGER_INVERSE[1] = -GUN_ARM[1]; FINGER_INVERSE[2] = -GUN_ARM[2]; FINGER_INVERSE[3] = GUN_ARM[3];
          math.quat.multiply(GUN_ARM, FINGER_INVERSE, w.meleeAxeClub);
          if (!parts.club.quaternion) math.quat.fromEuler(cave.axeRotation, parts.club.rotation.x, parts.club.rotation.y, parts.club.rotation.z);
          math.quat.slerpTo(cave.axeRotation, GUN_ARM, axeGrip);
          parts.club.quaternion = cave.axeRotation;
          math.quat.rotateVec(MUZZLE, cave.axeRotation, w.meleeAxeGrip.x, w.meleeAxeGrip.y, w.meleeAxeGrip.z);
          setVec(parts.club.position, lerp(parts.club.position.x, -MUZZLE[0], axeGrip), lerp(parts.club.position.y, -0.625 * h - MUZZLE[1], axeGrip), lerp(parts.club.position.z, 0.15 * h - MUZZLE[2], axeGrip));
        }
        if (returningPrimary) {
          const carry = 1 - ease.inOutQuad(clamp(w.meleeReadyTime / MELEE_CARRY_BLEND, 0, 1));
          math.quat.slerpTo(cave.gunHandRotation, MELEE_REST_ARM, carry);
          if (!parts.club.quaternion) math.quat.fromEuler(cave.axeRotation, parts.club.rotation.x, parts.club.rotation.y, parts.club.rotation.z);
          math.quat.slerpTo(cave.axeRotation, MELEE_REST_CLUB, carry);
          parts.club.quaternion = cave.axeRotation;
          setVec(parts.club.position, lerp(parts.club.position.x, MELEE_REST_GRIP[0], carry), lerp(parts.club.position.y, MELEE_REST_GRIP[1], carry), lerp(parts.club.position.z, MELEE_REST_GRIP[2], carry));
        }
        const towardTarget = !backCut && w.meleeTime > MELEE_RECOVER && w.meleeTime <= release ? stroke : 0;
        if (towardTarget > 0) {
          const dx = w.meleeAimX * towardTarget, dy = w.meleeAimY * towardTarget, dz = w.meleeAimZ * towardTarget;
          w.meleeOffsetX += dx; w.meleeOffsetY += dy; w.meleeOffsetZ += dz;
          parts.armR.position.x += dx; parts.armR.position.y += dy; parts.armR.position.z += dz;
        }
        parts.armR.quaternion = cave.gunHandRotation;
      } else if (primaryCarry) {
        // The pose above preserves the anatomical right arm's walking sway.
      } else if (primaryHeld) parts.armR.rotation.y = 0;
      w.carry = primaryCarry ? "hands" : !ready ? "hidden" : drawn ? "hands" : "back";
      if (!ready) { if (cave === player) posePeek(cave, 0); poseHands(cave, leftSupportsGun); return; }
      if (drawn) {
        if (!w.reloading) parts.snack.visible = false;
        // Keep the loading hand free while workers carry their rifle for
        // the whole trip, including an empty magazine and each banana load.
        const lowCarry = !w.reloading && !celebrating && (cave === player ? !w.aiming : working
          && (cave.work.phase !== "shoot" || workBodyTarget && !cave.work.targetReady) && !cave.build)
          && !w.burstRemaining && w.recoil <= 0;
        leftSupportsGun = lowCarry;
        // Facing +Z, the character's right hand is armR (-X), and their
        // left hand is armL (+X). Keep the left hand high and the right low.
        const gripRight = w.reloading || !lowCarry && (cave === player || working);
        const arm = gripRight ? parts.armR : parts.armL;
        const steadyAim = cave === player && w.aiming && !w.reloading && !w.reloadHandoff;
        if (!gripRight) leftSupportsGun = true;
        if (w.reloading) {
          arm.rotation.x = -Math.PI / 2; arm.rotation.y = 0;
        } else if (lowCarry) {
          arm.rotation.x = -1; arm.rotation.y = 0;
        } else if (!w.reloading && (!cave.build || cave.build.phase === "shoot")) {
          // One kick per emitted banana, returning before the next burst round.
          const kick = clamp((w.recoil - GUN_HOLD + GUN_KICK) / GUN_KICK, 0, 1);
          arm.rotation.x = (steadyAim ? -Math.PI / 2 : -1.55) + (cave === player ? w.aimPitch : 0) - 0.11 * kick * kick;
          if (cave === player) arm.rotation.y = w.aimYaw - (steadyAim ? arm.poseYaw : 0);
          if (!gripRight && !cave.build) parts.armR.rotation.x = -1.2;
        }
        // The shoulder pivot still follows the twisting torso, but the arm
        // counterturns to keep its rifle aligned with the crosshair direction.
        // Leave out the relaxed arm splay while aiming; it skews the barrel.
        math.quat.fromEuler(GUN_ARM, arm.rotation.x, lowCarry ? 0.2 : arm.rotation.y, steadyAim || w.reloading ? 0 : lowCarry ? -0.15 : arm.rotation.z);
        // Roll around the arm's own axis so the finger nubs face inward.
        // Keep the rifle's aim independent of that wrist roll.
        math.quat.fromEuler(GUN_GRIP, 0, gripRight ? Math.PI / 2 : -Math.PI / 2, 0);
        math.quat.multiply(cave.gunHandRotation, GUN_ARM, GUN_GRIP);
        arm.quaternion = cave.gunHandRotation;
        // During reload, rest the grip against the upper finger edge so
        // the rifle sits inward without burying its receiver in the hand.
        math.quat.rotateVec(MUZZLE, cave.gunHandRotation, 0, (w.reloading ? -0.58 : -0.625) * h, (w.reloading ? 0.25 : 0.15) * h);
        const palmX = arm.position.x + MUZZLE[0], palmY = arm.position.y + MUZZLE[1], palmZ = arm.position.z + MUZZLE[2];
        // Solve the carry's lower wrist from the raised left hand. Reload
        // holds the rifle upright in the extended right hand.
        if (w.reloading) math.quat.fromEuler(gun.quaternion, -Math.PI / 2, Math.PI / 2, 0);
        else if (lowCarry) math.quat.fromEuler(gun.quaternion, 0.53, -2.23, 0);
        else {
          math.quat.fromEuler(GUN_GRIP, Math.PI / 2 + (cave.build || cave === player ? 0 : w.aimPitch), 0, 0);
          math.quat.multiply(gun.quaternion, GUN_ARM, GUN_GRIP);
        }
        // Aim and recoil pivot the rifle around the grip held in the palm.
        math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.14 * h, -0.184 * h);
        setVec(gun.position, palmX - MUZZLE[0], palmY - MUZZLE[1], palmZ - MUZZLE[2]);
        if (lowCarry) {
          // Lower the character's right arm without stretching it.
          const rightArm = parts.armR, reach = Math.hypot(0.625, 0.15);
          math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.08 * h, 0.27 * h);
          const dx = gun.position.x + MUZZLE[0] - rightArm.position.x;
          const dy = gun.position.y + MUZZLE[1] - rightArm.position.y;
          const dz = gun.position.z + MUZZLE[2] - rightArm.position.z;
          const length = Math.hypot(dx, dy, dz), ax = 0.15 / reach, ay = -0.625 / reach;
          GUN_ARM[0] = ay * dz / length; GUN_ARM[1] = -ax * dz / length;
          GUN_ARM[2] = (ax * dy - ay * dx) / length; GUN_ARM[3] = 1 + (ax * dx + ay * dy) / length;
          math.quat.normalize(GUN_ARM);
          math.quat.fromEuler(GUN_GRIP, 0, Math.PI / 2, 0);
          math.quat.multiply(cave.gunSupportRotation, GUN_ARM, GUN_GRIP);
          rightArm.quaternion = cave.gunSupportRotation;
          math.quat.rotateVec(MUZZLE, rightArm.quaternion, 0, -0.625 * h, 0.15 * h);
          const rightX = rightArm.position.x + MUZZLE[0], rightY = rightArm.position.y + MUZZLE[1], rightZ = rightArm.position.z + MUZZLE[2];
          // Carry stock-down from the right hand toward the raised left palm.
          math.quat.fromEuler(gun.quaternion, -0.53, Math.PI - 2.23, 0);
          math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.14 * h, -0.184 * h);
          setVec(gun.position, rightX - MUZZLE[0], rightY - MUZZLE[1], rightZ - MUZZLE[2]);
          // Turn the whole left arm around its long axis toward the wood.
          // Its palm stays in place and the nubs stay on the hand's edge.
          const leftArm = parts.armL, q = leftArm.quaternion;
          math.quat.rotateVec(MUZZLE, q, 0, -0.625 * h, 0);
          const leftX = leftArm.position.x + MUZZLE[0], leftY = leftArm.position.y + MUZZLE[1], leftZ = leftArm.position.z + MUZZLE[2];
          math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.0475 * h, 0.27 * h);
          const woodX = gun.position.x + MUZZLE[0] - leftX, woodY = gun.position.y + MUZZLE[1] - leftY, woodZ = gun.position.z + MUZZLE[2] - leftZ;
          FINGER_INVERSE[0] = -q[0]; FINGER_INVERSE[1] = -q[1]; FINGER_INVERSE[2] = -q[2]; FINGER_INVERSE[3] = q[3];
          math.quat.rotateVec(MUZZLE, FINGER_INVERSE, woodX, woodY, woodZ);
          math.quat.fromEuler(GUN_GRIP, 0, Math.atan2(MUZZLE[0], MUZZLE[2]), 0);
          math.quat.multiply(cave.gunHandRotation, q, GUN_GRIP);
          // Seat the inner nub's upper rear corner against the wood with a
          // small shoulder turn. The rigid arm and attached fingers keep
          // their shape; the rifle stays in the lowered right hand.
          const gq = gun.quaternion, cornerReach2 = (0.5 * 0.5 + 9 * 9 + 2.5 * 2.5) / 256;
          FINGER_INVERSE[0] = -gq[0]; FINGER_INVERSE[1] = -gq[1]; FINGER_INVERSE[2] = -gq[2]; FINGER_INVERSE[3] = gq[3];
          math.quat.rotateVec(MUZZLE, FINGER_INVERSE, leftArm.position.x - gun.position.x, leftArm.position.y - gun.position.y, leftArm.position.z - gun.position.z);
          const shoulderX = MUZZLE[0] / h, shoulderY = MUZZLE[1] / h, shoulderZ = MUZZLE[2] / h;
          const contactX = shoulderX - Math.sqrt(cornerReach2 - (shoulderY + 0.0475) ** 2 - (shoulderZ - 0.345) ** 2);
          math.quat.rotateVec(MUZZLE, gq, contactX * h, -0.0475 * h, 0.345 * h);
          const bx = gun.position.x + MUZZLE[0] - leftArm.position.x;
          const by = gun.position.y + MUZZLE[1] - leftArm.position.y;
          const bz = gun.position.z + MUZZLE[2] - leftArm.position.z;
          math.quat.rotateVec(MUZZLE, q, h / 32, -9 * h / 16, 2.5 * h / 16);
          FINGER_TARGET[0] = MUZZLE[1] * bz - MUZZLE[2] * by;
          FINGER_TARGET[1] = MUZZLE[2] * bx - MUZZLE[0] * bz;
          FINGER_TARGET[2] = MUZZLE[0] * by - MUZZLE[1] * bx;
          FINGER_TARGET[3] = cornerReach2 * h * h + MUZZLE[0] * bx + MUZZLE[1] * by + MUZZLE[2] * bz;
          math.quat.normalize(FINGER_TARGET);
          math.quat.multiply(cave.gunHandRotation, FINGER_TARGET, q);
        }
        if (!celebrating && (w.swapTime > 0 || w.reloadHandoff)) {
          // Lower the right hand diagonally across the body, bringing the
          // rifle's magazine toward the spare on the anatomical left hip.
          // Blend from the current carry/aim pose and keep the grip attached.
          const progress = 1 - w.swapTime / MAGAZINE_SWAP_TIME;
          const blend = w.reloadHandoff ? reloadHandoffBlend(w) : ease.inOutQuad(1 - Math.abs(progress * 2 - 1));
          const right = parts.armR;
          math.quat.fromEuler(GUN_ARM, w.reloadHandoff ? -0.25 : -0.2, 0, w.reloadHandoff ? 0.9 : 0.64);
          math.quat.fromEuler(GUN_GRIP, 0, Math.PI / 2, 0);
          math.quat.multiply(GUN_SWAP_TARGET, GUN_ARM, GUN_GRIP);
          math.quat.slerpTo(right.quaternion, GUN_SWAP_TARGET, blend);
          if (w.reloadHandoff) {
            math.quat.fromEuler(GUN_GRIP, Math.PI / 2, 0, 0);
            math.quat.multiply(GUN_SWAP_TARGET, GUN_ARM, GUN_GRIP);
          } else {
            // Keep the right grip low while tilting the magazine well up
            // toward the spare arriving in the left hand.
            math.quat.fromEuler(GUN_SWAP_TARGET, -0.35, 0.5, 1.13);
          }
          math.quat.slerpTo(gun.quaternion, GUN_SWAP_TARGET, blend);
          math.quat.rotateVec(MUZZLE, right.quaternion, 0, (w.reloading ? lerp(-0.58, -0.625, blend) : -0.625) * h, (w.reloading ? lerp(0.25, 0.15, blend) : 0.15) * h);
          const handX = right.position.x + MUZZLE[0], handY = right.position.y + MUZZLE[1], handZ = right.position.z + MUZZLE[2];
          math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.14 * h, -0.184 * h);
          setVec(gun.position, handX - MUZZLE[0], handY - MUZZLE[1], handZ - MUZZLE[2]);
        }
      } else {
        // Keep the magazine outside the hair, and beside back-mounted gear.
        const head = parts.head, bounds = cave.gunHeadBounds, sideCarry = backPack(cave) || cave.traits.skater;
        math.quat.fromEuler(GUN_ARM, head.rotation.x, head.rotation.y, head.rotation.z);
        const q = head.quaternion || GUN_ARM, x = q[0], y = q[1], z = q[2], qw = q[3];
        const zx = 2 * (x * z - y * qw) * head.scale.x, zy = 2 * (y * z + x * qw) * head.scale.y, zz = (1 - 2 * (x * x + y * y)) * head.scale.z;
        const rear = head.position.z + zx * (zx < 0 ? bounds.max[0] : bounds.min[0]) + zy * (zy < 0 ? bounds.max[1] : bounds.min[1]) + zz * (zz < 0 ? bounds.max[2] : bounds.min[2]);
        setVec(gun.position, (sideCarry ? 0.34 : 0.06) * h, 0.24 * h + cave.viewLift, Math.min(-0.245 * h, rear - 0.055 * h));
        math.quat.fromEuler(GUN_ARM, 0, 0, sideCarry ? -0.05 : -0.45);
        math.quat.fromEuler(GUN_GRIP, -Math.PI / 2, Math.PI, -Math.PI / 2);
        math.quat.multiply(gun.quaternion, GUN_ARM, GUN_GRIP);
        if (spareLoading) {
          const arm = parts.armR;
          // Raise the hand to the height of the magazine in the upright AK.
          arm.rotation.x = -1.976; arm.rotation.y = 0;
          math.quat.fromEuler(GUN_ARM, arm.rotation.x, 0, arm.rotation.z);
          math.quat.fromEuler(GUN_GRIP, 0, Math.PI / 2, 0);
          math.quat.multiply(cave.gunHandRotation, GUN_ARM, GUN_GRIP);
          arm.quaternion = cave.gunHandRotation;
          if (w.reloadHandoff) {
            math.quat.fromEuler(GUN_ARM, -0.25, 0, 0.9);
            math.quat.multiply(GUN_SWAP_TARGET, GUN_ARM, GUN_GRIP);
            math.quat.slerpTo(arm.quaternion, GUN_SWAP_TARGET, reloadHandoffBlend(w));
          }
          syncMagazine(cave);
        }
      }
      if (w.swapTime > 0) { syncMagazine(cave); leftSupportsGun = true; }
      if (working && workBodyTarget && cave.work.phase === "shoot" && cave.work.aimReady && drawn && !celebrating
        && !w.reloading && !w.reloadHandoff && !w.swapTime) poseWorkAim(cave);
      if (cave === player) { posePeek(cave, 0); aimPeek(cave); }
      if (sightCamera && sightMix > 0 && cave === player && drawn && w.equipped && w.aiming
        && !w.reloading && !w.reloadHandoff && !w.swapTime && !cave.root.quaternion) {
        const eye = sightCamera.position, target = sightCamera.target, p = cave.root.position;
        const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
        const length = Math.hypot(dx, dy, dz) || 1, yaw = cave.root.rotation.y, cy = Math.cos(yaw), sy = Math.sin(yaw);
        const fx = (cy * dx - sy * dz) / length, fy = dy / length, fz = (sy * dx + cy * dz) / length;
        const flat = Math.max(1e-5, Math.hypot(fx, fz));
        const kick = clamp((w.recoil - GUN_HOLD + GUN_KICK) / GUN_KICK, 0, 1);
        const forward = (0.85 - 0.04 * kick) * h, drop = (GUN_SIGHT_DROP - 0.02 * kick) * h;
        const sightPitch = -Math.atan2(fy, flat) + GUN_SIGHT_DOWN - 0.035 * kick;
        // Keep the sights straight and centered on the view ray.
        const ex = cy * (eye.x - p.x) - sy * (eye.z - p.z);
        const ez = sy * (eye.x - p.x) + cy * (eye.z - p.z);
        gun.position.x = lerp(gun.position.x, ex + fx * forward + fy * fx / flat * drop, sightMix);
        gun.position.y = lerp(gun.position.y, eye.y - p.y + fy * forward - flat * drop, sightMix);
        gun.position.z = lerp(gun.position.z, ez + fz * forward + fy * fz / flat * drop, sightMix);
        math.quat.fromEuler(GUN_SIGHT, sightPitch, Math.atan2(fx, fz), 0);
        math.quat.slerpTo(gun.quaternion, GUN_SIGHT, sightMix);
        gun.poseLean *= 1 - sightMix;
        // The gun moves to the eye in this pose; carry the gripping hand with
        // it instead of leaving the arm at its pre-sight position.
        const arm = parts.armR;
        math.quat.rotateVec(MUZZLE, gun.quaternion, 0, -0.14 * h, -0.184 * h);
        const tx = gun.position.x + MUZZLE[0] - arm.position.x;
        const ty = gun.position.y + MUZZLE[1] - arm.position.y;
        const tz = gun.position.z + MUZZLE[2] - arm.position.z;
        math.quat.rotateVec(MUZZLE, arm.quaternion, 0, -0.625 * h, 0.15 * h);
        const ax = MUZZLE[0], ay = MUZZLE[1], az = MUZZLE[2];
        GUN_ARM[0] = ay * tz - az * ty;
        GUN_ARM[1] = az * tx - ax * tz;
        GUN_ARM[2] = ax * ty - ay * tx;
        GUN_ARM[3] = Math.hypot(ax, ay, az) * Math.hypot(tx, ty, tz) + ax * tx + ay * ty + az * tz;
        math.quat.normalize(GUN_ARM);
        math.quat.multiply(cave.gunHandRotation, GUN_ARM, arm.quaternion);
        arm.quaternion = cave.gunHandRotation;
        math.quat.rotateVec(MUZZLE, arm.quaternion, 0, -0.625 * h, 0.15 * h);
        sightArmOffset.x = tx - MUZZLE[0]; sightArmOffset.y = ty - MUZZLE[1]; sightArmOffset.z = tz - MUZZLE[2];
        arm.position.x += sightArmOffset.x; arm.position.y += sightArmOffset.y; arm.position.z += sightArmOffset.z;
      }
      if (cave === player && drawn && w.bashTime > 0) {
        const lunge = 0.16 * h * Math.sin(Math.PI * (1 - w.bashTime / GUN_BASH_TIME));
        gun.position.z += lunge;
        parts.armR.position.z += lunge;
        parts.armL.position.z += lunge;
        w.bashOffset = lunge;
      }
      poseHands(cave, leftSupportsGun);
    };
    const stopBurst = (cave) => {
      const w = cave.weapon;
      w.burstRemaining = w.burstTimer = w.recoil = 0;
      w.triggerHeld = w.triggerSingle = false;
      w.triggerHeldTime = 0;
      w.triggerQueued = 0;
      w.reloadFire = w.reloadFireHeld = false;
      w.reloadFireRounds = BURST_ROUNDS;
    };
    const weaponReady = (cave) => !!cave && !cave.grabbedBy && cave.root.visible && !cave.health.stunned && cave.weapon.secondaryOwned && cave.weapon.equipped && !cave.weapon.reloading && !cave.weapon.swapTime && !cave.weapon.reloadHandoff && !cave.weapon.bashTime && (cave.weapon.unlimited || cave.weapon.ammo > 0)
      && cave.state !== "sleeping" && (cave === player || !cave.camp.burning && !cave.camp.rolling && !cave.camp.panic.active) && !cave.bedTravel.mode && !seatBlocksWeapons(cave);
    const canFire = (cave = player) => weaponReady(cave) && cave.weapon.cooldown <= 0 && !cave.weapon.burstRemaining;
    const canSwapMagazine = (cave = player) => hasMagazine(cave) && cave.weapon.secondaryOwned && (cave === player || cave.state === "working") && cave.root.visible && !cave.health.stunned
      && cave.weapon.equipped && !cave.weapon.reloading && !cave.weapon.swapTime && !cave.weapon.reloadHandoff
      && cave.state !== "sleeping" && !cave.camp.burning && !cave.camp.rolling && !cave.camp.panic.active && !cave.bedTravel.mode && !seatBlocksWeapons(cave);
    const swapMagazine = (cave = player, index = null) => {
      if (!canSwapMagazine(cave)) return false;
      const w = cave.weapon;
      if (index === null) index = fullestMagazine(cave);
      if (index < 0 || index >= w.spareAmmo.length) return false;
      stopBurst(cave);
      const magazineArmStart = cave.magazineModels[index].armStart;
      const left = cave.parts.armL;
      if (left.quaternion) magazineArmStart.set(left.quaternion);
      else math.quat.fromEuler(magazineArmStart, left.rotation.x, left.rotation.y, left.rotation.z);
      w.swapTime = MAGAZINE_SWAP_TIME;
      w.swapMagazine = index;
      w.swapCommitted = false;
      w.cooldown = Math.max(w.cooldown, MAGAZINE_SWAP_TIME);
      poseWeapon(cave);
      return true;
    };
    const emitWeaponShot = (cave) => {
      const w = cave.weapon, p = cave.root.position, spot = w.burstTarget;
      if (w.burstWork && workBodyTarget) {
        if (!aimWork(cave, workSites[cave.work.site])) return false;
        setVec(spot, cave.work.target.x, cave.work.target.y, cave.work.target.z);
      }
      const spread = w.burstPlayerAim && cave === player && w.aiming;
      if (w.burstPlayerAim && cave === player && ctx.aimTarget) ctx.aimTarget(spot, spread);
      else if (w.burstPlayerAim) {
        const yaw = cave.root.rotation.y, pitch = cave.parts.head.rotation.x;
        setVec(spot, p.x + Math.sin(yaw) * Math.cos(pitch) * 8, p.y + cave.traits.height * 0.45 - Math.sin(pitch) * 8, p.z + Math.cos(yaw) * Math.cos(pitch) * 8);
      }
      // Player spread changes the projectile, not the arm's centered aim.
      if (!spread) {
        if (cave === player) {
          const yaw = Math.atan2(spot.x - p.x, spot.z - p.z) - cave.root.rotation.y;
          w.aimYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        }
        w.aimPitch = -Math.atan2(spot.y - p.y - cave.traits.height * 0.45, Math.hypot(spot.x - p.x, spot.z - p.z));
      }
      if (w.burstWork && ctx.workShotClear) {
        poseWeapon(cave);
        weaponOrigin(weaponStart, cave);
        cave.work.blocked = !ctx.workShotClear(weaponStart.x, weaponStart.y, weaponStart.z, spot.x, spot.y, spot.z);
        if (cave.work.blocked) return false;
      }
      if (!w.unlimited) w.ammo--;
      w.shotsFired++; w.recoil = GUN_HOLD;
      poseWeapon(cave, cave === player ? cave.gunSightCamera : null, cave === player ? cave.gunSightMix : 0);
      fireBullet(cave, spot);
      if (cave === player && cave.gunSightMix > 0) poseWeapon(cave);
      return true;
    };
    const interruptReloadToFire = (cave) => {
      if (cave !== player || !cave || !cave.root.visible || !cave.weapon.equipped || !cave.weapon.unlimited && cave.weapon.ammo <= 0 || cave.weapon.swapTime
        || cave.state === "sleeping" || cave.bedTravel.mode || seatBlocksWeapons(cave)) return false;
      if (cave.weapon.reloading) { stopReload(cave); poseWeapon(cave); }
      return cave.weapon.reloadHandoff < 0;
    };
    const fireWeapon = (cave = player, target = null, rounds = BURST_ROUNDS) => {
      if (interruptReloadToFire(cave)) {
        const w = cave.weapon;
        w.reloadFire = true;
        w.reloadFireRounds = rounds;
        w.burstPlayerAim = !target;
        if (target) setVec(w.burstTarget, target.x, target.y === undefined ? groundAt(target.x, target.z) + 0.75 : target.y, target.z);
        return true;
      }
      if (!canFire(cave)) return false;
      const w = cave.weapon;
      w.burstPlayerAim = !target;
      w.burstWork = cave !== player && !!workSites && cave.work.phase === "shoot";
      if (target) setVec(w.burstTarget, target.x, target.y === undefined ? groundAt(target.x, target.z) + 0.75 : target.y, target.z);
      w.burstRemaining = (w.unlimited ? rounds : Math.min(rounds, w.ammo)) - 1;
      w.burstTimer = BURST_STEP;
      w.cooldown = rounds === 1 ? BURST_STEP : SHOT_PERIOD;
      if (!emitWeaponShot(cave)) { stopBurst(cave); w.cooldown = 0; return false; }
      if (!w.unlimited && !w.ammo) w.triggerHeld = false;
      return true;
    };
    const setWeaponTrigger = (held, single = false) => {
      if (!player) return false;
      const w = player.weapon;
      if (!held) {
        w.triggerHeld = false;
        w.triggerSingle = false;
        w.triggerHeldTime = 0;
        w.reloadFireHeld = false;
        if (!w.burstRemaining) w.burstTimer = 0;
        return true;
      }
      if (interruptReloadToFire(player)) {
        w.triggerSingle = single;
        w.reloadFire = w.reloadFireHeld = true;
        w.reloadFireRounds = single ? 1 : BURST_ROUNDS;
        w.burstPlayerAim = true;
        return true;
      }
      if (!weaponReady(player)) return false;
      if (w.triggerHeld) return true;
      w.triggerSingle = single;
      w.triggerHeld = true;
      w.triggerHeldTime = 0;
      if (!w.burstRemaining) {
        // A fresh press may wait out the previous shot's cooldown. It never
        // resumes automatically after reload, stow or another cancellation.
        w.burstTimer = 0;
        if (!fireWeapon(player, null, single ? 1 : BURST_ROUNDS) && single && w.cooldown > 0) {
          // Preserve each distinct semi-automatic press until the mechanical
          // shot clock allows it. Pointer release must not erase a fast second
          // click; cancellation paths clear the queue through stopBurst.
          w.triggerQueued = Math.min(AMMO_MAX, w.triggerQueued + 1);
        }
      }
      return true;
    };
    const updateWeapon = (cave, dt) => {
      const w = cave.weapon;
      // A donation pauses the worker's burst and magazine timers while the
      // free hand cheers. The unfinished reload resumes from the same round.
      if (cave !== player && cave.state === "working" && cave.cheer > 0) { stopBurst(cave); return; }
      w.cooldown = Math.max(0, w.cooldown - dt);
      if (w.triggerHeld && w.triggerSingle) {
        w.triggerHeldTime += dt;
        if (w.triggerHeldTime >= FOCUSED_AUTO_HOLD) w.triggerSingle = false;
      }
      w.recoil = Math.max(0, w.recoil - dt);
      w.reloadHandoffFrame = !!w.reloadHandoff;
      if (w.reloadHandoff) {
        if (!hasMagazine(cave) || !w.equipped || !cave.root.visible || cave.state === "sleeping"
          || cave.camp.burning || cave.camp.rolling || cave.camp.panic.active || cave.bedTravel.mode || seatBlocksWeapons(cave)) stopReload(cave, true);
        else {
          w.reloadHandoffTime = Math.max(0, w.reloadHandoffTime - dt);
          if (w.reloadHandoff === 2) {
            if (w.reloadHandoffTime <= RELOAD_HANDOFF_TIME / 2) w.reloadMagazine = w.reloadNext;
          } else w.reloadSpare = w.reloadHandoff > 0 ? w.reloadHandoffTime <= RELOAD_HANDOFF_TIME / 2 : w.reloadHandoffTime > RELOAD_HANDOFF_TIME / 2;
          if (!w.reloadHandoffTime) w.reloadHandoff = 0;
        }
      }
      if (w.swapTime > 0) {
        if (!hasMagazine(cave) || cave !== player && cave.state !== "working" || !w.equipped || w.reloading
          || !cave.root.visible || cave.state === "sleeping" || cave.camp.burning || cave.camp.rolling || cave.camp.panic.active || cave.bedTravel.mode) {
          w.swapTime = 0; w.swapCommitted = false;
        } else {
          w.swapTime = Math.max(0, w.swapTime - dt);
          if (!w.swapCommitted && w.swapTime <= MAGAZINE_SWAP_TIME / 2) {
            const ammo = w.ammo;
            w.ammo = w.spareAmmo[w.swapMagazine]; w.spareAmmo[w.swapMagazine] = ammo;
            w.swapCommitted = true;
          }
        }
      }
      if (w.reloadFire) {
        if (w.reloadHandoff) return;
        if (cave !== player || !weaponReady(cave)) { stopBurst(cave); return; }
        if (!canFire(cave)) return;
        const held = w.reloadFireHeld, rounds = w.reloadFireRounds, target = w.burstPlayerAim ? null : w.burstTarget;
        w.reloadFire = w.reloadFireHeld = false;
        w.reloadFireRounds = BURST_ROUNDS;
        poseWeapon(cave);
        fireWeapon(cave, target, rounds);
        w.triggerHeld = held && (w.unlimited || w.ammo > 0);
        return;
      }
      if (w.triggerQueued && !w.burstRemaining && w.cooldown <= 0) {
        if (!weaponReady(cave)) { stopBurst(cave); return; }
        w.triggerQueued--;
        fireWeapon(cave, null, 1);
        return;
      }
      if (!w.burstRemaining && !w.triggerHeld) return;
      // A short focused press stays a single shot. A longer hold resumes
      // automatic fire on the same shot clock.
      if (w.triggerSingle && !w.burstRemaining) {
        w.burstTimer = Math.max(0, w.burstTimer - dt);
        return;
      }
      if (!weaponReady(cave) || w.burstWork && (cave.work.phase !== "shoot" || !siteActive(cave, workSites[cave.work.site]))) {
        stopBurst(cave);
        return;
      }
      if (w.triggerHeld && !w.burstTimer && w.triggerHeldTime < FOCUSED_AUTO_HOLD) { fireWeapon(cave); return; }
      w.burstTimer -= dt;
      // Finish a tapped burst; holding continues on the same shot clock.
      // Keep the normal magazine-sized catch-up bound in unlimited debug mode.
      let shots = 0;
      while ((w.burstRemaining || w.triggerHeld) && (w.unlimited || w.ammo > 0) && w.burstTimer <= 1e-9 && shots++ < AMMO_MAX) {
        if (!emitWeaponShot(cave)) { stopBurst(cave); break; }
        if (w.burstRemaining) w.burstRemaining--;
        w.burstTimer += BURST_STEP;
        if (w.triggerHeld) w.cooldown = Math.max(0, w.burstTimer);
      }
      if (!w.unlimited && !w.ammo) w.triggerHeld = false;
      if (!w.burstRemaining && !w.triggerHeld) w.burstTimer = 0;
    };
    const runReload = (cave, dt) => {
      const w = cave.weapon, parts = cave.parts;
      if (!w.reloading) return false;
      if (!canReload(cave)) { stopReload(cave); return false; }
      if (w.reloadHandoff || w.reloadHandoffFrame) { parts.snack.visible = false; return true; }
      if (w.ammo === AMMO_MAX && (!w.reloadSpare || w.spareAmmo[w.reloadMagazine] === AMMO_MAX)) { handoffToSpare(cave); return true; }
      w.reloadTime += dt;
      // Fill the AK before both spares without depleting the pile.
      // Finish showing that magazine before touching the next.
      let missing = reloadMissing(cave);
      while (w.reloadTime >= RELOAD_PERIOD / 2 && missing > 0) {
        const rounds = reloadBite(cave);
        if (ctx.reloadPolicy ? !ctx.reloadPolicy.available(cave, rounds) : world.level < rounds / AMMO_PER_BANANA) break;
        w.reloadTime -= RELOAD_PERIOD / 2;
        w.reloadStep = 1 - w.reloadStep;
        if (w.reloadSpare) w.spareAmmo[w.reloadMagazine] += rounds;
        else w.ammo += rounds;
        if (ctx.reloadPolicy) ctx.reloadPolicy.consume(cave, rounds);
        missing -= rounds;
        if (missing && (w.reloadSpare ? w.spareAmmo[w.reloadMagazine] === AMMO_MAX : w.ammo === AMMO_MAX)) { handoffToSpare(cave); return true; }
      }
      if (!missing || (ctx.reloadPolicy ? !ctx.reloadPolicy.available(cave, reloadBite(cave)) : world.level < reloadBite(cave) / AMMO_PER_BANANA)) { stopReload(cave); return true; }
      const chew = w.reloadTime / RELOAD_PERIOD + w.reloadStep * 0.5;
      parts.armL.rotation.x = chew < 0.55 ? lerp(-0.2, -2.3, chew / 0.55) : lerp(-2.3, -0.2, (chew - 0.55) / 0.45);
      parts.head.rotation.x = Math.sin(chew * Math.PI) * 0.15;
      parts.snack.visible = chew < 0.6;
      parts.snack.scale.x = parts.snack.scale.y = parts.snack.scale.z = models.BANANA_AMMO_SCALE;
      return true;
    };
    const builtEquipment = [];
    const dismantling = [];
    const spawnEquipment = (spot) => {
      const geometry = models.buildableGeos[Math.floor(Math.random() * models.buildableGeos.length)]();
      const node = createNode({ position: { x: spot.x, y: groundAt(spot.x, spot.z), z: spot.z }, rotation: { x: 0, y: spot.ry, z: 0 }, geometry, sightHidden: !!geometry.sightHidden });
      addChild(root, node);
      builtEquipment.push({ node, spot });
      popNode(node);
      if (ctx.onModelChange) ctx.onModelChange();
    };
    const startBuild = (cave) => {
      cave.weapon.equipped = true;
      if (!buildSpots.length) {
        const oldest = builtEquipment.shift();
        if (!oldest) {
          cave.nextBuildAt = elapsed + 20;
          return;
        }
        dismantling.push(oldest.node);
        addTween({
          dur: 0.4, ease: ease.inQuad, update: (k) => {
            const s = Math.max(0.01, 1 - k);
            setVec(oldest.node.scale, s, s, s);
          }, done: () => {
            removeChild(root, oldest.node);
            const i = dismantling.indexOf(oldest.node);
            if (i >= 0) dismantling.splice(i, 1);
            if (ctx.onModelChange) ctx.onModelChange();
          }
        });
        buildSpots.push(oldest.spot);
      }
      const spot = buildSpots.splice(Math.floor(Math.random() * buildSpots.length), 1)[0];
      cave.build = {
        spot,
        phase: "turn",
        t: 0,
        age: 0,
        shots: 0,
        shotTimer: 0,
        built: false,
        quote: BUILD_QUOTES[Math.floor(Math.random() * BUILD_QUOTES.length)],
        startYaw: cave.root.rotation.y,
        targetYaw: Math.atan2(spot.x - cave.slot.x, spot.z - cave.slot.z)
      };
      cave.parts.snack.visible = false;
      cave.parts.head.rotation.x = 0;
    };
    const runBuild = (cave, dt) => {
      const b = cave.build, parts = cave.parts;
      b.t += dt;
      b.age += dt;
      if (b.phase === "turn") {
        const k = Math.min(1, b.t / 0.35);
        cave.root.rotation.y = lerp(b.startYaw, b.targetYaw, k);
        parts.armL.rotation.x = lerp(-0.2, -1.55, k);
        parts.armR.rotation.x = lerp(-0.2, -1.1, k);
        parts.gun.visible = true;
        parts.snack.visible = false;
        if (k >= 1) {
          b.phase = "shoot";
          b.t = 0;
        }
      } else if (b.phase === "shoot") {
        parts.armL.rotation.x = -1.55;
        b.shotTimer -= dt;
        if (b.shotTimer <= 0 && b.shots < 5) {
          b.shotTimer = 0.16;
          if (fireWeapon(cave, b.spot)) b.shots++;
          else if (cave.weapon.ammo === 0) b.shots = 5;
        }
        if (b.shots >= 5 && b.t > 1.15) {
          b.phase = "reveal";
          b.t = 0;
        }
      } else if (b.phase === "reveal") {
        if (!b.built) {
          b.built = true;
          spawnEquipment(b.spot);
        }
        if (b.t > 0.45) {
          b.phase = "return";
          b.t = 0;
        }
      } else if (b.phase === "return") {
        const k = Math.min(1, b.t / 0.35);
        cave.root.rotation.y = lerp(b.targetYaw, Math.atan2(-cave.slot.x, -cave.slot.z), k);
        parts.armL.rotation.x = lerp(-1.55, -0.2, k);
        parts.armR.rotation.x = lerp(-1.1, -0.2, k);
        if (k >= 1) {
          parts.gun.visible = false;
          cave.build = null;
          cave.nextBuildAt = elapsed + 14 + Math.random() * 22;
        }
      }
    };
    const walkPose = (cave, phase) => {
      const parts = cave.parts;
      const swing = Math.sin(phase);
      parts.legR.rotation.x = swing * 0.55;
      parts.legL.rotation.x = -swing * 0.55;
      parts.armR.rotation.x = -0.2 - swing * 0.3;
      parts.armL.rotation.x = -0.2 + swing * 0.3;
      cave.root.position.y = groundY(cave) + Math.abs(Math.sin(phase)) * 0.04;
    };
    const standPose = (cave) => {
      cave.root.position.y += cave.restLower; cave.restLower = 0;
      const parts = cave.parts;
      parts.armL.quaternion = null;
      parts.legR.rotation.x = parts.legL.rotation.x = 0;
      parts.legR.rotation.z = parts.legL.rotation.z = 0;
      parts.armR.rotation.x = parts.armL.rotation.x = -0.2;
      parts.torso.rotation.x = parts.torso.rotation.z = 0;
    };
    const prepareDragged = (cave) => {
      if (cave === player) elevatePlayer(0);
      clearHeadLook(cave);
      clearShoulder(cave);
      standPose(cave);
      stopBurst(cave); stopReload(cave, true); releaseSwing(cave, true);
      clearGunBashThrust(cave); clearMeleeThrust(cave);
      const w = cave.weapon;
      w.meleeTime = w.meleeReadyTime = w.meleeComboTime = w.bashTime = 0;
      w.meleeTarget.node = w.meleeTarget.owner = null;
      cave.walk = null; cave.work.phase = ""; cave.work.direct = true;
      releaseBuild(cave);
      cave.avoidance.active = false; cave.avoidance.tx = NaN; cave.avoidance.navigation.mode = 0;
      cave.traffic.moving = cave.traffic.waiting = false;
      if (cave.pathing) { cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count; }
      cave.hop = cave.hopV = cave.rocketJumpTime = 0; cave.rocketJumpHeld = false;
      cave.leap.vx = cave.leap.vz = cave.leap.land = 0; cave.leap.thrown = cave.leap.rageThrown = false;
      cave.riding.support = null;
      if (cave.jet) {
        cave.jet.thrust = cave.jet.spending = false; cave.jet.power = 0; cave.jet.flame.visible = false;
      } else if (cave.traits.footRockets) cave.parts.jetpack.visible = cave.parts.jetFlame.visible = false;
      cave.act.kind = "idle";
      cave.parts.snack.visible = cave.parts.gunFlash.visible = false;
      if (cave === player) steer.x = steer.z = steer.forward = steer.strafe = steer.peek = 0;
    };
    const recoverDragged = (cave) => {
      clearHeadLook(cave);
      cave.root.rotation.x = cave.root.rotation.z = 0;
      standPose(cave);
      cave.parts.head.rotation.x = 0;
      cave.parts.armR.rotation.z = -0.12;
      cave.parts.armL.rotation.z = 0.12;
      cave.act.kind = cave === player ? "player" : "idle";
      cave.act.until = elapsed + 0.35;
    };
    const standPlayer = (cave = player) => {
      if (!cave || !cave.camp.seat) return false;
      const seat = cave.camp.seat;
      let exitZ = seat.walkAt.z, clear = false;
      for (let i = 0; i < 3; i++) {
        exitZ = seat.walkAt.z + (i === 1 ? 0.65 : i === 2 ? -0.65 : 0);
        if (walkable(seat.walkAt.x, exitZ, seat.walkAt.x, exitZ, seat.floor, cave.bodyHeight, cave)) { clear = true; break; }
      }
      if (!clear) return false;
      seat.sitter = null;
      cave.camp.seat = null;
      cave.root.quaternion = null;
      cave.root.rotation.x = cave.root.rotation.z = 0;
      standPose(cave);
      setVec(cave.root.position, seat.walkAt.x, seat.floor + cave.baseY, exitZ);
      cave.hop = cave.hopV = 0;
      return true;
    };
    const sitPlayer = (seat) => {
      const cave = player;
      if (!cave || cave.grabbedBy || cave.camp.burning || cave.camp.rolling || cave.camp.seat || seat.sitter || !grounded(cave)) return false;
      if (!walkable(seat.walkAt.x, seat.walkAt.z, seat.walkAt.x, seat.walkAt.z, seat.floor, cave.bodyHeight, cave)) return false;
      elevatePlayer(0);
      removeJetpack(cave);
      releaseBuild(cave);
      cave.walk = null;
      cave.hop = cave.hopV = cave.cheer = cave.catchT = 0;
      cave.leap.vx = cave.leap.vz = 0;
      cave.rocketJumpTime = 0;
      if (cave.traits.footRockets && !cave.jet) cave.parts.jetpack.visible = cave.parts.jetFlame.visible = false;
      cave.camp.seat = seat;
      seat.sitter = cave;
      cave.root.rotation.y = seat.ry;
      setVec(cave.root.position, seat.x, seat.y + cave.traits.height * 0.08, seat.z);
      return true;
    };
    const beginPanic = (cave) => {
      const panic = cave.camp.panic;
      if (panic.active) return;
      panic.speed = (cave.walk ? cave.walk.speed : NPC_WALK_SPEED) * 2;
      panic.resumeWalk = cave.walk;
      panic.resumeSleep = cave.state === "sleeping";
      panic.active = cave !== player;
      panic.phase = 0;
      panic.heading = cave.root.rotation.y;
      panic.turnAt = 0;
      if (cave.state === "sleeping" || cave.bedTravel.mode) {
        const sleepingPose = cave.state === "sleeping" && !ctx.bedRoute;
        standFromBed(cave);
        releaseBedroll(cave);
        cave.bedTravel.bed = null;
        cave.state = contributors.stateFor(cave.contributor) === "working" ? "working" : "chilling";
        if (cave === player) cave.override = cave.state;
        cave.parts.head.geometry = cave.headOpen;
        if (sleepingPose) cave.root.position.y = groundY(cave);
        assignFanSlots([...cavemen.values()], (entry) => entry.state === "working");
        refreshRosterRow(cave);
      }
      releaseBuild(cave);
      cave.walk = null;
      cave.avoidance.navigation.mode = 0;
      cave.avoidance.active = false;
      cave.avoidance.stalled = 0;
      cave.avoidance.tx = NaN;
      if (cave.pathing) cave.pathing.tx = NaN;
      cave.act.kind = cave === player ? "player" : "panic";
      cave.cheer = cave.catchT = cave.yawn = 0;
      cave.parts.snack.visible = cave.parts.gun.visible = false;
    };
    const finishPanic = (cave) => {
      const panic = cave.camp.panic, resumeWalk = panic.resumeWalk, resumeSleep = panic.resumeSleep;
      panic.active = false;
      panic.threat = panic.resumeWalk = null;
      panic.resumeSleep = false;
      cave.avoidance.navigation.mode = 0;
      cave.avoidance.active = false;
      cave.avoidance.stalled = 0;
      cave.avoidance.tx = NaN;
      if (cave.pathing) cave.pathing.tx = NaN;
      standPose(cave);
      if (cave === player) { cave.act.kind = "player"; return; }
      if (resumeSleep) {
        if (ctx.bedRoute) startSleep(cave);
        else applyState(cave, "sleeping");
        return;
      }
      cave.act.kind = "idle";
      cave.act.until = elapsed + (cave.state === "chilling" ? chillPause(cave) : 1.5);
      cave.act.said = true;
      const p = cave.root.position, feet = p.y - cave.baseY;
      if (ctx.bedRoute && feet < -0.5 && underHome(p.x, p.z) && (!ctx.abyssAt || !ctx.abyssAt(p.x, p.z, feet, cave))) startBedRoute(cave, null, false);
      else if (resumeWalk) {
        cave.walk = resumeWalk;
        cave.act.kind = resumeWalk.to === "spot" ? "wander" : "rush";
      }
    };
    const ignite = (cave) => {
      const c = cave.camp;
      if (c.burning || c.rolling || c.cooldown > 0 || !cave.root.visible || cave.state === "away") return false;
      if (cave.grabbedBy && ctx.releaseGrabbed) ctx.releaseGrabbed(cave);
      if (c.seat && !standPlayer(cave)) return false;
      beginPanic(cave);
      const variation = math.fnv1a(cave.traits.name + "/fire/" + ++c.ignitions) / 4294967296;
      const reaction = (cave.index + c.ignitions - 1) % 3;
      c.reactionDelay = reaction === 0 ? 0.6 + variation * 0.65 : reaction === 1 ? 3 + variation * 3 : 10.5 + variation * 2.5;
      c.burning = true;
      // Fire interrupts loading, but it never unequips or cancels the selected
      // attack. The controlled visitor can keep fighting while the body burns
      // and through the physical roll; NPC panic still owns its own pose.
      stopReload(cave);
      c.burnAge = c.rollTime = c.puff = 0;
      c.spread.fill(0);
      c.burnTime.fill(0);
      updateFireSpread(cave);
      if (cave === player) poseWeapon(cave);
      ctx.fx.say(cave, "HOT! DROP & ROLL!", 2);
      return true;
    };
    const updateFireThreats = () => {
      const gorillas = ctx.fireThreats ? ctx.fireThreats() : null;
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const cave = crewList[caveIndex];
        const panic = cave.camp.panic, memory = panic.memory, gorillaMemory = panic.gorillaMemory, p = cave.root.position;
        panic.threat = null;
        panic.remembered = false;
        panic.escapeX = panic.escapeZ = 0;
        if (cave === player || !cave.root.visible || cave.state === "away") { memory.fill(0); gorillaMemory.fill(0); continue; }
        if (cave.camp.rolling) continue;
        const reach = panic.active ? FIRE_FLEE_CLEAR : FIRE_FLEE_REACH, feet = p.y - cave.baseY;
        let nearest = Infinity;
        for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
          const other = crewList[otherIndex];
          const at = other.index * 4;
          if (other === cave || !other.root.visible || !other.camp.burning) { memory[at + 3] = 0; continue; }
          const q = other.root.position, floor = other.camp.rolling ? other.camp.floor : q.y - other.baseY;
          const floorReach = Math.max(0.8, cave.bodyHeight * 0.65);
          if (Math.abs(feet - floor) > floorReach) { memory[at + 3] = 0; continue; }
          const distance = Math.hypot(p.x - q.x, p.z - q.z);
          const y = Math.max(feet, floor) + Math.min(cave.bodyHeight, other.bodyHeight) * 0.35;
          if (distance < reach && (!ctx.fireReachable || ctx.fireReachable(p.x, y, p.z, q.x, y, q.z))) {
            memory[at] = q.x; memory[at + 1] = q.z; memory[at + 2] = floor; memory[at + 3] = 1;
          } else if (memory[at + 3] && distance >= Math.max(FIRE_FLEE_CLEAR + FIRE_MEMORY_RELEASE, Math.hypot(p.x - memory[at], p.z - memory[at + 1]) + FIRE_MEMORY_RELEASE)) {
            // Running out of sight does not make a stationary fire safe; only a receding or dead source frees its memory.
            memory[at + 3] = 0;
          }
          if (!memory[at + 3]) continue;
          panic.remembered = true;
          const dx = p.x - memory[at], dz = p.z - memory[at + 1], rememberedDistance = Math.hypot(dx, dz);
          if (rememberedDistance >= FIRE_FLEE_CLEAR || Math.abs(feet - memory[at + 2]) > floorReach) continue;
          if (rememberedDistance < nearest) { nearest = rememberedDistance; panic.threat = other; }
          const weight = (FIRE_FLEE_CLEAR - rememberedDistance) / Math.max(0.04, rememberedDistance * rememberedDistance);
          panic.escapeX += dx * weight; panic.escapeZ += dz * weight;
        }
        const canFleeRage = gorillas && !cave.humanControlled && !cave.remoteControlled
          && !cave.puppet && !cave.grabbedBy && !cave.health.stunned && !cave.leap.thrown;
        if (gorillas) for (let otherIndex = 0; otherIndex < gorillas.length; otherIndex++) {
          const other = gorillas[otherIndex], at = otherIndex * 4;
          // Rage shares the remembered flee direction, never ignition or
          // drop-and-roll. runCamp stands resting NPCs and runs on grounded feet.
          const raging = canFleeRage && other.rage?.active;
          if (!other.active || !other.root.visible || !other.fire.burning && !raging) { gorillaMemory[at + 3] = 0; continue; }
          const q = other.root.position, floor = q.y;
          const floorReach = Math.max(0.8, Math.min(cave.bodyHeight, other.height) * 0.65);
          if (Math.abs(feet - floor) > floorReach) { gorillaMemory[at + 3] = 0; continue; }
          const distance = Math.hypot(p.x - q.x, p.z - q.z);
          const y = Math.max(feet, floor) + Math.min(cave.bodyHeight, other.height) * 0.35;
          if (distance < reach && (!ctx.fireReachable || ctx.fireReachable(p.x, y, p.z, q.x, y, q.z))) {
            gorillaMemory[at] = q.x; gorillaMemory[at + 1] = q.z; gorillaMemory[at + 2] = floor; gorillaMemory[at + 3] = 1;
          } else if (gorillaMemory[at + 3] && distance >= Math.max(FIRE_FLEE_CLEAR + FIRE_MEMORY_RELEASE,
            Math.hypot(p.x - gorillaMemory[at], p.z - gorillaMemory[at + 1]) + FIRE_MEMORY_RELEASE)) gorillaMemory[at + 3] = 0;
          if (!gorillaMemory[at + 3]) continue;
          panic.remembered = true;
          const dx = p.x - gorillaMemory[at], dz = p.z - gorillaMemory[at + 1], rememberedDistance = Math.hypot(dx, dz);
          if (rememberedDistance >= FIRE_FLEE_CLEAR || Math.abs(feet - gorillaMemory[at + 2]) > floorReach) continue;
          if (rememberedDistance < nearest) { nearest = rememberedDistance; panic.threat = other; }
          const weight = (FIRE_FLEE_CLEAR - rememberedDistance) / Math.max(0.04, rememberedDistance * rememberedDistance);
          panic.escapeX += dx * weight; panic.escapeZ += dz * weight;
        }
      }
    };
    const runPanic = (cave, dt) => {
      const c = cave.camp, panic = c.panic, p = cave.root.position;
      clearHeadLook(cave);
      if (panic.threat && Math.hypot(panic.escapeX, panic.escapeZ) > 1e-6) panic.heading = Math.atan2(panic.escapeX, panic.escapeZ);
      else if (c.burning && c.burnAge >= panic.turnAt) {
        panic.heading += (panic.rand() - 0.5) * 2.8;
        panic.turnAt = c.burnAge + 0.55 + panic.rand() * 0.8;
      }
      const tx = p.x + Math.sin(panic.heading) * 3, tz = p.z + Math.cos(panic.heading) * 3;
      let remaining = panic.speed * dt * (inBananas(cave) ? 0.5 : 1), moved = 0;
      // Physical substeps keep the fast run solid; direct targets deliberately bypass the path network.
      while (remaining > 1e-8) {
        const distance = walkToward(cave, tx, tz, remaining);
        if (!distance) break;
        remaining -= distance; moved += distance;
      }
      if (moved > 0) {
        panic.phase += moved * 5;
        walkPose(cave, panic.phase);
        p.y = groundY(cave);
        if (c.burning && !panic.threat && cave.avoidance.active) panic.heading = cave.root.rotation.y;
      } else standPose(cave);
      if (c.burning) {
        cave.parts.armR.rotation.x = -1.8 + Math.sin(panic.phase) * 0.3;
        cave.parts.armL.rotation.x = -1.8 - Math.sin(panic.phase) * 0.3;
      }
      cave.parts.snack.visible = cave.parts.gun.visible = false;
    };
    const dropRoll = (cave = player) => {
      if (!cave || !cave.camp.burning) return false;
      const c = cave.camp;
      if (c.rolling) return true;
      clearShoulder(cave);
      if (cave === player) elevatePlayer(0);
      if (cave.jet) {
        cave.jet.thrust = false;
        cave.jet.spending = false;
        cave.jet.power = 0;
        cave.jet.flame.visible = false;
      }
      cave.walk = null;
      releaseBuild(cave);
      cave.hop = cave.hopV = cave.cheer = cave.catchT = 0;
      cave.leap.vx = cave.leap.vz = 0;
      c.rolling = true;
      c.rollTime = 0;
      c.rollScorch.set(c.scorch);
      c.fadeTime = SOOT_SECONDS;
      c.x = cave.root.position.x; c.z = cave.root.position.z;
      c.floor = groundY(cave) - cave.baseY;
      c.heading = cave.root.rotation.y;
      math.quat.fromEuler(c.base, -Math.PI / 2, c.heading, 0);
      cave.root.quaternion = c.rotation;
      return true;
    };
    const runCamp = (cave, dt) => {
      cave.root.position.y += cave.restLower; cave.restLower = 0;
      const c = cave.camp, parts = cave.parts, p = cave.root.position;
      if (c.seat || c.rolling) clearHeadLook(cave);
      if (cave !== player && cave.root.visible && cave.state !== "away" && !c.rolling) {
        if (c.burning || c.panic.threat || c.panic.remembered) {
          if (c.seat && !standPlayer(cave)) return true;
          beginPanic(cave);
          if (grounded(cave)) {
            if (c.burning && c.burnAge >= c.reactionDelay) dropRoll(cave);
            else if (!c.burning && !c.panic.threat) { standPose(cave); return true; }
            else { runPanic(cave, dt); return true; }
          }
        } else if (c.panic.active && grounded(cave)) {
          finishPanic(cave);
        }
      }
      if (c.seat) {
        if (cave === player && !c.seat.lockMovement && Math.hypot(steer.x, steer.z) > 0.05 && standPlayer(cave)) return false;
        standPose(cave);
        parts.legR.rotation.x = parts.legL.rotation.x = -Math.PI / 2;
        parts.armR.rotation.x = parts.armL.rotation.x = -0.75;
        parts.snack.visible = false;
        return true;
      }
      if (!c.rolling) return false;
      c.rollTime = Math.min(ROLL_SECONDS, c.rollTime + dt);
      const progress = c.rollTime / ROLL_SECONDS, cooled = progress * progress * (3 - 2 * progress);
      for (let i = 0; i < BODY_PARTS.length; i++) c.scorch[i] = lerp(c.rollScorch[i], Math.max(c.rollScorch[i], c.spread[i]), cooled);
      const angle = Math.sin(c.rollTime * 7) * 1.25, offset = Math.sin(c.rollTime * 7) * 0.35;
      const x = c.x + Math.cos(c.heading) * offset, z = c.z - Math.sin(c.heading) * offset;
      // Keep the sweep on clear ground: a wall or bench limits travel while the roll still puts flames out in place.
      if (flyable(p.x, p.z, x, z, c.floor + 0.02, Math.max(0.5, cave.bodyHeight * 0.35), cave)) { p.x = x; p.z = z; }
      p.y = c.floor + cave.traits.height * 0.26;
      math.quat.fromEuler(c.turn, 0, angle, 0);
      math.quat.multiply(c.rotation, c.base, c.turn);
      parts.legR.rotation.x = parts.legL.rotation.x = -0.65;
      parts.armR.rotation.x = parts.armL.rotation.x = -1.5;
      parts.snack.visible = false;
      // Plant the lowest part of the rotating body so wide shoulders do not sink into the floor mid-roll.
      BL.scene.updateWorld(cave.root, cave.root.parent ? cave.root.parent.world : undefined);
      let bottom = Infinity;
      for (const key of BODY_PARTS) {
        const part = parts[key], b = BL.scene.boundsOf(part.geometry), m = part.world;
        const center = m[1] * b.center[0] + m[5] * b.center[1] + m[9] * b.center[2] + m[13];
        const extent = (Math.abs(m[1]) * (b.max[0] - b.min[0]) + Math.abs(m[5]) * (b.max[1] - b.min[1]) + Math.abs(m[9]) * (b.max[2] - b.min[2])) * 0.5;
        bottom = Math.min(bottom, center - extent);
      }
      p.y += c.floor + 0.015 - bottom;
      if (c.rollTime === ROLL_SECONDS) {
        c.burning = c.rolling = false;
        c.fadeTime = SOOT_SECONDS;
        c.smokeTime = 3;
        c.cooldown = 1.2;
        c.puff = 0;
        cave.root.quaternion = null;
        cave.root.rotation.x = cave.root.rotation.z = 0;
        cave.root.rotation.y = c.heading;
        standPose(cave);
        p.y = groundY(cave);
        finishPanic(cave);
      }
      return true;
    };
    const updateFireSpread = (cave) => {
      const c = cave.camp;
      BL.scene.updateWorld(cave.root, cave.root.parent ? cave.root.parent.world : undefined);
      const front = cave.root.position.y - cave.baseY + cave.bodyHeight * Math.min(1.05, 0.12 + c.burnAge * 0.09);
      for (let i = 0; i < BODY_PARTS.length; i++) {
        const part = cave.parts[BODY_PARTS[i]], b = BL.scene.boundsOf(part.geometry), m = part.world;
        const center = m[1] * b.center[0] + m[5] * b.center[1] + m[9] * b.center[2] + m[13];
        const extent = (Math.abs(m[1]) * (b.max[0] - b.min[0]) + Math.abs(m[5]) * (b.max[1] - b.min[1]) + Math.abs(m[9]) * (b.max[2] - b.min[2])) * 0.5;
        // Hands (index >= 4) catch from the legs after a short delay.
        const transfer = i >= 4 ? clamp((c.burnAge - 1) / 2, 0, 1) : 1;
        c.spread[i] = Math.max(c.spread[i], clamp((front - center + extent) / (extent * 2), 0, 1) * transfer);
      }
    };
    const fireView = (cave, out) => {
      let coverage = 0, ember = 0, soot = 0;
      if (cave) {
        const c = cave.camp, progress = c.rollTime / ROLL_SECONDS;
        const heat = c.burning ? (c.rolling ? 1 - progress * progress * (3 - 2 * progress) : 1) : 0;
        for (let i = 0; i < BODY_PARTS.length; i++) {
          coverage += c.spread[i] * heat;
          ember += c.spread[i] * (0.22 + 0.78 * c.burnTime[i] / EMBER_HEAT_SECONDS) * heat;
          soot += c.scorch[i];
        }
      }
      out.coverage = clamp(coverage / BODY_PARTS.length, 0, 1);
      out.ember = clamp(ember / BODY_PARTS.length, 0, 1);
      out.soot = clamp(soot / BODY_PARTS.length, 0, 1);
      return out;
    };
    const updateCampEffects = (cave, dt) => {
      const c = cave.camp;
      c.cooldown = Math.max(0, c.cooldown - dt);
      if (c.burning && !c.rolling) {
        c.burnAge += dt;
        updateFireSpread(cave);
      }
      const remaining = Math.max(0, c.fadeTime - (c.rolling ? 0 : dt)), fade = c.fadeTime > 0 ? remaining / c.fadeTime : 0;
      c.fadeTime = remaining;
      c.soot = 0;
      const progress = c.rollTime / ROLL_SECONDS;
      const heat = c.burning ? (c.rolling ? 1 - progress * progress * (3 - 2 * progress) : 1) : 0;
      for (let i = 0; i < BODY_PARTS.length; i++) {
        if (c.burning && !c.rolling && c.spread[i] > 0) c.burnTime[i] = Math.min(EMBER_HEAT_SECONDS, c.burnTime[i] + dt);
        c.scorch[i] *= fade;
        const part = cave.parts[BODY_PARTS[i]];
        part.scorch = c.scorch[i];
        // Each limb heats from when the fire front reaches it; older flames brighten, then cool into char in a roll.
        const temperature = 0.22 + 0.78 * c.burnTime[i] / EMBER_HEAT_SECONDS;
        part.ember = c.spread[i] * temperature * heat * (0.96 + Math.sin(elapsed * 11 + cave.phase + i * 1.7) * 0.025 + Math.sin(elapsed * 23 + i) * 0.015);
        // Fixed head surfaces such as the gas mask share the head's heat and char; removable hat and face do not.
        if (part === cave.parts.head) for (const child of part.children) {
          if (child === cave.parts.hat || child === cave.parts.face) continue;
          child.ember = part.ember;
          child.scorch = part.scorch;
        }
        const fingers = part === cave.parts.armR ? cave.parts.fingersR : part === cave.parts.armL ? cave.parts.fingersL : null;
        if (fingers) { fingers.ember = part.ember; fingers.scorch = part.scorch; }
        c.soot = Math.max(c.soot, c.scorch[i]);
      }
      c.smokeTime = Math.max(0, c.smokeTime - dt);
      if (!c.burning && c.smokeTime === 0 || !cave.root.visible || dt === 0) return;
      c.puff -= dt;
      if (c.puff > 0) return;
      c.puff = c.burning ? 0.08 : 0.2;
      BL.scene.updateWorld(cave.root, cave.root.parent ? cave.root.parent.world : undefined);
      let total = 0;
      for (let i = 0; i < BODY_PARTS.length; i++) total += c.spread[i];
      const count = c.burning ? Math.ceil(4 * (c.rolling ? 1 - c.rollTime / ROLL_SECONDS : 1)) : 0;
      for (let i = 0; i < count + 1; i++) {
        // Emit from the reached surfaces of the real limbs; their world transforms keep flames attached while moving.
        let pick = Math.random() * total, index = BODY_PARTS.length - 1;
        for (let j = 0; j < BODY_PARTS.length; j++) {
          pick -= c.spread[j];
          if (pick < 0) { index = j; break; }
        }
        const part = cave.parts[BODY_PARTS[index]], b = BL.scene.boundsOf(part.geometry), m = part.world;
        const side = Math.random() < 0.5, edge = Math.random() < 0.5 ? -1 : 1;
        const x = side ? b.center[0] + edge * ((b.max[0] - b.min[0]) * 0.5 + 0.035) : lerp(b.min[0], b.max[0], Math.random());
        const y = lerp(b.min[1], b.max[1], Math.random() * c.spread[index]);
        const z = side ? lerp(b.min[2], b.max[2], Math.random()) : b.center[2] + edge * ((b.max[2] - b.min[2]) * 0.5 + 0.035);
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (i < count) ctx.fx.spawnParticle(BURN_FLAMES[i % 2], wx, wy, wz, (Math.random() - 0.5) * 0.2, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.2, 0.45, 2, -0.2, -Infinity);
        else ctx.fx.spawnParticle(BURN_SMOKE, wx, wy + 0.12, wz, (Math.random() - 0.5) * 0.25, 0.6, (Math.random() - 0.5) * 0.25, 1.2, 0.5, -0.15, -Infinity);
      }
    };
    const updateFireContacts = () => {
      let burning = false;
      for (let i = 0; i < crewList.length; i++) if (crewList[i].root.visible && crewList[i].camp.burning) { burning = true; break; }
      if (!burning) return;
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const cave = crewList[caveIndex];
        const c = cave.camp, p = cave.root.position, b = c.contactBounds;
        c.contactBurning = c.burning;
        if (!cave.root.visible || cave.state === "away") continue;
        if (!cave.root.quaternion) {
          // 0.38 half-extent matches the standing collision body, head clearance included.
          b[0] = p.x - 0.38; b[1] = p.y - cave.baseY; b[2] = p.z - 0.38;
          b[3] = p.x + 0.38; b[4] = b[1] + cave.bodyHeight; b[5] = p.z + 0.38;
        } else {
          BL.scene.updateWorld(cave.root, cave.root.parent ? cave.root.parent.world : undefined);
          b[0] = b[1] = b[2] = Infinity;
          b[3] = b[4] = b[5] = -Infinity;
          for (const key of BODY_PARTS) {
            const part = cave.parts[key], bounds = BL.scene.boundsOf(part.geometry), m = part.world;
            for (let axis = 0; axis < 3; axis++) {
              const center = m[axis] * bounds.center[0] + m[axis + 4] * bounds.center[1] + m[axis + 8] * bounds.center[2] + m[axis + 12];
              const extent = (Math.abs(m[axis]) * (bounds.max[0] - bounds.min[0]) + Math.abs(m[axis + 4]) * (bounds.max[1] - bounds.min[1]) + Math.abs(m[axis + 8]) * (bounds.max[2] - bounds.min[2])) * 0.5;
              b[axis] = Math.min(b[axis], center - extent);
              b[axis + 3] = Math.max(b[axis + 3], center + extent);
            }
          }
        }
      }
      for (let sourceIndex = 0; sourceIndex < crewList.length; sourceIndex++) {
        const source = crewList[sourceIndex];
        if (!source.root.visible || !source.camp.contactBurning) continue;
        const a = source.camp.contactBounds;
        for (let targetIndex = 0; targetIndex < crewList.length; targetIndex++) {
          const target = crewList[targetIndex];
          if (source === target || !target.root.visible || target.state === "away" || target.camp.burning || target.camp.cooldown > 0) continue;
          const b = target.camp.contactBounds;
          if (a[1] > b[4] + 0.06 || b[1] > a[4] + 0.06) continue;
          if (!source.root.quaternion && !target.root.quaternion) {
            // A blocked substep stops just outside the collision radius; 0.81 lets the flame fringe still transfer fire.
            if (Math.hypot(source.root.position.x - target.root.position.x, source.root.position.z - target.root.position.z) > 0.81) continue;
          } else if (Math.hypot(Math.max(0, a[0] - b[3], b[0] - a[3]), Math.max(0, a[2] - b[5], b[2] - a[5])) > 0.06) continue;
          const y = (Math.max(a[1], b[1]) + Math.min(a[4], b[4])) * 0.5;
          if (ctx.fireReachable && !ctx.fireReachable((a[0] + a[3]) * 0.5, y, (a[2] + a[5]) * 0.5, (b[0] + b[3]) * 0.5, y, (b[2] + b[5]) * 0.5)) continue;
          ignite(target);
        }
      }
    };
    const sleepParts = (cave, k) => {
      clearHeadLook(cave);
      const parts = cave.parts, travel = cave.bedTravel;
      parts.armR.quaternion = parts.armL.quaternion = null;
      parts.armR.rotation.y = parts.armL.rotation.y = 0;
      math.quat.fromEuler(parts.fingersR.quaternion, 0, Math.PI, 0);
      math.quat.fromEuler(parts.fingersL.quaternion, 0, Math.PI, 0);
      parts.armR.position.x = lerp(cave.sleepParts.armRX, travel.armRX, k);
      parts.armL.position.x = lerp(cave.sleepParts.armLX, travel.armLX, k);
      parts.armR.rotation.x = parts.armL.rotation.x = lerp(-0.2, 0, k);
      parts.armR.rotation.z = lerp(-0.12, travel.armRZ, k);
      parts.armL.rotation.z = lerp(0.12, travel.armLZ, k);
      parts.legR.rotation.x = parts.legR.rotation.z = parts.legL.rotation.x = parts.legL.rotation.z = 0;
      parts.head.position.x = cave.sleepParts.headX + travel.headDropX * k;
      parts.head.position.y = cave.sleepParts.headY + travel.headDropY * k;
      parts.head.position.z = cave.sleepParts.headZ + travel.headDropZ * k;
      parts.head.rotation.x = parts.head.rotation.y = 0;
    };
    const updateSleepHead = (cave) => {
      const p = cave.root.position, head = cave.parts.head.position;
      math.quat.rotateVec(MUZZLE, cave.sleepRotation, head.x, head.y + cave.traits.height * 3.5 / 16, head.z);
      setVec(cave.sleepHead, p.x + MUZZLE[0], p.y + MUZZLE[1], p.z + MUZZLE[2]);
    };
    const fitSleepPose = (cave, pose) => {
      clearHeadLook(cave);
      const travel = cave.bedTravel, bed = cave.bedroll, r = cave.root;
      const px = r.position.x, py = r.position.y, pz = r.position.z, hx = cave.parts.head.position.x, hy = cave.parts.head.position.y, hz = cave.parts.head.position.z, ax = cave.parts.armR.position.x, bx = cave.parts.armL.position.x;
      const az = cave.parts.armR.rotation.z, bz = cave.parts.armL.rotation.z, side = pose === "left" || pose === "right";
      travel.headDrop = travel.headDropX = travel.headDropY = travel.headDropZ = 0;
      travel.armRX = cave.sleepParts.armRX; travel.armLX = cave.sleepParts.armLX;
      travel.armRZ = side ? 0.35 : 0; travel.armLZ = -travel.armRZ;
      sleepParts(cave, 1);
      r.quaternion = null;
      setVec(r.position, 0, 0, 0);
      if (pose === "left") setVec(r.rotation, 0, Math.PI / 2, -Math.PI / 2);
      else if (pose === "right") setVec(r.rotation, 0, -Math.PI / 2, Math.PI / 2);
      else if (pose === "stomach") setVec(r.rotation, Math.PI / 2, Math.PI, 0);
      else setVec(r.rotation, -Math.PI / 2, 0, 0);
      math.quat.fromEuler(SLEEP_BASE, r.rotation.x, r.rotation.y, r.rotation.z);
      measureSleepPitch(cave, 0);
      if (bed.outdoor) {
        // Bare rock supports the whole body: no mattress compression or pillow.
        travel.pitch = travel.restZ = travel.compression = 0;
        travel.restY = 0.03 - Math.min(SLEEP_BOUNDS.min, SLEEP_BOUNDS.headMin);
        math.quat.fromAxisAngle(SLEEP_TILT, 0, 1, 0, bed.node.rotation.y);
        math.quat.multiply(cave.sleepTargetRotation, SLEEP_TILT, cave.sleepTargetRotation);
        setVec(r.position, px, py, pz);
        cave.parts.head.position.x = hx; cave.parts.head.position.y = hy; cave.parts.head.position.z = hz;
        cave.parts.armR.position.x = ax; cave.parts.armL.position.x = bx;
        cave.parts.armR.rotation.z = az; cave.parts.armL.rotation.z = bz;
        r.quaternion = cave.sleepRotation;
        travel.pose = pose;
        return;
      }
      let pitch = 0;
      if (side) {
        // Neck and legs share one rigid body transform; solve pitch from the real pillow face and supporting foot.
        // The broader shoulder/side may compress the mattress between those ends.
        let lo = -Math.PI / 6, hi = Math.PI / 6;
        for (let i = 0; i < 20; i++) {
          pitch = (lo + hi) / 2;
          measureSleepPitch(cave, pitch);
          travel.restY = bed.sleep.surface - SLEEP_COMPRESSION - SLEEP_BOUNDS.feetMin;
          math.quat.rotateVec(MUZZLE, cave.sleepTargetRotation, cave.sleepParts.headX, cave.sleepParts.headY + cave.traits.height * 3.5 / 16, cave.sleepParts.headZ);
          travel.restZ = bed.sleep.pillowZ - MUZZLE[2];
          if (pillowMinimum(cave, bed, true) < bed.sleep.pillowTop - SLEEP_COMPRESSION * 0.6) lo = pitch;
          else hi = pitch;
        }
        pitch = hi;
      } else if (SLEEP_BOUNDS.feetMin > SLEEP_BOUNDS.coreMin) {
        let lo = 0, hi = Math.PI / 3;
        for (let i = 0; i < 20; i++) {
          pitch = (lo + hi) / 2;
          measureSleepPitch(cave, pitch);
          if (SLEEP_BOUNDS.feetMin > SLEEP_BOUNDS.coreMin) lo = pitch;
          else hi = pitch;
        }
        pitch = hi;
      }
      measureSleepPitch(cave, pitch);
      travel.pitch = pitch;
      travel.restY = bed.sleep.surface - SLEEP_COMPRESSION - (side ? SLEEP_BOUNDS.feetMin : SLEEP_BOUNDS.min);
      // Keep legs straight; tilt the body only as far as the actual feet require.
      // Only head faces over the pillow give support; overhanging hair may rest lower on the sheet.
      const q = cave.sleepTargetRotation;
      math.quat.rotateVec(MUZZLE, q, cave.sleepParts.headX, cave.sleepParts.headY + cave.traits.height * 3.5 / 16, cave.sleepParts.headZ);
      travel.restZ = bed.sleep.pillowZ - MUZZLE[2];
      travel.compression = SLEEP_COMPRESSION;
      if (side) {
        // Left pose rests armL: the lower arm hugs the torso instead of driving its shoulder through the mattress.
        const arm = pose === "left" ? cave.parts.armL : cave.parts.armR;
        SLEEP_BOUNDS.min = Infinity;
        measureSleeper(arm, false, cave.parts.head);
        const tuck = Math.max(0, bed.sleep.surface - SLEEP_SIDE_COMPRESSION - travel.restY - SLEEP_BOUNDS.min) / Math.cos(pitch);
        if (pose === "left") arm.position.x = travel.armLX -= tuck;
        else arm.position.x = travel.armRX += tuck;
        measureSleepPitch(cave, pitch);
        travel.compression = Math.max(SLEEP_COMPRESSION, bed.sleep.surface - travel.restY - Math.min(SLEEP_BOUNDS.min, SLEEP_BOUNDS.headMin));
      } else {
        travel.headDrop = pillowMinimum(cave, bed, true) - (bed.sleep.pillowTop - SLEEP_COMPRESSION * 0.6);
        SLEEP_INVERSE[0] = -q[0]; SLEEP_INVERSE[1] = -q[1]; SLEEP_INVERSE[2] = -q[2]; SLEEP_INVERSE[3] = q[3];
        math.quat.rotateVec(MUZZLE, SLEEP_INVERSE, 0, -travel.headDrop, 0);
        travel.headDropX = MUZZLE[0]; travel.headDropY = MUZZLE[1]; travel.headDropZ = MUZZLE[2];
      }
      math.quat.fromAxisAngle(SLEEP_TILT, 0, 1, 0, bed.node.rotation.y);
      math.quat.multiply(q, SLEEP_TILT, q);
      setVec(r.position, px, py, pz);
      cave.parts.head.position.x = hx; cave.parts.head.position.y = hy; cave.parts.head.position.z = hz;
      cave.parts.armR.position.x = ax; cave.parts.armL.position.x = bx;
      cave.parts.armR.rotation.z = az; cave.parts.armL.rotation.z = bz;
      r.quaternion = cave.sleepRotation;
      travel.pose = pose;
    };
    const lieDown = (cave) => {
      const travel = cave.bedTravel, r = cave.root;
      travel.fromX = r.position.x; travel.fromY = r.position.y; travel.fromZ = r.position.z; travel.fromYaw = r.rotation.y;
      resetPose(cave);
      cave.parts.club.visible = false;
      for (const node of cave.sleepParts.equipment) node.visible = false;
      if (cave.bedroll.outdoor) {
        for (const node of cave.swagNodes) node.visible = false;
        for (const model of cave.magazineModels) if (model) model.node.visible = false;
      }
      stopBurst(cave);
      stopReload(cave, true);
      putBedWeapons(cave);
      math.quat.fromEuler(cave.sleepFromRotation, 0, travel.fromYaw, 0);
      math.quat.copy(cave.sleepRotation, cave.sleepFromRotation);
      fitSleepPose(cave, "left");
      sleepParts(cave, 0);
      travel.mode = "lie";
      travel.phase = 0;
      travel.route = null;
      travel.roll = 1;
      updateSleepHead(cave);
    };
    const turnSleep = (cave, pose) => {
      clearHeadLook(cave);
      const travel = cave.bedTravel;
      if (travel.pose === pose) return;
      travel.fromX = cave.root.position.x; travel.fromY = cave.root.position.y; travel.fromZ = cave.root.position.z;
      travel.fromHeadX = cave.parts.head.position.x; travel.fromHeadY = cave.parts.head.position.y; travel.fromHeadZ = cave.parts.head.position.z;
      travel.fromArmRX = cave.parts.armR.position.x; travel.fromArmLX = cave.parts.armL.position.x; travel.fromCompression = travel.compression;
      travel.fromArmRZ = cave.parts.armR.rotation.z; travel.fromArmLZ = cave.parts.armL.rotation.z;
      math.quat.copy(cave.sleepFromRotation, cave.sleepRotation);
      fitSleepPose(cave, pose);
      travel.roll = 0;
    };
    const shoulderNeighbor = (cave, other) => {
      if (other === cave || !other.root.visible || other.state === "away" || other.root.quaternion || other.camp.seat) return false;
      const feet = cave.root.position.y - cave.baseY, floor = other.root.position.y - other.baseY;
      return feet < floor + other.bodyHeight - 0.05 && feet + cave.bodyHeight > floor + 0.05 && Math.abs(feet - floor) < STEP;
    };
    const snapshotTraffic = (cave) => {
      const traffic = cave.traffic, travel = cave.bedTravel, work = cave.work, p = cave.root.position;
      traffic.moving = false;
      if (cave === player || !cave.root.visible || cave.grabbedBy || cave.camp.seat || cave.camp.panic.active || cave.hop > 0 || cave.hopV > 0) return;
      let target = null;
      if (cave.roofEscape.active) { traffic.tx = traffic.tz = 0; traffic.moving = true; }
      else if (travel.mode === "walk") target = travel.route[travel.index];
      else if (!travel.mode && (cave.state === "working" || cave.state === "chilling")) {
        if (cave.walk) { traffic.tx = cave.walk.tx; traffic.tz = cave.walk.tz; traffic.moving = true; }
        else if (workSites && cave.state === "working") {
          if (work.phase === "outbound" || work.phase === "return") target = work.index >= 0 ? workSites[work.site].route[work.index] : cave.slot;
          else if (work.phase === "station") target = work.position;
        }
      }
      if (target) { traffic.tx = target.x; traffic.tz = target.z; traffic.moving = true; }
      if (!traffic.moving) return;
      let dx = traffic.tx - p.x, dz = traffic.tz - p.z;
      traffic.distance = Math.hypot(dx, dz);
      const path = cave.pathing;
      const detour = cave.avoidance.detour;
      if (detour.site >= 0 && detour.goalX === traffic.tx && detour.goalZ === traffic.tz) {
        dx = detour.x - p.x; dz = detour.z - p.z;
      } else if (cave.state === "working" && path && path.tx === traffic.tx && path.tz === traffic.tz && path.index < path.count) {
        dx = path.targetX - p.x; dz = path.targetZ - p.z;
      }
      const length = Math.hypot(dx, dz);
      traffic.moving = length > 1e-6;
      traffic.speed = cave.roofEscape.active ? RUSH_SPEED : cave.walk ? cave.walk.speed : travel.mode === "walk" ? 2 : RUSH_SPEED;
      if (traffic.moving) { traffic.fx = dx / length; traffic.fz = dz / length; }
    };
    const waitingFor = (other, cave) => {
      // Following and crossing share one wait graph. Never close a cycle,
      // including a worker queue whose leader is yielding back to its tail.
      for (let depth = 0; other && depth < crewList.length; depth++) {
        if (other === cave) return true;
        const traffic = other.traffic;
        other = traffic.waiting ? traffic.leader || traffic.crossing : null;
      }
      return false;
    };
    const following = (cave, other, gap) => {
      const a = cave.traffic, b = other.traffic;
      if (!b.moving || !shoulderNeighbor(cave, other) || waitingFor(other, cave)) return false;
      // A yielding nonworker is stationary traffic, not the leader of a worker
      // queue. Following it can close a cycle with the worker it yielded to.
      if (cave.state === "working" && other.state !== "working" && (b.waiting || b.crossing === cave || a.fx * b.fx + a.fz * b.fz < 0.95)) return false;
      const sameGoal = Math.hypot(a.tx - b.tx, a.tz - b.tz) <= 0.8;
      if (a.fx * b.fx + a.fz * b.fz < (sameGoal && a.leader === other ? -0.2 : sameGoal ? 0.7 : 0.85)) return false;
      const dx = other.shoulder.snapX - cave.shoulder.snapX, dz = other.shoulder.snapZ - cave.shoulder.snapZ;
      const along = dx * a.fx + dz * a.fz, across = dx * a.fz - dz * a.fx;
      // Equal progress has one deterministic leader. A stopped follower never
      // makes its leader yield back, even when both start shoulder to shoulder.
      if (along < -0.08 || sameGoal && b.distance > a.distance + 0.05
        || (sameGoal ? Math.abs(b.distance - a.distance) <= 0.05 : Math.abs(along) <= 0.08) && other.index > cave.index) return false;
      return Math.abs(across) < 0.85 && along < gap;
    };
    const crossingSoon = (cave, other, holding = false) => {
      const a = cave.traffic, b = other.traffic;
      if (!b.moving || !shoulderNeighbor(cave, other) || waitingFor(other, cave)) return false;
      const workerFirst = cave.state !== "working" && other.state === "working";
      if (cave.state === "working" && other.state !== "working" || !workerFirst && other.index >= cave.index) return false;
      const dot = a.fx * b.fx + a.fz * b.fz;
      const dx = other.shoulder.snapX - cave.shoulder.snapX, dz = other.shoulder.snapZ - cave.shoulder.snapZ;
      if (dx * dx + dz * dz > (workerFirst ? 20.25 : 9)) return false;
      if (workerFirst && holding) {
        // Once waiting, let the worker's shoulders pass the crossing before
        // stepping back into its lane. A turn away releases the wait too.
        return dx * b.fx + dz * b.fz < 0.95 && Math.abs(dx * b.fz - dz * b.fx) < 2.5;
      }
      if (dot < (workerFirst ? -0.94 : -0.7) || dot > (workerFirst ? 0.94 : 0.7)) return false;
      const vx = b.fx * b.speed - a.fx * a.speed, vz = b.fz * b.speed - a.fz * a.speed;
      const closing = dx * vx + dz * vz, speed2 = vx * vx + vz * vz;
      if (closing >= 0 || speed2 < 1e-6) return false;
      const time = Math.min(workerFirst ? 1.1 : 0.65, -closing / speed2), gap = workerFirst ? 1.05 : 0.8;
      // Workers have priority independent of roster order. Look far enough
      // ahead to stop a crossing walker before it occupies the working lane.
      return (dx + vx * time) ** 2 + (dz + vz * time) ** 2 < gap * gap;
    };
    const spaceWalker = (cave) => {
      const traffic = cave.traffic;
      if (!traffic.moving) { traffic.waiting = false; traffic.leader = traffic.crossing = null; return; }
      if (traffic.crossing && crossingSoon(cave, traffic.crossing, true)) { traffic.waiting = true; traffic.leader = null; return; }
      traffic.crossing = null;
      if (cave.state !== "working") for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
        const other = crewList[otherIndex];
        if (other.state === "working" && crossingSoon(cave, other)) {
          traffic.crossing = other; traffic.waiting = true; traffic.leader = null; return;
        }
      }
      if (traffic.leader && following(cave, traffic.leader, FOLLOW_RELEASE)) { traffic.waiting = true; return; }
      traffic.leader = null;
      for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
        const other = crewList[otherIndex];
        if (!following(cave, other, FOLLOW_GAP)) continue;
        traffic.leader = other; break;
      }
      // Separate stop and resume distances let a full gap open without
      // stop/start flicker around one boundary; branching releases immediately.
      traffic.waiting = !!traffic.leader;
      if (!traffic.waiting) for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
        const other = crewList[otherIndex];
        if (crossingSoon(cave, other)) { traffic.crossing = other; traffic.waiting = true; break; }
      }
    };
    // One swept gap, used by every walker on the island. Already inside it and
    // moving apart is allowed, so a crowd unpicks itself instead of locking.
    // Every body the scene walks that is not on the roster: the Agent and any it
    // has called in. One array, rebuilt only when that crowd changes.
    const spotOccupied = (cave, x, y, z) => {
      for (let i = 0; i < crewList.length; i++) {
        const other = crewList[i], p = other.root.position, floor = p.y - other.baseY;
        if (other !== cave && other.root.visible && y < floor + other.bodyHeight && y + cave.bodyHeight > floor
          && Math.hypot(x - p.x, z - p.z) < Math.max(SHOULDER_GAP, cave.bodyRadius + other.bodyRadius)) return true;
      }
      return false;
    };
    const outsideClear = (fromX, fromZ, x, z, y, height) => {
      const bodies = ctx.outsideActors && ctx.outsideActors();
      if (!bodies) return true;
      for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        if (y >= body.y + ctx.outsideActorHeight || y + height <= body.y) continue;
        if (!gapClear(fromX, fromZ, x, z, body, OUTSIDE_GAP)) return false;
      }
      return true;
    };
    const gapClear = (fromX, fromZ, x, z, q, gap = SHOULDER_GAP) => {
      const dx = x - fromX, dz = z - fromZ, length = dx * dx + dz * dz;
      const ox = fromX - q.x, oz = fromZ - q.z, before = ox * ox + oz * oz;
      if (before < gap * gap && (x - q.x) ** 2 + (z - q.z) ** 2 > before && ox * dx + oz * dz >= 0) return true;
      const t = length ? clamp(-(ox * dx + oz * dz) / length, 0, 1) : 0;
      return (ox + dx * t) ** 2 + (oz + dz * t) ** 2 >= gap * gap - 1e-8;
    };
    // Same swept clearance as the hub's upright actors and the lab; passing changes the path, never body radii.
    const shoulderClear = (cave, x, z) => {
      const p = cave.root.position;
      for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
        const other = crewList[otherIndex];
        if (!shoulderNeighbor(cave, other)) continue;
        if (!gapClear(p.x, p.z, x, z, other.root.position)) return false;
      }
      // Walking bodies the scene owns rather than the roster keep the same gap.
      return outsideClear(p.x, p.z, x, z, p.y - cave.baseY, cave.bodyHeight);
    };
    // The same gap from the other side: a scene's own walker against the whole crew.
    const actorClear = (fromX, fromZ, x, z, y, height) => {
      for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
        const other = crewList[otherIndex];
        if (!other.root.visible || other.state === "away" || other.root.quaternion || other.camp.seat) continue;
        const feet = other.root.position.y - other.baseY;
        if (y >= feet + other.bodyHeight || y + height <= feet) continue;
        if (!gapClear(fromX, fromZ, x, z, other.root.position, OUTSIDE_GAP)) return false;
      }
      return true;
    };
    const shoulderStep = (cave, fx, fz, distance, npc, reach = SHOULDER_REACH) => {
      const s = cave.shoulder, p = cave.root.position;
      if (cave.hop > 0 || cave.hopV > 0 || cave.root.quaternion || cave.camp.seat || cave.camp.panic.active) return -1;
      // A deliberate turn starts a new line; returning never moves an actor without input or against a new heading.
      if (s.phase && fx * s.forwardX + fz * s.forwardZ < (npc ? 0.3 : 0.94)) { s.phase = 0; s.other = null; }
      if (!s.phase) {
        let nearest = npc ? reach : SHOULDER_REACH, found = null, across = 0, rear = false;
        for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
          const other = crewList[otherIndex];
          if (!shoulderNeighbor(cave, other)) continue;
          // Spacing already owns same-direction traffic. Starting a pass as
          // that wait releases would steer the follower back into its leader.
          if (npc && following(cave, other, NPC_PASS_REACH)) continue;
          const dx = other.shoulder.snapX - s.snapX, dz = other.shoulder.snapZ - s.snapZ;
          const along = dx * fx + dz * fz, side = dx * fz - dz * fx;
          if (Math.abs(along) >= nearest || Math.abs(side) >= SHOULDER_TOUCH || dx * dx + dz * dz < SHOULDER_GAP * SHOULDER_GAP - 1e-6) continue;
          // A moving leader yields only to a faster walker closing from behind, not to standing or receding neighbours.
          if (along <= 0 && (along < -0.95 || (other.shoulder.snapVX - s.snapVX) * fx + (other.shoulder.snapVZ - s.snapVZ) * fz < 0.08)) continue;
          nearest = Math.abs(along); found = other; across = side; rear = along <= 0;
        }
        const hit = s.obstacle, prop = !!ctx.shoulderObstacle && ctx.shoulderObstacle(cave, fx, fz, reach, hit)
          && (!found || hit.minAlong < nearest - SHOULDER_GAP);
        if (!found && !prop) return -1;
        s.phase = 1; s.other = prop ? null : found; s.prop = prop; s.rear = !prop && rear;
        s.originX = p.x; s.originZ = p.z;
        s.forwardX = fx; s.forwardZ = fz;
        s.heading = npc ? Math.atan2(fx, fz) : cave.root.rotation.y;
        if (prop) across = (hit.minAcross + hit.maxAcross) * 0.5;
        const dx = prop ? fx * hit.minAlong + fz * across : found.shoulder.snapX - s.snapX;
        const dz = prop ? fz * hit.minAlong - fx * across : found.shoulder.snapZ - s.snapZ;
        const side = dx * Math.cos(s.heading) - dz * Math.sin(s.heading);
        s.side = Math.abs(side) < 0.02 ? 1 : Math.sign(side);
        s.dodge = Math.abs(across) < 0.02 ? (s.rear ? -1 : 1) : Math.sign(across);
        s.amount = prop ? clamp(1 - Math.max(hit.minContactAcross, -hit.maxContactAcross, 0) / 0.3, 0, 1) : clamp(1 - Math.abs(across) / SHOULDER_TOUCH, 0, 1);
        if (prop) s.propOffset = s.dodge > 0 ? hit.minAcross - 0.315 : hit.maxAcross + 0.315;
      }
      fx = s.forwardX; fz = s.forwardZ;
      const offset = (p.x - s.originX) * fz - (p.z - s.originZ) * fx;
      let targetOffset = 0, along = 0;
      if (s.phase === 1) {
        if (s.prop) {
          const hit = s.obstacle, progress = (p.x - s.originX) * fx + (p.z - s.originZ) * fz;
          const lineX = s.originX + fx * progress, lineZ = s.originZ + fz * progress;
          along = Math.max(0, hit.minAlong - progress);
          // Test the original line at the body's current height.
          // Keeps long benches and irregular trunks beside us until their real rear surface clears, not a broad box.
          if (!ctx.shoulderObstacleActive(hit.node) || progress > hit.minAlong + 0.3
            && ctx.shoulderPropClear(cave, lineX + fx * 0.3, lineZ + fz * 0.3)
            && (npc ? walkerClear(cave, lineX + fx * 0.3, lineZ + fz * 0.3) : canStep(cave, false, p.x, p.z, lineX + fx * 0.3, lineZ + fz * 0.3))) s.phase = 2;
          else {
            targetOffset = s.propOffset;
            s.targetYaw = s.side * s.amount * SHOULDER_TWIST * clamp((SHOULDER_REACH - along) / 0.8, 0, 1);
          }
        } else if (!shoulderNeighbor(cave, s.other)) s.phase = 2;
        else {
          const q = s.other.root.position;
          along = (q.x - p.x) * fx + (q.z - p.z) * fz;
          if ((s.rear ? along > SHOULDER_GAP + 0.12 : along < -SHOULDER_GAP - 0.12) || Math.hypot(q.x - p.x, q.z - p.z) > (npc ? NPC_PASS_REACH : SHOULDER_REACH) + 0.5) s.phase = 2;
          else {
            const otherOffset = (q.x - s.originX) * fz - (q.z - s.originZ) * fx;
            targetOffset = -s.dodge * Math.max(0, SHOULDER_GAP + 0.015 - s.dodge * otherOffset);
            s.targetYaw = (s.rear ? -1 : 1) * s.side * s.amount * SHOULDER_TWIST * clamp((SHOULDER_REACH - Math.abs(along)) / 0.8, 0, 1);
          }
        }
      }
      if (s.phase === 2 && Math.abs(offset) < 0.005) { s.phase = 0; s.other = null; s.obstacle.node = null; return -1; }
      s.attempted = true;
      const turn = Math.atan2(targetOffset - offset, s.phase === 1 ? Math.max(0.28, Math.abs(along) * 0.65) : 0.6);
      let moved = false;
      // Start with a proportional sidestep, then tighten toward the tangent in small angular steps when close.
      for (let i = 0; i <= 18; i++) {
        const angle = i ? turn - s.dodge * i * Math.PI / 36 : turn;
        if (Math.abs(angle) > Math.PI / 2 + 1e-6) break;
        const forward = Math.cos(angle) * distance, side = Math.sin(angle) * distance;
        const x = p.x + fx * forward + fz * side, z = p.z + fz * forward - fx * side;
        if (s.prop && !ctx.shoulderPropClear(cave, x, z)) continue;
        if (!shoulderClear(cave, x, z) || !(npc ? walkerClear(cave, x, z) : canStep(cave, false, p.x, p.z, x, z))) continue;
        p.x = x; p.z = z; p.y = groundY(cave);
        moved = true; break;
      }
      // A wall can block the sidestep before shoulders meet: keep clear forward travel, stop at the real boundary.
      if (!moved) {
        const x = p.x + fx * distance, z = p.z + fz * distance;
        if ((!s.prop || ctx.shoulderPropClear(cave, x, z)) && shoulderClear(cave, x, z) && (npc ? walkerClear(cave, x, z) : canStep(cave, false, p.x, p.z, x, z))) {
          p.x = x; p.z = z; p.y = groundY(cave);
          moved = true;
        }
      }
      if (npc) cave.root.rotation.y = s.heading;
      return moved ? distance : 0;
    };
    const poseShoulder = (cave, dt) => {
      const s = cave.shoulder;
      if (cave.root.quaternion || cave.camp.seat || cave.hop > 0 || cave.hopV > 0 || cave.camp.panic.active) { clearShoulder(cave); return; }
      if (!s.attempted) { s.phase = 0; s.other = null; s.obstacle.node = null; }
      s.yaw = damp(s.yaw, s.attempted ? s.targetYaw : 0, 16, dt);
      if (Math.abs(s.yaw) < 1e-5) s.yaw = 0;
      for (let i = 0; i < cave.root.children.length; i++) {
        const part = cave.root.children[i];
        part.poseYaw = part === cave.parts.head ? 0 : s.yaw;
      }
    };
    // Walkers use the visitor's swept body; hold one detour side until the direct route clears, never alternate.
    const walkerClear = (cave, x, z) => {
      const p = cave.root.position, feet = p.y - cave.baseY;
      const panic = cave.camp.panic;
      if (panic.active && panic.threat) {
        const threat = panic.threat.root.position;
        if (Math.hypot(x - threat.x, z - threat.z) < Math.min(1.1, Math.hypot(p.x - threat.x, p.z - threat.z)) - 1e-7) return false;
      }
      // Bodies the scene owns are obstacles like any other: the walker's own
      // avoidance steers around them rather than through them.
      if (!outsideClear(p.x, p.z, x, z, feet, cave.bodyHeight)) return false;
      return shoulderClear(cave, x, z) && npcWalkable(p.x, p.z, x, z, feet, cave.bodyHeight, cave)
        && groundAt(x, z, feet, feet, cave) >= feet - STEP - 1e-7;
    };
    const resetWalkerRoute = (cave, retainPath = false) => {
      const tx = retainPath && cave.pathing ? cave.pathing.tx : NaN, tz = retainPath && cave.pathing ? cave.pathing.tz : NaN;
      const a = cave.avoidance;
      a.active = false; a.tx = NaN; a.stalled = 0; a.best = Infinity;
      a.navigation.mode = 0; a.detour.site = -1;
      cave.traffic.waiting = false; cave.traffic.leader = cave.traffic.crossing = null;
      cave.pileApproach = false;
      if (cave.pathing) { cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count = 0; }
      clearShoulder(cave);
      // Recovery changes steering, not the destination. Publish its rebuilt
      // surface route in this frame, including while the short backoff runs.
      if (ctx.npcPaths && Number.isFinite(tx) && Number.isFinite(tz)) ctx.npcPaths.target(cave, tx, tz);
    };
    // Independent of changing path hints and traffic waits: a failed route may
    // otherwise restart its local recovery forever without moving the Ooga.
    const watchWalker = (cave, dt, fromX, fromZ) => {
      const progress = cave.progress, p = cave.root.position, travel = cave.bedTravel, work = cave.work;
      const airborne = cave.hop > 0 || cave.hopV > 0;
      const roof = dt > 0 && cave !== player && cave.root.visible && (cave.state === "working" || cave.state === "chilling")
        && !cave.roofEscape.active && !cave.health.stunned && !cave.camp.burning && !cave.camp.rolling
        && ctx.npcStrandedAt && ctx.npcStrandedAt(cave, p.x, p.y - cave.baseY, p.z);
      if (!roof) progress.roofTime = 0;
      else if ((progress.roofTime += dt) >= 8 && !airborne && ctx.npcRecoverySpot) {
        if (ctx.npcRecoverySpot(cave, NPC_RECOVERY_SPOT)) {
          setVec(p, NPC_RECOVERY_SPOT.x, cave.baseY + NPC_RECOVERY_SPOT.y, NPC_RECOVERY_SPOT.z);
          cave.hop = cave.hopV = cave.jumps = 0; cave.leap.vx = cave.leap.vz = cave.leap.land = 0;
          cave.cloudSupport = null;
          resetWalkerRoute(cave);
          if (cave.state === "chilling") { cave.walk = null; startWander(cave); }
          progress.x = p.x; progress.z = p.z;
          progress.stalled = progress.motionless = progress.retry = progress.backoff = progress.roofTime = 0;
          progress.replanned = progress.navigationHop = progress.escaped = false; progress.resets++;
          return;
        }
        progress.roofTime = 6;
      }
      // Retain the navigation intent through its landing frame, when the
      // ordinary traffic snapshot is still paused and mode 4 has just ended.
      const navigationHop = cave.avoidance.navigation.mode === 4 || progress.navigationHop;
      const attempting = cave.walk || travel.mode === "walk" || cave.state === "working" && workSites
        && (work.phase === "outbound" || work.phase === "return" || work.phase === "station");
      if (dt <= 0 || !attempting || !navigationHop && (!cave.traffic.moving || cave.traffic.distance < 0.15) || cave === player || !cave.root.visible
        || cave.health.stunned || cave.camp.seat || cave.camp.burning || cave.camp.rolling || cave.cheer > 0
        || airborne && !navigationHop || cave.root.quaternion || cave.roofEscape.active) {
        progress.x = p.x; progress.z = p.z; progress.stalled = progress.motionless = progress.retry = progress.backoff = 0;
        progress.replanned = progress.navigationHop = progress.escaped = false; return;
      }
      progress.navigationHop = navigationHop && airborne;
      if (!Number.isFinite(progress.x) || Math.hypot(p.x - progress.x, p.z - progress.z) >= 0.45) {
        progress.x = p.x; progress.z = p.z; progress.stalled = progress.motionless = progress.retry = 0; progress.replanned = progress.escaped = false; return;
      }
      const leader = cave.traffic.leader || cave.traffic.crossing;
      if (cave.traffic.waiting && leader && Math.hypot(leader.shoulder.motionX, leader.shoulder.motionZ) > 0.08) {
        progress.stalled = progress.motionless = 0; progress.replanned = progress.escaped = false; return;
      }
      progress.stalled += dt;
      progress.motionless = Math.hypot(p.x - fromX, p.z - fromZ) > 1e-5 ? 0 : progress.motionless + dt;
      // Failed recovery jumps count as stalled travel, but neither replanning
      // nor relocation may interrupt the collision-checked airborne motion.
      if (airborne) return;
      if (!progress.escaped && progress.motionless >= 0.8) {
        progress.escaped = true;
        const heading = Math.atan2(cave.traffic.tx - p.x, cave.traffic.tz - p.z);
        for (let side = 0; side < 5; side++) {
          const angle = heading + (side === 4 ? Math.PI : (side & 1 ? -1 : 1) * (Math.PI / 2 + (side >> 1) * Math.PI / 4));
          const dx = Math.sin(angle), dz = Math.cos(angle), x = p.x + dx * 0.4, z = p.z + dz * 0.4;
          if (!walkerClear(cave, x, z) || !shoulderClear(cave, x, z)) continue;
          resetWalkerRoute(cave, true);
          progress.backX = dx; progress.backZ = dz; progress.backoff = 0.4; progress.detours++;
          break;
        }
      }
      if (!progress.replanned && progress.stalled >= 1 && progress.motionless >= 0.8 && !progress.backoff) {
        resetWalkerRoute(cave, true); progress.replanned = true; progress.replans++;
        ctx.fx.say(cave, "COMING THROUGH!", 1.8);
        if (travel.mode === "walk" && ctx.bedRoute) startBedRoute(cave, travel.toBed ? cave.bedroll : travel.bed, travel.toBed);
      }
      if (progress.stalled < 8) return;
      progress.retry -= dt;
      if (progress.retry > 0) return;
      progress.retry = 4;
      const feet = p.y - cave.baseY, heading = Math.atan2(cave.traffic.tx - p.x, cave.traffic.tz - p.z);
      for (let ring = 0; ring < 3; ring++) for (let side = 0; side < 8; side++) {
        const angle = heading + side * Math.PI / 4, radius = 0.9 + ring * 0.75;
        const x = p.x + Math.sin(angle) * radius, z = p.z + Math.cos(angle) * radius;
        const y = groundAt(x, z, feet, feet, cave);
        if (!Number.isFinite(y) || Math.abs(y - feet) > STEP || ctx.abyssAt && ctx.abyssAt(x, z, y, cave)
          || ctx.npcLandingAllowed && !ctx.npcLandingAllowed(x, y, z, cave.bodyHeight, cave)
          || !npcWalkable(x, z, x, z, y, cave.bodyHeight, cave) || !outsideClear(x, z, x, z, y, cave.bodyHeight)) continue;
        let occupied = false;
        for (let i = 0; i < crewList.length; i++) {
          const other = crewList[i], q = other.root.position, floor = q.y - other.baseY;
          if (other !== cave && other.root.visible && y < floor + other.bodyHeight && y + cave.bodyHeight > floor
            && Math.hypot(x - q.x, z - q.z) < Math.max(SHOULDER_GAP, cave.bodyRadius + other.bodyRadius)) { occupied = true; break; }
        }
        if (occupied) continue;
        // Last resort only: preserve activity and possessions, and place the
        // feet on nearby verified support, never another floor or body.
        setVec(p, x, cave.baseY + y, z); cave.cloudSupport = null;
        cave.hop = cave.hopV = cave.jumps = 0; cave.leap.vx = cave.leap.vz = cave.leap.land = 0;
        resetWalkerRoute(cave);
        if (travel.mode === "walk" && ctx.bedRoute) startBedRoute(cave, travel.toBed ? cave.bedroll : travel.bed, travel.toBed);
        progress.x = x; progress.z = z; progress.stalled = progress.motionless = progress.retry = progress.backoff = 0;
        progress.replanned = progress.escaped = false; progress.resets++;
        ctx.fx.say(cave, "BACK AT IT!", 1.8);
        return;
      }
    };
    const recoverWalker = (cave, tx, tz, dt, usePath = false) => {
      const a = cave.avoidance, nav = a.navigation, p = cave.root.position, path = cave.pathing;
      // Keep the route identity stable and recover toward its current segment.
      // The path index advances within a route; replans and explicit route
      // resets invalidate the cached target before restarting stall tracking.
      const stable = usePath && path && Number.isFinite(path.tx) && Number.isFinite(path.tz) && path.count > 1 && path.index < path.count - 1;
      const gx = stable ? path.tx : tx, gz = stable ? path.tz : tz;
      const leg = stable ? Math.min(path.index, path.count - 2) : -1, version = stable ? path.version : -1;
      const changed = gx !== a.goalX || gz !== a.goalZ || version !== a.pathVersion || !Number.isFinite(a.tx);
      if (changed || leg > a.pathIndex) {
        a.goalX = gx; a.goalZ = gz; a.pathIndex = leg; a.pathVersion = version;
        let end = leg + 1;
        if (stable) {
          // Graph samples along one straight lane are not recovery goals:
          // a sub-metre sample can finish the search before the obstruction.
          // Stop at the next bend, keeping recovery on this side of its wall.
          const dx = path.laneX[end] - path.laneX[leg], dz = path.laneZ[end] - path.laneZ[leg];
          while (end + 1 < path.count) {
            const nx = path.laneX[end + 1] - path.laneX[end], nz = path.laneZ[end + 1] - path.laneZ[end];
            if (dx * nx + dz * nz <= 0 || Math.abs(dx * nz - dz * nx) > 1e-7) break;
            end++;
          }
        }
        a.tx = stable ? path.laneX[end] : tx; a.tz = stable ? path.laneZ[end] : tz;
        // Rounded bends have short, non-collinear samples. A nearby clear
        // sample can end recovery before the blocked lookahead, so retain
        // the route's lookahead there, rather than its final destination.
        const nearby = Math.hypot(a.tx - p.x, a.tz - p.z);
        if (stable && nearby < 0.75 && Math.hypot(tx - p.x, tz - p.z) > nearby) { a.tx = tx; a.tz = tz; }
        a.best = Infinity; a.stalled = 0; nav.mode = 0;
      }
      const distance = Math.hypot(a.tx - p.x, a.tz - p.z);
      if (cave.traffic.waiting) { a.stalled = 0; a.best = Infinity; nav.mode = 0; return; }
      if (distance < a.best - 0.1) { a.best = distance; a.stalled = 0; }
      else a.stalled += dt;
      if (!nav.mode && a.stalled > 0.75 && distance > 0.15) {
        // A small fixed local search escapes a cul-de-sac; spread over frames, unobstructed walking never searches.
        nav.mode = 1; nav.x = p.x; nav.z = p.z; nav.count = nav.index = 0; nav.searches++;
        nav.costs.fill(Infinity); nav.parents.fill(-1); nav.closed.fill(0);
        nav.costs[NAV_CENTER] = 0; nav.heights[NAV_CENTER] = p.y - cave.baseY;
      }
    };
    const recoveryBodies = new Array(crewList.length), recoveryOutside = [];
    let recoveryBodyCount = 0, recoveryOutsideCount = 0;
    const recoveryHeight = (cave, x, z, y, tx, tz, step) => {
      const dx = tx - x, dz = tz - z, distance = Math.hypot(dx, dz);
      if (distance < 1e-7) return y;
      step = Math.min(step, NAV_STEP);
      const steps = Math.max(1, Math.ceil(distance / step));
      const fromX = x, fromZ = z;
      // Fetch and filter the crowd once per edge. Keep short swept checks
      // only for nearby bodies: escape and height rules depend on each step.
      recoveryBodyCount = recoveryOutsideCount = 0;
      for (let n = 0; n < crewList.length; n++) {
        const other = crewList[n];
        if (other !== cave && other.root.visible && other.state !== "away" && !other.root.quaternion && !other.camp.seat
          && Math.hypot(other.root.position.x - x, other.root.position.z - z) <= distance + SHOULDER_GAP) recoveryBodies[recoveryBodyCount++] = other;
      }
      const outside = ctx.outsideActors && ctx.outsideActors();
      if (outside) for (let n = 0; n < outside.length; n++) {
        const body = outside[n];
        if (Math.hypot(body.x - x, body.z - z) <= distance + OUTSIDE_GAP) recoveryOutside[recoveryOutsideCount++] = body;
      }
      // A coarse edge can cross a deep corner before reaching a higher tread.
      // Follow the same short, supported steps as the walker, not the line
      // between endpoint heights, or recovery will select that edge forever.
      for (let i = 1; i <= steps; i++) {
        const along = Math.min(distance, i * step) / distance;
        const nx = fromX + dx * along, nz = fromZ + dz * along;
        for (let n = 0; n < recoveryOutsideCount; n++) {
          const body = recoveryOutside[n];
          if (y < body.y + ctx.outsideActorHeight && y + cave.bodyHeight > body.y
            && !gapClear(x, z, nx, nz, body, OUTSIDE_GAP)) return NaN;
        }
        for (let n = 0; n < recoveryBodyCount; n++) {
          const other = recoveryBodies[n], floor = other.root.position.y - other.baseY;
          if (y < floor + other.bodyHeight - 0.05 && y + cave.bodyHeight > floor + 0.05 && Math.abs(y - floor) < STEP
            && !gapClear(x, z, nx, nz, other.root.position)) return NaN;
        }
        if (!npcWalkable(x, z, nx, nz, y, cave.bodyHeight, cave)) return NaN;
        const height = groundAt(nx, nz, y, y, cave);
        if (height < y - STEP - 1e-7 || height > y + STEP + 1e-7) return NaN;
        x = nx; z = nz; y = height;
      }
      return y;
    };
    const searchWalker = (cave, tx, tz, step) => {
      const nav = cave.avoidance.navigation;
      for (let budget = 0; budget < 6; budget++) {
        let current = -1, best = Infinity;
        for (let i = 0; i < NAV_SIZE; i++) if (!nav.closed[i] && nav.costs[i] < Infinity) {
          const x = nav.x + (i % NAV_WIDTH - NAV_HALF) * NAV_CELL, z = nav.z + (Math.floor(i / NAV_WIDTH) - NAV_HALF) * NAV_CELL;
          const score = nav.costs[i] + Math.hypot(tx - x, tz - z);
          if (score < best) { current = i; best = score; }
        }
        if (current < 0) { nav.mode = 3; nav.jumpCandidate = 0; return; }
        nav.closed[current] = 1; nav.expansions++;
        const col = current % NAV_WIDTH, row = Math.floor(current / NAV_WIDTH);
        const x = nav.x + (col - NAV_HALF) * NAV_CELL, z = nav.z + (row - NAV_HALF) * NAV_CELL, y = nav.heights[current];
        const remaining = Math.hypot(tx - x, tz - z);
        // A stalled walker needs a step out of its current cell. Accepting
        // the center produces an empty route and clears the stall unchanged.
        const destination = current !== NAV_CENTER && remaining < 0.75 && Number.isFinite(recoveryHeight(cave, x, z, y, tx, tz, step));
        const exit = (col === 0 || row === 0 || col === NAV_WIDTH - 1 || row === NAV_WIDTH - 1)
          && remaining < Math.hypot(tx - nav.x, tz - nav.z) - 0.5;
        if (destination || exit) {
          for (let i = current; i !== NAV_CENTER && i >= 0; i = nav.parents[i]) nav.path[nav.count++] = i;
          nav.index = nav.count - 1; nav.mode = 2;
          return;
        }
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dz) || col + dx < 0 || col + dx >= NAV_WIDTH || row + dz < 0 || row + dz >= NAV_WIDTH) continue;
          const next = current + dz * NAV_WIDTH + dx, cost = nav.costs[current] + Math.hypot(dx, dz) * NAV_CELL;
          if (nav.closed[next] || cost >= nav.costs[next]) continue;
          const nx = x + dx * NAV_CELL, nz = z + dz * NAV_CELL;
          const height = recoveryHeight(cave, x, z, y, nx, nz, step);
          if (!Number.isFinite(height)) continue;
          nav.costs[next] = cost; nav.parents[next] = current; nav.heights[next] = height;
        }
      }
    };
    const jumpWalker = (cave, tx, tz) => {
      const nav = cave.avoidance.navigation, p = cave.root.position, feet = p.y - cave.baseY;
      if (inBananas(cave) || nav.jumpCandidate >= 8) { nav.mode = 0; cave.avoidance.stalled = -1; return; }
      for (let otherIndex = 0; otherIndex < crewList.length; otherIndex++) {
        const other = crewList[otherIndex];
        if (!shoulderNeighbor(cave, other)) continue;
        const q = other.root.position;
        if (Math.min(Math.hypot(p.x - q.x, p.z - q.z), Math.hypot(tx - q.x, tz - q.z)) >= SHOULDER_REACH) continue;
        // A crowd can invalidate a local search while it is being explored.
        // Refresh the ground route when either the walker or its hint is
        // beside someone, instead of jumping out of a passing queue.
        nav.mode = 0; cave.avoidance.stalled = -0.25; return;
      }
      const distance = Math.hypot(tx - p.x, tz - p.z), reach = Math.min(distance, SHOULDER_REACH);
      if (distance > 1e-7 && !shoulderClear(cave, p.x + (tx - p.x) * reach / distance, p.z + (tz - p.z) * reach / distance)) {
        // Another Ooga can close a doorway only temporarily. Retry ordinary
        // walking after yielding instead of jumping onto the visitor's head.
        nav.mode = 0; cave.avoidance.stalled = -0.25;
        return;
      }
      const candidate = nav.jumpCandidate++, turn = candidate ? Math.ceil(candidate / 2) * (candidate & 1 ? 1 : -1) * Math.PI / 4 : 0;
      const angle = Math.atan2(tx - p.x, tz - p.z) + turn, endX = p.x + Math.sin(angle) * 1.1, endZ = p.z + Math.cos(angle) * 1.1;
      // Rotated escape candidates need the same crowd check as the forward
      // route: another Ooga's head is not a recovery platform.
      if (!shoulderClear(cave, endX, endZ)) return;
      const landing = groundAt(endX, endZ, feet + 2.1, feet + 2.1, cave), clearance = Math.max(feet, landing) + 0.08;
      const maxDrop = ctx.npcRecoveryDrop && ctx.npcRecoveryDrop(p.x, feet, p.z, cave) ? 4 : 3;
      if (landing < feet - maxDrop || landing > feet + 2.1 || !flyable(endX, endZ, endX, endZ, landing + 1e-5, cave.bodyHeight, cave)
        || ctx.npcLandingAllowed && !ctx.npcLandingAllowed(endX, landing, endZ, cave.bodyHeight, cave)) return;
      const double = landing > feet + 0.85;
      let x = p.x, z = p.z, y = feet, velocity = JUMP_SPEED, boosted = false, moving = false;
      // Check one candidate per frame against swept bodies and actual support.
      // A lift before lateral travel lets a wedged NPC jump onto its obstacle.
      for (let i = 0; i < 120; i++) {
        velocity -= WALK.gravity * 0.025;
        if (double && !boosted && velocity <= 0) { velocity = JUMP_SPEED; boosted = true; }
        const nextY = y + velocity * 0.025;
        if (nextY >= clearance) moving = true;
        const remaining = Math.hypot(endX - x, endZ - z), step = moving ? Math.min(0.075, remaining) : 0;
        const nx = remaining ? x + (endX - x) * step / remaining : x, nz = remaining ? z + (endZ - z) * step / remaining : z;
        if (ctx.npcHazardClear && !ctx.npcHazardClear(x, y, z, nx, nextY, nz, cave.bodyHeight, cave)) return;
        if (moving && velocity < 0 && nextY <= landing && Math.hypot(endX - nx, endZ - nz) < 0.6) {
          if (!flyable(nx, nz, nx, nz, landing + 1e-5, cave.bodyHeight, cave)) return;
          nav.mode = 4; nav.jumpX = endX; nav.jumpZ = endZ; nav.clearance = clearance; nav.double = double;
          nav.boosted = nav.moving = false; nav.jumps++; cave.hopV = JUMP_SPEED;
          cave.leap.vx = cave.leap.vz = 0;
          return;
        }
        if (nextY < feet - maxDrop || !flyable(x, z, nx, nz, Math.min(y, nextY) + 1e-5, cave.bodyHeight, cave)
          || !flyable(nx, nz, nx, nz, nextY + 1e-5, cave.bodyHeight, cave)) return;
        x = nx; z = nz; y = nextY;
      }
    };
    const walkToward = (cave, tx, tz, distance) => {
      const progress = cave.progress;
      if (progress.backoff > 0) {
        const p = cave.root.position, step = Math.min(distance, progress.backoff, PLAYER_STEP);
        const x = p.x + progress.backX * step, z = p.z + progress.backZ * step;
        if (!walkerClear(cave, x, z) || !shoulderClear(cave, x, z)) { progress.backoff = 0; return 0; }
        p.x = x; p.z = z; p.y = groundY(cave);
        progress.backoff = Math.max(0, progress.backoff - step);
        return step;
      }
      if (cave.traffic.waiting) return 0;
      const nav = cave.avoidance.navigation;
      if (nav.mode === 1) { searchWalker(cave, cave.avoidance.tx, cave.avoidance.tz, NAV_STEP); return 0; }
      if (nav.mode === 3) { jumpWalker(cave, cave.avoidance.tx, cave.avoidance.tz); return 0; }
      if (nav.mode === 4) return 0;
      if (nav.mode === 2) {
        while (nav.index >= 0) {
          const i = nav.path[nav.index], x = nav.x + (i % NAV_WIDTH - NAV_HALF) * NAV_CELL, z = nav.z + (Math.floor(i / NAV_WIDTH) - NAV_HALF) * NAV_CELL;
          if (Math.hypot(x - cave.root.position.x, z - cave.root.position.z) < 1e-6) { nav.index--; continue; }
          tx = x; tz = z; break;
        }
        if (nav.index < 0) { nav.mode = 0; cave.avoidance.stalled = 0; cave.avoidance.best = Infinity; cave.avoidance.active = false; }
      }
      const p = cave.root.position, dx = tx - p.x, dz = tz - p.z, remaining = Math.hypot(dx, dz);
      if (remaining < 1e-7) return 0;
      const step = Math.min(distance, nav.mode === 2 ? NAV_STEP : PLAYER_STEP, remaining), heading = Math.atan2(dx, dz), avoidance = cave.avoidance;
      // A clear stop before a wall must not trigger a pass around the wall beyond it; probe only the route left.
      // Recovery waypoints already clear solid bodies; a shoulder detour here can circle a blocked waypoint forever.
      const passing = nav.mode === 2 ? -1 : shoulderStep(cave, dx / remaining, dz / remaining, step, true, Math.min(NPC_PASS_REACH, remaining));
      if (passing >= 0) {
        avoidance.active = false;
        // A wall can close the chosen shoulder side. Let the ordinary
        // two-sided detour below try the open side before starting recovery.
        if (passing || cave.shoulder.prop) return passing;
      }
      let angle = heading;
      const ahead = nav.mode === 2 ? step : avoidance.active ? Math.min(0.9, remaining) : step;
      if (walkerClear(cave, p.x + Math.sin(heading) * step, p.z + Math.cos(heading) * step)
        && (ahead === step || walkerClear(cave, p.x + Math.sin(heading) * ahead, p.z + Math.cos(heading) * ahead))) avoidance.active = false;
      else {
        if (nav.mode === 2) { nav.mode = 0; avoidance.stalled = 0.8; return 0; }
        let clear = false;
        // Fixed capacity, no path allocation: each candidate is tested for the step and a body-width look-ahead.
        for (let side = 0; side < 2 && !clear; side++) {
          const sign = side ? -avoidance.side : avoidance.side;
          for (let turn = 1; turn <= 4; turn++) {
            angle = heading + sign * turn * Math.PI / 6;
            const look = Math.max(step, 0.35), sx = Math.sin(angle), sz = Math.cos(angle);
            if (!walkerClear(cave, p.x + sx * look, p.z + sz * look) || !walkerClear(cave, p.x + sx * step, p.z + sz * step)) continue;
            avoidance.side = sign;
            avoidance.active = clear = true;
            break;
          }
        }
        if (!clear) { if (avoidance.stalled >= 0) avoidance.stalled = Math.max(0.8, avoidance.stalled); return 0; }
      }
      p.x += Math.sin(angle) * step; p.z += Math.cos(angle) * step;
      p.y = groundY(cave);
      cave.root.rotation.y += Math.atan2(Math.sin(angle - cave.root.rotation.y), Math.cos(angle - cave.root.rotation.y)) * 0.35;
      return step;
    };
    const runBed = (cave, dt) => {
      const travel = cave.bedTravel, p = cave.root.position;
      if (travel.mode === "rest" && cave.bedroll?.outdoor && cave !== player && (travel.retry -= dt) <= 0) {
        travel.retry = 1;
        const previous = cave.bedroll;
        if (claimBedroll(cave) && cave.bedroll !== previous) { startSleep(cave, true); return; }
      }
      if (travel.mode === "landing") {
        runPlayer(cave, dt, false);
        if (ctx.abyssAt && ctx.abyssAt(p.x, p.z, p.y - cave.baseY, cave) && p.y - cave.baseY < ctx.abyssRespawnY) {
          if (ctx.respawnSpot && !ctx.respawnSpot(cave, NPC_RECOVERY_SPOT)) return;
          if (ctx.onAbyssRespawn) ctx.onAbyssRespawn(cave);
          if (ctx.respawnSpot) setVec(p, NPC_RECOVERY_SPOT.x, cave.baseY + NPC_RECOVERY_SPOT.y, NPC_RECOVERY_SPOT.z);
          else setVec(p, walkIn.x, cave.baseY + groundAt(walkIn.x, walkIn.z, Infinity, Infinity, cave), walkIn.z);
          cave.hop = cave.hopV = cave.jumps = 0;
          cave.leap.vx = cave.leap.vz = 0; cave.leap.thrown = cave.leap.rageThrown = false;
          cave.cloudSupport = null;
        }
        if (grounded(cave)) startBedRoute(cave, travel.toBed ? cave.bedroll : travel.bed, travel.toBed);
        return;
      }
      if (travel.mode === "waiting") {
        if (travel.toBed && !cave.bedroll) {
          travel.retry -= dt;
          if (travel.retry <= 0) {
            if (!cave.root.visible) startSleep(cave, true);
            else if (claimBedroll(cave)) startSleep(cave, !!cave.bedroll.outdoor);
            else travel.retry = 1;
          }
          return;
        }
        if (!grounded(cave)) { startBedRoute(cave, travel.toBed ? cave.bedroll : travel.bed, travel.toBed); return; }
        if (travel.plan) return;
        travel.retry -= dt;
        if (travel.retry <= 0) {
          if (!travel.toBed || claimBedroll(cave)) startBedRoute(cave, travel.toBed ? cave.bedroll : travel.bed, travel.toBed);
          else travel.retry = 1;
        }
        return;
      }
      if (travel.mode === "walk") {
        if (cave.hop > 0 || cave.hopV > 0) { runPlayer(cave, dt, false); return; }
        // The architectural route ends at the meadow. Only workers continue to a live eating slot.
        if (!travel.toBed && cave.state !== "chilling" && travel.index >= travel.route.length - 1) {
          travel.mode = ""; travel.route = null; travel.bed = null;
          if (cave.state === "working") { startMeal(cave); walkToSlot(cave, true); }
          else if (wanderSpot) startWander(cave);
          else startMeal(cave);
          return;
        }
        let remaining = dt * 2 * (inBananas(cave) ? 0.5 : 1), recoveryChecked = false;
        while (remaining > 1e-8 && travel.index < travel.route.length) {
          const target = travel.route[travel.index], dx = target.x - p.x, dz = target.z - p.z, distance = Math.hypot(dx, dz);
          if (distance < 1e-6) { travel.index++; continue; }
          if (travel.index + 1 < travel.route.length && ctx.npcRouteBlocked && ctx.npcRouteBlocked(cave, target.x, target.y, target.z)) { travel.index++; continue; }
          // Scenery may cover an intermediate waypoint: aim around the prop toward the next one, never insist on it.
          // Keep the doorway turn until the shortcut is clear; temporary bodies still use local walking avoidance.
          if (distance < 3 && travel.index + 1 < travel.route.length && !npcWalkable(target.x, target.z, target.x, target.z, target.y, cave.bodyHeight, cave)) {
            const next = travel.route[travel.index + 1];
            if (ctx.bedRouteClear(cave, next)) { travel.index++; continue; }
          }
          const detour = ctx.npcDetour && ctx.npcDetour(cave, target.x, target.z, target.y), aim = detour ? cave.avoidance.detour : target;
          if (!recoveryChecked) { recoverWalker(cave, aim.x, aim.z, dt); recoveryChecked = true; }
          const step = walkToward(cave, aim.x, aim.z, remaining);
          if (!step) { travel.blocked += dt; break; }
          // travel.blocked is the current obstruction duration, like avoidance.stalled; clear it when progress resumes.
          travel.blocked = 0;
          travel.phase += step * 4.5;
          remaining -= step;
          if (Math.hypot(target.x - p.x, target.z - p.z) < 1e-6) travel.index++;
        }
        if (travel.index === travel.route.length) {
          standPose(cave);
          if (travel.toBed) lieDown(cave);
          else {
            travel.mode = ""; travel.route = null; travel.bed = null;
            if (cave.state === "chilling" && wanderSpot) startWander(cave);
            else { cave.root.rotation.y = Math.atan2(-p.x, -p.z); startMeal(cave); }
          }
        } else {
          walkPose(cave, travel.phase);
          // Contact stays on the physical floor; gait motion lives in the limbs.
          p.y = groundY(cave);
        }
        return;
      }
      const bed = cave.bedroll;
      if (travel.mode === "lie") {
        travel.phase = Math.min(1, travel.phase + dt / 0.85);
        const k = ease.inOutQuad(travel.phase), angle = bed.node.rotation.y;
        setVec(p, lerp(travel.fromX, bed.x + Math.sin(angle) * travel.restZ, k), lerp(travel.fromY, bed.y + travel.restY, k), lerp(travel.fromZ, bed.z + Math.cos(angle) * travel.restZ, k));
        math.quat.copy(cave.sleepRotation, cave.sleepFromRotation);
        math.quat.slerpTo(cave.sleepRotation, cave.sleepTargetRotation, k);
        sleepParts(cave, k);
        if (travel.phase === 1) {
          travel.mode = "rest";
          cave.parts.head.geometry = cave.headClosed;
        }
      } else if (travel.mode === "rest") {
        if (travel.manual && cave === player && bed.sleep) {
          if (Math.abs(steer.forward) > 0.05 && Math.abs(steer.forward) >= Math.abs(steer.strafe)) turnSleep(cave, steer.forward > 0 ? "stomach" : "back");
          else if (Math.abs(steer.strafe) > 0.05) turnSleep(cave, steer.strafe < 0 ? "right" : "left");
        }
        if (travel.roll < 1) {
          travel.roll = Math.min(1, travel.roll + dt / 0.55);
          const k = ease.inOutQuad(travel.roll);
          math.quat.copy(cave.sleepRotation, cave.sleepFromRotation);
          math.quat.slerpTo(cave.sleepRotation, cave.sleepTargetRotation, k);
          setVec(p, lerp(travel.fromX, bed.x + Math.sin(bed.node.rotation.y) * travel.restZ, k), lerp(travel.fromY, bed.y + travel.restY, k) + Math.sin(k * Math.PI) * 0.09, lerp(travel.fromZ, bed.z + Math.cos(bed.node.rotation.y) * travel.restZ, k));
          cave.parts.head.position.x = lerp(travel.fromHeadX, cave.sleepParts.headX + travel.headDropX, k);
          cave.parts.head.position.y = lerp(travel.fromHeadY, cave.sleepParts.headY + travel.headDropY, k);
          cave.parts.head.position.z = lerp(travel.fromHeadZ, cave.sleepParts.headZ + travel.headDropZ, k);
          cave.parts.armR.position.x = lerp(travel.fromArmRX, travel.armRX, k);
          cave.parts.armL.position.x = lerp(travel.fromArmLX, travel.armLX, k);
          cave.parts.armR.rotation.z = lerp(travel.fromArmRZ, travel.armRZ, k);
          cave.parts.armL.rotation.z = lerp(travel.fromArmLZ, travel.armLZ, k);
          // A side-to-back roll is taller than either end pose: lift from the real meshes while turning, then settle.
          BL.scene.updateWorld(cave.root);
          SLEEP_BOUNDS.min = SLEEP_BOUNDS.headMin = Infinity;
          measureSleeper(cave.root, false, cave.parts.head);
          const compression = lerp(travel.fromCompression, travel.compression, k);
          const lift = Math.max(0, bed.y + bed.sleep.surface - compression - Math.min(SLEEP_BOUNDS.min, SLEEP_BOUNDS.headMin), bed.sleep.pillowTop - SLEEP_COMPRESSION * 0.6 - pillowMinimum(cave, bed, false));
          p.y += lift;
        }
      }
      cave.parts.torso.scale.y = 1 + Math.sin(elapsed * 1.4 + cave.phase) * 0.015;
      updateSleepHead(cave);
      if (travel.mode === "rest") {
        cave.zzzTimer -= dt;
        if (cave.zzzTimer <= 0) { cave.zzzTimer = 1.6; ctx.fx.zzzAt(cave.sleepHead.x, cave.sleepHead.y + 0.35, cave.sleepHead.z, cave); }
      }
    };
    // Keep backward and lateral steps readable in a mirror without turning the body.
    const closeWalkPose = (cave) => {
      const parts = cave.parts;
      const side = steer.strafe, backward = steer.forward < -0.05;
      parts.torso.rotation.x = backward ? 0.07 : 0;
      parts.torso.rotation.z = -side * 0.08;
      parts.legR.rotation.z = parts.legL.rotation.z = side * 0.1;
    };
    const setPeekPart = (node, lean, pivot) => {
      if (!node) return;
      node.poseLean = lean;
      node.poseLeanY = pivot;
    };
    // The root is already at the hips. Lean the body from there: a pivot
    // above the torso pushes the hips out while barely moving the head.
    // Held children inherit the lean; root-level gear follows it explicitly.
    const posePeek = (cave, dt) => {
      cave.peek = damp(cave.peek, steer.peek, 14, dt);
      if (Math.abs(cave.peek) < 1e-4 && !steer.peek) cave.peek = 0;
      const parts = cave.parts, lean = cave.peek * 0.5, pivot = 0;
      setPeekPart(parts.torso, lean, pivot);
      setPeekPart(parts.armR, lean, pivot);
      setPeekPart(parts.armL, lean, pivot);
      setPeekPart(parts.head, lean, pivot);
      setPeekPart(parts.gun, parts.gun.parent === cave.root ? lean : 0, pivot);
      setPeekPart(parts.club, parts.club.parent === cave.root ? lean : 0, pivot);
      if (cave.jet) setPeekPart(cave.jet.node, cave.jet.node.parent === cave.root ? lean : 0, pivot);
      for (let i = 0; i < cave.magazineModels.length; i++) {
        const model = cave.magazineModels[i];
        if (model) setPeekPart(model.node, model.node.parent === cave.root ? lean : 0, pivot);
      }
    };
    const aimPeek = (cave) => {
      const w = cave.weapon, arm = cave.parts.armR, gun = cave.parts.gun, lean = arm.poseLean;
      if (lean && w.equipped && w.aiming && !w.reloading && !w.reloadHandoff && !w.swapTime) {
        // The shoulder follows the body, but the held rifle keeps pointing
        // along the aim line even when aiming uphill or downhill while leaning.
        // Express the inverse body roll in the arm's pre-twist frame.
        math.quat.fromEuler(GUN_ARM, 0, -arm.poseYaw, 0);
        math.quat.fromEuler(GUN_GRIP, 0, 0, -lean);
        math.quat.multiply(GUN_ARM, GUN_ARM, GUN_GRIP);
        math.quat.fromEuler(GUN_GRIP, 0, arm.poseYaw, 0);
        math.quat.multiply(GUN_ARM, GUN_ARM, GUN_GRIP);
        math.quat.multiply(arm.quaternion, GUN_ARM, arm.quaternion);
        math.quat.multiply(gun.quaternion, GUN_ARM, gun.quaternion);
        math.quat.rotateVec(MUZZLE, GUN_ARM, gun.position.x - arm.position.x, gun.position.y - arm.position.y, gun.position.z - arm.position.z);
        setVec(gun.position, arm.position.x + MUZZLE[0], arm.position.y + MUZZLE[1], arm.position.z + MUZZLE[2]);
      }
    };
    // Flying pose, legs trailing and arms out
    const flyPose = (cave) => {
      const parts = cave.parts;
      parts.legR.rotation.x = -0.5;
      parts.legL.rotation.x = -0.3;
      parts.armR.rotation.x = parts.armL.rotation.x = -1.1;
    };
    const runWalk = (cave, dt) => {
      // A growing pile or new fire can cover a chosen destination; pick a safe spot instead of circling it.
      if (cave.walk.to === "spot" && npcDestinationBlocked(cave, cave.walk.tx, cave.walk.tz)) startWander(cave);
      const w = cave.walk, p = cave.root.position;
      if (w.to === "slot" && !slotAvailable(cave, cave.slot)) {
        const slot = closestSlot(cave);
        if (!slot) { standPose(cave); return; }
        cave.slot = slot; w.tx = slot.x; w.tz = slot.z;
        cave.avoidance.active = cave.pileApproach = false;
      }
      // Painted trails guide work trips. Resting Oogas roam freely, retaining
      // the same swept scenery checks and bounded local obstacle avoidance.
      if (cave.state !== "working" && cave.pathing) {
        cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count;
        cave.pathing.targetX = w.tx; cave.pathing.targetZ = w.tz;
      }
      const detour = ctx.npcDetour && ctx.npcDetour(cave, w.tx, w.tz), diversion = cave.avoidance.detour;
      const direct = w.to === "slot" && approachPile(cave), paths = cave.state === "working" && !direct && !detour && ctx.npcPaths;
      if (direct) {
        w.tx = cave.slot.x; w.tz = cave.slot.z;
        if (cave.pathing) { cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count; cave.pathing.targetX = w.tx; cave.pathing.targetZ = w.tz; }
      }
      if (paths && (!cave.avoidance.navigation.mode || cave.pathing.tx !== w.tx || cave.pathing.tz !== w.tz)) paths.target(cave, w.tx, w.tz);
      recoverWalker(cave, detour ? diversion.x : paths ? cave.pathing.targetX : w.tx, detour ? diversion.z : paths ? cave.pathing.targetZ : w.tz, dt, !!paths);
      let remaining = w.speed * dt * (inBananas(cave) ? 0.5 : 1), moved = 0;
      while (remaining > 1e-8 && Math.hypot(w.tx - p.x, w.tz - p.z) > 1e-6) {
        if (paths && (!cave.avoidance.navigation.mode || cave.pathing.tx !== w.tx || cave.pathing.tz !== w.tz)) paths.target(cave, w.tx, w.tz);
        if (detour) ctx.npcDetour(cave, w.tx, w.tz);
        const step = walkToward(cave, detour ? diversion.x : paths ? cave.pathing.targetX : w.tx, detour ? diversion.z : paths ? cave.pathing.targetZ : w.tz, remaining);
        if (!step) break;
        moved += step; remaining -= step;
      }
      if (Math.hypot(w.tx - p.x, w.tz - p.z) < 1e-6) {
        cave.shoulder.phase = 0; cave.shoulder.other = null;
        if (w.to === "spot") {
          arriveAtSpot(cave);
        } else {
          cave.root.rotation.y = Math.atan2(-p.x, -p.z);
          if (cave !== player) startMeal(cave);
        }
        standPose(cave);
        cave.walk = null;
        return;
      }
      w.heading = cave.root.rotation.y;
      w.phase += moved * 5;
      if (moved) walkPose(cave, w.phase); else standPose(cave);
      // The gait belongs to the limbs; the physical feet stay on the support.
      p.y = groundY(cave);
    };
    const planWorkSite = (cave, resume = false, announceTrip = false) => {
      const previous = cave.weapon.workSite === undefined ? -1 : cave.weapon.workSite;
      const first = resume && previous >= 0 ? 0 : 1;
      let selected = -1;
      for (let offset = first; offset < first + workSites.length; offset++) {
        const index = (previous + offset) % workSites.length, site = workSites[index];
        if (!siteActive(cave, site)) continue;
        selected = index;
        break;
      }
      if (cave.work.plannedSite !== selected || announceTrip) {
        cave.work.plannedSite = selected;
        if (ctx.workPlanned) ctx.workPlanned(cave, selected);
      }
      return selected;
    };
    const selectWorkSite = (cave, resume = false) => {
      let index = cave.work.plannedSite;
      if (resume || index < 0 || !siteActive(cave, workSites[index])) index = planWorkSite(cave, resume);
      if (index < 0) return false;
      const work = cave.work, site = workSites[index];
      work.site = cave.weapon.workSite = index;
      work.index = 0;
      if (site.position) { if (site.position(cave, work.position) === false) return false; }
      else setVec(work.position, site.route[site.route.length - 1].x, 0, site.route[site.route.length - 1].z);
      work.phase = "outbound";
      work.targetReady = work.aimReady = false;
      work.blocked = false; work.blockedTime = 0;
      work.rest = cave.traits.maintainer ? WORK_REST_MIN + Math.random() * WORK_REST_SPREAD : 0;
      work.reloadSlot = work.direct = cave.pileApproach = false;
      cave.act.kind = "work";
      cave.weapon.equipped = true;
      cave.avoidance.tx = NaN;
      // Publish an outbound trip with its surface route already planned.
      // Reload can start this phase after the frame's walking update.
      if (ctx.npcPaths && cave.pathing) ctx.npcPaths.target(cave, site.route[0].x, site.route[0].z);
      return true;
    };
    const walkWorkTo = (cave, target, dt, followPath = true) => {
      const p = cave.root.position, work = cave.work, paths = followPath && !work.direct && ctx.npcPaths;
      if (!paths && cave.pathing) {
        cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count;
        cave.pathing.targetX = target.x; cave.pathing.targetZ = target.z;
      }
      if (Math.hypot(target.x - p.x, target.z - p.z) < 0.12) { standPose(cave); return true; }
      if (paths && (!cave.avoidance.navigation.mode || cave.pathing.tx !== target.x || cave.pathing.tz !== target.z)) paths.target(cave, target.x, target.z);
      recoverWalker(cave, paths ? cave.pathing.targetX : target.x, paths ? cave.pathing.targetZ : target.z, dt, !!paths);
      let remaining = RUSH_SPEED * dt * (inBananas(cave) ? 0.5 : 1), moved = 0;
      while (remaining > 1e-8 && Math.hypot(target.x - p.x, target.z - p.z) >= 0.12) {
        if (paths && (!cave.avoidance.navigation.mode || cave.pathing.tx !== target.x || cave.pathing.tz !== target.z)) paths.target(cave, target.x, target.z);
        const step = walkToward(cave, paths ? cave.pathing.targetX : target.x, paths ? cave.pathing.targetZ : target.z, remaining);
        if (!step) break;
        moved += step; remaining -= step;
      }
      work.gait += moved * 5;
      if (moved) walkPose(cave, work.gait); else standPose(cave);
      p.y = groundY(cave);
      return Math.hypot(target.x - p.x, target.z - p.z) < 0.12;
    };
    const aimWork = (cave, site) => {
      const work = cave.work, p = cave.root.position;
      work.targetReady = work.aimReady = false;
      if (workBodyTarget) {
        work.aimSample = cave.weapon.shotsFired + cave.index;
        work.targetReady = !!workBodyTarget(cave, work.target, work.aimSample);
        if (!work.targetReady) {
          // Carry the rifle while watching the approaching companion. This
          // look target never enables firing outside the assigned cave.
          if (!workCompanionTarget || !workCompanionTarget(cave, work.target)) {
            if (!site.target) return false;
            site.target(cave, work.target);
          }
        }
      } else if (site.target) site.target(cave, work.target);
      else setVec(work.target, work.position.x + Math.sin(elapsed + cave.phase) * 2, p.y + 0.8, work.position.z - 3);
      cave.root.rotation.y = Math.atan2(work.target.x - p.x, work.target.z - p.z);
      cave.weapon.aimPitch = -Math.atan2(work.target.y - p.y - cave.traits.height * 0.45, Math.hypot(work.target.x - p.x, work.target.z - p.z));
      if (workBodyTarget) {
        cave.parts.head.rotation.x = -Math.atan2(work.target.y - p.y - cave.parts.head.position.y, Math.hypot(work.target.x - p.x, work.target.z - p.z));
        cave.parts.head.rotation.y = 0;
      }
      work.aimReady = !workBodyTarget || work.targetReady;
      return !workBodyTarget || work.targetReady;
    };
    const runWork = (cave, dt) => {
      const work = cave.work, weapon = cave.weapon;
      if (!work.phase) {
        if (weapon.ammo >= AMMO_MAX) {
          if (!selectWorkSite(cave)) { standPose(cave); return; }
        } else {
          work.site = Math.min(workSites.length - 1, weapon.workSite || 0);
          work.phase = nearReload(cave) ? "reload" : "return";
          work.index = workSites[work.site].route.length - 1;
          planWorkSite(cave);
        }
      }
      const site = workSites[work.site], route = site.route;
      if ((work.phase === "outbound" || work.phase === "station" || work.phase === "shoot") && !siteActive(cave, site)) {
        work.index = work.phase === "outbound" ? Math.min(work.index, route.length - 1) : route.length - 1;
        work.phase = "return"; cave.act.kind = "reload-return"; cave.avoidance.tx = NaN;
        planWorkSite(cave);
      }
      if ((work.phase === "return" || work.phase === "reload") && (work.plannedSite < 0 || !siteActive(cave, workSites[work.plannedSite]))) planWorkSite(cave);
      if (work.phase === "outbound") {
        const approach = route[route.length - 1], p = cave.root.position;
        if (work.index === route.length - 1 && site.approachDistance && Math.hypot(approach.x - p.x, approach.z - p.z) <= site.approachDistance) {
          work.phase = "station"; cave.avoidance.tx = NaN;
        } else if (work.index < route.length) {
          if (walkWorkTo(cave, route[work.index], dt)) { work.index++; cave.avoidance.tx = NaN; }
          return;
        } else {
          work.phase = "station";
        }
      }
      if (work.phase === "station") {
        // A nonworker can occupy a reserved shooting place after it was
        // selected. Walking around that body cannot reach its exact center.
        const occupied = spotOccupied(cave, work.position.x, work.position.y, work.position.z);
        const near = Math.hypot(cave.root.position.x - work.position.x, cave.root.position.z - work.position.z) < 1.5;
        work.blockedTime = occupied && near ? work.blockedTime + dt : 0;
        // An occupied place re-invokes the site's position hook every 0.8 s by
        // design. It is also the place-cycling hook, so it must be total and bounded.
        if (work.blockedTime >= 0.8 && site.position) {
          work.blockedTime = 0;
          const x = work.position.x, y = work.position.y, z = work.position.z, place = work.place;
          if (site.position(cave, work.position, true) !== false && Number.isFinite(work.position.x)
            && Number.isFinite(work.position.y) && Number.isFinite(work.position.z)) {
            if (work.position.x !== x || work.position.y !== y || work.position.z !== z) {
              resetWalkerRoute(cave); cave.progress.backoff = 0;
            }
          } else {
            setVec(work.position, x, y, z); work.place = place;
          }
        }
        if (walkWorkTo(cave, work.position, dt, !site.approachDistance)) {
          work.phase = "shoot"; work.direct = false; work.timer = 0.2 + cave.index * 0.07; work.emptyTime = work.blockedTime = 0;
          aimWork(cave, site);
        }
      } else if (work.phase === "shoot") {
        if (site.approachDistance && Math.hypot(cave.root.position.x - work.position.x, cave.root.position.z - work.position.z) > 0.45) {
          stopBurst(cave); work.phase = "station"; cave.avoidance.tx = NaN;
          return;
        }
        work.blockedTime = work.blocked ? work.blockedTime + dt : 0;
        if (work.blockedTime >= 0.6 && site.position) {
          work.blockedTime = 0;
          if (site.position(cave, work.position, true) !== false) {
            stopBurst(cave); work.blocked = false; work.phase = "station"; cave.avoidance.tx = NaN;
            return;
          }
        }
        standPose(cave);
        cave.act.kind = "work";
        const targetReady = aimWork(cave, site);
        if (targetReady) work.timer -= dt;
        else work.timer = Math.max(0.2, work.timer);
        if (targetReady && work.timer <= 0 && weapon.ammo > 0 && !weapon.burstRemaining && weapon.cooldown <= 0) {
          if (fireWeapon(cave, work.target)) work.timer = 0.22 + (cave.index % 3) * 0.045;
          else if (work.blocked) work.timer = 0.15;
        }
        if (!weapon.ammo && !weapon.swapTime) {
          // Send the companion ahead as soon as this cave's last shot is
          // fired. The owner's empty-rifle pause and reload trip are separate.
          if (!work.emptyTime && !(hasMagazine(cave) && magazineAmmo(cave, fullestMagazine(cave)) > 0))
            planWorkSite(cave, false, true);
          // Let the last banana land while the visibly empty rifle remains
          // aimed into the cave, then lower it for the return to the pile.
          work.emptyTime += dt;
          if (work.emptyTime >= 0.45) {
            if (hasMagazine(cave) && magazineAmmo(cave, fullestMagazine(cave)) > 0 && swapMagazine(cave)) {
              work.emptyTime = 0;
            } else {
              work.phase = "return"; work.index = route.length - 1;
              cave.act.kind = "reload-return"; cave.avoidance.tx = NaN;
              // The next cave was announced on the final shot. A companion
              // whose next shift is here stays inside through the reload.
            }
          }
        }
      } else if (work.phase === "return") {
        if (work.index >= 0) {
          const point = route[work.index], direct = site.approachDistance && work.index === route.length - 1;
          if (direct && Math.hypot(point.x - cave.root.position.x, point.z - cave.root.position.z) < 0.8) {
            work.index--; cave.avoidance.tx = NaN;
          } else {
            if (walkWorkTo(cave, point, dt, !direct)) { work.index--; cave.avoidance.tx = NaN; }
            return;
          }
        }
        if (work.index < 0) {
          if (!work.reloadSlot || !cave.slot || !slotAvailable(cave, cave.slot)) {
            const slot = closestSlot(cave);
            if (!slot) { standPose(cave); return; }
            cave.slot = slot; work.reloadSlot = true; cave.pileApproach = false;
          }
          const direct = approachPile(cave);
          if (walkWorkTo(cave, cave.slot, dt, !direct)) { work.phase = "reload"; work.direct = false; cave.act.kind = "reload"; }
        }
      } else if (work.phase === "reload") {
        standPose(cave);
        cave.root.rotation.y = Math.atan2(-cave.root.position.x, -cave.root.position.z);
        if (!nearReload(cave)) { work.phase = "return"; work.index = -1; return; }
        if (!reloadMissing(cave)) {
          if (weapon.reloadHandoff) return;
          // Loaded and in no hurry: stand at the pile before the next trip.
          if (work.rest > 0) { work.rest -= dt; return; }
          selectWorkSite(cave);
          return;
        }
        if (!weapon.reloading) startReload(cave);
        runReload(cave, dt);
      }
    };
    const quoteFor = () => {
      const table = ctx.phase ? PHASE_QUOTES[ctx.phase()] : IDLE_QUOTES;
      return table[Math.floor(Math.random() * table.length)];
    };
    const idleSay = (cave) => {
      const voice = contributors.voiceFor(cave.traits.name);
      if (voice && Math.random() < VOICE_MIX) ctx.fx.say(cave, voice.idle[Math.floor(Math.random() * voice.idle.length)], VOICE_SECONDS);
      else ctx.fx.say(cave, quoteFor(), 2);
    };
    const runYawn = (cave) => {
      // Re-armed in every phase so the stagger holds when midnight arrives mid-visit.
      if (ctx.phase && elapsed > cave.yawnAt) {
        cave.yawnAt = elapsed + 25 + Math.random() * 30;
        if (ctx.phase() === "midnight") cave.yawn = YAWN_DUR;
      }
      if (cave.yawn <= 0) return false;
      const parts = cave.parts;
      const k = Math.sin((1 - cave.yawn / YAWN_DUR) * Math.PI);
      parts.armR.rotation.x = parts.armL.rotation.x = -0.2 - 2.2 * k;
      parts.head.rotation.x = -0.25 * k;
      parts.snack.visible = false;
      return true;
    };
    const runIdle = (cave, dt) => {
      const parts = cave.parts, a = cave.act;
      cave.root.position.y = groundY(cave) + cave.hop;
      const sitting = cave.state === "chilling" && a.spot.sit && cave.hop === 0;
      parts.legR.rotation.x = parts.legL.rotation.x = sitting ? -Math.PI / 2 : 0;
      if (sitting) {
        // Only the resting pose is lowered; support and hops still use standing feet.
        cave.restLower = Math.max(0, cave.baseY - cave.traits.height * 0.08);
        cave.root.position.y -= cave.restLower;
      }
      parts.torso.scale.y = 1 + Math.sin(elapsed * 2.2 + cave.phase) * 0.015;
      if (cave.cheer > 0) {
        const wave = Math.sin(elapsed * 14 + cave.phase) * 0.35;
        parts.armR.rotation.x = -2.6 + wave;
        parts.armL.rotation.x = -2.6 - wave;
        parts.head.rotation.x = -0.15;
        return;
      }
      if (cave.catchT > 0) {
        const k = cave.catchT;
        parts.armR.rotation.x = -0.2 - k * 1.6;
        parts.armL.rotation.x = -0.2 - k * 1.6;
        parts.head.rotation.x = -k * 0.2;
        return;
      }
      if (cave.state !== "chilling" && runYawn(cave)) return;
      parts.head.rotation.y = Math.sin(elapsed * 0.9 + cave.phase) * 0.55;
      parts.head.rotation.x = 0.08 + Math.sin(elapsed * 0.5 + cave.phase) * 0.1;
      const arm = sitting ? -0.75 : -0.2;
      parts.armL.rotation.x = damp(parts.armL.rotation.x, arm, 10, dt);
      parts.armR.rotation.x = damp(parts.armR.rotation.x, arm, 10, dt);
      if (!a.said && elapsed > a.sayAt) {
        a.said = true;
        if (Math.random() < 0.6) idleSay(cave);
      }
      if (cave.state === "chilling" && ctx.npcRouteBlocked && ctx.npcRouteBlocked(cave, cave.root.position.x, cave.root.position.y - cave.baseY, cave.root.position.z)) { startWander(cave); return; }
      if (elapsed < a.until) return;
      parts.head.rotation.y = 0;
      parts.head.rotation.x = 0;
      if (cave.state === "chilling") {
        if (wanderSpot) startWander(cave);
        else a.until = elapsed + chillPause(cave);
        return;
      }
      if (!wanderSpot || (world.level >= 1 && (a.trips >= TRIPS_MAX || Math.random() < 0.45))) {
        a.kind = "eat";
        walkToSlot(cave, true);
        if (cave.walk) cave.walk.speed = 1.6;
      } else {
        startWander(cave);
      }
    };
    const footSparks = (cave, power) => {
      const p = cave.root.position, side = cave.traits.height * 2.5 / 16, yaw = cave.root.rotation.y;
      const dx = Math.cos(yaw) * side, dz = -Math.sin(yaw) * side;
      ctx.fx.burst(p.x - dx, p.y - cave.baseY + 0.04, p.z - dz, power, JET_SPARKS, 1.1);
      ctx.fx.burst(p.x + dx, p.y - cave.baseY + 0.04, p.z + dz, power, JET_SPARKS, 1.1);
    };
    const runRocketJump = (cave, dt) => {
      const burning = cave.rocketJumpTime > 0 && cave.rocketJumpHeld && cave.hopV > 0 && !cave.health.stunned;
      if (!burning) cave.rocketJumpTime = 0;
      else {
        const burn = Math.min(dt, cave.rocketJumpTime);
        // Half gravity for twice the ordinary apex time gives exactly the
        // height of two full jumps timed at their apices, without jetpack fuel.
        cave.hopV += WALK.gravity * burn * 0.5;
        cave.rocketJumpTime -= burn;
        cave.rocketPuff -= dt;
        if (cave.rocketPuff <= 0) { cave.rocketPuff = JET_PUFF; footSparks(cave, 1); }
      }
      cave.parts.jetpack.visible = burning;
      cave.parts.jetFlame.visible = burning;
      if (burning) cave.parts.jetFlame.scale.y = 0.7 + Math.sin(elapsed * 40 + cave.phase) * 0.3;
    };
    const runJet = (cave, dt, driving) => {
      const jet = cave.jet;
      if (cave.jetRecovering) jet.thrust = false;
      const moving = driving && !cave.jetRecovering && (cave.hop > 0 || cave.hopV > 0) && Math.hypot(steer.x, steer.z) > 0.05;
      jet.power = (jet.thrust ? 2 : 0) + (moving ? 1 : 0);
      jet.spending = jet.power > 0;
      // A character's own thrusters can hold less than the standard pack: the gauge
      // still reads its own tank, that tank is just a shorter burn.
      if (jet.spending) cave.jetFuel = Math.max(0, cave.jetFuel - dt * jet.power / (JET_MOVE_SECONDS * jetTank(cave)));
      if (cave.jetFuel < 1e-10) { cave.jetFuel = 0; jet.thrust = false; jet.power = 0; }
      // A throw can already be rising faster than the pack's powered speed.
      // Thrust must not erase that momentum when the visitor first presses it.
      if (jet.thrust && cave.hopV < JET_RISE) {
        cave.hopV = Math.min(cave.hopV + JET_ACCEL * dt, JET_RISE);
      }
      if (jet.power) {
        jet.puff -= dt;
        if (jet.puff <= 0) {
          jet.puff = JET_PUFF;
          if (cave.traits.footRockets) footSparks(cave, jet.power / 2);
          else {
            const p = cave.root.position;
            ctx.fx.burst(p.x, p.y + 0.12, p.z, jet.power, JET_SPARKS, 1.1);
          }
        }
      }
      jet.flame.visible = jet.power > 0;
      if (jet.power) jet.flame.scale.y = (0.7 + Math.sin(elapsed * 40 + cave.phase) * 0.3) * jet.power / 2;
    };
    // Flying is also blocked by rock standing above him.
    const canStep = (cave, flying, fromX, fromZ, toX, toZ) => {
      const y = cave.root.position.y - cave.baseY;
      const height = cave.bodyHeight + Math.max(0, cave.viewLift);
      // On foot, the scene's own walkers are bodies to walk round, not through.
      if (!flying && cave.hop <= 0 && (!shoulderClear(cave, toX, toZ)
        || !outsideClear(fromX, fromZ, toX, toZ, y, height))) return false;
      return flying || cave.hop > 0
        ? flyable(fromX, fromZ, toX, toZ, y, height, cave) && groundAt(toX, toZ, y, y, cave) <= y
        : walkable(fromX, fromZ, toX, toZ, y, height, cave);
    };
    const movePlayer = (cave, flying, dx, dz) => {
      const p = cave.root.position, steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / PLAYER_STEP));
      dx /= steps;
      dz /= steps;
      for (let i = 0; i < steps; i++) {
        const speed = inBananas(cave) ? 0.5 : 1, sx = dx * speed, sz = dz * speed;
        const distance = Math.hypot(sx, sz);
        if (!flying && distance > 1e-8 && shoulderStep(cave, sx / distance, sz / distance, distance, false) >= 0) continue;
        if (canStep(cave, flying, p.x, p.z, p.x + sx, p.z + sz)) {
          p.x += sx;
          p.z += sz;
        } else {
          if (sx && canStep(cave, flying, p.x, p.z, p.x + sx, p.z)) p.x += sx;
          if (sz && canStep(cave, flying, p.x, p.z, p.x, p.z + sz)) p.z += sz;
        }
        if (!flying && cave.hop === 0) p.y = groundY(cave);
      }
    };
    const clampPlayerCeiling = (cave, ground, feet = cave.root.position.y - cave.baseY) => {
      if (!ctx.ceilingAt) return;
      const p = cave.root.position, ceiling = ctx.ceilingAt(p.x, p.z, feet, cave);
      const height = cave.bodyHeight + Math.max(0, cave.viewLift);
      const limit = Math.max(0, ceiling - (ground - cave.baseY) - height);
      // Held thrust keeps contact instead of integrating a gravity drop between impulses; a higher roof releases it.
      const held = cave.jet && cave.jet.thrust && feet + height >= ceiling - 1e-7;
      if (cave.hop <= limit && !held) return;
      cave.hop = limit;
      cave.hopV = held ? 0 : Math.min(cave.hopV, 0);
    };
    // A ladder owns a vertical body rectangle and a separate horizontal footprint. The top quarter of the
    // vertical rectangle clearing the landing starts the inward handoff; feet still rise at climbing speed.
    const ladderPose = (cave) => {
      const l = cave.ladder, parts = cave.parts, wave = Math.sin(cave.act.phase), mix = l.mix;
      standPose(cave);
      parts.torso.rotation.x = -0.12 * mix;
      parts.armR.rotation.x = lerp(-0.2, -2.2 + wave * 0.2, mix);
      parts.armL.rotation.x = lerp(-0.2, -2.2 - wave * 0.2, mix);
      parts.legR.rotation.x = wave * 0.35 * mix;
      parts.legL.rotation.x = -wave * 0.35 * mix;
      parts.head.rotation.x = -0.1 * mix;
      parts.snack.visible = false;
    };
    const leaveLadder = (cave) => {
      const l = cave.ladder;
      l.plane = null; l.cooldown = 0.35; l.mix = 0; l.descentHeld = false;
      cave.hop = Math.max(0, cave.root.position.y - groundY(cave));
      cave.hopV = 0; cave.jumps = cave.hop > 0 ? 1 : 0;
      standPose(cave);
    };
    const runLadder = (cave, dt, driving) => {
      const l = cave.ladder;
      if (!l) return false;
      const p = cave.root.position, feet = p.y - cave.baseY;
      l.cooldown = Math.max(0, l.cooldown - dt);
      if (!l.plane && driving && l.cooldown === 0 && !(cave.jet && cave.jet.thrust)) {
        for (const plane of ctx.ladders) {
          const dx = p.x - plane.x, dz = p.z - plane.z, along = dx * plane.nx + dz * plane.nz;
          const across = dx * plane.nz - dz * plane.nx, outward = steer.x * plane.nx + steer.z * plane.nz;
          const gap = cave.bodyRadius * 0.5, half = plane.width / 2;
          // At the top the outward walking command becomes descent until released, so a held W cannot
          // immediately reverse the mount and put the character back on the deck.
          const fromTop = Math.abs(feet - plane.top) < 0.15 && outward > 0.05;
          const fromFace = feet >= plane.bottom - 0.1 && feet < plane.top - 0.15 && outward < -0.05;
          if ((!fromTop && !fromFace) || Math.abs(across) > half - 0.1
            || along < -cave.bodyRadius || along > gap + 0.08) continue;
          l.plane = plane; l.across = across; l.along = along;
          l.descentHeld = fromTop && steer.forward > 0.05;
          l.flat.width = l.vertical.width = cave.bodyRadius * 2;
          l.flat.depth = cave.bodyRadius * 2; l.vertical.height = cave.bodyHeight;
          clearShoulder(cave);
          cave.hopV = 0; cave.leap.vx = cave.leap.vz = cave.leap.land = 0;
          cave.leap.thrown = cave.leap.rageThrown = false;
          break;
        }
      }
      if (!l.plane) return false;
      const plane = l.plane, height = l.vertical.height;
      if (steer.forward <= 0.05) l.descentHeld = false;
      const axis = driving ? (l.descentHeld ? -steer.forward : steer.forward) : -1;
      const side = driving ? steer.strafe : 0, length = Math.max(1, Math.hypot(axis, side));
      const speed = LADDER_SPEED * (driving ? steer.speed : 1), step = speed * dt / length;
      const nextFeet = clamp(feet + axis * step, plane.bottom, plane.top);
      const across = clamp(l.across - side * step, -plane.width / 2 + 0.1, plane.width / 2 - 0.1);
      // The exposed vertical fraction and the footprint's landing fraction are kept separate. Start moving
      // over the lip at 25% exposure, with no flip animation or pause in the held movement.
      const exposed = clamp((nextFeet + height - plane.top) / height, 0, 1);
      const blend = clamp((exposed - 0.25) / 0.75, 0, 1);
      const gap = cave.bodyRadius * 0.5, inset = plane.inset, landingTarget = lerp(gap, -inset, blend);
      const target = axis < 0 ? Math.max(l.along, landingTarget) : axis > 0 ? Math.min(l.along, landingTarget) : l.along;
      const along = l.along + clamp(target - l.along, -speed * dt, speed * dt);
      const nx = plane.x + plane.nz * across + plane.nx * along;
      const nz = plane.z - plane.nx * across + plane.nz * along;
      // Check scenery at the actual feet height; a ladder never grants passage through a machine or wall.
      if (!flyable(p.x, p.z, nx, nz, Math.min(feet, nextFeet), cave.bodyHeight, cave)) return true;
      l.along = along; l.across = across; p.x = nx; p.z = nz; p.y = cave.baseY + nextFeet;
      cave.hop = Math.max(0, p.y - groundY(cave)); cave.hopV = 0;
      cave.root.rotation.y = Math.atan2(-plane.nx, -plane.nz);
      l.vertical.overlap = 1 - exposed;
      l.flat.overlap = clamp((l.flat.depth / 2 - along) / l.flat.depth, 0, 1);
      l.mix = 1 - blend;
      cave.act.phase += Math.hypot(axis, side) * dt * 8;
      ladderPose(cave);
      if (axis > 0 && nextFeet >= plane.top && along <= -inset + 1e-6
        || axis < 0 && nextFeet <= plane.bottom && along >= gap - 1e-6) leaveLadder(cave);
      return true;
    };
    const runPlayer = (cave, dt, driving = true) => {
      if (runLadder(cave, dt, driving)) return;
      const p = cave.root.position, leap = cave.leap;
      const fromX = p.x, fromZ = p.z;
      const wasGround = groundY(cave);
      const onGorilla = ctx.standingOnGorilla && ctx.standingOnGorilla(cave, wasGround);
      if (cave.jet) runJet(cave, dt, driving);
      else if (cave.traits.footRockets) runRocketJump(cave, dt);
      clampPlayerCeiling(cave, wasGround);
      p.y = wasGround + cave.hop;
      if (cave.jet && cave.jet.thrust && ctx.glideJetCeiling && ctx.glideJetCeiling(cave, dt)) cave.hopV = Math.max(cave.hopV, JET_RISE);
      const flying = !!cave.jet && !cave.jetRecovering && cave.jetFuel > 0 && (cave.jet.thrust || cave.hop > 0.05);
      const len = driving ? Math.hypot(steer.x, steer.z) : 0;
      const jetSteering = leap.thrown && flying && len > 0.05;
      if (len > 0.05) {
        if (jetSteering) {
          // A steered flight is the visitor's again: Oogas, short props and
          // decor block it as they do any other flight.
          leap.rageThrown = false;
          // Counter-thrust steers the actual throw velocity, not a second
          // displacement that an outward throw can permanently overpower.
          const speed = Math.min(1, len) * JET_SPEED, vx = leap.vx, vz = leap.vz;
          const dx = steer.x / len * speed - vx, dz = steer.z / len * speed - vz;
          const difference = Math.hypot(dx, dz), burn = Math.min(dt, difference / JET_ACCEL);
          const blend = difference > 0 ? Math.min(1, JET_ACCEL * dt / difference) : 0;
          leap.vx += dx * blend; leap.vz += dz * blend;
          // Integrate the acceleration and any constant-speed remainder so
          // braking and reversal cover the same distance at every frame rate.
          movePlayer(cave, flying, (vx + leap.vx) * 0.5 * burn + leap.vx * (dt - burn),
            (vz + leap.vz) * 0.5 * burn + leap.vz * (dt - burn));
        } else {
          const k = Math.min(1, len) * (flying ? JET_SPEED : PLAYER_SPEED * steer.speed) * dt;
          movePlayer(cave, flying, steer.x / len * k, steer.z / len * k);
        }
        const heading = Math.atan2(steer.x, steer.z);
        if (!cave.weapon.aiming && Math.abs(steer.forward) > 0.05 && Math.abs(steer.strafe) <= 0.05) cave.root.rotation.y = heading;
        else if (!cave.weapon.aiming) cave.root.rotation.y += Math.atan2(Math.sin(heading - cave.root.rotation.y), Math.cos(heading - cave.root.rotation.y)) * Math.min(1, 12 * dt) * (1 - steer.view);
        cave.act.phase += dt * 10 * steer.speed * (steer.view > 0 && steer.forward < -0.05 ? -1 : 1);
        const positionY = p.y;
        walkPose(cave, cave.act.phase);
        p.y = positionY;
        if (steer.view > 0) closeWalkPose(cave);
        cave.parts.snack.visible = false;
      } else {
        cave.act.phase = 0;
        standPose(cave);
        cave.parts.torso.scale.y = 1 + Math.sin(elapsed * 2.2 + cave.phase) * 0.015;
      }
      if (cave.hop > 0 && (leap.vx || leap.vz) && !jetSteering) {
        const dx = leap.vx * dt, dz = leap.vz * dt;
        movePlayer(cave, flying, dx, dz);
        if (!leap.thrown) {
          leap.vx = damp(leap.vx, 0, WALK.ledgeDrag, dt);
          leap.vz = damp(leap.vz, 0, WALK.ledgeDrag, dt);
        }
        flyPose(cave);
      }
      if (flying) flyPose(cave);
      else if (cave.hop > 0 && ctx.abyssAt && ctx.abyssAt(p.x, p.z, p.y - cave.baseY, cave)) {
        flyPose(cave);
        cave.parts.armR.rotation.x = cave.parts.armL.rotation.x = -2.1;
      }
      // Airborne he holds a world height, so ground steps never lift him.
      if (flying || cave.hop > 0) cave.hop = Math.max(0, cave.hop + wasGround - groundY(cave));
      else {
        // Off a ledge the new support is the lower layer, and the height line below would snap him down in one frame.
        // Carry the drop in hop instead, so he leaves at his old height and falls forward.
        const drop = wasGround - groundY(cave);
        if (drop > STEP) {
          cave.hop += drop;
          if (!onGorilla && !cave.cloudSupport && !inBananas(cave)) {
            cave.hopV = Math.max(cave.hopV, WALK.ledgeRise);
            // Aim may face away from travel. Leaving the same ledge must
            // carry the same motion in combat and carry views.
            const dx = p.x - fromX, dz = p.z - fromZ, distance = Math.hypot(dx, dz);
            leap.vx = (distance > 1e-7 ? dx / distance : Math.sin(cave.root.rotation.y)) * WALK.ledgeSpeed;
            leap.vz = (distance > 1e-7 ? dz / distance : Math.cos(cave.root.rotation.y)) * WALK.ledgeSpeed;
          }
        }
      }
      // Only this line sets the height, so nothing compounds.
      const ground = groundY(cave);
      // A fresh ledge fall is still above the cave roof; query the ceiling at that world height, not the apron's.
      clampPlayerCeiling(cave, ground, ground - cave.baseY + cave.hop);
      cave.root.position.y = ground + cave.hop;
      // Movement can acquire a cloud after the pre-gravity support query; keep that layer if it drifts next frame.
      if (ctx.cloudAt) cave.cloudSupport = ctx.cloudAt(p.x, p.z, p.y - cave.baseY);
      if (grounded(cave)) cave.jumps = 0;
      else cave.jumps = Math.max(1, cave.jumps);
      if (cave.hop === 0 && (leap.vx || leap.vz || leap.thrown)) {
        leap.vx = leap.vz = 0;
        leap.thrown = leap.rageThrown = false;
        leap.land = 0.25;
        ctx.fx.burst(p.x, p.y + 0.05, p.z, 6, LAND_DUST, 1.2);
      }
      if (leap.land > 0) {
        leap.land = Math.max(0, leap.land - dt);
        cave.parts.torso.scale.y = 1 - leap.land * 0.6;
      }
      if (cave.catchT > 0) {
        const k = cave.catchT;
        cave.parts.armR.rotation.x = -0.2 - k * 1.6;
        cave.parts.armL.rotation.x = -0.2 - k * 1.6;
        cave.parts.head.rotation.x = -k * 0.2;
      } else cave.parts.head.rotation.x = 0;
    };
    const runRoofEscape = (cave, dt) => {
      if (!ctx.npcCaveRoofAt || cave.humanControlled || cave.health.stunned || cave.jet) return false;
      const escape = cave.roofEscape, p = cave.root.position;
      if (!escape.active) {
        if (!grounded(cave) || !ctx.npcCaveRoofAt(p.x, p.y - cave.baseY, p.z)) return false;
        escape.active = true; escape.jumping = false; escape.blocked = 0;
        resetWalkerRoute(cave); stopBurst(cave);
      }
      if (escape.jumping) {
        if (grounded(cave)) {
          escape.active = escape.jumping = false; escape.blocked = 0;
          resetWalkerRoute(cave);
          return false;
        }
        // Keep the inward running momentum throughout the fall. The usual
        // airborne sweep, ceiling clamp and support query own the landing.
        const distance = Math.hypot(p.x, p.z);
        cave.leap.vx = distance ? -p.x / distance * RUSH_SPEED : 0;
        cave.leap.vz = distance ? -p.z / distance * RUSH_SPEED : 0;
        runPlayer(cave, dt, false);
        return true;
      }
      if (p.y - cave.baseY <= STEP && !ctx.npcCaveRoofAt(p.x, p.y - cave.baseY, p.z)) {
        escape.active = false; resetWalkerRoute(cave); return false;
      }
      let remaining = RUSH_SPEED * dt, moved = 0;
      while (remaining > 1e-8) {
        const distance = Math.hypot(p.x, p.z);
        if (distance < 0.1) { escape.active = false; return false; }
        const sx = -p.x / distance, sz = -p.z / distance, feet = p.y - cave.baseY;
        const ahead = groundAt(p.x + sx * 0.75, p.z + sz * 0.75, feet, feet, cave);
        if (feet - ahead > STEP || escape.blocked >= 0.4) {
          escape.jumping = true; escape.blocked = 0;
          cave.root.rotation.y = Math.atan2(sx, sz);
          clearShoulder(cave);
          cave.hopV = JUMP_SPEED; cave.jumps = 1;
          cave.leap.vx = sx * RUSH_SPEED; cave.leap.vz = sz * RUSH_SPEED;
          cave.parts.snack.visible = false;
          flyPose(cave);
          return true;
        }
        const step = walkToward(cave, 0, 0, remaining);
        if (!step) { escape.blocked += dt; break; }
        escape.blocked = 0; moved += step; remaining -= step;
      }
      if (moved) {
        cave.act.phase += moved * 5;
        walkPose(cave, cave.act.phase);
        p.y = groundY(cave);
      } else standPose(cave);
      cave.parts.snack.visible = false;
      return true;
    };
    // Every voxel part is paired with its twin both ways, so one pass over the
    // body changes the colourway and a second pass changes it back.
    const swapTint = (cave) => {
      const tint = cave.tint;
      const visit = (node) => {
        const twin = node.geometry && tint.get(node.geometry);
        if (twin) node.geometry = twin;
        for (let i = 0; i < node.children.length; i++) visit(node.children[i]);
      };
      visit(cave.root);
      cave.headOpen = tint.get(cave.headOpen) || cave.headOpen;
      cave.headClosed = tint.get(cave.headClosed) || cave.headClosed;
      cave.portraitHead = tint.get(cave.portraitHead) || cave.portraitHead;
      cave.parts.head.geometry = cave.state === "sleeping" ? cave.headClosed : cave.headOpen;
    };
    // The NPC host's colourway, on a page following it.
    const setTint = (cave, state) => {
      if (!cave.tint || cave.tintState === state) return;
      swapTint(cave);
      cave.tintState = state;
    };
    // A hand toggle restarts the timer too, so it does not flip again seconds later.
    const toggleTint = (cave) => {
      if (!cave || !cave.tint) return false;
      swapTint(cave);
      cave.tintState ^= 1;
      cave.tintTime = tintWait();
      cave.tintHold = TINT_HOLD;
      return true;
    };
    const updateCaveman = (cave, dt) => {
      clearHeadLook(cave);
      const parts = cave.parts;
      if (ctx.prepareCloudSupport && (!cave.bedTravel.mode || cave.bedTravel.mode === "landing" || cave.bedTravel.mode === "waiting")) ctx.prepareCloudSupport(cave);
      if (!(cave.ladder && cave.ladder.plane) && cave.root.visible && (cave.state === "working" || cave.state === "chilling" || cave.bedTravel.mode === "landing" || cave.bedTravel.mode === "waiting" || cave.bedTravel.mode === "walk")) {
        // Hop is relative to support but the body lives at a world height; rebase before gravity when support changes.
        const floor = groundY(cave), p = cave.root.position;
        cave.hop = Math.max(0, p.y - floor);
        if (p.y < floor) p.y = floor;
      }
      cave.highlight = damp(cave.highlight, cave.highlightTarget, 12, dt);
      for (let i = 0; i < BODY_PARTS.length; i++) parts[BODY_PARTS[i]].highlight = cave.highlight;
      // A carved head breathes its candlelight from dim to bright
      if (cave.traits.pumpkin) parts.head.glow = 0.62 + 0.38 * Math.sin(elapsed * 2.1 + cave.phase);
      if (cave.traits.nunchaku && (cave.meleeSwap -= dt) <= 0) {
        cave.meleeOut = !cave.meleeOut;
        cave.meleeSwap = swapWait(cave.meleeOut);
        if (cave.meleeOut) startTwirl(cave, cave.meleeSwap);
      }
      if (cave.twirlFlipAt <= elapsed) {
        cave.twirlHand = cave.twirlHand ? 0 : 1;
        cave.twirlFlipAt = Infinity;
      }
      if (cave.tint) {
        if (cave.tintHold > 0) cave.tintHold -= dt;
        const want = cave.tintHold > 0 ? -1 : tintWanted();
        if (want >= 0) {
          if (want !== cave.tintState) {
            swapTint(cave);
            cave.tintState = want;
          }
          cave.tintTime = tintWait();
        } else if ((cave.tintTime -= dt) <= 0) {
          swapTint(cave);
          cave.tintState ^= 1;
          cave.tintTime = tintWait();
        }
      }
      if (!(cave.ladder && cave.ladder.plane) && (cave.hopV > 0 || cave.hop > 0)) {
        cave.hopV -= WALK.gravity * dt;
        // Fruit halves vertical travel without changing ballistic momentum; leaving restores normal movement at once.
        const verticalScale = inBananas(cave) ? 0.5 : 1;
        cave.hop = Math.max(0, cave.hop + cave.hopV * dt * verticalScale);
        if (cave.hop === 0 && cave.hopV < 0) {
          cave.hopV = 0;
          if (cave.jet && cave.jetFuel < JET_LAUNCH_FUEL) cave.jetRecovering = true;
        }
      }
      const recovery = cave.avoidance.navigation;
      if (recovery.mode === 4 && cave !== player) {
        if (cave.hop === 0 && cave.hopV <= 0) {
          recovery.mode = 0; cave.avoidance.stalled = 0; cave.avoidance.best = Infinity;
          cave.leap.vx = cave.leap.vz = 0; cave.root.position.y = groundY(cave);
        } else {
          if (recovery.double && !recovery.boosted && cave.hopV <= 0 && !inBananas(cave)) { recovery.boosted = true; cave.hopV = JUMP_SPEED; }
          if (groundY(cave) - cave.baseY + cave.hop >= recovery.clearance) recovery.moving = true;
          const dx = recovery.jumpX - cave.root.position.x, dz = recovery.jumpZ - cave.root.position.z, distance = Math.hypot(dx, dz);
          const speed = recovery.moving && !inBananas(cave) ? Math.min(3, distance / dt) : 0;
          cave.leap.vx = distance ? dx / distance * speed : 0; cave.leap.vz = distance ? dz / distance * speed : 0;
        }
      }
      if (cave.cheer > 0) cave.cheer -= dt;
      if (cave.yawn > 0) cave.yawn -= dt;
      if (cave.catchT > 0) cave.catchT = Math.max(0, cave.catchT - dt * 1.6);
      for (let i = 0; i < cave.swagNodes.length; i++) {
        const node = cave.swagNodes[i];
        if (node.swag.float) node.position.y = (node.swag.offset ? node.swag.offset.y : 0) + Math.sin(elapsed * 2.5 + cave.phase) * 0.04;
        for (let c = 0; c < node.children.length; c++) if (node.children[c].spin) node.children[c].rotation.y += dt * 9;
      }
      if (cave.bedTravel.mode) { runBed(cave, dt); return; }
      if (cave.state !== "working" && cave.state !== "chilling") {
        if (cave.state === "sleeping" && cave.bedroll && !cave.bedroll.hidden) {
          parts.torso.scale.y = 1 + Math.sin(elapsed * 1.4 + cave.phase) * 0.03;
          cave.zzzTimer -= dt;
          if (cave.zzzTimer <= 0) {
            cave.zzzTimer = 1.6;
            ctx.fx.zzzAt(cave.bedroll.x + 0.6, (cave.bedroll.y === undefined ? 0 : cave.bedroll.y) + 0.55, cave.bedroll.z, cave);
          }
        }
        return;
      }
      if (cave !== player && cave.ladder && cave.ladder.plane) { runLadder(cave, dt, false); return; }
      if (ctx.playerName && cave !== player) { standPose(cave); poseWeapon(cave); return; }
      if (cave === player) {
        runPlayer(cave, dt);
        runReload(cave, dt);
        return;
      }
      if (ctx.abyssAt && ctx.abyssAt(cave.root.position.x, cave.root.position.z, cave.root.position.y - cave.baseY, cave)) {
        if (cave.leap.thrown) {
          // A thrown Ooga keeps the launch velocity over open water.
          runPlayer(cave, dt, false);
          if (cave.root.position.y - cave.baseY >= (ctx.seaY ?? ctx.abyssRespawnY)) return;
          cave.leap.thrown = cave.leap.rageThrown = false;
        } else {
          // Releasing possession must not strand an Ooga beneath the world.
          cave.root.position.y = groundY(cave) + cave.hop;
          flyPose(cave);
          cave.parts.armR.rotation.x = cave.parts.armL.rotation.x = -2.1;
          if (cave.root.position.y - cave.baseY >= ctx.abyssRespawnY) return;
        }
        if (ctx.respawnSpot && !ctx.respawnSpot(cave, NPC_RECOVERY_SPOT)) return;
        if (ctx.onAbyssRespawn) ctx.onAbyssRespawn(cave);
        cave.hop = cave.hopV = cave.jumps = 0;
        cave.leap.vx = cave.leap.vz = 0;
        standPose(cave);
        cave.cloudSupport = null;
        // A scene's respawn location takes priority over work and wander slots.
        if (ctx.respawnSpot) {
          setVec(cave.root.position, NPC_RECOVERY_SPOT.x, cave.baseY + NPC_RECOVERY_SPOT.y, NPC_RECOVERY_SPOT.z);
          cave.walk = null; cave.work.phase = ""; cave.work.direct = true; cave.act.spot.sit = false;
          resetWalkerRoute(cave); cave.progress.backoff = 0;
        }
        else if (cave.slot) standAtSlot(cave);
        else if (ctx.npcRecoverySpot && ctx.npcRecoverySpot(cave, NPC_RECOVERY_SPOT))
          setVec(cave.root.position, NPC_RECOVERY_SPOT.x, cave.baseY + NPC_RECOVERY_SPOT.y, NPC_RECOVERY_SPOT.z);
        else setVec(cave.root.position, walkIn.x, cave.baseY + groundAt(walkIn.x, walkIn.z, Infinity, Infinity, cave), walkIn.z);
        startMeal(cave);
        return;
      }
      if (cave.leap.thrown) { runPlayer(cave, dt, false); return; }
      if (runRoofEscape(cave, dt)) return;
      if (cave.hop > 0 || cave.hopV > 0) { runPlayer(cave, dt, false); return; }
      if (workSites && cave.state === "working" && cave.cheer > 0) {
        standPose(cave);
        runIdle(cave, dt);
        parts.snack.visible = false;
        return;
      }
      if (cave.walk) {
        runWalk(cave, dt);
        return;
      }
      if (cave.state === "chilling") {
        if (cave.act.kind !== "idle") { cave.act.kind = "idle"; cave.act.until = elapsed + chillPause(cave); }
        runIdle(cave, dt);
        return;
      }
      if (workSites) { runWork(cave, dt); return; }
      if (cave.build) {
        runBuild(cave, dt);
        cave.root.position.y = groundY(cave) + cave.hop;
        return;
      }
      if (!cave.weapon.ammo && !cave.weapon.reloading) startReload(cave);
      if (runReload(cave, dt)) return;
      if (cave.act.kind === "idle") {
        runIdle(cave, dt);
        return;
      }
      // Idle breathing scales the torso, not the root.
      cave.root.position.y = groundY(cave) + cave.hop;
      parts.torso.scale.y = 1 + Math.sin(elapsed * 2.2 + cave.phase) * 0.015;
      const fed = world.level >= 1;
      if (cave.cheer > 0) {
        const wave = Math.sin(elapsed * 14 + cave.phase) * 0.35;
        parts.armR.rotation.x = -2.6 + wave;
        parts.armL.rotation.x = -2.6 - wave;
        parts.head.rotation.x = -0.15;
        parts.snack.visible = false;
        return;
      }
      if (cave.catchT > 0) {
        const k = cave.catchT;
        parts.armR.rotation.x = -0.2 - k * 1.6;
        parts.armL.rotation.x = -0.2 - k * 1.6;
        parts.head.rotation.x = -k * 0.2;
        return;
      }
      if (runYawn(cave)) return;
      parts.armR.rotation.x = damp(parts.armR.rotation.x, -0.2, 10, dt);
      if (wanderSpot) {
        if (!fed && cave.act.until > elapsed + HUNGRY_LINGER) cave.act.until = elapsed + HUNGRY_LINGER;
        if (elapsed > cave.act.until) {
          startWander(cave);
          return;
        }
      }
      if (fed) {
        if (elapsed > cave.nextBuildAt && (buildSpots.length || builtEquipment.length)) {
          startBuild(cave);
          return;
        }
        world.level = Math.max(0, world.level - EAT_RATE * dt);
        const chew = (elapsed + cave.phase) % CHEW_PERIOD / CHEW_PERIOD;
        if (chew < 0.18) parts.armL.rotation.x = lerp(-0.2, -1.05, chew / 0.18);
        else if (chew < 0.42) parts.armL.rotation.x = lerp(-1.05, -2.3, (chew - 0.18) / 0.24);
        else if (chew < 0.58) parts.armL.rotation.x = lerp(-2.3, -0.2, (chew - 0.42) / 0.16);
        else parts.armL.rotation.x = -0.2;
        parts.head.rotation.x = chew > 0.34 && chew < 0.54 ? Math.sin((chew - 0.34) / 0.2 * Math.PI) * 0.22 : 0;
        parts.snack.visible = chew >= 0.18 && chew < 0.42;
        parts.snack.scale.x = parts.snack.scale.y = parts.snack.scale.z = models.BANANA_AMMO_SCALE;
      } else {
        parts.armL.rotation.x = -0.1;
        parts.snack.visible = false;
        parts.head.rotation.x = 0.35;
      }
    };
    const ensureStunDrop = (cave, drop) => {
      if (drop.node) return drop.node;
      const h = cave.traits.height;
      if (drop.kind === "magazine") {
        drop.model = models.spareMagazine();
        drop.node = drop.model.node;
      } else {
        const geometry = drop.kind === "ammo" ? models.bananaGeometry() : null;
        drop.node = createNode({ geometry, sightHidden: true, matrixLiving: !!ctx.matrixLivingPile });
      }
      drop.node.sightHidden = true;
      drop.node.matrixLiving = !!ctx.matrixLivingPile;
      const scale = drop.kind === "ammo" ? 0.75 : h;
      setVec(drop.node.scale, scale, scale, scale);
      addChild(root, drop.node);
      return drop.node;
    };
    const placeStunDrop = (cave, drop, geometry = null) => {
      const node = ensureStunDrop(cave, drop), h = cave.traits.height, p = cave.root.position;
      if (geometry) node.geometry = geometry;
      const angle = cave.index * 1.71 + drop.slot * 1.2566370614359172;
      const radius = (0.58 + drop.slot * 0.055) * h;
      const x = p.x + Math.sin(angle) * radius, z = p.z + Math.cos(angle) * radius;
      setVec(node.position, x, groundAt(x, z, p.y - cave.baseY) + 0.09 * h, z);
      setVec(node.rotation, Math.PI / 2, angle, 0);
      node.quaternion = null;
      node.visible = true;
      drop.owner = cave;
      drop.active = true;
      drop.returning = false;
      drop.returnTime = 0;
      if (drop.kind === "ammo") drop.label = drop.unlimited ? "∞" : "+" + drop.ammo;
      else if (drop.kind === "magazine") drop.label = "+1 MAG";
      if (drop.model) drop.model.setAmmo(drop.ammo);
      if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(node);
    };
    const collectStunDrop = (drop, cave) => {
      const w = cave.weapon;
      if (drop.kind === "ammo") {
        if (drop.unlimited) {
          if (w.unlimited) return false;
          w.unlimited = true;
          drop.ammo = 0;
        } else {
          if (w.unlimited) return false;
          const added = collectAmmo(drop.ammo, cave);
          if (!added) return false;
          drop.ammo -= added;
          if (drop.ammo > 0) {
            drop.label = "+" + drop.ammo;
            return true;
          }
        }
      } else if (drop.kind === "magazine") {
        const before = drop.ammo, count = w.spareAmmo.length;
        drop.ammo = collectGroundMagazine(drop.ammo, cave);
        if (drop.model) drop.model.setAmmo(drop.ammo);
        if (drop.ammo === before && w.spareAmmo.length === count) return false;
        if (drop.ammo > 0) return true;
      }
      drop.active = drop.returning = false;
      drop.node.visible = false;
      if (!cave.health.stunned) poseWeapon(cave);
      return true;
    };
    const dropStunGear = (cave) => {
      const w = cave.weapon, gear = cave.stunGear, drops = gear.drops;
      gear.selectedSlot = w.selectedSlot;
      if (cave.sleepWeapons.visible) takeBedWeapons(cave);
      if (w.secondaryOwned && (w.ammo > 0 || w.unlimited)) {
        const drop = drops[0];
        drop.ammo = w.ammo; drop.unlimited = w.unlimited;
        w.ammo = 0; w.unlimited = false;
        placeStunDrop(cave, drop);
      }
      for (let i = 0; i < 2; i++) {
        const drop = drops[i + 1];
        if (i >= w.spareAmmo.length) continue;
        drop.ammo = w.spareAmmo[i];
        placeStunDrop(cave, drop);
      }
      w.spareAmmo.length = 0;
      syncMagazine(cave);
      w.equipped = w.primaryEquipped = w.aiming = false;
      cave.parts.club.visible = cave.parts.gun.visible = cave.parts.gunFlash.visible = false;
      if (cave.parts.chukTrail) for (const trail of cave.parts.chukTrail) trail.visible = false;
    };
    const finishStun = (cave) => {
      const w = cave.weapon, health = cave.health;
      health.stunned = health.recovering = false;
      cave.stunBirds.visible = false;
      setVec(cave.parts.head.rotation, 0, 0, 0);
      const selected = cave.stunGear.selectedSlot;
      w.selectedSlot = selected === 2 && w.secondaryOwned ? 2 : w.primaryOwned ? 1 : w.secondaryOwned ? 2 : 0;
      w.primaryEquipped = w.selectedSlot === 1;
      w.equipped = w.selectedSlot === 2;
      poseWeapon(cave);
    };
    const updateStunGear = (dt) => {
      for (let ownerIndex = 0; ownerIndex < crewList.length; ownerIndex++) {
        const owner = crewList[ownerIndex], drops = owner.stunGear.drops, target = owner.root.position;
        let waiting = false;
        for (let dropIndex = 0; dropIndex < drops.length; dropIndex++) {
          const drop = drops[dropIndex];
          if (!drop.active) continue;
          waiting = true;
          if (owner.health.recovering) {
            if (!drop.returning) {
              drop.returning = true; drop.returnTime = 0;
              drop.sx = drop.node.position.x; drop.sy = drop.node.position.y; drop.sz = drop.node.position.z;
            }
            drop.returnTime = Math.min(HEALTH_PICKUP_TIME, drop.returnTime + dt);
            const k = ease.inOutQuad(drop.returnTime / HEALTH_PICKUP_TIME);
            setVec(drop.node.position, lerp(drop.sx, target.x, k), lerp(drop.sy, target.y + owner.bodyHeight * 0.46, k), lerp(drop.sz, target.z, k));
            drop.node.rotation.y += dt * 8;
            if (drop.returnTime >= HEALTH_PICKUP_TIME) {
              const collected = collectStunDrop(drop, owner);
              if (drop.active && (drop.kind === "magazine" || drop.kind === "ammo")) placeStunDrop(owner, drop);
              else if (!collected) { drop.active = drop.returning = false; drop.node.visible = false; }
              waiting = false;
              for (let i = dropIndex + 1; i < drops.length; i++) if (drops[i].active) { waiting = true; break; }
            }
            continue;
          }
          const p = drop.node.position;
          for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
            const cave = crewList[caveIndex], q = cave.root.position;
            if ((cave === owner && owner.health.stunned) || !cave.root.visible || cave.health.stunned) continue;
            if (Math.hypot(q.x - p.x, q.z - p.z) <= GEAR_PICKUP_RADIUS + cave.bodyRadius && Math.abs(q.y - p.y) <= cave.bodyHeight
              && collectStunDrop(drop, cave)) break;
          }
        }
        if (owner.health.recovering && !waiting) finishStun(owner);
      }
    };
    const updateHealth = (cave, dt) => {
      const health = cave.health, birds = cave.stunBirds;
      if (health.stunned && cave.grabbedBy && ctx.releaseGrabbed) ctx.releaseGrabbed(cave);
      if (health.value < HEALTH_MAX) {
        if (health.stunned) health.value = Math.min(HEALTH_MAX, health.value + HEALTH_REGEN_RATE * dt);
        else if (health.delay > 0) health.delay = Math.max(0, health.delay - dt);
        else health.value = Math.min(HEALTH_MAX, health.value + HEALTH_REGEN_RATE * dt);
        if (health.value >= HEALTH_MAX && health.stunned) health.recovering = true;
      }
      birds.visible = cave.root.visible && health.stunned;
      if (!health.stunned) return false;
      birds.rotation.y += dt * 5.5;
      for (let i = 0; i < birds.children.length; i++) birds.children[i].position.y = Math.sin(elapsed * 7 + i * 2.1) * 0.045 * cave.traits.height;
      cave.walk = null;
      cave.traffic.moving = cave.traffic.waiting = false;
      cave.leap.vx = cave.leap.vz = cave.hopV = 0;
      if (cave.jet) {
        cave.jet.thrust = cave.jet.spending = false;
        cave.jet.power = 0;
        cave.jet.flame.visible = false;
      }
      clearHeadLook(cave);
      standPose(cave);
      cave.parts.armR.quaternion = cave.parts.armL.quaternion = null;
      setVec(cave.parts.armR.rotation, 0.05, 0, -0.04);
      setVec(cave.parts.armL.rotation, 0.05, 0, 0.04);
      setVec(cave.parts.head.rotation, Math.sin(elapsed * 3.1) * 0.08, Math.sin(elapsed * 4.8) * 0.72, Math.sin(elapsed * 2.4) * 0.1);
      cave.parts.club.visible = cave.parts.gun.visible = cave.parts.gunFlash.visible = cave.parts.snack.visible = false;
      if (cave.parts.chukTrail) for (const trail of cave.parts.chukTrail) trail.visible = false;
      cave.weapon.carry = "hidden";
      poseHands(cave);
      return true;
    };
    const damage = (cave, power = 1, showDamage = false) => {
      if (!cave || !cave.root.visible || cave.health.stunned || power <= 0) return false;
      const health = cave.health;
      const p = cave.root.position;
      const dealt = power * 4;
      health.value = Math.max(0, health.value - dealt);
      if (showDamage) fx.damageNumber(p.x, p.y - cave.baseY + cave.bodyHeight + 0.15, p.z, dealt);
      health.delay = HEALTH_REGEN_DELAY;
      if (health.value <= 0) {
        health.stunned = true;
        health.recovering = false;
        health.delay = 0;
        cave.walk = null;
        cave.leap.vx = cave.leap.vz = cave.hopV = 0;
        cave.rocketJumpTime = 0;
        if (cave.traits.footRockets && !cave.jet) cave.parts.jetpack.visible = cave.parts.jetFlame.visible = false;
        stopBurst(cave);
        stopReload(cave, true);
        releaseSwing(cave, true);
        // A released strike is no longer held, but its pose and contact timer
        // must stop before the stunned update takes over until recovery.
        const w = cave.weapon;
        clearGunBashThrust(cave);
        clearMeleeThrust(cave);
        w.meleeTime = w.meleeReadyTime = w.meleeComboTime = 0;
        w.bashTime = 0;
        w.meleeTarget.node = w.meleeTarget.owner = null;
        w.meleeAimX = w.meleeAimY = w.meleeAimZ = 0;
        w.meleeQuick = false;
        dropStunGear(cave);
      }
      return true;
    };
    // ---------- the jetpack ----------
    const makeJetpack = (cave, geometry, flameGeometry) => {
      const h = cave.traits.height;
      const node = createNode({ position: { x: 0, y: 0.06 * h + cave.viewLift, z: -0.18 * h }, scale: { x: h, y: h, z: h }, geometry });
      const flame = createNode({ geometry: flameGeometry, visible: false });
      addChild(node, flame);
      addChild(cave.root, node);
      cave.jet = { node, flame, thrust: false, spending: false, power: 0, puff: 0 };
      return node;
    };
    const builtInJetpack = (cave) => !!cave.parts.jetpack;
    // Put the jetpack on a caveman's back
    const wearJetpack = (cave, geometry, flameGeometry) => {
      if (cave.jet || ctx.jetpackAllowed && !ctx.jetpackAllowed(cave)) return null;
      if (builtInJetpack(cave)) {
        cave.rocketJumpTime = 0;
        cave.parts.jetpack.visible = true;
        cave.jet = { node: cave.parts.jetpack, flame: cave.parts.jetFlame, thrust: false, spending: false, power: 0, puff: 0 };
        if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
        return cave.parts.jetpack;
      }
      const node = makeJetpack(cave, geometry, flameGeometry);
      if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
      if (cave.jetFuel < JET_LAUNCH_FUEL && grounded(cave)) cave.jetRecovering = true;
      return node;
    };
    const cutJet = (cave) => {
      const jet = cave.jet;
      jet.thrust = jet.spending = false;
      jet.power = jet.puff = 0;
      jet.flame.visible = false;
    };
    const removeJetpack = (cave) => {
      if (!cave.jet) return false;
      if (builtInJetpack(cave)) {
        cutJet(cave);
        cave.parts.jetpack.visible = false;
        cave.jet = null;
        if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
        return true;
      }
      if (cave.jet.node.parent) removeChild(cave.jet.node.parent, cave.jet.node);
      cave.jet = null;
      if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
      return true;
    };
    const setJetpackOwnership = (cave, owned, geometry = null, flameGeometry = null) => {
      if (!cave) return false;
      cave.jetpackOwned = !!owned;
      if (geometry) cave.jetpackGeometry = geometry;
      if (flameGeometry) cave.jetpackFlameGeometry = flameGeometry;
      if (!owned) removeJetpack(cave);
      else if (cave.state === "sleeping" && cave.bedroll && cave.sleepWeapons.visible) putBedWeapons(cave);
      return true;
    };
    const thrust = (on) => {
      if (player && player.jet) player.jet.thrust = !!on && !player.grabbedBy && !player.health.stunned && !player.jetRecovering && player.jetFuel > 0;
    };
    const holdRocketJump = (on) => {
      if (player && player.traits.footRockets && !player.jet) player.rocketJumpHeld = !!on && !player.grabbedBy;
    };

    const sleepPlayer = (bed) => {
      const cave = player;
      if (!cave || cave.grabbedBy || cave.camp.burning || cave.camp.seat || cave.state === "sleeping" || !bed || bed.sleeper && bed.sleeper !== cave) return false;
      // Step smoothing may still be settling when SLEEP appears; admission uses planted feet, before clearing it.
      if (!grounded(cave)) return false;
      elevatePlayer(0);
      releaseBuild(cave);
      removeJetpack(cave);
      cave.walk = null;
      cave.hop = cave.hopV = cave.cheer = cave.catchT = 0;
      cave.override = cave.state = "sleeping";
      cave.bedroll = bed;
      bed.sleeper = cave;
      cave.bedTravel.manual = true;
      cave.bedTravel.bed = bed;
      cave.act.kind = "bed";
      lieDown(cave);
      refreshRosterRow(cave);
      return true;
    };
    const wakePlayer = () => {
      const cave = player;
      if (!cave || !cave.bedTravel.manual || cave.state !== "sleeping") return false;
      const bed = cave.bedroll;
      standFromBed(cave);
      releaseBedroll(cave);
      cave.override = cave.state = (cave.controlOverride || contributors.stateFor(cave.contributor)) === "working" ? "working" : "chilling";
      cave.bedTravel.bed = null;
      cave.parts.head.geometry = cave.headOpen;
      cave.root.position.y = groundY(cave);
      cave.root.rotation.y = bed.node ? bed.node.rotation.y : bed.ry || 0;
      cave.act.kind = "player";
      cave.act.phase = 0;
      refreshRosterRow(cave);
      return true;
    };
    const control = (cave) => {
      if (cave.grabbedBy && ctx.releaseGrabbed) ctx.releaseGrabbed(cave);
      if (cave === player || cave.state !== "working" && cave.state !== "chilling" && cave.state !== "sleeping") return false;
      release();
      if (legacyMagazine.owned && !legacyMagazine.carrier) {
        claimLegacyMagazines(cave.weapon);
        for (let i = 0; i < cave.weapon.spareAmmo.length; i++) if (!cave.magazineModels[i]) cave.magazineModels[i] = createMagazineModel();
      }
      cave.humanControlled = true;
      cave.weapon.aiming = false;
      refreshRosterRow(cave);
      cave.controlOverride = cave.override;
      cave.work.direct = false;
      stopBurst(cave);
      stopReload(cave);
      clearShoulder(cave);
      if (cave.state === "sleeping" && (!ctx.bedRoute || cave.bedTravel.mode === "rest" || cave.bedTravel.mode === "lie")) {
        player = cave;
        syncMagazine();
        cave.bedTravel.manual = true;
        if (!ctx.bedRoute) {
          math.quat.fromEuler(cave.sleepRotation, cave.root.rotation.x, cave.root.rotation.y, cave.root.rotation.z);
          cave.root.quaternion = cave.sleepRotation;
          cave.bedTravel.mode = "rest";
          cave.bedTravel.roll = 1;
          updateSleepHead(cave);
        }
        return true;
      }
      if (cave.state === "sleeping") {
        if (ctx.bedRoute) standFromBed(cave);
        else { resetPose(cave); cave.root.position.y = cave.baseY + groundAt(cave.root.position.x, cave.root.position.z, Infinity, Infinity, cave); }
        releaseBedroll(cave);
        cave.override = cave.state = (cave.controlOverride || contributors.stateFor(cave.contributor)) === "working" ? "working" : "chilling";
        cave.parts.head.geometry = cave.headOpen;
        assignFanSlots([...cavemen.values()], (entry) => entry.state === "working");
        refreshRosterRow(cave);
      }
      player = cave;
      syncMagazine();
      cave.camp.panic.active = false;
      cave.camp.panic.threat = cave.camp.panic.resumeWalk = null;
      cave.camp.panic.remembered = false;
      cave.camp.panic.memory.fill(0);
      cave.camp.panic.gorillaMemory.fill(0);
      cave.camp.panic.resumeSleep = false;
      releaseBuild(cave);
      cave.avoidance.navigation.mode = 0; cave.avoidance.tx = NaN;
      cave.walk = null;
      cave.bedTravel.mode = "";
      cave.bedTravel.route = null;
      cave.act.kind = "player";
      cave.act.phase = 0;
      cave.parts.gun.visible = false;
      cave.parts.snack.visible = false;
      cave.parts.head.rotation.x = 0;
      cave.parts.head.rotation.y = 0;
      standPose(cave);
      if (!ctx.abyssAt || !ctx.abyssAt(cave.root.position.x, cave.root.position.z, cave.root.position.y - cave.baseY, cave)) cave.root.position.y = groundY(cave) + cave.hop;
      if (cave.jet && cave.jetFuel < JET_LAUNCH_FUEL && grounded(cave)) cave.jetRecovering = true;
      if (cave.traits.stoneAxe) poseWeapon(cave);
      return true;
    };
    const release = () => {
      if (player?.grabbedBy && ctx.releaseGrabbed) ctx.releaseGrabbed(player);
      if (player) clearHeadLook(player);
      if (!player) return;
      const cave = player;
      clearGunBashThrust(cave);
      cave.humanControlled = false;
      cave.rocketJumpHeld = false;
      cave.weapon.aiming = false;
      refreshRosterRow(cave);
      stopBurst(cave);
      stopReload(cave);
      cave.work.phase = "";
      cave.work.plannedSite = -1; cave.work.targetReady = cave.work.aimReady = false;
      cave.weapon.primaryEquipped = false;
      cave.weapon.meleeTime = cave.weapon.meleeComboTime = 0;
      cave.weapon.bashTime = 0;
      cave.weapon.meleeHeld = false;
      cave.weapon.meleeQuick = false;
      cave.weapon.meleeReadyTime = 0;
      cave.weapon.meleeTarget.node = cave.weapon.meleeTarget.owner = null;
      cave.weapon.meleeHeldTime = cave.weapon.meleeCharge = 0;
      cave.weapon.meleeStrikeTime = MELEE_STRIKE;
      cave.work.direct = false;
      clearShoulder(cave);
      if (cave.camp.seat && !standPlayer(cave)) {
        cave.camp.seat.sitter = null;
        cave.camp.seat = null;
      }
      if (cave.bedTravel.manual && cave.state === "sleeping") {
        cave.bedTravel.manual = false;
        player = null;
        syncMagazine();
        steer.x = steer.z = steer.view = steer.forward = steer.strafe = steer.peek = 0;
        cave.peek = 0;
        posePeek(cave, 0);
        cave.override = cave.controlOverride;
        applyState(cave, stateOf(cave));
        return;
      }
      elevatePlayer(0);
      player = null;
      syncMagazine();
      steer.x = steer.z = steer.view = steer.forward = steer.strafe = steer.peek = 0;
      cave.peek = 0;
      posePeek(cave, 0);
      cave.leap.vx = cave.leap.vz = cave.leap.land = 0;
      if (cave.jet) {
        cave.jet.thrust = false;
        cave.jet.spending = false;
        cave.jet.power = 0;
        cave.jet.flame.visible = false;
      }
      if (!cave.camp.rolling) {
        standPose(cave);
        if (!ctx.abyssAt || !ctx.abyssAt(cave.root.position.x, cave.root.position.z, cave.root.position.y - cave.baseY, cave)) cave.root.position.y = groundY(cave) + cave.hop;
      }
      cave.act.kind = "idle";
      cave.act.until = elapsed + (cave.state === "chilling" ? chillPause(cave) : 1.5);
      cave.act.said = true;
      cave.act.trips = 0;
      if (!cave.camp.burning && ctx.bedRoute && cave.root.position.y - cave.baseY < -0.5 && underHome(cave.root.position.x, cave.root.position.z) && (!ctx.abyssAt || !ctx.abyssAt(cave.root.position.x, cave.root.position.z, cave.root.position.y - cave.baseY, cave))) startBedRoute(cave, null, false);
      cave.override = cave.controlOverride;
      if (ctx.playerName) return;
      applyState(cave, stateOf(cave));
      if (workSites && cave.state === "working" && !cave.camp.burning && !cave.camp.rolling) {
        // Resume useful work from the visitor's actual location. Only this
        // leg ignores the painted trails; swept walking still avoids solids.
        cave.walk = null;
        cave.avoidance.active = false; cave.avoidance.tx = NaN; cave.avoidance.navigation.mode = 0;
        cave.avoidance.detour.site = -1;
        cave.traffic.moving = cave.traffic.waiting = false;
        cave.traffic.leader = cave.traffic.crossing = null;
        if (cave.pathing) { cave.pathing.tx = NaN; cave.pathing.index = cave.pathing.count; }
        if (totalAmmo(cave) > 0) {
          if (selectWorkSite(cave, true)) { cave.work.phase = "station"; cave.work.direct = true; }
        } else {
          const slot = closestSlot(cave, true) || closestSlot(cave);
          if (slot) cave.slot = slot;
          cave.work.phase = "return"; cave.work.index = -1; cave.work.direct = true;
          cave.work.reloadSlot = !!slot; cave.pileApproach = false;
          cave.act.kind = "reload-return";
          planWorkSite(cave);
        }
      }
    };
    const steerPlayer = (x, z, view = 0, forward = 0, strafe = 0, speed = 1, peek = 0) => {
      if (player?.grabbedBy) x = z = forward = strafe = peek = 0;
      steer.x = x;
      steer.z = z;
      steer.view = clamp(view, 0, 1);
      steer.forward = forward;
      steer.strafe = strafe;
      steer.speed = speed;
      steer.peek = clamp(peek, -1, 1);
    };
    // Keeps possession and equipment while discarding motion at a safe arrival.
    const relocatePlayer = (position, heading) => {
      const cave = player;
      if (!cave) return;
      if (cave.grabbedBy && ctx.releaseGrabbed) ctx.releaseGrabbed(cave);
      if (cave.ladder) { cave.ladder.plane = null; cave.ladder.mix = 0; cave.ladder.cooldown = 0; }
      stopReload(cave);
      clearShoulder(cave);
      if (cave.camp.seat) { cave.camp.seat.sitter = null; cave.camp.seat = null; }
      if (cave.camp.rolling) { cave.camp.rolling = false; cave.root.quaternion = null; }
      if (cave.bedTravel.manual) wakePlayer();
      elevatePlayer(0);
      steer.x = steer.z = steer.view = steer.forward = steer.strafe = steer.peek = 0;
      cave.peek = 0;
      posePeek(cave, 0);
      cave.hop = cave.hopV = cave.act.phase = 0;
      cave.rocketJumpTime = cave.rocketPuff = 0;
      cave.rocketJumpHeld = false;
      if (cave.traits.footRockets && !cave.jet) cave.parts.jetpack.visible = cave.parts.jetFlame.visible = false;
      cave.cloudSupport = null;
      cave.jumps = 0;
      cave.leap.vx = cave.leap.vz = cave.leap.land = 0;
      cave.leap.thrown = cave.leap.rageThrown = false;
      cave.cheer = cave.catchT = cave.yawn = 0;
      if (cave.jet) {
        cave.jet.thrust = false;
        cave.jet.spending = false;
        cave.jet.power = 0;
        cave.jet.flame.visible = false;
        cave.jet.puff = 0;
      }
      standPose(cave);
      cave.parts.torso.scale.y = 1;
      cave.parts.head.rotation.x = cave.parts.head.rotation.y = 0;
      cave.root.rotation.x = cave.root.rotation.z = 0;
      cave.root.rotation.y = heading;
      setVec(cave.root.position, position.x, position.y + cave.baseY, position.z);
      if (cave.jet && cave.jetFuel < JET_LAUNCH_FUEL && grounded(cave)) cave.jetRecovering = true;
    };
    // Call after the camera's damped angles update, keeping pose and view in lockstep.
    const lookPlayer = (heading, pitch, mix, viewRotation = null) => {
      if (!player || player.grabbedBy) return;
      clearHeadLook(player);
      if (player.camp.rolling) return;
      if (mix <= 0) return;
      const root = player.root, head = player.parts.head;
      if (player.camp.seat && !player.camp.seat.allowWeapons) {
        head.rotation.y = clamp(Math.atan2(Math.sin(heading - root.rotation.y), Math.cos(heading - root.rotation.y)), -1.2, 1.2) * mix;
        head.rotation.x = pitch * mix;
        return;
      }
      if (player.bedTravel.manual) {
        if (!viewRotation || !root.quaternion) return;
        const q = root.quaternion, look = player.headLookRotation;
        // The camera looks along -Z while the model's face looks along +Z.
        LOOK_ROTATION[0] = -viewRotation[2]; LOOK_ROTATION[1] = viewRotation[3]; LOOK_ROTATION[2] = viewRotation[0]; LOOK_ROTATION[3] = -viewRotation[1];
        SLEEP_INVERSE[0] = -q[0]; SLEEP_INVERSE[1] = -q[1]; SLEEP_INVERSE[2] = -q[2]; SLEEP_INVERSE[3] = q[3];
        math.quat.multiply(LOOK_ROTATION, SLEEP_INVERSE, LOOK_ROTATION);
        math.quat.fromEuler(look, 0, 0, 0);
        math.quat.slerpTo(look, LOOK_ROTATION, mix);
        setVec(player.headLookPosition, head.position.x, head.position.y, head.position.z);
        // Rotate about the face centre so the eye anchor and authored pillow contact survive close-view exit.
        const center = player.traits.height * 3.5 / 16;
        math.quat.rotateVec(MUZZLE, look, 0, center, 0);
        head.position.x -= MUZZLE[0]; head.position.y += center - MUZZLE[1]; head.position.z -= MUZZLE[2];
        head.quaternion = look;
        return;
      }
      root.rotation.y += Math.atan2(Math.sin(heading - root.rotation.y), Math.cos(heading - root.rotation.y)) * mix;
      head.rotation.x += (pitch - head.rotation.x) * mix;
      head.rotation.y = 0;
    };
    // Shift the visible body while its root stays on the exact collision surface.
    // Scaling each leg about its hip keeps the feet on that same voxel step.
    const elevatePlayer = (lift) => {
      if (!player || player.grabbedBy || player.bedTravel.manual || player.camp.seat || player.camp.rolling) return;
      const cave = player, parts = cave.parts;
      // Step smoothing moves the rendered head after physics; clamp the lift to the same full-footprint ceiling.
      if (lift > 0 && ctx.ceilingAt) {
        const p = cave.root.position, feet = p.y - cave.baseY;
        lift = Math.min(lift, Math.max(0, ctx.ceilingAt(p.x, p.z, feet, cave) - feet - cave.bodyHeight));
      }
      const delta = lift - cave.viewLift;
      if (!delta) return;
      parts.legR.position.y += delta;
      parts.legL.position.y += delta;
      parts.torso.position.y += delta;
      parts.armR.position.y += delta;
      parts.armL.position.y += delta;
      parts.head.position.y += delta;
      if (parts.lion) parts.lion.position.y += delta;
      if (cave.jet) cave.jet.node.position.y += delta;
      cave.viewLift = lift;
      parts.legR.scale.y = parts.legL.scale.y = (cave.baseY + lift) / cave.baseY;
    };
    const jumpPlayer = () => {
      if (!player || player.grabbedBy || player.health.stunned || player.bedTravel.manual || player.camp.seat || player.camp.rolling || player.jet && !player.jetRecovering) return false;
      if (player.ladder && player.ladder.plane) {
        const plane = player.ladder.plane;
        leaveLadder(player);
        player.hopV = JUMP_SPEED; player.jumps = 1;
        player.leap.vx = plane.nx * WALK.ledgeSpeed; player.leap.vz = plane.nz * WALK.ledgeSpeed;
        return true;
      }
      if (player.traits.footRockets && !player.jet) {
        if (!grounded(player)) return false;
        elevatePlayer(0);
        player.jumps = 1;
        player.hopV = JUMP_SPEED;
        player.rocketJumpTime = ROCKET_JUMP_TIME;
        player.rocketJumpHeld = true;
        player.rocketPuff = 0;
        return true;
      }
      if (grounded(player)) player.jumps = 0;
      else player.jumps = Math.max(1, player.jumps);
      if (player.jumps >= 2 && !inBananas(player)) return false;
      // Takeoff clears step smoothing (elevatePlayer(0)) before testing headroom.
      elevatePlayer(0);
      player.jumps++;
      player.hopV = JUMP_SPEED;
      return true;
    };
    // The pack's weight halves a tap jump; holding continues thrust.
    // A nearby action consumes the press, and airborne presses add no impulse.
    const playerAction = () => {
      if (!player || player.grabbedBy || player.health.stunned) return false;
      if (player.camp.burning) return dropRoll();
      if (player.camp.seat) return standPlayer();
      if (player.bedTravel.manual) return wakePlayer();
      if (!player.weapon.reloading && !player.weapon.swapTime && !player.weapon.reloadHandoff && player.weapon.equipped && reloadMissing(player) > 0 && nearReload(player)) {
        if (!startReload(player)) hud.hint("No bananas in the pile");
        return true;
      }
      const p = player.root.position, feet = p.y - player.baseY;
      if (!player.weapon.reloading && !player.weapon.swapTime && !player.weapon.reloadHandoff && ctx.useNear && ctx.useNear(p.x, p.z, REACH + 0.6, feet)) return true;
      if (player.jet && !player.jetRecovering) {
        if (player.jetFuel > 0 && grounded(player)) {
          elevatePlayer(0);
          player.jumps = 1;
          player.hopV = JUMP_SPEED * Math.SQRT1_2;
        }
        return false;
      }
      const jumped = jumpPlayer();
      // Let the held Space reach the rocket jump after the initial press.
      return !(jumped && player.traits.footRockets && !player.jet);
    };
    const applySwag = (cave) => {
      for (const anchorKey of SWAG_ANCHORS) {
        const anchor = cave.parts[anchorKey];
        for (const child of anchor.children.slice()) removeChild(anchor, child);
        anchor.visible = false;
      }
      cave.swagNodes.length = 0;
      cave.parts.club.geometry = cave.skins.club.default;
      if (cave.parts.chuk) cave.parts.chuk.geometry = cave.parts.chuk.skins.default;
      cave.parts.gunBody.geometry = cave.skins.gun.default;
      const entryId = game.state.assignments[cave.traits.name];
      const item = entryId ? game.itemOf(entryId) : null;
      if (!item) return;
      if (item.skin) {
        const target = item.skin === "club" ? cave.parts.club : cave.parts.gunBody;
        target.geometry = cave.skins[item.skin].gold;
        // A weapon that carries a second stick takes the same skin.
        if (item.skin === "club" && cave.parts.chuk) cave.parts.chuk.geometry = cave.parts.chuk.skins.gold;
        return;
      }
      const anchor = item.slot === "face" ? cave.parts.face : cave.parts.hat;
      const node = item.buildNode();
      if (item.offset) Object.assign(node.position, item.offset);
      if (item.rotation) Object.assign(node.rotation, item.rotation);
      node.swag = item;
      addChild(anchor, node);
      anchor.visible = true;
      cave.swagNodes.push(node);
    };
    const applyAllSwag = () => {
      for (let i = 0; i < crewList.length; i++) {
        const cave = crewList[i];
        applySwag(cave);
        if (ctx.refreshMirrorObject) ctx.refreshMirrorObject(cave.root);
      }
      if (ctx.onModelChange) ctx.onModelChange();
    };
    const wornBy = (name) => {
      const item = game.itemOf(game.state.assignments[name] || "");
      return item ? item.name : null;
    };
    const renderLocker = () => hud.renderInventory(game.state.inventory, game.assignedTo, wornBy);
    // The first tap of a double-tap takes an Ooga, so the prompt waits out that
    // window: a modal opening under the second tap would swallow it.
    const openRecipeSoon = (cave) => {
      window.clearTimeout(recipeTimer);
      recipeTimer = window.setTimeout(() => {
        recipeTimer = 0;
        if (player !== cave) hud.openRecipe();
      }, BL.interact.DOUBLE_MS + 40);
    };
    const pokeCave = (cave) => {
      // One Ooga answers a poke with the prompt for building another one. It is
      // a machine: it answers asleep as well as awake.
      if (cave.traits.recipe) openRecipeSoon(cave);
      if (cave.state === "sleeping") {
        ctx.fx.say(cave, SLEEP_POKES[randomInt(SLEEP_POKES.length)], 1.8);
        const travel = cave.bedTravel;
        if (travel.mode === "rest" && travel.roll === 1 && cave.bedroll.sleep && randomInt(3) === 0) turnSleep(cave, SLEEP_POSES[(SLEEP_POSES.indexOf(travel.pose) + 1 + randomInt(3)) % SLEEP_POSES.length]);
        return;
      }
      const voice = contributors.voiceFor(cave.traits.name);
      ctx.fx.say(cave, voice ? voice.poke : POKES[randomInt(POKES.length)], 1.8);
    };
    // Build quotes; drawn by fx.drawOverlay.
    const drawQuotes = (ctx2d, project, drawBubble) => {
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const cave = crewList[caveIndex];
        const b = cave.build;
        if (!b || b.phase === "return") continue;
        const pos = project(cave.root.position.x, cave.root.position.y - cave.baseY + cave.headOffset + cave.viewLift + 0.45, cave.root.position.z);
        drawBubble(ctx2d, b.quote, pos ? pos.x : 0, pos ? pos.y : 0, Math.min(1, (b.age || 0) / 0.25), cave);
      }
      ctx2d.save();
      ctx2d.font = "bold 13px ui-monospace, monospace";
      ctx2d.textAlign = "center";
      ctx2d.textBaseline = "bottom";
      // A stroked outline reads like the old shadow and costs nothing; a blur on the overlay does not.
      ctx2d.fillStyle = "#ffe291";
      ctx2d.strokeStyle = "#17130b";
      ctx2d.lineWidth = 3;
      ctx2d.lineJoin = "round";
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const drops = crewList[caveIndex].stunGear.drops;
        for (let dropIndex = 0; dropIndex < drops.length; dropIndex++) {
          const drop = drops[dropIndex];
          if (!drop.active || drop.kind !== "ammo" && drop.kind !== "magazine") continue;
          const p = drop.node.position, pos = project(p.x, p.y + 0.4, p.z);
          if (pos) { ctx2d.strokeText(drop.label, pos.x, pos.y + 1); ctx2d.fillText(drop.label, pos.x, pos.y); }
        }
      }
      ctx2d.restore();
    };
    const wrapMaskSmoke = (cave, puff) => {
      const node = puff.node, p = node.position, bounds = cave.gunHeadBounds, m = cave.parts.head.world;
      math.mat4.transformPoint(SMOKE_LOCAL, SMOKE_INVERSE, p.x, p.y, p.z);
      const radius = 0.09 * node.scale.x * Math.sqrt(3), x = SMOKE_LOCAL[0], y = SMOKE_LOCAL[1], z = SMOKE_LOCAL[2];
      const minX = bounds.min[0] - radius, maxX = bounds.max[0] + radius;
      const minY = bounds.min[1] - radius, maxY = bounds.max[1] + radius;
      const minZ = bounds.min[2] - radius, maxZ = bounds.max[2] + radius;
      if (y < minY || y > maxY || z < minZ - 0.15 || z > maxZ + 0.2 || x < minX - 0.15 || x > maxX + 0.15) return;
      // Turn approaching wisps toward either temple before the face catches
      // them. Keep the same side for a puff as it curls past the head.
      const side = puff.wrapSide;
      let nx = x;
      if (nx > minX && nx < maxX && z > minZ && z < maxZ) nx = side < 0 ? minX - 0.001 : maxX + 0.001;
      if (nx === x) return;
      math.mat4.transformPoint(MUZZLE, m, nx, y, z);
      setVec(p, MUZZLE[0], MUZZLE[1], MUZZLE[2]);
      const along = puff.vx * m[0] + puff.vy * m[1] + puff.vz * m[2];
      if (along * side < 0.2) {
        const push = side * 0.2 - along;
        puff.vx += m[0] * push; puff.vy += m[1] * push; puff.vz += m[2] * push;
      }
    };
    const runMaskBreath = (cave, dt) => {
      if (!cave.traits.gasMask) return;
      // Refresh the head after movement and animation, even offscreen.
      BL.scene.updateWorld(cave.root);
      math.mat4.invert(SMOKE_INVERSE, cave.parts.head.world);
      const motion = cave.shoulder, walkingSpeed = Math.hypot(motion.motionX, motion.motionZ);
      const walking = walkingSpeed > 0.25 && cave.hop === 0;
      const forwardX = walking ? motion.motionX / walkingSpeed : 0;
      const forwardZ = walking ? motion.motionZ / walkingSpeed : 0;
      const head = cave.parts.head.world;
      math.mat4.transformPoint(MUZZLE, head, 0, 0.27 * cave.traits.height, 0);
      const headX = MUZZLE[0], headY = MUZZLE[1], headZ = MUZZLE[2];
      for (let i = 0; i < cave.breathSmoke.length; i++) {
        const puff = cave.breathSmoke[i];
        if (puff.life <= 0) continue;
        puff.life = Math.max(0, puff.life - dt);
        const node = puff.node;
        const time = puff.maxLife - puff.life;
        // Keep the initial exhale, then let both sizes settle into a slow upward drift.
        const exhaling = time < 0.25;
        const drag = Math.exp(-(exhaling ? 1.3 : 3.2) * dt);
        puff.vx *= drag; puff.vz *= drag;
        puff.vy = damp(puff.vy, exhaling ? 0.15 : MASK_SMOKE_RISE, exhaling ? 0.9 : 3.2, dt);
        if (walking && puff.cubes === 1 && time > 0.12 && time < 2.2) {
          const p = node.position;
          const dx = p.x - headX, dz = p.z - headZ;
          const along = dx * forwardX + dz * forwardZ;
          if (along > -2.5 && along < 1.5) {
            // The walking direction shapes the wake without passing the Ooga's
            // velocity to smoke. Wisps fan around the head, then meet behind it.
            const across = -dx * forwardZ + dz * forwardX;
            const wake = clamp((0.1 - along) / 0.7, 0, 1);
            const spread = lerp(0.42, 0.03, wake);
            const side = clamp((Math.cos(puff.phase) * spread - across) * 3, -0.9, 0.9);
            const rise = clamp((Math.sin(puff.phase) * spread * 0.7 - (p.y - headY)) * 2, -0.5, 0.5);
            puff.vx = damp(puff.vx, -forwardX * 0.22 - forwardZ * side, 4, dt);
            puff.vy = damp(puff.vy, MASK_SMOKE_RISE + rise, 4, dt);
            puff.vz = damp(puff.vz, -forwardZ * 0.22 + forwardX * side, 4, dt);
          }
        }
        node.position.x += (puff.vx + Math.sin(time * 3 + puff.phase) * 0.025) * dt;
        node.position.y += puff.vy * dt;
        node.position.z += (puff.vz + Math.cos(time * 2.5 + puff.phase) * 0.025) * dt;
        node.rotation.y += 1.2 * dt;
        // Individual puffs keep expanding even when the walking wake converges.
        const age = 1 - puff.life / puff.maxLife;
        const s = Math.min(MASK_SMOKE_MAX, puff.size * (1 + age * 1.8));
        node.scale.x = node.scale.y = node.scale.z = s;
        node.smokeOpacity = 0.85 * Math.min(1, puff.life / (puff.maxLife * 0.65));
        wrapMaskSmoke(cave, puff);
      }
      cave.breathMerge -= dt;
      if (cave.breathMerge <= 0) {
        cave.breathMerge = 0.14;
        // Wisps coalesce before the resulting clusters exert pressure.
        const smoke = cave.breathSmoke;
        for (let i = 0; i < smoke.length; i++) {
          const a = smoke[i];
          if (a.life <= 0) continue;
          for (let j = i + 1; j < smoke.length; j++) {
            const b = smoke[j];
            if (b.life <= 0) continue;
            const ap = a.node.position, bp = b.node.position;
            const dx = bp.x - ap.x, dy = bp.y - ap.y, dz = bp.z - ap.z;
            const distance2 = dx * dx + dy * dy + dz * dz;
            const scales = a.node.scale.x + b.node.scale.x;
            const reach = 0.09 * scales * 1.35;
            if (distance2 > reach * reach) continue;
            const av = a.node.scale.x ** 3, bv = b.node.scale.x ** 3;
            if (a.maxLife - a.life >= 0.2 && b.maxLife - b.life >= 0.2 && a.cubes + b.cubes <= MASK_SMOKE_MERGE_MAX) {
              const size = Math.cbrt(av + bv);
              if (size <= MASK_SMOKE_MAX) {
                const weight = bv / (av + bv);
                ap.x += dx * weight; ap.y += dy * weight; ap.z += dz * weight;
                a.vx = lerp(a.vx, b.vx, weight); a.vy = lerp(a.vy, b.vy, weight); a.vz = lerp(a.vz, b.vz, weight);
                a.serial = lerp(a.serial, b.serial, weight);
                a.life = Math.max(a.life, b.life); a.maxLife = Math.max(a.maxLife, b.maxLife);
                a.cubes += b.cubes;
                a.size = size / (1 + (1 - a.life / a.maxLife) * 1.8);
                setVec(a.node.scale, size, size, size);
                a.node.smokeOpacity = Math.max(a.node.smokeOpacity, b.node.smokeOpacity);
                if (a.anchor === j) a.anchor = -1;
                if (a.anchor < 0 && b.anchor >= 0 && b.anchor !== i) {
                  a.anchor = b.anchor; a.anchorBorn = b.anchorBorn;
                }
                if (b.cubes > 1) for (let k = 0; k < smoke.length; k++) {
                  const child = smoke[k];
                  if (child.anchor === j && child.anchorBorn === b.born) {
                    child.anchor = k === i ? -1 : i; child.anchorBorn = a.born;
                  }
                }
                b.life = 0; b.node.smokeOpacity = 0;
                continue;
              }
            }
          }
        }
      }
      // Only formed clusters repel. Compact their indices into reusable scratch
      // so filter wisps can gather without taking part in the pressure pass.
      const smoke = cave.breathSmoke, clusters = cave.breathClusters;
      let clusterCount = 0;
      for (let i = 0; i < smoke.length; i++) if (smoke[i].life > 0 && smoke[i].cubes > 1) clusters[clusterCount++] = i;
      const pressure = 1 - Math.exp(-4 * dt);
      for (let i = 0; i < clusterCount; i++) {
        const a = smoke[clusters[i]], ap = a.node.position;
        for (let j = i + 1; j < clusterCount; j++) {
          const b = smoke[clusters[j]], bp = b.node.position;
          let dx = bp.x - ap.x, dy = bp.y - ap.y, dz = bp.z - ap.z;
          let distance2 = dx * dx + dy * dy + dz * dz;
          const spacing = MASK_SMOKE_SEPARATION * (a.node.scale.x + b.node.scale.x);
          if (distance2 >= spacing * spacing) continue;
          if (distance2 < 1e-10) {
            dx = Math.cos(a.phase) * 0.001; dy = 0; dz = Math.sin(a.phase) * 0.001;
            distance2 = dx * dx + dz * dz;
          }
          const push = (spacing / Math.sqrt(distance2) - 1) * pressure;
          // Emission order survives merging and pool reuse; incoming clusters
          // displace older smoke more than they displace themselves.
          const aShare = a.serial < b.serial ? 0.85 : a.serial > b.serial ? 0.15 : 0.5;
          const bShare = 1 - aShare;
          if (a.serial <= b.serial) { a.anchor = clusters[j]; a.anchorBorn = b.born; }
          else { b.anchor = clusters[i]; b.anchorBorn = a.born; }
          ap.x -= dx * push * aShare; ap.y -= dy * push * aShare; ap.z -= dz * push * aShare;
          bp.x += dx * push * bShare; bp.y += dy * push * bShare; bp.z += dz * push * bShare;
        }
      }
      // A displaced cluster stays joined to its pusher instead of drifting
      // beyond contact. Birth IDs prevent links surviving a pooled puff's reuse.
      for (let i = 0; i < clusterCount; i++) {
        const puff = smoke[clusters[i]];
        if (puff.anchor < 0) continue;
        const anchor = smoke[puff.anchor];
        if (anchor.life <= 0 || anchor.born !== puff.anchorBorn) { puff.anchor = -1; continue; }
        const p = puff.node.position, q = anchor.node.position;
        const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
        const distance = Math.hypot(dx, dy, dz);
        const spacing = MASK_SMOKE_SEPARATION * (puff.node.scale.x + anchor.node.scale.x);
        if (distance <= spacing) continue;
        const pull = 1 - spacing / distance;
        p.x += dx * pull; p.y += dy * pull; p.z += dz * pull;
        puff.vx = lerp(puff.vx, anchor.vx, pressure);
        puff.vy = lerp(puff.vy, anchor.vy, pressure);
        puff.vz = lerp(puff.vz, anchor.vz, pressure);
      }
      // Coalescence and pressure can move a cluster's centre toward the head.
      for (let i = 0; i < smoke.length; i++) if (smoke[i].life > 0) wrapMaskSmoke(cave, smoke[i]);
      if (!cave.root.visible || cave.state !== "working" && cave.state !== "chilling") return;
      cave.breathAt -= dt;
      if (cave.breathAt > 0) return;
      if (!cave.breathPuffs) {
        cave.breathHuge = ++cave.breathCount >= cave.breathHugeAt;
        if (cave.breathHuge) { cave.breathCount = 0; cave.breathHugeAt = 4 + Math.floor(Math.random() * 3); }
        cave.breathTotal = cave.breathPuffs = cave.breathHuge ? 36 : 12;
      }
      // The filter's front is at (0, 0.1, 0.467) in the scaled mask.
      const m = cave.parts.head.world, h = cave.traits.height;
      const forwardLength = Math.hypot(m[8], m[9], m[10]);
      const perPort = cave.breathHuge ? MASK_SMOKE_PER_PORT : MASK_SMOKE_SMALL_PER_PORT;
      const first = (cave.breathTotal - cave.breathPuffs) * MASK_PORTS.length * perPort;
      const serial = ++cave.breathSerial;
      for (let i = 0; i < MASK_PORTS.length * perPort; i++) {
        // Matches the centre hole and six surrounding holes in MrHodlX's gas mask (src/characters/MrHodlX.js).
        const port = MASK_PORTS[i % MASK_PORTS.length];
        math.mat4.transformPoint(MUZZLE, m, (port[0] + (Math.random() - 0.5) * 0.006) * h, (0.1 + port[1] + (Math.random() - 0.5) * 0.006) * h, (0.49 + Math.random() * 0.004) * h);
        const k = (cave.breathHuge ? 1.35 : 0.16) * (0.8 + Math.random() * 0.4) / forwardLength;
        const spread = cave.breathHuge ? 3.5 : 0, jitter = cave.breathHuge ? 0.18 : 0.012;
        const side = port[0] * spread + (Math.random() - 0.5) * jitter;
        const lift = port[1] * spread + (Math.random() - 0.5) * jitter;
        const puff = cave.breathSmoke[first + i];
        setVec(puff.node.position, MUZZLE[0], MUZZLE[1], MUZZLE[2]);
        puff.size = cave.breathHuge ? 0.48 + Math.random() * 0.16 : MASK_SMOKE_SMALL * (0.75 + Math.random() * 0.25);
        puff.cubes = 1;
        puff.serial = serial;
        puff.born = serial; puff.anchor = -1; puff.anchorBorn = 0;
        puff.phase = Math.random() * Math.PI * 2;
        puff.wrapSide = walking ? (Math.cos(puff.phase) < 0 ? -1 : 1)
          : port[0] ? Math.sign(port[0]) : i & 1 ? -1 : 1;
        puff.node.rotation.y = puff.phase;
        setVec(puff.node.scale, puff.size, puff.size, puff.size);
        puff.node.smokeOpacity = 0.85;
        puff.vx = m[8] * k + m[0] * side + m[4] * lift;
        puff.vy = m[9] * k + m[1] * side + m[5] * lift + MASK_SMOKE_LIFT;
        puff.vz = m[10] * k + m[2] * side + m[6] * lift;
        puff.life = puff.maxLife = cave.breathHuge ? 4 + Math.random() * 0.6 : 2.6 + Math.random() * 0.6;
      }
      cave.breathPuffs--;
      cave.breathAt = cave.breathPuffs ? (cave.breathHuge ? 0.04 + Math.random() * 0.04 : 0.04 + Math.random() * 0.08) : 15 + Math.random() * 15;
    };
    const packMaskSmoke = (cave) => {
      const batch = cave.breathBatch;
      if (!batch) return;
      const data = batch.instanceData;
      let count = 0;
      for (let i = 0; i < cave.breathSmoke.length; i++) {
        const puff = cave.breathSmoke[i];
        if (puff.life <= 0) continue;
        const node = puff.node, offset = count++ * 20;
        math.mat4.fromTRS(node.world, node.position, node.rotation, node.scale);
        data.set(node.world, offset);
        data[offset + 16] = 1;
        data[offset + 17] = 0;
        data[offset + 18] = -1 - node.smokeOpacity;
        data[offset + 19] = 0;
      }
      batch.instanceCount = count;
      batch.instanceVersion++;
    };
    // Resolve a standing stack bottom-up, once per actor, so passengers get this frame's motion in any order.
    const updateMember = (cave, dt) => {
      const riding = cave.riding;
      if (riding.updated) return;
      if (riding.support) updateMember(riding.support, dt);
      const p = cave.root.position, x = p.x, y = p.y, z = p.z;
      if (updateHealth(cave, dt)) {
        riding.continuous = false;
        riding.updated = true;
        return;
      }
      // A scene may host a seated resident without sending them into ordinary work/stroll AI.
      if (ctx.residentPose && ctx.residentPose(cave, dt)) {
        riding.continuous = false;
        riding.updated = true;
        return;
      }
      // Test both endpoints against the same current heap. A resize or a
      // relocation between frames must not masquerade as an exit.
      const wasInBananas = cave.root.visible && (cave.state === "working" || cave.state === "chilling") && inBananas(cave);
      const support = riding.support;
      if (support && support.root.visible && support.riding.continuous) {
        const q = support.root.position, from = support.riding;
        ctx.carryCharacter(cave, q.x - from.x, q.y - from.y, q.z - from.z);
      }
      const ownX = p.x, ownY = p.y, ownZ = p.z;
      const w = cave.weapon, club = cave.parts.club, meleeBefore = w.meleeTime, bashBefore = w.bashTime;
      const meleeRelease = w.meleeStrikeTime + MELEE_RECOVER;
      // Only the forward stroke can hit. Held wind-up and recovery never
      // repeatedly disturb a surface, and idle actors do no contact work.
      const meleeStep = dt * (cave.traits.nunchaku ? NUNCHAKU_RATE : 1);
      const striking = dt > 0 && (ctx.onMeleeStrike || input.weaponTargets || ctx.fireReachable) && cave === player && w.primaryEquipped && !w.meleeHeld && !w.meleeHit
        && w.meleeTime > MELEE_RECOVER && w.meleeTime - meleeStep < meleeRelease && (!w.meleeQuick || w.meleeTime <= meleeRelease)
        && !cave.camp.seat && !cave.bedTravel.mode;
      if (striking) {
        BL.scene.updateWorld(cave.root);
        meleePreviousWorld.set(club.world);
      }
      clearMeleeThrust(cave);
      updateWeapon(cave, dt);
      // Always display and check the end of the chop before recovering, even
      // when a frame would otherwise step across the horizontal limit.
      const meleeFloor = w.meleeHeld ? MELEE_RELEASE : w.meleeQuick && w.meleeTime > meleeRelease ? meleeRelease : w.meleeTime > MELEE_RECOVER ? MELEE_RECOVER : 0;
      w.meleeTime = Math.max(meleeFloor, w.meleeTime - meleeStep);
      w.bashTime = Math.max(0, w.bashTime - dt);
      w.meleeReadyTime = meleeBefore > 0 && w.meleeTime === 0 ? MELEE_READY_HOLD + MELEE_CARRY_BLEND : Math.max(0, w.meleeReadyTime - dt);
      if (w.meleeHeld) {
        w.meleeHeldTime = Math.min(MELEE_CHARGE_DELAY + MELEE_CHARGE_TIME, w.meleeHeldTime + dt);
        w.meleeCharge = ease.inOutQuad(clamp((w.meleeHeldTime - MELEE_CHARGE_DELAY) / MELEE_CHARGE_TIME, 0, 1));
      }
      w.meleeComboTime = Math.max(0, w.meleeComboTime - dt);
      if (!runCamp(cave, dt)) updateCaveman(cave, dt);
      else if (!cave.camp.seat?.allowWeapons) stopReload(cave);
      watchWalker(cave, dt, x, z);
      const axeMoving = Math.hypot(p.x - x, p.z - z) > 1e-5 || cave.hop > 1e-4 || Math.abs(cave.hopV) > 1e-4
        || cave.catchT > 0 || cave.yawn > 0;
      w.axeIdle = carryingStoneAxe(cave) && !axeMoving ? Math.min(AXE_STICK_DELAY + AXE_STICK_BLEND, w.axeIdle + dt) : 0;
      poseShoulder(cave, dt);
      if (cave.parts.chuk) poseNunchaku(cave, dt);
      if (cave === player) posePeek(cave, dt);
      poseWeapon(cave);
      if (cave.ladder && cave.ladder.plane) ladderPose(cave);
      if (bashBefore > GUN_BASH_IMPACT && w.bashTime <= GUN_BASH_IMPACT && cave === player && w.equipped && !w.reloading && !w.swapTime && !w.reloadHandoff && !cave.health.stunned && !cave.camp.seat && !cave.bedTravel.mode) {
        weaponOrigin(weaponStart, cave, true);
        hitMeleeTarget(cave, GUN_BASH_POWER);
      }
      if (striking && w.meleeTime > 0 && club.visible && club.parent === cave.parts.armR && !cave.bedTravel.mode) {
        // The power spent on release stays with the strike until its arc lands.
        BL.scene.updateWorld(cave.root);
        weaponOrigin(weaponStart, cave, true);
        const interactive = input.weaponTargets && input.weaponTargets.strike(weaponHit, meleePreviousWorld, club.world, club.geometry, cave)
          && weaponContactClear(weaponStart, weaponHit, true);
        const blocked = !interactive && meleeSceneryBlocked(cave, meleePreviousWorld, club.world);
        let contactFraction = 1;
        if (interactive || blocked) {
          // Refine only a confirmed contact. Ordinary swings do one mesh
          // query per frame; five bounded probes keep the impact pose close
          // to the surface instead of finishing the stroke through it.
          meleeCurrentWorld.set(club.world);
          if (interactive) Object.assign(meleeContact, weaponHit);
          let low = 0, high = 1;
          for (let i = 0; i < 5; i++) {
            const middle = (low + high) / 2;
            for (let j = 0; j < 16; j++) meleeProbeWorld[j] = lerp(meleePreviousWorld[j], meleeCurrentWorld[j], middle);
            const touching = interactive
              ? input.weaponTargets.strike(weaponHit, meleePreviousWorld, meleeProbeWorld, club.geometry, cave) && weaponContactClear(weaponStart, weaponHit, true)
              : meleeSceneryBlocked(cave, meleePreviousWorld, meleeProbeWorld);
            if (touching) {
              high = middle;
              if (interactive) Object.assign(meleeContact, weaponHit);
            } else low = middle;
          }
          contactFraction = high;
          w.meleeHit = true;
          if (!hitMeleeTarget(cave)) {
            const power = strikeMeleePower(cave);
            if (interactive) {
              for (let j = 0; j < 16; j++) meleeProbeWorld[j] = lerp(meleePreviousWorld[j], meleeCurrentWorld[j], high);
              if (meleeContact.node.mirror && ctx.onMeleeStrike) ctx.onMeleeStrike(meleePreviousWorld, meleeProbeWorld, club.geometry, dt, power);
              if (ctx.onWeaponHit) ctx.onWeaponHit(cave, meleeContact.type, power);
              if (ctx.onWeaponImpact) {
                // The contact's own swept motion supplies the impact direction,
                // including wrist rotation rather than only the moving grip.
                math.mat4.invert(meleeContactInverse, meleeProbeWorld);
                math.mat4.transformPoint(MUZZLE, meleeContactInverse, meleeContact.x, meleeContact.y, meleeContact.z);
                const x = MUZZLE[0], y = MUZZLE[1], z = MUZZLE[2];
                let dx = (meleeProbeWorld[0] - meleePreviousWorld[0]) * x + (meleeProbeWorld[4] - meleePreviousWorld[4]) * y + (meleeProbeWorld[8] - meleePreviousWorld[8]) * z + meleeProbeWorld[12] - meleePreviousWorld[12];
                let dy = (meleeProbeWorld[1] - meleePreviousWorld[1]) * x + (meleeProbeWorld[5] - meleePreviousWorld[5]) * y + (meleeProbeWorld[9] - meleePreviousWorld[9]) * z + meleeProbeWorld[13] - meleePreviousWorld[13];
                let dz = (meleeProbeWorld[2] - meleePreviousWorld[2]) * x + (meleeProbeWorld[6] - meleePreviousWorld[6]) * y + (meleeProbeWorld[10] - meleePreviousWorld[10]) * z + meleeProbeWorld[14] - meleePreviousWorld[14];
                let length = Math.hypot(dx, dy, dz);
                if (length < 1e-8) { dx = Math.sin(cave.root.rotation.y); dy = 0; dz = Math.cos(cave.root.rotation.y); length = 1; }
                ctx.onWeaponImpact(cave, meleeContact, dx / length, dy / length, dz / length, power);
              }
            }
          }
        } else if (w.meleeTime <= MELEE_RECOVER && w.meleeTarget.node) {
          // Resolve the reticle target even if the visible skin passed beside it.
          hitMeleeTarget(cave);
        } else if (!input.weaponTargets && ctx.onMeleeStrike) {
          w.meleeHit = ctx.onMeleeStrike(meleePreviousWorld, club.world, club.geometry, dt, strikeMeleePower(cave));
        }
        if (w.meleeHit) {
          const beforeLower = ease.inOutQuad(clamp((meleeRelease - meleeBefore) / w.meleeStrikeTime, 0, 1));
          const afterLower = ease.inOutQuad(clamp((meleeRelease - w.meleeTime) / w.meleeStrikeTime, 0, 1));
          w.meleeStop = lerp(beforeLower, afterLower, contactFraction);
          w.meleeTime = MELEE_RECOVER;
          poseWeapon(cave);
          BL.scene.updateWorld(cave.root);
        }
      }
      if (ctx.characterSupportAt) riding.support = ctx.characterSupportAt(cave);
      if (dt > 0 && cave.root.visible && (cave.state === "working" || cave.state === "chilling") && ctx.onBodyMove) ctx.onBodyMove(cave, x, y, z, dt);
      if (dt > 0) {
        const s = cave.shoulder, speed = PLAYER_SPEED * (cave === player ? steer.speed : 1);
        const continuous = Math.hypot(p.x - x, p.z - z) <= speed * dt + 1e-5;
        s.motionX = continuous ? (p.x - x) / dt : 0; s.motionZ = continuous ? (p.z - z) / dt : 0;
      }
      updateCampEffects(cave, dt);
      runMaskBreath(cave, dt);
      packMaskSmoke(cave);
      if (wasInBananas && dt > 0 && cave.root.visible && (cave.state === "working" || cave.state === "chilling") && !inBananas(cave) && ctx.pile.spill) {
        const dx = p.x - x, dy = p.y - y, dz = p.z - z;
        // Respawns and scripted arrivals also move during update; only continuous movement carries fruit along.
        if (Math.hypot(dx, dz) <= (Math.max(JET_SPEED, PLAYER_SPEED * (cave === player ? steer.speed : 1)) + WALK.ledgeSpeed) * dt + 1e-5 && Math.abs(dy) <= Math.abs(cave.hopV) * dt + STEP + 1e-5
          && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-7) {
          const feet = p.y - cave.baseY;
          // Upward exits shed fruit at the feet crossing the top; side exits scatter it along the whole body.
          const height = dy > Math.hypot(dx, dz) ? 0 : cave.bodyHeight;
          ctx.pile.spill(p.x, feet + 0.04, p.z, dx / dt, dy / dt, dz / dt, height);
        }
      }
      if (cave.jetFuel < 1 && grounded(cave)) {
        if (cave.jet && cave.jetFuel < JET_LAUNCH_FUEL) cave.jetRecovering = true;
        if (!cave.jet || !cave.jet.spending) cave.jetFuel = Math.min(1, cave.jetFuel + dt / (JET_REFILL_SECONDS * jetTank(cave)));
      }
      if (cave.jetFuel > JET_LAUNCH_FUEL) cave.jetRecovering = false;
      // Check only this actor's own motion: a stack can add several legitimate walking velocities.
      // Keep the old fall speed when landing zeros hopV; respawns must never teleport passengers.
      riding.continuous = dt > 0 && Math.hypot(p.x - ownX, p.z - ownZ) <= (Math.max(PLAYER_SPEED * (cave === player ? steer.speed : 1), JET_SPEED) + WALK.ledgeSpeed) * dt + 1e-5
        && Math.abs(p.y - ownY) <= Math.max(Math.abs(riding.vy), Math.abs(cave.hopV)) * dt + STEP + WALK.gravity * dt * dt + 1e-5;
      riding.updated = true;
    };
    const update = (dt, now) => {
      elapsed = now;
      if (ctx.prepareNpcRoutes) ctx.prepareNpcRoutes();
      stepPlans();
      updateBullets(dt);
      // Snapshot both sides before anyone moves, so a centred meeting gives both the same right-shoulder default.
      // Previous-frame motion distinguishes an overtaker from someone merely behind.
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const cave = crewList[caveIndex];
        const s = cave.shoulder, riding = cave.riding, p = cave.root.position;
        riding.support = null; riding.updated = riding.continuous = false;
        riding.x = p.x; riding.y = p.y; riding.z = p.z;
        riding.vy = cave.hopV;
        s.snapX = p.x; s.snapZ = p.z;
        s.snapVX = s.motionX; s.snapVZ = s.motionZ;
        s.attempted = false; s.targetYaw = 0;
        snapshotTraffic(cave);
      }
      // A puppet (`cave.puppet`, set by npc-sync.js on a page following the room's NPC host) is posed from the
      // network: no spacing and no AI of its own; everything else about it stays as it is.
      for (let i = 0; i < crewList.length; i++) if (!crewList[i].puppet) spaceWalker(crewList[i]);
      if (dt > 0 && ctx.characterSupportAt) for (let i = 0; i < crewList.length; i++) {
        const cave = crewList[i];
        cave.riding.support = ctx.characterSupportAt(cave);
      }
      if (dt > 0) updateFireContacts();
      updateFireThreats();
      for (let i = 0; i < crewList.length; i++) if (!crewList[i].puppet) updateMember(crewList[i], dt);
      updateStunGear(dt);
      syncMagazine();
      if (dt > 0) updateFireContacts();
      // Collision exclusions belong to this ordered update only; input and relocation see ordinary bodies.
      for (let i = 0; i < crewList.length; i++) crewList[i].riding.support = null;
    };
    const dispose = () => {
      window.clearTimeout(recipeTimer);
      recipeTimer = 0;
      planQueue.length = 0;
      player = null;
      for (let caveIndex = 0; caveIndex < crewList.length; caveIndex++) {
        const cave = crewList[caveIndex];
        for (let dropIndex = 0; dropIndex < cave.stunGear.drops.length; dropIndex++) {
          const drop = cave.stunGear.drops[dropIndex];
          if (drop.active) collectStunDrop(drop, cave);
          if (drop.node && drop.node.parent) removeChild(drop.node.parent, drop.node);
        }
        if (cave.health.stunned) {
          cave.health.value = HEALTH_MAX;
          cave.health.stunned = cave.health.recovering = false;
        }
        for (const model of cave.magazineModels) if (model && model.node.parent) removeChild(model.node.parent, model.node);
        stopBurst(cave);
        stopReload(cave);
        releaseBedroll(cave);
        if (cave.camp.seat) cave.camp.seat.sitter = null;
        for (const node of cave.hitNodes) input.remove(node);
        removeChild(root, cave.root);
        removeChild(root, cave.sleepWeapons);
        if (cave.breathBatch) removeChild(root, cave.breathBatch);
      }
      cavemen.clear();
      crewList.length = 0;
      fanSlots.length = 0;
      for (const bullet of bulletPool) removeChild(root, bullet.node);
      bulletPool.length = 0;
      for (const built of builtEquipment) removeChild(root, built.node);
      builtEquipment.length = 0;
      for (const node of dismantling) removeChild(root, node);
      dismantling.length = 0;
    };
    if (ctx.playerName) {
      const cave = cavemen.get(ctx.playerName);
      cave.override = cave.state = "working";
      cave.root.visible = true;
      cave.act.kind = "idle";
      standPose(cave);
    }
    const stats = () => ({ built: builtEquipment.length, tomatoesThrown, projectiles: bulletPool.reduce((n,b)=>n+(b.life>0?1:0),0) });
    return {
      showShot, setTint, spotOccupied,
      cavemen, list: crewList, fanSlots, stateOf, stateCounts, workingCavemen, eatingCavemen, workingCount, eatingCount, feedableCavemen, refreshStates, refreshRosterRow, updateFan, rush, headWorldOf, applyAllSwag, wornBy, renderLocker, pokeCave, idleSay, drawQuotes,
      throwTomato, clearProjectiles, control, release, relocatePlayer, sleepPlayer, wakePlayer, sitPlayer, standPlayer, clearHeadLook, prepareDragged, recoverDragged, ignite, dropRoll, damage, fireView, steer: steerPlayer, look: lookPlayer, elevate: elevatePlayer, playerAction, jumpPlayer, poseWeapon, wearJetpack, removeJetpack, setJetpackOwnership, thrust, holdRocketJump, update, dispose, stats,
      actorClear, builtInJetpack, toggleTint, twirl, toggleWeapon, selectWeapon, configureWeapon, swingWeapon, bashWeapon, releaseSwing, fireWeapon, setWeaponTrigger, canFire, weaponOrigin, meleeReach, meleePower, nearReload, canReload, startReload, stopReload, stopBurst, canSwapMagazine, swapMagazine, collectMagazine, collectGroundMagazine, collectAmmo, removeMagazines, hasMagazine, magazineCount, magazineAmmo, totalAmmo, workSites,
      get sleeping() { return !!(player && player.bedTravel.manual && player.state === "sleeping"); },
      get player() {
        return player;
      }
    };
  };
  BL.crew = { create, LAND_DUST, JET_SPARKS, EAT_RATE, AMMO_MAX, AMMO_PER_BANANA, RELOAD_PERIOD, BURST_ROUNDS, BURST_STEP, MELEE_TAP_TIME, MELEE_CHARGE_DELAY, HEALTH_MAX, HEALTH_REGEN_DELAY, HEALTH_REGEN_RATE, JUMP_SPEED, JET_SPEED, JET_RISE, JET_FUEL_SECONDS, JET_MOVE_SECONDS, JET_REFILL_SECONDS, JET_LAUNCH_FUEL };
})();

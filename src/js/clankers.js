// A contributor's clanker keeps its own place in the work cave and travels while
// its Ooga reloads. Routes, leaps and reservations are bounded by the roster.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { clamp, damp, mulberry32, fnv1a } = BL.math;
  const { addChild } = BL.scene;
  // The tallest shootable meadow rocks reach 1.11; a prop step must clear their real mesh.
  const SCALE = 1, SPEED = 2.7, CHILL_SPEED = 0.9, STEP = 0.52, PROP_STEP = 1.16, JUMP_BUFFER = 0.18, PLAYER_SMASH_RECOVER = 0.12;
  const RAGE_SPEED = 12, RAGE_STEP = 0.1;
  // The hub shares this scope for route, live-body and captive sweeps. Derive
  // it from the held capture so release and possession restore normal collision.
  const rageCarrying = entry => !!(entry?.active && !entry.controlled && entry.rage.active
    && entry.motion.dragging && entry.capture?.autonomous && entry.capture.cave);
  const CHILL_REST_SECONDS = 120, CHILL_REST_VARIATION = 120;
  // Measured full-size gallop envelope. Airborne and floor-pound poses reserve
  // their larger envelopes before beginning the animation.
  // A sleeper's path to bed is at most this many points; its mouth is where its marks of sleep rise from.
  const SLEEP_POINTS = 24, SLEEP_MOUTH = { x: 0, y: 0, z: 0 };
  const WALK_RADIUS = 1.9, AIR_RADIUS = 2.05, FOOT = 1.4, SPACE = 0.07, TAU = Math.PI * 2;
  // The mirror sits at local z .5. Keeping a working root at or behind this
  // line leaves room for the largest 2.25-unit pound pose without recrossing it.
  const MIRROR_WORK_LIMIT = -1.85;
  const WALK_HEIGHT = 2.2;
  const JUMP_SAMPLES = 20, MAX_JUMP = 8.5;
  const CLIMB_POINTS = 128, CLIMB_RADIUS = 1.05, CLIMB_HEIGHT = 3.1, CLIMB_STANDOFF = 0.87;
  const CLIMB_SPEED = 2.1, CLIMB_APPROACH_SPEED = 3.15, CLIMB_CREST_SPEED = 2.75, CLIMB_TURN_TIME = 0.24, CLIMB_MOUNT_DISTANCE = 0.75;
  const WALL_RECT_SAMPLES = 4, WALL_ENTER_SHARE = 0.25, TOP_EXIT_SHARE = 0.75;
  const ROLL_SECONDS = 3, ROLL_ENTRY_SECONDS = 0.45, ROLL_RECOVER_SECONDS = 0.8, SOOT_SECONDS = 10, MOTION_RADIUS = BL.agent.MANAGED_MOTION_RADIUS, MOTION_HEIGHT = BL.agent.MANAGED_MOTION_HEIGHT;
  const FIRE_FLEE_REACH = 8, FIRE_FLEE_CLEAR = 10, FIRE_MEMORY = 1.5;
  const GRAVITY = BL.pilot.WALK.gravity, LEDGE_RISE = BL.pilot.WALK.ledgeRise;
  const PLAYER_JUMP_SPEED = BL.crew.JUMP_SPEED * Math.sqrt(1.5);
  const ROOF_JUMP_HEIGHT = 7.5, ROOF_RUN_UP = 1.5;
  const STEERING = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4];
  const FIRE_STEERING = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.1, -2.1, Math.PI];
  const REST_TRANSITION_TIMES = [1 / 120, 1 / 60, 1 / 30, 0.06, 0.15, 0.3, 0.6, 1.2];
  const ROOM_CELLS = [[-1.7, -4.92], [1.7, -4.92], [-1.7, -3.38], [1.7, -3.38],
    [-1.7, -1.84], [1.7, -1.84], [-1.7, -0.3], [1.7, -0.3],
    [0, -4.92], [0, -3.38], [0, -1.84], [0, -0.3]];
  // Aisle lanes admit the complete walking rig and its turn, unlike points
  // beside the bench faces that fit only a stationary sideways work pose.
  const LAB_ROUTE_X = [-1.14, 0, 1.14], LAB_ROUTE_Z = [-0.15, -1.8, -3.2, -4.05];
  // Stand as soon as the coat clears the plane, then walk to the room's route start.
  const LAB_ENTRY_GOAL = -1;
  const LAB_ROUTE_START = -2.5;
  const LAB_TURN_SPEED = 6;
  const create = (ctx) => {
    const { crew, sites, groundAt, clear } = ctx;
    const footprint = BL.agent.footprint, torso = BL.agent.torso;
    const pointSupportAt = ctx.pointSupportAt || groundAt;
    const climbSolidAt = ctx.climbSolidAt || ctx.solidAt, climbSurfaceAt = ctx.climbSurfaceAt || ctx.surfaceAt;
    const wallPanels = climbSolidAt ? BL.wallPanels.create(climbSolidAt) : null;
    const PANEL = { x: 0, y: 0, z: 0, heading: 0, nx: 0, nz: 1 };
    const RAMP = { groundX: 0, groundZ: 0, uneven: 0 };
    const walkingRampAt = (x, y, z, heading) => !!(ctx.surfaceAt
      && BL.wallPanels.rampAt(ctx.surfaceAt, x, y, z, heading, RAMP));
    const walkingStairsAt = (e, heading) => {
      const p = e.root.position;
      return !!(ctx.stairAt && ctx.stairAt(p.x, p.y, p.z))
        || walkingRampAt(p.x, p.y, p.z, heading);
    };
    const list = [], byOwner = new Map(), portals = new Array(sites.length).fill(null);
    // Stations are authored once in world space: { x, y, z, heading, kind,
    // side, enabled? }. labInside owns the entrance plane, independently of assignment.
    const labSite = Number.isInteger(ctx.labSite) ? ctx.labSite : -1, labStations = ctx.labStations || [], labEquipment = ctx.labEquipment || [];
    const coatClip = labSite >= 0 ? BL.agent.labCoatClip(sites[labSite].mouth) : null;
    const labNodes = new Float64Array(16 * 3), labHeadings = new Float64Array(16), labCosts = new Float64Array(16), labTimes = new Float64Array(16), labWaits = new Float64Array(16), labFixed = new Uint8Array(16), labPrevious = new Int8Array(16), labQueue = new Uint8Array(16);
    const labEdges = new Uint8Array(16 * 16 * 2), labEdgeWaits = new Float64Array(16 * 16 * 2), labEdgeTimes = new Float64Array(16 * 16 * 2);
    const labPenalties = new Float64Array(16 * 16);
    const labStationOrder = new Uint16Array(labStations.length);
    const labGeometry = new Uint8Array(128);
    const labFuturePoint = { x: 0, y: 0, z: 0, heading: 0 };
    let labPassAt = 0, labRouteBudget = 1, labRouteTurn = -1, labRouteNext = 0;
    let labEscape = null;
    const roamRadius = ctx.roamRadius || 28;
    const POINT = { x: 0, y: 0, z: 0, heading: 0 };
    const loungeSpots = new Float64Array(320 * 3);
    let loungeCount = 0, roofCount = 0, loungeReady = false;
    const roamPath = new Float64Array(12), roamPoint = { x: 0, y: 0, z: 0, heading: 0 };
    const climbWallDepths = new Float64Array(CLIMB_POINTS);
    let roamBudget = 1, roamNext = 0, roamTurn = -1, roamSerial = 0;
    let disposed = false, elapsed = 0, player = null, fireThreatsActive = false, rage = null;
    let debugShuttle = null, debugShuttleAt = 0, debugShuttleUntil = 0;
    let climbFrameBudget = 0, climbTurn = -1, climbNext = 0, debugRouteBudget = 0, wallBudget = 0;
    const WALL_GRID = 49, WALL_HALF = 24, WALL_STEP = 0.55, WALL_COUNT = WALL_GRID * WALL_GRID;
    const WALL_DU = [1, -1, 0, 0, 1, -1, 1, -1], WALL_DV = [0, 0, 1, -1, 1, 1, -1, -1];
    const wallSearch = ctx.debugMovement ? { owner: null, current: -1, neighbor: 0, visits: 0,
      x: 0, y: 0, z: 0, heading: 0, goalX: 0, goalY: 0, goalZ: 0, goalU: 0, goalV: 0, final: false,
      states: new Uint8Array(WALL_COUNT), attempts: new Uint8Array(WALL_COUNT), points: new Float64Array(WALL_COUNT * 3), headings: new Float64Array(WALL_COUNT),
      costs: new Float64Array(WALL_COUNT), scores: new Float64Array(WALL_COUNT), parents: new Int16Array(WALL_COUNT),
      route: new Int16Array(512) } : null;
    const clearWallSearch = (e) => {
      if (wallSearch && wallSearch.owner === e) wallSearch.owner = null;
    };
    const WALL_POINT = { x: 0, y: 0, z: 0, heading: 0, radius: 0 };
    const WALL_RECTANGLE = { halfForward: 0, halfSide: 0, centerForward: 0 };
    const alive = (cave) => cave.state === "working" || cave.state === "chilling";
    // Asleep is the Ooga's standing state, by its contributions: not the moment it stirs to eat a donation or
    // flee a fire, which would send its gorilla home over the bridge and straight back. One standing in for an
    // Ooga somebody else is driving is away, not asleep.
    const sleeps = (cave) => crew.stateOf(cave) === "sleeping" && !cave.remoteControlled;
    const enteringCave = e => !e.controlled && !e.rage.active && e.mode === "working" && e.phase === "travel"
      && (e.route === "apron" || e.route === "enter");
    const labWorker = e => !e.controlled && !e.rage.active && e.mode === "working"
      && (e.route === "exit" && e.fromSite === labSite || e.site === labSite && (e.motion.lab || e.planningLab));
    const labSpeed = e => e.lab.yielding ? 0.65 : e.route === "exit" ? SPEED : 1.1;
    const enteringAisle = (e) => e.phase === "travel" && e.route === "enter"
      && (e.site === labSite ? !e.entryTurn || e.entryTurn === 1 : !e.entryTurn);
    const releasePortal = (e) => {
      if (e.portal >= 0 && portals[e.portal] === e) portals[e.portal] = null;
      e.portal = -1;
    };
    const claimPortal = (e, site) => {
      if (portals[site] === e) {
        if (e.route !== "exit" && e.route !== "enter" && !e.jump.active && caveAt(e.root.position.x, e.root.position.y, e.root.position.z) !== site
          && elapsed - e.portalSince > 18) {
          releasePortal(e); e.portalRetry = elapsed + 2; e.portalWait = false;
        } else return true;
      }
      const holder = portals[site];
      if (holder && e.route === "exit" && holder.route !== "exit" && holder.route !== "enter" && !holder.jump.active
        && caveAt(holder.root.position.x, holder.root.position.y, holder.root.position.z) !== site) {
        releasePortal(holder); holder.route = "apron"; holder.portalWait = false;
      }
      if (portals[site]) return false;
      // Changed-cave departures get the opening first, keeping opposing
      // traffic from continually contesting the same narrow arch.
      const mouth = sites[site].mouth;
      let next = null, nearest = Infinity;
      for (let i = 0; i < list.length; i++) {
        const other = list[i];
        if (!other.active || other.fromSite !== site || other.route !== "exit"
          || other.phase !== "leave" && other.phase !== "travel") continue;
        const p = other.root.position;
        if (caveAt(p.x, p.y, p.z) !== site) continue;
        const distance = (p.x - mouth.x) ** 2 + (p.z - mouth.z) ** 2;
        if (distance < nearest) { next = other; nearest = distance; }
      }
      if (next && next !== e) return false;
      portals[site] = e; e.portal = site; e.portalSince = elapsed;
      return true;
    };
    const caveAt = (x, y, z, inset = 0) => {
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i], m = site.mouth, dx = x - m.x, dz = z - m.z;
        if (site.contains) { if (site.contains(x, y, z, inset)) return i; continue; }
        const across = dx * site.cr - dz * site.sr, along = dx * site.sr + dz * site.cr;
        const room = site.room || m.room, from = room ? room.from : 2.5, to = room ? room.to : 6.5;
        const half = along < -from ? (room ? room.w / 2 : 3) : 2.5;
        if (y >= m.floorY - 0.15 && y <= m.floorY + (room ? room.h : 4)
          && along <= 0.5 - inset && along >= -to + inset && Math.abs(across) < half - inset) return i;
      }
      return -1;
    };
    const contactAt = (x, y, z) => {
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i], m = site.mouth, dx = x - m.x, dz = z - m.z;
        const across = dx * site.cr - dz * site.sr, along = dx * site.sr + dz * site.cr;
        const room = site.room || m.room, from = room ? room.from : 2.5, to = room ? room.to : 6.5;
        const half = along < -from ? (room ? room.w / 2 : 3) : 2.5;
        if (y >= m.floorY - 0.15 && y <= m.floorY + (room ? room.h : 4)
          && along <= 2.5 && along >= -to && Math.abs(across) < half) return i;
      }
      return -1;
    };
    const chillZones = ctx.chillZones || [];
    const loungeAreas = ctx.loungeAreas || [];
    const nearInactiveCave = (x, z) => {
      if (!loungeAreas.length) return true;
      for (let i = 0; i < loungeAreas.length; i++) {
        const area = loungeAreas[i];
        if ((x - area.x) ** 2 + (z - area.z) ** 2 < area.radius ** 2) return true;
      }
      return false;
    };
    const descentWalls = ctx.descentWalls || [];
    const autonomousChill = (e) => e.mode === "chilling" && e.phase === "chill" && !e.controlled && !e.debugMove.active;
    const descentWallAt = (e, x, y, z, heading = e.climb.heading) => {
      const c = e.climb;
      if (e.controlled || e.debugMove.active || c.debugTraverse || !c.active && !c.departurePlanning || !c.descending && !c.departurePlanning) return null;
      for (let i = 0; i < descentWalls.length; i++) {
        const wall = descentWalls[i], dx = x - wall.x, dz = z - wall.z;
        const across = dx * wall.cr - dz * wall.sr, along = dx * wall.sr + dz * wall.cr;
        if (Math.abs(across) <= wall.half && along >= -2.5 && along <= 2.5
          && y > wall.floor + 0.6 && Math.sin(heading) * wall.sr + Math.cos(heading) * wall.cr < -0.5) return wall;
      }
      return null;
    };
    const chillCaveClear = (x, y, z, nx = x, ny = y, nz = z, escaping = false) => {
      for (let i = 0; i < chillZones.length; i++) {
        const zone = chillZones[i];
        if (Math.min(y, ny) >= zone.top) continue;
        const dx = x - zone.x, dz = z - zone.z;
        const across = dx * zone.cr - dz * zone.sr, along = dx * zone.sr + dz * zone.cr;
        const ax = (nx - x) * zone.cr - (nz - z) * zone.sr;
        const az = (nx - x) * zone.sr + (nz - z) * zone.cr;
        if (escaping) {
          // A former worker or released player can already be inside a reserved
          // approach. Allow planted turns and steps toward its nearest boundary.
          const depth = Math.min(zone.half - Math.abs(across), along - zone.from, zone.to - along, zone.top - y);
          const next = Math.min(zone.half - Math.abs(across + ax), along + az - zone.from, zone.to - along - az, zone.top - ny);
          // An actor already in the approach must be able to fall in place
          // after a blocked jump; the reservation only limits travel into it.
          if (depth > 0 && (next < depth - 1e-9 || x === nx && z === nz && ny <= y)) continue;
        }
        if (!BL.terrain.segmentBoxClear(across, y, along, ax, ny - y, az, 0, 0,
          -zone.half, -Infinity, zone.from, zone.half, zone.top, zone.to)) return false;
      }
      return true;
    };
    const peerShape = (x, y, z, bx, by, bz) => {
      return torso || footprint;
    };
    const roofAt = (x, y, z) => {
      const roofs = ctx.climbRoofs || ctx.loungeRoofs;
      if (!roofs || !ctx.surfaceAt || Math.abs(ctx.surfaceAt(x, z) - y) > 0.1) return -1;
      let index = -1, nearest = 9 * 9;
      for (let i = 0; i < roofs.length; i++) {
        const roof = roofs[i], distance = (roof.x - x) ** 2 + (roof.z - z) ** 2;
        if (y >= roof.y - 0.55 && distance < nearest) { nearest = distance; index = i; }
      }
      return index;
    };
    const unusedRoof = (x, y, z, foot) => {
      const roofs = ctx.loungeRoofs || ctx.climbRoofs;
      if (!roofs || !ctx.surfaceAt || Math.abs(ctx.surfaceAt(x, z) - y) > 0.05) return false;
      let patch = false;
      for (let i = 0; i < roofs.length; i++) {
        const roof = roofs[i];
        if (y >= roof.y - 0.55 && (roof.x - x) ** 2 + (roof.z - z) ** 2 < 4.5 ** 2) { patch = true; break; }
      }
      if (!patch) return false;
      // Eligible cave and HQ tops contain exposed stone as well as grass. All four
      // sides still need a nearby supporting top; the full rig clearance
      // rejects higher rock before a resting place is accepted.
      for (let side = 0; side < 4; side++) {
        const sx = x + (side < 2 ? (side ? 1 : -1) * foot : 0);
        const sz = z + (side >= 2 ? (side === 3 ? 1 : -1) * foot : 0);
        if (ctx.onLand && !ctx.onLand(sx, sz) || Math.abs(ctx.surfaceAt(sx, sz) - y) > 0.5) return false;
      }
      return true;
    };
    const grass = (x, y, z, foot = FOOT) => Number.isFinite(y) && Math.hypot(x, z) < roamRadius
      && chillCaveClear(x, y, z)
      && (nearInactiveCave(x, z) || unusedRoof(x, y, z, foot))
      // Grass on an active cave is still a climbable surface, but never a resting destination.
      && (roofAt(x, y, z) < 0 || unusedRoof(x, y, z, foot))
      && (!ctx.restSurfaceClear || ctx.restSurfaceClear(x, y, z, foot))
      && (!ctx.onLand || ctx.onLand(x, z)) && (!ctx.isGrass || ctx.isGrass(x, z, y)
        && ctx.isGrass(x - foot, z, y) && ctx.isGrass(x + foot, z, y)
        && ctx.isGrass(x, z - foot, y) && ctx.isGrass(x, z + foot, y) || unusedRoof(x, y, z, foot));
    const landing = (x, y, z) => Number.isFinite(y) && Math.hypot(x, z) < roamRadius && (!ctx.onLand || ctx.onLand(x, z));
    const actorLanding = (e, x, y, z) => (!e.debugMove.active || y > ctx.debugMinY)
      // Underground platforms can extend beyond the top island footprint.
      // A real floor beneath the centre also admits their inward handoff.
      && (landing(x, y, z) || Number.isFinite(y) && Math.abs(pointSupportAt(x, z, y + 0.02, e) - y) < 0.05);
    // A cave departure can fly over the reserved apron. Its destination is
    // outside that zone, and scenery/peer clearance still certifies the arc.
    const staticClear = (e, x, y, z, nx = x, ny = y, nz = z, fromHeading = e.heading, toHeading = fromHeading) =>
      (!autonomousChill(e) || e.climb.departurePlanning || e.jump.active && e.jump.caveExit
        || chillCaveClear(x, y, z, nx, ny, nz, true))
      && (!e.motion.dragging || !(e.rage.active || e.rageTraversal || e.jump.active || e.drive.airborne)
        || !ctx.rageCarryClear || ctx.rageCarryClear(e, x, y, z, nx, ny, nz, fromHeading, toHeading))
      && clear(x, y, z, nx, ny, nz, e.radius, e.height, e, null, fromHeading, toHeading);
    // Retained routes double as short-lived space/time reservations. Predict
    // from the actual position, so a late worker never leaves a phantom path
    // behind it. Unplanned, controlled and working actors keep their real spot.
    const labFuture = (e, seconds, out) => {
      const p = e.root.position, job = e.lab;
      out.x = p.x; out.y = p.y; out.z = p.z; out.heading = e.heading;
      if (!e.motion.lab || e.controlled || e.fire.burning || e === labEscape
        || !job.pathCount || job.arrived && !job.yielding) return out;
      const settling = e.gorilla.labItem ? !e.gorilla.labCompact : !e.gorilla.labWalkCompact;
      seconds -= Math.max(settling ? 0.15 : 0, job.readyAt - elapsed);
      const speed = labSpeed(e);
      for (let i = job.pathIndex; seconds > 0 && i < job.pathCount; i++) {
        if (i > job.pathIndex) seconds -= job.pathWaits[i];
        if (seconds <= 0) break;
        const at = i * 3, dx = job.path[at] - out.x, dz = job.path[at + 2] - out.z, distance = Math.hypot(dx, dz);
        const fixed = Number.isFinite(job.pathFacings[i]);
        const final = !fixed && i + 1 === job.pathCount && !job.pathPartial && !job.yielding && e.route !== "exit";
        const facing = fixed ? job.pathFacings[i] : final && distance <= 0.8 ? job.targetHeading : Math.atan2(dx, dz);
        const turn = Math.atan2(Math.sin(facing - out.heading), Math.cos(facing - out.heading)), duration = Math.abs(turn) / LAB_TURN_SPEED;
        if (seconds < duration) { out.heading += Math.sign(turn) * seconds * LAB_TURN_SPEED; break; }
        seconds -= duration; out.heading = facing;
        const approach = final ? Math.min(distance, 0.8) : 0, travel = distance - approach;
        let step = Math.min(travel, seconds * speed);
        if (distance > 0) { out.x += dx / distance * step; out.z += dz / distance * step; }
        seconds -= step / speed;
        if (step < travel || seconds <= 0) break;
        if (final) {
          const turn = Math.atan2(Math.sin(job.targetHeading - facing), Math.cos(job.targetHeading - facing));
          const duration = Math.abs(turn) / LAB_TURN_SPEED;
          if (seconds < duration) { out.heading += Math.sign(turn) * seconds * LAB_TURN_SPEED; break; }
          seconds -= duration; out.heading = job.targetHeading;
          step = Math.min(approach, seconds * speed);
          if (distance > 0) { out.x += dx / distance * step; out.z += dz / distance * step; }
          seconds -= step / speed;
          if (step < approach) break;
        }
        out.x = job.path[at]; out.y = job.path[at + 1]; out.z = job.path[at + 2];
        if (fixed && i + 1 === job.pathCount && !job.pathPartial && !job.yielding && e.route !== "exit") {
          const turn = Math.atan2(Math.sin(job.targetHeading - out.heading), Math.cos(job.targetHeading - out.heading));
          const duration = Math.abs(turn) / LAB_TURN_SPEED;
          if (seconds < duration) { out.heading += Math.sign(turn) * seconds * LAB_TURN_SPEED; break; }
          seconds -= duration; out.heading = job.targetHeading;
        }
      }
      return out;
    };
    // Surface NPCs reserve their trunks against peers, leaving arms and
    // shoulders free to overlap. Player movement keeps centre clearance.
    const occupied = (e, x, y, z, destinations = true, heading = e.heading) => {
      // Workers pass companions through the entrance and shared lab aisles.
      // Equipment claims keep their work positions distinct; scenery stays solid.
      if (enteringCave(e) || labWorker(e)) return false;
      const start = e.root.position;
      // A crowded aisle must not pin a controlled jump at its current XZ.
      // Horizontal movement still checks every peer below.
      if (e.controlled && e.motion.lab && e.drive.airborne && x === start.x && z === start.z) return false;
      if (!e.motion.lab && !e.planningLabTraffic && !e.climb.active) {
        for (let i = 0; i < list.length; i++) {
          const other = list[i];
          if (other === e || !other.active) continue;
          const p = other.root.position, dx = x - p.x, dz = z - p.z;
          if (!e.controlled) {
            const shape = torso || footprint;
            if (shape.overlaps(e, x, y, z, heading, other, p.x, p.y, p.z, other.heading, SPACE)
              && !shape.separates(e, start.x, start.y, start.z, e.heading, x, y, z, heading,
                other, p.x, p.y, p.z, other.heading, SPACE)) return true;
            continue;
          }
          const distance2 = dx * dx + dz * dz;
          if (Math.abs(y - p.y) < 1.2 && distance2 < 0.04
            && distance2 < (start.x - p.x) ** 2 + (start.z - p.z) ** 2 - 1e-6) return true;
        }
        return false;
      }
      for (let i = 0; i < list.length; i++) {
        const other = list[i];
        if (other === e || !other.active) continue;
        const p = e.planningLabTraffic ? labFuture(other, e.labPlanTime, labFuturePoint) : other.root.position;
        const otherHeading = e.planningLabTraffic ? p.heading : other.heading;
        const margin = e.motion.lab || other.motion.lab ? 0.03 : SPACE, radius = e.radius + other.radius + margin;
        const shape = peerShape(x, y, z, p.x, p.y, p.z);
        if (shape.overlaps(e, x, y, z, heading, other, p.x, p.y, p.z, otherHeading, margin)
          && (e.planningLabTraffic || !shape.separates(e, start.x, start.y, start.z, e.heading, x, y, z, heading,
            other, p.x, p.y, p.z, otherHeading, margin))) {
          if (e.planningLabTraffic) {
            const departing = other.motion.lab && !other.controlled && !other.fire.burning && other !== labEscape && !other.lab.arrived;
            e.labTrafficBlocked = other.motion.lab && !other.controlled && !other.fire.burning && other !== labEscape
              && other.lab.pathCount > 0 && (!other.lab.arrived || other.lab.yielding);
            // Fair planner admission takes more than one frame. A coworker
            // already assigned to leave is pending traffic even before its
            // retained route exists; don't mistake that brief queue for a jam.
            if (departing && Math.hypot(other.slotX - other.root.position.x, other.slotZ - other.root.position.z) > 0.1) e.labPendingTraffic = true;
          }
          return true;
        }
        if (destinations && other.climb.active && climbClaimOccupied(e, x, y, z, heading, other)) return true;
        if (destinations && other.jump.active) {
          const jump = other.jump, dx = jump.toX - jump.fromX, dz = jump.toZ - jump.fromZ, length2 = dx * dx + dz * dz;
          const t = length2 ? clamp(((x - jump.fromX) * dx + (z - jump.fromZ) * dz) / length2, 0, 1) : 0;
          const nearX = jump.fromX + dx * t, nearZ = jump.fromZ + dz * t;
          if (y < Math.max(jump.fromY, jump.toY) + jump.lift + other.height && y + e.height > Math.min(jump.fromY, jump.toY)
            && (x - nearX) ** 2 + (z - nearZ) ** 2 < radius * radius) return true;
        }
      }
      return false;
    };
    const expandGesture = (e, radius) => {
      const previous = e.radius, height = e.height, compact = e.compact, mode = e.footprintMode, p = e.root.position;
      e.footprintMode = radius >= 2.25 ? "pound" : "walk";
      e.compact = e.footprintMode === "pound" ? e.gorilla.poundCompact : e.gorilla.compact;
      e.radius = Math.max(previous, radius);
      e.height = Math.max(height, 2.6);
      if (staticClear(e, p.x, p.y, p.z) && !occupied(e, p.x, p.y, p.z)) return true;
      e.radius = previous; e.height = height; e.compact = compact; e.footprintMode = mode; return false;
    };
    const reserved = (e, x, z, heading = sites[e.site].mouth.ry) => {
      for (let i = 0; i < list.length; i++) {
        const other = list[i];
        if (other === e || !other.active || !other.hasSlot || other.site !== e.site) continue;
        // Interior staging is not a claim on nearby keyboards or benches.
        if (e.site === labSite && other.lab.station < 0) continue;
        const station = other.site === labSite && labStations[other.lab.station];
        const compact = other.compact, mode = other.footprintMode, work = other.planningLabWork;
        if (station) { other.compact = other.planningLab = true; other.footprintMode = "lab"; other.planningLabWork = station.kind; }
        const shape = peerShape(x, sites[e.site].mouth.floorY, z, other.slotX, other.slotY, other.slotZ);
        const overlaps = shape.overlaps(e, x, sites[e.site].mouth.floorY, z, heading,
          other, other.slotX, other.slotY, other.slotZ, station ? station.heading : sites[e.site].mouth.ry, SPACE);
        other.compact = compact; other.footprintMode = mode; other.planningLab = false; other.planningLabWork = work;
        if (overlaps) return true;
      }
      return false;
    };
    const sitePoint = (site, x, z, out) => {
      out.x = site.mouth.x + site.cr * x + site.sr * z;
      out.y = site.mouth.floorY;
      out.z = site.mouth.z - site.sr * x + site.cr * z;
      return out;
    };
    const mirrorWorkClear = (e, x, z, nx, nz) => {
      const site = e.site >= 0 ? sites[e.site] : null;
      if (!site?.mirrorRoom || e.route === "exit") return true;
      const m = site.mouth;
      const along = (x - m.x) * site.sr + (z - m.z) * site.cr;
      return along > MIRROR_WORK_LIMIT
        || (nx - m.x) * site.sr + (nz - m.z) * site.cr <= MIRROR_WORK_LIMIT;
    };
    const insideLab = (x, y, z) => labSite >= 0 && (ctx.labInside ? ctx.labInside(x, y, z) : caveAt(x, y, z) === labSite);
    const releaseLab = (e) => {
      if (e.lab.item >= 0 && ctx.labReturn) ctx.labReturn(e);
      e.lab.item = e.lab.pickup = -1; e.lab.stage = ""; e.lab.station = -1; e.lab.time = e.lab.reach = 0; e.lab.arrived = false;
      e.lab.yielding = 0; e.lab.yieldFor = null; e.lab.yieldReady = false; e.lab.pathPending = e.lab.pathPartial = false; e.lab.squeezeUntil = 0;
      e.lab.coordinationUntil = e.lab.trafficWait = 0;
      e.lab.pathCount = e.lab.pathIndex = 0; e.motion.labWork = ""; e.motion.labReach = 0; e.motion.labSqueeze = false;
      e.motion.labDie = false; e.motion.labRoll = 0;
      e.motion.labBench = null;
    };
    const syncLab = (e) => {
      const p = e.root.position, raging = e.rage.active;
      // Location still supplies collision geometry, but rage owns the pose
      // and job until it ends, including while crossing the lab threshold.
      const inside = !raging && insideLab(p.x, p.y, p.z), wasInside = e.motion.lab;
      e.motion.rage = raging;
      e.motion.lab = inside;
      e.motion.labRunIn = !raging && e.route === "enter" && e.site === labSite && !e.entryTurn;
      e.motion.labSqueeze = false;
      if (raging) e.biped = false;
      if (inside) {
        e.parked = false; e.biped = !e.motion.labRunIn; e.lounge = "";
        if (!wasInside && !e.controlled && !e.actionControlled) e.pound = e.beat = e.stand = e.recover = 0;
      } else if (wasInside) {
        e.biped = false;
        e.motion.labWork = "";
        if (!e.lab.yielding && (e.phase !== "travel" || e.site !== labSite)) releaseLab(e);
      }
      if (e.controlled || e.fire.rolling || e.climb.active || e.jump.active || e.drive.airborne || e.pound || e.beat || e.recover) e.motion.labWork = "";
    };
    const labEnvelope = (e) => {
      if (!e.motion.lab || e.motion.labRunIn || e.climb.active || e.jump.active || e.drive.airborne || e.fire.rolling || e.fire.rollRecover
        || e.drive.motionRecover || e.pound || e.beat || e.recover || e.motion.smash || e.gorilla.smashActive) return false;
      e.biped = true; e.footprintMode = "lab"; e.compact = !!(e.gorilla.labIdleCompact || e.gorilla.labWalkCompact || e.gorilla.labCompact);
      e.radius = Math.max(BL.agent.LAB_RADIUS || 1.1, e.gorilla.bodyRadius + 0.04);
      e.height = Math.max(BL.agent.LAB_HEIGHT || 2.8, e.gorilla.bodyHeight + 0.04);
      return true;
    };
    const labProof = (index, e, x, y, z, nx, ny, nz, fromHeading, toHeading) => {
      const cached = labGeometry[index];
      if (cached) return cached === 1;
      const fits = staticClear(e, x, y, z, nx, ny, nz, fromHeading, toHeading);
      if (index < labGeometry.length) labGeometry[index] = fits ? 1 : 2;
      return fits;
    };
    const labSegment = (e, ax, ay, az, bx, by, bz, heading, fromHeading = heading, final = false, fixed = false, startAt = 0, wait = 0, reuse = false) => {
      const distance = Math.hypot(bx - ax, bz - az);
      const travelHeading = Math.atan2(bx - ax, bz - az);
      let px = ax, py = ay, pz = az, facing = fromHeading, time = startAt, proof = 0;
      // A time shift changes peers, never this edge's scenery or turn poses.
      // Reuse successful static samples across its bounded wait alternatives.
      if (!reuse) labGeometry.fill(0);
      e.labTrafficBlocked = false;
      // Waiting is a reservation too: never wait in another worker's path.
      for (let t = 0; t < wait; t += 0.2) {
        e.labPlanTime = startAt + t;
        if (occupied(e, ax, ay, az, true, facing)) return false;
      }
      time += wait;
      let travelled = 0;
      do {
        // Match moveLab: face the route while travelling, then face the bench
        // only on its final approach. A sideways endpoint pose cannot prove a
        // long forward walk beside a cabinet, nor an obstructed starting turn.
        const remaining = distance - travelled;
        const desired = fixed ? fromHeading : final && remaining <= 0.800001 ? heading : travelHeading;
        const turn = Math.atan2(Math.sin(desired - facing), Math.cos(desired - facing));
        const turns = Math.ceil(Math.abs(turn) / 0.2);
        for (let n = 1; n <= turns; n++) {
          const angle = facing + turn * n / turns;
          e.labPlanTime = time + Math.abs(turn) * n / turns / LAB_TURN_SPEED;
          if (occupied(e, px, py, pz, true, angle)
            || !labProof(proof, e, px, py, pz, px, py, pz, angle, angle)) return false;
          proof++;
        }
        time += Math.abs(turn) / LAB_TURN_SPEED;
        facing = desired;
        const step = Math.min(0.3, remaining, final && !fixed && remaining > 0.800001 ? remaining - 0.8 : remaining);
        travelled += step;
        const k = distance ? travelled / distance : 1, x = ax + (bx - ax) * k, y = ay + (by - ay) * k, z = az + (bz - az) * k;
        time += step / labSpeed(e); e.labPlanTime = time;
        if (occupied(e, x, y, z, true, facing)
          || !labProof(proof, e, fixed ? px : x, fixed ? py : y, fixed ? pz : z, x, y, z, facing, facing)) return false;
        proof++;
        px = x; py = y; pz = z;
      } while (travelled < distance - 1e-8);
      // A backward or sideways aisle leg keeps its original facing. Prove the
      // final workstation turn here, after the body has cleared the aisle.
      if (fixed && final) {
        const turn = Math.atan2(Math.sin(heading - facing), Math.cos(heading - facing));
        const turns = Math.ceil(Math.abs(turn) / 0.2);
        for (let i = 1; i <= turns; i++) {
          const angle = facing + turn * i / turns;
          e.labPlanTime = time + Math.abs(turn) * i / turns / LAB_TURN_SPEED;
          if (occupied(e, bx, by, bz, true, angle)
            || !labProof(proof, e, bx, by, bz, bx, by, bz, facing + turn * (i - 1) / turns, angle)) return false;
          proof++;
        }
        time += Math.abs(turn) / LAB_TURN_SPEED;
      }
      e.labPlanTime = time;
      return true;
    };
    const labStageClear = (e, index, tx, tz) => {
      const at = index * 3, x = labNodes[at], y = labNodes[at + 1], z = labNodes[at + 2], heading = labHeadings[index];
      const site = sites[labSite], p = e.root.position;
      const along = (tx - p.x) * site.sr + (tz - p.z) * site.cr;
      const across = (x - site.mouth.x) * site.cr - (z - site.mouth.z) * site.sr;
      // A stopped torso in the centre blocks BOTH passing lanes. Opposing
      // trips stage on opposite sides, leaving their coworker's lane open.
      if (Math.abs(along) > 0.4 && across * Math.sign(along) < 0.35) return false;
      // Vacating a desk by less than a torso width does not actually release
      // it. Keep staging pockets clear of every coworker's claimed job too.
      for (const other of list) {
        const station = labStations[other.lab.station];
        if (other === e || !other.active || other.site !== labSite || !station) continue;
        if (torso.overlaps(e, x, y, z, heading, other, other.slotX, other.slotY, other.slotZ, station.heading, 0.08)) return false;
      }
      for (let t = 0; t <= 2; t += 0.2) {
        e.labPlanTime = labTimes[index] + t;
        if (occupied(e, x, y, z, true, heading)) return false;
      }
      return true;
    };
    const labExitTrafficClear = (e, x, y, z) => {
      const p = e.root.position, dx = x - p.x, dz = z - p.z, length2 = dx * dx + dz * dz;
      for (const other of list) {
        if (other === e || !other.active || Math.abs(other.root.position.y - y) > 1) continue;
        const q = other.root.position;
        const k = length2 ? clamp(((q.x - p.x) * dx + (q.z - p.z) * dz) / length2, 0, 1) : 0;
        const future = labFuture(other, Math.sqrt(length2) * k / labSpeed(e), labFuturePoint);
        const t = length2 ? clamp(((future.x - p.x) * dx + (future.z - p.z) * dz) / length2, 0, 1) : 0;
        if (Math.hypot(future.x - p.x - dx * t, future.z - p.z - dz * t) < 1.5) return false;
      }
      return true;
    };
    // A small shared roadmap covers the gaps between the three workstation
    // rows. Each route owns only its retained points; searching never allocates.
    const planLabPath = (e, tx, ty, tz, heading, partial = false) => {
      e.lab.pathPending = true;
      if (!labRouteBudget || labRouteTurn >= 0 && labRouteTurn !== e.index) return false;
      labRouteBudget--; e.lab.pathPending = false; e.lab.plans++; labRouteNext = (e.index + 1) % list.length;
      const p = e.root.position, job = e.lab, site = sites[labSite];
      const staged = job.pathPartial && job.targetX === tx && job.targetZ === tz;
      const radius = e.radius, height = e.height, compact = e.compact, mode = e.footprintMode;
      const planning = e.planningLab, work = e.planningLabWork, squeeze = e.motion.labSqueeze, speed = e.speed;
      const carrying = !!e.gorilla.labItem;
      const departure = (carrying ? e.gorilla.labCompact : e.gorilla.labWalkCompact) ? 0 : 0.4;
      const travelSpeed = labSpeed(e);
      e.radius = carrying ? BL.agent.LAB_RADIUS : BL.agent.LAB_WALK_RADIUS; e.height = BL.agent.LAB_HEIGHT; e.speed = travelSpeed;
      e.compact = e.planningLab = e.planningLabTraffic = true; e.footprintMode = "lab"; e.planningLabWork = carrying ? "carry" : "";
      e.labPendingTraffic = false;
      e.motion.labSqueeze = false;
      labNodes[0] = p.x; labNodes[1] = p.y; labNodes[2] = p.z;
      labHeadings[0] = e.heading;
      labNodes[3] = tx; labNodes[4] = ty; labNodes[5] = tz;
      let count = 2;
      // A bench can prevent the first turn without blocking a small step back.
      // Include that local clearance before the shared aisle points so a long
      // trip can turn promptly rather than reverse to the far workstation.
      for (let i = 0; i < 2; i++) {
        const at = count++ * 3, back = 0.65 + i * 0.4;
        labNodes[at] = p.x - Math.sin(e.heading) * back; labNodes[at + 1] = p.y;
        labNodes[at + 2] = p.z - Math.cos(e.heading) * back;
      }
      for (const z of LAB_ROUTE_Z) for (const x of LAB_ROUTE_X) {
        const at = count++ * 3;
        sitePoint(site, x, z, POINT); labNodes[at] = POINT.x; labNodes[at + 1] = POINT.y; labNodes[at + 2] = POINT.z;
      }
      // Prefer the authored facing-right aisle and avoid coworkers' predicted
      // crossings. These are costs, not locks: traffic never closes a safe
      // scenery route, and a stationary scientist cannot trap an exit.
      for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
        const a = i * 3, b = j * 3;
        const dx = labNodes[b] - labNodes[a], dz = labNodes[b + 2] - labNodes[a + 2];
        const distance = Math.hypot(dx, dz), x = (labNodes[a] + labNodes[b]) * 0.5;
        const y = (labNodes[a + 1] + labNodes[b + 1]) * 0.5, z = (labNodes[a + 2] + labNodes[b + 2]) * 0.5;
        const along = dx * site.sr + dz * site.cr;
        const across = (x - site.mouth.x) * site.cr - (z - site.mouth.z) * site.sr;
        let penalty = Math.abs(along) > 0.4 ? distance * Math.max(0, 0.55 - across * Math.sign(along)) : 0;
        for (const other of list) {
          if (other === e || !other.active || !other.motion.lab) continue;
          const q = labFuture(other, Math.hypot(labNodes[a] - p.x, labNodes[a + 2] - p.z) / travelSpeed + distance / (travelSpeed * 2), labFuturePoint);
          if (Math.abs(q.y - y) > 1) continue;
          penalty += Math.max(0, 1.5 - Math.hypot(q.x - x, q.z - z)) * 2;
        }
        labPenalties[i * 16 + j] = penalty;
      }
      // Peer arms may pass, but every route still fits the natural gait against
      // cabinets, benches and stone. There is no smaller passing animation.
      job.pathFixed = false; job.pathHeading = e.heading;
      const dx = tx - p.x, dz = tz - p.z, distance = Math.hypot(dx, dz);
      const sameFacing = Math.abs(Math.atan2(Math.sin(heading - e.heading), Math.cos(heading - e.heading))) < 0.35;
      const sideways = sameFacing && distance < 2.6 && Math.abs(dx * Math.sin(e.heading) + dz * Math.cos(e.heading)) < distance * 0.45;
      // Neighbouring jobs on one bench need a shuffle along it, not a detour
      // into the aisle just to face the direction of a short sideways step.
      let directSide = false, sideWait = 0, traffic = false;
      e.speed = sideways && dx * Math.sin(e.heading) + dz * Math.cos(e.heading) < 0 ? -travelSpeed : travelSpeed;
      if (sideways) for (; sideWait <= 2; sideWait += 0.5) {
        if (labSegment(e, p.x, p.y, p.z, tx, ty, tz, heading, e.heading, true, true, 0, sideWait + departure, sideWait > 0)) { directSide = true; break; }
        if (!e.labTrafficBlocked) break;
        traffic = true;
      }
      // An empty exit aisle takes the shortest proven route. Lane costs are
      // only useful when there is traffic, not for detouring a lone departure.
      const directExit = e.route === "exit" && !directSide && labExitTrafficClear(e, tx, ty, tz)
        && labSegment(e, p.x, p.y, p.z, tx, ty, tz, heading, e.heading, false, false, 0, departure);
      labPrevious.fill(-1); labPrevious[0] = 0; labCosts.fill(Infinity); labCosts[0] = 0;
      labQueue.fill(0); labQueue[0] = 1; labTimes[0] = 0; labEdges.fill(0);
      if (directSide) { labPrevious[1] = 0; labHeadings[1] = e.heading; labFixed[1] = 1; labWaits[1] = sideWait; }
      if (directExit) { labPrevious[1] = 0; labHeadings[1] = Math.atan2(dx, dz); labFixed[1] = labWaits[1] = 0; }
      // Validate promising edges lazily. The Euclidean lower bound orders the
      // frontier; a costly full-rig proof runs only when that edge could improve
      // the best route, rather than for every neighbour of every visited node.
      e.labPlanTime = 8;
      const blockedEnd = partial && !staged && occupied(e, tx, ty, tz, true, heading) && !e.labTrafficBlocked;
      let stagedAt = -1;
      for (let visit = 0; !directSide && !directExit && visit < count * count * 4; visit++) {
        let from = -1, next = -1, fixed = false, edge = -1, cost = Infinity, estimate = Infinity;
        for (let i = 0; i < count; i++) if (labQueue[i]) {
          const a = i * 3;
          for (let j = 1; j < count; j++) {
            if (labQueue[j] || blockedEnd && j === 1) continue;
            const b = j * 3, dx = labNodes[b] - labNodes[a], dz = labNodes[b + 2] - labNodes[a + 2];
            const length = Math.hypot(dx, dz), remaining = Math.hypot(tx - labNodes[b], tz - labNodes[b + 2]);
            if (length < 0.01) continue;
            for (let mode = 0; mode < 2; mode++) {
              if (mode && (length > 1.1 || i && labFixed[i])) continue;
              const id = (i * 16 + j) * 2 + mode, state = labEdges[id];
              if (state === 1) continue;
              const turn = mode ? 0 : Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dz) - labHeadings[i]), Math.cos(Math.atan2(dx, dz) - labHeadings[i])));
              const candidate = labCosts[i] + length * (mode ? 2 : 1) + turn * 0.18 + labPenalties[i * 16 + j]
                + (state === 2 ? labEdgeWaits[id] * travelSpeed : 0);
              if (candidate + remaining < estimate) { from = i; next = j; fixed = !!mode; edge = id; cost = candidate; estimate = candidate + remaining; }
            }
          }
        }
        if (from < 0) break;
        const a = from * 3, b = next * 3, dx = labNodes[b] - labNodes[a], dz = labNodes[b + 2] - labNodes[a + 2];
        const facing = next === 1 ? heading : Math.atan2(dx, dz);
        if (labEdges[edge] === 0) {
          labEdges[edge] = 1;
          e.speed = fixed && dx * Math.sin(labHeadings[from]) + dz * Math.cos(labHeadings[from]) < 0 ? -travelSpeed : travelSpeed;
          for (let delay = 0; delay <= 2; delay += 0.5) {
            if (labSegment(e, labNodes[a], labNodes[a + 1], labNodes[a + 2], labNodes[b], labNodes[b + 1], labNodes[b + 2], facing,
              labHeadings[from], next === 1 && !job.yielding && e.route !== "exit", fixed, labTimes[from], delay + (from === 0 ? departure : 0), delay > 0)) {
              labEdges[edge] = 2; labEdgeTimes[edge] = e.labPlanTime; labEdgeWaits[edge] = delay; break;
            }
            if (!e.labTrafficBlocked) break;
            traffic = true;
          }
          continue;
        }
        labCosts[next] = cost; labTimes[next] = labEdgeTimes[edge]; labWaits[next] = labEdgeWaits[edge];
        labHeadings[next] = fixed ? labHeadings[from] : facing; labFixed[next] = +fixed;
        labPrevious[next] = from; labQueue[next] = 1;
        if (next === 1) break;
        if (blockedEnd && Math.hypot(labNodes[b] - p.x, labNodes[b + 2] - p.z) >= 0.35) {
          if (labStageClear(e, next, tx, tz)) { stagedAt = next; break; }
        }
      }
      let at = labPrevious[1] >= 0 ? 1 : stagedAt;
      if (at < 0 && partial && !staged) {
        let nearest = Infinity;
        for (let i = 2; i < count; i++) {
          if (labPrevious[i] < 0) continue;
          const j = i * 3, distance = labCosts[i] + Math.hypot(tx - labNodes[j], tz - labNodes[j + 2]);
          if (Math.hypot(labNodes[j] - p.x, labNodes[j + 2] - p.z) < 0.35 || distance >= nearest) continue;
          if (labStageClear(e, i, tx, tz)) { nearest = distance; at = i; }
        }
      }
      e.radius = radius; e.height = height; e.compact = compact; e.footprintMode = mode;
      e.planningLab = planning; e.planningLabTraffic = false; e.planningLabWork = work; e.motion.labSqueeze = squeeze; e.speed = speed;
      job.pathCount = job.pathIndex = 0; job.pathAt = elapsed + 0.65;
      job.targetX = tx; job.targetY = ty; job.targetZ = tz; job.targetHeading = heading;
      if (at < 0) {
        // Let a known reservation advance before treating admission delay as
        // a stall. This deadline is set once, never renewed by failed retries.
        if ((traffic || e.labPendingTraffic) && !job.trafficWait) job.trafficWait = elapsed + 1.2;
        return false;
      }
      job.pathPartial = at !== 1;
      while (at) { labQueue[job.pathCount++] = at; at = labPrevious[at]; }
      for (let i = 0; i < job.pathCount; i++) {
        const index = labQueue[job.pathCount - 1 - i], from = index * 3, to = i * 3;
        job.path[to] = labNodes[from]; job.path[to + 1] = labNodes[from + 1]; job.path[to + 2] = labNodes[from + 2];
        job.pathFacings[i] = labFixed[index] ? labHeadings[index] : NaN; job.pathWaits[i] = labWaits[index];
      }
      job.readyAt = elapsed + departure + job.pathWaits[0];
      job.pathFixed = Number.isFinite(job.pathFacings[0]);
      job.pathHeading = job.pathFixed ? job.pathFacings[0] : e.heading;
      return true;
    };
    const labGoal = (e, x, y, z, heading, partial = false) => {
      const job = e.lab, p = e.root.position;
      if (job.targetX !== x || job.targetY !== y || job.targetZ !== z) {
        job.pathCount = job.pathIndex = 0; job.pathAt = job.coordinationUntil = job.trafficWait = 0; job.pathPartial = false;
      }
      if (job.pathPartial && job.pathCount && job.pathIndex + 1 === job.pathCount) {
        const end = job.pathIndex * 3;
        if (Math.hypot(job.path[end] - p.x, job.path[end + 2] - p.z) < 0.003) {
          job.pathCount = job.pathIndex = 0; job.pathAt = 0; job.coordinationUntil = elapsed + 2;
        }
      }
      if (job.pathIndex >= job.pathCount) {
        if (elapsed < job.pathAt || !planLabPath(e, x, y, z, heading, partial)) return false;
      }
      let at = job.pathIndex * 3;
      // Turns are checked at the waypoint itself. Cutting a corner early can
      // shift the next leg into a desk even though the planned route is clear.
      if (Math.hypot(job.path[at] - p.x, job.path[at + 2] - p.z) < 0.003 && job.pathIndex + 1 < job.pathCount) {
        at = ++job.pathIndex * 3; job.readyAt = elapsed + job.pathWaits[job.pathIndex];
      }
      job.pathFixed = Number.isFinite(job.pathFacings[job.pathIndex]);
      if (job.pathFixed) job.pathHeading = job.pathFacings[job.pathIndex];
      setGoal(e, job.path[at], job.path[at + 1], job.path[at + 2]);
      if (e.blocked > 0.4) { job.pathCount = job.pathIndex = 0; job.pathAt = elapsed + 0.2; }
      return true;
    };
    const ordinaryLabStep = (e, x, y, z, heading, speed, separating = false) => {
      const p = e.root.position, radius = e.radius, height = e.height, compact = e.compact, mode = e.footprintMode;
      const planning = e.planningLab, work = e.planningLabWork, squeeze = e.motion.labSqueeze, previousSpeed = e.speed;
      e.radius = BL.agent.LAB_WALK_RADIUS; e.height = BL.agent.LAB_HEIGHT;
      e.compact = e.planningLab = true; e.footprintMode = "lab"; e.planningLabWork = "";
      e.motion.labSqueeze = false; e.speed = speed;
      // Check the natural walking pose against scenery at both ends before
      // opening the shoulders from a stationary workstation pose.
      const fits = (separating || !occupied(e, p.x, p.y, p.z)) && !occupied(e, x, y, z, true, heading)
        && staticClear(e, p.x, p.y, p.z) && staticClear(e, p.x, p.y, p.z, x, y, z, e.heading, heading);
      e.radius = radius; e.height = height; e.compact = compact; e.footprintMode = mode;
      e.planningLab = planning; e.planningLabWork = work; e.motion.labSqueeze = squeeze; e.speed = previousSpeed;
      return fits;
    };
    const beginLabEscape = (e) => {
      if (labEscape || !e.motion.lab || e.lab.item >= 0) return false;
      const p = e.root.position, s = e.stuck;
      const station = labStations[e.lab.station];
      const targetX = station ? station.x : e.goalX, targetZ = station ? station.z : e.goalZ;
      const startDistance = Math.hypot(targetX - p.x, targetZ - p.z);
      let awayX = 0, awayZ = 0;
      for (const other of list) {
        if (other === e || !other.active || !other.motion.lab) continue;
        const q = other.root.position, dx = p.x - q.x, dz = p.z - q.z, d2 = dx * dx + dz * dz;
        if (d2 < 9) { awayX += dx / Math.max(0.1, d2); awayZ += dz / Math.max(0.1, d2); }
      }
      const away = Math.hypot(awayX, awayZ) > 0.01 ? Math.atan2(awayX, awayZ) : e.heading + Math.PI;
      let best = -Infinity;
      // A short translation with the current facing fits beside a desk even
      // when turning toward a distant roadmap point would swing into it.
      // Only one stalled worker retreats at a time; the others keep its space.
      for (let ring = 0; ring < 3; ring++) for (let side = 0; side < 8; side++) {
        const angle = away + (side % 2 ? 1 : -1) * Math.ceil(side / 2) * Math.PI / 4, distance = 0.45 + ring * 0.35;
        const x = p.x + Math.sin(angle) * distance, z = p.z + Math.cos(angle) * distance;
        const speed = Math.cos(angle - e.heading) < 0 ? -0.9 : 0.9;
        if (!insideLab(x, p.y, z) || !ordinaryLabStep(e, x, p.y, z, e.heading, speed, true)) continue;
        let gap = 3;
        for (const other of list) {
          if (other === e || !other.active || !other.motion.lab) continue;
          gap = Math.min(gap, Math.hypot(x - other.root.position.x, z - other.root.position.z));
        }
        const score = gap * 0.35 + (startDistance - Math.hypot(targetX - x, targetZ - z));
        if (score > best) { best = score; s.escapeX = x; s.escapeZ = z; }
      }
      if (!Number.isFinite(best)) return false;
      s.escapeLeft = 1.8; s.escapeBlocked = 0; s.escapes++; labEscape = e;
      e.motion.labWork = ""; e.motion.labReach = 0; e.blocked = 0;
      return true;
    };
    const stepLabEscape = (e, dt) => {
      const s = e.stuck, p = e.root.position;
      if (labEscape !== e) return false;
      s.escapeLeft -= dt;
      const dx = s.escapeX - p.x, dz = s.escapeZ - p.z, distance = Math.hypot(dx, dz);
      if (s.escapeLeft <= 0 || s.escapeBlocked > 0.3 || distance < 0.015 || !e.motion.lab || e.controlled || e.lab.item >= 0) {
        labEscape = null; s.escapeLeft = 0; e.lab.pathCount = e.lab.pathIndex = 0; e.lab.pathAt = 0;
        s.retryAt = elapsed + 0.5;
        e.blocked = 0; return false;
      }
      e.motion.labWork = ""; e.motion.labReach = 0;
      const step = Math.min(distance, 0.9 * dt), x = p.x + dx / distance * step, z = p.z + dz / distance * step;
      const speed = dx * Math.sin(e.heading) + dz * Math.cos(e.heading) < 0 ? -0.9 : 0.9;
      e.speed = speed;
      labEnvelope(e);
      if (e.gorilla.labWalkCompact && ordinaryLabStep(e, x, p.y, z, e.heading, speed, true)
        && !occupied(e, x, p.y, z, true, e.heading) && staticClear(e, p.x, p.y, p.z, x, p.y, z)) {
        p.x = x; p.z = z; s.escapeBlocked = 0;
      } else { e.speed = 0; s.escapeBlocked += dt; }
      return true;
    };
    const moveLab = (e, dt, speed = labSpeed(e)) => {
      const p = e.root.position, dx = e.goalX - p.x, dz = e.goalZ - p.z, distance = Math.hypot(dx, dz);
      const carrying = !!e.gorilla.labItem;
      e.motion.labSqueeze = false;
      e.motion.labWork = carrying ? "carry" : "";
      if (!carrying) e.motion.labReach = 0;
      if (!distance) { e.speed = 0; return; }
      if (e.lab.pathCount && elapsed < e.lab.readyAt) { e.speed = 0; e.blocked = 0; return; }
      const station = labStations[e.lab.station];
      const fixed = e.lab.pathFixed && e.lab.pathCount;
      const final = e.entryTurn !== 1 && !e.lab.yielding && !e.lab.pathPartial && e.route !== "exit" && station && e.lab.pathIndex + 1 >= e.lab.pathCount;
      const desired = fixed ? e.lab.pathHeading
        : final && distance <= 0.800001
        ? station.heading : Math.atan2(dx, dz);
      const turn = Math.atan2(Math.sin(desired - e.heading), Math.cos(desired - e.heading));
      const heading = e.heading + clamp(turn, -dt * LAB_TURN_SPEED, dt * LAB_TURN_SPEED);
      // Clear the starting turn before committing to a forward walk. A fixed
      // departure or short bench shuffle intentionally keeps its facing.
      const step = !fixed && Math.abs(turn) > dt * LAB_TURN_SPEED ? 0
        : Math.min(distance, speed * dt, final && !fixed && distance > 0.800001 ? distance - 0.8 : distance);
      const x = p.x + dx / distance * step, z = p.z + dz / distance * step;
      const walkingSpeed = (dx * Math.sin(heading) + dz * Math.cos(heading) < 0 ? -1 : 1) * speed;
      if (carrying) {
        // A displaced inspector must reach its bench before yielding. The real
        // held vessel cannot fit the empty-handed shuffle; retain its full pose.
        e.motion.labSqueeze = false;
        if (!e.gorilla.labCompact) { e.speed = 0; return; }
      } else {
        if (!e.gorilla.labWalkCompact) { e.speed = 0; return; }
        if (!ordinaryLabStep(e, x, p.y, z, heading, walkingSpeed)) {
          e.speed = 0; e.blocked += dt;
          if (heading !== e.heading && ordinaryLabStep(e, p.x, p.y, p.z, heading, walkingSpeed)) e.heading = heading;
          return;
        }
      }
      e.speed = walkingSpeed;
      labEnvelope(e);
      if (occupied(e, x, p.y, z, true, heading) || !staticClear(e, p.x, p.y, p.z, x, p.y, z, e.heading, heading)) {
        // A bench can block the translating arc while leaving room to turn
        // into the final approach. Validate that stationary turn separately.
        e.speed = 0;
        if (heading !== e.heading && !occupied(e, p.x, p.y, p.z, true, heading)
          && staticClear(e, p.x, p.y, p.z, p.x, p.y, p.z, e.heading, heading)) e.heading = heading;
        e.blocked += dt; return;
      }
      p.x = x; p.z = z; e.heading = heading;
      if (step > 0) e.lab.trafficWait = 0;
      e.speed = step / dt * (dx * Math.sin(heading) + dz * Math.cos(heading) < 0 ? -1 : 1); e.blocked = 0;
    };
    const requestLabPass = (requester, tx, tz) => {
      if (enteringCave(requester) || labWorker(requester) || elapsed < labPassAt || labSite < 0) return false;
      // Ask for clearance along the route actually being walked. The straight
      // chord to a distant workstation may cross an unrelated occupied desk.
      if (requester.lab.pathCount) {
        const at = requester.lab.pathIndex * 3;
        tx = requester.lab.path[at]; tz = requester.lab.path[at + 2];
      }
      const p = requester.root.position, dx = tx - p.x, dz = tz - p.z, length2 = dx * dx + dz * dz;
      let nearest = Infinity, blocker = null;
      for (let i = 0; i < list.length; i++) {
        const other = list[i], q = other.root.position;
        if (other === requester || !other.active || other.controlled || other === labEscape || other.site !== labSite || other.phase !== "work"
          || other.lab.yielding || !other.motion.lab || other.climb.active || other.fire.rolling) continue;
        // A worker already following its reservation is about to clear this
        // space. Do not cancel that plan by asking it to yield mid-crossing.
        if (!other.lab.arrived && other.blocked < 0.4
          && (!other.lab.pathPartial || other.lab.pathCount || elapsed < other.lab.coordinationUntil)) continue;
        // A held-item return can itself need room. Never ask one of the
        // requester’s waiting ancestors to yield back and close a wait cycle.
        let dependency = requester, cyclic = false;
        for (let n = 0; dependency && n < list.length; n++) {
          if (dependency === other) { cyclic = true; break; }
          dependency = dependency.lab.yielding ? dependency.lab.yieldFor : null;
        }
        if (cyclic) continue;
        const projection = length2 ? ((q.x - p.x) * dx + (q.z - p.z) * dz) / length2 : 0;
        if (projection < -0.05) continue;
        const t = clamp(projection, 0, 1);
        const distance = Math.hypot(q.x - p.x, q.z - p.z);
        const shape = peerShape(p.x, p.y, p.z, q.x, q.y, q.z);
        const reach = shape.radius(requester) + shape.radius(other) + 0.03;
        if (distance > 4 || distance >= nearest || Math.hypot(q.x - p.x - dx * t, q.z - p.z - dz * t) > reach) continue;
        const heading = requester.lab.pathFixed && requester.lab.pathCount ? requester.lab.pathHeading : Math.atan2(dx, dz);
        if (shape.separates(requester, p.x, p.y, p.z, requester.heading, tx, p.y, tz, heading,
          other, q.x, q.y, q.z, other.heading, 0.03)) continue;
        blocker = other; nearest = distance;
      }
      if (!blocker) return false;
      labPassAt = elapsed + 0.45;
      const job = blocker.lab, site = sites[labSite], p0 = blocker.root.position;
      const across = (p0.x - site.mouth.x) * site.cr - (p0.z - site.mouth.z) * site.sr;
      const along = (p0.x - site.mouth.x) * site.sr + (p0.z - site.mouth.z) * site.cr;
      // Retract before selecting a real, reachable retreat. A fixed side point
      // can be inside the bench or still cover the requester's final approach.
      const side = across < 0 ? -1 : 1;
      job.yielding = 1; job.yieldFor = requester; job.yieldUntil = elapsed + 1;
      const length = Math.sqrt(length2) || 1; job.yieldDX = dx / length; job.yieldDZ = dz / length;
      job.yieldAlong = along; job.yieldChoice = 0; job.yieldReady = false;
      job.yieldTargetX = tx; job.yieldTargetZ = tz;
      job.yieldProgressX = p.x; job.yieldProgressZ = p.z; job.yieldProgressAt = elapsed;
      job.yieldSide = side; job.pathCount = job.pathIndex = 0; job.pathAt = 0;
      blocker.motion.labSqueeze = false;
      if (job.item >= 0) { job.stage = "return"; job.reach = 0; }
      return true;
    };
    const planLabYield = (e) => {
      const job = e.lab, p = e.root.position, point = job.yieldPoint, home = labStations[job.station];
      if (elapsed < job.pathAt) return false;
      const other = job.yieldFor, q = other && other.root.position;
      const radius = e.radius, height = e.height, compact = e.compact, mode = e.footprintMode;
      const planning = e.planningLab, work = e.planningLabWork, speed = e.speed;
      e.radius = BL.agent.LAB_WALK_RADIUS; e.height = BL.agent.LAB_HEIGHT;
      e.compact = e.planningLab = true; e.footprintMode = "lab"; e.planningLabWork = ""; e.speed = 0.65;
      let found = false;
      for (let n = 0; n < 8; n++) {
        const choice = job.yieldChoice % 8;
        if (choice === 0 && home) {
          point.x = home.x; point.y = home.y; point.z = home.z;
        } else {
          const shift = choice === 2 ? -0.8 : choice === 3 ? 0.8 : choice === 4 ? -0.8 : choice === 5 ? -1.6 : choice === 6 ? 1.6 : 0;
          const across = choice === 4 ? 0 : (choice === 7 ? -job.yieldSide : job.yieldSide) * LAB_ROUTE_X[2];
          sitePoint(sites[labSite], across, job.yieldAlong + shift, point);
        }
        point.heading = Math.atan2(point.x - p.x, point.z - p.z);
        let blocks = false;
        if (q) {
          const dx = job.yieldTargetX - q.x, dz = job.yieldTargetZ - q.z, length2 = dx * dx + dz * dz;
          const shape = peerShape(point.x, point.y, point.z, q.x, q.y, q.z);
          const reach = shape.radius(e) + shape.radius(other) + 0.03;
          for (let i = 0; i < shape.count(other); i++) {
            const offset = shape.offset(other, i), x = q.x + Math.sin(other.heading) * offset, z = q.z + Math.cos(other.heading) * offset;
            const k = length2 ? clamp(((point.x - x) * dx + (point.z - z) * dz) / length2, 0, 1) : 0;
            if ((point.x - x - dx * k) ** 2 + (point.z - z - dz * k) ** 2 < reach * reach) { blocks = true; break; }
          }
        }
        if (Math.hypot(point.x - p.x, point.z - p.z) < 0.08 || blocks || !insideLab(point.x, point.y, point.z)
          || occupied(e, point.x, point.y, point.z, true, point.heading)
          || !staticClear(e, point.x, point.y, point.z, point.x, point.y, point.z, point.heading, point.heading)) {
          job.yieldChoice++; continue;
        }
        found = true; break;
      }
      e.radius = radius; e.height = height; e.compact = compact; e.footprintMode = mode;
      e.planningLab = planning; e.planningLabWork = work; e.speed = speed;
      if (!found) { job.pathAt = elapsed + 0.5; return false; }
      if (!planLabPath(e, point.x, point.y, point.z, point.heading)) {
        if (!job.pathPending) job.yieldChoice++;
        return false;
      }
      job.yieldReady = true; e.blocked = 0;
      return true;
    };
    const yieldLab = (e, dt) => {
      const job = e.lab, p = e.root.position, point = job.yieldPoint;
      if (job.item >= 0) { workLab(e, dt); return; }
      e.motion.labWork = ""; e.motion.labReach = 0; e.motion.labSqueeze = false;
      if (!e.gorilla.labWalkCompact) { e.speed = 0; return; }
      const other = job.yieldFor, q = other && other.root.position;
      if (elapsed >= job.yieldUntil) {
        const distance = q ? Math.hypot(q.x - p.x, q.z - p.z) : Infinity;
        const passed = q && (q.x - p.x) * job.yieldDX + (q.z - p.z) * job.yieldDZ > 1.65;
        const withdrew = other && other.controlled && other.drive.x * job.yieldDX + other.drive.z * job.yieldDZ < -0.2 && distance > 2.1;
        if (!other || !other.active || passed || withdrew || distance >= 4.5 || other.lab.arrived && other.phase === "work") {
          let home = labStations[job.station];
          if (home && home.kind === "carry") {
            const pickup = labPickupFor(e, job.station);
            if (pickup < 0) return;
            home = labPickupPoint(home, labEquipment[pickup], job.pickupPoint);
            job.pickup = pickup;
          }
          if (home) {
            if (elapsed < job.pathAt) return;
            // Returning resumes ordinary walking, including the workstation
            // turn. Reserve that speed and pose before releasing the yield.
            const yielding = job.yielding;
            job.yielding = 0;
            if (!planLabPath(e, home.x, home.y, home.z, home.heading)) { job.yielding = yielding; return; }
          }
          job.yielding = 0; job.yieldFor = null; job.yieldReady = false; job.arrived = false;
          return;
        }
      }
      if (q && Math.hypot(q.x - job.yieldProgressX, q.z - job.yieldProgressZ) > 0.15) {
        job.yieldProgressX = q.x; job.yieldProgressZ = q.z; job.yieldProgressAt = elapsed;
      }
      if (job.yieldReady && (e.blocked > 0.5 || elapsed - job.yieldProgressAt > 2.5 && Math.hypot(p.x - point.x, p.z - point.z) < 0.08)) {
        job.yieldReady = false; job.yieldChoice++; job.pathCount = job.pathIndex = 0; job.pathAt = 0;
        job.yieldProgressAt = elapsed;
      }
      if (!job.yieldReady && !planLabYield(e)) { e.speed = 0; return; }
      const distance = Math.hypot(p.x - point.x, p.z - point.z);
      if (distance > 0.003) {
        if (labGoal(e, point.x, point.y, point.z, point.heading)) moveLab(e, dt, 0.65);
        else e.speed = 0;
      } else e.speed = damp(e.speed, 0, 12, dt);
    };
    const labPickupFor = (e, station) => {
      const pickup = e.lab.item >= 0 ? e.lab.item : e.lab.pickup, item = labEquipment[pickup];
      if (item && item.station === station && (!item.holder || item.holder === e)) return pickup;
      for (let i = 0; i < labEquipment.length; i++) {
        const item = labEquipment[i];
        if (item.station === station && (!item.holder || item.holder === e)) return i;
      }
      return -1;
    };
    const labPickupPoint = (station, equipment, point) => {
      const q = equipment.pickup, sine = Math.sin(station.heading), cosine = Math.cos(station.heading);
      point.x = q.x - sine * 1.213094 - cosine * 0.572893; point.y = station.y;
      point.z = q.z - cosine * 1.213094 + sine * 0.572893;
      point.heading = station.heading; point.side = station.side;
      return point;
    };
    const labPickupPose = (e, equipment) => {
      e.motion.labReach = 1;
      e.motion.labGripY = equipment.node.geometry.labGripY || BL.scene.boundsOf(equipment.node.geometry).max[1] * 0.85;
      e.motion.labDie = equipment.kind === "die";
      e.motion.labBench = equipment.bench || null;
      e.motion.labItemGeometry = equipment.node.geometry;
    };
    const reserveLab = (e, moving) => {
      if (!labStations.length) return false;
      const p = e.root.position, previous = e.lab.station;
      const radius = e.radius, height = e.height, compact = e.compact, mode = e.footprintMode;
      const reach = e.motion.labReach, grip = e.motion.labGripY, die = e.motion.labDie, bench = e.motion.labBench, itemGeometry = e.motion.labItemGeometry;
      e.radius = BL.agent.LAB_RADIUS || 1.1; e.height = BL.agent.LAB_HEIGHT || 2.8;
      e.compact = e.planningLab = true; e.footprintMode = "lab";
      // Shuffle the available jobs with this actor's seeded random stream.
      // Reuse one scratch order; claims still make every station exclusive.
      for (let i = 0; i < labStationOrder.length; i++) labStationOrder[i] = i;
      for (let i = labStationOrder.length - 1; i > 0; i--) {
        const at = Math.floor(e.random() * (i + 1)), value = labStationOrder[i];
        labStationOrder[i] = labStationOrder[at]; labStationOrder[at] = value;
      }
      // All six regular claims precede the middle computer. A current regular
      // worker keeps its station rather than manufacturing an overflow shift.
      let full = previous < 0 || labStations[previous].overflow;
      for (let i = 0; i < labStations.length && full; i++) {
        if (labStations[i].enabled === false || labStations[i].overflow) continue;
        let claimed = false;
        for (const other of list) if (other.active && other.site === labSite && other.lab.station === i) { claimed = true; break; }
        if (!claimed) full = false;
      }
      let chosen = -1, chosenPickup = -1;
      for (let i = 0; i < labStations.length * 2; i++) {
        const index = labStationOrder[i % labStations.length], station = labStations[index];
        if (station.enabled === false) continue;
        if (i < labStations.length ? station.overflow : !station.overflow || !full) continue;
        if (moving && (index === previous || Math.hypot(station.x - p.x, station.z - p.z) < 0.65)) continue;
        let claimed = false;
        for (let j = 0; j < list.length; j++) {
          const other = list[j];
          if (other !== e && other.active && other.site === labSite && other.lab.station === index) { claimed = true; break; }
        }
        if (claimed) continue;
        const pickup = station.kind === "carry" ? labPickupFor(e, index) : -1;
        if (station.kind === "carry" && pickup < 0) continue;
        // A rolled die can move its pickup spot. Prove the exact destination
        // workLab will use, instead of discarding this route after committing.
        const destination = pickup >= 0 ? labPickupPoint(station, labEquipment[pickup], e.lab.pickupPoint) : station;
        // Admit the real pickup pose, including this bench and vessel height.
        // A raised inspection pose or the previous bench's reach is not the
        // pose the worker must fit when it arrives here.
        e.motion.labReach = 0; e.motion.labBench = null; e.motion.labDie = false;
        if (pickup >= 0) labPickupPose(e, labEquipment[pickup]);
        e.planningLabStation = index;
        e.planningLabWork = station.kind; e.planningLabSide = station.side === -1 ? -1 : 1;
        if (occupied(e, destination.x, destination.y, destination.z, true, destination.heading)
          || !staticClear(e, destination.x, destination.y, destination.z, destination.x, destination.y, destination.z, destination.heading, destination.heading)) continue;
        // Changing jobs is optional. Keep the current desk productive until a
        // complete route is reserved; staging in its aisle would release the
        // old job before we know how to reach the new one.
        if (moving && !planLabPath(e, destination.x, destination.y, destination.z, destination.heading)) continue;
        chosen = index; chosenPickup = pickup; break;
      }
      e.radius = radius; e.height = height; e.compact = compact; e.footprintMode = mode; e.planningLab = false; e.planningLabWork = ""; e.planningLabStation = -1;
      e.motion.labReach = reach; e.motion.labGripY = grip; e.motion.labDie = die; e.motion.labBench = bench;
      e.motion.labItemGeometry = itemGeometry;
      if (chosen < 0) {
        if (moving) e.lab.pathPending = false;
        return false;
      }
      const station = labStations[chosen];
      const destination = chosenPickup >= 0 ? labPickupPoint(station, labEquipment[chosenPickup], e.lab.pickupPoint) : station;
      e.lab.station = chosen; e.lab.arrived = false; e.lab.time = e.lab.reach = 0;
      e.lab.stage = station.kind === "carry" ? "fetch" : ""; e.lab.bench = -1; e.lab.pickup = chosenPickup;
      e.slotIndex = chosen; e.slotX = destination.x; e.slotY = destination.y; e.slotZ = destination.z; e.hasSlot = true;
      return true;
    };
    const trafficAt = (x, y, z) => {
      // Keep the doorway and its central apron open even between shifts.
      for (let i = 0; i < sites.length; i++) {
        const site = sites[i], m = site.mouth, dx = x - m.x, dz = z - m.z;
        if (y < m.floorY - 0.2 || y > m.floorY + 2.6) continue;
        const across = dx * site.cr - dz * site.sr, along = dx * site.sr + dz * site.cr;
        if (along <= -0.5 || along >= 12 || Math.abs(across) >= 6.5) continue;
        if (along < 6.5 && Math.abs(across) < 2.5) return true;
      }
      return false;
    };
    const reserveFloor = (e) => {
      const site = sites[e.site], lab = e.site === labSite;
      const radius = e.radius, height = e.height, compact = e.compact, mode = e.footprintMode;
      const planning = e.planningLab, work = e.planningLabWork;
      e.planningEntry = true;
      if (lab) {
        e.radius = BL.agent.LAB_RADIUS; e.height = BL.agent.LAB_HEIGHT;
        e.compact = e.planningLab = true; e.footprintMode = "lab"; e.planningLabWork = "";
      }
      let best = -Infinity, chosen = -1;
      const point = e.lab.waitPoint;
      // Equipment capacity never limits entry. Choose a supported interior
      // spot, preferring distance from residents and their reserved desks.
      for (let i = 0; i < ROOM_CELLS.length; i++) {
        const index = (i + e.index) % ROOM_CELLS.length, cell = ROOM_CELLS[index];
        if (cell[1] > -1.84 || site.mirrorRoom && cell[1] > -3) continue;
        sitePoint(site, cell[0] * (site.mirrorRoom ? 0.76 : 1), cell[1], POINT);
        const heading = site.mouth.ry + Math.PI;
        if (!staticClear(e, POINT.x, POINT.y, POINT.z, POINT.x, POINT.y, POINT.z, heading, heading)) continue;
        let distance = Infinity;
        for (const other of list) {
          if (other === e || !other.active) continue;
          const q = other.hasSlot && other.site === e.site ? null : other.root.position;
          const x = q ? q.x : other.slotX, y = q ? q.y : other.slotY, z = q ? q.z : other.slotZ;
          if (Math.abs(y - POINT.y) < e.height)
            distance = Math.min(distance, (x - POINT.x) ** 2 + (z - POINT.z) ** 2);
        }
        if (chosen >= 0 && distance <= best) continue;
        chosen = index; best = distance;
        point.x = POINT.x; point.y = POINT.y; point.z = POINT.z; point.heading = heading;
      }
      e.radius = radius; e.height = height; e.compact = compact; e.footprintMode = mode;
      e.planningLab = planning; e.planningLabWork = work;
      e.planningEntry = false;
      if (chosen < 0) return false;
      e.lab.station = -1; e.lab.stage = ""; e.lab.pickup = -1;
      e.lab.arrived = false; e.lab.time = 1; e.lab.waitSince = elapsed;
      e.lab.pathCount = e.lab.pathIndex = 0; e.lab.pathAt = 0;
      e.lab.pathPending = e.lab.pathPartial = false; e.lab.targetX = e.lab.targetZ = NaN;
      e.slotIndex = -1; e.slotX = point.x; e.slotY = point.y; e.slotZ = point.z; e.hasSlot = true;
      return true;
    };
    const reserve = (e, move = false) => {
      const site = sites[e.site];
      if (!site) return false;
      if (e.site === labSite) return reserveLab(e, move) || !move && reserveFloor(e);
      const p = e.root.position, previousHeading = e.heading;
      e.heading = site.mouth.ry;
      // Fill the sides before the centre, keeping a route through the mouth
      // for ordinary repository populations. Every candidate still checks the
      // complete current/planned rig against furniture and other residents.
      const cells = ROOM_CELLS;
      let order = null;
      if (move && site.mirrorRoom) {
        const across = (p.x - site.mouth.x) * site.cr - (p.z - site.mouth.z) * site.sr;
        const along = (p.x - site.mouth.x) * site.sr + (p.z - site.mouth.z) * site.cr;
        const side = across > 0.2 ? -1 : across < -0.2 ? 1 : ((e.index + e.workCycle) & 1 ? 1 : -1);
        const deep = along > -4.15;
        const preferred = side < 0 ? deep ? [0, 2] : [2, 0] : deep ? [1, 3] : [3, 1];
        const other = side < 0 ? deep ? [1, 3] : [3, 1] : deep ? [0, 2] : [2, 0];
        // Cross to the opposite side first and alternate the deep and shallow
        // lanes. Occupancy may choose a fallback, but every safe room cell is
        // still considered before giving up.
        order = [...preferred, ...other, deep ? 8 : 9, deep ? 9 : 8];
      }
      const start = move && !order ? (e.slotIndex + 1 + e.workCycle) % cells.length : 0;
      const count = order ? order.length : cells.length;
      for (let i = 0; i < count; i++) {
        const index = order ? order[i] : (start + i) % cells.length, cell = cells[index];
        // Keep the complete working pose behind the mirror plane. The old
        // middle row left the torso inside while a turn, jump or pound could
        // put the head back through the glass.
        if (site.mirrorRoom && cell[1] > -3) continue;
        // The expanded mirror chamber still has a voxel-stepped side wall.
        // Keep its work lanes nearer the centre so an inward-facing full arm
        // pose can travel between them without scraping that wall.
        sitePoint(site, site.mirrorRoom ? cell[0] * 0.76 : cell[0], cell[1], POINT);
        if (move && Math.hypot(POINT.x - p.x, POINT.z - p.z) < 0.65) continue;
        if (occupied(e, POINT.x, POINT.y, POINT.z) || reserved(e, POINT.x, POINT.z)
          || !staticClear(e, POINT.x, POINT.y, POINT.z)) continue;
        e.slotIndex = index; e.slotX = POINT.x; e.slotY = POINT.y; e.slotZ = POINT.z; e.hasSlot = true;
        e.heading = previousHeading; return true;
      }
      e.heading = previousHeading; return !move && reserveFloor(e);
    };
    const restTransitionClear = (e, lounge, dt = 0) => {
      if (!ctx.restPoseClear) return true;
      // A short first step can sweep sideways before the torso is upright.
      // Larger look-ahead poses do not imply this actual frame is clear.
      if (dt > 0 && !ctx.restPoseClear(e, dt, lounge)) return false;
      for (let i = 0; i < REST_TRANSITION_TIMES.length; i++) {
        if (!ctx.restPoseClear(e, REST_TRANSITION_TIMES[i], lounge)) return false;
      }
      return true;
    };
    let checkingRest = false;
    const noRestTerrain = () => false;
    const restPreviewClear = (e) => {
      if (!checkingRest) return true;
      checkingRest = false;
      const p = e.root.position;
      e.compact = false; e.radius = Math.max(WALK_RADIUS, e.gorilla.bodyRadius + 0.1);
      e.height = Math.max(2.7, e.gorilla.bodyHeight + 0.04);
      for (const other of list) if (other !== e && other.active) {
        const q = other.root.position;
        if ((torso || footprint).overlaps(e, p.x, p.y, p.z, e.root.rotation.y,
          other, q.x, q.y, q.z, other.heading, SPACE)) return false;
      }
      return !occupied(e, p.x, p.y, p.z, true, e.root.rotation.y)
        && staticClear(e, p.x, p.y, p.z, p.x, p.y, p.z, e.root.rotation.y, e.root.rotation.y);
    };
    const restSpace = (e, pose, x, y, z, heading) => {
      if (!chillCaveClear(x, y, z)) return false;
      if (ctx.restSiteClear && !ctx.restSiteClear(e, x, y, z, heading)) return false;
      if (ctx.restPoseClear) {
        if (!ctx.restPoseClear(e, 2, pose, true, x, y, z, heading)) return false;
        // A resting place must also let its occupant get back onto all fours.
        // Check the rise while selecting it, before another body can settle
        // into the space needed by that transition.
        for (const dt of REST_TRANSITION_TIMES) {
          if (!ctx.restPoseClear(e, dt, "", true, x, y, z, heading, pose)) return false;
        }
        return true;
      }
      const compact = e.compact, radius = e.radius, height = e.height;
      checkingRest = true;
      let fits = e.gorilla.climbPoseClear(2, x, y, z, heading, e.motion,
        ctx.solidAt || noRestTerrain, restPreviewClear, e, 0, true, pose);
      for (let i = 0; fits && i < REST_TRANSITION_TIMES.length; i++) {
        checkingRest = true;
        fits = e.gorilla.climbPoseClear(REST_TRANSITION_TIMES[i], x, y, z, heading, e.motion,
          ctx.solidAt || noRestTerrain, restPreviewClear, e, 0, true, "", pose);
      }
      checkingRest = false; e.compact = compact; e.radius = radius; e.height = height;
      return fits;
    };
    const leaveLounge = (e) => {
      e.groomTime = 0; e.motion.groom = 0; e.loungePartner = null;
      e.motion.sitTime = e.motion.sitLookTarget = e.motion.sitShiftTarget = 0;
      if (e.lounge) e.loungeDepart = true;
    };
    const roamStartClear = (e) => {
      const p = e.root.position, compact = e.compact, mode = e.footprintMode, radius = e.radius, height = e.height;
      e.compact = e.planningRoam = true; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
      const fits = !occupied(e, p.x, p.y, p.z) && staticClear(e, p.x, p.y, p.z);
      e.compact = compact; e.footprintMode = mode; e.radius = radius; e.height = height; e.planningRoam = false;
      return fits;
    };
    const setGoal = (e, x, y, z) => {
      if (e.lounge && Math.hypot(x - e.root.position.x, z - e.root.position.z) > 0.18) leaveLounge(e);
      e.goalX = x; e.goalY = y; e.goalZ = z;
    };
    // Retain the small itinerary for an entire outing. Static routes are only
    // searched when choosing a destination or an obstruction changes; peers
    // share their retained routes for short, deterministic crossing waits.
    const roamFuture = (e, seconds, out) => {
      const p = e.root.position, r = e.roam;
      out.x = p.x; out.y = p.y; out.z = p.z; out.heading = e.heading;
      if (e.controlled || e.lounge || e.loungeDepart || e.recover > 0 || e.climb.active || elapsed < r.waitUntil) return out;
      for (let i = r.index; i < r.count && seconds > 0; i++) {
        const at = i * 3, dx = r.path[at] - out.x, dz = r.path[at + 2] - out.z;
        const distance = Math.hypot(dx, dz), heading = i === 0 && r.reverseStart ? r.departHeading : Math.atan2(dx, dz);
        seconds -= Math.abs(Math.atan2(Math.sin(heading - out.heading), Math.cos(heading - out.heading))) / 3;
        if (seconds <= 0) break;
        const step = Math.min(distance, seconds * CHILL_SPEED);
        if (distance > 0) { out.x += dx * step / distance; out.z += dz * step / distance; }
        out.y += (r.path[at + 1] - out.y) * Math.min(1, step / Math.max(0.001, distance));
        out.heading = heading; seconds -= step / CHILL_SPEED;
      }
      return out;
    };
    const roamPeerClear = (e, x, y, z, heading) => !occupied(e, x, y, z, false, heading);
    const roamLeg = (e, x, y, z, nx, ny, nz, heading, partial, out, fixedHeading = NaN) => {
      const distance = Math.hypot(nx - x, nz - z), facing = Number.isFinite(fixedHeading) ? fixedHeading : Math.atan2(nx - x, nz - z);
      if (!staticClear(e, x, y, z, x, y, z, heading, facing)
        || !roamPeerClear(e, x, y, z, facing)) return false;
      const steps = Math.max(1, Math.ceil(distance / 0.4)), dx = (nx - x) / steps, dz = (nz - z) / steps;
      let px = x, py = y, pz = z;
      for (let i = 1; i <= steps; i++) {
        const tx = x + dx * i, tz = z + dz * i;
        let ty = support(e, tx, tz, py, PROP_STEP, facing), propDrop = false;
        // A prop's edge has no continuous wall to grip. Prove the horizontal
        // clearance and vertical landing here, then use the existing passive
        // descent at execution. Otherwise every route off a rock is mistaken
        // for an unavailable climb, even though walking off it is supported.
        const terrainHere = ctx.terrainSupportAt
          ? ctx.terrainSupportAt(e, px, pz, py, PROP_STEP, facing) : groundAt(px, pz, py);
        if (!Number.isFinite(ty) && py - terrainHere > STEP) {
          const terrainThere = ctx.terrainSupportAt
            ? ctx.terrainSupportAt(e, tx, tz, py, PROP_STEP, facing) : groundAt(tx, tz, py);
          if (Number.isFinite(terrainThere) && py - terrainThere > STEP && py - terrainThere <= PROP_STEP) {
            ty = terrainThere; propDrop = true;
          }
        }
        if (!Number.isFinite(ty) || Math.abs(ty - py) > PROP_STEP && !propDrop || !actorLanding(e, tx, ty, tz)
          || !roamPeerClear(e, tx, ty, tz, facing)
          || !propStepClear(e, px, py, pz, tx, ty, tz, facing, facing)) {
          // A low tread is not a climbable wall. Try another walking approach
          // instead of retaining a zero-length "wall" route at its edge.
          if (!partial || Math.abs(ny - py) < 1 || !e.debugMove.active && Math.hypot(px - nx, pz - nz) > 7) return false;
          // A chamber below the requested roof has an enclosing ceiling. Its
          // back wall is not an approach to the outside cliff: keep searching
          // around the mouth instead of repeatedly walking under the goal.
          if (ny > py + 1 && caveAt(px, py, pz) >= 0) return false;
          out.x = px; out.y = py; out.z = pz; out.heading = facing;
          return true;
        }
        px = tx; py = ty; pz = tz;
      }
      // Intermediate knots inherit the support reached by the swept steps.
      // Their point-terrain sample can be below a rock that provides a valid
      // short clearance step. Only the final destination owns a level goal.
      out.x = px; out.y = py; out.z = pz; out.heading = facing;
      return true;
    };
    const planRoam = (e, x, y, z, endHeading = e.loungeHeading, pose = e.roam.pose, walkingOnly = false) => {
      if (!roamBudget) return false;
      roamBudget--;
      const p = e.root.position, r = e.roam;
      const compact = e.compact, mode = e.footprintMode, radius = e.radius, height = e.height;
      e.compact = e.planningRoam = true; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
      const dx = x - p.x, dz = z - p.z, distance = Math.hypot(dx, dz);
      const sx = distance > 0 ? dz / distance : 1, sz = distance > 0 ? -dx / distance : 0;
      let found = false, best = Infinity, count = 0, wall = false, reverse = false, departHeading = e.heading;
      // Straight first. The two interior knots produce a short parallel pass
      // around a tree or resting body, without routing via a distant landmark.
      for (let attempt = 0; attempt < (e.debugMove.active ? 16 : 15); attempt++) {
        // A bridge or prop can leave enough room to back out, but not to turn
        // around. Keep the ordinary swept walking proof for that entire leg.
        const reverseDirect = attempt === 15;
        const reverseHeading = Math.atan2(dx, dz) + Math.PI;
        if (reverseDirect && Math.cos(reverseHeading - e.heading) < 0) continue;
        const departure = reverseDirect ? 0 : attempt >= 11 ? -(attempt - 10) * 0.65 : attempt >= 9 ? (attempt - 8) * 0.9 : 0;
        const offset = attempt && !departure && !reverseDirect ? Math.ceil(attempt / 2) * 1.35 * (attempt % 2 ? 1 : -1) : 0;
        let px = p.x, py = p.y, pz = p.z, heading = e.heading, length = 0, valid = true, n = 0;
        const legs = departure ? 2 : attempt && !reverseDirect ? 3 : 1;
        for (let leg = 0; leg < legs; leg++) {
          const final = leg + 1 === legs, t = final ? 1 : (leg + 1) / 3;
          // At a tight resting place, move forward into the clearing before
          // turning. The large knuckle arc need not fit at the resting root.
          const nx = departure && !final ? p.x + Math.sin(e.heading) * departure : p.x + dx * t + (final ? 0 : sx * offset);
          const nz = departure && !final ? p.z + Math.cos(e.heading) * departure : p.z + dz * t + (final ? 0 : sz * offset);
          const ny = final ? y : groundAt(nx, nz, py);
          if (!roamLeg(e, px, py, pz, nx, ny, nz, heading, final, roamPoint,
            reverseDirect ? reverseHeading : departure < 0 && !final ? e.heading : NaN)) { valid = false; break; }
          length += Math.hypot(roamPoint.x - px, roamPoint.z - pz);
          roamPath[n++] = roamPoint.x; roamPath[n++] = roamPoint.y; roamPath[n++] = roamPoint.z;
          px = roamPoint.x; py = roamPoint.y; pz = roamPoint.z; heading = roamPoint.heading;
        }
        const partial = Math.abs(py - y) > 0.55;
        if (partial && y > py + 1 && caveAt(px, py, pz) >= 0) continue;
        // A short blocked approach is not cheaper than a complete detour.
        // Among wall approaches credit progress toward the intended endpoint,
        // otherwise a zero-length obstruction wins every retry.
        const cost = length + (partial ? Math.hypot(x - px, z - pz) * 2 : 0);
        if (!valid || walkingOnly && partial || found && (!wall && partial || wall === partial && cost >= best)) continue;
        if (!partial) {
          const facing = Number.isFinite(endHeading) ? endHeading : heading;
          if (!staticClear(e, px, py, pz, px, py, pz, heading, facing)
            || !roamPeerClear(e, px, py, pz, facing)) continue;
          // Reserve the actual resting body at its final facing. A clear
          // walking endpoint alone says nothing about space for reclining.
          if (pose) {
            e.planningRoam = e.compact = false;
            const fits = restSpace(e, pose, px, py, pz, facing);
            e.planningRoam = e.compact = true;
            if (!fits) continue;
          }
        }
        found = true; best = cost; count = n / 3; wall = partial; reverse = departure < 0 || reverseDirect;
        departHeading = reverseDirect ? reverseHeading : e.heading;
        for (let i = 0; i < n; i++) r.path[i] = roamPath[i];
        if (!attempt && !partial) break;
      }
      e.compact = compact; e.footprintMode = mode; e.radius = radius; e.height = height; e.planningRoam = false;
      r.plans++;
      if (!found) return false;
      r.count = count; r.index = 0; r.wall = wall; r.propDeparture = false; r.level = p.y; r.waitUntil = 0; r.blocked = 0;
      r.reverseStart = reverse; r.departHeading = departHeading;
      r.targetX = x; r.targetY = y; r.targetZ = z; r.order = ++roamSerial; r.obstacle = null;
      return true;
    };
    const loungePose = (e) => {
      const choice = e.random();
      return choice < 0.35 ? "sit" : choice < 0.48 ? "back" : choice < 0.61 ? "left" : choice < 0.74 ? "right"
        : choice < 0.83 ? "lean-left" : choice < 0.92 ? "lean-right" : "lean-back";
    };
    const prepareLounges = (e) => {
      if (loungeReady) return;
      loungeReady = true;
      const roofs = ctx.loungeRoofs || ctx.climbRoofs, meadow = ctx.meadowRadius || 22;
      const compact = e.compact, radius = e.radius, height = e.height;
      e.compact = false; e.radius = Math.max(radius, 2.12); e.height = Math.max(height, 2.7);
      // Search clear patches on inactive cave and HQ ramp roofs, including stone. The
      // first small ring often lands on trees or higher voxels; a bounded half-
      // metre grid finds the actual clearings without moving props or rock.
      if (roofs && ctx.surfaceAt) for (let i = 0; i < roofs.length && loungeCount < 80; i++) {
        const roof = roofs[i], start = loungeCount;
        for (let n = 0; n < 298 && loungeCount < 80; n++) {
          if (loungeCount - start >= 8) break;
          const angle = roof.angle + (n - 1) * TAU / 8, spread = n ? 3 : 0;
          const dx = n < 9 ? Math.sin(angle) * spread : ((n - 9) % 17 - 8) * 0.5;
          const dz = n < 9 ? Math.cos(angle) * spread : (Math.floor((n - 9) / 17) - 8) * 0.5;
          if (dx * dx + dz * dz >= 4.5 ** 2) continue;
          const x = roof.x + dx, z = roof.z + dz, y = ctx.surfaceAt(x, z);
          if (y < roof.y - 0.55 || !grass(x, y, z) || trafficAt(x, y, z) || caveAt(x, y, z) >= 0
            || !staticClear(e, x, y, z)) continue;
          // Distribute seats across the roof instead of filling the cache
          // with several points inside one gorilla's resting footprint.
          let crowded = false;
          for (let seat = start; seat < loungeCount; seat++) {
            const at = seat * 3;
            if ((loungeSpots[at] - x) ** 2 + (loungeSpots[at + 2] - z) ** 2 < 2.5 ** 2) { crowded = true; break; }
          }
          if (crowded) continue;
          const at = loungeCount++ * 3;
          loungeSpots[at] = x; loungeSpots[at + 1] = y; loungeSpots[at + 2] = z;
          roofCount++;
        }
      }
      e.compact = compact; e.radius = radius; e.height = height;
      const inner = meadow * 0.82, edge = meadow - WALK_RADIUS - 0.25;
      for (let i = 0; i < 288 && loungeCount < 320; i++) {
        const angle = i % 96 * TAU / 96, distance = inner + (edge - inner) * Math.floor(i / 96) / 2;
        const x = Math.sin(angle) * distance, z = Math.cos(angle) * distance, y = groundAt(x, z, 0);
        if (!grass(x, y, z) || trafficAt(x, y, z) || caveAt(x, y, z) >= 0) continue;
        const at = loungeCount++ * 3;
        loungeSpots[at] = x; loungeSpots[at + 1] = y; loungeSpots[at + 2] = z;
      }
    };
    const loungeReserved = (e, x, y, z, radius = WALK_RADIUS, partner = null) => {
      for (let i = 0; i < list.length; i++) {
        const other = list[i];
        if (other === e || other === partner || !other.active || other.phase !== "chill"
          || other.loungePartner === e || Math.abs(other.goalY - y) > 1.5) continue;
        // A settled body still owns room to rise. Only its explicitly paired
        // grooming guest shares that space; ordinary walking uses torso bounds.
        const space = radius + (other.loungePartner ? 1.25 : WALK_RADIUS) + SPACE;
        if ((other.goalX - x) ** 2 + (other.goalZ - z) ** 2 < space * space) return true;
      }
      return false;
    };
    const loungeGoal = (e, x, y, z, roof, partner = null, heading = NaN, pose = "") => {
      setGoal(e, x, y, z);
      // Try direct travel first; discard any detour from the previous outing.
      e.roam.count = e.roam.index = 0; e.roam.wall = e.roam.detour = false;
      e.roam.targetX = x; e.roam.targetY = y; e.roam.targetZ = z;
      e.roam.progressDistance = Infinity; e.roam.progressTime = 0;
      e.roam.runUp = e.roam.jumpRetry = 0;
      e.rest = CHILL_REST_SECONDS + e.random() * CHILL_REST_VARIATION;
      e.loungeRoof = roof; e.loungePartner = partner; e.loungeHeading = heading;
      e.loungeCycle = roof ? e.loungeCycle + 1 : 0;
      e.groomTime = 0; e.groomWait = 2 + e.random() * 6;
      e.roam.poseWait = 20 + e.random() * 25;
      e.motion.sitTime = 0; e.motion.sitWait = 2 + e.random() * 5;
      e.motion.sitLookTarget = e.motion.sitShiftTarget = 0;
      if (!e.loungeDepart) e.lounge = "";
      e.phase = "chill"; e.motion.groom = 0; e.roam.arrived = false; e.roam.failedChoices = 0; e.roam.pose = partner ? "sit" : pose || loungePose(e);
      e.roam.departPending = false;
    };
    const loungeSeatSpace = (e, x, y, z, heading, partner = e.loungePartner) => {
      const compact = e.compact, mode = e.footprintMode, radius = e.radius, height = e.height;
      e.compact = e.planningSeat = true; e.footprintMode = "sit"; e.radius = 0.9; e.height = 2.7;
      const fits = !occupied(e, x, y, z, true, heading) && staticClear(e, x, y, z, x, y, z, heading, heading);
      e.compact = compact; e.footprintMode = mode; e.radius = radius; e.height = height; e.planningSeat = false;
      return fits && !loungeReserved(e, x, y, z, 1.25, partner)
        && (!ctx.restSiteClear || ctx.restSiteClear(e, x, y, z, heading));
    };
    const loungeFailed = (e, x, z) => {
      const r = e.roam;
      return elapsed < r.failedUntil && (x - r.failedX) ** 2 + (z - r.failedZ) ** 2 < 4
        || elapsed < r.wallFailedUntil && (x - r.wallFailedX) ** 2 + (z - r.wallFailedZ) ** 2 < 4;
    };
    const nearbyLounge = (e, roof, spawn, stayLevel = false) => {
      const first = Math.floor(e.random() * Math.max(1, list.length));
      for (let i = 0; i < list.length; i++) {
        const other = list[(first + i) % list.length];
        if (other === e || !other.active || other.controlled || other.mode !== "chilling" || other.phase !== "chill" || other.loungePartner
          || other.lounge !== "sit" || !other.gorilla.sitCompact || other.loungeRoof !== roof || other.rest < 15) continue;
        let claimed = false;
        for (let j = 0; j < list.length; j++) if (list[j] !== e && list[j].active && list[j].loungePartner === other) { claimed = true; break; }
        if (claimed) continue;
        // Sit just behind one shoulder, facing the same direction. Keeping the
        // torsos separate leaves a hand free to reach the neighbour's back.
        const q = other.root.position, heading = other.heading, sine = Math.sin(heading), cosine = Math.cos(heading);
        if (stayLevel && Math.hypot(q.x - e.root.position.x, q.z - e.root.position.z) > 12) continue;
        const firstSide = e.random() < 0.5 ? -1 : 1;
        for (let n = 0; n < 2; n++) {
          const side = n ? -firstSide : firstSide;
          const x = q.x - cosine * side * 1.9 - sine, z = q.z + sine * side * 1.9 - cosine;
          const y = roof && ctx.surfaceAt ? ctx.surfaceAt(x, z) : groundAt(x, z, q.y);
          if (!spawn && (Math.hypot(x - e.root.position.x, z - e.root.position.z) < 2 || loungeFailed(e, x, z))) continue;
          if (Math.hypot(x, z) < (ctx.meadowRadius || 22) * 0.82 || Math.abs(y - q.y) > 0.15 || !grass(x, y, z, 0.9) || trafficAt(x, y, z)
            || caveAt(x, y, z) >= 0 || !loungeSeatSpace(e, x, y, z, heading, other)) continue;
          if (spawn && !restSpace(e, "sit", x, y, z, heading)) continue;
          if (!spawn && Math.hypot(x - e.root.position.x, z - e.root.position.z) > 10) continue;
          loungeGoal(e, x, y, z, roof, other, heading);
          e.rest = Math.min(e.rest, Math.max(10, other.rest - Math.hypot(x - e.root.position.x, z - e.root.position.z) / CHILL_SPEED));
          e.motion.groomSide = side;
          if (spawn) { e.heading = heading; e.lounge = "sit"; }
          return true;
        }
      }
      return false;
    };
    const chooseChill = (e, spawn = false, stayLevel = false) => {
      if (e.debugMove.active) return false;
      // Cave exits also request a fresh distant destination. Only a companion
      // still hidden during activation may already be seated at that goal.
      spawn = spawn && !e.root.visible;
      stayLevel = stayLevel || !spawn && elapsed < e.roam.levelOnlyUntil;
      if (!spawn && (!roamBudget || roamTurn >= 0 && roamTurn !== e.index || elapsed < e.roam.nextChoice)) return false;
      if (!spawn && e.lounge && !roamStartClear(e)) {
        // A seat can fit beside scenery while the future knuckles cannot.
        // Clear that start in the seated pose before asking a walking planner
        // for an entire outing; otherwise departure waits on its own route.
        const r = e.roam, p = e.root.position;
        if (!r.departPending) { r.departAt = elapsed; r.departX = p.x; r.departY = p.y; r.departZ = p.z; }
        r.departPending = true; e.rest = 0; leaveLounge(e); return false;
      }
      prepareLounges(e);
      const p = e.root.position, compact = e.compact, radius = e.radius, height = e.height;
      const onRoof = unusedRoof(p.x, p.y, p.z, 0);
      // Long rests keep outings occasional. Some rooftop departures visit a
      // neighbouring roof before a later trip returns to the meadow.
      const wantsRoof = stayLevel ? onRoof : e.mode !== "working" && roofCount > 0 && e.loungeCycle < 2 && e.random() < (onRoof ? 0.55 : 0.9);
      const roofTour = !spawn && onRoof && wantsRoof && !stayLevel && e.random() < 0.5;
      const currentRoof = roofTour ? roofAt(p.x, p.y, p.z) : -1;
      const pose = loungePose(e);
      e.compact = false; e.height = Math.max(height, 2.7);
      // Prefer a small group on some visits; a crowded group always falls back
      // to another empty resting spot instead of blocking a walk indefinitely.
      if (e.random() < 0.5 && nearbyLounge(e, wantsRoof, spawn, stayLevel)) {
        e.compact = compact; e.radius = radius; e.height = height; return true;
      }
      for (let pass = 0; pass < 2; pass++) {
        const roof = pass ? !wantsRoof : wantsRoof;
        const count = roof ? roofCount : loungeCount - roofCount, from = roof ? 0 : roofCount;
        const local = !spawn ? 48 : 0, candidates = count + local;
        if (!candidates) continue;
        const first = Math.floor(e.random() * Math.max(1, count));
        e.radius = roof ? Math.max(radius, 2.12) : radius;
        for (let i = 0; i < candidates; i++) {
          const choice = local && e.roam.failedChoices >= 2 ? (i < local ? count + i : i - local) : i;
          const n = (from + (first + choice) % Math.max(1, count)) * 3;
          let x = loungeSpots[n], y = loungeSpots[n + 1], z = loungeSpots[n + 2];
          if (choice >= count) {
            // Cached seats may all be too close or blocked from this side of
            // a prop. Search the current level too, including roof clearings;
            // querying only the meadow strands a walker above that meadow.
            const sample = choice - count, angle = (first + sample % 12) * TAU / 12;
            const radius = 2.5 + Math.floor(sample / 12) * 2.5;
            x = p.x + Math.sin(angle) * radius; z = p.z + Math.cos(angle) * radius;
            y = roof && ctx.surfaceAt ? ctx.surfaceAt(x, z) : groundAt(x, z, 0);
            if (roof && !unusedRoof(x, y, z, FOOT)) continue;
            if (Math.hypot(x, z) < (ctx.meadowRadius || 22) * 0.82 || !grass(x, y, z) || trafficAt(x, y, z)
              || caveAt(x, y, z) >= 0) continue;
          }
          // A walking-only outing may step off a rock or follow a sloped roof.
          // Its supported route, not equal endpoint heights, excludes climbs.
          if (stayLevel && Math.hypot(x - p.x, z - p.z) > 12) continue;
          // Worker assignments can change after the resting-spot cache was
          // built. Recheck the live firing lanes for cached candidates too.
          if (trafficAt(x, y, z) || !chillCaveClear(x, y, z)) continue;
          const distance = Math.hypot(x - p.x, z - p.z);
          if (roofTour && !pass && roof && roofAt(x, y, z) === currentRoof) continue;
          // A former worker may start on the opposite side of the island.
          // Let it reach the inactive frontage before choosing shorter outings.
          const tripLimit = !stayLevel && !onRoof && !roof && loungeAreas.length ? roamRadius * 2
            : roofTour && roof ? 24 : !stayLevel && roof !== onRoof ? 18 : 12;
          if (!spawn && (distance < 2 || distance > tripLimit || loungeFailed(e, x, z))) continue;
          // Filter a future walking arrival, not the current reclining body's
          // large fallback circle. The exact new rest and rise are proved by
          // restSpace below (or by the retained route's endpoint admission).
          const mode = e.footprintMode, candidateCompact = e.compact, candidateHeight = e.height;
          const arrivalHeading = spawn ? e.heading : Math.atan2(x - p.x, z - p.z);
          if (!spawn) { e.planningRoam = e.compact = true; e.footprintMode = "walk"; e.height = WALK_HEIGHT; }
          const clearSpot = !occupied(e, x, y, z, true, arrivalHeading) && !loungeReserved(e, x, y, z, roof ? 2.12 : WALK_RADIUS)
            && staticClear(e, x, y, z, x, y, z, arrivalHeading, arrivalHeading);
          e.planningRoam = false; e.compact = candidateCompact; e.footprintMode = mode; e.height = candidateHeight;
          if (!clearSpot || ctx.restSiteClear && !ctx.restSiteClear(e, x, y, z, arrivalHeading)) continue;
          if (spawn && !restSpace(e, pose, x, y, z, e.heading)) continue;
          loungeGoal(e, x, y, z, roof, null, NaN, pose);
          if (spawn) e.lounge = e.roam.pose;
          e.compact = compact; e.radius = radius; e.height = height; return true;
        }
      }
      e.compact = compact; e.radius = radius; e.height = height;
      e.roam.failedChoices++; e.roam.nextChoice = elapsed + 0.5; return false;
    };
    const restAfterClimb = (e) => {
      if (e.debugMove.active) { resetDebugRoute(e, true); return; }
      // Returning from a blocked or bottomless route invalidates that stroll.
      // A supported nearby rest replaces its unreachable goal, so the same
      // wall is not retried as soon as the short grip cooldown expires.
      e.loungePartner = null; e.loungeHeading = NaN; e.motion.groom = 0;
      if (e.roam.wall) {
        e.roam.wallFailedX = e.goalX; e.roam.wallFailedZ = e.goalZ; e.roam.wallFailedUntil = elapsed + 60;
      }
      e.roam.count = e.roam.index = 0; e.roam.wall = false; e.roam.alignTime = 0;
      // A spawned prop can sit directly beneath an otherwise valid wall
      // dismount. Leave that temporary support before choosing a lounge;
      // route planning from its top must not turn the prop into a rest spot.
      if (choosePropExit(e)) return;
      if (chooseChill(e, false, true)) return;
      const p = e.root.position;
      setGoal(e, p.x, p.y, p.z);
      e.rest = !ctx.restSiteClear || ctx.restSiteClear(e, p.x, p.y, p.z, e.heading) ? 12 + e.random() * 8 : 0;
      e.speed = 0; e.lounge = ""; e.phase = "chill";
      // At a narrow lip the full resting body may not fit yet. Preserve the
      // walking footprint until the ordinary safe-expansion check permits it.
      e.exitFootprint = true;
    };
    const spawnLounge = (e) => chooseChill(e, true);
    const groomLounge = (e, dt) => {
      const partner = e.loungePartner, p = e.root.position;
      const seated = e.lounge === "sit" && Math.abs(e.speed) < 0.05 && !e.fire.burning;
      let near = false;
      if (seated && partner && partner.active && !partner.controlled && partner.lounge === "sit"
        && partner.phase === "chill" && !partner.fire.burning) {
        const q = partner.root.position, dx = q.x - p.x, dz = q.z - p.z;
        const side = dx * Math.cos(e.heading) - dz * Math.sin(e.heading);
        const forward = dx * Math.sin(e.heading) + dz * Math.cos(e.heading);
        near = Math.abs(q.y - p.y) < 0.2 && Math.abs(side) > 1.6 && Math.abs(side) < 2.25 && forward > 0.65 && forward < 1.35;
        if (near) {
          e.motion.groomSide = side < 0 ? -1 : 1;
          near = !ctx.groomClear || ctx.groomClear(e, partner);
        }
      }
      if (e.loungeDepart) near = false;
      if (!near) {
        e.groomTime = 0;
        if (partner && (!partner.active || partner.controlled || partner.lounge !== "sit" || partner.loungeDepart || partner.fire.burning
          || seated && Math.hypot(partner.root.position.x - e.root.position.x, partner.root.position.z - e.root.position.z) > 2.8)) e.loungePartner = null;
      }
      else if (e.groomTime > 0) e.groomTime = Math.max(0, e.groomTime - dt);
      else if ((e.groomWait -= dt) <= 0) {
        e.groomTime = 2.2 + e.random() * 2.4;
        e.groomWait = 7 + e.random() * 10;
      }
      e.motion.groom = damp(e.motion.groom, near && e.groomTime > 0 ? 1 : 0, 6, dt);
      e.motion.groomPhase += dt;
      const m = e.motion;
      if (!seated || e.loungeDepart) m.sitTime = m.sitLookTarget = m.sitShiftTarget = 0;
      else if (m.sitTime > 0) {
        m.sitTime = Math.max(0, m.sitTime - dt);
        if (!m.sitTime) m.sitLookTarget = m.sitShiftTarget = 0;
      } else if ((m.sitWait -= dt) <= 0) {
        m.sitWait = 4 + e.random() * 7;
        const choice = e.random(), side = e.random() < 0.5 ? -1 : 1;
        if (choice < 0.52) { m.sitLookTarget = side; m.sitTime = 1.2 + e.random() * 1.5; }
        else if (choice < 0.8 && !partner && m.groom < 0.05) {
          m.sitShiftTarget = side; m.sitLookTarget = side * 0.4; m.sitTime = 3 + e.random() * 2;
        }
      }
      m.sitLook = damp(m.sitLook, m.sitLookTarget, 4, dt);
      m.sitShift = damp(m.sitShift, m.sitShiftTarget, 3, dt);
      if (e.lounge && !e.loungeDepart && !partner && m.groom < 0.05 && !e.roam.transition && e.rest > 5
        && (e.roam.poseWait -= dt) <= 0) {
        e.roam.poseWait = 20 + e.random() * 25;
        const pose = loungePose(e);
        // Keep the destination and heading. Only change posture when both
        // the full resting pose and its transition fit beside scenery/peers.
        if (pose !== e.lounge && restSpace(e, pose, p.x, p.y, p.z, e.heading) && restTransitionClear(e, pose, dt)) {
          e.lounge = e.roam.pose = pose;
          m.sitTime = m.sitLookTarget = m.sitShiftTarget = 0;
        }
      }
    };
    const departLounge = (e, dt) => {
      e.speed = 0; e.motion.groom = 0;
      const p = e.root.position;
      if (e.gorilla.debug.grooming > 0.02) return;
      // Admit the future walking pose before asking the seated rig to rise.
      // Waiting for a seated mesh to fit walking capsules can never complete.
      const roomToRise = roamStartClear(e);
      if (roomToRise && (!ctx.restPoseClear || ctx.restPoseClear(e, 1.2, "", false, p.x, p.y, p.z, e.heading, null, dt))
        && (!e.roam.departPending || chooseChill(e))) {
        e.footprintMode = "walk"; e.compact = e.gorilla.compact;
        // Finish the same checked rise that poseEntry validates before taking
        // a terrain step. Moving halfway through it can pin the remaining
        // limb transition against a nearby prop while every route looks clear.
        e.loungeDepart = false; e.lounge = ""; e.recover = 1.2; e.roam.riseAdmitted = true;
        return;
      }
      // A quad pose fitting here does not prove it can turn or walk out.
      // Keep the seated clearance maneuver until its onward route is also
      // admitted; standing in a prop pocket first can trap the wider gait.
      e.footprintMode = "sit"; e.compact = e.gorilla.sitCompact;
      const sine = Math.sin(e.heading), cosine = Math.cos(e.heading), radial = Math.hypot(p.x, p.z) || 1;
      for (let side = 0; side < 4; side++) {
        const across = side ? (side === 1 ? -1 : 1) * dt * 0.3 : 0;
        const x = side === 3 ? p.x + p.x / radial * dt * 0.35 : p.x - sine * dt * 0.35 + cosine * across;
        const z = side === 3 ? p.z + p.z / radial * dt * 0.35 : p.z - cosine * dt * 0.35 - sine * across;
        const y = groundAt(x, z, p.y);
        if (Math.abs(y - p.y) > 0.12 || !grass(x, y, z, 0.9)) continue;
        // A side-lying body is not a seated capsule. Check its actual short
        // scoot, including the limbs, before trying the rise again.
        if (ctx.restPoseClear ? !ctx.restPoseClear(e, dt, e.lounge, false, x, y, z, e.heading)
          : occupied(e, x, y, z) || !staticClear(e, p.x, p.y, p.z, x, y, z)) continue;
        p.x = x; p.y = y; p.z = z;
        if (e.roam.departPending) { e.goalX = x; e.goalY = y; e.goalZ = z; }
        break;
      }
    };
    const alignLounge = (e, dt) => {
      if (!Number.isFinite(e.loungeHeading)) return true;
      const p = e.root.position, delta = Math.atan2(Math.sin(e.loungeHeading - e.heading), Math.cos(e.loungeHeading - e.heading));
      if (Math.abs(delta) < 0.015) return true;
      const heading = e.heading + delta * (1 - Math.exp(-8 * dt));
      if (occupied(e, p.x, p.y, p.z, true, heading) || !staticClear(e, p.x, p.y, p.z, p.x, p.y, p.z, e.heading, heading)) {
        // A companion may have moved since this spot was chosen. Leave the
        // seating plan rather than twisting the arm chain through its body.
        e.rest = Math.min(e.rest, 1);
        return false;
      }
      e.heading = heading; e.roam.alignTime = 0;
      return false;
    };
    const spawnApproach = (e) => {
      const p = e.root.position, site = sites[e.site];
      // A newly visible worker starts on the inward approach, never in an
      // outside waiting area. Companions cannot prevent this spawn.
      e.planningEntry = true;
      for (let i = 0; i < 12; i++) {
        sitePoint(site, i % 3 === 0 ? 0 : i % 3 === 1 ? -2.5 : 2.5, 5.5 + Math.floor(i / 3), POINT);
        const x = POINT.x, z = POINT.z, y = groundAt(x, z, site.mouth.floorY);
        if (Math.abs(y - site.mouth.floorY) > STEP || !landing(x, y, z) || !staticClear(e, x, y, z)) continue;
        e.planningEntry = false; setGoal(e, x, y, z); return true;
      }
      e.planningEntry = false;
      setGoal(e, p.x, p.y, p.z); return false;
    };
    const beginTravel = (e, siteIndex) => {
      e.roam.departPending = false;
      releasePortal(e);
      if (siteIndex !== labSite) releaseLab(e);
      e.site = siteIndex; e.hasSlot = false; e.slotIndex = -1; e.overflow = false;
      e.portalWait = false; e.portalRetry = 0;
      e.phase = "travel"; e.route = "exit"; e.entryTurn = false; e.blocked = 0; e.retry = 0;
      const p = e.root.position, from = caveAt(p.x, p.y, p.z);
      e.fromSite = from;
      const room = reserve(e);
      if (from === siteIndex) {
        e.phase = "work"; e.route = ""; e.rest = 0.5;
        if (room) setGoal(e, e.slotX, e.slotY, e.slotZ);
        else {
          e.lab.station = -1; e.lab.stage = ""; e.lab.time = 1;
          e.lab.waitSince = elapsed;
          e.lab.waitPoint.x = e.slotX = p.x; e.lab.waitPoint.y = e.slotY = p.y;
          e.lab.waitPoint.z = e.slotZ = p.z; e.lab.waitPoint.heading = e.heading;
          e.hasSlot = true; setGoal(e, p.x, p.y, p.z);
        }
      }
    };
    const activate = (e, atPosition = false) => {
      if (rage) rage.cancel(e, "respawn");
      if (ctx.rageRelease) ctx.rageRelease(e);
      clearWallSearch(e);
      const d = e.drive, f = e.fire, m = e.motion;
      e.backoutLeft = 0;
      d.x = d.z = d.vx = d.vy = d.vz = d.motionRecover = d.jumps = 0;
      d.wallRelease = false;
      d.climbExitHeading = d.climbExitLook = NaN; d.climbTurnTimer = 0;
      d.jumpHeld = d.jumpDown = d.jumpPressed = d.airborne = d.resume = d.motionEnvelope = false; d.jumpBuffer = 0; d.grounded = true;
      f.burning = f.rolling = f.requested = f.escaping = f.panic.active = false; f.retry = f.escapeRetry = 0; f.age = f.heat = f.soot = f.cooldown = f.rollRecover = 0;
      m.takeoff = m.landing = m.roll = m.rollAngle = m.rollSide = m.climb = m.climbSide = m.mantle = m.groom = m.supportOffset = 0;
      m.verifyGrip = false;
      e.climb.active = e.climb.claimPending = e.climb.crestPending = e.climb.searchPending = e.climb.free = false;
      e.climb.openingExit = e.climb.openingStagePending = false;
      e.climb.debugTraverse = e.climb.debugStuck = false; e.climb.debugRole = -1;
      e.debugMove.active = e.debugMove.cancelled = e.debugMove.wallPending = false; e.debugMove.status = "";
      e.climb.traverseStart = e.climb.traverseEnd = 0;
      e.climb.retry = e.climb.airAttachAfter = e.climb.handoffDirection = d.climbAxis = d.climbSide = 0; e.roam.count = e.roam.index = 0; e.roam.departPending = e.roam.propDeparture = false;
      e.actionControlled = e.motion.smash = false;
      releaseLab(e); e.motion.lab = false;
      e.mode = e.owner.state; e.site = e.owner.work.plannedSite >= 0 ? e.owner.work.plannedSite : e.owner.work.site;
      e.parked = e.mode === "working"; e.parkFor = 0; e.exitFootprint = false;
      e.biped = e.parked ? true : false;
      e.radius = WALK_RADIUS; e.foot = FOOT;
      e.pound = e.beat = e.stand = e.recover = 0; e.lounge = ""; e.loungeDepart = false; e.footprintMode = e.parked ? "stand" : "walk";
      e.gorilla.poseManaged(2, e.root.position.x, e.root.position.y, e.root.position.z, e.heading, 0, false, e.biped);
      e.compact = e.parked ? e.gorilla.standCompact : false;
      e.active = true; e.root.visible = false; e.hasSlot = false; e.jump.active = false; e.overflow = false;
      e.portalWait = false; e.portalRetry = 0;
      if (atPosition) {
        e.parked = e.biped = e.compact = false; e.footprintMode = "walk";
        e.phase = "controlled"; e.route = ""; e.speed = e.rest = e.blocked = e.retry = 0;
        d.run = d.passiveFall = d.cancelled = false; d.heading = e.heading;
        e.exitFootprint = true; e.height = WALK_HEIGHT;
        setGoal(e, e.root.position.x, e.root.position.y, e.root.position.z);
      } else if (e.mode === "working" && sites[e.site] && reserve(e)) {
        e.root.position.x = e.slotX; e.root.position.y = e.slotY; e.root.position.z = e.slotZ;
        e.heading = e.site === labSite ? (labStations[e.lab.station] || e.lab.waitPoint).heading : sites[e.site].mouth.ry;
        e.phase = "work"; e.route = ""; e.rest = 1 + e.random() * 2;
        setGoal(e, e.slotX, e.slotY, e.slotZ);
      } else {
        e.parked = false; e.biped = false; e.footprintMode = "walk";
        e.gorilla.poseManaged(2, e.root.position.x, e.root.position.y, e.root.position.z, e.heading, 0, false, false);
        e.compact = e.mode === "working" && e.gorilla.compact;
        if (e.mode === "working" ? spawnApproach(e) : spawnLounge(e)) {
          e.root.position.x = e.goalX; e.root.position.y = e.goalY; e.root.position.z = e.goalZ;
          if (e.mode === "working" && sites[e.site]) beginTravel(e, e.site);
        } else { e.active = false; e.retry = 1; return; }
      }
      syncLab(e);
      e.gorilla.poseManaged(atPosition || e.lounge ? 2 : 1 / 60, e.root.position.x, e.root.position.y, e.root.position.z, e.heading, 0, false, e.biped, e.lounge, e.motion);
      labEnvelope(e);
      if (e.lounge === "sit" && e.gorilla.sitCompact) { e.footprintMode = "sit"; e.compact = true; }
      e.root.visible = true;
      if (ctx.track && !e.tracked) { ctx.track(e); e.tracked = true; }
      if (e === debugShuttle) { debugShuttleAt = elapsed + 4; debugShuttleUntil = 0; }
    };
    for (let i = 0; i < crew.list.length; i++) {
      const owner = crew.list[i], gorilla = BL.agent.create({ managed: true, groundAt, climbSolidAt, groundPlaneAt: ctx.groundPlaneAt, groundHullAt: ctx.groundHullAt, scale: SCALE, coatClip });
      gorilla.poseManaged(0.6, 0, 0, 0, i * 2.39996323, 0, false, false);
      const entry = {
        owner, cave: owner, tooltipOwner: owner, gorilla, root: gorilla.root, parts: gorilla.parts,
        health: { value: BL.crew.HEALTH_MAX * 2, max: BL.crew.HEALTH_MAX * 2, delay: 0 }, index: i,
        rage: BL.clankerRage.state(),
        radius: WALK_RADIUS, height: 2.7, foot: FOOT, minY: 0, biped: false, compact: owner.state === "working" && gorilla.compact, footprintMode: "walk",
        active: false, tracked: false, mode: "", phase: "", route: "", entryTurn: false, planningEntry: false, site: -1, fromSite: -1, portal: -1,
        hasSlot: false, slotIndex: -1, slotX: 0, slotY: 0, slotZ: 0, goalX: 0, goalY: 0, goalZ: 0,
        random: mulberry32(fnv1a(`clanker/${owner.id || owner.traits.name || i}`)),
        // Its bed while its Ooga sleeps: see `updateSleep`.
        sleep: { stage: "", slot: -1, leg: 0, count: 0, path: new Float64Array(SLEEP_POINTS * 2), mark: 0, pose: "", stall: 0, near: Infinity },
        heading: i * 2.39996323, speed: 0, blocked: 0, retry: 0, rest: 0, turn: 1, portalWait: false,
        steerHeading: NaN, steerSide: 0, steerFor: 0, steerClear: 0, steerGoalX: NaN, steerGoalZ: NaN,
        backoutLeft: 0, backoutHeading: 0,
        sampleTime: 0, sampleX: 0, sampleZ: 0, stuckTime: 0, portalSince: 0, portalRetry: 0,
        stuck: { time: 0, stage: 0, taskTime: 0, taskActive: false, taskX: 0, taskZ: 0, taskDistance: 0,
          invalidTime: 0, invalidX: NaN, invalidZ: NaN,
          replans: 0, recoveries: 0, escapes: 0, escapeLeft: 0, escapeBlocked: 0, escapeX: 0, escapeZ: 0,
          retryAt: 0, reason: "", x: NaN, y: NaN, z: NaN, workTime: 0, workCycles: 0, workReach: 0, workStage: "", workItem: -1,
          turnError: Infinity, heading: NaN, searchCursor: 0 },
        overflow: false, activity: 0, hits: 0, pounds: 0, pound: 0, poundHit: false, poundPower: 2.5, smashSerial: 0,
        beat: 0, beats: 0, stand: 0, parked: false, parkFor: 0, exitFootprint: false, workCycle: 0, recover: 0, lounge: "", jumps: 0,
        loungePartner: null, loungeHeading: NaN, loungeCycle: 0, loungeRoof: false, loungeDepart: false, groomTime: 0, groomWait: 0,
        planningRoam: false, planningSeat: false, walkPoseChecked: false, roam: { path: new Float64Array(12), count: 0, index: 0, wall: false, detour: false, level: 0, reverseStart: false, departHeading: 0, propDeparture: false,
          targetX: NaN, targetY: NaN, targetZ: NaN, order: 0, waitUntil: 0, blocked: 0, obstacle: null, waitPeer: null, waitX: 0, waitZ: 0,
          plans: 0, arrived: false, pose: "", poseWait: 0, lastPose: "", transition: 0, nextChoice: 0, failedChoices: 0, runUp: 0, jumpRetry: 0,
          departPending: false, departAt: 0, departX: 0, departY: 0, departZ: 0, riseAdmitted: false,
          wallFailedX: NaN, wallFailedZ: NaN, wallFailedUntil: 0,
          levelOnlyUntil: 0, planAt: 0, progressTime: 0, progressX: NaN, progressZ: NaN, progressDistance: Infinity, progressTurn: Infinity, progressCursor: -1, progressClaim: 0, backoutX: NaN, backoutZ: NaN, alignTime: 0, failedX: NaN, failedZ: NaN, failedUntil: 0 },
        controlled: false, pendingSite: -1, actionControlled: false,
        debugMove: { active: false, cancelled: false, status: "", reason: "", target: { x: 0, y: 0, z: 0 },
          goal: { x: 0, y: 0, z: 0, heading: NaN }, candidate: 0, hops: 0, normalized: false,
          normalizeAt: 0, normalizeScore: Infinity, wallTarget: false, wallPending: false, wallFinal: false,
          normalX: 0, normalY: 1, normalZ: 0, normalHeading: NaN, originX: 0, originY: 0, originZ: 0,
          progressDistance: Infinity, progressTime: 0,
          visited: new Float64Array(32 * 3), visitedCount: 0, visitedNext: 0,
          failed: new Float64Array(32 * 3), failedCount: 0, failedNext: 0 },
        planningLab: false, planningLabWork: "", planningLabSide: 1, planningLabStation: -1, lab: { station: -1, time: 0, arrived: false, cycles: 0, waitSince: 0,
          item: -1, pickup: -1, bench: -1, pickupPoint: { x: 0, y: 0, z: 0, heading: 0, side: 1 },
          stage: "", reach: 0, yielding: 0, yieldStation: -1, yieldSide: 1, yieldUntil: 0, yieldFor: null, yieldDX: 0, yieldDZ: 0,
          yieldAlong: 0, yieldChoice: 0, yieldReady: false, yieldTargetX: 0, yieldTargetZ: 0,
          yieldProgressX: 0, yieldProgressZ: 0, yieldProgressAt: 0, yieldPoint: { x: 0, y: 0, z: 0, heading: 0 },
          squeezeUntil: 0, waitPoint: { x: 0, y: 0, z: 0, heading: 0 }, coordinationUntil: 0, path: new Float64Array(16 * 3), pathFacings: new Float64Array(16), pathWaits: new Float64Array(16), plans: 0, readyAt: 0, targetHeading: 0, trafficWait: 0, pathPending: false, pathPartial: false, pathFixed: false, pathHeading: 0, pathCount: 0, pathIndex: 0, pathAt: 0, targetX: NaN, targetY: NaN, targetZ: NaN },
        drive: { x: 0, z: 0, climbAxis: 0, climbSide: 0, heading: NaN, climbExitHeading: NaN, climbExitLook: NaN, climbTurnTimer: 0,
          run: false, jumpHeld: false, jumpDown: false, jumpPressed: false, jumpBuffer: 0, jumps: 0, avoidSide: 0, avoidHeading: 0, avoidTime: 0,
          cancelled: false, vx: 0, vy: 0, vz: 0, airborne: false, passiveFall: false, wallRelease: false, grounded: true, resume: false, motionRecover: 0, motionEnvelope: false },
        motion: { poundCharge: 0, takeoff: 0, landing: 0, supportOffset: 0, supportEntry: null, swim: 0, rage: false,
          groundRects: { flat: { x: 0, y: 0, z: 0, heading: 0 }, angled: { x: 0, y: 0, z: 0, heading: 0, groundX: 0, groundZ: 0, steep: false, walkable: true } },
          walkPhase: NaN, roll: 0, rollAngle: 0, rollSide: 0, smash: false, dragging: false, throwProgress: 0,
          climbGripX: NaN, climbGripY: NaN, climbGripZ: NaN, climbGripStride: 0, climbGripDirection: 0, climbGripSide: 0, climbGripRelease: 0,
          climb: 0, climbBlend: NaN, openingSettle: 0, climbStride: 0, climbDirection: 0, climbSide: 0, verifyGrip: false, mantle: 0, groom: 0, groomSide: 1, groomPhase: 0,
          sitWait: 3, sitTime: 0, sitLook: 0, sitShift: 0, sitLookTarget: 0, sitShiftTarget: 0,
          lab: false, labRunIn: false, workExit: false, labWork: "", labPhase: i * 0.71, labSide: 1, labDt: 1 / 30, labReach: 0, labGripY: 0.53105, labItemGeometry: null, labSqueeze: false,
          labDie: false, labRoll: 0, labBench: null },
        climb: { active: false,
          panel: { x: 0, y: 0, z: 0, heading: 0, nx: 0, nz: 1, u: 0, v: 0, depth: 0 },
          autoDirection: -1, descending: false, progress: 0, length: 0, lowerY: 0, upperY: 0, climbs: 0,
          count: 0, index: 0, heading: 0, topHeading: 0, exitHeading: 0, fromTop: false, basePrepEnd: 0, lowerGroundDistance: 0, bottomTurn: 0, mount: 0, finish: 0, retry: 0, blocked: 0, mantleStart: 0, mantleRiseEnd: 0, autoTo: -1, waitRelease: false, lowerExit: true, minimum: 0, attempts: 0, failure: "", blockX: 0, blockY: 0, blockZ: 0,
          searchPending: false, searchDeferred: false, searchCursor: 0, searchIndex: 0, searchBudget: 0,
          searchX: 0, searchY: 0, searchZ: 0, searchHeading: 0, searchDescending: false,
          searchGoalX: 0, searchGoalY: 0, searchGoalZ: 0,
          claimPending: false, crestPending: false, claimOrder: 0, claimFor: -1, claimOwnerOrder: 0, claimProgress: 0, claimProgressAt: 0, claimRetreat: false,
          returning: false, reversals: 0, holdPose: false, free: false, lipBypass: false, mountPending: false, airAttachAfter: 0, departureRetry: 0, departurePlanning: false, handoffDirection: 0,
          freeTargetX: 0, freeTargetY: NaN, freeTargetZ: 0, openingCrossY: 0,
          openingStagePending: false, openingStageX: 0, openingStageZ: 0,
          openingExit: false, openingExitX: 0, openingExitZ: 0, openingExitHeading: 0,
          handoffStartX: 0, handoffStartY: 0, handoffStartZ: 0, gripPreparedAt: -Infinity,
          debugRole: -1, debugTraverse: false, debugStuck: false, debugStop: -1, traverseStart: 0, traverseEnd: 0, lowerClearance: 0, lowerClearanceAscent: false,
          peerCheck: false, peerX: 0, peerY: 0, peerZ: 0, peerHeading: 0,
          points: new Float64Array((ctx.debugMovement ? 512 : CLIMB_POINTS) * 3), lengths: new Float64Array(ctx.debugMovement ? 512 : CLIMB_POINTS),
          headings: new Float64Array(ctx.debugMovement ? 512 : CLIMB_POINTS) },
        fire: { burning: false, contactBurning: false, age: 0, heat: 0, rolling: false, rollTime: 0, soot: 0, cooldown: 0,
          reaction: 0, rollRecover: 0, x: 0, z: 0, heading: 0, requested: false, retry: 0,
          escaping: false, escapeRetry: 0, escapeX: 0, escapeY: 0, escapeZ: 0,
          panic: { active: false, x: 0, y: 0, z: 0, seenAt: -Infinity, awayX: 0, awayZ: 0 } },
        fireFX: { next: 0 },
        jump: { active: false, progress: 0, reverse: false, blocked: 0, duration: 0, fromX: 0, fromY: 0, fromZ: 0,
          toX: 0, toY: 0, toZ: 0, lift: 0, wall: false, caveExit: false,
          points: new Float64Array((JUMP_SAMPLES + 1) * 3) }
      };
      entry.motion.supportEntry = entry;
      gorilla.root.visible = false;
      gorilla.root.matrixNative = false;
      gorilla.root.matrixLiving = true;
      addChild(ctx.root, gorilla.root);
      list.push(entry); byOwner.set(owner, entry);
    }
    const sync = () => {
      if (disposed) return;
      for (let i = 0; i < list.length; i++) if (!list[i].active && alive(list[i].owner)) activate(list[i]);
    };
    sync();
    const startLabShuttle = (owner) => {
      const e = byOwner.get(owner);
      if (labSite < 0 || !e) return false;
      debugShuttle = e; debugShuttleAt = elapsed + 4; debugShuttleUntil = 0;
      owner.work.site = owner.work.plannedSite = labSite;
      if (!e.active) activate(e);
      if (e.site !== labSite || e.phase === "chill") beginTravel(e, labSite);
      return true;
    };
    const plan = (cave, index) => {
      const e = byOwner.get(cave);
      if (!e || !sites[index]) return;
      if (e === debugShuttle && index !== labSite) return;
      if (e.controlled || e.rage.active || e.drive.airborne || e.climb.active || e.debugMove.active) { e.pendingSite = index; return; }
      // Reloading never evicts a gorilla whose next shift is in this cave.
      if (e.site === index) return;
      if (!e.active) { e.site = index; return; }
      // Release this job and its held equipment now; returning to a bench
      // must not keep the owner waiting at the next repository.
      e.pendingSite = -1;
      e.rest = e.stand = e.beat = 0;
      beginTravel(e, index);
    };
    const jumpPoint = (jump, t, out) => {
      out.x = jump.fromX + (jump.toX - jump.fromX) * t;
      out.y = jump.fromY + (jump.toY - jump.fromY) * t + jump.lift * 4 * t * (1 - t);
      out.z = jump.fromZ + (jump.toZ - jump.fromZ) * t;
    };
    const prepareJump = (e, x, y, z, lift = 0, vault = false, running = false, wall = false) => {
      if (e.motion.lab && !e.controlled) return false;
      const p = e.root.position, jump = e.jump, distance = Math.hypot(x - p.x, z - p.z);
      if (distance > MAX_JUMP || y > p.y + (running ? ROOF_JUMP_HEIGHT : 1.7) || y < p.y - 7.5
        || (wall ? wallContactShare(e, x, y, z, e.heading) < WALL_ENTER_SHARE
          || !climbClear(e, x, y, z, x, y, z, e.heading) : !landing(x, y, z))
        || e.phase === "work" && caveAt(x, y, z, AIR_RADIUS) !== e.site) return false;
      let duration = running ? distance / SPEED : Math.max(vault ? 1 : 0.52, distance / (vault ? 2.4 : 3.3));
      const rageAscent = running && e.rageTraversal && y > p.y;
      if (rageAscent) {
        // Rage approaches can use the full jump reach to a high landing. Do not
        // stretch that arc to the ordinary stroll speed. The longest legal
        // flight rises to the maximum apex, then descends to this landing.
        const rise = y - p.y, apexTime = Math.sqrt(2 * ROOF_JUMP_HEIGHT / GRAVITY);
        duration = clamp(duration, Math.sqrt(2 * rise / GRAVITY),
          apexTime + Math.sqrt(2 * (ROOF_JUMP_HEIGHT - rise) / GRAVITY));
      }
      if (running) {
        // Keep a gravity-shaped arc at the chosen running speed. Reject
        // landings above the apex or beyond the bounded running-jump height.
        const velocity = (y - p.y) / duration + GRAVITY * duration * 0.5;
        const tolerance = rageAscent ? 1e-9 : 0;
        if (velocity <= 0 || velocity - GRAVITY * duration > tolerance
          || velocity * velocity / (2 * GRAVITY) > ROOF_JUMP_HEIGHT + tolerance) return false;
        lift = GRAVITY * duration * duration / 8;
      }
      // A voluntary jump must not bypass the fireplace detour just because
      // its airborne arc clears the flame. Walk around the pit and rim.
      if (!e.controlled && ctx.fireClear && !ctx.fireClear(e, p.x, p.y, p.z, x, y, z)) return false;
      const previousRadius = e.radius, previousHeight = e.height, previousCompact = e.compact;
      e.compact = false;
      // Use the same measured envelope that poseEntry retains throughout flight.
      e.radius = Math.max(MOTION_RADIUS, previousRadius); e.height = Math.max(MOTION_HEIGHT, previousHeight);
      if (occupied(e, p.x, p.y, p.z) || !staticClear(e, p.x, p.y, p.z) || occupied(e, x, y, z)) {
        e.radius = previousRadius; e.height = previousHeight; e.compact = previousCompact; return false;
      }
      jump.fromX = p.x; jump.fromY = p.y; jump.fromZ = p.z;
      jump.toX = x; jump.toY = y; jump.toZ = z;
      jump.lift = lift || 0.5 + distance * 0.16;
      jump.duration = duration;
      if (y < p.y - 1.7) {
        jump.lift = Math.max(jump.lift, (p.y - y) * 0.55 + 0.4);
        jump.duration = Math.max(jump.duration, Math.sqrt((p.y - y) * 2 / 9.8) + 0.45);
      }
      const points = jump.points;
      points[0] = p.x; points[1] = p.y; points[2] = p.z;
      for (let i = 1; i <= JUMP_SAMPLES; i++) {
        jumpPoint(jump, i / JUMP_SAMPLES, POINT);
        const j = i * 3;
        if (!staticClear(e, points[j - 3], points[j - 2], points[j - 1], POINT.x, POINT.y, POINT.z)
          || occupied(e, POINT.x, POINT.y, POINT.z)) { e.radius = previousRadius; e.height = previousHeight; e.compact = previousCompact; return false; }
        points[j] = POINT.x; points[j + 1] = POINT.y; points[j + 2] = POINT.z;
      }
      jump.active = true; jump.wall = wall; jump.caveExit = false; jump.progress = 0; jump.reverse = false; jump.blocked = 0; e.jumps++;
      return true;
    };
    const tryRoofHop = (e, heading, destination) => {
      const p = e.root.position, previousHeading = e.heading;
      if (Math.cos(heading - previousHeading) < 0.85) return false;
      const sx = Math.sin(heading), sz = Math.cos(heading);
      e.heading = heading;
      // Land on the destination hill's supported top. The shared jump proof
      // bounds the gravity arc and sweeps every segment against live scenery.
      for (let distance = 2; distance <= MAX_JUMP; distance += 0.4) {
        const x = p.x + sx * distance, z = p.z + sz * distance, y = ctx.surfaceAt(x, z);
        if (roofAt(x, y, z) !== destination
          || Math.abs(pointSupportAt(x, z, y + 0.02, e) - y) > 0.05) continue;
        if (prepareJump(e, x, y, z, 0, false, true)) {
          e.roam.runUp = 0; e.motion.takeoff = 1; return true;
        }
      }
      e.heading = previousHeading;
      return false;
    };
    const tryRoofJump = (e, heading) => {
      const p = e.root.position, previousHeading = e.heading;
      // An active entrance has no face at ground height. Measure the stone
      // above its opening before aiming the running jump at that panel.
      const approach = heading;
      heading = wallFaceHeading(e, heading);
      if (!Number.isFinite(heading) && wallPanels.fit(p.x, p.y + 3.5, p.z, approach, PANEL)) heading = PANEL.heading;
      if (!Number.isFinite(heading) || Math.cos(heading - previousHeading) < 0.85) return false;
      const sx = Math.sin(heading), sz = Math.cos(heading);
      e.heading = heading;
      // Aim for a real grip above the opening, not a roof landing. Twelve
      // candidates bound the arc proofs; the ordinary climber finishes the trip.
      for (let distance = 2.4; distance <= 4.81; distance += 0.8) {
        const x = p.x + sx * distance, z = p.z + sz * distance;
        for (let level = 0; level < 3; level++) {
          const y = e.goalY - 1.4 - level * 0.8;
          if (y <= p.y + 1
            || !climbSolidAt(x + sx * CLIMB_STANDOFF, y + 0.25, z + sz * CLIMB_STANDOFF)
            || !climbSolidAt(x + sx * CLIMB_STANDOFF, y + 0.85, z + sz * CLIMB_STANDOFF)) continue;
          if (prepareJump(e, x, y, z, 0, false, true, true)) {
            e.roam.runUp = 0; e.motion.takeoff = 1; return true;
          }
        }
      }
      e.heading = previousHeading;
      return false;
    };
    const tryJump = (e, heading) => {
      const p = e.root.position, sx = Math.sin(heading), sz = Math.cos(heading);
      const vaultLift = caveAt(p.x, p.y, p.z) >= 0 ? 1.4 : 2.2;
      for (let distance = 0.35; distance <= MAX_JUMP; distance += 0.35) {
        const x = p.x + sx * distance, z = p.z + sz * distance;
        if (distance < 1) continue;
        const y = groundAt(x, z, p.y + 1.65);
        if (prepareJump(e, x, y, z) || prepareJump(e, x, y, z, vaultLift, true)) return true;
      }
      return false;
    };
    const updateJump = (e, dt) => {
      const jump = e.jump, p = e.root.position;
      let next = jump.progress, moved = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        next = clamp(jump.progress + (jump.reverse ? -dt : dt) / jump.duration, 0, 1);
        jumpPoint(jump, next, POINT);
        // Reservations prevent a new leap from crossing an existing route.
        // In flight, sweep the actual bodies: conservative future corridors
        // must not pin an already-airborne clanker in both directions.
        if (staticClear(e, p.x, p.y, p.z, POINT.x, POINT.y, POINT.z)
          // Admit the actual next animated hand/captive pose before advancing
          // the arc cursor. A refusal reverses through the same checked arc.
          && (!rageCarrying(e) || ctx.rageJumpPoseClear?.(e, dt, POINT.x, POINT.y, POINT.z,
            Math.hypot(jump.toX - jump.fromX, jump.toZ - jump.fromZ) / jump.duration,
            next !== 1 && !(next === 0 && jump.reverse)) !== false)) { moved = true; break; }
        // Moving actors can temporarily obstruct either end. Recheck both
        // directions, so a blocked retreat can resume a now-clear landing.
        jump.reverse = !jump.reverse;
      }
      if (!moved) {
        e.speed = 0; jump.blocked += dt;
        if (jump.blocked >= 0.4) {
          // A moving neighbour can close both directions of an authored arc.
          // Release that arc into the same swept gravity/landing controller as
          // a player jump instead of suspending the clanker in midair forever.
          const d = e.drive;
          d.vx = d.vz = 0;
          d.vy = Math.min(0, ((jump.toY - jump.fromY) + jump.lift * 4 * (1 - jump.progress * 2)) / jump.duration);
          d.airborne = d.resume = d.motionEnvelope = true; d.passiveFall = d.grounded = false; d.motionRecover = 0.6;
          jump.active = false; e.motion.takeoff = 0;
          if (e.rage.active) {
            // A refused rage arc needs the same checked outward recovery as
            // a released wall grip. Keep the flying pose if its held body
            // cannot yet fit the passive-fall pose at this height.
            d.wallRelease = true;
            d.passiveFall = !rageCarrying(e) || ctx.rageJumpPoseClear?.(e, dt, p.x, p.y, p.z, 0, false) !== false;
            e.climb.airAttachAfter = Infinity;
          }
        }
        return;
      }
      jump.blocked = 0;
      p.x = POINT.x; p.y = POINT.y; p.z = POINT.z; jump.progress = next;
      e.speed = Math.hypot(jump.toX - jump.fromX, jump.toZ - jump.fromZ) / jump.duration;
      if (next === 1 && jump.wall) {
        const d = e.drive;
        d.airborne = true;
        d.vx = (jump.toX - jump.fromX) / jump.duration;
        d.vz = (jump.toZ - jump.fromZ) / jump.duration;
        d.vy = (jump.toY - jump.fromY - jump.lift * 4) / jump.duration;
        if (attachContactWall(e)) {
          jump.active = false; e.climb.fromTop = false; return;
        }
        // A moved obstruction can invalidate the grip during flight. Retrace
        // the checked arc to the takeoff footing instead of standing in air.
        d.airborne = false; d.vx = d.vy = d.vz = 0; jump.reverse = true; return;
      }
      if (next === 1 || next === 0 && jump.reverse) {
        jump.active = false; e.blocked = 0; e.rest = Math.max(e.rest, 0.12);
      }
    };
    // One bounded, reversible wall route per gorilla. Endpoints reserve a full
    // walking body; the upright climb reserves the measured hand/foot envelope.
    let climbClaimSerial = 0;
    const climbTransitionPeers = (e, x, y, z, nx, ny, nz, radius, height, actors, riders, toRadius, toHeight, peers, part, hull) => {
      const c = e.climb;
      if (c.peerCheck) {
        c.peerCheck = false;
        const p = e.root.position;
        if (ctx.climbPeersClear && !ctx.climbPeersClear(e, c.peerX, c.peerY, c.peerZ,
          p.x, p.y, p.z, c.peerHeading, e.root.rotation.y, true)) return false;
      }
      return !ctx.climbTransitionClear || ctx.climbTransitionClear(e, x, y, z, nx, ny, nz,
        radius, height, actors, riders, toRadius, toHeight, !ctx.climbPeersClear, part, hull);
    };
    climbTransitionPeers.needsHull = !!(ctx.climbTransitionClear && ctx.climbTransitionClear.needsHull);
    const climbPoseClear = (e, dt, x, y, z, heading, motion, speed = 0) => {
      const c = e.climb, p = e.root.position;
      c.peerX = p.x; c.peerY = p.y; c.peerZ = p.z; c.peerHeading = e.heading;
      c.peerCheck = true;
      const fits = e.gorilla.climbPoseClear(dt, x, y, z, heading, motion, ctx.solidAt,
        climbTransitionPeers, e, speed);
      c.peerCheck = false;
      return fits;
    };
    const climbClear = (e, x, y, z, nx = x, ny = y, nz = z, heading = e.climb.active ? e.climb.heading : e.heading, actors = true, wallTravel = false) => {
      const departure = descentWallAt(e, x, y, z, heading);
      // Stay on the exterior face down to the jump height, even where its
      // entrance apron is reserved. The actual stone/prop sweep still applies.
      if (autonomousChill(e) && !(wallTravel && departure && ny > departure.floor + 0.6)
        && !chillCaveClear(x, y, z, nx, ny, nz, true)) return false;
      if (!wallTravel && actors && !e.controlled && ctx.climbPeersClear
        && !ctx.climbPeersClear(e, x, y, z, nx, ny, nz, heading, heading)) return false;
      if (e.motion.dragging && ctx.rageCarryClear
        && !ctx.rageCarryClear(e, x, y, z, nx, ny, nz, heading, heading)) return false;
      // The upright rectangle owns wall support. On the wall, only the core
      // and actual props are swept; individual stone voxels are not blockers.
      const radius = wallTravel || e.controlled ? 0.12 : 0.42;
      return ctx.climbClear ? ctx.climbClear(e, x, y + 0.85, z, nx, ny + 0.85, nz,
        radius, 0.5, false, wallTravel ? false : actors, wallTravel || e.controlled || !ctx.climbPeersClear, !wallTravel)
        : clear(x, y + 0.85, z, nx, ny + 0.85, nz, radius, 0.5, e);
    };
    const climbWalkClear = (e, x, y, z, nx, ny, nz, heading, actors = true) => {
      if (autonomousChill(e) && !chillCaveClear(x, y, z, nx, ny, nz, true)) return false;
      if (actors && ctx.climbPeersClear && !ctx.climbPeersClear(e, x, y, z, nx, ny, nz, heading, heading)) return false;
      return ctx.climbClear ? ctx.climbClear(e, x, y + 0.65, z, nx, ny + 0.65, nz,
        0.42, 0.5, false, actors, !ctx.climbPeersClear)
        : clear(x, y + 0.65, z, nx, ny + 0.65, nz, 0.42, 0.5, e);
    };
    const climbPoint = (c, distance, out) => {
      let i = c.index;
      while (i > 0 && c.lengths[i] > distance) i--;
      while (i < c.count - 2 && c.lengths[i + 1] < distance) i++;
      c.index = i;
      const k = clamp((distance - c.lengths[i]) / Math.max(0.0001, c.lengths[i + 1] - c.lengths[i]), 0, 1), at = i * 3;
      out.x = c.points[at] + (c.points[at + 3] - c.points[at]) * k;
      out.y = c.points[at + 1] + (c.points[at + 4] - c.points[at + 1]) * k;
      out.z = c.points[at + 2] + (c.points[at + 5] - c.points[at + 2]) * k;
      out.heading = c.headings[i] + Math.atan2(Math.sin(c.headings[i + 1] - c.headings[i]), Math.cos(c.headings[i + 1] - c.headings[i])) * k;
    };
    const CLIMB_GROUND_POINT = { x: 0, y: 0, z: 0, heading: 0 };
    const climbGroundPoint = (c, end) => {
      const index = c.index;
      climbPoint(c, end === 2 ? c.length : end === 1 ? c.lowerGroundDistance : c.basePrepEnd, CLIMB_GROUND_POINT);
      c.index = index;
      return CLIMB_GROUND_POINT;
    };
    const climbClaimOccupied = (e, x, y, z, heading, owner) => {
      const c = owner.climb;
      if (!c.active || c.free) return false;
      const planning = owner.planningRoam, height = owner.height;
      // A wall grip has a smaller trunk footprint than its grounded finish.
      // Keep both supported ends free in case a temporary obstacle requires
      // returning to the original footing; arms still share peer space.
      owner.planningRoam = true; owner.height = WALK_HEIGHT;
      try {
        for (let end = c.lowerExit ? 0 : 2; end < 3; end++) {
          const p = climbGroundPoint(c, end), facing = end === 2 ? c.topHeading : c.heading;
          if (torso.overlaps(e, x, y, z, heading, owner, p.x, p.y, p.z, facing, SPACE)) return true;
        }
        return false;
      } finally { owner.planningRoam = planning; owner.height = height; }
    };
    const climbGroundPeersClear = (e) => {
      if (!ctx.climbPeersClear) return true;
      const c = e.climb, planning = e.planningRoam, height = e.height;
      e.planningRoam = true; e.height = WALK_HEIGHT;
      try {
        for (let end = c.lowerExit ? 0 : 2; end < 3; end++) {
          const p = climbGroundPoint(c, end), facing = end === 2 ? c.topHeading : c.heading;
          if (!ctx.climbPeersClear(e, p.x, p.y, p.z, p.x, p.y, p.z, facing, facing, true)) return false;
        }
        return true;
      } finally { e.planningRoam = planning; e.height = height; }
    };
    const appendClimbPoint = (e, x, y, z) => {
      const c = e.climb, i = c.count, at = i * 3;
      if (i >= c.lengths.length) return false;
      const distance = i ? Math.hypot(x - c.points[at - 3], y - c.points[at - 2], z - c.points[at - 1]) : 0;
      if (i && distance < 0.0001) return true;
      const px = i ? c.points[at - 3] : x, py = i ? c.points[at - 2] : y, pz = i ? c.points[at - 1] : z;
      // A moving neighbour cannot invalidate the whole future climb. Check
      // stone/props here, then actual nearby bodies on each movement step.
      if (!climbClear(e, px, py, pz, x, y, z, e.climb.probeHeading, false)) {
        c.blockX = x; c.blockY = y; c.blockZ = z; return false;
      }
      c.points[at] = x; c.points[at + 1] = y; c.points[at + 2] = z;
      c.headings[i] = c.probeHeading;
      c.length += distance; c.lengths[i] = c.length; c.count++;
      return true;
    };
    const plannedTurnMotion = { climb: 1, climbBlend: 1, mantle: 0, climbStride: 0, climbDirection: 0, climbSide: 0 };
    const plannedTurnClear = ctx.climbTransitionClear ? (e, x, y, z, nx, ny, nz, radius, height, actors, riders, toRadius, toHeight) =>
      ctx.climbTransitionClear(e, x, y, z, nx, ny, nz, radius, height, false, false, toRadius, toHeight) : null;
    const climbStartTurnClear = (e, heading) => {
      const p = e.root.position, turn = Math.atan2(Math.sin(heading - e.heading), Math.cos(heading - e.heading));
      if (Math.abs(turn) < 0.001) return true;
      const compact = e.compact, planning = e.planningRoam, mode = e.footprintMode, radius = e.radius, height = e.height;
      const active = e.climb.active;
      // The first turn is still planted walking. Admission and execution
      // must use that same collision state before the hands take the wall.
      e.climb.active = false;
      e.compact = e.planningRoam = true; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
      try {
        // Admission reserves the same full walking turn as a ground route.
        // The mount cannot start by snapping from an arbitrary approach yaw
        // onto the wall bearing, especially when perched on a narrow ledge.
        if (!staticClear(e, p.x, p.y, p.z, p.x, p.y, p.z, e.heading, heading)) return false;
        const steps = Math.max(1, Math.ceil(Math.abs(turn) / 0.12));
        for (let i = 1; i <= steps; i++) {
          const y = support(e, p.x, p.z, p.y, STEP, e.heading + turn * i / steps);
          if (!Number.isFinite(y) || y > p.y + 0.1 || p.y - y > STEP) return false;
        }
        return true;
      } finally { e.climb.active = active; e.compact = compact; e.planningRoam = planning; e.footprintMode = mode; e.radius = radius; e.height = height; }
    };
    const bottomTurnClear = (e, x, y, z, heading) => {
      // Lower into the grounded pose without turning away from the wall.
      // The chosen footfall must fit the complete pose at this heading.
      plannedTurnMotion.climbDirection = 0;
      plannedTurnMotion.climbSide = 0;
      plannedTurnMotion.climbStride = e.motion.climbStride + y - e.root.position.y;
      for (let i = 0; i <= 16; i++) {
        const turn = i / 16;
        let blend = 1 - turn * turn * (3 - 2 * turn), clear = false;
        // Match the controller's hand release beside projecting stone.
        for (;;) {
          plannedTurnMotion.climbBlend = blend; plannedTurnMotion.mantle = 0;
          if (e.gorilla.climbPoseClear(2, x, y, z, heading, plannedTurnMotion,
            ctx.solidAt, plannedTurnClear, e, 0, true)) { clear = true; break; }
          if (blend >= 1 || i === 16) break;
          blend = Math.min(1, blend + 0.12);
        }
        if (!clear) return false;
      }
      return true;
    };
    const climbCrestClear = (e) => {
      const c = e.climb, p = e.root.position, savedIndex = c.index;
      plannedTurnMotion.climbSide = 0;
      const length = c.length - c.mantleStart;
      const samples = Math.min(40, Math.max(4, Math.ceil(length / 0.25)));
      let fits = true, facing = c.descending ? c.topHeading : c.heading;
      for (let i = 0; i <= samples; i++) {
        const distance = c.mantleStart + length * (c.descending ? 1 - i / samples : i / samples);
        climbPoint(c, distance, POINT);
        const top = distance < c.mantleRiseEnd
          ? 0.65 * (distance - c.mantleStart) / Math.max(0.01, c.mantleRiseEnd - c.mantleStart)
          : 0.65 + 0.35 * (distance - c.mantleRiseEnd) / Math.max(0.1, c.length - c.mantleRiseEnd);
        const turn = Math.atan2(Math.sin(c.topHeading - c.heading), Math.cos(c.topHeading - c.heading));
        plannedTurnMotion.climbBlend = (1 - top) * (1 - top);
        plannedTurnMotion.mantle = top;
        plannedTurnMotion.climbStride = e.motion.climbStride + POINT.y - p.y;
        plannedTurnMotion.climbDirection = c.descending ? -1 : 1;
        const heading = c.heading + turn * top;
        if (e.gorilla.climbPoseClear(2, POINT.x, POINT.y, POINT.z, heading,
          plannedTurnMotion, ctx.solidAt, plannedTurnClear, e, 0, true)) facing = heading;
        // Runtime can retain the last clear yaw while folding past an uneven
        // lip. Prove that same pose in travel order, including descent.
        else if (!e.gorilla.climbPoseClear(2, POINT.x, POINT.y, POINT.z, facing,
          plannedTurnMotion, ctx.solidAt, plannedTurnClear, e, 0, true)) {
          c.blockX = POINT.x; c.blockY = POINT.y; c.blockZ = POINT.z; fits = false; break;
        }
      }
      c.index = savedIndex;
      return fits;
    };
    const wallGrip = (x, y, z, heading) => {
      const sx = Math.sin(heading), sz = Math.cos(heading);
      // Both the lower foot holds and upper hand holds need actual stone.
      // A torso-clear point beside an opening is not a climbable surface.
      for (let level = 0; level < 2; level++) {
        let found = false;
        for (let side = -1; side <= 1 && !found; side++) for (let depth = 0.25; depth <= 1.65; depth += 0.14) {
          if (climbSolidAt(x + sx * depth + sz * side * 0.42, y + 0.35 + level * 1.45,
            z + sz * depth - sx * side * 0.42)) { found = true; break; }
        }
        if (!found) return false;
      }
      return true;
    };
    const wallBodyClear = (x, y, z, heading) => {
      const sx = Math.sin(heading), sz = Math.cos(heading);
      // The grip can reach over a projecting ledge while the torso cannot.
      // Keep the upright rectangle outside the stone at its lower, middle and
      // upper levels, without treating individual limbs as movement blockers.
      for (let level = 0; level < 4; level++) for (let depth = 0; depth <= 0.76; depth += 0.38) {
        if (climbSolidAt(x + sx * depth, y + 0.42 + level * 0.48,
          z + sz * depth)) return false;
      }
      return true;
    };
    const wallEdgeClear = (e, x, y, z, heading, nx, ny, nz) => {
      return Math.hypot(nx - x, ny - y, nz - z) <= WALL_STEP * 2.5
        && climbClear(e, x, y, z, nx, ny, nz, heading, false);
    };
    const plannedGuideMotion = { climb: 1, climbBlend: 1, mantle: 0, climbStride: 0,
      climbDirection: 0, climbSide: 0, verifyGrip: true };
    const climbGuidePoseClear = (e, x, y, z, heading, bothHands = true) => {
      plannedGuideMotion.climbStride = e.motion.climbStride + y - e.root.position.y;
      return e.gorilla.climbPoseClear(2, x, y, z, heading, plannedGuideMotion,
        ctx.solidAt, plannedTurnClear, e, 0, true)
        && (bothHands ? e.gorilla.climbContactMask === 3 : !!e.gorilla.climbContactMask);
    };
    const projectWallPoint = (e, x, y, z, px, py, pz, heading, side, vertical) => {
      let best = Infinity;
      plannedTurnMotion.climbBlend = 1; plannedTurnMotion.mantle = 0;
      plannedTurnMotion.climbSide = side; plannedTurnMotion.climbDirection = vertical;
      plannedTurnMotion.climbStride = e.motion.climbStride + Math.hypot(x - px, y - py, z - pz);
      const sx = Math.sin(heading), sz = Math.cos(heading);
      let wall = Infinity;
      for (let h = 0; h < 7; h++) for (let across = -1; across <= 1; across++) {
        for (let depth = 0.08; depth <= 2.6; depth += 0.16) {
          if (climbSolidAt(x + sx * depth + sz * across * 0.72, y + 0.06 + h * 0.48,
            z + sz * depth - sx * across * 0.72)) { wall = Math.min(wall, depth - 0.04); break; }
        }
      }
      if (!Number.isFinite(wall)) return false;
      const depth = wall - CLIMB_STANDOFF;
      // Keep the previous contact plane across small recesses instead of
      // moving in and out with each stone. Project outward at protrusions;
      // the unchanged edge sweep still owns corners and openings.
      const steady = clamp((px - x) * sx + (pz - z) * sz, depth - 0.36, depth);
      for (let trial = -1; trial < 4; trial++) {
        const offset = trial < 0 ? steady : depth - trial * 0.12;
        const nx = x + sx * offset, nz = z + sz * offset;
        const score = (nx - x) ** 2 + (nz - z) ** 2;
        if (score >= best || !wallBodyClear(nx, y, nz, heading) || !wallGrip(nx, y, nz, heading)
          || !wallEdgeClear(e, px, py, pz, heading, nx, y, nz)
          || trial < 0 && !climbGuidePoseClear(e, nx, y, nz, heading)
          || !e.gorilla.climbPoseClear(2, nx, y, nz, heading, plannedTurnMotion, ctx.solidAt, plannedTurnClear, e, 0, true)) continue;
        best = score; WALL_POINT.x = nx; WALL_POINT.y = y; WALL_POINT.z = nz; WALL_POINT.heading = heading;
      }
      return Number.isFinite(best);
    };
    const wallFailure = (e, reason) => {
      e.debugMove.status = "blocked"; e.debugMove.reason = reason; e.debugMove.wallPending = false;
      e.climb.debugStuck = e.climb.holdPose = true; e.speed = 0; e.motion.climbSide = e.motion.climbDirection = 0;
      clearWallSearch(e);
    };
    const beginWallSearch = (e) => {
      const s = wallSearch, d = e.debugMove, p = e.root.position;
      if (s.owner && s.owner !== e) return false;
      s.owner = e; s.current = -1; s.neighbor = s.visits = 0;
      s.x = p.x; s.y = p.y; s.z = p.z; s.heading = e.heading;
      const nx = Number.isFinite(d.normalHeading) ? d.normalX : -Math.sin(e.heading);
      const nz = Number.isFinite(d.normalHeading) ? d.normalZ : -Math.cos(e.heading);
      s.goalX = d.target.x + nx * CLIMB_STANDOFF; s.goalY = d.target.y; s.goalZ = d.target.z + nz * CLIMB_STANDOFF;
      const side = (s.goalX - p.x) * Math.cos(e.heading) - (s.goalZ - p.z) * Math.sin(e.heading);
      const rise = s.goalY - p.y, extent = Math.max(Math.abs(side), Math.abs(rise)), fraction = Math.min(1, 6.6 / Math.max(0.01, extent));
      s.goalU = side * fraction / WALL_STEP; s.goalV = rise * fraction / WALL_STEP; s.final = fraction === 1;
      s.states.fill(0); s.attempts.fill(0); s.parents.fill(-1); s.costs.fill(Infinity); s.scores.fill(Infinity);
      const start = WALL_HALF * WALL_GRID + WALL_HALF, at = start * 3;
      s.states[start] = 1; s.points[at] = p.x; s.points[at + 1] = p.y; s.points[at + 2] = p.z;
      s.headings[start] = e.heading; s.costs[start] = 0; s.scores[start] = Math.hypot(s.goalU, s.goalV) * WALL_STEP;
      d.status = "planning"; e.climb.holdPose = true; e.speed = 0;
      return true;
    };
    const spliceWallRoute = (e, end) => {
      const s = wallSearch, c = e.climb, d = e.debugMove;
      let count = 0;
      for (let i = end; i >= 0; i = s.parents[i]) {
        if (count >= s.route.length) return false;
        s.route[count++] = i;
      }
      if (count < 2) {
        c.debugStop = c.progress; d.wallFinal = true; d.wallPending = false; d.status = "arrived"; return true;
      }
      const progress = c.progress, oldLength = c.length, oldTraverse = c.debugTraverse;
      let insert = 0;
      while (insert < c.count && c.lengths[insert] <= progress + 1e-7) insert++;
      const added = count * 2 - 1;
      if (c.count + added > c.lengths.length || insert >= c.count) return false;
      c.points.copyWithin((insert + added) * 3, insert * 3, c.count * 3);
      c.headings.copyWithin(insert + added, insert, c.count);
      for (let i = 0; i < added; i++) {
        const node = s.route[i < count ? count - 1 - i : i - count + 1], from = node * 3, to = (insert + i) * 3;
        c.points[to] = s.points[from]; c.points[to + 1] = s.points[from + 1]; c.points[to + 2] = s.points[from + 2];
        c.headings[insert + i] = s.headings[node];
      }
      c.count += added;
      for (let i = insert; i < c.count; i++) {
        const at = i * 3;
        c.lengths[i] = c.lengths[i - 1] + Math.hypot(c.points[at] - c.points[at - 3],
          c.points[at + 1] - c.points[at - 2], c.points[at + 2] - c.points[at - 1]);
      }
      c.length = c.lengths[c.count - 1];
      const extra = c.length - oldLength;
      c.mantleStart += extra; c.mantleRiseEnd += extra;
      c.traverseStart = oldTraverse ? Math.min(c.traverseStart, progress) : progress;
      c.traverseEnd = oldTraverse ? Math.max(c.traverseEnd >= progress ? c.traverseEnd + extra : c.traverseEnd, progress + extra) : progress + extra;
      c.debugTraverse = true; c.debugStop = c.lengths[insert + count - 1];
      c.progress = progress + (c.descending ? extra : 0); c.index = 0; c.autoTo = -1;
      c.holdPose = true; c.debugStuck = false; c.blocked = 0;
      d.wallPending = false; d.wallFinal = s.final; d.status = "climbing"; d.reason = "";
      return true;
    };
    const searchWallRoute = (e) => {
      const s = wallSearch, c = e.climb, d = e.debugMove;
      c.holdPose = true; e.speed = 0; e.motion.climbSide = e.motion.climbDirection = 0;
      if (s.owner !== e && !beginWallSearch(e)) { d.status = "planning"; return; }
      while (wallBudget > 0) {
        if (s.current < 0) {
          let best = Infinity, current = -1;
          for (let i = 0; i < WALL_COUNT; i++) if (s.states[i] === 1 && s.scores[i] < best) { best = s.scores[i]; current = i; }
          if (current < 0 || s.visits++ >= 384) { wallFailure(e, "No connected grip route to this wall point"); return; }
          s.current = current; s.neighbor = 0; s.states[current] = 2;
          const at = current * 3, u = current % WALL_GRID - WALL_HALF, v = Math.floor(current / WALL_GRID) - WALL_HALF;
          const arrived = s.final ? Math.abs(s.points[at + 1] - s.goalY) <= 0.32
            && Math.hypot(s.points[at] - s.goalX, s.points[at + 2] - s.goalZ) <= 0.8
            : Math.hypot(u - s.goalU, v - s.goalV) <= 0.65;
          if (arrived) {
            if (!spliceWallRoute(e, current)) wallFailure(e, "Wall route exceeds the retained grip capacity");
            s.owner = null; return;
          }
        }
        const from = s.current, at = from * 3, px = s.points[at], py = s.points[at + 1], pz = s.points[at + 2];
        const heading = s.headings[from], column = from % WALL_GRID, row = Math.floor(from / WALL_GRID);
        if (s.neighbor >= 8) { s.current = -1; continue; }
        const neighbor = s.neighbor++, du = WALL_DU[neighbor], dv = WALL_DV[neighbor], nc = column + du, nr = row + dv;
        if (nc < 0 || nr < 0 || nc >= WALL_GRID || nr >= WALL_GRID) continue;
        const to = nr * WALL_GRID + nc, target = to * 3;
        if (s.states[to] >= 2 || s.attempts[to] >= 8) continue;
        wallBudget--;
        if (!s.states[to]) {
          const x = px + Math.cos(heading) * du * WALL_STEP, y = py + dv * WALL_STEP, z = pz - Math.sin(heading) * du * WALL_STEP;
          if (!projectWallPoint(e, x, y, z, px, py, pz, heading, du, dv)) { s.attempts[to]++; continue; }
          s.points[target] = WALL_POINT.x; s.points[target + 1] = WALL_POINT.y; s.points[target + 2] = WALL_POINT.z;
          s.headings[to] = WALL_POINT.heading;
        } else if (!wallEdgeClear(e, px, py, pz, heading, s.points[target], s.points[target + 1], s.points[target + 2])) continue;
        const cost = s.costs[from] + Math.hypot(s.points[target] - px, s.points[target + 1] - py, s.points[target + 2] - pz);
        if (cost >= s.costs[to]) continue;
        s.states[to] = 1; s.parents[to] = from; s.costs[to] = cost;
        const estimate = s.final ? Math.hypot(s.points[target] - s.goalX, s.points[target + 1] - s.goalY, s.points[target + 2] - s.goalZ)
          : Math.hypot(nc - WALL_HALF - s.goalU, nr - WALL_HALF - s.goalV) * WALL_STEP;
        s.scores[to] = cost + estimate;
      }
    };
    const climbPointDistance2 = (x, z, ax, az, bx, bz) => {
      const dx = bx - ax, dz = bz - az, length = dx * dx + dz * dz;
      const t = length ? clamp(((x - ax) * dx + (z - az) * dz) / length, 0, 1) : 0;
      return (x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2;
    };
    const climbRoutesOverlap = (a, b) => {
      // A freely traversing player owns its live body contact, not the old
      // vertical rail it left. Ordinary peer sweeps still protect that body.
      if (a.free || b.free) return false;
      for (let i = 1; i < a.count; i++) for (let j = 1; j < b.count; j++) {
        const ai = i * 3, bi = j * 3, ap = a.points, bp = b.points;
        if (Math.min(ap[ai - 2], ap[ai + 1]) > Math.max(bp[bi - 2], bp[bi + 1]) + CLIMB_HEIGHT
          || Math.min(bp[bi - 2], bp[bi + 1]) > Math.max(ap[ai - 2], ap[ai + 1]) + CLIMB_HEIGHT) continue;
        const ax = ap[ai - 3], az = ap[ai - 1], bx = ap[ai], bz = ap[ai + 2];
        const cx = bp[bi - 3], cz = bp[bi - 1], dx = bp[bi], dz = bp[bi + 2];
        // The wall lane uses the trunks; either grounded end also needs room
        // for the two torso centres of the four-footed arrival/departure.
        const gap = i === 1 || i + 1 === a.count || j === 1 || j + 1 === b.count ? 2.5 : 1.3;
        if (Math.min(ax, bx) > Math.max(cx, dx) + gap || Math.max(ax, bx) < Math.min(cx, dx) - gap
          || Math.min(az, bz) > Math.max(cz, dz) + gap || Math.max(az, bz) < Math.min(cz, dz) - gap) continue;
        const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, cross = ux * vz - uz * vx;
        if (Math.abs(cross) > 1e-8) {
          const t = ((cx - ax) * vz - (cz - az) * vx) / cross;
          const u = ((cx - ax) * uz - (cz - az) * ux) / cross;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
        }
        if (Math.min(climbPointDistance2(ax, az, cx, cz, dx, dz), climbPointDistance2(bx, bz, cx, cz, dx, dz),
          climbPointDistance2(cx, cz, ax, az, bx, bz), climbPointDistance2(dx, dz, ax, az, bx, bz)) < gap * gap) return true;
      }
      return false;
    };
    const admitClimb = (e) => {
      const c = e.climb;
      if (c.crestPending && !e.debugMove.active) c.crestPending = false;
      if (c.crestPending) {
        if (!climbFrameBudget) { c.searchPending = c.searchDeferred = true; c.retry = 0.03; return false; }
        // Mesh admission is the last expensive part of this outer update.
        // A second failed route must not share a frame with the full crest.
        climbFrameBudget = 0; c.crestPending = false;
        if (!climbCrestClear(e)) { c.claimPending = false; return false; }
      }
      for (const other of list) {
        const o = other.climb;
        if (other === e || !other.active || !o.active && (!o.claimPending || !o.searchPending || o.claimOrder >= c.claimOrder)) continue;
        if (!(c.claimFor === other.index && c.claimOwnerOrder === o.claimOrder) && !climbRoutesOverlap(c, o)) continue;
        if (c.claimFor !== other.index || Math.abs(c.claimProgress - o.progress) >= 0.05) {
          c.claimFor = other.index; c.claimProgress = o.progress; c.claimProgressAt = elapsed;
        }
        c.claimOwnerOrder = o.claimOrder;
        c.claimPending = c.searchPending = c.searchDeferred = true; c.retry = 0.03;
        // Do not wait on the owner's landing. Ordinary supported backout
        // clears it before another approach; an airborne actor never yields.
        const p = e.root.position;
        c.claimRetreat = false;
        if (!e.controlled && o.active) for (let i = 1; i < o.count; i++) {
          const at = i * 3;
          if (p.y > Math.max(o.points[at - 2], o.points[at + 1]) + CLIMB_HEIGHT
            || p.y + e.height < Math.min(o.points[at - 2], o.points[at + 1])) continue;
          if (climbPointDistance2(p.x, p.z, o.points[at - 3], o.points[at - 1], o.points[at], o.points[at + 2]) < 1.4 ** 2) {
            c.claimRetreat = true; break;
          }
        }
        return false;
      }
      if (!climbGroundPeersClear(e)) { c.failure = "landing occupied"; c.claimPending = false; return false; }
      c.claimPending = false; c.claimFor = -1; c.claimRetreat = false;
      c.mount = 0; c.finish = c.blocked = c.bottomTurn = c.lowerClearance = 0; c.active = true; c.climbs++; c.failure = "";
      c.openingExit = false;
      c.returning = c.holdPose = c.debugStuck = c.lowerClearanceAscent = false; c.reversals = 0;
      c.free = c.lipBypass = false; c.handoffDirection = 0;
      c.debugStop = -1;
      if (e.debugMove.active) {
        const d = e.debugMove;
        d.status = "climbing"; c.debugRole = 0;
        d.wallPending = d.wallTarget; d.wallFinal = false;
      }
      c.waitRelease = c.descending && e.controlled && e.drive.climbAxis > 0;
      c.autoTo = c.descending ? Math.max(0, c.mantleStart - 0.8)
        : e.controlled ? Math.min(c.length, c.lowerGroundDistance + 0.45) : -1;
      c.autoDirection = c.descending ? -1 : 1;
      e.drive.airborne = e.drive.passiveFall = false; e.drive.grounded = false; e.drive.vx = e.drive.vy = e.drive.vz = e.drive.jumps = 0;
      e.drive.jumpPressed = false; e.drive.jumpBuffer = 0; e.drive.jumpDown = e.drive.jumpHeld; e.motion.groom = 0;
      e.motion.climb = 1; e.motion.climbBlend = 0; e.motion.mantle = 1;
      e.drive.climbExitHeading = e.drive.climbExitLook = NaN; e.drive.climbTurnTimer = 0;
      e.lounge = ""; if (e.controlled) e.loungePartner = null;
      e.speed = 0; e.biped = false;
      releasePortal(e);
      return true;
    };
    const buildClimb = (e, lx, ly, lz, ux, uy, uz, heading, descending, lowerExit = true, latePull = false) => {
      const c = e.climb, sx = Math.sin(heading), sz = Math.cos(heading), p = e.root.position;
      c.claimPending = c.crestPending = false;
      c.claimFor = -1; c.claimOwnerOrder = 0;
      const topHeading = descending ? e.heading : heading;
      c.probeHeading = heading;
      c.debugTraverse = false; c.traverseStart = c.traverseEnd = 0;
      c.attempts++; c.failure = "start";
      // The current walking pose already passed movement collision. The
      // climbing centre remains outside stone before the first grip.
      if (descending ? !e.gorilla.climbPoseClear(0, p.x, p.y, p.z, e.heading, e.motion, ctx.solidAt) : !climbClear(e, p.x, p.y, p.z)) return false;
      c.failure = "approach turn";
      if (!descending && !climbStartTurnClear(e, heading)) return false;
      c.failure = "top";
      if (!descending && !climbWalkClear(e, ux, uy, uz, ux, uy, uz, topHeading, false)) return false;
      c.failure = "path"; c.count = 0; c.length = 0; c.index = 0; c.basePrepEnd = 0;
      if (!appendClimbPoint(e, lx, ly, lz)) return false;
      const reach = Math.hypot(ux - lx, uz - lz) + 3;
      const wallHalfWidth = Math.min(0.35 * e.root.scale.x, ctx.rectangleAt(e, WALL_RECTANGLE, true).halfSide * 0.5);
      // Reach over the lip while the feet are still on the wall. The final
      // rise blends the torso forward; only its supported continuation lowers
      // the hands all the way to the four-footed walking pose.
      const riseY = uy - Math.min(0.9, (uy - ly) * 0.45);
      const count = Math.ceil((riseY - ly) / 0.3);
      if (count < 2 || count * 2 + 11 > CLIMB_POINTS) return false;
      let lastX = lx, lastZ = lz, sampled = -1;
      for (let i = 0; i <= count; i++) {
        // Preserve early mount rejection: only sample the short neighborhood
        // needed by this row, never the whole wall before checking its base.
        const lookahead = Math.min(count, i > 1 && i < count - 1 ? i + 2 : i);
        for (let row = sampled + 1; row <= lookahead; row++) {
          const y = ly + (riseY - ly) * row / count;
          let wall = Infinity;
          // Follow the torso contact band of the upright wall rectangle.
          // The hands prove their own grip; relief beside the arms must not
          // push the whole climb route away from an otherwise clear wall.
          for (let h = 0; h < 2; h++) for (let side = -1; side <= 1; side++) {
            const across = side * wallHalfWidth, height = y + (h ? 1.2 : 0.65) * e.root.scale.x;
            for (let d = 0.08; d <= reach; d += 0.12) if (climbSolidAt(lx + sx * d + sz * across, height,
              lz + sz * d - sx * across)) {
              let low = Math.max(0, d - 0.12), high = d;
              for (let refine = 0; refine < 3; refine++) {
                const middle = (low + high) * 0.5;
                if (climbSolidAt(lx + sx * middle + sz * across, height,
                  lz + sz * middle - sx * across)) high = middle;
                else low = middle;
              }
              wall = Math.min(wall, low); break;
            }
          }
          if (!Number.isFinite(wall) && y < uy - 0.1) return false;
          climbWallDepths[row] = wall; sampled = row;
        }
        const y = ly + (riseY - ly) * i / count, wall = climbWallDepths[i];
        // A short outward envelope makes small stone relief behave like one
        // wall. Keep mount/crest endpoints and large ledges on their measured
        // contour. This is guidance only: real geometry remains the collider.
        let guide = wall;
        if (i > 1 && i < count - 1) for (let direction = -1; direction <= 1; direction += 2) {
          for (let n = 1; n <= 2; n++) {
            const at = i + direction * n;
            if (at < 1 || at >= count || !Number.isFinite(climbWallDepths[at])
              || Math.abs(climbWallDepths[at] - wall) > 0.36) break;
            guide = Math.min(guide, climbWallDepths[at] + n * (riseY - ly) / count * 0.18);
          }
        }
        guide = Math.max(wall - 0.24, guide);
        if (guide < wall - 0.025) {
          const gx = lx + sx * (guide - CLIMB_STANDOFF), gz = lz + sz * (guide - CLIMB_STANDOFF);
          if (wallGrip(gx, y, gz, heading) && climbGuidePoseClear(e, gx, y, gz, heading)
            && appendClimbPoint(e, gx, y, gz)) { lastX = gx; lastZ = gz; continue; }
        }
        let x = lastX, z = lastZ;
        if (Number.isFinite(wall)) { x = lx + sx * (wall - CLIMB_STANDOFF); z = lz + sz * (wall - CLIMB_STANDOFF); }
        // Rise beside a ledge first, then pull inward at that height. This
        // avoids a diagonal chord clipping the corner between two voxels.
        if (!appendClimbPoint(e, lastX, y, lastZ)) {
          // A projecting voxel above a grip needs an outward transfer before
          // the rise. Reserve that complete elbow instead of clipping it.
          const savedCount = c.count, savedLength = c.length, previousY = c.points[(c.count - 1) * 3 + 1];
          let placed = false;
          for (let retreat = 0.12; retreat <= 1.2; retreat += 0.12) {
            c.count = savedCount; c.length = savedLength;
            const rx = lastX - sx * retreat, rz = lastZ - sz * retreat;
            if (appendClimbPoint(e, rx, previousY, rz) && appendClimbPoint(e, rx, y, rz)) { placed = true; break; }
          }
          if (!placed) return false;
        }
        let placed = false;
        // Plant the last footfall outside the close wall grip. That small
        // outward transfer happens during the descent, leaving room to turn
        // onto all fours without sweeping the shoulders through the rock.
        for (let retreat = i ? 0 : 0.4; retreat <= (i ? 0.72 : 1.6); retreat += 0.12) {
          const nx = x - sx * retreat, nz = z - sz * retreat;
          if (!i && lowerExit && !bottomTurnClear(e, nx, y, nz, heading)) continue;
          if (appendClimbPoint(e, nx, y, nz)) { x = nx; z = nz; placed = true; break; }
        }
        if (!placed) return false;
        if (!i) c.lowerGroundDistance = c.length;
        lastX = x; lastZ = z;
      }
      c.failure = "mantle"; c.mantleStart = c.length;
      const topDX = ux - lastX, topDZ = uz - lastZ, topRun = Math.hypot(topDX, topDZ);
      const inward = Math.min(1.05, topRun * 0.65);
      const pullX = topRun ? topDX / topRun * inward : 0, pullZ = topRun ? topDZ / topRun * inward : 0;
      // Roll over the lip on one continuous quarter curve: begin vertically,
      // pull the hips inward while rising, and finish moving horizontally on
      // all fours. More samples keep the root direction continuous enough that
      // the planted hands do not appear to kink around the voxel edge.
      for (let i = 1; i <= 8; i++) {
        const t = i / 8, rise = (uy - riseY) * (2 * t - t * t);
        // A projecting lip can catch the toes during the early inward pull.
        // The alternate curve keeps that same rise and landing, bringing the
        // feet inward later; admission still proves every complete pose.
        const pull = latePull ? t * t * t * t : t * t;
        if (!appendClimbPoint(e, lastX + pullX * pull, riseY + rise, lastZ + pullZ * pull)) return false;
      }
      lastX += pullX; lastZ += pullZ;
      c.mantleRiseEnd = c.length;
      if (!descending && !climbWalkClear(e, lastX, uy, lastZ, ux, uy, uz, topHeading, false)) return false;
      if (!appendClimbPoint(e, ux, uy, uz)) return false;
      c.minimum = lowerExit ? 0 : c.lengths[1];
      c.lowerY = ly; c.upperY = uy; c.heading = heading; c.lowerExit = lowerExit;
      c.topHeading = topHeading; c.fromTop = descending; c.exitHeading = heading;
      c.progress = descending ? c.length : 0; c.descending = descending;
      c.failure = "crest pose";
      c.claimPending = c.crestPending = true; c.claimOrder = ++climbClaimSerial;
      return admitClimb(e);
    };
    const rememberDebugPoint = (d, failed, x, y, z) => {
      const points = failed ? d.failed : d.visited, index = failed ? d.failedNext : d.visitedNext;
      points[index * 3] = x; points[index * 3 + 1] = y; points[index * 3 + 2] = z;
      if (failed) { d.failedNext = (index + 1) % 32; d.failedCount = Math.min(32, d.failedCount + 1); }
      else { d.visitedNext = (index + 1) % 32; d.visitedCount = Math.min(32, d.visitedCount + 1); }
    };
    const debugPointSeen = (points, count, x, y, z, radius) => {
      for (let i = 0; i < count; i++) if (Math.abs(points[i * 3 + 1] - y) < 0.7
        && (points[i * 3] - x) ** 2 + (points[i * 3 + 2] - z) ** 2 < radius * radius) return true;
      return false;
    };
    const resetDebugRoute = (e, failed = false) => {
      const d = e.debugMove, p = e.root.position, c = e.climb;
      if (failed) rememberDebugPoint(d, true, p.x, p.y, p.z);
      else d.candidate = 0;
      if (failed && d.normalized && !d.wallTarget && !c.active) {
        const g = d.goal, heading = Math.atan2(g.x - p.x, g.z - p.z);
        // A character may occupy the landing during a long trip, or the
        // final approach may face differently after following a curved ramp.
        // Resolve nearby footing again only when that endpoint is occupied.
        if (!roamPeerClear(e, g.x, g.y, g.z, heading)) {
          d.normalized = false; d.normalizeAt = 0; d.normalizeScore = Infinity;
        }
      }
      d.originX = p.x; d.originY = p.y; d.originZ = p.z;
      d.status = "planning"; e.roam.count = e.roam.index = 0; e.roam.wall = e.roam.propDeparture = false;
      d.progressDistance = Infinity; d.progressTime = 0;
      e.roam.progressTime = 0; e.roam.progressX = e.roam.progressZ = NaN;
      c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
      c.searchCursor = 0; c.claimOrder = 0; c.claimFor = -1; c.retry = 0;
      setGoal(e, d.goal.x, d.goal.y, d.goal.z); e.speed = 0;
    };
    const cancelDebugMove = (value) => {
      const e = entryFor(value);
      if (!e || !e.debugMove.active) return false;
      clearWallSearch(e);
      e.debugMove.active = e.debugMove.wallPending = false; e.debugMove.status = "";
      e.debugMove.cancelled = !e.controlled;
      // Cancelling the destination must not turn a retained wall grip into an
      // ordinary stalled walk. Finish this reserved climb to safe footing, or
      // preserve its blocked debug hold until the next command takes over.
      e.climb.debugRole = e.climb.active && !e.controlled ? 0 : -1;
      if (e.climb.debugRole < 0) e.climb.debugStuck = false;
      e.climb.debugStop = -1;
      e.roam.count = e.roam.index = 0; e.roam.propDeparture = false;
      if (!e.controlled && !e.climb.active && !e.drive.airborne) resumeEntry(e);
      return true;
    };
    const debugMove = (value, x, y, z, normal = null) => {
      const e = entryFor(value);
      if (!ctx.debugMovement || !e || !e.active || e.controlled
        || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
      const d = e.debugMove, p = e.root.position;
      clearWallSearch(e);
      d.active = true; d.cancelled = false; d.status = "planning"; d.reason = "";
      d.target.x = d.goal.x = x; d.target.y = d.goal.y = y; d.target.z = d.goal.z = z;
      d.goal.heading = NaN;
      const length = normal ? Math.hypot(normal.x, normal.z) : 0;
      d.normalX = length > 0.01 ? normal.x / length : 0; d.normalZ = length > 0.01 ? normal.z / length : 0;
      d.normalY = normal ? normal.y : 1;
      d.normalHeading = length > 0.35 && Math.abs(d.normalY) < 0.65 ? Math.atan2(-d.normalX, -d.normalZ) : NaN;
      // A destination without a picked normal still names a surface point.
      // Leading knuckles can rest several treads above that point on stairs;
      // their footprint height must not turn the tread into a wall command.
      d.wallTarget = normal ? Number.isFinite(d.normalHeading) : Math.abs(pointSupportAt(x, z, y, e) - y) > 0.75;
      d.wallPending = d.wallTarget; d.wallFinal = false;
      d.normalized = false; d.normalizeAt = 0; d.normalizeScore = Infinity;
      d.hops = d.candidate = d.visitedCount = d.visitedNext = d.failedCount = d.failedNext = 0;
      rememberDebugPoint(d, false, p.x, p.y, p.z);
      if (labEscape === e) labEscape = null;
      e.stuck.escapeLeft = 0;
      releasePortal(e); releaseLab(e); e.hasSlot = false; e.pendingSite = -1;
      e.roam.departPending = false; e.roam.pose = ""; e.loungeHeading = NaN;
      if (e.lounge) leaveLounge(e);
      e.parked = false; e.pound = e.beat = e.stand = e.rest = 0;
      e.fromSite = caveAt(p.x, p.y, p.z); e.route = e.fromSite >= 0 && caveAt(x, y, z) !== e.fromSite ? "exit" : "";
      e.phase = e.route ? "leave" : "chill";
      e.climb.debugRole = 0; e.climb.debugStuck = false; e.climb.debugStop = -1;
      if (e.climb.active) {
        e.climb.descending = e.climb.progress >= e.climb.mantleStart || y < p.y; e.climb.autoTo = -1;
        d.status = "climbing"; return true;
      }
      resetDebugRoute(e);
      return true;
    };
    // Resolve a clicked face to supported room for the complete walking body.
    // Search only on a command, in small batches; the cursor still marks the
    // exact clicked point while the retained goal records its nearby footing.
    const normalizeDebugGoal = (e) => {
      const d = e.debugMove, t = d.target, g = d.goal;
      const p = e.root.position;
      const compact = e.compact, mode = e.footprintMode, radius = e.radius, height = e.height;
      e.compact = e.planningRoam = true; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
      const limit = 65;
      for (let n = 0; n < 4 && d.normalizeAt < limit; n++, d.normalizeAt++) {
        const i = d.normalizeAt, offset = i ? Math.ceil(i / 16) * 1.1 : 0, angle = i * TAU / 16;
        const x = t.x + Math.sin(angle) * offset, z = t.z + Math.cos(angle) * offset;
        const heading = Math.hypot(x - p.x, z - p.z) > 0.01 ? Math.atan2(x - p.x, z - p.z) : e.heading;
        const distance = Math.hypot(x - t.x, z - t.z);
        // Clicks name the stone/deck face, while the complete walking body may
        // rest on the next tread. Resolve its arrival-facing footprint before
        // searching sideways; retaining the old yaw rejects narrow bridges.
        const near = support(e, x, z, t.y, STEP, heading);
        const top = climbSurfaceAt ? support(e, x, z, climbSurfaceAt(x, z), STEP, heading) : near;
        for (let layer = 0; layer < 2; layer++) {
          const y = layer ? near : top, score = distance * distance + (y - t.y) ** 2 * 0.36;
          if (score >= d.normalizeScore || (!d.wallTarget || t.y > e.root.position.y + 0.8) && y < t.y - 0.55 || !actorLanding(e, x, y, z)
            || !staticClear(e, x, y, z, x, y, z, heading, heading)
            || !roamPeerClear(e, x, y, z, heading)
            // A broad support footprint can touch an adjacent ledge while
            // every actual pad hangs in space. Admit the settled arrival rig
            // against its real front/rear contacts and complete body shape.
            || ctx.restFootingClear && !ctx.restFootingClear(e, x, y, z, heading)) continue;
          d.normalizeScore = score; g.x = x; g.y = y; g.z = z; g.heading = heading;
        }
        if (d.normalizeScore < 0.04) { d.normalizeAt = limit; break; }
      }
      e.compact = compact; e.footprintMode = mode; e.radius = radius; e.height = height; e.planningRoam = false;
      if (d.normalizeAt < limit) return false;
      if (!Number.isFinite(d.normalizeScore)) { d.status = "blocked"; d.reason = "No supported footing near this point"; return false; }
      d.normalized = true; resetDebugRoute(e); return true;
    };
    const planDebugRoute = (e) => {
      const d = e.debugMove, p = e.root.position, g = d.goal;
      if (!debugRouteBudget) return;
      const toward = Math.atan2(g.x - p.x, g.z - p.z);
      // Try the destination first, then neighboring ledges on its level.
      // When those approaches fail, walking waypoints fan around the current
      // obstacle. Every accepted leg is swept from the actual current pose.
      for (let skip = 0; skip < 8 && d.candidate < 97; skip++) {
        const i = d.candidate++, local = i > 48, turn = i ? (i - 1) % 16 : 0;
        const side = turn ? Math.ceil(turn / 2) * (turn % 2 ? 1 : -1) : 0;
        const distance = i ? local ? (1 + Math.floor((i - 49) / 16)) * 3.2 : (1 + Math.floor((i - 1) / 16)) * 2 : 0;
        const angle = toward + (local ? 0 : Math.PI) + side * Math.PI / 8;
        const x = (local ? d.originX : g.x) + Math.sin(angle) * distance;
        const z = (local ? d.originZ : g.z) + Math.cos(angle) * distance;
        const y = i ? support(e, x, z, local ? d.originY : g.y, STEP) : g.y;
        // A level waypoint still belongs to the ultimate roof request.
        // Ending below its enclosing ceiling cannot prepare an outside climb.
        if (!actorLanding(e, x, y, z) || !local && Math.abs(y - g.y) > 0.55
          || local && g.y > y + 1 && caveAt(x, y, z) >= 0
          || i > 0 && debugPointSeen(d.visited, d.visitedCount, x, y, z, 1.3)) continue;
        const budget = roamBudget; roamBudget = 1; debugRouteBudget--;
        const found = planRoam(e, x, y, z, NaN, "", local);
        roamBudget = budget;
        if (found) {
          const at = (e.roam.count - 1) * 3;
          if (!e.roam.wall || !debugPointSeen(d.failed, d.failedCount,
            e.roam.path[at], e.roam.path[at + 1], e.roam.path[at + 2], 1.3)) {
            setGoal(e, x, y, z); d.status = "walking"; d.reason = ""; return;
          }
          e.roam.count = e.roam.index = 0;
        }
        return;
      }
      if (d.candidate >= 97) { d.status = "blocked"; d.reason = "No clear walking or climbing approach"; e.speed = 0; }
    };
    const wallRectangleShare = (e, x, y, z, heading, top = false) => {
      if (!climbSolidAt || !climbSurfaceAt) return 0;
      const rect = ctx.rectangleAt(e, WALL_RECTANGLE, top);
      const halfForward = rect.halfForward, halfSide = rect.halfSide, centerForward = rect.centerForward;
      const forwardX = Math.sin(heading), forwardZ = Math.cos(heading);
      const sideX = forwardZ, sideZ = -forwardX;
      let occupied = 0;
      for (let row = 0; row < WALL_RECT_SAMPLES; row++) {
        const along = centerForward + halfForward * (2 * (row + 0.5) / WALL_RECT_SAMPLES - 1);
        for (let column = 0; column < WALL_RECT_SAMPLES; column++) {
          const across = halfSide * (2 * (column + 0.5) / WALL_RECT_SAMPLES - 1);
          const px = x + forwardX * along + sideX * across;
          const pz = z + forwardZ * along + sideZ * across;
          if (top) {
            const surface = climbSurfaceAt(px, pz);
            if (Math.abs(surface - y) <= 0.65 && climbSolidAt(px, surface - 0.12, pz)) occupied++;
          } else if (climbSolidAt(px, y + 0.85, pz) && climbSolidAt(px, y + 1.8, pz)
            && climbSurfaceAt(px, pz) > y + 1.8) occupied++;
        }
      }
      return occupied / (WALL_RECT_SAMPLES * WALL_RECT_SAMPLES);
    };
    const wallVerticalShare = (e, x, y, z, heading, top) => {
      const rect = ctx.rectangleAt(e, WALL_RECTANGLE, true);
      const forwardX = Math.sin(heading), forwardZ = Math.cos(heading);
      const sideX = forwardZ, sideZ = -forwardX;
      const probe = top ? CLIMB_STANDOFF + 0.18 : -0.45;
      const centerY = y + 0.4 * e.root.scale.x;
      const halfHeight = 1.4 * e.root.scale.x;
      const cellHalf = halfHeight / WALL_RECT_SAMPLES;
      let overlapping = 0;
      for (let column = 0; column < WALL_RECT_SAMPLES; column++) {
        const across = rect.halfSide * (2 * (column + 0.5) / WALL_RECT_SAMPLES - 1);
        const px = x + forwardX * probe + sideX * across;
        const pz = z + forwardZ * probe + sideZ * across;
        // The roof may be several metres above a cave's ground. A descending
        // gorilla can only hand off to a floor reachable from its present feet.
        const surface = top ? climbSurfaceAt(px, pz) : groundAt(px, pz, y + STEP);
        if (!Number.isFinite(surface)) continue;
        for (let row = 0; row < WALL_RECT_SAMPLES; row++) {
          const height = centerY + halfHeight * (2 * (row + 0.5) / WALL_RECT_SAMPLES - 1);
          if (top ? height >= surface : Math.abs(height - surface) <= cellHalf) overlapping++;
        }
      }
      return overlapping / (WALL_RECT_SAMPLES * WALL_RECT_SAMPLES);
    };
    const wallContactShare = (e, x, y, z, heading) => {
      const rect = ctx.rectangleAt(e, WALL_RECTANGLE, true), scale = e.root.scale.x;
      const sx = Math.sin(heading), sz = Math.cos(heading);
      let contact = 0;
      for (let row = 0; row < WALL_RECT_SAMPLES; row++) {
        const height = y + (0.25 + row * 0.7) * scale;
        for (let column = 0; column < WALL_RECT_SAMPLES; column++) {
          const across = rect.halfSide * (2 * (column + 0.5) / WALL_RECT_SAMPLES - 1);
          for (let depth = 0.35; depth <= 1.55; depth += 0.2) {
            if (!climbSolidAt(x + sx * depth + sz * across, height,
              z + sz * depth - sx * across)) continue;
            if (++contact >= WALL_RECT_SAMPLES) return WALL_ENTER_SHARE;
            break;
          }
        }
      }
      return contact / (WALL_RECT_SAMPLES * WALL_RECT_SAMPLES);
    };
    const wallLipHold = (x, y, z, heading) => {
      const sx = Math.sin(heading), sz = Math.cos(heading);
      // Between the lower face and an overhanging rim, the feet can briefly
      // lose the old face while the hands still have the projecting stone.
      for (let level = 0; level < 4; level++) for (let depth = 0.4; depth <= 2.4; depth += 0.2) {
        if (climbSolidAt(x + sx * depth, y + 1.2 + level * 0.4,
          z + sz * depth)) return true;
      }
      return false;
    };
    const wallFaceDepth = (x, y, z, heading) => {
      const sx = Math.sin(heading), sz = Math.cos(heading);
      // A terraced hill can recede between two climbing steps. Find the next
      // face at torso/hand height rather than treating the missing old face
      // as an opening or backing away from it.
      for (let depth = 0.8; depth <= 2.4; depth += 0.2) for (let level = 0; level < 4; level++) {
        if (climbSolidAt(x + sx * depth, y + 0.8 + level * 0.36,
          z + sz * depth)) return depth;
      }
      return Infinity;
    };
    const cliffRiserAhead = (x, z, heading, direction, distance = 3.2) => {
      const floor = climbSurfaceAt(x, z);
      const ramp = walkingRampAt(x, floor, z, heading);
      const sx = Math.sin(heading), sz = Math.cos(heading);
      let previous = climbSurfaceAt(x - sx * 0.4, z - sz * 0.4);
      for (let d = -0.2; d <= distance; d += 0.2) {
        const height = climbSurfaceAt(x + sx * d, z + sz * d);
        // Walkable treads and hills can gain a body height over several
        // steps. A nearly vertical terraced face can have no single tall
        // riser, so also measure its rise over a short continuous span.
        if (!Number.isNaN(height) && Number.isFinite(previous)
          && (height - previous) * direction > (ramp ? BL.wallPanels.RAMP_STEP : 0.85)) return true;
        if (d >= 0.8 && Number.isFinite(height)) {
          const behind = climbSurfaceAt(x + sx * (d - 0.8), z + sz * (d - 0.8));
          if (Number.isFinite(behind)
            && (height - behind) * direction > BL.wallPanels.RAMP_SLOPE * 0.8 + 0.15) return true;
        }
        previous = height;
      }
      return false;
    };
    const roofEdgeCrossing = (e, x, z, heading) => {
      if (!climbSurfaceAt) return false;
      const p = e.root.position, side = e.root.scale.x * 0.7;
      const acrossX = Math.cos(heading), acrossZ = -Math.sin(heading);
      for (let i = 0; i < 3; i++) {
        const offset = i === 0 ? 0 : i === 1 ? -side : side;
        const fromX = p.x + acrossX * offset, fromZ = p.z + acrossZ * offset;
        if (Math.abs(climbSurfaceAt(fromX, fromZ) - p.y) > 0.2
          || climbSurfaceAt(x + acrossX * offset, z + acrossZ * offset) >= p.y - STEP) continue;
        if (cliffRiserAhead(fromX, fromZ, heading, -1, 1.6)) return true;
      }
      return false;
    };
    const handoffProgress = (c, p) => {
      const length = Math.hypot(c.freeTargetX - c.handoffStartX,
        c.freeTargetY - c.handoffStartY, c.freeTargetZ - c.handoffStartZ);
      if (length < 0.001) return 1;
      const left = Math.hypot(c.freeTargetX - p.x, c.freeTargetY - p.y, c.freeTargetZ - p.z);
      const t = clamp(1 - left / length, 0, 1);
      return t * t * (3 - 2 * t);
    };
    const finishRectangleClimb = (e, y, facing, wallDismount = false) => {
      const c = e.climb, d = e.drive, m = e.motion, p = e.root.position;
      p.y = y; e.heading = facing; e.speed = 0;
      c.active = c.free = c.lipBypass = c.mountPending = c.holdPose = c.openingStagePending = false; c.handoffDirection = 0; c.retry = 0.25;
      c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
      d.airborne = d.passiveFall = false; d.grounded = true; d.vy = d.jumps = 0;
      d.wallRelease = false;
      d.climbExitHeading = wallDismount && e.controlled ? facing : NaN;
      d.climbExitLook = wallDismount && e.controlled ? facing : NaN;
      d.climbTurnTimer = e.controlled ? 0.45 : 0;
      m.climb = m.mantle = m.climbDirection = m.climbSide = 0; m.climbBlend = NaN;
      m.climbGripX = m.climbGripY = m.climbGripZ = NaN; m.climbGripRelease = 0;
      e.footprintMode = "walk"; e.compact = e.gorilla.compact;
      e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
      if (!e.controlled && d.resume) resumeEntry(e);
    };
    const dropRectangleClimb = (e, away = true, speed = 1.5) => {
      const c = e.climb, d = e.drive, m = e.motion;
      c.active = c.free = c.lipBypass = c.mountPending = c.holdPose = c.openingStagePending = false; c.handoffDirection = 0;
      c.airAttachAfter = elapsed + 0.2; c.retry = 0.25;
      d.airborne = d.passiveFall = true; d.grounded = false; d.vy = 0;
      d.wallRelease = true;
      d.vx = away ? -Math.sin(e.heading) * speed : 0;
      d.vz = away ? -Math.cos(e.heading) * speed : 0;
      d.motionEnvelope = false; d.resume = !e.controlled;
      m.climb = m.mantle = m.climbDirection = m.climbSide = 0; m.climbBlend = NaN;
      m.climbGripX = m.climbGripY = m.climbGripZ = NaN; m.climbGripRelease = 0;
      e.footprintMode = "walk"; e.compact = false;
      e.radius = CLIMB_RADIUS; e.height = CLIMB_HEIGHT;
    };
    const openingLanding = (e, x, y, z, heading, platform = null, descending = false) => {
      if (!ctx.climbOpeningClear || autonomousChill(e)) return false;
      const c = e.climb, sx = Math.sin(heading), sz = Math.cos(heading);
      // Balcony floors extend inward from a spherical overhang. Measure the
      // landing and outward clearance from that geometry, not the root.
      const radius = Math.hypot(x, z);
      const firstReach = platform ? Math.max(0.3, radius - Math.hypot(platform.x, platform.z)) : 1.8;
      const lastReach = platform ? firstReach + 2.4 : 3;
      const clearance = platform ? Math.max(0, platform.radius - radius) : 0;
      for (let reach = firstReach; reach <= lastReach; reach += 0.3) {
        const tx = x + sx * reach, tz = z + sz * reach;
        const floor = pointSupportAt(tx, tz, platform ? platform.y + 0.05 : y + 1.05, e);
        if (!Number.isFinite(floor) || floor > y + 1.05 || !platform && y - floor > 2.4
          // A descent cannot enter a floor above its feet. Just below the
          // rim, that floor is the roof we left, not a window landing.
          || !platform && descending && floor > y + 0.1
          || platform && Math.abs(floor - platform.y) > 0.1
          || !actorLanding(e, tx, floor, tz)) continue;
        // Enter at the lowest height the actual opening permits. Crossing
        // high and only lowering at the far end leaves the head in the lintel.
        // Descending past a rim must not raise the body back onto the roof
        // to reach a lower-looking landing beyond it. Ascending windows and
        // the measured balcony capture keep their certified crossing range.
        const highestCrossing = platform ? floor + 0.5 : descending ? y : y + 1.05;
        for (let crossY = platform ? floor : Math.max(floor, y - 2.4); crossY <= highestCrossing; crossY += 0.25) {
          if (floor > crossY + 0.1 || !ctx.climbOpeningClear(e, tx, crossY, tz, tx, floor, tz)) continue;
          // A falling body may meet the projecting ceiling before it can
          // descend. Clear that lip outward, lower, then swing feet inward.
          for (let trial = 0; trial < (platform ? 7 : 1); trial++) {
            const retreat = trial ? clearance + (trial - 1) * 0.3 : 0;
            const ax = x - sx * retreat, az = z - sz * retreat;
            if (!ctx.climbOpeningClear(e, x, y, z, ax, y, az)
              || !ctx.climbOpeningClear(e, ax, y, az, ax, crossY, az)
              || !ctx.climbOpeningClear(e, ax, crossY, az, tx, crossY, tz)) continue;
            c.freeTargetX = tx; c.freeTargetY = floor; c.freeTargetZ = tz; c.openingCrossY = crossY;
            c.openingStagePending = retreat > 0; c.openingStageX = ax; c.openingStageZ = az;
            c.handoffStartX = ax; c.handoffStartY = y; c.handoffStartZ = az;
            c.handoffDirection = -2; c.blocked = 0;
            return true;
          }
        }
      }
      return false;
    };
    const beginPlatformEntry = (e) => {
      const p = e.root.position, c = e.climb, d = e.drive, m = e.motion;
      // A released wall grip must also clear balcony openings before an
      // airborne catch can mount them again.
      if (d.airborne && elapsed < c.airAttachAfter) return false;
      if (!ctx.platformEntryAt || !ctx.platformEntryAt(p.x, p.y, p.z, WALL_POINT)) return false;
      const heading = WALL_POINT.heading;
      if (!openingLanding(e, p.x, p.y, p.z, heading, WALL_POINT)) return false;
      e.heading = c.heading = c.topHeading = heading;
      bindWallPanel(e, heading);
      c.active = c.free = c.descending = c.fromTop = true;
      c.mountPending = c.holdPose = c.waitRelease = c.lipBypass = false;
      c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
      c.autoTo = -1; c.airAttachAfter = 0;
      d.vx = d.vy = d.vz = d.motionRecover = 0;
      d.airborne = d.passiveFall = d.grounded = d.motionEnvelope = false;
      m.climb = m.climbBlend = 1; m.mantle = m.takeoff = m.supportOffset = 0;
      m.climbGripX = m.climbGripY = m.climbGripZ = NaN; m.climbGripRelease = 0;
      e.speed = 0; e.biped = false; e.lounge = "";
      return true;
    };
    const rectangleGripStep = (e, dt, x, y, z, heading = e.heading) => {
      const c = e.climb, m = e.motion, p = e.root.position;
      if (c.gripPreparedAt === elapsed) return true;
      const stride = m.climbStride, release = m.climbGripRelease;
      const gripX = m.climbGripX, gripY = m.climbGripY, gripZ = m.climbGripZ;
      const gripStride = m.climbGripStride, gripDirection = m.climbGripDirection, gripSide = m.climbGripSide;
      const travel = Math.hypot(x - p.x, y - p.y, z - p.z);
      // Running can take two controller steps before one animation frame.
      // Always prove the dt that poseEntry will actually render, from the
      // unchanged articulated rig, rather than either half-step's pose.
      const poseDt = m.labDt || dt;
      const offset = m.supportOffset;
      m.supportOffset = damp(offset, 0, 12, poseDt);
      m.climbStride += travel * (m.climbDirection < 0 ? -1 : 1);
      m.climbGripX = m.climbGripY = m.climbGripZ = NaN; m.climbGripRelease = 0;
      m.verifyGrip = true;
      let fits = climbPoseClear(e, poseDt, x, y, z, heading, m);
      const contact = fits ? e.gorilla.climbContactMask : 0;
      if (contact === 1 || contact === 2) {
        if (release & contact) {
          // Switching the load to the previously free hand takes a planted
          // frame first. Establish both palms here before letting go of the
          // old supporting one or advancing the body towards the new face.
          m.climbStride = stride;
          fits = climbPoseClear(e, poseDt, p.x, p.y, p.z, e.heading, m)
            && e.gorilla.climbContactMask === 3;
          if (fits) {
            m.verifyGrip = false; m.supportOffset = offset;
            c.holdPose = false; c.gripPreparedAt = elapsed; return true;
          }
          m.climbStride += travel * (m.climbDirection < 0 ? -1 : 1);
        }
        // Reach with the unplanted hand while the other carries the body.
        // Prove that same supporting palm before, midway through and after
        // the translation; a nearby wall rectangle alone is not a grip.
        m.climbGripRelease = 3 ^ contact;
        m.climbGripStride = m.climbStride;
        m.climbGripDirection = m.climbDirection; m.climbGripSide = m.climbSide;
        fits = !(release & contact);
        for (let i = 0; i <= 2 && fits; i++) {
          const t = i * 0.5, px = p.x + (x - p.x) * t, py = p.y + (y - p.y) * t, pz = p.z + (z - p.z) * t;
          m.climbGripX = px; m.climbGripY = py; m.climbGripZ = pz;
          fits = climbPoseClear(e, poseDt, px, py, pz, heading, m)
            && (e.gorilla.climbContactMask & contact) === contact;
        }
      } else fits = fits && contact === 3;
      m.verifyGrip = false; m.supportOffset = offset;
      if (!fits) {
        m.climbStride = stride; m.climbGripRelease = release;
        m.climbGripX = gripX; m.climbGripY = gripY; m.climbGripZ = gripZ;
        m.climbGripStride = gripStride; m.climbGripDirection = gripDirection; m.climbGripSide = gripSide;
        return false;
      }
      p.x = x; p.y = y; p.z = z; e.heading = heading;
      c.blocked = 0; c.holdPose = false;
      return true;
    };
    const updateRectangleClimb = (e, dt) => {
      const c = e.climb, d = e.drive, m = e.motion, p = e.root.position;
      // The contact plane owns facing, independently of the trip/look bearing
      // that brought the gorilla here. S changes vertical travel, not yaw.
      const heading = c.panel.heading, sx = c.panel.nx, sz = c.panel.nz;
      e.heading = c.heading = heading;
      wallPanels.coordinates(c.panel, p.x, p.y, p.z);
      const goal = e.debugMove.active ? e.debugMove.target : e;
      const goalX = e.debugMove.active ? goal.x : e.goalX;
      const goalY = e.debugMove.active ? goal.y : e.goalY;
      const goalZ = e.debugMove.active ? goal.z : e.goalZ;
      let side = e.controlled ? d.climbSide : clamp((goalX - p.x) * sz - (goalZ - p.z) * sx, -1, 1);
      // A normal NPC's climb is a leg of its trip, not its final height.
      // Preserve the chosen direction through the roof/wall handoff: a
      // destination on another roof still requires descending this wall.
      let vertical = e.controlled ? d.climbAxis : e.debugMove.active
        ? clamp(goalY - p.y, -1, 1) : c.descending ? -1 : 1;
      if (!e.controlled && Math.abs(vertical) < 0.15) vertical = 0;
      if (!e.controlled && Math.abs(side) < 0.15) side = 0;
      if (e.debugMove.active && !side && !vertical) {
        e.debugMove.status = "arrived"; c.holdPose = true; e.speed = 0; return;
      }
      if (c.waitRelease) {
        if (d.climbAxis <= 0) c.waitRelease = false;
        else vertical = 0;
      }
      const length = Math.max(1, Math.hypot(side, vertical)); side /= length; vertical /= length;
      const distance = CLIMB_SPEED * (e.controlled && d.run ? 2 : 1) * dt;
      if (autonomousChill(e) && vertical < 0 && !descentWallAt(e, p.x, p.y, p.z)
        && !chillCaveClear(p.x, p.y, p.z, p.x, p.y - Math.max(distance, 0.4), p.z, true)) {
        // Cross above the entrance to the nearest corner before descending,
        // rather than stopping at its reserved ceiling or entering the room.
        vertical = 0;
        for (let i = 0; i < chillZones.length; i++) {
          const zone = chillZones[i], dx = p.x - zone.x, dz = p.z - zone.z;
          const across = dx * zone.cr - dz * zone.sr, along = dx * zone.sr + dz * zone.cr;
          if (p.y - 0.4 >= zone.top || Math.abs(across) >= zone.half || along <= zone.from || along >= zone.to) continue;
          side = (across < 0 ? -1 : across > 0 ? 1 : e.turn) * (zone.cr * sz + zone.sr * sx < 0 ? -1 : 1);
          break;
        }
      }
      m.climb = m.climbBlend = 1; m.openingSettle = 0; m.mantle = 0;
      m.climbDirection = vertical; m.climbSide = side;
      e.compact = false; e.footprintMode = "pound";
      e.radius = CLIMB_RADIUS; e.height = CLIMB_HEIGHT; e.speed = 0; c.holdPose = false;
      if (c.handoffDirection === -2) {
        if (c.openingStagePending) {
          const remaining = Math.hypot(c.openingStageX - p.x, c.openingStageZ - p.z);
          const advance = Math.min(remaining, distance * 1.35);
          const x = remaining ? p.x + (c.openingStageX - p.x) * advance / remaining : p.x;
          const z = remaining ? p.z + (c.openingStageZ - p.z) * advance / remaining : p.z;
          if (!ctx.climbOpeningClear(e, p.x, p.y, p.z, x, p.y, z)) { dropRectangleClimb(e, false); return; }
          p.x = x; p.z = z; m.climbStride += advance;
          if (remaining - advance < 0.001) c.openingStagePending = false;
          return;
        }
        // Align with the window before crossing, then lower whenever the
        // next inward position clears the sill. Keep the input live.
        const remaining = Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z);
        const alignment = c.openingCrossY - p.y;
        const startDistance = Math.hypot(c.freeTargetX - c.handoffStartX, c.freeTargetZ - c.handoffStartZ);
        const aligning = Math.abs(alignment) > 0.03 && remaining >= startDistance - 0.001;
        const advance = aligning ? 0 : Math.min(remaining, distance * 1.35);
        const x = remaining > 0 ? p.x + (c.freeTargetX - p.x) * advance / remaining : p.x;
        const z = remaining > 0 ? p.z + (c.freeTargetZ - p.z) * advance / remaining : p.z;
        if (!ctx.climbOpeningClear(e, p.x, p.y, p.z, x, p.y, z)) {
          // A lower sill may require returning to the certified crossing
          // height before the next horizontal step.
          const raise = Math.min(c.openingCrossY, p.y + distance * 1.35);
          if (raise > p.y + 0.001 && ctx.climbOpeningClear(e, p.x, p.y, p.z, p.x, raise, p.z)) {
            m.climbStride += raise - p.y; p.y = raise; return;
          }
          dropRectangleClimb(e, false); return;
        }
        let y = aligning ? p.y + clamp(alignment, -distance * 1.35, distance * 1.35)
          : remaining - advance <= startDistance * 0.5
            ? Math.max(c.freeTargetY, p.y - distance * 1.35) : p.y;
        if (y !== p.y && !ctx.climbOpeningClear(e, x, p.y, z, x, y, z)) {
          if (aligning) { dropRectangleClimb(e, false); return; }
          y = p.y;
        }
        m.climbStride += Math.hypot(advance, y - p.y);
        p.x = x; p.y = y; p.z = z;
        const inward = clamp(1 - Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z)
          / Math.max(0.001, Math.hypot(c.freeTargetX - c.handoffStartX, c.freeTargetZ - c.handoffStartZ)), 0, 1);
        // Release the upper grip once the feet are through the opening.
        // Keeping any climb blend at the landing leaves the hands on the lintel.
        m.climb = m.climbBlend = 1 - clamp(inward / 0.8, 0, 1);
        if (remaining - advance < 0.03 && Math.abs(y - c.freeTargetY) < 0.03) {
          if (Math.abs(pointSupportAt(p.x, p.z, p.y + 0.1, e) - c.freeTargetY) > 0.12) {
            dropRectangleClimb(e, false); return;
          }
          const settle = m.climb;
          finishRectangleClimb(e, c.freeTargetY, heading);
          c.openingExit = true; c.openingExitX = p.x; c.openingExitZ = p.z; c.openingExitHeading = heading;
          m.climbGripX = m.climbGripY = m.climbGripZ = NaN;
          m.climbGripRelease = 0;
          m.openingSettle = settle;
        }
        return;
      }
      if (c.mountPending) {
        // Slide the ground rectangle over the rim until the wall rectangle
        // carries it. No mantle pose or precomputed arc changes the root.
        const remaining = Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z);
        const advance = Math.min(remaining, distance);
        const x = remaining ? p.x + (c.freeTargetX - p.x) * advance / remaining : p.x;
        const z = remaining ? p.z + (c.freeTargetZ - p.z) * advance / remaining : p.z;
        const y = remaining - advance < 0.45 ? Math.max(c.freeTargetY, p.y - distance) : p.y;
        if (climbClear(e, p.x, p.y, p.z, x, y, z, heading, true, true)) {
          p.x = x; p.y = y; p.z = z; c.blocked = 0;
        } else c.blocked += dt;
        m.climb = m.climbBlend = handoffProgress(c, p);
        if (Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z) < 0.03
          && Math.abs(p.y - c.freeTargetY) < 0.03
          && wallContactShare(e, p.x, p.y, p.z, heading) >= WALL_ENTER_SHARE) c.mountPending = false;
        if (c.mountPending && c.blocked > 0.6) {
          const floor = support(e, p.x, p.z, p.y, STEP);
          if (Number.isFinite(floor) && Math.abs(floor - p.y) < 0.1)
            finishRectangleClimb(e, floor, heading + Math.PI);
          else dropRectangleClimb(e);
          c.mountPending = false;
          return;
        }
        if (c.mountPending) m.climbDirection = m.climbSide = 0;
        return;
      }
      if (e.controlled && !c.handoffDirection && vertical < 0 && !side) {
        const floor = pointSupportAt(p.x - sx * 0.6, p.z - sz * 0.6, p.y + 0.2, e);
        if (Number.isFinite(floor) && floor <= p.y && p.y - floor <= 1.2) {
          dropRectangleClimb(e); c.airAttachAfter = Infinity; return;
        }
        // A wall that ends above open space cannot hold a downward step.
        // Release while the current grip is still close, before the body can
        // remain suspended at the last row of stone.
        let lowerGrip = false;
        for (let across = -0.4; across <= 0.4 && !lowerGrip; across += 0.4)
          for (let depth = 0.8; depth <= 1.55; depth += 0.2)
            if (climbSolidAt(p.x + sx * depth + sz * across, p.y - 0.55,
              p.z + sz * depth - sx * across)) { lowerGrip = true; break; }
        if (!lowerGrip) { dropRectangleClimb(e); c.airAttachAfter = Infinity; return; }
      }
      // The lintel can still hold the upright rectangle after the feet reach
      // a window. Try its certified inner footing before the ordinary wall
      // and crest handoffs, both when climbing up and when climbing down.
      if (!c.handoffDirection && vertical < 0 && beginPlatformEntry(e)) return;
      if (!c.handoffDirection && vertical
        && !climbSolidAt(p.x + sx, p.y + 0.65, p.z + sz)
        && openingLanding(e, p.x, p.y, p.z, heading, null, vertical < 0)) return;
      if (c.handoffDirection === 1 || vertical > 0 && wallVerticalShare(e, p.x, p.y, p.z, heading, true) >= WALL_ENTER_SHARE) {
        if (c.handoffDirection !== 1) {
          c.freeTargetY = NaN;
          for (let reach = 1.2; reach <= 2.4; reach += 0.3) {
            const x = p.x + sx * reach, z = p.z + sz * reach, y = climbSurfaceAt(x, z);
            // An autonomous ascent already reserved its roof. A narrow shelf
            // partway up is a grip, not the walking exit for that route.
            if (!Number.isFinite(y) || y < p.y + 0.1 || y > p.y + 1.8
              || !e.controlled && !e.debugMove.active && !c.fromTop && c.count > 1 && y < c.upperY - 0.65
              || wallRectangleShare(e, x, y, z, heading, true) < TOP_EXIT_SHARE
              || !actorLanding(e, x, y, z)
              || !climbWalkClear(e, x, y, z, x, y, z, heading)) continue;
            c.freeTargetX = x; c.freeTargetY = y; c.freeTargetZ = z;
            c.handoffStartX = p.x; c.handoffStartY = p.y; c.handoffStartZ = p.z;
            break;
          }
          if (Number.isFinite(c.freeTargetY)) c.handoffDirection = 1;
        }
        if (c.handoffDirection === 1) {
          m.climb = m.climbBlend = 1 - Math.sqrt(handoffProgress(c, p));
          const rise = Math.min(c.freeTargetY, p.y + distance);
          const remaining = Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z);
          const advance = rise >= c.freeTargetY - 0.4 ? Math.min(remaining, distance) : 0;
          const x = p.x + sx * advance, z = p.z + sz * advance;
          if (climbClear(e, p.x, p.y, p.z, x, rise, z, heading, true, true)) {
            p.x = x; p.y = rise; p.z = z; c.blocked = 0;
            m.climb = m.climbBlend = 1 - Math.sqrt(handoffProgress(c, p));
            if (remaining - advance < 0.03 && Math.abs(p.y - c.freeTargetY) < 0.03
              && wallRectangleShare(e, p.x, p.y, p.z, heading, true) >= TOP_EXIT_SHARE) {
              finishRectangleClimb(e, c.freeTargetY, heading);
            }
          } else if ((c.blocked += dt) > 0.5) { c.handoffDirection = 0; c.blocked = 0; }
          return;
        }
      }
      // The vertical wall rectangle hands off once a quarter of it overlaps
      // the horizontal ground plane.
      if (c.handoffDirection === -1 || vertical < 0
        && wallVerticalShare(e, p.x, p.y, p.z, heading, false) >= WALL_ENTER_SHARE) {
        if (c.handoffDirection !== -1) {
          c.freeTargetY = NaN;
          for (let retreat = 0.3; retreat <= 2.4 && !Number.isFinite(c.freeTargetY); retreat += 0.3)
            for (let lane = 0; lane < 5 && !Number.isFinite(c.freeTargetY); lane++) {
              const side = lane ? Math.ceil(lane / 2) * 0.5 * (lane % 2 ? 1 : -1) : 0;
              const x = p.x - sx * retreat + sz * side, z = p.z - sz * retreat - sx * side;
              const terrain = ctx.terrainSupportAt
                ? ctx.terrainSupportAt(e, x, z, p.y, STEP, heading)
                : groundAt(x, z, p.y + STEP);
              const y = support(e, x, z, p.y, STEP, heading);
              if (!Number.isFinite(terrain) || !Number.isFinite(y)
                || Math.abs(y - terrain) > 0.12 || y > p.y + 0.1 || p.y - y > 0.8
                || !wallBodyClear(x, y, z, heading) || !actorLanding(e, x, y, z)
                || !climbWalkClear(e, x, y, z, x, y, z, heading)
                || !climbClear(e, p.x, p.y, p.z, x, p.y, z, heading, true, true)
                || !climbClear(e, x, p.y, z, x, y, z, heading, true, true)) continue;
              c.freeTargetX = x; c.freeTargetY = y; c.freeTargetZ = z;
              c.handoffStartX = p.x; c.handoffStartY = p.y; c.handoffStartZ = p.z;
              c.handoffDirection = -1;
            }
        }
        if (c.handoffDirection === -1) {
          m.climb = m.climbBlend = 1 - handoffProgress(c, p);
          const remaining = Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z);
          const advance = Math.min(remaining, distance);
          const x = remaining ? p.x + (c.freeTargetX - p.x) * advance / remaining : p.x;
          const z = remaining ? p.z + (c.freeTargetZ - p.z) * advance / remaining : p.z;
          // Clear the lower projection before lowering the body past it.
          const y = remaining - advance < 0.03 ? Math.max(c.freeTargetY, p.y - distance) : p.y;
          if ((remaining - advance >= 0.03 || wallBodyClear(x, y, z, heading))
            && climbClear(e, p.x, p.y, p.z, x, y, z, heading, true, true)) {
            p.x = x; p.y = y; p.z = z; c.blocked = 0;
            m.climb = m.climbBlend = 1 - handoffProgress(c, p);
          } else if ((c.blocked += dt) > 0.5) { c.handoffDirection = 0; c.blocked = 0; }
          if (Math.hypot(c.freeTargetX - p.x, c.freeTargetZ - p.z) < 0.03
            && Math.abs(p.y - c.freeTargetY) < 0.03)
            finishRectangleClimb(e, c.freeTargetY, heading, true);
          return;
        }
        // A wall foot has reached the floor, but no complete walking body
        // fits there yet. Keep its grip and allow a sideways search instead
        // of continuing vertically through the ground plane.
        if (!e.controlled && !e.debugMove.active && !side) {
          const x = p.x - sx * 0.6, z = p.z - sz * 0.6;
          const floor = pointSupportAt(x, z, p.y + 0.2, e);
          // On a jagged face the last handhold can end just above clear
          // grass. Release into a short outward fall rather than holding a
          // stationary wall pose until the recovery timer relocates the Ooga.
          if (Number.isFinite(floor) && floor <= p.y && p.y - floor <= 1.2
            && actorLanding(e, x, floor, z)
            && climbClear(e, p.x, p.y, p.z, x, p.y, z, heading, true, true)) {
            dropRectangleClimb(e, true, 4);
            if (autonomousChill(e)) e.drive.resume = false;
            return;
          }
        }
        vertical = 0; m.climbDirection = 0;
      }
      if (Math.abs(side) + Math.abs(vertical) < 0.001) {
        if (!rectangleGripStep(e, dt, p.x, p.y, p.z)) {
          const required = 3 & ~m.climbGripRelease;
          c.holdPose = (e.gorilla.climbHandContactMask() & required) === required;
        }
        return;
      }
      wallPanels.point(c.panel, c.panel.u + side * distance, c.panel.v + vertical * distance, c.panel.depth, WALL_POINT);
      const tx = WALL_POINT.x, ty = WALL_POINT.y, tz = WALL_POINT.z;
      const contact = wallContactShare(e, tx, ty, tz, heading);
      if ((contact >= WALL_ENTER_SHARE || c.lipBypass && wallLipHold(tx, ty, tz, heading))
        && wallBodyClear(tx, ty, tz, heading)
        && climbClear(e, p.x, p.y, p.z, tx, ty, tz, heading, true, true)
        && rectangleGripStep(e, dt, tx, ty, tz)) {
        c.lipBypass = contact < WALL_ENTER_SHARE;
        c.blocked = 0; return;
      }
      if (side && vertical) for (let axis = 0; axis < 2; axis++) {
        const x = axis ? p.x : tx, y = axis ? ty : p.y, z = axis ? p.z : tz;
        const contact = wallContactShare(e, x, y, z, heading);
        if ((contact < WALL_ENTER_SHARE
          && !(c.lipBypass && wallLipHold(x, y, z, heading)))
          || !wallBodyClear(x, y, z, heading)
          || !climbClear(e, p.x, p.y, p.z, x, y, z, heading, true, true)
          || !rectangleGripStep(e, dt, x, y, z)) continue;
        c.lipBypass = contact < WALL_ENTER_SHARE;
        c.blocked = 0; return;
      }
      // Follow a receding stone face diagonally. The forward component uses
      // the same step budget as the vertical/lateral input and stops one
      // standoff short of the next face; the body and scenery sweeps still
      // certify each short move.
      if ((vertical || side) && wallBodyClear(tx, ty, tz, heading)) {
        const face = wallFaceDepth(tx, ty, tz, heading);
        if (Number.isFinite(face) && face >= 0.76) {
          const advance = Math.max(0, Math.min(distance * 0.7, face - CLIMB_STANDOFF));
          const tangent = Math.sqrt(distance * distance - advance * advance);
          const x = p.x + sz * side * tangent + sx * advance;
          const y = p.y + vertical * tangent;
          const z = p.z - sx * side * tangent + sz * advance;
          if (wallBodyClear(x, y, z, heading)
            && climbClear(e, p.x, p.y, p.z, x, y, z, heading, true, true)
            && rectangleGripStep(e, dt, x, y, z)) {
            c.lipBypass = true; c.blocked = 0; return;
          }
        }
      }
      // An opening with an inner floor carries the feet inward first. Open
      // air without a supported, clear landing still uses normal gravity.
      if (vertical < 0 && !wallContactShare(e, tx, ty, tz, heading)
        && wallBodyClear(tx, ty, tz, heading)
        && climbClear(e, p.x, p.y, p.z, tx, ty, tz, heading, true, true)) {
        p.x = tx; p.y = ty; p.z = tz;
        if (!openingLanding(e, tx, ty, tz, heading, null, true)) dropRectangleClimb(e);
        return;
      }
      // A projecting voxel can occupy the tangent step while the wall is
      // still climbable. Ease the rectangle outward and retry next frame.
      const protrudes = !wallBodyClear(tx, ty, tz, heading);
      const retreat = Math.min(distance, 0.12), rx = p.x - sx * retreat, rz = p.z - sz * retreat;
      const lip = protrudes && wallLipHold(rx, p.y, rz, heading);
      if (protrudes && (wallContactShare(e, rx, p.y, rz, heading) >= WALL_ENTER_SHARE || lip)
        && climbClear(e, p.x, p.y, p.z, rx, p.y, rz, heading, true, true)
        && rectangleGripStep(e, dt, rx, p.y, rz)) {
        c.lipBypass = lip; c.blocked = 0; return;
      }
      // A wider lip may outgrow the short outward step. Project onto its
      // actual face only while stuck, at a bounded rate; the checked edge
      // sweep still prevents the body from cutting through the projection.
      if ((vertical || side) && Math.floor((c.blocked + dt) / 0.18) !== Math.floor(c.blocked / 0.18)
        && projectWallPoint(e, tx, ty, tz, p.x, p.y, p.z, heading, side, vertical)) {
        const travel = Math.hypot(WALL_POINT.x - p.x, WALL_POINT.y - p.y, WALL_POINT.z - p.z);
        const t = Math.min(1, distance / Math.max(0.001, travel));
        const x = p.x + (WALL_POINT.x - p.x) * t, y = p.y + (WALL_POINT.y - p.y) * t, z = p.z + (WALL_POINT.z - p.z) * t;
        if (wallBodyClear(x, y, z, heading)
          && climbClear(e, p.x, p.y, p.z, x, y, z, heading, true, true)
          && rectangleGripStep(e, dt, x, y, z)) return;
      }
      // Crossing a corner can require a different panel. Measure that face;
      // never rotate by guessed offsets merely to escape a blocked step.
      if (side && Math.floor((c.blocked + dt) / 0.18) !== Math.floor(c.blocked / 0.18)
        && wallPanels.fit(tx, ty, tz, heading, PANEL)
        && Math.cos(PANEL.heading - heading) > 0.35
        && Math.abs(Math.sin(PANEL.heading - heading)) > 0.08
        && wallBodyClear(tx, ty, tz, PANEL.heading)
        && wallContactShare(e, tx, ty, tz, PANEL.heading) >= WALL_ENTER_SHARE
        && climbClear(e, p.x, p.y, p.z, tx, ty, tz, heading, true, true)
        && climbClear(e, p.x, p.y, p.z, tx, ty, tz, PANEL.heading, true, true)
        && rectangleGripStep(e, dt, tx, ty, tz, PANEL.heading)) {
        c.heading = PANEL.heading;
        bindWallPanel(e, c.heading);
        c.lipBypass = false; c.blocked = 0; return;
      }
      // An unreachable depth change retains its last real grip. Do not let
      // the idle animation release that support after rejecting movement.
      const required = 3 & ~m.climbGripRelease;
      c.holdPose = (e.gorilla.climbHandContactMask() & required) === required;
      c.blocked += dt;
      if (autonomousChill(e) && c.descending && c.blocked > 0.6) {
        // A stepped face may end between two wall panels. If clear ground is
        // below the outward side, release the grip and let gravity finish the
        // descent instead of holding the same rejected wall step indefinitely.
        const x = p.x - sx * 1.5, z = p.z - sz * 1.5;
        const floor = pointSupportAt(x, z, p.y + 0.02, e);
        if (Number.isFinite(floor) && floor <= p.y && floor >= p.y - 12
          && actorLanding(e, x, floor, z)
          && chillCaveClear(p.x, p.y, p.z, x, floor, z, true)
          && climbClear(e, p.x, p.y, p.z, x, p.y, z, heading, true, true)) {
          dropRectangleClimb(e, true, 4);
          d.resume = false;
        }
      }
    };
    const wallFaceHeading = (e, heading) => {
      const p = e.root.position;
      if (wallPanels && wallPanels.fit(p.x, p.y, p.z, heading, PANEL)) return PANEL.heading;
      // Look ahead across the walking rectangle before its centre reaches a
      // diagonal face. Every candidate still needs a fitted wall plane; a
      // nearby rock or the side of a ramp cannot supply a guessed yaw.
      for (let reach = 0.5; reach <= 1.5; reach += 0.5) for (let lane = -2; lane <= 2; lane++) {
        const bearing = heading + lane * 0.28;
        const x = p.x + Math.sin(bearing) * reach, z = p.z + Math.cos(bearing) * reach;
        if (wallRectangleShare(e, x, p.y, z, bearing) < WALL_ENTER_SHARE) continue;
        if (wallPanels.fit(p.x, p.y, p.z, bearing, PANEL)
          || wallPanels.fit(x, p.y, z, bearing, PANEL)) return PANEL.heading;
      }
      return NaN;
    };
    const bindWallPanel = (e, heading, x = e.root.position.x, y = e.root.position.y, z = e.root.position.z) => {
      const panel = e.climb.panel;
      panel.heading = heading; panel.nx = Math.sin(heading); panel.nz = Math.cos(heading);
      panel.x = x + panel.nx * CLIMB_STANDOFF; panel.y = y; panel.z = z + panel.nz * CLIMB_STANDOFF;
      wallPanels.coordinates(panel, x, y, z);
    };
    const attachWallPanel = (e) => {
      const p = e.root.position, c = e.climb;
      const heading = wallFaceHeading(e, c.heading);
      if (!Number.isFinite(heading) || !wallBodyClear(p.x, p.y, p.z, heading)
        || wallContactShare(e, p.x, p.y, p.z, heading) < WALL_ENTER_SHARE
        || !climbClear(e, p.x, p.y, p.z, p.x, p.y, p.z, heading, true, true)) return false;
      e.heading = c.heading = heading;
      bindWallPanel(e, c.heading);
      return true;
    };
    const climbApproachHeading = (e, heading, descending) => e.debugMove.active && e.debugMove.wallTarget
      && Number.isFinite(e.debugMove.normalHeading) ? e.debugMove.normalHeading + (descending ? Math.PI : 0)
      : descending ? heading : wallFaceHeading(e, heading);
    const pendingClimbSearch = (e) => {
      const c = e.climb;
      if (!c.searchPending) return false;
      const p = e.root.position, d = e.drive;
      const dx = e.controlled ? d.x : e.goalX - p.x;
      const dz = e.controlled ? d.z : e.goalZ - p.z;
      const heading = climbApproachHeading(e, Math.atan2(dx, dz), c.searchDescending);
      if (!Number.isFinite(heading) || !e.active || c.active || !e.controlled && (!alive(e.owner) && !e.sleep.stage || !e.debugMove.active && e.mode !== e.owner.state)
        || e.recover > 0 || e.jump.active || d.airborne || e.pound || e.beat || e.stand || e.parked || e.fire.rolling
        || Math.hypot(dx, dz) <= (e.controlled ? 0.05 : 0.18)
        || Math.hypot(p.x - c.searchX, p.y - c.searchY, p.z - c.searchZ) > 0.35
        || Math.abs(Math.atan2(Math.sin(heading - c.searchHeading), Math.cos(heading - c.searchHeading))) > 0.18
        || !e.controlled && Math.hypot(e.goalX - c.searchGoalX, e.goalY - c.searchGoalY, e.goalZ - c.searchGoalZ) > 0.35
        || caveAt(p.x, p.y, p.z) >= 0 || walkingStairsAt(e, heading)
        || !e.controlled && (e.route === "exit" && e.fromSite >= 0 || e.route === "enter"
          || e.route === "apron" && p.y <= e.goalY + 0.8)) {
        c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = c.claimRetreat = false;
        c.claimOrder = 0; c.claimFor = -1; c.searchCursor = 0; c.retry = 0;
        if (climbTurn === e.index) climbTurn = -1;
        return false;
      }
      return true;
    };
    const holdClimbSearch = (e) => {
      if (!pendingClimbSearch(e)) return false;
      if (e.climb.claimPending && e.climb.claimRetreat) {
        const c = e.climb;
        c.claimPending = c.crestPending = c.searchPending = c.searchDeferred = false; c.claimOrder = 0; c.claimFor = -1; c.retry = 0.8;
        // The waiting torso occupies the admitted climber's landing. Use the
        // existing swept ground backout instead of blocking it or teleporting.
        backOut(e, e.motion.labDt || 1 / 30, true);
        return true;
      }
      // Keep the existing four-footed support while finding a complete grip
      // route. Walking around would continually invalidate the deferred cursor.
      e.speed = e.drive.vx = e.drive.vz = 0; e.biped = false;
      return true;
    };
    // A failed crest can have dozens of valid-looking footholds. Resume their
    // deterministic order over later updates instead of rebuilding every full
    // wall route in one frame. All bearings and lower-end fallbacks share this
    // cursor and budget; none restarts the first failed candidate on a retry.
    const attemptClimb = (e, lx, ly, lz, ux, uy, uz, heading, descending, lowerExit = true) => {
      const c = e.climb;
      for (let curve = 0; curve < (descending ? 1 : 2); curve++) {
        const index = c.searchIndex++;
        if (index < c.searchCursor) continue;
        if (!c.searchBudget || !climbFrameBudget || climbTurn >= 0 && climbTurn !== e.index) {
          c.searchDeferred = true; c.retry = 0.03; return false;
        }
        c.searchBudget--; climbFrameBudget--; climbNext = (e.index + 1) % list.length; c.searchCursor = index + 1;
        if (!buildClimb(e, lx, ly, lz, ux, uy, uz, heading, descending, lowerExit, !!curve)) {
          // Both curves share the approach and vertical wall path. Only a
          // rejected crest can benefit from building the alternate pull.
          if (!descending && !curve && !c.claimPending && c.failure !== "mantle" && c.failure !== "crest pose") {
            c.searchIndex++; c.searchCursor = c.searchIndex; break;
          }
          continue;
        }
        c.searchPending = false;
        if (climbTurn === e.index) climbTurn = -1;
        return true;
      }
      return false;
    };
    const tryClimbAlong = (e, heading, descending = false) => {
      if (!climbSolidAt || !climbSurfaceAt || e.climb.active || e.climb.retry > 0 || e.jump.active || e.drive.airborne
        || e.fire.rolling || e.pound || e.beat || e.recover > 0 || e.parked) return false;
      if (walkingStairsAt(e, heading)) return false;
      if (descending && beginEdgeClimb(e, heading)) return true;
      if (!descending) heading = wallFaceHeading(e, heading);
      if (!Number.isFinite(heading)) return false;
      const p = e.root.position, sx = Math.sin(heading), sz = Math.cos(heading);
      e.climb.retry = e.controlled ? 0.12 : 0.6; e.climb.failure = "search";
      if (descending) {
        if (!cliffRiserAhead(p.x, p.z, heading, -1)) { e.climb.retry = 0; return false; }
        let edge = NaN;
        for (let d = 0.35; d <= 3.1; d += 0.25) {
          if (climbSurfaceAt(p.x + sx * d, p.z + sz * d) < p.y - 0.8) { edge = d; break; }
        }
        if (!Number.isFinite(edge)) return false;
        for (let n = 0; n < 7; n++) for (let d = edge + 1.8; d <= edge + 6; d += 0.6) {
          const side = n ? Math.ceil(n / 2) * 0.75 * (n % 2 ? 1 : -1) : 0;
          const x = p.x + sx * d + sz * side, z = p.z + sz * d - sx * side;
          const y = support(e, x, z, climbSurfaceAt(x, z), STEP, heading + Math.PI);
          if (!landing(x, y, z) || y > p.y - 0.8 || y < p.y - 16
            || !climbWalkClear(e, x, y, z, x, y, z, heading + Math.PI, false)) continue;
          if (attemptClimb(e, x, y, z, p.x, p.y, p.z, heading + Math.PI, true)) return true;
          if (e.climb.searchDeferred) return false;
        }
      } else {
        let wall = NaN;
        for (let d = 0.25; d <= 4.5; d += 0.2) {
          if (climbSolidAt(p.x + sx * d, p.y + 0.9, p.z + sz * d)) { wall = d; break; }
        }
        if (!Number.isFinite(wall)) return false;
        if (wallRectangleShare(e, p.x, p.y, p.z, heading) < WALL_ENTER_SHARE
          && !cliffRiserAhead(p.x, p.z, heading, 1, wall + 0.6)) return false;
        e.climb.failure = "landing";
        for (let n = 0; n < 7; n++) for (let d = wall + 1.5; d <= wall + 6; d += 0.6) {
          // A voxel crest can slope sideways. Pull over onto the nearest
          // complete foothold rather than insisting on an unsafe half ledge.
          const side = n ? Math.ceil(n / 2) * 0.75 * (n % 2 ? 1 : -1) : 0;
          const x = p.x + sx * d + sz * side, z = p.z + sz * d - sx * side;
          const y = support(e, x, z, climbSurfaceAt(x, z), STEP, heading);
          // Fold onto all fours only where at least three quarters of the
          // rectangle is on the roof and less than a quarter still faces wall.
          if (!landing(x, y, z) || y < p.y + 0.8 || y > p.y + 16
            || wallRectangleShare(e, x, y, z, heading, true) < TOP_EXIT_SHARE
            || wallRectangleShare(e, x, y, z, heading) >= WALL_ENTER_SHARE
            || !climbWalkClear(e, x, y, z, x, y, z, heading, false)) continue;
          if (attemptClimb(e, p.x, p.y, p.z, x, y, z, heading, false)) return true;
          if (e.climb.searchDeferred) return false;
        }
      }
      return false;
    };
    const tryClimb = (e, heading, descending = false) => {
      const c = e.climb, p = e.root.position;
      if (c.retry > 0) return false;
      heading = climbApproachHeading(e, heading, descending);
      if (!Number.isFinite(heading)) return false;
      if (walkingStairsAt(e, heading)) return false;
      if (c.claimPending && c.searchDescending === descending && pendingClimbSearch(e)) {
        if (!admitClimb(e)) return false;
        c.searchPending = c.searchDeferred = false;
        if (climbTurn === e.index) climbTurn = -1;
        return true;
      }
      if (!(!descending && wallRectangleShare(e, p.x, p.y, p.z, heading) >= WALL_ENTER_SHARE)
        && !cliffRiserAhead(p.x, p.z, heading, descending ? -1 : 1)) {
        c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
        c.retry = 0;
        return false;
      }
      if (!c.searchPending || c.searchDescending !== descending
        || Math.hypot(p.x - c.searchX, p.y - c.searchY, p.z - c.searchZ) > 0.35
        || Math.abs(Math.atan2(Math.sin(heading - c.searchHeading), Math.cos(heading - c.searchHeading))) > 0.18) {
        c.searchPending = c.claimPending = c.crestPending = false; c.searchCursor = 0; c.searchX = p.x; c.searchY = p.y; c.searchZ = p.z;
        c.searchHeading = heading; c.searchDescending = descending;
        c.searchGoalX = e.goalX; c.searchGoalY = e.goalY; c.searchGoalZ = e.goalZ;
      }
      // New approaches still run the cheap wall test. Only a real deferred
      // foothold joins the priority queue; ordinary grass walkers cannot fill it.
      if (c.searchPending && (!climbFrameBudget || climbTurn >= 0 && climbTurn !== e.index)) {
        c.searchPending = true; c.searchDeferred = true; c.retry = 0.03;
        return false;
      }
      c.searchPending = true; c.searchDeferred = false; c.searchIndex = 0;
      if (tryClimbAlong(e, heading, descending)) return true;
      if (c.searchDeferred) return false;
      if (!c.retry) { c.searchPending = false; return false; }
      if (descending && climbSolidAt && climbSurfaceAt) {
        // Autonomous walks need a supported destination. A bottomless wall
        // is an exploration choice for the player, not a useful chill route.
        if (!e.controlled && !e.debugMove.active) {
          c.searchPending = false;
          if (climbTurn === e.index) climbTurn = -1;
          if (e.phase === "chill") { restAfterClimb(e); return true; }
          return false;
        }
        // The player may descend without a known floor. Reserve the longest
        // available section of wall and retain a grip at its lower end.
        const sx = Math.sin(heading), sz = Math.cos(heading);
        for (let edge = 0.35; edge <= 3.1; edge += 0.25) {
          if (climbSurfaceAt(p.x + sx * edge, p.z + sz * edge) >= p.y - 0.8) continue;
          for (let depth = 16; depth >= 2; depth -= 2) {
            const x = p.x + sx * (edge + 2), z = p.z + sz * (edge + 2);
            if (attemptClimb(e, x, p.y - depth, z, p.x, p.y, p.z, heading + Math.PI, true, false)) return true;
            if (c.searchDeferred) return false;
          }
          break;
        }
      }
      c.searchPending = false;
      if (climbTurn === e.index) climbTurn = -1;
      return false;
    };
    const climbBlocked = (e, dt) => {
      const c = e.climb;
      // A rejected translation may still allow the feet to settle safely
      // before the next step. Prove that stationary articulation too; blindly
      // damping the old target can otherwise push a hand into the lip.
      const p = e.root.position;
      c.holdPose = !climbPoseClear(e, dt, p.x, p.y, p.z, e.heading, e.motion);
      c.blocked += dt;
      if (c.debugRole >= 0 && !e.controlled && c.blocked > 1.2) {
        c.debugStuck = c.holdPose = true;
        if (e.debugMove.active) { e.debugMove.status = "blocked"; e.debugMove.reason = "Climbing motion blocked"; }
        return;
      }
      if (!e.controlled && c.blocked > 1.2 && !c.returning) {
        // A temporary obstruction cancels the trip once. Follow the already
        // checked route back to its reserved source, rather than bouncing
        // forever between two blocked heights and resetting the stall timer.
        c.returning = true; c.reversals++;
        c.descending = !c.fromTop; c.autoTo = -1; c.blocked = 0; e.drive.resume = true;
      }
    };
    const prepareAscendingClearance = (e, dt, heading, stride, nextStride, direction, side, blockedArm) => {
      const c = e.climb, m = e.motion, p = e.root.position;
      if (!c.lowerExit || c.descending || c.debugTraverse || c.progress <= c.lowerGroundDistance
        || p.y > c.lowerY + CLIMB_HEIGHT || c.progress >= c.mantleStart - 1.6 || c.lowerClearance >= 0.48) return false;
      const sx = Math.sin(c.heading), sz = Math.cos(c.heading), remaining = 0.48 - c.lowerClearance;
      const tx = POINT.x - sx * remaining, tz = POINT.z - sz * remaining;
      const oldRelease = m.climbGripRelease, oldX = m.climbGripX, oldY = m.climbGripY, oldZ = m.climbGripZ;
      // Clear the projecting foot of the wall, keeping one hand available.
      // The full next pose must fit before taking a speed-limited outward step.
      let fits = false;
      for (let attempt = 0; attempt < (blockedArm ? 2 : 1); attempt++) {
        m.climbGripRelease = attempt ? blockedArm : 0;
        m.climbGripX = attempt ? tx : NaN; m.climbGripY = attempt ? POINT.y : NaN; m.climbGripZ = attempt ? tz : NaN;
        if (wallGrip(tx, POINT.y, tz, heading) && climbPoseClear(e, dt, tx, POINT.y, tz, heading, m)) { fits = true; break; }
      }
      const shift = Math.min(remaining, dt * CLIMB_SPEED);
      const weight = Math.min(1, (c.progress - c.lowerGroundDistance) / 0.6);
      const x = p.x - sx * shift * weight, z = p.z - sz * shift * weight;
      m.climbStride = stride; m.climbDirection = m.climbSide = 0;
      if (m.climbGripRelease) { m.climbGripX = x; m.climbGripY = p.y; m.climbGripZ = z; }
      if (!fits || !wallGrip(x, p.y, z, heading) || !climbClear(e, p.x, p.y, p.z, x, p.y, z)
        || !climbPoseClear(e, dt, x, p.y, z, heading, m)) {
        m.climbStride = nextStride; m.climbDirection = direction; m.climbSide = side;
        m.climbGripRelease = oldRelease; m.climbGripX = oldX; m.climbGripY = oldY; m.climbGripZ = oldZ;
        return false;
      }
      p.x = x; p.z = z; c.lowerClearance += shift; c.lowerClearanceAscent = true;
      c.blocked = 0; c.holdPose = false; e.speed = 0; return true;
    };
    const prepareLowerClearance = (e, dt, heading, stride, nextStride, direction, side) => {
      const c = e.climb, m = e.motion, p = e.root.position;
      if (!c.lowerExit || !c.descending || c.debugTraverse || c.progress <= c.lowerGroundDistance
        || c.progress > c.lowerGroundDistance + 1.6 || c.lowerClearance >= 0.28) return false;
      const sx = Math.sin(c.heading), sz = Math.cos(c.heading), remaining = 0.28 - c.lowerClearance;
      const tx = POINT.x - sx * remaining, tz = POINT.z - sz * remaining;
      // A projecting low lip can need slightly more room than the wall's
      // sampled trunk corridor. First prove a complete next pose with a grip;
      // then approach that clearance through a swept, speed-limited move.
      if (!wallGrip(tx, POINT.y, tz, heading) || !climbPoseClear(e, dt, tx, POINT.y, tz, heading, m)) return false;
      const shift = Math.min(remaining, dt * CLIMB_SPEED);
      const weight = Math.min(1, (c.progress - c.lowerGroundDistance) / 0.6);
      const x = p.x - sx * shift * weight, z = p.z - sz * shift * weight;
      m.climbStride = stride; m.climbDirection = m.climbSide = 0;
      if (!wallGrip(x, p.y, z, heading) || !climbClear(e, p.x, p.y, p.z, x, p.y, z)
        || !climbPoseClear(e, dt, x, p.y, z, heading, m)) {
        m.climbStride = nextStride; m.climbDirection = direction; m.climbSide = side; return false;
      }
      p.x = x; p.z = z; c.lowerClearance += shift; c.blocked = 0; c.holdPose = false; e.speed = 0;
      return true;
    };
    const prepareClimbPose = (e, dt, heading, stride, nextStride, direction, side) => {
      const c = e.climb, m = e.motion, p = e.root.position;
      const blockedArm = e.gorilla.climbBlockedArm;
      if (prepareLowerClearance(e, dt, heading, stride, nextStride, direction, side)
        || prepareAscendingClearance(e, dt, heading, stride, nextStride, direction, side, blockedArm)) return true;
      m.climbGripX = POINT.x; m.climbGripY = POINT.y; m.climbGripZ = POINT.z;
      m.climbGripStride = nextStride; m.climbGripDirection = direction; m.climbGripSide = side;
      m.climbGripRelease = 0;
      m.climbStride = stride; m.climbDirection = m.climbSide = 0;
      // Preparing the next grip does not translate the root. Retain this
      // collision-checked articulation target, including its shoulder/foot
      // phase, without adding distance to the spatial stride while blocked.
      let fits = climbPoseClear(e, dt, p.x, p.y, p.z, heading, m);
      if (blockedArm || !fits && e.gorilla.climbBlockedArm) {
        // Free the hand before shifting its shoulder around a projecting lip.
        // Only the obstructed arm releases; the body stays in its old phase
        // until the same full pose check admits the next grip. A stationary
        // preview can pass without changing a hooked hand, so retain the arm
        // that prevented translation before that preview resets its result.
        const normalFits = fits;
        m.climbGripRelease = blockedArm || e.gorilla.climbBlockedArm;
        m.climbGripStride = stride; m.climbGripDirection = m.climbGripSide = 0;
        fits = climbPoseClear(e, dt, p.x, p.y, p.z, heading, m);
        if (!fits && normalFits) {
          m.climbGripRelease = 0;
          m.climbGripStride = nextStride; m.climbGripDirection = direction; m.climbGripSide = side;
          fits = true;
        }
      }
      if (!fits) {
        m.climbGripRelease = 0;
        m.climbGripX = m.climbGripY = m.climbGripZ = NaN; return false;
      }
      e.heading = heading; e.speed = 0; c.holdPose = false; c.blocked += dt;
      if (c.blocked > 1.2) climbBlocked(e, 0);
      return true;
    };
    const controlledRailDetour = (e, dt, released, travelDt) => {
      const c = e.climb, p = e.root.position;
      if (!e.controlled || c.blocked < 0.2 || c.progress <= c.lowerGroundDistance + 0.12
        || c.progress >= c.mantleStart - 0.12 || !wallGrip(p.x, p.y, p.z, c.heading)
        || !attachWallPanel(e)) return false;
      // The authored vertical rail no longer matches this voxel face. Keep
      // the exact current pose and let checked free climbing follow the live
      // wall; do not jump to the next rail point.
      c.free = true; c.handoffDirection = 0; e.heading = c.heading;
      e.motion.climbGripX = e.motion.climbGripY = e.motion.climbGripZ = NaN;
      e.motion.climbGripRelease = 0;
      updateRectangleClimb(e, travelDt);
      return true;
    };
    const jumpOffWall = (e) => {
      const c = e.climb, d = e.drive, m = e.motion;
      const forwardX = Math.sin(e.heading), forwardZ = Math.cos(e.heading);
      const side = d.climbSide * 1.2;
      c.active = c.free = c.lipBypass = c.mountPending = c.holdPose = c.openingStagePending = false;
      c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
      c.handoffDirection = 0; c.autoTo = -1; c.retry = 0.4; c.airAttachAfter = elapsed + 0.25;
      c.debugRole = -1; c.debugTraverse = c.waitRelease = false;
      d.vx = -forwardX * 3.6 + forwardZ * side;
      d.vz = -forwardZ * 3.6 - forwardX * side;
      d.vy = PLAYER_JUMP_SPEED;
      d.airborne = d.motionEnvelope = true; d.grounded = d.passiveFall = false;
      d.jumps = 1; d.jumpPressed = false; d.jumpBuffer = 0; d.jumpDown = d.jumpHeld;
      d.motionRecover = 0.6;
      m.climb = m.mantle = m.climbSide = m.climbDirection = m.climbGripRelease = 0;
      m.climbGripX = m.climbGripY = m.climbGripZ = NaN;
      m.climbBlend = NaN; m.takeoff = 1;
      e.footprintMode = "walk"; e.compact = false; e.radius = MOTION_RADIUS; e.height = MOTION_HEIGHT;
      e.speed = 0; e.jumps++;
    };
    const jumpOffCaveSide = (e) => {
      const c = e.climb, p = e.root.position, wall = descentWallAt(e, p.x, p.y, p.z);
      if (!wall || c.mountPending || c.handoffDirection || p.y > wall.middle + 0.05 || elapsed < c.departureRetry) return false;
      c.departureRetry = elapsed + 0.4;
      const across = (p.x - wall.x) * wall.cr - (p.z - wall.z) * wall.sr;
      const preferred = across < 0 ? -1 : across > 0 ? 1 : e.turn;
      const heading = e.heading, compact = e.compact, mode = e.footprintMode;
      const radius = e.radius, height = e.height;
      // Prove a full airborne arc to real ground beyond either side of the
      // entrance. Release the climbing envelope for that proof: flight must
      // not keep testing a hand grip against the wall it is leaving.
      c.active = false; c.departurePlanning = true; e.footprintMode = "walk";
      for (let side = 0; side < 2; side++) for (let reach = 0; reach < 3; reach++) {
        const sign = side ? -preferred : preferred;
        const lateral = Math.max(Math.abs(across) + 1.5, wall.half + 0.5) + reach * 0.6;
        const outward = 3.2 + reach * 0.8;
        const x = wall.x + wall.cr * sign * lateral + wall.sr * outward;
        const z = wall.z - wall.sr * sign * lateral + wall.cr * outward;
        const y = groundAt(x, z, wall.floor + STEP);
        if (!Number.isFinite(y) || Math.abs(y - wall.floor) > STEP || !chillCaveClear(x, y, z)) continue;
        e.heading = Math.atan2(x - p.x, z - p.z);
        if (!prepareJump(e, x, y, z, 2.2)) continue;
        c.departurePlanning = false; e.jump.caveExit = true;
        e.drive.resume = false;
        finishRectangleClimb(e, p.y, e.heading);
        e.drive.grounded = false;
        c.airAttachAfter = elapsed + e.jump.duration + 0.5;
        e.compact = false; e.radius = Math.max(MOTION_RADIUS, radius); e.height = Math.max(MOTION_HEIGHT, height);
        e.motion.takeoff = 1; e.rest = 0;
        e.roam.count = e.roam.index = 0; e.roam.wall = false;
        return true;
      }
      c.active = true; c.departurePlanning = false; e.heading = heading; e.compact = compact;
      e.footprintMode = mode; e.radius = radius; e.height = height;
      return false;
    };
    const updateClimb = (e, dt) => {
      const c = e.climb, d = e.drive, m = e.motion, p = e.root.position;
      if (c.free) e.heading = c.heading = c.panel.heading;
      if (e.controlled && d.jumpPressed) { jumpOffWall(e); return; }
      if (jumpOffCaveSide(e)) return;
      const travelDt = dt * (e.controlled && d.run ? 2 : 1);
      // Keep both ground rectangles current while climbing. Their different
      // heights/angles describe the actual footing available at a handoff.
      if (ctx.groundPlaneAt) ctx.groundPlaneAt(p.x, p.y, p.z, e.heading, m.groundRects.angled, m);
      if (c.debugStuck) { c.holdPose = true; e.speed = 0; return; }
      if (c.free) { updateRectangleClimb(e, dt); return; }
      const released = m.climbGripRelease, gripStride = m.climbGripStride;
      const gripDirection = m.climbGripDirection, gripSide = m.climbGripSide;
      m.climbGripX = m.climbGripY = m.climbGripZ = NaN;
      m.climbGripRelease = 0;
      // An autonomous route may walk up to the wall, but the upright
      // rectangle owns travel once stone actually supports it. The old rail
      // no longer dictates the wall or crest portion of an ordinary climb.
      // On a roof departure, torso contact can appear before the feet have
      // cleared the crest. Finish that supported approach before handing the
      // fully wall-facing rectangle its direction; partial crest yaw points
      // it back at roof terrain instead of down the face.
      if ((!c.fromTop || c.progress <= c.mantleStart + 0.001)
        && wallContactShare(e, p.x, p.y, p.z, c.heading) >= WALL_ENTER_SHARE && attachWallPanel(e)) {
        c.free = true; c.handoffDirection = 0; e.heading = c.heading;
        updateRectangleClimb(e, dt); return;
      }
      if (e.debugMove.active && c.debugStop >= 0 && Math.abs(c.progress - c.debugStop) < 0.001) {
        if (e.debugMove.wallFinal) {
          e.debugMove.status = "arrived"; c.holdPose = true; e.speed = 0; m.climbSide = m.climbDirection = 0; return;
        }
        e.debugMove.wallPending = true; c.debugStop = -1;
      }
      if (e.debugMove.active && e.debugMove.wallTarget && e.debugMove.wallPending
        && c.progress > c.lowerGroundDistance + 0.18 && c.progress < c.mantleStart - 0.18
        && m.climbBlend > 0.98 && e.gorilla.debug.climbing > 0.98 && wallGrip(p.x, p.y, p.z, e.heading)) {
        searchWallRoute(e); return;
      }
      c.holdPose = false;
      e.speed = 0; e.compact = false;
      e.radius = Math.max(CLIMB_RADIUS, e.gorilla.bodyRadius + 0.015); e.height = Math.max(CLIMB_HEIGHT, e.gorilla.bodyHeight + 0.015);
      e.footprintMode = "pound";
      m.climb = 1; m.climbDirection = m.climbSide = 0;
      if (e.controlled && Math.abs(d.climbSide) > 0.01 && !c.handoffDirection && c.autoTo < 0
        && c.progress > c.lowerGroundDistance + 0.12 && c.progress < c.mantleStart - 0.12
        && m.climbBlend > 0.98 && e.gorilla.debug.climbing > 0.98 && attachWallPanel(e)) {
        c.free = true; c.handoffDirection = 0;
        updateRectangleClimb(e, travelDt); return;
      }
      if (c.waitRelease && d.climbAxis <= 0) c.waitRelease = false;
      let axis = e.controlled ? c.waitRelease ? 0 : d.climbAxis : c.descending ? -1 : 1;
      if (!e.controlled && !c.lowerExit && c.progress <= c.minimum + 0.001) {
        if (c.debugRole < 0) c.returning = true;
        c.descending = false; c.autoTo = -1; axis = 1;
      }
      if (c.autoTo >= 0) {
        if (c.autoDirection > 0 && d.climbAxis < 0) c.autoTo = -1;
        else if (c.autoDirection > 0 ? c.progress < c.autoTo - 0.01 : c.progress > c.autoTo + 0.01) axis = c.autoDirection > 0 ? 1 : -1;
        else c.autoTo = -1;
      }
      if (e.controlled && !c.handoffDirection && (axis > 0 && c.progress >= c.mantleStart - 0.001
        || axis < 0 && c.lowerExit && c.progress <= c.lowerGroundDistance + 0.12)) c.handoffDirection = Math.sign(axis);
      if (c.handoffDirection) axis = c.handoffDirection;
      if (axis < 0 && c.basePrepEnd > c.progress + 0.001) {
        // The initial backstep is still ordinary supported walking. Reversing
        // here releases the grip attempt at that safe footing immediately.
        c.active = false; c.retry = 0.8; d.grounded = true;
        c.free = false; c.handoffDirection = d.climbSide = 0;
        m.climb = 0; m.climbBlend = NaN; m.mantle = 0;
        e.compact = e.gorilla.compact; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
        return;
      }
      if (!c.fromTop && c.progress === 0 && axis > 0) {
        const turn = Math.atan2(Math.sin(c.heading - e.heading), Math.cos(c.heading - e.heading));
        if (Math.abs(turn) > 0.001) {
          const facing = e.heading + clamp(turn, -travelDt * 3, travelDt * 3);
          m.climbBlend = m.mantle = 0;
          if (climbStartTurnClear(e, facing)
            && climbPoseClear(e, dt, p.x, p.y, p.z, facing, m)) {
            e.heading = facing; c.blocked = 0;
          } else climbBlocked(e, dt);
          return;
        }
      }
      // Settle the hands and torso at the foot of the wall while keeping the
      // wall-facing heading through the grounded handoff.
      if (c.lowerExit && c.progress <= c.lowerGroundDistance + 0.001
        && (axis < 0 && c.bottomTurn < 1 || axis > 0 && c.bottomTurn > 0)) {
        const oldBlend = m.climbBlend, oldMantle = m.mantle;
        const turn = clamp(c.bottomTurn + (axis < 0 ? 1 : -1) * travelDt / CLIMB_TURN_TIME, 0, 1), facing = c.heading;
        let blend = 1 - turn * turn * (3 - 2 * turn);
        m.climbBlend = blend; m.mantle = 0;
        while (!climbPoseClear(e, dt, p.x, p.y, p.z, facing, m) && blend < 1) {
          blend = Math.min(1, blend + 0.12); m.climbBlend = blend;
        }
        if (climbPoseClear(e, dt, p.x, p.y, p.z, facing, m)) {
          e.heading = facing; c.bottomTurn = turn; c.blocked = 0;
        } else {
          m.climbBlend = oldBlend; m.mantle = oldMantle; climbBlocked(e, dt);
        }
        return;
      }
      if (!axis) {
        c.holdPose = !climbPoseClear(e, dt, p.x, p.y, p.z, e.heading, m);
        return;
      }
      // Reduce horizontal travel through the last mount distance. The feet
      // approach at walking/running pace, then hand off to wall speed instead
      // of carrying a full run into an abrupt vertical stop.
      const phaseAt = c.progress + axis * travelDt * CLIMB_CREST_SPEED;
      const approach = e.controlled ? d.run ? SPEED : CHILL_SPEED * 2 : e.mode === "chilling" ? CHILL_SPEED : CLIMB_APPROACH_SPEED;
      const wallApproach = Math.min(approach, CLIMB_SPEED);
      const remainingGround = Math.max(0, c.lowerGroundDistance - c.progress);
      const groundPace = wallApproach + (approach - wallApproach)
        * clamp(remainingGround / CLIMB_MOUNT_DISTANCE, 0, 1);
      const pace = c.lowerExit && phaseAt <= c.lowerGroundDistance + 0.001 ? groundPace
        : phaseAt >= c.mantleStart - 0.001 ? CLIMB_CREST_SPEED : CLIMB_SPEED;
      const bottom = c.lowerExit && axis < 0 ? c.basePrepEnd || 0 : c.minimum;
      let next = clamp(c.progress + axis * travelDt * pace, bottom, c.length);
      if (e.debugMove.active && c.debugStop >= 0) next = axis > 0 ? Math.min(next, c.debugStop) : Math.max(next, c.debugStop);
      if (axis < 0 && c.lowerExit && c.progress > c.lowerGroundDistance && next < c.lowerGroundDistance) next = c.lowerGroundDistance;
      climbPoint(c, next, POINT);
      let nextClearance = c.lowerClearance;
      const clearanceWeight = clamp((next - c.lowerGroundDistance) / 0.6, 0, 1)
        * (c.lowerClearanceAscent ? clamp((c.mantleStart - next) / 1.6, 0, 1) : 1);
      if (c.lowerClearance && c.lowerExit && !c.debugTraverse) {
        // Meet the unchanged reserved handoffs exactly. Ascending corrections
        // also disappear before the already checked crest and roof landing.
        const clearance = c.lowerClearance * clearanceWeight;
        POINT.x -= Math.sin(c.heading) * clearance; POINT.z -= Math.cos(c.heading) * clearance;
      }
      const riseEnd = Number.isFinite(c.mantleRiseEnd) ? c.mantleRiseEnd : c.mantleStart;
      const top = next <= c.mantleStart ? 0 : riseEnd > c.mantleStart && next < riseEnd
        ? 0.65 * (next - c.mantleStart) / (riseEnd - c.mantleStart)
        : clamp((riseEnd > c.mantleStart ? 0.65 : 0) + (riseEnd > c.mantleStart ? 0.35 : 1)
          * (next - riseEnd) / Math.max(0.1, c.length - riseEnd), 0, 1);
      const ground = next <= c.lowerGroundDistance + 0.001 && c.lowerExit;
      let blend = (1 - top) * (1 - top), facing = c.heading;
      if (top > 0) {
        const turn = Math.atan2(Math.sin(c.topHeading - c.heading), Math.cos(c.topHeading - c.heading));
        facing = c.heading + turn * top;
      }
      if (ground) {
        if (axis < 0) blend = 1 - c.bottomTurn * c.bottomTurn * (3 - 2 * c.bottomTurn);
        else {
          const start = Math.max(c.basePrepEnd || 0, c.lowerGroundDistance - CLIMB_MOUNT_DISTANCE);
          const approach = clamp((next - start) / Math.max(0.01, c.lowerGroundDistance - start), 0, 1);
          blend = approach * approach * (3 - 2 * approach);
        }
      }
      const oldBlend = m.climbBlend, oldMantle = m.mantle, oldStride = m.climbStride, oldSide = m.climbSide;
      // Keep the knuckle-walk gait alive while the body rises into its first
      // grips. Zeroing it at the start of this blend translated a rigid pose
      // across the last stretch of ground and made the mount look like a float.
      let speed = ground ? Math.hypot(POINT.x - p.x, POINT.z - p.z) / dt : 0;
      if ((POINT.x - p.x) * Math.sin(facing) + (POINT.z - p.z) * Math.cos(facing) < 0) speed = -speed;
      m.climbBlend = blend; m.mantle = top;
      m.climbStride += !ground && top === 0 ? next - c.progress : POINT.y - p.y;
      const stepLength = Math.hypot(POINT.x - p.x, POINT.y - p.y, POINT.z - p.z);
      m.climbDirection = !ground && top === 0 ? (POINT.y - p.y) / Math.max(0.0001, stepLength) : Math.sign(axis);
      m.climbSide = !ground && top === 0
        ? ((POINT.x - p.x) * Math.cos(facing) - (POINT.z - p.z) * Math.sin(facing)) / Math.max(0.0001, stepLength) : 0;
      if (c.lowerClearanceAscent && nextClearance > 0 && !ground && !top && axis > 0) {
        // Once the hands clear a projecting lip, return toward the wall. A
        // permanent offset would leave them reaching into air above the lip.
        // Each inward step is independently proved with the full moving rig.
        const x = POINT.x, z = POINT.z, direction = m.climbDirection, side = m.climbSide;
        const shift = Math.min(nextClearance, travelDt * CLIMB_SPEED);
        POINT.x += Math.sin(c.heading) * shift * clearanceWeight;
        POINT.z += Math.cos(c.heading) * shift * clearanceWeight;
        const distance = Math.hypot(POINT.x - p.x, POINT.y - p.y, POINT.z - p.z);
        m.climbDirection = (POINT.y - p.y) / Math.max(0.0001, distance);
        m.climbSide = ((POINT.x - p.x) * Math.cos(facing) - (POINT.z - p.z) * Math.sin(facing)) / Math.max(0.0001, distance);
        let fits = false;
        if (climbClear(e, p.x, p.y, p.z, POINT.x, POINT.y, POINT.z)) for (let release = 0; release <= 2; release++) {
          m.climbGripRelease = release;
          m.climbGripX = release ? POINT.x : NaN; m.climbGripY = release ? POINT.y : NaN; m.climbGripZ = release ? POINT.z : NaN;
          if (climbPoseClear(e, dt, POINT.x, POINT.y, POINT.z, facing, m)) { fits = true; break; }
        }
        if (fits) nextClearance -= shift;
        else {
          POINT.x = x; POINT.z = z; m.climbDirection = direction; m.climbSide = side;
          m.climbGripRelease = 0; m.climbGripX = m.climbGripY = m.climbGripZ = NaN;
        }
      }
      const transition = c.debugTraverse && next >= c.traverseStart - 0.2 && next <= c.traverseEnd + 0.2
        || blend < 0.999 || e.gorilla.debug.climbing < 0.999 || Math.abs(facing - e.heading) > 0.001;
      if (!transition && !climbClear(e, p.x, p.y, p.z, POINT.x, POINT.y, POINT.z)) {
        m.climbBlend = oldBlend; m.mantle = oldMantle; m.climbStride = oldStride; m.climbDirection = 0; m.climbSide = oldSide;
        climbBlocked(e, dt);
        if (controlledRailDetour(e, dt, released, travelDt)) return;
        return;
      }
      // Even a steady wall step changes the grip around uneven stone. Its
      // coarse body sweep cannot certify the articulated hands: prove the
      // same damped pose that will be rendered before moving the root.
      const nextStride = m.climbStride, nextDirection = m.climbDirection, nextSide = m.climbSide;
      let poseFits = climbPoseClear(e, dt, POINT.x, POINT.y, POINT.z, facing, m, speed);
      if (!poseFits && (released === 1 || released === 2) && !ground && !top) {
        // A hand released above a lip must stay raised through the first
        // translation past it. Reaching down again before that step repeats
        // the same blocked sweep forever. Try the ordinary grip first on
        // every frame, and retain just this one hand only if the full moving
        // pose and remaining wall grip both still pass.
        m.climbGripX = POINT.x; m.climbGripY = POINT.y; m.climbGripZ = POINT.z;
        m.climbGripStride = gripStride; m.climbGripDirection = gripDirection; m.climbGripSide = gripSide;
        m.climbGripRelease = released;
        poseFits = wallGrip(POINT.x, POINT.y, POINT.z, facing)
          && climbPoseClear(e, dt, POINT.x, POINT.y, POINT.z, facing, m, speed);
        if (!poseFits && c.lowerExit && c.descending && next > c.lowerGroundDistance
          && next < c.lowerGroundDistance + 1.6) {
          // At the low masonry handoff, the root-height grip bands can already
          // be below the wall. Keep the released hand raised through the new
          // phase only when the remaining actual palm retains a stone witness.
          m.climbGripStride = nextStride; m.climbGripDirection = nextDirection; m.climbGripSide = nextSide;
          const retained = released === 1 ? 2 : 1;
          poseFits = climbPoseClear(e, dt, POINT.x, POINT.y, POINT.z, facing, m, speed)
            && !!(e.gorilla.climbContactMask & retained)
            && climbPoseClear(e, 2, POINT.x, POINT.y, POINT.z, facing, m, 0)
            && !!(e.gorilla.climbContactMask & retained);
        }
        if (!poseFits) {
          m.climbGripX = m.climbGripY = m.climbGripZ = NaN; m.climbGripRelease = 0;
        }
      }
      if (!poseFits) {
        // An uneven crest may interrupt a turn. Keep the low walking pose and
        // advance toward the open lip before continuing the pivot.
        if (!top || !climbPoseClear(e, dt, POINT.x, POINT.y, POINT.z, e.heading, m, speed)) {
          if (prepareClimbPose(e, dt, facing, oldStride, nextStride, nextDirection, nextSide)
            || top > 0 && facing !== e.heading && prepareClimbPose(e, dt, e.heading, oldStride, nextStride, nextDirection, nextSide)) {
            if (controlledRailDetour(e, dt, released, travelDt)) return;
            return;
          }
          m.climbBlend = oldBlend; m.mantle = oldMantle; m.climbStride = oldStride; m.climbDirection = 0; m.climbSide = oldSide;
          if (controlledRailDetour(e, dt, released, travelDt)) return;
          climbBlocked(e, dt); return;
        }
        facing = e.heading;
      }
      c.blocked = 0; e.speed = speed;
      p.x = POINT.x; p.y = POINT.y; p.z = POINT.z; c.progress = next; c.lowerClearance = nextClearance; e.heading = facing;
      if (next === c.length && axis > 0 || next === bottom && axis < 0 && c.lowerExit) {
        c.active = false; c.retry = 0.8; d.grounded = true;
        c.free = false; c.handoffDirection = d.climbSide = 0;
        c.debugTraverse = false; c.debugRole = -1;
        m.climb = 0; m.climbBlend = NaN; m.mantle = m.climbSide = 0;
        e.compact = e.gorilla.compact; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = 2.7;
        e.recover = e.blocked = 0;
        if (e.controlled) d.climbTurnTimer = 0.45;
        if (axis < 0) d.climbExitHeading = d.climbExitLook = e.heading;
        if (e.debugMove.active) { d.resume = false; resetDebugRoute(e); }
        else {
          if (!e.controlled && (d.resume || e.pendingSite >= 0)) resumeEntry(e);
          if (!e.controlled && e.mode === "chilling" && e.phase === "chill" && (axis > 0) === c.fromTop) restAfterClimb(e);
        }
      }
    };
    const travelGoal = (e, dt) => {
      const p = e.root.position, site = sites[e.site];
      if (!site && e.phase !== "leave") return false;
      if (e.route === "exit") {
        const from = e.fromSite >= 0 ? sites[e.fromSite] : null;
        const along = from ? (p.x - from.mouth.x) * from.sr + (p.z - from.mouth.z) * from.cr : Infinity;
        const exitRadius = Math.max(e.radius, WALK_RADIUS);
        if (from && along < 0.5 + exitRadius && p.y < from.mouth.floorY + 2.7) {
          if (e.fromSite === labSite && e.motion.lab) {
            // Queued departures must also retract their workstation pose, or
            // their hands can cover the aisle needed by the portal holder.
            e.motion.labWork = ""; e.motion.labReach = 0; e.motion.labSqueeze = false;
          }
          if (e.fromSite === labSite && e.motion.lab) {
            const across = (p.x - from.mouth.x) * from.cr - (p.z - from.mouth.z) * from.sr;
            if (e.lab.pathFixed && Math.cos(e.lab.pathHeading - from.mouth.ry) < 0) {
              e.lab.pathCount = e.lab.pathIndex = 0; e.lab.pathFixed = false;
              e.lab.readyAt = e.lab.pathAt = 0;
            }
            if (e.portal !== e.fromSite && (along < -0.6 || Math.abs(across) > 0.3)) {
              sitePoint(from, 0, -0.45, POINT);
              // Route searches reuse POINT for their roadmap nodes. Keep the
              // actual exit target when asking a blocked coworker to move.
              const x = POINT.x, y = POINT.y, z = POINT.z;
              if (!labGoal(e, x, y, z, from.mouth.ry, true)) {
                requestLabPass(e, x, z);
                // A rear worker may have claimed before the front workers'
                // state changed this frame. Let the nearest leaver go first.
                releasePortal(e); return false;
              }
              if (e.blocked > 0.3) requestLabPass(e, x, z);
              return true;
            }
          }
          // Walk the room route before claiming the narrow doorway. A rear
          // departure cannot hold everyone else at their workstations.
          if (!claimPortal(e, e.fromSite)) return false;
          // The room route is finished. Its last fixed-facing leg and wait
          // must not carry into the continuous outward doorway crossing.
          e.lab.pathCount = e.lab.pathIndex = 0; e.lab.pathFixed = false;
          e.lab.readyAt = e.lab.trafficWait = 0;
          sitePoint(from, 0, 0.7 + exitRadius, POINT);
          if (e.fromSite === labSite && e.blocked > 0.3) requestLabPass(e, POINT.x, POINT.z);
          setGoal(e, POINT.x, POINT.y, POINT.z);
          return true;
        }
        releasePortal(e); e.route = "apron";
        if (e.phase === "leave") {
          if (e === debugShuttle) {
            e.phase = "travel"; e.route = "island"; e.exitFootprint = true;
            sitePoint(from, 0, 5.5, POINT);
            setGoal(e, POINT.x, POINT.y, POINT.z);
            return true;
          }
          e.phase = "chill"; e.route = ""; e.exitFootprint = true;
          return chooseChill(e, true);
        }
      }
      if (e.route === "island") {
        if (Math.hypot(e.goalX - p.x, e.goalZ - p.z) > 0.3) return true;
        if (!debugShuttleUntil) debugShuttleUntil = elapsed + 2.5;
        if (elapsed < debugShuttleUntil) return false;
        debugShuttleUntil = 0; e.route = "apron";
      }
      if (e.route === "apron") {
        // Workstation and doorway reservations cannot hold a worker outside.
        e.portalWait = false;
        // Walk into the centre aisle before approaching the arch. Painted
        // paths do not change the gait or trigger a leap.
        sitePoint(site, 0, 5.5, POINT);
        if (Math.hypot(POINT.x - p.x, POINT.z - p.z) > 0.3) {
          setGoal(e, POINT.x, POINT.y, POINT.z); return true;
        }
        e.route = "enter"; e.entryTurn = false;
      }
      if (e.route === "enter") {
        e.overflow = false;
        if (e.site === labSite) {
          if (!e.entryTurn) {
            sitePoint(site, 0, LAB_ENTRY_GOAL, POINT);
            if (Math.hypot(POINT.x - p.x, POINT.z - p.z) > 0.08) {
              setGoal(e, POINT.x, POINT.y, POINT.z); return true;
            }
            e.entryTurn = 1;
            syncLab(e); labEnvelope(e);
          }
          if (e.entryTurn === 1) {
            sitePoint(site, 0, LAB_ROUTE_START, POINT);
            if (Math.hypot(POINT.x - p.x, POINT.z - p.z) > 0.08) {
              setGoal(e, POINT.x, POINT.y, POINT.z); return true;
            }
            e.entryTurn = 2;
            releasePortal(e);
          }
        }
        if (e.site !== labSite && !e.entryTurn) {
          const along = (p.x - site.mouth.x) * site.sr + (p.z - site.mouth.z) * site.cr;
          if (along > -3.3) {
            // Clear the complete body into the centre aisle before heading
            // to a work slot. Keep the same inward run through every arch.
            sitePoint(site, 0, -3.5, POINT);
            setGoal(e, POINT.x, POINT.y, POINT.z);
            return true;
          }
          e.entryTurn = true;
          releasePortal(e);
        }
        if (!e.hasSlot && !reserve(e)) {
          // The room floor is reachable even if every equipment pose is busy.
          // Retry desk selection from inside rather than reversing to a queue.
          e.lab.station = -1; e.lab.stage = ""; e.lab.time = 1;
          e.lab.waitSince = elapsed;
          e.lab.waitPoint.x = e.slotX = p.x; e.lab.waitPoint.y = e.slotY = p.y;
          e.lab.waitPoint.z = e.slotZ = p.z; e.lab.waitPoint.heading = e.heading;
          e.hasSlot = true;
        }
        // Workstation navigation starts only after the inward aisle is clear.
        if (e.motion.lab || site.mirrorRoom) e.entryTurn = true;
        if (e.site === labSite && e.motion.lab) {
          const station = labStations[e.lab.station];
          if (!labGoal(e, e.slotX, e.slotY, e.slotZ, (station || e.lab.waitPoint).heading)) {
            requestLabPass(e, e.slotX, e.slotZ); return false;
          }
        } else setGoal(e, e.slotX, e.slotY, e.slotZ);
        if (Math.hypot(e.slotX - p.x, e.slotZ - p.z) < 0.2) {
          e.phase = "work"; e.route = ""; e.rest = 0.8 + e.random(); releasePortal(e);
          if (e === debugShuttle) debugShuttleAt = elapsed + 8;
        }
        return true;
      }
      return true;
    };
    const backOut = (e, dt, start = false) => {
      const p = e.root.position;
      if (start) { e.backoutHeading = e.heading; e.backoutLeft = 1.5; }
      const heading = e.backoutHeading;
      const sx = -Math.sin(heading), sz = -Math.cos(heading);
      const step = Math.min(e.backoutLeft, CHILL_SPEED * dt);
      const x = p.x + sx * step, z = p.z + sz * step, y = support(e, x, z, p.y, PROP_STEP, heading);
      if (!Number.isFinite(y) || Math.abs(y - p.y) > PROP_STEP || !actorLanding(e, x, y, z)
        || occupied(e, x, y, z, true, heading)
        || !staticClear(e, p.x, p.y, p.z, x, y, z, e.heading, heading)) {
        e.backoutLeft = 0; return false;
      }
      setSupportY(e, y, x, z, heading, dt * 3); p.x = x; p.z = z; e.heading = heading; e.speed = -step / dt;
      e.backoutLeft = Math.max(0, e.backoutLeft - step); e.blocked = e.stuckTime = e.sampleTime = 0;
      e.sampleX = x; e.sampleZ = z;
      return true;
    };
    const propStepClear = (e, x, y, z, nx, ny, nz, fromHeading, toHeading) => {
      if (staticClear(e, x, y, z, nx, ny, nz, fromHeading, toHeading)) return true;
      // Short props are passable to the gorilla sweep. For terrain and taller
      // geometry, a diagonal lift may still clear as two checked segments.
      if (ny > y && (nx !== x || nz !== z)) return !occupied(e, x, ny, z, true, fromHeading)
        && staticClear(e, x, y, z, x, ny, z, fromHeading, fromHeading)
        && staticClear(e, x, ny, z, nx, ny, nz, fromHeading, toHeading);
      // On descent, clear horizontally before lowering onto measured support.
      return ny < y && (nx !== x || nz !== z) && !occupied(e, nx, y, nz, true, toHeading)
        && staticClear(e, x, y, z, nx, y, nz, fromHeading, toHeading)
        && staticClear(e, nx, y, nz, nx, ny, nz, toHeading, toHeading);
    };
    const tallBodyAhead = (e, heading) => {
      const p = e.root.position, sx = Math.sin(heading), sz = Math.cos(heading);
      return occupied(e, p.x + sx * 0.55, p.y, p.z + sz * 0.55)
        || ctx.tallObstacleAhead(e, sx, sz)
        || !e.controlled && ctx.fireClear && !ctx.fireClear(e, p.x, p.y, p.z,
          p.x + sx * 2, p.y, p.z + sz * 2, e.heading, heading);
    };
    const separateSurfacePeers = (e, dt) => {
      if (enteringCave(e) || e.controlled || e.motion.lab || e.climb.active || e.jump.active || e.drive.airborne
        || e.lounge || e.loungeDepart || e.fire.burning || e.fire.rolling || e.pound || e.beat
        || e.gorilla.motionActive) return false;
      const p = e.root.position, shape = torso || footprint;
      let crowded = false, dx = 0, dz = 0;
      for (const other of list) {
        if (other === e || !other.active) continue;
        const q = other.root.position;
        if (!shape.overlaps(e, p.x, p.y, p.z, e.heading, other, q.x, q.y, q.z, other.heading, SPACE)) continue;
        crowded = true;
        const distance2 = Math.max(0.01, (p.x - q.x) ** 2 + (p.z - q.z) ** 2);
        dx += (p.x - q.x) / distance2; dz += (p.z - q.z) / distance2;
      }
      if (!crowded) return false;
      // Keep the current facing while stepping sideways/backwards out of an
      // existing pileup. Turning first can expand the trunk into another peer.
      const heading = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dx, dz) : e.index * 2.399963229728653;
      const step = CHILL_SPEED * dt;
      for (let i = 0; i < 16; i++) {
        const side = i ? Math.ceil(i / 2) * (i % 2 ? 1 : -1) : 0;
        const angle = heading + side * Math.PI / 8;
        const x = p.x + Math.sin(angle) * step, z = p.z + Math.cos(angle) * step;
        const y = support(e, x, z, p.y, PROP_STEP);
        if (!Number.isFinite(y) || Math.abs(y - p.y) > PROP_STEP || !actorLanding(e, x, y, z)
          || occupied(e, x, y, z) || !propStepClear(e, p.x, p.y, p.z, x, y, z, e.heading, e.heading)) continue;
        setSupportY(e, y, x, z); p.x = x; p.z = z;
        e.speed = CHILL_SPEED * (Math.cos(angle - e.heading) < 0 ? -1 : 1);
        e.roam.progressTime = e.blocked = 0;
        return true;
      }
      return false;
    };
    const moveEntryAisle = (e, dt) => {
      const p = e.root.position, dx = e.goalX - p.x, dz = e.goalZ - p.z, distance = Math.hypot(dx, dz);
      e.backoutLeft = e.steerFor = e.steerSide = e.stuckTime = 0;
      if (distance < 0.02) { e.speed = 0; return; }
      const desired = Math.atan2(dx, dz), turn = Math.atan2(Math.sin(desired - e.heading), Math.cos(desired - e.heading));
      const heading = e.heading + clamp(turn, -dt * 7, dt * 7), step = Math.min(distance, SPEED * dt);
      const x = p.x + dx / distance * step, z = p.z + dz / distance * step;
      e.footprintMode = "pound"; e.compact = e.gorilla.poundCompact;
      labEnvelope(e);
      const y = support(e, x, z, p.y, PROP_STEP, heading);
      // Only prove the actual supported step. No steering fan, future-pose
      // horizon or blocked timer may reverse an admitted entrance run.
      if (!Number.isFinite(y) || Math.abs(y - p.y) > PROP_STEP || !actorLanding(e, x, y, z)
        || occupied(e, x, y, z, true, heading)
        || !propStepClear(e, p.x, p.y, p.z, x, y, z, e.heading, heading)) {
        e.speed = 0; e.blocked += dt; return;
      }
      setSupportY(e, y, x, z, heading, dt * 3); p.x = x; p.z = z; e.heading = heading;
      e.speed = step / dt; e.blocked = 0;
    };
    const move = (e, dt, speed) => {
      if (e.recover > 0) { e.speed = 0; return; }
      if (enteringAisle(e)) { moveEntryAisle(e, dt); return; }
      if (e.backoutLeft > 0 && backOut(e, dt)) return;
      const p = e.root.position, dx = e.goalX - p.x, dz = e.goalZ - p.z, distance = Math.hypot(dx, dz);
      if (distance < (e.motion.lab ? 0.06 : 0.15)) { e.speed = damp(e.speed, 0, 12, dt); return; }
      const desired = Math.atan2(dx, dz), step = Math.min(distance, speed * dt);
      // Include sideways and outward steps when skirting a reserved entrance;
      // the ordinary forward-only steering fan cannot escape its front edge.
      const avoidEntrance = autonomousChill(e) && !chillCaveClear(p.x, p.y, p.z,
        p.x + Math.sin(desired) * Math.min(distance, 2), p.y, p.z + Math.cos(desired) * Math.min(distance, 2));
      const steering = avoidEntrance ? FIRE_STEERING : STEERING;
      const inCave = caveAt(p.x, p.y, p.z) >= 0;
      const onProp = raisedSupport(e);
      const doorway = e.lab.yielding || e.route === "exit" && e.fromSite >= 0 || e.route === "enter"
        || e.route === "apron" && p.y <= e.goalY + 0.8;
      if (!onProp && !inCave && !doorway && !e.climb.retry) {
        const drop = ctx.surfaceAt && ctx.surfaceAt(p.x + Math.sin(desired) * 3.1, p.z + Math.cos(desired) * 3.1) < p.y - 0.8;
        // A meadow stroll should steer around a cave instead of climbing it
        // and immediately descending again to chase its unchanged floor goal.
        if ((e.phase !== "chill" || (drop ? e.goalY < p.y - 0.55 : e.goalY > p.y + 0.55))
          && (drop || wallRectangleShare(e, p.x, p.y, p.z, desired) >= WALL_ENTER_SHARE)
          && tryClimb(e, desired, !!drop)) return;
      }
      if (holdClimbSearch(e)) return;
      const roofTransfer = autonomousChill(e) && e.goalY < p.y - 1 && roofAt(p.x, p.y, p.z) >= 0;
      e.sampleTime += dt;
      if (e.sampleTime >= (roofTransfer ? 0.5 : 1)) {
        e.stuckTime = Math.hypot(p.x - e.sampleX, p.z - e.sampleZ) < 0.3 ? e.stuckTime + e.sampleTime : 0;
        e.sampleTime = 0; e.sampleX = p.x; e.sampleZ = p.z;
        if (e.stuckTime > (roofTransfer ? 0.5 : 1.5) && !inCave && !doorway
          && !(ctx.surfaceAt && ctx.surfaceAt(p.x + Math.sin(desired) * 3.1, p.z + Math.cos(desired) * 3.1) < p.y - 0.8)) {
          e.stuckTime = 0;
          // Keep a jump for terrain routes, not for bodies or tall scenery
          // that the walking steer must pass around.
          if (!tallBodyAhead(e, desired)) for (let i = 0; i < STEERING.length; i++) {
            const angle = desired + STEERING[i] * e.turn;
            if (tryJump(e, angle)) { e.heading = angle; return; }
          }
        }
      }
      const initialMode = e.footprintMode, initialCompact = e.compact;
      if (e.steerGoalX !== e.goalX || e.steerGoalZ !== e.goalZ) {
        e.steerGoalX = e.goalX; e.steerGoalZ = e.goalZ;
        e.steerFor = e.steerClear = e.steerSide = 0; e.steerHeading = e.heading;
      }
      e.steerFor = Math.max(0, e.steerFor - dt);
      let chosen = NaN, chosenFacing = e.heading, chosenMode = initialMode, chosenCompact = initialCompact;
      let best = -Infinity, chosenY = p.y, chosenStep = 0, directAhead = false;
      for (let i = 0; i < steering.length; i++) {
        const heading = desired + steering[i] * e.turn, sx = Math.sin(heading), sz = Math.cos(heading);
        const turn = Math.atan2(Math.sin(heading - e.heading), Math.cos(heading - e.heading));
        const labStation = e.motion.lab && e.phase === "work" && !e.lab.yielding
          && e.lab.pathIndex + 1 >= e.lab.pathCount && labStations[e.lab.stage === "fetch" || e.lab.stage === "return" ? e.lab.bench : e.lab.station];
        const roomFacing = e.motion.lab ? labStation && distance < 0.8 ? labStation.heading : NaN
          : e.route === "exit" && e.fromSite >= 0 ? sites[e.fromSite].mouth.ry
          : e.phase === "work" && !sites[e.site].mirrorRoom ? sites[e.site].mouth.ry : NaN;
        const facingTurn = Number.isFinite(roomFacing)
          ? Math.atan2(Math.sin(roomFacing - e.heading), Math.cos(roomFacing - e.heading)) : turn;
        // Bed trips cross the bridge in both directions. They must turn along the route, not keep
        // the reverse-facing pose used to back off a raised prop; the same swept checks still apply.
        const facing = onProp && !e.sleep.stage && Math.cos(heading - e.heading) < -0.25 ? e.heading
          : e.heading + clamp(facingTurn, -dt * 5, dt * 5);
        // The larger chain also covers reverse strides and the recovery
        // from a hop or chest beat. Reserve it before every working step.
        e.footprintMode = e.parked ? "stand" : e.mode === "working" || e.phase === "leave" || e.exitFootprint ? "pound" : "walk";
        e.compact = e.footprintMode === "stand" ? e.gorilla.standCompact
          : (e.mode === "working" || e.phase === "leave" || e.exitFootprint || e.phase === "chill" && (!e.lounge || Math.abs(e.speed) > 0.1))
            && (e.footprintMode === "pound" ? e.gorilla.poundCompact : e.gorilla.compact);
        labEnvelope(e);
        const stride = step;
        const x = p.x + sx * stride, z = p.z + sz * stride;
        // Crossing inward is one-way for this work visit. Once the complete
        // body is behind the glass it cannot wander back into the portal;
        // the explicit exit route remains the only way out.
        if (!mirrorWorkClear(e, p.x, p.z, x, z)) continue;
        const y = support(e, x, z, p.y, PROP_STEP, facing);
        const propStep = onProp || Math.abs(y - groundAt(x, z, p.y)) > 0.02;
        if (onProp && y < p.y - PROP_STEP && beginSupportFall(e, x, z, facing, sx * speed, sz * speed)) return;
        if (!Number.isFinite(y) || y > p.y + PROP_STEP || y < p.y - PROP_STEP || !actorLanding(e, x, y, z)
          || e.phase === "work" && !e.lab.yielding && caveAt(x, y, z) !== e.site
          || e.parked && caveAt(x, y, z) < 0) continue;
        if (occupied(e, x, y, z, true, facing)) continue;
        if (!(propStep ? propStepClear : staticClear)(e, p.x, p.y, p.z, x, y, z, e.heading, facing)) continue;
        // Reserve the approaching arm chain before it reaches a prop, including
        // the turn it will make along that approach. Shorten the horizon on
        // stairs; their individual risers still use the ordinary step checks.
        let ahead = Math.min(distance, 0.8 + speed * 0.7), ax = p.x + sx * ahead, az = p.z + sz * ahead;
        let ay = support(e, ax, az, p.y, PROP_STEP, facing);
        if (Math.abs(ay - p.y) > PROP_STEP) {
          ahead = Math.min(0.45, distance); ax = p.x + sx * ahead; az = p.z + sz * ahead;
          ay = support(e, ax, az, p.y, PROP_STEP, facing);
        }
        const aheadTurn = Math.min(Math.PI, ahead / Math.max(0.1, speed) * 5);
        const aheadFacing = e.heading + clamp(facingTurn, -aheadTurn, aheadTurn);
        const aheadPropStep = onProp || Math.abs(ay - groundAt(ax, az, p.y)) > 0.02;
        const goodAhead = Number.isFinite(ay) && Math.abs(ay - p.y) <= PROP_STEP && actorLanding(e, ax, ay, az)
          && !occupied(e, ax, ay, az, true, aheadFacing)
          && (aheadPropStep ? propStepClear : staticClear)(e, p.x, p.y, p.z, ax, ay, az, e.heading, aheadFacing);
        if (!i) directAhead = goodAhead;
        const side = Math.sign(steering[i] * e.turn);
        const commitment = e.steerFor > 0 && side && e.steerSide ? side === e.steerSide ? 0.45 : -1.25 : 0;
        const score = Math.cos(heading - desired) * 2 + Math.cos(heading - e.steerHeading) * 0.5
          + (goodAhead ? 3 : 0) + commitment - i * 0.008;
        if (score > best) {
          best = score; chosen = heading; chosenFacing = facing; chosenY = y; chosenStep = stride;
          chosenMode = e.footprintMode; chosenCompact = e.compact;
        }
        if (!i && goodAhead && (!e.steerSide || e.steerClear >= 0.25)) break;
      }
      e.footprintMode = chosenMode; e.compact = chosenCompact;
      e.steerClear = directAhead ? e.steerClear + dt : 0;
      if (e.steerClear >= 0.25) { e.steerSide = 0; e.steerFor = 0; }
      if (Number.isFinite(chosen)) {
        const side = Math.sign(Math.sin(chosen - desired));
        if (!directAhead && side && (e.steerFor <= 0 || side !== e.steerSide)) { e.steerSide = side; e.steerFor = 1.2; }
        e.steerHeading = chosen;
        const x = p.x + Math.sin(chosen) * chosenStep, z = p.z + Math.cos(chosen) * chosenStep;
        if (roofEdgeCrossing(e, x, z, chosen)) {
          if (beginEdgeClimb(e, chosen) || beginSupportFall(e, x, z, chosen,
            Math.sin(chosen) * speed, Math.cos(chosen) * speed)) return;
          if (chosenY < p.y - STEP) {
            e.speed = 0; e.blocked += dt;
            if (e.blocked > 1.5 && e.phase === "chill") { e.blocked = 0; chooseChill(e); }
            return;
          }
        }
        setSupportY(e, chosenY, x, z, chosenFacing, dt * 3); p.x = x; p.z = z; e.heading = chosenFacing;
        e.speed = chosenStep / dt * (Math.cos(chosen - e.heading) < 0 ? -1 : 1);
        e.blocked = Math.cos(chosen - desired) > 0.3 ? Math.max(0, e.blocked - dt * 2) : e.blocked + dt;
      } else {
        e.speed = damp(e.speed, 0, 16, dt); e.blocked += dt;
        if (!e.parked && !doorway && e.retry <= 0 && e.blocked > 0.3) {
          const tall = tallBodyAhead(e, desired);
          e.retry = 0.6;
          if (!tall && tryJump(e, desired)) { e.heading = desired; return; }
          if (e.steerFor <= 0) { e.turn = -e.turn; e.steerSide = 0; }
        }
        if (e.blocked > 1.5) {
          e.blocked = 0;
          if (e.phase === "work" && !e.lab.yielding) {
            if (reserve(e, true)) setGoal(e, e.slotX, e.slotY, e.slotZ);
          } else if (e.phase === "chill") chooseChill(e);
          else if (!enteringCave(e)) { e.route = caveAt(p.x, p.y, p.z) >= 0 ? "exit" : "apron"; e.fromSite = caveAt(p.x, p.y, p.z); }
        }
      }
    };
    const abandonRoam = (e) => {
      if (e.debugMove.active) { resetDebugRoute(e, true); return; }
      const r = e.roam, p = e.root.position;
      // A rejected wall approach should lead to a nearby rest, not another
      // roof destination behind the same obstruction on the next decision.
      if (r.wall) {
        r.levelOnlyUntil = elapsed + 20;
        // Ordinary candidate failures must not replace the longer exclusion
        // for the wall that already sent this outing back to its start.
        r.wallFailedX = e.goalX; r.wallFailedZ = e.goalZ; r.wallFailedUntil = elapsed + 60;
      }
      r.failedX = e.goalX; r.failedZ = e.goalZ; r.failedUntil = elapsed + 60;
      r.count = r.index = 0; r.wall = r.propDeparture = r.detour = false; r.blocked = r.progressTime = 0; r.obstacle = null;
      setGoal(e, p.x, p.y, p.z); e.rest = 0; e.speed = 0;
      r.nextChoice = elapsed + 0.2;
    };
    // A blocked meadow stroll retains a short, proven route around scenery.
    // Open travel and roof climbing still use the direct mover below.
    const moveRoamPlanned = (e, dt) => {
      const p = e.root.position, r = e.roam;
      const point = r.index * 3;
      const tx = r.index < r.count ? r.path[point] : e.goalX;
      const tz = r.index < r.count ? r.path[point + 2] : e.goalZ;
      const distanceToPoint = Math.hypot(tx - p.x, tz - p.z);
      const desired = r.index === 0 && r.reverseStart ? r.departHeading : Math.atan2(tx - p.x, tz - p.z);
      const turnError = Math.abs(Math.atan2(Math.sin(desired - e.heading), Math.cos(desired - e.heading)));
      r.progressTime += dt;
      if (e.backoutLeft > 0 && (!Number.isFinite(r.backoutX) || Math.hypot(p.x - r.backoutX, p.z - r.backoutZ) > 0.1)) {
        // A committed, fixed-heading canopy withdrawal deliberately moves
        // away from the destination. Credit its real clearance, not its pose.
        r.backoutX = p.x; r.backoutZ = p.z; r.progressTime = 0;
      }
      const peer = r.waitPeer;
      if (peer && peer.active && elapsed < r.waitUntil + 0.25 && peer.roam.progressTime < 0.6
        && Math.hypot(peer.root.position.x - r.waitX, peer.root.position.z - r.waitZ) > 0.1) {
        // Credit the known crossing actor before testing our own deadline.
        // A brief gap between conflict samples must not erase its progress.
        r.waitX = peer.root.position.x; r.waitZ = peer.root.position.z; r.progressTime = r.blocked = 0;
      }
      // Motion in a circle is not progress. Track improvement toward the
      // retained waypoint (or its planted turn), independently of replanning.
      if (r.progressX !== tx || r.progressZ !== tz) {
        r.progressX = tx; r.progressZ = tz; r.progressDistance = distanceToPoint; r.progressTurn = turnError;
      } else if (distanceToPoint < r.progressDistance - 0.1 || turnError < r.progressTurn - 0.05) {
        r.progressDistance = distanceToPoint; r.progressTurn = turnError; r.progressTime = 0;
      }
      if (e.climb.searchCursor > r.progressCursor || e.climb.claimProgressAt > r.progressClaim) r.progressTime = 0;
      r.progressCursor = e.climb.searchCursor; r.progressClaim = e.climb.claimProgressAt;
      if (r.progressTime > 2 && !e.climb.active) {
        e.climb.searchPending = e.climb.claimPending = e.climb.crestPending = false;
        abandonRoam(e); return;
      }
      // A tall prop has a separate supported-departure/fall controller. Small
      // treads stay on the retained route; switching controllers at every
      // half-metre prop edge reverses their steps and produces vertical jitter.
      const terrainY = ctx.terrainSupportAt ? ctx.terrainSupportAt(e, p.x, p.z, p.y, STEP) : groundAt(p.x, p.z, p.y);
      if (!r.propDeparture && (!r.count || r.wall) && p.y - terrainY > STEP && raisedSupport(e)) {
        // Commit to the supported exit until all of the footprint reaches
        // terrain. Switching back at STEP can replay a reverse waypoint and
        // send the body up the prop on the very next frame.
        r.propDeparture = true; r.count = r.index = 0; r.wall = false;
        r.progressTime = 0; r.progressX = r.progressZ = NaN;
      }
      if (r.propDeparture) {
        if (raisedSupport(e)) { move(e, dt, CHILL_SPEED); return; }
        r.propDeparture = false;
      }
      if ((!r.count || r.wall) && Math.abs(e.goalY - p.y) >= 1 && caveAt(p.x, p.y, p.z) < 0) {
        const searched = e.climb.retry <= 0;
        if (tryClimb(e, Math.atan2(e.goalX - p.x, e.goalZ - p.z), e.goalY < p.y) || holdClimbSearch(e)) { e.speed = 0; return; }
        // At the retained wall approach a completed search has already
        // rejected every grip/landing. Waiting and repeating that identical
        // search cannot open a route; release this outing immediately. A
        // deferred search or a moving claimant still keeps its normal wait.
        if (searched && r.wall && (r.index >= r.count || r.index + 1 === r.count && distanceToPoint < 0.025)) { abandonRoam(e); return; }
      }
      if (e.climb.claimPending) {
        tryClimb(e, Math.atan2(e.goalX - p.x, e.goalZ - p.z), e.goalY < p.y);
        holdClimbSearch(e); e.speed = 0; return;
      }
      if (e.backoutLeft > 0 && backOut(e, dt)) return;
      if (r.targetX !== e.goalX || r.targetY !== e.goalY || r.targetZ !== e.goalZ
        || !r.count || r.wall && Math.abs(p.y - r.level) > 0.55) {
        e.speed = 0;
        if (!roamBudget) return;
        if (!planRoam(e, e.goalX, e.goalY, e.goalZ)) {
          abandonRoam(e); return;
        }
      }
      if (r.index >= r.count) {
        e.speed = 0;
        if (!r.wall) return;
        const searched = e.climb.retry <= 0;
        if (tryClimb(e, Math.atan2(e.goalX - p.x, e.goalZ - p.z), e.goalY < p.y) || holdClimbSearch(e)) return;
        if (searched) abandonRoam(e);
        return;
      }
      const at = r.index * 3, dx = r.path[at] - p.x, dz = r.path[at + 2] - p.z, distance = Math.hypot(dx, dz);
      if (distance < 0.025) { r.index++; r.blocked = 0; e.speed = 0; return; }
      const facing = r.index === 0 && r.reverseStart ? r.departHeading : Math.atan2(dx, dz);
      const turn = Math.atan2(Math.sin(facing - e.heading), Math.cos(facing - e.heading));
      const heading = e.heading + clamp(turn, -dt * 3, dt * 3);
      // Rotate on supported feet, then travel forwards. A small corner blend
      // is enough; moving backwards across a clearing is never an idle route.
      const step = Math.abs(turn) > 0.15 ? 0 : Math.min(distance, CHILL_SPEED * dt);
      const x = p.x + dx / distance * step, z = p.z + dz / distance * step;
      // The route proves a planted turn followed by a supported step. A foot
      // leaving a prop during that turn must not also drop the whole body;
      // settling onto the next support belongs to the translation proof.
      const y = step > 0 ? support(e, x, z, p.y, PROP_STEP, heading) : p.y;
      let waitFor = null;
      for (let i = 0; i < list.length; i++) {
        const other = list[i];
        if (other === e || !other.active || other.controlled || other.phase !== "chill" || other.lounge
          || other.roam.index >= other.roam.count || other.roam.order >= r.order) continue;
        for (let t = 0.3; t <= 1.8; t += 0.3) {
          roamFuture(e, t, roamPoint);
          const px = roamPoint.x, py = roamPoint.y, pz = roamPoint.z;
          roamFuture(other, t, roamPoint);
          if (Math.abs(py - roamPoint.y) < 1.2
            && (px - roamPoint.x) ** 2 + (pz - roamPoint.z) ** 2 < 0.04) {
            waitFor = other; break;
          }
        }
        if (waitFor) break;
      }
      if (waitFor) {
        e.speed = 0; r.waitUntil = elapsed + 0.2; r.blocked += dt;
        const q = waitFor.root.position;
        if (r.waitPeer !== waitFor) {
          r.waitPeer = waitFor; r.waitX = q.x; r.waitZ = q.z;
        }
        if (r.blocked > 0.6 && roamBudget && elapsed >= r.planAt) {
          r.obstacle = waitFor; r.planAt = elapsed + 0.6;
          if (!planRoam(e, e.goalX, e.goalY, e.goalZ) && r.blocked > 2) abandonRoam(e);
        }
        return;
      }
      // Match roamFuture's reserved pause instead of inching into the other
      // actor's corridor whenever a single prediction sample becomes clear.
      if (elapsed < r.waitUntil) { e.speed = 0; return; }
      if (step > 0 && roofEdgeCrossing(e, x, z, facing)) {
        if (beginEdgeClimb(e, facing) || beginSupportFall(e, x, z, facing,
          Math.sin(facing) * CHILL_SPEED, Math.cos(facing) * CHILL_SPEED)) return;
        if (y < p.y - STEP) {
          e.speed = 0; r.blocked += dt;
          if (r.blocked > 1.5) abandonRoam(e);
          return;
        }
      }
      if (step > 0 && y < p.y - PROP_STEP && raisedSupport(e) && actorLanding(e, x, y, z)
        && !occupied(e, x, y, z, true, heading) && propStepClear(e, p.x, p.y, p.z, x, y, z, e.heading, heading)
        && beginSupportFall(e, x, z, heading, 0, 0)) return;
      if (step > 0 && y < p.y - PROP_STEP && beginSupportFall(e, x, z, heading,
        Math.sin(facing) * CHILL_SPEED, Math.cos(facing) * CHILL_SPEED)) return;
      if (Number.isFinite(y) && Math.abs(y - p.y) <= PROP_STEP && actorLanding(e, x, y, z)
        && !occupied(e, x, y, z, true, heading) && propStepClear(e, p.x, p.y, p.z, x, y, z, e.heading, heading)) {
        setSupportY(e, y, x, z, heading, dt * 3); p.x = x; p.z = z; e.heading = heading;
        e.speed = step / dt * (r.index === 0 && r.reverseStart ? -1 : 1); r.blocked = 0;
      } else {
        e.speed = 0; r.blocked += dt;
        if (r.blocked > 0.5 && roamBudget && elapsed >= r.planAt) {
          r.obstacle = null;
          for (let i = 0; i < list.length; i++) {
            const other = list[i];
            if (other === e || !other.active || !other.root.visible) continue;
            const q = other.root.position, distance2 = (x - q.x) ** 2 + (z - q.z) ** 2;
            if (Math.abs(y - q.y) < 1.2 && distance2 < 0.04
              && distance2 < (p.x - q.x) ** 2 + (p.z - q.z) ** 2 - 1e-6) { r.obstacle = other; break; }
          }
          r.planAt = elapsed + 0.6;
          if (!planRoam(e, e.goalX, e.goalY, e.goalZ)) abandonRoam(e);
        }
      }
    };
    const runDownhill = (e, dt, heading) => {
      const p = e.root.position, sx = Math.sin(heading), sz = Math.cos(heading);
      // A running ledge hop can stop against a stepped cliff before it finds
      // open air. Hand a blocked approach to the ordinary steered walker so
      // it can search for a supported descent instead of holding this pose.
      if (e.blocked > 0.45 || e.climb.searchPending) { move(e, dt, SPEED); return; }
      if (ctx.fireClear) {
        // The roof-height step cannot see a fire below. Check the whole
        // descent before borrowing the player's running ledge hop, including
        // momentum that can carry the landing beyond the work-cave approach.
        const fallTime = (LEDGE_RISE + Math.sqrt(LEDGE_RISE * LEDGE_RISE
          + 2 * GRAVITY * Math.max(0, p.y - e.goalY))) / GRAVITY;
        const reach = Math.max(Math.hypot(e.goalX - p.x, e.goalZ - p.z), SPEED * 2 * fallTime);
        if (!ctx.fireClear(e, p.x, p.y, p.z, p.x + sx * reach, e.goalY, p.z + sz * reach, e.heading, heading)) {
          // Keep the normal supported approach and edge-climb fallback.
          move(e, dt, SPEED);
          return;
        }
      }
      const d = e.drive, c = e.climb, departurePlanning = c.departurePlanning;
      c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
      if (climbTurn === e.index) climbTurn = -1;
      d.x = sx; d.z = sz; d.heading = heading; d.run = true;
      c.departurePlanning = true;
      updateDriven(e, dt);
      c.departurePlanning = departurePlanning;
      d.x = d.z = 0; d.run = false;
    };
    const moveRoam = (e, dt) => {
      const p = e.root.position, r = e.roam;
      if (r.targetX !== e.goalX || r.targetY !== e.goalY || r.targetZ !== e.goalZ) {
        r.targetX = e.goalX; r.targetY = e.goalY; r.targetZ = e.goalZ;
        r.progressDistance = Infinity; r.progressTime = 0; r.detour = false;
      }
      const roofTrip = !e.debugMove.active && e.mode === "chilling" && e.loungeRoof
        && e.goalY > p.y + 0.8 && caveAt(p.x, p.y, p.z) < 0;
      const heading = Math.atan2(e.goalX - p.x, e.goalZ - p.z);
      const roofWall = roofTrip && cliffRiserAhead(p.x, p.z, heading, 1);
      const currentRoof = !e.debugMove.active && e.mode === "chilling" && e.loungeRoof ? roofAt(p.x, p.y, p.z) : -1;
      const destinationRoof = currentRoof >= 0 ? roofAt(e.goalX, e.goalY, e.goalZ) : -1;
      const roofHop = destinationRoof >= 0 && destinationRoof !== currentRoof;
      const sx = Math.sin(heading), sz = Math.cos(heading);
      const roofGap = roofHop && (ctx.surfaceAt(p.x + sx * 1.5, p.z + sz * 1.5) < p.y - 0.55
        || ctx.surfaceAt(p.x + sx * 3, p.z + sz * 3) < p.y - 0.55
        || ctx.surfaceAt(p.x + sx * 4.5, p.z + sz * 4.5) < p.y - 0.55);
      r.jumpRetry = Math.max(0, r.jumpRetry - dt);
      if (!e.debugMove.active && r.detour) { moveRoamPlanned(e, dt); return; }
      if (roofGap && r.runUp >= ROOF_RUN_UP && !r.jumpRetry && !e.fire.burning) {
        r.jumpRetry = 0.4;
        if (tryRoofHop(e, heading, destinationRoof)) return;
      }
      // Approach the base before choosing a jump. A supported wall mount
      // takes priority; jumping remains available above an inaccessible mouth.
      if ((!roofTrip || roofWall && wallRectangleShare(e, p.x, p.y, p.z, heading) >= WALL_ENTER_SHARE)
        && Math.abs(e.goalY - p.y) >= 1 && caveAt(p.x, p.y, p.z) < 0) {
        if (tryClimb(e, heading, e.goalY < p.y) || holdClimbSearch(e)) { e.speed = 0; return; }
      }
      if (roofWall && r.runUp >= ROOF_RUN_UP && !r.jumpRetry && !e.fire.burning) {
        r.jumpRetry = 0.4;
        if (tryRoofJump(e, heading)) return;
      }
      const beforeX = p.x, beforeZ = p.z, beforeY = p.y;
      move(e, dt, roofTrip || roofHop ? SPEED : CHILL_SPEED);
      const travelled = Math.hypot(p.x - beforeX, p.z - beforeZ);
      r.runUp = (roofTrip || roofHop) && !e.climb.active && travelled >= SPEED * dt * 0.5
        && Math.abs(p.y - beforeY) <= STEP
        && (p.x - beforeX) * Math.sin(e.heading) + (p.z - beforeZ) * Math.cos(e.heading) > travelled * 0.85
        ? Math.min(ROOF_RUN_UP, r.runUp + travelled) : 0;
      if (e.debugMove.active) return;
      const distance = Math.hypot(e.goalX - p.x, e.goalZ - p.z) + Math.abs(e.goalY - p.y) * 0.5;
      if (distance < r.progressDistance - 0.15) { r.progressDistance = distance; r.progressTime = 0; }
      else if (!e.climb.searchPending && !e.climb.claimPending && !e.climb.active) r.progressTime += dt;
      // Small steering arcs cannot find every route between trees and reserved
      // cave aprons. Spend the existing shared route budget only after stalled
      // progress, and keep climbs/jumps on their existing controllers.
      if (r.progressTime > 0.8 && Math.abs(e.goalY - p.y) < 0.55
        && !e.climb.active && !e.jump.active && !e.drive.airborne && roamBudget && elapsed >= r.planAt) {
        r.planAt = elapsed + 0.6;
        if (planRoam(e, e.goalX, e.goalY, e.goalZ, NaN, "", true)) {
          r.detour = true; r.progressTime = 0; r.progressX = r.progressZ = NaN;
          r.progressDistance = r.progressTurn = Infinity; r.waitPeer = null; r.runUp = 0;
          return;
        }
      }
      if (r.progressTime > 4) {
        abandonRoam(e);
      }
    };
    const updateDebugMove = (e, dt) => {
      const d = e.debugMove, p = e.root.position, g = d.goal;
      if (e.jump.active) { updateJump(e, dt); return; }
      if (d.status === "arrived" || d.status === "blocked") { e.speed = 0; return; }
      e.biped = e.motion.lab && !e.motion.labRunIn;
      e.footprintMode = e.lounge === "sit" ? "sit" : "walk";
      e.compact = e.lounge === "sit" ? e.gorilla.sitCompact : e.gorilla.compact;
      e.radius = Math.max(WALK_RADIUS, e.gorilla.bodyRadius + 0.1);
      e.height = Math.max(WALK_HEIGHT, e.gorilla.bodyHeight + 0.04);
      labEnvelope(e);
      if (e.loungeDepart) { departLounge(e, dt); return; }
      if (e.recover > 0) { e.recover = Math.max(0, e.recover - dt); e.speed = 0; return; }
      // Room exits already own the doorway/aisle reservation and its low
      // ceiling transition. Keep that route until the body clears the mouth.
      if (e.route === "exit" && e.fromSite >= 0) {
        const site = sites[e.fromSite], m = site.mouth;
        const along = (p.x - m.x) * site.sr + (p.z - m.z) * site.cr;
        if (along < 0.5 + e.radius && p.y < m.floorY + 2.7) {
          d.status = "walking";
          if (travelGoal(e, dt)) {
            if (e.motion.lab && !e.motion.labRunIn) moveLab(e, dt);
            else move(e, dt, SPEED);
          } else e.speed = 0;
          if (e.blocked > 3) { d.status = "blocked"; d.reason = "Cave exit blocked"; }
          return;
        }
        releasePortal(e); e.route = ""; e.phase = "chill"; resetDebugRoute(e);
      }
      // A failed approach owns its safe withdrawal before another candidate
      // gets planned from the new footing.
      if (e.backoutLeft > 0) {
        const moved = backOut(e, dt);
        d.originX = p.x; d.originY = p.y; d.originZ = p.z;
        if (moved) return;
      }
      // A face below a nearby rim is an intentional descent. The complete
      // wall route is still checked before the first foot leaves its support.
      const atGoal = d.normalized && Math.hypot(g.x - p.x, g.z - p.z) < 0.18 && Math.abs(g.y - p.y) < 0.55;
      if (d.wallTarget && (!d.normalized || atGoal) && d.target.y < p.y - 0.8
        && Math.hypot(d.target.x - p.x, d.target.z - p.z) < 7) {
        setGoal(e, d.target.x, d.target.y, d.target.z);
        const searched = e.climb.retry <= 0;
        if (tryClimb(e, Math.atan2(d.target.x - p.x, d.target.z - p.z), true) || holdClimbSearch(e)) return;
        if (atGoal) {
          if (searched) { d.status = "blocked"; d.reason = "No clear descent to this point"; }
          e.speed = 0; return;
        }
      }
      if (!d.normalized) {
        if (!debugRouteBudget) return;
        debugRouteBudget--;
        normalizeDebugGoal(e); return;
      }
      if (atGoal && d.wallTarget) {
        const searched = e.climb.retry <= 0, descending = d.target.y < p.y;
        setGoal(e, d.target.x, d.target.y, d.target.z);
        if (tryClimb(e, Math.atan2(d.target.x - p.x, d.target.z - p.z), descending) || holdClimbSearch(e)) return;
        if (searched) { d.status = "blocked"; d.reason = "No connected wall approach from this footing"; }
        e.speed = 0; return;
      }
      if (atGoal) {
        const turn = Number.isFinite(g.heading) ? Math.atan2(Math.sin(g.heading - e.heading), Math.cos(g.heading - e.heading)) : 0;
        if (Math.abs(turn) > 0.005) {
          const heading = e.heading + clamp(turn, -3 * dt, 3 * dt);
          e.speed = 0;
          if (!occupied(e, p.x, p.y, p.z, true, heading)
            && propStepClear(e, p.x, p.y, p.z, p.x, p.y, p.z, e.heading, heading)) { e.heading = heading; e.blocked = 0; }
          else if ((e.blocked += dt) > 2) { d.normalized = false; d.normalizeAt = 0; d.normalizeScore = Infinity; }
          return;
        }
        d.status = "arrived"; d.reason = ""; e.speed = 0;
        e.roam.count = e.roam.index = 0; return;
      }
      if (e.motion.lab && insideLab(g.x, g.y, g.z)) {
        d.status = "walking";
        if (labGoal(e, g.x, g.y, g.z, Math.atan2(g.x - p.x, g.z - p.z), true)) moveLab(e, dt);
        else { e.speed = 0; requestLabPass(e, g.x, g.z); }
        if (e.blocked > 3) { d.status = "blocked"; d.reason = "Laboratory route blocked"; }
        return;
      }
      setGoal(e, g.x, g.y, g.z);
      d.status = "walking";
      moveRoam(e, dt);
      if (e.climb.active) d.status = "climbing";
      const distance = Math.hypot(g.x - p.x, g.z - p.z) + Math.abs(g.y - p.y) * 0.5;
      if (distance < d.progressDistance - 0.15) { d.progressDistance = distance; d.progressTime = 0; }
      else if (!e.climb.searchPending && !e.climb.claimPending && !e.climb.active) d.progressTime += dt;
      if (d.progressTime > 4) { d.status = "blocked"; d.reason = "Direct approach blocked"; e.speed = 0; }
    };
    const support = (e, x, z, y, step, heading = e.heading) => ctx.supportAt ? ctx.supportAt(e, x, z, y, step, heading) : groundAt(x, z, y);
    const setSupportY = (e, y, x = e.root.position.x, z = e.root.position.z, heading = e.heading, rise = Infinity) => {
      const p = e.root.position;
      // Let the planted limbs fit a short terrain riser while the trunk
      // settles onto it over successive frames instead of snapping upward.
      if ((!e.loungeRoof || e.debugMove.active) && y > p.y && y - p.y <= STEP && !raisedSupport(e)
        && Math.abs(y - groundAt(x, z, y)) < 0.02) y = Math.min(y, p.y + rise);
      const delta = p.y - y;
      if (Math.abs(delta) > 1e-7) {
        const terrain = ctx.terrainSupportAt;
        const fromFloor = terrain ? terrain(e, p.x, p.z, p.y, PROP_STEP, e.heading) : groundAt(p.x, p.z, p.y);
        const toFloor = terrain ? terrain(e, x, z, y, PROP_STEP, heading) : groundAt(x, z, y);
        // Ease only a move onto or off short scenery. On cave roofs this
        // offset would draw the body inside otherwise correctly supported
        // stone after every small upward terrain step.
        e.motion.supportOffset = p.y > fromFloor + 0.02 || y > toFloor + 0.02
          ? clamp(e.motion.supportOffset + delta, -PROP_STEP, PROP_STEP) : 0;
      }
      p.y = y;
    };
    const raisedSupport = (e) => {
      if (!ctx.supportAt) return false;
      const p = e.root.position;
      // Compare like footprints: a riser under a knuckle is still terrain,
      // even when the root's point sample belongs to the lower tread.
      const terrain = ctx.terrainSupportAt ? ctx.terrainSupportAt(e, p.x, p.z, p.y, STEP) : groundAt(p.x, p.z, p.y);
      return p.y - terrain > 0.02;
    };
    const choosePropExit = (e) => {
      if (!raisedSupport(e)) return false;
      const p = e.root.position;
      const goalDX = e.goalX - p.x, goalDZ = e.goalZ - p.z;
      const preferred = Math.hypot(goalDX, goalDZ) > 0.5 ? Math.atan2(goalDX, goalDZ) : e.heading;
      const compact = e.compact, mode = e.footprintMode, radius = e.radius, height = e.height;
      e.compact = e.planningRoam = true; e.footprintMode = "walk"; e.radius = WALK_RADIUS; e.height = WALK_HEIGHT;
      for (let ring = 0; ring < 3; ring++) for (let turn = 0; turn < 16; turn++) {
        const side = turn ? Math.ceil(turn / 2) * (turn % 2 ? 1 : -1) : 0;
        const heading = preferred + side * Math.PI / 8, distance = 2.8 + ring * 0.8;
        const x = p.x + Math.sin(heading) * distance, z = p.z + Math.cos(heading) * distance;
        const y = ctx.terrainSupportAt
          ? ctx.terrainSupportAt(e, x, z, p.y, PROP_STEP, heading) : groundAt(x, z, p.y);
        const facing = Math.cos(heading - e.heading) < -0.25 ? e.heading : heading;
        if (!Number.isFinite(y) || p.y - y <= 0.02 || p.y - y > PROP_STEP || !landing(x, y, z)
          || occupied(e, x, y, z, true, facing)
          || !roamLeg(e, p.x, p.y, p.z, x, y, z, e.heading, false, roamPoint, facing)) continue;
        e.compact = compact; e.footprintMode = mode; e.radius = radius; e.height = height; e.planningRoam = false;
        e.roam.count = e.roam.index = 0; e.roam.wall = false; e.roam.alignTime = 0;
        e.roam.targetX = e.roam.targetY = e.roam.targetZ = NaN;
        e.lounge = ""; e.loungePartner = null; e.rest = 0; e.exitFootprint = true;
        setGoal(e, x, y, z);
        return true;
      }
      e.compact = compact; e.footprintMode = mode; e.radius = radius; e.height = height; e.planningRoam = false;
      return false;
    };
    const entryFor = (value) => value === undefined ? player : typeof value === "number" ? list[value]
      : value && value.gorilla ? value : byOwner.get(value);
    const resumeEntry = (e) => {
      e.drive.resume = false; e.hasSlot = false;
      if (e.debugMove.active) { e.phase = e.route === "exit" ? "leave" : "chill"; resetDebugRoute(e); return; }
      e.roam.departPending = false;
      e.backoutLeft = 0;
      e.drive.climbExitHeading = e.drive.climbExitLook = NaN; e.drive.climbTurnTimer = 0;
      if (!alive(e.owner)) return;
      e.mode = e.owner.state;
      if (e.rage.active) { e.phase = "rage"; e.route = ""; e.speed = 0; return; }
      if (e.mode === "working") {
        const next = e.pendingSite >= 0 ? e.pendingSite : e.owner.work.plannedSite >= 0 ? e.owner.work.plannedSite : e.owner.work.site;
        e.pendingSite = -1;
        if (sites[next]) beginTravel(e, next);
      } else {
        e.fromSite = caveAt(e.root.position.x, e.root.position.y, e.root.position.z);
        if (e.fromSite >= 0) { e.phase = "leave"; e.route = "exit"; }
        else { e.phase = "chill"; e.route = ""; chooseChill(e, true); }
      }
    };
    const cancelInput = () => {
      if (!player) return;
      const d = player.drive;
      d.x = d.z = d.climbAxis = d.climbSide = 0; d.heading = NaN;
      d.avoidSide = d.avoidTime = 0;
      d.climbExitHeading = d.climbExitLook = NaN; d.climbTurnTimer = 0;
      d.jumpHeld = d.jumpDown = d.jumpPressed = d.run = false; d.jumpBuffer = 0; d.cancelled = true;
      player.climb.searchPending = player.climb.searchDeferred = player.climb.claimPending = player.climb.crestPending = false;
      player.climb.claimFor = -1; player.climb.claimOwnerOrder = player.climb.claimOrder = 0;
    };
    const release = () => {
      if (!player) return false;
      const e = player;
      cancelInput(); player = null; e.controlled = false;
      e.drive.resume = true;
      if (!e.drive.airborne && !e.fire.rolling && !e.climb.active) resumeEntry(e);
      return true;
    };
    const respawn = (e, x = 0, y = 0, z = 0) => {
      if (rage) rage.cancel(e, "respawn");
      if (ctx.rageRelease) ctx.rageRelease(e);
      releasePortal(e);
      e.drive.passiveFall = false;
      e.motion.climbBlend = NaN; e.motion.openingSettle = e.motion.poundCharge = 0;
      e.motion.climbGripX = e.motion.climbGripY = e.motion.climbGripZ = NaN;
      e.climb.holdPose = e.climb.mountPending = e.climb.waitRelease = false;
      if (e.controlled) {
        cancelInput();
        e.root.position.x = x; e.root.position.y = y; e.root.position.z = z;
      }
      activate(e, e.controlled);
    };
    const possess = (value) => {
      const e = entryFor(value);
      if (!e || !e.active || !e.root.visible) return false;
      if (player === e) return true;
      if (rage) rage.cancel(e, "possession");
      if (ctx.rageRelease) ctx.rageRelease(e);
      release(); player = e; e.controlled = true; e.drive.resume = false;
      // A hand on a sleeper wakes it. Its bed stays its own while its Ooga sleeps on.
      if (e.sleep.stage) { e.sleep.stage = ""; e.gorilla.chest.scale.y = 1; e.exitFootprint = false; }
      e.fire.panic.active = false;
      cancelDebugMove(e);
      e.climb.debugStuck = false;
      e.roam.departPending = false;
      releaseLab(e);
      releasePortal(e); e.hasSlot = false; e.pendingSite = -1;
      const d = e.drive, p = e.root.position;
      d.x = d.z = 0; d.heading = e.heading; d.run = d.jumpHeld = d.jumpDown = d.jumpPressed = d.cancelled = false; d.jumpBuffer = 0;
      d.avoidSide = d.avoidTime = 0;
      d.vx = d.vy = d.vz = 0; d.airborne = e.jump.active;
      if (e.jump.active) {
        const j = e.jump, direction = j.reverse ? -1 : 1;
        d.vx = (j.toX - j.fromX) / j.duration * direction;
        d.vz = (j.toZ - j.fromZ) / j.duration * direction;
        d.vy = ((j.toY - j.fromY) + j.lift * 4 * (1 - j.progress * 2)) / j.duration * direction;
        e.jump.active = false;
      }
      d.grounded = !d.airborne && Math.abs(support(e, p.x, p.z, p.y, STEP) - p.y) < 0.08;
      if (!d.grounded && !e.climb.active) d.airborne = true;
      d.jumps = d.grounded ? 0 : Math.max(1, d.jumps);
      if (e.lounge) { e.lounge = ""; e.recover = 0.65; }
      e.phase = "controlled"; e.route = ""; e.exitFootprint = true;
      return true;
    };
    const control = (input) => {
      if (!player || !input) return false;
      const d = player.drive;
      d.x = Number.isFinite(input.x) ? clamp(input.x, -1, 1) : 0;
      d.z = Number.isFinite(input.z) ? clamp(input.z, -1, 1) : 0;
      d.heading = Number.isFinite(input.heading) ? input.heading : NaN;
      d.run = !!input.run; d.jumpHeld = !!input.jumpHeld;
      d.climbAxis = Number.isFinite(input.climbAxis) ? clamp(input.climbAxis, -1, 1) : 0;
      d.climbSide = Number.isFinite(input.climbSide) ? clamp(input.climbSide, -1, 1) : 0;
      if (input.jumpPressed) { d.cancelled = false; d.jumpPressed = true; }
      return true;
    };
    const fullEnvelope = (e, radius, height) => {
      const r = e.radius, h = e.height, compact = e.compact, p = e.root.position;
      e.radius = Math.max(radius, r); e.height = Math.max(height, h); e.compact = false;
      if (!occupied(e, p.x, p.y, p.z) && staticClear(e, p.x, p.y, p.z)) return true;
      e.radius = r; e.height = h; e.compact = compact; return false;
    };
    const beginSupportFall = (e, x, z, heading, vx, vz, runningEdge = e.controlled && e.drive.run) => {
      const p = e.root.position, floor = ctx.terrainSupportAt
        ? ctx.terrainSupportAt(e, x, z, p.y, PROP_STEP, heading) : groundAt(x, z, p.y);
      const currentFloor = ctx.terrainSupportAt
        ? ctx.terrainSupportAt(e, p.x, p.z, p.y, PROP_STEP, e.heading) : groundAt(p.x, p.z, p.y);
      const d = e.drive, speed = Math.hypot(vx, vz);
      const backing = e.controlled && speed > 0.2 && (vx * Math.sin(e.heading) + vz * Math.cos(e.heading)) / speed < -0.25;
      const edgeLeap = runningEdge && !backing && p.y - currentFloor <= STEP;
      // Do not enter flight while a walking pad still has roof support.
      const terrainEdge = p.y - currentFloor <= STEP && floor < p.y - STEP
        && pointSupportAt(x, z, p.y + 0.1, e) < p.y - STEP;
      const landingFloor = terrainEdge ? pointSupportAt(x, z, p.y + 0.1, e) : floor;
      const backwardStepOff = backing && floor < p.y - STEP
        && (p.y - currentFloor <= STEP || Math.abs(support(e, p.x, p.z, p.y, STEP) - p.y) <= 0.2);
      // A run over terrain gets the Ooga's short ledge hop. Walking off a
      // raised prop or backing off a cliff hands the step to ordinary gravity.
      if (e.parked || e.climb.active || !terrainEdge && (!Number.isFinite(landingFloor)
        || !edgeLeap && !backwardStepOff && (!landing(x, landingFloor, z) || p.y - currentFloor <= STEP))) return false;
      // The walking fallback must not turn a rejected fire-bound leap into
      // a slower fall onto the same pit. Forced falls in place remain free.
      if (!e.controlled && speed > 0 && ctx.fireClear && Number.isFinite(landingFloor)) {
        const rise = edgeLeap ? LEDGE_RISE : 0;
        const fallTime = (rise + Math.sqrt(rise * rise
          + 2 * GRAVITY * Math.max(0, p.y - landingFloor))) / GRAVITY;
        if (!ctx.fireClear(e, p.x, p.y, p.z, x + vx * fallTime, landingFloor, z + vz * fallTime,
          e.heading, heading)) return false;
      }
      // A running gorilla leaves the rim under its own momentum. Check the
      // airborne centre path before committing, including beyond the island.
      if (edgeLeap) d.airborne = true;
      const departurePlanning = e.climb.departurePlanning;
      if (edgeLeap) e.climb.departurePlanning = true;
      const clear = !occupied(e, x, p.y, z, true, heading)
        && staticClear(e, p.x, p.y, p.z, x, p.y, z, e.heading, heading);
      e.climb.departurePlanning = departurePlanning;
      if (edgeLeap) d.airborne = false;
      if (!clear) return false;
      p.x = x; p.z = z; e.heading = heading;
      d.vx = vx; d.vz = vz; d.vy = edgeLeap ? LEDGE_RISE : 0;
      d.airborne = true; d.passiveFall = !edgeLeap; d.grounded = false; d.motionEnvelope = edgeLeap;
      // A prop fall keeps the four-footed step pose. The rim leap uses the
      // existing airborne pose and leaves one midair jump available.
      d.motionRecover = edgeLeap ? 0.6 : 0; d.resume = !e.controlled && !edgeLeap; e.lounge = "";
      e.motion.takeoff = edgeLeap ? 1 : 0;
      if (edgeLeap) { d.jumps = 1; e.climb.airAttachAfter = elapsed + 0.45; }
      e.climb.searchPending = e.climb.searchDeferred = e.climb.claimPending = e.climb.crestPending = false;
      return true;
    };
    const supportRemoved = () => {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e.active || !e.root.visible || e.climb.active || e.jump.active || e.drive.airborne) continue;
        const p = e.root.position, floor = support(e, p.x, p.z, p.y, PROP_STEP);
        if (floor >= p.y - 0.05) continue;
        const d = e.drive;
        // A controlled walker keeps its horizontal pace while the destroyed
        // support falls away; gravity handles the short drop separately.
        if (!e.controlled) d.vx = d.vz = 0;
        d.vy = 0;
        d.airborne = d.passiveFall = true; d.grounded = d.motionEnvelope = false;
        d.motionRecover = 0; d.resume = !e.controlled;
        e.lounge = ""; e.motion.takeoff = 0;
      }
    };
    const ignite = (value) => {
      const e = entryFor(value);
      if (!e || !e.active || !e.root.visible || e.fire.burning || e.fire.rolling || e.fire.cooldown > 0) return false;
      const f = e.fire;
      f.burning = true; f.requested = f.escaping = false; f.retry = f.escapeRetry = 0; f.age = 0; f.heat = 0.05; f.reaction = 1 + e.random() * 2;
      f.panic.active = false; fireThreatsActive = true;
      e.drive.jumpPressed = false;
      if (e.lounge) { e.lounge = ""; e.recover = 0.65; }
      return true;
    };
    const dropRoll = (value) => {
      const e = entryFor(value);
      if (!e || !e.fire.burning) return false;
      if (e.fire.rolling) return true;
      e.fire.requested = true;
      if (e.drive.airborne || e.jump.active || e.climb.active) return false;
      const radius = MOTION_RADIUS, height = MOTION_HEIGHT;
      if (!fullEnvelope(e, radius, height)) return false;
      const f = e.fire, p = e.root.position;
      f.rolling = true; f.requested = f.escaping = false; f.rollTime = 0; f.x = p.x; f.z = p.z; f.heading = e.heading;
      e.pound = e.beat = e.stand = e.recover = e.speed = 0; e.actionControlled = e.motion.smash = false; e.lounge = ""; e.parked = false;
      e.drive.vx = e.drive.vy = e.drive.vz = 0;
      e.drive.jumpPressed = false; e.drive.motionEnvelope = true;
      e.motion.roll = e.motion.rollAngle = e.motion.rollSide = 0;
      return true;
    };
    const quickSmash = e => e && e.poundHit && (e.pound > 0 || e.recover > 0);
    const smashPower = (charge = 0, combo = quickSmash(player)) => (2.5 + 2.5 * clamp(charge, 0, 1)) * (combo ? 0.25 : 1);
    const smash = (charge = 0, combo = quickSmash(player), power = smashPower(charge, combo)) => {
      const e = player;
      if (!e || e.climb.active || e.fire.rolling || e.parked || e.beat || e.pound > 0 && !e.poundHit) return false;
      if (e.recover > 0 && !combo) return false;
      if (ctx.canSmash ? !ctx.canSmash(e) : !expandGesture(e, 2.25)) return false;
      const duration = e.gorilla.pound(e.drive.airborne, charge, combo);
      if (!duration) return false;
      // Spend the strength sampled on release, including a hold during recharge.
      e.poundPower = power;
      e.footprintMode = "pound"; e.compact = e.gorilla.poundCompact; e.radius = Math.max(e.radius, 2.25);
      e.pound = duration; e.poundHit = false; e.recover = 0; e.smashSerial++; e.actionControlled = e.motion.smash = true;
      return true;
    };
    const chestBeat = () => {
      const e = player;
      if (!e || e.climb.active || e.fire.rolling || e.drive.airborne || e.recover > 0 || e.parked || e.pound || e.beat) return false;
      if (!expandGesture(e, 1.55)) return false;
      const p = e.root.position;
      e.speed = e.drive.vx = e.drive.vz = 0;
      e.gorilla.poseManaged(0, p.x, p.y, p.z, e.heading, 0, false, false, "", e.motion);
      if (!e.gorilla.beat()) return false;
      e.beat = BL.agent.MANAGED_BEAT_TIME; e.beats++;
      return true;
    };
    const beginDrivenJump = (e) => {
      const d = e.drive;
      const jumps = d.grounded && !d.airborne ? 0 : Math.max(1, d.jumps);
      const carrying = e.motion.dragging;
      // The lab's upright aisle cannot fit the outdoor motion envelope.
      const labAir = e.motion.lab && !e.motion.labRunIn;
      if (jumps >= 2 || e.climb.active || !carrying && (e.recover > 0 || e.parked)
        || e.pound || e.beat || e.fire.burning || e.fire.rolling) return false;
      // Check takeoff with the state the next movement step will use. The lab
      // permits a vertical escape from an overlapping crowd only in flight;
      // testing the still-grounded pose can reject that jump before it begins.
      const wasAirborne = d.airborne;
      if (labAir) d.airborne = true;
      const clear = fullEnvelope(e, labAir ? Math.max(BL.agent.LAB_RADIUS, e.gorilla.bodyRadius + 0.1) : MOTION_RADIUS,
        labAir ? Math.max(BL.agent.LAB_HEIGHT, e.gorilla.bodyHeight + 0.04) : MOTION_HEIGHT);
      d.airborne = wasAirborne;
      if (!clear) return false;
      // A held Ooga already has one hand off the floor. A parked stance's
      // rise/recovery must not outlast the fresh jump press.
      if (carrying) {
        e.recover = 0;
        if (e.parked) { e.parked = e.biped = false; e.footprintMode = "pound"; }
      }
      // Each fresh press supplies one impulse, with one additional press in
      // the air. Under the Ooga's gravity sqrt(1.5) gives 50% more height.
      d.vy = PLAYER_JUMP_SPEED; d.jumps = jumps + 1;
      d.wallRelease = false;
      if (e.climb.airAttachAfter === Infinity) e.climb.airAttachAfter = elapsed + 0.2;
      d.grounded = d.passiveFall = false; d.airborne = true; d.motionEnvelope = true; d.motionRecover = 0.6; e.motion.takeoff = 1; e.jumps++;
      return true;
    };
    const beginEdgeClimb = (e, outward) => {
      const p = e.root.position, c = e.climb, d = e.drive;
      if (walkingStairsAt(e, outward)) return false;
      const backing = e.controlled && Math.cos(outward - e.heading) < -0.25;
      if (d.airborne || c.active || !climbSurfaceAt
        || Math.abs(support(e, p.x, p.z, p.y, STEP) - p.y) > 0.2) return false;
      const planning = c.departurePlanning; c.departurePlanning = true;
      try {
        const sx = Math.sin(outward), sz = Math.cos(outward), side = e.root.scale.x * 0.7;
        for (let lane = 0; lane < 3; lane++) {
          const offset = lane === 0 ? 0 : lane === 1 ? -side : side;
          const baseX = p.x + sz * offset, baseZ = p.z - sx * offset;
          if (!backing && (Math.abs(climbSurfaceAt(baseX, baseZ) - p.y) > 0.2
            || !cliffRiserAhead(baseX, baseZ, outward, -1, 3.2))) continue;
          for (let edge = 0.2; edge <= 3.2; edge += 0.2) {
            if (climbSurfaceAt(baseX + sx * edge, baseZ + sz * edge) >= p.y - 0.8) continue;
            const distance = edge + CLIMB_STANDOFF;
            let x = baseX + sx * distance, z = baseZ + sz * distance;
            const y = p.y - (autonomousChill(e) ? 1.8 : 0.7);
            if (!wallPanels.fit(x, y - 1.4, z, outward + Math.PI, PANEL)) continue;
            const heading = PANEL.heading, nx = PANEL.nx, nz = PANEL.nz;
            // Put the mount outside the fitted panel, even at a diagonal edge.
            const correction = (PANEL.x - x) * nx + (PANEL.z - z) * nz - CLIMB_STANDOFF;
            if (Math.abs(correction) > 0.6) continue;
            x += nx * correction; z += nz * correction;
            if (wallContactShare(e, x, y, z, heading) < WALL_ENTER_SHARE || !wallBodyClear(x, y, z, heading)
              || !climbClear(e, p.x, p.y, p.z, x, p.y, z, heading, true, true)
              || !climbClear(e, x, p.y, z, x, y, z, heading, true, true)) continue;
            c.active = c.free = c.mountPending = c.descending = c.fromTop = true;
            c.handoffDirection = 0; c.freeTargetX = x; c.freeTargetY = y; c.freeTargetZ = z;
            c.handoffStartX = p.x; c.handoffStartY = p.y; c.handoffStartZ = p.z;
            c.waitRelease = e.controlled && d.climbAxis > 0;
            c.heading = c.topHeading = heading; c.blocked = 0; c.autoTo = -1; c.climbs++;
            bindWallPanel(e, heading, x, y, z);
            c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
            d.airborne = d.passiveFall = d.grounded = false;
            d.vx = d.vy = d.vz = 0; d.jumps = 0;
            e.heading = heading; e.motion.climb = e.motion.mantle = 0;
            e.lounge = ""; e.speed = 0;
            return true;
          }
        }
        return false;
      } finally { c.departurePlanning = planning; }
    };
    const attachContactWall = (e) => {
      const d = e.drive, c = e.climb, p = e.root.position;
      if ((!e.controlled && !d.airborne) || elapsed < c.airAttachAfter || !climbSolidAt || !climbSurfaceAt) return false;
      const speed = Math.hypot(d.vx, d.vz);
      if (speed < 0.2) return false;
      const travelHeading = Math.atan2(d.vx, d.vz);
      if (ctx.stairAt && ctx.stairAt(p.x, p.y, p.z)
        || !d.airborne && walkingRampAt(p.x, p.y, p.z, travelHeading)
          && !cliffRiserAhead(p.x, p.z, travelHeading, 1)) return false;
      let heading = wallFaceHeading(e, travelHeading), descending = false;
      if (d.airborne && d.vy <= 0 && (!Number.isFinite(heading)
        || wallContactShare(e, p.x, p.y, p.z, heading) < WALL_ENTER_SHARE)) {
        const reverse = wallFaceHeading(e, travelHeading + Math.PI);
        if (Number.isFinite(reverse) && wallContactShare(e, p.x, p.y, p.z, reverse) >= WALL_ENTER_SHARE) {
          heading = reverse; descending = true;
        }
      }
      if (!Number.isFinite(heading)) return false;
      if (!d.airborne && walkingRampAt(p.x, p.y, p.z, heading)
        && !cliffRiserAhead(p.x, p.z, heading, descending ? -1 : 1)) return false;
      const sx = Math.sin(heading), sz = Math.cos(heading);
      // Ground travel along a room wall must keep sliding. Only a terrain
      // riser starts a grounded climb; airborne contact can attach directly.
      if (!descending && (d.vx * sx + d.vz * sz < 0.2
        || !d.airborne && !cliffRiserAhead(p.x, p.z, heading, 1)
        || wallRectangleShare(e, p.x, p.y, p.z, heading) < WALL_ENTER_SHARE)) return false;
      let wall = NaN;
      for (let distance = 0.35; distance <= 1.3; distance += 0.08) {
        if (climbSolidAt(p.x + sx * distance, p.y + (descending ? 0.25 : 0.85), p.z + sz * distance)) { wall = distance; break; }
      }
      if (!Number.isFinite(wall)) return false;
      for (let offset = 0; offset < 3; offset++) {
        // Move only the short distance from airborne contact to a real grip.
        // Trying a little farther out handles projecting voxel edges.
        const correction = wall - CLIMB_STANDOFF - offset * 0.12;
        if (correction < -0.35 || correction > 0.35) continue;
        const x = p.x + sx * correction, z = p.z + sz * correction;
        for (let i = 0; i < 3; i++) {
          const y = p.y + (i === 1 ? -0.12 : i === 2 ? 0.12 : 0);
          if (wallContactShare(e, x, y, z, heading) < WALL_ENTER_SHARE
            || !wallBodyClear(x, y, z, heading)
            || !climbClear(e, p.x, p.y, p.z, x, y, z, heading)) continue;
          p.x = x; p.y = y; p.z = z; e.heading = heading;
          c.active = c.free = true; c.fromTop = descending || !e.controlled; c.descending = descending;
          // A new grip owns its wall rectangle. An interrupted roof mount or
          // window entry must not resume translation toward its old target.
          c.mountPending = c.openingStagePending = c.lipBypass = false;
          c.waitRelease = descending && e.controlled && d.climbAxis > 0;
          c.holdPose = c.debugStuck = false; c.blocked = c.retry = c.handoffDirection = 0;
          c.autoTo = -1; c.airAttachAfter = 0; c.handoffDirection = 0;
          c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = false;
          c.heading = c.topHeading = heading; c.climbs++;
          bindWallPanel(e, heading);
          d.vx = d.vy = d.vz = 0; d.airborne = d.passiveFall = d.grounded = d.motionEnvelope = false;
          d.jumpPressed = false; d.jumpBuffer = 0; d.jumpDown = d.jumpHeld; d.jumps = 0;
          e.motion.climb = e.motion.climbBlend = 1; e.motion.mantle = e.motion.takeoff = 0;
          e.motion.climbSide = e.motion.climbDirection = e.motion.supportOffset = 0;
          e.motion.climbGripX = e.motion.climbGripY = e.motion.climbGripZ = NaN;
          e.motion.climbGripRelease = 0;
          e.compact = false; e.footprintMode = "pound";
          e.radius = Math.max(CLIMB_RADIUS, e.gorilla.bodyRadius + 0.015);
          e.height = Math.max(CLIMB_HEIGHT, e.gorilla.bodyHeight + 0.015);
          e.speed = 0; e.biped = false; e.lounge = "";
          return true;
        }
      }
      return false;
    };
    const updateRoll = (e, dt) => {
      const f = e.fire, p = e.root.position;
      f.rollTime = Math.min(ROLL_ENTRY_SECONDS + ROLL_SECONDS, f.rollTime + dt);
      const progress = clamp(f.rollTime / ROLL_ENTRY_SECONDS, 0, 1), entry = progress * progress * (3 - 2 * progress);
      const angle = entry < 1 ? 0 : Math.sin((f.rollTime - ROLL_ENTRY_SECONDS) * 7), offset = angle * 0.35;
      const x = f.x + Math.cos(f.heading) * offset, z = f.z - Math.sin(f.heading) * offset;
      e.compact = false; e.radius = MOTION_RADIUS; e.height = MOTION_HEIGHT;
      if (!occupied(e, x, p.y, z) && staticClear(e, p.x, p.y, p.z, x, p.y, z)) { p.x = x; p.z = z; }
      e.speed = 0; e.biped = false; e.motion.roll = entry; e.motion.rollSide = entry * Math.PI; e.motion.rollAngle = angle * 1.25;
      if (f.rollTime >= ROLL_ENTRY_SECONDS + ROLL_SECONDS) {
        f.burning = f.rolling = false; f.soot = Math.max(f.soot, f.heat); f.heat = 0;
        f.cooldown = 1.2; f.rollRecover = e.recover = ROLL_RECOVER_SECONDS; e.motion.roll = e.motion.rollAngle = 0;
      }
    };
    const updateFire = (e, dt) => {
      const f = e.fire;
      f.cooldown = Math.max(0, f.cooldown - dt);
      f.rollRecover = Math.max(0, f.rollRecover - dt);
      f.retry = Math.max(0, f.retry - dt); f.escapeRetry = Math.max(0, f.escapeRetry - dt);
      if (f.burning) {
        f.age += dt; f.heat = Math.min(1, 0.05 + f.age / 4);
        if (!e.controlled && !f.rolling && f.age >= f.reaction) f.requested = true;
        if (f.requested && !f.retry && !e.drive.airborne && !e.jump.active && !dropRoll(e)) f.retry = 0.2;
      } else f.soot = Math.max(0, f.soot - dt / SOOT_SECONDS);
      if (f.rolling) updateRoll(e, dt);
      else e.motion.rollSide = f.rollRecover > 0 ? Math.PI * f.rollRecover / ROLL_RECOVER_SECONDS : 0;
      if (ctx.onFire && (f.burning || f.soot > 0 || f.rollRecover > 0)) ctx.onFire(e, dt);
    };
    const senseFireThreat = (e) => {
      const panic = e.fire.panic, p = e.root.position;
      if (e.controlled || e.fire.burning) { panic.active = false; return false; }
      if (!fireThreatsActive && !panic.active) return false;
      const reach = panic.active ? FIRE_FLEE_CLEAR : FIRE_FLEE_REACH;
      let nearest = reach, awayX = 0, awayZ = 0;
      for (let i = 0; fireThreatsActive && i < list.length + crew.list.length; i++) {
        let q, y, burning;
        if (i < list.length) {
          const other = list[i];
          if (other === e || !other.active || !other.root.visible) continue;
          burning = other.fire.burning; q = other.root.position; y = q.y;
        } else {
          const other = crew.list[i - list.length];
          if (!other.root.visible || other.state === "away") continue;
          burning = other.camp.burning; q = other.root.position;
          y = other.camp.rolling ? other.camp.floor : q.y - other.baseY;
        }
        if (!burning || Math.abs(p.y - y) > 2.2) continue;
        const dx = p.x - q.x, dz = p.z - q.z, distance = Math.hypot(dx, dz);
        if (distance >= reach) continue;
        const sightY = Math.max(p.y, y) + 0.8;
        if (ctx.fireReachable && !ctx.fireReachable(p.x, sightY, p.z, q.x, sightY, q.z)) continue;
        if (distance < nearest) {
          nearest = distance; panic.x = q.x; panic.y = y; panic.z = q.z; panic.seenAt = elapsed;
        }
        const weight = (reach - distance) / Math.max(0.25, distance * distance);
        awayX += dx * weight; awayZ += dz * weight;
      }
      if (nearest === reach && (!panic.active || elapsed - panic.seenAt > FIRE_MEMORY
        || Math.hypot(p.x - panic.x, p.z - panic.z) >= FIRE_FLEE_CLEAR)) {
        panic.active = false; return false;
      }
      if (Math.hypot(awayX, awayZ) < 0.001) {
        awayX = p.x - panic.x; awayZ = p.z - panic.z;
        if (Math.hypot(awayX, awayZ) < 0.001) { awayX = Math.sin(e.index * 2.4); awayZ = Math.cos(e.index * 2.4); }
      }
      panic.awayX = awayX; panic.awayZ = awayZ; panic.active = true;
      return true;
    };
    const fleeFire = (e, dt) => {
      if (!senseFireThreat(e)) return false;
      const p = e.root.position, panic = e.fire.panic;
      e.roam.departPending = false;
      if (e.lounge || e.loungeDepart) {
        if (e.lounge) leaveLounge(e);
        departLounge(e, dt); return true;
      }
      if (e.recover > 0) { e.recover = Math.max(0, e.recover - dt); e.speed = 0; return true; }
      e.parked = false; e.pound = e.beat = e.stand = 0;
      e.motion.labWork = ""; e.motion.groom = 0;
      e.biped = false; e.footprintMode = "walk"; e.compact = e.gorilla.compact;
      const heading = Math.atan2(panic.awayX, panic.awayZ), stride = SPEED * 2 * dt;
      for (let i = 0; i < FIRE_STEERING.length; i++) {
        const direction = heading + FIRE_STEERING[i] * e.turn;
        const turn = Math.atan2(Math.sin(direction - e.heading), Math.cos(direction - e.heading));
        const facing = e.heading + clamp(turn, -dt * 7, dt * 7);
        const x = p.x + Math.sin(direction) * stride, z = p.z + Math.cos(direction) * stride;
        if (!drivenGroundStep(e, x, z, facing, STEP)) continue;
        e.speed = stride / dt;
        return true;
      }
      e.turn = -e.turn; e.speed = 0;
      return true;
    };
    const escapeForRoll = (e, dt) => {
      const f = e.fire, p = e.root.position;
      if (!f.requested || f.rolling || e.drive.airborne || e.jump.active || e.pound || e.beat || e.recover
        || e.stand || e.parked || e.gorilla.motionActive || e.gorilla.smashActive) return false;
      // A roll needs more side room than a knuckle walk. Back away from the
      // contacted prop without turning the long arms through it, then lie down.
      e.footprintMode = "pound"; e.compact = e.gorilla.poundCompact;
      e.radius = Math.max(WALK_RADIUS, e.gorilla.bodyRadius + 0.1); e.height = Math.max(2.7, e.gorilla.bodyHeight + 0.08);
      e.biped = false;
      if (!f.escaping && !f.escapeRetry) {
        f.escapeRetry = 0.6;
        for (let n = 0; n < 24; n++) {
          const turn = n % 8, angle = e.heading + Math.PI + (turn % 2 ? 1 : -1) * Math.ceil(turn / 2) * Math.PI / 4;
          const distance = (Math.floor(n / 8) + 1) * 0.8;
          const x = p.x + Math.sin(angle) * distance, z = p.z + Math.cos(angle) * distance;
          const y = support(e, x, z, p.y, STEP);
          if (!Number.isFinite(y) || Math.abs(y - p.y) > STEP || !landing(x, y, z)
            || occupied(e, x, y, z) || !staticClear(e, p.x, p.y, p.z, x, y, z)) continue;
          let floorClear = true;
          for (let s = 1; s < 8; s++) {
            const k = s / 8, sy = support(e, p.x + (x - p.x) * k, p.z + (z - p.z) * k, p.y, STEP);
            if (!Number.isFinite(sy) || Math.abs(sy - p.y) > STEP) { floorClear = false; break; }
          }
          if (!floorClear) continue;
          const radius = e.radius, height = e.height, compact = e.compact;
          e.radius = MOTION_RADIUS; e.height = MOTION_HEIGHT; e.compact = false;
          const fits = !occupied(e, x, y, z) && staticClear(e, x, y, z);
          e.radius = radius; e.height = height; e.compact = compact;
          if (!fits) continue;
          f.escapeX = x; f.escapeY = y; f.escapeZ = z; f.escaping = true; break;
        }
      }
      if (!f.escaping) { e.speed = 0; return true; }
      const dx = f.escapeX - p.x, dz = f.escapeZ - p.z, distance = Math.hypot(dx, dz);
      if (distance < 0.06) { f.escaping = false; f.retry = 0; e.speed = 0; return true; }
      const step = Math.min(distance, 1.8 * dt), x = p.x + dx / distance * step, z = p.z + dz / distance * step;
      const y = support(e, x, z, p.y, STEP);
      if (Number.isFinite(y) && Math.abs(y - p.y) <= STEP && !occupied(e, x, y, z)
        && staticClear(e, p.x, p.y, p.z, x, y, z)) {
        p.x = x; p.y = y; p.z = z;
        e.speed = step / dt * (dx * Math.sin(e.heading) + dz * Math.cos(e.heading) < 0 ? -1 : 1);
      } else { f.escaping = false; e.speed = 0; }
      return true;
    };
    const drivenGroundStep = (e, x, z, heading, drop, allowFall = false) => {
      const p = e.root.position, d = e.drive;
      const ramp = walkingRampAt(x, p.y, z, heading);
      if (ramp) drop = Math.max(drop, BL.wallPanels.RAMP_STEP);
      if (allowFall && d.run && !ramp && drop <= STEP
        && pointSupportAt(p.x, p.z, p.y + 0.1, e) >= p.y - STEP
        && pointSupportAt(x, z, p.y + 0.1, e) < p.y - STEP
        && beginSupportFall(e, x, z, heading, d.vx, d.vz, d.run)) return true;
      const y = support(e, x, z, p.y, PROP_STEP, heading);
      if (!Number.isFinite(y) || y < p.y - drop) {
        // Only the requested step may leave a prop. An avoidance sidestep
        // never chooses an unsupported drop on the player's behalf.
        return allowFall && beginSupportFall(e, x, z, heading, d.vx, d.vz, d.run);
      }
      if (y > p.y + PROP_STEP || e.parked && caveAt(x, y, z) < 0
        || occupied(e, x, y, z, true, heading)) return false;
      let valid = staticClear(e, p.x, p.y, p.z, x, y, z, e.heading, heading);
      // Terrain and tall geometry still require a clear lift and crossing.
      if (!valid && y < p.y && (x !== p.x || z !== p.z)
        && !occupied(e, x, p.y, z, true, heading)
        && staticClear(e, p.x, p.y, p.z, x, p.y, z, e.heading, heading)
        && staticClear(e, x, p.y, z, x, y, z, heading, heading)) valid = true;
      if (!valid && y > p.y
        && !occupied(e, p.x, y, p.z)
        && staticClear(e, p.x, p.y, p.z, p.x, y, p.z)
        && staticClear(e, p.x, y, p.z, x, y, z, e.heading, heading)) valid = true;
      if (!valid) return false;
      setSupportY(e, y, x, z, heading); p.x = x; p.z = z; e.heading = heading;
      return true;
    };
    const drivenGroundSlide = (e, dx, dz, facing, dt, steer, drop) => {
      const p = e.root.position, d = e.drive, distance = Math.hypot(dx, dz);
      // A blocked turn need not stop translation along a wall. All retries
      // keep the same center clearance and real support.
      if (Math.abs(facing - e.heading) > 1e-6
        && drivenGroundStep(e, p.x + dx, p.z + dz, e.heading, drop)) return true;
      if (distance < 1e-7) return false;
      // Keep only one component of the requested displacement, so sliding
      // never increases speed or crosses the blocked diagonal's inside corner.
      const xFirst = Math.abs(dx) >= Math.abs(dz);
      for (let i = 0; i < 2; i++) {
        const alongX = i ? !xFirst : xFirst;
        const sx = alongX ? dx : 0, sz = alongX ? 0 : dz;
        if (Math.abs(sx) + Math.abs(sz) < 1e-7 || sx === dx && sz === dz) continue;
        if (drivenGroundStep(e, p.x + sx, p.z + sz, facing, drop)
          || Math.abs(facing - e.heading) > 1e-6 && drivenGroundStep(e, p.x + sx, p.z + sz, e.heading, drop)) return true;
      }
      if (!steer || e.parked) return false;
      const direction = Math.atan2(dx, dz), backwards = dx * Math.sin(e.heading) + dz * Math.cos(e.heading) < 0;
      const preferred = d.avoidTime > 0 ? d.avoidSide : e.turn;
      // Keep one side until the center clears the obstruction. The body can
      // overlap nearby scenery while the feet follow this side path.
      for (let side = 0; side < 2; side++) {
        const sign = side ? -preferred : preferred;
        for (let trial = 1; trial <= 4; trial++) {
          const heading = direction + sign * trial * 0.4;
          const turn = Math.atan2(Math.sin(heading + (backwards ? Math.PI : 0) - e.heading), Math.cos(heading + (backwards ? Math.PI : 0) - e.heading));
          const body = e.heading + clamp(turn, -dt * 7, dt * 7);
          const x = p.x + Math.sin(heading) * distance, z = p.z + Math.cos(heading) * distance;
          if (!drivenGroundStep(e, x, z, body, drop)
            && !drivenGroundStep(e, x, z, e.heading, drop)) continue;
          d.avoidSide = sign; d.avoidHeading = direction; d.avoidTime = 0.45;
          return true;
        }
      }
      return false;
    };
    const rageFallClear = (e, dt, x, y, z, heading, speed, landed = false) => {
      if (!e.drive.wallRelease || !rageCarrying(e)) return true;
      const p = e.root.position, previousHeading = e.heading, landing = e.motion.landing;
      if (ctx.rageCarryClear && !ctx.rageCarryClear(e, p.x, p.y, p.z, x, y, z, previousHeading, heading)) return false;
      e.heading = heading;
      if (landed) e.motion.landing = e.drive.passiveFall ? 0 : 1;
      try {
        return ctx.rageJumpPoseClear?.(e, dt, x, y, z, speed, !landed && !e.drive.passiveFall) !== false;
      } finally { e.heading = previousHeading; e.motion.landing = landing; }
    };
    const updateDriven = (e, dt) => {
      const d = e.drive, p = e.root.position, m = e.motion;
      d.climbTurnTimer = Math.max(0, d.climbTurnTimer - dt);
      if (e.controlled) { e.phase = "controlled"; e.route = ""; }
      e.lounge = "";
      if (d.cancelled && !d.jumpHeld) d.cancelled = false;
      const pressed = (d.jumpPressed || d.jumpHeld && !d.jumpDown) && !d.cancelled;
      d.jumpPressed = false;
      // A temporarily blocked takeoff gets a short retry window. Only a fresh
      // press starts it; holding Space cannot queue repeated jumps.
      d.jumpBuffer = pressed ? JUMP_BUFFER : Math.max(0, d.jumpBuffer - dt);
      if (d.jumpBuffer) {
        if (e.fire.burning) { dropRoll(e); d.jumpBuffer = 0; }
        else if (beginDrivenJump(e) || d.jumps >= 2) d.jumpBuffer = 0;
      }
      d.jumpDown = d.jumpHeld;
      if (e.fire.rolling) return;
      if (d.x * d.x + d.z * d.z > 0.0025) e.fire.escaping = false;
      else if (escapeForRoll(e, dt)) { d.vx = d.vz = 0; return; }
      if (e.recover > 0 && (!d.airborne || e.actionControlled)) {
        const movingSmash = e.actionControlled;
        e.recover = Math.max(0, e.recover - dt);
        if (!e.recover) e.actionControlled = e.motion.smash = false;
        if (!movingSmash) { e.speed = 0; d.vx = d.vz = 0; return; }
      }
      if (e.pound > 0 || e.beat > 0) {
        if (e.pound > 0) {
          e.pound = Math.max(0, e.pound - dt);
          if (!e.poundHit && e.pound <= 0.22) {
            e.poundHit = true; e.pounds++;
            if (!d.airborne && ctx.onPound) ctx.onPound(e);
            if (e.actionControlled && ctx.onSmash) ctx.onSmash(e);
          }
          if (!e.pound) e.recover = PLAYER_SMASH_RECOVER;
        }
        e.beat = Math.max(0, e.beat - dt);
        if (!e.actionControlled) { e.speed = 0; d.vx = d.vz = 0; return; }
      }
      if (e.parked && expandGesture(e, WALK_RADIUS)) {
        e.parked = false; e.biped = false; e.footprintMode = "pound"; e.compact = e.gorilla.poundCompact;
        e.recover = 0.55; e.speed = 0; return;
      }
      e.biped = e.parked;
      e.footprintMode = e.parked ? "stand" : d.passiveFall ? e.footprintMode : "walk";
      if (!d.airborne) d.motionRecover = Math.max(0, d.motionRecover - dt);
      const motion = d.airborne && !d.passiveFall || d.motionRecover > 0 || e.fire.rollRecover > 0 || e.drive.motionEnvelope && e.gorilla.motionActive;
      e.compact = !motion && (e.parked ? e.gorilla.standCompact : e.footprintMode === "walk" ? e.gorilla.compact : e.gorilla.poundCompact);
      const labAir = e.motion.lab && d.airborne && !e.motion.labRunIn;
      e.radius = Math.max(labAir ? BL.agent.LAB_RADIUS : motion ? MOTION_RADIUS : WALK_RADIUS, e.gorilla.bodyRadius + 0.1);
      e.height = Math.max(labAir ? BL.agent.LAB_HEIGHT : motion ? MOTION_HEIGHT : WALK_HEIGHT, e.gorilla.bodyHeight + 0.04);
      if (d.wallRelease && d.passiveFall) {
        e.radius = Math.max(CLIMB_RADIUS, e.gorilla.bodyRadius + 0.015);
        e.height = Math.max(CLIMB_HEIGHT, e.gorilla.bodyHeight + 0.015);
      }
      labEnvelope(e);
      const amount = Math.min(1, Math.hypot(d.x, d.z)), norm = amount > 0 ? Math.hypot(d.x, d.z) : 1;
      d.avoidTime = Math.max(0, d.avoidTime - dt);
      if (amount <= 0.05 || d.airborne || d.x * Math.sin(d.avoidHeading) + d.z * Math.cos(d.avoidHeading) < norm * 0.8) d.avoidTime = 0;
      const speed = e.parked ? 0.6 : d.run ? SPEED * 2 : CHILL_SPEED * 2;
      const wantX = e.controlled || !d.airborne ? d.x / norm * speed * amount : d.vx;
      const wantZ = e.controlled || !d.airborne ? d.z / norm * speed * amount : d.vz;
      // Controlled ground steps take their faster selected pace immediately;
      // only airborne steering needs a gradual velocity change.
      d.vx = d.airborne ? damp(d.vx, wantX, 3, dt) : wantX;
      d.vz = d.airborne ? damp(d.vz, wantZ, 3, dt) : wantZ;
      let wantedHeading = Number.isFinite(d.heading) ? d.heading : amount > 0.01 ? Math.atan2(d.x, d.z) : e.heading;
      if (Number.isFinite(d.climbExitHeading)) {
        // Continuing S after a descent backs away while still facing the wall.
        // A fresh look or movement direction resumes ordinary facing.
        if (!Number.isFinite(d.climbExitLook)) d.climbExitLook = wantedHeading;
        const lookTurn = Math.abs(Math.atan2(Math.sin(wantedHeading - d.climbExitLook), Math.cos(wantedHeading - d.climbExitLook)));
        const movingAway = amount < 0.05 || (d.x * Math.sin(d.climbExitHeading) + d.z * Math.cos(d.climbExitHeading)) / norm < -0.7;
        if (lookTurn > 0.08 || !movingAway || d.airborne) d.climbExitHeading = d.climbExitLook = NaN;
        else wantedHeading = d.climbExitHeading;
      }
      const delta = Math.atan2(Math.sin(wantedHeading - e.heading), Math.cos(wantedHeading - e.heading));
      const turnRate = d.climbTurnTimer > 0 ? 14 : 7;
      const heading = e.heading + clamp(delta, -dt * turnRate, dt * turnRate);
      const direction = Math.atan2(d.x, d.z), backing = e.controlled && Math.cos(direction - e.heading) < -0.25;
      if (d.airborne && (d.vy <= 0 && beginPlatformEntry(e) || attachContactWall(e))) return;
      if (!d.airborne && amount > 0.05 && !e.climb.retry && caveAt(p.x, p.y, p.z) < 0
        && (p.y - groundAt(p.x, p.z, p.y) <= STEP
          || backing && Math.abs(support(e, p.x, p.z, p.y, STEP) - p.y) <= 0.2)) {
        const sx = Math.sin(direction), sz = Math.cos(direction);
        const drop = climbSurfaceAt && climbSurfaceAt(p.x + sx * 2.2, p.z + sz * 2.2) < p.y - 0.8;
        if (drop && (!d.run || backing) && beginEdgeClimb(e, direction)) return;
        const wall = !drop && wallRectangleShare(e, p.x, p.y, p.z, direction) >= WALL_ENTER_SHARE;
        // The rectangle sees a wall before the hands reach it. Keep walking
        // until a local grip is close enough, then use the checked route if
        // the direct mount is obstructed.
        let nearWall = false;
        if (wall || e.controlled && !drop) for (let distance = 0.4; distance <= 1.4; distance += 0.2) {
          if (climbSolidAt(p.x + sx * distance, p.y + 0.85, p.z + sz * distance)) { nearWall = true; break; }
        }
        if (nearWall && (e.controlled || !e.climb.departurePlanning) && attachContactWall(e)) return;
        if (!e.controlled && !e.climb.departurePlanning && (nearWall || drop || e.climb.searchPending)
          && tryClimb(e, direction, !!drop)) return;
      }
      if (holdClimbSearch(e)) return;
      const count = Math.max(1, Math.ceil(Math.max(Math.hypot(d.vx, d.vz), Math.abs(d.vy)) * dt / 0.1));
      const step = dt / count, oldX = p.x, oldZ = p.z;
      for (let i = 0; i < count; i++) {
        if (d.airborne && d.vy <= 0 && beginPlatformEntry(e)) return;
        const facing = e.heading + (heading - e.heading) / (count - i);
        if (!d.airborne) {
          const dx = d.vx * step, dz = d.vz * step, drop = raisedSupport(e) ? PROP_STEP : STEP;
          if (drivenGroundStep(e, p.x + dx, p.z + dz, facing, drop, true)
            || drivenGroundSlide(e, dx, dz, facing, step, amount > 0.05, drop)) continue;
          // Turning and walking have separate clearance: a blocked forward
          // step must still let the body pivot away from the obstacle.
          if (Math.abs(facing - e.heading) > 1e-6) drivenGroundStep(e, p.x, p.z, facing, drop);
          continue;
        }
        const x = p.x + d.vx * step, z = p.z + d.vz * step;
        let y = p.y + d.vy * step - GRAVITY * step * step * 0.5, landing = false;
        d.vy = Math.max(-40, d.vy - GRAVITY * step);
        // A roof tread may be a voxel above the previous one. Keep the same
        // step tolerance used on foot so a descending jump cannot miss that
        // roof and start treating an interior voxel as the next floor.
        const floor = support(e, x, z, Math.max(p.y, y), STEP, facing);
        if (d.vy <= 0 && Number.isFinite(floor) && floor <= p.y + STEP && y <= floor) {
          y = floor; landing = true;
        }
        let valid = (!e.parked || caveAt(x, y, z) >= 0) && !occupied(e, x, y, z, true, facing)
          && staticClear(e, p.x, p.y, p.z, x, y, z, e.heading, facing);
        if (!valid && !e.walkPoseChecked && y < p.y && (x !== p.x || z !== p.z) && (!e.parked || caveAt(x, y, z) >= 0)
          && !occupied(e, x, p.y, z, true, facing) && !occupied(e, x, y, z, true, facing)
          && staticClear(e, p.x, p.y, p.z, x, p.y, z, e.heading, facing)
          && staticClear(e, x, p.y, z, x, y, z, facing, facing)) valid = true;
        if (valid && !rageFallClear(e, dt, x, y, z, facing, Math.hypot(x - oldX, z - oldZ) / dt, landing)) valid = false;
        if (valid) {
          p.x = x; p.y = y; p.z = z; e.heading = facing;
          if (landing) {
            d.airborne = false; d.grounded = true; d.vy = d.jumps = 0;
            d.motionRecover = d.passiveFall ? 0 : 0.6; m.landing = d.passiveFall ? 0 : 1; d.passiveFall = false;
            d.wallRelease = false;
            if (e.climb.airAttachAfter === Infinity) e.climb.airAttachAfter = 0;
          }
        }
        else {
          // Resolve a blocked lateral move independently from gravity so walls
          // cannot suspend a jumping gorilla above the floor.
          const ownFloor = support(e, p.x, p.z, Math.max(p.y, y), STEP);
          if (d.vy <= 0 && Number.isFinite(ownFloor) && ownFloor <= p.y + STEP && y < ownFloor) y = ownFloor;
          const beforeFall = p.y;
          if (!occupied(e, p.x, y, p.z) && (staticClear(e, p.x, p.y, p.z, p.x, y, p.z)
            // A falling body can brush a cliff with its walking pose. Check
            // the same narrow core used beside stone while preserving the
            // actual terrain and prop sweep, then let gravity continue.
            || d.passiveFall && ctx.climbClear && ctx.climbClear(e,
              p.x, p.y + 0.85, p.z, p.x, y + 0.85, p.z,
              0.12, 0.5, false, false, true, true))
            && rageFallClear(e, dt, p.x, y, p.z, e.heading, Math.hypot(p.x - oldX, p.z - oldZ) / dt,
              Number.isFinite(ownFloor) && Math.abs(y - ownFloor) < 0.02 && d.vy <= 0)) p.y = y;
          else if (d.vy > 0) d.vy = 0;
          if (p.y === beforeFall && d.vy < 0 && (!Number.isFinite(ownFloor) || ownFloor < p.y - 0.5)
            && ctx.climbClear) {
            // A diagonal roof exit can leave the narrow core a fraction of a
            // voxel inside the cliff. Find the first outward position where
            // both the core and the downward step fit. Props remain solid.
            const velocity = Math.hypot(d.vx, d.vz);
            const awayX = velocity > 0.1 ? d.vx / velocity : d.wallRelease ? -Math.sin(e.heading) : 0;
            const awayZ = velocity > 0.1 ? d.vz / velocity : d.wallRelease ? -Math.cos(e.heading) : 0;
            if (awayX || awayZ) for (let distance = 0.1; distance <= 0.8; distance += 0.1) {
              const tx = p.x + awayX * distance, tz = p.z + awayZ * distance;
              if (occupied(e, tx, p.y, tz)
                || !ctx.climbClear(e, p.x, p.y + 0.85, p.z, tx, p.y + 0.85, tz,
                  0.12, 0.5, false, false, true, false)
                || !ctx.climbClear(e, tx, p.y + 0.85, tz, tx, y + 0.85, tz,
                  0.12, 0.5, false, false, true, true)
                || !rageFallClear(e, dt, tx, y, tz, e.heading, Math.hypot(tx - oldX, tz - oldZ) / dt,
                  Number.isFinite(ownFloor) && Math.abs(y - ownFloor) < 0.02 && d.vy <= 0)) continue;
              p.x = tx; p.y = y; p.z = tz;
              break;
            }
          }
          if (Number.isFinite(ownFloor) && Math.abs(p.y - ownFloor) < 0.02 && d.vy <= 0
            && rageFallClear(e, dt, p.x, p.y, p.z, e.heading, Math.hypot(p.x - oldX, p.z - oldZ) / dt, true)) {
            if (d.airborne) { d.motionRecover = d.passiveFall ? 0 : 0.6; m.landing = d.passiveFall ? 0 : 1; }
            d.airborne = d.passiveFall = false; d.grounded = true; d.vy = d.jumps = 0;
            d.wallRelease = false;
            if (e.climb.airAttachAfter === Infinity) e.climb.airAttachAfter = 0;
          }
        }
      }
      e.speed = Math.hypot(p.x - oldX, p.z - oldZ) / dt;
      if (e.speed > 0 && (p.x - oldX) * Math.sin(e.heading) + (p.z - oldZ) * Math.cos(e.heading) < 0) e.speed = -e.speed;
      if (!d.airborne && d.resume && !e.controlled) resumeEntry(e);
    };
    const poseEntry = (e, dt, beforeX, beforeY, beforeZ) => {
      const p = e.root.position;
      if (e.climb.active && e.climb.holdPose) return;
      const exit = e.climb;
      if (exit.openingExit) {
        const dx = p.x - exit.openingExitX, dz = p.z - exit.openingExitZ;
        const sx = Math.sin(exit.openingExitHeading), sz = Math.cos(exit.openingExitHeading);
        if (dx * sx + dz * sz > 2.4 || Math.abs(dx * sz - dz * sx) > 1.1) exit.openingExit = false;
      }
      syncLab(e);
      e.motion.workExit = !e.controlled && e.mode === "working" && e.phase === "travel" && e.route === "exit";
      e.motion.openingSettle = Math.max(0, e.motion.openingSettle - dt * 1.4);
      e.motion.supportOffset = damp(e.motion.supportOffset, 0, 12, dt);
      e.motion.labPhase += dt;
      if (e.lounge && Math.abs(e.speed) <= 0.1 && !ctx.restPoseClear) {
        const compact = e.compact, mode = e.footprintMode;
        // The sitting body has its own measured capsules. Its rise and settling
        // fit the walking chain; reclining still reserves the wider full body.
        if (e.lounge === "sit") {
          if (!loungeSeatSpace(e, p.x, p.y, p.z, e.heading)) { leaveLounge(e); e.rest = 0; }
          if (e.gorilla.sitCompact) { e.footprintMode = "sit"; e.compact = true; }
          else { e.footprintMode = "walk"; e.compact = e.gorilla.compact; }
        } else {
          e.compact = false;
          if (occupied(e, p.x, p.y, p.z) || !staticClear(e, p.x, p.y, p.z)) {
            e.compact = compact; e.footprintMode = mode; e.lounge = ""; e.rest = 0;
          }
        }
      }
      if (!e.controlled && e.phase === "chill" && !e.climb.active && !e.jump.active && !e.drive.airborne && !e.fire.burning) {
        if (e.roam.lastPose !== e.lounge) { e.roam.lastPose = e.lounge; e.roam.transition = 1.2; }
        if (e.roam.transition > 0 && ctx.restPoseClear) {
          const actualLounge = e.gorilla.debug.lounge;
          // An interrupted handoff may already have cleared the logical rest
          // without changing the rig. Admit its complete rise before advancing.
          const unprovedRise = actualLounge && !e.lounge && !e.roam.riseAdmitted;
          if (unprovedRise && !ctx.restPoseClear(e, 1.2, "", false, p.x, p.y, p.z, e.heading, null, dt)
            || !ctx.restPoseClear(e, dt, e.lounge)) {
            p.x = beforeX; p.y = beforeY; p.z = beforeZ; e.heading = e.root.rotation.y;
            e.roam.riseAdmitted = false;
            if (actualLounge !== e.lounge) {
              const rising = !e.lounge && !!actualLounge;
              e.lounge = e.roam.lastPose = actualLounge; e.roam.transition = 0; e.roam.arrived = false;
              if (rising) { e.recover = 0; leaveLounge(e); }
              else e.rest = Math.min(e.rest, 1);
            }
            e.speed = 0; return false;
          }
          e.roam.transition = Math.max(0, e.roam.transition - dt);
        }
      }
      if (e.climb.active && e.climb.free) {
        e.heading = e.climb.heading = e.climb.panel.heading;
        wallPanels.coordinates(e.climb.panel, p.x, p.y, p.z);
      }
      // Certify the final animated trunk too, after support and speed settle.
      if (ctx.walkingPeersClear && !e.motion.lab && !e.climb.active && !e.jump.active
        && !e.drive.airborne && !e.lounge && !ctx.walkingPeersClear(e, dt, beforeX, beforeY, beforeZ)) {
        p.x = beforeX; p.y = beforeY; p.z = beforeZ;
        e.heading = e.root.rotation.y; e.speed = 0; return false;
      }
      if (e.climb.mountPending || e.climb.handoffDirection) {
        e.motion.climbGripX = e.motion.climbGripY = e.motion.climbGripZ = NaN;
        e.motion.climbGripRelease = 0;
      }
      e.gorilla.poseManaged(dt, p.x, p.y, p.z, e.heading, e.speed,
        e.jump.active || e.drive.airborne && !e.drive.passiveFall, e.biped, e.lounge, e.motion);
      if (e.climb.active && !e.climb.mountPending && !e.climb.handoffDirection
        && e.motion.climbBlend > 0.98 && e.motion.mantle < 0.01) {
        // The rendered palms, rather than the wall's coarse body samples,
        // decide whether this gorilla is still attached. One hand may release
        // for a checked regrip, but every other hand must hold actual stone.
        const released = Number.isFinite(e.motion.climbGripX) ? e.motion.climbGripRelease : 0;
        const required = 3 & ~released;
        if ((e.gorilla.climbHandContactMask() & required) !== required) {
          dropRectangleClimb(e, false);
          e.climb.debugStuck = false;
          if (e.debugMove.active) {
            e.debugMove.status = "blocked";
            e.debugMove.reason = "Lost wall grip";
            e.debugMove.wallPending = false;
          }
          e.gorilla.poseManaged(dt, p.x, p.y, p.z, e.heading, 0, false, e.biped, "", e.motion);
        }
      }
      e.motion.walkPhase = NaN;
      e.roam.riseAdmitted = false;
      if (!e.motion.lab && e.footprintMode === "lab") {
        e.footprintMode = "pound"; e.compact = e.gorilla.poundCompact;
      }
      if (e.climb.active) {
        e.radius = Math.max(CLIMB_RADIUS, e.gorilla.bodyRadius + 0.015);
        e.height = Math.max(CLIMB_HEIGHT, e.gorilla.bodyHeight + 0.015);
      }
      if (e.lounge === "sit" && e.gorilla.sitCompact) { e.footprintMode = "sit"; e.compact = true; }
      else if (e.footprintMode === "sit") { e.footprintMode = "walk"; e.compact = e.gorilla.compact; }
      if (e.actionControlled || e.motion.smash || e.gorilla.smashActive) {
        e.footprintMode = "pound"; e.compact = e.gorilla.poundCompact;
        e.radius = Math.max(BL.agent.MANAGED_SMASH_RADIUS, e.gorilla.bodyRadius + 0.1);
        e.height = Math.max(e.height, e.gorilla.bodyHeight + 0.08);
      }
      if (e.gorilla.motionActive && !e.climb.active) {
        e.compact = false;
        if (!(e.motion.lab && e.drive.airborne && !e.motion.labRunIn)) {
          e.radius = Math.max(e.radius, MOTION_RADIUS);
          e.height = Math.max(e.height, MOTION_HEIGHT);
        }
      }
      if (e.drive.motionEnvelope && !e.gorilla.motionActive && !e.drive.airborne
        && !e.drive.motionRecover && !e.fire.rolling && !e.fire.rollRecover) e.drive.motionEnvelope = false;
      labEnvelope(e);
      if (ctx.fireContact && ctx.fireContact(e, beforeX, beforeY, beforeZ)) ignite(e);
      if (ctx.onMove && (beforeX !== p.x || beforeY !== p.y || beforeZ !== p.z)) ctx.onMove(e, beforeX, beforeY, beforeZ, dt);
    };
    const shareLabStation = (e) => {
      // A completed job releases its desk for an interior coworker. Keep the
      // whole handoff in the lab; returning glassware precedes this call.
      let next = null;
      for (const other of list) {
        if (other === e || !other.active || other.controlled || other.mode !== "working"
          || other.site !== labSite || !other.motion.lab || other.lab.station >= 0
          || other.fire.burning || other.fire.rolling || other.debugMove.active
          || other.phase !== "work" && other.route !== "enter") continue;
        if (!next || other.lab.waitSince < next.lab.waitSince) next = other;
      }
      if (!next) return false;
      // Fill an unused regular/overflow station before interrupting anyone.
      if (reserveLab(next, false)) { setGoal(next, next.slotX, next.slotY, next.slotZ); return false; }
      if (!reserveFloor(e)) return false;
      e.lab.time = 3; e.lab.cycles++; e.workCycle++;
      e.motion.labWork = ""; e.motion.labReach = 0;
      setGoal(e, e.slotX, e.slotY, e.slotZ);
      // Give the oldest waiting coworker the released equipment immediately,
      // rather than letting the same roster entries win every one-second poll.
      if (reserveLab(next, false)) setGoal(next, next.slotX, next.slotY, next.slotZ);
      return true;
    };
    const finishLabItem = (e) => {
      const job = e.lab;
      job.item = -1; job.stage = ""; job.reach = 0; job.time = 0;
      job.arrived = false;
      if (job.yielding) { job.stage = "fetch"; return; }
      if (e.mode !== e.owner.state || e.pendingSite >= 0 && e.pendingSite !== e.site) return;
      if (shareLabStation(e)) return;
      if (reserve(e, true)) { job.cycles++; e.workCycle++; setGoal(e, e.slotX, e.slotY, e.slotZ); }
      else job.stage = "fetch";
    };
    const workLab = (e, dt) => {
      const p = e.root.position, job = e.lab, station = labStations[job.station];
      if (station && station.enabled === false) {
        releaseLab(e); e.hasSlot = false; beginTravel(e, labSite); return;
      }
      const wasWorking = !!e.motion.labWork;
      e.motion.labWork = ""; e.motion.labReach = 0;
      if (job.item >= 0) e.motion.labSqueeze = false;
      e.motion.labDie = false; e.motion.labRoll = 0;
      if (job.stage === "roll") {
        e.speed = damp(e.speed, 0, 12, dt);
        e.motion.labWork = "roll";
        job.time -= dt;
        const item = labEquipment[job.item];
        // Keep the scientist and its claim at the bench while the real die
        // tumbles. A requested exit/yield changes this to the normal return.
        if (item && item.rolling || job.time > 0) return;
        if (ctx.labReturn && !ctx.labReturn(e)) return;
        finishLabItem(e);
        return;
      }
      if (station && station.kind === "carry" && job.item < 0 && !job.stage) job.stage = "fetch";
      let destination = station || job.waitPoint;
      if (job.stage === "fetch" || job.stage === "inspect" || job.stage === "return") {
        job.pickup = labPickupFor(e, job.station);
        const equipment = labEquipment[job.pickup];
        if (equipment) {
          job.bench = equipment.station;
          destination = labPickupPoint(labStations[job.bench], equipment, job.pickupPoint);
          labPickupPose(e, equipment);
          if (job.stage === "inspect") e.motion.labReach = 0;
        } else destination = null;
      }
      if (!destination) { e.speed = 0; return; }
      e.slotX = destination.x; e.slotY = destination.y; e.slotZ = destination.z;
      const distance = Math.hypot(destination.x - p.x, destination.z - p.z);
      if (distance > 0.003) {
        job.arrived = false;
        job.reach = 0;
        if (e.gorilla.labItem) { e.motion.labWork = "carry"; e.motion.labReach = 1; e.motion.labSqueeze = false; }
        if (labGoal(e, destination.x, destination.y, destination.z, destination.heading, true)) moveLab(e, dt, 1.1);
        else { e.speed = damp(e.speed, 0, 12, dt); if (!job.pathPending) requestLabPass(e, destination.x, destination.z); }
        if (e.blocked > 0.35) requestLabPass(e, destination.x, destination.z);
        return;
      }
      e.speed = damp(e.speed, 0, 12, dt);
      if (!station) {
        // Wait for equipment inside the lab. A busy desk never evicts this
        // worker or sends it back through the entrance to wait outside.
        job.arrived = true; job.time -= dt;
        if (job.time <= 0) {
          job.time = 1;
          if (reserve(e, true)) { job.cycles++; e.workCycle++; setGoal(e, e.slotX, e.slotY, e.slotZ); }
        }
        return;
      }
      // Finish retracting the wider walking shoulders before raising the hands.
      // Doing both together sweeps the elbows outside either final footprint.
      if (job.item < 0 && !wasWorking) {
        e.motion.labSqueeze = false;
        if (!e.gorilla.labIdleCompact) { e.speed = 0; return; }
      }
      const turn = Math.atan2(Math.sin(destination.heading - e.heading), Math.cos(destination.heading - e.heading));
      {
        const heading = e.heading + clamp(turn, -dt * LAB_TURN_SPEED, dt * LAB_TURN_SPEED);
        if (Math.abs(turn) > 0.01 && !occupied(e, p.x, p.y, p.z, true, heading)
          && staticClear(e, p.x, p.y, p.z, p.x, p.y, p.z, e.heading, heading)) e.heading = heading;
      }
      if (Math.abs(turn) >= 0.08) return;
      e.motion.labSide = destination.side === -1 ? -1 : 1;
      const nextWork = job.stage === "fetch" || job.stage === "return" ? "carry" : station.kind;
      // A route was planned against yesterday's occupied workstations. Before
      // opening the arms again, reserve the whole working pose at this instant.
      const compact = e.compact, mode = e.footprintMode;
      e.planningLab = e.compact = true; e.footprintMode = "lab";
      e.planningLabWork = nextWork; e.planningLabSide = e.motion.labSide;
      const ready = !occupied(e, p.x, p.y, p.z) && staticClear(e, p.x, p.y, p.z);
      e.compact = compact; e.footprintMode = mode; e.planningLab = false; e.planningLabWork = "";
      if (!ready) return;
      e.motion.labSqueeze = false;
      if (job.stage === "fetch" || job.stage === "return") {
        e.motion.labWork = "carry"; e.motion.labReach = 1;
        job.reach += dt;
        if (job.reach < 0.8) return;
        if (job.stage === "return") {
          if (ctx.labReturn && !ctx.labReturn(e)) return;
          finishLabItem(e);
          return;
        } else {
          const chosen = job.pickup;
          if (chosen < 0 || !ctx.labPickup || !ctx.labPickup(e, chosen)) { job.reach = 0; return; }
          job.item = chosen; job.stage = "inspect"; job.reach = 0;
          job.pathCount = job.pathIndex = 0; job.pathAt = 0; job.arrived = false;
          return;
        }
      }
      e.motion.labWork = station.kind === "carry" ? job.item >= 0 ? "carry" : "" : station.kind;
      if (!job.arrived) {
        job.arrived = true;
        job.time = e.motion.labDie ? 1.1 + e.random() * 0.6 : 8 + e.random() * 5;
      }
      job.time -= dt;
      if (e.motion.labDie) e.motion.labRoll = clamp(1 - job.time / 0.45, 0, 1);
      if (job.time <= 0) {
        if (e.motion.labDie && job.item >= 0 && ctx.labRoll) {
          if (!ctx.labRoll(e, job.item)) return;
          job.stage = "roll"; job.time = 2.5 + e.random() * 1.5;
          return;
        }
        if (job.item >= 0) { job.stage = "return"; job.arrived = false; job.reach = 0; job.pathCount = 0; return; }
        if (shareLabStation(e)) return;
        // A workstation stays occupied until its scientist has a real, clear
        // next job. Failed reservations keep the hands working, not idling.
        if (reserve(e, true)) {
          job.cycles++; e.workCycle++;
          setGoal(e, e.slotX, e.slotY, e.slotZ);
        } else job.time = 1 + e.random();
      }
    };
    // Sleep. A gorilla sleeps when its Ooga does and where the scene keeps beds (`ctx.sleep`: `slots`, each with its
    // root point, heading and `nest`, and `path(slot, out)`, the dry way there from the home island as x, z pairs).
    // It reserves a bed before it sets out and keeps it through the walk, the sleep, the waking and the walk
    // home; beds are dealt for the day by a hash of the roster's names (`bedsToday`), so the choice is random,
    // reproducible, the same on every page, and never reshuffled under a sleeper. Stages: "go" along the path, "settle" turning onto the bed, "asleep", then "return" back
    // along the path once its Ooga wakes, after which the ordinary work and chill machinery takes over.
    // A hand on it wins: possession wakes it where it lies, and a release while its Ooga still sleeps walks it
    // back to bed from where it stands.
    const SLEEP_POSES = ["left", "right", "back"], SLEEP_REACH = 1.1, SLEEP_ARRIVE = 0.3, SLEEP_STALL = 25, SLEEP_MARK = 1.9, DAY_MS = 86400000;
    // Who sleeps where today: every gorilla's bed, worked out once a day from the roster's names alone. Each takes
    // the first bed still free in its own shuffled order, in roster order, so the answer never depends on who
    // happened to fall asleep first, and every page looking at the island sees the same gorilla in the same bed
    // without a word passing between them. A bed already taken is kept past midnight until its sleeper leaves it.
    let bedDay = -1;
    const bedOf = [];
    const bedsToday = () => {
      const day = Math.floor(Date.now() / DAY_MS), beds = ctx.sleep.slots.length;
      if (day === bedDay && bedOf.length === list.length) return bedOf;
      bedDay = day;
      const taken = new Uint8Array(beds);
      bedOf.length = list.length;
      for (let i = 0; i < list.length; i++) {
        const name = list[i].owner.traits.name;
        let best = -1, lowest = Infinity;
        // The bed with the lowest hash for this name and day among those still free: a shuffle without a list.
        for (let b = 0; b < beds; b++) {
          const order = taken[b] ? Infinity : fnv1a(`bed/${day}/${name}/${b}`);
          if (order < lowest) { lowest = order; best = b; }
        }
        bedOf[i] = best;
        if (best >= 0) taken[best] = 1;
      }
      return bedOf;
    };
    const bedTaken = (slot, but) => {
      for (const other of list) if (other !== but && other.sleep.slot === slot) return true;
      return false;
    };
    const releaseBed = (e) => {
      const s = e.sleep;
      s.stage = ""; s.slot = -1;
      e.gorilla.chest.scale.y = 1;
    };
    const reserveBed = (e) => {
      const s = e.sleep, beds = ctx.sleep.slots;
      if (s.slot >= 0) return true;
      let slot = bedsToday()[e.index];
      // Its own bed, unless a sleeper from before midnight still lies in it: then the first one nobody has.
      if (slot >= 0 && bedTaken(slot, e)) {
        slot = -1;
        for (let b = 0; b < beds.length && slot < 0; b++) if (!bedTaken(b, e)) slot = b;
      }
      if (slot < 0) return false;
      s.slot = slot;
      s.pose = SLEEP_POSES[fnv1a(`pose/${e.owner.traits.name}/${slot}`) % SLEEP_POSES.length];
      return true;
    };
    // The leg of its path nearest where it stands, so a trip resumed anywhere on the way carries on from there.
    const sleepLegFrom = (e) => {
      const s = e.sleep, p = e.root.position;
      let best = 0, nearest = Infinity;
      for (let i = 0; i < s.count; i++) {
        const d = Math.hypot(s.path[i * 2] - p.x, s.path[i * 2 + 1] - p.z);
        if (d < nearest) { nearest = d; best = i; }
      }
      return best;
    };
    const layDown = (e) => {
      const s = e.sleep, bed = ctx.sleep.slots[s.slot];
      e.heading = bed.heading; e.speed = 0; e.lounge = s.pose; e.loungeDepart = false; e.loungeHeading = bed.heading;
      e.footprintMode = "sit"; s.stage = "asleep"; s.mark = SLEEP_MARK * 0.5;
    };
    // True while sleep owns the entry this frame. False hands it back to the caller: to hide it (no bed to be had)
    // or to let the ordinary update walk it out of a cave, down from a roof or back to its bench first.
    const updateSleep = (e, dt, beforeX, beforeY, beforeZ) => {
      const s = e.sleep, p = e.root.position, site = ctx.sleep;
      if (!s.stage || s.stage === "return") {
        if (!e.active) {
          // First seen asleep: it is already in its bed.
          if (!reserveBed(e)) return false;
          const bed = site.slots[s.slot];
          activate(e, true);
          e.active = e.root.visible = true; e.parked = e.biped = false; e.mode = "sleeping"; e.phase = "sleep"; e.route = "";
          p.x = bed.x; p.y = bed.y; p.z = bed.z;
          // It knows the way home from the start, though it never walked here.
          s.count = site.path(s.slot, s.path); s.leg = s.count - 1;
          layDown(e);
          e.gorilla.poseManaged(2, p.x, p.y, p.z, e.heading, 0, false, false, e.lounge, e.motion);
          return true;
        }
        // Awake somewhere: what it holds goes back and it leaves any room by its door before it sets out.
        if (!s.stage && (e.lab.item >= 0 || e.motion.lab || e.jump.active || caveAt(p.x, p.y, p.z) >= 0 || e.phase === "leave" && e.route === "exit")) {
          // Its bench is free the moment its Ooga sleeps, though it still has the room to walk out of.
          if (e.mode !== "sleeping" && e.lab.item < 0) releaseLab(e);
          return "busy";
        }
        if (!reserveBed(e)) return false;
        releasePortal(e); releaseLab(e); clearWallSearch(e);
        e.hasSlot = false; e.pendingSite = -1; e.parked = false; e.rest = e.pound = e.beat = e.stand = 0;
        e.roam.departPending = false; e.roam.count = e.roam.index = 0;
        if (e.lounge) { leaveLounge(e); e.lounge = ""; e.loungeDepart = false; e.recover = Math.max(e.recover, 0.65); }
        e.mode = "sleeping"; e.phase = "sleep"; e.route = ""; e.exitFootprint = true;
        s.count = site.path(s.slot, s.path);
        s.leg = s.stage === "return" ? Math.min(s.count - 1, s.leg + 1) : sleepLegFrom(e);
        s.stage = "go"; s.stall = 0; s.near = Infinity;
      }
      if (s.stage === "go") {
        const last = s.leg >= s.count - 1, gx = s.path[s.leg * 2], gz = s.path[s.leg * 2 + 1], d = Math.hypot(gx - p.x, gz - p.z);
        if (d < (last ? SLEEP_ARRIVE : SLEEP_REACH)) {
          if (last) { s.stage = "settle"; e.speed = 0; }
          else { s.leg++; s.near = Infinity; }
        } else {
          // The first two points are the home island's own ground: a goal known to lie below lets a sleeper that
          // starts on a roof climb or hop down to it, as a stroller bound for the meadow does.
          setGoal(e, gx, last ? site.slots[s.slot].y : s.leg < 2 && ctx.surfaceAt ? ctx.surfaceAt(gx, gz) : p.y, gz);
          // A hop it has begun is finished, and it gets to its feet before it walks, as on any other errand.
          // A blocked walk marks itself as waiting at a doorway, which forbids a climb: a sleeper has no doorway.
          e.route = "";
          if (e.jump.active) updateJump(e, dt);
          else if (e.recover > 0) { e.recover = Math.max(0, e.recover - dt); e.speed = 0; }
          else move(e, dt, SPEED);
          // A way that cannot be walked is not a reason to stand in the forest all night: after a long stall the
          // sleeper is simply found in its bed.
          if (d < s.near - 0.25) { s.near = d; s.stall = 0; }
          else if (s.stall > 3 && !last && !e.jump.active && !e.climb.active && e.recover <= 0 && e.retry <= 0 && p.y > e.goalY + 0.8) {
            // Held up on high ground with the way on below it: hop down, as a stroller leaving a roof does.
            const desired = Math.atan2(gx - p.x, gz - p.z);
            e.retry = 1.2;
            for (let i = 0; i < STEERING.length; i++) if (tryJump(e, desired + STEERING[i] * e.turn)) { e.heading = desired + STEERING[i] * e.turn; break; }
            s.stall += dt;
          }
          else if ((s.stall += dt) > SLEEP_STALL) {
            // Placed, not walked: the pose is set outright, as a spawn's is, with no step to certify.
            const bed = site.slots[s.slot];
            p.x = bed.x; p.y = bed.y; p.z = bed.z; e.jump.active = false;
            layDown(e);
            e.gorilla.poseManaged(2, p.x, p.y, p.z, e.heading, 0, false, false, e.lounge, e.motion);
            return true;
          }
        }
      }
      if (s.stage === "settle") {
        const bed = site.slots[s.slot], turn = Math.atan2(Math.sin(bed.heading - e.heading), Math.cos(bed.heading - e.heading));
        e.speed = 0;
        e.heading += clamp(turn, -dt * 3, dt * 3);
        if (Math.abs(turn) < 0.05) layDown(e);
      }
      if (s.stage === "asleep") {
        e.speed = 0;
        // Slow breath in the chest, and a mark of sleep from its mouth now and then.
        e.gorilla.chest.scale.y = 1 + Math.sin(elapsed * 1.4 + e.index) * 0.018;
        if ((s.mark -= dt) <= 0 && ctx.sleep.mark) {
          s.mark = SLEEP_MARK;
          e.gorilla.mouth(SLEEP_MOUTH);
          ctx.sleep.mark(SLEEP_MOUTH.x, SLEEP_MOUTH.y + 0.25, SLEEP_MOUTH.z);
        }
      }
      poseEntry(e, dt, beforeX, beforeY, beforeZ);
      return true;
    };
    // Its Ooga is up: it rises and walks the same way home, then goes back to work or to its ease.
    const updateWake = (e, dt, beforeX, beforeY, beforeZ) => {
      const s = e.sleep, p = e.root.position;
      if (s.stage !== "return") {
        e.gorilla.chest.scale.y = 1;
        if (e.lounge) { e.lounge = ""; e.loungeDepart = false; e.recover = Math.max(e.recover, 1.2); }
        e.footprintMode = "walk";
        // Back along the path from the point nearest where it stands: its bed if it reached it.
        const at = sleepLegFrom(e);
        s.leg = Math.max(0, Math.hypot(s.path[at * 2] - p.x, s.path[at * 2 + 1] - p.z) < SLEEP_REACH ? at - 1 : at);
        s.stage = "return"; s.stall = 0; s.near = Infinity;
      }
      const gx = s.path[s.leg * 2], gz = s.path[s.leg * 2 + 1], d = Math.hypot(gx - p.x, gz - p.z);
      if (d < SLEEP_REACH || (s.stall += dt) > SLEEP_STALL) {
        s.stall = 0;
        // Home is the first point of the path, down the approach stair in the meadow: a gorilla is not left
        // standing at the bridge's head, where the walkers come and go.
        if (s.leg <= 0) {
          releaseBed(e);
          e.exitFootprint = false; e.mode = ""; e.phase = "chill"; e.route = ""; e.rest = 0;
          return false;
        }
        s.leg--; s.near = Infinity;
      } else {
        if (d < s.near - 0.25) { s.near = d; s.stall = 0; }
        setGoal(e, gx, p.y, gz);
        e.route = "";
        if (e.jump.active) updateJump(e, dt);
        else if (e.recover > 0) { e.recover = Math.max(0, e.recover - dt); e.speed = 0; }
        else move(e, dt, SPEED);
      }
      poseEntry(e, dt, beforeX, beforeY, beforeZ);
      return true;
    };
    // Rage shares the surface controller's support and collision contract.
    // Treating its supported, fitted limbs as a climbing hull rejected legal
    // steps off pebbles after the ordinary walking sweep had admitted them.
    const rageStepAllowed = (e, x, y, z, nx, ny, nz, fromHeading, heading) => {
      if (!Number.isFinite(ny) || ny > y + PROP_STEP) return false;
      if (ny < y - PROP_STEP) {
        const terrain = ctx.terrainSupportAt
          ? ctx.terrainSupportAt(e, x, z, y, STEP, fromHeading) : groundAt(x, z, y);
        // A tall object has no wall descent to reserve. Prove a clear fall
        // onto real land, then let the normal gravity controller take over.
        // A captive instead needs the explicitly swept jump/climb route.
        if (e.motion.dragging || y - terrain <= 0.02 || !actorLanding(e, nx, ny, nz)
          || !propStepClear(e, x, y, z, nx, ny, nz, fromHeading, heading)) return false;
      }
      return ctx.rageDragClear(e, x, y, z, nx, ny, nz, heading, fromHeading);
    };
    const rageLegClear = (e, x, y, z, nx, ny, nz, fromHeading, heading) => {
      const turn = Math.atan2(Math.sin(heading - fromHeading), Math.cos(heading - fromHeading));
      // Planning may sample support more coarsely: each complete segment is
      // still swept, while live 12 m/s movement keeps the 0.1 m integration step.
      const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, nz - z) / 0.25), Math.ceil(Math.abs(turn) / 0.15));
      let px = x, py = y, pz = z, facing = fromHeading;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, tx = x + (nx - x) * t, tz = z + (nz - z) * t, nextHeading = fromHeading + turn * t;
        const ty = support(e, tx, tz, py, PROP_STEP, nextHeading);
        if (!rageStepAllowed(e, px, py, pz, tx, ty, tz, facing, nextHeading)
          || occupied(e, tx, ty, tz, true, nextHeading)
          || !propStepClear(e, px, py, pz, tx, ty, tz, facing, nextHeading)) return false;
        px = tx; py = ty; pz = tz; facing = nextHeading;
      }
      return Math.abs(py - ny) < 0.1;
    };
    const rageGroundStep = (e, x, z, heading) => {
      const p = e.root.position, y = support(e, x, z, p.y, PROP_STEP, heading);
      if (!rageStepAllowed(e, p.x, p.y, p.z, x, y, z, e.heading, heading)) return false;
      const falling = y < p.y - PROP_STEP;
      if (falling) {
        // Step clear of the support and fall vertically; a fast pursuit must
        // never turn a prop departure into an unchecked launch off the island.
        e.drive.vx = e.drive.vz = 0; e.drive.run = false;
      }
      return drivenGroundStep(e, x, z, heading, PROP_STEP, falling);
    };
    const rageWalk = (e, dt, x, y, z, heading) => {
      const p = e.root.position, r = e.rage, startX = p.x, startZ = p.z;
      if (elapsed >= r.slideUntil) r.slideSide = 0;
      const distance = Math.hypot(x - p.x, z - p.z), step = Math.min(distance, dt * RAGE_SPEED);
      const count = Math.max(1, Math.ceil(step / RAGE_STEP)), tick = dt / count;
      let moved = false;
      for (let i = 0; i < count; i++) {
        const dx = x - p.x, dz = z - p.z, remaining = Math.hypot(dx, dz);
        const travel = Math.min(remaining, RAGE_SPEED * tick), fraction = remaining > 1e-7 ? travel / remaining : 0;
        const turn = Math.atan2(Math.sin(heading - e.heading), Math.cos(heading - e.heading));
        const facing = e.heading + clamp(turn, -5 * tick, 5 * tick), nx = p.x + dx * fraction, nz = p.z + dz * fraction;
        if (rageGroundStep(e, nx, nz, facing)
          // As with ordinary control, a tight turn must not trap a walker on
          // its own support when translation with the old facing is clear.
          || Math.abs(facing - e.heading) > 1e-6 && rageGroundStep(e, nx, nz, e.heading)) moved = true;
        else {
          // Slide the same posed body around a trunk without first swinging
          // its captive into it. Retain the successful side until the direct
          // route has stayed clear; every candidate still sweeps live solids.
          let slid = false;
          const side = r.slideSide || (e.index & 1 ? -1 : 1);
          for (let attempt = 0; remaining > 1e-7 && attempt < 4; attempt++) {
            const sign = attempt < 2 ? side : -side, tangent = attempt & 1;
            const along = tangent ? 0.15 : 0.5, across = tangent ? 0.9886859966642595 : 0.8660254037844386;
            const reach = Math.min(travel, remaining * along), sx = dx / remaining, sz = dz / remaining;
            if (rageGroundStep(e, p.x + (sx * along + sz * across * sign) * reach,
              p.z + (sz * along - sx * across * sign) * reach, e.heading)) {
              r.slideSide = sign; r.slideUntil = elapsed + 0.75; moved = slid = true; break;
            }
          }
          if (!slid) {
            if (Math.abs(facing - e.heading) > 1e-6 && rageGroundStep(e, p.x, p.z, facing)) moved = true;
            break;
          }
        }
        if (e.drive.airborne) break;
      }
      e.speed = Math.hypot(p.x - startX, p.z - startZ) / dt;
      return moved;
    };
    const rageTraverse = (e, x, y, z) => {
      if (e.climb.active || e.jump.active || e.drive.airborne) return false;
      const p = e.root.position, carrying = e.motion.dragging, heading = Math.atan2(x - p.x, z - p.z);
      if (!carrying && y <= p.y + 0.75) return false;
      setGoal(e, x, y, z);
      e.rageTraversal = true;
      try {
        let takeoffClear = true;
        if (carrying && ctx.rageJumpPoseClear) {
          // rage.update poses the takeoff immediately, before updateJump's
          // first arc step. Prove that transition without activating a jump
          // or changing its counters/envelope on refusal.
          const takeoff = e.motion.takeoff;
          e.motion.takeoff = 1;
          takeoffClear = ctx.rageJumpPoseClear(e, e.motion.labDt, p.x, p.y, p.z, e.speed, true) !== false;
          e.motion.takeoff = takeoff;
        }
        const sx = Math.sin(heading), sz = Math.cos(heading), remaining = Math.hypot(x - p.x, y - p.y, z - p.z);
        const reach = Math.min(MAX_JUMP, Math.hypot(x - p.x, z - p.z) + 1);
        const ceiling = carrying ? p.y + PROP_STEP : Math.min(p.y + ROOF_JUMP_HEIGHT, y);
        // Prefer a real landing toward the target, including below a held
        // captive. The existing jump proof certifies the full gravity arc.
        for (let distance = reach; takeoffClear && distance >= 1; distance -= 0.5) {
          const nx = p.x + sx * distance, nz = p.z + sz * distance;
          const ny = support(e, nx, nz, ceiling, 0.02, heading);
          if (!Number.isFinite(ny) || !carrying && ny <= p.y + 0.5
            || Math.hypot(x - nx, y - ny, z - nz) >= remaining - 0.35
            || Math.abs(pointSupportAt(nx, nz, ny + 0.02, e) - ny) > 0.1) continue;
          if (prepareJump(e, nx, ny, nz, 0, false, true) || prepareJump(e, nx, ny, nz)) {
            e.climb.searchPending = e.climb.searchDeferred = e.climb.claimPending = false;
            e.motion.takeoff = 1; return true;
          }
        }
        return carrying && tryClimb(e, heading, y < p.y - 0.8);
      } finally { e.rageTraversal = false; }
    };
    const resetRageWarp = e => {
      // Clear old movement without releasing the newly captured Ooga.
      // The brief wall visit has no supporting floor; its return is checked.
      clearWallSearch(e); releasePortal(e); releaseLab(e);
      if (climbTurn === e.index) climbTurn = -1;
      if (labEscape === e) { e.stuck.escapeLeft = 0; labEscape = null; }
      const c = e.climb, d = e.drive, m = e.motion, jump = e.jump, p = e.root.position;
      c.active = c.free = c.lipBypass = c.mountPending = c.holdPose = c.waitRelease = false;
      c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = c.claimRetreat = false;
      c.openingExit = c.openingStagePending = c.departurePlanning = c.peerCheck = false;
      c.debugStuck = c.debugTraverse = false; c.debugRole = -1;
      c.count = c.index = c.claimOrder = c.claimOwnerOrder = c.searchCursor = c.handoffDirection = 0;
      c.retry = c.airAttachAfter = c.blocked = 0; c.claimFor = c.autoTo = -1;
      jump.active = jump.reverse = jump.wall = jump.caveExit = false; jump.progress = jump.blocked = 0;
      d.x = d.z = d.vx = d.vy = d.vz = d.climbAxis = d.climbSide = d.jumps = 0;
      d.jumpHeld = d.jumpDown = d.jumpPressed = d.airborne = d.passiveFall = d.resume = d.motionEnvelope = false;
      d.run = d.wallRelease = d.cancelled = false; d.grounded = true;
      d.jumpBuffer = d.motionRecover = d.climbTurnTimer = d.avoidTime = d.avoidSide = 0;
      d.heading = d.climbExitHeading = d.climbExitLook = NaN;
      m.takeoff = m.landing = m.climb = m.climbDirection = m.climbSide = m.mantle = m.openingSettle = 0;
      m.climbBlend = m.climbGripX = m.climbGripY = m.climbGripZ = NaN;
      m.climbGripRelease = m.supportOffset = m.swim = m.groom = m.poundCharge = 0;
      m.verifyGrip = m.workExit = e.actionControlled = m.smash = false;
      e.debugMove.active = e.debugMove.wallPending = false;
      e.roam.count = e.roam.index = 0; e.roam.departPending = e.roam.propDeparture = false;
      e.lounge = ""; e.loungePartner = null; e.loungeDepart = e.parked = e.biped = e.hasSlot = false;
      e.speed = e.rest = e.pound = e.beat = e.stand = e.recover = e.blocked = e.retry = e.backoutLeft = 0;
      e.phase = "rage"; e.route = ""; e.entryTurn = e.exitFootprint = e.rageTraversal = false;
      e.footprintMode = "walk"; m.walkGait = "gallop"; m.walkPhase = NaN;
      syncLab(e);
      // Match the hub's settled destination and hull-preview pose passes.
      m.workExit = true;
      if (e.capture?.warpVisit) ctx.rageWarpPose(e);
      else {
        e.gorilla.poseManaged(2, p.x, p.y, p.z, e.heading, 0, false, false, "", m);
        e.gorilla.poseManaged(2, p.x, p.y, p.z, e.heading, 0, false, false, "", m);
      }
      m.workExit = false;
      setGoal(e, p.x, p.y, p.z);
      e.compact = e.gorilla.compact;
      e.radius = Math.max(WALK_RADIUS, e.gorilla.bodyRadius + 0.1);
      e.height = Math.max(WALK_HEIGHT, e.gorilla.bodyHeight + 0.04);
      return true;
    };
    const rageWarpTarget = (e, target) => !!ctx.rageWarpTarget && ctx.rageWarpTarget(e, target) && resetRageWarp(e);
    const rageWarpHome = e => !!ctx.rageWarpHome && ctx.rageWarpHome(e) && resetRageWarp(e);
    if (ctx.rageLandAt) rage = BL.clankerRage.create({ list, crew, debugRage: ctx.debugRage,
      landAt: ctx.rageLandAt, floorAt: (e, x, z, y, heading) => support(e, x, z, y, PROP_STEP, heading),
      legClear: rageLegClear, edgeAt: ctx.rageEdgeAt, edgeHeading: ctx.rageEdgeHeading, edgeGoal: ctx.rageEdgeGoal,
      walk: rageWalk, traverse: rageTraverse, warpRequired: ctx.rageWarpRequired, warpTarget: rageWarpTarget,
      warpHome: ctx.rageWarpHome ? rageWarpHome : null,
      huntRange: ctx.rageHuntRange, huntJumpRange: MAX_JUMP, huntJumpHeight: ROOF_JUMP_HEIGHT,
      captureEligible: ctx.rageCaptureEligible, approach: ctx.rageApproach, grab: ctx.rageGrab, captive: ctx.rageCaptive,
      release: ctx.rageRelease, throw: ctx.rageThrow, throwing: e => !!e.capture?.throwing,
      traversing: e => e.climb.active || e.jump.active || e.drive.airborne || e.drive.resume,
      suspended: e => e.motion.swim > 0 || e.fire.burning || e.fire.rolling || e.fire.rollRecover > 0
        || e.loungeDepart || e.recover > 0 && !e.motion.dragging,
      retarget: e => {
        const c = e.climb;
        clearWallSearch(e);
        e.debugMove.active = e.debugMove.wallPending = false;
        c.searchPending = c.searchDeferred = c.claimPending = c.crestPending = c.claimRetreat = false;
        c.claimOrder = c.searchCursor = 0; c.claimFor = c.autoTo = -1;
        c.debugStuck = c.debugTraverse = c.waitRelease = false; c.debugRole = -1;
        if (climbTurn === e.index) climbTurn = -1;
        // Both rail and free climbs share this release into the checked fall
        // controller. Keep the root in place and leave existing flights alone.
        if (c.active && !e.jump.active && !e.drive.airborne) {
          dropRectangleClimb(e, false);
          // Landing rearms automatic grips. Until then, neither a wall nor
          // a lower balcony should resume the abandoned climb.
          c.airAttachAfter = Infinity;
        }
      },
      begin: e => {
        clearWallSearch(e); releasePortal(e); releaseLab(e);
        if (labEscape === e) { e.stuck.escapeLeft = 0; labEscape = null; }
        e.debugMove.active = false; e.roam.count = e.roam.index = 0; e.roam.departPending = false;
        if (e.lounge) leaveLounge(e);
        e.phase = "rage"; e.route = ""; e.rest = e.pound = e.beat = e.stand = 0; e.hasSlot = false;
        e.motion.groom = e.motion.poundCharge = 0; e.parked = false;
        syncLab(e);
      },
      end: (e, debug) => {
        e.speed = 0; e.biped = false; e.motion.walkGait = "";
        e.roam.count = e.roam.index = 0; e.rest = 0; e.phase = "chill"; e.route = "";
        setGoal(e, e.root.position.x, e.root.position.y, e.root.position.z);
        // A contributor activity change is handled by normal updateEntry on
        // the same step. Airborne bodies retain their existing fall controller.
        // Debug can also interrupt a worker; resume its ordinary task when
        // the shared movement controller next reaches supported ground.
        if (debug) e.drive.resume = true;
        syncLab(e);
      }
    });
    const updateEntry = (e, dt) => {
      // Expiry, health and account/activity cancellation precede regeneration
      // and every movement controller, including swimming or climbing.
      if (rage) rage.check(e, elapsed);
      // A certified cliff warp during check starts a new local movement step;
      // its final pose must not sweep or roll back to the previous location.
      const p = e.root.position, beforeX = p.x, beforeY = p.y, beforeZ = p.z;
      const beforeSupportOffset = e.motion.supportOffset;
      if (e.health.delay > 0) e.health.delay = Math.max(0, e.health.delay - dt);
      else if (e.health.value < e.health.max) e.health.value = Math.min(e.health.max, e.health.value + BL.crew.HEALTH_REGEN_RATE * dt);
      e.motion.labDt = dt;
      e.motion.walkPhase = NaN;
      e.motion.walkGait = e.controlled ? e.drive.run ? "gallop" : "knuckle" : e.rage.active ? "gallop" : "";
      if (!e.climb.active) e.motion.climbSide = 0;
      syncLab(e);
      e.motion.takeoff = Math.max(0, e.motion.takeoff - dt * 5);
      e.motion.landing = Math.max(0, e.motion.landing - dt * 5);
      e.retry = Math.max(0, e.retry - dt);
      e.climb.retry = Math.max(0, e.climb.retry - dt);
      if (e.controlled || e.mode !== "chilling" || e.fire.burning) e.motion.groom = 0;
      if (e.controlled || e.fire.burning) e.loungeDepart = false;
      e.parkFor = Math.max(0, e.parkFor - dt);
      // An Ooga asleep sends its gorilla to bed, not away. "busy" lets the rest of this update walk it out of a
      // room or put its work down first; with no bed to be had it is hidden as it always was.
      const bedtime = ctx.sleep && sleeps(e.owner) && !e.controlled && !e.drive.airborne && !e.fire.rolling && !e.fire.burning && !e.climb.active
        ? updateSleep(e, dt, beforeX, beforeY, beforeZ) : false;
      if (bedtime === true) return;
      if (!bedtime && !alive(e.owner) && !e.controlled && !e.drive.airborne && !e.fire.rolling && !e.climb.active) {
        if (e.active) {
          releaseBed(e);
          releasePortal(e);
          releaseLab(e);
          e.active = e.root.visible = e.hasSlot = e.jump.active = false;
          e.debugMove.active = e.debugMove.cancelled = false; e.debugMove.status = "";
          clearWallSearch(e);
          e.overflow = false;
          if (e.tracked && ctx.untrack) ctx.untrack(e);
          e.tracked = false;
        }
        return;
      }
      if (!e.active) { if (!e.retry) activate(e); return; }
      if (e.sleep.stage && !sleeps(e.owner) && alive(e.owner) && !e.controlled && !e.drive.airborne && !e.fire.rolling && !e.fire.burning && !e.climb.active
        && updateWake(e, dt, beforeX, beforeY, beforeZ)) return;
      if (ctx.fireContact && ctx.fireContact(e, p.x, p.y, p.z)) ignite(e);
      updateFire(e, dt);
      if (rage && e.rage.active && e.fire.burning) rage.check(e, elapsed);
      if (rage && e.rage.active && e.rage.warpWaiting && !e.climb.active && !e.jump.active && !e.drive.airborne) {
        // Failed endpoint admission keeps the last coherent pose in place.
        // A jump or fall already under way finishes first; check() has
        // released any climb into that same checked fall.
        e.speed = 0; return;
      }
      if (e.climb.active) {
        // Shift doubles distance, not the size of a single grip/stone sweep.
        // Two half-frame proofs keep the fast climb as reliable as the walk.
        if (e.controlled && e.drive.run) {
          updateClimb(e, dt * 0.5);
          if (e.climb.active) updateClimb(e, dt * 0.5);
        } else updateClimb(e, dt);
        poseEntry(e, dt, beforeX, beforeY, beforeZ); return;
      }
      if (e.controlled || e.drive.airborne || e.drive.resume) {
        updateDriven(e, dt); poseEntry(e, dt, beforeX, beforeY, beforeZ); return;
      }
      // Breakable scenery can disappear between the final climb sample and
      // the grounded handoff. Re-read live support before any idle/work logic;
      // an unsupported gorilla falls now instead of waiting at the old height.
      const liveFloor = support(e, p.x, p.z, p.y, PROP_STEP);
      const centerFloor = pointSupportAt(p.x, p.z, p.y + 0.1, e);
      // Blended short-prop support can sit below the point top. Falling in
      // place would land on that same blend every frame and prevent departure.
      if (!e.jump.active && !e.fire.rolling && Number.isFinite(liveFloor)
        && (liveFloor < p.y - STEP || centerFloor < p.y - STEP && p.y - liveFloor <= STEP && !raisedSupport(e))
        && beginSupportFall(e, p.x, p.z, e.heading, 0, 0)) {
        updateDriven(e, dt); poseEntry(e, dt, beforeX, beforeY, beforeZ); return;
      }
      if (!e.jump.active && !e.fire.rolling && Number.isFinite(liveFloor)
        && liveFloor >= p.y - STEP && liveFloor <= p.y + PROP_STEP) setSupportY(e, liveFloor, p.x, p.z, e.heading, dt * 3);
      if (e.fire.rolling || escapeForRoll(e, dt)) { poseEntry(e, dt, beforeX, beforeY, beforeZ); return; }
      if (fleeFire(e, dt)) { poseEntry(e, dt, beforeX, beforeY, beforeZ); return; }
      if (rage && e.rage.active) {
        e.phase = "rage"; e.biped = false;
        let advanced = false;
        // Physical transitions retain their controllers, but must not fall
        // through to a queued cave job while the chase is temporarily paused.
        if (e.jump.active) updateJump(e, dt);
        else if (e.loungeDepart) departLounge(e, dt);
        else if (e.recover > 0) {
          e.recover = Math.max(0, e.recover - dt); e.speed = 0;
          if (!e.recover) e.actionControlled = e.motion.smash = false;
        } else {
          e.footprintMode = "walk"; e.compact = e.gorilla.compact;
          e.radius = Math.max(WALK_RADIUS, e.gorilla.bodyRadius + 0.1);
          e.height = Math.max(WALK_HEIGHT, e.gorilla.bodyHeight + 0.04);
          e.motion.walkGait = "gallop";
          advanced = rage.update(e, dt, elapsed);
          if (!advanced) e.speed = 0;
        }
        const posed = poseEntry(e, dt, beforeX, beforeY, beforeZ) !== false;
        if (!posed) e.motion.supportOffset = beforeSupportOffset;
        if (advanced) rage.poseResult(e, dt, elapsed, posed);
        // A held grab claims new body contact before the crew's floor pass
        // can step the target onto this frame's moving gorilla mesh.
        rage.contact(e, elapsed); return;
      }
      if (separateSurfacePeers(e, dt)) { poseEntry(e, dt, beforeX, beforeY, beforeZ); return; }
      if (e.motion.lab && e.lab.item >= 0 && (e.mode !== e.owner.state || e.pendingSite >= 0 && e.pendingSite !== e.site)) {
        if (e.lab.stage !== "return") { e.lab.stage = "return"; e.lab.reach = 0; }
        workLab(e, dt); poseEntry(e, dt, beforeX, beforeY, beforeZ); return;
      }
      if (e.debugMove.active) {
        updateDebugMove(e, dt);
        poseEntry(e, dt, beforeX, beforeY, beforeZ); return;
      }
      if (e.pendingSite >= 0 && e.lab.item < 0 && e.mode === "working" && e.owner.state === "working") {
        const site = e.pendingSite; e.pendingSite = -1; beginTravel(e, site);
      }
      if (e.mode !== e.owner.state) {
        e.roam.departPending = false;
        releasePortal(e);
        e.lab.yielding = 0; e.lab.yieldFor = null; e.lab.yieldReady = false;
        if (e.lounge) leaveLounge(e);
        e.mode = e.owner.state; e.hasSlot = false;
        if (e.mode === "working") beginTravel(e, e.owner.work.plannedSite >= 0 ? e.owner.work.plannedSite : e.owner.work.site);
        else {
          e.fromSite = caveAt(p.x, p.y, p.z);
          if (e.fromSite >= 0) { e.phase = "leave"; e.route = "exit"; }
          else { e.phase = "chill"; e.rest = 0; chooseChill(e); }
        }
      }
      if (autonomousChill(e) && !chillCaveClear(p.x, p.y, p.z)) {
        e.rest = 0;
        if (e.lounge) leaveLounge(e);
        if (!chillCaveClear(e.goalX, e.goalY, e.goalZ)
          || Math.hypot(e.goalX - p.x, e.goalZ - p.z) < 0.15) chooseChill(e);
      }
      if (e.exitFootprint) {
        // Clearing the arch does not instantly make space for the relaxed
        // lounge envelope. Keep the walking limb chain until nearby leavers
        // have separated far enough for the larger idle footprint.
        const compact = e.compact;
        e.compact = false;
        if (staticClear(e, p.x, p.y, p.z) && !occupied(e, p.x, p.y, p.z)) e.exitFootprint = false;
        else e.compact = compact;
      }
      // Outside a work room the gait always stays on all fours. Standing is
      // a brief idle action inside, never a narrow-door collision workaround.
      e.biped = e.motion.lab && !e.motion.labRunIn || e.parked || e.phase === "work" && (e.stand > 0 || e.beat > 0);
      if (e.parked && e.gorilla.standCompact) e.footprintMode = "stand";
      else if (!e.parked && e.footprintMode === "stand" && e.gorilla.compact) e.footprintMode = "walk";
      else if (e.phase === "chill" && !e.exitFootprint && !e.gorilla.motionActive && e.gorilla.compact
        && !e.jump.active && !e.pound && !e.beat && !e.stand) e.footprintMode = "walk";
      e.drive.motionRecover = Math.max(0, e.drive.motionRecover - dt);
      const seated = e.lounge === "sit" && e.gorilla.sitCompact && Math.abs(e.speed) <= 0.1;
      if (seated) e.footprintMode = "sit";
      else if (e.footprintMode === "sit") e.footprintMode = "walk";
      e.compact = (seated || e.mode === "working" || e.phase === "leave" || e.parked || e.exitFootprint || e.phase === "chill" && (!e.lounge || e.lounge === "sit" || Math.abs(e.speed) > 0.1))
        && !e.jump.active && !e.gorilla.motionActive
        && !e.fire.rollRecover && !e.drive.motionRecover && !(e.drive.motionEnvelope && e.gorilla.motionActive)
        && (seated || (e.footprintMode === "stand" ? e.gorilla.standCompact : e.footprintMode === "pound" ? e.gorilla.poundCompact : e.gorilla.compact));
      const gestureRadius = (e.fire.rollRecover > 0 || e.drive.motionRecover > 0 || e.drive.motionEnvelope && e.gorilla.motionActive) ? MOTION_RADIUS : e.pound > 0 ? 2.25 : e.jump.active ? AIR_RADIUS : WALK_RADIUS;
      e.radius = Math.max(gestureRadius, e.gorilla.bodyRadius + 0.1);
      const gestureHeight = (e.fire.rollRecover > 0 || e.drive.motionRecover > 0 || e.drive.motionEnvelope && e.gorilla.motionActive) ? MOTION_HEIGHT : e.lounge || e.recover > 0 ? 2.7
        : e.parked || e.pound > 0 || e.beat > 0 || e.stand > 0 ? 2.6 : WALK_HEIGHT;
      e.height = Math.max(gestureHeight, e.gorilla.bodyHeight + 0.04);
      e.foot = FOOT;
      labEnvelope(e);
      if (!enteringCave(e) && (stepLabEscape(e, dt) || labEscape && labEscape !== e && e.motion.lab && e.stuck.time >= 0.65
        && !labWorker(e) && Math.hypot(p.x - labEscape.root.position.x, p.z - labEscape.root.position.z) < 3)) {
        if (labEscape !== e) e.speed = 0;
        poseEntry(e, dt, beforeX, beforeY, beforeZ); return;
      }
      if (e.jump.active) updateJump(e, dt);
      else if (e.loungeDepart) departLounge(e, dt);
      else if (e.recover > 0) {
        e.recover = Math.max(0, e.recover - dt); e.speed = 0;
        if (!e.recover) e.actionControlled = e.motion.smash = false;
      } else if (e.beat > 0 || e.stand > 0) {
        e.beat = Math.max(0, e.beat - dt); e.stand = Math.max(0, e.stand - dt); e.speed = 0;
        if (!e.beat && !e.stand) {
          e.recover = 0.45; e.rest = 0.6;
          if (e.phase === "work" && reserve(e, true)) setGoal(e, e.slotX, e.slotY, e.slotZ);
        }
      } else if (e.pound > 0) {
        e.pound = Math.max(0, e.pound - dt); e.speed = 0;
        if (!e.poundHit && e.pound <= 0.22) {
          e.poundHit = true; e.pounds++;
          if (ctx.onPound) ctx.onPound(e);
          if (e.actionControlled && ctx.onSmash) ctx.onSmash(e);
        }
        if (e.pound <= 0) {
          e.recover = 0.35;
          e.rest = 0.6 + e.random() * 0.4;
          if (e.phase === "work") {
            if (reserve(e, true)) setGoal(e, e.slotX, e.slotY, e.slotZ);
          }
        }
      } else if (e.lab.yielding) {
        yieldLab(e, dt);
      } else if (e.phase === "travel" || e.phase === "leave") {
        if (e.parked) {
          e.speed = 0;
          const passage = e.fromSite < 0 || claimPortal(e, e.fromSite);
          if (passage && expandGesture(e, WALK_RADIUS)) { e.parked = false; e.recover = 0.55; }
          else if (passage && e.gorilla.standCompact && e.fromSite >= 0) {
            // Walk upright through the room's central aisle. The
            // full quadruped envelope must fit before crossing the entrance.
            sitePoint(sites[e.fromSite], 0, -0.9, POINT);
            setGoal(e, POINT.x, POINT.y, POINT.z);
            move(e, dt, 0.6);
          }
        } else if (travelGoal(e, dt)) {
          if (!e.jump.active) {
            // A short prop can lift the feet above the ground-level goal too.
            // Keep its supported exit on the ordinary steered walker.
            if (e.route === "apron" && p.y > e.goalY + 0.8 && !raisedSupport(e) && caveAt(p.x, p.y, p.z) < 0)
              runDownhill(e, dt, Math.atan2(e.goalX - p.x, e.goalZ - p.z));
            else if (enteringAisle(e)) moveEntryAisle(e, dt);
            else if (e.motion.lab && !e.motion.labRunIn && (e.fromSite === labSite && e.route === "exit"
              || e.site === labSite && (e.route === "enter" || e.phase === "work"))) moveLab(e, dt);
            else move(e, dt, e.mode === "chilling" ? CHILL_SPEED : SPEED);
          }
        }
        else { e.speed = damp(e.speed, 0, 12, dt); }
      } else if (e.phase === "work") {
        if (e.motion.lab) workLab(e, dt);
        else if (sites[e.site].mirrorRoom) {
          // Mirror-room clankers run side to side on alternating depth lanes.
          // Pause at each turn and rear up to beat the chest every fifth run.
          // Keep each run inside the glass and reserve its destination first.
          if (Math.hypot(e.goalX - p.x, e.goalZ - p.z) > 0.18) move(e, dt, SPEED * 1.3);
          else {
            e.speed = damp(e.speed, 0, 12, dt); e.rest -= dt;
            if (e.rest <= 0) {
              const beatTurn = (e.workCycle + 1) % 5 === 0;
              if (beatTurn && Math.abs(e.speed) >= 0.05) e.rest = 0.1;
              else {
                e.workCycle++;
                if (beatTurn && expandGesture(e, 1.55) && e.gorilla.beat()) {
                  e.biped = true; e.beat = BL.agent.MANAGED_BEAT_TIME; e.beats++;
                } else if (reserve(e, true)) {
                  setGoal(e, e.slotX, e.slotY, e.slotZ);
                  e.rest = e.workCycle % 5 === 4 ? 0.8 + e.random() * 0.5 : 0.3 + e.random() * 0.35;
                } else e.rest = 0.25;
              }
            }
          }
        }
        else if (e.parked) {
          e.speed = 0; e.rest -= dt;
          if (!e.parkFor && e.rest <= 0) {
            e.rest = 0.75;
            if (expandGesture(e, WALK_RADIUS)) {
              e.parked = false; e.recover = 0.55;
              if (reserve(e, true)) setGoal(e, e.slotX, e.slotY, e.slotZ);
            }
          }
        } else if (Math.hypot(e.goalX - p.x, e.goalZ - p.z) > 0.18) move(e, dt, SPEED * 0.85);
        else {
          e.speed = damp(e.speed, 0, 12, dt); e.rest -= dt;
          if (e.rest <= 0) {
            const cycle = e.workCycle % 6;
            if (cycle === 2 && Math.abs(e.speed) < 0.05 && expandGesture(e, 1.55) && e.gorilla.beat()) {
              e.beat = BL.agent.MANAGED_BEAT_TIME; e.beats++; e.workCycle++;
            } else if (cycle === 4 && expandGesture(e, 1.55)) {
              e.stand = 0.9; e.workCycle++;
            } else if (cycle === 5 && prepareJump(e, p.x, p.y, p.z, 0.35)) {
              e.rest = 0.5; e.workCycle++;
              if (reserve(e, true)) setGoal(e, e.slotX, e.slotY, e.slotZ);
            } else if (expandGesture(e, 2.25) && e.gorilla.pound()) {
              e.activity = Math.max(0, e.activity - 3); e.pound = BL.agent.POUND_TIME; e.poundHit = false;
              e.workCycle++;
            } else {
              e.rest = 0.4;
              if (reserve(e, true)) setGoal(e, e.slotX, e.slotY, e.slotZ);
            }
          }
        }
      } else {
        if (Math.hypot(e.goalX - p.x, e.goalZ - p.z) > 0.025 || Math.abs(e.goalY - p.y) > 0.55) moveRoam(e, dt);
        else if (raisedSupport(e) && choosePropExit(e)) move(e, dt, CHILL_SPEED);
        else {
          e.speed = damp(e.speed, 0, 12, dt);
          if (!e.roam.departPending && !e.exitFootprint && !e.lounge
            && (!ctx.restSiteClear || ctx.restSiteClear(e, p.x, p.y, p.z, e.heading))
            && grass(p.x, p.y, p.z, e.loungePartner ? 0.9 : FOOT) && alignLounge(e, dt)) {
            let pose = e.loungePartner ? "sit" : e.roam.pose || loungePose(e);
            let fits = restTransitionClear(e, pose, dt);
            // A reclining pose may need more room than the approach. Sitting
            // is a supported alternative at the same destination, not another
            // trip across the clearing to discover the same obstruction.
            if (!fits && pose !== "sit") { pose = "sit"; fits = restTransitionClear(e, pose, dt); }
            if (fits) {
              e.speed = 0; e.lounge = pose; e.roam.arrived = true; e.roam.alignTime = 0;
              if (e.rest <= 0) e.rest = CHILL_REST_SECONDS + e.random() * CHILL_REST_VARIATION;
            } else { e.roam.alignTime += dt; if (e.roam.alignTime > 0.5) e.rest = 0; }
          }
          if (e.lounge) e.rest = Math.max(0, e.rest - dt);
          else if (!e.loungeDepart) { e.roam.alignTime += dt; if (e.roam.alignTime > 1.5) e.rest = 0; }
          if (e.rest <= 0) chooseChill(e);
        }
        groomLounge(e, dt);
      }
      poseEntry(e, dt, beforeX, beforeY, beforeZ);
    };
    const recoverStall = (e, dt) => {
      // Debug inspection keeps a previously commanded actor visible even
      // after cancellation and dismount. Ordinary collision-safe wandering
      // still runs; a stall must not silently relocate or hide this actor.
      if (e.debugMove.active || e.debugMove.cancelled || e.climb.debugRole >= 0 && e.climb.active) return;
      // A sleeper lies still on purpose, and its trip keeps its own watch for a stall.
      if (e.sleep.stage) return;
      const p = e.root.position, s = e.stuck, job = e.lab, r = e.roam;
      if (e.fire.panic.active) {
        s.x = p.x; s.y = p.y; s.z = p.z; s.time = s.taskTime = 0; s.taskActive = false;
        return;
      }
      const invalidRest = e.active && !e.controlled && e.phase === "chill" && Math.abs(e.speed) < 0.1
        && !e.fire.burning && !e.fire.rolling && !e.pound && !e.beat
        && !grass(p.x, p.y, p.z, e.loungePartner ? 0.9 : FOOT);
      if (!invalidRest || !Number.isFinite(s.invalidX) || Math.hypot(p.x - s.invalidX, p.z - s.invalidZ) > 0.5) {
        s.invalidTime = 0; s.invalidX = p.x; s.invalidZ = p.z;
      } else s.invalidTime += dt;
      const invalidExpired = s.invalidTime >= 8 && !e.climb.active && !e.jump.active && !e.drive.airborne;
      if (!e.active || e.controlled || e.phase !== "chill") r.departPending = false;
      if (r.departPending && Math.hypot(p.x - r.departX, p.y - r.departY, p.z - r.departZ) > 0.15) {
        r.departX = p.x; r.departY = p.y; r.departZ = p.z; r.departAt = elapsed;
      }
      const departureStalled = r.departPending && elapsed - r.departAt > 1.5;
      const station = labStations[job.station], goalDistance = Math.hypot(e.goalX - p.x, e.goalZ - p.z);
      const desired = job.pathFixed && job.pathCount ? job.pathHeading
        : !job.yielding && !job.pathPartial && e.route !== "exit" && station && goalDistance <= 0.800001 && job.pathIndex + 1 >= job.pathCount
        ? station.heading : Math.atan2(e.goalX - p.x, e.goalZ - p.z);
      const turnError = Math.abs(Math.atan2(Math.sin(desired - e.heading), Math.cos(desired - e.heading)));
      const stageChanged = job.stage !== s.workStage || job.item !== s.workItem;
      if (stageChanged) s.workReach = 0;
      const doingWork = job.cycles !== s.workCycles || !!e.motion.labWork && s.workTime > 0 && job.time < s.workTime - 1e-7
        || Math.min(job.reach, 0.8) > s.workReach + 1e-7;
      const progressed = Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) >= 0.35
        || doingWork
        || e.climb.searchPending && e.climb.searchCursor > s.searchCursor
        || Math.abs(e.heading - s.heading) > 1e-7 && (e.phase === "chill" || turnError < s.turnError - 1e-7);
      s.workTime = job.time; s.workCycles = job.cycles; s.workReach = Math.max(s.workReach, Math.min(job.reach, 0.8));
      s.workStage = job.stage; s.workItem = job.item; s.turnError = turnError;
      s.searchCursor = e.climb.searchCursor; s.heading = e.heading;
      const away = Math.hypot(e.goalX - p.x, e.goalZ - p.z) > 0.18 || Math.abs(e.goalY - p.y) > 0.55;
      const resting = !r.departPending && !e.loungeDepart && (e.lounge && e.rest > 0 || !e.motion.lab && !away && e.rest > 0
        || e.motion.lab && e.phase === "work" && job.station < 0 && job.arrived && !away);
      const wantsMove = r.departPending || e.loungeDepart || e.climb.active || e.climb.searchPending || e.jump.active || e.drive.airborne
        || e.phase === "travel" || e.phase === "leave" || e.motion.lab && e.phase === "work" || away;
      // Escaping in circles must not pass as completing the blocked job.
      if (doingWork || !e.active || e.controlled || !e.motion.lab || resting || !wantsMove || e.fire.burning || e.fire.rolling) {
        s.taskTime = 0; s.taskActive = false;
      } else if (s.taskActive) {
        const distance = Math.hypot(s.taskX - p.x, s.taskZ - p.z);
        // Give a recovering walker credit for getting genuinely closer to its
        // original workstation. Moving around in an escape loop or changing
        // waypoints cannot refresh this monotonically decreasing watermark.
        if (distance < s.taskDistance - 0.35) { s.taskDistance = distance; s.taskTime = 0; }
        else s.taskTime += dt;
      }
      const taskExpired = s.taskActive && s.taskTime >= 8 || r.departPending && elapsed - r.departAt >= 8;
      // An independent clock survives changing waypoints and mutual yielding.
      // Limb animation alone is not progress; real work and deliberate rest are.
      if (!invalidExpired && (!e.active || e.controlled || e.fire.burning || e.fire.rolling || e.pound || e.beat
        || resting || !wantsMove || r.departPending && !departureStalled
        || e.phase === "chill" && !departureStalled && (e.recover > 0
          || !e.loungeDepart && !e.climb.active && (elapsed < e.roam.waitUntil || e.roam.progressTime < 2.1)
          || e.climb.claimPending && elapsed - e.climb.claimProgressAt < 1.5)
        || !taskExpired && (elapsed < job.coordinationUntil || elapsed < job.trafficWait || job.pathCount && elapsed < job.readyAt || progressed) || !Number.isFinite(s.x))) {
        s.x = p.x; s.y = p.y; s.z = p.z; s.time = 0; s.stage = 0;
        return;
      }
      s.time += dt;
      if (!invalidExpired && !taskExpired && (s.time < 0.65 || s.stage && elapsed < s.retryAt
        || labEscape && e.motion.lab && !enteringCave(e))) return;
      const hard = s.time >= 8 || taskExpired || invalidExpired, lab = e.motion.lab;
      // An inward run never becomes a yielding/backout route. If its actual
      // geometry remains blocked, bounded recovery places it inside instead.
      if (!hard && enteringCave(e)) return;
      // A live climb may be paused between search slices. Replanning that
      // mid-wall pose as a ground walk is unsafe, so retain its grip until reset.
      if (!hard && (e.climb.active || e.jump.active || e.drive.airborne)) { s.stage = 1; s.retryAt = elapsed + 0.5; return; }
      releasePortal(e);
      if (hard || !lab) releaseLab(e);
      else {
        // Keep the workstation and real held equipment. Only stale movement
        // claims are discarded; a carrier returns its item before retreating.
        job.yielding = 0; job.yieldFor = null; job.yieldReady = false; job.arrived = false;
        job.pathCount = job.pathIndex = 0; job.pathPending = job.pathPartial = false;
        if (job.item >= 0) { job.stage = "return"; job.reach = 0; }
      }
      if (e.lounge) leaveLounge(e);
      for (const other of list) if (other !== e && other.lab.yieldFor === e) {
        other.lab.yieldFor = null; other.lab.yielding = 0; other.lab.yieldReady = false;
        other.lab.pathCount = other.lab.pathIndex = 0; other.lab.pathAt = 0;
      }
      e.climb.searchPending = e.climb.searchDeferred = e.climb.claimPending = e.climb.crestPending = false;
      e.climb.searchCursor = e.climb.retry = 0;
      if (climbTurn === e.index) climbTurn = -1;
      e.blocked = e.stuckTime = e.retry = e.portalRetry = 0;
      e.steerHeading = e.steerGoalX = e.steerGoalZ = NaN; e.backoutLeft = 0;
      e.lab.pathAt = 0; e.lab.targetX = e.lab.targetZ = NaN;
      if (hard || !lab) { e.hasSlot = false; e.slotIndex = -1; }
      e.parked = false;
      e.speed = e.drive.vx = e.drive.vz = 0;
      if (hard) {
        if (labEscape === e) labEscape = null;
        s.escapeLeft = 0; s.taskTime = 0; s.taskActive = false;
        // Recovery reserves a supported workstation or interior floor spot;
        // equipment availability cannot send the worker to an outside queue.
        const soot = e.fire.soot, cooldown = e.fire.cooldown;
        e.climb.active = e.drive.passiveFall = false;
        activate(e);
        e.fire.soot = soot; e.fire.cooldown = cooldown;
        s.recoveries++; s.reason = "relocated"; s.time = s.invalidTime = 0; s.stage = 0;
        s.invalidX = s.invalidZ = NaN;
        s.x = p.x; s.y = p.y; s.z = p.z;
      } else {
        if (lab && !s.taskActive) {
          s.taskActive = true; s.taskTime = 0;
          s.taskX = station ? station.x : e.goalX; s.taskZ = station ? station.z : e.goalZ;
          s.taskDistance = Math.hypot(s.taskX - p.x, s.taskZ - p.z);
        }
        if ((!lab || job.station < 0) && e.mode === "working") resumeEntry(e);
        if (lab) beginLabEscape(e);
        s.replans++; s.reason = "replanned"; s.stage = 1;
        s.retryAt = elapsed + 1.5;
      }
      s.workTime = job.time; s.workCycles = job.cycles;
      if (ctx.onRecovery && e.active) ctx.onRecovery(e, hard);
    };
    const update = (dt) => {
      if (disposed || !(dt > 0)) return;
      if (rage) rage.frame(elapsed);
      if (labEscape && (!labEscape.active || labEscape.controlled || labEscape.fire.burning
        || labEscape.climb.active || labEscape.jump.active || labEscape.drive.airborne)) {
        labEscape.stuck.escapeLeft = 0; labEscape = null;
      }
      roamBudget = 1; roamTurn = -1; debugRouteBudget = 1; wallBudget = 8;
      if (wallSearch && wallSearch.owner && (!wallSearch.owner.active || wallSearch.owner.controlled
        || !wallSearch.owner.debugMove.active || !wallSearch.owner.climb.active)) wallSearch.owner = null;
      for (let i = 0; i < list.length; i++) {
        const index = (roamNext + i) % list.length, e = list[index];
        if (e.active && !e.controlled && e.phase === "chill" && !e.loungeDepart && e.recover <= 0
          && e.rest <= 0 && e.roam.nextChoice <= elapsed
          && Math.hypot(e.goalX - e.root.position.x, e.goalZ - e.root.position.z) <= 0.025
          && Math.abs(e.goalY - e.root.position.y) <= 0.55) {
          roamTurn = index; roamNext = (index + 1) % list.length; break;
        }
      }
      labRouteBudget = 1; labRouteTurn = -1;
      for (let i = 0; i < list.length; i++) {
        const index = (labRouteNext + i) % list.length, e = list[index];
        if (e.active && e.lab.pathPending && e.lab.pathAt <= elapsed) { labRouteTurn = index; labRouteNext = (index + 1) % list.length; break; }
      }
      if (player && labSite >= 0 && Math.hypot(player.drive.x, player.drive.z) > 0.05) {
        const p = player.root.position, m = sites[labSite].mouth;
        if (Math.abs(p.y - m.floorY) < 0.5 && Math.hypot(p.x - m.x, p.z - m.z) < 7)
          requestLabPass(player, p.x + player.drive.x * 3.5, p.z + player.drive.z * 3.5);
      }
      let remaining = Math.min(dt, 0.25);
      // Budget the rendered update, not each catch-up physics substep. Rotate
      // the deferred-search priority so a crowded cliff cannot starve the last
      // companion in the roster or rebuild many wall routes in the same frame.
      climbFrameBudget = 2; climbTurn = -1;
      for (let i = 0; i < list.length; i++) {
        list[i].climb.searchBudget = 2;
        if (!list[i].rage.warpWaiting) pendingClimbSearch(list[i]);
      }
      for (let i = 0; i < list.length; i++) {
        const index = (climbNext + i) % list.length, e = list[index], c = e.climb;
        if (!e.active || e.rage.warpWaiting || c.active || !c.searchPending || c.retry > remaining || e.recover > 0 || e.jump.active || e.drive.airborne
          || e.pound || e.beat || e.parked || e.fire.rolling) continue;
        if (e.controlled ? Math.hypot(e.drive.x, e.drive.z) <= 0.05 : Math.hypot(e.goalX - e.root.position.x, e.goalZ - e.root.position.z) <= 0.18) continue;
        climbTurn = index; climbNext = (index + 1) % list.length;
        break;
      }
      while (remaining > 1e-8) {
        const step = Math.min(remaining, 1 / 30); remaining -= step; elapsed += step;
        fireThreatsActive = false;
        for (let i = 0; i < list.length; i++) if (list[i].active && list[i].fire.burning) { fireThreatsActive = true; break; }
        if (!fireThreatsActive) for (let i = 0; i < crew.list.length; i++) {
          if (crew.list[i].root.visible && crew.list[i].camp.burning) { fireThreatsActive = true; break; }
        }
        if (debugShuttle && debugShuttle.active && !debugShuttle.controlled && !debugShuttle.debugMove.active && debugShuttle.phase === "work"
          && debugShuttle.site === labSite && debugShuttle.motion.lab && elapsed >= debugShuttleAt) {
          releaseLab(debugShuttle);
          debugShuttle.hasSlot = false; debugShuttle.slotIndex = -1;
          debugShuttle.phase = "leave"; debugShuttle.route = "exit"; debugShuttle.fromSite = labSite;
          debugShuttle.parked = false; debugShuttle.rest = 0; debugShuttleAt = Infinity;
        }
        for (let i = 0; i < list.length; i++) {
          updateEntry(list[i], step);
          if (!list[i].rage.active) recoverStall(list[i], step);
        }
      }
    };
    const companionTarget = (cave, out) => {
      const e = byOwner.get(cave);
      if (!e || !e.active || e.mode !== "working") return false;
      e.gorilla.bodyTarget(out);
      return true;
    };
    const target = (cave, out, sample = 0) => {
      const e = byOwner.get(cave);
      if (!e || !e.active || e.mode !== "working" || e.site !== cave.work.site
        || e.phase !== "work" && !(e.phase === "travel" && e.route === "enter")) return false;
      const p = e.root.position;
      if (e.site === labSite ? !insideLab(p.x, p.y, p.z) : caveAt(p.x, p.y, p.z) !== cave.work.site) return false;
      if (e.site === labSite) {
        // The entrance transforms incoming bananas; desk workers are never
        // projectile targets behind equipment or another scientist.
        sitePoint(sites[labSite], Math.sin((sample + e.index) * 2.39996323) * 1.8, 0.5, out);
        out.y += 1.3 + (Math.sin(sample * 1.7 + e.index) * 0.5 + 0.5);
        return true;
      }
      e.gorilla.bodyTarget(out, sample);
      return true;
    };
    const hit = (cave) => {
      const e = byOwner.get(cave);
      if (!e || !e.active) return false;
      e.activity = Math.min(9, e.activity + 1); e.hits++;
      if (e.site !== labSite && e.activity >= 3) e.rest = Math.min(e.rest, 0.7);
      return true;
    };
    const damage = (entry, power) => {
      if (!entry || !entry.active || !(power > 0)) return false;
      entry.health.value = Math.max(0, entry.health.value - power * 4);
      entry.health.delay = BL.crew.HEALTH_REGEN_DELAY;
      if (rage && entry.health.value === 0) rage.cancel(entry, "health");
      return true;
    };
    const bananaHit = (entry, source, serial) => !!rage && !!entry && rage.bananaHit(entry, source, serial);
    const debugRage = (entry, on = true) => !disposed && !!rage && rage.debugRage(entryFor(entry), on);
    const stats = () => {
      let active = 0, working = 0, chilling = 0, overflow = 0, airborne = 0, hits = 0, pounds = 0, beats = 0, stuck = 0, replans = 0, recoveries = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.active) { active++; if (e.mode === "working") working++; else chilling++; }
        if (e.overflow) overflow++;
        if (e.jump.active || e.drive.airborne) airborne++;
        hits += e.hits; pounds += e.pounds; beats += e.beats;
        if (e.stuck.time >= 0.65) stuck++;
        replans += e.stuck.replans; recoveries += e.stuck.recoveries;
      }
      return { capacity: list.length, active, working, chilling, overflow, airborne, hits, pounds, beats, stuck, replans, recoveries, elapsed };
    };
    const liveGeometry = (set) => { for (let i = 0; i < list.length; i++) if (list[i].active) list[i].gorilla.liveGeometry(set); };
    const dispose = () => {
      if (rage) rage.dispose();
      disposed = true; player = null;
      if (wallSearch) wallSearch.owner = null;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.tracked && ctx.untrack) ctx.untrack(e);
        e.gorilla.dispose(); e.active = e.tracked = e.debugMove.active = false;
      }
      list.length = 0; byOwner.clear();
      portals.fill(null);
    };
    const debugLoungeSpots = (e, sourceX, sourceZ) => {
      if (!ctx.debugMovement || !list.length) return [];
      e = e || list[0];
      prepareLounges(e);
      const spots = [];
      for (let i = 0; i < loungeCount; i++) {
        const at = i * 3;
        const x = loungeSpots[at], y = loungeSpots[at + 1], z = loungeSpots[at + 2];
        const heading = Number.isFinite(sourceX) && Number.isFinite(sourceZ)
          ? Math.atan2(x - sourceX, z - sourceZ) : e.heading;
        if (ctx.restSiteClear && !ctx.restSiteClear(e, x, y, z, heading)) continue;
        spots.push({ x, y, z, roof: i < roofCount });
      }
      return spots;
    };
    return { list, sync, update, target, companionTarget, hit, damage, bananaHit, debugRage, plan, startLabShuttle, debugMove, cancelDebugMove, stats, liveGeometry, dispose, contactAt,
      debugLoungeSpots,
      possess, release, respawn, control, cancelInput, smash, smashPower, quickSmash, chestBeat, ignite, dropRoll, supportRemoved,
      get player() { return player; } };
  };
  BL.clankers = { create, rageCarrying, WALK_RADIUS, WALK_HEIGHT, PROP_STEP, RAGE_SPEED };
})();

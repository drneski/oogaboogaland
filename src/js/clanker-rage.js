// Local-only banana rage. The hub supplies physical movement/capture proofs;
// this bounded planner owns no player input, damage, animation or network state.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const HITS = 42, WINDOW = 60, DURATION = 60, SERIALS = 128, DEBUG_RANGE = 35;
  const THROW_CHARGE_TIME = 1, WARP_HOLD_TIME = 0.4, EDGE_NEAR = 2.4;
  const GRIP_WAIT = 0.75, BACKOFF_TIME = 1.25, BACKOFF_DISTANCE = 2.5;
  const TARGET_HUNT_TIME = 8, TARGET_RETRY_TIME = 8;
  const GRID = 181, HALF = 90, STEP = 1.25, CELLS = GRID * GRID, ROUTE = 256;
  const DX = [1, -1, 0, 0, 1, -1, 1, -1], DZ = [0, 0, 1, -1, 1, 1, -1, -1];
  const signedOut = () => !!BL.net && BL.net.state.resolved === true && !BL.net.state.me;
  const state = () => ({ active: false, debug: false, count: 0, first: 0, age: 0, beganAt: 0, expires: 0, phase: "", target: null, targetUntil: 0,
    times: new Float64Array(HITS), hitters: new Uint16Array(HITS), serials: new Float64Array(SERIALS), serial: 0,
    path: new Float64Array(ROUTE * 3), countPath: 0, index: 0, pending: false, planAt: 0,
    blocked: 0, poseBlocked: 0, approachInset: 0, approachAttempt: 0, approachBearing: NaN,
    gripSince: -1, gripX: 0, gripZ: 0, backoffUntil: 0, backoffAttempts: 0, backoffAbandon: false,
    backoffX: 0, backoffY: 0, backoffZ: 0, backoffHeading: 0,
    huntJumpAt: 0, huntJumpDistance: Infinity, huntJumpAttempt: 0, huntJumpBearing: NaN, warpAt: 0, warpWaiting: false, homePending: false, slideSide: 0, slideUntil: 0,
    poseRejectX: 0, poseRejectZ: 0, poseRejectHeading: NaN, poseRejectUntil: 0,
    poseRepair: false, poseRepairDistance: Infinity,
    land: 0, dx: 0, dz: 1, goalX: 0, goalY: 0, goalZ: 0,
    edgeReady: false, edgeWaiting: false, edgeIndex: -1, edgeInset: 0, edgeRetryAt: 0,
    edgeOriginX: 0, edgeOriginY: 0, edgeOriginZ: 0,
    edgeSide: 0, edgeSideUntil: 0, edgeProgress: Infinity, edgeProgressAt: 0, edgeTraversed: false, edgeSettleUntil: 0,
    edgeX: 0, edgeZ: 0, edgeDx: 0, edgeDz: 1, edgeLand: 0, edgeProbes: 0, edgeRejectReason: "",
    edgeRejected: new Uint8Array(48),
    grabHeld: false, throwHeld: false, throwCharge: 0, chargeAt: 0, traversing: false,
    rejected: null, rejectUntil: 0, rejectedTargets: null, agitators: null, search: null, reason: "" });
  const create = (ctx) => {
    const { list, crew } = ctx;
    for (let i = 0; i < list.length; i++) {
      list[i].rage.rejectedTargets = new Uint8Array(crew.list.length);
      list[i].rage.agitators = new Uint8Array(crew.list.length);
    }
    // Pursuit alone uses a bounded workspace, resumed in round-robin slices.
    // A held captive goes directly to its selected, physically proven stance.
    let costs, heights, headings, parents, states, heap, heapAt;
    const reverse = new Uint16Array(ROUTE);
    const edge = { dx: 0, dz: 0 };
    const approach = { x: 0, y: 0, z: 0, heading: 0 };
    let owner = null, size = 0, cursor = -1, neighbor = 0, budget = 0, next = 0, now = 0;
    let originX = 0, originZ = 0, started = 0;
    const eligible = (e, debug = e.rage.debug) => signedOut() && e.active && !e.controlled && e.health.value > 0
      && (debug ? ctx.debugRage === true && (e.mode === "working" || e.mode === "chilling")
        && (crew.stateOf(e.owner) === "working" || crew.stateOf(e.owner) === "chilling")
        : e.mode === "chilling" && crew.stateOf(e.owner) === "chilling");
    const clearHits = r => { r.count = r.first = 0; r.times.fill(0); };
    const resetApproach = r => {
      r.approachInset = r.approachAttempt = 0; r.approachBearing = NaN;
      r.gripSince = -1; r.backoffUntil = r.backoffAttempts = 0; r.backoffAbandon = false;
      r.huntJumpAt = r.huntJumpAttempt = 0; r.huntJumpDistance = Infinity; r.huntJumpBearing = NaN;
      r.warpAt = r.slideSide = r.slideUntil = 0;
      r.warpWaiting = r.homePending = false;
    };
    const retryApproach = (e, heading) => {
      const r = e.rage;
      if (!ctx.approach || r.approachAttempt >= 2) return false;
      if (!r.approachAttempt) r.approachBearing = heading;
      r.approachAttempt++; r.approachInset = 0; r.blocked = 0;
      return true;
    };
    const clearRoute = e => {
      const r = e.rage;
      r.countPath = r.index = 0; r.pending = false;
      if (owner === e) { owner = null; size = 0; cursor = -1; }
    };
    const saveSearch = () => {
      if (!owner) return;
      const s = owner.rage.search;
      s.size = size; s.cursor = cursor; s.neighbor = neighbor;
    };
    const loadSearch = e => {
      const s = e.rage.search;
      owner = e; costs = s.costs; heights = s.heights; headings = s.headings; parents = s.parents;
      states = s.states; heap = s.heap; heapAt = s.heapAt;
      size = s.size; cursor = s.cursor; neighbor = s.neighbor;
      originX = s.x; originZ = s.z; started = s.started;
    };
    const cancel = (e, reason = "cancelled") => {
      const r = e.rage, debug = r.debug;
      clearHits(r); clearRoute(e);
      r.debug = false; r.poseBlocked = 0; r.poseRejectHeading = NaN; resetApproach(r);
      r.targetUntil = 0;
      r.poseRepair = false; r.poseRepairDistance = Infinity;
      r.edgeReady = r.edgeWaiting = false; r.edgeIndex = -1; r.edgeRetryAt = 0; r.edgeRejected.fill(0);
      if (!r.active) return;
      r.active = false; r.phase = ""; r.target = r.rejected = null; r.age = r.beganAt = r.expires = 0; r.reason = reason;
      r.grabHeld = r.throwHeld = false; r.throwCharge = 0;
      r.rejectedTargets.fill(0); r.agitators.fill(0); r.traversing = false;
      ctx.release(e); effects(e);
      ctx.end(e, debug);
    };
    const accountChanged = () => {
      if (!signedOut()) for (let i = 0; i < list.length; i++) cancel(list[i], "account");
    };
    const unsubscribe = BL.net ? BL.net.subscribe(accountChanged) : null;
    const begin = (e, target, debug = false) => {
      const r = e.rage;
      clearHits(r);
      r.active = true; r.debug = debug; r.beganAt = now; r.expires = debug ? Infinity : now + DURATION;
      r.age = 0; r.phase = "hunt"; r.target = target; r.poseRejectHeading = NaN; resetApproach(r);
      r.targetUntil = target ? now + TARGET_HUNT_TIME : 0;
      r.edgeRetryAt = 0;
      r.grabHeld = true; r.throwHeld = false; r.throwCharge = 0;
      r.rejectedTargets.fill(0); r.rejected = null; r.rejectUntil = 0;
      r.land = ctx.landAt(e.root.position.x, e.root.position.z); r.planAt = now; r.blocked = r.poseBlocked = 0; r.reason = "";
      effects(e); ctx.begin(e); return true;
    };
    const debugRage = (e, on = true) => {
      if (ctx.debugRage !== true || list.indexOf(e) < 0) return false;
      if (!on) {
        if (!e.rage.debug) return false;
        cancel(e, "debug"); return true;
      }
      if (!eligible(e, true)) return false;
      if (e.rage.debug) return true;
      // Selection is exclusive, but unrelated banana-triggered rages keep
      // their own hit window, target list and ordinary expiry.
      for (let i = 0; i < list.length; i++) if (list[i].rage.debug) cancel(list[i], "selection");
      cancel(e, "debug");
      return begin(e, null, true);
    };
    const bananaHit = (e, shooter, serial) => {
      const r = e.rage;
      const shooterIndex = crew.list.indexOf(shooter);
      // Serial numbers belong to actual projectiles, never to damage units or
      // work events. Keep the replay fence across resets of the hit window.
      if (shooterIndex < 0 || !Number.isSafeInteger(serial) || serial <= 0 || serial <= r.serial - SERIALS
        || r.serials[serial % SERIALS] === serial) return false;
      r.serials[serial % SERIALS] = serial; r.serial = Math.max(r.serial, serial);
      if (r.active) return false;
      if (!eligible(e)) { clearHits(r); return false; }
      while (r.count && now - r.times[r.first] >= WINDOW) { r.first = (r.first + 1) % HITS; r.count--; }
      const slot = (r.first + r.count) % HITS;
      r.times[slot] = now; r.hitters[slot] = shooterIndex; r.count++;
      if (r.count !== HITS) return false;
      r.agitators.fill(0);
      for (let i = 0; i < HITS; i++) r.agitators[r.hitters[(r.first + i) % HITS]] = 1;
      return begin(e, shooter);
    };
    const score = cell => costs[cell];
    const less = (a, b) => score(a) < score(b) || score(a) === score(b) && a < b;
    const push = cell => {
      let at = heapAt[cell];
      if (at < 0) { at = size++; heap[at] = cell; heapAt[cell] = at; }
      while (at > 0) {
        const up = (at - 1) >> 1, other = heap[up];
        if (!less(cell, other)) break;
        heap[at] = other; heapAt[other] = at; at = up;
      }
      heap[at] = cell; heapAt[cell] = at;
    };
    const pop = () => {
      const cell = heap[0], last = heap[--size]; heapAt[cell] = -1;
      if (size) {
        let at = 0;
        while (at * 2 + 1 < size) {
          let child = at * 2 + 1;
          if (child + 1 < size && less(heap[child + 1], heap[child])) child++;
          if (!less(heap[child], last)) break;
          heap[at] = heap[child]; heapAt[heap[at]] = at; at = child;
        }
        heap[at] = last; heapAt[last] = at;
      }
      return cell;
    };
    const xOf = cell => originX + ((cell % GRID) - HALF) * STEP;
    const zOf = cell => originZ + (Math.floor(cell / GRID) - HALF) * STEP;
    const validTarget = (e, cave) => {
      const index = crew.list.indexOf(cave);
      if (index < 0 || !e.rage.debug && !e.rage.agitators[index]
        || e.rage.rejectedTargets[index] || !ctx.captureEligible(e, cave)) return false;
      if (!e.rage.debug) return true;
      const p = e.root.position, q = cave.root.position;
      return (p.x - q.x) ** 2 + (p.z - q.z) ** 2 + (p.y - (q.y - cave.baseY)) ** 2 <= DEBUG_RANGE * DEBUG_RANGE;
    };
    const chooseTarget = e => {
      const r = e.rage, p = e.root.position;
      if (validTarget(e, r.target)) {
        if (!r.targetUntil) r.targetUntil = now + TARGET_HUNT_TIME;
        return true;
      }
      clearRoute(e);
      let nearest = Infinity; r.target = null; r.targetUntil = 0; r.poseRejectHeading = NaN; resetApproach(r);
      for (let i = 0; i < crew.list.length; i++) {
        const cave = crew.list[i];
        if (!validTarget(e, cave)) continue;
        const q = cave.root.position, distance = (p.x - q.x) ** 2 + (p.z - q.z) ** 2 + (p.y - (q.y - cave.baseY)) ** 2;
        if (distance < nearest) { nearest = distance; r.target = cave; }
      }
      // Try every eligible body before retrying unreachable ones. Remembering
      // only the last failure made two blocked Oogas starve a reachable third.
      if (!r.target && now >= r.rejectUntil) { r.rejectedTargets.fill(0); r.rejected = null; r.rejectUntil = now + 4; }
      if (r.target) r.targetUntil = now + TARGET_HUNT_TIME;
      return !!r.target;
    };
    const rejectHunt = (e, retry, delay) => {
      const r = e.rage, index = crew.list.indexOf(r.target);
      clearRoute(e);
      if (index >= 0) r.rejectedTargets[index] = 1;
      r.rejected = r.target; r.rejectUntil = Math.max(r.rejectUntil, now + retry);
      r.target = null; r.targetUntil = 0; r.planAt = now + delay; r.blocked = 0;
      r.phase = "hunt"; r.throwHeld = false; r.throwCharge = 0; r.poseRejectHeading = NaN; resetApproach(r);
    };
    const failed = e => {
      const r = e.rage;
      clearRoute(e);
      if (r.phase === "edge") {
        // A route or launch failure is not a G release. Keep the captive and
        // charge while trying another nearby outward coast.
        if (r.edgeIndex >= 0) r.edgeRejected[r.edgeIndex] |= 1 << r.edgeInset;
        r.edgeReady = false; r.edgeWaiting = !!ctx.edgeGoal;
        r.planAt = now + 0.3; r.blocked = 0; r.throwHeld = true; return;
      }
      if (r.target && !r.backoffAbandon && validTarget(e, r.target)) {
        const p = e.root.position, q = r.target.root.position;
        if (Math.hypot(q.x - p.x, q.z - p.z) <= (ctx.huntRange ? ctx.huntRange(e) : 2.6) + 0.5) {
          // Even an exhausted side approach or failed hill takeoff must
          // leave the target room before abandoning it at a wall.
          beginBackoff(e); return;
        }
      }
      rejectHunt(e, 4, 0.3);
    };
    const beginBackoff = e => {
      const r = e.rage, p = e.root.position, q = r.target.root.position;
      const away = Math.hypot(p.x - q.x, p.z - q.z) > 1e-7
        ? Math.atan2(p.x - q.x, p.z - q.z) : e.heading + Math.PI;
      const side = e.index & 1 ? -1 : 1;
      // A short diagonal retreat opens a way along the wall for the target.
      // Keep facing fixed so the first escape step does not sweep a turn
      // into the wall. Every live step still uses the normal body collision.
      r.backoffX = p.x + Math.sin(away) * BACKOFF_DISTANCE;
      r.backoffY = p.y; r.backoffZ = p.z + Math.cos(away) * BACKOFF_DISTANCE;
      r.backoffHeading = e.heading;
      let found = false;
      for (let reach = BACKOFF_DISTANCE; reach >= BACKOFF_DISTANCE / 2 && !found && budget > 0; reach -= BACKOFF_DISTANCE / 2) {
        for (let i = 0; i < 5 && budget > 0; i++) {
          const turn = i < 2 ? (i ? -side : side) * Math.PI / 4 : i === 2 ? 0 : (i === 3 ? side : -side) * Math.PI / 2;
          const x = p.x + Math.sin(away + turn) * reach, z = p.z + Math.cos(away + turn) * reach;
          const y = ctx.floorAt(e, x, z, p.y, e.heading);
          if (!Number.isFinite(y)) continue;
          budget--;
          if (!ctx.legClear(e, p.x, p.y, p.z, x, y, z, e.heading, e.heading)) continue;
          r.backoffX = x; r.backoffY = y; r.backoffZ = z; found = true; break;
        }
      }
      // If no whole segment fits, the same checked walk can still take a
      // partial step away. Never force either body through the obstruction.
      clearRoute(e); r.gripSince = -1; r.blocked = 0; r.slideSide = r.slideUntil = 0;
      r.backoffAbandon = r.backoffAttempts >= 2; r.backoffAttempts++;
      r.backoffUntil = r.planAt = now + BACKOFF_TIME;
    };
    const backoff = (e, dt) => {
      const r = e.rage;
      if (now >= r.backoffUntil) {
        r.backoffUntil = 0; r.gripSince = -1; r.planAt = now;
        if (r.backoffAbandon) { failed(e); return; }
        const p = e.root.position, q = r.target.root.position;
        r.approachBearing = Math.atan2(q.x - p.x, q.z - p.z);
        r.approachAttempt = r.backoffAttempts & 1 ? 1 : 2; r.approachInset = 0;
        return;
      }
      ctx.walk(e, dt, r.backoffX, r.backoffY, r.backoffZ, r.backoffHeading);
    };
    const chooseEdge = e => {
      const r = e.rage, p = e.root.position;
      if (ctx.edgeGoal && ctx.edgeGoal(e, r) === false) {
        r.edgeWaiting = true; r.blocked = 0; r.planAt = now + 0.5; return;
      }
      if (!ctx.edgeGoal) {
        ctx.edgeHeading(e, edge);
        r.goalX = p.x + edge.dx * STEP; r.goalY = p.y; r.goalZ = p.z + edge.dz * STEP;
      }
      r.edgeReady = true; r.edgeWaiting = false; r.poseRepair = false; r.poseRepairDistance = Infinity;
      r.edgeSide = 0; r.edgeSideUntil = 0; r.edgeTraversed = false; r.edgeSettleUntil = 0;
      r.edgeProgress = Math.hypot(r.goalX - p.x, r.goalZ - p.z); r.edgeProgressAt = now;
    };
    const start = e => {
      const r = e.rage, p = e.root.position;
      if (!r.search) r.search = { costs: new Float64Array(CELLS), heights: new Float64Array(CELLS), headings: new Float64Array(CELLS),
        parents: new Int16Array(CELLS), states: new Uint8Array(CELLS), heap: new Uint16Array(CELLS), heapAt: new Int16Array(CELLS),
        x: 0, z: 0, started: 0, size: 0, cursor: -1, neighbor: 0 };
      const s = r.search;
      s.x = p.x; s.z = p.z; s.started = now; s.size = 0; s.cursor = -1; s.neighbor = 0;
      loadSearch(e);
      owner = e; originX = p.x; originZ = p.z; started = now; cursor = -1; neighbor = 0; size = 0;
      states.fill(0); heapAt.fill(-1); parents.fill(-1); costs.fill(Infinity);
      const cell = HALF * GRID + HALF;
      heights[cell] = p.y; headings[cell] = e.heading; costs[cell] = 0; states[cell] = 1; push(cell);
      r.pending = true;
      if (r.phase === "hunt") {
        const q = r.target.root.position;
        r.goalX = q.x; r.goalY = q.y - r.target.baseY; r.goalZ = q.z;
      }
    };
    const routeTo = (e, cell) => {
      const r = e.rage;
      let length = 0, at = cell;
      while (at >= 0 && length < ROUTE) { reverse[length++] = at; at = parents[at]; }
      if (at >= 0) { failed(e); return false; }
      for (let i = 0; i < length; i++) {
        at = reverse[length - 1 - i];
        r.path[i * 3] = xOf(at); r.path[i * 3 + 1] = heights[at]; r.path[i * 3 + 2] = zOf(at);
      }
      r.countPath = length; r.index = 1; r.blocked = 0;
      return true;
    };
    const finish = (e, cell) => {
      const r = e.rage;
      if (!routeTo(e, cell)) return;
      r.pending = false;
      owner = null; size = 0; cursor = -1;
    };
    const huntFooting = (r, x, z, distance) => {
      // First try the current approach, even when already close. A refused
      // arc gets only two alternate bearings, farther from the hill's wall,
      // reached through the same checked walking search.
      if (!r.huntJumpAttempt) return true;
      if (r.huntJumpAttempt > 2 || distance < ctx.huntJumpRange - 2) return false;
      const heading = r.huntJumpBearing + (r.huntJumpAttempt === 1 ? 1 : -1) * Math.PI / 3;
      return (x - r.goalX) * Math.sin(heading) + (z - r.goalZ) * Math.cos(heading) > distance * 0.9659258262890683;
    };
    const huntTraverse = e => {
      const r = e.rage, p = e.root.position, q = r.target.root.position, y = q.y - r.target.baseY;
      if (!ctx.traverse || !ctx.huntJumpRange || y <= p.y + 0.75 || y > p.y + ctx.huntJumpHeight
        || Math.hypot(q.x - p.x, q.z - p.z) > ctx.huntJumpRange) return false;
      if (now < r.huntJumpAt) return true;
      if (r.huntJumpAttempt >= 3) { failed(e); return true; }
      if (!r.huntJumpAttempt) r.huntJumpBearing = Math.atan2(p.x - q.x, p.z - q.z);
      r.huntJumpAttempt++; r.huntJumpAt = now + 0.75;
      r.huntJumpDistance = Math.hypot(q.x - p.x, y - p.y, q.z - p.z);
      const traversing = ctx.traverse(e, q.x, y, q.z);
      clearRoute(e); r.blocked = 0;
      if (traversing) r.traversing = true;
      else if (r.huntJumpAttempt >= 3) failed(e);
      else r.planAt = r.huntJumpAt;
      // A failed elevated approach must not fall through to grab movement
      // underneath its target. Wait for the next supported takeoff route.
      return true;
    };
    const search = e => {
      const r = e.rage;
      if (now - started > 12) { failed(e); return; }
      while (budget > 0 && owner === e) {
        if (cursor < 0) {
          if (!size) { failed(e); return; }
          cursor = pop(); states[cursor] = 2; neighbor = 0;
          const x = xOf(cursor), y = heights[cursor], z = zOf(cursor);
          const distance = Math.hypot(x - r.goalX, z - r.goalZ), rise = r.goalY - y;
          if (distance < (ctx.huntRange ? ctx.huntRange(e) : 2.6) && Math.abs(rise) < 0.75
            // A walk route may finish at a takeoff footing below its target.
            // Traversal still needs the adapter's actual landing/arc proof.
            || ctx.huntJumpRange && distance <= ctx.huntJumpRange && rise > 0.75 && rise <= ctx.huntJumpHeight
              && huntFooting(r, x, z, distance)) {
            finish(e, cursor); return;
          }
        }
        const dir = neighbor++, col = cursor % GRID + DX[dir], row = Math.floor(cursor / GRID) + DZ[dir]; budget--;
        if (neighbor === 8) neighbor = 0;
        const previous = cursor;
        if (!neighbor) cursor = -1;
        if (col < 0 || col >= GRID || row < 0 || row >= GRID) continue;
        const cell = row * GRID + col;
        if (states[cell] === 2) continue;
        const x = xOf(previous), z = zOf(previous), y = heights[previous], nx = xOf(cell), nz = zOf(cell);
        const heading = Math.atan2(DX[dir], DZ[dir]);
        // A real animated pose can refuse a leg that the route shell admits.
        // Replanning at that same spot must choose a different first step.
        if (previous === HALF * GRID + HALF && Number.isFinite(r.poseRejectHeading)
          && Math.hypot(x - r.poseRejectX, z - r.poseRejectZ) < 0.3
          && Math.cos(heading - r.poseRejectHeading) >= Math.SQRT1_2 - 1e-7) continue;
        const ny = ctx.floorAt(e, nx, nz, y, heading);
        if (!Number.isFinite(ny)) continue;
        const cost = costs[previous] + Math.hypot(nx - x, ny - y, nz - z);
        if (cost >= costs[cell] || !ctx.legClear(e, x, y, z, nx, ny, nz, headings[previous], heading)) continue;
        costs[cell] = cost; heights[cell] = ny; headings[cell] = heading; parents[cell] = previous; states[cell] = 1; push(cell);
      }
    };
    const frame = time => {
      now = time; budget = 96;
      saveSearch(); owner = null;
      accountChanged();
      for (let i = 0; i < list.length; i++) {
        const index = (next + i) % list.length, e = list[index], r = e.rage;
        if (!r.active || r.warpWaiting || r.homePending || now < r.planAt || now < r.backoffUntil || r.phase === "throw" || ctx.suspended(e) || ctx.traversing?.(e)
          || (r.phase === "edge" ? r.edgeReady : r.countPath && !r.pending)) continue;
        if (r.phase === "hunt" && !chooseTarget(e)) { r.planAt = now + 0.5; continue; }
        if (r.phase === "hunt" && ctx.warpRequired?.(e, r.target)) { clearRoute(e); continue; }
        next = (index + 1) % list.length;
        if (r.phase === "edge") chooseEdge(e);
        else if (r.pending) loadSearch(e); else start(e);
        break;
      }
    };
    const warpHome = e => {
      const r = e.rage;
      if (!r.homePending) return true;
      if (!ctx.captive(e)) { r.homePending = r.warpWaiting = false; return true; }
      // Hold both inputs while a destination is temporarily unavailable.
      // A refused return must never fall through into an airborne route.
      r.warpWaiting = true; clearRoute(e);
      if (now < r.warpAt) return false;
      r.warpAt = now + 0.75;
      if (!ctx.warpHome(e)) return false;
      const p = e.root.position;
      r.homePending = r.warpWaiting = r.traversing = false;
      r.edgeOriginX = p.x; r.edgeOriginY = p.y; r.edgeOriginZ = p.z;
      r.edgeReady = false; r.edgeWaiting = !!ctx.edgeGoal; r.edgeIndex = -1;
      r.edgeRetryAt = 0; r.edgeRejected.fill(0);
      r.poseRepair = false; r.poseRepairDistance = Infinity;
      r.planAt = now; r.blocked = r.poseBlocked = 0;
      return true;
    };
    const check = (e, time) => {
      now = time;
      const r = e.rage;
      if (!eligible(e)) { cancel(e, e.health.value <= 0 ? "health" : "eligibility"); return false; }
      if (!r.active) {
        while (r.count && now - r.times[r.first] >= WINDOW) { r.first = (r.first + 1) % HITS; r.count--; }
        return false;
      }
      if (!r.debug && now >= r.expires) { cancel(e, "expired"); return false; }
      if (r.phase === "hunt" && r.target && r.targetUntil > 0 && now >= r.targetUntil && !ctx.captive(e)) {
        // This deadline belongs to the target, not a route or an animation.
        // Expire it even while airborne; the physical controller still owns
        // the landing before movement toward the next target can start.
        rejectHunt(e, TARGET_RETRY_TIME, 0); r.reason = "target-timeout";
        if (ctx.retarget) ctx.retarget(e);
        chooseTarget(e);
      }
      if (Number.isFinite(r.poseRejectHeading)
        && (now >= r.poseRejectUntil
          || Math.hypot(e.root.position.x - r.poseRejectX, e.root.position.z - r.poseRejectZ) >= 0.5))
        r.poseRejectHeading = NaN;
      r.age = now - r.beganAt;
      if (r.phase === "edge" && r.throwHeld)
        r.throwCharge = Math.min(1, (now - r.chargeAt) / THROW_CHARGE_TIME);
      if (ctx.suspended(e)) {
        ctx.release(e); clearRoute(e); r.phase = "hunt"; r.planAt = now + 0.3;
        r.homePending = r.warpWaiting = false;
        r.grabHeld = r.throwHeld = false; r.throwCharge = 0; return false;
      }
      if (!warpHome(e)) return true;
      // Border targets have no walking or climbing fallback. The endpoint
      // hook commits placement and capture together; contact adopts that
      // held body before the pair returns to a checked flat destination.
      r.warpWaiting = false;
      if (r.phase === "hunt" && !ctx.captive(e) && chooseTarget(e)) {
        const required = !!ctx.warpRequired?.(e, r.target);
        r.warpWaiting = required;
        // Border targets have no climbing route: release a climb into the
        // checked fall rather than hold the gorilla on the wall.
        if (required) { clearRoute(e); r.grabHeld = true; if (ctx.retarget) ctx.retarget(e); }
        if (ctx.warpTarget && (!ctx.warpRequired || required) && now >= r.warpAt) {
          r.warpAt = now + 0.75; r.grabHeld = true;
          if (ctx.warpTarget(e, r.target)) {
            clearRoute(e); r.planAt = now; r.blocked = r.poseBlocked = 0; r.traversing = false;
            contact(e, now, true);
          }
        }
      }
      if (!warpHome(e) || r.warpWaiting) return true;
      const traversing = !!ctx.traversing?.(e);
      if (r.traversing && !traversing) {
        clearRoute(e); r.planAt = r.edgeProgressAt = now;
        if (r.phase === "hunt" && r.target) {
          const p = e.root.position, q = r.target.root.position;
          if (Math.hypot(q.x - p.x, q.y - r.target.baseY - p.y, q.z - p.z) < r.huntJumpDistance - 0.35) {
            r.huntJumpAttempt = 0; r.huntJumpDistance = Infinity; r.huntJumpBearing = NaN;
          } else if (r.huntJumpAttempt >= 3) failed(e);
        }
      }
      r.traversing = traversing;
      return true;
    };
    const contact = (e, time, warped = false) => {
      const r = e.rage;
      const held = r.target && ctx.captive(e) === r.target;
      if (!r.active || r.phase !== "hunt" || !r.grabHeld || !eligible(e)
        || !held && (ctx.suspended(e) || ctx.traversing?.(e) || !validTarget(e, r.target))) return false;
      now = time;
      const home = !!ctx.warpHome && (warped || !!ctx.warpRequired?.(e, r.target));
      if (!held && !ctx.grab(e, r.target)) {
        const p = e.root.position, q = r.target.root.position;
        const near = Math.hypot(q.x - p.x, q.z - p.z) <= (ctx.huntRange ? ctx.huntRange(e) : 2.6)
          && Math.abs(q.y - r.target.baseY - p.y) <= 0.75;
        if (!near) r.gripSince = -1;
        else if (r.gripSince < 0 || Math.hypot(q.x - r.gripX, q.z - r.gripZ) > 0.5) {
          r.gripSince = now; r.gripX = q.x; r.gripZ = q.z;
        }
        return false;
      }
      clearRoute(e); r.phase = "edge"; r.planAt = now; r.blocked = r.poseBlocked = 0;
      r.targetUntil = 0;
      r.edgeReady = false; r.edgeWaiting = !!ctx.edgeGoal; r.edgeIndex = -1; r.edgeRetryAt = 0; r.edgeRejected.fill(0);
      r.edgeOriginX = e.root.position.x; r.edgeOriginY = e.root.position.y; r.edgeOriginZ = e.root.position.z;
      r.poseRepair = false; r.poseRepairDistance = Infinity; r.edgeSettleUntil = 0;
      r.poseRejectHeading = NaN; r.poseRejectUntil = 0; resetApproach(r);
      r.homePending = r.warpWaiting = home;
      // Show the ankle capture before returning together. The same gate
      // then keeps a refused home endpoint on its bounded retry schedule.
      if (home) r.warpAt = now + WARP_HOLD_TIME;
      r.throwHeld = true; r.throwCharge = 0; r.chargeAt = now; return true;
    };
    const poseResult = (e, dt, time, accepted) => {
      const r = e.rage;
      if (!r.active) return;
      if (accepted) {
        r.poseBlocked = 0;
        const remaining = Math.hypot(e.root.position.x - r.goalX, e.root.position.z - r.goalZ);
        // Grant another repair only after net progress toward this fixed
        // stance. Backtracking or circling cannot replenish the allowance.
        if (r.poseRepair && remaining < r.poseRepairDistance - 0.5) {
          r.poseRepair = false; r.poseRepairDistance = remaining;
        }
        return;
      }
      // walk may have advanced before the animated captive rejects that
      // step. Count only the committed pose as progress, not that rollback.
      r.edgeSettleUntil = 0;
      r.poseBlocked += dt;
      r.blocked = Math.max(r.blocked, r.poseBlocked);
      if (r.poseBlocked <= 0.5 || r.phase === "throw") return;
      if (r.phase === "edge" && r.edgeReady) {
        if (!r.poseRepair) {
          r.poseRepair = true;
          r.poseRepairDistance = Math.min(r.poseRepairDistance,
            Math.hypot(e.root.position.x - r.goalX, e.root.position.z - r.goalZ));
          r.edgeSide = e.index & 1 ? -1 : 1; r.edgeSideUntil = time + 0.75;
        } else {
          if (r.edgeIndex >= 0) r.edgeRejected[r.edgeIndex] |= 1 << r.edgeInset;
          r.edgeReady = false; r.edgeWaiting = !!ctx.edgeGoal; r.edgeRejectReason = "blocked-pose";
        }
      }
      if (r.index < r.countPath) {
        const p = e.root.position, at = r.index * 3, dx = r.path[at] - p.x, dz = r.path[at + 2] - p.z;
        if (Math.hypot(dx, dz) > 0.07) {
          r.poseRejectX = p.x; r.poseRejectZ = p.z; r.poseRejectHeading = Math.atan2(dx, dz); r.poseRejectUntil = time + 3;
        }
      }
      clearRoute(e); r.planAt = time + 0.2; r.blocked = r.poseBlocked = 0;
    };
    const carry = (e, dt) => {
      const r = e.rage, p = e.root.position;
      if (!r.edgeReady || r.edgeWaiting || now < r.planAt) return;
      const distance = Math.hypot(r.goalX - p.x, r.goalZ - p.z);
      const ready = distance <= EDGE_NEAR && ctx.edgeAt(e, p.x, p.y, p.z, edge);
      if (ready || distance < 1e-6) {
        // The provider also supplies the outward heading when the current
        // inward-facing captive has not yet turned into its launch stance.
        const heading = Math.atan2(edge.dx, edge.dz), before = e.heading;
        const walked = ctx.walk(e, dt, ready ? p.x : r.goalX, ready ? p.y : r.goalY, ready ? p.z : r.goalZ, heading);
        if (Math.abs(Math.atan2(Math.sin(e.heading - heading), Math.cos(e.heading - heading))) < 0.035) {
          // Let at least one final pose commit before starting the swing.
          // Turning the controller alone is not a rendered pose.
          if (!r.edgeSettleUntil) { r.edgeSettleUntil = now + 0.1; return; }
          if (now < r.edgeSettleUntil || r.throwCharge < 1) return;
          if (ctx.edgeAt(e, p.x, p.y, p.z, edge) && ctx.throw(e, edge.dx, edge.dz, r.throwCharge)) {
            r.throwHeld = false; r.phase = "throw";
          } else failed(e);
        } else {
          r.edgeSettleUntil = 0;
          if (walked && Math.abs(e.heading - before) > 1e-5) r.blocked = 0;
          else if ((r.blocked += dt) > 1.5) failed(e);
        }
        return;
      }
      // Finish even a sub-centimetre approach: the stance may lie exactly
      // on the allowed inland boundary, whose proof must remain strict.
      r.edgeSettleUntil = 0;
      // Measure committed progress from the previous frame. A proposed move
      // rolled back by the final carry pose must not keep this timer alive.
      if (distance < r.edgeProgress - 0.15) { r.edgeProgress = distance; r.edgeProgressAt = now; }
      if (!r.edgeTraversed && p.y > r.goalY + 1.16 && ctx.traverse) {
        r.edgeTraversed = true;
        if (ctx.traverse(e, r.goalX, r.goalY, r.goalZ)) {
          r.traversing = true; r.edgeProgressAt = now; r.blocked = 0; return;
        }
      }
      if (now - r.edgeProgressAt > 4) {
        if (!r.edgeTraversed && ctx.traverse?.(e, r.goalX, r.goalY, r.goalZ)) {
          r.edgeTraversed = r.traversing = true; r.edgeProgressAt = now; r.blocked = 0;
        } else failed(e);
        return;
      }
      const direct = Math.atan2(r.goalX - p.x, r.goalZ - p.z);
      if (now >= r.edgeSideUntil) r.edgeSide = 0;
      const heading = direct + r.edgeSide * Math.PI / 3;
      const reach = Math.min(distance, 0.75), x = p.x, z = p.z;
      // A short, committed sidestep is the only detour. Every candidate uses
      // the same live support, body and captive sweeps as direct movement.
      ctx.walk(e, dt, r.edgeSide ? x + Math.sin(heading) * reach : r.goalX,
        r.goalY, r.edgeSide ? z + Math.cos(heading) * reach : r.goalZ, heading);
      if (Math.hypot(p.x - x, p.z - z) > 1e-5) r.blocked = 0;
      else if ((r.blocked += dt) > 0.25) {
        r.edgeSide = r.edgeSide ? -r.edgeSide : e.index & 1 ? -1 : 1;
        r.edgeSideUntil = now + 0.75; r.blocked = 0;
      }
    };
    const update = (e, dt, time) => {
      if (!check(e, time)) return false;
      if (e.rage.warpWaiting || e.rage.homePending) { e.speed = 0; return true; }
      if (e.rage.traversing) return false;
      const r = e.rage;
      const p = e.root.position;
      e.speed = 0;
      if (r.phase === "throw" && !ctx.captive(e)) {
        // The click has already been released. Release G only after the
        // swing actually launches the Ooga, then press it for the next hunt.
        r.grabHeld = false; r.throwHeld = false; r.throwCharge = 0;
        clearRoute(e); r.phase = "hunt"; r.target = null; r.targetUntil = 0; r.planAt = now; r.poseRejectHeading = NaN; resetApproach(r);
        return true;
      }
      if (r.phase === "throw" && ctx.throwing && !ctx.throwing(e)) {
        clearRoute(e); r.phase = "edge"; r.planAt = now;
        r.throwHeld = true; return true;
      }
      if (r.phase !== "hunt" && !ctx.captive(e)) {
        clearRoute(e); r.phase = "hunt"; r.target = null; r.targetUntil = 0; r.planAt = now; r.poseRejectHeading = NaN; resetApproach(r);
        r.throwHeld = false; r.throwCharge = 0;
      }
      if (r.phase === "throw") return true;
      if (r.phase === "hunt") {
        if (!chooseTarget(e)) { clearRoute(e); return true; }
        r.grabHeld = true;
        if (contact(e, time)) return true;
        // Turning/sliding is not progress toward a refused close grip. If
        // the target remains boxed in, make room before another approach.
        if (!r.backoffUntil && r.gripSince >= 0 && now - r.gripSince >= GRIP_WAIT) beginBackoff(e);
        if (r.backoffUntil) { backoff(e, dt); return true; }
        const q = r.target.root.position;
        if ((r.countPath || r.pending) && Math.hypot(q.x - r.goalX, q.z - r.goalZ) > 2.5) {
          clearRoute(e); r.planAt = now;
        }
      } else {
        r.grabHeld = true; carry(e, dt); return true;
      }
      if (owner === e) search(e);
      if (!r.countPath) return true;
      // Facing changes the prop support footprint. A waypoint's old height
      // must not pin a stopped gorilla after its XZ destination is reached.
      while (r.index < r.countPath) {
        const at = r.index * 3;
        if (Math.hypot(r.path[at] - p.x, r.path[at + 2] - p.z) >= 0.07) break;
        const floor = ctx.floorAt(e, p.x, p.z, p.y, e.heading);
        if (!Number.isFinite(floor) || Math.abs(floor - p.y) >= 0.15) break;
        r.index++;
      }
      if (r.index >= r.countPath) {
        if (huntTraverse(e)) return true;
        const q = r.target.root.position;
        if (ctx.approach) {
          if (!ctx.approach(e, r.target, approach)) { failed(e); return true; }
          // Close in through supported steps, then try each fixed side
          // of the original approach. The bearing stays anchored so a
          // blocked hand cannot send the gorilla into an endless orbit.
          if (Math.hypot(approach.x - p.x, approach.z - p.z) < 0.07) {
            let changed = r.approachInset < 0.6;
            if (changed) { r.approachInset = Math.min(0.6, r.approachInset + 0.2); r.blocked = 0; }
            else changed = retryApproach(e, approach.heading);
            if (changed && !ctx.approach(e, r.target, approach)) { failed(e); return true; }
          }
        } else { approach.x = q.x; approach.y = q.y - r.target.baseY; approach.z = q.z; approach.heading = Math.atan2(q.x - p.x, q.z - p.z); }
        const x = p.x, y = p.y, z = p.z, heading = e.heading;
        if (ctx.walk(e, dt, approach.x, approach.y, approach.z, approach.heading)
          && (Math.hypot(p.x - x, p.y - y, p.z - z) > 1e-5 || Math.abs(e.heading - heading) > 1e-5)) r.blocked = 0;
        else if ((r.blocked += dt) > 1.5 && !retryApproach(e, approach.heading)) failed(e);
        return true;
      }
      const at = r.index * 3, x = r.path[at], y = r.path[at + 1], z = r.path[at + 2];
      const beforeX = p.x, beforeY = p.y, beforeZ = p.z, heading = e.heading;
      if (ctx.walk(e, dt, x, y, z, Math.atan2(x - p.x, z - p.z))
        && (Math.hypot(p.x - beforeX, p.y - beforeY, p.z - beforeZ) > 1e-5 || Math.abs(e.heading - heading) > 1e-5)) r.blocked = 0;
      else if ((r.blocked += dt) > 0.5) { clearRoute(e); r.planAt = now + 0.2; }
      return true;
    };
    const dispose = () => {
      for (let i = 0; i < list.length; i++) { cancel(list[i], "dispose"); list[i].rage.search = null; }
      if (unsubscribe) unsubscribe(); owner = null;
    };
    return { frame, check, update, contact, poseResult, bananaHit, debugRage, cancel, dispose };
  };

  // Rage reveals the Agent's original green voxel pattern. Native Matrix
  // mode preserves that palette; calm companions resume their living mode.
  const effects = e => {
    const active = e.rage.active && e.active;
    e.gorilla.setForm(active ? "code" : "ape");
    e.root.matrixNative = active;
  };
  BL.clankerRage = { create, state, signedOut, effects, HITS, WINDOW, DURATION, DEBUG_RANGE, TARGET_HUNT_TIME, WARP_HOLD_TIME };
})();

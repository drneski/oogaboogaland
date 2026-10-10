(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { clamp, damp, mat4, quat } = BL.math;
  const { boundsOf, updateWorld } = BL.scene;
  const { create: createControls } = BL.controls;
  const BASE_FOV = 48 * Math.PI / 180;
  const MAX_FOV = 64 * Math.PI / 180;
  const MIN_HFOV = 58 * Math.PI / 180;
  const YAW_RATE = 1.7, PITCH_RATE = 1.1, DIRECT_VIEW_RATE = 28;
  // Trailing pitch stops 1e-4 short of +-PI/2 so the vertical view keeps a horizontal part and retains its yaw.
  const TRAILING_PITCH = [-Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4];
  const CLOSE_RATE = 12, CLOSE_SNAP = 0.001, CLOSE_PINCH_EXIT = 1.08, CLOSE_LOOK_DIST = 4;
  const AIM_ENTRY_RATE = 8, CARRY_FOCUS_TIME = 0.22;
  const OVERHEAD_TIME = 0.65, OVERHEAD_MIN = 5, OVERHEAD_ZOOM_RATE = 10, OVERHEAD_ZOOM_FAST = 18;
  const OVERHEAD_NORTH_TIME = 0.6;
  const overheadNorthEase = t => t * t * t * (10 + t * (-15 + 6 * t));
  const SHOT_SPREAD = 0.015, ADS_SPREAD = 0.005, SPREAD_MASS = 1 - Math.exp(-4.5);
  const TARGET_INTERVAL = 0.05, HIT_TIME = 0.16, TARGET_MARGIN = 0.035;
  const AIM_CLOSE_HIT = 0.9, AIM_SPREAD_NEAR = 6, AIM_SPREAD_MAX = 2.4;
  const AIM_RETICLE_RADIUS = 14;
  const AUTO_AIM_PROPS = new Set(["crate", "barrel", "rock"]);
  const SHOULDER_PITCH = 0.42, SHOULDER_LIFT = 0.16, SHOULDER_DISTANCE = 2.85, SHOULDER_SIDE = 0.6;
  const SHOULDER_SWAP_RATE = 10, PEEK_CAMERA = 0.34, PEEK_RATE = 14;
  const POSSESS_OVERHEAD_CLEARANCE = 21;
  const RIGHT_DOUBLE_TIME = 350, RIGHT_TAP_TRAVEL = 8;
  // Retain each character's choice across releases and scene visits this session.
  const controlModes = new Map();
  // A lying head may look toward either shoulder, the wall behind it or the
  // feet, but never back through its pillow or the ground beneath its face.
  const LYING_YAW_LIMIT = 80 * Math.PI / 180, LYING_PITCH_LIMIT = 70 * Math.PI / 180;
  const CLOSE_GROUND_RATE = 9, CLOSE_TELEPORT = 0.8;
  const WALK = { speed: 7.75, run: 1.5, gravity: 9.8, step: 0.6, ledgeRise: 2.4, ledgeSpeed: 3, ledgeDrag: 1.5 };
  const ACT_DO = "JUMP!", ACT_FLY = "Blast off!";
  // Camera rotations carry look and up together, including a sleeper's roll.
  // Local -Z looks forward; local +Y is the top of the rendered image.
  const viewRotation = (out, fx, fy, fz, ux, uy, uz, yaw) => {
    let length = Math.hypot(fx, fy, fz);
    if (length < 1e-9) { fx = -Math.sin(yaw); fy = 0; fz = -Math.cos(yaw); length = 1; }
    const bx = -fx / length, by = -fy / length, bz = -fz / length;
    let rx = uy * bz - uz * by, ry = uz * bx - ux * bz, rz = ux * by - uy * bx;
    length = Math.hypot(rx, ry, rz);
    if (length < 1e-9) { rx = Math.cos(yaw); ry = 0; rz = -Math.sin(yaw); length = 1; }
    rx /= length; ry /= length; rz /= length;
    ux = by * rz - bz * ry; uy = bz * rx - bx * rz; uz = bx * ry - by * rx;
    const trace = rx + uy + bz;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      out[0] = (uz - by) / s; out[1] = (bx - rz) / s; out[2] = (ry - ux) / s; out[3] = s / 4;
    } else if (rx > uy && rx > bz) {
      const s = Math.sqrt(1 + rx - uy - bz) * 2;
      out[0] = s / 4; out[1] = (ux + ry) / s; out[2] = (bx + rz) / s; out[3] = (uz - by) / s;
    } else if (uy > bz) {
      const s = Math.sqrt(1 + uy - rx - bz) * 2;
      out[0] = (ux + ry) / s; out[1] = s / 4; out[2] = (by + uz) / s; out[3] = (bx - rz) / s;
    } else {
      const s = Math.sqrt(1 + bz - rx - uy) * 2;
      out[0] = (bx + rz) / s; out[1] = (by + uz) / s; out[2] = s / 4; out[3] = (ry - ux) / s;
    }
    quat.normalize(out);
  };
  const create = (ctx) => {
    const { renderer, canvas, camera, hud, presets, dist: [DIST_MIN, DIST_MAX], follow, fly, clampTarget, clampCamera, coarse, close = null, ceilingAt = null, mayPossess = null } = ctx;
    let crew = null, fx = null, input = null, reticleTarget = null, active = true;
    let ownAccount = null, ownCrew = null, ownOoga = null;
    const syncOwnOoga = () => {
      const account = BL.net.state.me;
      if (account === ownAccount && crew === ownCrew) return;
      ownAccount = account; ownCrew = crew;
      const character = BL.net.ownCharacter();
      ownOoga = character && crew && crew.cavemen ? crew.cavemen.get(character.handle) || null : null;
      if (hud.setOwnOoga) hud.setOwnOoga(ownOoga);
    };
    const unsubscribeOwnOoga = BL.net.subscribe(syncOwnOoga);
    let restoredPose = null;
    const freeTarget = { x: 0, y: 0, z: 0 };
    const followTarget = { x: 0, y: 0, z: 0 };
    const view = presets[ctx.landing];
    const orbit = { ...view, tYaw: view.yaw, tPitch: view.pitch, tDist: view.dist, tx: view.target.x, ty: view.target.y, tz: view.target.z };
    let freeStrafe = 0, freeForward = 0, freeClimb = 0, freeMoveYaw = view.yaw;
    let closeWanted = false, shoulderView = false, closeMix = 0, closeVelocity = 0, closeRate = CLOSE_RATE, distanceVelocity = 0, closeExitScale = 1, closeCave = null, hiddenHead = null, hiddenHeadCameraHidden = false, viewPitch = orbit.pitch;
    let groundView = 0, groundTarget = 0, groundX = 0, groundZ = 0, groundZone = 0, groundValid = false, groundLift = 0, groundEasing = false;
    let freeFeetY = 0, freeFloorY = 0, freeFallV = 0, freeLeapX = 0, freeLeapZ = 0, freeFallValid = false, freeFalling = false;
    let freeCloud = null;
    let sleepingView = false, trailingPitchChosen = false;
    let lyingView = 0, lyingCave = null, lyingYaw = 0, lyingPitch = 0;
    const sleepForward = new Float64Array(3), sleepUp = new Float64Array(3);
    const sleepCameraUp = { x: 0, y: 1, z: 0 };
    const orbitRotation = quat.create(), headRotation = quat.create(), cameraRotation = quat.create(), releaseRotation = quat.create();
    const entryRoll = quat.create(), inverseRotation = quat.create();
    let releaseMix = 0, closeCameraActive = false;
    let headOrbit = false, exitAngleHold = false, exitBodyX = 0, exitBodyY = 0, exitBodyZ = 0;
    const headOrbitOffset = { x: 0, y: 0, z: 0 };
    const headInverse = mat4.create(), headPartMatrix = mat4.create(), headEye = new Float64Array(3), headNear = new Float64Array(3), headBounds = new Float64Array(6);
    const rollingForward = new Float64Array(3), rollingUp = new Float64Array(3), rollingRight = new Float64Array(3), rollingBaseForward = new Float64Array(3);
    const entryPosition = { x: 0, y: 0, z: 0 };
    let entryRebase = false, entryOffsetActive = false, freeEntry = false;
    const previousEye = { x: 0, y: 0, z: 0 }, eyeVelocity = { x: 0, y: 0, z: 0 }, dollyVelocity = { x: 0, y: 0, z: 0 };
    const previousAnchor = { x: 0, y: 0, z: 0 }, motionAnchor = { x: 0, y: 0, z: 0 }, anchorVelocity = { x: 0, y: 0, z: 0 };
    const DOLLY_HANDOFF = 0.25;
    let eyeMotionValid = false, dollyTime = DOLLY_HANDOFF;
    const carryDollyVelocity = (following = false) => {
      dollyVelocity.x = eyeVelocity.x - (following ? anchorVelocity.x : 0);
      dollyVelocity.y = eyeVelocity.y - (following ? anchorVelocity.y : 0);
      dollyVelocity.z = eyeVelocity.z - (following ? anchorVelocity.z : 0);
      dollyTime = eyeMotionValid ? 0 : DOLLY_HANDOFF;
    };
    const headAnchor = (cave, out) => {
      const p = crew.sleeping && cave.root.quaternion ? cave.sleepHead : cave.root.position;
      out.x = p.x; out.z = p.z;
      out.y = p.y + (p === cave.sleepHead ? 0 : -cave.baseY + cave.headOffset * close.eyeRatio + cave.viewLift);
    };
    const resetFreeFall = () => {
      freeFallV = freeLeapX = freeLeapZ = 0;
      freeFallValid = freeFalling = false;
      freeCloud = null;
    };
    const bind = (systems) => {
      crew = systems.crew;
      input = systems.input;
      reticleTarget = systems.reticleTarget || null;
      sightClear = systems.fireReachable || null;
      cursorClear = systems.cursorReachable || sightClear;
      aimSurface = systems.aimSurface || null;
      systems.aimTarget = aimTarget;
      systems.meleeTarget = meleeTarget;
      systems.onWeaponHit = weaponHit;
      fx = systems.fx;
      syncOwnOoga();
    };
    const player = () => crew ? crew.player : null;
    const rememberControlMode = () => {
      const cave = player();
      if (cave && !crew.sleeping && controlModes.get(cave.traits.name) !== cave.weapon.aiming) controlModes.set(cave.traits.name, cave.weapon.aiming);
    };
    // Carry still owns an orbit. Combat's overhead pointer stays on the upper
    // centreline: vertical input sets its reach, horizontal input turns the view.
    const overheadMin = ctx.birdsEyeMin ?? OVERHEAD_MIN;
    // A scene with no follow (the mine) never carries an Ooga, so it never reads this.
    const carryOrbitMin = follow ? Math.max(DIST_MIN, clamp(close ? close.trailingDist : follow.min, follow.min, follow.max)) : DIST_MIN;
    const overheadDefault = ctx.birdsEyeMin ?? Math.max(OVERHEAD_MIN + 1, DIST_MAX * 0.5);
    let overheadActive = false, overheadMix = 0, overheadExit = 0, overheadTime = 0;
    let overheadHeight = overheadDefault, overheadWanted = overheadHeight, overheadVelocity = 0, overheadYaw = 0;
    let overheadTargetYaw = 0, overheadEntryYaw = 0, overheadEntryPitch = 0, overheadEntryRadius = 0, overheadToShoulder = false, overheadNorthUp = false;
    let overheadNorthStartYaw = 0, overheadNorthTime = 0;
    let overheadX = 0, overheadY = 0, overheadPointerMoved = false, overheadCeiling = Infinity;
    const overheadEntry = { x: 0, y: 0, z: 0 }, overheadAim = { x: 0, y: 0, z: 0 };
    const overheadRotation = quat.create(), overheadStartRotation = quat.create(), overheadViewRotation = quat.create();
    // Carry entered from overhead keeps the same root-centred orbit, including
    // its vertical pole. It must not inherit head/portrait framing or a clamp.
    let centeredCarry = false, carryTime = OVERHEAD_TIME, carryStartOrtho = 0, carryStartScale = 0, carryFov = BASE_FOV;
    const carryStartRotation = quat.create();
    const aimCorrection = quat.create(), aimScreenRay = new Float64Array(3);
    let overheadFov = BASE_FOV, overheadStartOrtho = 0, overheadStartScale = 0;
    const reticle = document.getElementById("weapon-reticle");
    const targetHit = { node: null, owner: null, x: 0, y: 0, z: 0, distance: 0, type: "object" };
    const assistedTargetHit = { node: null, owner: null, x: 0, y: 0, z: 0, distance: 0, type: "object" };
    const assistedTargetScreen = { x: 0, y: 0 }, aimProjection = new Float64Array(3), aimCenter = new Float64Array(3);
    const targetOrigin = { x: 0, y: 0, z: 0 };
    let targetWait = 0, targetPrimary = false, targetActive = false, hitRemaining = 0, hitStrength = 0;
    let combatTooltipCave = null, combatTooltipText = "";
    let assistedTargetActive = false, assistedTargetInRange = false, assistedTargetClose = false, assistedTargetDistance = Infinity, assistedTargetWait = 0, assistedReticleX = NaN, assistedReticleY = NaN;
    const targetFeedback = (type) => {
      if (reticle.dataset.target !== type) reticle.dataset.target = type;
    };
    const feedbackType = (hit) => {
      if (!hit || !hit.owner) return "none";
      const kind = hit.owner.kind;
      if (kind === "clanker" || kind === "agent") return "friendly";
      if (kind === "caveman") return hit.type;
      if (kind === "crate") return "object";
      return reticleTarget ? reticleTarget(hit) : hit.type;
    };
    const visualTarget = (owner) => owner.cave !== player();
    const setCombatTooltip = (hit) => {
      const owner = hit && hit.owner, gorilla = owner && owner.kind === "clanker";
      const cave = owner && (gorilla || owner.kind === "caveman") ? owner.cave : null;
      if (cave !== combatTooltipCave) combatTooltipText = cave ? gorilla ? `🦍 ${owner.entry.owner.traits.display}` : cave.traits.display : "";
      else if (!cave || !hud.el.tooltip.hidden && hud.el.tooltipText.textContent === combatTooltipText) return;
      combatTooltipCave = cave;
      if (cave) hud.tooltip.show(combatTooltipText, 0, 0, cave, !!gorilla);
      else hud.tooltip.hide();
    };
    const clearFeedback = () => {
      targetWait = hitRemaining = hitStrength = 0;
      targetActive = false;
      setCombatTooltip(null);
      targetFeedback("none");
      if (reticle.dataset.hit !== "none") reticle.dataset.hit = "none";
      reticle.style.removeProperty("--reticle-hit");
    };
    const weaponHit = (source, type) => {
      if (source !== player() || !armed()) return;
      hitRemaining = HIT_TIME;
      hitStrength = 1;
      if (reticle.dataset.hit !== type) reticle.dataset.hit = type;
      reticle.style.setProperty("--reticle-hit", "1");
    };
    const aimEntryBody = { x: 0, y: 0, z: 0 };
    const aimEntry = { x: 0, y: 0, z: 0 };
    const aimEntryRotation = quat.create(), aimLookRotation = quat.create(), aimPanRotation = quat.create();
    const aimForward = new Float64Array(3);
    let aimEntryRadius = 0, aimEntryYaw = 0, aimEntryHeight = 0, aimBodyYaw = 0, aimBodyPitch = 0, aimBodyHeadYaw = 0, aimAtCursor = false, aimPreserveFacing = false;
    let aimWeaponYaw = 0, aimWeaponPitch = 0, overheadWeaponYaw = 0, overheadWeaponPitch = 0;
    let aimScreenX = 0, aimScreenY = 0, aimEntryOrtho = 0;
    const aimPoint = { x: 0, y: 0, z: 0 };
    const cursorItem = { x: 0, y: 0, z: 0 };
    const cursorPoint = { x: 0, y: 0, z: 0 }, cursorRay = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 };
    const cursorView = mat4.create(), cursorUp = { x: 0, y: 1, z: 0 };
    let cursorAim = false, cursorOccluded = false, shoulderSide = SHOULDER_SIDE, shoulderSideTarget = SHOULDER_SIDE;
    let peekTarget = 0, peekMix = 0;
    let aimCave = null, aimMix = 0, aimVelocity = 0, adsMix = 0, ads = false, disposed = false;
    let aimLeftAccepted = false, aimLeftFocused = false, aimReleaseEvent = null;
    let rightDownAt = -Infinity, rightTapAt = -Infinity, rightTravel = 0, rightExitHeld = false, rightReturnFirstPerson = false;
    let primaryButtonCave = null;
    const buttonTarget = { x: 0, y: 0, z: 0 };
    let reticleRadius = -1;
    let zoomTilt = false, zoomPitchVelocity = 0, zoomAnchorPitch = 0, zoomAnchorDistance = DIST_MIN;
    let carryExitMode = 0, carryExitBase = 0, carryExitHeight = 0, carryExitVelocity = 0, carryFocusRemaining = 0;
    const stopCarryExit = () => {
      if (!carryExitMode) return;
      carryExitMode = 0;
      carryFocusRemaining = 0;
      orbit.tPitch = orbit.pitch;
      zoomTilt = false;
      zoomPitchVelocity = 0;
    };
    let lockPending = false, aimLocked = false, softAimFocused = false, externalControl = false, externalCombat = null, unlockedAt = -Infinity;
    let savedPitch = 0, savedDist = 0, savedNear = camera.near, sightClear = null, cursorClear = null, aimSurface = null;
    const weaponViewReady = (cave) => active && !!cave && !cave.health.stunned && !crew.sleeping && (closeWanted || (!cave.camp.seat || cave.camp.seat.allowWeapons) && !cave.bedTravel.mode);
    const shoulderBoomPitch = (pitch) => Math.max(pitch, Math.min(0, pitch + 0.22));
    const shoulderDistance = (cave, pitch) => {
      // Keep the feet above the bottom 5% while the head stays near the
      // crosshair. Looking toward the horizon needs a little more room.
      const height = (cave.headOffset * 0.95 + cave.viewLift) / cave.traits.height + SHOULDER_LIFT;
      const margin = 0.9 * Math.tan(BASE_FOV / 2), angle = pitch - shoulderBoomPitch(pitch);
      return Math.max(SHOULDER_DISTANCE, height * (Math.cos(pitch) - margin * Math.sin(pitch)) / (margin * Math.cos(angle) + Math.sin(angle)));
    };
    const armed = () => {
      const cave = player();
      return weaponViewReady(cave) && cave.weapon.aiming;
    };
    const aimView = () => {
      const cave = player();
      return weaponViewReady(cave) && (closeWanted || shoulderView);
    };
    const lyingType = (cave) => cave && (closeWanted || closeMix > 0) && cave.root.quaternion
      ? crew.sleeping ? 1 : cave.camp.rolling ? 2 : 0 : 0;
    const posedHeadFrame = (cave) => {
      updateWorld(cave.root, cave.root.parent ? cave.root.parent.world : undefined);
      const head = cave.parts.head, bounds = boundsOf(head.geometry), m = head.world;
      mat4.transformPoint(headEye, m, bounds.center[0], bounds.center[1], bounds.max[2] + 0.01);
      let length = Math.hypot(m[0], m[1], m[2]);
      rollingRight[0] = m[0] / length; rollingRight[1] = m[1] / length; rollingRight[2] = m[2] / length;
      length = Math.hypot(m[4], m[5], m[6]);
      rollingUp[0] = m[4] / length; rollingUp[1] = m[5] / length; rollingUp[2] = m[6] / length;
      length = Math.hypot(m[8], m[9], m[10]);
      rollingBaseForward[0] = m[8] / length; rollingBaseForward[1] = m[9] / length; rollingBaseForward[2] = m[10] / length;
    };
    const syncLyingView = (cave) => {
      const type = lyingType(cave);
      if (type === lyingView && cave === lyingCave) return type;
      lyingView = type;
      lyingCave = type ? cave : null;
      lyingYaw = lyingPitch = 0;
      if (!type) return 0;
      posedHeadFrame(cave);
      let fx = camera.target.x - camera.position.x, fy = camera.target.y - camera.position.y, fz = camera.target.z - camera.position.z;
      const length = Math.hypot(fx, fy, fz) || 1;
      fx /= length; fy /= length; fz /= length;
      const right = fx * rollingRight[0] + fy * rollingRight[1] + fz * rollingRight[2];
      const up = fx * rollingUp[0] + fy * rollingUp[1] + fz * rollingUp[2];
      const forward = fx * rollingBaseForward[0] + fy * rollingBaseForward[1] + fz * rollingBaseForward[2];
      lyingYaw = clamp(Math.atan2(right, forward), -LYING_YAW_LIMIT, LYING_YAW_LIMIT);
      lyingPitch = clamp(Math.atan2(-up, Math.hypot(right, forward)), -LYING_PITCH_LIMIT, LYING_PITCH_LIMIT);
      return type;
    };
    const moveLyingView = (yaw, pitch) => {
      lyingYaw = clamp(lyingYaw + yaw, -LYING_YAW_LIMIT, LYING_YAW_LIMIT);
      lyingPitch = clamp(lyingPitch + pitch, -LYING_PITCH_LIMIT, LYING_PITCH_LIMIT);
    };
    const applyLyingView = (cave) => {
      posedHeadFrame(cave);
      const cy = Math.cos(lyingYaw), sy = Math.sin(lyingYaw), cp = Math.cos(lyingPitch), sp = Math.sin(lyingPitch);
      const fx = rollingBaseForward[0] * cy + rollingRight[0] * sy;
      const fy = rollingBaseForward[1] * cy + rollingRight[1] * sy;
      const fz = rollingBaseForward[2] * cy + rollingRight[2] * sy;
      rollingForward[0] = fx * cp - rollingUp[0] * sp;
      rollingForward[1] = fy * cp - rollingUp[1] * sp;
      rollingForward[2] = fz * cp - rollingUp[2] * sp;
      sleepCameraUp.x = rollingUp[0] * cp + fx * sp;
      sleepCameraUp.y = rollingUp[1] * cp + fy * sp;
      sleepCameraUp.z = rollingUp[2] * cp + fz * sp;
      viewRotation(headRotation, rollingForward[0], rollingForward[1], rollingForward[2], sleepCameraUp.x, sleepCameraUp.y, sleepCameraUp.z, orbit.yaw);
    };
    const viewMode = () => !player() ? "detached" : closeWanted ? "first-person" : shoulderView ? "shoulder" : armed() ? "birds-eye" : "orbit";
    const birdsEye = () => armed() && !closeWanted && !shoulderView;
    const assistedView = () => birdsEye() || overheadExit > 0 && aimAtCursor;
    const carryCursor = BL.cursor.create({ canvas, requestLock: () => lockAim(), unlock: () => unlockAim() });
    const setSoftAimFocus = (active) => {
      softAimFocused = !!active;
      document.body.classList.toggle("aim-cursor-focused", softAimFocused);
      if (softAimFocused) {
        canvas.tabIndex = -1;
        canvas.focus({ preventScroll: true });
      } else if (document.activeElement === canvas) canvas.blur();
    };
    const resetPointer = () => {
      if (input) input.reset();
      controls.clearPointer();
    };
    const unlockAim = () => {
      if (externalControl && !disposed) return;
      rightDownAt = rightTapAt = -Infinity;
      rightExitHeld = false;
      setSoftAimFocus(false);
      ads = false;
      primaryButtonCave = null;
      aimLeftAccepted = aimLeftFocused = false;
      carryCursor.endAim();
      if (crew) {
        const cave = player();
        if (cave) crew.stopBurst(cave);
        crew.releaseSwing(cave, true);
      }
      if (carryCursor.active) {
        carryCursor.stop();
      }
      resetPointer();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
    // Another playable actor shares the canvas and controls, but owns its own
    // aim events and pointer lock until it hands the pilot control back.
    const setExternalControl = (active, combat = null) => {
      externalControl = !!active;
      externalCombat = active ? combat : null;
      aimLocked = false;
      unlockedAt = -Infinity;
      if (!externalControl) return;
      camera.orthoMix = 0;
      setSoftAimFocus(false);
      ads = false;
      primaryButtonCave = null;
      aimLeftAccepted = aimLeftFocused = false;
      aimReleaseEvent = null;
      carryCursor.stop();
      resetPointer();
    };
    const retireAimLock = () => {
      document.removeEventListener("pointerlockchange", aimLockChanged);
      document.removeEventListener("pointerlockerror", aimLockFailed);
    };
    const aimLockFailed = () => {
      lockPending = false;
      if (externalControl && !disposed) return;
      carryCursor.endAim();
      if (disposed) retireAimLock();
      if (!disposed && armed()) hud.hint("Click the island to hide the cursor and aim · 1 melee · 2 AK · scroll to change view");
    };
    const lockAim = () => {
      if (externalControl || coarse || disposed || !armed() || lockPending || document.pointerLockElement === canvas || !canvas.requestPointerLock) return;
      lockPending = true;
      const request = canvas.requestPointerLock();
      if (request && request.then) request.then(() => {
        lockPending = false;
        if (externalControl && !disposed) return;
        if (disposed || !armed()) unlockAim();
        if (disposed) retireAimLock();
      }, aimLockFailed);
    };
    const focusAim = () => {
      if (externalControl || coarse || disposed || !armed()) return false;
      setSoftAimFocus(true);
      return true;
    };
    const captureAimEntry = (cave) => {
      const p = cave.root.position, up = camera.up || cursorUp;
      aimEntryOrtho = camera.orthoMix || 0;
      aimEntry.x = camera.position.x; aimEntry.y = camera.position.y; aimEntry.z = camera.position.z;
      aimEntryBody.x = p.x; aimEntryBody.y = p.y; aimEntryBody.z = p.z;
      viewRotation(aimEntryRotation, camera.target.x - aimEntry.x, camera.target.y - aimEntry.y, camera.target.z - aimEntry.z, up.x, up.y, up.z, orbit.yaw);
      aimBodyYaw = cave.root.rotation.y; aimBodyPitch = cave.parts.head.rotation.x;
      aimBodyHeadYaw = cave.parts.head.rotation.y;
      aimWeaponYaw = cave.root.rotation.y + cave.weapon.aimYaw;
      aimWeaponPitch = cave.weapon.aimPitch;
      const x = aimEntry.x - p.x, z = aimEntry.z - p.z;
      const y = aimEntry.y - p.y + cave.baseY - cave.headOffset * 0.95 - cave.viewLift;
      aimEntryRadius = Math.hypot(x, z);
      aimEntryYaw = Math.atan2(x, z);
      aimEntryHeight = y;
    };
    const releaseCursorAim = () => {
      if (!aimAtCursor && !aimPreserveFacing) return;
      aimAtCursor = aimPreserveFacing = false;
      // A new look gesture takes over from the displayed eye and heading.
      // Reusing the old arc origin would jump sideways when its endpoint turns.
      const dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z;
      const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(-dy, Math.hypot(dx, dz));
      const changed = Math.abs(Math.atan2(Math.sin(yaw - orbit.yaw), Math.cos(yaw - orbit.yaw))) + Math.abs(pitch - orbit.pitch);
      orbit.yaw = orbit.tYaw = yaw;
      orbit.pitch = orbit.tPitch = pitch;
      if (aimMix === 1 && changed < 1e-4) return;
      captureAimEntry(player());
      carryCursor.rebaseAim();
      aimMix = aimVelocity = 0;
    };
    const syncAim = () => {
      if (externalControl) return;
      rememberControlMode();
      const controlled = player(), combat = armed();
      const overhead = birdsEye();
      if (overhead && !overheadActive) beginOverhead(controlled);
      else if (!overhead && overheadActive) overheadExit = overheadMix;
      overheadActive = overhead;
      if (!combat) overheadMix = overheadExit = 0;
      reticle.hidden = !combat;
      if (!combat) setCombatTooltip(null);
      if (!overhead && !overheadExit) resetAssist();
      const cursorFocused = softAimFocused || document.pointerLockElement === canvas;
      if (combat && overhead && !coarse && cursorFocused && (!carryCursor.active || carryCursor.visible)) {
        const rect = canvas.getBoundingClientRect();
        carryCursor.start(rect.left + overheadX * rect.width / renderer.size.width,
          rect.top + overheadY * rect.height / renderer.size.height, false, false);
      } else if (combat && !overhead && carryCursor.active) { carryCursor.stop(); resetPointer(); }
      if (!combat && (carryCursor.active || softAimFocused || document.pointerLockElement === canvas)) unlockAim();
      const cave = aimView() ? controlled : null;
      if (cave === aimCave) return;
      if (carryCursor.active) {
        ads = false;
        if (controlled) crew.stopBurst(controlled);
        crew.releaseSwing(controlled, true);
      } else if (!combat) unlockAim();
      if (aimCave) {
        camera.near = savedNear;
        const p = aimCave.root.position;
        orbit.tx = p.x; orbit.ty = p.y - aimCave.baseY + follow.y + aimCave.viewLift; orbit.tz = p.z;
        if (!closeWanted) {
          // Rebase the displayed eye around the real follow anchor. A fake
          // focus below it would sink toward the body on the first exit frame.
          const dx = camera.position.x - orbit.tx, dy = camera.position.y - orbit.ty, dz = camera.position.z - orbit.tz;
          orbit.dist = Math.hypot(dx, dy, dz);
          orbit.yaw = Math.atan2(dx, dz);
          const behind = aimCave.root.rotation.y + Math.PI;
          orbit.tYaw = orbit.yaw + Math.atan2(Math.sin(behind - orbit.yaw), Math.cos(behind - orbit.yaw));
          orbit.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          followTarget.x = orbit.tx; followTarget.y = orbit.ty; followTarget.z = orbit.tz;
          orbit.target = followTarget;
          carryExitMode = !overhead && aimCave === player() && weaponViewReady(aimCave)
            ? ceilingAt && ceilingAt(p.x, p.z, p.y - aimCave.baseY, aimCave) < Infinity ? 1 : 2 : 0;
          carryFocusRemaining = carryExitMode ? CARRY_FOCUS_TIME : 0;
          carryExitBase = carryExitHeight = dy;
          carryExitVelocity = 0;
          closeMix = closeVelocity = 0;
          trailingPitchChosen = true;
          distanceVelocity = zoomPitchVelocity = 0;
          orbit.tPitch = Math.max(0.08, savedPitch); orbit.tDist = Math.max(orbit.dist, savedDist);
          viewRotation(cameraRotation, camera.target.x - camera.position.x, camera.target.y - camera.position.y, camera.target.z - camera.position.z, 0, 1, 0, orbit.yaw);
          closeCameraActive = true;
        }
        if (!overhead) aimCave.weapon.aimYaw = 0;
      }
      aimCave = cave;
      clearFeedback();
      reticle.hidden = !combat;
      if (!cave) { peekTarget = peekMix = 0; return; }
      centeredCarry = false;
      carryExitMode = 0;
      carryFocusRemaining = 0;
      savedPitch = orbit.tPitch; savedDist = orbit.tDist; savedNear = camera.near;
      captureAimEntry(cave);
      sleepingView = false;
      const dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z;
      // A point beside/under the body cannot be centred from the normal
      // shoulder eye. Keep the character's heading instead of permanently
      // shrinking the sideways offset to reach that point.
      const cursorTooClose = cursorAim && Math.hypot(cursorPoint.x - cave.root.position.x, cursorPoint.z - cave.root.position.z) < SHOULDER_SIDE * cave.traits.height * 2;
      aimPreserveFacing = (cursorOccluded || cursorTooClose) && !closeWanted;
      aimAtCursor = cursorAim && !aimPreserveFacing && !closeWanted;
      orbit.yaw = orbit.tYaw = Math.atan2(-dx, -dz);
      orbit.pitch = orbit.tPitch = closeWanted ? Math.atan2(-dy, Math.hypot(dx, dz)) : SHOULDER_PITCH;
      shoulderSide = shoulderSideTarget = SHOULDER_SIDE;
      if (aimPreserveFacing) {
        // A wall in front of the orbit eye is an obstruction to navigation,
        // not an instruction to turn the character back toward that wall.
        orbit.yaw = orbit.tYaw = aimBodyYaw + aimBodyHeadYaw + Math.PI;
        orbit.pitch = orbit.tPitch = aimBodyPitch;
      } else if (aimAtCursor) {
        const h = cave.traits.height, p = cave.root.position;
        const x = cursorPoint.x - p.x, z = cursorPoint.z - p.z, horizontal = Math.hypot(x, z);
        const side = SHOULDER_SIDE * h;
        if (horizontal > 1e-6) orbit.yaw = orbit.tYaw = Math.atan2(-x, -z) + Math.asin(side / horizontal);
        const forward = Math.sqrt(Math.max(0, horizontal * horizontal - side * side));
        const y = p.y - cave.baseY + cave.headOffset * 0.95 + cave.viewLift + SHOULDER_LIFT * h - cursorPoint.y;
        // Solve the viewing angle from the safe shoulder eye. Aiming slightly
        // above eye level must not drag the physical boom under the character.
        let low = TRAILING_PITCH[0], high = TRAILING_PITCH[1];
        for (let i = 0; i < 32; i++) {
          const pitch = (low + high) * 0.5, boom = shoulderBoomPitch(pitch), distance = shoulderDistance(cave, pitch) * h;
          const look = Math.atan2(y + Math.sin(boom) * distance, forward + Math.cos(boom) * distance);
          if (pitch < look) low = pitch; else high = pitch;
        }
        orbit.pitch = orbit.tPitch = (low + high) * 0.5;
        // Preserve the selected point's screen position while the pointer
        // approaches the reticle. Camera translation and pan share this aim.
        mat4.lookAt(cursorView, camera.position, camera.target, camera.up || cursorUp);
        const rx = cursorPoint.x - camera.position.x, ry = cursorPoint.y - camera.position.y, rz = cursorPoint.z - camera.position.z;
        const depth = mat4.projectionDepth(-(cursorView[2] * rx + cursorView[6] * ry + cursorView[10] * rz), camera.fov, camera.orthoMix, camera.orthoHeight);
        const tangent = Math.tan(camera.fov * 0.5);
        aimScreenX = (cursorView[0] * rx + cursorView[4] * ry + cursorView[8] * rz) / depth / tangent / (renderer.size.width / renderer.size.height);
        aimScreenY = (cursorView[1] * rx + cursorView[5] * ry + cursorView[9] * rz) / depth / tangent;
      }
      cursorAim = cursorOccluded = false;
      aimMix = aimVelocity = adsMix = zoomPitchVelocity = 0;
      zoomTilt = false;
      // Carry an ongoing inward dolly into shoulder view instead of braking
      // to a stop just because the scroll crossed the camera-mode boundary.
      if (eyeMotionValid) {
        const h = cave.traits.height, sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw), boomPitch = shoulderBoomPitch(orbit.pitch);
        const distance = shoulderDistance(cave, orbit.pitch) * h * (1 - closeMix), side = shoulderSide * h * (1 - closeMix);
        const horizontal = Math.cos(boomPitch) * distance - Math.cos(orbit.pitch) * 0.16 * h * closeMix;
        const endX = sy * horizontal + cy * side, endZ = cy * horizontal - sy * side;
        const endY = Math.sin(boomPitch) * distance + SHOULDER_LIFT * h * (1 - closeMix);
        const radial = Math.hypot(endX, endZ) - aimEntryRadius;
        const yaw = Math.atan2(Math.sin(Math.atan2(endX, endZ) - aimEntryYaw), Math.cos(Math.atan2(endX, endZ) - aimEntryYaw));
        const es = Math.sin(aimEntryYaw), ec = Math.cos(aimEntryYaw);
        // Carry the incoming velocity along the arc's tangent, not a chord
        // through the character when the new target is off to one side.
        const vx = es * radial + aimEntryRadius * ec * yaw;
        const vy = endY - aimEntryHeight;
        const vz = ec * radial - aimEntryRadius * es * yaw;
        const length2 = vx * vx + vy * vy + vz * vz;
        if (length2 > 1e-8) aimVelocity = clamp(((eyeVelocity.x - anchorVelocity.x) * vx + (eyeVelocity.y - anchorVelocity.y) * vy + (eyeVelocity.z - anchorVelocity.z) * vz) / length2, 0, AIM_ENTRY_RATE);
      }
      headOrbit = exitAngleHold = entryOffsetActive = entryRebase = false;
      releaseMix = 0;
      camera.near = Math.min(savedNear, 0.06);
      hud.tooltip.hide();
    };
    // Resolve the viewing ray on a shot or cursor-directed entry. Bounded
    // bisection reuses terrain/prop sweeps without per-frame geometry scans.
    const pointAlongAim = (out, x, y, z, dx, dy, dz, reach = 60, clear = sightClear, iterations = 12) => {
      let lo = 0, hi = reach;
      if (clear && !clear(x, y, z, x + dx * hi, y + dy * hi, z + dz * hi)) {
        for (let i = 0; i < iterations; i++) {
          const mid = (lo + hi) * 0.5;
          if (clear(x, y, z, x + dx * mid, y + dy * mid, z + dz * mid)) lo = mid;
          else hi = mid;
        }
        hi = lo;
      } else hi = 60;
      out.x = x + dx * hi; out.y = y + dy * hi; out.z = z + dz * hi;
      if (aimSurface) aimSurface(out, x, y, z);
    };
    const spreadRadius = () => renderer.size.height * (SHOT_SPREAD + (ADS_SPREAD - SHOT_SPREAD) * adsMix) / (2 * Math.tan(camera.fov / 2));
    const targetAlongAim = (out, x, y, z, dx, dy, dz) => {
      if (!input || !input.weaponTargets || !input.weaponTargets.ray(targetHit, x, y, z, dx, dy, dz, 60, player())) return false;
      const clear = sightClear || cursorClear, near = Math.max(0, targetHit.distance - 1e-5);
      // The real target must precede scenery padding, especially at grazing
      // angles. Exclude its own shell while keeping intervening cover solid.
      if (clear && !clear(x, y, z, x + dx * near, y + dy * near, z + dz * near, targetHit.node, true)) return false;
      out.x = targetHit.x; out.y = targetHit.y; out.z = targetHit.z;
      return true;
    };
    // The view ray aims, but cover counts only from the muzzle's depth on: a palm or rock
    // between the camera and the Ooga must not stop the aim point behind the gun.
    const aimAlongView = (out, x, y, z, dx, dy, dz) => {
      crew.weaponOrigin(targetOrigin, player(), false);
      const skip = Math.max(0, (targetOrigin.x - x) * dx + (targetOrigin.y - y) * dy + (targetOrigin.z - z) * dz);
      x += dx * skip; y += dy * skip; z += dz * skip;
      if (!targetAlongAim(out, x, y, z, dx, dy, dz)) pointAlongAim(out, x, y, z, dx, dy, dz);
    };
    const aimTarget = (out, spread = false) => {
      if (assistedView()) {
        const cave = player();
        crew.weaponOrigin(targetOrigin, cave, false);
        if (assistedTargetActive || overheadExit && aimAtCursor) {
          const point = overheadExit && aimAtCursor ? cursorPoint : assistedTargetHit;
          if (!spread || assistedTargetClose) {
            out.x = point.x; out.y = point.y; out.z = point.z;
            return;
          }
          // Assisted aim belongs to the selected world target, independent of
          // where the detached camera happens to be. Apply the same bounded
          // shot variance around the muzzle-to-target ray.
          let fx = point.x - targetOrigin.x, fy = point.y - targetOrigin.y, fz = point.z - targetOrigin.z;
          const distance = Math.hypot(fx, fy, fz);
          fx /= distance; fy /= distance; fz /= distance;
          const horizontal = Math.hypot(fx, fz);
          const rx = horizontal > 1e-8 ? fz / horizontal : 1, ry = 0, rz = horizontal > 1e-8 ? -fx / horizontal : 0;
          const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
          const radius = SHOT_SPREAD * Math.min(AIM_SPREAD_MAX, Math.max(0.35, distance / AIM_SPREAD_NEAR))
            * Math.sqrt(-2 * Math.log(1 - Math.random() * SPREAD_MASS)) / 3;
          const angle = Math.random() * Math.PI * 2;
          const side = Math.cos(angle) * radius, lift = Math.sin(angle) * radius;
          const dx = fx + rx * side + ux * lift, dy = fy + ry * side + uy * lift, dz = fz + rz * side + uz * lift;
          if (!targetAlongAim(out, targetOrigin.x, targetOrigin.y, targetOrigin.z, dx, dy, dz)) {
            pointAlongAim(out, targetOrigin.x, targetOrigin.y, targetOrigin.z, dx, dy, dz);
          }
          return;
        }
        const yaw = cave.root.rotation.y;
        out.x = targetOrigin.x + Math.sin(yaw) * 60;
        out.y = targetOrigin.y;
        out.z = targetOrigin.z + Math.cos(yaw) * 60;
        return;
      }
      if (spread) {
        // A circular Gaussian, truncated at three sigma so the ring bounds
        // the shot cone. Inverse sampling needs two draws and no retry loop.
        const radius = spreadRadius() * Math.sqrt(-2 * Math.log(1 - Math.random() * SPREAD_MASS)) / 3;
        const angle = Math.random() * Math.PI * 2;
        mat4.lookAt(cursorView, camera.position, camera.target, camera.up || cursorUp);
        mat4.rayFromView(cursorRay, cursorView, renderer.size.width, renderer.size.height, camera.fov, camera.position,
          renderer.size.width / 2 + Math.cos(angle) * radius, renderer.size.height / 2 + Math.sin(angle) * radius, camera.orthoMix, camera.orthoHeight);
        aimAlongView(out, cursorRay.ox, cursorRay.oy, cursorRay.oz, cursorRay.dx, cursorRay.dy, cursorRay.dz);
        return;
      }
      const p = camera.position, dx = camera.target.x - p.x, dy = camera.target.y - p.y, dz = camera.target.z - p.z;
      const length = Math.hypot(dx, dy, dz);
      aimAlongView(out, p.x, p.y, p.z, dx / length, dy / length, dz / length);
    };
    const resolveReticleTarget = (out, cave, primary, visual = false) => {
      if (!input || !input.weaponTargets) return false;
      crew.weaponOrigin(targetOrigin, cave, primary);
      const eye = camera.position, dx = camera.target.x - eye.x, dy = camera.target.y - eye.y, dz = camera.target.z - eye.z;
      const length = Math.hypot(dx, dy, dz), reach = visual ? 60 : primary ? crew.meleeReach(cave) : 60;
      const eyeReach = reach + Math.hypot(eye.x - targetOrigin.x, eye.y - targetOrigin.y, eye.z - targetOrigin.z);
      // Visual inspection includes the Ooga's own companion; weapon contacts
      // keep their existing friendly-fire exclusions.
      if (!input.weaponTargets.ray(out, eye.x, eye.y, eye.z, dx / length, dy / length, dz / length, Math.min(60, eyeReach),
        visual ? null : cave, visual ? visualTarget : null, visual)) return false;
      const mx = out.x - targetOrigin.x, my = out.y - targetOrigin.y, mz = out.z - targetOrigin.z;
      const distance = Math.hypot(mx, my, mz), near = Math.max(0, 1 - TARGET_MARGIN / Math.max(distance, TARGET_MARGIN));
      const cameraNear = Math.max(0, out.distance - TARGET_MARGIN) / length;
      const clear = sightClear || cursorClear;
      // Melee contacts keep their weapon reach; visual feedback can inspect
      // interactive targets farther away without changing a released strike.
      return distance <= reach && (!clear || clear(eye.x, eye.y, eye.z, eye.x + dx * cameraNear, eye.y + dy * cameraNear, eye.z + dz * cameraNear, out.node, true))
        && (!clear || clear(targetOrigin.x, targetOrigin.y, targetOrigin.z, targetOrigin.x + mx * near, targetOrigin.y + my * near, targetOrigin.z + mz * near, out.node, true));
    };
    const meleeTarget = (out, cave) => {
      if (cave !== player() || !cave.weapon.primaryEquipped && !cave.weapon.equipped) return false;
      const primary = cave.weapon.primaryEquipped;
      if (!armed()) {
        crew.weaponOrigin(targetOrigin, cave, true);
        const yaw = cave.root.rotation.y;
        return input.weaponTargets.verticalRay(out, targetOrigin.x, targetOrigin.y, targetOrigin.z,
          Math.sin(yaw), Math.cos(yaw), crew.meleeReach(cave), cave, sightClear || cursorClear) && (!primary || out.type === "object");
      }
      if (assistedView()) {
        if (!assistedTargetActive || !(primary ? assistedTargetInRange : assistedMeleeInRange(cave)) || primary && assistedTargetHit.type !== "object") return false;
        Object.assign(out, assistedTargetHit);
        return true;
      }
      return resolveReticleTarget(out, cave, true) && (!primary || out.type === "object");
    };
    const updateFeedback = (cave, dt) => {
      if (hitRemaining > 0) {
        hitRemaining = Math.max(0, hitRemaining - dt);
        const strength = Math.round(hitRemaining / HIT_TIME * 100) / 100;
        if (strength !== hitStrength) {
          hitStrength = strength;
          reticle.style.setProperty("--reticle-hit", String(strength));
        }
        if (!hitRemaining) reticle.dataset.hit = "none";
      }
      targetWait -= dt;
      const primary = cave.weapon.primaryEquipped;
      if (targetWait > 0 && primary === targetPrimary) {
        setCombatTooltip(targetActive ? targetHit : null);
        return;
      }
      targetWait = TARGET_INTERVAL;
      targetPrimary = primary;
      if (assistedView()) {
        targetActive = !!(input && input.weaponTargets && input.weaponTargets.ray(targetHit,
          cursorRay.ox, cursorRay.oy, cursorRay.oz, cursorRay.dx, cursorRay.dy, cursorRay.dz, 60, null, visualTarget, true));
        if (targetActive) {
          const clear = sightClear || cursorClear, near = Math.max(0, 1 - TARGET_MARGIN / Math.max(targetHit.distance, TARGET_MARGIN));
          if (clear && !clear(cursorRay.ox, cursorRay.oy, cursorRay.oz,
            cursorRay.ox + (targetHit.x - cursorRay.ox) * near, cursorRay.oy + (targetHit.y - cursorRay.oy) * near,
            cursorRay.oz + (targetHit.z - cursorRay.oz) * near, targetHit.node, true)) targetActive = false;
        }
        targetFeedback(targetActive ? feedbackType(targetHit) : "none");
        setCombatTooltip(targetActive ? targetHit : null);
        return;
      }
      targetActive = resolveReticleTarget(targetHit, cave, primary, true);
      targetFeedback(targetActive ? feedbackType(targetHit) : "none");
      setCombatTooltip(targetActive ? targetHit : null);
    };
    const positionReticle = (x, y) => {
      x = Math.round(x * 100) / 100; y = Math.round(y * 100) / 100;
      if (x !== assistedReticleX) { assistedReticleX = x; reticle.style.left = `${x}px`; }
      if (y !== assistedReticleY) { assistedReticleY = y; reticle.style.top = `${y}px`; }
      if (birdsEye() && carryCursor.active && !carryCursor.visible) {
        carryCursor.placeCanvas(x, y, renderer.size.width, renderer.size.height);
      }
    };
    const resetAssist = () => {
      assistedTargetActive = assistedTargetInRange = assistedTargetClose = false;
      assistedTargetDistance = Infinity;
      assistedTargetWait = 0;
      // The HUD survives scene visits; its offset may belong to the previous
      // pilot even when this visit has never positioned the overhead reticle.
      if (!Number.isNaN(assistedReticleX) || reticle.style.left || reticle.style.top) {
        assistedReticleX = assistedReticleY = NaN;
        reticle.style.removeProperty("left");
        reticle.style.removeProperty("top");
      }
      if (reticle.dataset.close !== "false") reticle.dataset.close = "false";
      if (reticle.dataset.occluded !== "false") reticle.dataset.occluded = "false";
    };
    const autoTarget = (owner, node) => !!(owner && (owner.kind === "caveman" || owner.kind === "room-sign"
      || owner.kind === "prop" && AUTO_AIM_PROPS.has(owner.prop)) || node && node.mirror);
    const centerTarget = (hit) => {
      const owner = hit.owner, node = hit.node;
      if (!owner || !node) return;
      if (node.mirrorDamage?.aimCenter && node.mirrorDamage.aimCenter(hit, hit.x, hit.y, hit.z)) return;
      if (owner.kind === "caveman") {
        const target = owner.cave, p = target.root.position;
        hit.x = p.x; hit.y = p.y - target.baseY + target.bodyHeight * 0.5; hit.z = p.z;
        return;
      }
      const bounds = boundsOf(node.geometry);
      mat4.transformPoint(aimCenter, node.world, (bounds.min[0] + bounds.max[0]) * 0.5,
        (bounds.min[1] + bounds.max[1]) * 0.5, (bounds.min[2] + bounds.max[2]) * 0.5);
      hit.x = aimCenter[0]; hit.y = aimCenter[1]; hit.z = aimCenter[2];
    };
    const assistedMeleeInRange = (cave) => {
      crew.weaponOrigin(targetOrigin, cave, true);
      const dx = assistedTargetHit.x - targetOrigin.x, dy = assistedTargetHit.y - targetOrigin.y, dz = assistedTargetHit.z - targetOrigin.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance > crew.meleeReach(cave)) return false;
      const clear = sightClear || cursorClear, near = Math.max(0, 1 - TARGET_MARGIN / Math.max(distance, TARGET_MARGIN));
      return !clear || clear(targetOrigin.x, targetOrigin.y, targetOrigin.z,
        targetOrigin.x + dx * near, targetOrigin.y + dy * near, targetOrigin.z + dz * near, assistedTargetHit.node, true);
    };
    const sameLevelTarget = (owner, node) => {
      if (!autoTarget(owner, node)) return false;
      const cave = player(), feet = cave.root.position.y - cave.baseY - cave.hop;
      if (owner && owner.cave) {
        const other = owner.cave;
        const floor = other.root.position.y - other.baseY - (other.hop || 0);
        return floor >= feet - 0.7 && floor < overheadCeiling - 0.2;
      }
      const bounds = boundsOf(node.geometry), m = node.world;
      const y = m[1] * bounds.center[0] + m[5] * bounds.center[1] + m[9] * bounds.center[2] + m[13];
      return y >= feet - 0.4 && y < overheadCeiling;
    };
    const projectAim = (point) => {
      mat4.lookAt(cursorView, camera.position, camera.target, camera.up || cursorUp);
      mat4.transformPoint(aimProjection, cursorView, point.x, point.y, point.z);
      if (-aimProjection[2] <= 0.01) return false;
      const depth = mat4.projectionDepth(-aimProjection[2], camera.fov, camera.orthoMix, camera.orthoHeight), focal = renderer.size.height / (2 * Math.tan(camera.fov / 2));
      assistedTargetScreen.x = renderer.size.width / 2 + aimProjection[0] * focal / depth;
      assistedTargetScreen.y = renderer.size.height / 2 - aimProjection[1] * focal / depth;
      return true;
    };
    const beginOverhead = (cave, preserve = false, preserveNorth = false) => {
      const p = cave.root.position, up = camera.up || cursorUp;
      overheadWeaponYaw = cave.root.rotation.y + cave.weapon.aimYaw;
      overheadWeaponPitch = cave.weapon.aimPitch;
      // North-up is a deliberate N-key state, not a sticky default inherited
      // by the next live entry from orbit or shoulder view. Replays opt in by
      // restoring their recorded lock before resuming the held pose.
      if (!preserveNorth) overheadNorthUp = false;
      overheadEntry.x = camera.position.x - p.x;
      overheadEntry.y = camera.position.y - p.y;
      overheadEntry.z = camera.position.z - p.z;
      viewRotation(overheadStartRotation, camera.target.x - camera.position.x, camera.target.y - camera.position.y,
        camera.target.z - camera.position.z, up.x, up.y, up.z, orbit.yaw);
      overheadEntryRadius = Math.hypot(overheadEntry.x, overheadEntry.y, overheadEntry.z);
      overheadEntryPitch = Math.atan2(overheadEntry.y, Math.hypot(overheadEntry.x, overheadEntry.z));
      overheadEntryYaw = Math.hypot(overheadEntry.x, overheadEntry.z) > 1e-7 ? Math.atan2(overheadEntry.x, overheadEntry.z) : orbit.yaw;
      overheadYaw = orbit.yaw;
      overheadNorthStartYaw = overheadYaw; overheadNorthTime = 0;
      overheadTargetYaw = overheadNorthUp
        ? overheadYaw + Math.atan2(Math.sin(-overheadYaw), Math.cos(-overheadYaw))
        : overheadYaw;
      viewRotation(overheadRotation, 0, -1, 0, -Math.sin(overheadYaw), 0, -Math.cos(overheadYaw), overheadYaw);
      overheadHeight = overheadWanted = preserve ? overheadEntryRadius + cave.baseY : overheadDefault;
      overheadVelocity = 0;
      overheadTime = overheadMix = overheadExit = 0;
      overheadFov = camera.fov;
      overheadStartOrtho = camera.orthoMix || 0;
      overheadStartScale = camera.orthoHeight || 0;
      overheadPointerMoved = preserve;
      overheadToShoulder = centeredCarry = false;
      overheadX = renderer.size.width / 2; overheadY = renderer.size.height / 2;
      if (preserve) {
        const rect = canvas.getBoundingClientRect();
        overheadY = clamp((carryCursor.y - rect.top) * renderer.size.height / rect.height, 0, renderer.size.height / 2);
        positionReticle(overheadX, overheadY);
      }
      const dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z;
      const length = Math.hypot(dx, dy, dz);
      if (!targetAlongAim(overheadAim, camera.position.x, camera.position.y, camera.position.z, dx / length, dy / length, dz / length)) {
        const distance = dy < -1e-5 ? (p.y - cave.baseY - camera.position.y) / dy : 60 / length;
        overheadAim.x = camera.position.x + dx * distance;
        overheadAim.y = camera.position.y + dy * distance;
        overheadAim.z = camera.position.z + dz * distance;
      }
      closeMix = closeVelocity = 0;
      restoreHead();
    };
    const moveOverheadPointer = (dx, dy) => {
      if (!dx && !dy) return;
      // Resume from the visible edge, not the retained target's off-screen
      // projection, so a small inward movement immediately takes over.
      overheadPointerMoved = true;
      const halfHeight = renderer.size.height / 2;
      overheadX = renderer.size.width / 2;
      overheadY = clamp(overheadY + dy, 0, halfHeight);
      if (dx) {
        // Turn toward the pixel the mouse would have reached. Keep a finite
        // lever arm near the Ooga so crossing the centre cannot flip the view.
        const reach = Math.max(AIM_RETICLE_RADIUS, halfHeight * 0.2, halfHeight - overheadY);
        overheadTargetYaw -= Math.atan2(dx, reach);
        overheadNorthUp = false;
      }
      assistedTargetWait = 0;
    };
    const overheadRay = (cave, x, y) => {
      // Hop is measured from support, which can switch to the abyss floor
      // before the body falls. Aim and cut planes follow the actual body.
      const feet = cave.root.position.y - cave.baseY;
      overheadCeiling = ctx.birdsEyeCeiling ? ctx.birdsEyeCeiling(cave) : feet + cave.bodyHeight + 0.4;
      mat4.lookAt(cursorView, camera.position, camera.target, camera.up || cursorUp);
      mat4.rayFromView(cursorRay, cursorView, renderer.size.width, renderer.size.height, camera.fov, camera.position, x, y, camera.orthoMix, camera.orthoHeight);
      // Roofs above the revealed level must not steal either the zoom anchor
      // or the assisted target. Both queries start at the same cut plane.
      const skip = cursorRay.dy < -1e-5 ? Math.max(0, (overheadCeiling - cursorRay.oy) / cursorRay.dy) : 0;
      cursorRay.ox += cursorRay.dx * skip; cursorRay.oy += cursorRay.dy * skip; cursorRay.oz += cursorRay.dz * skip;
    };
    const anchorOverheadPointer = (cave) => {
      if (!overheadPointerMoved) return;
      // Capture the actual pixel hit once, even if the wheel arrives before
      // the next aim update. Assisted hits are throttled and centred on items.
      overheadRay(cave, overheadX, overheadY);
      pointAlongAim(overheadAim, cursorRay.ox, cursorRay.oy, cursorRay.oz, cursorRay.dx, cursorRay.dy, cursorRay.dz,
        DIST_MAX * 2, cursorClear, 18);
      const reach = Math.hypot(overheadAim.x - cursorRay.ox, overheadAim.y - cursorRay.oy, overheadAim.z - cursorRay.oz);
      if (input && input.weaponTargets && input.weaponTargets.ray(targetHit,
        cursorRay.ox, cursorRay.oy, cursorRay.oz, cursorRay.dx, cursorRay.dy, cursorRay.dz, reach + 0.01, cave, sameLevelTarget)) {
        overheadAim.x = targetHit.x; overheadAim.y = targetHit.y; overheadAim.z = targetHit.z;
      }
      overheadPointerMoved = false;
      assistedTargetWait = 0;
    };
    const updateBirdsEyeAim = (cave, dt) => {
      const p = cave.root.position, feet = p.y - cave.baseY;
      const halfWidth = renderer.size.width / 2, halfHeight = renderer.size.height / 2;
      overheadX = halfWidth;
      overheadY = clamp(overheadY, 0, halfHeight);
      let rayY = overheadY;
      const projected = overheadPointerMoved || projectAim(overheadAim);
      if (!overheadPointerMoved) {
        const margin = Math.min(AIM_RETICLE_RADIUS, halfHeight / 2);
        rayY = projected ? Math.min(halfHeight, assistedTargetScreen.y) : 0;
        // Zoom retains the full forward projection beyond the top edge, so
        // zooming back out finds the same point. Neither display nor picking
        // may drift sideways or behind the Ooga as it walks or the view turns.
        overheadY = clamp(rayY, margin, halfHeight);
      }
      // Refresh the revealed floor even while an anchor has no forward ray;
      // the query below remains disabled until that anchor returns in front.
      overheadRay(cave, overheadX, rayY);
      if (projected && cursorRay.dy < -1e-5) {
        const floor = overheadPointerMoved ? feet : overheadAim.y;
        const distance = Math.max(0, (floor - cursorRay.oy) / cursorRay.dy);
        overheadAim.x = cursorRay.ox + cursorRay.dx * distance;
        overheadAim.y = floor;
        overheadAim.z = cursorRay.oz + cursorRay.dz * distance;
      }
      assistedTargetWait -= dt;
      if (!projected) {
        assistedTargetActive = false;
        assistedTargetWait = 0;
      } else if (assistedTargetWait <= 0) {
        assistedTargetWait = TARGET_INTERVAL;
        assistedTargetActive = !!(input && input.weaponTargets && input.weaponTargets.ray(assistedTargetHit,
          cursorRay.ox, cursorRay.oy, cursorRay.oz, cursorRay.dx, cursorRay.dy, cursorRay.dz, DIST_MAX * 2, cave, sameLevelTarget));
        if (!assistedTargetActive && input && input.weaponTargets) {
          const dx = overheadAim.x - p.x, dz = overheadAim.z - p.z, distance = Math.hypot(dx, dz);
          if (distance > 0.05) assistedTargetActive = input.weaponTargets.verticalRay(assistedTargetHit,
            p.x, feet + cave.bodyHeight * 0.5, p.z, dx / distance, dz / distance,
            Math.min(60, distance + 0.7), cave, sightClear || cursorClear, sameLevelTarget);
        }
        if (assistedTargetActive) {
          centerTarget(assistedTargetHit);
          const clear = sightClear || cursorClear;
          crew.weaponOrigin(targetOrigin, cave, false);
          if (clear && !clear(targetOrigin.x, targetOrigin.y, targetOrigin.z,
            assistedTargetHit.x, assistedTargetHit.y, assistedTargetHit.z, assistedTargetHit.node, true)) assistedTargetActive = false;
        }
      }
      const point = assistedTargetActive ? assistedTargetHit : overheadAim;
      const dx = point.x - p.x, dz = point.z - p.z;
      let pitch = 0;
      if (assistedTargetActive) {
        const dy = point.y - p.y - cave.traits.height * 0.45;
        assistedTargetDistance = Math.hypot(dx, dy, dz);
        assistedTargetInRange = !cave.weapon.primaryEquipped || assistedMeleeInRange(cave);
        assistedTargetClose = assistedTargetInRange && assistedTargetDistance <= cave.traits.height * AIM_CLOSE_HIT;
        pitch = -Math.atan2(dy, Math.hypot(dx, dz));
      } else {
        assistedTargetInRange = assistedTargetClose = false;
        assistedTargetDistance = Infinity;
      }
      if (Math.hypot(dx, dz) > 0.05) {
        const turn = Math.atan2(Math.sin(Math.atan2(dx, dz) - cave.root.rotation.y), Math.cos(Math.atan2(dx, dz) - cave.root.rotation.y));
        crew.look(cave.root.rotation.y + turn * (1 - Math.exp(-20 * dt)), pitch, 1);
      }
      const weaponTurn = Math.atan2(Math.sin(cave.root.rotation.y - overheadWeaponYaw), Math.cos(cave.root.rotation.y - overheadWeaponYaw));
      const weaponYaw = overheadWeaponYaw + weaponTurn * overheadMix - cave.root.rotation.y;
      cave.weapon.aimYaw = Math.atan2(Math.sin(weaponYaw), Math.cos(weaponYaw));
      cave.weapon.aimPitch = overheadWeaponPitch + (pitch - overheadWeaponPitch) * overheadMix;
      crew.poseWeapon(cave);
      // Assistance may choose an item's centre, but never move the pointer.
      const visible = !overheadPointerMoved || projectAim(point);
      positionReticle(overheadX, overheadY);
      reticle.dataset.close = "false";
      reticle.dataset.occluded = String(!visible);
      if (reticleRadius !== AIM_RETICLE_RADIUS) {
        reticleRadius = AIM_RETICLE_RADIUS;
        reticle.style.setProperty("--reticle-radius", `${AIM_RETICLE_RADIUS}px`);
      }
      updateFeedback(cave, dt);
    };
    const setOverheadProjection = (cave, mix) => {
      const p = cave.root.position;
      camera.orthoMix = mix;
      // Match scale at the character, even when entering from a horizontal
      // orbit: a ray/floor intersection has unbounded depth near the horizon.
      const dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z;
      const depth = ((p.x - camera.position.x) * dx + (p.y - camera.position.y) * dy + (p.z - camera.position.z) * dz) / Math.max(1e-9, Math.hypot(dx, dy, dz));
      camera.orthoHeight = 2 * Math.tan(camera.fov / 2) * Math.max(camera.near, depth);
    };
    const updateOverhead = (cave, dt) => {
      syncJetpackHud(); syncWeaponHud();
      crew.elevate(0);
      overheadTime = Math.min(OVERHEAD_TIME, overheadTime + dt);
      const t = overheadTime / OVERHEAD_TIME;
      overheadMix = t * t * (3 - 2 * t);
      if (overheadNorthUp) {
        // A finite shortest-arc trajectory starts and stops with zero velocity
        // and acceleration. Even a half turn stays below 0.25 rad per 60 Hz
        // frame, and reaches exact north before the replay settling deadline.
        overheadNorthTime = Math.min(OVERHEAD_NORTH_TIME, overheadNorthTime + dt);
        overheadYaw = overheadNorthStartYaw + (overheadTargetYaw - overheadNorthStartYaw)
          * overheadNorthEase(overheadNorthTime / OVERHEAD_NORTH_TIME);
      } else {
        overheadYaw = damp(overheadYaw, overheadTargetYaw, 14, dt);
        overheadNorthStartYaw = overheadYaw; overheadNorthTime = 0;
      }
      viewRotation(overheadRotation, 0, -1, 0, -Math.sin(overheadYaw), 0, -Math.cos(overheadYaw), overheadYaw);
      const delta = overheadHeight - overheadWanted;
      // A full-height wheel jump should not spend almost a second approaching
      // the shoulder boundary. Retain the gentle small-step spring, but raise
      // its critical rate with travel so large deltas finish promptly.
      const travel = clamp(Math.abs(delta) / Math.max(1, DIST_MAX - overheadMin), 0, 1);
      const zoomRate = OVERHEAD_ZOOM_RATE + (OVERHEAD_ZOOM_FAST - OVERHEAD_ZOOM_RATE) * Math.sqrt(travel);
      const impulse = (overheadVelocity + zoomRate * delta) * dt;
      const decay = Math.exp(-zoomRate * dt);
      overheadHeight = overheadWanted + (delta + impulse) * decay;
      overheadVelocity = (overheadVelocity - zoomRate * impulse) * decay;
      if (Math.abs(overheadHeight - overheadWanted) < 0.001 && Math.abs(overheadVelocity) < 0.01) {
        overheadHeight = overheadWanted; overheadVelocity = 0;
      }
      const p = cave.root.position, remaining = 1 - overheadMix;
      // Travel on the sphere, not its chord, so toggling X never changes the
      // distance to the character. Scroll entry may still dolly to its height.
      const radius = overheadEntryRadius * remaining + (overheadHeight - cave.baseY) * overheadMix;
      const pitch = overheadEntryPitch + (Math.PI / 2 - overheadEntryPitch) * overheadMix;
      const horizontal = Math.cos(pitch) * radius;
      camera.position.x = p.x + Math.sin(overheadEntryYaw) * horizontal;
      camera.position.y = p.y + Math.sin(pitch) * radius;
      camera.position.z = p.z + Math.cos(overheadEntryYaw) * horizontal;
      overheadViewRotation.set(overheadStartRotation);
      quat.slerpTo(overheadViewRotation, overheadRotation, overheadMix);
      quat.rotateVec(aimForward, overheadViewRotation, 0, 0, -1);
      quat.rotateVec(sleepUp, overheadViewRotation, 0, 1, 0);
      camera.target.x = camera.position.x + aimForward[0] * CLOSE_LOOK_DIST;
      camera.target.y = camera.position.y + aimForward[1] * CLOSE_LOOK_DIST;
      camera.target.z = camera.position.z + aimForward[2] * CLOSE_LOOK_DIST;
      sleepCameraUp.x = sleepUp[0]; sleepCameraUp.y = sleepUp[1]; sleepCameraUp.z = sleepUp[2];
      camera.up = sleepCameraUp;
      camera.fov = overheadFov;
      camera.near = savedNear;
      if (ctx.observeOrbit) ctx.observeOrbit(camera.position);
      setOverheadProjection(cave, overheadStartOrtho + (1 - overheadStartOrtho) * overheadMix);
      if (overheadStartOrtho) camera.orthoHeight = overheadStartScale * remaining + camera.orthoHeight * overheadMix;
      orbit.tx = p.x; orbit.ty = p.y; orbit.tz = p.z;
      updateBirdsEyeAim(cave, dt);
      eyeMotionValid = false;
      if (overheadToShoulder) {
        headAnchor(cave, aimPoint);
        // Calibrate at floor zero, then compare relative to this head. The
        // same clearance follows floors, props, hills and a falling body.
        const headHeight = cave.headOffset * close.eyeRatio + cave.viewLift;
        if (camera.position.y - aimPoint.y <= overheadMin - headHeight + 0.08) shooterView(true);
      }
    };
    const beginCenteredCarry = (cave) => {
      const p = cave.root.position, up = camera.up || cursorUp;
      const dx = camera.position.x - p.x, dy = camera.position.y - p.y, dz = camera.position.z - p.z;
      orbit.dist = orbit.tDist = Math.hypot(dx, dy, dz);
      orbit.yaw = orbit.tYaw = Math.hypot(dx, dz) > 1e-7 ? Math.atan2(dx, dz) : overheadYaw;
      orbit.pitch = orbit.tPitch = Math.atan2(dy, Math.hypot(dx, dz));
      viewRotation(carryStartRotation, camera.target.x - camera.position.x, camera.target.y - camera.position.y,
        camera.target.z - camera.position.z, up.x, up.y, up.z, orbit.yaw);
      carryTime = 0;
      carryStartOrtho = camera.orthoMix || 0;
      carryStartScale = camera.orthoHeight || 0;
      carryFov = camera.fov;
      orbit.target = followTarget;
      followTarget.x = orbit.tx = p.x; followTarget.y = orbit.ty = p.y; followTarget.z = orbit.tz = p.z;
      headAnchor(cave, aimPoint);
      headOrbitOffset.x = p.x - aimPoint.x; headOrbitOffset.y = p.y - aimPoint.y; headOrbitOffset.z = p.z - aimPoint.z;
      headOrbit = exitAngleHold = trailingPitchChosen = centeredCarry = true;
      exitBodyX = p.x; exitBodyY = p.y; exitBodyZ = p.z;
      carryExitMode = carryFocusRemaining = 0;
      distanceVelocity = zoomPitchVelocity = 0;
      zoomTilt = closeCameraActive = false;
    };
    const endCenteredCarry = () => {
      if (!centeredCarry) return;
      // Ordinary orbit uses world-up, which cannot represent the exact pole.
      orbit.pitch = clamp(orbit.pitch, TRAILING_PITCH[0], TRAILING_PITCH[1]);
      orbit.tPitch = clamp(orbit.tPitch, TRAILING_PITCH[0], TRAILING_PITCH[1]);
      centeredCarry = false;
    };
    const updateCenteredCarry = (cave, dt) => {
      syncJetpackHud(); syncWeaponHud();
      crew.elevate(0);
      carryTime = Math.min(OVERHEAD_TIME, carryTime + dt);
      const t = carryTime / OVERHEAD_TIME, mix = t * t * (3 - 2 * t);
      orbit.yaw = damp(orbit.yaw, orbit.tYaw, 14, dt);
      orbit.pitch = damp(orbit.pitch, orbit.tPitch, 14, dt);
      const delta = orbit.dist - orbit.tDist, impulse = (distanceVelocity + OVERHEAD_ZOOM_RATE * delta) * dt;
      const decay = Math.exp(-OVERHEAD_ZOOM_RATE * dt);
      orbit.dist = orbit.tDist + (delta + impulse) * decay;
      distanceVelocity = (distanceVelocity - OVERHEAD_ZOOM_RATE * impulse) * decay;
      const p = cave.root.position, cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch), sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
      followTarget.x = orbit.tx = p.x; followTarget.y = orbit.ty = p.y; followTarget.z = orbit.tz = p.z;
      camera.position.x = p.x + sy * cp * orbit.dist;
      camera.position.y = p.y + sp * orbit.dist;
      camera.position.z = p.z + cy * cp * orbit.dist;
      viewRotation(overheadRotation, -sy * cp, -sp, -cy * cp, -sy * sp, cp, -cy * sp, orbit.yaw);
      overheadViewRotation.set(carryStartRotation);
      quat.slerpTo(overheadViewRotation, overheadRotation, mix);
      quat.rotateVec(aimForward, overheadViewRotation, 0, 0, -1);
      quat.rotateVec(sleepUp, overheadViewRotation, 0, 1, 0);
      camera.target.x = camera.position.x + aimForward[0] * CLOSE_LOOK_DIST;
      camera.target.y = camera.position.y + aimForward[1] * CLOSE_LOOK_DIST;
      camera.target.z = camera.position.z + aimForward[2] * CLOSE_LOOK_DIST;
      sleepCameraUp.x = sleepUp[0]; sleepCameraUp.y = sleepUp[1]; sleepCameraUp.z = sleepUp[2];
      camera.up = sleepCameraUp;
      camera.fov = carryFov; camera.near = savedNear;
      if (ctx.observeOrbit) ctx.observeOrbit(camera.position);
      setOverheadProjection(cave, carryStartOrtho * (1 - mix));
      camera.orthoHeight = carryStartScale * (1 - mix) + camera.orthoHeight * mix;
      trailingViewInput = trailingZoomInput = false;
      eyeMotionValid = false;
    };
    const aimMouseMove = (e) => {
      if (externalControl || !armed() || document.pointerLockElement !== canvas && (!softAimFocused || e.target !== canvas)) return;
      if (e.movementX || e.movementY) resumePose();
      if (birdsEye()) {
        if (document.pointerLockElement === canvas) moveOverheadPointer(e.movementX, e.movementY);
        else {
          const rect = canvas.getBoundingClientRect();
          // Soft focus also owns a virtual pointer: zoom may have moved it
          // away from the native cursor, so absolute coordinates would jump.
          moveOverheadPointer(e.movementX * renderer.size.width / rect.width,
            e.movementY * renderer.size.height / rect.height);
        }
        return;
      }
      if (e.movementX || e.movementY) releaseCursorAim();
      const sensitivity = ads ? 0.0015 : 0.0025;
      const cave = player();
      if (syncLyingView(cave)) {
        moveLyingView(-e.movementX * sensitivity, e.movementY * sensitivity);
        return;
      }
      orbit.yaw = orbit.tYaw -= e.movementX * sensitivity;
      orbit.pitch = orbit.tPitch = clamp(orbit.tPitch + e.movementY * sensitivity, TRAILING_PITCH[0], TRAILING_PITCH[1]);
    };
    // Mouse and trackpad taps expose the same buttons. Classify the release
    // by its held duration, shared with the displayed charge and HUD button.
    const releasePrimary = (cave, focused = null) => {
      const released = crew.releaseSwing(cave, false, focused,
        !!cave && cave.weapon.meleeHeldTime < BL.crew.MELEE_TAP_TIME);
      if (released) syncWeaponHud();
      return released;
    };
    const releaseRightTap = () => {
      const now = performance.now();
      if (Number.isFinite(rightDownAt)) rightTapAt = aimView()
        && now - rightDownAt <= RIGHT_DOUBLE_TIME && rightTravel <= RIGHT_TAP_TRAVEL ? now : -Infinity;
      rightDownAt = -Infinity;
      rightExitHeld = false;
    };
    const aimPointer = (e) => {
      if (!active || externalControl || e.pointerType !== "mouse") return;
      if (e.type === "pointercancel") {
        rightDownAt = rightTapAt = -Infinity;
        rightExitHeld = false;
      }
      if (e.type === "pointermove" && Number.isFinite(rightDownAt)) rightTravel += Math.hypot(e.movementX || 0, e.movementY || 0);
      if (e.button === 2 && e.type === "pointerup") releaseRightTap();
      // The carry cursor can absorb the release that follows a view switch.
      // A fresh press is a new gesture even if that release never reached us.
      if (rightExitHeld && e.type === "pointerdown") rightExitHeld = false;
      if (rightExitHeld) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (e.type === "pointerdown") {
        if (e.button !== 2) rightDownAt = -Infinity;
        if (e.button === 2 && aimView()) {
          const now = performance.now();
          if (now - rightTapAt <= RIGHT_DOUBLE_TIME) {
            e.preventDefault(); e.stopImmediatePropagation();
            ads = false;
            rightReturnFirstPerson = closeWanted;
            shooterView(false);
            rightExitHeld = true;
            return;
          }
          rightDownAt = now; rightTravel = 0;
        }
        rightTapAt = -Infinity;
      }
      if (!armed()) {
        if (!weaponViewReady(player()) || e.button !== 2 || !(e.type === "pointerdown" || e.type === "pointermove" && (e.buttons & 2))) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (!closeWanted && !shoulderView) {
          const rect = canvas.getBoundingClientRect();
          resumeRightView(e.clientX - rect.left, e.clientY - rect.top);
        }
        return;
      }
      if (birdsEye() && e.button === 2 && e.type === "pointerdown") {
        e.preventDefault(); e.stopImmediatePropagation();
        resumeRightView(renderer.size.width / 2, renderer.size.height / 2);
        return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === "pointercancel") {
        ads = false;
        aimLeftAccepted = aimLeftFocused = false;
        const cave = player();
        crew.stopBurst(cave);
        crew.releaseSwing(cave, true);
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      // While another mouse button is held, presses and releases arrive as
      // pointermove with the changed button, not pointerdown / pointerup.
      const pressed = e.type === "pointerdown" || e.type === "pointermove" && (e.buttons & (e.button === 0 ? 1 : 2));
      if (pressed) {
        // An ordinary capture click never attacks. A page that loaded already
        // focused in first person upgrades to pointer lock without swallowing
        // the click because mouse-look was active before the gesture.
        if (document.pointerLockElement !== canvas) {
          const alreadyFocused = softAimFocused;
          lockAim();
          if (!alreadyFocused) return;
        }
        resumePose();
        if (e.button === 0) {
          if (player().weapon.primaryEquipped) crew.swingWeapon(player(), true, ads);
          else {
            const w = player().weapon, before = w.shotsFired + w.triggerQueued;
            aimLeftFocused = ads;
            weaponAction("weapon-fire", true);
            aimLeftAccepted = !ads || w.triggerHeld || w.reloadFireHeld || w.shotsFired + w.triggerQueued > before;
          }
        }
        if (e.button === 2) {
          ads = true;
          if (e.buttons & 1 && !player().weapon.primaryEquipped && crew.setWeaponTrigger(true, true)) aimLeftAccepted = true;
        }
      } else if (e.type === "pointerup" || e.type === "pointermove") {
        if (e.button === 0) {
          releaseAimAttack(e);
          releasePrimary(player(), ads);
        }
        if (e.button === 2) ads = false;
      }
    };
    const aimKey = (e) => {
      if (externalControl || e.metaKey || e.ctrlKey || e.altKey || e.target.closest && e.target.closest("input, textarea, dialog, #sheet")) return;
      // R swaps magazines whenever the AK is drawn, aimed or not: V fires it unaimed, so it empties unaimed.
      // Otherwise R stays the free camera's pitch.
      const cave = player();
      const key = e.key.toLowerCase();
      if (key === "f" && armed() && cave.weapon.equipped) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) weaponAction("weapon-bash");
        return;
      }
      if (birdsEye() && key === "n") {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat) return;
        resumePose();
        overheadNorthUp = true;
        overheadNorthStartYaw = overheadYaw; overheadNorthTime = 0;
        overheadPointerMoved = true;
        assistedTargetWait = 0;
        overheadTargetYaw = overheadYaw + Math.atan2(Math.sin(-overheadYaw), Math.cos(-overheadYaw));
        return;
      }
      if (e.key.toLowerCase() === "r" && !controls.rightShift && cave && cave.weapon.equipped) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.repeat) weaponAction(ctx.reloadAnywhere ? "weapon-reload" : "magazine-swap");
        return;
      }
      if (!armed()) return;
      if (e.key === "Escape" && (document.pointerLockElement === canvas || performance.now() - unlockedAt < 100) || e.key === "Tab") {
        e.preventDefault(); e.stopImmediatePropagation(); unlockAim();
      }
    };
    const releaseAimAttack = (e) => {
      if (externalControl || !crew || aimReleaseEvent === e || e.type === "mouseup" && aimReleaseEvent?.type === "pointerup"
        && e.button === aimReleaseEvent.button && e.timeStamp - aimReleaseEvent.timeStamp < 100) return;
      aimReleaseEvent = e;
      const cave = player(), focused = aimLeftFocused || ads;
      // Chorded mouse buttons do not consistently emit a second pointerdown:
      // some browsers report only the release while right-click remains held.
      // Count that release as the click only when its press did not already
      // fire or queue a focused single shot.
      if (cave && cave.weapon.equipped && focused && !aimLeftAccepted && armed()) crew.setWeaponTrigger(true, true);
      crew.setWeaponTrigger(false);
      aimLeftAccepted = aimLeftFocused = false;
    };
    const aimMouseUp = (e) => {
      if (externalControl) return;
      if (e.target.closest && e.target.closest(".equipment-hud")) return;
      if (e.button === 0 && crew) { releaseAimAttack(e); releasePrimary(player(), ads); }
      if (e.button === 2) { ads = false; releaseRightTap(); }
    };
    const aimLockChanged = () => {
      lockPending = false;
      if (externalControl && !disposed) return;
      const locked = document.pointerLockElement === canvas;
      if (locked) setSoftAimFocus(false);
      if (aimLocked && !locked) unlockedAt = performance.now();
      aimLocked = locked;
      if (!locked) {
        ads = false;
        aimLeftAccepted = aimLeftFocused = false;
        carryCursor.endAim();
        if (crew) {
          const cave = player();
          if (cave) crew.stopBurst(cave);
          crew.releaseSwing(cave, true);
        }
        if (carryCursor.active) {
          carryCursor.stop();
          resetPointer();
        }
      } else if (disposed || !armed()) document.exitPointerLock();
      if (disposed) retireAimLock();
    };
    window.addEventListener("mousemove", aimMouseMove);
    window.addEventListener("pointerup", aimMouseUp);
    window.addEventListener("keydown", aimKey, true);
    window.addEventListener("blur", unlockAim);
    document.addEventListener("pointerlockchange", aimLockChanged);
    document.addEventListener("pointerlockerror", aimLockFailed);
    canvas.addEventListener("pointerdown", aimPointer, true);
    canvas.addEventListener("pointermove", aimPointer, true);
    canvas.addEventListener("pointerup", aimPointer, true);
    canvas.addEventListener("pointercancel", aimPointer, true);

    const resetGroundView = () => {
      freeEntry = false;
      const cave = player();
      if (cave) crew.elevate(0);
      groundView = groundTarget = groundLift = 0;
      groundEasing = false;
      groundValid = false;
      resetFreeFall();
    };
    const restoreHead = () => {
      if (!hiddenHead) return;
      hiddenHead.parts.head.cameraHidden = hiddenHeadCameraHidden;
      hiddenHead = null;
    };
    const hideHead = (cave) => {
      if (hiddenHead === cave) return;
      restoreHead();
      hiddenHead = cave;
      hiddenHeadCameraHidden = cave.parts.head.cameraHidden;
      cave.parts.head.cameraHidden = true;
    };
    const includeHeadPart = (node) => {
      if (!node.visible) return;
      if (node.geometry) {
        const b = boundsOf(node.geometry), m = headPartMatrix;
        mat4.multiply(m, headInverse, node.world);
        const cx = b.center[0], cy = b.center[1], cz = b.center[2];
        const hx = (b.max[0] - b.min[0]) * 0.5, hy = (b.max[1] - b.min[1]) * 0.5, hz = (b.max[2] - b.min[2]) * 0.5;
        for (let axis = 0; axis < 3; axis++) {
          const center = m[axis] * cx + m[axis + 4] * cy + m[axis + 8] * cz + m[axis + 12];
          const extent = Math.abs(m[axis]) * hx + Math.abs(m[axis + 4]) * hy + Math.abs(m[axis + 8]) * hz;
          headBounds[axis] = Math.min(headBounds[axis], center - extent);
          headBounds[axis + 3] = Math.max(headBounds[axis + 3], center + extent);
        }
      }
      for (const child of node.children) includeHeadPart(child);
    };
    const syncHeadVisibility = (cave) => {
      if (!cave) { restoreHead(); return; }
      // The near plane can expose interior faces before the eye enters.
      // Include the whole head subtree so hats and masks cannot flash either.
      updateWorld(cave.root, cave.root.parent ? cave.root.parent.world : undefined);
      const head = cave.parts.head;
      mat4.invert(headInverse, head.world);
      headBounds[0] = headBounds[1] = headBounds[2] = Infinity;
      headBounds[3] = headBounds[4] = headBounds[5] = -Infinity;
      includeHeadPart(head);
      mat4.transformPoint(headEye, headInverse, camera.position.x, camera.position.y, camera.position.z);
      if (headEye[0] >= headBounds[0] && headEye[0] <= headBounds[3]
        && headEye[1] >= headBounds[1] && headEye[1] <= headBounds[4]
        && headEye[2] >= headBounds[2] && headEye[2] <= headBounds[5]) { hideHead(cave); return; }
      let fx = camera.target.x - camera.position.x, fy = camera.target.y - camera.position.y, fz = camera.target.z - camera.position.z;
      const length = Math.hypot(fx, fy, fz);
      fx /= length; fy /= length; fz /= length;
      const up = camera.up, ux = up ? up.x : 0, uy = up ? up.y : 1, uz = up ? up.z : 0;
      let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
      const rightLength = Math.hypot(rx, ry, rz);
      rx /= rightLength; ry /= rightLength; rz /= rightLength;
      const vx = ry * fz - rz * fy, vy = rz * fx - rx * fz, vz = rx * fy - ry * fx;
      const halfH = camera.near * Math.tan(camera.fov * 0.5), halfW = halfH * renderer.size.width / Math.max(1, renderer.size.height);
      mat4.transformPoint(headNear, headInverse, camera.position.x + fx * camera.near, camera.position.y + fy * camera.near, camera.position.z + fz * camera.near);
      for (let axis = 0; axis < 3; axis++) {
        const m = headInverse;
        const extent = Math.abs(m[axis] * rx + m[axis + 4] * ry + m[axis + 8] * rz) * halfW
          + Math.abs(m[axis] * vx + m[axis + 4] * vy + m[axis + 8] * vz) * halfH;
        if (headNear[axis] + extent < headBounds[axis] || headNear[axis] - extent > headBounds[axis + 3]) { restoreHead(); return; }
      }
      hideHead(cave);
    };
    const setFreeEye = () => {
      resetFreeFall();
      const eyeHeight = close.eyeHeight;
      freeTarget.x = camera.position.x;
      freeTarget.z = camera.position.z;
      freeFloorY = close.groundAt(freeTarget.x, freeTarget.z, camera.position.y - eyeHeight);
      freeTarget.y = Math.max(camera.position.y, freeFloorY + eyeHeight);
      freeFeetY = freeTarget.y - eyeHeight;
      freeFallValid = true;
      freeFalling = freeFeetY - freeFloorY > WALK.step;
      const cave = player();
      if (freeFalling && cave) {
        freeFallV = cave.hopV;
        freeLeapX = cave.leap.vx;
        freeLeapZ = cave.leap.vz;
      }
      clampTarget(freeTarget);
      orbit.target = freeTarget;
    };
    const faceWith = (cave) => {
      closeCave = cave;
      entryPosition.x = camera.position.x; entryPosition.y = camera.position.y; entryPosition.z = camera.position.z;
      entryRebase = true;
      carryDollyVelocity();
      closeRate = 10;
      entryOffsetActive = false;
      closeMix = closeVelocity = 0;
      headOrbit = exitAngleHold = false;
      // Boom and close-distance flattening can differ from the requested orbit: enter along the direction on screen.
      const dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z, up = camera.up;
      viewRotation(cameraRotation, dx, dy, dz, up ? up.x : 0, up ? up.y : 1, up ? up.z : 0, orbit.yaw);
      orbit.yaw = orbit.tYaw = Math.atan2(-dx, -dz);
      orbit.pitch = orbit.tPitch = Math.atan2(-dy, Math.hypot(dx, dz));
      closeCameraActive = true;
      sleepingView = !!(cave && crew.sleeping && cave.root.quaternion);
      if (!sleepingView) {
        viewRotation(headRotation, dx, dy, dz, 0, 1, 0, orbit.yaw);
        inverseRotation[0] = -headRotation[0]; inverseRotation[1] = -headRotation[1]; inverseRotation[2] = -headRotation[2]; inverseRotation[3] = headRotation[3];
        quat.multiply(entryRoll, inverseRotation, cameraRotation);
      }
    };
    const lockCurrentAimPoint = () => {
      // Save the surface beneath the displayed reticle before the eye moves.
      // Keeping only the viewing direction introduces shoulder parallax.
      const p = camera.position, dx = camera.target.x - p.x, dy = camera.target.y - p.y, dz = camera.target.z - p.z;
      const length = Math.hypot(dx, dy, dz) || 1;
      if (!targetAlongAim(cursorPoint, p.x, p.y, p.z, dx / length, dy / length, dz / length)) {
        pointAlongAim(cursorPoint, p.x, p.y, p.z, dx / length, dy / length, dz / length, 60, sightClear || cursorClear, 18);
      }
      if (Math.hypot(cursorPoint.x - p.x, cursorPoint.y - p.y, cursorPoint.z - p.z) < 0.1) {
        cursorPoint.x = p.x + dx / length * 60; cursorPoint.y = p.y + dy / length * 60; cursorPoint.z = p.z + dz / length * 60;
      }
      aimAtCursor = true; aimPreserveFacing = false;
      aimScreenX = aimScreenY = 0;
    };
    const enterClose = (combat = false) => {
      if (!close || closeWanted) return;
      closeWanted = true;
      shoulderView = false;
      closeExitScale = 1;
      const cave = player();
      if (combat && weaponViewReady(cave)) {
        if (!cave.weapon.equipped && !cave.weapon.primaryEquipped) crew.selectWeapon(cave.weapon.selectedSlot, cave);
        cave.weapon.aiming = true;
      }
      syncAim();
      if (aimView()) {
        if (cave.camp.rolling) releaseCursorAim();
        else if (!aimAtCursor) lockCurrentAimPoint();
        headOrbit = exitAngleHold = entryOffsetActive = entryRebase = false;
        return;
      }
      if (cave) faceWith(cave);
      else {
        // Finish zooming to the displayed focal point before walking physics takes over.
        // Resolve an embedded destination before the dolly, or recovery teleports the eye at first person.
        freeTarget.x = headOrbit ? orbit.tx : camera.target.x;
        freeTarget.y = headOrbit ? orbit.ty : camera.target.y;
        freeTarget.z = headOrbit ? orbit.tz : camera.target.z;
        if (ctx.enterFreeView) ctx.enterFreeView(freeTarget);
        freeTarget.y = Math.max(freeTarget.y, close.groundAt(freeTarget.x, freeTarget.z, freeTarget.y - close.eyeHeight) + close.eyeHeight);
        clampTarget(freeTarget);
        orbit.target = freeTarget;
        resetFreeFall();
        faceWith(null);
        headOrbit = freeEntry = true;
      }
    };
    const exitClose = () => {
      if (!closeWanted) return;
      const cave = player();
      shoulderView = !!cave;
      if (aimView()) {
        if (cave && !cave.camp.rolling) lockCurrentAimPoint();
        closeWanted = false;
        closeExitScale = 1;
        headOrbit = exitAngleHold = entryOffsetActive = entryRebase = false;
        closeCave = null;
        return;
      }
      freeEntry = false;
      if (closeMix < 1) carryDollyVelocity(true);
      else dollyTime = DOLLY_HANDOFF;
      closeRate = closeMix < 1 ? 10 : CLOSE_RATE;
      distanceVelocity = 0;
      const up = camera.up, dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z;
      if (dollyTime < DOLLY_HANDOFF) {
        // Outward zoom moves along the held viewing ray: keep longitudinal velocity, drop a fading sideways head turn.
        const along = (dollyVelocity.x * dx + dollyVelocity.y * dy + dollyVelocity.z * dz) / (dx * dx + dy * dy + dz * dz);
        dollyVelocity.x = dx * along; dollyVelocity.y = dy * along; dollyVelocity.z = dz * along;
      }
      viewRotation(cameraRotation, dx, dy, dz, up ? up.x : 0, up ? up.y : 1, up ? up.z : 0, orbit.yaw);
      orbit.yaw = orbit.tYaw = Math.atan2(-dx, -dz);
      orbit.pitch = orbit.tPitch = Math.atan2(-dy, Math.hypot(dx, dz));
      viewRotation(headRotation, dx, dy, dz, 0, 1, 0, orbit.yaw);
      inverseRotation[0] = -headRotation[0]; inverseRotation[1] = -headRotation[1]; inverseRotation[2] = -headRotation[2]; inverseRotation[3] = headRotation[3];
      quat.multiply(entryRoll, inverseRotation, cameraRotation);
      // Zoom back on the ray already viewed, roll included.
      // The starting eye becomes the head-relative orbit anchor, so only distance changes after a collision nudge.
      if (cave) {
        headAnchor(cave, followTarget);
        headOrbitOffset.x = camera.position.x - followTarget.x; headOrbitOffset.y = camera.position.y - followTarget.y; headOrbitOffset.z = camera.position.z - followTarget.z;
        followTarget.x = camera.position.x; followTarget.y = camera.position.y; followTarget.z = camera.position.z;
        orbit.target = followTarget;
      } else {
        freeTarget.x = camera.position.x; freeTarget.y = camera.position.y; freeTarget.z = camera.position.z;
        orbit.target = freeTarget;
      }
      orbit.tx = orbit.target.x; orbit.ty = orbit.target.y; orbit.tz = orbit.target.z;
      const body = cave ? cave.root.position : freeTarget;
      exitBodyX = body.x; exitBodyY = body.y; exitBodyZ = body.z;
      headOrbit = exitAngleHold = closeCameraActive = trailingPitchChosen = true;
      releaseMix = 0;
      closeWanted = false;
      syncHeadVisibility(cave);
      // The new orbit starts at the displayed eye, even mid-entry; its dolly begins there without moving it.
      closeMix = 1;
      closeVelocity = 0;
      entryRebase = entryOffsetActive = false;
      closeExitScale = 1;
      closeCave = null;
      resetFreeFall();
      orbit.tDist = clamp(cave ? close.trailingDist : close.orbitDist, DIST_MIN, DIST_MAX);
      if (cave && crew.sleeping) crew.look(0, 0, 0);
    };
    const syncJetpackHud = () => {
      const cave = player(), status = ctx.jetpackStatus && ctx.jetpackStatus(cave);
      if (status) hud.setJetpack(status.owned, status.equipped, status.fuel, status.blocked);
      else hud.setJetpack(!!(cave && cave.jet), !!(cave && cave.jet), cave ? cave.jetFuel : 0);
    };
    const syncModeHud = () => {
      if (hud.setMode) hud.setMode(player(), armed(), viewMode());
    };
    let reloadPrompt = false;
    const syncWeaponHud = () => {
      const cave = player(), weapon = cave && cave.weapon;
      const ready = !!weapon && !cave.grabbedBy && !crew.sleeping && (!cave.camp.seat || cave.camp.seat.allowWeapons) && !cave.bedTravel.mode;
      const primaryReady = ready && weapon.primaryOwned;
      const secondaryReady = ready && weapon.secondaryOwned;
      if (primaryButtonCave && (primaryButtonCave !== cave || !primaryReady || !weapon.primaryEquipped)) {
        crew.releaseSwing(primaryButtonCave, true);
        primaryButtonCave = null;
      }
      const reload = secondaryReady && weapon.equipped && crew.canReload(cave);
      const meleeCharge = weapon && weapon.meleeHeld ? weapon.meleeCharge : 0;
      hud.setPrimary(primaryReady, !!weapon && !weapon.equipped, primaryReady ? cave.parts.club.geometry : null,
        meleeCharge, !!weapon && weapon.meleeHeld,
        weapon ? crew.meleePower(cave, meleeCharge) : 1, !!weapon && weapon.aiming, cave ? cave.traits.name : "");
      hud.setWeapon(secondaryReady, !!weapon && weapon.equipped, weapon ? weapon.ammo : 0, !!weapon && weapon.reloading, reload, !!weapon && weapon.unlimited);
      const count = secondaryReady && crew ? crew.magazineCount(cave) : 0, canSwap = !!crew && secondaryReady && crew.canSwapMagazine(cave);
      hud.setMagazine(count, crew ? crew.magazineAmmo(cave, 0) : 0, crew ? crew.magazineAmmo(cave, 1) : 0, canSwap,
        weapon && weapon.reloading && weapon.reloadSpare ? weapon.reloadMagazine : -1);
      if (reload && !weapon.reloading) {
        hud.setAct("RELOAD +6");
        reloadPrompt = true;
      } else if (reloadPrompt) {
        reloadPrompt = false;
        showAct();
      }
    };
    const showAct = () => {
      const cave = player();
      if (cave) hud.setAct(cave.camp.burning ? "DROP & ROLL!" : cave.camp.seat ? "STAND UP!" : crew.sleeping ? "WAKE UP!" : cave.jet && !cave.jetRecovering ? ACT_FLY : ACT_DO);
      syncModeHud();
      syncJetpackHud();
    };
    const weaponAction = (action, held = false) => {
      if (action === "weapon-primary-up" || action === "weapon-primary-cancel") {
        if (primaryButtonCave) {
          if (action === "weapon-primary-cancel") crew.releaseSwing(primaryButtonCave, true);
          else releasePrimary(primaryButtonCave);
        }
        primaryButtonCave = null;
        if (crew) syncWeaponHud();
        return true;
      }
      const cave = player();
      if (!active || !cave || cave.grabbedBy || crew.sleeping) return false;
      resumePose();
      if (action === "weapon-primary" || action === "weapon-primary-down") {
        const alreadyHeld = !cave.weapon.equipped;
        if (!cave.weapon.primaryEquipped) {
          crew.selectWeapon(1, cave);
          syncAim();
        }
        if (alreadyHeld) {
          const charge = action === "weapon-primary-down";
          if (crew.swingWeapon(cave, true)) {
            if (charge) primaryButtonCave = cave;
            else releasePrimary(cave);
          }
        }
      } else if (action === "weapon-secondary") {
        if (!cave.weapon.equipped) {
          crew.selectWeapon(2, cave);
          syncAim();
        } else {
          // Navigation looks back toward the character. A HUD shot follows
          // the character's facing instead of that unrelated orbit-camera ray.
          let target = null;
          if (!armed()) {
            const p = cave.root.position, yaw = cave.root.rotation.y;
            const dx = Math.sin(yaw), dz = Math.cos(yaw), y = p.y + cave.traits.height * 0.45;
            if (input && input.weaponTargets.verticalRay(targetHit, p.x, y, p.z, dx, dz, 60, cave, sightClear || cursorClear, autoTarget)) {
              centerTarget(targetHit);
              buttonTarget.x = targetHit.x; buttonTarget.y = targetHit.y; buttonTarget.z = targetHit.z;
            } else {
              buttonTarget.x = p.x + dx * 60;
              buttonTarget.y = y;
              buttonTarget.z = p.z + dz * 60;
            }
            target = buttonTarget;
          }
          if (!crew.fireWeapon(cave, target, ads ? 1 : undefined) && !cave.weapon.unlimited && !cave.weapon.ammo) hud.hint("Empty magazine · press Space within reach of the pile to reload");
        }
      } else if (action === "weapon-toggle") {
        crew.toggleWeapon(cave);
        syncAim();
        if (armed() && cave.weapon.equipped) lockAim();
        if (cave.weapon.equipped) hud.hint(armed() ? "Left-click bursts · F rifle strike · zoom: tap one shot, hold for auto · 1 melee · 2 AK · scroll to change view · Space reloads or jumps / jetpacks" : "AK equipped · right-click or scroll in to aim · 1 melee · Space reloads beside the pile or jumps / jetpacks");
        else hud.hint(armed() ? "Hold left-click to raise the club · release to strike · allow 0.2s between swings for full power · 2 AK · scroll out for navigation" : "Club equipped · right-click or scroll in to aim · 2 AK");
      } else if (action === "weapon-fire") {
        if (cave.weapon.primaryEquipped) crew.swingWeapon(cave, false, ads);
        else if (!(held ? crew.setWeaponTrigger(true, ads) : crew.fireWeapon(cave, null, ads ? 1 : undefined)) && cave.weapon.equipped && !cave.weapon.unlimited && !cave.weapon.ammo) hud.hint("Empty magazine · press Space within reach of the pile to reload");
      } else if (action === "weapon-bash") {
        crew.bashWeapon(cave);
      } else if (action === "weapon-reload") {
        crew.startReload(cave);
      } else if (action === "magazine-swap" || action === "weapon-magazine") {
        if (!crew.swapMagazine(cave) && !crew.hasMagazine(cave)) hud.hint("Find a spare magazine · Space reloads the AK and both spares beside the pile");
      } else return false;
      syncWeaponHud();
      if (ctx.reloadAnywhere) hud.hint("1 melee · 2 AK · right-click to aim · F rifle strike · V fire · R reload · Space use / reload / jump");
      return true;
    };
    const weaponMode = (slot) => {
      if (!active) return false;
      const cave = player();
      if (!cave) return false;
      if (slot === 0) return true;
      resumePose();
      if (!crew.selectWeapon(slot, cave)) return true;
      ads = false;
      syncAim();
      if (armed()) lockAim();
      syncWeaponHud();
      hud.hint(armed() ? slot === 1 ? "Hold left-click to raise the club · release to strike · allow 0.2s between hits for full power · 2 AK · scroll out for navigation" : "Left-click bursts · F rifle strike · zoom: tap one shot, hold for auto · 1 melee · scroll out for navigation · Space reloads beside the pile" : "1 melee · 2 AK · right-click or scroll in to aim · Space reloads beside the pile or jumps / jetpacks");
      if (ctx.reloadAnywhere) hud.hint("1 melee · 2 AK · right-click to aim · F rifle strike · V fire · R reload · Space use / reload / jump");
      return true;
    };
    const shooterView = (active, px = null, py = null, combat = null) => {
      resumePose();
      const cave = player();
      if (!weaponViewReady(cave)) return;
      rightDownAt = rightTapAt = -Infinity;
      if (active) rightReturnFirstPerson = false;
      if (active && birdsEye() && !closeWanted) {
        anchorOverheadPointer(cave);
        // The assisted hit may be centred on an object and refreshed on a
        // throttle. The cursor anchor is the exact rendered ray hit, including
        // its elevation, and is the only point that can cross modes unchanged.
        cursorPoint.x = overheadAim.x; cursorPoint.y = overheadAim.y; cursorPoint.z = overheadAim.z;
        cursorOccluded = false;
        cursorAim = true;
      } else if (active && px !== null && py !== null && !closeWanted) {
        mat4.lookAt(cursorView, camera.position, camera.target, camera.up || cursorUp);
        mat4.rayFromView(cursorRay, cursorView, renderer.size.width, renderer.size.height, camera.fov, camera.position, px, py, camera.orthoMix, camera.orthoHeight);
        // Navigation can place the eye farther away than a weapon's range.
        // Reach across the island from that eye, not just sixty units into
        // the air above the floor, then retain that world point throughout.
        const position = cave.root.position;
        const reach = Math.max(60, Math.hypot(camera.position.x - position.x, camera.position.y - position.y, camera.position.z - position.z) + DIST_MAX);
        pointAlongAim(cursorPoint, cursorRay.ox, cursorRay.oy, cursorRay.oz, cursorRay.dx, cursorRay.dy, cursorRay.dz, reach, cursorClear, 18);
        const hitDepth = Math.hypot(cursorPoint.x - cursorRay.ox, cursorPoint.y - cursorRay.oy, cursorPoint.z - cursorRay.oz);
        const p = cave.root.position, headY = p.y - cave.baseY + cave.headOffset * 0.95 + cave.viewLift;
        const actorDepth = (p.x - cursorRay.ox) * cursorRay.dx + (headY - cursorRay.oy) * cursorRay.dy + (p.z - cursorRay.oz) * cursorRay.dz;
        // Classify only on entry, using the same solids as the aim ray. A
        // surface nearer than the character must also obstruct their head;
        // visible targets beyond the character retain normal cursor aiming.
        cursorOccluded = hitDepth < actorDepth - cave.traits.height * 0.25 && !!sightClear
          && !sightClear(cursorRay.ox, cursorRay.oy, cursorRay.oz, p.x, headY, p.z);
        if (hitDepth < 0.1) {
          // An orbit eye inside scenery has no surface in front of its ray.
          // Do not turn that zero-depth hit into a target behind the character.
          cursorPoint.x = cursorRay.ox + cursorRay.dx * reach;
          cursorPoint.y = cursorRay.oy + cursorRay.dy * reach;
          cursorPoint.z = cursorRay.oz + cursorRay.dz * reach;
        }
        if (input && input.aimPoint(px, py, cursorItem, cave)) {
          const solidDepth = Math.hypot(cursorPoint.x - cursorRay.ox, cursorPoint.y - cursorRay.oy, cursorPoint.z - cursorRay.oz);
          const itemDepth = Math.hypot(cursorItem.x - cursorRay.ox, cursorItem.y - cursorRay.oy, cursorItem.z - cursorRay.oz);
          const forwardDepth = -(cursorView[2] * (cursorItem.x - cursorRay.ox) + cursorView[6] * (cursorItem.y - cursorRay.oy) + cursorView[10] * (cursorItem.z - cursorRay.oz));
          if (forwardDepth > 0.1 && itemDepth <= solidDepth + 0.1) {
            cursorPoint.x = cursorItem.x; cursorPoint.y = cursorItem.y; cursorPoint.z = cursorItem.z;
          }
        }
        cursorAim = true;
      }
      if (active && !cave.weapon.equipped && !cave.weapon.primaryEquipped) crew.selectWeapon(cave.weapon.selectedSlot, cave);
      shoulderView = active && !closeWanted;
      if (combat !== null) cave.weapon.aiming = combat;
      if (!active) {
        closeWanted = false;
        crew.releaseSwing(cave, true);
        crew.stopBurst(cave);
        if (!coarse) {
          resetPointer();
          if (armed()) carryCursor.stop();
          else unlockAim();
        }
      }
      syncAim();
      if (active) {
        if (armed() && !coarse && px !== null && py !== null && !closeWanted && !overheadExit) {
          const rect = canvas.getBoundingClientRect();
          carryCursor.beginAim(rect.left + px, rect.top + py);
        }
        if (armed()) { focusAim(); lockAim(); }
      } else {
        if (armed()) { focusAim(); lockAim(); }
        zoomTilt = false;
        zoomPitchVelocity = 0;
        if (birdsEye()) overheadHeight = overheadWanted = overheadMin;
        else {
          // Carry leaves shoulder through syncAim's swooping orbit handoff.
          // Only combat enters the overhead camera; do not force carry to its pole.
          orbit.tDist = carryOrbitMin;
        }
        restoreHead();
      }
      crew.poseWeapon(cave);
      syncWeaponHud();
      syncModeHud();
    };
    const resumeRightView = (px, py) => {
      const firstPerson = rightReturnFirstPerson;
      shooterView(true, px, py);
      if (firstPerson && shoulderView) enterClose();
    };
    const modeAction = (action) => {
      const cave = player();
      if (action === "mode-retake") {
        syncOwnOoga();
        if (ownOoga && ownOoga !== cave) hooks.onDoubleTap({ owner: { kind: "caveman", cave: ownOoga } });
        return !!ownOoga;
      }
      if (action === "mode-release") {
        if (cave) release();
        return !!cave;
      }
      if (action !== "mode-toggle" || !cave) return false;
      if (!weaponViewReady(cave)) {
        hud.hint(crew.sleeping ? "Wake this Ooga Booga before entering shooter mode" : "Stand up before entering shooter mode");
        return true;
      }
      resumePose();
      const leavingOverhead = birdsEye();
      rightDownAt = rightTapAt = -Infinity;
      cave.weapon.aiming = !cave.weapon.aiming;
      if (!cave.weapon.aiming) {
        crew.stopBurst(cave);
        crew.releaseSwing(cave, true);
        unlockAim();
      } else {
        // A freshly possessed character can carry its primary without an
        // equipped slot yet. Match scroll/right-click entry before posing it.
        if (!cave.weapon.equipped && !cave.weapon.primaryEquipped) crew.selectWeapon(cave.weapon.selectedSlot, cave);
        if (birdsEye()) {
          beginOverhead(cave, true);
          overheadActive = true;
        }
        carryCursor.stop();
        resetPointer();
        focusAim();
        lockAim();
      }
      crew.poseWeapon(cave);
      syncAim();
      if (leavingOverhead) beginCenteredCarry(cave);
      syncWeaponHud();
      syncModeHud();
      return true;
    };
    const possess = (cave, preserveHeight = false) => {
      // A scene may refuse an Ooga (whose it is, who is here): the refusal says why and nothing changes.
      const refusal = mayPossess && mayPossess(cave);
      if (refusal) {
        hud.toast(refusal);
        return;
      }
      restoredPose = null;
      centeredCarry = false;
      rememberControlMode();
      if (!crew.control(cave)) return;
      shoulderView = !crew.sleeping && !preserveHeight;
      carryExitMode = carryFocusRemaining = 0;
      cave.weapon.aiming = !crew.sleeping && (controlModes.get(cave.traits.name) ?? true);
      if (cave.weapon.aiming && !cave.weapon.equipped && !cave.weapon.primaryEquipped) crew.selectWeapon(cave.weapon.selectedSlot, cave);
      hud.setWeapon(false, false, 0);
      eyeMotionValid = false;
      dollyTime = DOLLY_HANDOFF;
      distanceVelocity = 0;
      zoomTilt = false;
      zoomPitchVelocity = 0;
      headOrbit = exitAngleHold = false;
      releaseMix = 0;
      resetGroundView();
      orbit.tDist = clamp(orbit.tDist, follow.min, follow.max);
      orbit.tPitch = clamp(orbit.tPitch, TRAILING_PITCH[0], TRAILING_PITCH[1]);
      if (preserveHeight && !crew.sleeping) {
        closeWanted = false;
        closeMix = closeVelocity = 0;
        restoreHead();
        if (cave.weapon.aiming) {
          beginOverhead(cave);
          // Height, rather than slanted camera-to-body distance, survives
          // selecting someone off-centre on a different floor.
          overheadHeight = overheadWanted = camera.position.y - cave.root.position.y + cave.baseY;
          overheadActive = true;
        } else beginCenteredCarry(cave);
      }
      if (closeWanted) {
        closeMix = closeVelocity = 0;
        faceWith(cave);
      }
      hud.el.act.hidden = false;
      showAct();
      syncAim();
      syncWeaponHud();
      hud.tooltip.hide();
      fx.say(cave, crew.sleeping ? "zzz..." : "Ooga? Me?", 1.6);
      if (crew.sleeping) hud.hint(coarse ? "Tap WAKE UP! to get up" : cave.bedroll.sleep ? "Space wakes up · WASD changes sleeping pose" : "Space wakes up · Escape leaves them sleeping");
      else if (cave.jet && cave.jetRecovering) hud.hint("Jetpack recharges on the ground · restart above 20% fuel");
      else if (cave.jet) hud.hint(coarse ? "Left stick flies · pinch in for first person · hold Blast off to climb" : "WASD flies · scroll in for first person · hold Space to climb · Escape to let go");
      else hud.hint(coarse ? "Left stick walks · pinch in for first person · JUMP! jumps or uses a nearby control" : "WASD walks · right-click to aim · scroll to change view · Space to jump or use a nearby control");
    };
    const rememberSleepView = () => {
      const up = camera.up;
      viewRotation(releaseRotation, camera.target.x - camera.position.x, camera.target.y - camera.position.y, camera.target.z - camera.position.z, up ? up.x : 0, up ? up.y : 1, up ? up.z : 0, orbit.yaw);
      releaseMix = 1;
    };
    const release = (quiet = false) => {
      restoredPose = null;
      endCenteredCarry();
      const cave = player();
      if (!cave) return;
      rememberControlMode();
      cave.weapon.aiming = false;
      shoulderView = false;
      unlockAim();
      eyeMotionValid = false;
      dollyTime = DOLLY_HANDOFF;
      if (crew.sleeping && closeWanted) {
        const dx = camera.target.x - camera.position.x, dy = camera.target.y - camera.position.y, dz = camera.target.z - camera.position.z;
        rememberSleepView();
        // Close-view input was head-relative; free navigation resumes from that world direction, easing roll upright.
        orbit.yaw = orbit.tYaw = Math.atan2(-dx, -dz);
        orbit.pitch = orbit.tPitch = clamp(Math.atan2(-dy, Math.hypot(dx, dz)), TRAILING_PITCH[0], TRAILING_PITCH[1]);
      }
      if ((closeWanted || closeMix > 0) && ctx.releaseView) ctx.releaseView(cave, camera.position);
      closeWanted = false;
      resetGroundView();
      restoreHead();
      entryRebase = entryOffsetActive = false;
      closeCave = null;
      crew.release();
      syncAim();
      const portrait = clamp(1 - renderer.size.width / Math.max(1, renderer.size.height), 0, 0.6);
      freeTarget.x = camera.target.x;
      freeTarget.y = camera.target.y + portrait * 0.6;
      freeTarget.z = camera.target.z;
      const dx = camera.position.x - freeTarget.x, dy = camera.position.y - freeTarget.y, dz = camera.position.z - freeTarget.z;
      orbit.dist = orbit.tDist = Math.hypot(dx, dy, dz);
      const horizontal = Math.hypot(dx, dz);
      orbit.yaw = orbit.tYaw = horizontal > 1e-5 ? Math.atan2(dx, dz)
        : camera.up ? Math.atan2(camera.up.x, camera.up.z) : orbit.yaw;
      orbit.pitch = orbit.tPitch = clamp(Math.atan2(dy, horizontal), TRAILING_PITCH[0], TRAILING_PITCH[1]);
      closeMix = closeVelocity = 0;
      orbit.target = freeTarget;
      orbit.tx = freeTarget.x; orbit.ty = freeTarget.y; orbit.tz = freeTarget.z;
      distanceVelocity = zoomPitchVelocity = 0;
      dollyTime = DOLLY_HANDOFF;
      eyeMotionValid = false;
      headOrbit = exitAngleHold = closeCameraActive = false;
      carryExitMode = carryFocusRemaining = 0;
      freeStrafe = freeForward = freeClimb = 0;
      freeMoveYaw = orbit.yaw;
      hud.el.act.hidden = true;
      syncJetpackHud();
      syncWeaponHud();
      syncModeHud();
      if (!quiet) hud.toast(`${cave.traits.display} ${cave.state === "sleeping" ? "keeps sleeping" : "wanders off"}`);
    };
    // Nearby actions consume a press; a ready jetpack leaves Space as throttle.
    const action = () => {
      if (player()?.grabbedBy) return true;
      if (ctx.onPlayerAction && ctx.onPlayerAction()) return true;
      if (!active) return true;
      if (externalControl) return false;
      resumePose();
      const cave = player();
      return cave ? crew.playerAction() : !!ctx.onFreeAction && ctx.onFreeAction();
    };
    // Held it climbs, clicked it acts; both mouse buttons on the canvas walk
    const controls = createControls({ move: document.getElementById("joy-move"), look: document.getElementById("joy-look"), boost: hud.el.act, chord: canvas, onAction: action, pressActions: true, shooter: () => externalCombat ? externalCombat() : armed(), canDescend: () => !player() });
    // A wheel gesture that crosses a mode boundary is held there so its momentum cannot carry on into the next
    // mode; the hold lasts ZOOM_HOLD seconds. A mouse or trackpad that keeps scrolling extends one gesture for as
    // long as it scrolls, so an unbounded hold left the view stuck in shoulder or first person.
    const ZOOM_HOLD = 0.35;
    let trailingViewInput = false, trailingZoomInput = false, stoppedZoomGesture = null, stoppedZoomAt = 0;
    const zoomPitch = (cave, fromDistance) => {
      if (!weaponViewReady(cave)) return;
      if (carryExitMode === 1) return;
      if (!zoomTilt) {
        zoomAnchorPitch = trailingPitchChosen ? orbit.tPitch : viewPitch;
        zoomAnchorDistance = fromDistance;
      }
      // Add a small tilt relative to the chosen view over the full zoom range.
      // Below a ceiling, keep the chosen angle exactly; the horizontal boom is
      // only the one-time transition out of shooter view.
      const span = Math.log(DIST_MAX / DIST_MIN);
      const change = Math.log(orbit.tDist / zoomAnchorDistance) / span;
      const p = cave.root.position, covered = ceilingAt && ceilingAt(p.x, p.z, p.y - cave.baseY, cave) < Infinity;
      orbit.tPitch = covered ? zoomAnchorPitch
        : clamp(zoomAnchorPitch + 0.32 * change, Math.min(0.08, zoomAnchorPitch), Math.max(0.68, zoomAnchorPitch));
      trailingPitchChosen = true;
      zoomTilt = true;
    };
    const hooks = {
      hoverIgnore: () => closeWanted || closeMix > 0 ? player() : null,
      onOrbit: (dx, dy) => {
        if (dx || dy) resumePose();
        if ((dx || dy) && hud.fadeDetachedName) hud.fadeDetachedName();
        if (birdsEye()) { moveOverheadPointer(dx, dy); return; }
        const cave = player();
        if (syncLyingView(cave)) {
          if (dx || dy) releaseCursorAim();
          moveLyingView(-dx * 0.0025, dy * 0.0025);
          return;
        }
        if (aimView()) {
          if (dx || dy) releaseCursorAim();
          orbit.yaw = orbit.tYaw -= dx * 0.0025;
          orbit.pitch = orbit.tPitch = clamp(orbit.tPitch + dy * 0.0025, TRAILING_PITCH[0], TRAILING_PITCH[1]);
          return;
        }
        if (dx || dy) stopCarryExit();
        if (dy) { zoomTilt = false; zoomPitchVelocity = 0; }
        orbit.tYaw -= dx * 4e-3;
        const pitch = close && !cave && (closeWanted || closeMix > 0.5) ? close.pitch : TRAILING_PITCH;
        if (dy) orbit.tPitch = clamp(orbit.tPitch + dy * 3.5e-3, pitch[0], pitch[1]);
        if (cave && !closeWanted) {
          trailingViewInput = true;
          if (dy) trailingPitchChosen = true;
        }
      },
      onZoom: (factor, gesture = null, px = null, py = null) => {
        if (factor === 1) return;
        resumePose();
        if (gesture !== null && gesture === stoppedZoomGesture && performance.now() - stoppedZoomAt < ZOOM_HOLD * 1000) return;
        if (hud.fadeDetachedName) hud.fadeDetachedName();
        const cave = player();
        if (birdsEye()) {
          // X may preserve a radius below the scroll boundary. Scrolling in
          // there enters shoulder from this pose, never first lifting out.
          const wanted = clamp(overheadWanted * factor, Math.min(overheadWanted, overheadMin), DIST_MAX);
          if (wanted !== overheadWanted) {
            anchorOverheadPointer(cave);
            overheadWanted = wanted;
          }
          overheadToShoulder = factor < 1 && wanted <= overheadMin;
          if (overheadToShoulder) stoppedZoomGesture = gesture;
          return;
        }
        if (aimView()) {
          // Stop the entire gesture at shoulder view, including its momentum.
          // A fresh scroll is needed to cross the next mode boundary.
          if (factor < 1 && shoulderView) enterClose();
          else if (factor > 1) {
            if (closeWanted) {
              exitClose();
              stoppedZoomGesture = gesture;
              stoppedZoomAt = performance.now();
            }
            else {
              shooterView(false);
              stoppedZoomGesture = gesture;
            }
          }
          return;
        }
        if (!close) {
          orbit.tDist = clamp(orbit.tDist * factor, DIST_MIN, DIST_MAX);
          return;
        }
        if (closeWanted) {
          if (factor > 1) {
            closeExitScale *= factor;
            if (closeExitScale >= CLOSE_PINCH_EXIT) {
              exitClose();
              if (player()) trailingZoomInput = true;
            }
          } else closeExitScale = 1;
          return;
        }
        const fromDistance = orbit.tDist;
        if (factor < 1 && carryExitMode === 2) stopCarryExit();
        const minimum = weaponViewReady(cave) ? carryOrbitMin : DIST_MIN;
        orbit.tDist = clamp(fromDistance * factor, Math.min(fromDistance, minimum), DIST_MAX);
        zoomPitch(cave, fromDistance);
        if (player()) {
          // Ease the chosen distance in the orbit itself: a wheel event must not teleport the eye before its dolly starts.
          trailingZoomInput = true;
        }
        if (factor < 1 && orbit.tDist <= minimum + 0.001) {
          if (weaponViewReady(cave)) {
            shooterView(true, px, py);
            stoppedZoomGesture = gesture;
              stoppedZoomAt = performance.now();
          }
          else enterClose();
        }
      },
      onDoubleTap: (hit) => {
        if (hit && hit.owner.kind === "caveman") {
          const cave = hit.owner.cave;
          if (cave === player()) release();
          else {
            const headY = cave.root.position.y - cave.baseY + cave.headOffset + cave.viewLift;
            const highEntry = !player() && camera.position.y - headY >= POSSESS_OVERHEAD_CLEARANCE;
            possess(cave, highEntry);
            if (player() === cave && armed()) { focusAim(); lockAim(); }
          }
        } else if (player()) release();
      }
    };
    const goPreset = (name) => {
      const p = presets[name];
      if (!p) return;
      eyeMotionValid = false;
      dollyTime = DOLLY_HANDOFF;
      distanceVelocity = 0;
      release(true);
      shoulderView = false;
      closeWanted = false;
      closeMix = closeVelocity = 0;
      closeExitScale = 1;
      closeCave = null;
      trailingPitchChosen = false;
      zoomTilt = false;
      zoomPitchVelocity = 0;
      headOrbit = exitAngleHold = false;
      entryRebase = entryOffsetActive = false;
      releaseMix = 0;
      restoreHead();
      resetFreeFall();
      orbit.target = p.target;
      orbit.tYaw = p.yaw;
      orbit.tPitch = p.pitch;
      orbit.tDist = p.dist;
    };
    // Call before the crew moves: reads keys and sticks for this frame.
    const readInput = (dt) => {
      if (!active || externalControl) return;
      syncAim();
      const a = controls.read();
      // Arrival easing keeps its label; only manual camera input fades it.
      if ((a.x || a.y || a.up || a.yaw || a.pitch || a.orbitYaw) && hud.fadeDetachedName) hud.fadeDetachedName();
      const cave = player();
      const lying = syncLyingView(cave);
      const shoulderCombat = !!cave && armed() && shoulderView && !closeWanted;
      if (shoulderCombat && a.shiftTap) shoulderSideTarget = -shoulderSideTarget;
      peekTarget = shoulderCombat && a.peek && !a.sprint ? a.x : 0;
      const planted = shoulderCombat && !!a.peek && !a.sprint;
      const moveX = planted ? 0 : a.x, moveY = planted ? 0 : a.y;
      if (restoredPose) {
        if (a.x || a.y || a.up || a.yaw || a.pitch || a.orbitYaw) resumePose();
        else return;
      }
      if (aimView()) {
        // Armed, the controls keep Q/E off the look axis (birds-eye orbits with them); aiming views turn with them here.
        const turn = clamp(a.yaw + a.orbitYaw, -1, 1);
        if (a.x || a.y || a.up || turn || a.pitch) releaseCursorAim();
        if (lying) moveLyingView(turn * YAW_RATE * dt, a.pitch * PITCH_RATE * dt);
        else {
          orbit.yaw = orbit.tYaw += turn * YAW_RATE * dt;
          orbit.pitch = orbit.tPitch = clamp(orbit.tPitch + a.pitch * PITCH_RATE * dt, TRAILING_PITCH[0], TRAILING_PITCH[1]);
        }
        if (armed()) poseAim();
      }
      const movementYaw = birdsEye() ? overheadYaw : orbit.yaw;
      const fx0 = -Math.sin(movementYaw), fz0 = -Math.cos(movementYaw);
      const rx = Math.cos(movementYaw), rz = -Math.sin(movementYaw);
      if (cave) {
        freeStrafe = freeForward = freeClimb = 0;
        const p = cave.root.position;
        followTarget.x = p.x;
        followTarget.y = p.y - cave.baseY + follow.y;
        followTarget.z = p.z;
        orbit.target = followTarget;
        if (cave.jet) crew.thrust(a.up > 0);
        else if (cave.traits.footRockets) crew.holdRocketJump(a.up > 0);
        crew.steer(fx0 * moveY + rx * moveX, fz0 * moveY + rz * moveX, armed() ? 1 : close ? closeMix : 0, moveY, moveX,
          armed() && ads ? 0.65 : a.sprint ? WALK.run : 1, peekTarget);
      } else {
        if (orbit.target === freeTarget) {
          const stopStrafe = freeStrafe && (!a.x || freeStrafe * a.x < 0), stopForward = freeForward && (!a.y || freeForward * a.y < 0);
          const stopClimb = freeClimb && (!a.up || freeClimb * a.up < 0);
          if (stopStrafe || stopForward || stopClimb) {
            // Consume released or reversed input's leftover damping; the eye's current center stops release snapping back.
            const offset = orbit.dist * (1 - closeMix), cp = Math.cos(viewPitch);
            const centerX = camera.position.x - Math.sin(orbit.yaw) * cp * offset;
            const centerY = camera.position.y - Math.sin(viewPitch) * offset;
            const centerZ = camera.position.z - Math.cos(orbit.yaw) * cp * offset;
            const sr = Math.sin(freeMoveYaw), cr = Math.cos(freeMoveYaw);
            if (stopStrafe) {
              const target = (centerX - freeTarget.x) * cr - (centerZ - freeTarget.z) * sr;
              const current = (centerX - orbit.tx) * cr - (centerZ - orbit.tz) * sr;
              freeTarget.x += target * cr; freeTarget.z -= target * sr;
              orbit.tx += current * cr; orbit.tz -= current * sr;
            }
            if (stopForward) {
              const target = (centerX - freeTarget.x) * sr + (centerZ - freeTarget.z) * cr;
              const current = (centerX - orbit.tx) * sr + (centerZ - orbit.tz) * cr;
              freeTarget.x += target * sr; freeTarget.z += target * cr;
              orbit.tx += current * sr; orbit.tz += current * cr;
            }
            if (stopClimb) freeTarget.y = orbit.ty = centerY;
          }
        }
        if (a.x || a.y || a.up) {
          if (orbit.target !== freeTarget) {
            freeTarget.x = orbit.target.x;
            freeTarget.y = orbit.target.y;
            freeTarget.z = orbit.target.z;
            orbit.target = freeTarget;
          }
          const speed = (closeWanted ? WALK.speed / Math.max(1, Math.hypot(a.x, a.y)) : fly.speed + orbit.tDist * fly.perDist) * dt;
          freeTarget.x += (fx0 * a.y + rx * a.x) * speed;
          freeTarget.z += (fz0 * a.y + rz * a.x) * speed;
          if (a.up && !closeWanted) {
            // Underground bounds apply to the eye: a pitched orbit's focus can sit below its floor, and must stay there.
            const offset = fly.yMin === undefined ? 0 : Math.sin(viewPitch) * orbit.dist * (1 - closeMix);
            freeTarget.y = clamp(freeTarget.y + a.up * fly.climb * dt, (fly.yMin === undefined ? 0 : fly.yMin) - offset, fly.yMax - offset);
          }
          clampTarget(freeTarget);
        }
        if (closeWanted && freeFalling && freeFeetY + (freeFallV - WALK.gravity * dt) * dt > freeFloorY && (freeLeapX || freeLeapZ)) {
          freeTarget.x += freeLeapX * dt;
          freeTarget.z += freeLeapZ * dt;
          freeLeapX = damp(freeLeapX, 0, WALK.ledgeDrag, dt);
          freeLeapZ = damp(freeLeapZ, 0, WALK.ledgeDrag, dt);
          clampTarget(freeTarget);
        }
        freeStrafe = a.x; freeForward = a.y; freeClimb = a.up;
        freeMoveYaw = orbit.yaw;
      }
      if (a.yaw || a.pitch) stopCarryExit();
      if (birdsEye()) {
        if (a.orbitYaw) {
          overheadNorthUp = false;
          overheadPointerMoved = true;
          assistedTargetWait = 0;
        }
        overheadTargetYaw += a.orbitYaw * YAW_RATE * dt;
        if (a.yaw || a.pitch) moveOverheadPointer(-a.yaw * 500 * dt, a.pitch * 500 * dt);
        return;
      }
      if (!aimView() && lying && (a.yaw || a.pitch)) {
        moveLyingView(a.yaw * YAW_RATE * dt, a.pitch * PITCH_RATE * dt);
      } else if (!lying && a.yaw) {
        orbit.tYaw += a.yaw * YAW_RATE * dt;
        if (cave && !closeWanted) trailingViewInput = true;
      }
      if (!lying && a.pitch) {
        zoomTilt = false;
        zoomPitchVelocity = 0;
        const pitch = close && !cave && (closeWanted || closeMix > 0.5) ? close.pitch : TRAILING_PITCH;
        orbit.tPitch = clamp(orbit.tPitch + a.pitch * PITCH_RATE * dt, pitch[0], pitch[1]);
        if (cave && !closeWanted) trailingViewInput = trailingPitchChosen = true;
      }
    };
    // The camera moves only on input: no drift, auto-orbit or inertia.

    const poseAim = () => {
      if (player()?.grabbedBy) return;
      if (aimPreserveFacing) {
        crew.look(aimBodyYaw, aimBodyPitch, 1);
        player().parts.head.rotation.y = aimBodyHeadYaw;
        return;
      }
      const turn = Math.atan2(Math.sin(orbit.yaw + Math.PI - aimBodyYaw), Math.cos(orbit.yaw + Math.PI - aimBodyYaw));
      crew.look(aimBodyYaw + turn * aimMix, aimBodyPitch + (orbit.pitch - aimBodyPitch) * aimMix, 1);
    };
    const updateAim = (cave, dt) => {
      syncJetpackHud(); syncWeaponHud();
      crew.elevate(0);
      // Match the navigation dolly: zoom starts with continuous velocity,
      // rather than taking its largest sideways/backward step on entry.
      const target = closeWanted ? 1 : 0, decay = Math.exp(-CLOSE_RATE * dt);
      let delta = closeMix - target, impulse = (closeVelocity + CLOSE_RATE * delta) * dt;
      closeMix = target + (delta + impulse) * decay;
      closeVelocity = (closeVelocity - CLOSE_RATE * impulse) * decay;
      if (closeMix < 0 || closeMix > 1 || Math.abs(closeMix - target) < CLOSE_SNAP && Math.abs(closeVelocity) < CLOSE_SNAP * CLOSE_RATE) {
        closeMix = clamp(closeMix, 0, 1);
        if (Math.abs(closeMix - target) < CLOSE_SNAP) closeMix = target;
        closeVelocity = 0;
      }
      // Releasing a shoulder target can restart this spring while zooming in.
      // Finish its eye/aim handoff at the close-view rate so first person
      // cannot retain a slower shoulder offset after the zoom has settled.
      const entryRate = closeWanted ? CLOSE_RATE : AIM_ENTRY_RATE;
      const entryDecay = Math.exp(-entryRate * dt);
      delta = aimMix - 1; impulse = (aimVelocity + entryRate * delta) * dt;
      aimMix = 1 + (delta + impulse) * entryDecay;
      aimVelocity = (aimVelocity - entryRate * impulse) * entryDecay;
      if (1 - aimMix < CLOSE_SNAP && Math.abs(aimVelocity) < CLOSE_SNAP * entryRate) { aimMix = 1; aimVelocity = 0; }
      poseAim();
      shoulderSide = damp(shoulderSide, shoulderSideTarget, SHOULDER_SWAP_RATE, dt);
      if (Math.abs(shoulderSide - shoulderSideTarget) < 1e-4) shoulderSide = shoulderSideTarget;
      peekMix = damp(peekMix, peekTarget, PEEK_RATE, dt);
      if (Math.abs(peekMix - peekTarget) < 1e-4) peekMix = peekTarget;
      adsMix = damp(adsMix, ads ? 1 : 0, CLOSE_RATE, dt);
      if (Math.abs(adsMix - (ads ? 1 : 0)) < CLOSE_SNAP) adsMix = ads ? 1 : 0;
      const h = cave.traits.height, p = cave.root.position;
      if (cave.camp.rolling && closeWanted) {
        // First person belongs to the rolling head rather than an upright
        // world-space boom. The rendered head supplies the eye, forward and
        // up axes, while bounded local look follows it through the roll.
        syncLyingView(cave);
        applyLyingView(cave);
        camera.position.x = headEye[0]; camera.position.y = headEye[1]; camera.position.z = headEye[2];
        camera.target.x = headEye[0] + rollingForward[0] * CLOSE_LOOK_DIST;
        camera.target.y = headEye[1] + rollingForward[1] * CLOSE_LOOK_DIST;
        camera.target.z = headEye[2] + rollingForward[2] * CLOSE_LOOK_DIST;
        camera.up = sleepCameraUp;
        camera.orthoMix = 0;
        camera.fov = Math.min(MAX_FOV, Math.max(BASE_FOV, 2 * Math.atan(Math.tan(MIN_HFOV / 2) / (renderer.size.width / Math.max(1, renderer.size.height))))) * (1 - 0.2 * adsMix);
        cave.weapon.aimYaw = lyingYaw;
        cave.weapon.aimPitch = lyingPitch;
        crew.poseWeapon(cave);
        if (armed()) updateFeedback(cave, dt);
        syncHeadVisibility(cave);
        carryCursor.updateAim(aimMix);
        eyeMotionValid = false;
        return;
      }
      const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch), sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
      const eyeClearance = cave.headOffset * 0.95 + cave.viewLift;
      const eyeY = p.y - cave.baseY + eyeClearance;
      const distance = (shoulderDistance(cave, orbit.pitch) - 0.3 * adsMix) * h * (1 - closeMix), side = shoulderSide * (1 - 0.14 * adsMix) * h * (1 - closeMix);
      const eyeForward = 0.16 * h * closeMix;
      // Ordinary aim stays above the head. Only a steep upward look lowers
      // the boom; distance supplies the room needed to keep the feet in view.
      const boomPitch = shoulderBoomPitch(orbit.pitch), horizontal = Math.cos(boomPitch) * distance - cp * eyeForward;
      const peek = peekMix * PEEK_CAMERA * h;
      const x = p.x + sy * horizontal + cy * (side + peek);
      const y = eyeY + Math.sin(boomPitch) * distance + SHOULDER_LIFT * h * (1 - closeMix);
      const z = p.z + cy * horizontal - sy * (side + peek);
      if (aimMix < 1 && closeMix > 0) {
        // A fresh inward scroll may arrive before shoulder entry finishes.
        // Approach the eyes directly; a polar arc flips sides as it crosses
        // the head to reach the first-person eye just in front of the face.
        camera.position.x = aimEntry.x + p.x - aimEntryBody.x + (x - aimEntry.x - p.x + aimEntryBody.x) * aimMix;
        camera.position.y = aimEntry.y + p.y - aimEntryBody.y + (y - aimEntry.y - p.y + aimEntryBody.y) * aimMix;
        camera.position.z = aimEntry.z + p.z - aimEntryBody.z + (z - aimEntry.z - p.z + aimEntryBody.z) * aimMix;
      } else if (aimMix < 1) {
        const endX = x - p.x, endY = y - eyeY, endZ = z - p.z;
        const endYaw = Math.atan2(endX, endZ);
        const arcYaw = aimEntryYaw + Math.atan2(Math.sin(endYaw - aimEntryYaw), Math.cos(endYaw - aimEntryYaw)) * aimMix;
        const arcHorizontal = aimEntryRadius + (Math.hypot(endX, endZ) - aimEntryRadius) * aimMix;
        camera.position.x = p.x + Math.sin(arcYaw) * arcHorizontal;
        camera.position.y = eyeY + aimEntryHeight + (endY - aimEntryHeight) * aimMix;
        camera.position.z = p.z + Math.cos(arcYaw) * arcHorizontal;
      } else {
        camera.position.x = x; camera.position.y = y; camera.position.z = z;
      }
      // The outward dolly is an orbit path. Keep it unrestricted throughout
      // the handoff instead of dropping physical clearance only at mix zero.
      clampCamera(camera.position, closeMix, eyeClearance, false, dt, false, true, false, !closeWanted);
      camera.fov = Math.min(MAX_FOV, Math.max(BASE_FOV, 2 * Math.atan(Math.tan(MIN_HFOV / 2) / (renderer.size.width / Math.max(1, renderer.size.height))))) * (1 - 0.2 * adsMix);
      setOverheadProjection(cave, aimEntryOrtho * (1 - aimMix));
      if (aimAtCursor && !overheadExit) {
        // Solve a world-up view that puts the selected point under the gliding
        // cursor. Interpolating an unrelated camera rotation lets it drift off
        // the object or even push that object outside the screen mid-swoop.
        const dx = cursorPoint.x - camera.position.x, dy = cursorPoint.y - camera.position.y, dz = cursorPoint.z - camera.position.z;
        const tangent = Math.tan(camera.fov * 0.5), remaining = 1 - aimMix;
        const sx = aimScreenX * remaining * tangent * renderer.size.width / renderer.size.height, sy = aimScreenY * remaining * tangent;
        const pitch = Math.atan(sy) - Math.asin(clamp(dy / Math.hypot(dx, dy, dz) * Math.sqrt((1 + sx * sx + sy * sy) / (1 + sy * sy)), -1, 1));
        const yaw = Math.atan2(-dx, -dz) + Math.atan2(sx, Math.cos(pitch) + sy * Math.sin(pitch));
        viewRotation(aimPanRotation, -Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch), 0, 1, 0, yaw);
      } else {
        viewRotation(aimLookRotation, -sy * cp, -sp, -cy * cp, 0, 1, 0, orbit.yaw);
        aimPanRotation.set(aimEntryRotation);
        quat.slerpTo(aimPanRotation, aimLookRotation, aimMix);
        if (aimAtCursor && overheadExit) {
          // Retain a picked point through a vertical camera's singularity.
          // Rotate the interpolated screen ray onto that world point, carrying
          // its roll continuously rather than solving a world-up Euler view.
          const tangent = Math.tan(camera.fov * 0.5), remaining = 1 - aimMix;
          const dx = cursorPoint.x - camera.position.x, dy = cursorPoint.y - camera.position.y, dz = cursorPoint.z - camera.position.z;
          const length = Math.hypot(dx, dy, dz), x = dx / length, y = dy / length, z = dz / length;
          let sx = aimScreenX * remaining * tangent * renderer.size.width / renderer.size.height, sy = aimScreenY * remaining * tangent;
          const perspective = 1 - camera.orthoMix, offset = camera.orthoMix * camera.orthoHeight / (2 * tangent);
          let across = sx * sx + sy * sy;
          // A hybrid ray has a displaced origin. Solve its positive view
          // depth, then rotate that full camera-to-point vector onto the aim.
          // This keeps an off-centre target under the same gliding reticle.
          if (across * offset * offset >= length * length && across > 0) {
            const scale = length * 0.999 / (Math.sqrt(across) * offset);
            sx *= scale; sy *= scale; across = sx * sx + sy * sy;
          }
          const a = 1 + across * perspective * perspective;
          const depth = (-across * perspective * offset + Math.sqrt(Math.max(0, length * length * a - across * offset * offset))) / a;
          const w = perspective * depth + offset;
          quat.rotateVec(aimScreenRay, aimPanRotation, sx * w / length, sy * w / length, -depth / length);
          aimCorrection[0] = aimScreenRay[1] * z - aimScreenRay[2] * y;
          aimCorrection[1] = aimScreenRay[2] * x - aimScreenRay[0] * z;
          aimCorrection[2] = aimScreenRay[0] * y - aimScreenRay[1] * x;
          aimCorrection[3] = 1 + aimScreenRay[0] * x + aimScreenRay[1] * y + aimScreenRay[2] * z;
          quat.normalize(aimCorrection);
          quat.multiply(aimPanRotation, aimCorrection, aimPanRotation);
        }
      }
      quat.rotateVec(aimForward, aimPanRotation, 0, 0, -1);
      camera.target.x = camera.position.x + aimForward[0] * CLOSE_LOOK_DIST;
      camera.target.y = camera.position.y + aimForward[1] * CLOSE_LOOK_DIST;
      camera.target.z = camera.position.z + aimForward[2] * CLOSE_LOOK_DIST;
      // A sleeper may wake from a rolled view. Carry its full orientation
      // through the existing aim dolly before returning to world-up.
      if (aimMix < 1) {
        quat.rotateVec(sleepUp, aimPanRotation, 0, 1, 0);
        sleepCameraUp.x = sleepUp[0]; sleepCameraUp.y = sleepUp[1]; sleepCameraUp.z = sleepUp[2];
        camera.up = sleepCameraUp;
      } else camera.up = null;
      if (reticle.dataset.ads !== String(ads)) reticle.dataset.ads = String(ads);
      // Use the same cone and current FOV as the emitted shots, including
      // the ADS transition. Write the DOM only while its visible size changes.
      const radius = Math.round(spreadRadius() * 100) / 100;
      if (radius !== reticleRadius) {
        reticleRadius = radius;
        reticle.style.setProperty("--reticle-radius", `${radius}px`);
      }
      // Pose tracks the same ray without collision work between shots.
      if (aimAtCursor) {
        aimPoint.x = cursorPoint.x; aimPoint.y = cursorPoint.y; aimPoint.z = cursorPoint.z;
      } else if (aimPreserveFacing) {
        aimPoint.x = p.x - sy * cp * 60;
        aimPoint.y = eyeY - sp * 60;
        aimPoint.z = p.z - cy * cp * 60;
      } else {
        aimPoint.x = camera.position.x + (camera.target.x - camera.position.x) * 15;
        aimPoint.y = camera.position.y + (camera.target.y - camera.position.y) * 15;
        aimPoint.z = camera.position.z + (camera.target.z - camera.position.z) * 15;
      }
      cave.weapon.aimPitch = -Math.atan2(aimPoint.y - p.y - h * 0.45, Math.hypot(aimPoint.x - p.x, aimPoint.z - p.z));
      const yaw = Math.atan2(aimPoint.x - p.x, aimPoint.z - p.z) - cave.root.rotation.y;
      cave.weapon.aimYaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      if (overheadExit) {
        // Blend the world aim, so the arm and its attached gun move with
        // the camera handoff even while the body turns beneath them.
        const worldYaw = cave.root.rotation.y + cave.weapon.aimYaw;
        const turn = Math.atan2(Math.sin(worldYaw - aimWeaponYaw), Math.cos(worldYaw - aimWeaponYaw));
        const localYaw = aimWeaponYaw + turn * aimMix - cave.root.rotation.y;
        cave.weapon.aimYaw = Math.atan2(Math.sin(localYaw), Math.cos(localYaw));
        cave.weapon.aimPitch = aimWeaponPitch + (cave.weapon.aimPitch - aimWeaponPitch) * aimMix;
      }
      // Keep the world hold for reflections; the renderer applies the sight
      // pose only while uploading the player's camera view.
      crew.poseWeapon(cave, camera, 0, closeMix * aimMix);
      cave.gunSightMix = adsMix * closeMix * aimMix;
      if (reticle.dataset.sight !== String(cave.gunSightMix > 0.95)) reticle.dataset.sight = String(cave.gunSightMix > 0.95);
      if (armed()) updateFeedback(cave, dt);
      syncHeadVisibility(cave);
      if (overheadExit) {
        overheadMix = overheadExit * (1 - aimMix);
        // A selected point retains its reticle during the swoop. Once the
        // handoff finishes the ordinary shoulder reticle owns the centre.
        if (aimAtCursor && projectAim(cursorPoint)) positionReticle(assistedTargetScreen.x, assistedTargetScreen.y);
        else positionReticle(renderer.size.width / 2, renderer.size.height / 2);
        if (aimMix === 1) { overheadMix = overheadExit = 0; resetAssist(); }
      }
      carryCursor.updateAim(aimMix);
      eyeMotionValid = false;
    };
    const update = (dt) => {
      if (externalControl) return;
      if (restoredPose) {
        applyPose(restoredPose);
        syncJetpackHud(); syncWeaponHud();
        if (armed()) updateFeedback(player(), dt);
        syncHeadVisibility(player());
        return;
      }
      syncAim();
      const cave = player();
      if (cave) cave.gunSightMix = 0;
      syncModeHud();
      if (birdsEye()) { updateOverhead(cave, dt); return; }
      // A bed or seated pose has its own camera anchor; a held carry-exit
      // height must not turn its later zoom into a vertical, singular orbit.
      if (carryExitMode && !weaponViewReady(cave)) stopCarryExit();
      if (aimView()) { updateAim(cave, dt); return; }
      if (centeredCarry && cave && !closeWanted && weaponViewReady(cave)) { updateCenteredCarry(cave, dt); return; }
      endCenteredCarry();
      camera.orthoMix = 0;
      const sleeping = !!(cave && crew.sleeping && cave.root.quaternion);
      const rolling = !!(cave && cave.camp.rolling && cave.root.quaternion);
      const lying = syncLyingView(cave);
      if (sleepingView && !sleeping && cave && closeWanted && closeMix > 0) {
        rememberSleepView();
        // Waking restores the bed's upright stance: ease rendered roll to that heading, no sleep-relative Euler angles.
        orbit.yaw = orbit.tYaw = cave.root.rotation.y + Math.PI;
        orbit.pitch = orbit.tPitch = 0;
        quat.fromEuler(entryRoll, 0, 0, 0);
      }
      if (sleeping && !sleepingView) {
        lyingView = 0;
      }
      sleepingView = sleeping;
      if ((cave || headOrbit) && (closeWanted || closeMix > 0 || closeCameraActive)) {
        if (!closeCameraActive) {
          const up = camera.up;
          viewRotation(cameraRotation, camera.target.x - camera.position.x, camera.target.y - camera.position.y, camera.target.z - camera.position.z, up ? up.x : 0, up ? up.y : 1, up ? up.z : 0, orbit.yaw);
          closeCameraActive = true;
        }
      } else closeCameraActive = false;
      camera.up = null;
      syncJetpackHud();
      syncWeaponHud();
      if (cave) {
        const p = cave.root.position;
        if (headOrbit) {
          headAnchor(cave, followTarget);
          followTarget.x += headOrbitOffset.x; followTarget.y += headOrbitOffset.y; followTarget.z += headOrbitOffset.z;
        } else {
          followTarget.x = sleeping ? cave.sleepHead.x : p.x;
          followTarget.y = sleeping ? cave.sleepHead.y : p.y - cave.baseY + follow.y;
          followTarget.z = sleeping ? cave.sleepHead.z : p.z;
        }
      }
      if (exitAngleHold && !closeWanted && closeMix === 0 && !sleeping) {
        const body = cave ? cave.root.position : freeTarget;
        if (Math.hypot(body.x - exitBodyX, body.y - exitBodyY, body.z - exitBodyZ) > 1e-5) exitAngleHold = false;
      }
      const directTrailingView = trailingViewInput && !!cave && !closeWanted;
      // Crossing into first person starts a dolly even when the same wheel event changed the trailing distance.
      // Its corridor recovery keeps the normal motion budget instead of acting as a direct drag.
      const directCameraPosition = directTrailingView || trailingZoomInput && !!cave && !closeWanted;
      trailingViewInput = false;
      trailingZoomInput = false;
      let groundReset = false;
      if (closeWanted && cave !== closeCave) {
        if (cave) {
          resetGroundView();
          closeMix = closeVelocity = 0;
          faceWith(cave);
        } else {
          resetGroundView();
          if (closeCave) setFreeEye();
          closeCave = null;
          restoreHead();
        }
      }
      if (close) {
        // Analytic critically damped step: speed stays continuous.
        // First-order easing would add its largest step exactly when the wheel reaches first person.
        const target = closeWanted ? 1 : 0, delta = closeMix - target;
        const decay = Math.exp(-closeRate * dt), impulse = (closeVelocity + closeRate * delta) * dt;
        closeMix = target + (delta + impulse) * decay;
        closeVelocity = (closeVelocity - closeRate * impulse) * decay;
        if (closeMix < 0 || closeMix > 1 || Math.abs(closeMix - target) < CLOSE_SNAP && Math.abs(closeVelocity) < CLOSE_SNAP * closeRate) {
          closeMix = closeMix < 0 ? 0 : closeMix > 1 ? 1 : target;
          closeVelocity = 0;
        }
      } else closeMix = closeVelocity = 0;
      // Direct drags and held keys ease fast rather than land as sent, so uneven input per frame cannot judder.
      orbit.yaw = damp(orbit.yaw, orbit.tYaw, directTrailingView ? DIRECT_VIEW_RATE : 14, dt);
      if (carryExitMode && cave && !closeWanted) {
        zoomPitchVelocity = 0;
      } else if (zoomTilt && cave && !closeWanted && !directTrailingView) {
        const delta = orbit.pitch - orbit.tPitch, decay = Math.exp(-14 * dt), impulse = (zoomPitchVelocity + 14 * delta) * dt;
        orbit.pitch = orbit.tPitch + (delta + impulse) * decay;
        zoomPitchVelocity = (zoomPitchVelocity - 14 * impulse) * decay;
      } else {
        orbit.pitch = damp(orbit.pitch, orbit.tPitch, directTrailingView ? DIRECT_VIEW_RATE : 14, dt);
        zoomPitchVelocity = 0;
      }
      if (cave && close && !sleeping && !rolling) crew.look(orbit.yaw + Math.PI, orbit.pitch, closeMix);
      if (cave && close && !sleeping && !rolling) {
        const p = cave.root.position;
        const ground = p.y - cave.baseY - cave.hop;
        const zone = close.zone ? close.zone() : 0;
        const moved = Math.hypot(p.x - groundX, p.z - groundZ);
        const airborne = cave.hop > 0.001 || Math.abs(cave.hopV) > 0.001 || !!cave.jet && cave.jet.thrust;
        groundReset = !groundValid || airborne || zone !== groundZone || moved > CLOSE_TELEPORT || Math.abs(ground - groundTarget) > close.maxStep + 1e-6;
        if (groundReset) groundView = ground;
        else {
          const visualGround = close.visualGroundAt ? close.visualGroundAt(p.x, p.z, ground) : ground;
          // The terrain sample removes the voxel-sized stair jump spatially.
          // Bound its remaining correction by horizontal travel so an uneven
          // footprint cannot transfer a one-frame kick into the body and
          // follow camera. Unlike time damping this keeps pace on a long
          // staircase instead of accumulating height lag. First person stays
          // fixed to the physical eye for precise aiming.
          const groundStep = moved > 1e-6 ? moved * 1.05 : CLOSE_GROUND_RATE * dt * 0.08;
          groundView = closeMix > 0.5 ? visualGround : clamp(visualGround, groundView - groundStep, groundView + groundStep);
        }
        groundLift = clamp(groundView - ground, -cave.baseY * 0.5, cave.baseY * 0.75);
        groundTarget = ground;
        groundX = p.x;
        groundZ = p.z;
        groundZone = zone;
        groundValid = true;
        groundEasing = !airborne;
        crew.elevate(groundLift);
        groundLift = cave.viewLift;
        groundView = ground + groundLift;
        followTarget.y = p.y - cave.baseY + (headOrbit ? cave.headOffset * close.eyeRatio + headOrbitOffset.y : follow.y) + cave.viewLift;
      } else {
        if (cave && close && !sleeping && !rolling) crew.elevate(0);
        groundLift = 0;
        groundEasing = false;
        groundValid = false;
      }
      {
        // Wheel events change the destination, never the current distance velocity; exact critically damped step.
        const delta = orbit.dist - orbit.tDist, decay = Math.exp(-CLOSE_RATE * dt);
        const impulse = (distanceVelocity + CLOSE_RATE * delta) * dt;
        orbit.dist = orbit.tDist + (delta + impulse) * decay;
        distanceVelocity = (distanceVelocity - CLOSE_RATE * impulse) * decay;
      }
      orbit.tx = damp(orbit.tx, orbit.target.x, 5, dt);
      orbit.ty = damp(orbit.ty, orbit.target.y, 5, dt);
      orbit.tz = damp(orbit.tz, orbit.target.z, 5, dt);
      if (carryExitMode && cave && !closeWanted) {
        // Below a ceiling, extend the boom at the displayed eye's height.
        // Outdoors, ease height separately so a down-aim cannot first dip
        // while its steep viewing angle returns to the chosen carry angle.
        if (carryExitMode === 2) {
          const target = Math.max(carryExitBase, Math.sin(orbit.tPitch) * orbit.tDist);
          const delta = carryExitHeight - target, decay = Math.exp(-CLOSE_RATE * dt);
          const impulse = (carryExitVelocity + CLOSE_RATE * delta) * dt;
          carryExitHeight = target + (delta + impulse) * decay;
          carryExitVelocity = (carryExitVelocity - CLOSE_RATE * impulse) * decay;
        }
        orbit.pitch = Math.asin(clamp(carryExitHeight / orbit.dist, -1, 1));
      }
      const { width, height } = renderer.size;
      const aspect = width / Math.max(1, height);
      camera.fov = clamp(2 * Math.atan(Math.tan(MIN_HFOV / 2) / aspect), BASE_FOV, MAX_FOV);
      const portrait = clamp(1 - aspect, 0, 0.6);
      let flatten = 0;
      if (cave && close && !trailingPitchChosen && !headOrbit) {
        const span = close.trailingDist - DIST_MIN;
        flatten = span > 0 ? clamp((close.trailingDist - orbit.dist) / span, 0, 1) : 1;
        flatten = flatten * flatten * (3 - 2 * flatten);
      }
      viewPitch = orbit.pitch * (1 - flatten);
      const cp = Math.cos(viewPitch), sp = Math.sin(viewPitch);
      let targetX = orbit.tx, targetY = orbit.ty - portrait * 0.6, targetZ = orbit.tz;
      const orbitX = orbit.tx + Math.sin(orbit.yaw) * cp * orbit.dist;
      const orbitY = orbit.ty + sp * orbit.dist;
      const orbitZ = orbit.tz + Math.cos(orbit.yaw) * cp * orbit.dist;
      let eyeX = freeTarget.x, eyeZ = freeTarget.z, eyeY = freeTarget.y, eyeClearance = close ? close.eyeHeight : 0;
      let freeLedge = false, previousFloor = freeFloorY;
      if ((cave || headOrbit) && closeCameraActive) {
        if (lying && !headOrbit) {
          applyLyingView(cave);
        } else {
          const cp = Math.cos(orbit.pitch);
          viewRotation(headRotation, -Math.sin(orbit.yaw) * cp, -Math.sin(orbit.pitch), -Math.cos(orbit.yaw) * cp, 0, 1, 0, orbit.yaw);
          quat.multiply(headRotation, headRotation, entryRoll);
        }
      }
      if (closeMix > 0) {
        if (headOrbit && !closeWanted) {
          eyeX = orbit.tx; eyeY = orbit.ty; eyeZ = orbit.tz;
        } else if (lying) {
          eyeX = headEye[0]; eyeY = headEye[1]; eyeZ = headEye[2];
          eyeClearance = Math.max(0.1, eyeY - close.groundAt(eyeX, eyeZ, eyeY - 0.1));
        } else if (cave) {
          const heading = cave.root.rotation.y, forward = close.eyeForward;
          eyeX = cave.root.position.x + Math.sin(heading) * forward;
          eyeY = cave.root.position.y - cave.baseY + cave.headOffset * close.eyeRatio + cave.viewLift;
          eyeZ = cave.root.position.z + Math.cos(heading) * forward;
          eyeClearance = eyeY - close.groundAt(eyeX, eyeZ, cave.root.position.y - cave.baseY - cave.hop);
        } else if (closeWanted && !freeEntry) {
          if (!freeFallValid) {
            freeFeetY = freeFloorY = close.groundAt(eyeX, eyeZ, camera.position.y - close.eyeHeight);
            freeFallValid = true;
          }
          previousFloor = freeFloorY;
          if (freeCloud && !freeFalling && !freeCloud.wrapped && freeCloud.node.visible && freeCloud.node.parent) {
            eyeX += freeCloud.dx; eyeZ += freeCloud.dz;
            freeTarget.x += freeCloud.dx; freeTarget.z += freeCloud.dz;
          }
          const previousFeet = freeFeetY;
          if (freeFalling) {
            freeFallV -= WALK.gravity * dt;
            freeFeetY += freeFallV * dt;
          }
          const ground = close.groundAt(eyeX, eyeZ, freeFeetY, Math.max(previousFeet, freeFeetY));
          if (!freeFalling && freeFloorY - ground > WALK.step) {
            freeFalling = freeLedge = true;
            freeFallV = freeCloud ? 0 : WALK.ledgeRise;
            freeLeapX = freeCloud ? 0 : -Math.sin(orbit.yaw) * WALK.ledgeSpeed;
            freeLeapZ = freeCloud ? 0 : -Math.cos(orbit.yaw) * WALK.ledgeSpeed;
          }
          if (!freeFalling) freeFeetY = ground;
          else freeFeetY = Math.max(ground, freeFeetY);
          freeFloorY = ground;
          eyeY = freeFeetY + close.eyeHeight;
        } else if (!freeEntry) eyeY = close.groundAt(eyeX, eyeZ, camera.position.y - close.eyeHeight) + close.eyeHeight;
      }
      camera.position.x = orbitX + (eyeX - orbitX) * closeMix;
      camera.position.y = orbitY + (eyeY - orbitY) * closeMix;
      camera.position.z = orbitZ + (eyeZ - orbitZ) * closeMix;
      if (entryRebase) {
        // A reversed dolly or a new possession may use another orbit pivot; its zero-time endpoint is the displayed eye.
        entryRebase = false;
        entryOffsetActive = true;
      }
      if (entryOffsetActive) {
        camera.position.x += (entryPosition.x - orbitX) * (1 - closeMix);
        camera.position.y += (entryPosition.y - orbitY) * (1 - closeMix);
        camera.position.z += (entryPosition.z - orbitZ) * (1 - closeMix);
        if (closeMix === 1) entryOffsetActive = false;
      }
      if (dollyTime < DOLLY_HANDOFF) {
        dollyTime = Math.min(DOLLY_HANDOFF, dollyTime + dt);
        const u = dollyTime / DOLLY_HANDOFF, remaining = 1 - u;
        // Finite handoff starts at the previous rendered velocity with zero acceleration and ends at zero for all three.
        // Lets the new dolly brake before reversing direction.
        const carry = dollyTime * remaining * remaining * remaining * (1 + 3 * u);
        camera.position.x += dollyVelocity.x * carry;
        camera.position.y += dollyVelocity.y * carry;
        camera.position.z += dollyVelocity.z * carry;
      }
      const desiredX = camera.position.x, desiredY = camera.position.y, desiredZ = camera.position.z;
      const collided = lying && closeWanted && closeMix === 1 ? false
        : clampCamera(camera.position, closeMix, eyeClearance, groundEasing, dt, groundReset, directCameraPosition, !cave && orbit.target === freeTarget, freeEntry || headOrbit && !closeWanted && (exitAngleHold || closeMix > 0));
      if (freeEntry && closeMix === 1) {
        freeEntry = false;
        setFreeEye();
        orbit.tx = freeTarget.x; orbit.ty = freeTarget.y; orbit.tz = freeTarget.z;
      }
      if (!cave && closeWanted && closeMix === 1 && freeFallValid) {
        const feet = camera.position.y - close.eyeHeight;
        const ground = close.groundAt(camera.position.x, camera.position.z, feet);
        // Collision can reject a ledge crossing: only accepted movement falls; landing clears velocity and drift.
        if (freeLedge && previousFloor - ground <= WALK.step || freeFalling && freeFallV <= 0 && feet <= ground + 1e-6) {
          freeFalling = false;
          freeFallV = freeLeapX = freeLeapZ = 0;
        } else if (freeFalling && freeFallV > 0 && feet < freeFeetY - 1e-6) freeFallV = 0;
        freeFeetY = feet;
        freeFloorY = ground;
        freeCloud = !freeFalling && close.cloudAt ? close.cloudAt(camera.position.x, camera.position.z, feet) : null;
        freeTarget.y = camera.position.y;
      }
      if (collided && !cave && orbit.target === freeTarget) {
        // A blocked eye consumes its movement: keep the orbit offset, drop hidden target travel so reversing responds.
        const orbitMix = 1 - closeMix;
        if (Math.abs(camera.position.x - desiredX) > 1e-7) freeTarget.x = orbit.tx = camera.position.x - (orbitX - targetX) * orbitMix;
        if (Math.abs(camera.position.y - desiredY) > 1e-7) freeTarget.y = orbit.ty = camera.position.y - (orbitY - orbit.ty) * orbitMix;
        if (Math.abs(camera.position.z - desiredZ) > 1e-7) freeTarget.z = orbit.tz = camera.position.z - (orbitZ - targetZ) * orbitMix;
        targetX = orbit.tx;
        targetY = orbit.ty - portrait * 0.6;
        targetZ = orbit.tz;
      }
      const lookCp = Math.cos(orbit.pitch), lookSp = Math.sin(orbit.pitch);
      let lookX = camera.position.x - Math.sin(orbit.yaw) * lookCp * CLOSE_LOOK_DIST;
      let lookY = camera.position.y - lookSp * CLOSE_LOOK_DIST;
      let lookZ = camera.position.z - Math.cos(orbit.yaw) * lookCp * CLOSE_LOOK_DIST;
      if ((cave || headOrbit) && closeCameraActive) {
        viewRotation(orbitRotation, targetX - camera.position.x, targetY - camera.position.y, targetZ - camera.position.z, 0, 1, 0, orbit.yaw);
        // Follow the previously rendered rotation: a fresh shortest arc between two moving endpoints can reverse at 180.
        if (headOrbit || closeMix === 1) quat.copy(cameraRotation, headRotation);
        else if (carryExitMode && !closeWanted && closeMix === 0) {
          // Finish recentering promptly, independently of the zoom spring
          // or later wheel events. Keep following the body's moving anchor.
          const remaining = Math.max(0, carryFocusRemaining - dt);
          const blend = carryFocusRemaining > 0 ? 1 - (remaining / carryFocusRemaining) ** 2 : 1;
          quat.slerpTo(cameraRotation, orbitRotation, blend);
          carryFocusRemaining = remaining;
          if (!remaining) closeCameraActive = false;
        } else quat.slerpTo(cameraRotation, closeWanted ? headRotation : orbitRotation, 1 - Math.exp(-CLOSE_RATE * dt));
        if (!headOrbit && !closeWanted && closeMix === 0) {
          // The close-view boom can end on a different side of the head than the unrestricted orbit.
          // Settle its orientation too; do not discard a still-rolled camera at the position snap.
          const sign = cameraRotation[0] * orbitRotation[0] + cameraRotation[1] * orbitRotation[1] + cameraRotation[2] * orbitRotation[2] + cameraRotation[3] * orbitRotation[3] < 0 ? -1 : 1;
          const error = Math.hypot(cameraRotation[0] - sign * orbitRotation[0], cameraRotation[1] - sign * orbitRotation[1], cameraRotation[2] - sign * orbitRotation[2], cameraRotation[3] - sign * orbitRotation[3]);
          if (error < 1e-4) closeCameraActive = false;
        }
      }
      camera.target.x = targetX + (lookX - targetX) * closeMix;
      camera.target.y = targetY + (lookY - targetY) * closeMix;
      camera.target.z = targetZ + (lookZ - targetZ) * closeMix;
      if (releaseMix > 0) {
        releaseMix = damp(releaseMix, 0, CLOSE_RATE, dt);
        if (releaseMix < CLOSE_SNAP) releaseMix = 0;
        viewRotation(orbitRotation, camera.target.x - camera.position.x, camera.target.y - camera.position.y, camera.target.z - camera.position.z, 0, 1, 0, orbit.yaw);
        quat.copy(cameraRotation, releaseRotation);
        quat.slerpTo(cameraRotation, orbitRotation, 1 - releaseMix);
      }
      if ((cave || headOrbit) && closeCameraActive || releaseMix > 0) {
        quat.rotateVec(sleepForward, cameraRotation, 0, 0, -1);
        quat.rotateVec(sleepUp, cameraRotation, 0, 1, 0);
        camera.target.x = camera.position.x + sleepForward[0] * CLOSE_LOOK_DIST;
        camera.target.y = camera.position.y + sleepForward[1] * CLOSE_LOOK_DIST;
        camera.target.z = camera.position.z + sleepForward[2] * CLOSE_LOOK_DIST;
        sleepCameraUp.x = sleepUp[0]; sleepCameraUp.y = sleepUp[1]; sleepCameraUp.z = sleepUp[2];
        camera.up = sleepCameraUp;
      }
      syncHeadVisibility(cave);
      if (cave && close) headAnchor(cave, motionAnchor);
      else {
        const anchor = cave ? cave.root.position : freeTarget;
        motionAnchor.x = anchor.x; motionAnchor.y = anchor.y; motionAnchor.z = anchor.z;
      }
      if (dt > 0 && eyeMotionValid) {
        eyeVelocity.x = (camera.position.x - previousEye.x) / dt;
        eyeVelocity.y = (camera.position.y - previousEye.y) / dt;
        eyeVelocity.z = (camera.position.z - previousEye.z) / dt;
        anchorVelocity.x = (motionAnchor.x - previousAnchor.x) / dt;
        anchorVelocity.y = (motionAnchor.y - previousAnchor.y) / dt;
        anchorVelocity.z = (motionAnchor.z - previousAnchor.z) / dt;
      } else if (!eyeMotionValid) {
        eyeVelocity.x = eyeVelocity.y = eyeVelocity.z = 0;
        anchorVelocity.x = anchorVelocity.y = anchorVelocity.z = 0;
      }
      previousEye.x = camera.position.x; previousEye.y = camera.position.y; previousEye.z = camera.position.z;
      previousAnchor.x = motionAnchor.x; previousAnchor.y = motionAnchor.y; previousAnchor.z = motionAnchor.z;
      eyeMotionValid = true;
    };
    // A connected doorway changes the world frame, not the control mode or
    // camera blend. Keep its cached anchors and orientations in that frame too.
    const portalPoints = [camera.position, camera.target, freeTarget, followTarget, entryPosition, previousEye,
      previousAnchor, motionAnchor, overheadAim, aimEntryBody, aimEntry, aimPoint, cursorItem, cursorPoint, targetOrigin, buttonTarget];
    const portalVectors = [headOrbitOffset, overheadEntry, eyeVelocity, dollyVelocity, anchorVelocity, sleepCameraUp, cursorUp];
    const portalRotations = [orbitRotation, headRotation, cameraRotation, releaseRotation, overheadRotation,
      overheadStartRotation, overheadViewRotation, carryStartRotation, aimEntryRotation, aimLookRotation, aimPanRotation];
    const portalRotation = quat.create();
    const transformView = (m, yaw) => {
      for (const p of portalPoints) {
        const x = p.x, y = p.y, z = p.z;
        p.x = m[0] * x + m[4] * y + m[8] * z + m[12];
        p.y = m[1] * x + m[5] * y + m[9] * z + m[13];
        p.z = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      for (const v of portalVectors) {
        const x = v.x, z = v.z;
        v.x = m[0] * x + m[8] * z; v.z = m[2] * x + m[10] * z;
      }
      if (camera.up && camera.up !== sleepCameraUp && camera.up !== cursorUp) {
        const x = camera.up.x, z = camera.up.z;
        camera.up.x = m[0] * x + m[8] * z; camera.up.z = m[2] * x + m[10] * z;
      }
      const x = orbit.tx, z = orbit.tz, ex = exitBodyX, ez = exitBodyZ, gx = groundX, gz = groundZ;
      orbit.tx = m[0] * x + m[8] * z + m[12]; orbit.ty += m[13]; orbit.tz = m[2] * x + m[10] * z + m[14];
      exitBodyX = m[0] * ex + m[8] * ez + m[12]; exitBodyY += m[13]; exitBodyZ = m[2] * ex + m[10] * ez + m[14];
      groundX = m[0] * gx + m[8] * gz + m[12]; groundZ = m[2] * gx + m[10] * gz + m[14];
      groundView += m[13]; groundTarget += m[13]; groundValid = false;
      orbit.yaw += yaw; orbit.tYaw += yaw; freeMoveYaw += yaw; lyingYaw += yaw;
      overheadYaw += yaw; overheadTargetYaw += yaw; overheadEntryYaw += yaw; overheadNorthStartYaw += yaw; aimEntryYaw += yaw; aimBodyYaw += yaw;
      aimWeaponYaw += yaw; overheadWeaponYaw += yaw;
      quat.fromEuler(portalRotation, 0, yaw, 0);
      for (const q of portalRotations) quat.multiply(q, portalRotation, q);
      restoredPose = null;
      clearFeedback();
      assistedTargetActive = false; assistedTargetWait = 0;
    };
    // The scene supplies a safe arrival and resets its collision history first.
    // navigate changes location only, never the visitor's mode or chosen Ooga.
    const navigate = (destination) => {
      restoredPose = null;
      centeredCarry = false;
      carryExitMode = carryFocusRemaining = 0;
      eyeMotionValid = false;
      dollyTime = DOLLY_HANDOFF;
      distanceVelocity = 0;
      sleepingView = false;
      headOrbit = exitAngleHold = false;
      entryRebase = entryOffsetActive = false;
      closeCameraActive = false;
      releaseMix = 0;
      quat.fromEuler(entryRoll, 0, 0, 0);
      trailingPitchChosen = false;
      zoomTilt = false;
      zoomPitchVelocity = 0;
      camera.up = null;
      const cave = player(), position = destination.position;
      resetGroundView();
      freeStrafe = freeForward = freeClimb = 0;
      overheadToShoulder = false;
      if (birdsEye()) { overheadTime = OVERHEAD_TIME; overheadMix = 1; }
      trailingViewInput = trailingZoomInput = false;
      closeMix = closeWanted ? 1 : 0;
      closeVelocity = 0;
      closeExitScale = 1;
      closeCave = closeWanted ? cave : null;
      orbit.yaw = orbit.tYaw = freeMoveYaw = destination.yaw;
      orbit.pitch = orbit.tPitch = destination.pitch;
      orbit.dist = orbit.tDist = destination.dist;
      if (cave) {
        crew.relocatePlayer(position, destination.yaw + Math.PI);
        followTarget.x = position.x;
        followTarget.y = position.y + follow.y;
        followTarget.z = position.z;
        orbit.target = followTarget;
      } else {
        const target = closeWanted ? position : destination.target;
        freeTarget.x = target.x;
        freeTarget.y = target.y + (closeWanted ? close.eyeHeight : 0);
        freeTarget.z = target.z;
        orbit.target = freeTarget;
        if (closeWanted) {
          // Support selection must start on the destination's elevation layer.
          camera.position.x = freeTarget.x;
          camera.position.y = freeTarget.y;
          camera.position.z = freeTarget.z;
        }
      }
      orbit.tx = orbit.target.x;
      orbit.ty = orbit.target.y;
      orbit.tz = orbit.target.z;
      if (aimView()) {
        // Navigation is a new physical arrival, not a dolly from the old
        // scene position or from where a fresh camera was left before a
        // possess. Start directly at its selected shoulder or first-person eye.
        aimMix = 1; aimVelocity = 0;
        aimAtCursor = aimPreserveFacing = false;
      }
      update(0);
    };
    // Debug replay holds the recorded view until a navigation gesture. This
    // preserves an interrupted camera dolly as well as an ordinary settled view.
    const copyVector = (out, value) => { out[0] = value.x; out[1] = value.y; out[2] = value.z; };
    const readVector = (out, value) => { out.x = value[0]; out.y = value[1]; out.z = value[2]; };
    const capturePose = (out) => {
      const cave = player();
      copyVector(out.position, camera.position); copyVector(out.target, camera.target);
      const up = camera.up || cursorUp;
      copyVector(out.up, up); out.fov = camera.fov;
      out.orthoMix = camera.orthoMix || 0; out.orthoHeight = camera.orthoHeight || 0;
      out.mode = viewMode();
      out.closeWanted = closeWanted;
      out.combat = armed();
      out.birdsEyeNorthUp = overheadNorthUp;
      out.character = cave ? cave.traits.name : "";
      out.orbit[0] = orbit.yaw; out.orbit[1] = orbit.pitch; out.orbit[2] = orbit.dist;
      out.orbit[3] = orbit.tx; out.orbit[4] = orbit.ty; out.orbit[5] = orbit.tz;
      if (birdsEye()) { out.orbit[0] = overheadYaw; out.orbit[1] = Math.PI / 2; out.orbit[2] = overheadHeight; }
      out.shoulderSide = shoulderSide; out.closeMix = closeMix; out.ads = adsMix;
      out.headOrbit = headOrbit; copyVector(out.headOffset, headOrbitOffset);
      if (cave) {
        copyVector(out.actor, cave.root.position); copyVector(out.body, cave.root.rotation); copyVector(out.head, cave.parts.head.rotation);
        out.bodyRolled = !!cave.root.quaternion; out.headRolled = !!cave.parts.head.quaternion;
        for (let i = 0; i < 4; i++) {
          out.bodyQuaternion[i] = cave.root.quaternion ? cave.root.quaternion[i] : i === 3 ? 1 : 0;
          out.headQuaternion[i] = cave.parts.head.quaternion ? cave.parts.head.quaternion[i] : i === 3 ? 1 : 0;
        }
        out.selectedSlot = cave.weapon.equipped ? 2 : cave.weapon.primaryEquipped ? 1 : cave.weapon.selectedSlot;
        out.ammo = cave.weapon.ammo; out.unlimited = !!cave.weapon.unlimited;
        out.magazines[0] = crew.magazineAmmo(cave, 0); out.magazines[1] = crew.magazineAmmo(cave, 1); out.magazineCount = crew.magazineCount(cave);
        out.aimYaw = cave.weapon.aimYaw; out.aimPitch = cave.weapon.aimPitch;
        out.jetpack = !!cave.jet; out.fuel = cave.jetFuel;
        out.hop = cave.hop; out.hopV = cave.hopV; out.lift = cave.viewLift;
      } else {
        out.actor.fill(0); out.body.fill(0); out.head.fill(0); out.magazines.fill(0);
        out.bodyQuaternion.fill(0); out.bodyQuaternion[3] = 1;
        out.headQuaternion.fill(0); out.headQuaternion[3] = 1;
        out.bodyRolled = out.headRolled = out.unlimited = out.jetpack = false;
        out.selectedSlot = 1; out.ammo = out.magazineCount = out.aimYaw = out.aimPitch = out.hop = out.hopV = out.lift = 0;
        out.fuel = 1;
      }
      return out;
    };
    const applyPose = (pose) => {
      const cave = player();
      if (cave) {
        readVector(cave.root.position, pose.actor); readVector(cave.root.rotation, pose.body); readVector(cave.parts.head.rotation, pose.head);
        cave.root.quaternion = pose.bodyRolled ? pose.bodyQuaternion : null;
        cave.parts.head.quaternion = pose.headRolled ? pose.headQuaternion : null;
        cave.hop = pose.hop; cave.hopV = pose.hopV;
        crew.elevate(pose.lift);
        crew.poseWeapon(cave);
      }
      readVector(camera.position, pose.position); readVector(camera.target, pose.target);
      readVector(sleepCameraUp, pose.up); camera.up = sleepCameraUp; camera.fov = pose.fov;
      camera.orthoMix = pose.orthoMix ?? (pose.mode === "birds-eye" && pose.combat ? 1 : 0);
      camera.orthoHeight = pose.orthoHeight ?? 2 * Math.tan(camera.fov / 2) * pose.orbit[2];
    };
    const restorePose = (pose, exactCamera = true) => {
      const cave = player();
      restoredPose = null;
      centeredCarry = false;
      // Read old replay links only at this boundary; all current state and
      // newly copied links use combat and the birds-eye view identifier.
      if (pose.combat === undefined && typeof pose.battle === "boolean") pose.combat = pose.battle;
      delete pose.battle;
      const oldOverhead = pose.mode === "orbit" && pose.combat;
      closeWanted = typeof pose.closeWanted === "boolean" ? pose.closeWanted
        : pose.mode === "first-person" || pose.mode === "eye-level" || pose.mode === "detached" && pose.closeMix >= 0.5;
      shoulderView = !!cave && pose.mode === "shoulder";
      // Older cursor-target entries saved a collapsed shoulder eye, sometimes
      // with an offset effectively zero. Repair it before holding the replay;
      // waiting for input leaves the first frame centred behind the head.
      const repairShoulder = shoulderView && !closeWanted && pose.closeMix === 0 && Math.abs(pose.shoulderSide) < SHOULDER_SIDE - 1e-4;
      if (repairShoulder) exactCamera = false;
      if (cave) {
        cave.weapon.aiming = pose.combat === undefined ? pose.mode === "shoulder" || closeWanted && !crew.sleeping : !!pose.combat;
        crew.steer(0, 0, 0, 0, 0);
      }
      applyPose(pose);
      syncAim();
      orbit.yaw = orbit.tYaw = pose.orbit[0]; orbit.pitch = orbit.tPitch = pose.orbit[1]; orbit.dist = orbit.tDist = pose.orbit[2];
      orbit.tx = pose.orbit[3]; orbit.ty = pose.orbit[4]; orbit.tz = pose.orbit[5];
      const target = cave ? followTarget : freeTarget;
      target.x = orbit.tx; target.y = orbit.ty; target.z = orbit.tz; orbit.target = target;
      headOrbit = pose.headOrbit; readVector(headOrbitOffset, pose.headOffset);
      closeMix = pose.closeMix; closeVelocity = distanceVelocity = aimVelocity = 0; aimMix = 1;
      closeCave = cave; shoulderSide = pose.shoulderSide;
      // Exact replay holds its captured eye; once resumed, old links with a
      // collapsed shoulder offset ease back to the selected shoulder.
      shoulderSideTarget = pose.shoulderSide < 0 ? -SHOULDER_SIDE : SHOULDER_SIDE;
      if (repairShoulder) shoulderSide = shoulderSideTarget;
      ads = pose.ads > 0.5; adsMix = pose.ads;
      carryExitMode = carryFocusRemaining = 0; eyeMotionValid = false;
      trailingPitchChosen = true; zoomTilt = false;
      aimAtCursor = aimPreserveFacing = false;
      if (cave) {
        aimBodyYaw = pose.body[1]; aimBodyPitch = pose.head[0]; aimBodyHeadYaw = pose.head[1];
        cave.weapon.aimYaw = pose.aimYaw; cave.weapon.aimPitch = pose.aimPitch;
      }
      if (birdsEye()) {
        overheadHeight = overheadWanted = oldOverhead ? overheadDefault : pose.orbit[2];
        overheadVelocity = 0;
        overheadToShoulder = false;
        overheadNorthUp = !!pose.birdsEyeNorthUp;
        overheadYaw = pose.orbit[0];
        overheadNorthStartYaw = overheadYaw; overheadNorthTime = 0;
        overheadTargetYaw = overheadNorthUp
          ? overheadYaw + Math.atan2(Math.sin(-overheadYaw), Math.cos(-overheadYaw))
          : overheadYaw;
        overheadFov = camera.fov;
        viewRotation(overheadRotation, 0, -1, 0, -Math.sin(overheadYaw), 0, -Math.cos(overheadYaw), overheadYaw);
        overheadTime = OVERHEAD_TIME; overheadMix = 1;
        overheadAim.x = pose.actor[0] + Math.sin(pose.body[1] + pose.aimYaw) * 8;
        overheadAim.y = pose.actor[1] - cave.baseY;
        overheadAim.z = pose.actor[2] + Math.cos(pose.body[1] + pose.aimYaw) * 8;
        if (oldOverhead) exactCamera = false;
      } else if (cave && pose.mode === "orbit" && pose.headOrbit &&
        Math.hypot(orbit.tx - pose.actor[0], orbit.ty - pose.actor[1], orbit.tz - pose.actor[2]) < 1e-5) {
        // Root-centred carry uses the existing replay anchor/offset fields.
        beginCenteredCarry(cave);
      }
      if (!exactCamera) { update(0); capturePose(pose); }
      restoredPose = pose;
      update(0);
    };
    const resumePose = () => {
      if (!restoredPose) return;
      restoredPose = null;
      const cave = player();
      if (cave && !crew.sleeping) { cave.root.quaternion = null; cave.parts.head.quaternion = null; }
      if (birdsEye()) {
        const height = overheadWanted;
        beginOverhead(cave, true, true);
        overheadWanted = height;
        overheadPointerMoved = false;
      } else if (centeredCarry) beginCenteredCarry(cave);
      else if (armed()) {
        captureAimEntry(player());
        aimMix = aimVelocity = 0;
      }
      resetGroundView();
    };
    const setActive = (value) => {
      if (active === value) return;
      active = value;
      controls.reset();
      unlockAim();
      carryCursor.endAim();
      if (crew && player()) {
        crew.stopBurst(player()); crew.stopReload(player(), true); crew.releaseSwing(player(), true);
        crew.steer(0, 0, 0, 0, 0);
      }
      reticle.hidden = !value || !armed();
    };
    const dispose = () => {
      unsubscribeOwnOoga();
      ownAccount = ownCrew = ownOoga = null;
      if (hud.setOwnOoga) hud.setOwnOoga(null);
      rememberControlMode();
      restoredPose = null;
      disposed = true;
      unlockAim();
      carryCursor.dispose();
      clearFeedback();
      resetAssist();
      reticle.hidden = true;
      camera.near = savedNear;
      camera.orthoMix = camera.orthoHeight = 0;
      window.removeEventListener("mousemove", aimMouseMove);
      window.removeEventListener("pointerup", aimMouseUp);
      window.removeEventListener("keydown", aimKey, true);
      window.removeEventListener("blur", unlockAim);
      if (!lockPending) retireAimLock();
      canvas.removeEventListener("pointerdown", aimPointer, true);
      canvas.removeEventListener("pointermove", aimPointer, true);
      canvas.removeEventListener("pointerup", aimPointer, true);
      canvas.removeEventListener("pointercancel", aimPointer, true);
      resetGroundView();
      restoreHead();
      hud.el.act.hidden = true;
      hud.setAct(ACT_DO);
      hud.setPrimary(false, false, null, 0, false, 1, false);
      hud.setWeapon(false, false, 0);
      hud.setMagazine(0, 0, 0, false);
      if (hud.setMode) hud.setMode(null, false, "detached", false);
      controls.dispose();
      crew = fx = input = null;
    };
    return { orbit, hooks, controls, cursor: carryCursor, capturePose, restorePose, focusAim, setExternalControl, get poseHeld() { return !!restoredPose; }, get aiming() { return armed(); },
      // Scenery follows the displayed blend, not the entry's local clock:
      // carry/shoulder exits and mid-transition reversals retain this value.
      get birdsEye() { return birdsEye(); }, get birdsEyeMix() { return camera.orthoMix || 0; }, get birdsEyeHeight() { return overheadHeight; }, get birdsEyeNorthUp() { return overheadNorthUp; },
      get birdsEyeCeiling() { return overheadCeiling; },
      get shoulderEntryMix() { return aimMix; },
      bind, setActive, readInput, update, goPreset, navigate, transformView, enterClose, exitClose, possess, release, action, modeAction, weaponAction, weaponMode, showAct, dispose, get player() {
      return player();
    }, get assistedTarget() {
      if (birdsEye() && assistedTargetActive) return assistedTargetHit;
      return aimView() && (cursorAim || aimAtCursor) ? cursorPoint : null;
    }, get assistedTargetDistance() {
      return birdsEye() && assistedTargetActive ? assistedTargetDistance : Infinity;
    }, get moving() {
      // A press can arrive between frames, before readInput updates crew steer.
      const cave = player(), a = controls.read();
      return !!cave && !cave.grabbedBy && (Math.hypot(a.x, a.y) > 0.05 || cave.hop > 0 || cave.hopV > 0);
    }, get mode() {
      return viewMode();
    }, get closeMix() {
      return closeMix;
    }, get closeWanted() {
      return closeWanted;
    }, get preserveExitAngle() {
      return headOrbit && !closeWanted && (exitAngleHold || closeMix > 0);
    }, get freeFalling() {
      return freeFalling;
    }, get groundLift() {
      return groundLift;
    }, get groundView() {
      return groundView;
    }, get groundTarget() {
      return groundTarget;
    }, get viewPitch() {
      return viewPitch;
    } };
  };
  BL.pilot = { create, WALK };
})();

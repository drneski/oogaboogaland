(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { mat4 } = BL.math;
  const createNode = (options = {}) => ({
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    poseYaw: 0,
    poseLean: 0,
    poseLeanY: 0,
    scale: { x: 1, y: 1, z: 1 },
    geometry: null,
    glow: 1,
    highlight: 0,
    scorch: 0,
    ember: 0,
    visible: true,
    cameraHidden: false,
    parent: null,
    children: [],
    // World cull sphere, written once per frame by the renderer's collect pass.
    cullX: 0,
    cullY: 0,
    cullZ: 0,
    cullR: 0,
    world: mat4.create(),
    local: mat4.create(),
    ...options
  });
  const addChild = (parent, ...children) => {
    for (const child of children) {
      child.parent = parent;
      parent.children.push(child);
    }
    return parent;
  };
  const removeChild = (parent, child) => {
    const i = parent.children.indexOf(child);
    if (i >= 0) {
      parent.children.splice(i, 1);
      child.parent = null;
    }
  };
  const updateLocal = (node) => {
    // A node carrying a quaternion turns by it instead of its Euler rotation
    if (node.quaternion) mat4.fromTQS(node.local, node.position, node.quaternion, node.scale);
    else mat4.fromTRS(node.local, node.position, node.rotation, node.scale);
    // A body pose turns both the part and its pivot in the parent's frame.
    // It must not change the authored gait or the character's facing direction.
    if (node.poseYaw) {
      const m = node.local, c = Math.cos(node.poseYaw), s = Math.sin(node.poseYaw);
      for (let i = 0; i < 16; i += 4) {
        const x = m[i], z = m[i + 2];
        m[i] = c * x + s * z; m[i + 2] = c * z - s * x;
      }
    }
    // A planted peek rolls upper-body parts around one shared hip height.
    // Each part remains a root child, so the same transform makes the torso,
    // head, arms and equipment move as one without disturbing either foot.
    if (node.poseLean) {
      const m = node.local, c = Math.cos(node.poseLean), s = Math.sin(node.poseLean), pivot = node.poseLeanY;
      for (let i = 0; i < 16; i += 4) {
        const x = m[i], y = m[i + 1] - (i === 12 ? pivot : 0);
        m[i] = c * x - s * y;
        m[i + 1] = s * x + c * y + (i === 12 ? pivot : 0);
      }
    }
  };
  const updateWorld = (node, parentWorld) => {
    if (!node.visible) return;
    updateLocal(node);
    if (parentWorld) mat4.multiply(node.world, parentWorld, node.local);
    else node.world.set(node.local);
    for (const child of node.children) updateWorld(child, node.world);
  };
  const traverseVisible = (node, fn) => {
    if (!node.visible) return;
    fn(node);
    for (const child of node.children) traverseVisible(child, fn);
  };
  const createCamera = ({ fov = 50, near = 0.2, far = 60, orthoMix = 0, orthoHeight = 0 } = {}) => ({
    fov: fov * Math.PI / 180,
    near,
    far,
    orthoMix,
    orthoHeight,
    position: { x: 0, y: 3, z: 8 },
    target: { x: 0, y: 1, z: 0 }
  });
  const cameraProjection = (out, camera, aspect, near = camera.near) => mat4.perspective(out, camera.fov, aspect, near, camera.far, camera.orthoMix || 0, camera.orthoHeight || 0);
  // Ancestor-inherited node attributes; both renderers walk the same graph, so the walks live here, not in each.
  const matrixModeOf = (node) => {
    let partial = 0;
    while (node) {
      // 5: drawn in its own palette inside the Matrix (the Agent)
      if (node.matrixNative) return 5;
      if (node.matrixLiving) return 2;
      if (node.matrixCloud) return 4;
      if (node.matrixEmissiveLiving || node.matrixSignLiving) partial = 3;
      node = node.parent;
    }
    return partial;
  };
  const hiddenFromCamera = (node) => {
    for (let n = node; n; n = n.parent) if (n.cameraHidden) return true;
    return false;
  };
  const hiddenFromCutaway = (node) => {
    for (let n = node; n; n = n.parent) if (n.cutawayWholeHidden) return true;
    return false;
  };
  const boundsCache = new WeakMap();
  const boundsOf = (geometry) => {
    let b = boundsCache.get(geometry);
    if (b) return b;
    const v = geometry.verts;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      minX = Math.min(minX, v[i]);
      maxX = Math.max(maxX, v[i]);
      minY = Math.min(minY, v[i + 1]);
      maxY = Math.max(maxY, v[i + 1]);
      minZ = Math.min(minZ, v[i + 2]);
      maxZ = Math.max(maxZ, v[i + 2]);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let i = 0; i < v.length; i += 3) {
      const dx = v[i] - cx, dy = v[i + 1] - cy, dz = v[i + 2] - cz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    b = { center: [cx, cy, cz], radius: Math.sqrt(r2), min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
    boundsCache.set(geometry, b);
    return b;
  };
  const tweens = [];
  const addTween = ({ delay = 0, dur, ease = (t) => t, update, done }) => {
    const tw = { delay, dur, ease, update, done, t: 0, alive: true };
    tweens.push(tw);
    return tw;
  };
  // Reverse iteration keeps splice indices valid.
  // Never call clearTweens from an update/done callback: it truncates this loop's array.
  const stepTweens = (dt) => {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (!tw.alive) {
        tweens.splice(i, 1);
        continue;
      }
      if (tw.delay > 0) {
        tw.delay -= dt;
        continue;
      }
      tw.t += dt / tw.dur;
      const k = Math.min(1, tw.t);
      tw.update(tw.ease(k));
      if (k >= 1) {
        tw.alive = false;
        tweens.splice(i, 1);
        if (tw.done) tw.done();
      }
    }
  };
  const tweenCount = () => tweens.length;
  const clearTweens = () => {
    for (const tw of tweens) tw.alive = false;
    tweens.length = 0;
  };
  BL.scene = { createNode, addChild, removeChild, updateLocal, updateWorld, traverseVisible, createCamera, cameraProjection, boundsOf, matrixModeOf, hiddenFromCamera, hiddenFromCutaway, addTween, stepTweens, tweenCount, clearTweens };
})();

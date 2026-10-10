(() => {
  "use strict";
  const BL = window.BL;
  const { makeVox } = BL.models;
  const { hexToRgb } = BL.math;
  const SHIELD_PALETTE = ["#513b2b", "#644a34", "#292c30", "#777b7d", "#a8aaab", "#d69b39"].map(hexToRgb);
  const GOLD_SHIELD_PALETTE = ["#8a602c", "#a57532", "#6b491e", "#ce9d45", "#efc96b", "#f7931a"].map(hexToRgb);
  const shieldVox = () => {
    const v = makeVox();
    // A round plank shield; the standard held-item hook owns carry and sling poses.
    for (let x = -4; x <= 6; x++) for (let y = -1; y <= 9; y++) {
      const r2 = (x - 1) * (x - 1) + (y - 4) * (y - 4);
      if (r2 > 25) continue;
      const rim = r2 > 16;
      v.set(x, y, 0, rim ? 2 : 0);
      v.set(x, y, 1, rim ? 3 : (x + 4) % 3 === 0 ? 0 : 1);
    }
    v.fill(0, 2, 3, 5, 2, 2, 3);
    v.set(1, 4, 3, 4);
    for (const [x, y] of [[1, 8], [1, 0], [-3, 4], [5, 4]]) v.set(x, y, 2, 4);
    // A small split-stave rune in muted Bitcoin gold, beside the iron boss.
    v.fill(-2, -2, 3, 6, 2, 2, 5);
    v.set(-1, 5, 2, 5);
    v.set(-1, 3, 2, 5);
    return v;
  };
  BL.characters.add({
    handle: "l0n0",
    // Initial local registration dates; Oogatron refreshes recorded contribution activity.
    joined: 1791577993,
    lastCommit: 1791577993,
    look: {
      build: "normal", height: 1.16, face: "beard", hatY: 11,
      skin: "#dfb895", hair: "#d9b65f", fur: "#51483e",
      portrait: { min: [-1, -5, -2], max: [7, 10, 8] }
    },
    voice: {
      poke: "The timechain calls. We sail.",
      idle: [
        "Stack sats. Raid knowledge.",
        "Proof, not promises.",
        "The longship needs more hash.",
        "No king controls the timechain.",
        "I came for bananas. Stayed for Bitcoin.",
        "Valhalla can wait. Blocks won't.",
        "Where does this path lead?",
        "A Viking verifies."
      ]
    },
    dress: {
      torso(k, v) {
        const cloth = k.color("#292c30"), leather = k.color("#513b2b"), seam = k.color("#75604b"), iron = k.color("#777b7d");
        k.loin = [cloth, leather];
        // A broad tunic under a fur shoulder wrap, with a diagonal leather strap.
        v.fill(0, 8, 0, 2, 0, 5, cloth);
        v.fill(1, 7, 3, 7, 1, 4, cloth);
        v.fill(0, 8, 6, 7, 0, 5, k.jit(k.P.fur, seam, 0.15));
        for (let y = 2; y <= 6; y++) {
          const x = 7 - y;
          v.fill(x, x + 1, y, y, 5, 5, leather);
        }
        v.fill(0, 8, 2, 2, 0, 5, leather);
        v.fill(4, 5, 2, 3, 6, 6, iron);
        v.set(4, 3, 7, k.color("#d69b39"));
      },
      club: () => ({ voxels: shieldVox(), palette: SHIELD_PALETTE, goldPalette: GOLD_SHIELD_PALETTE, rest: { x: 0, z: 0 }, carry: { x: 0.15, z: 0 } }),
      gear(k) {
        const leather = k.color("#513b2b"), dark = k.color("#302720"), iron = k.color("#777b7d");
        // Keep the standard joints, hands and feet; dress their existing voxel shapes.
        const boot = makeVox();
        boot.fill(0, 3, 2, 4, 0, 3, leather);
        boot.fill(0, 3, 0, 1, 0, 5, dark);
        boot.fill(0, 3, 4, 4, 0, 3, k.P.fur);
        boot.fill(0, 3, 2, 2, 4, 4, iron);
        const bootGeometry = k.vg(boot, { x: -2 * k.u, y: -5 * k.u, z: -2.5 * k.u });
        k.parts.legR.geometry = k.parts.legL.geometry = bootGeometry;
        const arm = makeVox();
        arm.fill(0, 2, 2, 7, 0, 2, k.skinJ);
        arm.fill(-1, 3, 8, 10, -1, 3, k.skinJ);
        arm.fill(-1, 3, 0, 1, -1, 3, k.skinJ);
        arm.fill(-1, 3, 8, 9, -1, 3, k.jit(k.P.fur, leather, 0.15));
        arm.fill(0, 2, 3, 5, 0, 2, leather);
        arm.fill(0, 2, 3, 3, 3, 3, iron);
        const armGeometry = k.vg(arm, { x: -1.5 * k.u, y: -11 * k.u, z: -1.5 * k.u });
        k.parts.armR.geometry = k.parts.armL.geometry = armGeometry;
        // A fixed, powerful silhouette rather than the default hashed belly width.
        k.parts.torso.scale.x = 1.12;
        k.parts.torso.scale.z = 1;
        k.parts.armR.position.x = -(0.29 * k.h * 1.12 + 0.09 * k.h);
        k.parts.armL.position.x = -k.parts.armR.position.x;
      },
      crown(k, v) {
        // Long, uneven locks down the back; leave the face and eyes uncovered.
        for (const [x, z, end] of [[-1, 0, -2], [-1, 3, -3], [7, 0, -3], [7, 3, -2], [0, -2, -4], [2, -2, -3], [4, -2, -4], [6, -2, -3]]) {
          v.fill(x, x, end, 5, z, z, k.hairJ);
        }
        v.fill(1, 3, 9, 9, 0, 2, k.P.hair);
        v.set(2, 10, 1, k.P.hairDk);
      },
      mark(k, v) {
        const braid = k.color("#d9b65f"), shade = k.color("#ad8742"), tie = k.color("#777b7d");
        // A square beard and two short plaits, drawn after the engine's hair erosion.
        v.fill(0, 6, 0, 1, 6, 7, braid);
        v.fill(1, 5, -1, -1, 6, 7, braid);
        for (const x of [1, 5]) {
          for (let y = -2; y >= -4; y--) {
            v.set(x, y, 7, (x + y) % 2 === 0 ? shade : braid);
            v.set(x, y, 8, (x + y) % 2 === 0 ? braid : shade);
          }
          v.set(x, -5, 7, tie);
        }
        // One raised eyebrow, a crooked smile and a small weathered cheek mark.
        v.del(5, 4, 6);
        v.set(5, 5, 6, braid);
        v.fill(2, 4, 0, 0, 8, 8, shade);
        v.set(4, 1, 8, k.P.white);
        v.set(0, 2, 6, k.P.skinDk);
      }
    }
  });
})();

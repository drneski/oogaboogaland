(() => {
  "use strict";
  const BL = window.BL;
  const { makeVox, voxelGeometry, bevelBox, merge } = BL.models;
  const { createNode, addChild } = BL.scene;
  const { hexToRgb } = BL.math;
  const GREEN = "#1bcd6e", DARK = "#080a0e", CHARCOAL = "#161b28";
  const CLUB_PALETTE = ["#38291f", "#594231", "#947657"].map(hexToRgb);

  // A white/cyan faceted fist: palm, four folded fingers and a crossing thumb.
  // Opaque facets keep the diamond readable in both renderers without a new material.
  const diamondFist = (u) => {
    const pieces = [];
    const gem = (x, y, z, w, h, d, color) => {
      const geo = bevelBox({
        w: w * u, h: h * u, d: d * u, bevel: Math.min(w, h, d) * u * 0.28,
        color, emissive: 0.15, offset: { x: x * u, y: y * u, z: z * u }
      });
      const facets = [];
      for (const face of geo.faces) {
        if (face.i.length !== 4) { facets.push(face); continue; }
        const [a, b, c, d] = face.i;
        facets.push({ i: [a, b, c], color: face.color, emissive: face.emissive });
        facets.push({ i: [a, c, d], color: hexToRgb("#b9edff"), emissive: 0.15 });
      }
      geo.faces = facets;
      pieces.push(geo);
    };
    gem(0, 10.6, 0, 2.8, 2.6, 2.8, "#88dfff");
    gem(0, 13, 0, 5.8, 4.2, 3.8, "#e8eaf0");
    for (let i = 0; i < 4; i++) {
      const x = -2.1 + i * 1.4, y = i === 0 || i === 3 ? 14.8 : 15.2;
      gem(x, y, 1, 1.35, 2.4, 2.6, i % 2 ? "#d7f6ff" : "#a4e6ff");
      gem(x, y - 1.5, 2, 1.3, 1.4, 1.7, "#e8eaf0");
    }
    gem(2.5, 12.5, 1.1, 2, 2.6, 2.6, "#00c2ff");
    gem(1.5, 12.5, 2.3, 2.5, 1.6, 1.8, "#d7f6ff");
    return merge(...pieces);
  };

  // Sampled from the supplied logo: the inner curl and detached tongues stay intact.
  const LOGO = [
    "000000000000000000000000",
    "000000000000000000000000",
    "000000000001000000000000",
    "000000000001100000000000",
    "000000000011100000000000",
    "000000000001110000000000",
    "000000000001111000000000",
    "000000000000111000000000",
    "000000001000110000000000",
    "000000001000010000000000",
    "000000001100000000000000",
    "000000001100000000100000",
    "000000001100000001100000",
    "000000011110000011000000",
    "000000011110000111000011",
    "000000111110001111000011",
    "000000111110001111000111",
    "001001111110011111000111",
    "011011111110011111000110",
    "011111111110011111100100",
    "011111111110000011100000",
    "011111111110000001110000",
    "011111111100000000110000",
    "011111111000000000011000",
    "111111111000000000001000",
    "111111110000000000101100",
    "111111100000000000111100",
    "111111000000000000111100",
    "111111000000000001111110",
    "111110000000000001111110",
    "111110000000000111111100",
    "111110000000000111111100",
    "011110000000000111111100",
    "011110000000000111111100",
    "001110000000000111111000",
    "001111000000101111111000",
    "000111110011111111110000",
    "000011111111111111100000",
    "000000111111111110000000",
    "000000001111111000000000"
  ];

  BL.characters.add({
    handle: "hotpixelgroup",
    joined: 1790600000,
    lastCommit: 1790680000,
    display: "hotpixelgroup",
    github: "hotpixelgroup",
    look: {
      skin: "#c48253",
      hair: DARK,
      fur: CHARCOAL,
      height: 1.08,
      eyeColor: "#e8eaf0",
      face: "beard",
      hatY: 19,
      portrait: { min: [-2, -2, -1], max: [8, 18, 8] }
    },
    voice: {
      poke: "Hot pixels, forged blocks.",
      idle: [
        "Proof of work never sleeps.",
        "The hardest stone yields to patience.",
        "Tick tock, next block.",
        "Stacking sats, pixel by pixel."
      ]
    },
    dress: {
      torso(k, v) {
        const dark = k.color(DARK), charcoal = k.color(CHARCOAL);
        const green = k.color(GREEN), shade = k.color("#13a356");
        const bone = k.color("#e8e5d5"), leather = k.color("#38291f");
        k.loin = [charcoal, dark];
        // Clear the stock diagonal strap: the exposed chest is plain skin.
        v.fill(1, 7, 3, 7, 1, 4, k.skinJ);
        v.fill(0, 8, 0, 2, 0, 5, (x, y, z) => (x + z) % 4 === 0 ? dark : charcoal);
        v.fill(0, 8, 3, 3, 0, 5, leather);
        // Green hide over the anatomical left shoulder, front and back.
        for (let x = 6; x <= 9; x++) for (let z = 0; z <= 5; z++) {
          const hem = 5 + (x + z) % 2;
          v.fill(x, x, hem, 8, z, z, (a, y) => (a + y + z) % 5 === 0 ? shade : green);
        }
        // Eighth-size cells retain the original badge size with a 24x40 logo.
        const badge = makeVox();
        badge.fill(0, 35, 0, 43, 0, 1, bone);
        badge.fill(2, 33, 2, 41, 2, 2, green);
        for (let row = 0; row < LOGO.length; row++) for (let x = 0; x < 24; x++) {
          if (LOGO[row][x] === "1") badge.set(x + 6, 41 - row, 3, dark);
        }
        addChild(k.root, createNode({
          position: { x: 0, y: 2.7 * k.u, z: 3.5 * k.u },
          geometry: k.vg(badge, { x: -18 * k.u, y: -22 * k.u, z: 0 }),
          scale: { x: 0.125, y: 0.125, z: 0.125 }
        }));
      },
      club(k) {
        const v = makeVox(), u = k.u;
        v.fill(0, 0, -2, 10, 0, 0, 0);
        for (const y of [0, 4, 9]) {
          v.fill(-1, 1, y, y, -1, 1, 2);
          v.set(0, y + 1, 0, 1);
        }
        const handle = voxelGeometry(v, {
          unit: u, palette: CLUB_PALETTE, origin: { x: -u, y: -u, z: -u }
        });
        const geo = merge(handle, diamondFist(u));
        // Swag keeps the crystal fist instead of replacing it with a gold club.
        return { voxels: v, default: geo, gold: geo,
          rest: { x: 0.2, z: -0.05 }, carry: { x: 0.35, z: 0 } };
      },
      crown(k, v) {
        // Keep the brow close to the head; the fine carved flames live above it.
        v.fill(-1, 7, 6, 7, -1, 6, k.color(CHARCOAL));
      },
      headgear(k) {
        const dark = k.color(CHARCOAL);
        const green = k.color(GREEN), light = k.color("#2ee085"), shade = k.color("#13a356");
        // Half-size cells give each tongue a curled tip, broad belly and tapered
        // root instead of a rectangular post. Green fills both faces and the sides.
        const outline = [
          "000000100", "000001100", "000011100", "000111000",
          "001111000", "001111100", "011111110", "011111110",
          "111111111", "111111111", "011111110", "001111100"
        ];
        const tongues = [[-6, 0, 0.7], [3, 4, 1], [12, 0, 0.7]];
        for (const [x0, y0, size] of tongues) {
          const v = makeVox();
          for (let row = 0; row < outline.length; row++) for (let x = 0; x < 9; x++) {
            if (outline[row][x] !== "1") continue;
            const y = y0 + outline.length - 1 - row;
            const inset = x > 0 && x < 8 && outline[row][x - 1] === "1"
              && outline[row][x + 1] === "1" && row < outline.length - 1;
            v.fill(x0 + x, x0 + x, y, y, 0, 3, inset ? shade : dark);
            if (inset) {
              v.set(x0 + x, y, 4, x < 4 ? light : green);
              v.set(x0 + x, y, -1, green);
            }
          }
          addChild(k.parts.head, createNode({
            position: { x: (x0 + 4.5 - 7) * 0.5 * k.u, y: (8 + y0 * 0.5) * k.u, z: 0 },
            geometry: k.vg(v, { x: -(x0 + 4.5) * k.u, y: -y0 * k.u, z: 0 }),
            scale: { x: 0.5 * size, y: 0.5 * size, z: 0.5 * size }
          }));
        }
      },
      mark(k, v) {
        const green = k.color(GREEN);
        // Below the eyes and clear of the blink cells.
        for (const x of [0, 1, 5, 6]) v.set(x, 1, 7, green);
      },
      gear(k) {
        // Bone wrist bands follow each animated arm.
        const v = makeVox(), bone = k.color("#e8e5d5");
        v.fill(-2, 4, 2, 3, -2, 4, (x, y, z) =>
          x === -2 || x === 4 || z === -2 || z === 4 ? bone : null);
        const geometry = k.vg(v, { x: -1.5 * k.u, y: -11 * k.u, z: -1.5 * k.u });
        for (const arm of [k.parts.armR, k.parts.armL]) addChild(arm, createNode({ geometry }));
      }
    }
  });
})();

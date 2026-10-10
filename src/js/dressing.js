// The one set-dressing kit every scene draws from. `KIT` pieces are voxel functions on a 1/16 grid, each
// writing through `box` and `put` into separate solid, hanging, decorative glow and lantern glow layers: general (`lanternPost`, `crate`, `coalCrate`,
// `barrel`, `cart`, `banner`, `gauge`, `rubble`, `bracket`, `hanging`, `bulb`), lab (`die`,
// `flaskBench`, `terminal`, `chalkboard`), the mirror (`monolith`, `runeStone`), lightning (`coil`,
// `boards`), plus `bench`, `vine` and `banner(v)` carrying each cave's emblem from `hubModels.SIGN_ICONS`.
//
// `set()` places pieces by quarter turns (`put`), strings sagging cables with lamps (`cable`) and `build`s
// everything placed into one `solid`, one `hang`, decorative `glow` and lantern `lampGlow` mesh plus the `lights` its lanterns
// cast; lamps hung by `cable` bake into swinging body and glow meshes. Lantern glass (amber,
// teal, green, red) is the variant and sets the light's colour in `LIGHT_RGB`. `nodes(baked, opts)` makes a
// baked set's nodes. A theme's `inside` list and `ceiling` lamp runs in scene-hub.js furnish the room behind
// a mouth from the kit's pieces.
//
// Beyond sets: `palm(v)` three swaying cartoon palm meshes (not voxels) placed as their own nodes, `islet(v)` the terraced sea stacks on the horizon (variant 1 has a sea arch), `motes(opts)` a
// fixed field of glowing dust that wraps round the view (`update(elapsed, x, z)`), `flock(opts)` one
// instanced batch of wheeling gulls and `fleet(opts)` log rafts on the sea, each with `update(elapsed)`.
//
// Bake each dressed area once and memoise it (the hub per island, the caves per page).
// Only `solid` collides.
(() => {
  "use strict";
  const BL = window.BL = window.BL || {};
  const { voxelFaces, noShadow, merge } = BL.models;
  const { mulberry32, hexToRgb } = BL.math;
  const BANANA_ART = BL.hubModels.AMMO_BANANA;
  // Set dressing for every scene from one voxel kit. Pieces are authored once as integer voxel lists; a set places
  // them by quarter turns on the kit's grid and bakes every placed voxel into one mesh per layer, so faces
  // where two pieces touch are never emitted. Layers: `solid` (stands on the ground, collides), `hang` (cables,
  // arms, cloth, frames: no collision), `glow` (bolts and ore glints) and `lampGlow` (lantern glass).
  const U = 1 / 16;
  const SOLID = 0, HANG = 1, GLOW = 2, LAMP_GLOW = 3;
  // Keep decorative uprights distinct inside a merged solid. Structures,
  // workbenches and short stepping props retain their ordinary collision.
  const RAGE_PASS = 64;
  const RAGE_PASS_PIECES = new Set(["lanternPost", "banner", "chalkboard", "monolith", "coil", "gauge"]);
  const PALETTE = [
    "#8a5a32", "#a8703e", "#5c3a1e", "#43291a", // 0 wood, 1 wood light, 2 wood dark, 3 plank gap
    "#4a4d52", "#2c2e33", "#6f737a", // 4 iron, 5 iron dark, 6 iron light
    "#1d1b1a", "#e8b830", // 7 cable, 8 cable band
    "#ffd66b", "#fff1b0", "#ffcf2e", // 9 glass, 10 flame, 11 bolt
    "#2a2a2e", "#3d3d44", // 12 coal, 13 coal light
    "#1d1d22", "#34343b", // 14 cloth, 15 cloth edge
    "#efe6cc", "#4caf50", "#f2c230", "#d9442b", // 16 cream, 17 green, 18 yellow, 19 red
    "#6d6a66", "#85817b", "#56534f", "#6d8a3a", "#86a24a", // 20 stone, 21 stone light, 22 stone dark, 23 moss, 24 moss light
    "#b89a68", "#9a7f52", // 25 burlap, 26 burlap dark
    "#7fb23d", "#9ccc4a", "#5f9632", // 27 grass, 28 grass tip, 29 grass dark
    "#7ff5e6", "#7dff96", "#ff5a46", // 30 teal glass, 31 green glass, 32 red lamp
    "#f2efe8", "#2f4a3a", "#e6eee4", // 33 white paint, 34 chalkboard, 35 chalk
    "#141816", "#46ff72", "#b9bec6", "#c77a3a", "#c08cff", // 36 obsidian, 37 glyph, 38 chrome, 39 copper, 40 violet glass
    "#1f6f6a", "#6a4424", // 41 teal cloth, 42 brown cloth
    "#9a7148", "#7a5634", "#4fae3a", "#6fcf4a", "#3a8a2c", "#6b4a26", // 43 palm trunk, 44 trunk dark, 45 frond, 46 frond light, 47 frond dark, 48 coconut
    "#f5d142", "#4f9a38", // 49 banana, 50 vine
    "#e9d7a0", "#d8c184", // 51 sand, 52 sand dark
    "#d9a441", "#5a3a1a", // 53 leopard tan, 54 leopard spot
    BANANA_ART.ink.D, BANANA_ART.ink.Y, BANANA_ART.ink.G // 55-57 ammo banana outline, fruit, stem
  ];
  const EMISSIVE = { 9: 1, 10: 1, 11: 0.9, 30: 1, 31: 1, 32: 1, 37: 1, 40: 1 };
  // Lantern glass by variant (amber, teal, green, red) and the light each casts; the fifth is a bolt's yellow.
  const GLASS = [9, 30, 31, 32];
  const LIGHT_RGB = [[1, 0.7, 0.36], [0.45, 1, 0.92], [0.5, 1, 0.55], [1, 0.38, 0.3], [1, 0.9, 0.35]];
  const ICONS = BL.hubModels.SIGN_ICONS;
  const RGB = PALETTE.map(hexToRgb);
  // A cell packs into one number (12 bits an axis, offset to stay positive): a set's layers are numeric maps,
  // several times cheaper to fill and probe than string-keyed voxel maps.
  const KEY = (x, y, z) => ((x + 2048) * 4096 + (y + 2048)) * 4096 + (z + 2048);
  const BOLT = ["...##", "..##.", ".##..", "#####", "..##.", ".##..", "##..."];
  // A piece is three flat lists of x, y, z, colour per layer, built by its author through `put`.
  const author = (build) => {
    const layers = [[], [], [], []];
    const put = (layer, x, y, z, c) => layers[layer].push(x, y, z, c);
    const box = (layer, x0, x1, y0, y1, z0, z1, color) => {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        // Shell only: the interior never shows and would only cost map entries.
        if (x > x0 && x < x1 && y > y0 && y < y1 && z > z0 && z < z1) continue;
        put(layer, x, y, z, typeof color === "function" ? color(x, y, z) : color);
      }
    };
    build(put, box);
    return layers.map((list) => Int16Array.from(list));
  };
  const lantern = (put, box, cx, top, cz, glass = 9) => {
    box(HANG, cx - 1, cx, top + 1, top + 2, cz - 1, cz, 5);
    box(HANG, cx - 3, cx + 2, top, top, cz - 3, cz + 2, 5);
    for (const [x, z] of [[cx - 3, cz - 3], [cx + 2, cz - 3], [cx - 3, cz + 2], [cx + 2, cz + 2]]) box(HANG, x, x, top - 7, top - 1, z, z, 5);
    box(LAMP_GLOW, cx - 2, cx + 1, top - 7, top - 1, cz - 2, cz + 1, (x, y) => y === top - 4 && glass === 9 ? 10 : glass);
    box(HANG, cx - 3, cx + 2, top - 8, top - 8, cz - 3, cz + 2, 5);
    box(HANG, cx - 1, cx, top - 9, top - 9, cz - 1, cz, 4);
  };
  const icon = (put, layer, rows, x0, y0, z, scale, color) => {
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== "#") continue;
      for (let i = 0; i < scale; i++) for (let j = 0; j < scale; j++) put(layer, x0 + c * scale + i, y0 + (rows.length - 1 - r) * scale + j, z, color);
    }
  };
  const bolt = (put, layer, x0, y0, z, scale, color) => icon(put, layer, BOLT, x0, y0, z, scale, color);
  const disc = (fn, r, y, cx = 0, cz = 0) => {
    const n = Math.ceil(r);
    for (let x = -n - 1; x <= n; x++) for (let z = -n - 1; z <= n; z++) {
      const d = Math.hypot(x + 0.5, z + 0.5);
      if (d <= r) fn(cx + x, y, cz + z, d);
    }
  };
  const plank = (x, y, z, lo, hi, axis) => {
    const t = axis === 0 ? x : axis === 1 ? y : z;
    return (t - lo) % 4 === 3 && t !== hi ? 3 : ((t - lo) >> 2) & 1 ? 1 : 0;
  };
  const crateShell = (box, h, open, seed) => box(SOLID, -6, 5, 0, h - 1, -6, 5, (x, y, z) => {
    const ex = x === -6 || x === 5, ey = y === 0 || y === h - 1, ez = z === -6 || z === 5;
    if (ex + ey + ez >= 2) return (ex && ez && (y < 2 || y > h - 3)) || (ey && (ex || ez) && ((ex ? z : x) < -4 || (ex ? z : x) > 3)) ? 6 : 2;
    if (open && y === h - 1) return 3;
    // Planks run across each side, with a diagonal brace on the two broad faces.
    if (ez && Math.abs((x + 6) * (h - 1) / 11 - y) < 1) return 2;
    return plank(x, y, z, 0, h - 1, 1) === 3 ? 3 : (y >> 2) + seed & 1 ? 1 : 0;
  });
  const KIT = {
    lanternPost: (v) => author((put, box) => {
      box(SOLID, -4, 3, 0, 2, -4, 3, (x, y) => y === 2 ? 4 : 2);
      box(SOLID, -2, 1, 3, 47, -2, 1, (x, y, z) => (x === -2 || x === 1) && (z === -2 || z === 1) ? 2 : y % 9 === 0 ? 3 : 0);
      for (const y of [11, 40]) box(SOLID, -3, 2, y, y + 1, -3, 2, 4);
      box(HANG, 2, 17, 42, 44, -1, 0, (x) => x === 17 ? 2 : 1);
      for (let i = 0; i < 9; i++) box(HANG, 2 + i, 2 + i, 33 + i, 34 + i, -1, 0, 2);
      box(HANG, 15, 15, 39, 41, -1, -1, 5);
      lantern(put, box, 16, 36, 0, GLASS[v]);
    }),
    crate: (v) => author((put, box) => crateShell(box, 12, false, v)),
    coalCrate: (v) => author((put, box) => {
      crateShell(box, 9, true, v);
      const rand = mulberry32(71 + v);
      for (let x = -5; x <= 4; x++) for (let z = -5; z <= 4; z++) {
        const h = 9 + Math.floor(rand() * 2.6 * (1 - Math.max(Math.abs(x + 0.5), Math.abs(z + 0.5)) / 6));
        for (let y = 8; y <= h; y++) {
          const glint = y === h && rand() < 0.07;
          put(glint ? GLOW : SOLID, x, y, z, glint ? 11 : rand() < 0.3 ? 13 : 12);
        }
      }
      bolt(put, GLOW, -3, 1, 6, 1, 11);
    }),
    barrel: (v) => author((put) => {
      for (let y = 0; y < 15; y++) {
        const r = 4.6 + Math.sin(y / 14 * Math.PI) * 0.9;
        for (let x = -6; x <= 5; x++) for (let z = -6; z <= 5; z++) {
          const d = Math.hypot(x + 0.5, z + 0.5);
          if (d > r || (d < r - 1.5 && y > 0 && y < 14)) continue;
          const hoop = y === 2 || y === 12;
          put(SOLID, x, y, z, hoop && d > r - 1 ? 5 : y === 14 ? 2 : (Math.floor(Math.atan2(z + 0.5, x + 0.5) * 3 + v) & 1) ? 1 : 0);
        }
      }
    }),
    cart: () => author((put, box) => {
      box(SOLID, -8, 7, 3, 11, -5, 4, (x, y, z) => {
        const edge = (x === -8 || x === 7) + (z === -5 || z === 4) + (y === 11) >= 2;
        return edge || y === 3 ? 5 : y === 11 ? 4 : plank(x, y, z, 3, 11, 1) === 3 ? 3 : 0;
      });
      const rand = mulberry32(5);
      for (let x = -7; x <= 6; x++) for (let z = -4; z <= 3; z++) {
        const h = 11 + Math.floor(rand() * 3 * (1 - Math.abs(x + 0.5) / 9));
        const glint = rand() < 0.08;
        put(glint ? GLOW : SOLID, x, h, z, glint ? 11 : rand() < 0.35 ? 13 : 12);
        for (let y = 10; y < h; y++) put(SOLID, x, y, z, 12);
      }
      for (const wx of [-5, 4]) for (const wz of [-6, 5]) for (let x = wx - 3; x <= wx + 3; x++) for (let y = 0; y <= 6; y++) {
        const d = Math.hypot(x - wx, y - 3);
        if (d <= 3.2) put(SOLID, x, y, wz, d < 1.2 ? 6 : 5);
      }
    }),
    // A cave's standard: 0 bolt, 1 die, 2 glyph, 3 banana.
    banner: (v) => author((put, box) => {
      const CLOTH = [14, 41, 36, 42][v], EDGE = [15, 33, 37, 18][v];
      const EMBLEM = [["bolt", 18], ["die", 33], ["glyph", 37], null][v];
      box(SOLID, -3, 2, 0, 1, -3, 2, 2);
      box(SOLID, -1, 0, 2, 45, -1, 0, 2);
      box(SOLID, -1, 0, 46, 47, -1, 0, v === 2 ? 37 : 6);
      box(HANG, -9, 8, 43, 44, -1, 0, 0);
      for (let x = -8; x <= 7; x++) {
        const bottom = 14 + ((x * 7) % 3 + 3) % 3 * 2;
        for (let y = bottom; y <= 42; y++) put(HANG, x, y, 1, x === -8 || x === 7 ? EDGE : CLOTH);
      }
      if (EMBLEM) icon(put, v === 2 ? GLOW : HANG, ICONS[EMBLEM[0]], -5, 22, 2, 2, EMBLEM[1]);
      if (v === 3) for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
        const ink = BANANA_ART.rows[Math.floor(row * 9 / 15)][Math.floor(col * 9 / 15)];
        if (ink !== ".") put(HANG, col - 7, 36 - row, 2, ink === "D" ? 55 : ink === "Y" ? 56 : 57);
      }
    }),
    // EntropyLab: a big die, a bench of glowing flasks, a terminal, a chalkboard of scribbles.
    die: () => author((put) => {
      for (let x = -4; x <= 3; x++) for (let y = 0; y <= 7; y++) for (let z = -4; z <= 3; z++) {
        const ex = x === -4 || x === 3, ey = y === 0 || y === 7, ez = z === -4 || z === 3;
        if (!(ex || ey || ez) || ex + ey + ez === 3) continue;
        put(SOLID, x, y, z, 33);
      }
    }),
    flaskBench: (v) => author((put, box) => {
      box(SOLID, -10, 9, 11, 12, -5, 4, 0);
      for (const [x, z] of [[-10, -5], [8, -5], [-10, 3], [8, 3]]) box(SOLID, x, x + 1, 0, 10, z, z + 1, 2);
      box(SOLID, -9, 8, 3, 3, -4, 3, 1);
      const COLORS = [30, 31, 40];
      [[-7, -1], [-2, 1], [3, -2]].forEach(([cx, cz], i) => {
        const fill = [14, 15, 13][i];
        for (let y = 13; y <= fill; y++) disc((x, yy, z) => put(GLOW, x, yy, z, COLORS[(i + v) % 3]), y === 13 ? 1.6 : 2.1, y, cx, cz);
        for (let y = 13; y <= 17; y++) {
          const radius = 2.6 - Math.abs(y - 15) * 0.5;
          disc((x, yy, z, d) => {
            if (d > radius - 0.8 && (y === 17 || x === cx - 2 || z === cz + 2)) put(HANG, x, yy, z, x === cx - 2 ? 35 : 38);
          }, radius, y, cx, cz);
        }
        box(SOLID, cx - 1, cx, 18, 20, cz - 1, cz, 33);
        box(SOLID, cx - 1, cx, 21, 21, cz - 1, cz, 0);
      });
      box(SOLID, 5, 9, 13, 14, 1, 3, 2);
      for (let k = 0; k < 4; k++) box(GLOW, 5 + k, 5 + k, 15, 17 + (k & 1) * 2, 2, 2, COLORS[k % 3]);
    }),
    terminal: () => author((put, box) => {
      crateShell(box, 12, false, 1);
      box(SOLID, -6, 5, 12, 23, -5, 4, (x, y) => y === 12 || y === 23 ? 5 : 6);
      for (let y = 14; y <= 21; y++) box(y & 1 ? GLOW : SOLID, -4, 3, y, y, 5, 5, y & 1 ? 31 : 36);
      box(SOLID, -5, 4, 12, 12, 6, 8, 5);
    }),
    chalkboard: () => author((put, box) => {
      for (let y = 0; y <= 29; y++) {
        const z = Math.round(-2 - y * 3 / 29);
        box(SOLID, -1, 0, y, y, z, z + 1, 2);
      }
      for (const side of [-1, 1]) for (let y = 0; y <= 17; y++) {
        const x = side < 0 ? Math.round(-1 - 8 * (1 - y / 17)) : Math.round(8 * (1 - y / 17));
        const z = Math.round(-10 + y * 6 / 17);
        box(SOLID, x, x + 1, y, y, z, z + 1, 2);
      }
      box(SOLID, -13, 12, 10, 26, -2, -2, (x, y) => x === -13 || x === 12 || y === 10 || y === 26 ? 2 : 34);
      box(SOLID, -14, 13, 9, 9, -2, 2, 1);
      box(SOLID, -10, -6, 10, 11, 1, 2, 5);
      box(SOLID, 6, 9, 10, 10, 1, 1, 35);
    }),
    // The mirror cave: black monoliths running with green glyphs, and rune stones.
    monolith: (v) => author((put, box) => {
      box(SOLID, -4, 3, 0, 44, -2, 1, 36);
      box(SOLID, -3, 2, 45, 47, -1, 0, 36);
      const rand = mulberry32(17 + v);
      for (let y = 3; y <= 42; y++) for (let x = -3; x <= 2; x++) if (y % 7 < 5 && rand() < 0.42) put(GLOW, x, y, 2, 37);
    }),
    runeStone: (v) => author((put, box) => {
      box(SOLID, -6, 5, 0, 10, -4, 3, (x, y) => y === 10 ? 21 : 20);
      icon(put, GLOW, ICONS.glyph, -3, 2, 4, 1, 37);
    }),
    // The Lightning Factory: a coil with a glowing crown and arcs leaping from it.
    coil: () => author((put, box) => {
      box(SOLID, -5, 4, 0, 3, -5, 4, (x, y) => y === 3 ? 6 : 5);
      for (let y = 4; y <= 30; y++) disc((x, yy, z) => put(SOLID, x, yy, z, y % 3 === 0 ? 39 : 5), y % 3 === 0 ? 3.2 : 2.3, y);
      for (let y = 31; y <= 37; y++) disc((x, yy, z) => put(GLOW, x, yy, z, 11), 3.6 - Math.abs(y - 34) * 0.9, y);
      const rand = mulberry32(3);
      for (let arc = 0; arc < 3; arc++) {
        let x = 0, y = 34, z = 0;
        const dx = [1, -1, 0][arc], dz = [0, 1, -1][arc];
        for (let k = 0; k < 9; k++) {
          x += dx * 1; z += dz * 1; y += rand() < 0.5 ? 1 : -1;
          put(GLOW, x + dx * 3, y, z + dz * 3, 11);
        }
      }
    }),
    // Planks nailed across a sealed mouth: this one is coming soon.
    boards: () => author((put, box) => {
      for (let k = -40; k <= 40; k++) {
        const y1 = Math.round(24 + k * 0.55), y2 = Math.round(24 - k * 0.55);
        for (let w = 0; w < 4; w++) { put(HANG, k, y1 + w, 0, 1); put(HANG, k, y2 + w, 1, 0); }
      }
      box(HANG, -38, 37, 30, 33, 2, 2, 1);
      for (const x of [-36, 35]) for (const y of [31, 32]) put(HANG, x, y, 3, 6);
    }),
    // Headquarters: a log bench.
    bench: () => author((put, box) => {
      for (const cx of [-8, 7]) for (let y = 0; y <= 5; y++) disc((x, yy, z) => put(SOLID, x, yy, z, y === 5 ? 1 : 2), 2.4, y, cx, 0);
      box(SOLID, -12, 11, 6, 8, -2, 1, (x, y) => y === 8 ? 1 : 2);
    }),
    vine: (v) => author((put) => {
      const rand = mulberry32(800 + v);
      for (let k = 0; k < 3; k++) {
        const x = k * 2 + (v & 1), len = 10 + Math.floor(rand() * 18);
        for (let y = 0; y > -len; y--) {
          put(HANG, x, y, 0, 50);
          if (-y % 3 === 1) put(HANG, x + ((y & 2) ? 1 : -1), y, 0, rand() < 0.5 ? 23 : 24);
        }
      }
    }),
    gauge: () => author((put, box) => {
      box(SOLID, -2, 0, 0, 21, -2, 0, 2);
      box(SOLID, -7, 6, 22, 35, -3, 1, (x, y) => x === -7 || x === 6 || y === 22 || y === 35 ? 5 : 2);
      box(SOLID, 7, 8, 0, 29, -2, -1, 4);
      box(SOLID, 7, 8, 30, 31, -2, -1, 6);
      box(SOLID, -6, 5, 23, 34, 2, 2, 16);
      for (let a = 0; a <= 20; a++) {
        const t = a / 20, ang = Math.PI * (1 - t);
        const x = Math.round(Math.cos(ang) * 4.6 - 0.5), y = Math.round(Math.sin(ang) * 4.6) + 26;
        put(SOLID, x, y, 3, t < 0.45 ? 17 : t < 0.75 ? 18 : 19);
      }
      for (let i = 0; i <= 4; i++) put(SOLID, Math.round(i * 0.8) - 1, 26 + Math.round(i * 0.9), 3, 5);
    }),
    rubble: (v) => author((put, box) => {
      const rand = mulberry32(211 + v * 13);
      for (let n = 0; n < 4 + v % 3; n++) {
        const w = 3 + Math.floor(rand() * 5), h = 2 + Math.floor(rand() * 4), d = 3 + Math.floor(rand() * 5);
        const x0 = Math.floor((rand() - 0.5) * 10), z0 = Math.floor((rand() - 0.5) * 10), y0 = n > 2 ? 2 + Math.floor(rand() * 2) : 0;
        box(SOLID, x0, x0 + w, y0, y0 + h, z0, z0 + d, (x, y) => y === y0 + h && rand() < 0.55 ? (rand() < 0.5 ? 23 : 24) : rand() < 0.25 ? 21 : rand() < 0.2 ? 22 : 20);
      }
    }),
    // A plain pole the cables start from on walls; it carries a small lantern of its own.
    bracket: () => author((put, box) => {
      box(HANG, -1, 0, 0, 1, -1, 6, 2);
      box(HANG, -1, 0, -6, 1, 6, 7, 4);
      lantern(put, box, 0, -1, 6);
    })
  };
  // Where a piece's lantern glass sits, in voxel units of the piece: the point its light comes from.
  const LIGHTS = { lanternPost: [16, 32.5, 0], hanging: [1, -7.5, 1], coil: [0, 34, 0] };
  const pieces = new Map();
  const pieceOf = (kind, variant) => {
    const key = kind + ":" + variant;
    let piece = pieces.get(key);
    if (!piece) pieces.set(key, piece = KIT[kind](variant));
    return piece;
  };
  // A piece's pick sphere in voxel units, measured once from its solid and hanging voxels: centre x, y, z and radius.
  const pickOf = (piece) => {
    if (piece.pick) return piece.pick;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let layer = 0; layer < 4; layer++) {
      const list = piece[layer];
      for (let i = 0; i < list.length; i += 4) {
        x0 = Math.min(x0, list[i]); x1 = Math.max(x1, list[i] + 1);
        y0 = Math.min(y0, list[i + 1]); y1 = Math.max(y1, list[i + 1] + 1);
        z0 = Math.min(z0, list[i + 2]); z1 = Math.max(z1, list[i + 2] + 1);
      }
    }
    // Half the larger footprint side: the sphere hugs the piece rather than its tallest diagonal.
    return piece.pick = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0, (y1 - y0) * 0.6) / 2];
  };
  // Pieces drawn as cartoon timber instead of voxels: the hub's crate and barrel, scaled to the piece's voxel
  // footprint and turned with it, baked into the set's solid mesh so they still collide and cost no draw of their
  // own. `keep` names the voxels still written (a coal crate's coal and glints); the voxel piece still sets the
  // pick sphere.
  const filled = (layer, x, y, z) => layer !== SOLID || (y >= 8 && x > -6 && x < 5 && z > -6 && z < 5);
  const CRATE_SCALE = 0.75 / 0.9, OPEN_SCALE = 0.5625 / 0.9;
  const MESHES = {
    die: { build: (variant) => {
      const geo = BL.models.die({ size: 0.5, variant });
      for (let i = 1; i < geo.verts.length; i += 3) geo.verts[i] += 0.25;
      return geo;
    }, variants: new Map(), scale: [1, 1, 1], keep: null },
    crate: { build: () => BL.hubModels.woodCrate(0), scale: [CRATE_SCALE, CRATE_SCALE, CRATE_SCALE], keep: null },
    coalCrate: { build: () => BL.hubModels.woodCrate(1), scale: [CRATE_SCALE, OPEN_SCALE, CRATE_SCALE], keep: filled },
    barrel: { build: () => BL.hubModels.barrel(), scale: [0.8, 1.04, 0.8], keep: null }
  };
  const stepBounds = new Map();
  const boundsForStep = (kind, variant) => {
    const key = `${kind}:${variant}`;
    if (stepBounds.has(key)) return stepBounds.get(key);
    const piece = pieceOf(kind, variant), mesh = MESHES[kind];
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const solid = piece[SOLID];
    for (let i = 0; i < solid.length; i += 4) {
      const x = solid[i], y = solid[i + 1], z = solid[i + 2];
      if (mesh && (!mesh.keep || !mesh.keep(SOLID, x, y, z))) continue;
      box[0] = Math.min(box[0], x * U); box[1] = Math.min(box[1], y * U); box[2] = Math.min(box[2], z * U);
      box[3] = Math.max(box[3], (x + 1) * U); box[4] = Math.max(box[4], (y + 1) * U); box[5] = Math.max(box[5], (z + 1) * U);
    }
    if (mesh) {
      let geometry = mesh.variants ? mesh.variants.get(variant) : mesh.geometry;
      if (!geometry) {
        geometry = mesh.build(variant);
        if (mesh.variants) mesh.variants.set(variant, geometry);
        else mesh.geometry = geometry;
      }
      const [sx, sy, sz] = mesh.scale;
      for (let i = 0; i < geometry.verts.length; i += 3) {
        const x = geometry.verts[i] * sx, y = geometry.verts[i + 1] * sy, z = geometry.verts[i + 2] * sz;
        box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.min(box[2], z);
        box[3] = Math.max(box[3], x); box[4] = Math.max(box[4], y); box[5] = Math.max(box[5], z);
      }
    }
    const result = Number.isFinite(box[0]) && box[4] - box[1] <= 1.16 && box[1] >= -0.01 ? box : null;
    stepBounds.set(key, result);
    return result;
  };
  // A mesh piece's geometry scaled, turned by quarter turns q and moved to (ox, oy, oz) in kit cells.
  const meshAt = (kind, ox, oy, oz, q, variant) => {
    const m = MESHES[kind];
    let src = m.variants ? m.variants.get(variant) : m.geometry;
    if (!src) {
      src = m.build(variant);
      if (m.variants) m.variants.set(variant, src);
      else m.geometry = src;
    }
    const [sx, sy, sz] = m.scale, v = src.verts, out = new Array(v.length);
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i] * sx, z = v[i + 2] * sz;
      out[i] = ox * U + (q === 0 ? x : q === 1 ? z : q === 2 ? -x : -z);
      out[i + 1] = oy * U + v[i + 1] * sy;
      out[i + 2] = oz * U + (q === 0 ? z : q === 1 ? -x : q === 2 ? -z : x);
    }
    return { verts: out, faces: src.faces, lines: src.lines };
  };
  const set = () => {
    // Mesh pieces placed so far: kind, then the cell origin and quarter turns.
    const meshes = [];
    // Layers 3 and 4 hold what hangs from a cable (lantern bodies and other glow); 5 and 6 hold lantern glass.
    // The hanging layers swing without moving the cable or the posts.
    const layers = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map(), new Map()], lights = [];
    // What was placed, for poking: kind, variant, then the pick sphere's centre x, y, z and radius in metres.
    const picks = [];
    const steps = [];
    // Each light is x, y, z and its colour's index in LIGHT_RGB.
    const light = (kind, ox, oy, oz, q, variant) => {
      const p = LIGHTS[kind];
      if (!p) return;
      const x = q === 0 ? p[0] : q === 1 ? p[2] : q === 2 ? -p[0] : -p[2];
      const z = q === 0 ? p[2] : q === 1 ? -p[0] : q === 2 ? -p[2] : p[0];
      lights.push((ox + x) * U, (oy + p[1]) * U, (oz + z) * U, kind === "coil" ? 4 : variant);
    };
    // Later pieces overwrite earlier voxels in the same cell; the hang layer never overwrites a solid one.
    const write = (layer, x, y, z, c, ragePass = false) => {
      const k = KEY(x, y, z);
      if (layer !== SOLID && layers[SOLID].has(k)) return;
      // The palette fits below this bit. Carry it through run merging so a
      // decorative face never absorbs an adjacent structural face's tag.
      layers[layer].set(k, c | (layer === SOLID && ragePass ? RAGE_PASS : 0));
    };
    const put = (kind, x, y, z, turns = 0, variant = 0) => {
      const piece = pieceOf(kind, variant), mesh = MESHES[kind];
      const ragePass = RAGE_PASS_PIECES.has(kind);
      const ox = Math.round(x / U), oy = Math.round(y / U), oz = Math.round(z / U), q = ((turns % 4) + 4) % 4;
      const step = boundsForStep(kind, variant);
      if (step) {
        const x0 = q & 1 ? step[2] : step[0], x1 = q & 1 ? step[5] : step[3];
        const z0 = q & 1 ? step[0] : step[2], z1 = q & 1 ? step[3] : step[5];
        steps.push([(ox * U) + (q === 2 || q === 3 ? -x1 : x0), (oy * U) + step[1],
          (oz * U) + (q === 1 || q === 2 ? -z1 : z0),
          (ox * U) + (q === 2 || q === 3 ? -x0 : x1), (oy * U) + step[4],
          (oz * U) + (q === 1 || q === 2 ? -z0 : z1)]);
      }
      if (mesh) meshes.push(kind, ox, oy, oz, q, variant);
      for (let layer = 0; layer < 4; layer++) {
        const list = piece[layer];
        for (let i = 0; i < list.length; i += 4) {
          const lx = list[i], lz = list[i + 2];
          if (mesh && (!mesh.keep || !mesh.keep(layer, lx, list[i + 1], lz))) continue;
          const rx = q === 0 ? lx : q === 1 ? lz : q === 2 ? -lx - 1 : -lz - 1;
          const rz = q === 0 ? lz : q === 1 ? -lx - 1 : q === 2 ? -lz - 1 : lx;
          write(layer === LAMP_GLOW ? 5 : layer, ox + rx, oy + list[i + 1], oz + rz, list[i + 3], ragePass);
        }
      }
      light(kind, ox, oy, oz, q, variant);
      const [px, py, pz, pr] = pickOf(piece);
      picks.push(kind, variant, (ox + (q === 0 ? px : q === 1 ? pz : q === 2 ? -px : -pz)) * U, (oy + py) * U, (oz + (q === 0 ? pz : q === 1 ? -px : q === 2 ? -pz : px)) * U, pr * U);
      return set;
    };
    // A sagging cable of 6-connected voxels between two points, banded every metre, with lanterns hung at `lamps`.
    // Lanterns and bulbs all take the one glass `variant`.
    const cable = (ax, ay, az, bx, by, bz, sag, lamps = [], lamp = "hanging", variant = 0) => {
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / U * 2);
      let px = Math.round(ax / U), py = Math.round(ay / U), pz = Math.round(az / U), run = 0;
      const lay = (x, y, z) => {
        write(HANG, x, y, z, (run++ % 16) < 2 ? 8 : 7);
      };
      lay(px, py, pz);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const x = Math.round((ax + (bx - ax) * t) / U), y = Math.round((ay + (by - ay) * t - sag * 4 * t * (1 - t)) / U), z = Math.round((az + (bz - az) * t) / U);
        while (px !== x || py !== y || pz !== z) {
          if (px !== x) px += Math.sign(x - px);
          else if (py !== y) py += Math.sign(y - py);
          else pz += Math.sign(z - pz);
          lay(px, py, pz);
        }
      }
      lamps.forEach((t) => {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t - sag * 4 * t * (1 - t), z = az + (bz - az) * t;
        const piece = pieceOf(lamp, variant);
        const ox = Math.round(x / U), oy = Math.round(y / U), oz = Math.round(z / U);
        for (let layer = 0; layer < 4; layer++) {
          const list = piece[layer], into = layer === LAMP_GLOW ? 6 : layer === GLOW ? 4 : 3;
          for (let i = 0; i < list.length; i += 4) write(into, ox + list[i], oy + list[i + 1], oz + list[i + 2], list[i + 3]);
        }
        light(lamp, ox, oy, oz, 0, variant);
      });
      return set;
    };
    const bake = (layer) => {
      const map = layers[layer];
      if (!map.size) return null;
      const geo = { verts: [], faces: [], lines: [], voxel: new Float32Array([U, 0, 0, 0]) };
      // Keep both shells closed where decorative and structural cells touch;
      // filtering one must not leave a hole in the other one's collision.
      let collisionTag = 0;
      const has = (x, y, z) => {
        const cell = map.get(KEY(x, y, z));
        return cell !== undefined && (cell & RAGE_PASS) === collisionTag;
      };
      const emit = (pts, c) => {
        const b = geo.verts.length / 3;
        for (const [x, y, z] of pts) geo.verts.push(x * U, y * U, z * U);
        const ragePass = !!(c & RAGE_PASS); c &= RAGE_PASS - 1;
        const face = { i: [b, b + 1, b + 2, b + 3], color: RGB[c], emissive: layer === GLOW || layer === 4 || layer >= 5 ? EMISSIVE[c] || 0 : 0 };
        if (ragePass) face.ragePass = true;
        geo.faces.push(face);
      };
      voxelFaces((fn) => {
        for (const [k, c] of map) {
          collisionTag = c & RAGE_PASS;
          fn(Math.floor(k / 16777216) - 2048, Math.floor(k / 4096) % 4096 - 2048, k % 4096 - 2048, c);
        }
      }, has, emit);
      if (layer === 3 || layer === 4 || layer === 6) geo.swing = 1;
      return layer === GLOW || layer === 4 || layer >= 5 ? noShadow(geo) : geo;
    };
    const build = () => {
      let solid = bake(SOLID);
      if (meshes.length) {
        const parts = solid ? [solid] : [];
        for (let i = 0; i < meshes.length; i += 6) parts.push(meshAt(meshes[i], meshes[i + 1], meshes[i + 2], meshes[i + 3], meshes[i + 4], meshes[i + 5]));
        solid = merge(...parts);
        meshes.length = 0;
      }
      if (solid && steps.length) {
        solid.gorillaSteps = steps.slice();
        for (const face of solid.faces) {
          const vertices = solid.verts;
          for (const step of steps) {
            let within = true;
            for (const index of face.i) {
              const at = index * 3;
              if (vertices[at] < step[0] - 1e-6 || vertices[at] > step[3] + 1e-6
                || vertices[at + 1] < step[1] - 1e-6 || vertices[at + 1] > step[4] + 1e-6
                || vertices[at + 2] < step[2] - 1e-6 || vertices[at + 2] > step[5] + 1e-6) { within = false; break; }
            }
            if (within) { face.gorillaStep = true; break; }
          }
        }
      }
      const out = { solid, hang: bake(HANG), glow: bake(GLOW), swing: bake(3), swingGlow: bake(4), lampGlow: bake(5), swingLampGlow: bake(6), lights: Float32Array.from(lights), picks: picks.splice(0) };
      for (const layer of layers) layer.clear();
      lights.length = steps.length = 0;
      return out;
    };
    const set = { put, cable, build };
    return set;
  };
  KIT.hanging = (v) => author((put, box) => {
    box(HANG, 0, 0, -3, -1, 0, 0, 5);
    lantern(put, box, 1, -4, 1, GLASS[v]);
  });
  // A festoon bulb: small enough to string across a doorway without closing it.
  KIT.bulb = (v) => author((put, box) => {
    box(HANG, 0, 0, -1, -1, 0, 0, 5);
    box(HANG, -1, 1, -2, -2, -1, 1, 4);
    box(LAMP_GLOW, -1, 1, -5, -3, -1, 1, GLASS[v]);
  });
  // Dust in lamplight: a fixed field of glowing motes that drifts and wraps round a moving centre (the view's
  // target), so there is always air to see near the camera and no mote is ever created or dropped. One draw.
  let moteGeometry = null;
  const motes = ({ count = 220, span = 14, low = 0.4, high = 5 } = {}) => {
    if (!moteGeometry) moteGeometry = noShadow(BL.models.box({ w: 0.035, h: 0.035, d: 0.035, color: "#ffe2a8", emissive: 0.8 }));
    const rand = mulberry32(911), data = new Float32Array(count * 20);
    const bx = new Float32Array(count), by = new Float32Array(count), bz = new Float32Array(count), ph = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      bx[i] = rand() * span; by[i] = low + rand() * (high - low); bz[i] = rand() * span; ph[i] = rand() * 6.283;
      const o = i * 20, s = 0.5 + rand();
      data[o] = s; data[o + 5] = s; data[o + 10] = s; data[o + 15] = 1;
    }
    const node = BL.scene.createNode({ geometry: moteGeometry, instanceData: data, instanceCount: count, instanceVersion: 0, fixedInstanceCapacity: true, glow: 1 });
    const wrap = (v, c) => c - span * 0.5 + ((v - c + span * 0.5) % span + span) % span;
    const update = (elapsed, cx, cz) => {
      for (let i = 0; i < count; i++) {
        const o = i * 20, t = elapsed * 0.25 + ph[i];
        data[o + 12] = wrap(bx[i] + elapsed * 0.08 + Math.sin(t) * 0.4, cx);
        data[o + 13] = by[i] + Math.sin(t * 1.3) * 0.25;
        data[o + 14] = wrap(bz[i] + Math.cos(t * 0.9) * 0.4, cz);
      }
      node.instanceVersion++;
    };
    return { node, update };
  };
  // Palms stand as their own nodes rather than in a set, so the wind can bend each on its own phase; one
  // geometry per variant, every copy instanced. They are smooth cartoon meshes, not voxels: a leaning trunk of
  // tapered eight-sided segments, each flaring out over the one below like a palm's leaf scars; three round
  // coconuts; and a crown of broad fronds, each a V-folded, closed ribbon that rises, arcs over and droops,
  // its edges notched into leaflets, light on top and dark beneath, with three short fronds standing up.
  const TRUNK = ["#9a7148", "#83603c", "#6f4f30"].map(hexToRgb), NUT = hexToRgb("#6b4a26");
  const FROND = ["#3f9a34", "#5fbf3f", "#86d652", "#2c6e2a"].map(hexToRgb);
  const palms = [];
  const palm = (v) => {
    if (palms[v]) return palms[v];
    const geo = { verts: [], faces: [], lines: [] }, rand = mulberry32(700 + v);
    const vert = (x, y, z) => (geo.verts.push(x, y, z), geo.verts.length / 3 - 1);
    const quad = (a, b, c, d, color) => geo.faces.push({ i: [a, b, c, d], color, emissive: 0 });
    const H = 3.9 + v * 0.45, LEAN = 0.8 + v * 0.3, SEG = 10, SIDES = 8;
    const axis = (t) => LEAN * t * t;
    // Trunk: each segment flares at its foot and narrows to its top; a ledge joins it to the segment below.
    let below = null;
    for (let k = 0; k < SEG; k++) {
      const t0 = k / SEG, t1 = (k + 1) / SEG, base = (t) => 0.2 - 0.07 * t;
      const ring = (t, r) => Array.from({ length: SIDES }, (_, e) => {
        const a = e / SIDES * Math.PI * 2;
        return vert(axis(t) + Math.cos(a) * r, H * t, Math.sin(a) * r);
      });
      const foot = ring(t0, base(t0) * 1.18), top = ring(t1, base(t1) * 0.94), color = TRUNK[k % 2 ? 1 : 0];
      for (let e = 0; e < SIDES; e++) {
        const f = (e + 1) % SIDES;
        quad(foot[e], top[e], top[f], foot[f], color);
        if (below) quad(below[e], below[f], foot[f], foot[e], TRUNK[2]);
      }
      below = top;
    }
    const topX = axis(1);
    // Coconuts: low round nuts tucked under the crown.
    for (let n = 0; n < 3; n++) {
      const a = n * 2.1 + 0.4, cx = topX + Math.cos(a) * 0.17, cz = Math.sin(a) * 0.17, cy = H - 0.16, r = 0.13;
      const rows = [];
      for (let i = 0; i <= 4; i++) {
        const p = i / 4 * Math.PI, rr = Math.sin(p) * r, y = cy - Math.cos(p) * r;
        rows.push(Array.from({ length: 6 }, (_, e) => vert(cx + Math.cos(e / 6 * Math.PI * 2) * rr, y, cz + Math.sin(e / 6 * Math.PI * 2) * rr)));
      }
      for (let i = 0; i < 4; i++) for (let e = 0; e < 6; e++) {
        const f = (e + 1) % 6;
        quad(rows[i][e], rows[i + 1][e], rows[i + 1][f], rows[i][f], NUT);
      }
    }
    // A frond: a closed ribbon along an arc, V-folded across its width, notched by alternating widths.
    const frond = (a, len, rise, droop, broad) => {
      const ca = Math.cos(a), sa = Math.sin(a), STEPS = 11, T = 0.035;
      let prev = null;
      for (let k = 0; k <= STEPS; k++) {
        const s = k / STEPS, d = len * s, y = H + 0.08 + rise * d - droop * d * d;
        const w = broad * Math.pow(Math.sin(Math.PI * Math.min(1, (s + 0.1) / 1.05)), 0.7) * (k % 2 ? 0.78 : 1);
        const cx = topX + ca * d, cz = sa * d, px = -sa, pz = ca, sag = w * 0.38;
        const ring = [
          vert(cx + px * w, y - sag, cz + pz * w), vert(cx, y + 0.03, cz), vert(cx - px * w, y - sag, cz - pz * w),
          vert(cx - px * w, y - sag - T, cz - pz * w), vert(cx, y + 0.03 - T, cz), vert(cx + px * w, y - sag - T, cz + pz * w)
        ];
        if (prev) {
          const tone = s < 0.5 ? 0 : 1;
          quad(prev[0], ring[0], ring[1], prev[1], FROND[tone + 1]);
          quad(prev[1], ring[1], ring[2], prev[2], FROND[tone]);
          quad(prev[3], ring[3], ring[4], prev[4], FROND[3]);
          quad(prev[4], ring[4], ring[5], prev[5], FROND[3]);
          quad(prev[2], ring[2], ring[3], prev[3], FROND[3]);
          quad(prev[5], ring[5], ring[0], prev[0], FROND[3]);
        }
        prev = ring;
      }
    };
    for (let f = 0; f < 8; f++) frond(f / 8 * Math.PI * 2 + rand() * 0.35, 2.0 + rand() * 0.5, 0.6, 0.32, 0.3);
    for (let f = 0; f < 3; f++) frond(f / 3 * Math.PI * 2 + 0.5 + rand() * 0.3, 0.9 + rand() * 0.2, 1.1, 0.45, 0.2);
    geo.sway = 0.0035;
    return palms[v] = geo;
  };
  // The islands on the horizon: terraced sea stacks on the island's own grid mesher, two metres a cell, a sand
  // ring at the waterline, rock cliffs and grass tops; variant 1 has a sea arch through it. Built once a page.
  const islets = [];
  const islet = (v) => {
    if (islets[v]) return islets[v];
    const u = 2, S = 40, H = 16 + v * 5, grid = BL.terrain.makeGrid(S, H, S), rand = mulberry32(1200 + v * 7);
    const bumps = Array.from({ length: 6 }, () => [rand() * S, rand() * S, 4 + rand() * 6]);
    const heightAt = (x, z) => {
      const r = Math.hypot(x - S / 2, z - S / 2) / (S / 2);
      let h = (1 - Math.min(1, r) ** 4) * (H - 4) * (0.75 + 0.25 * Math.cos(x * 0.3 + v) * Math.sin(z * 0.25));
      for (const [bx, bz, br] of bumps) h -= Math.max(0, 1 - Math.hypot(x - bx, z - bz) / br) * 6;
      return r > 1 ? 0 : Math.max(1, Math.round(h / 3) * 3 + 1);
    };
    for (let x = 0; x < S; x++) for (let z = 0; z < S; z++) {
      const h = heightAt(x, z), r = Math.hypot(x - S / 2, z - S / 2) / (S / 2);
      for (let y = 0; y < h; y++) {
        if (v === 1 && Math.abs(x - S / 2) < 4 && y > 2 && y < 11) continue;
        const color = y < 2 && r > 0.55 ? (rand() < 0.3 ? 52 : 51) : y === h - 1 && h > 4 ? (rand() < 0.3 ? 29 : 27) : y >= h - 3 && rand() < 0.35 ? 23 : rand() < 0.3 ? 21 : rand() < 0.3 ? 22 : 20;
        grid.set(x, y, z, color + 1);
      }
    }
    const geo = BL.terrain.gridGeometry(grid, { unit: u, palette: [null, ...RGB], origin: { x: -S * u / 2, y: 0, z: -S * u / 2 } });
    geo.castShadow = false;
    islets[v] = geo;
    return geo;
  };
  // The nodes for a baked set: solid (for the caller's collision), hang, decorative glow, lantern glow and swinging layers. All
  // stay out of the sight systems: registering the facades' solids alone cost the hub 140 ms of boot, and dressing
  // needs no outline cue. `glow` sets the lit layers' glow.
  const nodes = (baked, { glow = 0, living = false } = {}) => {
    const out = [];
    const node = (geometry, lit) => geometry && out.push(BL.scene.createNode({ geometry, sightHidden: true, glow: lit ? glow : 0, matrixEmissiveLiving: lit && living }));
    node(baked.solid, false); node(baked.hang, false); node(baked.glow, true); node(baked.swing, false); node(baked.swingGlow, true);
    node(baked.lampGlow, true); node(baked.swingLampGlow, true);
    return out;
  };
  // A gull: a wide shallow V of wings over a white body; flapping is the instance's own vertical scale.
  KIT.gull = () => author((put) => {
    for (let x = -9; x <= 8; x++) {
      const y = Math.round(Math.abs(x + 0.5) * 0.35);
      put(SOLID, x, y, 0, Math.abs(x + 0.5) > 6 ? 5 : 33);
      put(SOLID, x, y, 1, Math.abs(x + 0.5) > 6 ? 5 : 33);
    }
    for (let z = -2; z <= 3; z++) put(SOLID, 0, 0, z, 33);
    put(SOLID, 0, 0, 4, 18);
  });
  // An Ooga raft, bow to +z: five round logs side by side, the middle one longest, lashed by three rope bands, a
  // post mast with a yard across it and a sail hung from the yard. Variant 0 flies a leopard hide stretched to a
  // lower yard, 1 hangs three banana leaves from a trunk-ringed post under a crown with a bunch of bananas, 2 a
  // patched brown hide with a banana on it; 0 and 2 carry a pennant and bananas on deck.
  KIT.boat = (v) => author((put, box) => {
    const BAND = v === 1 ? 50 : 25, BOW = [-2, 0, 3, 0, -2], STERN = [3, 1, 0, 1, 3];
    // Each log is a 3x3 section with its corners cut; cut ends show light end grain.
    for (let i = 0; i < 5; i++) {
      const cx = -6 + i * 3, z0 = -16 + STERN[i], z1 = 13 + BOW[i];
      for (let z = z0; z <= z1; z++) for (let x = cx - 1; x <= cx + 1; x++) for (let y = 0; y <= 2; y++) {
        const end = z === z0 || z === z1;
        if ((x !== cx && y !== 1) || (x === cx && y === 1 && !end)) continue;
        put(SOLID, x, y, z, end ? 1 : i & 1 ? 43 : 0);
      }
    }
    // Rope bands follow the logs' tops and wrap down the outer sides.
    for (const z of [-10, -3, 7]) {
      for (let x = -7; x <= 7; x++) put(SOLID, x, (x + 7) % 3 === 1 ? 3 : 2, z, BAND);
      put(SOLID, -8, 1, z, BAND); put(SOLID, 8, 1, z, BAND);
    }
    box(SOLID, -1, 0, 2, 45, -1, 0, (x, y) => v === 1 ? (y % 4 === 0 ? 44 : 43) : 2);
    box(SOLID, -2, 1, 3, 3, -2, 1, BAND);
    box(SOLID, -9, 8, 40, 40, 2, 2, v === 1 ? 44 : 2);
    if (v === 1) {
      // Three banana leaves hang from the yard, the middle one in front; the side ones splay outward as they fall.
      for (const [cx, bot, z] of [[-5, 16, 2], [5, 16, 2], [0, 13, 3]]) for (let y = bot; y <= 39; y++) {
        const t = (39 - y) / (39 - bot), mid = cx + Math.sign(cx) * Math.round(t * 2);
        const hw = Math.max(0, Math.round(2.8 * Math.sin(Math.PI * (0.12 + 0.88 * t)) - 0.2));
        for (let x = mid - hw; x <= mid + hw; x++) put(HANG, x, y, z, x === mid ? 46 : hw > 1 && Math.abs(x - mid) === hw ? 47 : 45);
      }
      // A crown of two short leaves over the post, and a bunch of bananas behind it.
      for (const s of [-1, 1]) for (let k = 0; k < 8; k++) {
        const y = 44 + Math.round(k * 0.6);
        for (const yy of [y, y + 1]) put(HANG, s * (2 + k), yy, 0, yy === y ? 45 : 46);
      }
      box(SOLID, -1, 0, 31, 34, -3, -2, 49);
      box(SOLID, 0, 0, 35, 36, -2, -2, 48);
      return;
    }
    box(SOLID, -9, 8, 13, 13, 2, 2, 2);
    // The hide between the yards: leopard in clean 2x2 spots on a staggered lattice, or patched brown with a banana.
    const BANANA = ["...........s", "..........s.", ".........##.", "#.......###.", "##.....###..", ".#########..", "..#######...", "....###....."];
    for (let y = 15; y <= 39; y++) for (let x = -8; x <= 7; x++) {
      if ((x === -8 || x === 7) && (y === 15 || y === 39)) continue;
      let c;
      if (v === 0) {
        const j = Math.floor((y - 15) / 4), sx = x + 10 + (j & 1) * 2, i = Math.floor(sx / 5), h = (i * 2 + j) % 3;
        const lx = sx - i * 5 - 1 - (h === 1 ? 1 : 0), ly = y - 15 - j * 4 - (h === 2 ? 1 : 0);
        c = lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1 ? 54 : 53;
      } else {
        const ch = y >= 22 && y <= 29 ? BANANA[29 - y][x + 6] : undefined;
        c = ch === "#" ? 49 : ch === "s" ? 48 : (x <= -4 && y >= 33 && y <= 37) || (x >= 3 && y >= 17 && y <= 20) ? 25 : 42;
      }
      put(HANG, x, y, 2, c);
    }
    for (let k = 0; k < 5; k++) for (let y = 42 + Math.floor(k / 3); y <= 44 - Math.floor(k / 3); y++) put(HANG, 0, y, 2 + k, 19);
    box(SOLID, 2, 3, 2, 3, -9, -8, 49);
    put(SOLID, 3, 4, -8, 48);
  });
  // Seagulls wheeling round a centre on their own circles, heights and speeds; one instanced draw.
  const instanceField = (geometry, count) => BL.scene.createNode({ geometry, instanceData: new Float32Array(count * 20), instanceCount: count, instanceVersion: 0, fixedInstanceCapacity: true, sightHidden: true });
  const writeYaw = (data, o, yaw, sx, sy, sz, x, y, z) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    data[o] = c * sx; data[o + 1] = 0; data[o + 2] = -s * sx; data[o + 3] = 0;
    data[o + 4] = 0; data[o + 5] = sy; data[o + 6] = 0; data[o + 7] = 0;
    data[o + 8] = s * sz; data[o + 9] = 0; data[o + 10] = c * sz; data[o + 11] = 0;
    data[o + 12] = x; data[o + 13] = y; data[o + 14] = z; data[o + 15] = 1;
  };
  let gullGeometry = null, boatGeometry = [];
  const flock = ({ count = 18, cx = 0, cz = 0, radius = [26, 60], height = [14, 34], seed = 5, scale = 1.6 } = {}) => {
    if (!gullGeometry) gullGeometry = noShadow(set().put("gull", 0, 0, 0).build().solid);
    const node = instanceField(gullGeometry, count), rand = mulberry32(seed), data = node.instanceData;
    const r = new Float32Array(count), h = new Float32Array(count), w = new Float32Array(count), p = new Float32Array(count), f = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      r[i] = radius[0] + rand() * (radius[1] - radius[0]); h[i] = height[0] + rand() * (height[1] - height[0]);
      w[i] = (0.05 + rand() * 0.06) * (rand() < 0.5 ? -1 : 1); p[i] = rand() * 6.283; f[i] = 5 + rand() * 3;
    }
    const update = (elapsed) => {
      for (let i = 0; i < count; i++) {
        const a = p[i] + elapsed * w[i], x = cx + Math.cos(a) * r[i], z = cz + Math.sin(a) * r[i];
        const glide = Math.sin(elapsed * 0.3 + p[i]) > 0.2, flap = glide ? 0.6 : 0.3 + Math.abs(Math.sin(elapsed * f[i] + p[i])) * 1.6;
        writeYaw(data, i * 20, Math.atan2(-Math.sin(a) * w[i], Math.cos(a) * w[i]) + Math.PI, scale, flap * scale, scale, x, h[i] + Math.sin(elapsed * 0.5 + p[i]) * 1.5, z);
      }
      node.instanceVersion++;
    };
    update(0);
    return { node, update };
  };
  // Rafts sailing slowly round the island on the sea, rocking on the swell.
  const fleet = ({ sea = -70, spots = [], seed = 9 } = {}) => {
    const nodes = [], rand = mulberry32(seed);
    // Each variant bakes to a logs-and-mast mesh and its sail: two shared geometries (no glow layer).
    for (let v = 0; v < 3; v++) if (!boatGeometry[v]) {
      const baked = set().put("boat", 0, 0, 0, 0, v).build();
      boatGeometry[v] = [baked.solid, baked.hang, baked.glow].filter(Boolean).map(noShadow);
    }
    const boats = spots.map(([r, a, s], i) => {
      const node = BL.scene.createNode({ scale: { x: s, y: s * 0.85, z: s }, sightHidden: true });
      for (const geometry of boatGeometry[i % 3]) BL.scene.addChild(node, BL.scene.createNode({ geometry, sightHidden: true }));
      const seated = (i & 1) === 0;
      const passenger = BL.models.caveman(BL.contributors.traitsFor(`boat-ooga-${i % 2}`));
      const figure = passenger.root, size = 1 / s, deck = 3 * U;
      // Horizon rafts are enlarged scenery; their passengers retain the
      // same world scale and proportions as the Oogas on the island.
      figure.scale.x = figure.scale.z = size;
      figure.scale.y = size / 0.85;
      figure.position.x = seated ? -0.3 : 0.3;
      figure.position.y = deck + figure.scale.y * passenger.traits.height * 5 / 16 * (seated ? 0.4 : 1);
      figure.position.z = -0.65;
      figure.rotation.y = seated ? -0.12 : 0.12;
      passenger.parts.club.visible = false;
      if (seated) {
        passenger.parts.legR.rotation.x = passenger.parts.legL.rotation.x = -1.15;
        passenger.parts.armR.rotation.x = passenger.parts.armL.rotation.x = -0.65;
      }
      figure.sightHidden = true;
      BL.scene.addChild(node, figure);
      return { node, r, a, w: (0.004 + rand() * 0.004) * (i & 1 ? 1 : -1), ph: rand() * 6.3 };
    });
    for (const b of boats) nodes.push(b.node);
    const update = (elapsed) => {
      for (const b of boats) {
        const a = b.a + elapsed * b.w, n = b.node;
        n.position.x = Math.sin(a) * b.r; n.position.z = -Math.cos(a) * b.r; n.position.y = sea - 0.2 + Math.sin(elapsed * 0.9 + b.ph) * 0.25;
        // Bow (local +z) along the orbit: the position's derivative in a is (cos a, sin a), signed by the heading.
        n.rotation.y = b.w > 0 ? Math.PI / 2 - a : -Math.PI / 2 - a;
        n.rotation.z = Math.sin(elapsed * 0.8 + b.ph) * 0.06;
        n.rotation.x = Math.sin(elapsed * 0.6 + b.ph * 2) * 0.04;
      }
    };
    update(0);
    return { nodes, update };
  };
  // Shared static Studio furnishings: one merged mesh per kind, instanced by the renderer.
  const studioCache=new Map();
  const studio=kind=>{
    if(studioCache.has(kind))return studioCache.get(kind);
    const bits=[],b=(c,x,y,z,w,h,d,e=0)=>bits.push(BL.models.box({w,h,d,color:c,emissive:e,offset:{x,y,z}}));
    if(kind==="seat"||kind==="armchair"){
      const plush=kind==="armchair",w=plush?1.65:1.25;
      b("#353039",0,.3,0,w-.2,.6,.8);b(plush?"#424a55":"#75333f",0,.65,0,w,.22,.95);
      b(plush?"#535b66":"#843b46",0,1.12,.45,w,1.05,.25);
      for(const x of [-w/2,w/2])b(plush?"#424a55":"#584236",x,.82,0,.15,plush?.32:.16,1);
    }else if(kind==="mic"){
      // Model feet are 5/16 h below its root; the lower face is another 9/16 h above it.
      const mouth=BL.contributors.traitsFor("YellowBrokeIt").height*14/16-.05;
      b("#30323a",0,.04,0,.8,.08,.65);b("#92949c",0,mouth/2,0,.055,mouth-.08,.055);b("#c0bdb5",0,mouth,0,.2,.26,.2);
      b("#28262e",0,mouth+.02,-.03,.23,.08,.23);
    }else if(kind==="table"||kind==="stool"){
      const table=kind==="table",w=table?2.6:.8,d=table?1.2:.8,h=table?.65:1.05;
      b("#ad794a",0,h,0,w,.17,d);for(const x of [-w*.4,w*.4])for(const z of [-d*.35,d*.35])b("#68462f",x,h/2,z,.1,h,.1);
    }else if(kind==="host-desk"){
      b("#70472f",0,.78,.62,4,1.5,.18);b("#c58d53",0,1.55,0,4.2,.2,1.7);
      for(const x of [-1.85,1.85])b("#70472f",x,.75,0,.22,1.5,1.4);
      for(const x of [-1.4,0,1.4])b("#ad794a",x,.78,.73,1.22,1.15,.06);
      b("#3c3033",0,.12,.73,3.7,.12,.08);b("#f6d7a5",.9,1.81,.1,.25,.3,.25);
      b("#e2caa1",-.6,1.67,0,.75,.04,.5);b("#30323a",-.1,1.69,.4,.3,.07,.25);
      b("#92949c",-.1,1.9,.4,.05,.4,.05);b("#30323a",-.1,2.11,.4,.16,.24,.16);
    }else if(kind==="lounge-table"){
      b("#ad794a",0,.84,0,1,.12,1);b("#68462f",0,.42,0,.16,.84,.16);b("#353039",0,.06,0,.7,.12,.7);
    }else if(kind==="speaker"){
      b("#242530",0,1,0,1.2,2,.8);for(const y of [.5,1.4])b("#494752",0,y,.42,.75,.65,.04);
    }else if(kind==="light"){
      b("#282932",0,0,0,.7,.8,.7);b("#ffce85",0,-.42,0,.52,.06,.5,.8);
    }else if(kind==="wall-lamp"){
      b("#30272a",0,0,0,.32,.66,.12);b("#e7ac5d",0,0,.1,.2,.38,.18,.65);
      for(const y of [-.25,.25])b("#684632",0,y,.12,.32,.1,.25);
    }else if(kind==="jukebox"){
      b("#6a422e",0,1.2,0,1.5,2.4,1.2);b("#302b32",0,1.25,.62,1.25,2.05,.1);
      for(const x of [-.67,.67])b("#ffc568",x,1.3,.7,.12,2.2,.12,.75);
      // Stepped crown suggests a vintage arch without curved geometry or extra draws.
      b("#6a422e",0,2.46,0,1.18,.26,1.2);b("#6a422e",0,2.66,0,.76,.18,1.2);
      for(const [x,y,w] of [[-.55,2.4,.25],[.55,2.4,.25],[-.35,2.6,.28],[.35,2.6,.28],[0,2.7,.45]])b("#e5a64d",x,y,.65,w,.15,.12,.65);
      for(const x of [-.54,.54])b("#70b9ab",x,1.18,.74,.08,1.6,.08,.55);b("#598575",0,1.75,.7,.9,.55,.08,.4);
      for(let i=0;i<7;i++)b("#b78e58",0,.35+i*.12,.72,1,.04,.06);
      for(const x of [-.35,0,.35])b("#e7bf73",x,1.22,.73,.13,.13,.1,.3);
    }
    const geometry=merge(...bits);studioCache.set(kind,geometry);return geometry;
  };
  BL.dressing = { U, PALETTE, KIT, LIGHT_RGB, studio, set, motes, palm, islet, nodes, flock, fleet };
})();

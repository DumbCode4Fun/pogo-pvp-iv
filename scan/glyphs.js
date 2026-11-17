/**
 * Reading the game's text without an OCR library.
 *
 * The grid's text is always the same font, at the same size once the frame is 720 pixels wide, in the
 * same dark slate on a near-white tile. So a line of text is turned into an "ink map" (how much of each
 * pixel is text colour), cut into glyphs where the ink is connected, and each glyph is compared with
 * the stored pictures of known glyphs (the atlas, built from our own recordings by scripts/scan-atlas.mjs).
 *
 * Pure: no DOM, no Node.
 */

/** Tile background and text colour, as measured on recordings from three phones. */
const BG = [253, 253, 250];
const INK = [72, 104, 108];
const SPAN = [BG[0] - INK[0], BG[1] - INK[1], BG[2] - INK[2]];

/**
 * How much of each pixel in the box is text, 0-255. A pixel on the edge of a letter is a blend of text
 * colour and background, so all three channels must agree on the blend; a sprite poking into the line
 * (they do overlap the CP) is dark too but the wrong colour, and comes out as 0.
 */
export function inkMap(frame, x0, y0, w, h) {
  const { data, width, height } = frame;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= width) continue;
      const i = (sy * width + sx) * 4;
      const ar = (BG[0] - data[i]) / SPAN[0];
      const ag = (BG[1] - data[i + 1]) / SPAN[1];
      const ab = (BG[2] - data[i + 2]) / SPAN[2];
      const a = (ar + ag + ab) / 3;
      // darker than the text itself, or off its colour (a grey or black sprite): not text
      if (a < 0.1 || a > 1.16) continue;
      const spread = Math.max(Math.abs(ar - a), Math.abs(ag - a), Math.abs(ab - a));
      if (spread > 0.11) continue;
      out[y * w + x] = a >= 1 ? 255 : Math.round(a * 255);
    }
  }
  return out;
}

/**
 * Connected blobs of ink (8-connected, ink above `level`), left to right. Parts stacked over each other
 * (the dot of an i, an accent) are joined into one glyph unless `join` is off. Each: { x, y, w, h, area, peak }.
 */
export function findGlyphs(map, w, h, { level = 110, join = true } = {}) {
  const label = new Int32Array(w * h);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (map[start] < level || label[start]) continue;
    const id = boxes.length + 1;
    const box = { x0: w, y0: h, x1: 0, y1: 0, area: 0, peak: 0 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const px = p % w;
      const py = (p - px) / w;
      box.area++;
      if (map[p] > box.peak) box.peak = map[p];
      if (px < box.x0) box.x0 = px;
      if (px > box.x1) box.x1 = px;
      if (py < box.y0) box.y0 = py;
      if (py > box.y1) box.y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (map[q] >= level && !label[q]) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    boxes.push(box);
  }
  boxes.sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const b of boxes) {
    const prev = merged[merged.length - 1];
    if (prev && join) {
      const overlap = Math.min(prev.x1, b.x1) - Math.max(prev.x0, b.x0) + 1;
      const narrow = Math.min(prev.x1 - prev.x0, b.x1 - b.x0) + 1;
      const apart = b.y0 > prev.y1 || prev.y0 > b.y1;
      if (apart && overlap >= narrow * 0.5) {
        prev.x0 = Math.min(prev.x0, b.x0);
        prev.x1 = Math.max(prev.x1, b.x1);
        prev.y0 = Math.min(prev.y0, b.y0);
        prev.y1 = Math.max(prev.y1, b.y1);
        prev.area += b.area;
        prev.peak = Math.max(prev.peak, b.peak);
        continue;
      }
    }
    merged.push({ ...b });
  }
  // a blob wholly inside another's box is part of it: the dark middle of the 4 or the 0 on a disc
  const outer = merged.filter((b) => !merged.some((o) => o !== b && o.area > b.area && o.x0 <= b.x0 && o.x1 >= b.x1 && o.y0 <= b.y0 && o.y1 >= b.y1));
  return outer.map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area, peak: b.peak }));
}

/** The ink inside a glyph's box, as its own little map: { w, h, top, data }. `top` is its y in the line. */
export function cutGlyph(map, w, g) {
  const data = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) data.set(map.subarray((g.y + y) * w + g.x, (g.y + y) * w + g.x + g.w), y * g.w);
  return { w: g.w, h: g.h, top: g.y, data };
}

/**
 * How alike two glyph pictures are, 0-1 (cosine of their ink, centred on each other, best of a pixel's
 * shift either way). Different sizes never match: at a fixed scale, size is part of what a glyph is.
 */
export function alike(a, b) {
  if (Math.abs(a.w - b.w) > 2 || Math.abs(a.h - b.h) > 2) return 0;
  const W = Math.max(a.w, b.w) + 2;
  const H = Math.max(a.h, b.h) + 2;
  const ax = (W - a.w) >> 1;
  const ay = (H - a.h) >> 1;
  const bx0 = (W - b.w) >> 1;
  const by0 = (H - b.h) >> 1;
  let aa = 0;
  for (let i = 0; i < a.data.length; i++) aa += a.data[i] * a.data[i];
  let bb = 0;
  for (let i = 0; i < b.data.length; i++) bb += b.data[i] * b.data[i];
  if (!aa || !bb) return 0;
  let best = 0;
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      const bx = bx0 + sx;
      const by = by0 + sy;
      // overlap of the two boxes on the shared canvas
      const x0 = Math.max(ax, bx);
      const x1 = Math.min(ax + a.w, bx + b.w);
      const y0 = Math.max(ay, by);
      const y1 = Math.min(ay + a.h, by + b.h);
      let ab = 0;
      for (let y = y0; y < y1; y++) {
        let ia = (y - ay) * a.w + (x0 - ax);
        let ib = (y - by) * b.w + (x0 - bx);
        for (let x = x0; x < x1; x++) ab += a.data[ia++] * b.data[ib++];
      }
      if (ab > best) best = ab;
    }
  }
  return best / Math.sqrt(aa * bb);
}

/**
 * The best atlas entry for a glyph: { ch, score, second }. `set` is the atlas's list for this kind of
 * line (entries { ch, w, h, top, data }). Entries sitting more than `rise` pixels higher or lower in
 * the line are skipped, which is what tells a superscript from a full-size digit of the same shape.
 */
export function classify(glyph, set, rise = 4) {
  let best = { ch: '', score: 0 };
  let second = 0;
  for (const t of set) {
    if (Math.abs(t.top - glyph.top) > rise) continue;
    const s = alike(glyph, t);
    if (s > best.score) {
      if (t.ch !== best.ch) second = best.score;
      best = { ch: t.ch, score: s };
    } else if (s > second && t.ch !== best.ch) second = s;
  }
  return { ...best, second };
}

/** The best `n` different glyphs for a picture, best first: [{ ch, score }]. */
export function rank(glyph, set, rise = 4, n = 3) {
  const best = new Map();
  for (const t of set) {
    if (Math.abs(t.top - glyph.top) > rise) continue;
    const s = alike(glyph, t);
    if (s > (best.get(t.ch) ?? 0)) best.set(t.ch, s);
  }
  return [...best]
    .map(([ch, score]) => ({ ch, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/**
 * Long names are drawn smaller so they fit the tile, about its vertical middle. The atlas holds glyphs
 * at full size; this gives the same set as it looks at scale `s` (cached per set). `centre` is the row
 * of the line the text shrinks towards.
 */
const scaled = new WeakMap();
export function scaledSet(set, s, centre = 26) {
  if (s === 1) return set;
  let byScale = scaled.get(set);
  if (!byScale) scaled.set(set, (byScale = new Map()));
  if (byScale.has(s)) return byScale.get(s);
  const list = set.map((t) => {
    const w = Math.max(1, Math.round(t.w * s));
    const h = Math.max(1, Math.round(t.h * s));
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      // area sampling: average the source pixels each target pixel covers
      const y0 = (y * t.h) / h;
      const y1 = ((y + 1) * t.h) / h;
      for (let x = 0; x < w; x++) {
        const x0 = (x * t.w) / w;
        const x1 = ((x + 1) * t.w) / w;
        let sum = 0;
        let area = 0;
        for (let sy = Math.floor(y0); sy < Math.min(t.h, Math.ceil(y1)); sy++) {
          const hy = Math.min(y1, sy + 1) - Math.max(y0, sy);
          for (let sx = Math.floor(x0); sx < Math.min(t.w, Math.ceil(x1)); sx++) {
            const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
            sum += t.data[sy * t.w + sx] * wx * hy;
            area += wx * hy;
          }
        }
        data[y * w + x] = area ? Math.round(sum / area) : 0;
      }
    }
    return { ch: t.ch, w, h, top: Math.round(centre + (t.top - centre) * s), data };
  });
  byScale.set(s, list);
  return list;
}

/**
 * An i is an l with a two-pixel gap under its dot, which a whole-picture comparison barely notices.
 * True when a narrow upright glyph has that gap in its upper part.
 */
export function hasDotGap(pic) {
  if (pic.w > 7 || pic.h < 10) return false;
  const rows = [];
  for (let y = 0; y < pic.h; y++) {
    let sum = 0;
    for (let x = 0; x < pic.w; x++) sum += pic.data[y * pic.w + x];
    rows.push(sum);
  }
  const body = rows.slice(Math.floor(pic.h / 2), pic.h - 2).sort((a, b) => a - b);
  const stem = body[body.length >> 1];
  let gap = Infinity;
  for (let y = 2; y <= Math.round(pic.h * 0.42); y++) gap = Math.min(gap, rows[y]);
  return gap < stem * 0.5;
}

/**
 * A blob that matches no glyph is usually two or more letters touching ("rt", "ff", a letter against a
 * circled digit). This tries every way of cutting it into vertical slices and keeps the one whose
 * slices all read best. `read(pic)` returns { ch, score } for one slice. Returns the slices, left to
 * right, as [{ ch, score, x, w }], or null when no cutting reads.
 */
export function splitGlyph(map, w, g, read, { level = 110, minW = 2, maxW = 32, floor = 0.72 } = {}) {
  const n = g.w;
  // the ink box of columns a..b-1 of the blob, or null if that slice is empty
  const slice = (a, b) => {
    let x0 = -1;
    let x1 = -1;
    let y0 = g.h;
    let y1 = -1;
    for (let x = a; x < b; x++) {
      for (let y = 0; y < g.h; y++) {
        if (map[(g.y + y) * w + g.x + x] >= level) {
          if (x0 < 0) x0 = x;
          x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x0 < 0) return null;
    // keep to the slice's columns, but take the rows' ink as it is (the neighbour's edge is cut away)
    return cutGlyph(map, w, { x: g.x + x0, y: g.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  };
  // glyphs touch by a pixel or two, so a cut can only be where a column holds little ink
  const cols = [];
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let y = 0; y < g.h; y++) sum += map[(g.y + y) * w + g.x + x];
    cols.push(sum);
  }
  const typical = [...cols].sort((a, b) => a - b)[n >> 1];
  const canCut = (x) => x === 0 || x === n || Math.min(cols[x - 1], cols[x]) <= typical * 0.62;
  const best = new Array(n + 1).fill(null);
  best[0] = { total: 0, parts: [] };
  for (let b = minW; b <= n; b++) {
    if (!canCut(b)) continue;
    for (let a = Math.max(0, b - maxW); a <= b - minW; a++) {
      if (!best[a] || !canCut(a)) continue;
      const pic = slice(a, b);
      if (!pic) continue;
      const c = read(pic);
      if (c.score < floor) continue;
      const total = best[a].total + (c.score - 0.6) * (b - a);
      if (!best[b] || total > best[b].total) best[b] = { total, parts: [...best[a].parts, { ch: c.ch, score: c.score, x: g.x + a, w: b - a }] };
    }
  }
  return best[n] ? best[n].parts : null;
}

// ---------------------------------------------------------------- circled digits

/**
 * The Nicknamer writes IVs as white digits on dark discs. A disc is a blob about as wide as it is tall
 * and mostly filled, which no letter is (an O is a ring).
 */
export function isDisc(pic) {
  if (pic.h < 17 || pic.h > 32 || Math.abs(pic.w - pic.h) > 3) return false;
  let sum = 0;
  for (let i = 0; i < pic.data.length; i++) sum += pic.data[i];
  if (sum / (255 * pic.data.length) <= 0.5) return false;
  // a round thing leaves the corners of its box empty; a bold N or M fills them
  const at = (x, y) => pic.data[y * pic.w + x];
  const corner = (x, y, dx, dy) => at(x, y) + at(x + dx, y) + at(x, y + dy) + at(x + dx, y + dy);
  const w = pic.w - 1;
  const h = pic.h - 1;
  return Math.max(corner(0, 0, 1, 1), corner(w, 0, -1, 1), corner(0, h, 1, -1), corner(w, h, -1, -1)) < 4 * 70;
}

/**
 * A typed "●" (some players mark Pokémon with one after the name): a small filled round blob at letter
 * height. Smaller than a Nicknamer disc, and solid where an o is a ring.
 */
export function isDot(pic) {
  if (pic.h < 9 || pic.h > 15 || Math.abs(pic.w - pic.h) > 2) return false;
  let sum = 0;
  for (let i = 0; i < pic.data.length; i++) sum += pic.data[i];
  if (sum / (255 * pic.data.length) < 0.68) return false;
  // solid in the middle, where an o or an e has its hole
  const mid = pic.data[(pic.h >> 1) * pic.w + (pic.w >> 1)];
  const corner = pic.data[0] + pic.data[pic.w - 1] + pic.data[(pic.h - 1) * pic.w] + pic.data[pic.h * pic.w - 1];
  return mid >= 200 && corner < 4 * 90;
}

/** The white digit inside a disc, as a picture of its own (ink = where the disc is *not* dark). */
export function discHole(pic) {
  const data = new Uint8Array(pic.w * pic.h);
  const cx = (pic.w - 1) / 2;
  const cy = (pic.h - 1) / 2;
  const r = Math.min(pic.w, pic.h) / 2 - 3;
  for (let y = 0; y < pic.h; y++) {
    for (let x = 0; x < pic.w; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) data[y * pic.w + x] = 255 - pic.data[y * pic.w + x];
    }
  }
  return { w: pic.w, h: pic.h, top: pic.top, data };
}

/** Atlas entries are stored as base64 so the atlas is one JSON file; this gives them their bytes. */
export function loadAtlas(json) {
  const bytes = (b64) => {
    const text = atob(b64);
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  };
  const out = {};
  for (const [kind, list] of Object.entries(json.sets)) out[kind] = list.map((t) => ({ ...t, data: bytes(t.data) }));
  out.badges = {};
  for (const [name, shape] of Object.entries(json.badges ?? {})) out.badges[name] = { ...shape, data: bytes(shape.data) };
  return out;
}

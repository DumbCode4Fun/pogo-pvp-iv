/**
 * One tile of the storage grid: where its parts are, and reading them.
 *
 * A tile is placed by its column (0-2) and the y of its HP bar, as track.js reports it. From the top:
 * the CP line, the sprite (with badges around it), the name line, the HP bar.
 *
 * Pure: no DOM, no Node.
 */
import { COLS, BUTTONS } from './track.js';
import { inkMap, findGlyphs, cutGlyph, classify, rank, splitGlyph, isDisc, isDot, discHole, scaledSet, hasDotGap } from './glyphs.js';
import { CIRCLED, SUPERSCRIPT, UNREAD_DISC } from './resolve.js';

/** Boxes relative to the column centre (x) and the HP bar's first row (y). */
export const CP_BOX = { x: -112, y: -218, w: 224, h: 50 };
export const NAME_BOX = { x: -114, y: -52, w: 228, h: 48 };
export const SPRITE_BOX = { x: -80, y: -170, w: 160, h: 120 };
/** A tile needs this much room above its bar, and this much below, to be whole. */
export const TILE_ABOVE = 218;
export const TILE_BELOW = 8;

/** A glyph matching its atlas entry at least this well is taken at face value. */
const SURE = 0.9;
/** Below this a glyph is reported as '?'. */
const FLOOR = 0.74;

/**
 * Whether the whole tile is on screen and clear of the header and the floating buttons (they only
 * cover the middle and right columns).
 */
export function tileVisible(frame, col, barY, headerBottom) {
  if (barY - TILE_ABOVE < headerBottom + 10) return false;
  if (barY + TILE_BELOW > frame.height - (col === 0 ? 6 : BUTTONS)) return false;
  return true;
}

/**
 * The fast-scroll handle slides down the right edge and washes out whatever it passes over. Only the
 * end of a long name in the right column reaches under it: true when this reading is one of those.
 */
export function underHandle(col, barY, handle, name) {
  if (col !== 2 || !handle || handle.y1 <= barY + NAME_BOX.y || handle.y0 >= barY) return false;
  return name.glyphs.some((g) => g.x + g.w > HANDLE_EDGE);
}
/** Where the handle's edge falls in the right column's name box. */
const HANDLE_EDGE = 164;

/** A tile's two text lines as ink maps, and its badge regions: { cp: { map, w, h }, name: { map, w, h }, badges }. */
export function tileLines(frame, col, barY) {
  const y = Math.round(barY);
  const cx = COLS[col];
  return {
    cp: { map: inkMap(frame, cx + CP_BOX.x, y + CP_BOX.y, CP_BOX.w, CP_BOX.h), w: CP_BOX.w, h: CP_BOX.h },
    name: { map: inkMap(frame, cx + NAME_BOX.x, y + NAME_BOX.y, NAME_BOX.w, NAME_BOX.h), w: NAME_BOX.w, h: NAME_BOX.h },
    badges: tileBadges(frame, col, barY),
  };
}

// ---------------------------------------------------------------- badges

/**
 * Where the badges sit, relative to the column centre and the HP bar, and how to tell their colour:
 *   dynamax     a pale pink outlined X behind the sprite, up and to the right
 *   gigantamax  the same X filled in a deeper rose
 *   shadow      a purple flame at the sprite's lower left
 */
export const BADGES = {
  dynamax: { x: 0, y: -185, w: 90, h: 85, is: (r, g, b) => r >= 225 && g >= 160 && g <= 230 && b >= 180 && r - g >= 20 && b - g >= 4 },
  gigantamax: { x: 0, y: -185, w: 90, h: 85, is: (r, g, b) => r >= 190 && r <= 240 && g >= 110 && g <= 165 && b >= 145 && b <= 195 && r - g >= 50 },
  shadow: { x: -80, y: -110, w: 60, h: 65, is: (r, g, b) => b >= 215 && r >= 180 && r <= 230 && g >= 145 && g <= 200 && b - g >= 40 && b - r >= 12 },
};

/** For each badge, which pixels of its region have its colour: { dynamax: Uint8Array, ... } (0 or 255). */
export function tileBadges(frame, col, barY) {
  const { data, width, height } = frame;
  const y0 = Math.round(barY);
  const out = {};
  for (const [name, b] of Object.entries(BADGES)) {
    const mask = new Uint8Array(b.w * b.h);
    for (let y = 0; y < b.h; y++) {
      const sy = y0 + b.y + y;
      if (sy < 0 || sy >= height) continue;
      for (let x = 0; x < b.w; x++) {
        const sx = COLS[col] + b.x + x;
        if (sx < 0 || sx >= width) continue;
        const i = (sy * width + sx) * 4;
        if (b.is(data[i], data[i + 1], data[i + 2])) mask[y * b.w + x] = 255;
      }
    }
    out[name] = mask;
  }
  return out;
}

/**
 * How much each region looks like its badge, 0-1: the coloured pixels compared with the badge's stored
 * shape. A pink sprite fills the region with the right colour but not the X's shape, and scores low.
 */
export function readBadges(masks, atlas) {
  const out = {};
  for (const name of Object.keys(BADGES)) {
    const shape = atlas.badges?.[name];
    const mask = masks[name];
    if (!shape || !mask) {
      out[name] = 0;
      continue;
    }
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < mask.length; i++) {
      ab += mask[i] * shape.data[i];
      aa += mask[i] * mask[i];
      bb += shape.data[i] * shape.data[i];
    }
    out[name] = aa && bb ? ab / Math.sqrt(aa * bb) : 0;
  }
  return out;
}

/** A badge is there when its region matches its shape at least this well. */
export const BADGE_LEVEL = 0.5;

/** A copy of a line with everything outside rows y0..y1 blanked. */
function band(line, y0, y1) {
  const map = new Uint8Array(line.map.length);
  map.set(line.map.subarray(y0 * line.w, (y1 + 1) * line.w), y0 * line.w);
  return { map, w: line.w, h: line.h };
}

/** The CP digits sit in these rows of the CP box; below them the sprite can poke in. */
const CP_ROWS = [8, 45];
const DIGIT_HEIGHT = 30;
/** Name text, superscripts and accents sit in these rows of the name box; above is the sprite. */
const NAME_ROWS = [6, 47];

/** The blobs of the CP line that can be digits (the small, paler "CP" label is left out). */
export function cpGlyphs(line) {
  const b = band(line, CP_ROWS[0], CP_ROWS[1]);
  return findGlyphs(b.map, b.w, b.h, { join: false })
    .filter((g) => g.h >= 20 && g.peak >= 200)
    .map((g) => ({ ...g, pic: cutGlyph(b.map, b.w, g), line: b }));
}

/**
 * The blobs of the name line. Left out: specks; anything running the full height of the line (a sprite
 * or an overlay bubble at the screen's edge poking in); and the tag icon in front of a tagged Pokémon's
 * name, which is drawn paler than text.
 */
export function nameGlyphs(line) {
  const b = band(line, NAME_ROWS[0], NAME_ROWS[1]);
  const glyphs = findGlyphs(b.map, b.w, b.h)
    .filter((g) => g.area >= 5 && g.peak >= 170 && g.y + g.h > 12)
    .filter((g) => !(g.h > 32 || (g.y <= NAME_ROWS[0] && g.h > 24) || ((g.x === 0 || g.x + g.w === b.w) && g.h > 22 && g.w < 14)))
    .map((g) => ({ ...g, pic: cutGlyph(b.map, b.w, g), line: b }));
  if (glyphs.length > 1 && glyphs[0].peak < 225 && glyphs[1].peak >= 240 && glyphs[0].w <= 20) glyphs.shift();
  return glyphs;
}

/**
 * Reads the CP: { text, score, glyphs }. text is digits, with '?' for a blob next to the digits that
 * could not be read; '' when there is no CP here (an empty slot past the end of the box). score is the
 * weakest digit's match, 0-1.
 */
export function readCp(line, atlas) {
  const read = (pic) => classify(pic, atlas.cp, 8);
  const out = [];
  for (const g of cpGlyphs(line)) {
    const c = read(g.pic);
    if (c.score >= SURE) {
      out.push({ ch: c.ch, score: c.score, x: g.x, w: g.w, top: g.y });
      continue;
    }
    const parts = g.w > 14 ? splitGlyph(g.line.map, g.line.w, g, read, { minW: 8, maxW: 26 }) : null;
    if (parts && Math.min(...parts.map((p) => p.score)) > c.score) out.push(...parts.map((p) => ({ ...p, top: g.y })));
    else out.push({ ch: c.score >= FLOOR ? c.ch : '?', score: c.score, x: g.x, w: g.w, top: g.y, blob: g });
  }
  // A sprite reaching up from below can touch a digit (Giratina's tails do). The digits all start on the
  // same row and are the same height, so cut the blob to those rows and read what is left.
  const good = out.filter((o) => o.ch !== '?' && o.score >= SURE).map((o) => o.top);
  if (good.length) {
    const top = good.sort((a, b) => a - b)[good.length >> 1];
    for (const o of out) {
      if (o.ch !== '?' || !o.blob) continue;
      const g = o.blob;
      const y1 = Math.min(g.y + g.h, top + DIGIT_HEIGHT);
      const cut = findGlyphs(band(g.line, Math.max(g.y, top - 1), y1 - 1).map, g.line.w, g.line.h, { join: false }).filter((k) => k.x >= g.x && k.x < g.x + g.w && k.h >= 20);
      if (cut.length !== 1) continue;
      const c = read(cutGlyph(band(g.line, Math.max(g.y, top - 1), y1 - 1).map, g.line.w, cut[0]));
      if (c.score >= 0.82) Object.assign(o, { ch: c.ch, score: c.score * 0.95 });
    }
  }
  // junk well to either side of the number (a badge, a sprite's edge) is not part of it; an unread
  // blob right next to a digit is kept as '?', because it is probably a digit with something over it
  const far = (a, b) => b.x - (a.x + a.w) > 14;
  while (out.length > 1 && out[0].ch === '?' && far(out[0], out[1])) out.shift();
  while (out.length > 1 && out[out.length - 1].ch === '?' && far(out[out.length - 2], out[out.length - 1])) out.pop();
  if (out.length && out.every((o) => o.ch === '?')) out.length = 0;
  return { text: out.map((o) => o.ch).join(''), score: out.length ? Math.min(...out.map((o) => o.score)) : 0, glyphs: out.map(({ blob, ...o }) => o) };
}

/** Scales a name can be drawn at; long names shrink to fit the tile. */
const SCALES = [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68, 0.64, 0.6];
/** A name narrower than this is at full size; at this width it may have been shrunk to fit. */
const FULL_WIDTH = 176;
/** The row of the name box that names shrink towards. */
const NAME_MIDDLE = 26;
const DISC_HEIGHT = 28.3;
const TALL_HEIGHT = 21;

/** One name-line blob: a circled digit is read by the digit inside it, anything else as a glyph. */
function readNameGlyph(pic, sets) {
  if (isDisc(pic)) {
    const ranked = rank(discHole(pic), sets.disc, 6, 3);
    const best = ranked[0] ?? { ch: UNREAD_DISC, score: 0 };
    // being a disc at all is most of the evidence; which digit it is, is the score
    return { ch: best.score >= 0.6 ? best.ch : UNREAD_DISC, score: best.score, disc: true, alts: ranked };
  }
  if (isDot(pic)) return { ch: '●', score: SURE };
  const c = classify(pic, sets.name, 5);
  // a superscript digit: keep the runners-up, the % is checked against the IVs later
  if (SUPERSCRIPT.includes(c.ch)) c.alts = rank(pic, sets.name, 5, 6).filter((a) => SUPERSCRIPT.includes(a.ch)).slice(0, 3);
  if (c.ch === 'i' || c.ch === 'l' || c.ch === 'I') {
    const dotted = hasDotGap(pic);
    if (dotted && c.ch !== 'i') c.ch = 'i';
    else if (!dotted && c.ch === 'i') c.ch = 'l';
  }
  return c;
}

/**
 * When a name ends in the Nicknamer's badge (three discs, then the % in superscript), the runners-up for
 * each of those glyphs: { discs: [[{ ch, score }]], pct: [[{ ch, score }]] }. A 12 and a 13 look alike on
 * a name drawn small, and so do a superscript 6 and 8, so the reading alone is not the last word:
 * resolve.js picks the combination that also fits the CP and agrees with itself. Null without a badge.
 */
function ivBadge(glyphs) {
  const d = glyphs.findIndex((g) => g.disc);
  if (d < 0 || !glyphs[d + 1]?.disc || !glyphs[d + 2]?.disc || glyphs[d + 3]?.disc) return null;
  const tail = glyphs.slice(d + 3);
  if (tail.length > 3) return null;
  const options = (g) => (g.alts ?? [{ ch: g.ch, score: g.score }]).filter((a) => a.score >= g.score - 0.2).map((a) => ({ ch: a.ch, score: Number(a.score.toFixed(3)) }));
  return { discs: glyphs.slice(d, d + 3).map(options), pct: tail.map(options) };
}

function readNameAt(blobs, atlas, scale) {
  const sets = { name: scaledSet(atlas.name ?? [], scale), disc: scaledSet(atlas.disc ?? [], scale) };
  const read = (pic) => readNameGlyph(pic, sets);
  const out = [];
  for (const g of blobs) {
    const c = read(g.pic);
    if (c.disc || c.score >= SURE) {
      out.push({ ch: c.ch, score: c.score, x: g.x, w: g.w, disc: Boolean(c.disc), alts: c.alts });
      continue;
    }
    const parts = g.w >= 8 ? splitGlyph(g.line.map, g.line.w, g, read, { maxW: Math.ceil(32 * scale) }) : null;
    if (parts && Math.min(...parts.map((p) => p.score)) > c.score) out.push(...parts.map((p) => ({ ...p, disc: Boolean(p.disc) })));
    else if (c.score < FLOOR && g.w <= 5 && g.h <= 6 && !out.some((o) => o.disc)) {
      // a dot too small to match anything: a full stop on the baseline ("Mr. Mime"), an apostrophe up top
      out.push({ ch: g.y + g.h / 2 > NAME_MIDDLE ? '.' : "'", score: SURE, x: g.x, w: g.w });
    } else out.push({ ch: c.score >= FLOOR ? c.ch : '?', score: c.score, x: g.x, w: g.w, alts: c.alts });
  }
  const kept = out.filter((o) => o.ch !== '');
  // a capital I and a small l are the same stroke in this font; at the start of a name it is the capital
  if (kept.length > 1 && kept[0].ch === 'l' && /^\p{Ll}$/u.test(kept[1].ch)) kept[0].ch = 'I';
  const total = kept.reduce((sum, o) => sum + (o.ch === '?' ? 0 : o.score), 0);
  return {
    text: kept.map((o) => o.ch).join(''),
    score: kept.length ? Math.min(...kept.map((o) => (o.ch === '?' ? 0 : o.score))) : 0,
    quality: kept.length ? total / kept.length : 0,
    scale,
    badge: ivBadge(kept),
    glyphs: kept.map(({ alts, ...o }) => o),
  };
}

/**
 * Reads the name line: { text, score, scale, badge, glyphs }. Circled digits come back as the
 * Nicknamer's own characters (⓿ ❶-❿ ⓫-⓯), an unreadable disc as ◌, superscripts as ⁰-⁹, anything
 * unreadable as '?'. `badge` holds the runners-up for the IV glyphs (see ivBadge), or null.
 */
export function readName(line, atlas) {
  const blobs = nameGlyphs(line);
  if (!blobs.length) return { text: '', score: 0, scale: 1, badge: null, glyphs: [] };
  const left = Math.min(...blobs.map((g) => g.x));
  const right = Math.max(...blobs.map((g) => g.x + g.w));
  let first = [1];
  if (right - left >= FULL_WIDTH) {
    // shrunk to fit, by an unknown amount: the tallest blob is a disc or a capital, so two guesses
    const discs = blobs.filter((g) => isDisc(g.pic));
    const tall = Math.max(...blobs.map((g) => g.h));
    const guesses = discs.length ? [Math.max(...discs.map((g) => g.h)) / DISC_HEIGHT] : [tall / DISC_HEIGHT, tall / TALL_HEIGHT];
    const near = new Set([1]);
    for (const guess of guesses) for (const s of SCALES) if (Math.abs(s - guess) <= 0.045) near.add(s);
    first = [...near];
  }
  let best = null;
  const attempt = (scales) => {
    for (const scale of scales) {
      const r = readNameAt(blobs, atlas, scale);
      if (!best || r.quality > best.quality) best = r;
      if (scale === 1 && r.score >= SURE) return true;
    }
    return best.score >= 0.84;
  };
  // the guesses are usually right; when none reads well, every scale gets a turn
  if (!attempt(first) && right - left >= FULL_WIDTH - 12) attempt(SCALES.filter((s) => !first.includes(s)));
  return best;
}

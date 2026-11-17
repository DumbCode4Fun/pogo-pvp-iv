/**
 * Turning a recording of someone scrolling their Pokémon storage into a list of tiles.
 *
 *   const scanner = createScanner({ atlas });
 *   for each frame, in order:  scanner.feed({ data, width: 720, height })     // RGBA
 *   const { tiles, stats } = scanner.finish();
 *
 * Each tile is read on the few frames where it is whole and the grid is moving least (video compression
 * smears text while it scrolls), and the readings are put to a vote. Nothing here knows about species:
 * a tile is { row, col, cp, name, ... } with the text as the game drew it. resolve.js does the rest.
 *
 * Pure: no DOM, no Node. The frames come from ffmpeg in scripts/scan-video.mjs, or from the browser.
 */
import { createTracker, BUTTONS } from './track.js';
import { tileVisible, tileLines, readCp, readName, readBadges, underHandle, BADGES, BADGE_LEVEL, TILE_ABOVE, TILE_BELOW } from './tile.js';

/** Unrest (pixels of recent movement) under which text is sharp, and over which it is too smeared to bother. */
const SETTLED = 12;
const BLURRED = 45;
/** Added to the unrest of a reading taken through the scroll handle, so any clear reading beats it. */
const COVERED = 1000;

/** Readings agree by text; a still frame and a confident reading weigh more. */
function vote(reads, field) {
  const groups = new Map();
  for (const r of reads) {
    const v = r[field];
    if (!v) continue;
    const g = groups.get(v.text) ?? { text: v.text, weight: 0, score: 0, n: 0, badge: null };
    g.weight += Math.max(0.05, v.score - 0.5) / (1 + r.q / 20);
    if (v.score >= g.score) {
      g.score = v.score;
      g.badge = v.badge ?? null;
    }
    g.n++;
    groups.set(v.text, g);
  }
  let best = null;
  for (const g of groups.values()) if (!best || g.weight > best.weight) best = g;
  return best ?? { text: '', weight: 0, score: 0, n: 0 };
}

/**
 * atlas: from loadAtlas(glyph-atlas.json). Without one nothing is read, which is only useful with
 * keepLines (the atlas builder collects the text lines to learn glyphs from).
 * reads: how many readings to keep per tile.
 * onBest(key, col, y, frame): called when a tile's best reading so far comes from the frame just fed,
 * so the caller can keep a picture of the tile (key is the tile's `key` in finish()).
 */
export function createScanner({ atlas = null, reads: keep = 3, keepLines = false, onBest = null } = {}) {
  const tracker = createTracker();
  const tiles = new Map();
  const stats = { frames: 0, gridFrames: 0, unsure: 0, readings: 0 };
  let unrest = 0;
  let heading = 1;

  function feed(frame) {
    const frameIndex = stats.frames++;
    const step = tracker.step(frame);
    if (!step) return null;
    stats.gridFrames++;
    if (!step.sure) stats.unsure++;
    // How unsettled the picture is. A recording often holds each game frame twice, so "did not move
    // since the last frame" says little; what blurs text is recent movement, and it takes the encoder
    // several frames to sharpen up after the grid stops. So: the latest movement, fading by frame.
    unrest = Math.max(Math.abs(step.moved), unrest * 0.75);
    if (step.moved) heading = Math.sign(step.moved);
    const q = unrest < 0.5 ? 0 : unrest;
    for (const row of step.rows) {
      for (let col = 0; col < 3; col++) {
        if (!tileVisible(frame, col, row.y, step.headerBottom)) continue;
        const key = `${row.index},${col}`;
        let tile = tiles.get(key);
        if (!tile) tiles.set(key, (tile = { row: row.index, col, reads: [], lines: null, sure: true }));
        if (!step.sure) tile.sure = false;
        // the same picture again teaches nothing; a stiller one, or the same stillness elsewhere on screen, does
        if (tile.reads.some((r) => r.q % COVERED <= q && Math.abs(r.y - row.y) < 2)) continue;
        // Reading is the slow part. While the grid is still unsettled a tile is read once, so that it
        // is not lost if it never comes to rest, and not even that while it is flying past with frames
        // to spare before it leaves the screen. The readings that count come once things have settled.
        if (q > SETTLED) {
          if (tile.reads.length) continue;
          const leaving = heading > 0 ? row.y - TILE_ABOVE - 2 * unrest < step.headerBottom + 10 : row.y + TILE_BELOW + 2 * unrest > frame.height - (col === 0 ? 6 : BUTTONS);
          if (q > BLURRED && !leaving) continue;
        }
        const worst = tile.reads[tile.reads.length - 1];
        if (tile.reads.length >= keep && !(q < worst.q * 0.4 || (q === 0 && worst.q > 0))) continue;
        const lines = tileLines(frame, col, row.y);
        const reading = { q, y: row.y, frame: frameIndex };
        if (atlas) {
          reading.cp = readCp(lines.cp, atlas);
          reading.name = readName(lines.name, atlas);
          reading.badges = readBadges(lines.badges, atlas);
          // a name read through the scroll handle only counts when there is nothing better
          if (underHandle(col, row.y, step.handle, reading.name)) reading.q = q + COVERED;
        }
        stats.readings++;
        if (tile.reads.length >= keep) tile.reads.pop();
        tile.reads.push(reading);
        tile.reads.sort((a, b) => a.q - b.q);
        if (keepLines && tile.reads[0] === reading) tile.lines = lines;
        if (onBest && tile.reads[0] === reading) onBest(key, col, row.y, frame);
      }
    }
    return step;
  }

  function finish() {
    const out = [];
    for (const tile of tiles.values()) {
      const cp = vote(tile.reads, 'cp');
      const name = vote(tile.reads, 'name');
      // an empty slot (the row past the last Pokémon) has neither; without an atlas everything is kept
      if (atlas && !cp.text && !name.text) continue;
      const badges = {};
      for (const name of Object.keys(BADGES)) {
        const scores = tile.reads.map((r) => r.badges?.[name] ?? 0).sort((a, b) => a - b);
        badges[name] = scores.length ? scores[scores.length >> 1] : 0;
      }
      out.push({
        key: `${tile.row},${tile.col}`,
        row: tile.row,
        col: tile.col,
        cp: cp.text,
        cpScore: cp.score,
        name: name.text,
        nameScore: name.score,
        badge: name.badge ?? null,
        covered: tile.reads.length > 0 && tile.reads[0].q >= COVERED,
        shadow: badges.shadow >= BADGE_LEVEL,
        dynamax: badges.dynamax >= BADGE_LEVEL || badges.gigantamax >= BADGE_LEVEL,
        gigantamax: badges.gigantamax >= BADGE_LEVEL,
        badges,
        y: tile.reads.length ? tile.reads[0].y : null,
        readings: tile.reads.length,
        moving: tile.reads.length ? tile.reads[0].q % COVERED : null,
        frame: tile.reads.length ? tile.reads[0].frame : null,
        sure: tile.sure,
        ...(keepLines ? { lines: tile.lines } : {}),
      });
    }
    out.sort((a, b) => a.row - b.row || a.col - b.col);
    const first = out.length ? out[0].row : 0;
    for (const t of out) t.row -= first;
    return { tiles: out, stats: { ...stats, pitch: tracker.pitch, segments: tracker.segments } };
  }

  return { feed, finish };
}

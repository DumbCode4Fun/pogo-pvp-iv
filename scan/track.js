/**
 * Following the storage grid through a screen recording.
 *
 * Every frame must be RGBA and exactly WIDTH pixels wide (the caller resizes); the game lays the grid
 * out in proportion to the screen width, so at one fixed width every number below holds on any phone.
 * Only the height, and how far down the header sits (notch, status bar), differ per device.
 *
 * The grid is three columns of tiles in rows PITCH apart. Under each name is the HP bar, a teal line
 * that is easy to find, so each frame gives the rows' positions directly. What a frame cannot say on
 * its own is *which* rows those are: every row looks like the next. That comes from the previous frame:
 * the scroll step between two frames is (change in bar position) + k whole rows, and k is whichever
 * makes the two pictures line up. Rows then carry a running index from frame to frame, so nothing is
 * summed in pixels and nothing can drift.
 *
 * Pure: no DOM, no Node. Used by scan.js.
 */

export const WIDTH = 720;
/** Centre x of the three columns. */
export const COLS = [132, 360, 588];
/** Nominal distance between rows; the tracker measures the real one (it is 259.7 on some phones). */
export const PITCH = 260;

/** The HP bar's teal, loosely: video compression pulls it towards its surroundings. */
const isTeal = (r, g, b) => g - r > 60 && b - r > 40 && g > 150;
/** The search bar's pale green. It is the last thing above the grid, on every phone and language. */
const isSearchBar = (r, g, b) => Math.abs(r - 229) < 9 && Math.abs(g - 240) < 9 && Math.abs(b - 222) < 10;

const BAR_HALF = 48;
const BAR_MIN = 70; // teal pixels out of 97 for a row of pixels to count as part of a bar
/** From the middle of a bar to its first row, on a recording made at 720 pixels wide. */
const BAR_MIDDLE = 2.5;
const SIG_X0 = 24;
const SIG_BLOCK = 8;
const SIG_BLOCKS = 77; // 24..640: stops short of the fast-scroll handle on the right edge
/** The floating buttons sit in the last BUTTONS pixels, over the middle and right columns. */
export const BUTTONS = 172;

/**
 * The y just below the search bar, or null when this is not the storage grid (a Pokémon's page, the
 * search keyboard...). Looks for the run of rows that are search-bar green on both sides of the label.
 */
export function findHeaderBottom(frame) {
  const { data, width, height } = frame;
  const isBarRow = (y) => {
    let hit = 0;
    let all = 0;
    for (const [x0, x1] of [[90, 270], [450, 630]]) {
      for (let x = x0; x < x1; x += 6) {
        const i = (y * width + x) * 4;
        all++;
        if (isSearchBar(data[i], data[i + 1], data[i + 2])) hit++;
      }
    }
    return hit >= all * 0.9;
  };
  let run = 0;
  for (let y = Math.floor(height * 0.06); y < height * 0.34; y++) {
    if (isBarRow(y)) run++;
    else {
      if (run >= 50 && run <= 110) return y + 2;
      run = 0;
    }
  }
  return null;
}

/**
 * The HP bars in a frame: [{ y, cols: [bool, bool, bool] }], y being where the bar's first row of pixels
 * is (a fraction: it is worked out from the bar's middle).
 * A bar is a run of 3-9 rows that are teal across a column's bar width. The middle and right columns
 * are ignored where the floating buttons are, since those are teal too.
 */
export function findBars(frame, top = 0) {
  const { data, width, height } = frame;
  const found = [];
  const counts = new Uint16Array(height + 1);
  for (let c = 0; c < 3; c++) {
    const x0 = COLS[c] - BAR_HALF;
    const x1 = COLS[c] + BAR_HALF;
    const bottom = c === 0 ? height : height - BUTTONS;
    let run = 0;
    for (let y = top; y <= bottom; y++) {
      let n = 0;
      if (y < bottom) {
        let i = (y * width + x0) * 4;
        for (let x = x0; x <= x1; x++, i += 4) if (isTeal(data[i], data[i + 1], data[i + 2])) n++;
      }
      counts[y] = n;
      if (n >= BAR_MIN) run++;
      else {
        if (run >= 3 && run <= 9) {
          // Where the bar starts depends on how the recording was scaled and compressed (its edge rows
          // are half teal), so place it by its middle instead: the same on every phone to half a pixel.
          let sum = 0;
          let weight = 0;
          for (let k = Math.max(top, y - run - 2); k <= Math.min(bottom, y + 1); k++) {
            sum += k * counts[k];
            weight += counts[k];
          }
          found.push({ y: sum / weight - BAR_MIDDLE, c });
        }
        run = 0;
      }
    }
  }
  found.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const f of found) {
    const lastRow = rows[rows.length - 1];
    if (lastRow && f.y - lastRow.y <= 3) {
      lastRow.cols[f.c] = true;
      lastRow.ys.push(f.y);
    } else rows.push({ y: f.y, ys: [f.y], cols: [0, 1, 2].map((c) => c === f.c) });
  }
  for (const r of rows) r.y = r.ys.reduce((a, b) => a + b, 0) / r.ys.length;
  return rows;
}

/**
 * The fast-scroll handle: a pale tab on the right edge with two teal chevrons, which slides down as
 * the list scrolls and washes out whatever is under it. Returns the rows it covers, { y0, y1 }, or null.
 */
export function findHandle(frame, top = 0) {
  const { data, width, height } = frame;
  const rows = [];
  for (let y = top; y < height - BUTTONS; y++) {
    let n = 0;
    let i = (y * width + 664) * 4;
    for (let x = 664; x < 700; x++, i += 4) if (isTeal(data[i], data[i + 1], data[i + 2])) n++;
    if (n >= 2 && n <= 14) rows.push(y);
  }
  if (rows.length < 8) return null;
  // the chevrons span about 45 rows; a teal sprite in the right column would be bigger and denser
  const mid = rows[rows.length >> 1];
  const close = rows.filter((y) => Math.abs(y - mid) <= 40);
  if (close.length < 8) return null;
  return { y0: mid - 66, y1: mid + 66 };
}

/** A coarse picture of the frame for comparing two frames: mean brightness of 8-pixel blocks, per row. */
function signature(frame, out) {
  const { data, width, height } = frame;
  const sig = out && out.length === height * SIG_BLOCKS ? out : new Uint8Array(height * SIG_BLOCKS);
  for (let y = 0; y < height; y++) {
    let i = (y * width + SIG_X0) * 4;
    const o = y * SIG_BLOCKS;
    for (let b = 0; b < SIG_BLOCKS; b++) {
      let sum = 0;
      for (let k = 0; k < SIG_BLOCK; k++, i += 4) sum += data[i] + 2 * data[i + 1] + data[i + 2];
      sig[o + b] = sum >> 5;
    }
  }
  return sig;
}

/** Mean difference between the current picture and the previous one moved up by d pixels. */
function mismatch(cur, prev, d, top, bottom) {
  const y0 = Math.max(top, top - d);
  const y1 = Math.min(bottom, bottom - d);
  if (y1 - y0 < 120) return Infinity;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    const a = y * SIG_BLOCKS;
    const b = (y + d) * SIG_BLOCKS;
    for (let k = 0; k < SIG_BLOCKS; k++) sum += Math.abs(cur[a + k] - prev[b + k]);
    n += SIG_BLOCKS;
  }
  return sum / n;
}

/**
 * step(frame) returns null for a frame that is not the grid, otherwise
 *   { rows: [{ index, y }], moved, headerBottom, sure, handle }
 * rows: every row position in or near the frame; y is the first pixel row of its HP bar and index is the
 *       same number for the same row in every frame. An index says nothing about whether tiles exist
 *       there (the positions carry on past the end of the box).
 * moved: pixels the grid moved up since the previous grid frame (negative: moved down).
 * sure: false when the step from the previous frame was a poor match (a jump cut, a dropped stretch).
 * handle: the rows the fast-scroll handle covers on the right edge, { y0, y1 }, or null.
 */
export function createTracker() {
  let pitch = PITCH;
  const spacings = [];
  let headerBottom = null;
  let last = null;
  let spare = null;
  let segment = 0;

  return {
    get pitch() {
      return pitch;
    },
    get segments() {
      return segment + 1;
    },
    step(frame) {
      if (frame.width !== WIDTH) throw new Error(`Frames must be ${WIDTH} pixels wide, got ${frame.width}.`);
      const header = findHeaderBottom(frame);
      if (header === null) return null;
      if (headerBottom === null || Math.abs(header - headerBottom) > 3) headerBottom = header;
      const bars = findBars(frame, headerBottom);
      if (!bars.length) return null;

      // the real pitch, from bars one row apart, settled over the first few hundred sightings
      if (spacings.length < 400) {
        for (let i = 1; i < bars.length; i++) {
          const gap = bars[i].y - bars[i - 1].y;
          if (Math.abs(gap - PITCH) <= 3) spacings.push(gap);
        }
        if (spacings.length >= 8) pitch = spacings.reduce((a, b) => a + b, 0) / spacings.length;
      }

      // phase: where the rows sit, modulo the pitch
      const anchor = bars[0].y;
      let off = 0;
      let n = 0;
      for (const b of bars) {
        const r = b.y - anchor - Math.round((b.y - anchor) / pitch) * pitch;
        if (Math.abs(r) <= 4) {
          off += r;
          n++;
        }
      }
      const first = anchor + off / n;
      const phi = first - Math.floor(first / pitch) * pitch;

      const top = headerBottom + 4;
      const bottom = frame.height - BUTTONS;
      const sig = signature(frame, spare);
      let base = 0;
      let moved = 0;
      let sure = true;
      if (last && last.height === frame.height) {
        let best = null;
        let second = Infinity;
        for (let k = -4; k <= 4; k++) {
          const d = Math.round(last.phi - phi + k * pitch);
          const m = mismatch(sig, last.sig, d, top, bottom);
          if (!best || m < best.m) {
            second = best ? best.m : second;
            best = { k, d, m };
          } else if (m < second) second = m;
        }
        // a good step matches far better than any other; a cut to another part of the box matches nothing
        sure = best.m < 30 && (best.m < 6 || second > best.m * 1.25);
        if (best.m === Infinity || best.m >= 45) {
          segment++;
          base = segment * 1e6;
          sure = false;
        } else {
          base = last.base + best.k;
          moved = last.phi - phi + best.k * pitch;
        }
      }
      spare = last ? last.sig : null;
      last = { phi, base, sig, height: frame.height };

      const rows = [];
      for (let i = -1; phi + i * pitch < frame.height + pitch; i++) rows.push({ index: base + i, y: phi + i * pitch });
      return { rows, moved, headerBottom, sure, bars, handle: findHandle(frame, headerBottom) };
    },
  };
}

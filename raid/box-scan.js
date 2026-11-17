/**
 * The Box tab's "Read a recording": a screen recording of the game's Pokémon storage, read in the
 * browser (or by the local server when the browser can't play it), compared with the saved box, and
 * shown as a review (unchanged / changed / not sure / new / gone / couldn't read) before anything is saved.
 * Applying keeps the roster as it was in an undo slot until the next recording.
 *
 * The reading itself is ../scan/ (shared with scripts/scan-video.mjs); this file is the page around it.
 */
import { $, el } from './ui.js';
import { cpText } from './engine.js';
import { readVideoFrames } from './video-frames.js';
import { createScanner } from '../scan/scan.js';
import { loadAtlas } from '../scan/glyphs.js';
import { createResolver } from '../scan/resolve.js';
import { scanToEntries, reconcile, applyDiff } from '../scan/reconcile.js';
import { COLS } from '../scan/track.js';

const here = new URL('./', import.meta.url);
/** Lists longer than this are drawn when opened, not up front. */
const LAZY = 120;
const THUMB = { w: 114, h: 116 };

let ctx = null; // { gd, account(), byId, done(account, summary) }
let tools = null; // atlas + resolver, loaded the first time
let running = null; // AbortController of the reading in progress
let review = null; // { accountId, file, diff, tiles, thumbs, choices }

/**
 * Wires the button, file picker, status line and review panel on the Box view.
 *   gd           the game data
 *   account()    the account on show
 *   findAccount(id)
 *   storageKind  'server' when the local server is there (it can read what the browser can't)
 *   done(account, message)   after a change to an account's roster: redraw and save
 */
export function wireBoxScan(options) {
  ctx = { ...options, byId: new Map(options.gd.pokemon.map((p) => [p.id, p])) };
  $('scanBtn').onclick = () => {
    if (running) return;
    $('scanFile').click();
  };
  $('scanFile').onchange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) readRecording(file);
  };
  renderUndo();
}

/** The undo line under the buttons, for the account on show. */
export function renderUndo() {
  const box = $('scanUndo');
  const a = ctx?.account();
  if (!a?.undo) return box.replaceChildren();
  box.replaceChildren(
    el('span', { text: `Last recording applied on ${a.undo.at.slice(0, 10)} ("${a.undo.file}"). ` }),
    el(
      'button',
      {
        type: 'button',
        class: 'ghost',
        onclick: () => {
          if (!confirm(`Put ${a.name || a.id}'s Pokémon back as they were before "${a.undo.file}" was applied (${a.undo.roster.length} Pokémon)? Changes made since then are lost too.`)) return;
          a.roster = a.undo.roster;
          if (a.undo.lastImport) a.lastImport = a.undo.lastImport;
          else delete a.lastImport;
          delete a.undo;
          ctx.done(a, `Put back the ${a.roster.length} Pokémon from before the recording.`);
          renderUndo();
        },
      },
      'Undo it',
    ),
  );
}

// ---------------------------------------------------------------- reading

async function loadTools() {
  if (tools) return tools;
  const res = await fetch(new URL('../scan/glyph-atlas.json', here));
  if (!res.ok) throw new Error(`Could not load the glyph atlas (${res.status}).`);
  const atlas = loadAtlas(await res.json());
  const resolve = createResolver(ctx.gd, { evolutions: globalThis.PVP_DATA?.evolutions ?? {} });
  tools = { atlas, resolve };
  return tools;
}

function status(text, { busy = false, error = false } = {}) {
  const box = $('scanStatus');
  box.classList.toggle('error', error);
  box.replaceChildren(el('span', { text }), ...(busy ? [el('button', { type: 'button', class: 'ghost', onclick: () => running?.abort() }, 'Cancel')] : []));
}

async function readRecording(file) {
  const account = ctx.account();
  if (!account) return;
  running = new AbortController();
  const { signal } = running;
  $('scanBtn').disabled = true;
  closeReview();
  try {
    status(`Loading the reader…`, { busy: true });
    const { atlas, resolve } = await loadTools();
    const thumbs = new Map();
    let result;
    try {
      result = await readInBrowser(file, atlas, thumbs, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      if (ctx.storageKind !== 'server') throw err;
      status(`${err.message} Reading it on this computer instead (no pictures in the review)…`, { busy: true });
      result = await readOnServer(file, signal);
    }
    if (signal.aborted) return status('Cancelled.');
    const { tiles, stats, seconds } = result;
    if (!tiles.length) {
      return status(`No Pokémon found in "${file.name}". It needs to show the game's Pokémon storage screen being scrolled.`, { error: true });
    }
    const resolved = tiles.map((t) => {
      const r = resolve(t);
      return { ...t, col: 'LMR'[t.col] ?? t.col, species: r.name, pokemonId: r.pokemonId, ivs: r.ivs, pct: r.pct, sure: r.sure, note: r.note, formOpen: r.form === false };
    });
    const incoming = scanToEntries(ctx.gd, resolved);
    const diff = reconcile(ctx.gd, account.roster ?? [], incoming, { evolutions: globalThis.PVP_DATA?.evolutions ?? {} });
    review = { accountId: account.id, file: file.name, diff, tiles: resolved, thumbs, stats, seconds, choices: defaultChoices(account, diff) };
    status(`Read ${tiles.length} Pokémon from "${file.name}" in ${Math.round(seconds)} s. Nothing is saved until you apply it below.`);
    renderReview();
  } catch (err) {
    if (signal.aborted) status('Cancelled.');
    else {
      console.error(err);
      status(err.message, { error: true });
    }
  } finally {
    running = null;
    $('scanBtn').disabled = false;
  }
}

async function readInBrowser(file, atlas, thumbs, signal) {
  // pictures of the tiles for the review, small and compressed: a whole box is a couple of thousand
  const cut = Object.assign(document.createElement('canvas'), { width: 228, height: 232 });
  const small = Object.assign(document.createElement('canvas'), { width: THUMB.w, height: THUMB.h });
  const cutCtx = cut.getContext('2d');
  const smallCtx = small.getContext('2d');
  const onBest = (key, col, y, frame) => {
    const x0 = COLS[col] - 114;
    const y0 = Math.round(y) - 220;
    if (y0 < 0 || y0 + 232 > frame.height) return;
    const img = cutCtx.createImageData(228, 232);
    for (let r = 0; r < 232; r++) img.data.set(frame.data.subarray(((y0 + r) * frame.width + x0) * 4, ((y0 + r) * frame.width + x0 + 228) * 4), r * 228 * 4);
    cutCtx.putImageData(img, 0, 0);
    smallCtx.drawImage(cut, 0, 0, THUMB.w, THUMB.h);
    thumbs.set(key, small.toDataURL('image/jpeg', 0.7));
  };
  const scanner = createScanner({ atlas, onBest });
  const started = performance.now();
  await readVideoFrames(file, (frame) => scanner.feed(frame), {
    signal,
    onProgress: (f) => status(`Reading "${file.name}": ${Math.round(f * 100)}%`, { busy: true }),
  });
  const { tiles, stats } = scanner.finish();
  return { tiles, stats, seconds: (performance.now() - started) / 1000 };
}

async function readOnServer(file, signal) {
  const started = performance.now();
  const res = await fetch('api/scan', { method: 'POST', body: file, signal, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!res.ok && !res.body) throw new Error(`The computer could not read it (${res.status}).`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let out = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.tiles) out = msg;
      else if (msg.progress !== undefined) status(`Reading "${file.name}" on this computer: ${msg.progress === null ? `${msg.frames} frames` : `${Math.round(msg.progress * 100)}%`}`, { busy: true });
    }
  }
  if (!out) throw new Error('The computer stopped before it finished reading.');
  return { tiles: out.tiles, stats: out.stats, seconds: (performance.now() - started) / 1000 };
}

// ---------------------------------------------------------------- review

/**
 * What applying does unless changed by hand: new ones added, gone ones removed, "not sure" pairs kept
 * apart. A recording that matches little of a big saved box is probably only part of the box, or
 * another account's: then gone ones are kept by default.
 */
function defaultChoices(account, diff) {
  const saved = (account.roster ?? []).length;
  const matched = diff.same.length + diff.changed.length;
  const read = diff.same.length + diff.changed.length + diff.unsure.length + diff.added.length + diff.unreadable.length;
  // little of the saved box found, and either a short recording or almost nothing in common
  const partial = saved >= 20 && matched < saved * 0.5 && (read < saved * 1.2 || matched < saved * 0.2);
  return {
    partial,
    keepGone: new Set(partial ? diff.gone.map((g) => g.rosterIndex) : []),
    skipAdded: new Set(),
    confirmed: new Set(),
  };
}

function closeReview() {
  review = null;
  $('scanPanel').hidden = true;
  $('scanPanel').replaceChildren();
}

const nameOf = (id) => ctx.byId.get(id)?.name ?? id;
const ivText = (e) => (e.ivsAssumed ? 'IVs ?' : `${e.ivAtk}/${e.ivDef}/${e.ivSta}`);
const savedText = (e) =>
  [nameOf(e.pokemonId), `CP ${cpText(ctx.gd, e)}`, `L${e.level}`, ivText(e), e.shadow ? 'shadow' : '', e.mega ? 'mega' : '', e.fastMove || e.chargedMoves?.length ? 'moves set' : '']
    .filter(Boolean)
    .join(' · ');

function thumb(tile) {
  const src = tile && review.thumbs.get(tile.key);
  return src ? el('img', { class: 'scan-thumb', src, alt: '', title: `${tile.name} · CP ${tile.cp}`, width: THUMB.w * 0.66, height: THUMB.h * 0.66 }) : el('span', { class: 'scan-thumb none' });
}

/** A tile as read: the text on screen and what it was taken for. */
function tileText(item) {
  const t = item.tile;
  const e = item.entry;
  const parts = [`"${t.name}"`, `CP ${t.cp || '?'}`];
  if (e) parts.push(`${nameOf(e.pokemonId)} L${e.level}`, ivText(e));
  if (t.shadow) parts.push('shadow');
  if (t.gigantamax) parts.push('G-Max');
  else if (t.dynamax) parts.push('Dynamax');
  return parts.join(' · ');
}

function section(title, rows, { open = false, hint = '' } = {}) {
  if (!rows.length) return null;
  const list = el('ul', { class: 'scan-list' });
  const fill = () => {
    if (list.childElementCount) return;
    list.replaceChildren(...rows.map((row) => row()));
  };
  const box = el('details', { class: 'scan-section', open }, el('summary', {}, `${title} (${rows.length})`), hint ? el('p', { class: 'muted small', text: hint }) : null, list);
  if (open || rows.length <= LAZY) fill();
  else box.addEventListener('toggle', fill, { once: true });
  return box;
}

const check = (checked, label, onChange) =>
  el('label', { class: 'checkbox inline' }, el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), el('span', { text: label }));

function renderReview() {
  const { diff, choices } = review;
  const account = ctx.findAccount(review.accountId);
  const who = account?.name || review.accountId;
  // "which form" is said once for all of them, not on every Mewtwo
  const noteText = (item) =>
    (item.tile.note ?? '')
      .split('; ')
      .filter((n) => n && !n.startsWith('the tile does not show which form'))
      .join('; ');
  const note = (item) => (noteText(item) ? el('div', { class: 'muted small warn-text', text: noteText(item) }) : null);
  const looks = [...diff.changed.map((m) => m.item), ...diff.added].filter((item) => noteText(item)).length;
  const formless = diff.added.filter((item) => item.tile.formOpen);
  const formNames = [...new Set(formless.map((item) => nameOf(item.entry.pokemonId)))];

  const counts = [
    `${diff.same.length} unchanged`,
    `${diff.changed.length} changed`,
    diff.unsure.length ? `${diff.unsure.length} not sure` : '',
    `${diff.added.length} new`,
    `${diff.gone.length} gone`,
    diff.unreadable.length ? `${diff.unreadable.length} couldn't be read` : '',
  ].filter(Boolean);

  const panel = $('scanPanel');
  panel.hidden = false;
  panel.replaceChildren(
    ...[
    el('h3', { text: `"${review.file}" against ${who}'s box` }),
    el('p', { text: `${review.tiles.length} Pokémon in the recording, ${(account?.roster ?? []).length} saved: ${counts.join(', ')}.` }),
    choices.partial
      ? el('div', { class: 'note warn', text: `Only ${diff.same.length + diff.changed.length} of the ${(account?.roster ?? []).length} saved Pokémon were found in it. If it is only part of the box, or another account's, the ones not found are kept unless you untick them; check the account before applying.` })
      : null,
    looks ? el('p', { class: 'muted small', text: `${looks} of the new and changed ones carry a note: worth a look before applying.` }) : null,
    formless.length
      ? el('p', {
          class: 'muted small',
          text: `${formless.length} new ones show a name with forms that have different stats, and nothing on the tile says which (no Nicknamer IVs to settle it by CP). They go in as ${formNames.slice(0, 6).join(', ')}${formNames.length > 6 ? '…' : ''}; change any that are another form by clicking the name in the box.`,
        })
      : null,
    section(
      'Changed',
      diff.changed.map((m) => () => el('li', {}, thumb(m.item.tile), el('div', {}, el('div', { text: `${nameOf(m.next.pokemonId)}: ${m.why.join(', ')}` }), el('div', { class: 'muted small', text: `was ${savedText(m.have)}` }), note(m.item)))),
      { hint: 'The same Pokémon as saved, with what the game shows now. Moves, megas and anything else set here are kept.' },
    ),
    section(
      'Not sure',
      diff.unsure.map((m) => () =>
        el(
          'li',
          {},
          thumb(m.item.tile),
          el(
            'div',
            {},
            el('div', { text: tileText(m.item) }),
            el('div', { class: 'muted small', text: `saved: ${savedText(m.have)}` }),
            check(choices.confirmed.has(m), 'same Pokémon (keep its moves and mega)', (on) => (on ? choices.confirmed.add(m) : choices.confirmed.delete(m))),
          ),
        ),
      ),
      { open: true, hint: 'A saved Pokémon with moves or a mega set, and one of its family in the recording at a CP no lower, but its saved IVs do not give that CP. Tick the ones that are the same Pokémon; the rest count as one gone and one new.' },
    ),
    section(
      'New',
      diff.added.map((item) => () =>
        el('li', {}, thumb(item.tile), el('div', {}, el('div', { text: tileText(item) }), note(item), check(!choices.skipAdded.has(item), 'add', (on) => (on ? choices.skipAdded.delete(item) : choices.skipAdded.add(item))))),
      ),
    ),
    section(
      'Gone',
      diff.gone.map((g) => () =>
        el('li', {}, el('span', { class: 'scan-thumb none' }), el('div', {}, el('div', { text: savedText(g.have) }), check(choices.keepGone.has(g.rosterIndex), 'keep it', (on) => (on ? choices.keepGone.add(g.rosterIndex) : choices.keepGone.delete(g.rosterIndex))))),
      ),
      { open: diff.gone.length <= 30, hint: 'Saved, but not in the recording: transferred or traded, or in a part of the box that was not recorded. Ticked ones stay.' },
    ),
    section(
      "Couldn't read",
      diff.unreadable.map((item) => () => el('li', {}, thumb(item.tile), el('div', {}, el('div', { text: `"${item.tile.name}" · CP ${item.tile.cp || '?'}` }), el('div', { class: 'muted small', text: item.problem })))),
      { open: diff.unreadable.length <= 30, hint: 'Left out. A typed nickname hides the species; add these by hand if you want them.' },
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', { type: 'button', class: 'primary', onclick: apply }, `Apply to ${who}`),
      el('button', { type: 'button', class: 'ghost', onclick: () => (closeReview(), status('Discarded; nothing was saved.')) }, 'Discard'),
    ),
    ].filter(Boolean),
  );
}

function apply() {
  const account = ctx.findAccount(review.accountId);
  if (!account) return;
  const { diff, choices } = review;
  const before = account.roster ?? [];
  const next = applyDiff(ctx.gd, before, diff, choices);
  const removed = before.length - (diff.same.length + diff.changed.length + choices.confirmed.size) - choices.keepGone.size;
  const added = diff.added.length - choices.skipAdded.size + (diff.unsure.length - choices.confirmed.size);
  if (!confirm(`Apply "${review.file}" to ${account.name || account.id}: ${next.length} Pokémon after, ${diff.changed.length + choices.confirmed.size} updated, ${added} added, ${removed} removed? "Undo it" puts it back until the next recording is applied.`)) return;
  account.undo = { at: new Date().toISOString(), file: review.file, roster: before, ...(account.lastImport ? { lastImport: account.lastImport } : {}) };
  account.roster = next;
  account.lastImport = { at: new Date().toISOString(), file: review.file, mode: 'scan' };
  const file = review.file;
  closeReview();
  status(`Applied "${file}": ${next.length} Pokémon in ${account.name || account.id}'s box.`);
  ctx.done(account, null);
  renderUndo();
}

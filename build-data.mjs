#!/usr/bin/env node
/**
 * Builds pvp-iv/data.js: base.json (stats, CP table) plus PvPoke's evolution families, league and cup
 * rankings and any Pokémon base.json doesn't know yet.
 *
 * Needs only base.json and the network, so GitHub Actions runs it daily to pick up cup rotations
 * (see .github/workflows/refresh-data.yml).  Locally:  node build-data.mjs
 * The output is a plain script (not JSON) so index.html works when opened straight from disk.
 */
import fs from 'node:fs';

const OUT = new URL('./data.js', import.meta.url);
const { cpm, shadow: shadowMods, species: baseSpecies } = JSON.parse(fs.readFileSync(new URL('./base.json', import.meta.url), 'utf8'));
const MEGA_FORM = /_MEGA(_[XY])?$|_PRIMAL$/;

/** GET with a few retries; returns the Response, which may be a 404 (the caller decides what that means). */
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok || res.status === 404 || attempt === 3) return res;
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

// PvPoke supplies what the base data lacks: evolution families, rankings, cups, and any Pokémon
// released since base.json was made.
const RAW = 'https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data';
const res = await get(`${RAW}/gamemaster/pokemon.json`);
if (!res.ok) throw new Error(`PvPoke fetch failed: ${res.status}`);
const pvpoke = await res.json();

const species = structuredClone(baseSpecies);

// Add released Pokémon whose dex number has no entry at all (Mimikyu, Toxtricity, ...). Extra forms of
// a Pokémon we already list are left alone: they share its base stats and would only clutter the list.
const haveDex = new Set(species.map((s) => s.dex));
const added = [];
for (const p of pvpoke) {
  if (!p.released || /_shadow|_mega|_primal/.test(p.speciesId) || haveDex.has(p.dex)) continue;
  species.push({
    id: p.speciesId.toUpperCase(),
    name: p.speciesName,
    dex: p.dex,
    atk: p.baseStats.atk,
    def: p.baseStats.def,
    sta: p.baseStats.hp,
  });
  added.push(p.speciesName);
}
species.sort((a, b) => a.dex - b.dex || a.name.localeCompare(b.name));

// Its ids are lower-case and mostly match ours; Alolan forms and the Nidorans are spelled differently.
const ALIASES = {
  nidoran_female: 'NIDORAN_NORMAL',
  nidoran_male: 'NIDORAN_MALE__NIDORAN_NORMAL',
  wooper_paldean: 'WOOPER_PALDEA',
  // Cosmetic-form species that the game data only carries as one specific form.
  dudunsparce: 'DUDUNSPARCE_THREE',
  shellos: 'SHELLOS_EAST_SEA',
  gastrodon: 'GASTRODON_EAST_SEA',
  deerling: 'DEERLING_AUTUMN',
  sawsbuck: 'SAWSBUCK_AUTUMN',
  scatterbug: 'SCATTERBUG_ARCHIPELAGO',
  spewpa: 'SPEWPA_ARCHIPELAGO',
  vivillon: 'VIVILLON_ARCHIPELAGO',
  flabebe: 'FLABEBE_BLUE',
  floette: 'FLOETTE_BLUE',
  florges: 'FLORGES_BLUE',
  polteageist: 'POLTEAGEIST_ANTIQUE',
};

const ourId = new Map(species.map((s) => [s.id.toLowerCase(), s.id]));
const toOurId = (pvpokeId) => ALIASES[pvpokeId] ?? ourId.get(pvpokeId.replace(/_alolan$/, '_alola'));

const edges = new Set();
for (const p of pvpoke) {
  const family = p.family;
  if (!family || /_shadow$|_mega/.test(p.speciesId)) continue;
  for (const child of family.evolutions ?? []) edges.add(`${p.speciesId}>${child}`);
  if (family.parent) edges.add(`${family.parent}>${p.speciesId}`);
}

const evolutions = {};
const link = (from, to) => {
  const list = (evolutions[from] ??= []);
  if (!list.includes(to)) list.push(to);
};
let skipped = 0;
for (const edge of edges) {
  if (/_shadow|_mega/.test(edge)) continue; // PvPoke hangs megas off the wrong stage; they're linked below
  const [from, to] = edge.split('>').map(toOurId);
  if (!from || !to) {
    skipped++;
    continue;
  }
  link(from, to);
}
// A Mega or Primal form belongs to the Pokémon it comes from (Mega Gengar after Gengar).
const known = new Set(species.map((s) => s.id));
for (const s of species) {
  const base = s.mega && s.id.replace(MEGA_FORM, '');
  if (base && known.has(base)) link(base, s.id);
}

// League rankings: PvPoke's simulated scores for every Pokémon (Shadow versions are ranked separately).
// Each row is [ourId, isShadow, rank, score, fastMove, ...chargedMoves]; the rank is the position in
// PvPoke's own list, so it stays right even when we have to drop a form we don't list.
const moveName = (id) =>
  id
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

let unrankedForms = 0;
/** One format's ranking rows, or null if PvPoke doesn't publish one (a 404). Any other failure aborts the build. */
async function fetchRanking(cup, cp) {
  const rankRes = await get(`${RAW}/rankings/${cup}/overall/rankings-${cp}.json`);
  if (rankRes.status === 404) return null;
  if (!rankRes.ok) throw new Error(`PvPoke ${cup}-${cp} rankings fetch failed: ${rankRes.status}`);
  const rows = [];
  (await rankRes.json()).forEach((entry, i) => {
    const shadow = entry.speciesId.endsWith('_shadow');
    const id = toOurId(entry.speciesId.replace(/_shadow$/, ''));
    if (!id) {
      unrankedForms++;
      return;
    }
    const [fast, ...charged] = entry.moveset;
    rows.push([id, shadow ? 1 : 0, i + 1, entry.score, moveName(fast), ...charged.map(moveName)]);
  });
  return rows;
}

const rankings = {};
for (const [league, cp] of Object.entries({ great: 1500, ultra: 2500, master: 10000 })) {
  rankings[league] = await fetchRanking('all', cp);
  if (!rankings[league]) throw new Error(`PvPoke ${league} rankings are missing`);
}

// Cups: whatever PvPoke currently lists in formats.json (these rotate, so this is a snapshot).
// Each has its own CP cap, rules text and ranking, keyed "<cup>-<cp>" because one cup can run at several caps.
const cups = [];
const skippedCups = [];
const formatsRes = await get(`${RAW}/gamemaster/formats.json`);
if (!formatsRes.ok) throw new Error(`PvPoke formats fetch failed: ${formatsRes.status}`);
for (const format of await formatsRes.json()) {
  const key = `${format.cup}-${format.cp}`;
  const rows = format.hideRankings || format.cup === 'custom' ? null : await fetchRanking(format.cup, format.cp);
  if (!rows) {
    skippedCups.push(format.title);
    continue;
  }
  rankings[key] = rows;
  cups.push({ key, title: format.title, cp: format.cp, rules: format.rules ?? [] });
}

const data = {
  cpm,
  shadow: shadowMods,
  species,
  evolutions,
  cups,
  rankings,
};

// This runs unattended and its output gets committed, so refuse to write data that looks truncated.
const sane = [
  [species.length >= baseSpecies.length, 'species list shrank'],
  [Object.keys(evolutions).length > 300, 'too few evolution families'],
  [rankings.great.length > 300 && rankings.ultra.length > 200 && rankings.master.length > 100, 'a standard league ranking looks truncated'],
];
for (const [ok, problem] of sane) if (!ok) throw new Error(`Refusing to write data.js: ${problem}`);

fs.writeFileSync(OUT, `globalThis.PVP_DATA = ${JSON.stringify(data)};\n`);
console.log(`wrote ${species.length} species, ${Object.keys(cpm).length} levels, ${Object.keys(evolutions).length} with evolutions (${skipped} odd-form links skipped)`);
console.log(`rankings: ${Object.entries(rankings).map(([l, r]) => `${l} ${r.length}`).join(', ')} (${unrankedForms} entries for forms we don't list)`);
console.log(`cups: ${cups.map((c) => c.title).join('; ')}`);
console.log(`cups without rankings, skipped: ${skippedCups.join('; ') || 'none'}`);
console.log(`added from PvPoke: ${added.join(', ') || 'none'}`);

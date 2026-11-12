/**
 * Reading Pokémon lists into roster entries, shared by the Raid tab's CSV import, the scripts that
 * read the plain-text lists in data/imports/, and the tests. Pure: no DOM, no files.
 *
 * The game shows CP, not level, so a level can be solved by inverting the CP formula:
 *
 *   CP = floor( (atk + ivA) * sqrt(def + ivD) * sqrt(sta + ivS) * CPM^2 / 10 )
 *
 * with CPM looked up per half-level. Every level is tried and the closest CP wins.
 *
 * ---- Plain-text lists (parseRosterList), one Pokemon per line, blank lines and # comments ignored:
 *
 *   Mewtwo | 4685 | 14/13/15            name | CP | IVs
 *   Zapdos | 3007                       IVs unknown -- assumed, and reported
 *   Starmie | 1820 | ? | mega           can mega evolve
 *   Mewtwo | 1752 | 11/14/12 | mega=MEGA_Y     which mega, when a species has X and Y
 *   Raichu | 1200 | ? | mega=*                  either form unlocked -- the planner picks per boss
 *   Mewtwo | 3701 | 15/15/15 | mega=MEGA_Y megaLevel=3
 *                                        Mega Level 1-4 (Base/High/Max/Super Max); default 1
 *   Lunala | 3312 | total=44           only the IV total is known; the split is solved from CP
 *   Dialga | 2836 | stars=2            appraisal stars only (2★ = total 30-36); solved the same way
 *   Machamp | 2650 | 14/13/11 | shadow frustration
 *                                        a Shadow, still on its locked move (Frustration)
 *   Charizard | 2889 | 15/14/15 | gmax  can Gigantamax (and so Dynamax); "dynamax" for Dynamax only
 *
 * A trailing comment may carry the percentage the game printed ("# 76%"); it is checked against
 * the IVs, which catches a misread badge.
 *
 * ---- CSV (parseRosterCsv). Columns are found by header name, in any order, ignoring case; unknown
 * columns are ignored. Comma- or semicolon-separated (Excel in many locales saves with semicolons
 * and decimal commas; both work). Only pokemonId or name is required.
 *
 *   pokemonId / name        which Pokemon. A name is the one the app shows ("Dialga (Origin)"); a
 *                           plain "Dialga" is corrected to the form whose stats give the CP.
 *   level / cp              level wins when both are there; a CP alone is solved to a level
 *   ivAtk, ivDef, ivSta     0-15; blank or ? = unknown (assumed 12/12/12, shown as "IV?")
 *   ivTotal / stars         only the IV total, or the appraisal stars (0-4), is known; needs cp
 *   pct                     the IV % the game or a nickname shows, checked against the IVs
 *   shadow, dynamax, gigantamax   yes / no (also y, x, true, 1). G-Max implies Dynamax.
 *   mega                    blank, yes (its only mega), MEGA / MEGA_X / MEGA_Y / PRIMAL, or * (either)
 *   megaLevel               1-4
 *   fastMove, chargedMove1, chargedMove2   move ids; blank = Any (best)
 */
import { cpOf, levelForCp, normalizeEntry } from './engine.js';
import { GMAX_TYPES } from './maxbattle.js';

/** IVs to assume when the screenshot didn't show them. Mid-range rather than flattering. */
export const ASSUMED_IV = 12;

/** IV totals behind each appraisal star count (4★ is a perfect 45, written 15/15/15). */
const STAR_TOTALS = { 0: [0, 22], 1: [23, 29], 2: [30, 36], 3: [37, 44] };

/** "Landorus" alone is ambiguous; these are the forms people mean in a raid box. */
const NAME_HINTS = {
  landorus: 'landorus (therian)',
  thundurus: 'thundurus (incarnate)',
  tornadus: 'tornadus (incarnate)',
  enamorus: 'enamorus (incarnate)',
  hoopa: 'hoopa (confined)',
  zacian: 'zacian (hero)',
  zamazenta: 'zamazenta (hero)',
  giratina: 'giratina (altered)',
  shaymin: 'shaymin (land)',
  deoxys: 'deoxys (normal)',
  darmanitan: 'darmanitan (standard)',
  meloetta: 'meloetta (aria)',
  urshifu: 'urshifu (single strike)',
  florges: 'florges (blue)', // colour is cosmetic; every Florges has the same stats
};

/** A name reduced to letters and digits: no case, accents or punctuation; ♀ / ♂ spelled out. */
const squash = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/♀/g, 'female')
    .replace(/♂/g, 'male')
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');

/** Same Pokemon, same level, same IVs, same shadow state: the same roster entry. */
export const entryKey = (e) => `${e.pokemonId}|${e.level}|${e.ivAtk}/${e.ivDef}/${e.ivSta}|${e.shadow ? 1 : 0}`;

/** A number cell: blank is null; a decimal comma (35,5) is read as a point. */
const num = (t) => (t === undefined || t === null || String(t).trim() === '' ? null : Number(String(t).trim().replace(',', '.')));

/**
 * Turns rows into roster entries. Both readers build rows of this shape:
 *   { where, pokemonId?, name?, cpText, needCp?, levelText?, ivText, pct?, shadow, frustration?,
 *     mega ('' | 'auto' | '*' | 'MEGA_Y'...), megaLevel?, dynamax?, gigantamax?, fastMove?, chargedMoves? }
 * Returns the entries plus what a human should look at, grouped.
 */
export function readRows(gd, rows) {
  const byId = new Map();
  const byName = new Map();
  const bySquashed = new Map();
  const byBase = new Map();
  const formsOf = new Map();
  for (const p of gd.pokemon) {
    byId.set(p.id, p);
    if (p.tempEvo) continue;
    byName.set(p.name.toLowerCase(), p);
    bySquashed.set(squash(p.name), p);
    // "Shellos (East Sea)", "Pumpkaboo (Average)": the plain species name finds the first form
    const base = squash(p.name.replace(/\s*\(.*\)$/, ''));
    if (!byBase.has(base)) byBase.set(base, p);
    if (!formsOf.has(p.pokemonId)) formsOf.set(p.pokemonId, []);
    formsOf.get(p.pokemonId).push(p);
  }
  /**
   * Exact name first, then the usual form for an ambiguous one, then the same ignoring case, accents
   * and punctuation ("Ho-Oh" = "Ho Oh", "Flabébé" = "Flabebe"), then a plain species name whose game
   * data names only forms. With known IVs the CP then corrects the form (correctForm, below).
   */
  const resolve = (name) => {
    const key = String(name ?? '').trim().toLowerCase();
    return byName.get(key) ?? byName.get(NAME_HINTS[key] ?? '') ?? bySquashed.get(squash(key)) ?? byBase.get(squash(key)) ?? null;
  };

  /** The level whose CP is closest to the observed one. */
  const levelFromCp = (species, ivs, cp) => {
    const best = levelForCp(gd, species, ivs, cp);
    return { ...best, cp: cpOf(gd, species, best.level, ivs) };
  };

  /**
   * A CP that no level can produce means the form is wrong -- the screenshot just says "Dialga",
   * but Origin Forme has different stats. When a sibling form matches the CP exactly, take it.
   */
  const correctForm = (species, ivs, cp) => {
    const direct = levelFromCp(species, ivs, cp);
    if (direct.diff === 0) return { species, solved: direct, corrected: false };
    for (const alt of formsOf.get(species.pokemonId) ?? []) {
      if (alt === species) continue;
      const solved = levelFromCp(alt, ivs, cp);
      if (solved.diff === 0) return { species: alt, solved, corrected: true };
    }
    return { species, solved: direct, corrected: false };
  };

  /**
   * Only the IV total is known -- e.g. from a nickname like "Mewtwo41" -- or only a range of
   * totals, from an appraisal star count. Try every split in range and keep the ones that
   * reproduce the CP exactly. Several usually fit; the one nearest the middle of the range and
   * most even is used, since without the full appraisal nothing favours attack over stamina.
   */
  const solveFromTotal = (species, lo, hi, cp) => {
    const exact = [];
    let nearest = null;
    for (let a = 0; a <= 15; a++) {
      for (let d = 0; d <= 15; d++) {
        for (let s = 0; s <= 15; s++) {
          if (a + d + s < lo || a + d + s > hi) continue;
          const ivs = [a, d, s];
          const solved = levelFromCp(species, ivs, cp);
          if (solved.diff === 0) exact.push({ ivs, solved });
          if (!nearest || solved.diff < nearest.solved.diff) nearest = { ivs, solved };
        }
      }
    }
    const mid = (lo + hi) / 2;
    const sum = (v) => v[0] + v[1] + v[2];
    const spread = (v) => Math.max(...v) - Math.min(...v);
    exact.sort((x, y) => Math.abs(sum(x.ivs) - mid) - Math.abs(sum(y.ivs) - mid) || spread(x.ivs) - spread(y.ivs));
    return exact.length ? { ...exact[0], fits: exact.length } : { ...nearest, fits: 0 };
  };

  const roster = [];
  const problems = [];
  const assumed = [];
  const inexact = [];
  const corrections = [];
  const totals = [];

  for (const row of rows) {
    const w = row.where;
    const label = row.name || row.pokemonId;

    let species = (row.pokemonId && byId.get(row.pokemonId)) || (row.name ? resolve(row.name) : null);
    if (!species) {
      problems.push(`${w}: unknown Pokémon "${label}"`);
      continue;
    }

    // A text list must give a CP; a CSV may give a level instead.
    const cp = row.needCp ? Number(row.cpText) : num(row.cpText);
    if (row.needCp ? !Number.isFinite(cp) : cp !== null && !Number.isFinite(cp)) {
      problems.push(`${w}: bad CP "${row.cpText}" for ${label}`);
      continue;
    }
    const level = num(row.levelText);
    if (level !== null && !gd.cpm[String(level)]) {
      problems.push(`${w}: bad level "${row.levelText}" for ${label}`);
      continue;
    }

    let ivs = [ASSUMED_IV, ASSUMED_IV, ASSUMED_IV];
    let ivKnown = false;
    const ivPart = row.ivText ?? '';
    // total=44 is an exact IV total; stars=2 is an appraisal, which only bounds the total.
    const totalMatch = /^total=(\d{1,2})$/i.exec(ivPart);
    const starsMatch = /^stars=([0-3])$/i.exec(ivPart);
    if (totalMatch || starsMatch) {
      const [lo, hi] = totalMatch ? [Number(totalMatch[1]), Number(totalMatch[1])] : STAR_TOTALS[starsMatch[1]];
      const what = totalMatch ? `total ${lo}` : `${starsMatch[1]}★ (total ${lo}-${hi})`;
      if (hi > 45) {
        problems.push(`${w}: IV total ${hi} is over 45 for ${label}`);
        continue;
      }
      if (cp === null) {
        problems.push(`${w}: an IV ${what} needs the CP to solve the split for ${label}; IVs assumed`);
      } else {
        const fromTotal = solveFromTotal(species, lo, hi, cp);
        ivs = fromTotal.ivs;
        ivKnown = true;
        if (fromTotal.fits === 0) {
          problems.push(`${w}: no ${what} IVs give ${label} exactly ${cp} CP -- wrong species or form?`);
        } else if (fromTotal.fits > 1) {
          totals.push(`${species.name} ${cp} CP, ${what}: ${fromTotal.fits} splits fit, using ${ivs.join('/')}`);
        }
      }
    } else if (ivPart && ivPart !== '?') {
      const parts = ivPart.split('/').map((s) => (s.trim() === '' ? NaN : Number(s)));
      if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 15)) {
        problems.push(`${w}: bad IVs "${ivPart}" for ${label}`);
        continue;
      }
      ivs = parts;
      ivKnown = true;
    }

    // The percentage the game (or a nickname) showed: check the IVs were read right.
    if (row.pct !== null && row.pct !== undefined && ivKnown) {
      const fromIvs = Math.round(((ivs[0] + ivs[1] + ivs[2]) / 45) * 100);
      if (Math.abs(fromIvs - row.pct) > 1) {
        problems.push(`${w}: ${label} IVs ${ivs.join('/')} are ${fromIvs}%, but the list says ${row.pct}%`);
      }
    }

    // Resolve the form before reading mega flags, since forms differ in what they can mega into.
    let solved;
    if (level !== null) {
      solved = { level, diff: 0, cp: cpOf(gd, species, level, ivs) };
      if (cp !== null && ivKnown && solved.cp !== cp) inexact.push(`${species.name} L${level} is ${solved.cp} CP, but the row says ${cp}`);
    } else if (cp !== null) {
      if (ivKnown) {
        const fixed = correctForm(species, ivs, cp);
        if (fixed.corrected) corrections.push(`${species.name} ${cp} CP -> ${fixed.species.name} @L${fixed.solved.level}`);
        species = fixed.species;
        solved = fixed.solved;
      } else {
        solved = levelFromCp(species, ivs, cp);
      }
    } else {
      problems.push(`${w}: no level or CP for ${label}; assumed level 40`);
      solved = { level: 40, diff: 0, cp: cpOf(gd, species, 40, ivs) };
    }

    let mega = '';
    // megaLevel records the Mega Level (1 Base, 2 High, 3 Max, 4 Super Max); default Base.
    const megaLevel = Math.min(4, Math.max(1, Number(row.megaLevel ?? 1) || 1));
    if (row.mega) {
      // '*' means "either form is unlocked" -- the planner then weighs X against Y per boss.
      const explicit = row.mega === 'auto' ? undefined : row.mega;
      const available = (species.tempEvos ?? []).map((t) => t.suffix);
      if (!available.length) {
        problems.push(`${w}: ${species.name} has no mega form`);
      } else if (explicit === '*') {
        mega = '*';
      } else if (explicit && !available.includes(explicit)) {
        problems.push(`${w}: ${species.name} has no ${explicit} (has ${available.join(', ')})`);
      } else {
        mega = explicit ?? available[0];
        if (!explicit && available.length > 1) {
          problems.push(`${w}: ${species.name} has ${available.join(' and ')}; picked ${mega}`);
        }
      }
    }

    // shadow = a Shadow Pokemon (x1.2 attack, x0.83 defence, can't mega evolve); frustration = it
    // still knows its locked shadow move. CP works the same either way, so the level solve stands.
    const shadow = Boolean(row.shadow);
    const frustration = Boolean(row.frustration);
    if (shadow && mega) {
      problems.push(`${w}: ${species.name} is marked shadow and mega, but shadows can't mega evolve; dropped the mega flag`);
      mega = '';
    }
    if (shadow && !species.shadowAvailable) {
      problems.push(`${w}: the game data has no released shadow ${species.name}; kept as shadow anyway`);
    }
    if (frustration && !shadow) problems.push(`${w}: "frustration" without "shadow" for ${species.name}; ignored`);

    // Max Battles: G-Max implies Dynamax, only some species have it, and Shadows can't take part.
    let gigantamax = Boolean(row.gigantamax);
    let dynamax = Boolean(row.dynamax) || gigantamax;
    if (gigantamax && !(species.id in GMAX_TYPES)) {
      problems.push(`${w}: ${species.name} has no Gigantamax form; kept as Dynamax only`);
      gigantamax = false;
    }
    if (shadow && dynamax) {
      problems.push(`${w}: ${species.name} is marked shadow and Dynamax, but shadows can't join Max Battles; dropped Dynamax`);
      dynamax = false;
      gigantamax = false;
    }

    if (!ivKnown) assumed.push(cp !== null ? `${species.name} ${cp} CP -> L${solved.level}` : `${species.name} L${solved.level}`);
    if (solved.diff > 0) inexact.push(`${species.name} ${cp} CP: closest is L${solved.level} at ${solved.cp} CP`);

    const chargedMoves = [...(row.chargedMoves ?? [])];
    if (shadow && frustration && !chargedMoves.length) chargedMoves.push(species.shadowMove ?? 'FRUSTRATION');
    const entry = normalizeEntry(gd, {
      pokemonId: species.id,
      level: solved.level,
      ivAtk: ivs[0],
      ivDef: ivs[1],
      ivSta: ivs[2],
      shadow,
      fastMove: row.fastMove ?? '',
      chargedMoves,
      mega,
      megaLevel: mega ? megaLevel : 1,
      dynamax,
      gigantamax,
      ...(ivKnown ? {} : { ivsAssumed: true }),
    });
    // normalizeEntry lists its defaults first; keep the Pokemon first, as hand-edited files read best that way.
    roster.push({ pokemonId: entry.pokemonId, ...entry });
  }

  return { roster, problems, corrections, inexact, totals, assumed };
}

// ---------------------------------------------------------------- plain-text lists

export function parseRosterList(gd, text) {
  const rows = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const [body, ...commentParts] = raw.split('#');
    const comment = commentParts.join('#');
    const line = body.trim();
    if (!line) return;
    const [namePart, cpPart, ivPart, ...rest] = line.split('|').map((s) => s.trim());
    const flags = rest.join('|');
    const shownPct = /(\d{1,3})\s*%/.exec(comment);
    rows.push({
      where: `line ${i + 1}`,
      name: namePart,
      cpText: cpPart,
      needCp: true,
      ivText: ivPart ?? '',
      pct: shownPct ? Number(shownPct[1]) : null,
      shadow: /\bshadow\b/i.test(flags),
      frustration: /\bfrustration\b/i.test(flags),
      mega: /\bmega\b/i.test(flags) ? (/mega=([A-Z_]+|\*)/i.exec(flags)?.[1]?.toUpperCase() ?? 'auto') : '',
      megaLevel: Number(/megaLevel=([1-4])/i.exec(flags)?.[1] ?? 1),
      dynamax: /\bdynamax\b/i.test(flags),
      gigantamax: /\b(gmax|g-max|gigantamax)\b/i.test(flags),
    });
  });
  return readRows(gd, rows);
}

// ---------------------------------------------------------------- CSV

/** Columns written by rosterToCsv. dynamax/gigantamax/cp came later, so they are last. */
export const CSV_HEADER = [
  'pokemonId', 'name', 'level', 'ivAtk', 'ivDef', 'ivSta', 'shadow', 'mega', 'megaLevel',
  'fastMove', 'chargedMove1', 'chargedMove2', 'dynamax', 'gigantamax', 'cp',
];

/**
 * Tolerant CSV reader: quoted fields, comma or semicolon separators (whichever the header uses),
 * a leading byte-order mark. Returns the non-blank rows with the file line each starts on.
 */
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const sep = first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = [];
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRow = () => {
    if (cell !== '' || cells.length) {
      cells.push(cell);
      rows.push({ line: start, cells });
    }
    cells = [];
    cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      endRow();
      if (ch === '\n') line++;
      start = line;
    } else cell += ch;
  }
  endRow();
  return rows;
}

const YES = /^(yes|y|x|true|1)$/i;
const NO = /^(no|n|false|0)$/i;

/** A roster CSV (see the top of this file) into entries. Returns { error } when it can't be read at all. */
export function parseRosterCsv(gd, text) {
  const table = parseCsv(text);
  if (!table.length) return { error: 'That file is empty.' };
  const header = table[0].cells.map((h) => h.trim().toLowerCase());
  const col = (...names) => names.map((n) => header.indexOf(n.toLowerCase())).find((i) => i >= 0) ?? -1;
  const cols = {
    pokemonId: col('pokemonId', 'id'),
    name: col('name', 'pokemon', 'species'),
    level: col('level'),
    cp: col('cp'),
    ivAtk: col('ivAtk', 'atk'),
    ivDef: col('ivDef', 'def'),
    ivSta: col('ivSta', 'sta', 'hp'),
    ivTotal: col('ivTotal', 'total'),
    stars: col('stars'),
    pct: col('pct', 'iv%', 'percent'),
    shadow: col('shadow'),
    dynamax: col('dynamax', 'dmax'),
    gigantamax: col('gigantamax', 'gmax', 'g-max'),
    mega: col('mega'),
    megaLevel: col('megaLevel'),
    fastMove: col('fastMove', 'fast'),
    charged1: col('chargedMove1', 'charged1'),
    charged2: col('chargedMove2', 'charged2'),
  };
  if (cols.pokemonId < 0 && cols.name < 0) {
    return { error: 'That CSV has no "pokemonId" or "name" column. Export one first to see the expected shape.' };
  }

  const rows = [];
  const problems = [];
  for (const { line, cells } of table.slice(1)) {
    if (cells.every((c) => !c.trim())) continue;
    const get = (key) => (cols[key] >= 0 ? (cells[cols[key]] ?? '').trim() : '');
    if (!get('pokemonId') && !get('name')) {
      problems.push(`row ${line}: no pokemonId or name`);
      continue;
    }
    const ivCells = [get('ivAtk'), get('ivDef'), get('ivSta')];
    let ivText = '?';
    if (ivCells.some((v) => v !== '' && v !== '?')) ivText = ivCells.join('/');
    else if (get('ivTotal')) ivText = `total=${get('ivTotal')}`;
    else if (get('stars')) ivText = get('stars') === '4' ? '15/15/15' : `stars=${get('stars')}`;
    const mega = get('mega');
    const pct = num(get('pct').replace('%', ''));
    rows.push({
      where: `row ${line}`,
      pokemonId: get('pokemonId'),
      name: get('name'),
      cpText: get('cp'),
      levelText: get('level'),
      ivText,
      pct: Number.isFinite(pct) ? pct : null,
      shadow: YES.test(get('shadow')),
      dynamax: YES.test(get('dynamax')),
      gigantamax: YES.test(get('gigantamax')),
      mega: !mega || NO.test(mega) ? '' : YES.test(mega) ? 'auto' : mega.toUpperCase(),
      megaLevel: num(get('megaLevel')) ?? 1,
      fastMove: get('fastMove'),
      chargedMoves: [get('charged1'), get('charged2')].filter(Boolean),
    });
  }
  const out = readRows(gd, rows);
  out.problems = [...problems, ...out.problems];
  return out;
}

/** A roster as CSV, readable by parseRosterCsv. Guessed IVs are written as "?" so they stay marked. */
export function rosterToCsv(gd, roster) {
  const byId = new Map(gd.pokemon.map((p) => [p.id, p]));
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [CSV_HEADER.join(',')];
  for (const e of roster) {
    const p = byId.get(e.pokemonId);
    const ivs = [e.ivAtk, e.ivDef, e.ivSta];
    lines.push(
      [
        e.pokemonId,
        quote(p?.name ?? ''),
        e.level,
        ...(e.ivsAssumed ? ['?', '?', '?'] : ivs),
        e.shadow ? 'yes' : 'no',
        e.mega ?? '',
        e.mega ? (e.megaLevel ?? 1) : '',
        e.fastMove ?? '',
        e.chargedMoves?.[0] ?? '',
        e.chargedMoves?.[1] ?? '',
        e.dynamax ? 'yes' : 'no',
        e.gigantamax ? 'yes' : 'no',
        p ? cpOf(gd, p, e.level, ivs) : '',
      ].join(','),
    );
  }
  return lines.join('\n');
}

/**
 * Adds `incoming` to `existing` without duplicates, in two passes.
 *
 * 1. Exact: a row matches a roster entry with the same Pokemon, level, IVs and shadow state
 *    (entryKey). Each entry is matched once: identical Pokemon are common (two Rayquaza from raids
 *    with the same IVs), so a file listing two where the roster has one adds the second, and
 *    importing the same file again adds nothing.
 * 2. Powered up: a row left over still matches a leftover entry of the same species (any form, when
 *    `gd` is given), the same IVs and shadow state, at the same level or higher -- the same Pokemon
 *    after power-ups, or after changing form (Zacian picking up its sword). Its level, and its form,
 *    are taken from the row; moves the new form can't use are dropped. Rows with guessed IVs never
 *    match this way, and the closest level wins when several could.
 *
 * Either way a matched row can only tick Dynamax / G-Max, never untick them or change anything else
 * (moves, mega settings and other edits made in the app survive), and nothing is ever removed.
 * Returns a new roster; the inputs are not changed.
 */
export function mergeRoster(existing, incoming, gd = null) {
  const roster = existing.map((e) => ({ ...e }));
  const unmatched = new Map();
  for (const e of roster) {
    const key = entryKey(e);
    if (!unmatched.has(key)) unmatched.set(key, []);
    unmatched.get(key).push(e);
  }
  const added = [];
  const already = [];
  const ticked = [];
  const updated = [];
  const tickFlags = (have, e) => {
    const tick = {};
    if (e.dynamax && !have.dynamax) tick.dynamax = true;
    if (e.gigantamax && !have.gigantamax) Object.assign(tick, { gigantamax: true, dynamax: true });
    Object.assign(have, tick);
    return Object.keys(tick).length > 0;
  };

  // pass 1: exact matches
  const rest = [];
  for (const e of incoming) {
    const have = unmatched.get(entryKey(e))?.shift();
    if (!have) {
      rest.push(e);
      continue;
    }
    (tickFlags(have, e) ? ticked : already).push(have);
  }

  // pass 2: the same Pokemon at a higher level, or in another form
  const byId = gd ? new Map(gd.pokemon.map((p) => [p.id, p])) : null;
  const speciesOf = (id) => byId?.get(id)?.pokemonId ?? id;
  const sameMon = (have, e) =>
    speciesOf(have.pokemonId) === speciesOf(e.pokemonId) &&
    have.ivAtk === e.ivAtk &&
    have.ivDef === e.ivDef &&
    have.ivSta === e.ivSta &&
    Boolean(have.shadow) === Boolean(e.shadow) &&
    e.level >= have.level;
  const leftover = [...unmatched.values()].flat();
  for (const e of rest) {
    const candidates = e.ivsAssumed ? [] : leftover.filter((have) => sameMon(have, e));
    if (!candidates.length) {
      const copy = { ...e };
      roster.push(copy);
      added.push(copy);
      continue;
    }
    const have = candidates.reduce((a, b) => (b.level - e.level > a.level - e.level ? b : a));
    leftover.splice(leftover.indexOf(have), 1);
    const from = { pokemonId: have.pokemonId, level: have.level };
    have.level = e.level;
    if (have.pokemonId !== e.pokemonId) {
      have.pokemonId = e.pokemonId;
      const p = byId?.get(e.pokemonId);
      if (p) {
        if (have.fastMove && !p.fastMoves.includes(have.fastMove)) have.fastMove = '';
        have.chargedMoves = (have.chargedMoves ?? []).filter((m) => p.chargedMoves.includes(m) || m === p.shadowMove);
        const megaOk = have.mega === '*' ? (p.tempEvos ?? []).length > 1 : (p.tempEvos ?? []).some((t) => t.suffix === have.mega);
        if (have.mega && !megaOk) {
          have.mega = '';
          have.megaLevel = 1;
        }
      }
    }
    delete have.ivsAssumed;
    tickFlags(have, e);
    updated.push({ entry: have, from });
  }
  return { roster, added, already, ticked, updated };
}

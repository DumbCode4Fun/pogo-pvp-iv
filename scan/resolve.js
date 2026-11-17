/**
 * From the text on a tile to what it says about the Pokémon.
 *
 * parseName splits a name line into the letters and, when the Nicknamer wrote it, the IVs:
 *   "Teddiur⓯❼⓯⁸²"  ->  label "Teddiur", ivs [15, 7, 15], pct 82
 *   "Mewtwo¹⁰⁰"      ->  label "Mewtwo",  ivs [15, 15, 15], pct 100
 *   "Snorlax"        ->  label "Snorlax", ivs null
 * The superscript % is a second opinion on the three circled digits: `checked` is true when it agrees
 * (the Nicknamer rounds, older names were floored, so either is accepted), false when it does not, and
 * null when there was nothing to compare.
 *
 * Pure: no DOM, no Node.
 */
import { cpOf } from '../raid/engine.js';

export const CIRCLED = ['⓿', '❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '❿', '⓫', '⓬', '⓭', '⓮', '⓯'];
export const SUPERSCRIPT = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
/** What readName gives for a disc whose digit it could not read (not ●, which players type themselves). */
export const UNREAD_DISC = '◌';

const superValue = (text) => (text ? Number([...text].map((c) => SUPERSCRIPT.indexOf(c)).join('')) : null);

export function parseName(text) {
  const chars = [...String(text ?? '')];
  const isDisc = (c) => CIRCLED.includes(c) || c === UNREAD_DISC;
  // the badge is three discs and then only the % (which may not have been readable)
  let end = chars.length;
  // (an unread superscript can come back as '?', or as a stray dot or apostrophe)
  while (end > 0 && (SUPERSCRIPT.includes(chars[end - 1]) || "?'.".includes(chars[end - 1]))) end--;
  let start = end;
  while (start > 0 && isDisc(chars[start - 1])) start--;
  const tail = chars.slice(end).join('');
  const pct = tail && [...tail].every((c) => SUPERSCRIPT.includes(c)) ? superValue(tail) : null;
  if (end - start === 3 && tail.length <= 3) {
    const discs = chars.slice(start, end);
    const ivs = discs.map((c) => CIRCLED.indexOf(c));
    const label = chars.slice(0, start).join('');
    if (ivs.some((v) => v < 0)) return { label, ivs: null, pct, checked: false, discs: discs.join('') };
    const exact = ((ivs[0] + ivs[1] + ivs[2]) / 45) * 100;
    const checked = pct === null ? null : pct === Math.round(exact) || pct === Math.floor(exact);
    return { label, ivs, pct, checked, discs: discs.join('') };
  }
  // a perfect one has no discs, just the name and 100
  let sup = chars.length;
  while (sup > 0 && SUPERSCRIPT.includes(chars[sup - 1])) sup--;
  if (superValue(chars.slice(sup).join('')) === 100 && sup > 0) return { label: chars.slice(0, sup).join(''), ivs: [15, 15, 15], pct: 100, checked: true, discs: '' };
  // no IV badge: the whole line is the name
  return { label: chars.join(''), ivs: null, pct: null, checked: null, discs: '' };
}

/**
 * A nickname of the other common kind: the species name, then a number, then maybe a marker
 *   "Tortipouss44"  IV total 44        "Minidraco2"  2 stars (total 30-36)       "Mystherb100"  15/15/15
 *   "Mewtwo41*", "Togetic38f", "Krabby38dyn", "Mewtwo43●": a marker after the number, ignored
 * Returns { label, kind: 'total' | 'stars' | 'hundo', value, lo, hi } or null. Stars are the appraisal's
 * 0-3 (3 stars: total 37-44); a total is 23-45. Other numbers are not taken as anything.
 */
export const STAR_TOTALS = { 0: [0, 22], 1: [23, 29], 2: [30, 36], 3: [37, 44] };

/** Vivillon pattern names, French as the game shows them, for Scatterbug nicknames. */
const VIVILLON_PATTERNS = ['Archipel', 'Banquise', 'Continent', 'Cyclone', 'Floraison', 'Mangrove', 'Métropole', 'Rivage', 'Sécheresse', 'Soleil Levant', 'Soleillevant', 'Verdure', 'Toundra', 'Savane', 'Jungle', 'Océan', 'Mousson', 'Pomponnette', 'Éventail', 'Marais', 'Sable'];
export function parseTotalName(text) {
  const m = /^(.*?[^\d\s*])\s*\**(\d{1,3})([^\d]*)$/u.exec(String(text ?? '').trim());
  if (!m) return null;
  const label = m[1].trim();
  const n = Number(m[2]);
  if (n === 100) return { label, kind: 'hundo', value: 100, lo: 45, hi: 45 };
  if (n >= 0 && n <= 3 && m[2].length === 1) return { label, kind: 'stars', value: n, lo: STAR_TOTALS[n][0], hi: STAR_TOTALS[n][1] };
  if (n >= 23 && n <= 45) return { label, kind: 'total', value: n, lo: n, hi: n };
  return null;
}

// ---------------------------------------------------------------- which Pokémon


/**
 * Names compared loosely: case, accents and punctuation aside, and i / l / I as one (they read alike).
 * The game writes Nidoran♂ where the game data says "Nidoran Male".
 */
const nameKey = (s) =>
  String(s ?? '')
    .replace('♂', ' male')
    .replace('♀', ' female')
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/i/g, 'l');

/** True when two strings differ by at most one letter changed, added or dropped. */
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * resolve(tile) says which Pokémon a scanned tile is, as far as the tile can tell:
 *   { name, pokemonId, level, ivs, pct, sure, note }
 * name: what to call it in a roster CSV: the species, with its form when the CP settled one
 *       ("Giratina (Origin)"), or the tile's own text when no species fits (a hand-typed nickname).
 * pokemonId / level: set when name, CP and IVs leave exactly one answer.
 * sure: false when a person should look (several species fit, the CP fits none, the IVs and the %
 *       disagree, an unreadable glyph).
 * form: false when the name has forms with different stats and nothing on the tile says which one (a
 *       plain "Giratina"); the reading itself is fine, so `sure` is not touched.
 *
 * How names are matched:
 *  - a plain name is the species as the game shows it; the form is not shown, so without IVs the first
 *    form is named and the CSV reader's own form check has nothing more to go on;
 *  - a Nicknamer name is the name the Pokémon had when it was named, cut to fit 12 characters, so
 *    "Piloswi" is tried as every species starting with it and everything those evolve into
 *    (`evolutions`: { id: [ids it evolves into] }, from the PvP data), and the CP picks among them.
 */
export function createResolver(gd, { evolutions = {}, names = {} } = {}) {
  const byId = new Map(gd.pokemon.map((p) => [p.id, p]));
  const forms = gd.pokemon.filter((p) => !p.tempEvo && !/^(Mega|Primal) /.test(p.name));
  const plain = new Set(forms.map((p) => p.id));
  const byKey = new Map();
  const addKey = (key, list) => {
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    for (const p of list) if (!byKey.get(key).includes(p)) byKey.get(key).push(p);
  };
  for (const p of forms) addKey(nameKey(p.name.replace(/\s*\(.*\)$/, '')), [p]);
  // the species in other languages (names.json: { fr: { dex: name } }), for boxes played in them
  const byDex = new Map();
  for (const p of forms) {
    if (!byDex.has(p.dex)) byDex.set(p.dex, []);
    byDex.get(p.dex).push(p);
  }
  for (const [lang, table] of Object.entries(names)) {
    if (!table || typeof table !== 'object') continue;
    for (const [dex, name] of Object.entries(table)) if (byDex.has(Number(dex))) addKey(nameKey(name), byDex.get(Number(dex)));
  }
  // Scatterbug is often named after its Vivillon pattern (seen in a French box; the patterns are the same
  // words in English too, where they are English already)
  const scatterbug = forms.filter((p) => p.pokemonId === 'SCATTERBUG');
  if (scatterbug.length) for (const pattern of VIVILLON_PATTERNS) if (!byKey.has(nameKey(pattern))) addKey(nameKey(pattern), scatterbug);
  const levels = Object.keys(gd.cpm)
    .map(Number)
    .filter((l) => l <= 51)
    .sort((a, b) => a - b);
  const levelFor = (p, ivs, cp) => {
    // CP never drops as the level rises: a binary search for the first level at or past it
    let lo = 0;
    let hi = levels.length - 1;
    if (cpOf(gd, p, levels[hi], ivs) < cp) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cpOf(gd, p, levels[mid], ivs) < cp) lo = mid + 1;
      else hi = mid;
    }
    return cpOf(gd, p, levels[lo], ivs) === cp ? levels[lo] : null;
  };
  /** Every IV split whose total is lo..hi (cached). */
  const splitCache = new Map();
  const splits = (lo, hi) => {
    const key = `${lo}-${hi}`;
    if (!splitCache.has(key)) {
      const out = [];
      for (let a = 0; a <= 15; a++) for (let d = 0; d <= 15; d++) for (let s = 0; s <= 15; s++) if (a + d + s >= lo && a + d + s <= hi) out.push([a, d, s]);
      splitCache.set(key, out);
    }
    return splitCache.get(key);
  };
  /** Every form of everything this species can become, itself included. */
  const line = (p) => {
    const seen = new Set([p.id]);
    const todo = [p.id];
    while (todo.length) {
      for (const next of evolutions[todo.pop()] ?? []) {
        if (!seen.has(next) && plain.has(next)) {
          seen.add(next);
          todo.push(next);
        }
      }
    }
    return [...seen].map((id) => byId.get(id));
  };
  // forms of one species with the same stats are one answer; two species with the same stats (Gardevoir and
  // Gallade, Slowbro and Slowking, Solgaleo and Lunala) are not
  const sameStats = (a, b) => a.pokemonId === b.pokemonId && a.stats.atk === b.stats.atk && a.stats.def === b.stats.def && a.stats.sta === b.stats.sta;

  /** Species named by the start of a nickname: the whole name, its first letters, or a name with letters after it. */
  const speciesFor = (key, exact) => {
    let starts = exact;
    if (!starts.length && key.length >= 3) for (const [k, list] of byKey) if (k.startsWith(key)) starts = starts.concat(list);
    if (!starts.length && key.length >= 4) {
      // "Ténéfixju", "Lillitxx": the longest species name the nickname starts with
      let best = '';
      for (const k of byKey.keys()) if (k.length >= 4 && key.startsWith(k) && k.length > best.length) best = k;
      if (best) starts = byKey.get(best);
    }
    let guessed = false;
    if (!starts.length && key.length >= 5) {
      for (const [k, list] of byKey) if ([key.length - 1, key.length, key.length + 1].some((n) => n <= k.length && oneEdit(key, k.slice(0, n)))) starts = starts.concat(list);
      guessed = starts.length > 0;
    }
    return { starts: [...new Set(starts)], guessed };
  };

  /**
   * A "name + IV total" (or stars) nickname: which of the species and what it evolved into can show this CP
   * with some IV split of that total. The named one wins when it fits; otherwise the first that does.
   */
  function byTotal(total, key, exact, cp, out, flag, tile) {
    const { starts, guessed } = speciesFor(key, exact);
    const baseOf = (p) => p.name.replace(/\s*\(.*\)$/, '');
    if (total.kind === 'total') out.ivTotal = total.value;
    else out.stars = total.value;
    if (!starts.length) {
      flag(`"${total.label}" names no species`);
      return out;
    }
    out.name = baseOf(starts[0]);
    if (cp === null) return out;
    const shadowOk = (p) => !tile.shadow || p.shadowAvailable;
    const pool = [...new Set(starts.flatMap((p) => line(p)).flatMap((p) => byKey.get(nameKey(baseOf(p))) ?? [p]))].filter(shadowOk);
    const fits = [];
    for (const p of pool) {
      const found = [];
      for (const ivs of splits(total.lo, total.hi)) {
        const level = levelFor(p, ivs, cp);
        if (level !== null) found.push({ ivs, level });
      }
      if (found.length) fits.push({ p, found });
    }
    if (!fits.length) {
      flag(`no IVs ${total.kind === 'total' ? `adding up to ${total.value}` : `of ${total.value} star${total.value === 1 ? '' : 's'}`} give ${out.name} (or what it evolves into) ${cp} CP`);
      return out;
    }
    const distinct = fits.filter((f, i) => fits.findIndex((g) => sameStats(g.p, f.p)) === i);
    const named = distinct.filter((f) => starts.includes(f.p));
    const chosen = (named.length ? named : distinct)[0];
    out.name = chosen.p.name;
    out.pokemonId = chosen.p.id;
    if (chosen.found.length === 1) {
      // the only split that fits, but only for the stage the nickname names: not as sure as a Nicknamer badge
      out.ivs = chosen.found[0].ivs;
      out.level = chosen.found[0].level;
      out.ivsFrom = 'total';
    } else {
      // several splits fit: the one nearest the middle of the range, most even first (the CSV reader's choice)
      const mid = (total.lo + total.hi) / 2;
      const sum = (v) => v[0] + v[1] + v[2];
      const spread = (v) => Math.max(...v) - Math.min(...v);
      const pick = [...chosen.found].sort((x, y) => Math.abs(sum(x.ivs) - mid) - Math.abs(sum(y.ivs) - mid) || spread(x.ivs) - spread(y.ivs))[0];
      out.split = { ivs: pick.ivs, level: pick.level, fits: chosen.found.length };
    }
    const others = distinct.filter((f) => f !== chosen && speciesOfId(f.p) !== speciesOfId(chosen.p));
    if (others.length) {
      out.stageOpen = true;
      out.note = [out.note, `another stage also fits the CP: ${others.map((f) => baseOf(f.p)).join(', ')}`].filter(Boolean).join('; ');
    }
    if (guessed) out.note = [out.note, `name read as "${total.label}"`].filter(Boolean).join('; ');
    return out;
  }
  const speciesOfId = (p) => p.pokemonId;

  return function resolve(tile) {
    const parsed = parseName(tile.name);
    const cp = /^\d+$/.test(tile.cp) ? Number(tile.cp) : null;
    const out = { name: parsed.label, pokemonId: null, level: null, ivs: parsed.ivs, pct: parsed.pct, sure: true, note: '' };
    const flag = (note) => {
      out.sure = false;
      out.note = out.note ? `${out.note}; ${note}` : note;
    };
    if (cp === null) flag(tile.cp ? `CP read as "${tile.cp}"` : 'no CP read');
    if (/\?/.test(tile.name)) flag('part of the name could not be read');
    if (parsed.discs && !parsed.ivs) flag('an IV digit could not be read');
    if (parsed.checked === false && parsed.ivs) flag(`IVs ${parsed.ivs.join('/')} do not give the ${parsed.pct}% on the tile`);

    // the other nickname kind: name + IV total, stars, or 100 (see parseTotalName)
    const total = parsed.ivs || parsed.discs || byKey.has(nameKey(tile.name)) ? null : parseTotalName(tile.name);
    if (total?.kind === 'hundo') {
      parsed.label = total.label;
      parsed.ivs = [15, 15, 15];
      out.ivs = parsed.ivs;
      out.pct = 100;
    }
    const key = nameKey(total ? total.label : parsed.label);
    const badge = Boolean(parsed.ivs || parsed.discs);
    const exact = byKey.get(key) ?? [];
    if (total && !badge) return byTotal(total, key, exact, cp, out, flag, tile);
    if (!badge) {
      // a plain name, or a nickname that starts with one ("Ténéfixju"); a loose one-letter match is too
      // loose without IVs or a CP check to confirm it
      const named = exact.length ? exact : speciesFor(key, exact);
      const found = exact.length ? exact : named.guessed ? [] : named.starts;
      if (!found.length) {
        if (key) flag('not a species name (a nickname?)');
        return out;
      }
      // The game shows no form. What can still narrow it down: only some forms exist as Shadows, and
      // the CP has to be within reach of the form at all. Forms that share stats are one answer.
      const base = found[0].name.replace(/\s*\(.*\)$/, '');
      const all = found.filter((p) => p.pokemonId === found[0].pokemonId);
      let forms = all;
      const narrow = (keep) => {
        const left = forms.filter(keep);
        if (left.length) forms = left;
      };
      if (tile.shadow) narrow((p) => p.shadowAvailable);
      if (cp !== null) narrow((p) => cp <= cpOf(gd, p, levels[levels.length - 1], [15, 15, 15]) && cp >= cpOf(gd, p, 1, [0, 0, 0]));
      out.name = base;
      if (forms.every((p) => sameStats(p, forms[0]))) {
        out.pokemonId = forms[0].id;
        if (forms.length < all.length) out.name = forms[0].name;
      } else {
        out.note = [out.note, `the tile does not show which form: ${forms.map((p) => p.name).join(' or ')}`].filter(Boolean).join('; ');
        out.form = false;
      }
      return out;
    }

    // a Nicknamer name: the full old name, or its first letters
    let starts = exact;
    if (!starts.length && key.length >= 3) for (const [k, list] of byKey) if (k.startsWith(key)) starts = starts.concat(list);
    // One letter dropped or misread ("Ladoru", "Lecbonk"): species whose name starts one edit away. Taken
    // only if the CP then fits, which a wrong species almost never does.
    let guessed = false;
    if (!starts.length && key.length >= 5) {
      for (const [k, list] of byKey) if ([key.length - 1, key.length, key.length + 1].some((n) => n <= k.length && oneEdit(key, k.slice(0, n)))) starts = starts.concat(list);
      guessed = starts.length > 0;
    }
    const baseOf = (p) => p.name.replace(/\s*\(.*\)$/, '');
    const pool = [...new Set(starts.flatMap((p) => line(p)).flatMap((p) => byKey.get(nameKey(baseOf(p))) ?? [p]))];
    if (!starts.length) flag('the name matches no species');
    else out.name = baseOf(starts[0]);

    // The badge is read twice over (three discs, and their sum as a %), and the CP has to be reachable
    // with those IVs. Glyphs that small get misread, so every plausible reading is weighed and the one
    // that agrees with itself and with the CP wins; the reading as it stands only wins ties.
    const shadowOk = (p) => !tile.shadow || p.shadowAvailable || !pool.some((o) => o.shadowAvailable);
    const fitting = (ivs) => (cp === null || !pool.length ? [] : pool.filter(shadowOk).map((p) => ({ p, level: levelFor(p, ivs, cp) })).filter((f) => f.level !== null));
    const agrees = (ivs, pct) => {
      const exact = ((ivs[0] + ivs[1] + ivs[2]) / 45) * 100;
      return pct === Math.round(exact) || pct === Math.floor(exact);
    };
    const asRead = parsed.ivs;
    const discOptions = (tile.badge?.discs ?? (asRead ? asRead.map((v) => [{ ch: CIRCLED[v], score: 1 }]) : [])).map((alts) =>
      alts.filter((a) => CIRCLED.includes(a.ch)).map((a) => ({ iv: CIRCLED.indexOf(a.ch), score: a.score })),
    );
    if (discOptions.length !== 3 || discOptions.some((o) => !o.length)) return out;
    for (const o of discOptions) o.sort((x, y) => y.score - x.score);
    let pctOptions = [{ pct: parsed.pct, score: 0 }];
    if (tile.badge?.pct?.length && tile.badge.pct.every((alts) => alts.some((a) => SUPERSCRIPT.includes(a.ch)))) {
      pctOptions = tile.badge.pct.reduce(
        (sofar, alts) => sofar.flatMap((s) => alts.filter((a) => SUPERSCRIPT.includes(a.ch)).map((a) => ({ pct: s.pct * 10 + SUPERSCRIPT.indexOf(a.ch), score: s.score + a.score }))),
        [{ pct: 0, score: 0 }],
      );
    }
    const canCheckCp = cp !== null && pool.length > 0;
    const reading = (ivs, o, changed) => {
      const fits = fitting(ivs);
      return { ivs, pct: o.pct, fits, changed, cpOk: !canCheckCp || fits.length > 0, pctOk: o.pct === null || agrees(ivs, o.pct), score: ivs.score + o.score };
    };
    const read = discOptions.map((o) => o[0]);
    const withScore = (picks) => Object.assign(picks.map((d) => d.iv), { score: picks.reduce((sum, d) => sum + d.score, 0) });
    const readPct = pctOptions.find((o) => o.pct === parsed.pct) ?? pctOptions[0];
    let pick = reading(withScore(read), readPct, false);
    if (!(pick.cpOk && pick.pctOk)) {
      // One misread glyph is likely, two at once are not: try each disc's runners-up in turn (with any
      // reading of the %), and accept a change only when it makes everything agree. A nickname pasted on
      // the wrong Pokémon agrees with nothing, and then it is reported as it stands, marked.
      const tries = [];
      for (const o of pctOptions) tries.push(reading(withScore(read), o, o !== readPct));
      for (let d = 0; d < 3; d++) {
        for (const alt of discOptions[d].slice(1)) {
          if (alt.score < discOptions[d][0].score - 0.12) continue;
          const picks = read.map((x, i) => (i === d ? alt : x));
          for (const o of pctOptions) tries.push(reading(withScore(picks), o, true));
        }
      }
      const good = tries.filter((r) => r.cpOk && r.pctOk).sort((x, y) => y.score - x.score);
      if (good.length) {
        const before = pick.ivs.join('/');
        pick = good[0];
        if (pick.ivs.join('/') !== before) out.note = [out.note, `IVs read as ${before}; ${pick.ivs.join('/')} is what fits the CP and the %`].filter(Boolean).join('; ');
        const rival = good.find((r) => r.ivs.join() !== pick.ivs.join());
        if (rival) flag(`${rival.ivs.join('/')} would fit as well`);
      }
    }
    out.note = out.note
      .split('; ')
      .filter((n) => n && !/do not give the/.test(n))
      .join('; ');
    out.sure = !out.note || /is what fits the CP and the %$/.test(out.note);
    out.ivs = [...pick.ivs];
    out.pct = pick.pct;
    if (!pick.pctOk) flag(`IVs ${pick.ivs.join('/')} do not give the ${pick.pct}% on the tile`);
    if (canCheckCp && !pick.cpOk) flag(`no level of ${out.name} (or what it evolves into) gives ${cp} CP with ${pick.ivs.join('/')}`);
    if (!pick.fits.length) {
      if (guessed) {
        out.name = parsed.label;
        flag('the name matches no species');
      }
      return out;
    }

    // forms that share stats are one answer; otherwise the species named on the tile wins over its evolutions
    const distinct = pick.fits.filter((f, i) => pick.fits.findIndex((g) => sameStats(g.p, f.p)) === i);
    const named = distinct.filter((f) => starts.includes(f.p));
    const chosen = (named.length ? named : distinct)[0];
    out.name = chosen.p.name;
    out.pokemonId = chosen.p.id;
    out.level = chosen.level;
    if (distinct.length > 1) {
      // The species named on the tile fitting is the plain reading; that something it evolves into
      // would also reach this CP is worth a note, not a question. Two forms of it both fitting is.
      const also = `also fits ${distinct.filter((f) => f !== chosen).map((f) => `${f.p.name} L${f.level}`).join(', ')}`;
      if (named.length === 1) out.note = [out.note, also].filter(Boolean).join('; ');
      else flag(also);
    }
    if (guessed) out.note = [out.note, `name read as "${parsed.label}"`].filter(Boolean).join('; ');
    return out;
  };
}

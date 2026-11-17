/**
 * From a scan to a roster change: what the recording says against what is saved.
 *
 *   const incoming = scanToEntries(gd, resolvedTiles);   // tiles as resolve.js left them
 *   const diff = reconcile(gd, roster, incoming, { evolutions });
 *   const next = applyDiff(gd, roster, diff, choices);
 *
 * The game shows no Pokémon id, so a scanned tile is matched to a saved entry by what both show, in
 * passes from surest to least sure:
 *   1. same     the same species and shadow state at the same CP, with IVs that agree where both are
 *               known. Two identical Mewtwo are matched by count, never by position.
 *   2. changed  known IVs on both sides, same family and shadow state, and the tile at a higher CP: the
 *               same Pokémon powered up, evolved or changed form since.
 *   3. changed  IVs known on one side only (an un-nicknamed Pokémon): they must give the other side's CP
 *               exactly, at a level no lower than before. Few levels fit by chance, so this is a strong test.
 *   4. changed  the saved entry's CP is only an estimate (IVs were never known): the same species and
 *               shadow state within a few percent of the CP is taken to be it, and the tile's CP replaces
 *               the estimate.
 * What is left on the tile side is new; what is left on the saved side is gone (transferred, traded, or
 * not in the part of the box that was recorded). Tiles that name no species are listed apart, to be
 * skipped or settled by hand.
 *
 * Applying keeps everything typed in the app on a matched entry (moves, mega, Mega Level) and takes from
 * the tile what the game shows: CP, level, the IVs when the tile has them, and the shadow, Dynamax and
 * G-Max badges, which a tile shows reliably either way.
 *
 * Pure: no DOM, no Node.
 */
import { readRows } from '../raid/roster-import.js';
import { entryCp, normalizeEntry, cpOf, cpmLevels } from '../raid/engine.js';

/** How far an estimated CP may be from the CP on the tile and still be taken as the same Pokémon. */
export const ESTIMATE_SLACK = 0.04;

/**
 * Resolved tiles (resolve.js output merged with the tile: { cp, name, pokemonId, species, ivs, pct,
 * shadow, dynamax, gigantamax, ... }) to incoming entries: [{ tile, entry, problem }]. `entry` is a roster
 * entry as an import would make it (level solved from the CP, form corrected by it when the IVs are
 * known, `seenCp` kept); `problem` says why a tile could not become one.
 */
export function scanToEntries(gd, tiles) {
  const rows = [];
  const out = tiles.map((tile) => {
    const cp = /^\d+$/.test(String(tile.cp ?? '')) ? String(tile.cp) : '';
    if (!cp) return { tile, entry: null, problem: tile.cp ? `CP read as "${tile.cp}"` : 'no CP read' };
    if (!tile.pokemonId && !tile.species) return { tile, entry: null, problem: 'no name read' };
    const row = {
      where: `row ${tile.row}${tile.col ?? ''}`,
      pokemonId: tile.pokemonId ?? '',
      name: tile.pokemonId ? '' : tile.species,
      cpText: cp,
      ivText: tile.ivs ? tile.ivs.join('/') : '?',
      pct: null,
      shadow: Boolean(tile.shadow),
      dynamax: Boolean(tile.dynamax),
      gigantamax: Boolean(tile.gigantamax),
      mega: '',
    };
    const item = { tile, entry: null, problem: null, row };
    rows.push(row);
    return item;
  });
  // one pass over all rows; `sources` says which row each entry came from
  const read = readRows(gd, rows);
  const entryOf = new Map(read.sources.map((row, i) => [row, read.roster[i]]));
  for (const item of out) {
    if (!item.row) continue;
    const entry = entryOf.get(item.row);
    if (entry) {
      // the CP on the tile is the one to find it by, whether or not level and IVs give it back
      entry.seenCp = Number(item.row.cpText);
      item.entry = entry;
    } else {
      item.problem = `"${item.tile.name ?? item.tile.species}" names no Pokémon`;
    }
    delete item.row;
  }
  return out;
}

/**
 * Lines `incoming` (from scanToEntries) up with `roster`. Returns
 *   { same, changed, unsure, added, gone, unreadable }
 * same / changed: [{ have, rosterIndex, item, next, why }]   added: [item]   gone: [{ have, rosterIndex }]
 * `next` is what a matched entry becomes from the tile (species, level, CP, badges; IVs when known on
 * either side).
 * unsure: possible pairs, shaped like changed ones, that only apply when confirmed.
 * unreadable: [item] (tiles with no entry). `why` says, for a change, what changed.
 * `evolutions` ({ id: [ids it evolves into] }) lets pass 2 follow evolutions; without it only forms
 * of the same species match.
 */
export function reconcile(gd, roster, incoming, { evolutions = {} } = {}) {
  const byId = new Map(gd.pokemon.map((p) => [p.id, p]));
  const speciesOf = (id) => byId.get(id)?.pokemonId ?? id;

  // every species a Pokémon can be or become, by species (forms share a species)
  const familyCache = new Map();
  const family = (id) => {
    const key = speciesOf(id);
    if (familyCache.has(key)) return familyCache.get(key);
    const seen = new Set([key]);
    const todo = [key, ...gd.pokemon.filter((p) => p.pokemonId === key).map((p) => p.id)];
    while (todo.length) {
      for (const next of evolutions[todo.pop()] ?? []) {
        const s = speciesOf(next);
        if (!seen.has(s)) {
          seen.add(s);
          todo.push(next, ...gd.pokemon.filter((p) => p.pokemonId === s).map((p) => p.id));
        }
      }
    }
    familyCache.set(key, seen);
    return seen;
  };
  const ivsOf = (e) => (e.ivsAssumed ? null : [e.ivAtk, e.ivDef, e.ivSta]);
  const savedIvs = (e) => (e.ivsAssumed ? {} : { ivAtk: e.ivAtk, ivDef: e.ivDef, ivSta: e.ivSta, ivsAssumed: undefined });
  const sameIvs = (a, b) => !a || !b || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
  const cpOfSaved = (e) => entryCp(gd, e, byId.get(e.pokemonId));

  const readable = incoming.filter((x) => x.entry);
  const unreadable = incoming.filter((x) => !x.entry);
  const left = roster.map((have, rosterIndex) => ({ have, rosterIndex, cp: cpOfSaved(have) }));
  const same = [];
  const changed = [];
  let todo = readable;

  const formsOf = new Map();
  for (const p of gd.pokemon) {
    if (p.tempEvo || /^(Mega|Primal) /.test(p.name)) continue;
    if (!formsOf.has(p.pokemonId)) formsOf.set(p.pokemonId, []);
    formsOf.get(p.pokemonId).push(p);
  }
  const levels = cpmLevels(gd);
  /**
   * The form and level (at or above `from`) at which these IVs give exactly `cp`, trying the forms of
   * `speciesId` with `prefer` first: { pokemonId, level } or null.
   */
  const reach = (speciesId, ivs, cp, from, prefer) => {
    const forms = [...(formsOf.get(speciesOf(speciesId)) ?? [])].sort((x, y) => (y.id === prefer) - (x.id === prefer));
    for (const f of forms) for (const l of levels) if (l >= from && cpOf(gd, f, l, ivs) === cp) return { pokemonId: f.id, level: l };
    return null;
  };

  /**
   * One pass: each item takes the closest leftover saved entry that `fits` it, if any. `fits` returns
   * null for no, or what the match settles ({} or { pokemonId, level, ivs }).
   */
  const pass = (fits, distance) => {
    const rest = [];
    for (const item of todo) {
      let best = null;
      left.forEach((saved, i) => {
        const settles = fits(saved, item);
        if (!settles) return;
        const d = distance(saved, item, settles);
        if (!best || d < best.d) best = { i, d, settles };
      });
      if (!best) rest.push(item);
      else record(left.splice(best.i, 1)[0], item, best.settles);
    }
    todo = rest;
  };

  /** What the entry becomes: the tile's reading, with what the match settled on top. */
  const result = (saved, item, settles) => ({ ...item.entry, ...settles });
  const what = (saved, item, next) => {
    const h = saved.have;
    const out = [];
    if (speciesOf(h.pokemonId) !== speciesOf(next.pokemonId)) out.push(`evolved into ${byId.get(next.pokemonId)?.name ?? next.pokemonId}`);
    else if (h.pokemonId !== next.pokemonId) out.push(`form is ${byId.get(next.pokemonId)?.name ?? next.pokemonId}`);
    if (saved.cp.cp !== next.seenCp) out.push(`CP ${saved.cp.exact ? '' : '~'}${saved.cp.cp} → ${next.seenCp}`);
    if (h.ivsAssumed && !next.ivsAssumed) out.push(`IVs now known: ${next.ivAtk}/${next.ivDef}/${next.ivSta}`);
    if (Boolean(h.dynamax) !== Boolean(next.dynamax)) out.push(next.dynamax ? 'Dynamax' : 'no longer Dynamax');
    if (Boolean(h.gigantamax) !== Boolean(next.gigantamax)) out.push(next.gigantamax ? 'G-Max' : 'no longer G-Max');
    if (Boolean(h.shadow) !== Boolean(next.shadow)) out.push(next.shadow ? 'shadow' : 'purified');
    return out;
  };
  const record = (saved, item, settles) => {
    const next = result(saved, item, settles);
    const why = what(saved, item, next);
    (why.length ? changed : same).push({ have: saved.have, rosterIndex: saved.rosterIndex, item, next, why });
  };
  const sameShadow = (s, x) => Boolean(s.have.shadow) === Boolean(x.entry.shadow);
  const inFamily = (s, x) => family(s.have.pokemonId).has(speciesOf(x.entry.pokemonId));

  // 1. the same Pokémon, as it was
  pass(
    (s, x) =>
      speciesOf(s.have.pokemonId) === speciesOf(x.entry.pokemonId) && sameShadow(s, x) && s.cp.exact && s.cp.cp === x.entry.seenCp && sameIvs(ivsOf(s.have), ivsOf(x.entry))
        ? // the tile names no form: keep the saved one
          { pokemonId: ivsOf(x.entry) ? x.entry.pokemonId : s.have.pokemonId, level: ivsOf(x.entry) ? x.entry.level : s.have.level, ...(ivsOf(x.entry) ? {} : savedIvs(s.have)) }
        : null,
    (s, x) => (s.have.pokemonId === x.entry.pokemonId ? 0 : 1),
  );
  // 2. powered up, evolved or changed form, IVs known on both sides
  pass(
    (s, x) => {
      const a = ivsOf(s.have);
      const b = ivsOf(x.entry);
      return a && b && sameIvs(a, b) && sameShadow(s, x) && inFamily(s, x) && x.entry.level >= s.have.level ? {} : null;
    },
    (s, x) => x.entry.level - s.have.level,
  );
  // 3. powered up or evolved, IVs known on one side only: those IVs must give the tile's CP exactly, at a
  //    level no lower than the saved one (a strong test: a few levels in a hundred fit by chance)
  pass(
    (s, x) => {
      if (!sameShadow(s, x) || !inFamily(s, x)) return null;
      const a = ivsOf(s.have);
      const b = ivsOf(x.entry);
      if (a && !b) {
        const at = reach(x.entry.pokemonId, a, x.entry.seenCp, s.have.level, s.have.pokemonId);
        return at ? { ...at, ...savedIvs(s.have) } : null;
      }
      if (b && !a && s.cp.exact) {
        // the saved CP was read off the screen: the tile's IVs must give it at the saved species
        return reach(s.have.pokemonId, b, s.cp.cp, 0, s.have.pokemonId) && x.entry.seenCp >= s.cp.cp ? {} : null;
      }
      return null;
    },
    (s, x, settles) => (settles.level ?? x.entry.level) - s.have.level,
  );
  // 4. a saved estimate that is close enough
  pass(
    (s, x) =>
      !s.cp.exact && speciesOf(s.have.pokemonId) === speciesOf(x.entry.pokemonId) && sameShadow(s, x) && Math.abs(s.cp.cp - x.entry.seenCp) <= s.cp.cp * ESTIMATE_SLACK
        ? {}
        : null,
    (s, x) => Math.abs(s.cp.cp - x.entry.seenCp),
  );

  // 5. not sure: a saved entry carrying things typed in the app (a mega, moves) and a new tile of its
  //    family and shadow state at a CP no lower. Most often the same Pokémon whose saved IVs were a
  //    guess; a person decides, and until then they count as gone and new.
  const unsure = [];
  for (const saved of [...left]) {
    if (!saved.have.mega && !saved.have.fastMove && !(saved.have.chargedMoves ?? []).length) continue;
    let best = -1;
    todo.forEach((x, i) => {
      if (!sameShadow(saved, x) || !inFamily(saved, x) || x.entry.seenCp < (saved.cp.cp ?? 0)) return;
      if (best < 0 || x.entry.seenCp < todo[best].entry.seenCp) best = i;
    });
    if (best < 0) continue;
    const item = todo.splice(best, 1)[0];
    left.splice(left.indexOf(saved), 1);
    const next = result(saved, item, {});
    unsure.push({ have: saved.have, rosterIndex: saved.rosterIndex, item, next, why: what(saved, item, next) });
  }

  return { same, changed, unsure, added: todo, gone: left.map(({ have, rosterIndex }) => ({ have, rosterIndex })), unreadable };
}

/**
 * The roster after a reconcile, in the order the recording showed the Pokémon (the game's own sort),
 * with kept "gone" entries after them. `keepGone`: true keeps every gone entry, or a Set of roster
 * indexes to keep. `skipAdded`: a Set of incoming items not to add. `confirmed`: a Set of `unsure` pairs
 * that are the same Pokémon; the others count as one gone and one new. Changes are always taken.
 */
export function applyDiff(gd, roster, diff, { keepGone = false, skipAdded = new Set(), confirmed = new Set() } = {}) {
  const byId = new Map(gd.pokemon.map((p) => [p.id, p]));
  const merged = (have, e) => {
    const out = { ...have, chargedMoves: [...(have.chargedMoves ?? [])] };
    out.pokemonId = e.pokemonId;
    out.level = e.level;
    out.seenCp = e.seenCp;
    if (!e.ivsAssumed) {
      out.ivAtk = e.ivAtk;
      out.ivDef = e.ivDef;
      out.ivSta = e.ivSta;
      delete out.ivsAssumed;
    } else if (have.ivsAssumed) {
      // still a guess: take the new guess, which the tile's CP was solved with
      out.ivAtk = e.ivAtk;
      out.ivDef = e.ivDef;
      out.ivSta = e.ivSta;
    }
    // A known level and IVs that give the CP back need no seen CP
    if (!out.ivsAssumed && e.seenCp === entryCp(gd, { ...out, seenCp: undefined }, byId.get(out.pokemonId)).cp) delete out.seenCp;
    out.shadow = Boolean(e.shadow);
    out.dynamax = Boolean(e.dynamax);
    out.gigantamax = Boolean(e.gigantamax);
    // what the new species or form cannot have goes
    const p = byId.get(out.pokemonId);
    if (p && have.pokemonId !== out.pokemonId) {
      if (out.fastMove && !p.fastMoves.includes(out.fastMove)) out.fastMove = '';
      out.chargedMoves = out.chargedMoves.filter((m) => p.chargedMoves.includes(m) || (out.shadow && m === p.shadowMove));
      const megaOk = out.mega === '*' ? (p.tempEvos ?? []).length > 1 : (p.tempEvos ?? []).some((t) => t.suffix === out.mega);
      if (out.mega && !megaOk) {
        out.mega = '';
        out.megaLevel = 1;
      }
    }
    if (out.shadow) {
      out.mega = '';
      out.megaLevel = 1;
    }
    return normalizeEntry(gd, out);
  };
  const fresh = (e) => {
    const out = { ...e };
    if (!out.ivsAssumed && out.seenCp === entryCp(gd, { ...out, seenCp: undefined }, byId.get(out.pokemonId)).cp) delete out.seenCp;
    return out;
  };

  const byItem = new Map();
  const unsure = diff.unsure ?? [];
  const pairs = [...diff.same, ...diff.changed, ...unsure.filter((m) => confirmed.has(m))];
  const added = [...diff.added, ...unsure.filter((m) => !confirmed.has(m)).map((m) => m.item)];
  const gone = [...diff.gone, ...unsure.filter((m) => !confirmed.has(m)).map(({ have, rosterIndex }) => ({ have, rosterIndex }))];
  for (const m of pairs) byItem.set(m.item, m.why.length ? merged(m.have, m.next ?? m.item.entry) : m.have);
  for (const item of added) if (!skipAdded.has(item)) byItem.set(item, fresh(item.entry));

  // scan order: the order the items were handed to reconcile
  const order = pairs.map((m) => m.item).concat(added);
  order.sort((a, b) => (a.tile?.row ?? 0) - (b.tile?.row ?? 0) || colIndex(a.tile) - colIndex(b.tile));
  const out = order.filter((item) => byItem.has(item)).map((item) => byItem.get(item));
  for (const g of gone) if (keepGone === true || (keepGone instanceof Set && keepGone.has(g.rosterIndex))) out.push(g.have);
  return out;
}

const colIndex = (tile) => ({ L: 0, M: 1, R: 2 })[tile?.col] ?? Number(tile?.col ?? 0);

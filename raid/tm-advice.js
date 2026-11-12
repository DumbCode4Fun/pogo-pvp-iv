/**
 * Which TM would move the needle?
 *
 * Two flavours:
 *   - adviseTms: for the raid being planned. Try each move a Pokemon could be taught instead,
 *     re-pick that account's team and re-run the raid; report seconds off the kill (or boss HP
 *     removed when it doesn't win). A big DPS jump on a Pokemon that never makes the team does
 *     nothing for the fight, so it isn't reported.
 *   - generalTmAdvice: across every raid boss (see all-raids.js). Elite TMs are too scarce to
 *     spend on one boss, so this is where they're advised.
 *
 * TM rules modelled:
 *   - A Fast or Charged TM rerolls the move into a random non-legacy move the Pokemon doesn't
 *     already know. Each try is 1 in (moves it could roll), so hitting a particular move takes
 *     that many TMs on average.
 *   - An Elite TM picks the move, legacy ones included.
 *   - Form-exclusive moves (Roar of Time, Behemoth Blade, ...) come with the form; no TM teaches them.
 */
import { rankRoster, pickTeam, attackerVariants, DEFAULT_TUNING } from './engine.js';
import { buildAllRaidContext, gainAcrossBosses } from './all-raids.js';

/** Moves this Pokemon could be taught, split by which kind of TM does it. */
export function learnableMoves(gd, pokemonId) {
  const species = gd.pokemon.find((p) => p.id === pokemonId);
  if (!species) return null;
  const exclusive = new Set(species.exclusiveMoves ?? []);
  const legacy = new Set(species.legacyMoves ?? []);
  const split = (ids) => {
    const usable = ids.filter((id) => gd.moves[id] && !exclusive.has(id));
    return { regular: usable.filter((id) => !legacy.has(id)), elite: usable.filter((id) => legacy.has(id)) };
  };
  return {
    fast: split(species.fastMoves),
    charged: split(species.chargedMoves),
    legacy,
    /** A shadow's locked move (Frustration): only replaceable during a removal event. */
    shadowMove: species.shadowMove ?? null,
  };
}

/**
 * Every single-move change a TM can make to a roster entry. Only entries with a fast and a
 * charged move entered: "Any" moves are already assumed to be the best ones.
 */
export function tmOptions(gd, entry) {
  const charged = (entry.chargedMoves ?? []).filter(Boolean);
  if (!entry.fastMove || !charged.length) return [];
  const learn = learnableMoves(gd, entry.pokemonId);
  if (!learn) return [];
  const out = [];

  const fastRolls = learn.fast.regular.filter((id) => id !== entry.fastMove).length;
  for (const to of [...learn.fast.regular, ...learn.fast.elite]) {
    if (to === entry.fastMove) continue;
    const elite = !learn.fast.regular.includes(to);
    out.push({
      kind: 'fast',
      slot: 0,
      from: entry.fastMove,
      to,
      elite,
      tms: elite ? 1 : fastRolls,
      losesLegacy: learn.legacy.has(entry.fastMove),
      spec: { ...entry, fastMove: to },
    });
  }

  // A Charged TM replaces the slot you choose, and never rolls a move already in either slot.
  const chargedRolls = learn.charged.regular.filter((id) => !charged.includes(id)).length;
  charged.forEach((from, slot) => {
    for (const to of [...learn.charged.regular, ...learn.charged.elite]) {
      if (charged.includes(to)) continue;
      const elite = !learn.charged.regular.includes(to);
      const next = charged.slice();
      next[slot] = to;
      out.push({
        kind: 'charged',
        slot,
        from,
        to,
        elite,
        tms: elite ? 1 : chargedRolls,
        losesLegacy: learn.legacy.has(from),
        // TMs can't touch Frustration except during a Frustration removal event.
        needsEvent: Boolean(entry.shadow) && from === learn.shadowMove,
        spec: { ...entry, chargedMoves: next },
      });
    }
  });
  return out;
}

const tmKey = (o) => `${o.kind}${o.elite ? 'Elite' : ''}`;

/**
 * The best option per kind of TM, from items shaped { o: tmOption, ... } and a value to maximise.
 *
 * An Elite TM only survives when it beats what a regular TM reaches for the same kind of move --
 * otherwise it's a wasted Elite TM. Ties are common (replacing either charged slot often rates
 * the same, since only the best one gets used), so on a tie keep legacy moves, then spend fewer TMs.
 */
function bestPerTm(items, value) {
  const same = (x, y) => Math.abs(x - y) <= 1e-9 + 1e-6 * Math.max(Math.abs(x), Math.abs(y));
  const beats = (c, u) => {
    const cv = value(c);
    const uv = value(u);
    if (!same(cv, uv)) return cv > uv;
    if (Boolean(c.o.needsEvent) !== Boolean(u.o.needsEvent)) return !c.o.needsEvent;
    if (c.o.losesLegacy !== u.o.losesLegacy) return !c.o.losesLegacy;
    return c.o.tms < u.o.tms;
  };
  const best = {};
  for (const item of items) {
    const k = tmKey(item.o);
    if (!best[k] || beats(item, best[k])) best[k] = item;
  }
  for (const kind of ['fast', 'charged']) {
    const elite = best[`${kind}Elite`];
    if (elite && best[kind] && !beats(elite, best[kind])) delete best[`${kind}Elite`];
  }
  return Object.values(best);
}

const moveNamer = (gd) => (id) => gd.moves[id]?.name ?? id;

function describeChange(gd, o) {
  const name = moveNamer(gd);
  return {
    kind: o.kind,
    slot: o.slot,
    fromId: o.from,
    toId: o.to,
    from: name(o.from),
    to: name(o.to),
    elite: o.elite,
    tms: o.tms,
    losesLegacy: o.losesLegacy,
    needsEvent: Boolean(o.needsEvent),
  };
}

function describeEntry(gd, account, entry, rosterIndex) {
  const species = gd.pokemon.find((p) => p.id === entry.pokemonId);
  const name = moveNamer(gd);
  return {
    accountId: account.id,
    accountName: account.name,
    rosterIndex,
    pokemon: (species?.name ?? entry.pokemonId) + (entry.shadow ? ' (Shadow)' : ''),
    level: entry.level,
    ivs: [entry.ivAtk, entry.ivDef, entry.ivSta],
    moves: { fast: name(entry.fastMove), charged: entry.chargedMoves.map(name) },
  };
}

const movesUnentered = (entry) => !entry.fastMove || !(entry.chargedMoves ?? []).filter(Boolean).length;

// ---------------------------------------------------------------- one raid

/**
 * @param env {{
 *   boss, ctx, teamSize: number,
 *   baseline: simulate() result for the recommended teams,
 *   accounts: Array<{ account, ranking, downtime, rateCtx }>  -- played accounts only; `ranking`
 *     is the rankRoster() list the account's team was picked from,
 *   simulateWith: (accountId, teamSpecs) => simulate() result with that account's team swapped,
 *   includeElite?: boolean, limit?: number,
 * }}
 */
export function adviseTms(gd, { boss, ctx, teamSize, baseline, accounts, simulateWith, includeElite = true, limit = 30 }) {
  const rows = [];
  let unentered = 0;
  let checked = 0;

  for (const { account, ranking, downtime, rateCtx } of accounts) {
    const team = pickTeam(ranking, teamSize);
    const inTeam = new Set(team.map((r) => r.rosterIndex));
    // A Pokemon outside the team has to beat the weakest member to change anything.
    const cutoff = team.length >= teamSize ? team[team.length - 1].score : -Infinity;
    // The ranking is sorted, so the first hit per roster entry is its best variant.
    const current = new Map();
    for (const r of ranking) if (!current.has(r.rosterIndex)) current.set(r.rosterIndex, r);

    account.roster.forEach((entry, rosterIndex) => {
      const all = tmOptions(gd, entry);
      if (!all.length) {
        if (movesUnentered(entry)) unentered++;
        return;
      }
      checked++;
      const now = current.get(rosterIndex);
      if (!now) return;

      const rate = (spec) =>
        rankRoster(gd, [spec], boss, ctx, rateCtx, downtime).map((v) => ({ ...v, rosterIndex }));

      // Rate every option on its own; only ones that beat the current moves are candidates.
      const improving = (includeElite ? all : all.filter((o) => !o.elite))
        .map((o) => ({ o, variants: rate(o.spec) }))
        .filter((x) => x.variants.length && x.variants[0].score > now.score * (1 + 1e-6));
      const singles = bestPerTm(improving, (x) => x.variants[0].score);
      if (!singles.length) return;

      // Both moves at once, when each helps on its own: fast and charged moves interact through energy.
      const topOf = (kind) =>
        singles.filter((s) => s.o.kind === kind).sort((a, b) => b.variants[0].score - a.variants[0].score)[0];
      const trials = singles.map((s) => ({ changes: [s.o], variants: s.variants }));
      const bf = topOf('fast');
      const bc = topOf('charged');
      if (bf && bc) {
        const spec = { ...entry, fastMove: bf.o.to, chargedMoves: bc.o.spec.chargedMoves };
        trials.push({ changes: [bf.o, bc.o], variants: rate(spec) });
      }

      for (const { changes, variants } of trials) {
        if (!variants.length) continue;
        if (!inTeam.has(rosterIndex) && variants[0].score <= cutoff) continue;
        const reranked = [...ranking.filter((r) => r.rosterIndex !== rosterIndex), ...variants].sort(
          (a, b) => b.score - a.score,
        );
        const newTeam = pickTeam(reranked, teamSize);
        if (!newTeam.some((r) => r.rosterIndex === rosterIndex)) continue;

        const res = simulateWith(account.id, newTeam.map((r) => r.spec));
        const flipsToWin = !baseline.won && res.won;
        const secondsSaved = baseline.won && res.won ? baseline.timeToKill - res.timeToKill : null;
        const damageGain = res.damageRatio - baseline.damageRatio;
        const helps = flipsToWin || (secondsSaved !== null ? secondsSaved > 1e-9 : !baseline.won && damageGain > 1e-4);
        if (!helps) continue;

        rows.push({
          ...describeEntry(gd, account, entry, rosterIndex),
          changes: changes.map((c) => describeChange(gd, c)),
          dpsBefore: now.dps,
          dpsAfter: variants[0].dps,
          joinsTeam: !inTeam.has(rosterIndex),
          won: res.won,
          timeToKill: res.timeToKill,
          damageRatio: res.damageRatio,
          secondsSaved,
          damageGain,
          flipsToWin,
        });
      }
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.flipsToWin) - Number(a.flipsToWin) ||
      (b.secondsSaved ?? 0) - (a.secondsSaved ?? 0) ||
      b.damageGain - a.damageGain ||
      b.dpsAfter - b.dpsBefore - (a.dpsAfter - a.dpsBefore),
  );

  // The single best use of each kind of TM -- the headline.
  const bestByTm = {};
  for (const row of rows) {
    if (row.changes.length !== 1) continue;
    bestByTm[tmKey(row.changes[0])] ??= row;
  }

  return { rows: rows.slice(0, limit), total: rows.length, bestByTm, unentered, checked };
}

// ---------------------------------------------------------------- across all raids

/**
 * TM advice that isn't tied to one raid: every move change scored against every raid boss
 * (all-raids.js), ranked by team strength gained summed over all of them.
 *
 * Each row also says whether the Pokemon itself is ever worse off against any boss. Same-type
 * upgrades (Surf -> Origin Pulse) usually aren't; swapping away coverage usually is, somewhere.
 *
 * @param opts {{ accounts: Array<{ id, name, partyPower?, playQuality?, roster }>, tuning?,
 *   partySize?, teamSize?, limit?, context?: buildAllRaidContext() result, to share the work }}
 */
export function generalTmAdvice(gd, { accounts, tuning = DEFAULT_TUNING, partySize = 4, teamSize = 6, limit = 60, context }) {
  const started = Date.now();
  const all = context ?? buildAllRaidContext(gd, accounts, { tuning, partySize, teamSize });
  const rows = [];
  let unentered = 0;
  let checked = 0;

  for (const account of accounts) {
    const baseline = all.baselines.get(account.id);
    if (!baseline) continue;
    baseline.roster.forEach((entry, rosterIndex) => {
      const options = tmOptions(gd, entry);
      if (!options.length) {
        if (movesUnentered(entry)) unentered++;
        return;
      }
      checked++;

      const scored = options
        .map((o) => ({ o, ...gainAcrossBosses(gd, baseline, rosterIndex, attackerVariants(gd, o.spec)) }))
        .filter((s) => s.sumGain > 1e-6 && s.helped);

      for (const s of bestPerTm(scored, (x) => x.sumGain)) {
        rows.push({
          ...describeEntry(gd, account, entry, rosterIndex),
          change: describeChange(gd, s.o),
          /** Team strength gained, summed over every boss -- roughly "percent faster", added up across raids. */
          sumGain: s.sumGain,
          raidsHelped: s.helped,
          avgGain: s.gains.reduce((t, g) => t + g.gain, 0) / s.helped,
          bestRaids: s.gains.slice(0, 3),
          /** Bosses this Pokemon itself does worse against after the change. */
          worseAgainst: s.worse,
          neverWorse: s.worse === 0,
        });
      }
    });
  }

  rows.sort((a, b) => b.sumGain - a.sumGain);
  return {
    rows: rows.slice(0, limit),
    total: rows.length,
    bossesChecked: all.bosses.length,
    unentered,
    checked,
    ms: Date.now() - started,
  };
}

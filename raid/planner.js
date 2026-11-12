/**
 * Turns "here are my 5 accounts and here is the boss" into a recommendation.
 *
 * Responsibilities:
 *   - pick and order each account's 6 attackers (and which one, if any, to mega evolve)
 *   - choose what the idle accounts should hold -- a mega there boosts everyone
 *   - search playstyles for the actively played accounts
 *   - sweep the boss movesets so the verdict says "yes, unless it has X"
 */
import {
  RAID_TIERS,
  PLAYSTYLES,
  buildAttacker,
  buildBoss,
  rateAttacker,
  rankRoster,
  pickTeam,
  simulate,
  effectiveFriendship,
  normalizeEntry,
  DEFAULT_TUNING,
} from './engine.js';
import { adviseTms } from './tm-advice.js';

const TEAM_SIZE = 6;

/** Relobby cycle sizes worth considering: lead only, lead + backup, lead + 2 backups. */
const RELOBBY_CYCLES = [1, 2, 3];

function playstyleOptions() {
  return [
    { playstyle: 'full', cycleSize: TEAM_SIZE, label: PLAYSTYLES.full.label },
    ...RELOBBY_CYCLES.map((k) => ({
      playstyle: 'relobby',
      cycleSize: k,
      label: k === 1 ? 'Relobby on lead' : `Relobby after ${k}`,
    })),
  ];
}

const normPartyPower = (v) => (v === true ? 'optimal' : v === false || !v ? 'off' : v);

/**
 * @param input {{
 *   bossSpec: { pokemonId, tier, fastMove?, chargedMove?, hpOverride? },
 *   weather: string, purifiedGems: boolean, tuning?: object,
 *   friendships?: { [pairKey]: level },
 *   accounts: Array<{ id, name, active, friendship?, partyPower, maxRevives, roster: object[] }>
 * }}
 */
export function plan(gd, input) {
  const tuning = { ...DEFAULT_TUNING, ...(input.tuning ?? {}) };
  const ctx = {
    weather: input.weather ?? 'NONE',
    purifiedGems: Boolean(input.purifiedGems),
    tuning,
    groupDps: 0,
    /** Accounts filling a party slot, idle ones included -- Party Power charges off all of them. */
    partySize: input.accounts.filter((a) => (a.partyPower ?? 'off') !== 'off').length,
    _rateCache: new Map(), // shared across every sim this plan runs
  };
  const boss = buildBoss(gd, input.bossSpec);

  // Everyone in the lobby counts for friendship, even with an empty roster.
  const presentIds = input.accounts.map((a) => a.id);
  const friendshipOf = (a) =>
    input.friendships ? effectiveFriendship(input.friendships, a.id, presentIds) : a.friendship ?? 0;

  const accounts = input.accounts
    .filter((a) => (a.roster ?? []).length > 0)
    .map((a) => ({
      ...a,
      friendship: friendshipOf(a),
      // Idle accounts deal no damage, but "in party — idle" is kept so party size stays right.
      partyPower: a.active ? normPartyPower(a.partyPower) : a.partyPower === 'idle' ? 'idle' : 'off',
      playQuality: a.playQuality ?? 'sharp',
      roster: a.roster.map((e) => normalizeEntry(gd, e)),
    }));
  if (!accounts.length) {
    return { error: 'No account has any Pokémon in its roster yet.', boss, ctx };
  }

  const activeAccounts = accounts.filter((a) => a.active);
  const idleAccounts = accounts.filter((a) => !a.active);
  const accountCtx = (a) => ({ friendship: a.friendship, partyPower: a.partyPower, playQuality: a.playQuality });

  // ---- 1. rank each roster ------------------------------------------------
  // The boss's charged-move rate depends on how hard the group hits it, which depends on the
  // teams. Rank once assuming nothing, estimate the group's output, then rank for real.
  const rankAll = () => {
    const out = new Map();
    for (const a of accounts) {
      out.set(a.id, {
        full: rankRoster(gd, a.roster, boss, ctx, accountCtx(a), tuning.faintDelay),
        relobby: rankRoster(gd, a.roster, boss, ctx, accountCtx(a), tuning.relobbyTime),
      });
    }
    return out;
  };
  let ranked = rankAll();
  ctx.groupDps = activeAccounts.reduce((sum, a) => sum + (pickTeam(ranked.get(a.id).full, 1)[0]?.dps ?? 0), 0);
  ranked = rankAll();

  const teamFor = (a, style) => pickTeam(ranked.get(a.id)[style === 'relobby' ? 'relobby' : 'full'], TEAM_SIZE);

  // ---- 2. what should the idle accounts hold? ----------------------------
  // They never tap, so their lead is the only Pokemon that reaches the field. Its only value
  // is a mega boost: a normal mega boosts until it faints (so bulk matters), while Mega
  // Rayquaza and the Primals keep boosting all fight from the moment the raid starts.
  const idleChoices = new Map();
  for (const a of idleAccounts) {
    const all = ranked.get(a.id).relobby;
    const persistent = all.filter((r) => r.attacker.megaBoost?.persists);
    const megas = all.filter((r) => r.attacker.megaBoost && !r.attacker.megaBoost.persists);
    const byBulk = (x, y) => (y.ttf === x.ttf ? y.tdo - x.tdo : y.ttf - x.ttf);
    const pool = [...persistent, ...megas.sort(byBulk)];
    const candidates = (pool.length ? pool : all.slice().sort(byBulk)).slice(0, 6);
    idleChoices.set(a.id, candidates);
  }

  const buildIdleEntry = (a, choice) => ({
    id: a.id,
    name: a.name,
    active: false,
    friendship: a.friendship,
    partyPower: 'off',
    playQuality: a.playQuality,
    maxRevives: 0,
    playstyle: 'full',
    cycleSize: 1,
    team: choice ? [choice.spec] : [],
  });

  const buildActiveEntry = (a, opt) => ({
    id: a.id,
    name: a.name,
    active: true,
    friendship: a.friendship,
    partyPower: a.partyPower,
    playQuality: a.playQuality,
    maxRevives: a.maxRevives ?? null,
    playstyle: opt.playstyle,
    cycleSize: opt.cycleSize,
    team: teamFor(a, opt.playstyle).map((r) => r.spec),
  });

  const options = playstyleOptions();
  const runSim = (activeOpts, idlePicks, forBoss = boss) =>
    simulate(
      gd,
      forBoss,
      [
        ...activeAccounts.map((a, i) => buildActiveEntry(a, activeOpts[i])),
        ...idleAccounts.map((a) => buildIdleEntry(a, idlePicks.get(a.id))),
      ],
      ctx,
    );

  /** Objective: win first, then kill fastest; if losing, maximise damage dealt. */
  const better = (a, b) => {
    if (!b) return true;
    if (a.won !== b.won) return a.won;
    if (a.won) return a.timeToKill < b.timeToKill;
    return a.damageRatio > b.damageRatio;
  };

  const idlePicks = new Map(idleAccounts.map((a) => [a.id, idleChoices.get(a.id)[0]]));

  // ---- 3. search playstyles for the actively played accounts -------------
  let bestOpts = activeAccounts.map(() => options[0]);
  let bestResult = null;

  const combos = [];
  const walk = (i, acc) => {
    if (i === activeAccounts.length) {
      combos.push(acc.slice());
      return;
    }
    for (const opt of options) {
      acc.push(opt);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);

  for (const combo of combos) {
    const res = runSim(combo, idlePicks);
    if (better(res, bestResult)) {
      bestResult = res;
      bestOpts = combo;
    }
  }

  // ---- 4. with playstyles settled, re-pick the idle leads ----------------
  for (const a of idleAccounts) {
    let bestChoice = idlePicks.get(a.id);
    let bestFor = null;
    for (const cand of idleChoices.get(a.id)) {
      const trial = new Map(idlePicks);
      trial.set(a.id, cand);
      const res = runSim(bestOpts, trial);
      if (better(res, bestFor)) {
        bestFor = res;
        bestChoice = cand;
      }
    }
    idlePicks.set(a.id, bestChoice);
  }
  bestResult = runSim(bestOpts, idlePicks);

  // ---- 5. per-account playstyle comparison ------------------------------
  // Hold everyone else at the chosen configuration and vary one account.
  const playstyleComparison = activeAccounts.map((a, i) => {
    const rows = options.map((opt) => {
      const combo = bestOpts.slice();
      combo[i] = opt;
      const res = runSim(combo, idlePicks);
      return {
        ...opt,
        won: res.won,
        timeToKill: res.timeToKill,
        damageRatio: res.damageRatio,
        accountDamage: res.accounts.find((x) => x.id === a.id)?.damage ?? 0,
        chosen: opt.playstyle === bestOpts[i].playstyle && opt.cycleSize === bestOpts[i].cycleSize,
      };
    });
    return { id: a.id, name: a.name, rows };
  });

  // ---- 5a. how much luck is in it ---------------------------------------
  // The main answer is a median: the boss's delay between moves is rolled 1.5-2.5 s each time and
  // its charged move is a coin flip, and both are modelled at their average. A real raid lands
  // somewhere in a band, so run the same teams against a hostile and a friendly boss to show it.
  const LUCK = {
    unlucky: { bossMoveDelay: 1.5, bossChargedChance: 0.65 },
    lucky: { bossMoveDelay: 2.5, bossChargedChance: 0.35 },
  };
  const sameTeamsWith = (overrides) =>
    simulate(
      gd,
      boss,
      [
        ...activeAccounts.map((a, i) => buildActiveEntry(a, bestOpts[i])),
        ...idleAccounts.map((a) => buildIdleEntry(a, idlePicks.get(a.id))),
      ],
      { ...ctx, tuning: { ...tuning, ...overrides }, _rateCache: new Map() },
    );

  // Not simply "good" and "bad": a boss that throws fewer charged moves also feeds you less
  // energy (attackers gain 0.5 per HP lost), so a gentler boss can actually be killed slower.
  // Report the envelope rather than pretending one end is the friendly one.
  const luckRuns = [bestResult, ...Object.values(LUCK).map(sameTeamsWith)].map((res) => ({
    won: res.won,
    timeToKill: res.timeToKill,
    damageRatio: res.damageRatio,
    bossHpFracRemaining: res.bossHpFracRemaining,
  }));
  const rank = (r) => (r.won ? r.timeToKill : Infinity);
  const luck = {
    fastest: luckRuns.reduce((a, b) => (rank(b) < rank(a) ? b : a)),
    slowest: luckRuns.reduce((a, b) => (rank(b) > rank(a) ? b : a)),
    anyLoses: luckRuns.some((r) => !r.won),
  };

  /** The recommended configuration, with one played account's team swapped out. */
  const simulateWith = (accountId, team) =>
    simulate(
      gd,
      boss,
      [
        ...activeAccounts.map((acc, j) =>
          acc.id === accountId ? { ...buildActiveEntry(acc, bestOpts[j]), team } : buildActiveEntry(acc, bestOpts[j]),
        ),
        ...idleAccounts.map((acc) => buildIdleEntry(acc, idlePicks.get(acc.id))),
      ],
      ctx,
    );

  // ---- 5b. mega backups -------------------------------------------------
  // A trainer can only have one Pokemon mega evolved at a time and megas go on cooldown, so the
  // best mega isn't always available. Re-run the fight forcing each mega in turn (and once with
  // none) to rank the fallbacks.
  const MAX_MEGA_CANDIDATES = 8;
  const megaBackups = activeAccounts.map((a, i) => {
    const opt = bestOpts[i];
    const ranking = ranked.get(a.id)[opt.playstyle === 'relobby' ? 'relobby' : 'full'];
    // Deduplicated by mega form, not by roster entry: owning six Mewtwo is still only one
    // "Mega Mewtwo Y" option, and listing it six times tells you nothing about what to reach for.
    const seen = new Set();
    const candidates = [];
    for (const r of ranking) {
      if (!r.isMega) continue;
      const form = r.attacker.species.id;
      if (seen.has(form)) continue;
      seen.add(form);
      candidates.push(r);
      if (candidates.length >= MAX_MEGA_CANDIDATES) break;
    }
    if (!candidates.length) return { id: a.id, name: a.name, rows: [] };

    const withTeam = (team) => simulateWith(a.id, team);

    const score = (res) => (res.won ? 1000 - res.timeToKill : res.damageRatio);
    const rows = candidates.map((cand) => {
      const team = pickTeam(ranking, TEAM_SIZE, { forceMega: cand.rosterIndex });
      const res = withTeam(team.map((r) => r.spec));
      return {
        pokemon: cand.attacker.name,
        dps: Math.round(cand.dps * 10) / 10,
        won: res.won,
        timeToKill: res.timeToKill,
        damageRatio: res.damageRatio,
        _score: score(res),
      };
    });

    const noMegaRes = withTeam(pickTeam(ranking, TEAM_SIZE, { noMega: true }).map((r) => r.spec));
    rows.push({
      pokemon: 'No mega available',
      dps: null,
      won: noMegaRes.won,
      timeToKill: noMegaRes.timeToKill,
      damageRatio: noMegaRes.damageRatio,
      noMega: true,
      _score: score(noMegaRes),
    });

    rows.sort((x, y) => y._score - x._score);
    const best = rows[0]._score;
    for (const row of rows) {
      row.best = row._score === best;
      // Seconds slower than the best option, or HP short of it.
      row.cost = row.won && rows[0].won ? row.timeToKill - rows[0].timeToKill : null;
      delete row._score;
    }
    return { id: a.id, name: a.name, rows };
  });

  // ---- 5c. TM advice ---------------------------------------------------
  // Which Fast or Charged TM speeds this raid up most. Elite TMs are too scarce to spend on
  // one boss, so they're advised across all raids instead (generalTmAdvice). Playstyles and
  // idle leads stay as recommended; only the changed Pokemon's own account re-picks its team.
  const tmAdvice =
    input.tmAdvice === false
      ? null
      : adviseTms(gd, {
          boss,
          ctx,
          includeElite: false,
          teamSize: TEAM_SIZE,
          baseline: bestResult,
          accounts: activeAccounts.map((a, i) => {
            const relobby = bestOpts[i].playstyle === 'relobby';
            return {
              account: a,
              ranking: ranked.get(a.id)[relobby ? 'relobby' : 'full'],
              downtime: relobby ? tuning.relobbyTime : tuning.faintDelay,
              rateCtx: accountCtx(a),
            };
          }),
          simulateWith,
        });
  // Top-ranked change per roster Pokemon, so the team cards can point at the move to replace.
  const tmFor = new Map();
  for (const row of tmAdvice?.rows ?? []) {
    const key = `${row.accountId}:${row.rosterIndex}`;
    if (!tmFor.has(key)) tmFor.set(key, row);
  }

  // ---- 6. boss moveset sweep -------------------------------------------
  const sweep = [];
  if (!boss.movesetPinned) {
    for (const f of boss.species.fastMoves) {
      for (const c of boss.species.chargedMoves) {
        const variantBoss = buildBoss(gd, { ...input.bossSpec, fastMove: f, chargedMove: c });
        const res = runSim(bestOpts, idlePicks, variantBoss);
        sweep.push({
          fast: gd.moves[f]?.name ?? f,
          charged: gd.moves[c]?.name ?? c,
          won: res.won,
          timeToKill: res.timeToKill,
          damageRatio: res.damageRatio,
        });
      }
    }
    sweep.sort((a, b) => a.damageRatio - b.damageRatio || (b.timeToKill ?? 0) - (a.timeToKill ?? 0));
  }

  // ---- 7. team detail for display --------------------------------------
  const describe = (r, accountId) => ({
    pokemonId: r.spec.pokemonId,
    /** The best TM change for this Pokemon in this raid, if one helps. */
    tm: tmFor.get(`${accountId}:${r.rosterIndex}`) ?? null,
    name: r.attacker.name,
    level: r.spec.level,
    effectiveLevel: r.attacker.effectiveLevel,
    ivs: [r.spec.ivAtk, r.spec.ivDef, r.spec.ivSta],
    types: r.attacker.types,
    fast: r.fast?.name ?? '-',
    charged: r.charged?.name ?? '-',
    // Optimal Party Power may save a different, harder-hitting charged move for the boost.
    ppCharged: r.ppCharged && r.ppCharged.id !== r.charged?.id ? r.ppCharged.name : null,
    ppEvery: r.ppEvery,
    dps: Math.round(r.dps * 10) / 10,
    // Against this Pokemon's best moveset *without* Party Power, not the same moveset.
    ppGain: r.dpsWithoutPartyPower ? r.dps / r.dpsWithoutPartyPower - 1 : 0,
    // Set when Party Power changes which moves this Pokemon should run.
    movesWithoutPartyPower:
      r.withoutPartyPower &&
      (r.withoutPartyPower.fast.id !== r.fast?.id || r.withoutPartyPower.charged.id !== r.charged?.id)
        ? `${r.withoutPartyPower.fast.name} / ${r.withoutPartyPower.charged.name}`
        : null,
    tdo: Math.round(r.tdo),
    ttf: Number.isFinite(r.ttf) ? Math.round(r.ttf * 10) / 10 : null,
    isMega: r.isMega,
    // The extra charged attack a Super-Max-eligible mega knows while mega evolved.
    plusMove: r.attacker.plusMove?.name ?? null,
    usesPlusMove: Boolean(
      r.attacker.plusMove &&
        (r.charged?.id === r.attacker.plusMove.id || r.ppCharged?.id === r.attacker.plusMove.id),
    ),
    megaBoost: Boolean(r.attacker.megaBoost),
    boostTypes: r.attacker.megaBoost?.types ?? null,
    boostPersists: Boolean(r.attacker.megaBoost?.persists),
    anyMoves: !r.spec.fastMove || !r.spec.chargedMoves.length,
  });

  const teams = accounts.map((a) => {
    const isActive = Boolean(a.active);
    const i = activeAccounts.indexOf(a);
    const opt = isActive ? bestOpts[i] : { playstyle: 'full', cycleSize: 1, label: 'Idle (holds the field)' };
    const chosen = isActive ? teamFor(a, opt.playstyle) : [idlePicks.get(a.id)].filter(Boolean);
    return {
      id: a.id,
      name: a.name,
      active: isActive,
      friendship: a.friendship,
      partyPower: a.partyPower,
      playstyle: opt.playstyle,
      cycleSize: opt.cycleSize,
      playstyleLabel: opt.label,
      playQuality: a.playQuality,
      members: chosen.map((r) => describe(r, a.id)),
      result: bestResult.accounts.find((x) => x.id === a.id),
    };
  });

  const megaSources = teams
    .flatMap((t) => t.members.filter((m) => m.megaBoost).map((m) => ({ from: t.name, member: m, active: t.active })))
    .sort((a, b) => Number(b.member.boostPersists) - Number(a.member.boostPersists) || (b.member.ttf ?? 0) - (a.member.ttf ?? 0));

  return {
    boss: {
      name: boss.name,
      types: boss.types,
      tier: boss.tier.label,
      hp: boss.hp,
      timer: boss.timer,
      isShadow: boss.isShadow,
      movesetPinned: boss.movesetPinned,
      eligible: boss.eligible,
    },
    ctx: { weather: ctx.weather, purifiedGems: ctx.purifiedGems, tuning },
    verdict: {
      won: bestResult.won,
      timeToKill: bestResult.timeToKill,
      damageRatio: bestResult.damageRatio,
      bossHpFracRemaining: bestResult.bossHpFracRemaining,
      totalDamage: Math.round(bestResult.totalDamage),
      enragedSeconds: Math.round(bestResult.enragedSeconds),
      enragedAt: bestResult.enragedAt,
      subduedAt: bestResult.subduedAt,
      gemThrowers: bestResult.gemThrowers,
      gemCalmSeconds: bestResult.gemCalmSeconds,
      worstMoveset: sweep[0] ?? null,
      bestMoveset: sweep[sweep.length - 1] ?? null,
      movesetsWon: sweep.filter((s) => s.won).length,
      movesetsTotal: sweep.length,
      luck,
    },
    /** Accounts that were left out because their roster is empty. */
    emptyAccounts: input.accounts.filter((a) => !(a.roster ?? []).length && a.active).map((a) => a.name),
    megaBoosts: megaSources.map(({ from, member, active }) => ({
      from,
      active,
      pokemon: member.name,
      types: member.boostTypes,
      uptime: member.ttf,
      persists: member.boostPersists,
    })),
    teams,
    megaBackups,
    tmAdvice,
    /** Accounts filling a party slot, including idle ones -- this is the party size. */
    partySize: input.accounts.filter((a) => (a.partyPower ?? 'off') !== 'off').length,
    playstyleComparison,
    sweep,
    trace: bestResult.trace,
  };
}

export { RAID_TIERS, buildAttacker, rateAttacker };

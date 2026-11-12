/**
 * Scoring a roster against every raid boss at once -- the basis for advice that isn't tied to
 * one raid: Elite TMs and power-ups.
 *
 * Against each boss, changing one Pokemon is worth the gain in that account's six-Pokemon team
 * strength: nothing if it wouldn't make the team either way, a lot if it's the lead. Summed over
 * every boss, that says how much a change is worth across raids in general -- so a change that
 * helps a little in many raids can outrank one that helps a lot in a single raid.
 *
 * Neutral weather, no friendship bonus (it scales every team alike), each account's own Party
 * Power and play quality, and full-team downtime between Pokemon.
 */
import {
  attackerVariants,
  rateForRanking,
  bossCandidates,
  buildBoss,
  calmPhase,
  normalizeEntry,
  DEFAULT_TUNING,
} from './engine.js';

/** Raids that general advice is judged against. Each boss counts once. */
export const GENERAL_TIERS = ['T5', 'T5_MEGA', 'T5_SHADOW'];

/** Every boss a 5-star, Mega/Primal or Shadow raid can have, each species once. */
export function allRaidBosses(gd) {
  const bosses = [];
  const seen = new Set();
  for (const tier of GENERAL_TIERS) {
    for (const species of bossCandidates(gd, tier)) {
      if (seen.has(species.id)) continue;
      seen.add(species.id);
      try {
        bosses.push(buildBoss(gd, { pokemonId: species.id, tier }));
      } catch {
        // not buildable as a boss; skip it
      }
    }
  }
  return bosses;
}

/**
 * Every account's roster rated against every boss, as it is today. Build it once and hand it to
 * each kind of advice, since this is most of the work.
 *
 * @param accounts Array<{ id, name, partyPower?, playQuality?, roster }>
 */
export function buildAllRaidContext(gd, accounts, { tuning = DEFAULT_TUNING, partySize = 4, teamSize = 6 } = {}) {
  const bosses = allRaidBosses(gd);
  const baselines = new Map();
  for (const account of accounts) {
    const baseline = accountBaseline(gd, account, bosses, { tuning, partySize, teamSize });
    if (baseline) baselines.set(account.id, baseline);
  }
  return { bosses, baselines };
}

function accountBaseline(gd, account, bosses, { tuning, partySize, teamSize }) {
  const roster = (account.roster ?? []).map((e) => normalizeEntry(gd, e));
  if (!roster.length) return null;
  const pp =
    account.partyPower === true ? 'optimal' : !account.partyPower || account.partyPower === 'idle' ? 'off' : account.partyPower;
  const rateCtx = { friendship: 0, partyPower: pp, playQuality: account.playQuality ?? 'sharp' };
  const downtime = tuning.faintDelay;
  // Built once per Pokemon and reused against every boss: building is the slow part of rating.
  const variants = roster.map((e) => attackerVariants(gd, e));

  const perBoss = bosses.map((boss) => {
    const phase = calmPhase(boss);
    const rankWith = (ctx) => {
      const ranking = [];
      variants.forEach((vs, rosterIndex) => {
        for (const v of vs) {
          const r = rateForRanking(gd, v, boss, ctx, rateCtx, downtime, phase);
          if (r) ranking.push({ rosterIndex, isMega: r.isMega, score: r.score, dps: r.dps });
        }
      });
      return ranking.sort((a, b) => b.score - a.score);
    };
    // As in the planner: the boss's charged-move rate depends on how hard it's being hit, so
    // rank once assuming nothing, then again with the lead's output feeding the boss.
    let ctx = { weather: 'NONE', purifiedGems: false, tuning, partySize, groupDps: 0 };
    let ranking = rankWith(ctx);
    ctx = { ...ctx, groupDps: ranking[0]?.dps ?? 0 };
    ranking = rankWith(ctx);
    const team = mergedTeam(ranking, -1, [], teamSize);
    const best = new Map();
    for (const r of ranking) if (!best.has(r.rosterIndex)) best.set(r.rosterIndex, r.score);
    return {
      boss,
      phase,
      ctx,
      ranking,
      best,
      inTeam: new Set(team.map((r) => r.rosterIndex)),
      teamScore: team.reduce((s, r) => s + r.score, 0),
      cutoff: team.length >= teamSize ? team[team.length - 1].score : -Infinity,
    };
  });

  return { account, roster, rateCtx, downtime, teamSize, perBoss };
}

/**
 * What it's worth to turn one roster Pokemon into `variants` (from attackerVariants), against
 * every boss.
 *
 * @returns {{ sumGain: number, helped: number, worse: number, gains: Array<{ boss: string, gain: number }> }}
 *   sumGain -- team strength gained, added up over every boss (can be negative)
 *   helped  -- bosses where the team gets stronger
 *   worse   -- bosses the Pokemon itself does worse against, team or not
 *   gains   -- where it helps, best first
 */
export function gainAcrossBosses(gd, baseline, rosterIndex, variants) {
  const { rateCtx, downtime, teamSize } = baseline;
  let sumGain = 0;
  let helped = 0;
  let worse = 0;
  const gains = [];
  for (const b of baseline.perBoss) {
    const rated = [];
    for (const v of variants) {
      const r = rateForRanking(gd, v, b.boss, b.ctx, rateCtx, downtime, b.phase);
      if (r) rated.push({ rosterIndex, isMega: r.isMega, score: r.score });
    }
    rated.sort((x, y) => y.score - x.score);
    const before = b.best.get(rosterIndex) ?? 0;
    const after = rated[0]?.score ?? 0;
    if (after < before * (1 - 1e-4)) worse++;
    // Outside the team before and after: this raid doesn't care about the change.
    if (!b.inTeam.has(rosterIndex) && after <= b.cutoff) continue;
    const team = mergedTeam(b.ranking, rosterIndex, rated, teamSize);
    const gain = b.teamScore > 0 ? team.reduce((s, r) => s + r.score, 0) / b.teamScore - 1 : 0;
    if (Math.abs(gain) < 1e-6) continue;
    sumGain += gain;
    if (gain > 0) {
      helped++;
      gains.push({ boss: b.boss.name, gain });
    }
  }
  gains.sort((x, y) => y.gain - x.gain);
  return { sumGain, helped, worse, gains };
}

/**
 * pickTeam over `ranking` with one roster entry's rows swapped for `extra`. Both lists are
 * already sorted, so walk them together until the team is full instead of re-sorting.
 */
function mergedTeam(ranking, excludeIndex, extra, size) {
  const team = [];
  const used = new Set();
  let megaTaken = false;
  let i = 0;
  let j = 0;
  while (team.length < size && (i < ranking.length || j < extra.length)) {
    if (i < ranking.length && ranking[i].rosterIndex === excludeIndex) {
      i++;
      continue;
    }
    const r = j < extra.length && (i >= ranking.length || extra[j].score > ranking[i].score) ? extra[j++] : ranking[i++];
    if (used.has(r.rosterIndex)) continue;
    if (r.isMega && megaTaken) continue;
    used.add(r.rosterIndex);
    if (r.isMega) megaTaken = true;
    team.push(r);
  }
  return team;
}

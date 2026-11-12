/**
 * Which Pokemon are most worth powering up, judged across every raid boss.
 *
 * Each Pokemon is tried at level 40, 45 and 50 (whichever are above where it is now) and scored
 * like the general TM advice: the gain in that account's team strength, summed over every boss
 * (see all-raids.js). Costs come from the game master's upgrade table.
 *
 * Copies of the same species spend the same candy, so every copy after the best one is marked
 * as sharing candy with it: powering up both is rarely what you want.
 */
import { attackerVariants } from './engine.js';
import { buildAllRaidContext, gainAcrossBosses } from './all-raids.js';

export const POWER_UP_TARGETS = [40, 45, 50];

/**
 * Stardust, Candy and XL Candy to take a Pokemon from level `from` to `to`.
 *
 * The tables hold the cost of one power-up at each whole level; a level takes two power-ups.
 * Candy is spent below level 40 and XL Candy from 40 on. Shadows cost more of both, rounded up
 * per power-up. A few species (Eternatus) have their own, pricier table.
 */
export function powerUpCost(gd, from, to, { shadow = false, pokemonId = null } = {}) {
  const base = gd.constants.powerUp;
  const u = (pokemonId && base.overrides?.[pokemonId]) || base;
  const candyMult = shadow ? u.shadowCandyMultiplier : 1;
  const dustMult = shadow ? u.shadowStardustMultiplier : 1;
  let stardust = 0;
  let candy = 0;
  let xl = 0;
  for (let level = from; level < to; level += 1 / u.upgradesPerLevel) {
    const i = Math.floor(level) - 1;
    stardust += Math.ceil((u.stardust[i] ?? 0) * dustMult);
    if (level < u.xlFromLevel) candy += Math.ceil((u.candy[i] ?? 0) * candyMult);
    else xl += Math.ceil((u.xl[Math.floor(level) - u.xlFromLevel] ?? 0) * candyMult);
  }
  return { stardust, candy, xl };
}

/**
 * @param opts {{ accounts: Array<{ id, name, partyPower?, playQuality?, roster }>, tuning?,
 *   partySize?, teamSize?, context?: buildAllRaidContext() result, to share with other advice }}
 */
export function powerUpAdvice(gd, { accounts, tuning, partySize, teamSize = 6, context }) {
  const started = Date.now();
  const all = context ?? buildAllRaidContext(gd, accounts, { tuning, partySize, teamSize });
  const rows = [];

  for (const account of accounts) {
    const baseline = all.baselines.get(account.id);
    if (!baseline) continue;
    baseline.roster.forEach((entry, rosterIndex) => {
      const targets = POWER_UP_TARGETS.filter((to) => to > entry.level);
      if (!targets.length) return;
      const species = gd.pokemon.find((p) => p.id === entry.pokemonId);
      // A shadow still on its locked move (Frustration) is too weak to make any team, so powering
      // it up would score nothing and the answer would be useless. Score it as it will be once the
      // move is replaced -- flagged on the row, since that needs a Frustration removal event.
      const lockedOnly =
        entry.shadow && entry.chargedMoves.length === 1 && entry.chargedMoves[0] === species?.shadowMove;
      const specAt = (level) => ({ ...entry, level, ...(lockedOnly ? { chargedMoves: [] } : {}) });
      const steps = [];
      for (const to of targets) {
        const g = gainAcrossBosses(gd, baseline, rosterIndex, attackerVariants(gd, specAt(to)));
        if (g.sumGain <= 1e-6) continue;
        steps.push({
          to,
          sumGain: g.sumGain,
          raidsHelped: g.helped,
          avgGain: g.helped ? g.gains.reduce((t, x) => t + x.gain, 0) / g.helped : 0,
          bestRaids: g.gains.slice(0, 3),
          cost: powerUpCost(gd, entry.level, to, { shadow: entry.shadow, pokemonId: species?.pokemonId }),
        });
      }
      if (!steps.length) return;
      rows.push({
        accountId: account.id,
        accountName: account.name,
        rosterIndex,
        pokemon: (species?.name ?? entry.pokemonId) + (entry.shadow ? ' (Shadow)' : ''),
        // Forms share candy with their species (Landorus Therian eats Landorus candy).
        candyPool: species?.pokemonId ?? entry.pokemonId,
        level: entry.level,
        ivs: [entry.ivAtk, entry.ivDef, entry.ivSta],
        shadow: Boolean(entry.shadow),
        mega: entry.mega || '',
        /** Moves set to Any are assumed to be the best ones, which flatters the gain. */
        anyMoves: !entry.fastMove || !entry.chargedMoves.length,
        /** Scored with its locked move replaced, which takes a Frustration removal event. */
        assumesFrustrationGone: lockedOnly,
        steps,
        /** The highest level tried: what the ranking goes by. */
        top: steps[steps.length - 1],
      });
    });
  }

  // Rank by the biggest gain, then point every later copy of a species at the best one.
  rows.sort((a, b) => b.top.sumGain - a.top.sumGain);
  const bestCopy = new Map();
  for (const row of rows) {
    const key = `${row.accountId}:${row.candyPool}`;
    const first = bestCopy.get(key);
    if (first) row.sharesCandyWith = { pokemon: first.pokemon, level: first.level, ivs: first.ivs };
    else bestCopy.set(key, row);
  }

  return { rows, bossesChecked: all.bosses.length, ms: Date.now() - started };
}

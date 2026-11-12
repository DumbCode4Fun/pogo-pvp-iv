/**
 * Max Battle (Dynamax / Gigantamax) solver, built on estimates.
 *
 * The game master has no Max Battle mechanics (no Max moves, boss HP, Max levels, Max Particles),
 * so this is a model assembled from community write-ups. Every number that is not directly
 * confirmed lives in MAX_TUNING with a note on how sure we are, and the UI shows and edits them.
 * Read the answers as "what this model says", not as game truth: calibrate against a real battle
 * with `damageScale` (see MAX_TUNING).
 *
 * What the model does, in the order things happen in a battle:
 *   - Up to four trainers each bring three Pokemon ticked Dynamax on their roster (canDynamax);
 *     the ones also ticked Gigantamax use their G-Max move.
 *   - Defender phase: a trainer's lead uses its Fast move. Each Fast attack hurts the boss a little
 *     and adds its energy to that trainer's Max meter.
 *   - Meter full: the trainer swaps a Pokemon in for the Max phase, which is three Max moves in a row
 *     (Max Attack, Max Guard or Max Spirit), then swaps back. Max moves cannot be dodged.
 *   - The boss hits one on-field Pokemon every few seconds, preferring whoever has Shields (Max Guard).
 *   - A trainer whose three Pokemon have fainted is out. Everyone out, or the clock, ends the fight.
 *
 * Everything here is pure: no DOM, no fetch.
 */
import { hitDamage, typeEffectiveness, buildAttacker, rosterCandidates } from './engine.js';

// ---------------------------------------------------------------- tiers and move tables

/**
 * Modelled boss HP by tier, from Dittobase's "Modeled Max Battle HP". The game does not publish it.
 * Only tiers with a published figure are offered (2-star and 4-star have none).
 */
export const MAX_TIERS = {
  T1: { id: 'T1', label: '1★ Dynamax', hp: 1700, gmax: false },
  T3: { id: 'T3', label: '3★ Dynamax', hp: 10000, gmax: false },
  T5: { id: 'T5', label: '5★ Dynamax', hp: 75000, gmax: false },
  T6: { id: 'T6', label: '6★ Gigantamax', hp: 75000, gmax: true },
};

/** Max move tables by Max level 1-3, from Pokemon GO Hub's Max Battles guide. */
export const MAX_ATTACK_POWER = { dynamax: [250, 300, 350], gmax: [350, 400, 450] };
export const MAX_GUARD_HP = [20, 40, 60];
export const MAX_SPIRIT_HEAL = [0.08, 0.12, 0.16];

/**
 * The 17 Pokemon Serebii lists as Gigantamax-capable, with their G-Max move's type. A Gigantamax
 * Pokemon's Max Attack has a fixed type; a Dynamax one takes the type of its Fast move. The types are
 * the main-series ones and are not confirmed for Pokemon GO. Only these species can be ticked
 * Gigantamax on the roster.
 */
export const GMAX_TYPES = {
  VENUSAUR: 'GRASS',
  CHARIZARD: 'FIRE',
  BLASTOISE: 'WATER',
  BUTTERFREE: 'BUG',
  PIKACHU: 'ELECTRIC',
  MEOWTH: 'NORMAL',
  MACHAMP: 'FIGHTING',
  GENGAR: 'GHOST',
  KINGLER: 'WATER',
  LAPRAS: 'ICE',
  SNORLAX: 'NORMAL',
  RILLABOOM: 'GRASS',
  CINDERACE: 'FIRE',
  INTELEON: 'WATER',
  TOXTRICITY_AMPED: 'ELECTRIC',
  GRIMMSNARL: 'DARK',
  DURALUDON: 'DRAGON',
};

// ---------------------------------------------------------------- tuning

/**
 * Each entry: key -> { value, label, min, max, step, status, note }.
 *   status 'sourced'  a community figure several write-ups agree on
 *   status 'guess'    nothing published; a placeholder to calibrate
 *   status 'choice'   a modelling decision rather than a game number
 */
export const MAX_TUNING = {
  maxLevel: { value: 3, label: 'Max move level (1-3)', min: 1, max: 3, step: 1, status: 'choice', note: 'Assumed for every Pokémon; Max Attack power is 250/300/350 (Dynamax) or 350/400/450 (Gigantamax) by level.' },
  supportUnlocked: { value: true, label: 'Max Guard and Max Spirit are unlocked', status: 'choice', note: 'They start locked and cost Max Particles and Candy.' },
  damageScale: { value: 1, label: 'Damage scale', min: 0.1, max: 10, step: 0.05, status: 'guess', note: 'Multiplies all damage to the boss. The real damage formula is unknown: if the model is too hard or too easy against a battle you really fought, change this until it matches.' },
  hpScale: { value: 1, label: 'Boss HP scale', min: 0.1, max: 10, step: 0.05, status: 'guess', note: 'Multiplies the modelled boss HP (1,700 / 10,000 / 75,000 by tier).' },
  meterCapacity: { value: 100, label: 'Max meter size (Fast-move energy)', min: 20, max: 400, step: 5, status: 'guess', note: 'How much Fast-move energy fills the Max meter. Not published.' },
  maxMoveSeconds: { value: 2.5, label: 'Seconds per Max move', min: 1, max: 6, step: 0.1, status: 'guess', note: 'A Max phase is three of these.' },
  bossCpm: { value: 0.79, label: 'Boss CP multiplier', min: 0.4, max: 1, step: 0.01, status: 'guess', note: 'Assumed the same as 5★ raids.' },
  bossMovePower: { value: 100, label: 'Boss attack power', min: 10, max: 500, step: 5, status: 'guess', note: 'Boss moves and damage are not published; one STAB attack of its main type is modelled.' },
  bossAttackInterval: { value: 3, label: 'Seconds between boss attacks', min: 0.5, max: 10, step: 0.5, status: 'guess', note: 'One target per attack.' },
  dodgeSuccess: { value: 0.5, label: 'Share of boss attacks you dodge', min: 0, max: 1, step: 0.05, status: 'guess', note: 'Dodging works in the defender phase only, not during Max moves.' },
  fastDamageCounts: { value: true, label: 'Fast attacks damage the boss', status: 'guess', note: 'Not confirmed; they certainly charge the meter.' },
  switchSeconds: { value: 1, label: 'Seconds to send in a new Pokémon after a faint', min: 0, max: 5, step: 0.5, status: 'choice', note: 'From the raid swap time.' },
  timeLimit: { value: 0, label: 'Time limit (s, 0 = none)', min: 0, max: 1800, step: 30, status: 'sourced', note: 'Serebii says there is none; the model stops at 30 minutes.' },
};

export const DEFAULT_MAX_TUNING = Object.fromEntries(Object.entries(MAX_TUNING).map(([k, t]) => [k, t.value]));

/** Fills in defaults and clamps numbers; anything unknown is dropped. */
export function resolveMaxTuning(input = {}) {
  const out = {};
  for (const [key, t] of Object.entries(MAX_TUNING)) {
    const raw = input[key];
    if (typeof t.value === 'boolean') out[key] = typeof raw === 'boolean' ? raw : t.value;
    else {
      const n = Number(raw);
      out[key] = raw === undefined || raw === null || raw === '' || !Number.isFinite(n) ? t.value : Math.min(t.max, Math.max(t.min, n));
    }
  }
  return out;
}

const HARD_TIME_CAP = 1800;
const DT = 0.1;
const BOSS_IV = 15;

// ---------------------------------------------------------------- boss and Pokemon

/** Species that may be a Max Battle boss at this tier: Gigantamax-capable ones for 6★, any released one otherwise. */
export function maxBossCandidates(gd, tierId) {
  const tier = MAX_TIERS[tierId];
  if (!tier) return [];
  return rosterCandidates(gd).filter((p) => (tier.gmax ? p.id in GMAX_TYPES : true));
}

export function buildMaxBoss(gd, spec, tuning) {
  const p = gd.pokemon.find((x) => x.id === spec.pokemonId);
  if (!p) throw new Error(`unknown boss: ${spec.pokemonId}`);
  const tier = MAX_TIERS[spec.tier];
  if (!tier) throw new Error(`unknown tier: ${spec.tier}`);
  return {
    species: p,
    name: p.name,
    types: p.types,
    tier,
    hp: Math.round(tier.hp * tuning.hpScale),
    atk: (p.stats.atk + BOSS_IV) * tuning.bossCpm,
    def: (p.stats.def + BOSS_IV) * tuning.bossCpm,
  };
}

const tierIndex = (tuning) => Math.min(3, Math.max(1, Math.round(tuning.maxLevel))) - 1;

/** Damage one Max Attack from `mon` does to the boss. */
export function maxAttackDamage(gd, mon, boss, tuning) {
  return maxAttackDamageOf(gd, mon.atk, mon.types, mon.maxType, mon.gmax, boss, tuning);
}

function maxAttackDamageOf(gd, atk, types, maxType, gmax, boss, tuning) {
  const power = MAX_ATTACK_POWER[gmax ? 'gmax' : 'dynamax'][tierIndex(tuning)];
  const stab = types.includes(maxType) ? gd.constants.stab : 1;
  const eff = typeEffectiveness(gd.typeChart, maxType, boss.types);
  return hitDamage(power, atk, boss.def, stab * eff) * tuning.damageScale;
}

function fastDamage(gd, mon, boss, tuning) {
  if (!tuning.fastDamageCounts) return 0;
  const f = mon.fast;
  const stab = mon.types.includes(f.type) ? gd.constants.stab : 1;
  return hitDamage(f.power, mon.atk, boss.def, stab * typeEffectiveness(gd.typeChart, f.type, boss.types)) * tuning.damageScale;
}

/** Damage one boss attack does to `mon` (before dodging and shields). */
function bossHit(gd, boss, mon, tuning) {
  const type = boss.types[0];
  const stab = gd.constants.stab;
  return hitDamage(tuning.bossMovePower, boss.atk, mon.def, stab * typeEffectiveness(gd.typeChart, type, mon.types));
}

/** True if a roster entry is ticked as able to join Max Battles (Gigantamax implies Dynamax). */
export const canDynamax = (entry) => Boolean(entry?.dynamax || entry?.gigantamax);

/**
 * One roster entry as a Max Pokemon, or null if it cannot take part (a Shadow, or unknown data).
 * solveMax decides which entries are offered (canDynamax); this only builds one.
 * It is Gigantamax when the entry is ticked Gigantamax and its species has a G-Max form.
 * It has a single Fast move, as in the game: the one that suits its Max Attack against this boss
 * (a Dynamax Max Attack takes the Fast move's type), unless the roster pins one.
 */
export function buildMon(gd, entry, boss, tuning) {
  if (entry.shadow) return null;
  let att;
  try {
    att = buildAttacker(gd, { ...entry, mega: '', shadow: false }, { asMega: false });
  } catch {
    return null;
  }
  if (!att.fastMoves.length) return null;
  const gmaxType = entry.gigantamax ? GMAX_TYPES[att.species.id] : undefined;
  const gmax = Boolean(gmaxType);

  let best = null;
  for (const fast of att.fastMoves) {
    const maxType = gmax ? gmaxType : fast.type;
    const dmg = maxAttackDamageOf(gd, att.atk, att.types, maxType, gmax, boss, tuning);
    const rate = fast.energy / (fast.duration / 1000);
    if (!best || dmg > best.dmg + 1e-9 || (Math.abs(dmg - best.dmg) < 1e-9 && rate > best.rate)) best = { fast, maxType, dmg, rate };
  }
  const mon = {
    name: att.name,
    speciesId: att.species.id,
    types: att.types,
    atk: att.atk,
    def: att.def,
    hp: Math.max(1, att.hp),
    fast: best.fast,
    gmax,
    maxType: best.maxType,
    maxDmg: best.dmg,
    energyRate: best.rate,
    bulk: att.hp * att.def,
    entry,
  };
  mon.fastDmg = fastDamage(gd, mon, boss, tuning);
  return mon;
}

// ---------------------------------------------------------------- simulation

/**
 * @param teams one array of Max Pokemon (up to 3) per trainer
 * @param strategy { tank: trainer index | null, healBelow: 0..1 }
 *   tank: that trainer never attacks; its lead takes Max Guard then Max Spirit and soaks the boss's hits.
 *   healBelow: a Max phase opens with Max Spirit when its trainer's lead is under this share of its HP.
 */
export function simulateMax(gd, boss, teams, tuning, strategy = { tank: null, healBelow: 0 }) {
  const limit = tuning.timeLimit > 0 ? tuning.timeLimit : HARD_TIME_CAP;
  const lvl = tierIndex(tuning);
  const guardHp = MAX_GUARD_HP[lvl];
  const spiritPct = MAX_SPIRIT_HEAL[lvl];

  const trainers = teams.map((team, i) => ({
    i,
    mons: team.map((m) => ({ m, hp: m.hp, shield: 0, alive: true })),
    lead: null, // index into mons that is on the field
    phase: 'defend',
    meter: 0,
    fastTimer: 0,
    moveTimer: 0,
    movesLeft: 0,
    queue: [],
    switchTimer: 0,
    dmg: 0,
    phases: 0,
    attacks: 0,
    out: false,
  }));

  const pickLead = (t, prefer) => {
    const alive = t.mons.map((x, idx) => ({ x, idx })).filter((o) => o.x.alive);
    if (!alive.length) return null;
    // the sturdiest Pokemon holds the field between Max phases, unless a tank-style choice is wanted
    alive.sort((a, b) => (prefer === 'attack' ? b.x.m.maxDmg - a.x.m.maxDmg : b.x.m.bulk - a.x.m.bulk));
    return alive[0].idx;
  };

  for (const t of trainers) {
    t.lead = pickLead(t, 'bulk');
    t.out = t.lead === null;
  }

  let hp = boss.hp;
  let time = 0;
  let bossTimer = 0;
  let rr = 0;
  const faints = [];
  const onField = (t) => (t.out ? null : t.mons[t.lead]);

  const faint = (t, mon) => {
    mon.alive = false;
    faints.push({ trainer: t.i, name: mon.m.name, at: time });
    if (t.phase === 'max' && t.mons[t.lead] === mon) {
      t.phase = 'defend';
      t.queue = [];
      t.fastTimer = 0;
    }
    t.lead = pickLead(t, 'bulk');
    t.out = t.lead === null;
    t.switchTimer = tuning.switchSeconds;
  };

  while (time < limit && hp > 0 && trainers.some((t) => !t.out)) {
    time += DT;

    // --- the trainers
    for (const t of trainers) {
      if (t.out) continue;
      if (t.switchTimer > 0) {
        t.switchTimer -= DT;
        continue;
      }
      const lead = t.mons[t.lead];
      if (t.phase === 'defend') {
        const f = lead.m.fast;
        t.fastTimer += DT;
        if (t.fastTimer + 1e-9 >= f.duration / 1000) {
          t.fastTimer -= f.duration / 1000;
          hp -= lead.m.fastDmg;
          t.dmg += lead.m.fastDmg;
          t.meter += f.energy;
          if (t.meter >= tuning.meterCapacity) {
            t.meter -= tuning.meterCapacity;
            t.phases += 1;
            t.phase = 'max';
            t.moveTimer = 0;
            const tanking = strategy.tank === t.i;
            if (tanking) {
              t.queue = tuning.supportUnlocked ? ['GUARD', 'SPIRIT', 'SPIRIT'] : ['ATTACK', 'ATTACK', 'ATTACK'];
            } else {
              // swap in the best attacker still standing
              const a = pickLead(t, 'attack');
              if (a !== t.lead) {
                t.lead = a;
                t.fastTimer = 0;
              }
              const cur = t.mons[t.lead];
              const hurt = cur.hp / cur.m.hp < strategy.healBelow;
              t.queue = hurt && tuning.supportUnlocked ? ['SPIRIT', 'ATTACK', 'ATTACK'] : ['ATTACK', 'ATTACK', 'ATTACK'];
            }
          }
        }
      } else {
        t.moveTimer += DT;
        if (t.moveTimer + 1e-9 >= tuning.maxMoveSeconds) {
          t.moveTimer -= tuning.maxMoveSeconds;
          const move = t.queue.shift();
          if (move === 'ATTACK') {
            hp -= lead.m.maxDmg;
            t.dmg += lead.m.maxDmg;
            t.attacks += 1;
          } else if (move === 'GUARD') {
            lead.shield = guardHp;
          } else if (move === 'SPIRIT') {
            const heal = lead.m.hp * spiritPct;
            // heals the user and the allies on the field
            for (const o of trainers) {
              const mon = onField(o);
              if (mon?.alive) mon.hp = Math.min(mon.m.hp, mon.hp + heal);
            }
          }
          if (!t.queue.length) {
            t.phase = 'defend';
            t.fastTimer = 0;
            // swap back to the defender, except the tank who stays put
            if (strategy.tank !== t.i) t.lead = pickLead(t, 'bulk') ?? t.lead;
          }
        }
      }
    }
    if (hp <= 0) break;

    // --- the boss
    bossTimer += DT;
    if (bossTimer + 1e-9 >= tuning.bossAttackInterval) {
      bossTimer -= tuning.bossAttackInterval;
      const live = trainers.filter((t) => !t.out);
      if (live.length) {
        const shielded = live.filter((t) => onField(t).shield > 0).sort((a, b) => onField(b).shield - onField(a).shield);
        const target = shielded[0] ?? live[rr++ % live.length];
        const mon = onField(target);
        let dmg = bossHit(gd, boss, mon.m, tuning);
        if (target.phase === 'defend') dmg *= 1 - tuning.dodgeSuccess * gd.constants.dodgeDamageReduction;
        const absorbed = Math.min(mon.shield, dmg);
        mon.shield -= absorbed;
        mon.hp -= dmg - absorbed;
        if (mon.hp <= 0) faint(target, mon);
      }
    }
  }

  const win = hp <= 0;
  const everyoneOut = trainers.every((t) => t.out);
  return {
    win,
    time: Math.round(time * 10) / 10,
    hpLeft: Math.max(0, Math.round(hp)),
    bossHp: boss.hp,
    reason: win ? 'boss defeated' : everyoneOut ? 'every Pokémon fainted' : 'time limit',
    faints,
    trainers: trainers.map((t) => ({ index: t.i, damage: Math.round(t.dmg), phases: t.phases, maxAttacks: t.attacks, out: t.out })),
  };
}

/** True if result `a` is better than `b`: a win beats a loss, then faster / more HP removed. */
export function betterResult(a, b) {
  if (!b) return true;
  if (a.win !== b.win) return a.win;
  if (a.win) return a.time < b.time - 1e-9;
  return a.hpLeft < b.hpLeft || (a.hpLeft === b.hpLeft && a.time > b.time);
}

// ---------------------------------------------------------------- solving

/** Up to a few reasonable teams of three for one trainer. */
function candidateTeams(mons) {
  // Different species only: three copies of one Pokemon would be an odd team and hides the others.
  const bySpecies = (list) => {
    const seen = new Set();
    return list.filter((m) => (seen.has(m.speciesId) ? false : seen.add(m.speciesId)));
  };
  const byDmg = bySpecies([...mons].sort((a, b) => b.maxDmg - a.maxDmg));
  const pool = byDmg.slice(0, 12);
  const byBulk = [...pool].sort((a, b) => b.bulk - a.bulk);
  const score = (m) => m.maxDmg * Math.sqrt(m.bulk);
  const byBalance = [...pool].sort((a, b) => score(b) - score(a));
  const teams = [];
  const add = (list) => {
    const team = list.slice(0, 3);
    if (!team.length) return;
    const key = team.map((m) => m.speciesId).sort().join('|');
    if (!teams.some((t) => t.key === key)) teams.push({ key, team });
  };
  add(byDmg);
  add(byBalance);
  const top2 = byDmg.slice(0, 2);
  add([...top2, ...byBulk.filter((m) => !top2.includes(m))]);
  const top1 = byDmg.slice(0, 1);
  add([...top1, ...byBulk.filter((m) => !top1.includes(m))]);
  return teams.map((t) => t.team);
}

/**
 * @param accounts [{ id, name, active, roster }]; only active ones fight, and only with the
 *   roster entries ticked Dynamax (canDynamax).
 * @returns the best teams and strategy found, with the full result and a sensitivity table.
 */
export function solveMax(gd, bossSpec, accounts, tuningInput) {
  const tuning = resolveMaxTuning(tuningInput);
  const boss = buildMaxBoss(gd, bossSpec, tuning);

  const playing = accounts.filter((a) => a.active && (a.roster ?? []).length);
  if (!playing.length) return { boss, tuning, error: 'No account that is marked as playing has any Pokémon yet.' };

  const fighting = playing.map((a) => ({ account: a, entries: a.roster.filter(canDynamax) })).filter((x) => x.entries.length);
  if (!fighting.length) {
    return { boss, tuning, error: 'None of the playing accounts has a Pokémon ticked Dynamax. Tick Dynamax on the Raid tab for each Pokémon that can join Max Battles.' };
  }

  const usable = fighting
    .map((x) => ({ account: x.account, mons: x.entries.map((e) => buildMon(gd, e, boss, tuning)).filter(Boolean) }))
    .filter((x) => x.mons.length);
  if (!usable.length) return { boss, tuning, error: 'None of the playing accounts has a Dynamax Pokémon that can take part (Shadow Pokémon cannot).' };

  const options = usable.map((x) => candidateTeams(x.mons));

  // Strategies: who (if anyone) tanks, and when to open a Max phase with a heal.
  const strategies = [];
  for (const healBelow of [0, 0.5]) {
    strategies.push({ tank: null, healBelow });
    if (usable.length > 1 && tuning.supportUnlocked) for (let t = 0; t < usable.length; t++) strategies.push({ tank: t, healBelow });
  }

  // For each strategy, hill-climb the teams (one trainer's team at a time, the others held fixed),
  // starting from the best teams found so far, and keep the best result overall. Doing the climb per
  // strategy, rather than once, keeps the answer from depending on which strategy happened to come first.
  let strategy = null;
  let best = null;
  let bestChoice = options.map(() => 0);
  for (const s of strategies) {
    const choice = [...bestChoice];
    const teamsOf = () => options.map((o, i) => o[choice[i]]);
    let r = simulateMax(gd, boss, teamsOf(), tuning, s);
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (let i = 0; i < options.length; i++) {
        for (let c = 0; c < options[i].length; c++) {
          if (c === choice[i]) continue;
          const prev = choice[i];
          choice[i] = c;
          const next = simulateMax(gd, boss, teamsOf(), tuning, s);
          if (betterResult(next, r)) {
            r = next;
            moved = true;
          } else choice[i] = prev;
        }
      }
      if (!moved) break;
    }
    if (betterResult(r, best)) {
      best = r;
      strategy = s;
      bestChoice = [...choice];
    }
  }
  const teamsOf = () => options.map((o, i) => o[bestChoice[i]]);

  const teams = teamsOf();
  return {
    boss,
    tuning,
    strategy,
    result: best,
    trainers: usable.map((x, i) => ({
      id: x.account.id,
      name: x.account.name || x.account.id,
      candidates: x.mons.length,
      team: teams[i],
      tank: strategy.tank === i,
    })),
    sensitivity: sensitivity(gd, bossSpec, teams, tuningInput, strategy),
  };
}

/** Re-runs the chosen teams with each shaky assumption halved and doubled. */
function sensitivity(gd, bossSpec, teams, tuningInput, strategy) {
  const base = resolveMaxTuning(tuningInput);
  const rows = [];
  for (const key of ['damageScale', 'hpScale', 'meterCapacity', 'bossMovePower', 'bossAttackInterval']) {
    for (const factor of [0.5, 2]) {
      const tuning = resolveMaxTuning({ ...base, [key]: base[key] * factor });
      if (tuning[key] === base[key]) continue; // clamped to the same value: nothing to show
      const boss = buildMaxBoss(gd, bossSpec, tuning);
      // the Pokemon were rated under the original numbers; re-rate their damage under the perturbed ones
      const re = teams.map((team) => team.map((m) => rebuild(gd, m, boss, tuning)));
      rows.push({ key, label: MAX_TUNING[key].label, factor, result: simulateMax(gd, boss, re, tuning, strategy) });
    }
  }
  return rows;
}

function rebuild(gd, mon, boss, tuning) {
  const out = { ...mon };
  out.maxDmg = maxAttackDamage(gd, mon, boss, tuning);
  out.fastDmg = fastDamage(gd, mon, boss, tuning);
  return out;
}

const fmtSeconds = (t) => `${Math.round(t)}s`;

/**
 * Calibration: finds the damage scale at which the chosen teams beat the boss in `targetSeconds`,
 * so the model can be tied to a battle you really fought. `solved` is a solveMax() result.
 * Returns { scale, time } or { error }.
 */
export function fitDamageScale(gd, bossSpec, solved, targetSeconds) {
  if (!solved?.result || !(targetSeconds > 0)) return { error: 'Enter how long the battle took, in seconds.' };
  const teams = solved.trainers.map((t) => t.team);
  const { min, max } = MAX_TUNING.damageScale;
  const at = (scale) => {
    const tuning = resolveMaxTuning({ ...solved.tuning, damageScale: scale });
    const boss = buildMaxBoss(gd, bossSpec, tuning);
    const re = teams.map((team) => team.map((m) => rebuild(gd, m, boss, tuning)));
    return simulateMax(gd, boss, re, tuning, solved.strategy);
  };
  if (!at(max).win) return { error: 'These teams cannot beat this boss even at the highest damage scale (they are knocked out first). Adjust the boss attack settings instead.' };
  if (at(min).win && at(min).time <= targetSeconds) return { scale: min, time: at(min).time };
  // Bisect on a log scale for the smallest scale that still wins within the target time.
  let lo = min;
  let hi = max;
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    const r = at(mid);
    if (r.win && r.time <= targetSeconds) hi = mid;
    else lo = mid;
  }
  const result = at(hi);
  // Time falls as damage rises, but a team can jump from losing to winning fast, leaving no scale that
  // lands near the target. Say so rather than report a scale that does not reproduce the battle.
  if (Math.abs(result.time - targetSeconds) > Math.max(5, targetSeconds * 0.1)) {
    return {
      error: `No damage scale makes these teams win in about ${Math.round(targetSeconds)}s: they go from losing to winning in ${fmtSeconds(result.time)} at scale ${Math.round(hi * 100) / 100}. The boss attack settings (power, interval, dodging) probably need adjusting first.`,
    };
  }
  return { scale: Math.round(hi * 100) / 100, time: result.time };
}

/**
 * Raid feasibility engine.
 *
 * Two layers:
 *   1. Per-Pokemon *cycle DPS* -- a closed-form average of the fast/charged move loop,
 *      including the energy a raid attacker gains from the damage it takes.
 *   2. An aggregate timeline stepper that advances every account in parallel, so boss
 *      phases (shadow enrage and gems), faint/switch downtime, relobby cycles and mega-boost
 *      uptime all resolve against the real 300 s clock.
 *
 * Everything here is pure: no DOM, no fetch. `tests/` drives it directly under Node.
 */

// ---------------------------------------------------------------- constants

const RAID_CLASSES = new Set(['LEGENDARY', 'MYTHIC', 'ULTRA_BEAST']);
/**
 * Legendary / mythical / ultra beast, and actually in Pokemon GO.
 *
 * Fusions and Crowned formes count: the items that create them come from dedicated Crown and
 * Fusion raids, where the boss *is* the fused/crowned form. Crowned Sword Zacian is a normal
 * 5-star boss -- its in-game 67,864 CP matches 15,000 HP exactly (see bossCp).
 */
const isRaidClass = (p) => RAID_CLASSES.has(p.pokemonClass) && p.released !== false;

/**
 * Raid boss HP and CP multiplier are server-side, not in the game master, so these are the
 * long-established community values. HP is overridable.
 *
 * `eligible` decides which Pokemon can be picked as the boss for that tier. Standard
 * (non-legendary) Mega raids are deliberately absent: they are tier-4-equivalent (9500 HP)
 * and out of scope.
 *
 * Mega Legendary and Primal raids share a tier: both are 22,500 HP at the same multiplier and
 * timer, so splitting them only changed which bosses were listed. Mega Rayquaza lives here --
 * it's a Mega Legendary raid (its Elite raid showed 88,200 CP, which is also 22,500 HP).
 */
export const RAID_TIERS = {
  T5: {
    id: 'T5',
    label: '5★ Legendary',
    hp: 15000,
    cpm: 0.79,
    timer: 300,
    eligible: (p) => !p.tempEvo && isRaidClass(p),
  },
  T5_MEGA: {
    id: 'T5_MEGA',
    label: 'Mega Legendary / Primal (6★)',
    hp: 22500,
    cpm: 0.79,
    timer: 300,
    eligible: (p) => Boolean(p.tempEvo) && isRaidClass(p),
  },
  T5_SHADOW: {
    id: 'T5_SHADOW',
    label: '5★ Shadow',
    hp: 15000,
    cpm: 0.79,
    timer: 300,
    shadow: true,
    eligible: (p) => !p.tempEvo && isRaidClass(p) && p.shadowAvailable,
  },
};

/** Tier ids from older saves. */
const TIER_ALIASES = { PRIMAL: 'T5_MEGA' };
export const resolveTier = (id) => TIER_ALIASES[id] ?? id;

/** Every Pokemon that can be the boss of a given tier, alphabetical. */
export function bossCandidates(gd, tierId) {
  const tier = RAID_TIERS[resolveTier(tierId)];
  return tier ? gd.pokemon.filter(tier.eligible) : [];
}

/** What a roster can hold: base forms (megas are a flag on the base) that are in the game. */
export const rosterCandidates = (gd) => gd.pokemon.filter((p) => !p.tempEvo && p.released !== false);

export const WEATHER = [
  { id: 'NONE', label: 'Neutral / Extreme' },
  { id: 'CLEAR', label: 'Clear / Sunny' },
  { id: 'RAINY', label: 'Rainy' },
  { id: 'PARTLY_CLOUDY', label: 'Partly Cloudy' },
  { id: 'OVERCAST', label: 'Cloudy' },
  { id: 'WINDY', label: 'Windy' },
  { id: 'SNOW', label: 'Snow' },
  { id: 'FOG', label: 'Fog' },
];

/** Attack multipliers are FRIENDSHIP_LEVEL_0..5 in the game master. */
export const FRIENDSHIP = [
  { id: 0, label: 'Not friends', mult: 1 },
  { id: 1, label: 'Good', mult: 1.03 },
  { id: 2, label: 'Great', mult: 1.05 },
  { id: 3, label: 'Ultra', mult: 1.07 },
  { id: 4, label: 'Best', mult: 1.1 },
  { id: 5, label: 'Forever', mult: 1.12 },
];

export const PARTY_POWER = [
  { id: 'off', label: 'Not in the party' },
  // Counts towards party size without attacking -- an idle account still fills a party slot.
  { id: 'idle', label: 'In party — idle' },
  { id: 'casual', label: 'In party — fires charged moves as they come' },
  { id: 'optimal', label: 'In party — times charged moves to Party Power' },
];

/**
 * How sharply an account is actually played. Two things slip when you are running a second phone
 * or half-watching: charged moves sit unfired for a moment, and Party Power gets forgotten.
 *
 *   chargedDelay  - seconds a charged move waits after it is affordable
 *   ppReliability - fraction of Party Power fills that actually get spent
 */
export const PLAY_QUALITY = [
  { id: 'sharp', label: 'Sharp — charged move the moment it is up', chargedDelay: 0, ppReliability: 1 },
  { id: 'average', label: 'Average — a beat late here and there', chargedDelay: 0.5, ppReliability: 0.75 },
  { id: 'distracted', label: 'Distracted — second phone, misses some', chargedDelay: 1, ppReliability: 0.5 },
];

export const playQuality = (id) => PLAY_QUALITY.find((q) => q.id === id) ?? PLAY_QUALITY[0];

/** Any mega the trainer has unlocked -- let the planner pick which one to use. */
export const MEGA_ANY = '*';

/** Which mega forms a roster entry may use. */
export function megaSuffixes(entry, species) {
  if (!entry.mega) return [];
  const available = (species?.tempEvos ?? []).map((t) => t.suffix);
  if (entry.mega === MEGA_ANY) return available;
  return available.includes(entry.mega) ? [entry.mega] : [];
}

/** Tunables the user can calibrate; each default names its source in the UI. */
export const DEFAULT_TUNING = {
  /** Boss adds this between its moves. Pokebattler simulates 1.5-2.5 s, median 2.0 s. */
  bossMoveDelay: 2.0,
  /**
   * Chance the boss fires its charged move after a fast attack when it has the energy.
   * 50% since the September 2024 hotfix (it briefly fired every time).
   */
  bossChargedChance: 0.5,
  /** Seconds lost choosing the next Pokemon after one faints. */
  faintDelay: 2.5,
  /** Seconds lost backing out, max-reviving and rejoining the lobby. */
  relobbyTime: 12,
  /**
   * Your own fast attacks needed to refill Party Power, by party size. The meter is per player,
   * not shared -- an idle account in the party stays on zero because it never attacks -- but a
   * bigger party lowers your personal threshold.
   *
   * 18 / 9 / 6 follows 18 / (partySize - 1), and matches the "6 fast attacks in a party of 4"
   * figure that gets quoted around (often misdescribed as 6 shared across the party). No source
   * publishes it properly, so these stay editable.
   */
  partyPowerFastAttacks2: 18,
  partyPowerFastAttacks3: 9,
  partyPowerFastAttacks4: 6,
  /** Shadow boss enraged stats: (mult x base) + 15 -- datamined 1.81 and 3. */
  enrageAtkMult: 1.81,
  enrageDefMult: 3.0,
  /** Enrage begins when the boss falls to this HP fraction... */
  enrageStartHpFrac: 0.6,
  /** ...and it subdues itself at this one. */
  enrageEndHpFrac: 0.15,
  /** Purified Gems: needed across the group, per-player cap, seconds per throw. */
  gemsNeeded: 8,
  gemsPerPlayer: 5,
  gemCooldown: 5,
  /** Timeline resolution, seconds. */
  dt: 0.5,
};

const BOSS_IV = 15;

// ---------------------------------------------------------------- primitives

export function typeEffectiveness(typeChart, moveType, defenderTypes) {
  let m = 1;
  for (const t of defenderTypes) m *= typeChart[moveType]?.[t] ?? 1;
  return m;
}

/** The Pokemon GO damage formula. `mults` is the product of every damage multiplier. */
export function hitDamage(power, atk, def, mults) {
  return Math.floor(0.5 * power * (atk / def) * mults) + 1;
}

const sec = (ms) => ms / 1000;

function boostedTypes(gd, weatherId) {
  return gd.weatherAffinities[weatherId] ?? [];
}

const friendshipMult = (level) => FRIENDSHIP.find((f) => f.id === (level ?? 0))?.mult ?? 1;

// ---------------------------------------------------------------- CP <-> level

/** Levels a Pokemon can actually be at: 1..50, plus 51 for a best buddy. */
export const cpmLevels = (gd) =>
  Object.keys(gd.cpm)
    .map(Number)
    .filter((l) => l <= 51)
    .sort((a, b) => a - b);

/** The CP the game would show for this species at this level and IVs. */
export function cpOf(gd, species, level, ivs) {
  const cpm = gd.cpm[String(level)];
  if (!cpm) return 0;
  const [a, d, s] = ivs;
  return Math.max(
    10,
    Math.floor(((species.stats.atk + a) * Math.sqrt(species.stats.def + d) * Math.sqrt(species.stats.sta + s) * cpm * cpm) / 10),
  );
}

/** Inverse: the level whose CP sits closest to `cp`. */
export function levelForCp(gd, species, ivs, cp) {
  let best = null;
  for (const level of cpmLevels(gd)) {
    const diff = Math.abs(cpOf(gd, species, level, ivs) - cp);
    if (!best || diff < best.diff) best = { level, diff };
  }
  return best;
}

// ---------------------------------------------------------------- roster entries

/**
 * Brings a stored roster entry to the current shape. Older saves listed megas as their own
 * species ("RAYQUAZA_MEGA"); now a roster holds the base Pokemon plus a mega flag.
 * `dynamax` / `gigantamax` say whether it can join Max Battles; saves from before those flags
 * existed start with both off. Gigantamax implies Dynamax, and a Shadow can do neither.
 */
export function normalizeEntry(gd, entry) {
  const out = {
    level: 40,
    ivAtk: 15,
    ivDef: 15,
    ivSta: 15,
    shadow: false,
    fastMove: '',
    chargedMoves: [],
    mega: '',
    megaLevel: 1,
    dynamax: false,
    gigantamax: false,
    ...entry,
  };
  const p = gd.pokemon.find((x) => x.id === out.pokemonId);
  if (p?.baseId) {
    out.pokemonId = p.baseId;
    out.mega = p.megaSuffix;
    out.shadow = false;
  }
  out.gigantamax = Boolean(out.gigantamax) && !out.shadow;
  out.dynamax = (Boolean(out.dynamax) || out.gigantamax) && !out.shadow;
  out.chargedMoves = (out.chargedMoves ?? []).filter(Boolean);
  // A shadow's locked move (Frustration) goes when it's purified -- it becomes Return -- so only a
  // shadow can keep it.
  if (!out.shadow) {
    const base = p?.baseId ? gd.pokemon.find((x) => x.id === out.pokemonId) : p;
    const locked = base?.shadowMove ?? 'FRUSTRATION';
    out.chargedMoves = out.chargedMoves.filter((m) => m !== locked);
  }
  return out;
}

// ---------------------------------------------------------------- combatants

/**
 * @param spec a roster entry: { pokemonId, level, ivAtk, ivDef, ivSta, shadow, fastMove,
 *   chargedMoves[], mega, megaLevel }. `mega` ('' | 'MEGA' | 'MEGA_X' | 'MEGA_Y' | 'PRIMAL')
 *   selects the mega-evolved stats; set `asMega: false` to build the base form regardless.
 */
export function buildAttacker(gd, spec, { asMega = true } = {}) {
  const entry = normalizeEntry(gd, spec);
  const base = gd.pokemon.find((x) => x.id === entry.pokemonId);
  if (!base) throw new Error(`unknown pokemon: ${entry.pokemonId}`);

  let form = base;
  let levelBoost = 0;
  const megaActive = asMega && Boolean(entry.mega);
  if (megaActive) {
    // "Any unlocked" resolves to the first form here; rankRoster expands it properly so the
    // planner can weigh Mega X against Mega Y.
    const suffix = entry.mega === MEGA_ANY ? megaSuffixes(entry, base)[0] : entry.mega;
    form = gd.pokemon.find((x) => x.id === `${base.id}_${suffix}`);
    if (!form) throw new Error(`${base.name} has no ${entry.mega} form`);
    entry.mega = suffix;
    // Mega Level 4 on some species raises the mega's own effective level.
    levelBoost = base.megaSelfLevelBoost?.[entry.megaLevel] ?? 0;
  }

  const level = entry.level + levelBoost;
  const cpm = gd.cpm[String(level)];
  if (cpm === undefined) throw new Error(`unknown level: ${level}`);
  const c = gd.constants;
  const shadow = Boolean(entry.shadow) && !megaActive;

  const fastIds = entry.fastMove ? [entry.fastMove] : base.fastMoves;
  const chargedIds = entry.chargedMoves.length ? entry.chargedMoves : base.chargedMoves;
  const charged = chargedIds.map((id) => gd.moves[id]).filter(Boolean);

  // A mega eligible for Super Max Level knows an extra charged attack automatically while mega
  // evolved. It isn't learned, so it's added no matter which moves the roster pins -- and its
  // power scales with Mega Level.
  let plusMove = null;
  if (megaActive && form.plusMove && gd.moves[form.plusMove]) {
    const scale = gd.constants.plusPowerByMegaLevel?.[entry.megaLevel] ?? 1;
    plusMove = { ...gd.moves[form.plusMove], power: gd.moves[form.plusMove].power * scale, megaLevel: entry.megaLevel };
    charged.push(plusMove);
  }

  return {
    spec: entry,
    species: form,
    name: form.name + (shadow ? ' (Shadow)' : ''),
    types: form.types,
    shadow,
    isMega: megaActive,
    level: entry.level,
    effectiveLevel: level,
    atk: (form.stats.atk + entry.ivAtk) * cpm * (shadow ? c.shadowAttack : 1),
    def: (form.stats.def + entry.ivDef) * cpm * (shadow ? c.shadowDefense : 1),
    hp: Math.floor((form.stats.sta + entry.ivSta) * cpm),
    fastMoves: fastIds.map((id) => gd.moves[id]).filter(Boolean),
    chargedMoves: charged,
    plusMove,
    /** A mega/primal in the battle boosts every attacker in the raid. */
    megaBoost: megaActive && form.boostsAllies ? { types: form.allyBoostTypes, persists: form.boostPersists } : null,
  };
}

/**
 * @param spec {{ pokemonId, tier, fastMove?, chargedMove?, hpOverride?, cpmOverride? }}
 */
export function buildBoss(gd, spec) {
  const p = gd.pokemon.find((x) => x.id === spec.pokemonId);
  if (!p) throw new Error(`unknown boss: ${spec.pokemonId}`);
  const tier = RAID_TIERS[resolveTier(spec.tier)];
  if (!tier) throw new Error(`unknown tier: ${spec.tier}`);
  const c = gd.constants;
  const cpm = spec.cpmOverride ?? tier.cpm;
  // A shadow raid boss is a shadow Pokemon: it deals and takes 20% more damage.
  const isShadow = Boolean(tier.shadow);

  const fast = spec.fastMove ? [gd.moves[spec.fastMove]] : p.fastMoves.map((m) => gd.moves[m]);
  const charged = spec.chargedMove ? [gd.moves[spec.chargedMove]] : p.chargedMoves.map((m) => gd.moves[m]);

  return {
    spec,
    species: p,
    name: p.name,
    types: p.types,
    tier,
    isShadow,
    eligible: tier.eligible(p),
    /** Identity for the rate cache: anything that changes the numbers must appear here. */
    key: [spec.pokemonId, spec.tier, spec.fastMove ?? '*', spec.chargedMove ?? '*', spec.hpOverride ?? '', cpm].join('|'),
    hp: spec.hpOverride ?? tier.hp,
    timer: tier.timer,
    baseAtk: p.stats.atk,
    baseDef: p.stats.def,
    cpm,
    shadowAtk: isShadow ? c.shadowAttack : 1,
    shadowDef: isShadow ? c.shadowDefense : 1,
    fastMoves: fast.filter(Boolean),
    chargedMoves: charged.filter(Boolean),
    movesetPinned: Boolean(spec.fastMove && spec.chargedMove),
  };
}

/**
 * The CP the game shows for a raid boss. Raid bosses use 15 IVs and their tier's fixed HP in
 * place of stamina, with no CP multiplier:
 *
 *   CP = (baseAtk + 15) * sqrt(baseDef + 15) * sqrt(bossHP) / 10
 *
 * Handy for checking a tier's HP against a screenshot: Mega Rayquaza reads 88,200 at 22,500 HP
 * and Crowned Sword Zacian reads 67,864 at 15,000.
 */
export function bossCp(boss) {
  return Math.floor(((boss.baseAtk + BOSS_IV) * Math.sqrt(boss.baseDef + BOSS_IV) * Math.sqrt(boss.hp)) / 10);
}

/** Boss attack/defence while calm. */
export function calmPhase(boss) {
  return {
    enraged: false,
    atk: (boss.baseAtk + BOSS_IV) * boss.cpm * boss.shadowAtk,
    def: (boss.baseDef + BOSS_IV) * boss.cpm * boss.shadowDef,
  };
}

/**
 * Boss attack/defence while enraged. The datamined formula replaces the base stat, not the
 * finished stat: (1.81 x baseAttack) + 15 and (3 x baseDefense) + 15, then CPM and the shadow
 * modifier as usual.
 */
export function enragedPhase(boss, ctx) {
  const t = ctx.tuning;
  return {
    enraged: true,
    atk: (t.enrageAtkMult * boss.baseAtk + BOSS_IV) * boss.cpm * boss.shadowAtk,
    def: (t.enrageDefMult * boss.baseDef + BOSS_IV) * boss.cpm * boss.shadowDef,
  };
}

/**
 * How long after enraging the group gets the boss calmed with Purified Gems, or null if it
 * can't (e.g. one thrower can't reach 8 gems at 5 each). Every throw takes `gemCooldown`
 * seconds to land and each thrower is limited to `gemsPerPlayer`.
 */
export function gemCalmSeconds(ctx, throwers) {
  const t = ctx.tuning;
  if (!ctx.purifiedGems || throwers <= 0) return null;
  if (throwers * t.gemsPerPlayer < t.gemsNeeded) return null;
  return Math.ceil(t.gemsNeeded / throwers) * t.gemCooldown;
}

// ---------------------------------------------------------------- incoming damage

/**
 * Average boss DPS against one attacker.
 *
 * The boss adds `bossMoveDelay` after every move. After each fast attack, if it can afford its
 * charged move, it fires it with probability `bossChargedChance`. It earns energy from its fast
 * move and from damage the group deals it (0.5 per HP lost) -- in a group raid that second
 * source means it can almost always afford the charged move, so the coin flip is what paces it.
 *
 * Unpinned movesets are averaged over every fast x charged pair.
 */
export function incomingDps(gd, boss, attacker, ctx, phase, groupDps = 0) {
  const c = gd.constants;
  const t = ctx.tuning;
  const boosted = boostedTypes(gd, ctx.weather);
  const delay = t.bossMoveDelay;
  const chance = Math.min(1, Math.max(0.01, t.bossChargedChance));
  const energyPerSec = c.bossEnergyPerHpLost * groupDps;

  const dmg = (move) => {
    const mults =
      (boss.types.includes(move.type) ? c.stab : 1) *
      typeEffectiveness(gd.typeChart, move.type, attacker.types) *
      (boosted.includes(move.type) ? c.weatherAttackBonus : 1);
    return hitDamage(move.power, phase.atk, attacker.def, mults);
  };

  let total = 0;
  let n = 0;
  for (const f of boss.fastMoves) {
    for (const ch of boss.chargedMoves) {
      const Df = dmg(f);
      const Dc = dmg(ch);
      const Tf = sec(f.duration) + delay;
      const Tc = sec(ch.duration) + delay;
      const Ec = Math.abs(ch.energy);
      // Fast attacks until it can afford the charged move, then on average (1-p)/p more
      // before the coin flip lands.
      const toAfford = (Ec - energyPerSec * Tc) / (Math.max(0, f.energy) + energyPerSec * Tf);
      const fastPerCharged = Math.max(1, Number.isFinite(toAfford) ? toAfford : 1) + (1 - chance) / chance;
      total += (fastPerCharged * Df + Dc) / (fastPerCharged * Tf + Tc);
      n++;
    }
  }
  return n ? total / n : 0;
}

// ---------------------------------------------------------------- outgoing damage

/**
 * Cycle DPS for one attacker against the boss, plus how long it survives.
 *
 * The fast-move count per charged move is solved continuously, accounting for the energy
 * gained from damage taken (0.5 per HP lost):
 *
 *   n * Ef + energyPerSec * (n * Tf + Tc) = Ec
 *
 * Party Power doubles the next charged move after `partyPowerFastAttacks` of your own fast
 * attacks, then resets:
 *   - casual:  charged moves fire whenever affordable; Party Power lands on whichever charged
 *              move comes after the meter fills.
 *   - optimal: every Party Power is spent on a charged move -- possibly a different, harder-
 *              hitting one than the move used in between -- with no fast attacks wasted.
 *
 * @param opts {{ friendship?: number, partyPower?: 'off'|'casual'|'optimal', megaBoost?:
 *   {types: string[]}|null, groupDps?: number }}
 */
export function rateAttacker(gd, attacker, boss, ctx, phase, opts = {}) {
  const c = gd.constants;
  const boosted = boostedTypes(gd, ctx.weather);
  const inDps = incomingDps(gd, boss, attacker, ctx, phase, opts.groupDps ?? ctx.groupDps ?? 0);
  const eps = inDps * c.energyPerHpLost;
  const ttf = inDps > 0 ? attacker.hp / inDps : Infinity;
  const friendship = friendshipMult(opts.friendship);
  // 'idle' means in the party but not attacking, so it earns no Party Power of its own.
  const rawPp = opts.partyPower === true ? 'optimal' : opts.partyPower || 'off';
  // Your own fast attacks only: the meter is per player, and a bigger party lowers the threshold.
  // Party Power needs an actual party, so a lone trainer never gets it.
  const partySize = Math.min(4, ctx.partySize ?? 4);
  const ppAvailable = partySize >= 2;
  const N = Math.max(1, ctx.tuning[`partyPowerFastAttacks${partySize}`] ?? 9);
  const ppMode = rawPp === 'idle' || !ppAvailable ? 'off' : rawPp;
  const quality = playQuality(opts.playQuality);
  // Forgetting Party Power some of the time is worth less than doubling every time.
  const ppMult = 1 + (c.partyPowerChargedMultiplier - 1) * quality.ppReliability;
  // Hesitating before a charged move stretches every cycle it appears in.
  const hesitate = quality.chargedDelay;

  // Multiple megas don't stack: each attack gets the best boost any of them offers.
  const megaMult = (moveType) => {
    if (!opts.megaBoost) return 1;
    return opts.megaBoost.types.includes(moveType) ? c.megaAllySameType : c.megaAllyDifferentType;
  };

  const dmg = (move) => {
    const mults =
      (attacker.types.includes(move.type) ? c.stab : 1) *
      typeEffectiveness(gd.typeChart, move.type, boss.types) *
      (boosted.includes(move.type) ? c.weatherAttackBonus : 1) *
      friendship *
      megaMult(move.type);
    return hitDamage(move.power, attacker.atk, phase.def, mults);
  };

  // Pre-compute per-move numbers once.
  const fasts = attacker.fastMoves.filter((f) => f.energy > 0).map((f) => ({ move: f, D: dmg(f), T: sec(f.duration), E: f.energy }));
  const chargeds = attacker.chargedMoves.map((m) => ({ move: m, D: dmg(m), T: sec(m.duration), E: Math.abs(m.energy) }));

  /** Fast moves per charged move, floored at one tap between charged moves. */
  const fastPer = (f, ch) => {
    const n = (ch.E - eps * ch.T) / (f.E + eps * f.T);
    return !Number.isFinite(n) || n < 1 ? 1 : n;
  };

  /**
   * Optimal Party Power over one window of N fast attacks: one doubled `cp`, plus as many
   * plain `cw` as the leftover energy buys (at least one fast tap between charged moves).
   */
  const optimalWindow = (f, cw, cp) => {
    const surplus = N * f.E + eps * (N * f.T + cp.T) - cp.E;
    if (surplus <= 0) {
      // Can't even afford cp inside the window: every charged move is cp, and every one is
      // doubled. cw is never fired, so it must not be reported as part of the plan.
      const nf = Math.max(N, (cp.E - eps * cp.T) / (f.E + eps * f.T));
      return { dps: (nf * f.D + ppMult * cp.D) / (nf * f.T + cp.T + hesitate), usesCw: false };
    }
    const perCw = cw.E - eps * cw.T;
    const k = Math.min(N - 1, perCw > 0 ? surplus / perCw : N - 1);
    return {
      // One hesitation per charged move fired in the window: the boosted one plus k plain ones.
      dps: (N * f.D + ppMult * cp.D + k * cw.D) / (N * f.T + cp.T + k * cw.T + (1 + k) * hesitate),
      usesCw: k > 0.05,
    };
  };

  let best = null;
  // Best moveset if Party Power didn't exist -- the honest baseline for "what is PP worth",
  // and it may be a different moveset from the one Party Power favours.
  let bestPlain = null;
  for (const f of fasts) {
    for (const cw of chargeds) {
      const n = fastPer(f, cw);
      const cycleTime = n * f.T + cw.T + hesitate;
      const plain = (n * f.D + cw.D) / cycleTime;
      if (!bestPlain || plain > bestPlain.dps) bestPlain = { fast: f.move, charged: cw.move, dps: plain };

      let dps = plain;
      let charged = cw;
      let ppCharged = null;
      let ppEvery = null;

      if (ppMode !== 'off') {
        // Casual: the meter fills during the k-th cycle and boosts that cycle's charged move.
        const k = Math.max(1, Math.ceil(N / n - 1e-9));
        dps = (n * f.D + cw.D * (1 + (ppMult - 1) / k)) / cycleTime;
        ppCharged = cw;
        ppEvery = k;

        if (ppMode === 'optimal') {
          for (const cp of chargeds) {
            const w = optimalWindow(f, cw, cp);
            if (w.dps > dps + 1e-9) {
              dps = w.dps;
              ppCharged = cp;
              charged = w.usesCw ? cw : cp;
              ppEvery = w.usesCw ? null : 1;
            }
          }
        }
      }

      const cand = {
        fast: f.move,
        charged: charged.move,
        ppCharged: ppCharged?.move ?? null,
        ppEvery,
        dps,
        ttf,
        tdo: dps * ttf,
        inDps,
        fastPerCharged: n,
        playQuality: quality.id,
      };
      if (!best || cand.dps > best.dps) best = cand;
    }
  }

  if (!best) return { dps: 0, ttf, tdo: 0, inDps, fast: null, charged: null, ppCharged: null };
  best.withoutPartyPower = bestPlain;
  best.dpsWithoutPartyPower = bestPlain.dps;
  return best;
}

// ---------------------------------------------------------------- friendship

const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * A trainer's raid bonus is set by their *highest* friendship with anyone else in the raid --
 * bonuses from several friends don't stack.
 */
export function effectiveFriendship(friendships, accountId, presentIds) {
  let best = 0;
  for (const other of presentIds) {
    if (other === accountId) continue;
    best = Math.max(best, friendships?.[pairKey(accountId, other)] ?? 0);
  }
  return best;
}

export { pairKey as friendshipKey };

// ---------------------------------------------------------------- team selection

export const PLAYSTYLES = {
  /** Work through the whole battle party, switching as each Pokemon faints. */
  full: { id: 'full', label: 'Full team' },
  /** Lead with the best Pokemon, back out and max revive it, rejoin. */
  relobby: { id: 'relobby', label: 'Relobby + max revive' },
};

/**
 * Rates every roster entry against the boss. Entries that can mega evolve are rated twice
 * (base and mega) so team selection can decide which, if any, to mega evolve.
 *
 * Ranking metric: damage per second *of participation* -- total damage output over the
 * Pokemon's lifetime plus the downtime after it. Hard raids are nearly always limited by the
 * clock rather than by how many Pokemon you own.
 */
export function rankRoster(gd, roster, boss, ctx, accountCtx, downtime) {
  const phase = calmPhase(boss);
  const rated = [];
  roster.forEach((raw, rosterIndex) => {
    for (const attacker of attackerVariants(gd, raw)) {
      const r = rateForRanking(gd, attacker, boss, ctx, accountCtx, downtime, phase);
      if (r) rated.push({ rosterIndex, ...r });
    }
  });
  rated.sort((a, b) => b.score - a.score);
  return rated;
}

/**
 * The ways one roster entry can fight: its base form plus every mega form it has unlocked
 * (Raichu X and Y both count). Building is the slow part of rating, so callers that rate the
 * same Pokemon against many bosses build it once here.
 */
export function attackerVariants(gd, entry) {
  const species = gd.pokemon.find((p) => p.id === entry.pokemonId);
  const specs = [{ spec: entry, asMega: false }];
  for (const suffix of megaSuffixes(entry, species)) specs.push({ spec: { ...entry, mega: suffix }, asMega: true });
  const out = [];
  for (const { spec, asMega } of specs) {
    try {
      out.push(buildAttacker(gd, spec, { asMega }));
    } catch {
      // roster entry references data that no longer exists
    }
  }
  return out;
}

/** One built attacker, rated and scored the way rankRoster ranks it; null if it deals nothing. */
export function rateForRanking(gd, attacker, boss, ctx, accountCtx, downtime, phase = calmPhase(boss)) {
  // A mega rates itself with its own boost on the field.
  const r = rateAttacker(gd, attacker, boss, ctx, phase, {
    ...accountCtx,
    megaBoost: attacker.megaBoost ?? accountCtx.megaBoost ?? null,
  });
  if (!r.dps) return null;
  const lifetime = Number.isFinite(r.ttf) ? r.ttf : boss.timer;
  return {
    isMega: attacker.isMega,
    spec: { ...attacker.spec, mega: attacker.isMega ? attacker.spec.mega : '' },
    attacker,
    ...r,
    score: r.tdo / (lifetime + downtime),
  };
}

/**
 * Top `size` from a ranking: each roster Pokemon once, and at most one mega per trainer.
 *
 * `forceMega` pins which roster entry mega evolves -- used to answer "what if that mega is on
 * cooldown?". `noMega` builds the best team with no mega at all.
 */
export function pickTeam(rated, size = 6, { forceMega = null, noMega = false } = {}) {
  const used = new Set();
  let megaTaken = noMega;
  const team = [];

  if (forceMega !== null) {
    const pick = rated.find((r) => r.isMega && r.rosterIndex === forceMega);
    if (!pick) return [];
    team.push(pick);
    used.add(pick.rosterIndex);
    megaTaken = true;
  }

  for (const r of rated) {
    if (team.length >= size) break;
    if (used.has(r.rosterIndex)) continue;
    if (r.isMega && megaTaken) continue;
    used.add(r.rosterIndex);
    if (r.isMega) megaTaken = true;
    team.push(r);
  }
  return team.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- timeline

/**
 * Steps every account forward together against the boss.
 *
 * @param accounts array of {
 *   id, name, active, friendship (effective level), partyPower ('off'|'casual'|'optimal'),
 *   maxRevives (number|null = unlimited), team: rosterEntry[], playstyle: 'full'|'relobby',
 *   cycleSize: number
 * }
 */
export function simulate(gd, boss, accounts, ctx) {
  const t = ctx.tuning;
  const dt = t.dt;

  const state = accounts.map((a) => {
    const team = a.team
      .map((s) => {
        try {
          return buildAttacker(gd, s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const relobby = a.playstyle === 'relobby';
    return {
      account: a,
      team,
      idx: 0,
      hpLeft: team[0]?.hp ?? 0,
      downtime: 0,
      inRelobby: false,
      /** Can still attack. */
      out: team.length === 0,
      /** Still in the raid at all -- idle accounts stay even after their lead faints. */
      present: true,
      relobby,
      cycleSize: relobby ? Math.max(1, Math.min(a.cycleSize ?? 1, team.length)) : team.length,
      revivesLeft: a.maxRevives === null || a.maxRevives === undefined ? Infinity : a.maxRevives,
      damage: 0,
      relobbies: 0,
      faints: 0,
      lastDps: 0,
    };
  });

  // Everyone actively playing throws gems.
  const throwers = state.filter((st) => st.account.active && !st.out).length;
  const calmAfter = boss.isShadow ? gemCalmSeconds(ctx, throwers) : null;

  let bossHp = boss.hp;
  let time = 0;
  let enragedAt = null;
  let subduedAt = null;
  let enragedSeconds = 0;
  const trace = [];

  const calm = calmPhase(boss);
  const enraged = enragedPhase(boss, ctx);

  // The planner runs this many dozens of times over the same combatants, so the cache is
  // shared through ctx when one is provided.
  const rateCache = ctx._rateCache ?? new Map();
  const rateFor = (st, attacker, phase, megaBoost, groupDps) => {
    const s = attacker.spec;
    const key = [
      boss.key,
      st.account.friendship ?? 0,
      st.account.partyPower ?? 'off',
      st.account.playQuality ?? 'sharp',
      s.pokemonId,
      s.level,
      `${s.ivAtk}/${s.ivDef}/${s.ivSta}`,
      s.shadow ? 1 : 0,
      attacker.isMega ? `${s.mega}${s.megaLevel}` : '-',
      s.fastMove || '*',
      s.chargedMoves.join(',') || '*',
      phase.enraged ? 1 : 0,
      megaBoost ? megaBoost.types.join(',') : '-',
      groupDps,
    ].join('|');
    let v = rateCache.get(key);
    if (!v) {
      v = rateAttacker(gd, attacker, boss, ctx, phase, {
        friendship: st.account.friendship,
        partyPower: st.account.partyPower,
        playQuality: st.account.playQuality,
        megaBoost,
        groupDps,
      });
      rateCache.set(key, v);
    }
    return v;
  };

  // Seed the boss's energy estimate from the planner, then track the real group output.
  let groupDps = ctx.groupDps ?? 0;

  while (time < boss.timer && bossHp > 0) {
    const hpFrac = bossHp / boss.hp;

    // ---- shadow enrage / gems ----
    if (boss.isShadow && subduedAt === null) {
      if (enragedAt === null && hpFrac <= t.enrageStartHpFrac) enragedAt = time;
      if (enragedAt !== null) {
        if (hpFrac <= t.enrageEndHpFrac) subduedAt = time;
        else if (calmAfter !== null && time - enragedAt >= calmAfter) subduedAt = time;
      }
    }
    const isEnraged = enragedAt !== null && subduedAt === null;
    const phase = isEnraged ? enraged : calm;
    if (isEnraged) enragedSeconds += dt;

    // ---- mega boosts ----
    // A mega boosts while it is on the field. Mega Rayquaza (and the Primals) keep boosting
    // from the bench or after fainting, for as long as their trainer is still in the raid.
    const boostTypes = new Set();
    let anyMega = false;
    for (const st of state) {
      if (!st.present) continue;
      const cur = st.team[st.idx];
      if (!st.out && st.downtime <= 0 && cur?.megaBoost) {
        anyMega = true;
        cur.megaBoost.types.forEach((x) => boostTypes.add(x));
      }
      for (const m of st.team) {
        if (m.megaBoost?.persists) {
          anyMega = true;
          m.megaBoost.types.forEach((x) => boostTypes.add(x));
        }
      }
    }
    const megaBoost = anyMega ? { types: [...boostTypes].sort() } : null;

    // Bucket the group's output so the boss-energy term doesn't defeat the cache.
    const groupBucket = Math.round(groupDps / 10) * 10;
    let stepGroupDps = 0;

    for (const st of state) {
      if (st.out) continue;
      if (st.downtime > 0) {
        st.downtime -= dt;
        if (st.downtime <= 0 && st.inRelobby) {
          st.inRelobby = false;
          st.present = true;
        }
        continue;
      }
      const cur = st.team[st.idx];
      if (!cur) {
        st.out = true;
        continue;
      }

      const r = rateFor(st, cur, phase, megaBoost, groupBucket);

      // Idle accounts sit in the lobby: their Pokemon still gets attacked (so a mega's boost
      // ends when it faints) but it deals no damage.
      if (st.account.active) {
        const dealt = Math.min(r.dps * dt, bossHp);
        bossHp -= dealt;
        st.damage += dealt;
        stepGroupDps += r.dps;
      }

      st.hpLeft -= r.inDps * dt;
      if (st.hpLeft <= 0) {
        st.faints++;
        st.idx++;
        const endOfCycle = st.idx >= st.cycleSize;
        if (endOfCycle && st.relobby && st.revivesLeft >= st.cycleSize) {
          st.revivesLeft -= st.cycleSize;
          st.relobbies++;
          st.idx = 0;
          st.downtime = t.relobbyTime;
          st.inRelobby = true;
          st.present = false; // backed out of the raid
          st.hpLeft = st.team[0].hp;
        } else if (st.idx >= st.team.length) {
          st.out = true;
          // An attacker who runs out is kicked to the rejoin screen; an idle account never left.
          if (st.account.active) st.present = false;
        } else {
          st.downtime = t.faintDelay;
          st.hpLeft = st.team[st.idx].hp;
        }
      }

      if (bossHp <= 0) break;
    }

    groupDps = stepGroupDps;
    time += dt;
    if (trace.length < 4000) trace.push({ t: time, bossHp: Math.max(0, bossHp), enraged: isEnraged });

    // Nobody left who can deal damage.
    if (!state.some((st) => st.account.active && !st.out)) break;
  }

  const won = bossHp <= 0;
  return {
    won,
    timeToKill: won ? time : null,
    timeUsed: time,
    bossHpRemaining: Math.max(0, bossHp),
    bossHpFracRemaining: Math.max(0, bossHp) / boss.hp,
    /** Damage dealt as a fraction of boss HP. */
    damageRatio: (boss.hp - Math.max(0, bossHp)) / boss.hp,
    totalDamage: boss.hp - Math.max(0, bossHp),
    enragedSeconds,
    enragedAt,
    subduedAt,
    gemThrowers: throwers,
    gemCalmSeconds: calmAfter,
    accounts: state.map((st) => ({
      id: st.account.id,
      name: st.account.name,
      active: st.account.active,
      damage: Math.round(st.damage),
      share: st.damage / Math.max(1, boss.hp - Math.max(0, bossHp)),
      faints: st.faints,
      relobbies: st.relobbies,
      ranOut: st.out,
    })),
    trace,
  };
}

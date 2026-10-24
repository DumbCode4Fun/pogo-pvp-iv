/**
 * IV / level / CP maths for the PvP league calculator.
 *
 * A classic script (so index.html opens straight from disk) that also imports cleanly under Node
 * for the tests. Needs globalThis.PVP_DATA from data.js loaded first.
 */
(() => {
  const IV_MAX = 15;
  const LEAGUES = {
    great: { label: 'Great League', short: 'GL', cap: 1500 },
    ultra: { label: 'Ultra League', short: 'UL', cap: 2500 },
    master: { label: 'Master League', short: 'ML', cap: Infinity },
  };

  const levelCache = new Map();
  const tableCache = new Map();

  /** Ascending [{level, cpm}] from level 1 up to maxLevel in half-level steps. */
  function levelsUpTo(maxLevel) {
    if (!levelCache.has(maxLevel)) {
      const { cpm } = globalThis.PVP_DATA;
      const levels = [];
      for (let level = 1; level <= maxLevel; level += 0.5) levels.push({ level, cpm: cpm[level] });
      levelCache.set(maxLevel, levels);
    }
    return levelCache.get(maxLevel);
  }

  function cpFor(species, ivs, cpm) {
    const atk = species.atk + ivs.atk;
    const def = species.def + ivs.def;
    const sta = species.sta + ivs.sta;
    return Math.max(10, Math.floor((atk * Math.sqrt(def * sta) * cpm * cpm) / 10));
  }

  /**
   * Powers the spread up to the highest level that stays at or under the cap (or maxLevel if it
   * never reaches it). Shadow modifiers change displayed Atk/Def but not CP, and cancel out of the
   * stat product, so they never change a ranking.
   */
  function evaluate(species, ivs, cap, maxLevel, shadow = false) {
    const levels = levelsUpTo(maxLevel);
    let pick = levels[0];
    for (let i = levels.length - 1; i >= 0; i--) {
      if (cpFor(species, ivs, levels[i].cpm) <= cap) {
        pick = levels[i];
        break;
      }
    }
    const { cpm } = pick;
    const mod = shadow ? globalThis.PVP_DATA.shadow : { atk: 1, def: 1 };
    const atk = (species.atk + ivs.atk) * cpm * mod.atk;
    const def = (species.def + ivs.def) * cpm * mod.def;
    const hp = Math.max(10, Math.floor((species.sta + ivs.sta) * cpm));
    return { ivs, level: pick.level, cp: cpFor(species, ivs, cpm), atk, def, hp, product: atk * def * hp };
  }

  /**
   * Every one of the 4096 IV spreads for a species in a league, best stat product first, each with
   * its rank (ties share a rank) and its percentage of the best product. `at(ivs)` looks one up.
   */
  function rankTable(species, leagueKey, maxLevel, shadow = false) {
    const key = `${species.id}|${leagueKey}|${maxLevel}|${shadow}`;
    if (tableCache.has(key)) return tableCache.get(key);

    const cap = LEAGUES[leagueKey].cap;
    const entries = [];
    for (let atk = 0; atk <= IV_MAX; atk++)
      for (let def = 0; def <= IV_MAX; def++)
        for (let sta = 0; sta <= IV_MAX; sta++)
          entries.push(evaluate(species, { atk, def, sta }, cap, maxLevel, shadow));

    entries.sort((a, b) => b.product - a.product);
    const best = entries[0].product;
    const byIvs = new Map();
    entries.forEach((entry, i) => {
      entry.rank = i > 0 && entry.product === entries[i - 1].product ? entries[i - 1].rank : i + 1;
      entry.percent = (entry.product / best) * 100;
      byIvs.set(entry.ivs.atk * 256 + entry.ivs.def * 16 + entry.ivs.sta, entry);
    });

    const table = { entries, at: (ivs) => byIvs.get(ivs.atk * 256 + ivs.def * 16 + ivs.sta) };
    if (tableCache.size >= 24) tableCache.clear();
    tableCache.set(key, table);
    return table;
  }

  /** "0/15/14" (or with commas, dashes or spaces) to {atk, def, sta}; null if it isn't three IVs of 0-15. */
  function parseSpread(text) {
    const m = /^\s*(\d{1,2})\s*[/,\s-]\s*(\d{1,2})\s*[/,\s-]\s*(\d{1,2})\s*$/.exec(text);
    if (!m) return null;
    const [atk, def, sta] = m.slice(1).map(Number);
    return Math.max(atk, def, sta) <= IV_MAX ? { atk, def, sta } : null;
  }

  globalThis.PvpCalc = { IV_MAX, LEAGUES, levelsUpTo, cpFor, evaluate, rankTable, parseSpread };
})();

(() => {
  const { IV_MAX, LEAGUES, capFromCp, rankTable, evolutionLine, evolutionRoot, parseSpread } = PvpCalc;
  const SPECIES = PVP_DATA.species;

  // v1 held one spread list for the whole app; v2 files spreads under each evolution family.
  const STORE_KEY = 'pvp-iv-calc.v2';
  const OLD_STORE_KEY = 'pvp-iv-calc.v1';
  const MAX_SPREADS = 100; // per evolution family
  const TOP_SIZES = [10, 20, 50, 100];
  const MAX_LEVELS = [40, 50, 51];

  const $ = (id) => document.getElementById(id);
  const speciesLabel = (s) => `${s.name} #${s.dex}`;
  const byLabel = new Map(SPECIES.map((s) => [speciesLabel(s).toLowerCase(), s]));
  const byId = new Map(SPECIES.map((s) => [s.id, s]));
  // PvPoke's league rankings, one map per league keyed "ID|isShadow" in rank order.
  const RANKS = Object.fromEntries(
    Object.entries(PVP_DATA.rankings).map(([league, rows]) => [
      league,
      new Map(rows.map(([id, shadow, rank, score, ...moves]) => [`${id}|${shadow}`, { id, shadow: Boolean(shadow), rank, score, moves }])),
    ]),
  );
  const metaRank = (id, formatKey, shadow = state.shadow) => RANKS[formatKey]?.get(`${id}|${shadow ? 1 : 0}`);
  const CUPS = new Map(PVP_DATA.cups.map((c) => [c.key, c]));
  const RANK_PAGE = 50;

  const HUNDO = { atk: IV_MAX, def: IV_MAX, sta: IV_MAX };
  /** Spread labels run A..Z, then AA, AB, ... like spreadsheet columns. */
  const letter = (i) => (i < 26 ? '' : letter(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));
  const ivText = (ivs) => `${ivs.atk}/${ivs.def}/${ivs.sta}`;
  const clampIv = (n) => Math.min(IV_MAX, Math.max(0, n));
  const fixed = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------------------------------------------------------------- state

  const DEFAULTS = {
    speciesId: 'AZUMARILL',
    lineFrom: 'AZUMARILL',
    league: 'great',
    cup: null,
    maxLevel: 50,
    shadow: false,
    topSize: 20,
    tab: 'calc',
    rankShadow: true,
  };
  // Shown only on the very first visit, so the page isn't empty while you look around.
  const EXAMPLE_SPREADS = [
    { atk: 0, def: 15, sta: 14 },
    { atk: 15, def: 15, sta: 15 },
  ];

  const cleanSpreads = (list) =>
    Array.isArray(list)
      ? list
          .filter((s) => ['atk', 'def', 'sta'].every((k) => Number.isInteger(s?.[k]) && s[k] >= 0 && s[k] <= IV_MAX))
          .slice(0, MAX_SPREADS)
          .map(({ atk, def, sta }) => ({ atk, def, sta }))
      : [];

  function readStore() {
    const raw = localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function load() {
    try {
      const stored = readStore();
      const saved = stored ?? {};
      const speciesId = byId.has(saved.speciesId) ? saved.speciesId : DEFAULTS.speciesId;
      // The evolution chips start from whatever was picked; keep that only if it still leads to the species.
      const lineFrom = byId.has(saved.lineFrom) && evolutionLine(saved.lineFrom).includes(speciesId) ? saved.lineFrom : speciesId;

      // Spreads are filed under the family's first stage. A v1 save had a single list: it moves under the
      // species it was last used with, and a first-ever visit gets the examples.
      const spreadsByFamily = {};
      for (const [root, list] of Object.entries(saved.spreadsByFamily ?? {})) {
        if (byId.has(root)) spreadsByFamily[root] = cleanSpreads(list);
      }
      if (!stored) spreadsByFamily[evolutionRoot(speciesId)] = structuredClone(EXAMPLE_SPREADS);
      else if (Array.isArray(saved.spreads)) spreadsByFamily[evolutionRoot(speciesId)] ??= cleanSpreads(saved.spreads);

      return {
        speciesId,
        lineFrom,
        league: saved.league in LEAGUES ? saved.league : DEFAULTS.league,
        // Cups rotate, so a saved one may have been dropped from the data since.
        cup: CUPS.has(saved.cup) ? saved.cup : null,
        maxLevel: MAX_LEVELS.includes(saved.maxLevel) ? saved.maxLevel : DEFAULTS.maxLevel,
        shadow: saved.shadow === true,
        topSize: TOP_SIZES.includes(saved.topSize) ? saved.topSize : DEFAULTS.topSize,
        tab: saved.tab === 'rankings' ? 'rankings' : DEFAULTS.tab,
        rankShadow: saved.rankShadow !== false,
        spreadsByFamily,
      };
    } catch {
      return { ...DEFAULTS, spreadsByFamily: { [evolutionRoot(DEFAULTS.speciesId)]: structuredClone(EXAMPLE_SPREADS) } };
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* private window or blocked storage: the app still works, it just forgets */
    }
  }

  const state = load();

  const species = () => byId.get(state.speciesId);
  const familyRoot = () => evolutionRoot(state.speciesId);
  /** The current family's saved spreads. Edits go straight into this array, so they persist with the next save. */
  const spreads = () => (state.spreadsByFamily[familyRoot()] ??= []);
  /** What is being played: a cup (its own CP cap and rules) or one of the three standard leagues. */
  function format() {
    const cup = CUPS.get(state.cup);
    if (cup) return { key: cup.key, label: cup.title, cap: capFromCp(cup.cp), rules: cup.rules, cup };
    const l = LEAGUES[state.league];
    return { key: state.league, label: l.label, cap: l.cap, rules: [], cup: null };
  }
  const capText = (cap) => (Number.isFinite(cap) ? `CP ≤ ${cap}` : 'no CP limit');
  const table = (cap = format().cap) => rankTable(species(), cap, state.maxLevel, state.shadow);

  function selectFormat(key) {
    if (CUPS.has(key)) state.cup = key;
    else if (key in LEAGUES) {
      state.cup = null;
      state.league = key;
    } else return;
    rankShown = RANK_PAGE;
    update();
  }

  // ---------------------------------------------------------------- controls

  function renderStaticControls() {
    $('species-list').innerHTML = SPECIES.map((s) => `<option value="${esc(speciesLabel(s))}"></option>`).join('');
    const leagueButtons = Object.entries(LEAGUES)
      .map(([key, l]) => `<button type="button" data-format="${key}">${l.label.replace(' League', '')}</button>`)
      .join('');
    $('league-buttons').innerHTML = leagueButtons;
    $('rank-league-buttons').innerHTML = leagueButtons;
    const cupOptions =
      `<option value="">No cup (standard league)</option>` +
      [...CUPS.values()].map((c) => `<option value="${esc(c.key)}">${esc(c.title)} (${capText(capFromCp(c.cp))})</option>`).join('');
    $('cup-select').innerHTML = cupOptions;
    $('rank-cup-select').innerHTML = cupOptions;
    $('top-size').innerHTML = TOP_SIZES.map((n) => `<button type="button" data-top="${n}">${n}</button>`).join('');
  }

  function syncControls() {
    const s = species();
    $('species-info').textContent = `Base stats: Atk ${s.atk} · Def ${s.def} · HP ${s.sta}`;
    const { key } = format();
    for (const b of document.querySelectorAll('.seg [data-format]')) b.setAttribute('aria-pressed', String(b.dataset.format === key));
    $('cup-select').value = state.cup ?? '';
    $('rank-cup-select').value = state.cup ?? '';
    $('level-select').value = String(state.maxLevel);
    $('shadow-check').checked = state.shadow;
    $('rank-shadow-check').checked = state.rankShadow;
  }

  // Where this Pokémon sits in PvPoke's ranking for each league (plus the selected cup), with the
  // format being viewed highlighted.
  function renderMetaRank() {
    const f = format();
    const shown = [
      ...Object.entries(LEAGUES).map(([key, l]) => ({ key, label: l.label.replace(' League', '') })),
      ...(f.cup ? [{ key: f.key, label: f.label }] : []),
    ];
    const pills = shown
      .map(({ key, label }) => {
        const r = metaRank(state.speciesId, key);
        return `<button type="button" class="rank-pill" data-format="${esc(key)}" aria-pressed="${key === f.key}"><strong>${esc(label)}</strong><span class="sub">${r ? `#${r.rank} · score ${r.score}` : 'Not ranked'}</span></button>`;
      })
      .join('');
    const here = metaRank(state.speciesId, f.key);
    const notes = [
      here
        ? `Top moveset in ${f.label}: ${here.moves.join(' · ')}. Rated by PvPoke's simulations; your IVs aren't factored in.`
        : `${species().name}${state.shadow ? ' (Shadow)' : ''} isn't in PvPoke's ${f.label} ranking.`,
    ];
    if (f.rules.length) notes.push(`${f.label} rules: ${f.rules.join(' ')} The calculator doesn't check that your Pokémon is eligible.`);
    $('meta-rank').innerHTML = `<span class="label">League ranking${state.shadow ? ' (Shadow)' : ''}</span>${pills}${notes.map((n) => `<p class="muted moves">${esc(n)}</p>`).join('')}`;
  }

  // ---------------------------------------------------------------- rankings tab

  let rankShown = RANK_PAGE;

  function renderRankings() {
    const f = format();
    $('rank-sub').textContent = `${f.cup ? f.label : ''}${f.cup ? ' · ' : ''}${capText(f.cap)}`;
    $('rank-rules').textContent = f.rules.join(' ');
    const query = $('rank-search').value.trim().toLowerCase();
    const rows = [...RANKS[f.key].values()].filter(
      (r) => (state.rankShadow || !r.shadow) && byId.get(r.id).name.toLowerCase().includes(query),
    );
    const html = rows
      .slice(0, rankShown)
      .map(
        (r) => `<tr><td>#${r.rank}</td><td class="left"><strong>${esc(byId.get(r.id).name)}</strong>${r.shadow ? ' <span class="muted">Shadow</span>' : ''}</td><td>${r.score}</td><td class="left moves">${esc(r.moves.join(' · '))}</td><td><button type="button" data-open="${r.id}" data-shadow="${r.shadow ? 1 : 0}">Open</button></td></tr>`,
      )
      .join('');
    $('rankings-table').innerHTML = rows.length
      ? `<table><thead><tr><th>Rank</th><th class="left">Pokémon</th><th>Score</th><th class="left">Moves</th><th></th></tr></thead><tbody>${html}</tbody></table>`
      : `<p class="muted">No ranked Pokémon match "${esc(query)}".</p>`;
    $('rankings-more').hidden = rankShown >= rows.length;
  }

  function setTab(tab) {
    state.tab = tab;
    $('tab-calc').hidden = tab !== 'calc';
    $('tab-rankings').hidden = tab !== 'rankings';
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    update();
  }

  /** Jump from a rankings row to the calculator for that Pokémon (Shadow rows turn the Shadow toggle on). */
  function openSpecies(id, shadow) {
    state.speciesId = id;
    state.lineFrom = id;
    state.shadow = shadow;
    $('species-input').value = speciesLabel(species());
    renderEditor();
    setTab('calc');
    window.scrollTo(0, 0);
  }

  // A Pokémon keeps its IVs through evolution, so a pre-evolution can be evaluated as any later stage.
  // Each chip shows how that stage fits the chosen league; stages that can't fill it are dimmed.
  const FILL_RATIO = 0.98;

  function renderEvoLine() {
    const f = format();
    // Mega forms are only offered in Mega cups (or when already selected), so other lines aren't cluttered.
    const megaOk = f.cup && /mega/.test(f.key);
    const line = evolutionLine(state.lineFrom).filter((id) => megaOk || !byId.get(id).mega || id === state.speciesId);
    $('evo-line').hidden = line.length < 2;
    if (line.length < 2) {
      $('evo-line').innerHTML = '';
      return;
    }

    const cap = f.cap;
    $('evo-line').innerHTML =
      `<span class="label">Evaluate as</span>` +
      line
        .map((id) => {
          const t = rankTable(byId.get(id), cap, state.maxLevel, state.shadow);
          const best = t.entries[0];
          // "Can't fill the league" means even the strongest possible spread is still under the cap at max level.
          const hundo = t.at(HUNDO);
          const under = Number.isFinite(cap) && hundo.level === state.maxLevel && hundo.cp < cap * FILL_RATIO;
          const detail = under ? `Tops out at CP ${hundo.cp}` : `Best: L${best.level} · CP ${best.cp}`;
          const meta = metaRank(id, f.key);
          const title = under ? `Even a 15/15/15 at level ${state.maxLevel} stays well under ${cap} CP, so it can't fill this format.` : '';
          return `<button type="button" class="evo${under ? ' under' : ''}" data-evo="${id}" aria-pressed="${id === state.speciesId}" title="${title}"><strong>${esc(byId.get(id).name)}</strong><span class="sub">${detail}</span><span class="sub">${meta ? `Ranked #${meta.rank}` : 'Not ranked'}</span></button>`;
        })
        .join('');
  }

  function resolveSpecies(text) {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    if (byLabel.has(q)) return byLabel.get(q);
    if (/^\d+$/.test(q)) return SPECIES.find((s) => s.dex === Number(q)) ?? null;
    return SPECIES.find((s) => s.name.toLowerCase() === q) ?? null;
  }

  function pickSpecies(text, { commit }) {
    const found = resolveSpecies(text);
    if (found && found.id !== state.speciesId) {
      state.speciesId = found.id;
      state.lineFrom = found.id;
      renderEditor(); // a different family has its own saved spreads
      update();
    }
    // Leaving the field with something that isn't a Pokémon snaps back to the current one.
    if (commit) $('species-input').value = speciesLabel(found ?? species());
  }

  // ---------------------------------------------------------------- spread editor

  function renderEditor() {
    const list = spreads();
    const root = byId.get(familyRoot());
    $('spreads-sub').textContent = `saved for ${root.id === state.speciesId ? root.name : `the ${root.name} family`}`;
    $('spread-editor').innerHTML = list.length
      ? ''
      : `<p class="muted">No IVs saved for this Pokémon yet. Add yours below; they're kept for every stage of its evolution line.</p>`;
    $('spread-editor').innerHTML += list
      .map(
        (ivs, i) => `<div class="spread-row">
          <span class="tag">${letter(i)}</span>
          ${[
            ['atk', 'Atk'],
            ['def', 'Def'],
            ['sta', 'HP'],
          ]
            .map(
              ([k, name]) =>
                `<label>${name} <input type="number" inputmode="numeric" min="0" max="${IV_MAX}" step="1" data-i="${i}" data-k="${k}" value="${ivs[k]}" aria-label="${name} IV, spread ${letter(i)}"></label>`,
            )
            .join('')}
          <button type="button" class="remove" data-remove="${i}" aria-label="Remove spread ${letter(i)}">✕</button>
        </div>`,
      )
      .join('');
    $('quick-add').querySelector('button').disabled = list.length >= MAX_SPREADS;
  }

  function addSpread(ivs) {
    if (spreads().length >= MAX_SPREADS) return false;
    spreads().push({ ...ivs });
    renderEditor();
    update();
    return true;
  }

  // ---------------------------------------------------------------- results

  const entryCells = (e, base, win = {}) => {
    const delta = (v, ref) => {
      if (!base) return '';
      const d = (v / ref - 1) * 100;
      return Math.abs(d) < 0.05 ? '' : `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d.toFixed(1)}%</span>`;
    };
    return `<td>${e.level}</td>
      <td>${e.cp}</td>
      <td class="${win.atk ? 'win' : ''}">${fixed(e.atk)}${delta(e.atk, base?.atk)}</td>
      <td class="${win.def ? 'win' : ''}">${fixed(e.def)}${delta(e.def, base?.def)}</td>
      <td class="${win.hp ? 'win' : ''}">${e.hp}${delta(e.hp, base?.hp)}</td>
      <td class="${win.product ? 'win' : ''}">${fixed(e.product / 1000)}${delta(e.product, base?.product)}</td>
      <td>${e.percent.toFixed(1)}%</td>
      <td>#${e.rank}</td>`;
  };

  // Click a heading to sort your spreads by it; click again to flip. The Rank 1 row stays pinned last.
  const COMPARE_COLUMNS = [
    { key: 'spread', label: 'Spread', ascFirst: true },
    { label: 'IVs', left: true },
    { key: 'level', label: 'Level' },
    { key: 'cp', label: 'CP' },
    { key: 'atk', label: 'Atk' },
    { key: 'def', label: 'Def' },
    { key: 'hp', label: 'HP' },
    { key: 'product', label: 'Stat product (k)' },
    { key: 'percent', label: '% of best' },
    { key: 'rank', label: 'Rank', ascFirst: true },
  ];
  const compareSort = { key: 'spread', dir: 1 };
  const leaguesSort = { key: 'spread', dir: 1 };

  function sortHeading(sort, { key, label, ascFirst }) {
    const active = sort.key === key;
    const arrow = active ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
    const aria = active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
    return `<th aria-sort="${aria}"><button type="button" class="sort" data-sort="${key}" data-asc-first="${Boolean(ascFirst)}">${label}${arrow}</button></th>`;
  }

  /** Applies a click on a sortable heading to `sort`: same column flips, a new one starts in its natural direction. */
  function applySort(sort, button) {
    const key = button.dataset.sort;
    sort.dir = sort.key === key ? -sort.dir : button.dataset.ascFirst === 'true' ? 1 : -1;
    sort.key = key;
  }

  function renderCompare() {
    const t = table();
    const league = format();
    const entries = spreads().map((ivs) => t.at(ivs));
    const best = t.entries[0];

    // With two or more spreads, flag the best value in each stat column among *your* spreads.
    const winners = (key) => {
      const top = Math.max(...entries.map((e) => e[key]));
      return entries.length > 1 ? entries.map((e) => e[key] === top) : entries.map(() => false);
    };
    const wins = Object.fromEntries(['atk', 'def', 'hp', 'product'].map((k) => [k, winners(k)]));

    // Sorting only reorders the rows; letters and the "vs A" deltas stay tied to entry order.
    const sortValue = (i) => (compareSort.key === 'spread' ? i : entries[i][compareSort.key]);
    const order = entries
      .map((_, i) => i)
      .sort((a, b) => (sortValue(a) - sortValue(b)) * compareSort.dir || a - b);

    const rows = order.map(
      (i) => `<tr><td><strong>${letter(i)}</strong></td><td class="left">${ivText(entries[i].ivs)}</td>${entryCells(
        entries[i],
        i > 0 ? entries[0] : null,
        { atk: wins.atk[i], def: wins.def[i], hp: wins.hp[i], product: wins.product[i] },
      )}</tr>`,
    );
    rows.push(
      `<tr class="best-row"><td><strong>Rank 1</strong></td><td class="left">${ivText(best.ivs)}</td>${entryCells(best, entries[0])}</tr>`,
    );

    $('compare-table').innerHTML = `<table>
      <thead><tr>${COMPARE_COLUMNS.map((c) => (c.key ? sortHeading(compareSort, c) : `<th class="left">${c.label}</th>`)).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;

    const cap = Number.isFinite(league.cap) ? ` (CP ≤ ${league.cap})` : '';
    $('compare-sub').textContent = `${species().name}${state.shadow ? ' (Shadow)' : ''} · ${league.label}${cap} · max level ${state.maxLevel}`;

    const notes = [
      entries.length
        ? `Rank is out of 4,096 spreads; green/red percentages are relative to spread A.`
        : `Add your IVs above to see how they compare with the best spread.`,
    ];
    if (!Number.isFinite(league.cap)) {
      notes.push(`Everything is powered to level ${state.maxLevel}, so 15/15/15 is always rank 1 here — the IVs only decide how close the rest get.`);
    } else if (t.at(HUNDO).level === state.maxLevel) {
      notes.push(`Even the best spread stays under ${league.cap} CP at level ${state.maxLevel}, so every spread sits at max level and the hundo ranks first.`);
    }
    if (state.shadow) notes.push('Shadow adjusts displayed Atk/Def (×1.2 / ×0.833) but leaves CP and the ranking unchanged.');
    $('compare-note').textContent = notes.join(' ');
  }

  function renderLeagues() {
    const keys = Object.keys(LEAGUES);
    const tables = keys.map((k) => table(LEAGUES[k].cap));
    const cell = (e) =>
      `<td><span class="pct">${e.percent.toFixed(1)}%</span> <strong>#${e.rank}</strong><span class="sub">L${e.level} · CP ${e.cp}</span></td>`;

    // Sort by spread order or by the rank in one league (best rank first on the first click).
    const mine = spreads();
    const sortValue = (i) => (leaguesSort.key === 'spread' ? i : tables[keys.indexOf(leaguesSort.key)].at(mine[i]).rank);
    const order = mine
      .map((_, i) => i)
      .sort((a, b) => (sortValue(a) - sortValue(b)) * leaguesSort.dir || a - b);

    const rows = order.map(
      (i) => `<tr><td><strong>${letter(i)}</strong></td><td class="left">${ivText(mine[i])}</td>${tables.map((t) => cell(t.at(mine[i]))).join('')}</tr>`,
    );
    rows.push(
      `<tr class="best-row"><td><strong>Rank 1</strong></td><td class="left">—</td>${tables
        .map((t) => `<td><strong>${ivText(t.entries[0].ivs)}</strong><span class="sub">L${t.entries[0].level} · CP ${t.entries[0].cp}</span></td>`)
        .join('')}</tr>`,
    );
    $('leagues-table').innerHTML = `<table>
      <thead><tr>${sortHeading(leaguesSort, { key: 'spread', label: 'Spread', ascFirst: true })}<th class="left">IVs</th>${keys
        .map((k) => sortHeading(leaguesSort, { key: k, label: LEAGUES[k].label, ascFirst: true }))
        .join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  }

  function renderTop() {
    const t = table();
    const shown = t.entries.slice(0, state.topSize);
    const mine = spreads();
    const has = (ivs) => mine.findIndex((s) => s.atk === ivs.atk && s.def === ivs.def && s.sta === ivs.sta);
    const full = mine.length >= MAX_SPREADS;

    const rows = shown.map((e) => {
      const owned = has(e.ivs);
      const action =
        owned >= 0
          ? `<span class="muted">in yours (${letter(owned)})</span>`
          : `<button type="button" data-add="${ivText(e.ivs)}" ${full ? 'disabled' : ''}>Add to mine</button>`;
      return `<tr><td>#${e.rank}</td><td class="left">${ivText(e.ivs)}</td><td>${e.level}</td><td>${e.cp}</td><td>${fixed(e.atk)}</td><td>${fixed(e.def)}</td><td>${e.hp}</td><td>${fixed(e.product / 1000)}</td><td>${e.percent.toFixed(1)}%</td><td>${action}</td></tr>`;
    });
    $('top-table').innerHTML = `<table>
      <thead><tr><th>Rank</th><th class="left">IVs</th><th>Level</th><th>CP</th><th>Atk</th><th>Def</th><th>HP</th><th>Stat product (k)</th><th>% of best</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
    $('top-sub').textContent = `for ${species().name} in ${format().label}`;
    for (const b of $('top-size').children) b.setAttribute('aria-pressed', String(Number(b.dataset.top) === state.topSize));
  }

  function update() {
    syncControls();
    renderMetaRank();
    renderEvoLine();
    renderCompare();
    renderLeagues();
    renderTop();
    if (state.tab === 'rankings') renderRankings();
    save();
  }

  // ---------------------------------------------------------------- wiring

  $('species-input').addEventListener('input', (e) => pickSpecies(e.target.value, { commit: false }));
  $('species-input').addEventListener('change', (e) => pickSpecies(e.target.value, { commit: true }));
  $('species-input').addEventListener('focus', (e) => e.target.select());

  $('evo-line').addEventListener('click', (e) => {
    const id = e.target.closest('[data-evo]')?.dataset.evo;
    if (!id || id === state.speciesId) return;
    state.speciesId = id;
    $('species-input').value = speciesLabel(species());
    renderEditor(); // same family, same spreads; this just refreshes the "saved for" label
    update();
    $('evo-line').querySelector(`[data-evo="${id}"]`)?.focus(); // re-rendering dropped focus
  });

  // League buttons live in both tabs, and the ranking pills under the Pokémon field select a format too.
  document.addEventListener('click', (e) => {
    const key = e.target.closest('[data-format]')?.dataset.format;
    if (key && key !== format().key) selectFormat(key);
  });
  for (const id of ['cup-select', 'rank-cup-select']) {
    // "No cup" goes back to the standard league that was last selected.
    $(id).addEventListener('change', (e) => selectFormat(e.target.value || state.league));
  }

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (tab && tab !== state.tab) setTab(tab);
  });
  $('rank-search').addEventListener('input', () => {
    rankShown = RANK_PAGE;
    renderRankings();
  });
  $('rank-shadow-check').addEventListener('change', (e) => {
    state.rankShadow = e.target.checked;
    rankShown = RANK_PAGE;
    update();
  });
  $('rankings-more').addEventListener('click', () => {
    rankShown += RANK_PAGE;
    renderRankings();
  });
  $('rankings-table').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) openSpecies(open.dataset.open, open.dataset.shadow === '1');
  });
  $('level-select').addEventListener('change', (e) => {
    state.maxLevel = Number(e.target.value);
    update();
  });
  $('shadow-check').addEventListener('change', (e) => {
    state.shadow = e.target.checked;
    update();
  });

  $('spread-editor').addEventListener('input', (e) => {
    const { i, k } = e.target.dataset;
    const n = parseInt(e.target.value, 10);
    if (k === undefined || Number.isNaN(n)) return;
    spreads()[i][k] = clampIv(n);
    update();
  });
  // Tidy up whatever was typed (empty, out of range) once the field is left.
  $('spread-editor').addEventListener('change', (e) => {
    const { i, k } = e.target.dataset;
    if (k !== undefined) e.target.value = spreads()[i][k];
  });
  $('spread-editor').addEventListener('click', (e) => {
    const i = e.target.closest('[data-remove]')?.dataset.remove;
    if (i === undefined) return;
    spreads().splice(Number(i), 1);
    renderEditor();
    update();
  });

  $('quick-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('quick-add-input');
    const ivs = parseSpread(input.value);
    const added = ivs && addSpread(ivs);
    $('quick-add-error').textContent = !ivs
      ? 'Enter three IVs from 0 to 15, like 0/15/14.'
      : added
        ? ''
        : `That's the limit of ${MAX_SPREADS} spreads for this Pokémon. Remove one to add another.`;
    if (added) input.value = '';
  });

  $('compare-table').addEventListener('click', (e) => {
    const button = e.target.closest('[data-sort]');
    if (!button) return;
    applySort(compareSort, button);
    renderCompare();
  });
  $('leagues-table').addEventListener('click', (e) => {
    const button = e.target.closest('[data-sort]');
    if (!button) return;
    applySort(leaguesSort, button);
    renderLeagues();
  });

  $('top-table').addEventListener('click', (e) => {
    const text = e.target.closest('[data-add]')?.dataset.add;
    const ivs = text && parseSpread(text);
    if (ivs) addSpread(ivs);
  });
  $('top-size').addEventListener('click', (e) => {
    const size = Number(e.target.closest('[data-top]')?.dataset.top);
    if (!TOP_SIZES.includes(size) || size === state.topSize) return;
    state.topSize = size;
    update();
  });

  renderStaticControls();
  $('species-input').value = speciesLabel(species());
  renderEditor();
  setTab(state.tab);
})();

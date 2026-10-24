(() => {
  const { IV_MAX, LEAGUES, rankTable, parseSpread } = PvpCalc;
  const SPECIES = PVP_DATA.species;

  const STORE_KEY = 'pvp-iv-calc.v1';
  const MAX_SPREADS = 8;
  const TOP_STEP = 20;
  const TOP_LIMIT = 200;
  const MAX_LEVELS = [40, 50, 51];

  const $ = (id) => document.getElementById(id);
  const speciesLabel = (s) => `${s.name} #${s.dex}`;
  const byLabel = new Map(SPECIES.map((s) => [speciesLabel(s).toLowerCase(), s]));
  const byId = new Map(SPECIES.map((s) => [s.id, s]));
  const letter = (i) => String.fromCharCode(65 + i);
  const ivText = (ivs) => `${ivs.atk}/${ivs.def}/${ivs.sta}`;
  const clampIv = (n) => Math.min(IV_MAX, Math.max(0, n));
  const fixed = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---------------------------------------------------------------- state

  const DEFAULTS = {
    speciesId: 'AZUMARILL',
    league: 'great',
    maxLevel: 50,
    shadow: false,
    spreads: [
      { atk: 0, def: 15, sta: 14 },
      { atk: 15, def: 15, sta: 15 },
    ],
  };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
      const spreads = Array.isArray(saved.spreads)
        ? saved.spreads
            .filter((s) => ['atk', 'def', 'sta'].every((k) => Number.isInteger(s?.[k]) && s[k] >= 0 && s[k] <= IV_MAX))
            .slice(0, MAX_SPREADS)
            .map(({ atk, def, sta }) => ({ atk, def, sta }))
        : [];
      return {
        speciesId: byId.has(saved.speciesId) ? saved.speciesId : DEFAULTS.speciesId,
        league: saved.league in LEAGUES ? saved.league : DEFAULTS.league,
        maxLevel: MAX_LEVELS.includes(saved.maxLevel) ? saved.maxLevel : DEFAULTS.maxLevel,
        shadow: saved.shadow === true,
        spreads: spreads.length ? spreads : structuredClone(DEFAULTS.spreads),
      };
    } catch {
      return structuredClone(DEFAULTS);
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
  let topCount = TOP_STEP;

  const species = () => byId.get(state.speciesId);
  const table = (league = state.league) => rankTable(species(), league, state.maxLevel, state.shadow);

  // ---------------------------------------------------------------- controls

  function renderStaticControls() {
    $('species-list').innerHTML = SPECIES.map((s) => `<option value="${esc(speciesLabel(s))}"></option>`).join('');
    $('league-buttons').innerHTML = Object.entries(LEAGUES)
      .map(([key, l]) => `<button type="button" data-league="${key}">${l.label.replace(' League', '')}</button>`)
      .join('');
  }

  function syncControls() {
    const s = species();
    $('species-info').textContent = `Base stats: Atk ${s.atk} · Def ${s.def} · HP ${s.sta}`;
    for (const b of $('league-buttons').children) b.setAttribute('aria-pressed', String(b.dataset.league === state.league));
    $('level-select').value = String(state.maxLevel);
    $('shadow-check').checked = state.shadow;
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
      topCount = TOP_STEP;
      update();
    }
    // Leaving the field with something that isn't a Pokémon snaps back to the current one.
    if (commit) $('species-input').value = speciesLabel(found ?? species());
  }

  // ---------------------------------------------------------------- spread editor

  function renderEditor() {
    $('spread-editor').innerHTML = state.spreads
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
          <button type="button" class="remove" data-remove="${i}" aria-label="Remove spread ${letter(i)}" ${state.spreads.length === 1 ? 'disabled' : ''}>✕</button>
        </div>`,
      )
      .join('');
    $('quick-add').querySelector('button').disabled = state.spreads.length >= MAX_SPREADS;
  }

  function addSpread(ivs) {
    if (state.spreads.length >= MAX_SPREADS) return false;
    state.spreads.push({ ...ivs });
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
    const league = LEAGUES[state.league];
    const entries = state.spreads.map((ivs) => t.at(ivs));
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

    const notes = [`Rank is out of 4,096 spreads; green/red percentages are relative to spread A.`];
    if (!Number.isFinite(league.cap)) {
      notes.push(`Everything is powered to level ${state.maxLevel}, so 15/15/15 is always rank 1 here — the IVs only decide how close the rest get.`);
    } else if (best.level === state.maxLevel) {
      notes.push(`Even the best spread stays under ${league.cap} CP at level ${state.maxLevel}, so every spread sits at max level and the hundo ranks first.`);
    }
    if (state.shadow) notes.push('Shadow adjusts displayed Atk/Def (×1.2 / ×0.833) but leaves CP and the ranking unchanged.');
    $('compare-note').textContent = notes.join(' ');
  }

  function renderLeagues() {
    const keys = Object.keys(LEAGUES);
    const tables = keys.map((k) => table(k));
    const cell = (e) =>
      `<td><span class="pct">${e.percent.toFixed(1)}%</span> <strong>#${e.rank}</strong><span class="sub">L${e.level} · CP ${e.cp}</span></td>`;

    // Sort by spread order or by the rank in one league (best rank first on the first click).
    const sortValue = (i) => (leaguesSort.key === 'spread' ? i : tables[keys.indexOf(leaguesSort.key)].at(state.spreads[i]).rank);
    const order = state.spreads
      .map((_, i) => i)
      .sort((a, b) => (sortValue(a) - sortValue(b)) * leaguesSort.dir || a - b);

    const rows = order.map(
      (i) => `<tr><td><strong>${letter(i)}</strong></td><td class="left">${ivText(state.spreads[i])}</td>${tables.map((t) => cell(t.at(state.spreads[i]))).join('')}</tr>`,
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
    const shown = t.entries.slice(0, topCount);
    const has = (ivs) => state.spreads.findIndex((s) => s.atk === ivs.atk && s.def === ivs.def && s.sta === ivs.sta);
    const full = state.spreads.length >= MAX_SPREADS;

    const rows = shown.map((e) => {
      const mine = has(e.ivs);
      const action =
        mine >= 0
          ? `<span class="muted">in comparison (${letter(mine)})</span>`
          : `<button type="button" data-add="${ivText(e.ivs)}" ${full ? 'disabled' : ''}>Compare</button>`;
      return `<tr><td>#${e.rank}</td><td class="left">${ivText(e.ivs)}</td><td>${e.level}</td><td>${e.cp}</td><td>${fixed(e.atk)}</td><td>${fixed(e.def)}</td><td>${e.hp}</td><td>${fixed(e.product / 1000)}</td><td>${e.percent.toFixed(1)}%</td><td>${action}</td></tr>`;
    });
    $('top-table').innerHTML = `<table>
      <thead><tr><th>Rank</th><th class="left">IVs</th><th>Level</th><th>CP</th><th>Atk</th><th>Def</th><th>HP</th><th>Stat product (k)</th><th>% of best</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
    $('top-sub').textContent = `top ${shown.length} for ${LEAGUES[state.league].label}`;
    $('top-more').hidden = topCount >= TOP_LIMIT;
  }

  function update() {
    syncControls();
    renderCompare();
    renderLeagues();
    renderTop();
    save();
  }

  // ---------------------------------------------------------------- wiring

  $('species-input').addEventListener('input', (e) => pickSpecies(e.target.value, { commit: false }));
  $('species-input').addEventListener('change', (e) => pickSpecies(e.target.value, { commit: true }));
  $('species-input').addEventListener('focus', (e) => e.target.select());

  $('league-buttons').addEventListener('click', (e) => {
    const key = e.target.closest('[data-league]')?.dataset.league;
    if (!key || key === state.league) return;
    state.league = key;
    topCount = TOP_STEP;
    update();
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
    state.spreads[i][k] = clampIv(n);
    update();
  });
  // Tidy up whatever was typed (empty, out of range) once the field is left.
  $('spread-editor').addEventListener('change', (e) => {
    const { i, k } = e.target.dataset;
    if (k !== undefined) e.target.value = state.spreads[i][k];
  });
  $('spread-editor').addEventListener('click', (e) => {
    const i = e.target.closest('[data-remove]')?.dataset.remove;
    if (i === undefined || state.spreads.length === 1) return;
    state.spreads.splice(Number(i), 1);
    renderEditor();
    update();
  });

  $('quick-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('quick-add-input');
    const ivs = parseSpread(input.value);
    $('quick-add-error').textContent = ivs ? '' : 'Enter three IVs from 0 to 15, like 0/15/14.';
    if (ivs && addSpread(ivs)) input.value = '';
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
  $('top-more').addEventListener('click', () => {
    topCount = Math.min(TOP_LIMIT, topCount + TOP_STEP);
    renderTop();
  });

  renderStaticControls();
  $('species-input').value = speciesLabel(species());
  renderEditor();
  update();
})();

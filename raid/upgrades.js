/**
 * Upgrades page: what to spend power-ups and TMs on.
 *
 * Read-only on purpose -- it never saves. It works from the raid view's live state (getSaved) and
 * recalculates when the view is shown, if anything changed since the last time.
 */
import { DEFAULT_TUNING } from './engine.js';
import { plan } from './planner.js';
import { buildAllRaidContext } from './all-raids.js';
import { generalTmAdvice } from './tm-advice.js';
import { powerUpAdvice } from './power-ups.js';
import { $, el, fmt1, gainText, tmCost, tmEffect, legacyWarning, eventNote } from './ui.js';

const state = {
  gd: null,
  savedKey: '',
  result: null,
  view: 'power',
  /** 'playing' (accounts marked as playing), or one account id. */
  account: 'playing',
  sort: 'gain',
  hideCopies: true,
};

const MAX_ROWS = 60;

let getSaved = null;

export function startUpgrades({ gd, getSaved: get }) {
  state.gd = gd;
  getSaved = get;
  $('recalc').onclick = () => refresh({ force: true });
}

/** Called whenever the Upgrades view is shown: rosters are edited on the Raid view, so pick up changes. */
export function showUpgrades() {
  refresh();
}

function refresh({ force = false } = {}) {
  const saved = getSaved();
  const key = JSON.stringify(saved);
  if (!force && key === state.savedKey) return;
  state.savedKey = key;
  $('recalc').disabled = true;
  $('status').textContent = 'Checking every raid boss…';
  // Let the status paint before the synchronous work (setTimeout: rAF pauses in hidden tabs).
  setTimeout(() => {
    try {
      state.result = compute(saved);
      render();
    } catch (err) {
      $('status').textContent = '';
      $('content').replaceChildren(el('p', { class: 'note warn', text: `Calculation failed: ${err.message}` }));
      console.error(err);
    } finally {
      $('recalc').disabled = false;
    }
  }, 0);
}

function compute(saved) {
  const gd = state.gd;
  const started = performance.now();
  const s = saved.settings;
  const tuning = { ...DEFAULT_TUNING, ...(s.tuning ?? {}) };
  const accounts = saved.accounts.map((a) => ({
    id: a.id,
    name: a.name || a.id,
    active: Boolean(a.active),
    partyPower: a.partyPower || 'off',
    playQuality: a.playQuality ?? 'sharp',
    maxRevives: a.maxRevives ?? null,
    roster: a.roster ?? [],
  }));
  const partySize = accounts.filter((a) => a.partyPower !== 'off').length;

  // Rating every roster against every boss is most of the work; both lists share it.
  const context = buildAllRaidContext(gd, accounts, { tuning, partySize });
  const tm = generalTmAdvice(gd, { accounts, tuning, partySize, context, limit: Infinity });
  const power = powerUpAdvice(gd, { accounts, tuning, partySize, context });

  let raid = null;
  if (s.bossSpec?.pokemonId) {
    raid = plan(gd, {
      bossSpec: {
        pokemonId: s.bossSpec.pokemonId,
        tier: s.bossSpec.tier,
        fastMove: s.bossSpec.fastMove || undefined,
        chargedMove: s.bossSpec.chargedMove || undefined,
      },
      weather: s.weather,
      purifiedGems: s.purifiedGems,
      tuning,
      friendships: s.friendships,
      accounts,
    });
  }
  return { accounts, tm, power, raid, bosses: context.bosses.length, ms: performance.now() - started };
}

// ---------------------------------------------------------------- shell

const tab = (label, sub, selected, onclick) =>
  el(
    'button',
    { class: 'tab', type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false', onclick },
    el('span', { text: label }),
    sub ? el('span', { class: 'tab-sub', text: sub }) : null,
  );

/**
 * Idle accounts never attack, and their gains are measured against their own (often weak) teams,
 * so by default only the accounts actually played are listed. Each account can still be picked.
 */
function byAccount(rows) {
  if (state.account !== 'playing') return rows.filter((row) => row.accountId === state.account);
  const playing = new Set(state.result.accounts.filter((a) => a.active).map((a) => a.id));
  return rows.filter((row) => playing.has(row.accountId));
}

function rowsFor(view) {
  const r = state.result;
  if (view === 'power') return byAccount(r.power.rows);
  if (view === 'elite') return byAccount(r.tm.rows.filter((row) => row.change.elite));
  if (view === 'regular') return byAccount(r.tm.rows.filter((row) => !row.change.elite));
  return byAccount(r.raid?.error ? [] : r.raid?.tmAdvice?.rows ?? []);
}

function render() {
  const r = state.result;
  $('status').textContent = `${r.bosses} raid bosses · ${fmt1(r.ms / 1000)}s`;

  const views = [
    ['power', 'Power-ups', `${rowsFor('power').filter((row) => !row.sharesCandyWith).length} Pokémon`],
    ['elite', 'Elite TMs', `${rowsFor('elite').length} worth doing`],
    ['regular', 'Fast & Charged TMs', `${rowsFor('regular').length} worth doing`],
    ['raid', r.raid?.boss ? `This raid: ${r.raid.boss.name}` : 'This raid', r.raid?.boss ? `${rowsFor('raid').length} changes` : 'no boss picked'],
  ];
  $('views').replaceChildren(
    ...views.map(([id, label, sub]) =>
      tab(label, sub, state.view === id, () => {
        state.view = id;
        render();
      }),
    ),
  );
  $('accounts').replaceChildren(
    tab('Playing accounts', r.accounts.filter((a) => a.active).map((a) => a.name).join(', ') || 'none marked', state.account === 'playing', () => {
      state.account = 'playing';
      render();
    }),
    ...r.accounts.map((a) =>
      tab(a.name, `${a.active ? 'playing' : 'idle'} · ${a.roster.length} mons`, state.account === a.id, () => {
        state.account = a.id;
        render();
      }),
    ),
  );

  const body = state.view === 'power' ? renderPower() : state.view === 'raid' ? renderRaid() : renderTms(state.view);
  $('content').replaceChildren(...body);
}

const pokemonCell = (row, ...extra) =>
  el(
    'td',
    { class: 'mon-name' },
    row.pokemon,
    ...extra,
    el('div', { class: 'muted small', text: `${row.accountName} · L${row.level} ${row.ivs.join('/')}` }),
    row.moves ? el('div', { class: 'muted small', text: `${row.moves.fast} / ${row.moves.charged.join(', ')}` }) : null,
  );

const table = (head, rows) =>
  el(
    'div',
    { class: 'table-scroll' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, ...head.map(([text, cls, title]) => el('th', { class: cls, title, text })))),
      el('tbody', {}, ...rows),
    ),
  );

// ---------------------------------------------------------------- power-ups

const SORTS = {
  gain: { label: 'Biggest gain', value: (row) => row.top.sumGain },
  // Past level 40 XL Candy is what runs out first. Only the gain XL Candy buys counts: the part
  // up to 40 is paid for in regular candy.
  xl: {
    label: 'Gain per XL Candy',
    value: (row) => {
      if (!row.top.cost.xl) return 0;
      const upTo40 = row.steps.find((s) => s.to === 40)?.sumGain ?? 0;
      return (row.top.sumGain - upTo40) / row.top.cost.xl;
    },
  },
  dust: { label: 'Gain per Stardust', value: (row) => row.top.sumGain / Math.max(1, row.top.cost.stardust) },
};

const costText = (c) =>
  [`${Math.round(c.stardust / 1000)}k dust`, c.candy ? `${c.candy.toLocaleString()} candy` : null, c.xl ? `${c.xl.toLocaleString()} XL` : null]
    .filter(Boolean)
    .join(' · ');

function renderPower() {
  const r = state.result;
  const parts = [
    el('p', {
      class: 'muted small',
      text:
        `Each Pokémon is tried at level 40, 45 and 50 against all ${r.bosses} raid bosses. The percentage is how much stronger ` +
        "that account's six-Pokémon team gets, added up over every boss where the Pokémon makes the team: +10% in one raid is " +
        'roughly a 10% faster kill there. Costs are for a normal Pokémon (shadows already included); a lucky one takes half the ' +
        'stardust and a purified one 10% less.',
    }),
    el(
      'div',
      { class: 'sort-row' },
      el(
        'label',
        { class: 'inline' },
        'Sort by ',
        el(
          'select',
          {
            onchange: (e) => {
              state.sort = e.target.value;
              render();
            },
          },
          ...Object.entries(SORTS).map(([id, s]) => el('option', { value: id, selected: state.sort === id, text: s.label })),
        ),
      ),
      el(
        'label',
        { class: 'checkbox inline' },
        el('input', {
          type: 'checkbox',
          checked: state.hideCopies,
          onchange: (e) => {
            state.hideCopies = e.target.checked;
            render();
          },
        }),
        el('span', { text: 'Hide copies that share candy with a better one' }),
      ),
    ),
  ];

  let rows = rowsFor('power');
  if (state.hideCopies) rows = rows.filter((row) => !row.sharesCandyWith);
  if (!rows.length) {
    parts.push(el('p', { class: 'muted', text: 'Nothing here would strengthen a raid team.' }));
    return parts;
  }
  const value = SORTS[state.sort].value;
  rows = rows.slice().sort((a, b) => value(b) - value(a));

  const stepCell = (row, to) => {
    const s = row.steps.find((x) => x.to === to);
    if (!s) return el('td', { class: 'num muted', text: row.level >= to ? '—' : 'no gain' });
    return el(
      'td',
      { class: 'num' },
      el('b', { text: gainText(s.sumGain) }),
      el('div', { class: 'muted small', text: `${s.raidsHelped} raids · avg ${gainText(s.avgGain)}` }),
      el('div', { class: 'muted small', text: costText(s.cost) }),
    );
  };

  const body = rows.slice(0, MAX_ROWS).map((row, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num muted', text: i + 1 }),
      pokemonCell(
        row,
        row.mega ? el('span', { class: 'badge mega', text: 'mega' }) : null,
        row.anyMoves
          ? el('span', { class: 'badge', title: 'Moves set to Any are assumed to be the best, which flatters the gain', text: 'any moves' })
          : null,
        row.assumesFrustrationGone
          ? el('span', {
              class: 'badge tm elite',
              title: 'Scored with its locked move replaced: on Frustration it would never make a team. Needs a Frustration removal event.',
              text: 'needs Frustration gone',
            })
          : null,
        row.sharesCandyWith
          ? el('div', {
              class: 'warn-text small',
              text: `same candy as ${row.sharesCandyWith.pokemon} L${row.sharesCandyWith.level} ${row.sharesCandyWith.ivs.join('/')}`,
            })
          : null,
      ),
      stepCell(row, 40),
      stepCell(row, 45),
      stepCell(row, 50),
      el('td', { class: 'small muted', text: row.top.bestRaids.map((b) => `${b.boss} ${gainText(b.gain)}`).join(', ') }),
    ),
  );
  parts.push(
    table(
      [['#'], ['Pokémon'], ['To level 40', 'num'], ['To level 45', 'num'], ['To level 50', 'num'], ['Helps most against']],
      body,
    ),
  );
  if (rows.length > MAX_ROWS) parts.push(el('p', { class: 'muted small', text: `Showing the top ${MAX_ROWS} of ${rows.length}.` }));
  return parts;
}

// ---------------------------------------------------------------- TMs across all raids

function renderTms(view) {
  const r = state.result;
  const tm = r.tm;
  const parts = [
    el('p', {
      class: 'muted small',
      text:
        `Every move change scored against all ${r.bosses} raid bosses at neutral weather, ranked by team gain added up across them. ` +
        "Team gain is how much stronger that account's six-Pokémon team gets (about +10% is a kill roughly 10% faster); a raid only " +
        'counts if the Pokémon makes the team. ' +
        (view === 'elite'
          ? 'An Elite TM is only listed when it beats the best a regular TM can reach for that move.'
          : 'A Fast or Charged TM rolls a random non-legacy move, so "~3 TMs" is the average number to land the one you want.'),
    }),
  ];
  if (tm.unentered) {
    parts.push(el('div', { class: 'note' }, `${tm.unentered} Pokémon have their moves set to Any, so they aren't checked. Enter their moves on the Raid page to include them.`));
  }
  const rows = rowsFor(view);
  if (!rows.length) {
    parts.push(el('p', { class: 'muted', text: tm.checked ? 'Nothing here helps any raid team.' : 'Nothing to check yet: enter moves for some Pokémon first.' }));
    return parts;
  }

  const body = rows.slice(0, MAX_ROWS).map((row, i) => {
    const c = row.change;
    return el(
      'tr',
      {},
      el('td', { class: 'num muted', text: i + 1 }),
      pokemonCell(row),
      el(
        'td',
        { class: 'small' },
        `${c.from} → ${c.to}`,
        c.elite ? el('span', { class: 'badge tm elite', text: 'legacy' }) : null,
        legacyWarning(c, row.moves.charged.length),
        eventNote(c, row.moves.charged.length),
      ),
      el('td', { class: 'small', text: tmCost(c) }),
      el(
        'td',
        { class: 'small' },
        `${row.raidsHelped} raid${row.raidsHelped === 1 ? '' : 's'}`,
        row.neverWorse
          ? el('div', {}, el('span', { class: 'badge mega', title: 'At least as strong against every boss checked', text: 'never worse' }))
          : el('div', {
              class: 'muted small',
              title: 'Bosses this Pokémon itself does worse against after the change, usually from losing coverage',
              text: `weaker vs ${row.worseAgainst}`,
            }),
      ),
      el('td', { class: 'num' }, gainText(row.avgGain), el('div', { class: 'muted small', text: `total ${gainText(row.sumGain)}` })),
      el('td', { class: 'small muted', text: row.bestRaids.map((b) => `${b.boss} ${gainText(b.gain)}`).join(', ') }),
    );
  });
  parts.push(
    table(
      [
        ['#'],
        ['Pokémon'],
        ['Change'],
        ['Costs'],
        ['Helps in'],
        ['Team gain', 'num', 'Average where it helps; total adds it up over every raid'],
        ['Helps most against'],
      ],
      body,
    ),
  );
  if (rows.length > MAX_ROWS) parts.push(el('p', { class: 'muted small', text: `Showing the top ${MAX_ROWS} of ${rows.length}.` }));
  return parts;
}

// ---------------------------------------------------------------- this raid

function renderRaid() {
  const r = state.result;
  const raid = r.raid;
  if (!raid) return [el('p', { class: 'muted', text: 'No boss is picked on the Raid page yet.' })];
  if (raid.error) return [el('p', { class: 'note warn', text: raid.error })];
  const a = raid.tmAdvice;
  const parts = [
    el(
      'p',
      { class: 'muted small' },
      `Fast and Charged TMs for the raid picked on the Raid page: ${raid.boss.name} [${raid.boss.types.join('/')}], ${raid.boss.tier}. ` +
        "Each row changes one move (or both, where shown), lets that account re-pick its team and re-runs the raid. Only accounts marked as playing count. " +
        'Elite TMs are only advised across all raids.',
    ),
  ];
  if (a.unentered) {
    parts.push(el('div', { class: 'note' }, `${a.unentered} Pokémon on played accounts have moves set to Any, so they aren't checked.`));
  }
  const rows = rowsFor('raid');
  if (!rows.length) {
    parts.push(
      el('p', {
        class: 'muted',
        text: a.checked
          ? 'No Fast or Charged TM speeds this raid up: the Pokémon that fight already know their best moves for it.'
          : 'Nothing to check yet: no Pokémon on a played account has its moves entered.',
      }),
    );
    return parts;
  }

  const body = rows.map((row, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num muted', text: i + 1 }),
      pokemonCell(row, row.joinsTeam ? el('span', { class: 'badge mega', title: 'Not in the team today; this change gets it in', text: 'joins team' }) : null),
      el(
        'td',
        { class: 'small' },
        ...row.changes.map((c) =>
          el('div', {}, `${c.from} → ${c.to}`, legacyWarning(c, row.moves.charged.length), eventNote(c, row.moves.charged.length)),
        ),
      ),
      el('td', { class: 'small' }, ...row.changes.map((c) => el('div', { text: tmCost(c) }))),
      el('td', { class: 'num', text: `${fmt1(row.dpsBefore)} → ${fmt1(row.dpsAfter)}` }),
      el('td', { class: 'num', text: tmEffect(row) }),
    ),
  );
  parts.push(table([['#'], ['Pokémon'], ['Change'], ['Costs'], ['Its DPS', 'num'], ['This raid', 'num']], body));
  return parts;
}

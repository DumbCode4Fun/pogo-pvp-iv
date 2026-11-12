/**
 * UI layer: roster editing, raid setup, and rendering the planner's report.
 * All of the actual maths lives in engine.js / planner.js.
 *
 * Started by mount.js with the game data and a storage backend (see ../storage.js).
 */
import {
  RAID_TIERS,
  WEATHER,
  FRIENDSHIP,
  PARTY_POWER,
  PLAY_QUALITY,
  DEFAULT_TUNING,
  bossCandidates,
  rosterCandidates,
  resolveTier,
  cpOf,
  levelForCp,
  MEGA_ANY,
  effectiveFriendship,
  friendshipKey,
  normalizeEntry,
} from './engine.js';
import { plan } from './planner.js';
import { GMAX_TYPES, MAX_SPECIALS } from './maxbattle.js';
import { ASSUMED_IV, parseRosterCsv, rosterToCsv, mergeRoster } from './roster-import.js';
import { $, el, getRoot, debounce, fmt1, pct, tmCost, tmEffect } from './ui.js';


/** Levels 1 → 50 in half steps, matching how power-ups work. */
const LEVELS = (() => {
  const out = [];
  for (let l = 1; l <= 50; l += 0.5) out.push(l);
  return out;
})();

// ---------------------------------------------------------------- state

const state = {
  gd: null,
  accounts: [],
  settings: null,
  currentId: null,
  result: null,
  busy: false,
};

const speciesById = new Map();
/** Where rosters are saved: {load(), save(state)} from storage.js. */
let backend = null;

export async function startRaid({ gd, storage }) {
  backend = storage;
  state.gd = gd;
  for (const p of gd.pokemon) speciesById.set(p.id, p);

  $('dataVersion').textContent =
    `${gd.pokemon.length} Pokémon · ${Object.keys(gd.moves).length} moves · data ${gd.generated.slice(0, 10)}`;

  wireActions();
  reloadState(await storage.load());
}

/** Everything the page shows that comes from {accounts, settings}: first load, and after a restore. */
function reloadState(saved) {
  state.accounts = saved.accounts;
  state.settings = { ...saved.settings, tuning: { ...DEFAULT_TUNING, ...(saved.settings.tuning ?? {}) } };
  state.currentId = state.accounts[0]?.id ?? null;
  const migrated = migrate();

  buildSetupControls();
  buildTuningControls();
  renderAccountTabs();
  renderAccountSettings();
  renderFriendships();
  renderRoster();
  if (migrated) persist();
  run();
  for (const fn of reloadListeners) fn();
}

/** The live state, for the Upgrades view and for backups. */
export const getSaved = () => ({ accounts: state.accounts, settings: state.settings });

/** Replaces everything with an imported state and saves it. Resolves false if the save failed. */
export function restoreState(saved) {
  reloadState(saved);
  return saveNow();
}

/**
 * Bring older saves up to date. Returns true if anything changed, so it gets written back.
 *   - megas used to be separate roster species; now a base Pokemon with a mega flag
 *   - Party Power used to be on/off; now off / casual / optimal
 *   - friendship used to be one level per account; now a level per pair of accounts
 *   - dropped tunables are removed so they don't linger in settings.json
 */
function migrate() {
  let changed = false;
  for (const a of state.accounts) {
    const before = JSON.stringify(a.roster ?? []);
    a.roster = (a.roster ?? []).map((e) => normalizeEntry(state.gd, e));
    if (JSON.stringify(a.roster) !== before) changed = true;
    if (typeof a.partyPower === 'boolean') {
      a.partyPower = a.partyPower ? 'optimal' : 'off';
      changed = true;
    }
  }

  const s = state.settings;
  if (!s.friendships) {
    s.friendships = {};
    for (const a of state.accounts) {
      for (const b of state.accounts) {
        if (a.id >= b.id) continue;
        // Best guess from the old per-account levels: a pair is at most as close as either said.
        s.friendships[friendshipKey(a.id, b.id)] = Math.min(a.friendship ?? 0, b.friendship ?? 0);
      }
    }
    changed = true;
  }

  for (const key of Object.keys(s.tuning)) {
    if (!(key in DEFAULT_TUNING)) {
      delete s.tuning[key];
      changed = true;
    }
  }

  // The Primal tier was folded into Mega Legendary (identical HP, multiplier and timer).
  const tier = resolveTier(s.bossSpec.tier);
  if (tier !== s.bossSpec.tier) {
    s.bossSpec.tier = tier;
    changed = true;
  }

  // A boss that isn't valid for the saved tier (e.g. saved before bosses were filtered, or a
  // Pokemon that turned out not to be in the game).
  if (s.bossSpec.pokemonId && !isValidBoss(s.bossSpec.pokemonId, s.bossSpec.tier)) {
    s.bossSpec.pokemonId = '';
    changed = true;
  }
  return changed;
}

const isValidBoss = (id, tier) => bossCandidates(state.gd, tier).some((p) => p.id === id);

/** Present in the raid = every account; friendship counts even with an empty roster. */
function friendshipFor(accountId) {
  return effectiveFriendship(
    state.settings.friendships,
    accountId,
    state.accounts.map((a) => a.id),
  );
}

// ---------------------------------------------------------------- persistence

let saveTimer;
function markSaving() {
  const s = $('saveStatus');
  s.textContent = 'saving…';
  s.className = 'save-status saving';
}

async function saveNow() {
  try {
    markSaving();
    await backend.save(getSaved());
    const s = $('saveStatus');
    s.textContent = 'saved';
    s.className = 'save-status saved';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => (s.textContent = ''), 1600);
    return true;
  } catch (err) {
    const s = $('saveStatus');
    s.textContent = `save failed: ${err.message}`;
    s.className = 'save-status error';
    return false;
  }
}

const persist = debounce(saveNow, 500);

/** For other views that keep their own settings inside the saved state (the Max Battle view). */
export const markChanged = () => persist();

const reloadListeners = [];
/** Called after the whole state is replaced (a restore), so other views can redraw. */
export const onStateReload = (fn) => reloadListeners.push(fn);

/** Any user edit: save, and recalculate if auto-run is on. */
function changed({ recalc = true } = {}) {
  persist();
  if (recalc && $('autoRun').checked) scheduleRun();
}

const scheduleRun = debounce(() => run(), 220);

const currentAccount = () => state.accounts.find((a) => a.id === state.currentId);

// ---------------------------------------------------------------- combobox

/**
 * Minimal searchable picker over the species list. A native <datalist> only prefix-matches
 * in some browsers, which is painful across 1200+ entries.
 */
export function makeCombo(container, { value, placeholder, onPick, items = () => state.gd.pokemon, emptyText = 'No match' }) {
  container.className = 'combo';
  container.replaceChildren();

  const input = el('input', { type: 'text', placeholder: placeholder ?? 'Search…', autocomplete: 'off' });
  const list = el('div', { class: 'combo-list', hidden: true });
  container.append(input, list);

  let matches = [];
  let cursor = 0;
  const setLabel = (id) => {
    input.value = speciesById.get(id)?.name ?? '';
  };
  if (value) setLabel(value);

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
  };

  const search = (q) => {
    const pool = items();
    const needle = q.trim().toLowerCase();
    if (!needle) return pool.slice(0, 80);
    const starts = [];
    const contains = [];
    for (const p of pool) {
      const name = p.name.toLowerCase();
      if (name.startsWith(needle)) starts.push(p);
      else if (name.includes(needle)) contains.push(p);
      if (starts.length >= 60) break;
    }
    return [...starts, ...contains].slice(0, 60);
  };

  const paint = () => {
    list.replaceChildren();
    if (!matches.length) {
      list.append(el('div', { class: 'combo-empty', text: emptyText }));
    } else {
      matches.forEach((p, i) => {
        list.append(
          el(
            'div',
            {
              class: 'combo-opt',
              role: 'option',
              'aria-selected': i === cursor ? 'true' : 'false',
              onmousedown: (e) => {
                e.preventDefault();
                pick(p);
              },
            },
            el('span', { text: p.name }),
            el('span', { class: 'types', text: p.types.join(' / ') }),
          ),
        );
      });
    }
    list.hidden = false;
  };

  const pick = (p) => {
    setLabel(p.id);
    close();
    onPick(p);
  };

  const refresh = () => {
    matches = search(input.value);
    cursor = 0;
    paint();
  };

  input.addEventListener('focus', () => {
    input.select();
    refresh();
  });
  input.addEventListener('input', refresh);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) return refresh();
    if (e.key === 'ArrowDown') {
      cursor = Math.min(cursor + 1, matches.length - 1);
      paint();
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      cursor = Math.max(cursor - 1, 0);
      paint();
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (matches[cursor]) pick(matches[cursor]);
      e.preventDefault();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return { setValue: setLabel, focus: () => input.focus(), clear: () => (input.value = '') };
}

// ---------------------------------------------------------------- raid setup

let addPickerValue = null;

function buildSetupControls() {
  const s = state.settings;

  // Only Pokemon that can actually be this tier's boss: legendaries / mythicals / ultra beasts
  // for 5-star, their megas for mega raids, the two primals, and shadow-capable legendaries.
  const bossCombo = makeCombo($('bossPicker'), {
    value: s.bossSpec.pokemonId,
    placeholder: 'Search a raid boss…',
    items: () => bossCandidates(state.gd, s.bossSpec.tier),
    emptyText: 'Not a boss in this tier',
    onPick: (p) => {
      s.bossSpec.pokemonId = p.id;
      s.bossSpec.fastMove = '';
      s.bossSpec.chargedMove = '';
      fillBossMoves();
      changed();
    },
  });

  const tier = $('tier');
  tier.replaceChildren(
    ...Object.values(RAID_TIERS).map((t) => el('option', { value: t.id, selected: t.id === s.bossSpec.tier }, t.label)),
  );
  tier.onchange = () => {
    s.bossSpec.tier = tier.value;
    $('gemsField').hidden = !RAID_TIERS[tier.value]?.shadow;
    // Switching tier usually invalidates the boss (Rayquaza is not a primal). Keep it when it
    // still fits -- Lugia is valid for both 5-star and 5-star shadow.
    if (!isValidBoss(s.bossSpec.pokemonId, tier.value)) {
      s.bossSpec.pokemonId = '';
      s.bossSpec.fastMove = '';
      s.bossSpec.chargedMove = '';
      bossCombo.clear();
      fillBossMoves();
    }
    changed();
  };
  $('gemsField').hidden = !RAID_TIERS[s.bossSpec.tier]?.shadow;

  const weather = $('weather');
  weather.replaceChildren(
    ...WEATHER.map((w) => {
      const boosts = state.gd.weatherAffinities[w.id];
      const label = boosts ? `${w.label} — ${boosts.map(titleCase).join(', ')}` : w.label;
      return el('option', { value: w.id, selected: w.id === s.weather }, label);
    }),
  );
  weather.onchange = () => {
    s.weather = weather.value;
    changed();
  };

  const gems = $('purifiedGems');
  gems.checked = Boolean(s.purifiedGems);
  gems.onchange = () => {
    s.purifiedGems = gems.checked;
    changed();
  };

  fillBossMoves();

  $('bossFast').onchange = (e) => {
    s.bossSpec.fastMove = e.target.value;
    changed();
  };
  $('bossCharged').onchange = (e) => {
    s.bossSpec.chargedMove = e.target.value;
    changed();
  };

  // Rosters hold base Pokemon that are actually in the game; mega evolving is a per-entry flag,
  // so mega forms aren't listed separately.
  const rosterPool = rosterCandidates(state.gd);
  makeCombo($('addPicker'), {
    placeholder: 'Search a Pokémon to add…',
    items: () => rosterPool,
    onPick: (p) => {
      addPickerValue = p.id;
      addToRoster();
    },
  });
}

const titleCase = (t) => t.charAt(0) + t.slice(1).toLowerCase();

function fillBossMoves() {
  const s = state.settings;
  const p = speciesById.get(s.bossSpec.pokemonId);
  const opts = (ids, current) => [
    el('option', { value: '', selected: !current }, 'Any / unknown (averaged)'),
    ...ids.map((id) =>
      el('option', { value: id, selected: id === current }, state.gd.moves[id]?.name ?? id),
    ),
  ];
  $('bossFast').replaceChildren(...opts(p?.fastMoves ?? [], s.bossSpec.fastMove));
  $('bossCharged').replaceChildren(...opts(p?.chargedMoves ?? [], s.bossSpec.chargedMove));
}

/**
 * Tunables, grouped by what kind of number they are. None of them are per-boss: the boss's own
 * stats and move timings already come from the game data. What differs is how much they're worth
 * touching — a house rule about your own play versus a mechanic that is simply how the game works.
 */
const TUNING_GROUPS = [
  {
    id: 'habits',
    title: 'How your group plays',
    blurb: 'Genuine estimates about you, not the game. Worth timing once and setting properly.',
    fields: [
      ['faintDelay', 'Downtime after a faint (s)', 0, 10, 0.5, 'estimate — picking the next Pokémon'],
      ['relobbyTime', 'Relobby + max revive (s)', 4, 40, 1, 'your 10–15 s estimate'],
      ['partyPowerFastAttacks2', 'Party Power refill — party of 2', 1, 60, 1, 'your own fast attacks; the meter is per player'],
      ['partyPowerFastAttacks3', 'Party Power refill — party of 3', 1, 60, 1, 'follows 18 / (party − 1)'],
      ['partyPowerFastAttacks4', 'Party Power refill — party of 4', 1, 60, 1, 'how often it comes back, not a cap per raid'],
    ],
  },
  {
    id: 'random',
    title: 'Random every time',
    blurb: 'The game rolls this fresh on each attack. The default is the middle of the range; nudge it to see a good or bad run.',
    fields: [['bossMoveDelay', 'Boss delay between moves (s)', 0, 5, 0.1, 'rolled 1.5–2.5 s each move, median 2.0']],
  },
  {
    id: 'mechanics',
    title: 'How the game works',
    blurb:
      'Measured mechanics that are the same for every boss — the enrage multipliers do not vary by Pokémon. Changing these models a hypothetical, not reality. Reset if in doubt.',
    fields: [
      ['bossChargedChance', 'Boss charged-move chance', 0.05, 1, 0.05, '50% once it has energy (Sept 2024 hotfix)'],
      ['enrageAtkMult', 'Shadow enrage: attack (× base + 15)', 1, 4, 0.01, 'datamined 1.81 — same for every shadow boss'],
      ['enrageDefMult', 'Shadow enrage: defence (× base + 15)', 1, 6, 0.1, 'datamined 3 — same for every shadow boss'],
      ['enrageStartHpFrac', 'Shadow enrage starts at HP fraction', 0.1, 1, 0.05, 'Bulbapedia: 60%, every shadow boss'],
    ],
  },
];

function buildTuningControls() {
  const grid = $('tuningGrid');
  const field = ([key, label, min, max, step, source]) =>
      el(
        'label',
        { class: 'field' },
        el('span', { text: label }),
        el('small', { class: 'muted', text: `default ${DEFAULT_TUNING[key]} — ${source}` }),
        el('input', {
          type: 'number',
          value: state.settings.tuning[key],
          min,
          max,
          step,
          oninput: (e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) {
              state.settings.tuning[key] = v;
              changed();
            }
          },
        }),
      );

  grid.replaceChildren(
    ...TUNING_GROUPS.flatMap((group) => [
      el(
        'div',
        { class: 'tune-group' },
        el('h4', { text: group.title }),
        el('p', { class: 'muted small', text: group.blurb }),
        el('div', { class: 'grid' }, ...group.fields.map(field)),
      ),
    ]),
  );
}

// ---------------------------------------------------------------- accounts

function renderAccountTabs() {
  $('accountTabs').replaceChildren(
    ...state.accounts.map((a) =>
      el(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          'aria-selected': a.id === state.currentId ? 'true' : 'false',
          onclick: () => {
            state.currentId = a.id;
            renderAccountTabs();
            renderAccountSettings();
            renderRoster();
          },
        },
        el('span', { text: a.name || a.id }),
        el('span', {
          class: 'tab-sub',
          text: `${a.active ? 'playing' : 'idle'} · ${(a.roster ?? []).length} mons`,
        }),
      ),
    ),
  );
}

function renderAccountSettings() {
  const a = currentAccount();
  const box = $('accountSettings');
  if (!a) return box.replaceChildren();

  box.replaceChildren(
    el(
      'label',
      { class: 'field' },
      el('span', { text: 'Account name' }),
      el('input', {
        type: 'text',
        value: a.name ?? '',
        oninput: (e) => {
          a.name = e.target.value;
          renderAccountTabs();
          renderFriendships();
          changed({ recalc: false });
        },
      }),
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { text: 'Party Power' }),
      el(
        'select',
        {
          onchange: (e) => {
            a.partyPower = e.target.value;
            changed();
          },
        },
        ...PARTY_POWER.map((p) => el('option', { value: p.id, selected: p.id === (a.partyPower || 'off') }, p.label)),
      ),
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { text: 'How sharply it is played' }),
      el(
        'select',
        {
          disabled: !a.active,
          title: a.active ? 'Affects charged-move timing and whether Party Power gets used' : 'Idle accounts deal no damage',
          onchange: (e) => {
            a.playQuality = e.target.value;
            changed();
          },
        },
        ...PLAY_QUALITY.map((q) => el('option', { value: q.id, selected: q.id === (a.playQuality ?? 'sharp') }, q.label)),
      ),
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { text: 'Max Revives available' }),
      el('input', {
        type: 'number',
        min: 0,
        step: 1,
        placeholder: 'blank = unlimited',
        value: a.maxRevives === null || a.maxRevives === undefined ? '' : a.maxRevives,
        oninput: (e) => {
          const raw = e.target.value.trim();
          a.maxRevives = raw === '' ? null : Math.max(0, Number(raw));
          changed();
        },
      }),
    ),
    el(
      'label',
      { class: 'field checkbox' },
      el('input', {
        type: 'checkbox',
        checked: Boolean(a.active),
        onchange: (e) => {
          a.active = e.target.checked;
          renderAccountTabs();
          changed();
        },
      }),
      el('span', { html: 'Actively played <em>(idle accounts deal no damage)</em>' }),
    ),
  );
}

// ---------------------------------------------------------------- friendships

/**
 * One level per pair of accounts. A trainer's raid bonus is their highest friendship with
 * anyone in the raid -- bonuses don't stack -- so each account's effective level is shown too.
 */
function renderFriendships() {
  const box = $('friendships');
  const accts = state.accounts;
  const f = (state.settings.friendships ??= {});

  const pairSelect = (a, b) =>
    el(
      'select',
      {
        title: `${a.name} ↔ ${b.name}`,
        onchange: (e) => {
          f[friendshipKey(a.id, b.id)] = Number(e.target.value);
          renderFriendships();
          changed();
        },
      },
      ...FRIENDSHIP.map((lvl) =>
        el('option', { value: lvl.id, selected: lvl.id === (f[friendshipKey(a.id, b.id)] ?? 0) }, lvl.label),
      ),
    );

  const head = el('tr', {}, el('th', {}), ...accts.slice(1).map((b) => el('th', { text: b.name || b.id })));
  const rows = accts.slice(0, -1).map((a, i) =>
    el(
      'tr',
      {},
      el('th', { text: a.name || a.id }),
      ...accts.slice(1).map((b, j) => el('td', {}, j >= i ? pairSelect(a, b) : '')),
    ),
  );

  const effective = accts.map((a) => {
    const lvl = FRIENDSHIP.find((x) => x.id === friendshipFor(a.id));
    return el('span', { class: 'badge', text: `${a.name || a.id}: ${lvl.label} ×${lvl.mult}` });
  });

  box.replaceChildren(
    el('div', { class: 'table-scroll' }, el('table', { class: 'matrix' }, el('thead', {}, head), el('tbody', {}, ...rows))),
    el('p', { class: 'muted small', text: 'Raid bonus each account actually gets — the best of its friendships in the lobby:' }),
    el('div', { class: 'pill-row' }, ...effective),
  );
}

// ---------------------------------------------------------------- roster

/**
 * How the roster table is ordered: by level or name, or (key null) the order the Pokémon were added.
 * Only the display is sorted; the saved roster keeps its order. A per-browser preference.
 */
const ROSTER_SORT_KEY = 'pogo-tools.raid.rosterSort';
let rosterSort = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(ROSTER_SORT_KEY));
    if (['level', 'name'].includes(saved?.key) && [1, -1].includes(saved?.dir)) return saved;
  } catch {
    /* blocked or bad storage: start unsorted */
  }
  return { key: null, dir: 1 };
})();

/** A heading click: level starts highest first, name A-Z; a second click flips, a third goes back to unsorted. */
function cycleRosterSort(key) {
  const first = key === 'level' ? -1 : 1;
  if (rosterSort.key !== key) rosterSort = { key, dir: first };
  else if (rosterSort.dir === first) rosterSort = { key, dir: -first };
  else rosterSort = { key: null, dir: 1 };
  try {
    localStorage.setItem(ROSTER_SORT_KEY, JSON.stringify(rosterSort));
  } catch {
    /* the sort just won't be remembered */
  }
  renderRoster();
}

const monName = (e) => speciesById.get(e.pokemonId)?.name ?? e.pokemonId;

/**
 * How many roster rows are drawn. A whole box is well over a thousand Pokémon, and laying out that
 * many table rows takes the browser a couple of seconds on every redraw, so rows come a page at a time.
 */
const ROSTER_PAGE = 100;
let rosterShown = ROSTER_PAGE;
let rosterShownFor = null; // the account the page count belongs to; another account starts at one page

/** The roster in display order. Ties keep the order they were added. */
function sortedRoster(roster) {
  const { key, dir } = rosterSort;
  if (!key) return roster;
  const value = (e) => (key === 'level' ? e.level : monName(e));
  return roster
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const x = value(a.entry);
      const y = value(b.entry);
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return c * dir || a.i - b.i;
    })
    .map((x) => x.entry);
}

function syncRosterSortHeadings() {
  for (const b of $('rosterTable').querySelectorAll('[data-roster-sort]')) {
    const on = b.dataset.rosterSort === rosterSort.key;
    const label = b.dataset.rosterSort === 'level' ? 'Lvl' : 'Pokémon';
    b.textContent = on ? `${label} ${rosterSort.dir > 0 ? '▲' : '▼'}` : label;
    b.setAttribute('aria-pressed', String(on));
    b.closest('th').setAttribute('aria-sort', on ? (rosterSort.dir > 0 ? 'ascending' : 'descending') : 'none');
  }
}

function renderRoster() {
  const a = currentAccount();
  const body = $('rosterBody');
  syncRosterSortHeadings();
  if (!a) return body.replaceChildren();

  const roster = (a.roster ??= []);
  if (rosterShownFor !== a.id) {
    rosterShown = ROSTER_PAGE;
    rosterShownFor = a.id;
  }
  const query = $('rosterFilter').value.trim().toLowerCase();
  const matching = query ? sortedRoster(roster).filter((e) => monName(e).toLowerCase().includes(query)) : sortedRoster(roster);
  const shown = matching.slice(0, rosterShown);
  $('rosterCount').textContent = !roster.length ? '' : query ? `— ${matching.length} of ${roster.length} Pokémon` : `— ${roster.length} Pokémon`;

  const message = (text) => body.replaceChildren(el('tr', { class: 'empty-row' }, el('td', { colspan: 12 }, text)));
  if (!roster.length) return message('Nothing here yet. Search below to add the Pokémon this account would bring.');
  if (!matching.length) return message(`No Pokémon in this roster matching "${query}".`);

  const showMore = (n) => {
    rosterShown = n;
    renderRoster();
  };
  const left = matching.length - shown.length;
  const moreRow = left
    ? el(
        'tr',
        { class: 'more-row' },
        el(
          'td',
          { colspan: 12 },
          `Showing ${shown.length} of ${matching.length}.`,
          el('button', { type: 'button', class: 'ghost', onclick: () => showMore(rosterShown + ROSTER_PAGE) }, `Show ${Math.min(ROSTER_PAGE, left)} more`),
          left > ROSTER_PAGE
            ? el('button', { type: 'button', class: 'ghost', title: 'A whole box takes a couple of seconds to draw', onclick: () => showMore(Infinity) }, 'Show all')
            : null,
        ),
      )
    : null;

  body.replaceChildren(
    ...shown.map((entry) => {
      const p = speciesById.get(entry.pokemonId);
      const name = p?.name ?? entry.pokemonId;

      const num = (key, min, max, step) =>
        el('input', {
          type: 'number',
          value: entry[key],
          min,
          max,
          step,
          oninput: (e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) {
              entry[key] = Math.min(max, Math.max(min, v));
              // Editing an IV means it's no longer a guess from the CP import.
              if (key.startsWith('iv') && entry.ivsAssumed) {
                delete entry.ivsAssumed;
                renderRoster();
              }
              changed();
            }
          },
        });

      const moveSelect = (ids, current, emptyLabel, onSet, exclude = null) =>
        el(
          'select',
          { onchange: (e) => onSet(e.target.value) },
          el('option', { value: '', selected: !current }, emptyLabel),
          ...ids
            .filter((id) => id !== exclude)
            .map((id) =>
              el(
                'option',
                { value: id, selected: id === current },
                `${state.gd.moves[id]?.name ?? id}${(p?.legacyMoves ?? []).includes(id) ? ' ★' : ''}${id === p?.shadowMove ? ' (shadow, locked)' : ''}`,
              ),
            ),
        );

      const charged = (entry.chargedMoves ??= []);
      const setCharged = (slot, value) => {
        const next = [charged[0] ?? '', charged[1] ?? ''];
        next[slot] = value;
        // Back to "Any (best)" on the first slot makes a second pick meaningless.
        if (slot === 0 && !value) next[1] = '';
        // Never let the same move sit in both slots.
        if (slot === 0 && value && next[1] === value) next[1] = '';
        entry.chargedMoves = next.filter(Boolean);
        renderRoster();
        changed();
      };

      // A shadow may still know its locked move (Frustration). It's never a real choice, so it's
      // offered only for shadows and "Any (best)" never assumes it.
      const shadowMove = entry.shadow && p?.shadowMove && state.gd.moves[p.shadowMove] ? [p.shadowMove] : [];
      const chargedIds = [...(p?.chargedMoves ?? []), ...shadowMove];
      // The second slot only means anything once the first is pinned: with "Any (best)" the
      // engine already weighs every charged move the species can learn.
      const chargedCell = charged[0]
        ? [
            moveSelect(chargedIds, charged[0], 'Any (best)', (v) => setCharged(0, v)),
            moveSelect(chargedIds, charged[1], 'No 2nd move', (v) => setCharged(1, v), charged[0]),
          ]
        : [
            moveSelect(chargedIds, '', 'Any (best)', (v) => setCharged(0, v)),
            el('small', { class: 'muted', text: 'all moves considered' }),
          ];

      return el(
        'tr',
        {},
        nameCell(entry, p, name),
        el('td', {}, levelSelect(entry)),
        el('td', {}, num('ivAtk', 0, 15, 1)),
        el('td', {}, num('ivDef', 0, 15, 1)),
        el('td', {}, num('ivSta', 0, 15, 1)),
        el(
          'td',
          {},
          el('input', {
            type: 'checkbox',
            checked: Boolean(entry.shadow),
            // Shadow Pokemon can't mega evolve or join Max Battles.
            disabled: (p && !p.shadowAvailable && !entry.shadow) || Boolean(entry.mega) || (Boolean(entry.dynamax) && !entry.shadow),
            title: entry.mega
              ? 'Shadow Pokémon can’t mega evolve'
              : entry.dynamax && !entry.shadow
                ? 'Shadow Pokémon can’t Dynamax'
                : p && !p.shadowAvailable
                  ? 'No shadow form in the game data'
                  : 'Shadow',
            onchange: (e) => {
              entry.shadow = e.target.checked;
              // Purified: Frustration is gone (it becomes Return).
              if (!entry.shadow && p?.shadowMove) {
                entry.chargedMoves = (entry.chargedMoves ?? []).filter((m) => m !== p.shadowMove);
              }
              renderRoster();
              changed();
            },
          }),
        ),
        ...maxCells(entry, p),
        el('td', { class: 'mega-cell' }, megaCell(entry, p)),
        el('td', {}, moveSelect(p?.fastMoves ?? [], entry.fastMove, 'Any (best)', (v) => {
          entry.fastMove = v;
          changed();
        })),
        el('td', { class: 'charged' }, chargedCell),
        el('td', {}, el('button', {
          class: 'row-x',
          type: 'button',
          title: 'Remove',
          onclick: () => {
            // the table may be sorted, so find the entry itself rather than trusting the row number
            roster.splice(roster.indexOf(entry), 1);
            renderRoster();
            renderAccountTabs();
            changed();
          },
        }, '✕')),
      );
    }),
    ...(moreRow ? [moreRow] : []),
  );
}

/**
 * The level picker. It starts with only the current level and gets all 99 levels the first time it
 * is focused or pressed: a full box is well over a thousand rows, and 99 options in each made
 * every redraw of the table take about a second.
 */
function levelSelect(entry) {
  const select = el(
    'select',
    {
      class: 'lvl',
      onchange: (e) => {
        entry.level = Number(e.target.value);
        changed();
      },
    },
    el('option', { value: entry.level, selected: true }, String(entry.level)),
  );
  const fill = () => {
    if (select.options.length > 1) return;
    // a Best Buddy's level 51 isn't in the list of levels you can power up to, so add it rather than lose it
    const levels = LEVELS.includes(entry.level) ? LEVELS : [...LEVELS, entry.level].sort((a, b) => a - b);
    select.replaceChildren(...levels.map((l) => el('option', { value: l, selected: l === entry.level }, String(l))));
    select.value = String(entry.level);
  };
  select.addEventListener('focus', fill);
  select.addEventListener('pointerdown', fill);
  return select;
}

/**
 * The Pokémon name, clickable to swap the species in place. Without this, correcting a misread
 * entry (Hoopa Confined vs Unbound) means deleting the row and retyping level, IVs and moves.
 * Anything the new species can't have — moves, mega form, shadow — is dropped.
 */
function nameCell(entry, species, name) {
  const cell = el('td', { class: 'mon-name' });

  const showName = () =>
    // Filtered, because replaceChildren turns a null into the text "null".
    cell.replaceChildren(
      ...[
        el('button', { type: 'button', class: 'name-swap', title: 'Change Pokémon', onclick: startSwap }, name),
        !species ? el('span', { class: 'badge', text: 'missing from data' }) : null,
        // Imported from CP without visible IVs: the level is only as good as the guess.
        entry.ivsAssumed
          ? el('span', { class: 'badge idle', title: 'IVs were not visible — guessed, so the level is approximate', text: 'IV?' })
          : null,
      ].filter(Boolean),
    );

  function startSwap() {
    const box = el('div');
    cell.replaceChildren(box);
    const combo = makeCombo(box, {
      value: entry.pokemonId,
      placeholder: 'Change Pokémon…',
      items: () => rosterCandidates(state.gd),
      onPick: (pick) => {
        // A swap is nearly always a misidentified species, so hold CP constant and re-solve the
        // level: Hoopa Confined L38 and Hoopa Unbound L28.5 are both 3255 CP.
        const ivs = [entry.ivAtk, entry.ivDef, entry.ivSta];
        if (species) {
          const cp = cpOf(state.gd, species, entry.level, ivs);
          const solved = levelForCp(state.gd, pick, ivs, cp);
          if (solved) entry.level = solved.level;
        }
        entry.pokemonId = pick.id;
        if (!pick.fastMoves.includes(entry.fastMove)) entry.fastMove = '';
        entry.chargedMoves = (entry.chargedMoves ?? []).filter((m) => pick.chargedMoves.includes(m));
        if (!(pick.tempEvos ?? []).some((t) => t.suffix === entry.mega)) {
          entry.mega = '';
          entry.megaLevel = 1;
        }
        if (!pick.shadowAvailable) entry.shadow = false;
        if (!(pick.id in GMAX_TYPES)) entry.gigantamax = false;
        renderRoster();
        renderAccountTabs();
        changed();
      },
    });
    // Clicking away without choosing puts the name back.
    box.querySelector('input')?.addEventListener('blur', () => setTimeout(showName, 200));
    combo.focus();
  }

  showName();
  return cell;
}

/**
 * The Dynamax and G-Max boxes: can this Pokemon join Max Battles (the Dynamax tab uses only these),
 * and as a Gigantamax? Gigantamax implies Dynamax, only the species in GMAX_TYPES have it, and a
 * Shadow can do neither. A box stays clickable while ticked so a stray flag can always be cleared.
 * Raids ignore both flags, so ticking one saves without recalculating the raid.
 * Crowned Zacian and Zamazenta and Eternatus (MAX_SPECIALS) join Max Battles without Dynamaxing, so
 * their box shows ticked and can't be changed.
 */
function maxCells(entry, p) {
  const hasGmax = Boolean(p && p.id in GMAX_TYPES);
  const special = p ? MAX_SPECIALS[p.id] : null;
  const set = (changes) => {
    Object.assign(entry, changes);
    renderRoster();
    changed({ recalc: false });
  };
  const dynamax = special
    ? el('input', {
        type: 'checkbox',
        checked: true,
        disabled: true,
        title: `Joins Max Battles without Dynamaxing, using ${state.gd.moves[special.moveId]?.name ?? 'its own move'} in the Max phase`,
      })
    : el('input', {
        type: 'checkbox',
        checked: Boolean(entry.dynamax),
        disabled: Boolean(entry.shadow) && !entry.dynamax,
        title: entry.shadow ? 'Shadow Pokémon can’t join Max Battles' : 'Can join Max Battles (used by the Dynamax tab)',
        // Unticking Dynamax unticks Gigantamax too.
        onchange: (e) => set(e.target.checked ? { dynamax: true } : { dynamax: false, gigantamax: false }),
      });
  const gmax = el('input', {
    type: 'checkbox',
    checked: Boolean(entry.gigantamax),
    disabled: (!hasGmax || Boolean(entry.shadow)) && !entry.gigantamax,
    title: !hasGmax
      ? 'No Gigantamax form'
      : entry.shadow
        ? 'Shadow Pokémon can’t join Max Battles'
        : 'Can Gigantamax (implies Dynamax): fixed G-Max move type, stronger Max Attack',
    // Gigantamax implies Dynamax.
    onchange: (e) => set(e.target.checked ? { gigantamax: true, dynamax: true } : { gigantamax: false }),
  });
  return [el('td', { class: 'max-cell' }, dynamax), el('td', { class: 'max-cell' }, gmax)];
}

/**
 * "Can this Pokemon mega evolve for the raid, and at what Mega Level?" Only shown for species
 * with a mega/primal form. Levels 1-3 don't change raid damage; level 4 (a handful of species)
 * makes the mega fight at +2 levels, so that option says so.
 */
function megaCell(entry, p) {
  if (!p?.tempEvos?.length) return el('span', { class: 'muted', text: '—' });

  const form = el(
    'select',
    {
      disabled: Boolean(entry.shadow),
      title: entry.shadow ? 'Shadow Pokémon can’t mega evolve' : 'Can this one mega evolve?',
      onchange: (e) => {
        entry.mega = e.target.value;
        entry.megaLevel ??= 1;
        renderRoster();
        changed();
      },
    },
    el('option', { value: '', selected: !entry.mega }, 'No'),
    ...p.tempEvos.map((t) => el('option', { value: t.suffix, selected: t.suffix === entry.mega }, t.label)),
    // Both forms unlocked (Raichu X and Y): let the planner weigh them per boss.
    p.tempEvos.length > 1
      ? el('option', { value: MEGA_ANY, selected: entry.mega === MEGA_ANY }, 'Either (best)')
      : null,
  );
  if (!entry.mega) return form;

  const max = p.megaMaxLevel ?? 3;
  const boost = p.megaSelfLevelBoost ?? {};
  const level = el(
    'select',
    {
      class: 'lvl',
      title: 'Mega Level',
      onchange: (e) => {
        entry.megaLevel = Number(e.target.value);
        changed();
      },
    },
    ...Array.from({ length: max }, (_, i) => i + 1).map((l) =>
      el('option', { value: l, selected: l === (entry.megaLevel ?? 1) }, boost[l] ? `Lv ${l} (+${boost[l]} lvl)` : `Lv ${l}`),
    ),
  );
  // Megas eligible for Super Max Level know an extra charged attack while mega evolved, and its
  // power rises with Mega Level -- worth showing, since it's free damage the roster never lists.
  const megaForm = state.gd.pokemon.find(
    (x) => x.id === `${p.id}_${entry.mega === MEGA_ANY ? p.tempEvos[0].suffix : entry.mega}`,
  );
  const plus = megaForm?.plusMove ? state.gd.moves[megaForm.plusMove] : null;

  return el(
    'div',
    { class: 'mega-pick' },
    form,
    level,
    plus
      ? el('small', {
          class: 'muted',
          title: 'Known automatically while mega evolved; power scales with Mega Level',
          text: `+ ${plus.name}`,
        })
      : null,
  );
}

function addToRoster() {
  const a = currentAccount();
  if (!a || !addPickerValue) return;
  const entry = {
    pokemonId: addPickerValue,
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
  };
  (a.roster ??= []).push(entry);
  addPickerValue = null;
  // In a big roster the new row can land past the rows on show: filter to its species so it's in view.
  const query = $('rosterFilter').value.trim().toLowerCase();
  const visible = (query ? sortedRoster(a.roster).filter((e) => monName(e).toLowerCase().includes(query)) : sortedRoster(a.roster)).slice(0, rosterShown);
  if (!visible.includes(entry)) $('rosterFilter').value = monName(entry);
  renderRoster();
  renderAccountTabs();
  changed();
}

// ---------------------------------------------------------------- csv

// Reading and writing the CSV lives in roster-import.js, shared with the scripts in scripts/.

function exportCsv() {
  const a = currentAccount();
  if (!a) return;
  // The byte-order mark makes Excel read the file as UTF-8 (accented names); the import skips it.
  const blob = new Blob(['﻿', rosterToCsv(state.gd, a.roster ?? [])], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `${(a.name || a.id).replace(/\W+/g, '-').toLowerCase()}-roster.csv` });
  getRoot().append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Reads a roster CSV into the current account. "add" keeps the roster and adds what isn't in it
 * yet (a row that is already there can still tick Dynamax / G-Max on it); "replace" swaps the whole
 * roster for the file. Either way the note under the buttons says what happened and what to check.
 */
async function importCsv(file, mode) {
  const a = currentAccount();
  if (!a) return;
  const who = a.name || a.id;
  const parsed = parseRosterCsv(state.gd, await file.text());
  if (parsed.error) return csvNote(`Nothing imported from "${file.name}": ${parsed.error}`, null);
  if (!parsed.roster.length) return csvNote(`Nothing imported: no usable rows in "${file.name}".`, parsed);

  let summary;
  if (mode === 'replace') {
    const had = (a.roster ?? []).length;
    if (had && !confirm(`Replace all ${had} Pokémon in ${who} with the ${parsed.roster.length} from "${file.name}"? This cannot be undone.`)) return;
    a.roster = parsed.roster;
    summary = `Replaced ${who}'s roster with the ${parsed.roster.length} Pokémon in "${file.name}".`;
  } else {
    const m = mergeRoster(a.roster ?? [], parsed.roster, state.gd);
    a.roster = m.roster;
    summary = [
      `Added ${m.added.length} Pokémon to ${who} from "${file.name}"`,
      m.updated.length ? `raised the level of ${m.updated.length} already there (powered up since; moves kept)` : '',
      m.ticked.length ? `ticked Dynamax / G-Max on ${m.ticked.length} already there` : '',
      m.already.length ? `${m.already.length} already there, left alone` : '',
    ]
      .filter(Boolean)
      .join('; ') + '.';
  }
  renderRoster();
  renderAccountTabs();
  changed();
  csvNote(summary, parsed);
}

/** The import's summary, then each group of notes in its own fold; anything that needs a look starts open. */
function csvNote(summary, parsed) {
  const groups = parsed
    ? [
        ['Needs a look', parsed.problems, true],
        ['Form corrected to match the CP', parsed.corrections],
        ['CP not exactly on a level (a best buddy adds one)', parsed.inexact],
        ['IVs solved from a total or stars', parsed.totals],
        [`IVs not given, assumed ${ASSUMED_IV}/${ASSUMED_IV}/${ASSUMED_IV} (marked IV?)`, parsed.assumed],
      ].filter(([, list]) => list?.length)
    : [];
  $('csvNote').replaceChildren(
    el('div', { text: summary }),
    ...groups.map(([title, list, open]) =>
      el('details', { open: Boolean(open) }, el('summary', { text: `${title}: ${list.length}` }), el('ul', {}, ...list.map((t) => el('li', { text: t })))),
    ),
  );
}

// ---------------------------------------------------------------- actions

function wireActions() {
  $('runBtn').onclick = () => run();
  $('addBtn').onclick = () => addToRoster();
  $('exportCsv').onclick = exportCsv;
  // One hidden file picker for both buttons; the button sets what the picked file is for.
  let csvMode = 'add';
  const pickCsv = (mode) => {
    csvMode = mode;
    $('importCsv').click();
  };
  $('addCsvBtn').onclick = () => pickCsv('add');
  $('replaceCsvBtn').onclick = () => pickCsv('replace');
  $('rosterFilter').oninput = debounce(() => {
    rosterShown = ROSTER_PAGE;
    renderRoster();
  }, 150);
  $('rosterTable').querySelector('thead').onclick = (e) => {
    const key = e.target.closest('[data-roster-sort]')?.dataset.rosterSort;
    if (key) cycleRosterSort(key);
  };
  $('importCsv').onchange = (e) => {
    const f = e.target.files?.[0];
    if (f) importCsv(f, csvMode);
    e.target.value = '';
  };

  $('clearRoster').onclick = () => {
    const a = currentAccount();
    if (!a?.roster?.length) return;
    if (!confirm(`Remove all ${a.roster.length} Pokémon from ${a.name}?`)) return;
    a.roster = [];
    renderRoster();
    renderAccountTabs();
    changed();
  };

  $('copyRoster').onclick = () => {
    const from = currentAccount();
    if (!from?.roster?.length) return alert('This account has an empty roster.');
    const others = state.accounts.filter((x) => x.id !== from.id);
    const target = prompt(
      `Copy ${from.roster.length} Pokémon from "${from.name}" to which account?\n\n` +
        others.map((o, i) => `${i + 1}. ${o.name}`).join('\n'),
    );
    const pick = others[Number(target) - 1];
    if (!pick) return;
    pick.roster = from.roster.map((e) => ({ ...e, chargedMoves: [...(e.chargedMoves ?? [])] }));
    renderAccountTabs();
    changed();
  };

  $('resetTuning').onclick = () => {
    state.settings.tuning = { ...DEFAULT_TUNING };
    buildTuningControls();
    changed();
  };

}

// ---------------------------------------------------------------- run

function run() {
  const out = $('results');
  const anyRoster = state.accounts.some((a) => (a.roster ?? []).length);
  if (!anyRoster) {
    out.replaceChildren(el('p', { class: 'muted', text: 'Add some Pokémon to at least one account first.' }));
    return;
  }
  if (!state.settings.bossSpec.pokemonId) {
    const tier = RAID_TIERS[state.settings.bossSpec.tier];
    out.replaceChildren(el('p', { class: 'muted', text: `Pick a boss — the list shows everything that can be a ${tier?.label ?? ''} boss.` }));
    return;
  }

  out.replaceChildren(el('p', { class: 'muted', text: 'Calculating…' }));

  // Let the "Calculating…" paint land before the synchronous solve. setTimeout rather than
  // requestAnimationFrame, which browsers pause entirely while the tab is not visible.
  setTimeout(() => {
    const started = performance.now();
    try {
      const s = state.settings;
      state.result = plan(state.gd, {
        bossSpec: {
          pokemonId: s.bossSpec.pokemonId,
          tier: s.bossSpec.tier,
          fastMove: s.bossSpec.fastMove || undefined,
          chargedMove: s.bossSpec.chargedMove || undefined,
        },
        weather: s.weather,
        purifiedGems: s.purifiedGems,
        tuning: s.tuning,
        friendships: s.friendships,
        accounts: state.accounts.map((a) => ({
          id: a.id,
          name: a.name || a.id,
          active: Boolean(a.active),
          partyPower: a.partyPower || 'off',
          playQuality: a.playQuality ?? 'sharp',
          maxRevives: a.maxRevives ?? null,
          roster: a.roster ?? [],
        })),
      });
      renderResults(state.result, performance.now() - started);
    } catch (err) {
      out.replaceChildren(el('p', { class: 'note warn', text: `Calculation failed: ${err.message}` }));
      console.error(err);
    }
  }, 0);
}

// ---------------------------------------------------------------- results

function renderResults(r, ms) {
  const out = $('results');
  if (r.error) return out.replaceChildren(el('p', { class: 'note warn', text: r.error }));

  const v = r.verdict;
  const allMovesetsWin = v.movesetsTotal === 0 || v.movesetsWon === v.movesetsTotal;
  const clockUsed = v.timeToKill ? v.timeToKill / r.boss.timer : 1;

  let tone = 'lose';
  let title = 'Not with this line-up';
  if (v.won && allMovesetsWin && clockUsed < 0.8) {
    tone = 'win';
    title = 'Yes — should go down';
  } else if (v.won) {
    tone = 'risky';
    title = allMovesetsWin ? 'Yes, but it is tight' : 'Winnable, depends on its moves';
  }

  const bossLine = `${r.boss.name} [${r.boss.types.join('/')}] · ${r.boss.tier} · ${r.boss.hp.toLocaleString()} HP · ${r.boss.timer}s`;

  const verdict = el(
    'div',
    { class: `verdict ${tone}` },
    el(
      'div',
      { class: 'verdict-head' },
      el('span', { class: 'verdict-title', text: title }),
      el('span', { class: 'muted small', text: bossLine }),
    ),
    el(
      'div',
      { class: 'stats' },
      v.won
        ? el('div', { class: 'stat' }, el('b', { text: `${fmt1(v.timeToKill)}s` }), el('span', { text: 'time to kill' }))
        : el('div', { class: 'stat' }, el('b', { text: pct(v.bossHpFracRemaining) }), el('span', { text: 'HP left at timeout' })),
      v.won
        ? el('div', { class: 'stat' }, el('b', { text: `${fmt1(r.boss.timer - v.timeToKill)}s` }), el('span', { text: 'clock to spare' }))
        : el('div', { class: 'stat' }, el('b', { text: pct(v.damageRatio) }), el('span', { text: 'of its HP removed' })),
      v.won
        ? el('div', { class: 'stat' }, el('b', { text: pct(clockUsed) }), el('span', { text: 'of the clock used' }))
        : el('div', { class: 'stat' }, el('b', { text: v.totalDamage.toLocaleString() }), el('span', { text: 'damage dealt' })),
      v.movesetsTotal
        ? el(
            'div',
            { class: 'stat' },
            el('b', { text: `${v.movesetsWon}/${v.movesetsTotal}` }),
            el('span', { text: 'boss movesets beaten' }),
          )
        : null,
      r.boss.isShadow
        ? el('div', { class: 'stat' }, el('b', { text: `${v.enragedSeconds}s` }), el('span', { text: 'spent enraged' }))
        : null,
    ),
  );

  const parts = [verdict];

  // --- accounts that contribute nothing ---
  if (r.emptyAccounts?.length) {
    parts.push(
      el(
        'div',
        { class: 'note warn' },
        el('b', { text: 'Empty rosters: ' }),
        `${r.emptyAccounts.join(', ')} ${r.emptyAccounts.length === 1 ? 'is' : 'are'} marked as playing but ` +
          `${r.emptyAccounts.length === 1 ? 'has' : 'have'} no Pokémon, so ${r.emptyAccounts.length === 1 ? 'it deals' : 'they deal'} ` +
          `no damage here. This verdict is for the accounts that do.`,
      ),
    );
  }

  // --- how much luck is in it ---
  if (v.luck) {
    const when = (o) => (o.won ? `${fmt1(o.timeToKill)}s` : `falls short at ${pct(o.bossHpFracRemaining)} HP left`);
    parts.push(
      el(
        'div',
        { class: `note ${v.luck.anyLoses ? 'warn' : ''}` },
        el('b', { text: 'How much luck is in it: ' }),
        `the headline is an average run. Varying how fast the boss attacks and how often it lands charged moves gives ${when(v.luck.fastest)} to ${when(v.luck.slowest)}.`,
        el('div', {
          class: 'muted small',
          text:
            'That band is narrower than real life: the model averages the boss out rather than simulating it, so a run where it happens to chain charged attacks early lands outside it.',
        }),
        v.luck.anyLoses
          ? el('div', { class: 'muted small', text: 'One end of that band loses the raid — treat this as a coin toss, not a plan.' })
          : null,
      ),
    );
  }

  // --- shadow enrage / gems ---
  if (r.boss.isShadow) {
    const t = r.ctx.tuning;
    let text;
    if (v.enragedAt === null) {
      text = `Never reached ${pct(t.enrageStartHpFrac)} HP, so it never enraged.`;
    } else if (r.ctx.purifiedGems && v.gemCalmSeconds !== null) {
      text =
        `Enrages at ${pct(t.enrageStartHpFrac)} HP (${fmt1(v.enragedAt)}s). ${v.gemThrowers} trainers throwing gems ` +
        `reach ${t.gemsNeeded} in about ${v.gemCalmSeconds}s (max ${t.gemsPerPlayer} each, ${t.gemCooldown}s per throw), ` +
        `so it spends ~${v.enragedSeconds}s enraged instead of fighting enraged down to ${pct(t.enrageEndHpFrac)}.`;
    } else if (r.ctx.purifiedGems) {
      text = `Gems can't calm it: ${v.gemThrowers} active trainer(s) × ${t.gemsPerPlayer} gems is short of the ${t.gemsNeeded} needed.`;
    } else {
      text = `Enrages at ${pct(t.enrageStartHpFrac)} HP and stays enraged until ${pct(t.enrageEndHpFrac)} — attack ${t.enrageAtkMult}×base+15, defence ${t.enrageDefMult}×base+15.`;
    }
    parts.push(el('div', { class: `note ${r.ctx.purifiedGems ? '' : 'warn'}` }, el('b', { text: 'Shadow boss: ' }), text));
  }

  // --- what the boss moveset does to the answer ---
  if (v.movesetsTotal > 1) {
    const worst = v.worstMoveset;
    const best = v.bestMoveset;
    parts.push(
      el(
        'div',
        { class: `note ${allMovesetsWin ? '' : 'warn'}` },
        el('div', {}, el('b', { text: 'Boss moveset matters. ' }), `Beat ${v.movesetsWon} of ${v.movesetsTotal} possible movesets.`),
        el('div', { class: 'muted small' },
          `Worst case ${worst.fast} / ${worst.charged} — ${worst.won ? `kill at ${fmt1(worst.timeToKill)}s` : `stalls at ${pct(1 - worst.damageRatio)} HP left`}. ` +
            `Best case ${best.fast} / ${best.charged} — ${best.won ? `kill at ${fmt1(best.timeToKill)}s` : `${pct(1 - best.damageRatio)} HP left`}.`),
      ),
    );
  }

  // --- mega boost ---
  if (r.megaBoosts?.length) {
    const c = state.gd.constants;
    parts.push(
      el(
        'div',
        { class: 'note' },
        el('b', { text: 'Mega boost: ' }),
        `every attacker in the raid gets ×${c.megaAllySameType} on the boosted types and ×${c.megaAllyDifferentType} on everything else. ` +
          `Boosts don't stack — each attack takes the best one on offer. A mega normally boosts only while it's on the field.`,
        el(
          'ul',
          { class: 'assume' },
          ...r.megaBoosts.map((m) =>
            el('li', {
              text:
                `${m.from}: ${m.pokemon} — boosts ${m.types.map(titleCase).join('/')}` +
                (m.persists
                  ? ' — keeps boosting from the bench and after fainting, for the whole fight'
                  : m.uptime
                    ? ` — about ${fmt1(m.uptime)}s on the field${m.active ? ' per stint' : ' before it faints'}`
                    : ''),
            }),
          ),
        ),
      ),
    );
  }

  if (r.trace?.length) parts.push(hpChart(r));

  // --- teams ---
  parts.push(el('h3', { text: 'Recommended line-ups' }));
  for (const t of r.teams) parts.push(teamCard(t, r));

  // --- mega backups ---
  const withBackups = (r.megaBackups ?? []).filter((b) => b.rows.length);
  if (withBackups.length) {
    parts.push(el('h3', { text: 'If a mega is on cooldown' }));
    parts.push(
      el('p', {
        class: 'muted small',
        text: 'One mega per trainer, and megas go on cooldown. Each row re-runs the raid with that Pokémon mega evolved instead, so you know what to reach for next.',
      }),
    );
    for (const b of withBackups) parts.push(megaBackupTable(b, r));
  }


  // --- playstyle comparison ---
  if (r.playstyleComparison.length) {
    parts.push(el('h3', { text: 'Playstyle, per played account' }));
    parts.push(
      el('p', { class: 'muted small', text: 'Each row holds the other accounts at their recommended setting and changes only this one.' }),
    );
    for (const c of r.playstyleComparison) parts.push(playstyleTable(c, r));
  }

  parts.push(assumptions(r, ms));
  out.replaceChildren(...parts);
}

/** How to play this Pokemon's moves, including where Party Power should go. */
function movesAdvice(m, t) {
  const base = `${m.fast} / ${m.charged}`;
  if (!t.active || t.partyPower === 'off') return el('span', { text: base });
  let pp;
  if (m.ppCharged) pp = `${m.charged} in between, save each Party Power for ${m.ppCharged}`;
  else if (m.ppEvery === 1) pp = `every ${m.charged} lands doubled`;
  else if (m.ppEvery) pp = `Party Power lands on about 1 in ${m.ppEvery} charged moves`;
  else pp = `time ${/^[aeiou]/i.test(m.charged) ? 'an' : 'a'} ${m.charged} to each Party Power fill`;
  return el(
    'span',
    {},
    base,
    el('div', { class: 'muted small', text: `${pp} · +${Math.round(m.ppGain * 100)}% from Party Power` }),
    m.movesWithoutPartyPower
      ? el('div', { class: 'muted small', text: `(without Party Power, ${m.movesWithoutPartyPower} is better)` })
      : null,
  );
}

function teamCard(t, r) {
  const rows = t.members.map((m, i) =>
    el(
      'tr',
      {},
      el('td', { class: 'num muted', text: i + 1 }),
      el(
        'td',
        { class: 'mon-name' },
        m.name,
        m.isMega ? ' ' : null,
        m.isMega ? el('span', { class: 'badge mega', text: 'mega evolve' }) : null,
        m.usesPlusMove
          ? el('span', {
              class: 'badge mega',
              title: `${m.plusMove} is known automatically while mega evolved — it doesn't take a move slot`,
              text: 'mega-only move',
            })
          : null,
        m.anyMoves ? el('span', { class: 'badge', title: 'Moves set to Any (best) — may be optimistic', text: 'any moves' }) : null,
        m.tm
          ? el('span', {
              class: `badge tm${m.tm.changes.some((c) => c.elite) ? ' elite' : ''}`,
              title: `${m.tm.changes.map((c) => `${c.from} → ${c.to} (${tmCost(c)})`).join(' and ')}: ${tmEffect(m.tm)}. More on the Upgrades page.`,
              text: `TM → ${m.tm.changes.map((c) => c.to).join(' + ')}`,
            })
          : null,
      ),
      el('td', { class: 'muted small', text: `L${m.level}${m.effectiveLevel !== m.level ? ` (fights as ${m.effectiveLevel})` : ''} ${m.ivs.join('/')}` }),
      el('td', { class: 'small' }, movesAdvice(m, t)),
      el('td', { class: 'num', text: fmt1(m.dps) }),
      el('td', { class: 'num', text: m.tdo.toLocaleString() }),
      el('td', { class: 'num muted', text: m.ttf === null ? '—' : `${fmt1(m.ttf)}s` }),
    ),
  );

  const res = t.result;
  return el(
    'div',
    { class: 'team-card' },
    el(
      'div',
      { class: 'team-head' },
      el('b', { text: t.name }),
      el(
        'span',
        { class: 'pill-row' },
        t.active
          ? el('span', { class: 'badge style', text: t.playstyleLabel })
          : el('span', { class: 'badge idle', text: 'idle — holds the field only' }),
        t.active && t.partyPower !== 'off'
          ? el('span', { class: 'badge', text: t.partyPower === 'optimal' ? 'Party Power (timed)' : 'Party Power' })
          : null,
        t.active && t.playQuality && t.playQuality !== 'sharp'
          ? el('span', { class: 'badge idle', text: t.playQuality === 'distracted' ? 'distracted' : 'average play' })
          : null,
        el('span', { class: 'badge', text: `${FRIENDSHIP.find((f) => f.id === t.friendship)?.label ?? '—'} bonus` }),
        res
          ? el('span', {
              class: 'badge',
              text: t.active
                ? `${res.damage.toLocaleString()} dmg · ${pct(res.share)} of total`
                : 'no damage',
            })
          : null,
        res && res.relobbies ? el('span', { class: 'badge', text: `${res.relobbies}× relobby` }) : null,
        // Only meaningful for accounts that were actually attacking; an idle account always
        // "runs out" the moment its single lead faints.
        res && res.ranOut && t.active ? el('span', { class: 'badge idle', text: 'ran out of Pokémon' }) : null,
      ),
    ),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: '#' }),
            el('th', { text: 'Pokémon' }),
            el('th', { text: 'Level / IV' }),
            el('th', { text: 'Moves used' }),
            el('th', { class: 'num', text: 'DPS' }),
            el('th', { class: 'num', text: 'Damage' }),
            el('th', { class: 'num', text: 'Survives' }),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    ),
  );
}

/** Ranked mega fallbacks for one account, with what each costs versus the best. */
function megaBackupTable(b, r) {
  const rows = b.rows.map((row) =>
    el(
      'tr',
      { class: row.best ? 'chosen' : '' },
      el('td', { class: row.noMega ? 'muted' : '' }, row.pokemon),
      el('td', { class: 'num muted', text: row.dps === null ? '—' : fmt1(row.dps) }),
      el('td', { text: row.won ? 'wins' : 'falls short' }),
      el('td', { class: 'num', text: row.won ? `${fmt1(row.timeToKill)}s` : pct(row.damageRatio) }),
      el('td', {
        class: 'num muted',
        text: row.best ? 'best' : row.cost === null ? '—' : `+${fmt1(row.cost)}s`,
      }),
    ),
  );
  return el(
    'div',
    { class: 'team-card' },
    el('div', { class: 'team-head' }, el('b', { text: b.name })),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: 'Mega evolve' }),
            el('th', { class: 'num', text: 'Its DPS' }),
            el('th', { text: 'Outcome' }),
            el('th', { class: 'num', text: 'Kill / HP removed' }),
            el('th', { class: 'num', text: 'Cost' }),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    ),
  );
}

function playstyleTable(c, r) {
  const rows = c.rows.map((row) =>
    el(
      'tr',
      { class: row.chosen ? 'chosen' : '' },
      el('td', { text: row.label }),
      el('td', { text: row.won ? 'wins' : 'falls short' }),
      el('td', { class: 'num', text: row.won ? `${fmt1(row.timeToKill)}s` : pct(row.damageRatio) }),
      el('td', { class: 'num', text: row.accountDamage.toLocaleString() }),
    ),
  );
  return el(
    'div',
    { class: 'team-card' },
    el('div', { class: 'team-head' }, el('b', { text: c.name })),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: 'Playstyle' }),
            el('th', { text: 'Outcome' }),
            el('th', { class: 'num', text: 'Kill / HP removed' }),
            el('th', { class: 'num', text: 'This account' }),
          ),
        ),
        el('tbody', {}, ...rows),
      ),
    ),
  );
}

/** Boss HP over time, with the enraged stretch shaded. */
function hpChart(r) {
  const W = 560;
  const H = 130;
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const maxT = r.boss.timer;

  const x = (t) => pad.l + (t / maxT) * iw;
  const y = (hp) => pad.t + (1 - hp / r.boss.hp) * ih;

  const pts = r.trace.map((p) => `${x(p.t).toFixed(1)},${y(p.bossHp).toFixed(1)}`).join(' ');

  const enraged = r.trace.filter((p) => p.enraged);

  const svgns = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs) => {
    const n = document.createElementNS(svgns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  svg.setAttribute('aria-label', 'Boss HP over time');

  // axes + gridlines
  for (const frac of [0, 0.5, 1]) {
    const yy = pad.t + frac * ih;
    svg.append(s('line', { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy, stroke: 'currentColor', opacity: 0.15 }));
    const label = s('text', { x: 2, y: yy + 4, fill: 'currentColor', opacity: 0.55, 'font-size': 10 });
    label.textContent = `${Math.round((1 - frac) * 100)}%`;
    svg.append(label);
  }
  for (const t of [0, maxT / 2, maxT]) {
    const label = s('text', { x: x(t), y: H - 4, fill: 'currentColor', opacity: 0.55, 'font-size': 10, 'text-anchor': t === 0 ? 'start' : t === maxT ? 'end' : 'middle' });
    label.textContent = `${t}s`;
    svg.append(label);
  }

  if (enraged.length > 1) {
    const rect = s('rect', {
      x: x(enraged[0].t),
      y: pad.t,
      width: Math.max(1, x(enraged[enraged.length - 1].t) - x(enraged[0].t)),
      height: ih,
      fill: 'currentColor',
      opacity: 0.1,
    });
    svg.append(rect);
  }

  svg.append(s('polyline', { points: pts, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));

  const wrap = el('div', {});
  wrap.append(svg);
  wrap.append(
    el('div', {
      class: 'muted small',
      text: enraged.length
        ? 'Boss HP over the raid clock. Shaded stretch is the enraged phase.'
        : 'Boss HP over the raid clock.',
    }),
  );
  return wrap;
}

function assumptions(r, ms) {
  const t = r.ctx.tuning;
  const anyAuto = state.accounts.some((a) =>
    (a.roster ?? []).some((e) => !e.fastMove || !(e.chargedMoves ?? []).length),
  );

  return el(
    'details',
    {},
    el('summary', { text: 'What this assumed' }),
    el(
      'ul',
      { class: 'assume' },
      el('li', { text: 'Cycle-DPS model: average fast/charged loop, no dodging, continuous tapping.' }),
      el('li', {
        text:
          `Boss adds ${t.bossMoveDelay}s after each move and, once it can afford its charged move, fires it ` +
          `${pct(t.bossChargedChance)} of the time after a fast attack. It gains energy from its fast move and ` +
          `0.5 per HP the group takes off it, so in a group raid it's rarely short of energy.`,
      }),
      el('li', { text: `${t.faintDelay}s lost per faint; ${t.relobbyTime}s per relobby.` }),
      el('li', {
        text:
          `Party Power fills after ${t.partyPowerFastAttacks} of your own fast attacks and doubles the next charged move. ` +
          `“Timed” players spend every fill on a charged move — sometimes a bigger one than they use in between.`,
      }),
      el('li', { text: 'Friendship: each account gets its best friendship level with anyone in the lobby.' }),
      el('li', {
        text: `Party of ${r.partySize} (accounts marked "in party", idle ones included). Each player has their own Party Power meter; in a party of ${r.partySize} it refills every ${t[`partyPowerFastAttacks${Math.min(4, r.partySize)}`] ?? '?'} of that account's own fast attacks, with no cap per raid — so an idle account in the party never charges one.`,
      }),
      el('li', {
        text: 'One mega per trainer. Mega Levels 1–3 don’t change raid damage; Level 4 makes the mega fight 2 levels higher.',
      }),
      el('li', { text: 'Raid boss HP and CP multiplier are community values — the game master does not publish them.' }),
      anyAuto
        ? el('li', {
            html: '<b>Some Pokémon have moves set to “Any (best)”</b> — the model assumes the ideal moveset for those, which can be optimistic. Pin the real moves for a truer answer.',
          })
        : null,
      el('li', { class: 'muted', text: `Solved in ${Math.round(ms)}ms.` }),
    ),
  );
}

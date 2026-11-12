/**
 * The Max Battle view (the Dynamax tab): pick a boss, see whether your playing accounts can take it
 * down, with which teams, and how much the answer depends on the numbers the game doesn't publish.
 *
 * The maths is in maxbattle.js. This view keeps its settings inside the saved state
 * (settings.maxBattle) so they ride along with rosters, backups and the local server.
 */
import { MAX_TIERS, MAX_TUNING, resolveMaxTuning, maxBossCandidates, solveMax, fitDamageScale, canDynamax } from './maxbattle.js';
import { $, el, debounce, fmt1, pct } from './ui.js';
import { makeCombo, getSaved, markChanged, onStateReload } from './app.js';

let gd = null;
let solved = null;
let bossCombo = null;
let started = false;
let calib = { seconds: '', message: '' };

const DEFAULT_BOSS = { pokemonId: 'REGISTEEL', tier: 'T5' };
const titleCase = (t) => t.charAt(0) + t.slice(1).toLowerCase();
const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${fmt1(s)}s`);

/** This view's slice of the saved settings, created on first use. */
function cfg() {
  const s = getSaved().settings;
  const m = (s.maxBattle ??= {});
  m.boss ??= { ...DEFAULT_BOSS };
  if (!MAX_TIERS[m.boss.tier]) m.boss.tier = DEFAULT_BOSS.tier;
  if (m.boss.pokemonId && !maxBossCandidates(gd, m.boss.tier).some((p) => p.id === m.boss.pokemonId)) m.boss.pokemonId = '';
  m.tuning ??= {};
  // dropped settings (the old "assumeGmax" switch, now a per-Pokémon flag) shouldn't linger in saves
  for (const key of Object.keys(m.tuning)) if (!(key in MAX_TUNING)) delete m.tuning[key];
  return m;
}

export function startMax({ gd: data }) {
  gd = data;
  started = true;
  buildControls();
  $('maxRun').onclick = solve;
  // a restore replaces every setting, so redraw from the new ones
  onStateReload(() => {
    buildControls();
    solve();
  });
}

/** Called whenever the view is shown: rosters are edited on the Raid tab, so solve again. */
export function showMax() {
  if (started) solve();
}

// ---------------------------------------------------------------- controls

const schedule = debounce(() => solve(), 250);
function changed() {
  markChanged();
  schedule();
}

/** Stores a tuning value, keeping only the ones that differ from the default. */
function setTuning(key, value) {
  const t = cfg().tuning;
  if (value === MAX_TUNING[key].value) delete t[key];
  else t[key] = value;
}

function buildControls() {
  const c = cfg();
  const tier = $('maxTier');
  tier.replaceChildren(
    ...Object.values(MAX_TIERS).map((t) => el('option', { value: t.id, selected: t.id === c.boss.tier }, `${t.label} · ${t.hp.toLocaleString()} HP`)),
  );
  tier.onchange = () => {
    const b = cfg().boss;
    b.tier = tier.value;
    if (b.pokemonId && !maxBossCandidates(gd, b.tier).some((p) => p.id === b.pokemonId)) {
      b.pokemonId = '';
      bossCombo.clear();
    }
    changed();
  };
  bossCombo = makeCombo($('maxBossPicker'), {
    value: c.boss.pokemonId,
    placeholder: 'Search a boss…',
    items: () => maxBossCandidates(gd, cfg().boss.tier),
    emptyText: 'Not a boss in this tier',
    onPick: (p) => {
      cfg().boss.pokemonId = p.id;
      changed();
    },
  });
  buildTuning();
  $('maxResetTuning').onclick = () => {
    cfg().tuning = {};
    buildTuning();
    changed();
  };
}

const STATUS_GROUPS = [
  ['guess', 'Guesses — nothing is published', 'Placeholders. These move the answer most; calibrate them against a battle you fought.'],
  ['choice', 'Modelling choices', 'Decisions about what to assume, not game numbers.'],
  ['sourced', 'From community figures', 'Reported by write-ups that agree, but not confirmed by the game files.'],
];

function buildTuning() {
  const current = resolveMaxTuning(cfg().tuning);
  const field = ([key, t]) => {
    const input =
      typeof t.value === 'boolean'
        ? el('input', {
            type: 'checkbox',
            checked: current[key],
            onchange: (e) => {
              setTuning(key, e.target.checked);
              changed();
            },
          })
        : el('input', {
            type: 'number',
            value: current[key],
            min: t.min,
            max: t.max,
            step: t.step,
            'data-key': key,
            oninput: (e) => {
              const v = Number(e.target.value);
              if (e.target.value !== '' && Number.isFinite(v)) {
                setTuning(key, v);
                changed();
              }
            },
          });
    const label = el('span', { text: t.label });
    return typeof t.value === 'boolean'
      ? el('label', { class: 'field checkbox' }, input, label, el('small', { class: 'muted', text: t.note }))
      : el('label', { class: 'field' }, label, el('small', { class: 'muted', text: t.note }), input);
  };
  $('maxTuningGrid').replaceChildren(
    ...STATUS_GROUPS.map(([status, title, blurb]) =>
      el(
        'div',
        { class: 'tune-group' },
        el('h4', { text: title }),
        el('p', { class: 'muted small', text: blurb }),
        el('div', { class: 'grid' }, ...Object.entries(MAX_TUNING).filter(([, t]) => t.status === status).map(field)),
      ),
    ),
  );
}

// ---------------------------------------------------------------- solving and rendering

/** Shown while no roster anywhere has a Pokémon ticked Dynamax: there is nothing to solve with. */
function noDynamaxState() {
  return el(
    'div',
    { class: 'note' },
    el('b', { text: 'No Dynamax Pokémon yet. ' }),
    'This solver only uses Pokémon that can join Max Battles, and none are ticked. On the ',
    el('a', { href: '#raid', text: 'Raid tab' }),
    ', tick ',
    el('b', { text: 'Dynamax' }),
    ' in each account’s roster for the Pokémon that can Dynamax, and ',
    el('b', { text: 'G-Max' }),
    ' for the ones that can Gigantamax. Rosters saved before these boxes existed start with every box unticked.',
  );
}

function solve() {
  const out = $('maxOut');
  const c = cfg();
  if (!getSaved().accounts.some((a) => (a.roster ?? []).some(canDynamax))) {
    solved = null;
    $('maxStatus').textContent = '';
    out.replaceChildren(noDynamaxState());
    return;
  }
  if (!c.boss.pokemonId) {
    solved = null;
    $('maxStatus').textContent = '';
    out.replaceChildren(el('p', { class: 'muted', text: 'Pick a boss.' }));
    return;
  }
  try {
    const t0 = performance.now();
    solved = solveMax(gd, c.boss, getSaved().accounts, c.tuning);
    $('maxStatus').textContent = `Solved in ${Math.round(performance.now() - t0)}ms.`;
    render();
  } catch (err) {
    solved = null;
    out.replaceChildren(el('p', { class: 'note warn', text: `Calculation failed: ${err.message}` }));
    console.error(err);
  }
}

const stat = (value, label) => el('div', { class: 'stat' }, el('b', { text: value }), el('span', { text: label }));

function render() {
  const out = $('maxOut');
  const s = solved;
  if (s.error) return out.replaceChildren(el('p', { class: 'note warn', text: s.error }));

  const r = s.result;
  const fainted = r.faints.length;
  const total = s.trainers.reduce((n, t) => n + t.team.length, 0);
  const cls = !r.win ? 'lose' : fainted >= Math.ceil(total / 2) ? 'risky' : 'win';
  const timedOut = !r.win && r.reason === 'time limit';
  const title = timedOut ? `No — not finished in ${fmtTime(r.time)}` : !r.win ? 'No — the boss wins' : fainted ? 'Yes — but it costs Pokémon' : 'Yes — should go down';
  const phases = r.trainers.reduce((n, t) => n + t.phases, 0);
  const attacks = r.trainers.reduce((n, t) => n + t.maxAttacks, 0);

  const verdict = el(
    'div',
    { class: `verdict ${cls}` },
    el(
      'div',
      { class: 'verdict-head' },
      el('span', { class: 'verdict-title', text: title }),
      el('span', { class: 'muted', text: `${s.boss.name} [${s.boss.types.join('/')}] · ${s.boss.tier.label} · ${r.bossHp.toLocaleString()} HP` }),
    ),
    el(
      'div',
      { class: 'stats' },
      r.win ? stat(fmtTime(r.time), 'time to kill') : stat(pct(r.hpLeft / r.bossHp), 'of the boss left'),
      stat(String(phases), 'Max phases'),
      stat(String(attacks), 'Max Attacks'),
      stat(`${fainted}/${total}`, 'fainted'),
    ),
    el('p', { class: 'small', text: strategyText(s) + (r.win ? '' : timedOut ? ` The boss was still standing when the model stopped at ${fmtTime(r.time)}.` : ` Every Pokémon had fainted after ${fmtTime(r.time)}.`) }),
  );

  out.replaceChildren(
    verdict,
    ...s.trainers.map((t, i) => teamCard(t, i, r.trainers[i], r)),
    calibrationBox(),
    sensitivityTable(s),
    assumptions(s),
  );
}

function strategyText(s) {
  const tank = s.trainers.find((t) => t.tank);
  const parts = [];
  if (tank) parts.push(`${tank.name} tanks: its lead opens each Max phase with Max Guard and Max Spirit and soaks the boss's attacks while the others attack.`);
  else parts.push('Everyone attacks in every Max phase.');
  if (s.strategy.healBelow > 0) parts.push(`A Max phase opens with Max Spirit when the lead is under ${pct(s.strategy.healBelow)} HP.`);
  return parts.join(' ');
}

function teamCard(t, index, stats, r) {
  const rows = t.team.map((m) => {
    const down = r.faints.find((f) => f.trainer === index && f.name === m.name);
    return el(
      'tr',
      {},
      el('td', { class: 'mon-name' }, m.name, m.gmax ? el('span', { class: 'badge mega', title: 'Gigantamax: fixed Max Attack type, +100 power', text: 'G-Max' }) : null),
      el('td', { text: m.fast.name }),
      el('td', { text: `${titleCase(m.maxType)}` }),
      el('td', { class: 'num', text: Math.round(m.maxDmg).toLocaleString() }),
      el('td', { class: 'num', text: String(m.hp) }),
      el('td', { class: down ? 'warn-text' : '', text: down ? `fainted at ${fmtTime(down.at)}` : '' }),
    );
  });
  const share = stats.damage ? `${stats.damage.toLocaleString()} damage` : 'no damage';
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
        t.tank ? el('span', { class: 'badge style', text: 'tank' }) : null,
        stats.out ? el('span', { class: 'badge idle', text: 'out of Pokémon' }) : null,
        el('span', { class: 'badge', text: `${stats.phases} Max phases · ${stats.maxAttacks} Max Attacks · ${share}` }),
      ),
    ),
    el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...['Pokémon', 'Fast move', 'Max Attack type', 'Damage per Max Attack', 'HP', ''].map((h, i) => el('th', { class: i === 3 || i === 4 ? 'num' : '', text: h })))),
        el('tbody', {}, ...rows),
      ),
    ),
    t.candidates > t.team.length ? el('p', { class: 'muted small', text: `Chosen from ${t.candidates} Dynamax Pokémon in the roster.` }) : null,
  );
}

function calibrationBox() {
  const input = el('input', { type: 'number', min: '1', step: '1', value: calib.seconds, placeholder: 'seconds', style: 'width:90px' });
  input.addEventListener('input', () => (calib.seconds = input.value));
  const button = el('button', { type: 'button', class: 'ghost', text: 'Fit damage scale' });
  button.onclick = () => {
    const fit = fitDamageScale(gd, cfg().boss, solved, Number(calib.seconds));
    if (fit.error) calib.message = fit.error;
    else {
      setTuning('damageScale', fit.scale);
      buildTuning();
      markChanged();
      solve();
      // report what the re-solved teams really do, which can differ slightly from the fixed teams the fit used
      const r = solved?.result;
      calib.message = r?.win
        ? `Damage scale set to ${fit.scale}; the model now takes ${fmtTime(r.time)}.`
        : `Damage scale set to ${fit.scale}, but the teams the solver picks still don't win; see the verdict.`;
      if (solved && !solved.error) render();
      return;
    }
    render();
  };
  return el(
    'div',
    { class: 'note' },
    el('b', { text: 'Calibrate. ' }),
    'If you fought this boss with a team like this and won, how many seconds did it take? ',
    input,
    ' ',
    button,
    calib.message ? el('div', { class: 'muted small', text: calib.message }) : null,
  );
}

function sensitivityTable(s) {
  const outcome = (r) =>
    r.win
      ? { text: `wins in ${fmtTime(r.time)}`, bad: false }
      : r.reason === 'time limit'
        ? { text: `not done after ${fmtTime(r.time)} (${pct(r.hpLeft / r.bossHp)} left)`, bad: true }
        : { text: `loses: all fainted (${pct(r.hpLeft / r.bossHp)} of the boss left)`, bad: true };
  const keys = [...new Set(s.sensitivity.map((x) => x.key))];
  const rows = keys.map((key) => {
    const at = (factor) => s.sensitivity.find((x) => x.key === key && x.factor === factor);
    const cell = (factor) => {
      const row = at(factor);
      if (!row) return el('td', { text: '—' });
      const o = outcome(row.result);
      return el('td', { class: o.bad ? 'warn-text' : '', text: o.text });
    };
    return el('tr', {}, el('td', { text: MAX_TUNING[key].label }), cell(0.5), cell(2));
  });
  const base = outcome(s.result);
  return el(
    'div',
    {},
    el('h3', { text: 'What the answer depends on' }),
    el('p', { class: 'muted small', text: `Same teams, one shaky number halved or doubled. Today: ${base.text}. If the answer flips here, treat the verdict with care.` }),
    el(
      'div',
      { class: 'table-scroll' },
      el('table', {}, el('thead', {}, el('tr', {}, ...['Assumption', 'Halved', 'Doubled'].map((h) => el('th', { text: h })))), el('tbody', {}, ...rows)),
    ),
  );
}

function assumptions(s) {
  const t = s.tuning;
  return el(
    'ul',
    { class: 'assume' },
    el('li', { text: `Boss HP is a modelled figure (${s.boss.tier.label}: ${s.boss.tier.hp.toLocaleString()}); the game does not publish it.` }),
    el('li', { text: `Max Attack power is community-reported: Dynamax 250/300/350 and Gigantamax 350/400/450 by Max level; every Pokémon is assumed at level ${t.maxLevel}.` }),
    el('li', { text: 'Damage uses the normal Pokémon GO formula with that power, STAB and type effectiveness. Fast attacks fill the Max meter; a full meter opens a three-move Max phase.' }),
    el('li', { text: `The boss is modelled as one ${titleCase(s.boss.types[0])} attack of power ${t.bossMovePower} every ${t.bossAttackInterval}s (a dual-type boss uses its first type), hitting a Pokémon with Shields first, otherwise taking turns.` }),
    el('li', { text: 'Fainted Pokémon stay down (no revives). Shadow Pokémon cannot take part.' }),
    el('li', { text: 'Only Pokémon ticked Dynamax in the roster take part. Those ticked G-Max (possible for the 17 Gigantamax species only) use their G-Max move, whose type is fixed; the others’ Max Attack takes the type of their Fast move.' }),
    el('li', { class: 'muted', text: 'Up to three Pokémon per account, from the accounts marked as playing on the Raid tab.' }),
  );
}

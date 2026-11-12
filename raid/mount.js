/**
 * Puts the raid calculator (Raid and Upgrades views) and the Max Battle solver into one host element.
 * The page's Raid tab and Dynamax tab both show this host; showTool() picks which views are on offer.
 *
 * It renders into a shadow root so its stylesheet, which styles bare elements like button and table,
 * cannot collide with the page's. Loaded on demand by shell.js the first time the Raid tab opens.
 */
import { setRoot, $ } from './ui.js';
import { MARKUP } from './markup.js';
import { startRaid, getSaved, restoreState } from './app.js';
import { startUpgrades, showUpgrades } from './upgrades.js';
import { startMax, showMax } from './max-ui.js';

const here = new URL('./', import.meta.url);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `storage` is the shared backend from storage.js: {kind, label, load(), save()}. Returns { showTool(tool) }. */
export async function mountRaid(host, storage) {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<link rel="stylesheet" href="${new URL('raid.css', here)}">${MARKUP}`;
  setRoot(root);

  // Wait for the stylesheet so the page doesn't flash unstyled.
  const css = root.querySelector('link');
  const cssReady = new Promise((done) => {
    css.addEventListener('load', done);
    css.addEventListener('error', done);
  });
  const dataUrl = new URL('gamedata.json', here);
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error(`Could not load the game data (${res.status}).`);
  const gd = await res.json();
  await cssReady;

  await startRaid({ gd, storage });
  startUpgrades({ gd, getSaved });
  startMax({ gd });
  const tools = wireViews();
  wireBackup(storage);
  return tools;
}

function wireViews() {
  const views = { raid: $('view-raid'), upgrades: $('view-upgrades'), max: $('view-max') };
  const nav = $('raidNav');
  const buttons = [...nav.querySelectorAll('[data-view]')];
  let raidView = 'raid'; // which of Raid / Upgrades the Raid tab was last on
  const show = (name) => {
    for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
    for (const b of buttons) {
      b.classList.toggle('active', b.dataset.view === name);
      b.toggleAttribute('aria-current', b.dataset.view === name);
    }
    if (name === 'upgrades') showUpgrades();
    if (name === 'max') showMax();
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      raidView = b.dataset.view;
      show(raidView);
    });
  }
  return {
    showTool(tool) {
      nav.hidden = tool === 'dynamax';
      show(tool === 'dynamax' ? 'max' : raidView);
    },
  };
}

/** Backup/restore of every account in one JSON file, and a line saying where rosters are kept. */
function wireBackup(storage) {
  const { serializeState, parseImport } = globalThis.PogoStorage;
  const note = $('storageNote');
  const say = (text) => (note.textContent = text);
  const where = () =>
    storage.kind === 'server'
      ? `Saved in ${storage.label}: each account is a plain JSON file you can edit by hand.`
      : `Saved in ${storage.label} only, never uploaded. Clearing site data erases it and other browsers start empty, so back up now and then.`;
  say(where());

  $('backupAll').onclick = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([serializeState(getSaved())], { type: 'application/json' }));
    link.download = `pogo-rosters-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    say(`Backed up ${plural(getSaved().accounts.length, 'account')}. ${where()}`);
  };

  $('restoreAll').onclick = () => $('restoreFile').click();
  $('restoreFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // so picking the same file again still fires
    if (!file) return;
    try {
      const incoming = parseImport(await file.text());
      const current = getSaved().accounts.length;
      const ok = confirm(
        `Replace all ${plural(current, 'account')} here with the ${plural(incoming.accounts.length, 'account')} from "${file.name}"? This cannot be undone.`,
      );
      if (!ok) return say(`Restore cancelled. ${where()}`);
      say((await restoreState(incoming)) ? `Restored ${plural(incoming.accounts.length, 'account')}. ${where()}` : 'Restored on screen, but saving failed.');
    } catch (err) {
      say(`Restore failed: ${err.message}`);
    }
  };
}

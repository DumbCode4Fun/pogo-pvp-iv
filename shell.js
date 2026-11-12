/**
 * The page shell: switches between the PvP, Raid and Dynamax tools. The PvP tool is already running
 * (app.js). The Raid and Dynamax tabs share one panel and one ES module bundle (raid/), loaded the first
 * time either opens; the bundle decides which of its views to show.
 */
(() => {
  const TABS = ['pvp', 'raid', 'dynamax'];
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- tabs

  const tabFromHash = () => {
    const name = location.hash.slice(1);
    return TABS.includes(name) ? name : 'pvp';
  };

  // The Raid and Dynamax tabs are both views of the one tools panel.
  const panelOf = (tab) => (tab === 'pvp' ? 'pvp' : 'raid');

  function showTab(tab) {
    for (const name of ['pvp', 'raid']) $(`app-${name}`).hidden = name !== panelOf(tab);
    for (const b of document.querySelectorAll('[data-app-tab]')) b.setAttribute('aria-selected', String(b.dataset.appTab === tab));
    if (tab === 'pvp') return;
    // The bundle may still be loading; only apply the result if this tab is still the one showing.
    ensureRaid()?.then((tools) => {
      if (tools && tabFromHash() === tab) tools.showTool(tab);
    });
  }

  document.querySelector('.app-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-app-tab]')?.dataset.appTab;
    if (tab) location.hash = tab; // the hashchange handler does the switching, so Back works
  });
  window.addEventListener('hashchange', () => showTab(tabFromHash()));

  // ---------------------------------------------------------------- raid tool

  let mounting = null;

  /** Loads and mounts the bundle once, resolving to its { showTool }; a failure can be retried by reopening the tab. */
  function ensureRaid() {
    if (mounting) return mounting;
    const status = $('raid-status');
    status.hidden = false;
    status.classList.remove('error');

    // Browsers refuse ES modules from file://, and the raid code is made of them.
    if (location.protocol === 'file:') {
      status.textContent = 'The Raid and Dynamax tabs need the page to be served over http. Run "node pvp-iv/serve.mjs" and open http://localhost:8788, or use the published site.';
      status.classList.add('error');
      return null;
    }
    status.textContent = 'Loading…';

    mounting = (async () => {
      const storage = await PogoStorage.shared();
      const { mountRaid } = await import('./raid/mount.js');
      const tools = await mountRaid($('raid-host'), storage);
      status.hidden = true;
      return tools;
    })().catch((err) => {
      mounting = null;
      console.error(err);
      status.textContent = `The raid and Max Battle tools failed to load: ${err.message}`;
      status.classList.add('error');
      // a half-built shadow root cannot be attached again, so retry on a fresh host element
      const fresh = document.createElement('div');
      fresh.id = 'raid-host';
      $('raid-host').replaceWith(fresh);
    });
    return mounting;
  }

  showTab(tabFromHash());
})();

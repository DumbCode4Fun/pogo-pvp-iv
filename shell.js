/**
 * The page shell: switches between the PvP, Raid, Dynamax and Box tools. The PvP tool is already
 * running (app.js). The Raid, Dynamax and Box tabs share one panel and one ES module bundle (raid/),
 * loaded the first time any of them opens; the bundle decides which of its views to show.
 */
(() => {
  const TABS = ['pvp', 'raid', 'dynamax', 'box'];
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- tabs

  const tabFromHash = () => {
    const name = location.hash.slice(1);
    return TABS.includes(name) ? name : 'pvp';
  };

  // The Raid, Dynamax and Box tabs are all views of the one tools panel.
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
      status.textContent = 'The Raid, Dynamax and Box tabs need the page to be served over http. Run "node pvp-iv/serve.mjs" and open http://localhost:8788, or use the published site.';
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
      status.textContent = `The Raid, Dynamax and Box tabs failed to load: ${err.message}`;
      status.classList.add('error');
      // a half-built shadow root cannot be attached again, so retry on a fresh host element
      const fresh = document.createElement('div');
      fresh.id = 'raid-host';
      $('raid-host').replaceWith(fresh);
    });
    return mounting;
  }

  // ---------------------------------------------------------------- the cloud sign-in bar

  /**
   * Only there when cloud-config.js names a Firebase project. Signing in switches this browser to the
   * cloud and reloads; if the group has nothing saved yet, the rosters saved here are copied up first.
   * Signing out switches back to saving on this computer (or in this browser) and reloads.
   */
  async function renderCloudBar() {
    const bar = $('cloud-bar');
    const cloud = PogoStorage.cloud;
    if (!cloud.config()) return;
    await PogoStorage.shared().catch(() => {});
    const st = cloud.state();
    const button = (label, onclick) => Object.assign(document.createElement('button'), { type: 'button', textContent: label, onclick });
    const say = (text, ...buttons) => {
      bar.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }), ...buttons);
      bar.hidden = false;
    };
    if (st.state === 'on') {
      say(`Saved in the cloud as ${st.email}.`, button('Sign out', signOut));
      offerLocalCopy(st);
    } else if (st.state === 'error') {
      say(`The cloud is not working (${st.message}). Saving in ${st.fallback ?? 'this browser'} for now.`, button('Try again', () => location.reload()), button('Stop using the cloud', signOut));
    } else {
      say('Rosters are saved on this device only.', button('Sign in with Google to share them across devices', signIn));
    }

    /**
     * This device kept boxes of its own before it signed in, and they differ from the cloud's: ask once
     * which are right. Afterwards the two agree, and this device's copy follows the cloud's (storage.js).
     */
    function offerLocalCopy(st) {
      const d = st.localDiffers;
      if (!d) return;
      const total = (list) => list.reduce((n, a) => n + a.count, 0);
      const list = (side) => side.map((a) => `${a.name}: ${a.count}`).join(', ');
      const where = d.label === 'this browser' ? 'This browser' : 'This computer';
      const act = (fn, doing) => async () => {
        try {
          say(doing);
          await fn();
          location.reload();
        } catch (err) {
          say(`That didn’t work: ${err.message}`, button('Reload', () => location.reload()));
        }
      };
      bar.append(
        Object.assign(document.createElement('span'), {
          className: 'cloud-local',
          textContent: `${where} also kept boxes of its own before signing in (${total(d.here)} Pokémon), different from the cloud’s (${total(d.cloud)}). Which are the real ones?`,
        }),
        button('The cloud’s: update this device’s copy', act(() => PogoStorage.cloud.useCloudCopyHere(), 'Copying the cloud’s boxes to this device…')),
        button('This device’s: replace the cloud’s…', () => {
          const ok = confirm(
            `Replace the boxes in the cloud with the ones kept on this device?

` +
              `This device: ${list(d.here)}
The cloud now: ${list(d.cloud)}

` +
              `Every device signed in will see this device's boxes. What only the cloud has is lost.`,
          );
          if (ok) act(() => PogoStorage.cloud.useThisCopyForCloud(), 'Copying this device’s boxes to the cloud…')();
        }),
      );
    }

    async function signIn() {
      try {
        say('Signing in…');
        const session = await cloud.session();
        if (!session.user) await session.signIn();
        const backend = await session.open();
        // An empty group gets this device's rosters, so signing in never starts anyone from nothing.
        const there = await backend.loadWithRevs();
        if (there.empty) {
          const local = await PogoStorage.open();
          const mine = await local.load();
          const count = mine.accounts.reduce((n, a) => n + (a.roster?.length ?? 0), 0);
          if (count && confirm(`Nothing is saved in the cloud yet. Copy the ${mine.accounts.length} accounts (${count} Pokémon) saved in ${local.label} up to it?`)) {
            for (const a of mine.accounts) await backend.saveAccount(a, null);
            await backend.saveSettings(mine.settings, there.revs.settings ?? null);
          }
        }
        cloud.setWanted(true);
        location.reload();
      } catch (err) {
        console.error(err);
        const session = await cloud.session().catch(() => null);
        say(`Could not use the cloud: ${session ? session.explain(err) : err.message}`, button('Try again', signIn));
      }
    }

    async function signOut() {
      cloud.setWanted(false);
      try {
        await (await cloud.session()).signOut();
      } catch {
        /* signing out of a cloud that never loaded */
      }
      location.reload();
    }
  }

  showTab(tabFromHash());
  renderCloudBar();
})();

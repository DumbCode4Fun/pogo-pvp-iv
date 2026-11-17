/**
 * Where the Raid and Dynamax tabs keep their rosters and settings.
 *
 * Backends behind one interface, picked by open():
 *   server   the local server answers api/state, so state is saved to data/accounts/*.json on disk
 *   browser  anything else (GitHub Pages, file://): saved in this browser's localStorage
 * Each account is saved on its own, and only if nobody else saved it since this page loaded it.
 *
 * The browser backend is per browser and per site, so Export/Import JSON is how rosters move between
 * browsers or get backed up. Nothing here ever leaves the machine.
 */
(() => {
  const FORMAT = 'pogo-tools-state';
  const VERSION = 1;
  const LOCAL_KEY = 'pogo-tools.state.v1';
  const API_URL = 'api/state'; // relative, so it also resolves under a Pages sub-path
  // An id becomes a file name on the server, so keep it to plain characters.
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** A first visit with no saved rosters: five empty accounts. */
  function defaultState() {
    const accounts = [1, 2, 3, 4, 5].map((n) => ({
      id: `a${n}`,
      name: `Account ${n}`,
      active: n <= 2,
      friendship: 4,
      partyPower: n <= 2 ? 'optimal' : 'off',
      maxRevives: n <= 2 ? null : 0,
      roster: [],
    }));
    return {
      accounts,
      settings: {
        bossSpec: { pokemonId: 'RAYQUAZA', tier: 'T5', fastMove: '', chargedMove: '' },
        weather: 'NONE',
        purifiedGems: false,
        tuning: {},
      },
    };
  }

  /**
   * Checks that `raw` looks like {accounts, settings} and returns it. Unknown fields are kept, since the
   * files are meant to be hand-editable. Throws an Error whose message is fit to show the user.
   */
  function normalizeState(raw) {
    if (!isObject(raw)) throw new Error('Not a roster file.');
    if (raw.format !== undefined && raw.format !== FORMAT) throw new Error(`Not a ${FORMAT} file.`);
    if (!Array.isArray(raw.accounts) || !raw.accounts.length) throw new Error('The file has no accounts.');

    const seen = new Set();
    const accounts = raw.accounts.map((a, i) => {
      if (!isObject(a)) throw new Error(`Account ${i + 1} is not an object.`);
      if (typeof a.id !== 'string' || !ID_PATTERN.test(a.id)) {
        throw new Error(`Account ${i + 1} needs an id of letters, digits, "-" or "_".`);
      }
      if (seen.has(a.id)) throw new Error(`Two accounts share the id "${a.id}".`);
      seen.add(a.id);
      if (a.roster !== undefined && !Array.isArray(a.roster)) throw new Error(`Account "${a.id}" has a roster that is not a list.`);
      return { ...a, name: typeof a.name === 'string' ? a.name : a.id, roster: a.roster ?? [] };
    });

    if (raw.settings !== undefined && !isObject(raw.settings)) throw new Error('The settings are not an object.');
    return { accounts, settings: { ...defaultState().settings, ...(raw.settings ?? {}) } };
  }

  /** The text of an export file. */
  const serializeState = (state, now = new Date()) =>
    JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: now.toISOString(), accounts: state.accounts, settings: state.settings }, null, 2);

  /** Reads an export file (or a bare {accounts, settings}) back into a state. */
  function parseImport(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    if (isObject(raw) && raw.version !== undefined && raw.version > VERSION) {
      throw new Error('That file comes from a newer version of this app.');
    }
    return normalizeState(raw);
  }

  /**
   * Every backend below saves one account (or the settings) at a time, with the revision it last saw:
   *   loadWithRevs() -> { state, revs: { accounts: { id: rev }, settings: rev } }
   *   saveAccount(account, rev) -> new rev      removeAccount(id, rev)      saveSettings(settings, rev) -> new rev
   * A save against a revision that is no longer current is refused with a ConflictError carrying what is
   * saved now, so two tabs or two devices can never silently overwrite each other. tracked() (below) turns
   * that into the plain load() / save(state) the page uses.
   */
  class ConflictError extends Error {
    constructor(message, conflict) {
      super(message);
      this.conflict = conflict; // { accountId | settings: true, current, rev }
    }
  }

  /** localStorage can be missing, blocked or full, so every touch is guarded. */
  function browserBackend(storage) {
    // { accounts, settings, revs: { accounts: { id: n }, settings: n } }; revisions count up from 0
    const read = () => {
      try {
        const text = storage?.getItem(LOCAL_KEY);
        if (text) {
          const raw = JSON.parse(text);
          const revs = isObject(raw.revs) ? raw.revs : { accounts: {}, settings: 0 };
          revs.accounts ??= {};
          return { state: normalizeState(raw), revs };
        }
      } catch {
        /* fall through to a fresh start */
      }
      return { state: defaultState(), revs: { accounts: {}, settings: 0 } };
    };
    const write = ({ state, revs }) => {
      if (!storage) throw new Error('This browser is not letting the page store data.');
      try {
        storage.setItem(LOCAL_KEY, JSON.stringify({ accounts: state.accounts, settings: state.settings, revs }));
      } catch {
        throw new Error('The browser refused to store the rosters (storage full or blocked). Export a backup.');
      }
    };
    const revOf = (revs, id) => (id === null ? (revs.settings ?? 0) : revs.accounts[id] ?? 0);
    return {
      kind: 'browser',
      label: 'this browser',
      async loadWithRevs() {
        const { state, revs } = read();
        return { state, revs: { accounts: Object.fromEntries(state.accounts.map((a) => [a.id, revOf(revs, a.id)])), settings: revOf(revs, null) } };
      },
      async saveAccount(account, rev) {
        const now = read();
        const at = now.state.accounts.findIndex((a) => a.id === account.id);
        if (revOf(now.revs, account.id) !== (rev ?? 0) && at >= 0) {
          throw new ConflictError(`Account "${now.state.accounts[at].name || account.id}" was changed in another tab since this one loaded it.`, { accountId: account.id, current: now.state.accounts[at], rev: revOf(now.revs, account.id) });
        }
        if (at >= 0) now.state.accounts[at] = account;
        else now.state.accounts.push(account);
        now.revs.accounts[account.id] = revOf(now.revs, account.id) + 1;
        write(now);
        return now.revs.accounts[account.id];
      },
      async removeAccount(id, rev) {
        const now = read();
        if (revOf(now.revs, id) !== (rev ?? 0)) throw new ConflictError(`Account "${id}" was changed in another tab.`, { accountId: id, current: now.state.accounts.find((a) => a.id === id) ?? null, rev: revOf(now.revs, id) });
        now.state.accounts = now.state.accounts.filter((a) => a.id !== id);
        delete now.revs.accounts[id];
        write(now);
        return null;
      },
      async saveSettings(settings, rev) {
        const now = read();
        if (revOf(now.revs, null) !== (rev ?? 0)) throw new ConflictError('The raid settings were changed in another tab.', { settings: true, current: now.state.settings, rev: revOf(now.revs, null) });
        now.state.settings = settings;
        now.revs.settings = revOf(now.revs, null) + 1;
        write(now);
        return now.revs.settings;
      },
    };
  }

  function serverBackend(fetchFn, apiUrl) {
    /** A PUT or DELETE that answers { rev }, or 409 with what is saved now. */
    const send = async (url, method, body, what, conflictKey) => {
      const res = await fetchFn(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 409) {
        const c = await res.json();
        // name the account as it is saved now, not as this page had renamed it
        const label = conflictKey.accountId && c.current?.name ? `Account "${c.current.name}"` : what;
        throw new ConflictError(`${label} was changed elsewhere (another tab, or the file itself) since this page loaded it.`, { ...conflictKey, current: c.current, rev: c.rev });
      }
      if (!res.ok) throw new Error(`The server could not save ${what.toLowerCase()} (${res.status}).`);
      return (await res.json()).rev;
    };
    return {
      kind: 'server',
      label: 'the local server (data/accounts)',
      async loadWithRevs() {
        const res = await fetchFn(apiUrl);
        if (!res.ok) throw new Error(`The server could not load the rosters (${res.status}).`);
        const raw = await res.json();
        return { state: normalizeState(raw), revs: raw.revs ?? { accounts: {}, settings: null } };
      },
      saveAccount: (account, rev) => send(`${apiUrl}/accounts/${encodeURIComponent(account.id)}`, 'PUT', { account, rev }, `Account "${account.name || account.id}"`, { accountId: account.id }),
      removeAccount: (id, rev) => send(`${apiUrl}/accounts/${encodeURIComponent(id)}`, 'DELETE', { rev }, `Account "${id}"`, { accountId: id }),
      saveSettings: (settings, rev) => send(`${apiUrl}/settings`, 'PUT', { settings, rev }, 'The raid settings', { settings: true }),
    };
  }

  /**
   * The page's view of a backend: load() and save(state), where save writes only the accounts (and
   * settings) that changed since they were loaded or last saved, each against its revision. A refused save
   * throws the ConflictError; what is saved now becomes the new starting point, so the page can show it
   * and save again.
   */
  function tracked(backend) {
    const last = new Map(); // 'a:<id>' | 'settings' -> { json, rev }
    const remember = (key, value, rev) => last.set(key, { json: JSON.stringify(value), rev });
    return {
      kind: backend.kind,
      label: backend.label,
      backend,
      async load() {
        const { state, revs } = await backend.loadWithRevs();
        last.clear();
        // what the backend doesn't hold yet (a first start) counts as changed, so the first save writes it
        for (const a of state.accounts) {
          if (revs.accounts && a.id in revs.accounts) remember(`a:${a.id}`, a, revs.accounts[a.id]);
          else last.set(`a:${a.id}`, { json: null, rev: null });
        }
        if (revs.settings === null || revs.settings === undefined) last.set('settings', { json: null, rev: null });
        else remember('settings', state.settings, revs.settings);
        return state;
      },
      async save(state) {
        const seen = new Set();
        for (const a of state.accounts) {
          const key = `a:${a.id}`;
          seen.add(key);
          const was = last.get(key);
          const json = JSON.stringify(a);
          if (was?.json === json) continue;
          try {
            remember(key, a, await backend.saveAccount(a, was?.rev ?? null));
          } catch (err) {
            if (err.conflict) remember(key, err.conflict.current, err.conflict.rev);
            throw err;
          }
        }
        for (const [key, was] of [...last]) {
          if (!key.startsWith('a:') || seen.has(key)) continue;
          try {
            await backend.removeAccount(key.slice(2), was.rev);
            last.delete(key);
          } catch (err) {
            if (err.conflict) remember(key, err.conflict.current, err.conflict.rev);
            throw err;
          }
        }
        const was = last.get('settings');
        if (was?.json !== JSON.stringify(state.settings)) {
          try {
            remember('settings', state.settings, await backend.saveSettings(state.settings, was?.rev ?? null));
          } catch (err) {
            if (err.conflict) remember('settings', err.conflict.current, err.conflict.rev);
            throw err;
          }
        }
      },
    };
  }

  /**
   * `fetch` and `localStorage` are injectable so this can be tested without a browser.
   * Returns {kind, label, load(), save(state)}: save writes only what changed, refusing (ConflictError,
   * with err.conflict = { accountId | settings, current, rev }) what was changed elsewhere meanwhile.
   */
  async function open({ fetchFn = globalThis.fetch, localStorageObj, apiUrl = API_URL } = {}) {
    let storage = localStorageObj;
    if (storage === undefined) {
      try {
        storage = globalThis.localStorage;
      } catch {
        storage = null; // accessing it can throw when site data is blocked
      }
    }
    if (typeof fetchFn === 'function') {
      try {
        const res = await fetchFn(apiUrl);
        const isJson = /json/i.test(res.headers?.get?.('content-type') ?? '');
        // A static host answers 404 or an HTML page here; only our own server answers with rosters.
        if (res.ok && isJson && Array.isArray((await res.json()).accounts)) return tracked(serverBackend(fetchFn, apiUrl));
      } catch {
        /* no server: use the browser */
      }
    }
    return tracked(browserBackend(storage));
  }

  /**
   * The page's one backend: opened on first use, then reused by every tool. Each save also fires a
   * "pogo-tools:saved" event carrying the saved state, so a tool that only reads rosters (the PvP tab)
   * stays current without loading them again, and never sees an older copy than the one just saved.
   */
  let sharedBackend = null;
  const announce = (backend) => ({
    ...backend,
    load: () => backend.load(),
    async save(state) {
      await backend.save(state);
      globalThis.dispatchEvent?.(new CustomEvent('pogo-tools:saved', { detail: state }));
    },
  });

  // ---------------------------------------------------------------- the cloud (optional)

  /**
   * With a Firebase project in cloud-config.js, someone signed in, and the cloud switched on in this
   * browser, the rosters are saved in the cloud instead (cloud.js). If the cloud can't be reached the page
   * says so and saves where it would without it.
   */
  const CLOUD_KEY = 'pogo-tools.cloud';
  const cloudConfig = () => globalThis.POGO_CLOUD ?? null;
  const cloudWanted = () => {
    try {
      return globalThis.localStorage?.getItem(CLOUD_KEY) === 'on';
    } catch {
      return false;
    }
  };
  const setCloudWanted = (on) => {
    try {
      if (on) globalThis.localStorage.setItem(CLOUD_KEY, 'on');
      else globalThis.localStorage.removeItem(CLOUD_KEY);
    } catch {
      /* the choice just won't be remembered */
    }
  };
  let session = null;
  /** The Firebase session (loads the SDK the first time). */
  const cloudSession = () => (session ??= import('./cloud.js').then((m) => m.connect(cloudConfig(), globalThis.PogoStorage)).catch((err) => {
    session = null;
    throw err;
  }));
  /** { state: 'none' | 'off' | 'on' | 'error', email?, message? } for the sign-in bar. */
  let cloudState = { state: 'none' };

  const pokemonIn = (state) => state.accounts.reduce((n, a) => n + (a.roster?.length ?? 0), 0);
  const perAccount = (state) => state.accounts.map((a) => ({ name: a.name || a.id, count: a.roster?.length ?? 0 }));

  /**
   * While signed in, this device's own copy (the local server's files, or this browser's storage) follows
   * the cloud's: a current backup on the computer, and no stale copy left to be mistaken for the real
   * boxes later. It only starts following once the two agree. If they differ when the page loads (a device
   * that kept boxes of its own before it signed in), both are left alone and cloudState.localDiffers asks
   * which one is right; the sign-in bar offers the two answers below.
   */
  function mirrored(cloud, local) {
    let following = false;
    const follow = async (state) => {
      if (!following) return;
      try {
        await local.save(state);
      } catch (err) {
        if (!err.conflict) return console.warn('Could not keep this device’s copy up to date:', err);
        // the local copy moved underneath (another tab signed out): take its revisions and write again
        try {
          await local.load();
          await local.save(state);
        } catch (again) {
          console.warn('Could not keep this device’s copy up to date:', again);
        }
      }
    };
    return {
      kind: cloud.kind,
      label: cloud.label,
      backend: cloud.backend,
      async load() {
        const state = await cloud.load();
        try {
          const mine = await local.load();
          const same = JSON.stringify(mine.accounts) === JSON.stringify(state.accounts);
          if (same || !pokemonIn(mine)) {
            following = true;
            delete cloudState.localDiffers;
            if (!same || JSON.stringify(mine.settings) !== JSON.stringify(state.settings)) await follow(state);
          } else {
            following = false;
            cloudState.localDiffers = { label: local.label, here: perAccount(mine), cloud: perAccount(state) };
          }
        } catch (err) {
          console.warn('Could not read this device’s own copy:', err);
        }
        return state;
      },
      async save(state) {
        await cloud.save(state);
        await follow(state);
      },
    };
  }

  /** The two answers when this device's copy and the cloud's differ. Both replace one side with the other. */
  async function useCloudCopyHere() {
    const s = await cloudSession();
    const cloud = tracked(await s.open());
    const state = await cloud.load();
    const local = await open();
    await local.load();
    await local.save(state);
  }
  async function useThisCopyForCloud() {
    const s = await cloudSession();
    const local = await open();
    const mine = await local.load();
    const cloud = tracked(await s.open());
    await cloud.load();
    await cloud.save(mine);
  }

  async function openShared() {
    if (cloudConfig()) cloudState = { state: 'off' };
    if (cloudConfig() && cloudWanted()) {
      try {
        const s = await cloudSession();
        if (s.user) {
          cloudState = { state: 'on', email: s.user.email };
          return mirrored(tracked(await s.open()), await open());
        }
      } catch (err) {
        cloudState = { state: 'error', message: err.message };
        const local = await open();
        cloudState.fallback = local.label;
        return local;
      }
    }
    return open();
  }
  const shared = () => (sharedBackend ??= openShared().then(announce));

  globalThis.PogoStorage = {
    FORMAT,
    ID_PATTERN,
    defaultState,
    normalizeState,
    serializeState,
    parseImport,
    open,
    shared,
    tracked,
    ConflictError,
    cloud: { config: cloudConfig, state: () => cloudState, session: cloudSession, wanted: cloudWanted, setWanted: setCloudWanted, useCloudCopyHere, useThisCopyForCloud, mirrored },
  };
})();

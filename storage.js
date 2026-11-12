/**
 * Where the Raid and Dynamax tabs keep their rosters and settings.
 *
 * Two backends behind one interface, picked by open():
 *   server   the local server answers api/state, so state is saved to data/accounts/*.json on disk
 *   browser  anything else (GitHub Pages, file://): saved in this browser's localStorage
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

  /** localStorage can be missing, blocked or full, so every touch is guarded. */
  function browserBackend(storage) {
    return {
      kind: 'browser',
      label: 'this browser',
      async load() {
        try {
          const text = storage?.getItem(LOCAL_KEY);
          if (text) return normalizeState(JSON.parse(text));
        } catch {
          /* fall through to a fresh start */
        }
        return defaultState();
      },
      async save(state) {
        if (!storage) throw new Error('This browser is not letting the page store data.');
        try {
          storage.setItem(LOCAL_KEY, JSON.stringify({ accounts: state.accounts, settings: state.settings }));
        } catch {
          throw new Error('The browser refused to store the rosters (storage full or blocked). Export a backup.');
        }
      },
    };
  }

  function serverBackend(fetchFn, apiUrl) {
    return {
      kind: 'server',
      label: 'the local server (data/accounts)',
      async load() {
        const res = await fetchFn(apiUrl);
        if (!res.ok) throw new Error(`The server could not load the rosters (${res.status}).`);
        return normalizeState(await res.json());
      },
      async save(state) {
        const res = await fetchFn(apiUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accounts: state.accounts, settings: state.settings }),
        });
        if (!res.ok) throw new Error(`The server could not save the rosters (${res.status}).`);
      },
    };
  }

  /**
   * `fetch` and `localStorage` are injectable so this can be tested without a browser.
   * Returns {kind, label, load(), save(state)}.
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
        if (res.ok && isJson && Array.isArray((await res.json()).accounts)) return serverBackend(fetchFn, apiUrl);
      } catch {
        /* no server: use the browser */
      }
    }
    return browserBackend(storage);
  }

  /**
   * The page's one backend: opened on first use, then reused by every tool. Each save also fires a
   * "pogo-tools:saved" event carrying the saved state, so a tool that only reads rosters (the PvP tab)
   * stays current without loading them again, and never sees an older copy than the one just saved.
   */
  let sharedBackend = null;
  const announce = (backend) => ({
    ...backend,
    async save(state) {
      await backend.save(state);
      globalThis.dispatchEvent?.(new CustomEvent('pogo-tools:saved', { detail: state }));
    },
  });
  const shared = () => (sharedBackend ??= open().then(announce));

  globalThis.PogoStorage = { FORMAT, ID_PATTERN, defaultState, normalizeState, serializeState, parseImport, open, shared };
})();

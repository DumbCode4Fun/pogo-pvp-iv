/**
 * Saving the rosters in the cloud (Firebase: Google sign-in and a Firestore database), so the phone and
 * the computer see the same boxes. Optional: it only does anything once cloud-config.js names a Firebase
 * project and someone signs in. storage.js loads this file on demand.
 *
 * Layout in Firestore, all under one group (the people who share the boxes):
 *   groups/<group>                           { members: [Google account emails] }, made by hand once
 *   groups/<group>/accounts/<id>             { rev, parts, name, savedAt, savedBy }
 *   groups/<group>/accounts/<id>/parts/<n>   { json }   the account as JSON, cut in pieces: a whole box
 *                                            with its undo copy can pass Firestore's 1 MB per document
 *   groups/<group>/meta/settings             { rev, json }
 * Every save runs in a transaction that checks `rev` first, so two devices can't overwrite each other
 * (see the backend contract in storage.js). Who may read and write is decided by firebase/firestore.rules.
 */

/** Pinned so a release of the SDK can't change the page under us. */
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
/** Characters of JSON per part; well under the 1 MiB limit even if every character took 2 bytes. */
export const PART = 400_000;

class ConflictError extends Error {
  constructor(message, conflict) {
    super(message);
    this.conflict = conflict;
  }
}

/**
 * The backend, over a small `store` interface so it can be tested without Firebase:
 *   store.list(path) -> [{ id, data }]      store.get(path) -> data | null
 *   store.transact(async (tx) => ...)       tx.get(path), tx.set(path, data), tx.delete(path)
 * Paths are arrays under the group: ['accounts', 'a1', 'parts', '0'].
 * `who` is written as savedBy. `normalizeState` / `defaultState` come from storage.js.
 */
export function cloudBackend(store, { who = '', normalizeState, defaultState, ConflictError: Conflict = ConflictError } = {}) {
  const head = (id) => ['accounts', id];
  const part = (id, n) => ['accounts', id, 'parts', String(n)];
  const settingsPath = ['meta', 'settings'];

  /** The account behind a head, its parts read with `get` (plain reads, or a transaction's). */
  const assemble = async (id, h, get) => {
    let json = '';
    for (let n = 0; n < (h.parts ?? 0); n++) json += (await get(part(id, n)))?.json ?? '';
    return JSON.parse(json);
  };

  return {
    kind: 'cloud',
    label: 'the cloud',
    /** { state, revs, empty }: `empty` when nothing has been saved to this group yet. */
    async loadWithRevs() {
      const heads = await store.list(['accounts']);
      const settingsDoc = await store.get(settingsPath);
      if (!heads.length) {
        return { state: defaultState(), revs: { accounts: {}, settings: settingsDoc?.rev ?? null }, empty: true };
      }
      const accounts = [];
      const revs = { accounts: {}, settings: settingsDoc?.rev ?? null };
      for (const { id, data } of heads.sort((a, b) => a.id.localeCompare(b.id))) {
        accounts.push(await assemble(id, data, (p) => store.get(p)));
        revs.accounts[id] = data.rev;
      }
      const state = normalizeState({ accounts, settings: settingsDoc ? JSON.parse(settingsDoc.json) : undefined });
      return { state, revs, empty: false };
    },

    saveAccount(account, rev) {
      const id = account.id;
      return store.transact(async (tx) => {
        const h = await tx.get(head(id));
        const now = h?.rev ?? null;
        if (now !== (rev ?? null)) {
          const current = h ? await assemble(id, h, (p) => tx.get(p)) : null;
          throw new Conflict(`Account "${current?.name || account.name || id}" was changed on another device since this page loaded it.`, { accountId: id, current, rev: now });
        }
        const json = JSON.stringify(account);
        const pieces = [];
        for (let i = 0; i < json.length; i += PART) pieces.push(json.slice(i, i + PART));
        pieces.forEach((piece, n) => tx.set(part(id, n), { json: piece }));
        for (let n = pieces.length; n < (h?.parts ?? 0); n++) tx.delete(part(id, n));
        const next = (now ?? 0) + 1;
        tx.set(head(id), { rev: next, parts: pieces.length, name: account.name ?? id, savedAt: new Date().toISOString(), savedBy: who });
        return next;
      });
    },

    removeAccount(id, rev) {
      return store.transact(async (tx) => {
        const h = await tx.get(head(id));
        const now = h?.rev ?? null;
        if (now !== (rev ?? null)) {
          throw new Conflict(`Account "${id}" was changed on another device.`, { accountId: id, current: h ? await assemble(id, h, (p) => tx.get(p)) : null, rev: now });
        }
        for (let n = 0; n < (h?.parts ?? 0); n++) tx.delete(part(id, n));
        if (h) tx.delete(head(id));
        return null;
      });
    },

    saveSettings(settings, rev) {
      return store.transact(async (tx) => {
        const doc = await tx.get(settingsPath);
        const now = doc?.rev ?? null;
        if (now !== (rev ?? null)) {
          throw new Conflict('The raid settings were changed on another device.', { settings: true, current: doc ? JSON.parse(doc.json) : null, rev: now });
        }
        const next = (now ?? 0) + 1;
        tx.set(settingsPath, { rev: next, json: JSON.stringify(settings), savedAt: new Date().toISOString(), savedBy: who });
        return next;
      });
    },
  };
}

/** The `store` for cloudBackend over Firestore, for one group. */
function firestoreStore(fs, db, group) {
  const ref = (p) => fs.doc(db, 'groups', group, ...p);
  const data = (snap) => (snap.exists() ? snap.data() : null);
  return {
    list: async (p) => (await fs.getDocs(fs.collection(db, 'groups', group, ...p))).docs.map((d) => ({ id: d.id, data: d.data() })),
    get: async (p) => data(await fs.getDoc(ref(p))),
    transact: (fn) =>
      fs.runTransaction(db, (t) =>
        fn({
          get: async (p) => data(await t.get(ref(p))),
          set: (p, value) => t.set(ref(p), value),
          delete: (p) => t.delete(ref(p)),
        }),
      ),
  };
}

/** What a Firebase error means for the person in front of the page. */
function explain(err, email) {
  const code = String(err?.code ?? '');
  if (code.includes('permission-denied')) return `${email || 'This Google account'} is not in this group yet: add it to "members" of the group in the Firebase console.`;
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in was closed before it finished.';
  if (code.includes('popup-blocked')) return 'The browser blocked the sign-in window; allow pop-ups for this page and try again.';
  if (code.includes('unauthorized-domain')) return `This address (${location.hostname}) is not allowed to sign in: add it under Authentication → Settings → Authorized domains in the Firebase console.`;
  if (code.includes('unavailable') || code.includes('network')) return 'The cloud could not be reached (offline?).';
  return err?.message ?? String(err);
}

/**
 * Starts Firebase for `config` ({ apiKey, authDomain, projectId, appId, group }). Resolves to
 *   { user: { email } | null, signIn(), signOut(), open() -> backend, explain(err) }
 * once the sign-in state is known. Loading the SDK needs the network; this rejects without it.
 */
export async function connect(config, storageApi) {
  const [appMod, authMod, fsMod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]);
  const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  const group = config.group || 'main';
  const user = await new Promise((resolve) => {
    const stop = authMod.onAuthStateChanged(auth, (u) => {
      stop();
      resolve(u);
    });
  });
  const session = {
    user: user ? { email: user.email } : null,
    async signIn() {
      const result = await authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider());
      session.user = { email: result.user.email };
      return session.user;
    },
    async signOut() {
      await authMod.signOut(auth);
      session.user = null;
    },
    /** Checks the signed-in account may use the group, then returns the backend. */
    async open() {
      if (!session.user) throw new Error('Not signed in.');
      await fsMod.getDoc(fsMod.doc(db, 'groups', group)).catch((err) => {
        throw new Error(explain(err, session.user.email));
      });
      return cloudBackend(firestoreStore(fsMod, db, group), {
        who: session.user.email,
        normalizeState: storageApi.normalizeState,
        defaultState: storageApi.defaultState,
        ConflictError: storageApi.ConflictError,
      });
    },
    explain: (err) => explain(err, session.user?.email),
  };
  return session;
}

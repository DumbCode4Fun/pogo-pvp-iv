/**
 * DOM and formatting helpers shared by the raid page (app.js) and the upgrades page (upgrades.js).
 */

/**
 * The raid UI lives in a shadow root (so its stylesheet can't collide with the rest of the page),
 * which means ids are looked up there rather than on the document.
 */
let root = document;
export const setRoot = (r) => {
  root = r;
};
export const getRoot = () => root;
export const $ = (id) => root.getElementById(id);

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString();
export const pct = (n) => `${Math.round(n * 100)}%`;
export const gainText = (x) => `+${(x * 100).toFixed(1)}%`;

/** "1 Elite Fast TM", "~3 Charged TMs": what one move change costs. */
export function tmCost(c) {
  const kind = c.kind === 'fast' ? 'Fast' : 'Charged';
  if (c.elite) return `1 Elite ${kind} TM`;
  return c.tms === 1 ? `1 ${kind} TM` : `~${c.tms} ${kind} TMs`;
}

/** What a TM change does to one raid: seconds off the kill, or HP removed if it still loses. */
export function tmEffect(row) {
  if (row.flipsToWin) return `wins the raid (${fmt1(row.timeToKill)}s)`;
  if (row.secondsSaved !== null) return `${fmt1(row.secondsSaved)}s faster (${fmt1(row.timeToKill)}s kill)`;
  return `+${(row.damageGain * 100).toFixed(1)}% of its HP`;
}

/** The note under a change that replaces a shadow's Frustration, which only an event allows. */
export function eventNote(change, chargedMovesKnown) {
  if (!change.needsEvent) return null;
  return el('div', {
    class: 'warn-text small',
    text:
      chargedMovesKnown === 1
        ? `${change.from} can only be replaced during a removal event — or unlock a 2nd charged move now`
        : `${change.from} can only be replaced during a removal event`,
  });
}

/** The warning under a change that replaces a legacy move. */
export function legacyWarning(change, chargedMovesKnown) {
  if (!change.losesLegacy) return null;
  return el('div', {
    class: 'warn-text small',
    // With one charged move there is no other slot to replace, but a second one can be unlocked.
    text:
      change.kind === 'charged' && chargedMovesKnown === 1
        ? `gives up legacy ${change.from} — unlock a 2nd charged move first to keep it`
        : `gives up legacy ${change.from}`,
  });
}

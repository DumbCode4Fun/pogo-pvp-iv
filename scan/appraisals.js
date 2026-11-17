/**
 * Appraisals sent by the Android Nicknamer ({ name, cp, ivs: [a, d, s], shadow?, at }) as incoming
 * entries for reconcile(), the same shape a recording gives. The IVs are exact, so they are passed on
 * as read; the name is what the appraisal screen showed (a species or a typed nickname) and goes
 * through the same resolver as a tile, which settles the species and checks it against the CP.
 */
import { scanToEntries } from './reconcile.js';

const valid = (a) =>
  a && typeof a.name === 'string' && Number.isInteger(a.cp) && a.cp > 0 && Array.isArray(a.ivs) && a.ivs.length === 3 && a.ivs.every((n) => Number.isInteger(n) && n >= 0 && n <= 15);

/**
 * `resolve` is createResolver(...). Returns { incoming, tiles, skipped }: `incoming` is scanToEntries'
 * output (one item per valid appraisal, in order), `tiles` the resolved tiles, `skipped` the appraisals
 * that were malformed.
 */
export function appraisalsToIncoming(gd, resolve, appraisals) {
  const skipped = appraisals.filter((a) => !valid(a));
  const tiles = appraisals.filter(valid).map((a, i) => {
    const tile = { key: a.id ?? String(i), row: i + 1, col: '', name: a.name, cp: String(a.cp), shadow: Boolean(a.shadow), dynamax: false, gigantamax: false };
    const r = resolve({ ...tile });
    return { ...tile, species: r.name, pokemonId: r.pokemonId, ivs: a.ivs, pct: Math.round(((a.ivs[0] + a.ivs[1] + a.ivs[2]) / 45) * 100), ivTotal: a.ivs[0] + a.ivs[1] + a.ivs[2], sure: r.sure, note: r.note, formOpen: false, stageOpen: Boolean(r.stageOpen), docId: a.id };
  });
  return { incoming: scanToEntries(gd, tiles), tiles, skipped };
}

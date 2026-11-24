/**
 * Where each place in the tariff actually is.
 *
 * The tariff knows what a village costs and which corridor it is on. It does
 * not know where it is, which is why a pin dropped in Uitvlugt could sit on
 * an order priced for Mocha without anything noticing.
 *
 * Two files answer it, both already in the repository, both written once by
 * tools that are not run at boot:
 *
 *   data/zone-coordinates-review.csv  — geocoded when the tariff was audited
 *   data/places-found.csv             — the places `npm run roads` located
 *
 * Only rows marked `ok` are read. A geocode nobody trusts is not a fact to
 * accuse a customer with, and the coverage is deliberately partial: 151 of
 * the 185 priced places have a confident coordinate, and the other 34 are
 * simply not checkable. Silence is the right answer there — a false
 * accusation about somebody's own address is worse than no check at all.
 *
 * Loaded once, at first use. Nothing writes here; to fill a gap, pin the
 * village and re-run the geocoder.
 */
import { findZone } from './zones.ts';
import fs from 'node:fs';
import path from 'node:path';

export type Point = { latitude: number; longitude: number };

let loaded: Map<string, Point> | null = null;

const readCsv = (file: string, latAt: number, lngAt: number, statusAt: number): [string, Point][] => {
  const out: [string, Point][] = [];
  let text = '';
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    // Not every deployment carries the review files. The check simply has
    // less to say.
    return out;
  }
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cells = line.split(',');
    const place = (cells[0] ?? '').trim();
    // The status column differs between the two files and the last column is
    // the fallback, since `places-found.csv` ends with its verdict.
    // -1 means the verdict is the LAST column, which is how
    // places-found.csv is shaped. It cannot be read by index: the column
    // before it holds a quoted address with commas inside, so a plain split
    // puts the row's own fields at shifting positions.
    const status = (statusAt < 0 ? cells[cells.length - 1] : cells[statusAt] ?? '')?.trim() ?? '';
    const latitude = Number(cells[latAt]);
    const longitude = Number(cells[lngAt]);
    if (place === '' || status !== 'ok') continue;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    // The country centroid, which Google hands back for anything it cannot
    // place. Refused when the files were written and refused again here, in
    // case an older copy carries one.
    if (Math.abs(latitude - 4.86) < 0.01 && Math.abs(longitude + 58.93) < 0.01) continue;
    out.push([place, { latitude, longitude }]);
  }
  return out;
};

function all(): Map<string, Point> {
  if (loaded) return loaded;
  const map = new Map<string, Point>();
  // The audit file first; the roads file fills what it could not place.
  for (const [place, point] of readCsv('./data/zone-coordinates-review.csv', 4, 5, 7)) {
    map.set(place.toLowerCase(), point);
  }
  for (const [place, point] of readCsv('./data/places-found.csv', 3, 4, -1)) {
    if (!map.has(place.toLowerCase())) map.set(place.toLowerCase(), point);
  }
  loaded = map;
  return map;
}

/** Where a tariff place is, or null when nobody has placed it confidently. */
export function coordsFor(place: string): Point | null {
  return all().get(place.trim().toLowerCase()) ?? null;
}

/** How many places can be checked at all — reported by /health. */
export function placesLocated(): number {
  return all().size;
}

/** The tariff place nearest a pin, for saying what somewhere actually IS. */
export function nearestPlace(pin: Point): { place: string; km: number } | null {
  let best: { place: string; km: number } | null = null;
  for (const [key, point] of all()) {
    const km = straightKm(pin, point);
    if (!best || km < best.km) best = { place: key, km };
  }
  if (!best) return null;
  // Back to the tariff's own spelling, since the map is keyed in lower case.
  //
  // The comment said this and the code did not do it, which nobody noticed
  // while the only readers were comparing names. The first caller to SHOW
  // one to a customer got "beterverwagting", and the first to write one
  // down wrote a pickup nobody would recognise on a card.
  const named = findZone(best.place);
  return named.kind === 'found' ? { place: named.match.place, km: best.km } : best;
}

/** Straight-line kilometres. The same haversine location.ts uses. */
export function straightKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

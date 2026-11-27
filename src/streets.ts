/**
 * The streets of the places the shop serves, from the map.
 *
 *   npm run streets
 *
 * The tariff is 185 village names. "Lot 20 Garnet Street" is not one of
 * them, so a trip from it could not be priced — and the shop's own memory
 * only ever knows the streets it has already delivered to, which on the
 * first day is none of them.
 *
 * OpenStreetMap knows them. This asks Overpass for every named street in
 * the strip the shop serves, and for every ward and village marked on it,
 * and pairs each street with the nearest one. A street two hundred metres
 * from the Kitty marker is in Kitty.
 *
 * Nothing is applied and nothing is sent anywhere. It writes a CSV for a
 * person to read, the way `npm run roads` writes its own — and the shop
 * loads it at boot only for streets nobody has delivered to yet, because a
 * delivery that actually happened outranks a guess from a map.
 *
 * No key and no account: Overpass is free. It is somebody's donated
 * server, so this asks in a handful of large tiles rather than a thousand
 * small ones, and waits between them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findZone } from './zones.ts';
import { streetKey } from './street-memory.ts';

const OUT = path.resolve('./data/streets.csv');

/**
 * Where to ask. The coast the shop serves, in tiles small enough that
 * Overpass answers without timing out.
 *
 * West to east: Parika and the East Bank Essequibo, the two banks of the
 * Demerara, Georgetown itself, and the East Coast out to Mahaica.
 */
const TILES: { name: string; south: number; west: number; north: number; east: number }[] = [
  { name: 'Georgetown', south: 6.76, west: -58.19, north: 6.84, east: -58.10 },
  { name: 'East Bank Demerara', south: 6.5, west: -58.28, north: 6.79, east: -58.12 },
  { name: 'East Coast Demerara', south: 6.75, west: -58.11, north: 6.87, east: -57.88 },
  { name: 'West Bank and West Coast', south: 6.72, west: -58.42, north: 6.87, east: -58.14 },
  { name: 'East Bank Essequibo', south: 6.76, west: -58.72, north: 6.92, east: -58.38 },
];

const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

type Element = {
  type: string;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
};

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Answers already fetched, kept on disk.
 *
 * Overpass is somebody's donated server and these are big questions, so a
 * second run reads what the first one was given rather than asking again.
 * It is also the way in on a network that will not let this process out:
 * the file can be fetched by anything — curl, a browser — and dropped here.
 *
 * The cache is working material, not part of the shop: it is the CSV that
 * gets committed.
 */
const CACHE = path.resolve('./data/overpass-cache');

function cached(name: string): Element[] | null {
  const file = path.join(CACHE, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { elements?: Element[] };
    return body.elements ?? [];
  } catch {
    console.log(`  (${name}.json could not be read, asking instead)`);
    return null;
  }
}

/** One Overpass question, tried at each mirror in turn. */
async function ask(query: string, name = ''): Promise<Element[]> {
  if (name) {
    const had = cached(name);
    if (had) return had;
  }

  let lastError = '';
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // A plain client name. Overpass asks who is calling; it does not
          // need to know whose shop this is.
          'user-agent': 'street-import/1.0',
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!res.ok) {
        lastError = `${url} answered ${res.status}`;
        continue;
      }
      const text = await res.text();
      if (name) {
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(path.join(CACHE, `${name}.json`), text, 'utf8');
      }
      const body = JSON.parse(text) as { elements?: Element[] };
      return body.elements ?? [];
    } catch (err) {
      lastError = `${url}: ${String(err)}`;
    }
  }
  throw new Error(`no Overpass mirror answered — ${lastError}`);
}

const where = (e: Element): { lat: number; lon: number } | null => {
  const lat = e.center?.lat ?? e.lat;
  const lon = e.center?.lon ?? e.lon;
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null;
};

/** Straight-line kilometres — the same haversine the rest of the shop uses. */
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * How far a street may be from a marker and still belong to it.
 *
 * Georgetown's wards are a few hundred metres across; the villages along
 * the coast are strung out over a kilometre or two. Beyond three the
 * nearest marker is not where the street is, it is merely the closest the
 * map comes — and a wrong ward is worse than none, because the shop would
 * price a trip from it.
 */
const NEAR_ENOUGH_KM = 3;

const found = new Map<string, { street: string; place: string; km: number }>();
let streetsSeen = 0;
let placesSeen = 0;

for (const tile of TILES) {
  const box = `${tile.south},${tile.west},${tile.north},${tile.east}`;
  process.stdout.write(`  ${tile.name.padEnd(26)}`);

  const slug = tile.name.toLowerCase().replace(/[^a-z]+/g, '-');
  const places = await ask(
    `[out:json][timeout:60];(node["place"](${box});way["place"](${box}););out tags center;`,
    `${slug}-places`,
  );
  const streets = await ask(
    `[out:json][timeout:90];way["highway"]["name"](${box});out tags center;`,
    `${slug}-streets`,
  );
  await wait(1500);

  // Only places the TARIFF carries. A street in a village the shop does not
  // price is a street it cannot use.
  const markers: { place: string; at: { lat: number; lon: number } }[] = [];
  for (const p of places) {
    const name = p.tags?.name?.trim();
    const at = where(p);
    if (!name || !at) continue;
    const known = findZone(name);
    if (known.kind !== 'found') continue;
    markers.push({ place: known.match.place, at });
  }
  placesSeen += markers.length;

  for (const s of streets) {
    const name = s.tags?.name?.trim();
    const at = where(s);
    if (!name || !at) continue;
    streetsSeen += 1;

    const key = streetKey(name);
    if (!key) continue;

    let best: { place: string; km: number } | null = null;
    for (const m of markers) {
      const d = km(at, m.at);
      if (!best || d < best.km) best = { place: m.place, km: d };
    }
    if (!best || best.km > NEAR_ENOUGH_KM) continue;

    // The same street may appear as a dozen ways. Keep the nearest reading.
    const id = `${key}|${best.place}`;
    const had = found.get(id);
    if (!had || best.km < had.km) found.set(id, { street: key, place: best.place, km: best.km });
  }

  console.log(`${markers.length} places · ${streets.length} ways`);
}

const rows = [...found.values()].sort((a, b) =>
  a.street === b.street ? a.km - b.km : a.street.localeCompare(b.street),
);

fs.writeFileSync(
  OUT,
  ['street,place,km_from_marker', ...rows.map((r) => `${r.street},${r.place},${r.km.toFixed(2)}`)].join(
    '\n',
  ) + '\n',
  'utf8',
);

const streetsWithTwo = new Set(
  rows.filter((r, i) => rows.some((o, j) => i !== j && o.street === r.street)).map((r) => r.street),
);

console.log('');
console.log(`  ${streetsSeen} named ways on the map, ${placesSeen} markers the tariff carries.`);
console.log(`  ${rows.length} street-and-place pairs written to ${OUT}`);
console.log(`  ${streetsWithTwo.size} street name(s) occur in more than one place — the shop will ask.`);
console.log('');
console.log('  Nothing is applied. Read it, then commit it: the shop loads it at boot');
console.log('  for streets nobody has delivered to yet, and a real delivery outranks it.');

/**
 * The tariff, measured by road instead of in a straight line.
 *
 *   npm run roads
 *
 * Two jobs, asked once, and neither of them changes a price.
 *
 *   1. Every place with a coordinate is routed from the shop, and the road
 *      distance is put beside the straight-line one. Vreed-en-Hoop is the
 *      case that explains the whole exercise: five kilometres across the
 *      Demerara and twenty-five round the bridge, so the tariff charges for
 *      five kilometres of work and the associate does twenty-five.
 *
 *   2. Every place with NO coordinate is looked up by name, because
 *      OpenStreetMap had never heard of forty-five of them and a place the
 *      shop cannot put on a map is a place it cannot measure or draw.
 *
 * Writes two CSVs for a person to read and prints the worst disagreements.
 * Nothing is applied: the prices are the shop's to set, which is how
 * Stanleytown and Felicity were decided and how these should be.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tariff } from './zones.ts';
import { money } from './config.ts';
import { mapsKeySet, roadDistance, geocodePlace, shopCentre, type Point } from './google-maps.ts';

const SOURCE = path.resolve('./data/zone-coordinates-review.csv');
const ROADS = path.resolve('./data/road-distances.csv');
const FOUND = path.resolve('./data/places-found.csv');

if (!mapsKeySet()) {
  console.log('GOOGLE_MAPS_KEY is not set, so there is nothing to ask. Nothing was changed.');
  process.exit(0);
}

const centre = shopCentre();
if (!centre) {
  console.log(
    'SERVICE_CENTRE_LAT and SERVICE_CENTRE_LNG are not set, so there is nowhere to measure from.',
  );
  process.exit(0);
}

/** The review file, which holds the coordinates somebody already geocoded. */
const cells = (line: string): string[] => {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
};

type Known = { place: string; lat: number; lng: number; km: number; status: string };
const known = new Map<string, Known>();
for (const line of fs.readFileSync(SOURCE, 'utf8').split(/\r?\n/).slice(1)) {
  if (!line.trim()) continue;
  const c = cells(line);
  const lat = Number(c[4]);
  const lng = Number(c[5]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0) continue;
  known.set(c[0] ?? '', { place: c[0] ?? '', lat, lng, km: Number(c[6]) || 0, status: (c[7] ?? '').trim() });
}

const places = tariff();
const withPin = places.filter((z) => known.has(z.place));
const without = places.filter((z) => !known.has(z.place));

console.log(
  `${places.length} places in the tariff: ${withPin.length} already pinned, ${without.length} to look up.`,
);
console.log(`Measuring from ${centre.latitude}, ${centre.longitude}.\n`);

/* ------------------------------------------------- 1. by road, not by air */

type Row = { place: string; zone: string; fee: number; straightKm: number; roadKm: number; minutes: number };
const rows: Row[] = [];

for (const z of withPin) {
  const at = known.get(z.place)!;
  const to: Point = { latitude: at.lat, longitude: at.lng };
  const road = await roadDistance(centre, to);
  if (!road) {
    console.log(`  ${z.place.padEnd(26)} no route`);
    continue;
  }
  rows.push({
    place: z.place,
    zone: z.zone,
    fee: z.fee,
    straightKm: at.km,
    roadKm: Math.round((road.metres / 1000) * 10) / 10,
    minutes: Math.round(road.seconds / 60),
  });
}

// The ones where the straight line lied most, which is where the money is.
const liars = [...rows]
  .filter((r) => r.straightKm > 0)
  .sort((a, b) => b.roadKm / b.straightKm - a.roadKm / a.straightKm)
  .slice(0, 12);

console.log('Where the straight line lies most:\n');
console.log('  place                      straight    road    ratio   min   fee');
for (const r of liars) {
  const ratio = (r.roadKm / r.straightKm).toFixed(1);
  console.log(
    `  ${r.place.padEnd(26)} ${String(r.straightKm).padStart(5)} km ${String(r.roadKm).padStart(6)} km` +
      `   x${ratio.padStart(4)} ${String(r.minutes).padStart(5)}   ${money(r.fee)}`,
  );
}

// Priced per road kilometre, which is the number a tariff should move with.
const perKm = [...rows]
  .filter((r) => r.roadKm > 0)
  .sort((a, b) => a.fee / a.roadKm - b.fee / b.roadKm);
console.log('\nCheapest per road kilometre (under-charged for the work):\n');
for (const r of perKm.slice(0, 6)) {
  console.log(`  ${r.place.padEnd(26)} ${money(r.fee)} for ${r.roadKm} km — ${money(Math.round(r.fee / r.roadKm))}/km`);
}
console.log('\nDearest per road kilometre:\n');
for (const r of perKm.slice(-6).reverse()) {
  console.log(`  ${r.place.padEnd(26)} ${money(r.fee)} for ${r.roadKm} km — ${money(Math.round(r.fee / r.roadKm))}/km`);
}

fs.writeFileSync(
  ROADS,
  ['place,zone,fee,straight_km,road_km,minutes,fee_per_road_km']
    .concat(
      rows.map((r) =>
        [r.place, r.zone, r.fee, r.straightKm, r.roadKm, r.minutes,
         r.roadKm > 0 ? Math.round(r.fee / r.roadKm) : ''].join(','),
      ),
    )
    .join('\n') + '\n',
  'utf8',
);

/* ------------------------------------------- 2. the ones nobody could find */

if (without.length > 0) {
  console.log(`\nLooking up ${without.length} places with no coordinate:\n`);
  const found: string[] = [];
  for (const z of without) {
    const hit = await geocodePlace(z.place);
    if (!hit) {
      console.log(`  ${z.place.padEnd(26)} not found`);
      continue;
    }
    const road = await roadDistance(centre, { latitude: hit.latitude, longitude: hit.longitude });
    const km = road ? Math.round((road.metres / 1000) * 10) / 10 : 0;
    console.log(
      `  ${z.place.padEnd(26)} ${hit.latitude.toFixed(5)}, ${hit.longitude.toFixed(5)}` +
        `  ${km ? `${km} km by road` : 'no route'}  — ${hit.formatted.slice(0, 44)}`,
    );
    found.push([z.place, z.zone, z.fee, hit.latitude, hit.longitude, km, `"${hit.formatted}"`, hit.kind].join(','));
  }
  fs.writeFileSync(
    FOUND,
    ['place,zone,fee,lat,lng,road_km,found_as,kind'].concat(found).join('\n') + '\n',
    'utf8',
  );
  console.log(`\nWritten to ${FOUND}`);
}

console.log(`Written to ${ROADS}`);
console.log('\nNothing was changed. The prices are yours to set.');

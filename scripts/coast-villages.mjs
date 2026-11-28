// As before, with the last two faults out of it.
//
//   - The border is the border, not the river. "South Drain" is the
//     Suriname side of the ferry and the river test let it through, so the
//     admin boundary itself now decides which country a place is in.
//   - Tertiary roads reach every corner of Georgetown and every hamlet
//     inland, which took the list from 300 to 468. They are only needed for
//     the last few kilometres to the ferry, so they count only south of
//     latitude 6.0 — the Corentyne leg, where the national route stops
//     being tagged secondary.
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE = path.resolve('./data/overpass-cache');

const cached = (name) => {
  const file = path.join(CACHE, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).elements ?? [];
  } catch {
    return null;
  }
};

async function ask(query, name) {
  const had = cached(name);
  if (had) {
    console.log(`  ${name}: ${had.length} from cache`);
    return had;
  }
  let lastError = '';
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'village-import/1.0',
        },
        body: new URLSearchParams({ data: query }).toString(),
      });
      if (!res.ok) {
        lastError = `${url} answered ${res.status}`;
        continue;
      }
      const text = await res.text();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(path.join(CACHE, `${name}.json`), text, 'utf8');
      const els = JSON.parse(text).elements ?? [];
      console.log(`  ${name}: ${els.length} from ${new URL(url).host}`);
      return els;
    } catch (err) {
      lastError = `${url}: ${String(err)}`;
    }
  }
  throw new Error(`no Overpass mirror answered — ${lastError}`);
}

const BOX = '5.70,-58.20,6.95,-56.90';
const R = 6371;
const km = (a, b) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Asked for, not assumed. The cache under data/overpass-cache is working
// material and is not committed, so a fresh clone has to be able to fetch
// these itself or the village list has no source anybody else can check.
const places = await ask(
  `[out:json][timeout:300];` +
    `node["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"](${BOX});` +
    `out body;`,
  'coast-1-places',
);

const roadsAll = await ask(
  `[out:json][timeout:300];` +
    `way["highway"~"^(trunk|primary|secondary|tertiary)$"](${BOX});` +
    `out geom;`,
  'coast-3-road',
);

/* ------------------------------------------------- the national border itself */
const border = await ask(
  `[out:json][timeout:300];` +
    `way["boundary"="administrative"]["admin_level"="2"](${BOX});` +
    `out geom;`,
  'coast-4-border',
);
const edge = [];
for (const w of border) for (const p of w.geometry ?? []) if (p) edge.push({ lat: p.lat, lon: p.lon });
console.log(`  border: ${border.length} ways, ${edge.length} points`);

/** East of the national border at this latitude is Suriname. */
const inSuriname = (p) => {
  let nearest = null;
  let gap = Infinity;
  for (const b of edge) {
    const d = Math.abs(b.lat - p.lat);
    if (d < gap) {
      gap = d;
      nearest = b;
    }
  }
  if (!nearest || gap > 0.1) return false;
  return p.lon > nearest.lon;
};

/* ---------------------------------- the through road, tertiary only at the end */
const line = [];
for (const w of roadsAll) {
  const kind = w.tags?.highway ?? '';
  for (const p of w.geometry ?? []) {
    if (!p) continue;
    if (kind === 'tertiary' && p.lat > 6.0) continue;
    line.push({ lat: p.lat, lon: p.lon });
  }
}
console.log(`  road points in play: ${line.length}`);

const nearestRoadKm = (p) => {
  let best = Infinity;
  for (const r of line) {
    if (Math.abs(r.lon - p.lon) > 0.06) continue;
    const d = km(p, r);
    if (d < best) best = d;
  }
  return best;
};

/* ------------------------------------------------------------------- the list */
const FROM = { lat: 6.8077, lon: -58.1622 };
const priced = new Set(
  fs
    .readFileSync('./data/delivery-zones.csv', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('place,'))
    .map((l) => l.split(',')[0]?.trim().toLowerCase())
    .filter(Boolean),
);

const seen = new Set();
const kept = [];
const dropped = { suriname: [], offRoad: 0 };

for (const el of places) {
  const name = el.tags?.name;
  if (!name || seen.has(name)) continue;
  seen.add(name);
  const p = { lat: el.lat, lon: el.lon };
  if (inSuriname(p)) {
    dropped.suriname.push(name);
    continue;
  }
  const off = nearestRoadKm(p);
  if (off > 2.5) {
    dropped.offRoad += 1;
    continue;
  }
  // Only the corridor actually asked about. The box is a rectangle, so it
  // also holds the West Bank, the West Coast and the East Bank road south
  // to Timehri — none of which is on the way to Moleson Creek. The route
  // out of Georgetown runs EAST, so east of the city is the route.
  if (p.lon < -58.10) {
    dropped.offRoute = (dropped.offRoute ?? 0) + 1;
    continue;
  }

  kept.push({
    name,
    kind: el.tags.place,
    lon: p.lon,
    km: Math.round(km(FROM, p) * 10) / 10,
    offRoad: Math.round(off * 10) / 10,
    priced: priced.has(name.toLowerCase()),
  });
}

kept.sort((a, b) => a.km - b.km);

const out = ['order,name,kind,km_from_georgetown,km_off_road,already_priced'];
kept.forEach((p, i) => {
  out.push([i + 1, p.name, p.kind, p.km, p.offRoad, p.priced ? 'yes' : 'no'].join(','));
});
console.log(`dropped off this route (west side, East Bank): ${dropped.offRoute ?? 0}`);
fs.writeFileSync('./data/coast-to-moleson-creek.csv', out.join('\n') + '\n', 'utf8');

console.log('');
console.log(`${kept.length} settlements on the road, Georgetown to Moleson Creek`);
console.log(`  ${kept.filter((p) => p.priced).length} already priced, ${kept.filter((p) => !p.priced).length} new`);
console.log(`dropped across the border: ${dropped.suriname.length} — ${dropped.suriname.slice(0, 8).join(', ')}`);
console.log(`dropped off the road: ${dropped.offRoad}`);
console.log(`furthest: ${kept.at(-1)?.name} at ${kept.at(-1)?.km} km`);
const moleson = kept.find((p) => /moleson/i.test(p.name));
console.log(`Moleson Creek: ${moleson ? `#${kept.indexOf(moleson) + 1} at ${moleson.km} km` : 'MISSING'}`);

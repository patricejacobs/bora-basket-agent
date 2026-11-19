/**
 * A draft fare between any two bands, written out as a table to be corrected.
 *
 *   npm run zones:matrix
 *
 * data/delivery-zones.csv prices one journey: out of Georgetown. That is the
 * right table for a shop that packs every order itself, and the wrong one for
 * a parcel from Diamond to Mahaica or a car from Vreed-en-Hoop to Parika,
 * neither of which goes anywhere near Stabroek.
 *
 * This turns that one column into a matrix: every band is an origin, and from
 * each of them a delivery inside the same band is $500, the way it is inside
 * Georgetown today.
 *
 * WHAT IT IS NOT: a survey. It is arithmetic over a table that was itself
 * written from general knowledge, so it inherits every error in that file and
 * adds its own. It exists to be read, corrected, and only then believed — the
 * same footing data/delivery-zones.csv started on.
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = path.resolve('./data/delivery-zones.csv');
const OUT = path.resolve('./data/zone-tariff-matrix.csv');

/** The cheapest delivery there is: next door, whoever you are. */
const BASE = 500;

/**
 * The bridge, and everything it costs to be on the far side of the river.
 *
 * The west side is priced from the crossing rather than from the map:
 * Vreed-en-Hoop is five kilometres from Stabroek and twenty-five by road. So
 * $2,000 of every west-side fare is the detour, and it must not be charged
 * twice to somebody travelling between two places that are both already over
 * there. Without this, Vreed-en-Hoop to Crane - a few minutes apart - priced
 * as $5,000, which is the fare to Parika.
 */
const BRIDGE = 2000;

type Band = {
  corridor: string;
  zone: string;
  fee: number;
  /** What the distance out of Georgetown costs, with the base stripped off. */
  out: number;
  places: string[];
};

function readBands(): Band[] {
  const lines = fs.readFileSync(SOURCE, 'utf8').split(/\r?\n/);
  const bands = new Map<string, Band>();
  let corridor = '';

  for (const line of lines) {
    // The section headings are the corridors, and they are the only thing
    // that says which places are on the road to which others.
    const heading = line.match(/^#\s*-+\s*(.+?)\s*$/);
    if (heading) {
      corridor = heading[1]!.replace(/,.*$/, '').trim();
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith('place,')) continue;

    const [place, zone, fee] = line.split(',');
    if (!place || !zone || !fee) continue;
    const amount = Number(fee);
    if (!Number.isFinite(amount)) continue;

    const key = `${corridor}|${amount}`;
    const band = bands.get(key) ?? {
      corridor,
      zone,
      fee: amount,
      out: amount - BASE,
      places: [],
    };
    band.places.push(place);
    bands.set(key, band);
  }

  return [...bands.values()];
}

/** True where two corridors are the same road for a while. */
function sharedTrunk(a: Band, b: Band): number {
  if (a.corridor === b.corridor) return Math.min(a.out, b.out);
  // Georgetown is the hub: it is on the way to everywhere, so a journey from
  // it is the difference and not the sum.
  if (a.corridor === 'Georgetown' || b.corridor === 'Georgetown') {
    return Math.min(a.out, b.out);
  }
  // Both sides of the river share the bridge and the run up to it. They part
  // company at Vreed-en-Hoop, one going south and one going west.
  const west = (c: string) => c.startsWith('West');
  if (west(a.corridor) && west(b.corridor)) return BRIDGE;
  // Everything else parts company in Georgetown itself - the East Coast road
  // and the East Bank road leave town in different directions - so the fare
  // is one leg in and one leg out.
  return 0;
}

/**
 * What it should cost to carry something from one band to another.
 *
 * Distance is the only thing in here. Not the time of day, not how hard the
 * road is, not whether anybody wants to come back from there empty.
 */
export function fareBetween(a: Band, b: Band): number {
  const trunk = sharedTrunk(a, b);
  return BASE + Math.max(0, a.out - trunk) + Math.max(0, b.out - trunk);
}

const bands = readBands().sort(
  (x, y) => x.corridor.localeCompare(y.corridor) || x.fee - y.fee,
);

const rows = [
  'from_corridor,from_zone,from_fee,to_corridor,to_zone,to_fee,fare',
  ...bands.flatMap((from) =>
    bands.map((to) =>
      [
        from.corridor,
        from.zone,
        from.fee,
        to.corridor,
        to.zone,
        to.fee,
        fareBetween(from, to),
      ].join(','),
    ),
  ),
];

fs.writeFileSync(OUT, rows.join('\n') + '\n', 'utf8');

console.log(`${bands.length} bands, ${rows.length - 1} fares → ${OUT}`);
console.log('');
for (const band of bands) {
  const others = bands.filter((b) => b !== band);
  const cheapest = Math.min(...others.map((b) => fareBetween(band, b)));
  const dearest = Math.max(...others.map((b) => fareBetween(band, b)));
  console.log(
    `${`${band.corridor} $${band.fee}`.padEnd(34)} own band $${BASE}` +
      `  ·  next $${cheapest}  ·  furthest $${dearest}` +
      `   (${band.places[0]}${band.places.length > 1 ? ` +${band.places.length - 1}` : ''})`,
  );
}

/**
 * Reads the tariff against the map and prints what cannot both be true.
 *
 *   npm run tariff:check
 *
 * One kind of fault, found one way: within a single corridor, a place NEARER
 * to town that costs MORE than a place farther out. Going somewhere closer
 * cannot cost more on a road that passes one to reach the other, and a
 * passenger who changes their mind to a nearer village and is charged extra
 * has been overcharged by the price list, not by anybody at the shop.
 *
 * The distances are straight-line from the town centre, geocoded once into
 * data/zone-coordinates-review.csv. Straight-line is not road distance and
 * the two differ most where a river or a dam intervenes, so this prints
 * evidence for a person to price, and changes nothing by itself. A 1.5 km
 * margin keeps near-neighbours out of it: two villages a few hundred metres
 * apart can sit either way round without anybody being wrong.
 *
 * Places without a confident geocode are skipped and counted at the end,
 * because an inversion against a coordinate nobody trusts is not a finding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tariff } from './zones.ts';

type Place = {
  place: string;
  zone: string;
  fee: number;
  corridor: string;
  km: number;
  status: string;
};

const SOURCE = path.resolve('./data/zone-coordinates-review.csv');
const REPORT = path.resolve('./data/tariff-inversions.csv');

/** A margin below which two places are simply neighbours, not out of order. */
const MARGIN_KM = 1.5;

const cells = (line: string): string[] => {
  // The note column is quoted and holds commas; nothing before it does.
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

const rows: Place[] = fs
  .readFileSync(SOURCE, 'utf8')
  .split(/\r?\n/)
  .slice(1)
  .filter((line) => line.trim() !== '')
  .map((line) => {
    const c = cells(line);
    return {
      place: c[0] ?? '',
      zone: c[1] ?? '',
      fee: Number(c[2] ?? 0),
      corridor: c[3] ?? '',
      km: Number(c[6] ?? 0),
      status: (c[7] ?? '').trim(),
    };
  });

// The PRICE comes from the live tariff, never from the review file beside
// it. That file was written once, when the places were geocoded, and a fee
// copied into it goes stale the first time a price is corrected — which
// would have this tool reporting a fault that had already been fixed, or
// worse, missing one that had just been introduced. What it is read for is
// the coordinates, which is the part the tariff does not know.
const priced = new Map(tariff().map((z) => [z.place, z]));

const usable = rows
  .filter((r) => r.km > 0 && r.status === 'ok' && priced.has(r.place))
  .map((r) => {
    const live = priced.get(r.place)!;
    return { ...r, fee: live.fee, zone: live.zone };
  })
  .filter((r) => r.fee > 0);
const skipped = rows.length - usable.length;

const byCorridor = new Map<string, Place[]>();
for (const r of usable) byCorridor.set(r.corridor, [...(byCorridor.get(r.corridor) ?? []), r]);

/**
 * Two places on the same corridor but not on the same road.
 *
 * The Soesdyke–Linden Highway leaves the East Bank road at Soesdyke, so Kuru
 * Kururu is not passed on the way to Timehri however the crow flies: it is
 * down a different branch, and farther by road while nearer in a straight
 * line. A pair like that is an artefact of the measurement and not a fault
 * in the price, so it is marked rather than silently counted.
 */
const branches = (a: Place, b: Place): boolean =>
  /highway/i.test(a.zone) !== /highway/i.test(b.zone);

type Inversion = { corridor: string; near: Place; far: Place };
const found: Inversion[] = [];

for (const [corridor, list] of [...byCorridor].sort()) {
  const ladder = [...list].sort((a, b) => a.km - b.km);
  for (let i = 0; i < ladder.length; i++) {
    for (let j = i + 1; j < ladder.length; j++) {
      const near = ladder[i]!;
      const far = ladder[j]!;
      if (far.km - near.km >= MARGIN_KM && far.fee < near.fee) {
        found.push({ corridor, near, far });
      }
    }
  }
}

/* --------------------------------------------------------------- the ladders */

const line = (p: Place, flag: string): string =>
  `  ${flag} ${String(p.km).padStart(5)} km  ${p.place.padEnd(24)} $${String(p.fee).padStart(5)}  ${p.zone}`;

for (const [corridor, list] of [...byCorridor].sort()) {
  const mine = found.filter((f) => f.corridor === corridor);
  if (mine.length === 0) continue;

  // A place is flagged when something farther out is cheaper than it, which
  // is the row worth looking at: the one priced above its neighbours.
  const overpriced = new Set(mine.map((f) => f.near.place));
  const underpriced = new Set(mine.map((f) => f.far.place));

  console.log('');
  console.log(`${corridor} — ${mine.length} inversion(s)`);
  for (const p of [...list].sort((a, b) => a.km - b.km)) {
    const flag = overpriced.has(p.place) ? '▲' : underpriced.has(p.place) ? '▼' : ' ';
    if (flag !== ' ') console.log(line(p, flag));
  }
}

/* ----------------------------------------------------------------- the pairs */

console.log('');
console.log('Every pair, nearer place first:');
console.log('');
for (const f of found) {
  console.log(
    `  ${branches(f.near, f.far) ? '†' : ' '} ${f.corridor.padEnd(20)} ${f.near.place} (${f.near.km}km, $${f.near.fee})` +
      ` costs MORE than ${f.far.place} (${f.far.km}km, $${f.far.fee})`,
  );
}

/* --------------------------------------------------------------- the report */

const report = [
  'corridor,nearer_place,nearer_km,nearer_fee,nearer_band,farther_place,farther_km,farther_fee,farther_band,gap_km,fee_difference,note',
  ...found.map((f) =>
    [
      f.corridor,
      f.near.place,
      f.near.km,
      f.near.fee,
      f.near.zone,
      f.far.place,
      f.far.km,
      f.far.fee,
      f.far.zone,
      Math.round((f.far.km - f.near.km) * 10) / 10,
      f.near.fee - f.far.fee,
      branches(f.near, f.far) ? 'different branch - straight-line distance misleads here' : '',
    ].join(','),
  ),
].join('\n');
fs.writeFileSync(REPORT, report + '\n', 'utf8');

/* --------------------------------------------------------------- the tally */

const blame = new Map<string, number>();
for (const f of found) {
  blame.set(f.near.place, (blame.get(f.near.place) ?? 0) + 1);
  blame.set(f.far.place, (blame.get(f.far.place) ?? 0) + 1);
}

console.log('');
console.log('Rows appearing in the most pairs — fix these first:');
for (const [place, count] of [...blame].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  const row = usable.find((r) => r.place === place)!;
  console.log(`  ${String(count).padStart(2)}x  ${place.padEnd(24)} ${row.km}km  $${row.fee}  [${row.zone}]`);
}

console.log('');
console.log(
  `${found.length} inversion(s) across ${usable.length} geocoded places` +
    `${skipped > 0 ? `, ${skipped} without a confident coordinate and skipped` : ''}.`,
);
console.log(`Written to ${REPORT}`);
const marked = found.filter((f) => branches(f.near, f.far)).length;
if (marked > 0) {
  console.log(
    `† ${marked} pair(s) sit on different branches of one corridor — the Highway leaves` +
      ' the East Bank road at Soesdyke, so straight-line distance misleads there.',
  );
}
console.log('Straight-line distances. Nothing was changed — the prices are yours to set.');

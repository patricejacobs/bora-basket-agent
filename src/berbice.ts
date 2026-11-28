/**
 * Prices the Berbice road into the tariff: Mahaicony to Moleson Creek.
 *
 *     npm run berbice
 *
 * **Taxi fares only.** One table has always priced two different things —
 * the fare on a trip and the charge on a delivery — and that held while the
 * tariff reached only as far as an associate could go and come back. Berbice
 * does not: Moleson Creek is a 190 km drive each way. So every row this
 * writes carries `taxi` in a fourth column, fares read them and the delivery
 * charge does not.
 *
 * **The rate is the tariff's own.** Georgetown is $500 at 2 km from
 * Stabroek and Mahaicony is $5,000 at 47 km, which is $100 a kilometre. The
 * new fares continue that line rather than starting a new one, so there is
 * no step at Mahaicony where the same road suddenly costs a different rate.
 * Change PER_KM and run it again; nothing else needs touching.
 *
 * It is worth knowing what that rate is NOT. A three-and-a-half hour run to
 * Corriverton usually costs less per kilometre than a twenty-minute one, so
 * a flat continuation is the simple answer rather than the right one. It is
 * one number in this file when somebody decides otherwise.
 *
 * **The places come from the map**, not from memory: `data/coast-to-moleson-
 * creek.csv`, which is every settlement OpenStreetMap carries within 2.5 km
 * of the through road, in order, Guyana only. The file this writes into says
 * of itself "WRITTEN FROM GENERAL KNOWLEDGE, NOT FROM A SURVEY" — these rows
 * are the survey.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseZones, loadZones, findZone, type Zone } from './zones.ts';

/** Dollars per kilometre beyond Mahaicony. The tariff's own rate. */
const PER_KM = 100;

/** Where the priced road ends today, and what it costs to get there. */
const FROM_PLACE = 'Mahaicony';
const FROM_KM = 47.2;
const FROM_FEE = 5000;

/** Fares are round hundreds everywhere else in this file. */
const ROUND_TO = 100;

const VILLAGES = path.resolve('./data/coast-to-moleson-creek.csv');
const TARIFF = path.resolve('./data/delivery-zones.csv');

/**
 * The road all of this is on, and it is the one the East Coast is on.
 *
 * Bands say how far; corridors say WHICH WAY. Giving Berbice corridors of
 * its own looked tidier and priced a 60 km trip from New Amsterdam to
 * Corriverton at $24,800 — more than the 158 km run to Moleson Creek —
 * because two places in different corridors are treated as opposite
 * directions out of Georgetown and have their fares added. They are not
 * opposite directions. They are the same road, one after the other, and
 * naming it so makes the fare between them the difference instead.
 */
const ROAD = 'East Coast Demerara';

/**
 * The bands, by distance. Named for the road rather than for the money,
 * because that is what dispatch reads them for — two places twenty minutes
 * apart on one road are nearer each other than two bands of equal price on
 * opposite sides of a river.
 */
const BANDS: { upTo: number; zone: string; corridor: string }[] = [
  { upTo: 80, zone: 'West Coast Berbice near', corridor: ROAD },
  { upTo: 100, zone: 'West Coast Berbice', corridor: ROAD },
  { upTo: 125, zone: 'Corentyne near', corridor: ROAD },
  { upTo: 145, zone: 'Corentyne', corridor: ROAD },
  { upTo: 999, zone: 'Corentyne far', corridor: ROAD },
];

type Village = { name: string; km: number; priced: boolean };

function read(): Village[] {
  if (!fs.existsSync(VILLAGES)) {
    throw new Error(`${VILLAGES} is missing — the village list has to be built first`);
  }
  const lines = fs.readFileSync(VILLAGES, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  return lines.map((line) => {
    const cells = line.split(',');
    return {
      name: (cells[1] ?? '').trim(),
      km: Number(cells[3] ?? 0),
      priced: (cells[5] ?? '').trim() === 'yes',
    };
  });
}

/** What a car to this village costs, continuing the tariff's own line. */
export function fareAt(km: number, perKm = PER_KM): number {
  const beyond = Math.max(0, km - FROM_KM);
  const raw = FROM_FEE + beyond * perKm;
  return Math.round(raw / ROUND_TO) * ROUND_TO;
}

function bandFor(km: number): { zone: string; corridor: string } {
  for (const band of BANDS) if (km <= band.upTo) return band;
  return BANDS[BANDS.length - 1]!;
}

/**
 * The names a customer might write, from one name on the map.
 *
 * The Corentyne's villages are numbered and most carry a second name, which
 * the map holds in one string: "No. 5 or Albion". Left whole it matches
 * nothing anybody would type, and reduced to the number alone it loses
 * Albion, which is how everyone says it. So both become rows at the same
 * fare — not an invented nickname, which is somebody else's decision, but
 * the two names the map itself records.
 */
export function namesFor(mapName: string): string[] {
  const parts = mapName
    .split(/\s+or\s+|\s*\/\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const part of parts) {
    // A bare number is never a place name here, whatever the map calls it.
    //
    // Writing "No. 4" into the tariff made every address with a 4 in it a
    // candidate for a Corentyne village: "Lot 4 Diamond" came back as a
    // choice between No. 4 and No. 44, two hundred kilometres apart and
    // nine thousand dollars different. The matcher allows a letter of slack
    // per seven and a two-character name has none to spare — the same
    // reason numbered STREETS were given no slack at all.
    //
    // Where the number carries a name with it, the name is the row and the
    // whole form is a second one: "No. 15 Susannah" gives Susannah, which
    // is what somebody writes, and the full name, which is what the map
    // says.
    const stripped = part.replace(/^(?:no[.]?|number)[ ]*[0-9]+[ ]*/i, '').trim();
    if (!stripped) continue;
    out.push(stripped);
    if (stripped.toLowerCase() !== part.toLowerCase()) out.push(part);
  }

  const seen = new Set<string>();
  return out.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether adding this row would spoil a name the tariff already carries.
 *
 * The matcher is deliberately forgiving — it matches on sound and allows a
 * letter of slack per seven — so adding a name is not only adding a name.
 * It can make an existing one ambiguous, and an ambiguous place is a
 * question where there used to be a price. Two hundred new names went in
 * and "Diamond" started coming back as East Canje, nine thousand dollars
 * and a hundred kilometres away.
 *
 * So every candidate is tried before it is kept: with it in the tariff,
 * every name already priced must still find itself. One that breaks even a
 * single existing place is not worth the village it would add — a customer
 * who cannot get a price for Diamond is a worse outcome than one who has to
 * name a neighbouring village in Berbice.
 */
/**
 * Whether adding this row changes an answer the tariff already gives.
 *
 * The matcher is deliberately forgiving — it matches on sound, allows a
 * letter of slack per seven, and prefers a LONGER name — so adding a name
 * is not only adding a name. With East Canje in the tariff, "Diamond, East
 * Bank" came back as East Canje: the wrong side of the country and nine
 * thousand dollars different, while "Diamond" on its own stayed right.
 *
 * The test is NO CHANGE, not correctness. An earlier version of this guard
 * asserted what each probe ought to return and refused every candidate,
 * because "Kingston, Georgetown" already answers Georgetown and always has.
 * Whether that is right is a separate question and not this file's to
 * settle; what this file must not do is make it different.
 */
type Answer = string;

function answersFor(probes: string[]): Map<string, Answer> {
  const out = new Map<string, Answer>();
  for (const probe of probes) {
    const found = findZone(probe);
    out.set(probe, found.kind === 'found' ? found.match.place : found.kind);
  }
  return out;
}

/**
 * The probes: every place the way customers write it.
 *
 * Bare names are not enough, which is the whole lesson of East Canje — the
 * collision only appears once the corridor or a lot number is in front of
 * it, because that is when a longer name can win.
 */
function probesFor(base: Zone[]): string[] {
  const out: string[] = [];
  for (const z of base) {
    out.push(z.place);
    out.push(`${z.place}, ${z.corridor}`);
    out.push(`Lot 12 ${z.place}`);
  }
  // And the addresses that are not places, which must stay that way: a
  // tariff that starts pricing "by the big mango tree" has begun guessing.
  out.push('by the big mango tree');
  out.push('the yellow house by the mosque');
  out.push('behind the school');
  out.push('third gate after the church');
  return out;
}

function wouldChangeAnything(
  candidate: Zone,
  base: Zone[],
  probes: string[],
  before: Map<string, Answer>,
): string {
  loadZones(asCsv([...base, candidate]));
  for (const probe of probes) {
    const found = findZone(probe);
    const now = found.kind === 'found' ? found.match.place : found.kind;
    const was = before.get(probe);
    if (now === was) continue;
    return `"${probe}" was ${was}, becomes ${now}`;
  }
  return '';
}

/** A tariff back into the shape parseZones reads, so it can be loaded. */
function asCsv(zones: Zone[]): string {
  const out = ['place,zone,fee,taxi_only'];
  let corridor = '';
  for (const z of zones) {
    if (z.corridor !== corridor) {
      corridor = z.corridor;
      out.push(`# ---------------------------------------------------------------- ${corridor}`);
    }
    out.push(`${z.place},${z.zone},${z.fee},${z.taxiOnly ? 'taxi' : ''}`);
  }
  return out.join('\n');
}

function main(): void {
  const villages = read()
    .filter((v) => v.km > FROM_KM && !v.priced && v.name)
    .sort((a, b) => a.km - b.km);

  const already = new Set(
    fs
      .readFileSync(TARIFF, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('place,'))
      .map((l) => l.split(',')[0]?.trim().toLowerCase())
      .filter(Boolean),
  );

  // The tariff as it stands, and every name in it, which is what must still
  // work afterwards.
  const base = parseZones(fs.readFileSync(TARIFF, 'utf8'));
  const probes = probesFor(base);
  // What the tariff answers today. Every candidate has to leave all of it
  // exactly as it is.
  loadZones(asCsv(base));
  const before = answersFor(probes);

  const rows: { corridor: string; line: string; place: string; fee: number; km: number }[] = [];
  const spoiled: string[] = [];
  const kept: Zone[] = [];

  for (const v of villages) {
    const band = bandFor(v.km);
    const fee = fareAt(v.km);
    for (const name of namesFor(v.name)) {
      if (already.has(name.toLowerCase())) continue;
      const candidate: Zone = {
        place: name,
        zone: band.zone,
        fee,
        taxiOnly: true,
        corridor: band.corridor,
      };
      const breaks = wouldChangeAnything(candidate, [...base, ...kept], probes, before);
      if (breaks) {
        spoiled.push(`${name} (${breaks})`);
        continue;
      }
      already.add(name.toLowerCase());
      kept.push(candidate);
      rows.push({
        corridor: band.corridor,
        place: name,
        fee,
        km: v.km,
        line: `${name},${band.zone},${fee},taxi`,
      });
    }
  }

  // Put the real tariff back, so nothing downstream is left holding the
  // trial copy this function has been loading and reloading.
  loadZones(fs.readFileSync(TARIFF, 'utf8'));

  // Grouped under the section headings the parser reads corridors from.
  const byCorridor = new Map<string, typeof rows>();
  for (const row of rows) {
    const held = byCorridor.get(row.corridor) ?? [];
    held.push(row);
    byCorridor.set(row.corridor, held);
  }

  const out: string[] = [
    '',
    '# ================================================================',
    '# TAXI FARES ONLY — the fourth column says so, and the delivery',
    '# charge skips every row that carries it. Moleson Creek is a 190 km',
    '# drive each way: a car can be sent, a bag of rice cannot.',
    '#',
    `# Priced at $${PER_KM} the kilometre beyond ${FROM_PLACE}, which is the`,
    `# tariff's own rate — ${FROM_PLACE} is $${FROM_FEE} at ${FROM_KM} km, and`,
    '# Georgetown $500 at 2 km. Continuing that line rather than starting a',
    '# new one, so the same road does not change rate halfway along it.',
    '#',
    '# Places and distances from OpenStreetMap, not from memory: every',
    '# settlement within 2.5 km of the through road, Guyana only, ordered by',
    '# distance from Georgetown. See src/berbice.ts and npm run berbice.',
    '# ================================================================',
  ];

  for (const [corridor, held] of byCorridor) {
    out.push('');
    out.push(`# ---------------------------------------------------------------- ${corridor}`);
    for (const row of held) out.push(row.line);
  }

  const body = fs.readFileSync(TARIFF, 'utf8').replace(/\s*$/, '');
  fs.writeFileSync(TARIFF, `${body}\n${out.join('\n')}\n`, 'utf8');

  const skipped = villages.filter((v) => namesFor(v.name).length === 0);
  console.log(`${rows.length} taxi-only row(s) written to data/delivery-zones.csv`);
  console.log(`  from ${villages.length - skipped.length} village(s) beyond ${FROM_PLACE}, at $${PER_KM}/km`);
  if (spoiled.length > 0) {
    console.log(`  ${spoiled.length} refused, because they changed an answer already given:`);
    for (const line of spoiled.slice(0, 20)) console.log(`    ${line}`);
    if (spoiled.length > 20) console.log(`    ... and ${spoiled.length - 20} more`);
  }
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} skipped, named by a number alone and nothing else:`);
    console.log(`    ${skipped.map((v) => v.name).join(', ')}`);
  }
  console.log('');
  for (const anchor of [
    'Fort Wellington',
    'Rosignol',
    'New Amsterdam',
    'Albion',
    'Rose Hall',
    'Port Mourant',
    'Corriverton',
    'Crabwood Creek',
    'Moleson Creek',
  ]) {
    const row = rows.find((r) => r.place.toLowerCase() === anchor.toLowerCase());
    if (row) console.log(`  ${anchor.padEnd(18)} ${String(row.km).padStart(6)} km   $${row.fee.toLocaleString()}`);
    else console.log(`  ${anchor.padEnd(18)} (not in the list)`);
  }
}

// Only when run on purpose. `fareAt` and `namesFor` are read by the test
// suite, and a module that rewrites the tariff the moment it is imported
// would price Berbice again on every run.
if (process.argv[1] && /berbice\.ts$/.test(process.argv[1])) main();

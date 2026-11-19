/**
 * Which parts of the map the shop covers, and which parts the work is in.
 *
 * Two questions the shop could not ask before, and they belong in one answer
 * because neither is useful alone. Coverage with no demand is somebody sitting
 * in Mahaicony earning nothing; demand with no coverage is a Georgetown
 * associate driving an hour each way and the fee not covering it.
 *
 * Nothing here changes a price or a dispatch. It exists to tell a shop where
 * to put the next associate, which is a decision for a person with the figures
 * in front of them.
 */
import * as repo from './db/repo.ts';
import { findZone, zones } from './zones.ts';
import { money } from './config.ts';

export type ZoneDemand = {
  /** The band's label, as the tariff names it. */
  zone: string;
  /** What a delivery into that band costs from Georgetown. */
  fee: number;
  jobs: number;
  /** Associates who work from a place in this band, named. */
  based: string[];
  /** Of those, how many are on duty this minute. */
  onDuty: number;
};

/**
 * The band a job belongs to, worked out from whatever the job actually says.
 *
 * A delivery had its zone priced and stored when it was placed. A parcel or a
 * taxi never did - they are quoted by the associate, not by the tariff - so
 * their band is read back out of the addresses they were booked with.
 *
 * The PICKUP is what counts here, not the destination. This report exists to
 * answer where an associate should be standing, and an associate stands where
 * the job starts. For a delivery out of the shop that is Georgetown, which is
 * why a delivery is counted by where it was going instead: the shop is always
 * at one end of it.
 */
export function bandOf(order: repo.OrderRecord): string {
  if (order.kind === 'parcel' || order.kind === 'taxi') {
    const said = order.pickup?.address ?? '';
    const found = said ? findZone(said) : { kind: 'unknown' as const };
    return found.kind === 'found' ? found.match.zone : '';
  }
  if (order.deliveryZone) {
    const found = findZone(order.deliveryZone);
    if (found.kind === 'found') return found.match.zone;
  }
  const said = order.address || order.location?.label || '';
  const found = said ? findZone(said) : { kind: 'unknown' as const };
  return found.kind === 'found' ? found.match.zone : '';
}

/** The cheapest fee in a band, which is how the bands are ordered and named. */
function feeOf(zone: string): number {
  const fees = zones().filter((z) => z.zone === zone).map((z) => z.fee);
  return fees.length > 0 ? Math.min(...fees) : 0;
}

/**
 * Every band that has work in it or somebody in it, with both counts.
 *
 * Ordered by the work rather than by the map: the top of this list is where
 * the next associate belongs, and a shop reading it should not have to sort
 * forty-four rows in their head.
 */
export function coverage(days = 30): {
  bands: ZoneDemand[];
  /** Jobs whose band could not be worked out at all, and why that matters. */
  unplaced: number;
  since: Date;
  total: number;
} {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = repo.allOrders().filter((o) => new Date(o.placedAt) >= since);

  const counted = new Map<string, number>();
  let unplaced = 0;
  for (const order of recent) {
    const band = bandOf(order);
    if (!band) {
      unplaced += 1;
      continue;
    }
    counted.set(band, (counted.get(band) ?? 0) + 1);
  }

  // Where the associates work from. An associate with no base is not counted
  // anywhere rather than counted in Georgetown: assuming it is how a shop
  // ends up believing a coast is covered.
  const basedIn = new Map<string, { names: string[]; onDuty: number }>();
  for (const who of repo.listAssociates()) {
    if (!who.active || !who.basePlace) continue;
    const found = findZone(who.basePlace);
    if (found.kind !== 'found') continue;
    const entry = basedIn.get(found.match.zone) ?? { names: [], onDuty: 0 };
    entry.names.push(who.name || `+${who.phone}`);
    if (repo.isOnDuty(who.phone)) entry.onDuty += 1;
    basedIn.set(found.match.zone, entry);
  }

  const names = new Set([...counted.keys(), ...basedIn.keys()]);
  const bands: ZoneDemand[] = [...names].map((zone) => ({
    zone,
    fee: feeOf(zone),
    jobs: counted.get(zone) ?? 0,
    based: basedIn.get(zone)?.names ?? [],
    onDuty: basedIn.get(zone)?.onDuty ?? 0,
  }));

  bands.sort((a, b) => b.jobs - a.jobs || a.fee - b.fee || a.zone.localeCompare(b.zone));

  return { bands, unplaced, since, total: recent.length };
}

/** The report as the shop reads it on a phone. */
export function coverageReport(days = 30): string {
  const { bands, unplaced, total } = coverage(days);
  const nl = String.fromCharCode(10);

  if (total === 0) {
    return [
      `*Coverage* — last ${days} days`,
      '',
      'No orders in that window, so there is nothing to say about where the',
      'work is yet. Come back when the shop has traded for a while.',
    ].join(nl);
  }

  const withWork = bands.filter((b) => b.jobs > 0);
  const gaps = withWork.filter((b) => b.based.length === 0);
  const idle = bands.filter((b) => b.based.length > 0 && b.jobs === 0);

  const line = (b: ZoneDemand): string => {
    const who =
      b.based.length === 0
        ? '— nobody based here'
        : `${b.based.join(', ')}${b.onDuty > 0 ? ` (${b.onDuty} on duty)` : ' (none on duty)'}`;
    return `*${b.zone}* ${money(b.fee)} · ${b.jobs} ${b.jobs === 1 ? 'job' : 'jobs'}${nl}   ${who}`;
  };

  return [
    `*Coverage* — last ${days} days, ${total} ${total === 1 ? 'job' : 'jobs'}`,
    '',
    ...(withWork.length > 0
      ? [...withWork.map(line)]
      : ['No job could be placed on the map. See the note below.']),
    ...(idle.length > 0
      ? ['', '*Covered, no work*', ...idle.map((b) => `${b.zone} — ${b.based.join(', ')}`)]
      : []),
    ...(() => {
      if (gaps.length === 0) return [];
      // Ranked by the driving, not by the job count. Seven runs into
      // Georgetown and seven up the East Bank are the same number and
      // nothing like the same argument: one is a city round somebody is
      // already doing, the other is seven hours on a highway. Jobs times the
      // band's fee is the closest thing to "how much road" this shop knows.
      const worst = [...gaps].sort((a, b) => b.jobs * b.fee - a.jobs * a.fee)[0]!;
      return [
        '',
        `*Most driving with nobody based there:* ${worst.zone} — ${worst.jobs} ${worst.jobs === 1 ? 'job' : 'jobs'} at ${money(worst.fee)}.`,
      ];
    })(),
    // Said plainly, because an associate counted nowhere makes every line
    // above read as a gap that may not be one. This is the difference
    // between a report and a wrong report.
    ...(() => {
      const homeless = repo
        .listAssociates()
        .filter((a) => a.active && !a.basePlace)
        .map((a) => a.name || `+${a.phone}`);
      if (homeless.length === 0) return [];
      return [
        '',
        `_${homeless.join(', ')} ${homeless.length === 1 ? 'has' : 'have'} no base set, so ${homeless.length === 1 ? 'they are' : 'they are'} counted in none of these bands._`,
      ];
    })(),
    ...(unplaced > 0
      ? [
          '',
          `_${unplaced} ${unplaced === 1 ? 'job' : 'jobs'} could not be placed on the map — no address the tariff recognised. They are missing from these counts._`,
        ]
      : []),
    '',
    'Set a base with `base <name> <place>`.',
  ].join(nl);
}

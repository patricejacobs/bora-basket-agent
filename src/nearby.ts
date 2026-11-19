/**
 * Who is near a job, worked out from where people finished rather than from
 * where their phones say they are.
 *
 * No live location. A shared pin is a courtesy that goes stale in silence —
 * somebody shares one at eight, drives for an hour, and dispatch still
 * believes they are standing where they started. A completed delivery is a
 * different kind of fact: that associate WAS at that address, and the order
 * records the minute. Five minutes old it is almost certainly still true;
 * forty minutes old it means nothing, and the rules below say so rather than
 * pretending otherwise.
 *
 * Two circles, from the delivery tariff:
 *
 *   the band     - "East Bank near". The same stretch of road.
 *   the corridor - "East Bank Demerara". The same road, further along.
 *
 * Neither needs a pin at either end, which matters: most addresses in this
 * shop arrive as words.
 */
import * as repo from './db/repo.ts';
import { findZone } from './zones.ts';

export type Place = { zone: string; corridor: string };

/** Where an address sits, or null when the tariff does not recognise it. */
export function placeOf(said: string): Place | null {
  if (!said.trim()) return null;
  const found = findZone(said);
  return found.kind === 'found'
    ? { zone: found.match.zone, corridor: found.match.corridor }
    : null;
}

/**
 * Where a job begins — the point an associate has to get to.
 *
 * A parcel and a taxi start where they are collected. A delivery starts at
 * whoever is cooking or packing it, which is why the outlet's own pickup
 * address is read before anything else: the customer's address is where the
 * job ENDS, and sending the nearest associate to the far end of it would be
 * worse than sending nobody in particular.
 */
export function jobStartsAt(order: repo.OrderRecord): Place | null {
  if (order.kind === 'parcel' || order.kind === 'taxi') {
    return placeOf(order.pickup?.address ?? '');
  }
  return placeOf(order.outlet?.pickupAddress ?? '');
}

/** Where a finished job left the associate: its destination, not its pickup. */
export function jobEndedAt(order: repo.OrderRecord): Place | null {
  return (
    placeOf(order.deliveryZone) ??
    placeOf(order.address) ??
    placeOf(order.location?.label ?? '')
  );
}

export type Standing = {
  phone: string;
  /** Null when they have never finished a job we can place. */
  at: Place | null;
  /** Minutes since they finished it; Infinity when there is nothing to go on. */
  minutesAgo: number;
};

/** Where each associate last finished something, and how long ago. */
export function standings(phones: string[], now = Date.now()): Standing[] {
  return phones.map((phone) => {
    const last = repo.lastDelivered(phone);
    if (!last) return { phone, at: null, minutesAgo: Number.POSITIVE_INFINITY };
    const finishedAt = repo.deliveredAt(last.orderNo) || last.placedAt;
    const ms = now - new Date(finishedAt).getTime();
    return {
      phone,
      at: jobEndedAt(last),
      minutesAgo: Number.isFinite(ms) ? ms / 60_000 : Number.POSITIVE_INFINITY,
    };
  });
}

export type Stage = 'band' | 'corridor' | 'everyone';

/**
 * Who should be offered this job at this stage.
 *
 * Each stage includes the one before it, because the point of widening is to
 * add people rather than to take the job away from whoever is already looking
 * at it. The caller skips anybody it has already told.
 *
 * A job whose start the tariff cannot place has no first or second stage at
 * all - everybody is equally near an address nobody recognises - so it goes
 * straight out to all of them. The same is true of an associate who has
 * finished nothing: they are not penalised for a quiet morning, they simply
 * are not in the narrow circles.
 */
export function stagePool(
  start: Place | null,
  people: Standing[],
  stage: Stage,
  limits: { bandMinutes: number; corridorMinutes: number },
): string[] {
  if (stage === 'everyone' || !start) return people.map((p) => p.phone);

  if (stage === 'band') {
    return people
      .filter((p) => p.at?.zone === start.zone && p.minutesAgo <= limits.bandMinutes)
      .map((p) => p.phone);
  }

  return people
    .filter(
      (p) =>
        p.at?.corridor === start.corridor &&
        p.minutesAgo <= limits.corridorMinutes,
    )
    .map((p) => p.phone);
}

/** How a staged offer is described in the log and the tests. */
export function describeStage(stage: Stage, start: Place | null): string {
  if (!start) return 'everyone (the pickup is not in the tariff)';
  if (stage === 'band') return `just ${start.zone}`;
  if (stage === 'corridor') return `the ${start.corridor} corridor`;
  return 'everyone';
}

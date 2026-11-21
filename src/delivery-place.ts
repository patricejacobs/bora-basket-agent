/**
 * Settling where a delivery is going, and what that costs.
 *
 * One function, because there are now two ways to arrive at the same answer
 * — the customer taps their village off a list, or they type it and agree
 * the read-back — and the two must price identically. A parcel priced one
 * way by the list and another way by the tool is the sort of fault nobody
 * finds until a sender argues about a figure at a gate.
 *
 * Everything it knows is already in the tariff and the draft. What it adds
 * is the one rule that is easy to get wrong in two places: a PARCEL is
 * priced from both ends and its zone belongs to the parcel, not to the
 * customer, because a parcel goes where the customer is not.
 */
import * as repo from './db/repo.ts';
import { findZone, fareBetween } from './zones.ts';

export type SettledPlace = {
  /** The tariff's own name for it. */
  place: string;
  /** The band it was priced under. */
  zone: string;
  /** What this customer will be charged, and has now agreed. */
  fee: number;
  /** "Parika to Diamond", where both ends did the pricing. */
  pricedBy: string;
};

/**
 * Writes the zone down, works out the charge, and records it as agreed.
 *
 * Agreed is the right word for both routes. A tap IS the agreement — they
 * chose the row themselves, with the figure printed on it — and the typed
 * route gets here only after the name has been read back and accepted.
 *
 * Returns null when the tariff has never heard of the place, which is the
 * caller's cue to offer the list or the flat rate rather than to guess.
 */
export function settleDeliveryPlace(phone: string, place: string): SettledPlace | null {
  const known = findZone(place);
  if (known.kind !== 'found') return null;

  const forParcel = repo.getService(phone) === 'parcel';
  if (forParcel) repo.setParcelZone(phone, known.match.place);
  else repo.setDeliveryZone(phone, known.match.place);

  const sender = forParcel ? repo.getParcelDraft(phone).sender.address : '';
  const bothEnds = forParcel && sender ? fareBetween(sender, known.match.place) : null;
  const fee = bothEnds ? bothEnds.fee : known.match.fee;

  // The promise. place_order and create_parcel_job refuse to charge more
  // than this, which is what makes a quote a quote rather than a courtesy.
  repo.setFeeAgreed(phone, fee);

  return {
    place: known.match.place,
    zone: known.match.zone,
    fee,
    pricedBy: bothEnds ? bothEnds.explanation : '',
  };
}

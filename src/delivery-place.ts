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
  const quote = quoteDeliveryPlace(phone, place);
  if (quote === null) return null;

  if (repo.getService(phone) === 'parcel') repo.setParcelZone(phone, quote.place);
  else repo.setDeliveryZone(phone, quote.place);

  // The promise. place_order and create_parcel_job refuse to charge more
  // than this, which is what makes a quote a quote rather than a courtesy.
  repo.setFeeAgreed(phone, quote.fee);

  return quote;
}

/**
 * What it WOULD cost, written down nowhere.
 *
 * The shop has to be able to say "that village is $1,800" in the middle of
 * a question, before anybody has agreed to anything — and a figure quoted
 * by one rule and charged by another is the fault this whole file exists to
 * prevent. So the settlement above is this function plus three writes, and
 * there is one place that knows a parcel is priced from both ends.
 */
export function quoteDeliveryPlace(phone: string, place: string): SettledPlace | null {
  const known = findZone(place);
  if (known.kind !== 'found') return null;

  const forParcel = repo.getService(phone) === 'parcel';
  const sender = forParcel ? repo.getParcelDraft(phone).sender.address : '';
  const bothEnds = forParcel && sender ? fareBetween(sender, known.match.place) : null;

  return {
    place: known.match.place,
    zone: known.match.zone,
    fee: bothEnds ? bothEnds.fee : known.match.fee,
    pricedBy: bothEnds ? bothEnds.explanation : '',
  };
}

/**
 * Does this typed street belong to a different village than the one chosen?
 *
 * The pin has had a check since Shawn's Uitvlugt pin turned up under a Mocha
 * price. The street had none, and it is the same fault by the other road:
 * choose Mocha, decline the map, type "Lot 12 Buxton Public Road", and the
 * card carries a Mocha price over a Buxton address with nothing on it to say
 * the two disagree. Buxton is 15 km from Mocha and $200 more, and the
 * associate is the one who finds out.
 *
 * Returns the village the address names, or null when there is nothing to
 * raise — and it is deliberately quiet, because a false alarm costs a real
 * customer an extra question every time:
 *
 *   an address the tariff cannot place is NOT a conflict. Most Guyanese
 *   addresses are landmarks — "the yellow house by the mosque" — and the
 *   shop has no business arguing with those;
 *
 *   the chosen village named anywhere in the line settles it. "Lot 2 Bel Air
 *   Street, Mocha" is a Mocha address with a street in it, and the matcher
 *   picks the street;
 *
 *   so is a village whose name contains the chosen one — "Lot 4 Little
 *   Diamond" under Diamond. That one can still be the wrong band, but the
 *   two are neighbours by name and often by road, and asking about every one
 *   of those would teach people to tap past the question.
 */
export function streetNamesElsewhere(typed: string, chosen: string): string | null {
  const going = chosen.trim();
  if (going === '') return null;

  const named = findZone(typed);
  if (named.kind !== 'found') return null;
  if (named.match.place.trim().toLowerCase() === going.toLowerCase()) return null;
  if (mentions(typed, going) || mentions(named.match.place, going)) return null;

  return named.match.place;
}

/** Is this place's name one of the words in that line? */
function mentions(line: string, place: string): boolean {
  const flat = (said: string): string =>
    ` ${said.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')} `;
  return flat(line).includes(flat(place));
}

/**
 * Is the door the shop already holds in the place this order is going to?
 *
 * A customer's saved address and pin are *home*. They answer "where does
 * this go?" only when this order is going home — and the moment it is not,
 * they are worse than nothing, because they are specific, confident and
 * wrong.
 *
 * Shawn chose Mocha and tapped Skip. The shop decided it already had his
 * door, from a street saved in Georgetown and a pin saved in Uitvlugt, and
 * put all three on one card: a Georgetown address, a Uitvlugt map link, a
 * Mocha price. Skip had quietly come to mean "use whatever you have, from
 * wherever", when what the customer said was "I have nothing to add".
 *
 * Two ways of knowing, in order:
 *
 *   the zone recorded with the door, written when it was settled — exact,
 *   and the only one that can speak for a PIN, which carries no address of
 *   its own;
 *
 *   failing that, the village named in the written address itself, which is
 *   all there is to go on for every row saved before this was recorded.
 *
 * Where neither can say — an address with no village in it, a shop with no
 * tariff at all — the answer is false, and the customer is asked. One extra
 * question beats one delivery to the wrong village.
 */
export function savedStreetIsIn(phone: string, place: string): boolean {
  const going = place.trim().toLowerCase();
  if (!going) return false;

  const recorded = repo.addressZone(phone).trim();
  if (recorded) return recorded.toLowerCase() === going;

  const written = (repo.getCustomer(phone).address ?? '').trim();
  if (!written) return false;
  const named = findZone(written);
  return named.kind === 'found' && named.match.place.toLowerCase() === going;
}

/**
 * The same question of the PIN, which is asked separately because the two
 * travel apart.
 *
 * Shawn typed a street at Mocha and skipped the pin. His address then
 * belonged to Mocha and his pin still belonged to Uitvlugt — so one answer
 * covering both would have declared a Uitvlugt pin a Mocha door the moment
 * he answered the street question, and printed the link to prove it.
 *
 * A pin carries no address of its own, so there is nothing to fall back on:
 * an unrecorded pin could be anywhere, and anywhere is not a door. Pins
 * saved before this column existed are therefore not trusted for a place
 * the written address cannot vouch for.
 */
export function savedPinIsIn(phone: string, place: string): boolean {
  const going = place.trim().toLowerCase();
  if (!going) return false;
  if (repo.getCustomer(phone).location === null) return false;

  const recorded = repo.pinZone(phone).trim();
  if (recorded) return recorded.toLowerCase() === going;

  // No record of where it was dropped: fall back to the address it was
  // saved alongside, and only when that address can speak for itself.
  return repo.addressZone(phone).trim() === '' && savedStreetIsIn(phone, place);
}

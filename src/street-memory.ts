/**
 * The base learning its customers' streets.
 *
 * The tariff is 185 village names. "Lot 20 Garnet Street" is not one of
 * them, so a trip from it could not be priced and went out as "the fare is
 * agreed with the chauffeur" — but "Lot 20 Garnet Street, **Kitty**" is
 * Kitty, and Kitty to Parika is $5,000. The fare was lost for want of one
 * word, and asking for that word every time is a question a regular
 * customer has already answered.
 *
 * Nobody is going to type a street index for Guyana, and no tariff will
 * ever carry one. But the base finishes deliveries all day, and every
 * finished one is a street and a village that were right: somebody drove
 * there and handed over a bag. So it remembers the pairs it has already
 * proved, and after a few weeks it knows the streets its own customers
 * live on.
 *
 * It starts knowing nothing and gets quietly better, which is how a new
 * dispatcher learns a city.
 */
import { findZone } from './zones.ts';

/**
 * A street, stripped to the part that repeats.
 *
 * "Lot 20 Garnet Street" and "20 garnet st." are the same street written by
 * two people, and must be the same key. The house number goes, because it
 * is the one part guaranteed not to repeat; the village goes, because that
 * is the answer rather than the question.
 *
 * Returns '' when nothing useful is left — a bare lot number, a landmark
 * with no street in it — and nothing is remembered for those.
 */
export function streetKey(written: string, place = ''): string {
  let said = String(written ?? '')
    .toLowerCase()
    .replace(/[.,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!said) return '';

  // The village, where it was written alongside: "garnet street, kitty".
  const village = place.trim().toLowerCase();
  if (village) said = said.replace(new RegExp(`\\b${village.replace(/[^a-z0-9 ]/g, '')}\\b`, 'g'), ' ');

  said = said
    // A leading house or lot number, however it is written.
    .replace(/^(?:lot|plot|#|no\.?)?\s*\d+\s*[a-z]?\b/, ' ')
    // The common short forms, so "st" and "street" are one street.
    .replace(/\bst\b/g, 'street')
    .replace(/\brd\b/g, 'road')
    .replace(/\bave?\b/g, 'avenue')
    .replace(/\s+/g, ' ')
    .trim();

  // What is left has to NAME a street, not merely be words.
  //
  // "The yellow house by the mosque" is a perfectly good address and a
  // useless key: it will never be written the same way twice, and
  // remembering it teaches the base nothing. A street says so — street,
  // road, dam, scheme, avenue — and those are the ones worth keeping.
  if (said.length < 4) return '';
  if (!/\b(street|road|avenue|lane|dam|scheme|highway|drive|place|way|circle|crescent|boulevard|alley|walk)\b/.test(said)) {
    return '';
  }
  // A village the tariff already knows is not a street worth remembering.
  if (findZone(said).kind === 'found') return '';

  return said;
}

/** Everything the base would need to say about a remembered street. */
export type StreetGuess = { place: string; seen: number };

/**
 * Does this pin agree with the place they said?
 *
 * A pin is specific, confident and opens a maps app, which is what makes a
 * wrong one worse than none: the associate drives to it. Shawn's order was
 * priced for Mocha and carried a pin 22 km away in Uitvlugt, and nothing
 * between the tap and the door had anything to say about it.
 *
 * Two ways of noticing, in order of certainty:
 *
 *   THE LABEL. WhatsApp attaches a place name to a location searched for in
 *   its own picker, and Shawn's said "Uitvlugt" in as many words. Where the
 *   label names a tariff place that is not the one chosen, that is the
 *   answer — no geometry, no tolerance, no argument.
 *
 *   THE DISTANCE, where the chosen place has a confident coordinate.
 *
 * The tolerance is deliberately wide. The villages on this tariff sit 600
 * metres apart at the median and 1.7 km apart at the ninetieth percentile:
 * Beterverwagting to Triumph is 1.3 km, and a house on that boundary pins
 * whichever side it likes. Anything tighter than a few kilometres would
 * accuse the honest constantly, which is how a warning gets ignored. At 8 km
 * it catches the wrong corridor and the wrong side of the river — Shawn's 22
 * km — and never fires on a neighbour.
 *
 * It answers one question only: is this pin near the VILLAGE they chose. It
 * cannot tell Lot 12 from Lot 40 three hundred metres away, and does not
 * pretend to.
 */
import { config } from './config.ts';
import { findZone, tariff } from './zones.ts';
import { coordsFor, straightKm, type Point } from './place-coords.ts';

export type PinVerdict =
  /** Near enough, or nothing to measure it against. */
  | { state: 'ok' }
  /** Somewhere else entirely, and here is what it looks like instead. */
  | { state: 'elsewhere'; km: number | null; looksLike: string };

export function checkPin(
  pin: Point & { label?: string },
  place: string,
  /** Overridable so a test can be explicit about the figure it is proving. */
  toleranceKm = config.store.pinToleranceKm,
): PinVerdict {
  const chosen = place.trim();
  if (!chosen) return { state: 'ok' };
  // The kill switch, and it switches off the label check too: a shop that
  // has turned this off has said it does not want to be told, and half a
  // check that still interrupts customers is worse than none.
  if (!(toleranceKm > 0)) return { state: 'ok' };

  const home = coordsFor(chosen);
  const km = home ? Math.round(straightKm(pin, home) * 10) / 10 : null;

  // The label, where WhatsApp gave one. A plus-code line like
  // "VMGW+PR7, Estate Rd, Uitvlugt, Guyana" names its village in plain words.
  const label = (pin.label ?? '').trim();
  if (label) {
    const named = findZone(label);
    if (named.kind === 'found' && named.match.place.toLowerCase() !== chosen.toLowerCase()) {
      // Only when the two really are apart. A label reading "Triumph" on a
      // pin 900 metres inside Beterverwagting is a boundary, not a mistake,
      // and the customer knows their own street better than the tariff does.
      if (km === null || km > toleranceKm) {
        return { state: 'elsewhere', km, looksLike: named.match.place };
      }
    }
  }

  if (home && km !== null && km > toleranceKm) {
    // Say what it IS, not only what it is not. "22 km from Mocha" is a
    // number; "22 km from Mocha, near Uitvlugt" is something a customer can
    // recognise as their own mistake or dismiss as our bad geocode.
    const near = nearestTariffPlace(pin, chosen);
    return { state: 'elsewhere', km, looksLike: near ?? '' };
  }

  return { state: 'ok' };
}

/**
 * The tariff place a pin is closest to, excluding the one already chosen.
 *
 * Only when it is a better answer than the chosen place by a clear margin —
 * otherwise a pin on a boundary gets named after its neighbour, which reads
 * as the shop contradicting itself.
 */
function nearestTariffPlace(pin: Point, exclude: string): string | null {
  let best: { place: string; km: number } | null = null;
  for (const candidate of tariffPlaces()) {
    if (candidate.toLowerCase() === exclude.toLowerCase()) continue;
    const point = coordsFor(candidate);
    if (!point) continue;
    const km = straightKm(pin, point);
    if (!best || km < best.km) best = { place: candidate, km };
  }
  return best ? best.place : null;
}

let places: string[] | null = null;

/** Every priced place, read once: the tariff is loaded from disk at boot. */
function tariffPlaces(): string[] {
  if (!places) places = tariff().map((z) => z.place);
  return places;
}

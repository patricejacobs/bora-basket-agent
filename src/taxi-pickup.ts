/**
 * The pin a passenger drops, against the place they say they are.
 *
 * Reported from the live shop: somebody said they were at **Timehri** and
 * pinned **Beterverwagting**, and nothing was said to anybody. The two are
 * 38 km apart. Worse than the silence, the fare is priced from the pickup —
 * so the shop quoted Beterverwagting's $1,200 for a trip that costs $3,800
 * out of Timehri, and a driver would have gone to the wrong end of the coast
 * on a figure already promised.
 *
 * The check itself has existed for weeks. `checkPin` reads a BV pin against
 * Timehri and answers `elsewhere, 38.1 km, looksLike Beterverwagting`
 * without being taught anything. It was simply never called on a taxi: all
 * five callers were delivery-side, and a taxi's pin goes in through the
 * parcel draft, which files it and asks nothing.
 *
 * Both answers are real here, which is why this asks rather than refuses.
 * A delivery's address is a place the customer has named and a wrong pin is
 * simply wrong — that one is told to send it again. A PICKUP is different:
 * the pin is live evidence of where somebody is standing this minute, and
 * the word may be the loose half. "I'm at Timehri" from a passenger at the
 * airport road junction is a reasonable thing to say and a reasonable thing
 * to be 38 km wrong about.
 */
import * as repo from './db/repo.ts';
import { money } from './config.ts';
import { t, type Language } from './language.ts';
import { fareBetween } from './zones.ts';
import type { PinVerdict } from './pin-check.ts';
import type { OutboundMessage } from './channels/types.ts';

const nl = String.fromCharCode(10);

/** "I am at the pinned place" — the pin wins, and the trip is re-priced. */
export const PICKUP_HERE = 'pickup:here';
/** "Send it again" — the place they named wins, and the pin was a slip. */
export const PICKUP_AGAIN = 'pickup:again';

/** "Garnet Street — the one in Kitty" — an area the shop has seen before. */
const PICKUP_AREA = 'pickup:area:';

export function pickupAreaId(place: string): string {
  return PICKUP_AREA + place;
}

export function pickupAreaFrom(id: string): string | null {
  const said = String(id ?? '').trim();
  if (!said.startsWith(PICKUP_AREA)) return null;
  const place = said.slice(PICKUP_AREA.length).trim();
  return place === '' ? null : place;
}

/**
 * Puts the areas this street has turned out to be in before.
 *
 * One candidate is a question with a yes in it — most people tap it and
 * never think about wards at all. Two or more is the honest version of the
 * same question: several Georgetown streets run through more than one
 * ward, and guessing between them silently is how a car goes to the wrong
 * end of a street somebody has already named correctly.
 */
export function askWhichArea(
  said: string,
  guesses: { place: string; seen: number }[],
  lang: Language,
): OutboundMessage {
  const top = guesses.slice(0, 3);

  return {
    kind: 'buttons',
    text:
      top.length === 1
        ? t('pickup_area_one', lang, { said, place: top[0]!.place })
        : t('pickup_area_many', lang, { said }),
    buttons: [
      ...top.map((g) => ({ id: pickupAreaId(g.place), title: g.place.slice(0, 20) })),
      ...(top.length < 3 ? [{ id: PICKUP_AGAIN, title: t('pickup_area_no', lang) }] : []),
    ],
  };
}

export function isPickupId(id: string): boolean {
  const said = String(id ?? '').trim();
  return said === PICKUP_HERE || said === PICKUP_AGAIN || pickupAreaFrom(said) !== null;
}

/**
 * Puts the disagreement to the passenger, with what each answer costs.
 *
 * The figure is on it because this is the one mismatch that changes the
 * fare before anybody has agreed to anything: the trip is priced from the
 * pickup, so which of these two is right is also which of two prices is
 * right. Somebody choosing between them should be looking at both.
 */
export function pickupLooksWrong(
  said: string,
  verdict: PinVerdict,
  going: string,
  lang: Language,
): OutboundMessage {
  const pinned = verdict.state === 'elsewhere' ? verdict.looksLike : '';
  const km = verdict.state === 'elsewhere' && verdict.km !== null ? `${verdict.km} km` : '';

  // What each end would cost, when the far end is known and the tariff can
  // price both. Early in a booking it often cannot, and a fare invented to
  // fill the sentence is worse than no sentence.
  const fromSaid = going ? fareBetween(said, going) : null;
  const fromPin = going && pinned ? fareBetween(pinned, going) : null;
  const bothPriced = fromSaid !== null && fromPin !== null && fromSaid.fee !== fromPin.fee;

  return {
    kind: 'buttons',
    text: [
      t(km ? 'pickup_far_named' : 'pickup_far', lang, { said, pinned, km }),
      ...(bothPriced
        ? ['', t('pickup_fares', lang, {
            said,
            pinned,
            said_fare: money(fromSaid.fee),
            pin_fare: money(fromPin.fee),
          })]
        : []),
      '',
      t('pickup_which', lang, { said, pinned }),
    ].join(nl),
    buttons: [
      { id: PICKUP_HERE, title: t('pickup_here', lang) },
      { id: PICKUP_AGAIN, title: t('pickup_again', lang) },
    ],
  };
}

/**
 * The pickup pin this draft is holding, and the place the passenger named.
 *
 * Returned together because the question only exists when there are two
 * answers to it: one of them alone is not a disagreement.
 */
export function pickupStandoff(phone: string, said: string): {
  pin: { latitude: number; longitude: number; label?: string } | null;
  said: string;
} {
  const draft = repo.getParcelDraft(phone);
  const pin = draft.pickup
    ? { latitude: draft.pickup.latitude, longitude: draft.pickup.longitude, label: draft.pickup.label }
    : null;
  return { pin, said: said.trim() };
}

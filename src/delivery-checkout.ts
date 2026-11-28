/**
 * Checkout as a fixed sequence, run by the base.
 *
 * A restaurant order used to end in a conversation: the agent asked for an
 * address, then a pin, then a name, in whatever order it thought best, and
 * composed the total itself. Every one of those is a question with a right
 * answer and no judgement in it, which makes it the wrong job for a language
 * model — slower, priced per message, and different every time.
 *
 * So the agent starts it and then stands back. Six steps, each one a tap or
 * a line, each one decided here:
 *
 *   place  → the list of places, or type the name
 *   pin    → send the exact spot, or skip
 *   street → only when they skipped: the lot number and road
 *   note   → anything for the person at the door
 *   name   → only when the base does not know it
 *   gate   → the whole price, with Book it / Change destination / Cancel
 *
 * The gate is the taxi's gate, word for word in shape: the figure is put in
 * front of them with its three answers, and nothing is ordered until they
 * tap. What they are shown is what they will hand over at the door — food
 * and delivery added up — because that is the number an argument at a gate
 * is ever about.
 */
import * as repo from './db/repo.ts';
import { money } from './config.ts';
import { t, type Language } from './language.ts';
import { endPicker } from './place-picker.ts';
import { savedPinIsIn, savedStreetIsIn, quoteDeliveryPlace } from './delivery-place.ts';
import { coordsFor, straightKm } from './place-coords.ts';
import { welcomeOnOffer, REWARD_POINTS, REWARD_VALUE } from './rewards.ts';
import type { OutboundMessage } from './channels/types.ts';

/** Every step of it, in order. '' means they are not in checkout at all. */
export type CheckoutStep = '' | 'place' | 'pin' | 'street' | 'note' | 'name' | 'gate';

const nl = String.fromCharCode(10);

/** The three answers to a price. The same ids a taxi's fare gate uses. */
export const GATE_BOOK = 'drop:gate:book';
export const GATE_CHANGE = 'drop:gate:change';
export const GATE_CANCEL = 'drop:gate:cancel';

export function isGateId(id: string): boolean {
  const said = String(id ?? '').trim();
  return said === GATE_BOOK || said === GATE_CHANGE || said === GATE_CANCEL;
}

/**
 * Every id this sequence sends, for the channel that has to pass them
 * through untranslated. Their titles are words in the customer's own
 * language; the meaning is in the id.
 */
/** The two answers to "pin the new address", after one changed on the road. */
export const ADDR_PIN = 'addr:pin';
export const ADDR_SKIP = 'addr:skip';

/** The two answers to a pin that does not look like the place they chose. */
export const PIN_KEEP = 'pin:keep';
export const PIN_AGAIN = 'pin:again';

/**
 * The two answers to a STREET that does not look like the place they chose.
 *
 * One of them carries the village the address named, because that is the
 * whole of what the tap means and no 20-character title could hold it in
 * four languages: "Golden Grove East Bank" is 22 characters on its own.
 */
export const STREET_AGAIN = 'street:again';
const STREET_MOVE = 'street:move:';

export function streetMoveId(place: string): string {
  return STREET_MOVE + place;
}

/** The village a Change-the-village tap was for, or null if it is not one. */
export function streetMoveTo(id: string): string | null {
  const said = String(id ?? '').trim();
  if (!said.startsWith(STREET_MOVE)) return null;
  const place = said.slice(STREET_MOVE.length).trim();
  return place === '' ? null : place;
}

export function isStreetId(id: string): boolean {
  return String(id ?? '').trim() === STREET_AGAIN || streetMoveTo(id) !== null;
}

export function isCheckoutId(id: string): boolean {
  const said = String(id ?? '').trim();
  return (
    isGateId(id) ||
    isStreetId(id) ||
    said === ADDR_PIN ||
    said === ADDR_SKIP ||
    said === PIN_KEEP ||
    said === PIN_AGAIN
  );
}

/**
 * Puts a pin that does not look like the chosen place back to the customer.
 *
 * A question, never a refusal. The customer may be right — a farm past the
 * village line, a house on a boundary, or a geocode of ours that is simply
 * off — and they know their own address better than a centroid does. What
 * they cannot do is find out afterwards, from an associate standing in the
 * wrong village.
 */
export function pinLooksWrong(
  place: string,
  verdict: { km: number | null; looksLike: string },
  lang: Language,
): OutboundMessage {
  const how = verdict.km === null ? '' : `${verdict.km} km`;
  // One answer, and it is a better pin.
  //
  // There used to be a second button saying the spot was right. It was the
  // wrong thing to offer: the base is not asking for a preference, it is
  // saying the map does not agree with the village, and the tap that waves
  // that away costs somebody else a ride across the country. A customer who
  // really does live past the village line has a way through that is not a
  // claim about a pin — the street, in words.
  //
  // The native request, so the one answer is one tap to the map.
  return {
    kind: 'location_request',
    text: [
      t(verdict.looksLike ? 'pin_far_named' : 'pin_far', lang, {
        place,
        km: how,
        near: verdict.looksLike,
      }),
      '',
      t('pin_send_again', lang, { place }),
    ].join(nl),
  };
}

/**
 * Puts a street that belongs to another village back to the customer.
 *
 * A question with two real answers, because either one of them can be the
 * mistake. They may have tapped the wrong row off a list of 185 places and
 * typed their own address correctly; or they chose their village correctly
 * and typed an address with somebody else's village in it. The base cannot
 * tell, and guessing either way sends an associate to the wrong coast.
 *
 * So both are offered, and the figure is on the message: changing the
 * village changes the fare, and a customer who finds that out at the door
 * is a customer who was not asked.
 */
export function streetLooksWrong(
  phone: string,
  chosen: string,
  named: string,
  lang: Language,
): OutboundMessage {
  const quote = quoteDeliveryPlace(phone, named);
  const here = coordsFor(chosen);
  const there = coordsFor(named);
  const km = here && there ? straightKm(here, there) : null;

  const move = t('street_move', lang);
  const again = t('street_again', lang);

  return {
    kind: 'buttons',
    text: [
      t(km === null ? 'street_elsewhere' : 'street_elsewhere_km', lang, {
        place: chosen,
        named,
        km: km === null ? '' : `${km.toFixed(1)} km`,
      }),
      '',
      t('street_which', lang, {
        place: chosen,
        named,
        fee: quote ? money(quote.fee) : '',
        move,
        again,
      }),
    ].join(nl),
    buttons: [
      { id: streetMoveId(named), title: move },
      { id: STREET_AGAIN, title: again },
    ],
  };
}

/** The list of places, and the first step. */
export function askPlace(phone: string, lang: Language): OutboundMessage {
  repo.setCheckoutStep(phone, 'place');
  return endPicker(phone, 'drop', lang);
}

/** The street, asked only of somebody who skipped the pin. */
export function askStreet(phone: string, place: string, lang: Language): OutboundMessage {
  repo.setCheckoutStep(phone, 'street');
  return { kind: 'text', text: t('checkout_street_ask', lang, { place }) };
}

export function askName(phone: string, lang: Language): OutboundMessage {
  repo.setCheckoutStep(phone, 'name');

  // A first-timer is told what their name is worth, on the question that
  // asks for it. This IS the registration — the base has had their number
  // since the first message, and the name is the one thing it could not
  // know — so a sign-up step of its own would be a second question for
  // something already being asked.
  //
  // What it is NOT allowed to say is what the gift is worth in money. Points
  // only convert in whole rewards — 1,000 of them for $500 off — so 50
  // points can buy nothing at all on its own, and `valueOf(50)` is zero. An
  // earlier draft of this line offered "$25 off" and would have promised a
  // customer something the scheme cannot pay. The rate is the honest thing
  // to say: this many points now, and this many buys that much off.
  const gift = welcomeOnOffer(phone);
  return {
    kind: 'text',
    text:
      gift > 0
        ? t('checkout_name_ask_welcome', lang, {
            points: String(gift),
            reward: String(REWARD_POINTS),
            value: money(REWARD_VALUE),
          })
        : t('checkout_name_ask', lang),
  };
}

/**
 * The price, with its three answers.
 *
 * Read from the cart at the moment it is shown rather than from anything
 * remembered, so a basket changed halfway through checkout cannot be booked
 * at the old figure.
 */
export function priceGate(phone: string, lang: Language): OutboundMessage {
  repo.setCheckoutStep(phone, 'gate');

  const cart = repo.getCart(phone);
  const items = cart.lines
    .map(
      (l) =>
        `${l.qty} x ${l.product.name}` +
        `${l.optionsSummary ? ` — _${l.optionsSummary}_` : ''} — ${money(l.lineTotal)}`,
    )
    .join(nl);
  const parcel = repo.getService(phone) === 'parcel';
  if (parcel) return parcelGate(phone, lang);

  const customer = repo.getCustomer(phone);
  const place = customer.deliveryZone || '';
  // The read-back, which a tap then answers. Who it is for and where it is
  // going have to be ON this message: `place_order` refuses an order whose
  // identity has not been put to the customer, and it is right to - an
  // order placed against a name nobody checked is a parcel at the wrong
  // door with the base's word for it.
  // Only a pin that belongs to THIS order's place is worth printing. The
  // label on a stale one is worse than silence: Shawn read
  // "(VMGW+PR7, Estate Rd, Uitvlugt, Guyana)" under a Mocha price, which is
  // a plus-code for a village he had not mentioned, and no way to tell
  // whether the base had understood him.
  const pinIsHere = savedPinIsIn(phone, place);
  // And the same question of the STREET, which was never asked here.
  //
  // The pin's label has been checked against the place since the Uitvlugt
  // plus-code turned up under a Mocha price. The address beside it was
  // printed whatever it said — so somebody who chose Beterverwagting and
  // pinned a spot there read "at 4 Diamond EBD (QWWM+VJF, Beterverwagting)"
  // and was asked to confirm it.
  //
  // A pin IS the door, which is why no street is asked for once one
  // arrives. That is right, and it is exactly why the stale street must not
  // be printed as though it were the answer.
  const doorIsHere = (customer.address ?? '').trim() !== '' && savedStreetIsIn(phone, place);
  const label = pinIsHere ? (customer.location?.label ?? '') : '';

  const where = doorIsHere
    ? `${customer.address}${label ? ` (${label})` : ''}`
    : pinIsHere
      ? t('checkout_at_pin', lang, { place })
      : place;

  return {
    kind: 'buttons',
    text: t('checkout_gate', lang, {
      items,
      place,
      fee: money(cart.deliveryFee),
      total: money(cart.total),
      name: customer.name || '',
      where,
      // Said, rather than left out. Silence under an address reads as "they
      // have my exact spot" to somebody who skipped it three messages ago,
      // and the associate is the one who finds out otherwise.
      spot: pinIsHere ? '' : `${nl}${t('checkout_no_spot', lang)}`,
      nl,
    }),
    buttons: [
      { id: GATE_BOOK, title: t('fare_book', lang) },
      { id: GATE_CHANGE, title: t('fare_change', lang) },
      { id: GATE_CANCEL, title: t('fare_cancel', lang) },
    ],
  };
}

/**
 * The same gate, for a parcel.
 *
 * There is no basket: what is being carried is one line in the sender's own
 * words, and the money is collected from THEM at the pickup rather than from
 * the person at the other end. Saying "cash at your door" to somebody
 * sending a parcel would be telling them the wrong thing twice over.
 */
function parcelGate(phone: string, lang: Language): OutboundMessage {
  const draft = repo.getParcelDraft(phone);
  const fee = repo.feeAgreed(phone);

  return {
    kind: 'buttons',
    text: t('checkout_gate_parcel', lang, {
      contents: draft.contents || '',
      to: draft.recipient.name || '',
      place: draft.zone || draft.recipient.address || '',
      where: draft.recipient.address || draft.zone || '',
      fee: money(fee),
      nl,
    }),
    buttons: [
      { id: GATE_BOOK, title: t('fare_book', lang) },
      { id: GATE_CHANGE, title: t('fare_change', lang) },
      { id: GATE_CANCEL, title: t('fare_cancel', lang) },
    ],
  };
}

/**
 * What comes next, given what was just answered.
 *
 * Driven by the step that finished rather than by guessing from the record,
 * so a question can never be asked twice because the thing it collected
 * happens to look empty - "nothing to add" is an answer, and an empty note
 * is what it leaves behind.
 *
 * The pin decides whether the street is asked at all. A pin IS the door, and
 * asking somebody who has just sent one for a lot number is asking them to
 * say it twice.
 */
export function nextAfter(
  phone: string,
  done: 'place' | 'pin' | 'skip' | 'street' | 'note' | 'name',
  lang: Language,
): OutboundMessage {
  const parcel = repo.getService(phone) === 'parcel';
  const customer = repo.getCustomer(phone);
  const draft = parcel ? repo.getParcelDraft(phone) : null;

  // A parcel's door is the RECIPIENT's, and their name is already written
  // down - it was agreed one half at a time before any of this started. So
  // the name step never applies to one, and the street and the pin belong to
  // the draft rather than to the customer, who is somewhere else entirely.
  const hasName = parcel ? true : (customer.name ?? '').trim() !== '';

  // The place this order is going to, which is what any saved door has to
  // agree with before it counts as an answer.
  const going = (parcel ? draft?.zone : customer.deliveryZone) || '';

  // A parcel's door was agreed one half at a time before checkout started
  // and belongs to the draft, not to the customer — there is no "home" to
  // go stale. A delivery's saved door is home, and home answers only when
  // the order is going home.
  const hasStreet = parcel
    ? (draft?.recipient.address ?? '').trim() !== ''
    : (customer.address ?? '').trim() !== '' && savedStreetIsIn(phone, going);
  // A pin carries no address of its own, so there is nothing to read it
  // against except the zone recorded when it was settled. Unrecorded, it
  // could be anywhere, and "anywhere" is not a door.
  const hasPin = parcel ? draft?.destination !== null : savedPinIsIn(phone, going);

  // Nothing stands between the address and the price that is not strictly
  // needed to place the order. A name is asked only when the base has none;
  // a street only when there is neither a pin nor an address on file. Both
  // are exceptions, not steps: walking it showed that four questions
  // between choosing a village and seeing the figure is three too many.
  const toThePrice = (): OutboundMessage =>
    hasName ? priceGate(phone, lang) : askName(phone, lang);

  switch (done) {
    case 'pin':
      return toThePrice();
    case 'note':
      // Words where the pin was offered are the doorstep note — and a note
      // is not a door. Without this, typing "a gate on the left" went
      // straight to the price with no address and no pin on the order at
      // all, and the tap on Book it was refused by place_order: the whole
      // sequence answered, and a shrug at the end of it.
      //
      // The same rule as the skip below, for the same reason. A question
      // they can still answer belongs in front of them while they are still
      // answering questions.
      return hasPin || hasStreet ? toThePrice() : askStreet(phone, going, lang);
    case 'skip':
      // A pin they sent EARLIER is still a door. Asking for a lot number
      // from somebody whose exact spot the base already holds is asking
      // them to say it twice, and skipping a second time - after changing
      // the address, say - is not a reason to start demanding streets.
      return hasPin || hasStreet ? toThePrice() : askStreet(phone, going, lang);
    case 'street':
      return toThePrice();
    case 'name':
      return priceGate(phone, lang);
    default:
      return priceGate(phone, lang);
  }
}

/** Out of checkout, whatever happened. The basket is left alone. */
export function endCheckout(phone: string): void {
  repo.setCheckoutStep(phone, '');
  repo.setCheckoutNote(phone, '');
}

/**
 * Books it.
 *
 * Through `place_order`, deliberately: that tool carries the stock, the
 * reward points, the quote gate and the dispatch, and a second path to an
 * order is a second set of rules to keep in step. The only difference is
 * who calls it — a tap on the price rather than a model deciding the moment
 * has come.
 *
 * Cash, because that is what "payable to the associate at your door" means.
 * A shop taking cards sets them up for the agent's own checkout, which is
 * unchanged.
 */
export async function placeTheOrder(phone: string, lang: Language): Promise<OutboundMessage[]> {
  const { executeTool, basketSummary } = await import('./agent/tools.ts');
  const ctx = { phone, outbound: [] as OutboundMessage[] };

  // Nobody on the road, caught HERE rather than left to the tool.
  //
  // place_order refuses it either way, but its reason is written for a model
  // and this path has no model in it: the refusal came back as
  // `checkout_failed` — "Something went wrong placing that" — to somebody
  // who had just tapped Book it. The base knew exactly what was wrong and
  // said none of it, and the order was forgotten as well.
  if (!repo.anyoneOnDuty()) {
    const { recordTurnedAway, nobodyOutMessage } = await import('./waiting-list.ts');
    const parcelNow = repo.getService(phone) === 'parcel';
    const basket = repo.getCart(phone);
    const draft = repo.getParcelDraft(phone);
    const held = parcelNow
      ? [draft.contents, draft.recipient.name && `for ${draft.recipient.name}`]
          .filter(Boolean)
          .join(' ')
      : basketSummary(phone);

    recordTurnedAway(phone, parcelNow ? 'parcel' : repo.getService(phone) || 'grocery', held);
    // Out of the sequence, basket untouched. The way back in is the message
    // the base sends when somebody clocks on, not a gate left hanging.
    endCheckout(phone);
    return [nobodyOutMessage(lang, held)];
  }

  // The tap IS the read-back answered: the name and the address were on the
  // message it came from, which is exactly what this gate asks for.
  repo.confirmIdentity(phone);

  // A parcel is booked by its own tool, for the same reason a basket is
  // booked by place_order: one set of rules per kind of job. What they
  // share is this sequence and this gate.
  const parcel = repo.getService(phone) === 'parcel';
  const draft = repo.getParcelDraft(phone);
  const note = repo.checkoutNote(phone);

  const answer = JSON.parse(
    parcel
      ? executeTool(
          'create_parcel_job',
          {
            contents: draft.contents,
            sender_name: draft.sender.name,
            sender_phone: draft.sender.phone,
            recipient_name: draft.recipient.name,
            recipient_phone: draft.recipient.phone,
            pickup_note: draft.sender.address,
            destination_note: [draft.recipient.address, note].filter(Boolean).join(' — '),
          },
          ctx as never,
        )
      : executeTool(
          'place_order',
          { payment_method: 'cash_on_delivery', delivery_note: note },
          ctx as never,
        ),
  ) as { placed?: boolean; booked?: boolean; order_number?: string; job_number?: string; error?: string };

  endCheckout(phone);

  const orderNo = answer.order_number ?? answer.job_number;
  if ((answer.placed !== true && answer.booked !== true) || !orderNo) {
    // The reason goes to the log, not to the customer: it is written for a
    // model and reads like it. The basket is untouched, so the agent can
    // pick it up on the next turn.
    console.error(`[checkout] ${phone} could not place the order:`, answer.error);
    return [{ kind: 'text', text: t('checkout_failed', lang) }];
  }

  const order = repo.findOrder(orderNo);
  return [
    ...ctx.outbound,
    {
      kind: 'text',
      // A parcel has no kitchen to confirm it. It is offered to the
      // associates, and the next thing that happens is one of them taking
      // it - so saying a shop will confirm it is a promise nobody made.
      text: parcel
        ? t('checkout_booked_parcel', lang, { order: orderNo })
        : t('checkout_placed', lang, {
            order: orderNo,
            kitchen: order?.outlet?.name || t('checkout_the_shop', lang),
          }),
    },
  ];
}

/**
 * Somebody declining to send a pin, in words rather than with the button.
 *
 * The button is one tap and most people use it. But the message it sits on
 * also invites words — "if there is anything they should know, just type it"
 * — so the two arrive down the same channel, and "skip" was being written
 * down as a doorstep note. The associate's card then read `skip` under the
 * address, which is a line somebody at a gate has to interpret.
 *
 * It matters more once the map is asked for directly: WhatsApp's own
 * location request carries exactly one button, its own, so declining has to
 * be sayable.
 *
 * Deliberately only the bare word, in the four languages. "Skip the rice" is
 * a sentence about shopping and "no onions please" is a doorstep note that
 * happens to start with no — neither is somebody declining to pin a door.
 */
const SKIP_WORDS =
  /^(skip|skip it|no|none|no thanks|no thank you|not now|later|nope|nah|omitir|saltar|no gracias|ahora no|más tarde|mas tarde|ignorar|saltar isso|não|nao|não obrigado|nao obrigado|agora não|agora nao|mais tarde|跳过|跳過|不用|不用了|稍后|稍後|没有|沒有)[.!]?$/i;

export function saysSkip(text: string): boolean {
  return SKIP_WORDS.test(text.trim());
}

/**
 * Somebody who has changed the subject rather than answered the question.
 *
 * The street step writes down whatever arrives, because at that moment
 * anything is presumed to be the answer. A customer who replied "I need
 * another order" had that saved as their address, verbatim, and an associate
 * was sent to a sentence.
 *
 * Deliberately narrow. A Guyanese address is often a landmark — "the yellow
 * house by the mosque", "second gate after the church" — and refusing those
 * would be worse than the fault it fixes. So this asks one question: does
 * this read as a REQUEST rather than a place? A question mark, or an opening
 * that announces an intention, and no number anywhere in it. A lot number is
 * taken as proof of an address whatever else the sentence is doing, because
 * people do type "Lot 12, come quick".
 */
const REQUEST_OPENERS =
  /\b(i need|i want|i would like|can i|could i|can you|could you|do you|please add|add another|another order|one more order|cancel|how much|how long|what time|instead of)\b/i;

export function looksLikeARequest(text: string): boolean {
  const said = text.trim();
  if (said === '') return false;
  // A number is almost always a lot, a street number or a floor.
  if (/\d/.test(said)) return false;
  return said.includes('?') || REQUEST_OPENERS.test(said);
}

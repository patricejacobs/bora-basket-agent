/**
 * Checkout as a fixed sequence, run by the shop.
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
 *   name   → only when the shop does not know it
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
import type { OutboundMessage } from './channels/types.ts';

/** Every step of it, in order. '' means they are not in checkout at all. */
export type CheckoutStep = '' | 'place' | 'pin' | 'street' | 'note' | 'name' | 'gate';

const nl = String.fromCharCode(10);

/** The three answers to a price. The same ids a taxi's fare gate uses. */
export const GATE_BOOK = 'drop:gate:book';
export const GATE_CHANGE = 'drop:gate:change';
export const GATE_CANCEL = 'drop:gate:cancel';

/** The one button on the note question: having nothing to say. */
export const NOTE_NONE = 'drop:note:none';

export function isGateId(id: string): boolean {
  const said = String(id ?? '').trim();
  return said === GATE_BOOK || said === GATE_CHANGE || said === GATE_CANCEL;
}

/**
 * Every id this sequence sends, for the channel that has to pass them
 * through untranslated. Their titles are words in the customer's own
 * language; the meaning is in the id.
 */
export function isCheckoutId(id: string): boolean {
  return isGateId(id) || String(id ?? '').trim() === NOTE_NONE;
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

/**
 * Anything for the person at the door.
 *
 * With a button for having nothing to say, because the commonest answer to
 * this question is "no" and typing it is a message for nothing.
 */
export function askNote(phone: string, lang: Language): OutboundMessage {
  repo.setCheckoutStep(phone, 'note');
  return {
    kind: 'buttons',
    text: t('checkout_note_ask', lang),
    buttons: [{ id: NOTE_NONE, title: t('checkout_note_none', lang) }],
  };
}

export function askName(phone: string, lang: Language): OutboundMessage {
  repo.setCheckoutStep(phone, 'name');
  return { kind: 'text', text: t('checkout_name_ask', lang) };
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
  // door with the shop's word for it.
  const where = customer.location
    ? `${customer.address || place}${customer.location.label ? ` (${customer.location.label})` : ''}`
    : customer.address || place;

  return {
    kind: 'buttons',
    text: t('checkout_gate', lang, {
      items,
      place,
      fee: money(cart.deliveryFee),
      total: money(cart.total),
      name: customer.name || '',
      where,
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
  const hasStreet = parcel
    ? (draft?.recipient.address ?? '').trim() !== ''
    : (customer.address ?? '').trim() !== '';
  const hasPin = parcel ? draft?.destination !== null : customer.location !== null;

  switch (done) {
    case 'pin':
      return askNote(phone, lang);
    case 'skip':
      // A pin they sent EARLIER is still a door. Asking for a lot number
      // from somebody whose exact spot the shop already holds is asking
      // them to say it twice, and skipping a second time - after changing
      // the address, say - is not a reason to start demanding streets.
      return hasPin || hasStreet
        ? askNote(phone, lang)
        : askStreet(phone, (parcel ? draft?.zone : customer.deliveryZone) || '', lang);
    case 'street':
      return askNote(phone, lang);
    case 'note':
      return hasName ? priceGate(phone, lang) : askName(phone, lang);
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
  const { executeTool } = await import('./agent/tools.ts');
  const ctx = { phone, outbound: [] as OutboundMessage[] };

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

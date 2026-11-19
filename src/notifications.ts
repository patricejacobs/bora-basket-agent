import { config, money } from './config.ts';
import { t, type Language } from './language.ts';
import { languageFor } from './services.ts';
import * as repo from './db/repo.ts';
import { sendText, sendButtons, sendTemplate, sendLocation, sendList } from './channels/whatsapp-send.ts';
import { nextActions, CANCEL_REASONS, describeAge, wantedBy } from './order-status.ts';
import { summariseStored } from './menu-options.ts';
import { checkRange, describePin } from './location.ts';

/**
 * Tells the shop an order came in.
 *
 * Without this an order lands in the database and nobody finds out, which is
 * the difference between a demo and a shop that can trade.
 */
/**
 * One line to everyone running the shop, for something that needs a person.
 *
 * Logged as well as sent, because the case this exists for is a shop with no
 * staff numbers configured — where the warning would otherwise go nowhere and
 * the problem would stay invisible, which is the whole failure being fixed.
 */
export async function warnStaff(body: string): Promise<void> {
  if (config.staffNumbers.length === 0) {
    console.warn(`[notify] nobody to warn (STAFF_NUMBERS is empty): ${body.replace(/\s+/g, ' ')}`);
    return;
  }
  for (const staff of config.staffNumbers) {
    try {
      await sendText(staff, body);
    } catch (err) {
      console.error('[notify] could not warn staff:', err);
    }
  }
}

export async function notifyStaffOfNewOrder(orderNo: string): Promise<void> {
  if (config.staffNumbers.length === 0) {
    console.warn(`[notify] ${orderNo} placed but STAFF_NUMBERS is empty — nobody was told`);
    return;
  }

  const order = repo.findOrder(orderNo);
  if (!order) return;

  const isParcel = order.kind === 'parcel';
  // Read from the order's own kind, not from whether it has a shop. A grocery
  // order has one now, so the old test treated it as a restaurant order: the
  // dispatch desk saw a knife and fork beside somebody's shopping, and was
  // told a kitchen was cooking it.
  const isCooked = order.kind === 'restaurant';

  // A taxi carries a person. Nothing about it is a list of goods, and the
  // desk reading this card needs the two ends of the trip rather than a
  // trolley and an empty line where the items would be.
  const isTaxi = order.kind === 'taxi';

  const lines = [
    isTaxi
      ? `🚕 *New taxi job ${order.orderNo}*`
      : isParcel
        ? `📦 *New parcel job ${order.orderNo}*`
        : order.outlet
          ? `${isCooked ? '🍽️' : '🛒'} *New order ${order.orderNo}* — ${order.outlet.name}`
          : `🛒 *New order ${order.orderNo}*`,
    '',
    // A parcel has no line items — one bag and a description. A taxi has the
    // journey instead, written the way the passenger gave it.
    ...(isTaxi
      ? [
          `Collect: ${order.pickup?.address || (order.pickup ? 'pin only' : 'not given')}`,
          `Take to: ${order.address || (order.location ? 'pin only' : 'not given')}`,
          ...(order.parcelDetails ? [order.parcelDetails] : []),
        ]
      : isParcel
        ? [order.parcelDetails || 'Contents not described']
        : order.items.map((i) => {
            const chosen = summariseStored(i.options);
            return `${i.qty} x ${i.name}${chosen ? ` — _${chosen}_` : ''} — ${money(i.lineTotal)}`;
          })),
    '',
    order.total > 0
      ? `*Total ${money(order.total)}* (${order.status === 'pending' ? 'unconfirmed' : order.status})`
      : isTaxi
        ? '*Fare not set* — the driver agrees it with the passenger'
        : '*Fee not set* — the associate agrees it with the sender at the pickup',
    // When it is wanted, on the desk's copy too. It is the one fact that
    // changes what to do with the order right now rather than later.
    ...(wantedBy(order) ? [wantedBy(order)] : []),
    ...(isParcel && order.pickup
      ? ['', `Uplift from: ${order.pickup.address || 'pin below'}`, `Sender ${order.customerName} +${order.contactPhone || order.phone}`]
      : []),
    // Somebody else prepares it, so the shop's line is the wait and the
    // collection rather than a picking list. Only a kitchen is described as
    // cooking — "Kitchen reckons about 20 minutes" over a bag of groceries is
    // the desk being told about a kitchen that does not exist.
    ...(order.outlet
      ? [
          `Uplift from ${order.outlet.name}${order.outlet.pickupAddress ? `, ${order.outlet.pickupAddress}` : ''}`,
          isCooked
            ? `Kitchen reckons about ${order.outlet.prepMinutes} minutes`
            : `Picking takes about ${order.outlet.prepMinutes} minutes`,
        ]
      : []),
    '',
    isParcel
      ? `To: ${order.recipientName} +${order.recipientPhone}`
      : isTaxi
        ? `Passenger: ${order.customerName}`
        : `${order.customerName}`,
    // Doorstep detail, which is often empty now that the pin carries the
    // location. Skipped rather than printed as a blank line — and skipped on
    // a taxi outright, where the address IS the destination and has been on
    // this card since the third line. The same line twice in one message is
    // read, checked against itself and trusted less.
    ...(order.address && !isTaxi ? [order.address] : []),
    `📞 +${order.contactPhone || order.phone}`,
    ...(order.location
      ? ['', describePin(order.location, checkRange(order.location, config.store.serviceArea))]
      : ['', '⚠️ No location pin on this order']),
  ];
  if (order.deliveryNote) lines.push(`Note: ${order.deliveryNote}`);

  const body = lines.join('\n');
  // The desk's own alert. No Confirm on it when a kitchen owns the order:
  // accepting is theirs, and the card is exactly where somebody taps without
  // reading. The refusal that actually enforces this lives in handleStaffMessage,
  // because a reply button never expires.
  const actions = nextActions(order.orderNo, order.status, 'staff', {
    outletConfirms: order.kind === 'restaurant' && order.outlet !== null,
  });

  for (const staff of config.staffNumbers) {
    // Buttons so dispatch is a tap rather than a typed command. Their titles are
    // themselves valid commands, so tapping and typing go through one parser and
    // anyone who prefers typing still can.
    if (actions.length > 0) await sendButtons(staff, body, actions);
    else await sendText(staff, body);

    // Then the pin as a map card of its own. The link in the text above is for
    // reading; this is the one a delivery associate taps to start navigating.
    if (order.location) {
      await sendLocation(staff, {
        latitude: order.location.latitude,
        longitude: order.location.longitude,
        name: `${order.orderNo} — ${order.customerName}`,
        ...(order.location.label || order.address
          ? { address: order.location.label || order.address }
          : {}),
      });
    }
  }
}

/**
 * What a cancelled customer is told.
 *
 * Named by whoever actually cancelled. A restaurant that cancels is named, so
 * the customer knows which kitchen let them down and can choose another; the
 * order number tells them nothing they can act on. But the shop is not allowed
 * to hide behind a restaurant's name — "they cancelled because you asked us to"
 * would be a lie, and an order the shop could not deliver is the shop's to own.
 */
function cancelledMessage(order: repo.OrderRecord): string {
  const known = CANCEL_REASONS.find((r) => r.internal === order.cancelReason);
  const firstName = order.customerName.split(/\s+/)[0] ?? '';
  const lang = languageFor(order.phone);

  const byOutlet = order.cancelledBy === 'outlet' && Boolean(order.outlet?.name);
  const subject = byOutlet
    ? t('cancel_by_outlet', lang, { outlet: order.outlet?.name ?? '' })
    : t('cancel_plain', lang, { order: order.orderNo });

  // An order the customer asked us to cancel is not something to apologise
  // for. Anything else is, and the regret goes first, before the explanation.
  const opening = known && !known.apologise ? t('cancel_done', lang, { name: firstName }) : t('cancel_sorry', lang, { name: firstName });

  // The reason is passed on as given, and the message ends there. Inviting
  // somebody to write back if it is "not right" implies the cancellation might
  // be a mistake and puts the work of chasing it on them.
  if (known) {
    return t('cancel_with_reason', lang, {
      opening,
      subject,
      reason: t(`reason_${known.key}`, lang),
    });
  }
  // A reason somebody typed, in whatever words they typed it. Not translated:
  // inventing a translation of a sentence a dispatcher wrote by hand would be
  // guessing at what they meant, in front of the customer.
  if (order.cancelReason && order.cancelReason !== 'No reason given') {
    return t('cancel_with_reason', lang, { opening, subject, reason: order.cancelReason });
  }
  return t('cancel_no_reason', lang, { opening, subject });
}

/**
 * Hands a conversation to a person.
 *
 * The one thing the agent genuinely cannot do is be a human being, and until
 * now "a staff member will follow up" went nowhere. Staff get the customer's
 * number as a tappable link so replying is one tap from the alert.
 */
/**
 * Sends every request for a person that nobody has received yet.
 *
 * Called at boot. A shop that has just set STAFF_NUMBERS for the first time
 * has customers waiting who were told, truthfully, that their request was
 * written down and somebody would come back to them - this is the somebody
 * coming back. Without it that promise expires quietly and the customer is
 * left worse off than if they had been refused.
 */
export async function flushHelpRequests(): Promise<number> {
  if (config.staffNumbers.length === 0) return 0;

  const waiting = repo.pendingHelpRequests();
  if (waiting.length === 0) return 0;

  let sent = 0;
  for (const r of waiting) {
    // Said plainly as old, because a complaint from three days ago read as if
    // it arrived this minute is answered in the wrong tone entirely.
    const aged = `${r.summary}

(asked for a person ${describeAge(r.createdAt)}, and nobody was reachable at the time)`;
    const told = await notifyStaffOfRequest(r.phone, aged, r.urgent).catch((err) => {
      console.error('[notify] a waiting help request could not be sent:', err);
      return 'no_staff' as const;
    });
    if (told === 'sent') {
      repo.markHelpDelivered(r.id);
      sent++;
    }
  }
  if (sent > 0) console.log(`[notify] ${sent} customer(s) who asked for a person have been passed on`);
  return sent;
}

export async function notifyStaffOfRequest(
  phone: string,
  summary: string,
  urgent = false,
): Promise<'sent' | 'no_staff'> {
  if (config.staffNumbers.length === 0) {
    console.warn(`[notify] ${phone} asked for a person but STAFF_NUMBERS is empty — nobody was told`);
    return 'no_staff';
  }

  const customer = repo.getCustomer(phone);
  const recent = repo.recentOrders(phone, 1)[0];

  const body = [
    urgent ? '🔴 *Customer needs help — urgent*' : '🙋 *Customer needs help*',
    '',
    summary.slice(0, 800),
    '',
    customer.name ? `${customer.name}` : 'Name not on file',
    `📞 +${customer.contactPhone || phone}`,
    `💬 https://wa.me/${phone.replace(/[^0-9]/g, '')}`,
    ...(recent ? [`Last order ${recent.orderNo} — ${recent.status}`] : ['No previous orders']),
    '',
    'Reply to them directly on WhatsApp — the agent has told them to expect a person.',
  ].join('\n');

  for (const staff of config.staffNumbers) await sendText(staff, body);
  return 'sent';
}

/**
 * Tells the customer their order moved.
 *
 * WhatsApp only allows free-form messages within 24 hours of the customer's last
 * message. Outside that window an approved template is the only route, so this
 * picks automatically and says plainly when neither is possible.
 */
/**
 * How a food order says goodbye.
 *
 * Only food. A bag of rice or a parcel carried across town gets the thank-you
 * alone - wishing somebody a good meal over a delivery that was not one reads
 * as a machine that does not know what it delivered.
 */
export const MEAL_SIGN_OFFS = [
  'signoff_order_again',
  'signoff_next_time',
  'signoff_meal',
  'signoff_food',
  'signoff_enjoy',
  'signoff_every_bite',
  'signoff_appetit',
];

/** Groceries. A wish about the day, not about a meal. */
export const SHOPPING_SIGN_OFFS = [
  'signoff_just_right',
  'signoff_see_you_next',
  'signoff_next_order',
  'signoff_here_for_you',
  'signoff_rest_of_day',
];

/** Parcels. Addressed to the sender, who is the one who paid and trusted us. */
export const PARCEL_SIGN_OFFS = [
  'signoff_moved_any_time',
  'signoff_trusting_us',
  'signoff_next_one',
  'signoff_carried',
  'signoff_good_to_help',
];

/**
 * Taxis. Addressed to a passenger who has just been driven somewhere.
 *
 * Built from lines the other pools already use rather than new ones, because
 * every wish that suits the end of a journey has been written here once
 * already. What a passenger must never be sent is the parcel pool: "thanks
 * for trusting us with it 📦" to somebody who was themselves the cargo.
 */
export const TAXI_SIGN_OFFS = [
  'signoff_rest_of_day',
  'signoff_see_you_next',
  'signoff_here_for_you',
  'signoff_good_to_help',
  'signoff_next_one',
];

/**
 * One of them, chosen by the order number rather than at random.
 *
 * Varied across customers, fixed for any one order. That second half is the
 * point: this message can be sent twice - a retry, a template fallback, a
 * dispatcher re-closing an order - and a customer who gets two goodbyes in
 * different words is talking to something unwell. It also means a complaint
 * about a particular message can be traced to the order that sent it.
 */
export function signOffFor(order: repo.OrderRecord, lang: Language = 'en'): string {
  // A pool per kind, because the wish has to be about what was actually
  // delivered. "Enjoy your meal" over a bag of rice and a bottle of bleach
  // reads as a message meant for somebody else, and a parcel sender was not
  // given anything to enjoy at all — what they gave was trust.
  const pool =
    order.kind === 'restaurant'
      ? MEAL_SIGN_OFFS
      : order.kind === 'grocery'
        ? SHOPPING_SIGN_OFFS
        : order.kind === 'taxi'
          ? TAXI_SIGN_OFFS
          : PARCEL_SIGN_OFFS;

  const n = Number(order.orderNo.replace(/[^0-9]/g, ''));
  const pick = Number.isFinite(n) ? n % pool.length : 0;
  return String.fromCharCode(10) + t(pool[pick] ?? pool[0] ?? 'signoff_meal', lang);
}

/**
 * The thanks, for what this customer actually did.
 *
 * One line, chosen by kind rather than written three times. A grocery customer
 * shopped, a restaurant customer ordered from a named kitchen, and a parcel
 * customer bought nothing at all — they chose the service to carry something.
 *
 * The restaurant line names the kitchen because the customer picked it by name
 * and knows it. The grocery line deliberately does not name the shop: with one
 * grocery nobody is ever shown which it is, so naming it here would introduce a
 * shop the customer has never heard of in the last message of the conversation.
 */
export function thanksFor(order: repo.OrderRecord, lang: Language = 'en'): string {
  if (order.kind === 'grocery') return t('thanks_grocery', lang);
  // A taxi thanks them for choosing the shop, as a parcel does. The line
  // below names a kitchen, and a passenger who has just been driven home
  // being thanked for ordering from a roti shop is the wrong message
  // entirely.
  if (order.kind === 'parcel' || order.kind === 'taxi') {
    return t('thanks_parcel', lang, { store: config.store.name });
  }
  return t('thanks_restaurant', lang, {
    outlet: order.outlet?.name ?? config.store.name,
  });
}

/**
 * The line that gives a customer their delivery code, or nothing.
 *
 * Nothing when codes are switched off, when the order predates them, or once it
 * has already been verified - re-sending a spent code invites somebody to read
 * out digits that no longer open anything, and makes the shop look confused
 * about its own delivery.
 */
export function doorCodeLine(order: repo.OrderRecord, lang: Language): string {
  if (!config.deliveryCode) return '';
  const state = repo.deliveryCodeState(order.orderNo);
  if (!state.exists || state.verifiedAt) return '';
  const code = repo.deliveryCodeFor(order.orderNo);
  if (!code) return '';

  // Somebody else is at the door, so somebody else needs the digits.
  //
  // The recipient cannot be messaged directly: WhatsApp refuses a
  // business-initiated message to a number that has never written in, and no
  // template can carry a code generated seconds ago. So the buyer is told the
  // code is for them to pass on - which is how a parcel has always worked.
  // Without this every third-party delivery ends with the associate tapping
  // "No code", and the unverified count stops meaning anything.
  const to = order.recipientName?.trim();
  if (to && to !== order.customerName) {
    return t('door_code_for', lang, { code, name: to });
  }
  return t('door_code', lang, { code });
}

/**
 * The receipt, printed when the order is handed over.
 *
 * Until now the last priced thing a customer saw was the cart, before the
 * order existed. They were told their order arrived and never told what
 * arrived, or what the money was for - which is the one message where both
 * facts are finally settled.
 *
 * What was ORDERED, line by line, plus the delivery charge. Nothing here is
 * recalculated: every figure is read off the order as it was written, so the
 * receipt and the total the associate collected cannot drift apart.
 *
 * No padded columns. WhatsApp renders a plain message in a proportional font,
 * so spaces lined up here arrive ragged on a phone; the label goes in front of
 * each figure instead, which reads the same in any font.
 */
export function receiptLines(order: repo.OrderRecord, lang: Language): string[] {
  // A taxi has no receipt to give. Nothing was bought, and the fare was never
  // known to the shop: the driver agrees it with the passenger in the car.
  // Rendering one anyway produced "*Total $0* — paid in cash" at the end of a
  // journey somebody is about to pay for, which is worse than silence.
  if (order.kind === 'taxi') return [];

  const isParcel = order.kind === 'parcel';

  // The time it was HANDED OVER, not the time it was ordered.
  //
  // A receipt is dated when the money changed hands, which on a delivery is
  // the doorstep - and the gap matters: an order placed at ten to eight and
  // delivered at half past nine carried a receipt saying 7:50, which is
  // neither when they paid nor when they got it.
  //
  // Falls back to the order's own time, so a receipt rendered before delivery
  // - a gallery, a test, a reprint of something still on the road - still
  // says something true rather than nothing.
  const when = (() => {
    const at = new Date(repo.deliveredAt(order.orderNo) || order.placedAt);
    if (Number.isNaN(at.getTime())) return '';
    return at.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: config.store.timezone,
    });
  })();

  // Deliberately without the order number: the line directly below this one
  // is "Order ORD-00042 delivered", and the same reference twice in one
  // message is a line read, checked against the other, and trusted less.
  const head = `🧾 *${t('receipt_title', lang)}*${when ? ` — ${when}` : ''}`;

  // A parcel bought nothing. Its fee was agreed and handed over at the uplift
  // by the person who sent it, so neither a goods line nor "paid at the door"
  // is true of one.
  if (isParcel) {
    return [
      head,
      '',
      `📦 ${order.parcelDetails || t('receipt_parcel_fee', lang)}`,
      // An unpriced parcel - one the associate agreed at the counter - has no
      // figure anybody here knows. Saying nothing is the only honest option:
      // the shop never learned what was settled.
      ...(order.total > 0
        ? ['', `*${t('receipt_parcel_fee', lang)} ${money(order.total)}* — ${t('receipt_paid_at_pickup', lang)}`]
        : []),
    ];
  }

  // How it was paid, from what was agreed when the order was placed. An
  // unrecognised method drops the clause rather than guessing: "Total $6,750"
  // on its own is true whatever the money was.
  const method = order.paymentMethod.startsWith('cash')
    ? t('receipt_paid_cash', lang)
    : order.paymentMethod.startsWith('card')
      ? t('receipt_paid_card', lang)
      : '';

  return [
    head,
    '',
    ...order.items.map((i) => {
      const chosen = summariseStored(i.options);
      return `${i.qty} x ${i.name}${chosen ? ` _${chosen}_` : ''} — ${money(i.lineTotal)}`;
    }),
    '',
    // The split only where there is something to split. With no delivery
    // charge, "Goods $3,200" above "Total $3,200" is the same figure twice
    // and a "Delivery $0" line is a charge that was never made - which on a
    // receipt reads like a question rather than an answer.
    ...(order.deliveryFee > 0
      ? [
          `${t('receipt_goods', lang)} ${money(order.subtotal)}`,
          // Named, where the order was charged under a zone. A delivery
          // charge is the line a customer queries, and "Delivery $1,800" says
          // nothing about why; "Delivery to Diamond $1,800" answers the
          // question before it is asked.
          order.deliveryZone
            ? `${t('receipt_delivery', lang)} ${order.deliveryZone} ${money(order.deliveryFee)}`
            : `${t('receipt_delivery', lang)} ${money(order.deliveryFee)}`,
        ]
      : []),
    // The reward, where one was spent. Shown as a deduction rather than
    // folded into the total: a customer who used five hundred dollars of
    // points must see the five hundred dollars, or the scheme has given them
    // nothing they can point at.
    ...(order.rewardValue > 0
      ? [`${t('receipt_reward', lang)} −${money(order.rewardValue)}`]
      : []),
    `*${t('receipt_total', lang)} ${money(order.total)}*${method ? ` — ${method}` : ''}`,
  ];
}

/**
 * How a delivered order closes.
 *
 * Two shapes, differing in one receipt line. The unverified one states the fact
 * where a receipt would put it - before the thanks, not in place of them -
 * because the order did arrive and the only thing in question is how that was
 * proved. Leading with the qualification would make every flat phone battery
 * read as a failed delivery.
 *
 * The invitation to write back comes last, after the sign-off, so the actionable
 * line is the one left on the screen. It also keeps a warning from landing
 * immediately before "enjoy your meal".
 */
export function deliveredMessage(order: repo.OrderRecord, lang: Language): string {
  const unconfirmed = repo.deliveryCodeUnconfirmed(order.orderNo);
  const confirmed = repo.deliveryCodeConfirmed(order.orderNo);

  // Three shapes, not two. An order that never had a code is told neither
  // thing - it is not a confirmed delivery and it is not a failed one, and
  // saying either would be inventing a fact about it.
  const isTaxi = order.kind === 'taxi';
  const key = unconfirmed ? 'delivered_unverified' : confirmed ? 'delivered_confirmed' : 'delivered';
  // A passenger was not delivered. The trip ended, which is a different
  // sentence and the only one that is true of somebody who got out of a car.
  const receipt = isTaxi
    ? t('taxi_dropped_off', lang, { order: order.orderNo })
    : t(key, lang, { order: order.orderNo });
  // Receipt, then thanks, then the wish. The thanks used to be the tail of the
  // receipt line itself, which meant one sentence had to suit a bag of
  // groceries, a hot meal and a parcel alike.
  const nl = String.fromCharCode(10);
  // The order closes, then the receipt for it, then the manners.
  //
  // The receipt used to come first. It reads better this way round: the line
  // the customer is waiting for is the one that says it arrived, and a receipt
  // is what you are handed afterwards rather than something to scroll past to
  // find out whether your delivery is done.
  //
  // A taxi has no receipt block at all, so it closes up rather than leaving
  // the blank lines that block used to sit between.
  const head = [
    receipt,
    ...(isTaxi ? [] : ['', ...receiptLines(order, lang)]),
    '',
    thanksFor(order, lang),
  ].join(nl);

  // Only the unconfirmed one invites a reply. On a delivery the customer
  // proved themselves, "anything wrong?" would be the shop asking a question
  // it already has the answer to.
  return head + signOffFor(order, lang) + (unconfirmed ? t('delivered_check', lang) : '');
}

export async function notifyCustomerOfStatus(
  order: repo.OrderRecord,
  status: repo.OrderStatus,
  /**
   * Who moved it, appended to the message for troubleshooting.
   *
   * Empty unless DIAGNOSE_SOURCE is on, and it must stay that way outside a
   * session somebody is watching: this puts a kitchen's telephone number into
   * a customer's chat. It is never added to a template, which has no room for
   * it and would need re-approving.
   */
  movedBy = '',
): Promise<'text' | 'template' | 'skipped'> {
  // Everything below is fixed text rather than something the model wrote, so
  // it is the one part of the conversation that would otherwise stay English
  // however the customer has been writing.
  const lang = languageFor(order.phone);
  const message = customerStatusMessage(order, status, lang);
  if (!message) return 'skipped';
  const firstName = order.customerName.split(/\s+/)[0] ?? order.customerName;

  if (repo.withinServiceWindow(order.phone)) {
    const traced = movedBy
      ? message + String.fromCharCode(10) + String.fromCharCode(10) + `_[moved by ${/^[0-9]+$/.test(movedBy) ? '+' + movedBy : movedBy}]_`
      : message;
    await sendText(order.phone, traced);
    // Only now, and only on this route. The code is in the customer's hands
    // because this message carried it; the template below cannot, and claiming
    // otherwise would have the associate asking for digits nobody has.
    if (status === 'on_the_way' && doorCodeLine(order, lang)) repo.markCodeSent(order.orderNo);

    // The rating goes out as its own message, straight after. The one above
    // closes the order and carries the receipt and the goodbye; a question
    // under all of that is read as part of the signature and scrolled past.
    //
    // Only on this route, like the code above: the template that serves a
    // customer outside the 24-hour window cannot carry a list, and there is
    // no sense recording that somebody was asked something they never saw.
    // What this delivery earned, and what it adds up to. Sent before the
    // rating question: the good news first, and a customer who sees what
    // their last delivery was worth is readier to answer what they thought
    // of it.
    if (status === 'delivered') {
      const earned = repo.pointsEarnedOn(order.orderNo);
      if (earned > 0) {
        const { balanceLines, usualDelivery } = await import('./rewards.ts');
        const nl = String.fromCharCode(10);
        await sendText(
          order.phone,
          [
            t('points_earned', lang, { points: String(earned) }),
            ...balanceLines(repo.pointsBalance(order.phone), lang, usualDelivery(order.phone)),
          ].join(nl),
        );
      }
    }

    if (status === 'delivered') {
      const { shouldAsk, ratingAsk } = await import('./ratings.ts');
      const fresh = repo.findOrder(order.orderNo) ?? order;
      if (shouldAsk(fresh)) {
        const ask = ratingAsk(fresh);
        if (ask.kind === 'list' && (await sendList(order.phone, ask.text, ask.button, ask.rows))) {
          repo.recordRatingAsk(fresh.orderNo, fresh.phone, fresh.kind);
        }
      }
    }
    return 'text';
  }

  const templateName =
    status === 'on_the_way'
      ? config.templates.onTheWay
      : status === 'delivered'
        ? config.templates.delivered
        : '';

  if (!templateName) {
    console.warn(
      `[notify] ${order.orderNo} → ${status}: outside the 24h window and no template configured, so the customer was not told`,
    );
    return 'skipped';
  }

  await sendTemplate(order.phone, templateName, [firstName, order.orderNo, money(order.total)]);
  return 'template';
}

/**
 * Exactly what a customer is sent when an order moves, or '' when nothing is.
 *
 * Pulled out of the sending so it can be read without sending anything - by a
 * check, or by the walkthrough that prints one delivery end to end. A
 * walkthrough that rebuilds the message itself proves only that it can rebuild
 * the message: the parcel payment line was wrong for a week behind exactly
 * that shortcut.
 */
export function customerStatusMessage(
  order: repo.OrderRecord,
  status: repo.OrderStatus,
  lang: Language = 'en',
): string {
  const firstName = order.customerName.split(/\s+/)[0] ?? order.customerName;

  const freeForm: Partial<Record<repo.OrderStatus, string>> = {
    // A taxi is confirmed the moment an associate takes the job, and what the
    // passenger needs to know then is that a car is coming — not that an
    // order has been accepted and we will say when it leaves.
    confirmed:
      order.kind === 'taxi'
        ? t('taxi_confirmed', lang, { name: firstName, order: order.orderNo }) +
          // The code travels with the news that a car is coming, because the
          // two facts are only useful together: digits with no car are a
          // puzzle, and a car with no digits is a stranger pulling up.
          (() => {
            const code = repo.safetyCodeFor(order.orderNo);
            const nl = String.fromCharCode(10);
            return code ? nl + nl + t('taxi_safety_code', lang, { code }) : '';
          })()
        : t('confirmed', lang, { name: firstName, order: order.orderNo }),
    // A parcel was paid for at the pickup, before it went anywhere. Telling
    // the sender it is "payable to the delivery associate" asks them for the
    // money a second time, and tells whoever booked it to expect a bill that
    // is already settled.
    on_the_way:
      (order.kind === 'taxi'
        ? t('taxi_on_the_way', lang, { name: firstName }) +
          String.fromCharCode(10) +
          // Said plainly, once, at the moment the passenger is in the car and
          // wondering what this will cost. The shop has no figure to give:
          // what it can do is say who to ask instead of quoting a $0 total.
          t('taxi_fare_with_driver', lang)
        : order.kind === 'parcel'
        ? t('parcel_on_the_way', lang, {
            order: order.orderNo,
            name: order.recipientName || 'the recipient',
          })
        : t('on_the_way', lang, {
            name: firstName,
            order: order.orderNo,
            total: money(order.total),
          })) + doorCodeLine(order, lang),
    // The store name rather than the words, so a rename carries through here
    // too — this is the last thing a customer reads from every order.
    delivered: deliveredMessage(order, lang),
    // The reason is the difference between an apology and an explanation. A
    // customer told the kitchen ran out knows to try something else; one told
    // only "cancelled" assumes they did something wrong.
    cancelled: cancelledMessage(order),
    // The one message that goes to the sender rather than to whoever was
    // receiving: it is their parcel, coming back to them.
    // Which of the two it was. A missed appointment and a code that would not
    // verify are different events to the person who sent it: one is a nuisance,
    // the other means the parcel may have been offered at the wrong door, and
    // the sender is the only one who can find out which.
    // Three endings, not two. A parcel goes back to whoever sent it, and the
    // two reasons read differently to them. Everything else is going back to
    // the shop and the person being written to is the one who was not at the
    // door - so none of the parcel wording fits, and saying "coming back to
    // you" to somebody who was out is close to rude.
    returned: order.kind === 'taxi'
      ? t('taxi_no_show', lang, { order: order.orderNo })
      : order.kind === 'parcel'
      ? t(
          repo.returnReason(order.orderNo) === 'wrong_code'
            ? 'returned_wrong_code'
            : 'returned_to_sender',
          lang,
          { order: order.orderNo, name: order.recipientName || 'the recipient' },
        )
      : t('returned_nobody_home', lang, { order: order.orderNo }),
  };

  return freeForm[status] ?? '';
}

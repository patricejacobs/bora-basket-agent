import { config, money } from './config.ts';
import { t, type Language } from './language.ts';
import { languageFor } from './services.ts';
import * as repo from './db/repo.ts';
import { sendText, sendButtons, sendTemplate, sendLocation } from './channels/whatsapp-send.ts';
import { nextActions, CANCEL_REASONS } from './order-status.ts';
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

  const lines = [
    isParcel
      ? `📦 *New parcel job ${order.orderNo}*`
      : order.outlet
        ? `🍽️ *New order ${order.orderNo}* — ${order.outlet.name}`
        : `🛒 *New order ${order.orderNo}*`,
    '',
    // A parcel has no line items — one bag and a description.
    ...(isParcel
      ? [order.parcelDetails || 'Contents not described']
      : order.items.map((i) => {
          const chosen = summariseStored(i.options);
          return `${i.qty} x ${i.name}${chosen ? ` — _${chosen}_` : ''} — ${money(i.lineTotal)}`;
        })),
    '',
    order.total > 0
      ? `*Total ${money(order.total)}* (${order.status === 'pending' ? 'unconfirmed' : order.status})`
      : '*Fee not set* — confirm the cost with the customer before uplifting',
    ...(isParcel && order.pickup
      ? ['', `Uplift from: ${order.pickup.address || 'pin below'}`, `Sender ${order.customerName} +${order.contactPhone || order.phone}`]
      : []),
    // A restaurant order is not yours to pack, so the shop's line is the wait
    // and the collection rather than a picking list.
    ...(order.outlet
      ? [
          `Uplift from ${order.outlet.name}${order.outlet.pickupAddress ? `, ${order.outlet.pickupAddress}` : ''}`,
          `Kitchen reckons about ${order.outlet.prepMinutes} minutes`,
        ]
      : []),
    '',
    isParcel ? `To: ${order.recipientName} +${order.recipientPhone}` : `${order.customerName}`,
    // Doorstep detail, which is often empty now that the pin carries the
    // location. Skipped rather than printed as a blank line.
    ...(order.address ? [order.address] : []),
    `📞 +${order.contactPhone || order.phone}`,
    ...(order.location
      ? ['', describePin(order.location, checkRange(order.location, config.store.serviceArea))]
      : ['', '⚠️ No location pin on this order']),
  ];
  if (order.deliveryNote) lines.push(`Note: ${order.deliveryNote}`);

  const body = lines.join('\n');
  const actions = nextActions(order.orderNo, order.status);

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
  // Food is food because a kitchen cooked it, which is the one fact that
  // cannot be wrong - a grocery order has no outlet and neither does a parcel.
  if (!order.outlet) return '';

  const n = Number(order.orderNo.replace(/[^0-9]/g, ''));
  const pick = Number.isFinite(n) ? n % MEAL_SIGN_OFFS.length : 0;
  return String.fromCharCode(10) + t(MEAL_SIGN_OFFS[pick] ?? 'signoff_meal', lang);
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
  const key = unconfirmed ? 'delivered_unverified' : confirmed ? 'delivered_confirmed' : 'delivered';
  const head = t(key, lang, { order: order.orderNo, store: config.store.name });

  // Only the unconfirmed one invites a reply. On a delivery the customer
  // proved themselves, "anything wrong?" would be the shop asking a question
  // it already has the answer to.
  return head + signOffFor(order, lang) + (unconfirmed ? t('delivered_check', lang) : '');
}

export async function notifyCustomerOfStatus(
  order: repo.OrderRecord,
  status: repo.OrderStatus,
): Promise<'text' | 'template' | 'skipped'> {
  const firstName = order.customerName.split(/\s+/)[0] ?? order.customerName;

  // Everything below is fixed text rather than something the model wrote, so
  // it is the one part of the conversation that would otherwise stay English
  // however the customer has been writing.
  const lang = languageFor(order.phone);

  const freeForm: Partial<Record<repo.OrderStatus, string>> = {
    confirmed: t('confirmed', lang, { name: firstName, order: order.orderNo }),
    on_the_way:
      t('on_the_way', lang, {
        name: firstName,
        order: order.orderNo,
        total: money(order.total),
      }) + doorCodeLine(order, lang),
    // The store name rather than the words, so a rename carries through here
    // too — this is the last thing a customer reads from every order.
    delivered: deliveredMessage(order, lang),
    // The reason is the difference between an apology and an explanation. A
    // customer told the kitchen ran out knows to try something else; one told
    // only "cancelled" assumes they did something wrong.
    cancelled: cancelledMessage(order),
    // The one message that goes to the sender rather than to whoever was
    // receiving: it is their parcel, coming back to them.
    returned: t('returned_to_sender', lang, {
      order: order.orderNo,
      name: order.recipientName || 'the recipient',
    }),
  };

  const message = freeForm[status];
  if (!message) return 'skipped';

  if (repo.withinServiceWindow(order.phone)) {
    await sendText(order.phone, message);
    // Only now, and only on this route. The code is in the customer's hands
    // because this message carried it; the template below cannot, and claiming
    // otherwise would have the associate asking for digits nobody has.
    if (status === 'on_the_way' && doorCodeLine(order, lang)) repo.markCodeSent(order.orderNo);
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

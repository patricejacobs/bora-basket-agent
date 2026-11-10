import { config, money } from './config.ts';
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
      : '*Fee not set* — confirm the cost with the customer before collecting',
    ...(isParcel && order.pickup
      ? ['', `Collect from: ${order.pickup.address || 'pin below'}`, `Sender ${order.customerName} +${order.contactPhone || order.phone}`]
      : []),
    // A restaurant order is not yours to pack, so the shop's line is the wait
    // and the collection rather than a picking list.
    ...(order.outlet
      ? [
          `Collect from ${order.outlet.name}${order.outlet.pickupAddress ? `, ${order.outlet.pickupAddress}` : ''}`,
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

  const byOutlet = order.cancelledBy === 'outlet' && Boolean(order.outlet?.name);
  const subject = byOutlet
    ? `*${order.outlet!.name}* has cancelled your order`
    : `Order ${order.orderNo} has been cancelled`;

  // An order the customer asked us to cancel is not something to apologise for.
  // Anything else is, and the regret goes first, before the explanation.
  const opening = known && !known.apologise ? `Done ${firstName} —` : `Sorry about this ${firstName} —`;

  // The reason is passed on as given, and the message ends there. Inviting
  // somebody to write back if it is "not right" implies the cancellation might
  // be a mistake and puts the work of chasing it on them — when what they
  // actually need is to know why, so they can decide what to do next.
  if (known) {
    return `${opening} ${subject}: ${known.customer}. Nothing has been charged.`;
  }
  if (order.cancelReason && order.cancelReason !== 'No reason given') {
    return `${opening} ${subject}. Reason given: ${order.cancelReason}. Nothing has been charged.`;
  }
  return `${opening} ${subject}. Nothing has been charged.`;
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
export async function notifyCustomerOfStatus(
  order: repo.OrderRecord,
  status: repo.OrderStatus,
): Promise<'text' | 'template' | 'skipped'> {
  const firstName = order.customerName.split(/\s+/)[0] ?? order.customerName;

  const freeForm: Partial<Record<repo.OrderStatus, string>> = {
    confirmed: `Thanks ${firstName} — order ${order.orderNo} is confirmed. We'll let you know when it's on the way.`,
    on_the_way: `${firstName}, your order ${order.orderNo} is on its way 🛵\nTotal ${money(order.total)}, payable to the delivery associate.`,
    // The store name rather than the words, so a rename carries through here
    // too — this is the last thing a customer reads from every order.
    delivered: `Order ${order.orderNo} delivered. Thank you for choosing ${config.store.name}!`,
    // The reason is the difference between an apology and an explanation. A
    // customer told the kitchen ran out knows to try something else; one told
    // only "cancelled" assumes they did something wrong.
    cancelled: cancelledMessage(order),
  };

  const message = freeForm[status];
  if (!message) return 'skipped';

  if (repo.withinServiceWindow(order.phone)) {
    await sendText(order.phone, message);
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

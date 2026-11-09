/**
 * Who gets told what, once a restaurant order exists.
 *
 * A grocery order has one audience: the shop picks it and drives it. Cooked food
 * has three, and they want different things at different moments:
 *
 *   the kitchen  — what to cook, and nothing about the customer's address
 *   the rider    — where to collect, where to take it, who to ring, what to collect
 *   the shop     — all of it, because someone has to notice when a kitchen goes quiet
 *
 * The rider is deliberately told only when the food is actually ready. Sent at
 * order time they stand in a restaurant watching a fryer, which is how delivery
 * companies lose riders.
 */
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { sendText, sendButtons, sendLocation } from './channels/whatsapp-send.ts';
import { nextActions } from './order-status.ts';
import { summariseStored } from './menu-options.ts';
import { checkRange, describePin, mapsLink } from './location.ts';
import { notifyStaffOfNewOrder } from './notifications.ts';

/**
 * Everyone who needs to know a new order exists.
 *
 * The shop always, and the kitchen too when the food is someone else's to cook.
 * One call so a future order path cannot tell one audience and forget the other
 * — which would read, from the customer's side, as a restaurant that never
 * started cooking.
 */
export async function announceNewOrder(orderNo: string): Promise<void> {
  await notifyStaffOfNewOrder(orderNo);
  const outcome = await notifyOutletOfOrder(orderNo);
  if (outcome === 'no_number') {
    console.warn(`[dispatch] ${orderNo} needs cooking but the outlet cannot be reached`);
  }
}

/** An order's lines as a kitchen or a rider wants to read them. */
function itemLines(order: repo.OrderRecord): string[] {
  return order.items.map((i) => {
    const chosen = summariseStored(i.options);
    return `${i.qty} x ${i.name}${chosen ? ` — _${chosen}_` : ''}`;
  });
}

/**
 * The kitchen ticket.
 *
 * No address and no customer phone number. The kitchen's job is to cook; handing
 * a restaurant the home address and number of every customer who orders through
 * you gives away the relationship and tells them nothing they need.
 */
export async function notifyOutletOfOrder(orderNo: string): Promise<'sent' | 'no_number' | 'not_a_restaurant'> {
  const order = repo.findOrder(orderNo);
  if (!order?.outlet) return 'not_a_restaurant';

  const outlet = repo.outletById(order.outlet.id);
  if (!outlet?.whatsapp) {
    console.warn(`[dispatch] ${orderNo} is for ${order.outlet.name}, which has no WhatsApp number`);
    return 'no_number';
  }

  const body = [
    `👨‍🍳 *Order ${order.orderNo}* — please cook`,
    '',
    ...itemLines(order),
    '',
    // The food only. A kitchen has no business seeing what the customer pays
    // for delivery, and showing it invites an argument about the split.
    `Food total ${money(order.items.reduce((sum, i) => sum + i.lineTotal, 0))}`,
    `Ordered ${new Date(order.placedAt).toLocaleTimeString('en-GB', {
      timeZone: config.store.timezone,
      hour: 'numeric',
      minute: '2-digit',
    })}`,
    '',
    'Tap *Confirm* to accept, then *Food ready* when it is up and a rider will come.',
  ].join('\n');

  await sendButtons(outlet.whatsapp, body, nextActions(order.orderNo, order.status, 'outlet'));
  return 'sent';
}

/**
 * The rider's job card: where to collect, where to go, who to ring, what to collect.
 *
 * This is the message that has to be complete, because a rider reading it is
 * on a bike and will not scroll back through a conversation. Both ends get a
 * tappable maps link, and both pins follow as map cards.
 */
export async function dispatchToDrivers(orderNo: string): Promise<'sent' | 'no_drivers'> {
  const order = repo.findOrder(orderNo);
  if (!order) return 'no_drivers';

  if (config.driverNumbers.length === 0) {
    console.warn(`[dispatch] ${orderNo} is ready but DRIVER_NUMBERS is empty — no rider was told`);
    return 'no_drivers';
  }

  const pickup = order.outlet;
  const pickupPin =
    pickup && pickup.pickupLat !== null && pickup.pickupLng !== null
      ? { latitude: pickup.pickupLat, longitude: pickup.pickupLng }
      : null;

  const body = [
    `🛵 *Collect ${order.orderNo}*`,
    '',
    ...(pickup
      ? [
          `*Pick up:* ${pickup.name}`,
          ...(pickup.pickupAddress ? [pickup.pickupAddress] : []),
          ...(pickupPin ? [mapsLink(pickupPin)] : []),
          '',
        ]
      : ['*Pick up:* the shop', '']),
    ...itemLines(order),
    '',
    `*Deliver to:* ${order.customerName}`,
    ...(order.address ? [order.address] : []),
    `📞 +${order.contactPhone || order.phone}`,
    ...(order.location
      ? [describePin(order.location, checkRange(order.location, config.store.serviceArea))]
      : ['⚠️ No location pin on this order — ring the customer']),
    '',
    // The one number a rider must not get wrong: cash due on the doorstep.
    `*Collect ${money(order.total)} cash* (${order.items.length} item${order.items.length === 1 ? '' : 's'} + delivery)`,
  ].join('\n');

  const actions = nextActions(order.orderNo, 'ready', 'driver');

  for (const driver of config.driverNumbers) {
    await sendButtons(driver, body, actions);

    // The pins as map cards, in the order the rider needs them: collection
    // first, then the drop. A link is for reading; these are for navigating.
    if (pickupPin && pickup) {
      await sendLocation(driver, {
        latitude: pickupPin.latitude,
        longitude: pickupPin.longitude,
        name: `Collect — ${pickup.name}`,
        ...(pickup.pickupAddress ? { address: pickup.pickupAddress } : {}),
      });
    }
    if (order.location) {
      await sendLocation(driver, {
        latitude: order.location.latitude,
        longitude: order.location.longitude,
        name: `Deliver — ${order.customerName}`,
        ...(order.location.label || order.address
          ? { address: order.location.label || order.address }
          : {}),
      });
    }
  }

  // Recorded so a repeated "food ready" cannot quietly send a second rider.
  repo.assignDriver(orderNo, config.driverNumbers[0] ?? '');
  return 'sent';
}

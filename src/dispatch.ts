/**
 * Who gets told what, once a restaurant order exists.
 *
 * A grocery order has one audience: the shop picks it and drives it. Cooked food
 * has three, and they want different things at different moments:
 *
 *   the kitchen  — what to cook, and nothing about the customer's address
 *   the delivery associate    — where to collect, where to take it, who to ring, what to collect
 *   the shop     — all of it, because someone has to notice when a kitchen goes quiet
 *
 * The delivery associate is deliberately told only when the food is actually ready. Sent at
 * order time they stand in a restaurant watching a fryer, which is how delivery
 * companies lose delivery associates.
 */
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { sendText, sendButtons, sendTemplate } from './channels/whatsapp-send.ts';
import { nextActions } from './order-status.ts';
import { summariseStored } from './menu-options.ts';
import { checkRange, describePin, mapsLink, distanceKm, formatDistance } from './location.ts';
import { notifyStaffOfNewOrder, warnStaff } from './notifications.ts';

/**
 * The associates near enough to a pickup to be worth telling.
 *
 * Three rules, and the last two matter more than the first.
 *
 * Distance is measured from the last position we know: a pin they shared, or
 * the doorstep of their last delivery. Anyone whose position is unknown, or
 * known but stale, is included — an associate who has not shared a pin would
 * otherwise stop receiving work and nobody would be able to say why.
 *
 * And if the filter leaves nobody at all, everybody is told. A long trip is a
 * complaint; an order nobody hears about is a customer who never gets dinner.
 */
/**
 * The associates who have clocked on.
 *
 * If nobody has, everybody is told instead. An associate who gets a job card
 * while off duty is mildly annoyed; an order nobody hears about is a customer
 * with no dinner and a kitchen with cooling food. Staff are warned, because a
 * shop running with nobody clocked on is something somebody should know.
 *
 * The same rule the distance filter follows: a filter that leaves nobody is a
 * filter that should not have run.
 */
function onDuty(associates: string[]): string[] {
  const working = associates.filter((phone) => repo.isOnDuty(phone));
  if (working.length > 0) return working;

  console.warn('[dispatch] nobody is clocked on - offering the job to everyone');
  void warnStaff(
    'No delivery associate is clocked on. The job has gone to everyone - check somebody is working.',
  ).catch(() => {});
  return associates;
}

function withinReach(
  associates: string[],
  pickup: { latitude: number; longitude: number } | null,
): string[] {
  const miles = config.associateRadiusMiles;
  if (miles <= 0 || !pickup) return associates;

  const radiusKm = miles * 1.60934;
  const freshAfter = Date.now() - config.associateLocationTtlMinutes * 60_000;

  const near = associates.filter((phone) => {
    const at = repo.getAssociateLocation(phone);
    if (!at) return true;
    if (new Date(at.updatedAt).getTime() < freshAfter) return true;
    return distanceKm(at, pickup) <= radiusKm;
  });

  if (near.length === 0) {
    console.warn(
      `[dispatch] no associate within ${miles} miles of the pickup — telling everyone instead`,
    );
    return associates;
  }
  return near;
}

/**
 * Tells a kitchen to stop cooking something that has been cancelled.
 *
 * Shared, because three different people can cancel an order and a kitchen
 * that keeps cooking is wasted food however it happened. Returns what to tell
 * whoever cancelled, so they know whether the kitchen actually heard.
 */
export async function tellKitchenCancelled(orderNo: string, hadAccepted = true): Promise<string> {
  const order = repo.findOrder(orderNo);
  if (!order?.outlet) return '';

  const outlet = repo.outletById(order.outlet.id);
  if (!outlet?.whatsapp) return '⚠️ Kitchen has no WhatsApp number — ring them to stop the order.';

  const reason = order.cancelReason ? ` — ${order.cancelReason}` : '';
  // A kitchen that never accepted the ticket has not started, and telling it to
  // "stop cooking" invites a worried phone call about food it never made.
  const what = hadAccepted
    ? 'Stop preparing it if you have started.'
    : 'Do not start it — ignore the ticket.';
  try {
    await sendText(outlet.whatsapp, `🚫 *${order.orderNo} cancelled*${reason}.

${what}`);
    return 'Kitchen told to stop.';
  } catch (err) {
    console.error('[dispatch] could not tell the kitchen about a cancellation:', err);
    return '⚠️ Could not tell the kitchen — ring them.';
  }
}

/**
 * Calls off a job that associates have already been sent.
 *
 * Only matters once the food was cooked, because that is when a job card goes
 * out. Before then nobody has been asked to go anywhere.
 *
 * Sent to whoever is carrying it if that is known, and to everyone otherwise,
 * because the card went to several and there is no record of who read it. An
 * associate who gets a cancellation for a job they never took is mildly
 * confused; one who rides to a cancelled order has wasted a trip and arrives
 * at a kitchen with nothing for them.
 */
export async function tellAssociatesCancelled(orderNo: string): Promise<number> {
  const order = repo.findOrder(orderNo);
  if (!order) return 0;

  const told = order.driverPhone ? [order.driverPhone] : config.driverNumbers;
  if (told.length === 0) return 0;

  const where = order.outlet?.name ?? 'the shop';
  const reason = order.cancelReason ? ` - ${order.cancelReason}` : '';
  const body = [
    `🚫 *${order.orderNo} cancelled*${reason}.`,
    '',
    `Do not uplift it from ${where}. If you are already there, leave it with them.`,
  ].join(String.fromCharCode(10));

  let sent = 0;
  for (const associate of told) {
    try {
      if (await sendText(associate, body)) sent++;
    } catch (err) {
      console.error('[dispatch] could not call off an associate:', err);
    }
  }
  return sent;
}

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
  if (outcome === 'nudged') {
    console.log(`[dispatch] ${orderNo}: kitchen nudged by template, ticket held until they reply`);
  }
}

/**
 * What is being carried, as a kitchen or a delivery associate wants to read it.
 *
 * A parcel has no line items — it is one bag with a description — so it gets
 * the sender's own words instead. Anything reading an order has to cope with
 * both, or a parcel prints as an empty list.
 */
function itemLines(order: repo.OrderRecord): string[] {
  if (order.kind === 'parcel') {
    return [`📦 ${order.parcelDetails || 'Parcel (contents not described)'}`];
  }
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
export type TicketOutcome = 'sent' | 'nudged' | 'unreachable' | 'no_number' | 'not_a_restaurant';

export async function notifyOutletOfOrder(orderNo: string): Promise<TicketOutcome> {
  const order = repo.findOrder(orderNo);
  if (!order?.outlet) return 'not_a_restaurant';

  const outlet = repo.outletById(order.outlet.id);
  if (!outlet?.whatsapp) {
    console.warn(`[dispatch] ${orderNo} is for ${order.outlet.name}, which has no WhatsApp number`);
    return 'no_number';
  }

  // The 24-hour window. A ticket is a plain message with buttons, and Meta
  // refuses those outside it — silently, as far as the kitchen is concerned.
  // Sending anyway is how an order sits at pending with nobody wondering why.
  if (!repo.serviceWindowOpen(outlet.whatsapp)) {
    return nudgeOutlet(order, outlet.whatsapp);
  }

  const body = [
    `👨‍🍳 *Order ${order.orderNo}* — please prepare`,
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
    `Tap *Confirm* to accept, then *${order.orderNo} ready* when the food is up and a delivery associate will come.`,
  ].join('\n');

  const ok = await sendButtons(
    outlet.whatsapp,
    body,
    nextActions(order.orderNo, order.status, 'outlet'),
  );
  // A send can still be refused for a reason the window check cannot see — a
  // clock that disagrees with Meta's, or a number that has blocked the shop.
  // Falling back rather than trusting the check keeps one rule: a ticket is
  // only ever marked delivered when Meta actually took it.
  if (!ok) return nudgeOutlet(order, outlet.whatsapp);

  repo.markOutletNotified(order.orderNo);
  return 'sent';
}

/**
 * What to do when the real ticket cannot get through.
 *
 * The template carries no detail beyond the order number, and does not need
 * any: its whole job is to make somebody tap. A tap is an inbound message, the
 * window opens, and the ticket they can actually act on follows at once.
 *
 * With no template configured there is nothing to send, and the honest answer
 * is to tell staff to pick up the phone. That alone is most of the value here —
 * the failure used to be invisible.
 */
async function nudgeOutlet(order: repo.OrderRecord, whatsapp: string): Promise<TicketOutcome> {
  const name = order.outlet?.name ?? 'the kitchen';
  const template = config.templates.kitchenNewOrder;

  if (template && (await sendTemplate(whatsapp, template, [order.orderNo]))) {
    console.warn(`[dispatch] ${order.orderNo}: ${name} is outside the 24h window — template sent`);
    return 'nudged';
  }

  console.error(
    `[dispatch] ${order.orderNo} could not reach ${name}` +
      (template ? ' — the template was refused too' : ' — no TEMPLATE_KITCHEN_NEW_ORDER is set'),
  );
  await warnStaff(
    `⚠️ *${order.orderNo}* could not reach *${name}*.

` +
      `They are outside WhatsApp's 24-hour window${template ? ' and the template was refused' : ' and no template is set up'}. ` +
      `Ring them — the order is waiting and they have not seen it.`,
  );
  return 'unreachable';
}

/**
 * Hands a kitchen the tickets it never received, the moment it messages.
 *
 * Called on any inbound message from an outlet, because any message at all
 * reopens the window — a tapped template button, a question, a thumbs up.
 *
 * Only live orders are handed over, and every order that existed before this
 * was recorded as already delivered, so switching it on cannot bury a kitchen
 * under a month of history for saying hello.
 */
export async function flushOutletTickets(outletId: number): Promise<number> {
  const owed = repo.ordersAwaitingTicket(outletId);
  let delivered = 0;
  for (const order of owed) {
    if ((await notifyOutletOfOrder(order.orderNo)) === 'sent') delivered++;
  }
  if (delivered > 0) {
    console.log(`[dispatch] window reopened — ${delivered} held ticket(s) delivered`);
  }
  return delivered;
}

/**
 * Where it is going, who to ring, and what to take off them.
 *
 * Shared, because an associate reads it twice: once on the job card, and
 * again the moment they have the food and the only thing left is the drop.
 * Repeating it there is the point - WhatsApp cannot retire the old card, so
 * the newest message has to be worth more than scrolling back to it.
 */
export function dropLines(order: repo.OrderRecord): string[] {
  const isParcel = order.kind === 'parcel';

  // The number they are messaging from, which is the one fact about the buyer
  // that cannot be wrong.
  //
  // This used to read `contact_phone`, which means "the best number for this
  // delivery" - and on an order for somebody else that is naturally the
  // RECIPIENT's. So the card printed Jenny's number under "Ordered by:
  // Patrice", and then printed the same digits again lower down under Jenny's
  // name. One number, two people, both labelled with confidence.
  const ordererPhone = order.phone;

  // Who is actually at the door. A recipient on the order means somebody else
  // is receiving it, whatever kind of order it is - parcels have always worked
  // this way and a food order sent to a friend is the same journey.
  const receiverName = order.recipientName || order.customerName;
  // `contact_phone` belongs here, at the door, which is what it was named for.
  const receiverPhone = order.recipientPhone || order.contactPhone || order.phone;
  const toSomebodyElse = Boolean(order.recipientName) && order.recipientName !== order.customerName;

  // Named only when it is a third name on the card. On a parcel the sender is
  // already the *Uplift from:* block above, so repeating them here would be
  // the same person twice; on a self-delivery it would be the same name and
  // number already on screen, pushing the address further down a card that is
  // read on a bike.
  const orderedBy = toSomebodyElse && !isParcel;

  // Two numbers on one card is exactly where a wrong call comes from, so each
  // says what it is for rather than leaving the associate to work it out at a
  // gate.
  // Never the same digits twice under two names. When the only number anybody
  // gave is the buyer's own, say so once rather than printing it as though it
  // were two different people.
  const sameNumber = receiverPhone === ordererPhone;
  // A number with no country code is a local one. Printing it with a `+` says
  // it is international, which it is not, and an associate copying it into a
  // dialler gets nowhere.
  const dial = (n: string): string => (n.replace(/[^0-9]/g, '').length >= 10 ? `+${n}` : n);

  const atTheDoor = toSomebodyElse
    ? sameNumber
      ? `📞 no number for ${receiverName.split(/\s+/)[0] || 'them'} — ring ${order.customerName} above`
      : `📞 ${dial(receiverPhone)} — ring at the door`
    : `📞 ${dial(receiverPhone)}`;

  // The pin's own label, which WhatsApp attaches to a shared location. Shown
  // only when it says something the two lines above do not: more often than
  // not it is the same text as the address, printed twice.
  const sameText = (a: string, b: string): boolean =>
    a.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ') ===
    b.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const pinLabel = order.location?.label ?? '';
  const labelAdds =
    pinLabel !== '' && !sameText(pinLabel, order.address) && !sameText(pinLabel, order.deliveryNote);

  // Whose pin is it?
  //
  // Every order copies the buyer's saved pin at checkout. On a delivery to
  // somebody else that pin is the buyer's own door - so a link built from it
  // sends an associate confidently to the wrong house, with a written address
  // directly above it saying somewhere different. A confident wrong answer is
  // worse than no answer: the associate trusts it and drives there.
  //
  // So a third-party order shows a link only when the buyer actually shared a
  // pin for the recipient during that order.
  const pinIsForThisDoor = order.location !== null && (!toSomebodyElse || order.recipientPin);

  return [
    // A missing pin goes first, not last. It changes how the trip is planned -
    // ring before setting off, rather than after arriving at a street you
    // cannot find - and a warning printed under the phone number is a warning
    // read too late.
    ...(pinIsForThisDoor ? [] : ['⚠️ *NO PIN* — ring before you set off', '']),
    ...(orderedBy
      // The number, and nothing telling them to use it. The buyer is who the
      // order came from, not somebody to call: the only instruction on this
      // card should be the one the associate is meant to act on, and a second
      // "ring" beside a second number is how the wrong one gets dialled.
      ? [`*Ordered by:* ${order.customerName}`, `📞 ${dial(ordererPhone)}`, '']
      : []),
    `*Deliver to:* ${receiverName}`,
    ...(order.address ? [order.address] : []),
    // What the customer said about finding the door. It was going to staff
    // and not to the person standing outside, which is the wrong way round.
    ...(order.deliveryNote ? [order.deliveryNote] : []),
    atTheDoor,
    ...(pinIsForThisDoor && order.location
      ? [
          ...(labelAdds ? [pinLabel] : []),
          'Click the link below for the delivery address:',
          mapsLink(order.location),
          ...(() => {
            const range = checkRange(order.location, config.store.serviceArea);
            return range.state === 'outside'
              ? [`⚠️ ${formatDistance(range.distanceKm)} away, OUTSIDE the ${range.radiusKm} km delivery area`]
              : [];
          })(),
        ]
      : []),
    '',
    // What it is made of, so the cash can be checked against the bag rather
    // than taken on trust at the door - and WHO hands it over, because
    // "collect $235,000" with two names on the screen is the same confusion
    // in a more expensive form.
    order.total > 0
      ? `*Collect ${money(order.total)} cash* from ${toSomebodyElse || isParcel ? receiverName : 'the customer'}` +
        (isParcel
          ? ''
          : ` (${order.items.length} item${order.items.length === 1 ? '' : 's'} + delivery)`)
      : '*Fee not set* - the shop will confirm it, do not quote one',
  ];
}

/**
 * What an associate gets when they say they have the food.
 *
 * One line and a button. Everything needed on the doorstep - the address, the
 * link, the door description, the phone, the cash - is on the job card they
 * accepted, and repeating it here only buries that card further up the chat.
 */
export function onTheWayCard(order: repo.OrderRecord): string {
  const head = `🛵 *${order.orderNo}* on the way`;
  // No pin: the one fact worth repeating here, because it is the difference
  // between navigating and telephoning.
  const noPin = order.location
    ? ''
    : `${String.fromCharCode(10)}⚠️ No pin — ring +${order.contactPhone || order.phone}`;
  if (!repo.deliveryCodeExpected(order.orderNo)) return head + noPin;

  // The instruction replaces the button, so it has to carry its own weight:
  // what to do, and what to do when the customer cannot do it. This is the
  // last message in their chat and the one they come back to at the door.
  return [
    head + noPin,
    '',
    `🔐 Type the four-digit code from ${order.customerName.split(/\s+/)[0] || 'the customer'} to close it.`,
    'No code? Reply *no code*.',
  ].join(String.fromCharCode(10));
}

/**
 * Offers an associate the oldest job still waiting, if they can take it.
 *
 * The other half of the one-at-a-time rule. Holding somebody to one delivery
 * means a job can be cooked with nobody free to fetch it - and nothing used to
 * re-offer it, so the order sat at `ready` until an associate happened to send
 * `jobs`. Food on a counter does not keep.
 *
 * Called at the only two moments capacity appears: when an associate finishes a
 * delivery, and when one clocks on.
 */
export async function offerWaitingWork(phone: string): Promise<string> {
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits || !config.driverNumbers.includes(digits)) return '';

  const limit = config.maxJobsPerAssociate;
  if (limit > 0 && repo.activeJobsFor(digits).length >= limit) return '';
  // Somebody who has clocked off, or been stopped by the day's hours cap, is
  // not offered more work however much is waiting.
  if (!repo.isOnDuty(digits)) return '';

  const waiting = repo.ordersAwaitingPickup(1)[0];
  if (!waiting) return '';

  const how = await dispatchToDrivers(waiting.orderNo, digits);
  return how === 'sent' ? waiting.orderNo : '';
}

/**
 * The delivery associate's job card: where to collect, where to go, who to ring, what to collect.
 *
 * This is the message that has to be complete, because a delivery associate reading it is
 * on a bike and will not scroll back through a conversation. Both ends get a
 * tappable maps link, and both pins follow as map cards.
 */
export type Dispatch = 'sent' | 'no_drivers' | 'all_busy';

export async function dispatchToDrivers(
  orderNo: string,
  /** One associate to offer it to, rather than everybody who is free. */
  only = '',
): Promise<Dispatch> {
  const order = repo.findOrder(orderNo);
  if (!order) return 'no_drivers';

  if (config.driverNumbers.length === 0) {
    console.warn(`[dispatch] ${orderNo} is ready but DRIVER_NUMBERS is empty — no delivery associate was told`);
    return 'no_drivers';
  }

  const pickup = order.pickup;
  const pickupPin =
    pickup && pickup.latitude !== null && pickup.longitude !== null
      ? { latitude: pickup.latitude, longitude: pickup.longitude }
      : null;

  // A parcel goes to its recipient, not to the person who sent it - which
  // dropLines handles. All this needs it for is the sender's number on the
  // uplift half, since a parcel is fetched from a person rather than a shop.
  const isParcel = order.kind === 'parcel';

  const body = [
    // Just the order number. The card already says *Uplift from:* with the
    // address under it, so a verb in the heading repeats what the next line
    // says and stops being true the moment the food is in the bag.
    isParcel ? `📦 *Parcel ${order.orderNo}*` : `🛵 *${order.orderNo}*`,
    '',
    ...(pickup
      ? [
          `*Uplift from:* ${order.outlet?.name ?? order.customerName}`,
          ...(pickup.address ? [pickup.address] : []),
          // Announced, like the one on the delivery card. A bare URL in a
          // message reads as something to ignore unless it says what it opens.
          ...(pickupPin ? ['Click the link below for the uplift address:', mapsLink(pickupPin)] : []),
          ...(isParcel ? [`📞 sender +${order.contactPhone || order.phone}`] : []),
          '',
        ]
      : ['*Uplift from:* the shop', '']),
    ...itemLines(order),
    '',
    ...dropLines(order),
  ].join('\n');

  const actions = nextActions(order.orderNo, 'ready', 'driver');

  // Somebody already carrying a delivery is not offered another. Sending it
  // anyway means a card they cannot act on, and a tap that gets refused.
  const limit = config.maxJobsPerAssociate;
  const pool = only
    ? config.driverNumbers.filter((phone) => phone === only.replace(/[^0-9]/g, ''))
    : config.driverNumbers;
  const free = limit > 0 ? pool.filter((phone) => repo.activeJobsFor(phone).length < limit) : pool;

  // Everybody is out. Its own outcome rather than folded into 'no_drivers',
  // because the two are nothing alike: an empty DRIVER_NUMBERS is a shop that
  // cannot deliver at all and somebody must fix it, while everyone being busy
  // is an ordinary queue. Told they are the same thing, a kitchen rings a shop
  // that can do nothing about it, at the busiest moment of their day.
  //
  // Unlike the two filters below, this one does NOT fall back to everybody -
  // the point of it is to avoid offering a job that would be refused. Which is
  // exactly why the order has to be re-offered when somebody finishes, and
  // `offerWaitingWork` above is that half of the rule. Without it this filter
  // silently strands the order.
  if (free.length === 0) {
    console.warn(
      `[dispatch] ${orderNo} is ready but every delivery associate is already carrying one`,
    );
    return 'all_busy';
  }

  const nearby = withinReach(onDuty(free), pickupPin);
  if (nearby.length === 0) return 'all_busy';

  for (const associate of nearby) {
    await sendButtons(associate, body, actions);

    // No map cards. The addresses travel as links in the card itself, which
    // is one message instead of three and keeps everything about the job in
    // the place they will come back to. A link also opens in whatever maps
    // app they actually navigate with, where a WhatsApp map card opens
    // WhatsApp's own.
  }

  return 'sent';
}

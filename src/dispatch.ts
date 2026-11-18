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
import { acceptButton, nextActions, wantedBy } from './order-status.ts';
import { summariseStored } from './menu-options.ts';
import {
  checkRange,
  describePin,
  mapsLink,
  distanceKm,
  formatDistance,
  saysTheSamePlace,
} from './location.ts';
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
  // A grocery needs calling off exactly as much as a kitchen does — somebody
  // is filling a bag — so this runs for both, and only the noun changes.
  const who = outlet?.kind === 'grocery' ? 'Shop' : 'Kitchen';
  if (!outlet?.whatsapp) return `⚠️ ${who} has no WhatsApp number — ring them to stop the order.`;

  const reason = order.cancelReason ? ` — ${order.cancelReason}` : '';
  // A shop that never accepted the ticket has not started, and telling it to
  // "stop" invites a worried phone call about work it never did.
  const what = hadAccepted
    ? 'Stop preparing it if you have started.'
    : 'Do not start it — ignore the ticket.';
  try {
    await sendText(outlet.whatsapp, `🚫 *${order.orderNo} cancelled*${reason}.

${what}`);
    return `${who} told to stop.`;
  } catch (err) {
    console.error('[dispatch] could not tell the shop about a cancellation:', err);
    return `⚠️ Could not tell the ${who.toLowerCase()} — ring them.`;
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

  const told = order.driverPhone ? [order.driverPhone] : repo.associateNumbers();
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
/**
 * A parcel offered to everyone who could take it.
 *
 * Short on purpose. This is a job somebody is deciding whether to accept, not
 * one they are driving to - the addresses, the numbers and the cash all arrive
 * on the uplift card once it is theirs. Everything shown here is something
 * that bears on the decision: how far, how much, and what it is.
 */
export async function offerParcel(orderNo: string, only = ''): Promise<Dispatch> {
  const order = repo.findOrder(orderNo);
  if (!order || order.kind !== 'parcel') return 'no_drivers';

  // The directory, not the environment variable. A shop that has taken
  // somebody off the road sets `active = 0` and they stop being offered work;
  // a shop that has taken somebody on adds them, and they start.
  const associates = repo.associateNumbers();
  if (associates.length === 0) {
    console.warn(`[dispatch] ${orderNo} booked but there are no active delivery associates — nobody was offered it`);
    return 'no_drivers';
  }

  const limit = config.maxJobsPerAssociate;
  const pool = only
    ? associates.filter((phone) => phone === only.replace(/[^0-9]/g, ''))
    : associates;
  const free =
    limit > 0 ? pool.filter((phone) => repo.activeJobsFor(phone).length < limit) : pool;
  if (free.length === 0) return 'all_busy';

  const pickup = order.pickup;
  const pickupPin =
    pickup && pickup.latitude !== null && pickup.longitude !== null
      ? { latitude: pickup.latitude, longitude: pickup.longitude }
      : null;
  const nearby = withinReach(onDuty(free), pickupPin);
  if (nearby.length === 0) return 'all_busy';

  for (const associate of nearby) {
    await sendButtons(associate, parcelOfferCard(order), [acceptButton(order.orderNo)]);
  }
  return 'sent';
}

/**
 * The offer itself, built apart from the sending so it can be read.
 *
 * Short on purpose: this is a job somebody is deciding whether to accept, not
 * one they are driving to. The addresses, the numbers and the cash arrive on
 * the uplift card once it is theirs.
 */
export function parcelOfferCard(order: repo.OrderRecord): string {
  const pickup = order.pickup;
  const pickupPin =
    pickup && pickup.latitude !== null && pickup.longitude !== null
      ? { latitude: pickup.latitude, longitude: pickup.longitude }
      : null;
  const trip =
    pickupPin && order.location
      ? `${formatDistance(distanceKm(pickupPin, order.location))} across town`
      : '';

  return [
    `📦 *New parcel job ${order.orderNo}*`,
    ...(order.total > 0
      ? [`*${money(order.total)}*, collected from the sender`]
      : ['*Fee not set* — agree it with the sender at the pickup']),
    '',
    `📦 ${order.parcelDetails || 'Contents not described'}`,
    '',
    `*Uplift from:* ${order.customerName}${pickup?.address ? `, ${pickup.address}` : ''}`,
    // The same words as every other card for this job. An associate reading
    // four messages about one parcel should not have to work out that "Take
    // to" and "Deliver to" mean the same thing.
    `*Deliver to:* ${order.recipientName}${order.address ? `, ${order.address}` : ''}`,
    ...(trip ? ['', trip] : []),
  ].join(String.fromCharCode(10));
}

export async function announceNewOrder(orderNo: string): Promise<void> {
  await notifyStaffOfNewOrder(orderNo);
  // One call for every shop. A grocery used to need a second route of its own,
  // because it was not an outlet and had nowhere for a ticket to go; it is one
  // now, so a kitchen and a grocery are told the same way.
  const outcome = await notifyOutletOfOrder(orderNo);
  if (outcome === 'no_number') {
    console.warn(`[dispatch] ${orderNo} needs preparing but the shop cannot be reached`);
  }
  if (outcome === 'nudged') {
    console.log(`[dispatch] ${orderNo}: shop nudged by template, ticket held until they reply`);
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

/**
 * The picking ticket for a grocery order.
 *
 * The counterpart to the kitchen ticket above, and missing until now: a
 * restaurant order reaches the people who make it, a grocery order reached
 * only the staff broadcast — which is a dispatch alert carrying an address, a
 * telephone number and a map pin. None of that helps somebody filling a bag
 * off a shelf, and all of it has to be read past to find the list.
 *
 * So: what to pick, what it comes to, when it was ordered. No address, no
 * customer number, no map. Not for the kitchen ticket's reason — the shop
 * already knows its own customers — but because a picking list with a
 * doorstep in it is a picking list somebody has to read twice.
 *
 * Restaurant orders are left alone: those are not the shop's to pack.
 */
export function pickingTicket(order: repo.OrderRecord): string {
  const goods = order.items.reduce((sum, i) => sum + i.lineTotal, 0);
  return [
    `🛒 *Order ${order.orderNo}* — please pick`,
    '',
    ...itemLines(order),
    '',
    // What the goods come to, not the order total. The delivery fee is not
    // theirs to collect and not theirs to be asked about.
    `Goods total ${money(goods)}`,
    ...(wantedBy(order) ? [wantedBy(order)] : []),
    `Ordered ${new Date(order.placedAt).toLocaleTimeString('en-GB', {
      timeZone: config.store.timezone,
      hour: 'numeric',
      minute: '2-digit',
    })}`,
  ].join(String.fromCharCode(10));
}

/* `notifyGroceryOfOrder` stood here.
 *
 * It existed because a grocery had no record and therefore nowhere for a
 * ticket to be addressed: the number came from GROCERY_NUMBER, the 24-hour
 * window had to be checked separately, and there was no template to fall back
 * on. A grocery is an outlet now, so `notifyOutletOfOrder` does all of that,
 * including the window and the nudge. The ticket it wrote survives as
 * `pickingTicket` above, which is the part that was worth keeping.
 */

export async function notifyOutletOfOrder(orderNo: string): Promise<TicketOutcome> {
  const order = repo.findOrder(orderNo);
  if (!order?.outlet) return 'not_a_restaurant';

  const outlet = repo.outletById(order.outlet.id);
  if (!outlet?.whatsapp) {
    console.warn(`[dispatch] ${orderNo} is for ${order.outlet.name}, which has no WhatsApp number`);
    return 'no_number';
  }

  const packing = outlet.kind === 'grocery';

  // The 24-hour window. A ticket is a plain message with buttons, and Meta
  // refuses those outside it — silently, as far as the kitchen is concerned.
  // Sending anyway is how an order sits at pending with nobody wondering why.
  if (!repo.serviceWindowOpen(outlet.whatsapp)) {
    return nudgeOutlet(order, outlet.whatsapp);
  }

  // Two shapes, one send path.
  //
  // A kitchen is told to cook; a grocery is told to pick. The picking list is
  // the better message for somebody at a shelf — items, goods total, and
  // nothing about where it is going — and it was already written for the old
  // GROCERY_NUMBER route, so this chooses between the two rather than making a
  // grocery read a ticket that tells it to start cooking.
  //
  // Neither is shown the delivery fee. It is not theirs to collect, and
  // showing it invites an argument about the split.
  const body = packing
    ? [
        pickingTicket(order),
        '',
        `Tap *Confirm* to accept, then *${order.orderNo} ready* when the bag is packed and a delivery associate will come.`,
      ].join('\n')
    : [
        `👨‍🍳 *Order ${order.orderNo}* — please prepare`,
        '',
        ...itemLines(order),
        '',
        `Food total ${money(order.items.reduce((sum, i) => sum + i.lineTotal, 0))}`,
        ...(wantedBy(order) ? [wantedBy(order)] : []),
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
/**
 * A number with no country code is a local one.
 *
 * Printing it with a `+` says it is international, which it is not, and an
 * associate copying that into a dialler gets nowhere.
 */
function dial(n: string): string {
  return n.replace(/[^0-9]/g, '').length >= 10 ? `+${n}` : n;
}

/** The same telephone number, written two different ways. */
function sameNumber(a: string, b: string): boolean {
  const x = a.replace(/[^0-9]/g, '');
  const y = b.replace(/[^0-9]/g, '');
  // Seven digits is the shortest a Guyanese number goes. Below that this is
  // comparing house numbers, and every address would match something.
  if (x.length < 7 || y.length < 7) return false;
  // One may carry a country code the other leaves off.
  return x.endsWith(y) || y.endsWith(x);
}

/**
 * An address with the telephone number taken back out of it.
 *
 * The card prints the number on its own line directly beneath the address, so
 * one written into the address as well is the same number twice - which on a
 * card read at a gate reads as two numbers, and invites somebody to try the
 * wrong one.
 *
 * Only a run that IS the number is removed, never a house or lot number:
 * matched on at least seven digits, against the very number about to be
 * printed. "Lot 677" survives; "ring 677 1234" does not.
 */
export function withoutPhone(address: string, phone: string): string {
  if (!address || !phone) return address;
  return address
    .replace(/[+(]?\d[\d\s().-]{5,}\d/g, (run) => (sameNumber(run, phone) ? '' : run))
    // Whatever introduced it - "ring", "call", "tel" - and the punctuation
    // around the hole it left.
    .replace(/\b(ring|call|tel|phone|contact|mobile|cell)\b[\s:,.-]*(?=[,;]|$)/gi, '')
    .replace(/\s*[,;:–—-]\s*(?=[,;]|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
}

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
  const atTheDoor = toSomebodyElse
    ? sameNumber
      ? `📞 no number for ${receiverName.split(/\s+/)[0] || 'them'} — ring ${order.customerName} above`
      : `📞 ${dial(receiverPhone)} — ring at the door`
    : `📞 ${dial(receiverPhone)}`;

  // The pin's own label, which WhatsApp attaches to a shared location. Shown
  // only when it says something the two lines above do not: more often than
  // not it is the same text as the address, printed twice.
  //
  // The test lives in location.ts, because the same question is asked of the
  // doorstep note below and of the note before it is ever stored.
  const pinLabel = order.location?.label ?? '';
  const labelAdds =
    pinLabel !== '' &&
    !saysTheSamePlace(order.address, pinLabel) &&
    !saysTheSamePlace(order.deliveryNote, pinLabel);

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

  // One way to the door, not two.
  //
  // A written address and a map link were both printed, and an associate
  // reading a card had to decide which to believe. They are not the same
  // claim: the address is what the customer typed, the pin is where they
  // happened to be standing, and when they disagree the card says so without
  // saying which is right.
  //
  // So the address wins where there is one, because it is what the customer
  // meant to say, and the link appears only when there is nothing written to
  // go on. That is the shop's rule, and this is the one place it has to hold:
  // the card somebody drives from.
  const written = withoutPhone(order.address, receiverPhone);
  const showPin = pinIsForThisDoor && order.location !== null && !written;

  // The note earns its line by adding something the address does not.
  //
  // Order 93's card read "26 Brickdam, Georgetown", and then, on the next
  // line, "26 Brickdam, Georgetown". The schema for `delivery_note` forbids
  // repeating the address in as many words - but a prompt is a request, not a
  // guard, and when the single line a customer types is both their address
  // and their only landmark, the model has no reason to put it in one slot
  // rather than both.
  //
  // Checked against what is actually printed above rather than the stored
  // address, since the phone number is stripped out of that line; and only
  // when something IS printed above, because with no address line the note is
  // everything the associate has to go on.
  const noteAdds = order.deliveryNote !== '' && !saysTheSamePlace(written, order.deliveryNote);

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
    ...(wantedBy(order) ? [wantedBy(order), ''] : []),
    `*Deliver to:* ${receiverName}`,
    ...(written ? [written] : []),
    // What the customer said about finding the door. It was going to staff
    // and not to the person standing outside, which is the wrong way round.
    ...(noteAdds ? [order.deliveryNote] : []),
    atTheDoor,
    ...(showPin && order.location
      ? [...(labelAdds ? [pinLabel] : []), 'Click the link below for the delivery address:', mapsLink(order.location)]
      : []),
    // Outside the delivery area, said whether or not the link is shown.
    //
    // It is not navigation, so it does not belong to the link: it is the one
    // fact on the card that changes whether the trip should be made at all.
    // Suppressing the pin in favour of a written address must not take this
    // with it — an associate riding thirty kilometres and finding out there is
    // the worst version of this card.
    ...(() => {
      if (!pinIsForThisDoor || !order.location) return [];
      const range = checkRange(order.location, config.store.serviceArea);
      return range.state === 'outside'
        ? [`⚠️ ${formatDistance(range.distanceKm)} away, OUTSIDE the ${range.radiusKm} km delivery area`]
        : [];
    })(),
    '',
    // What it is made of, so the cash can be checked against the bag rather
    // than taken on trust at the door - and WHO hands it over, because
    // "collect $235,000" with two names on the screen is the same confusion
    // in a more expensive form.
    // A parcel was paid for at the pickup, by the person who sent it. Asking
    // the recipient for the same money again is how somebody pays twice for
    // one journey - and the person at the door never agreed to pay at all.
    ...(isParcel
      ? ['Nothing to collect — the sender paid at the uplift.']
      : order.total > 0
        ? [
            `*Collect ${money(order.total)} cash* from ${toSomebodyElse ? receiverName : 'the customer'}`,
            // The figure broken down, because the associate is the one asked
            // to justify it. "Two items plus delivery" was a description of
            // the receipt rather than the receipt: somebody at a gate saying
            // "why is it four thousand four hundred and eighty" got an
            // answer that did not add up to anything.
            //
            // The split, not the item prices. The customer's own receipt
            // itemises it afterwards, and a card held in one hand at a gate
            // should answer the question actually asked - what is the
            // delivery costing me - in one line.
            order.deliveryFee > 0
              ? `${money(order.subtotal)} ${order.kind === 'restaurant' ? 'food' : 'goods'} + ${money(order.deliveryFee)} delivery`
              : `${money(order.subtotal)} ${order.kind === 'restaurant' ? 'food' : 'goods'}, delivery free`,
          ]
        : ['*Fee not set* - agree it with the sender at the pickup']),
  ];
}

/**
 * What an associate gets when they say they have the food.
 *
 * One line and a button. Everything needed on the doorstep - the address, the
 * link, the door description, the phone, the cash - is on the job card they
 * accepted, and repeating it here only buries that card further up the chat.
 */
/**
 * What an associate gets the moment a parcel becomes theirs.
 *
 * Where to go, who to find, and - the line that matters - how much to take
 * from the sender. A parcel is paid at the pickup, by the person sending it,
 * which is the opposite end of the journey from a food order and the one fact
 * an associate used to a restaurant round will not assume.
 */
export function parcelUpliftCard(order: repo.OrderRecord): string {
  const pickup = order.pickup;
  const pin =
    pickup && pickup.latitude !== null && pickup.longitude !== null
      ? { latitude: pickup.latitude, longitude: pickup.longitude }
      : null;

  return [
    `📦 *${order.orderNo}* is yours.`,
    '',
    `*Uplift from:* ${order.customerName}`,
    ...(() => {
      const written = withoutPhone(pickup?.address ?? '', order.contactPhone || order.phone);
      return written ? [written] : [];
    })(),
    // The sender's own number, asked for when the job was booked and carried
    // on the order rather than on the customer.
    //
    // Not the number they are messaging from: whoever books a parcel is not
    // necessarily the sender. An office arranges a courier, a daughter sends
    // something from her mother's house. `contact_phone` is safe to read here
    // because a parcel now fills it from that booking and never from the
    // customer record, where a past delivery's number used to leak in.
    `📞 ${dial(order.contactPhone || order.phone)}`,
    ...(pin ? ['Click the link below for the uplift address:', mapsLink(pin)] : ['⚠️ No pin for the pickup — ring them']),
    '',
    `📦 ${order.parcelDetails || 'Contents not described'}`,
    '',
    order.total > 0
      ? `*Collect ${money(order.total)} cash from ${order.customerName} when you take it.*`
      : '*Fee not set* — agree it with the sender at the pickup.',
  ].join(String.fromCharCode(10));
}

export function onTheWayCard(
  order: repo.OrderRecord,
  /**
   * False when the drop block follows in the same message, since that block
   * carries its own NO PIN banner - and the same warning twice in one message
   * is read as two problems.
   */
  warnAboutPin = true,
): string {
  const head = `🛵 *${order.orderNo}* on the way`;
  // No pin: the one fact worth repeating here, because it is the difference
  // between navigating and telephoning.
  const noPin =
    order.location || !warnAboutPin
      ? ''
      : `${String.fromCharCode(10)}⚠️ No pin — ring ${dial(order.contactPhone || order.phone)}`;
  if (!repo.deliveryCodeExpected(order.orderNo)) return head + noPin;

  // The instruction replaces the button, so it has to carry its own weight:
  // what to do, and what to do when the customer cannot do it. This is the
  // last message in their chat and the one they come back to at the door.
  return [
    head + noPin,
    '',
    `🔐 Type the four-digit code from ${(order.recipientName || order.customerName).split(/\s+/)[0] || 'the customer'} to close it.`,
    order.kind === 'parcel'
      ? 'Wrong code, or nobody there? Reply *nobody there* and bring it back.'
      : 'No code? Reply *no code*.',
  ].join(String.fromCharCode(10));
}

/**
 * Tells both associates a job has changed hands.
 *
 * The one taking it gets the whole job, not a notice about it: they are about
 * to drive somewhere, and the card they were handed was sent to somebody
 * else's phone.
 */
export async function tellTransferred(
  orderNo: string,
  from: string,
  to: string,
): Promise<boolean> {
  const order = repo.findOrder(orderNo);
  if (!order) return false;

  const giver = repo.getAssociate(from.replace(/[^0-9]/g, ''));
  const head = `🤝 *${order.orderNo}* has been handed to you by ${giver?.name || 'another delivery associate'}.`;

  const body = [
    head,
    '',
    ...dropLines(order),
    ...(repo.deliveryCodeExpected(order.orderNo)
      ? [
          '',
          `🔐 Type the four-digit code from ${(order.recipientName || order.customerName).split(/\s+/)[0] || 'the customer'} to close it.`,
          order.kind === 'parcel'
            ? 'Wrong code, or nobody there? Reply *nobody there* and bring it back.'
            : 'No code? Reply *no code*.',
        ]
      : []),
  ].join(String.fromCharCode(10));

  const actions = nextActions(order.orderNo, order.status, 'driver', {
    codeExpected: repo.deliveryCodeExpected(order.orderNo),
    parcel: order.kind === 'parcel',
  });

  return actions.length > 0
    ? sendButtons(to, body, actions)
    : sendText(to, body);
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
  if (!digits || !repo.isActiveAssociate(digits)) return '';

  const limit = config.maxJobsPerAssociate;
  if (limit > 0 && repo.activeJobsFor(digits).length >= limit) return '';
  // Somebody who has clocked off, or been stopped by the day's hours cap, is
  // not offered more work however much is waiting.
  if (!repo.isOnDuty(digits)) return '';

  const waiting = repo.ordersAwaitingPickup(1)[0];
  if (!waiting) return '';

  // A parcel is offered, not dispatched: it has its own short card with an
  // Accept button, because the associate is deciding whether to take it
  // rather than driving to something already theirs.
  const how =
    waiting.kind === 'parcel'
      ? await offerParcel(waiting.orderNo, digits)
      : await dispatchToDrivers(waiting.orderNo, digits);
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

  const associates = repo.associateNumbers();
  if (associates.length === 0) {
    console.warn(`[dispatch] ${orderNo} is ready but there are no active delivery associates — nobody was told`);
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
    ? associates.filter((phone) => phone === only.replace(/[^0-9]/g, ''))
    : associates;
  const free = limit > 0 ? pool.filter((phone) => repo.activeJobsFor(phone).length < limit) : pool;

  // Everybody is out. Its own outcome rather than folded into 'no_drivers',
  // because the two are nothing alike: an empty directory is a shop that
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

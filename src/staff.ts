/**
 * Staff commands over the same WhatsApp number.
 *
 * Deliberately parsed rather than run through the model: a dispatcher moving
 * twenty orders wants the same words to do the same thing every time, instantly
 * and at no cost per message. Conversation is the wrong tool for a work queue.
 */
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { notifyCustomerOfStatus, warnStaff } from './notifications.ts';
import { sendText } from './channels/whatsapp-send.ts';
import {
  STATUS_LABEL,
  STATUS_WORDS,
  cancelButtons,
  findCancelReason,
  isBackwards,
  nextActions,
  type Audience,
} from './order-status.ts';
import {
  dispatchToDrivers,
  flushOutletTickets,
  tellAssociatesCancelled,
  tellKitchenCancelled,
} from './dispatch.ts';
import { summariseStored } from './menu-options.ts';
import { mapsLink, type LocationPin } from './location.ts';
const chr10 = String.fromCharCode(10);
import {
  handleMenuPhoto,
  handleOnboardingCommand,
  handleStaffPin,
  isOnboardingCommand,
  ONBOARDING_HELP,
} from './onboarding.ts';
import type { IncomingImage } from './channels/types.ts';
import { checkRange, describePin } from './location.ts';
import type { OutboundMessage } from './channels/types.ts';

export const isStaff = (phone: string): boolean => config.staffNumbers.includes(phone);
export const isDriver = (phone: string): boolean => config.driverNumbers.includes(phone);

/**
 * Moves an order and sets off everything that follows.
 *
 * One path for all three actors, because the consequences of a status belong to
 * the status and not to whoever tapped it. "Food ready" has to send a delivery associate
 * whether a cook, a dispatcher or the shop owner pressed it — and if that lived
 * in each handler, one of them would eventually forget.
 */
async function applyStatus(
  order: repo.OrderRecord,
  status: repo.OrderStatus,
  reportedBy: 'staff' | 'outlet' | 'driver' = 'staff',
): Promise<{ body: string; status: repo.OrderStatus }> {
  // Delivered and cancelled are the end. The buttons on an old message do not
  // disappear when an order moves on, so a cook tapping "Confirm" twenty
  // minutes after a cancellation would otherwise revive it and start cooking
  // something nobody wants.
  if (order.status === 'cancelled' || order.status === 'delivered') {
    return {
      body: `${order.orderNo} is already *${STATUS_LABEL[order.status]}* and cannot be changed.${
        order.status === 'cancelled' ? ' Do not cook it.' : ''
      }`,
      status: order.status,
    };
  }

  // Forward, or cancelled. Never back.
  //
  // Checked here rather than in each handler because every actor reaches
  // this function, and the buttons that make it reachable never expire: the
  // first message about an order still offers Confirm a week later.
  if (isBackwards(order.status, status)) {
    return {
      body:
        `${order.orderNo} is already *${STATUS_LABEL[order.status]}* - it cannot go back to ` +
        `*${STATUS_LABEL[status]}*. Cancel it if something is wrong.`,
      status: order.status,
    };
  }

  repo.setOrderStatus(order.orderNo, status);
  const updated = { ...order, status };

  const notes: string[] = [];

  // The moment the food exists, a delivery associate is sent — and only now, or they stand
  // in the restaurant watching a fryer. A parcel has nothing to cook, so
  // accepting the job is itself the moment it is ready to collect.
  const dispatchNow = status === 'ready' || (status === 'confirmed' && order.kind === 'parcel');
  if (dispatchNow) {
    try {
      const how = await dispatchToDrivers(order.orderNo);
      notes.push(
        how === 'sent'
          ? '🛵 Delivery associate dispatched to uplift.'
          : '⚠️ No delivery associate was told — DRIVER_NUMBERS is empty.',
      );
    } catch (err) {
      console.error('[staff] failed to dispatch a delivery associate:', err);
      notes.push('⚠️ Status saved, but dispatching a delivery associate failed.');
    }
  }

  // 'ready' is on purpose not told to the customer: from their side, food on a
  // counter waiting for a delivery associate is indistinguishable from food still cooking,
  // and a message about it only invites "so where is it?". Reported as a
  // decision rather than as a failed send, or the operator chases a bug.
  // A cancellation has to reach whoever else was working on it. A kitchen that
  // keeps cooking an order the shop cancelled is wasted food and wasted money.
  if (status === 'cancelled' && order.outlet) {
    const told = await tellKitchenCancelled(order.orderNo, order.status !== 'pending');
    if (told) notes.push(told);
  }

  // Anyone already sent to fetch it. A job card only goes out once the food is
  // cooked, so before 'ready' there is nobody on the road to call back - and
  // after it, an associate who is not told rides to a kitchen with nothing for
  // them.
  if (status === 'cancelled' && ['ready', 'on_the_way'].includes(order.status)) {
    try {
      const reached = await tellAssociatesCancelled(order.orderNo);
      notes.push(
        reached > 0
          ? `Delivery associate called off (${reached}).`
          : '⚠️ Nobody was called off - no delivery associate could be reached.',
      );
    } catch (err) {
      console.error('[staff] failed to call off an associate:', err);
      notes.push('⚠️ Status saved, but calling off the delivery associate failed.');
    }
  }

  if (status === 'ready') {
    notes.push('Customer not told — nothing has changed for them until it moves.');
  } else {
    try {
      const how = await notifyCustomerOfStatus(updated, status);
      notes.push(
        how === 'skipped'
          ? '⚠️ Customer NOT notified — outside the 24h window and no template set up.'
          : `Customer notified${how === 'template' ? ' (via template)' : ''}.`,
      );
    } catch (err) {
      console.error('[staff] failed to notify customer:', err);
      notes.push('⚠️ Status saved, but notifying the customer failed.');
    }
  }

  // A collection reported by the kitchen is news to the shop. Staff did not
  // do it and the associate has not said anything yet, so without this the
  // only people who know the food has left are the cook and the customer.
  //
  // Not sent when staff moved it themselves: telling somebody what they just
  // did is the noise that makes people stop reading alerts.
  if (status === 'on_the_way' && reportedBy === 'outlet') {
    const who = order.outlet?.name ?? 'The kitchen';
    const associate = order.driverPhone ? `+${order.driverPhone}` : 'not recorded yet';
    await warnStaff(
      [
        `*${order.orderNo}* uplifted from *${who}*.`,
        '',
        'Reported by the kitchen, not by the associate.',
        `Delivery associate: ${associate}.`,
        'The customer has been told it is on the way.',
      ].join(String.fromCharCode(10)),
    );
    notes.push('Shop told.');
  }

  return { body: `${order.orderNo} → *${STATUS_LABEL[status]}*.\n${notes.join('\n')}`, status };
}

const HELP = [
  '*Staff commands*',
  '',
  '`orders` — list open orders',
  '`7 confirmed` — accept order 7',
  '`ORD-00007 ready` — food is up, a delivery associate is sent',
  '`7 on the way` — dispatch, customer is told',
  '`7 delivered` — close it, customer is told',
  '`7 cancel` — cancel it',
  '`7` — show one order',
  '',
  '`wanted` — what customers asked for and we did not have',
  '',
  '`outlets` — the restaurants on the system',
  'Send a photo of a menu to add one (`new outlet` for how)',
  '',
  'Order numbers work as `7`, `ORD-7` or `ORD-00007`.',
].join('\n');

/**
 * The unmet-demand report.
 *
 * The one thing a shop cannot read off its own till roll: what people came in
 * for and left without. Ranked by how many different people asked, because that
 * is the number that justifies buying stock — one person asking six times is a
 * search problem, six people asking once each is a shelf.
 */
function demandReport(days: number): string {
  const misses = repo.topSearchMisses(days, 15);
  const window = days === 1 ? 'today' : `the last ${days} days`;

  if (misses.length === 0) {
    return `Nothing came up empty in ${window}. Either the catalogue is covering it or nobody has asked.`;
  }

  const lines = misses.map((m) => {
    const who = m.people === 1 ? '1 person' : `${m.people} people`;
    const repeats = m.times > m.people ? `, ${m.times} times` : '';
    return `• *${m.example}* — ${who}${repeats}`;
  });

  return [
    `*Asked for, not in stock* — ${window}`,
    '',
    ...lines,
    '',
    `${repo.searchMissCount(days)} empty search(es) in total.`,
    'Ranked by how many different people asked.',
  ].join('\n');
}

const describe = (o: repo.OrderRecord): string =>
  [
    `*${o.orderNo}* — ${STATUS_LABEL[o.status]}`,
    ...o.items.map((i) => `${i.qty} x ${i.name}`),
    `Total ${money(o.total)}`,
    [o.customerName, o.address].filter(Boolean).join(', '),
    `📞 +${o.contactPhone || o.phone}`,
    // The maps link rather than coordinates: a dispatcher reading a queue of
    // ten orders needs something tappable, not two numbers to copy out. The
    // distance comes with it, which is what decides what the delivery associate takes next.
    o.location
      ? describePin(o.location, checkRange(o.location, config.store.serviceArea))
      : '⚠️ no location pin',
    ...(o.deliveryNote ? [`Note: ${o.deliveryNote}`] : []),
  ].join('\n');


/**
 * Turns "cancel" into a reason before anything is cancelled.
 *
 * A bare cancel is answered with buttons rather than acted on: the reason is
 * the whole value of the record, and it cannot be recovered afterwards by
 * asking somebody what they were thinking an hour ago. A reason given in the
 * same message — tapped or typed — goes straight through.
 *
 * Returns the buttons to send back, or null when there is a reason to act on.
 */
function askWhyCancelled(
  order: repo.OrderRecord,
  text: string,
  audience: Audience,
): OutboundMessage[] | null {
  if (findCancelReason(text)) return null;

  // A typed reason the list does not know: "7 cancel the goat spoil".
  const freeText = text.replace(/(?:ord[-\s]?)?0*\d{1,6}/i, '').replace(/\bcancel(led)?\b/i, '').trim();
  if (freeText.length >= 4) return null;

  return [
    {
      kind: 'buttons',
      text: `Why is ${order.orderNo} being cancelled?

Tap one, or type the reason — the customer is told what it was.`,
      buttons: cancelButtons(order.orderNo, audience),
    },
  ];
}

/** The reason as it will be recorded, from a tap or from typed words. */
function cancellationReason(order: repo.OrderRecord, text: string): string {
  const known = findCancelReason(text);
  if (known) return known.internal;
  return (
    text
      .replace(/(?:ord[-\s]?)?0*\d{1,6}/i, '')
      .replace(/\bcancel(led)?\b/i, '')
      .trim()
      .slice(0, 200) || 'No reason given'
  );
}

/** Never throws — a staff member always gets a readable answer. */
export async function handleStaffMessage(
  text: string,
  phone = '',
  image?: IncomingImage,
  location?: LocationPin,
): Promise<OutboundMessage[]> {
  const reply = (t: string): OutboundMessage[] => [{ kind: 'text', text: t }];
  const trimmed = text.trim();

  // A photograph from a staff member is a menu being onboarded. Nothing else in
  // the dispatch queue takes a picture, so there is no ambiguity to resolve.
  if (image) return handleMenuPhoto(phone, image);

  // A pin from a staff member is where a delivery associate collects — they are standing
  // outside the restaurant, which is the whole reason this happens on a phone.
  if (location) return handleStaffPin(phone, location);

  if (/^(help|\?|commands)$/i.test(trimmed)) return reply(HELP);

  if (isOnboardingCommand(trimmed)) return handleOnboardingCommand(phone, trimmed);

  if (/^outlets$/i.test(trimmed)) {
    const outlets = repo.listOutlets();
    if (outlets.length === 0) {
      return reply(`No restaurants yet.

${ONBOARDING_HELP}`);
    }
    return reply(
      [
        `*${outlets.length} outlet(s)*`,
        '',
        ...outlets.map((o) =>
          [
            `*${o.code}* ${o.name}${o.accepting ? '' : ' — _paused_'}`,
            `  ${o.hours || '⚠️ no hours set'}`,
            `  ${o.whatsapp ? `kitchen +${o.whatsapp}` : '⚠️ no kitchen number'}`,
            `  ${o.pickupLat !== null ? 'pin set' : '⚠️ no pickup pin'}`,
          ].join('\n'),
        ),
      ].join('\n\n'),
    );
  }

  if (/^(orders|open|queue|list)$/i.test(trimmed)) {
    const open = repo.openOrders(10);
    if (open.length === 0) return reply('No open orders. 🎉');
    return reply(
      [`*${open.length} open order(s)*`, ...open.map(describe)].join('\n\n') +
        '\n\nReply e.g. `7 on the way`.',
    );
  }

  // Before the order-number match below, which would otherwise read the day
  // count in "wanted 7" as order 7.
  const demand = trimmed.match(/^(?:wanted|demand|misses|missing)(?:\s+(\d{1,3}))?$/i);
  if (demand) {
    const days = Math.min(Math.max(Number(demand[1] ?? 30), 1), 365);
    return reply(demandReport(days));
  }

  const orderRef = trimmed.match(/(?:ord[-\s]?)?0*(\d{1,6})/i);
  if (!orderRef) {
    return reply(`Didn't catch an order number there.\n\n${HELP}`);
  }

  const order = repo.findOrder(orderRef[1] ?? '');
  if (!order) return reply(`No order ${orderRef[1]}. Send \`orders\` to see what's open.`);

  // A named reason is itself a cancellation: tapping "7 sold out" must cancel,
  // not print the order. A status word still wins, so "7 delivered, delivery associate was
  // busy" is a delivery rather than a cancellation.
  const matchedStatus = STATUS_WORDS.find(([pattern]) => pattern.test(trimmed));
  const matched: [RegExp, repo.OrderStatus] | undefined =
    matchedStatus ?? (findCancelReason(trimmed) ? [/./, 'cancelled'] : undefined);

  if (!matched) {
    // Looking one order up is usually the delivery associate about to drive to it, so the
    // pin follows as a map card. The open-orders list deliberately does not do
    // this: ten map cards in a row is unreadable.
    const card: OutboundMessage[] = order.location
      ? [{ kind: 'location', text: '', pin: order.location }]
      : [];
    return [{ kind: 'text', text: describe(order) }, ...card];
  }

  const status = matched[1];

  if (status === 'cancelled' && order.status !== 'cancelled') {
    const ask = askWhyCancelled(order, trimmed, 'staff');
    if (ask) return ask;
    repo.setCancelReason(order.orderNo, cancellationReason(order, trimmed), 'staff');
  }

  if (order.status === status) {
    return reply(`${order.orderNo} is already ${STATUS_LABEL[status]}.`);
  }

  const { body } = await applyStatus(order, status);
  const actions = nextActions(order.orderNo, status);
  return actions.length > 0 ? [{ kind: 'buttons', text: body, buttons: actions }] : reply(body);
}

/* ------------------------------------------------------------------ outlets */

const OUTLET_HELP = [
  '*Kitchen commands*',
  '',
  '`orders` — orders waiting on you',
  '`7 confirm` — accept order 7',
  '`ORD-00007 ready` — food is up, a delivery associate is sent',
  '`7 cancel` — you cannot make it',
  '',
  '`pause` — stop new orders coming',
  '`open` — start taking them again',
  '`sold out <SKU>` / `back <SKU>` — one dish off and on the menu',
].join('\n');

/**
 * A restaurant texting the shop number about its own orders.
 *
 * Everything here is scoped to that outlet. An outlet must not be able to see,
 * move or cancel another kitchen's order, and it never gets the customer's
 * address or number — only what to cook.
 */
export async function handleOutletMessage(
  outlet: repo.Outlet,
  text: string,
): Promise<OutboundMessage[]> {
  const reply = (t: string): OutboundMessage[] => [{ kind: 'text', text: t }];
  const trimmed = text.trim();

  // Anything at all from a kitchen reopens WhatsApp's 24-hour window — a
  // tapped template button, a question, a thumbs up. Tickets that could not be
  // delivered while it was shut are handed over now, before the message itself
  // is answered, so a kitchen replying to a nudge gets the order it is about.
  await flushOutletTickets(outlet.id);

  if (/^(help|\?|commands)$/i.test(trimmed)) return reply(OUTLET_HELP);

  if (/^(pause|busy|stop)$/i.test(trimmed)) {
    repo.setOutletAccepting(outlet.code, false);
    return reply(`Paused — no new orders will reach ${outlet.name}. Send \`open\` when ready.`);
  }
  if (/^(open|resume|unpause|back)$/i.test(trimmed)) {
    repo.setOutletAccepting(outlet.code, true);
    return reply(`${outlet.name} is taking orders again.`);
  }

  const soldOut = trimmed.match(/^(sold\s*out|out|finished|done)\s+([A-Za-z0-9-]+)$/i);
  if (soldOut) {
    const sku = soldOut[2] ?? '';
    const item = repo.getProductBySku(sku);
    if (!item || item.outletId !== outlet.id) return reply(`No item ${sku} on your menu.`);
    repo.setItemSoldOut(sku, true);
    return reply(`${item.name} marked sold out. Send \`back ${sku}\` when it returns.`);
  }
  const backOn = trimmed.match(/^(back|available|on)\s+([A-Za-z0-9-]+)$/i);
  if (backOn) {
    const sku = backOn[2] ?? '';
    const item = repo.getProductBySku(sku);
    if (!item || item.outletId !== outlet.id) return reply(`No item ${sku} on your menu.`);
    repo.setItemSoldOut(sku, false);
    return reply(`${item.name} is back on the menu.`);
  }

  if (/^(orders|open|queue|list)$/i.test(trimmed)) {
    const mine = repo.openOrders(20).filter((o) => o.outlet?.id === outlet.id);
    if (mine.length === 0) return reply('Nothing waiting on you right now. 🎉');
    return reply(
      [`*${mine.length} order(s) for ${outlet.name}*`, ...mine.map(describeForKitchen)].join('\n\n'),
    );
  }

  const ref = trimmed.match(/(?:ord[-\s]?)?0*(\d{1,6})/i);
  if (!ref) return reply(`Didn't catch an order number.\n\n${OUTLET_HELP}`);

  const order = repo.findOrder(ref[1] ?? '');
  // Deliberately the same answer for "does not exist" and "is not yours", so a
  // kitchen cannot probe for other outlets' order numbers.
  if (!order || order.outlet?.id !== outlet.id) {
    return reply(`No order ${ref[1]} for ${outlet.name}. Send \`orders\` to see yours.`);
  }

  const matchedStatus = STATUS_WORDS.find(([pattern]) => pattern.test(trimmed));
  const matched: [RegExp, repo.OrderStatus] | undefined =
    matchedStatus ?? (findCancelReason(trimmed) ? [/./, 'cancelled'] : undefined);
  if (!matched) return reply(describeForKitchen(order));

  const status = matched[1];
  // A kitchen can also report the collection, because it watches the food
  // leave and often sees it go before anyone else does. What it still cannot
  // do is close the order: delivered is the doorstep, and only whoever stood
  // on it can say so.
  if (!['confirmed', 'ready', 'on_the_way', 'cancelled'].includes(status)) {
    return reply(
      `A kitchen can confirm an order, mark it ready, say it was uplifted, or cancel it. Delivery is the delivery associate's end.`,
    );
  }
  // Collected before it was ever cooked is somebody tapping an old message.
  // Only the stages BEFORE ready. An order already on its way falls through
  // to the plain "already" reply below, and a delivered or cancelled one is
  // stopped by the terminal guard - both of which say something truer than
  // telling a cook to mark ready food ready.
  if (status === 'on_the_way' && ['pending', 'confirmed'].includes(order.status)) {
    return reply(
      `${order.orderNo} is ${STATUS_LABEL[order.status]} - mark it ready before saying it was uplifted.`,
    );
  }

  if (status === 'cancelled' && order.status !== 'cancelled') {
    const ask = askWhyCancelled(order, trimmed, 'outlet');
    if (ask) return ask;
    repo.setCancelReason(order.orderNo, cancellationReason(order, trimmed), 'outlet');
  }

  if (order.status === status) return reply(`${order.orderNo} is already ${STATUS_LABEL[status]}.`);

  const { body } = await applyStatus(order, status, 'outlet');
  const actions = nextActions(order.orderNo, status, 'outlet');
  return actions.length > 0 ? [{ kind: 'buttons', text: body, buttons: actions }] : reply(body);
}

const describeForKitchen = (o: repo.OrderRecord): string =>
  [
    `*${o.orderNo}* — ${STATUS_LABEL[o.status]}`,
    ...o.items.map((i) => {
      const chosen = summariseStored(i.options);
      return `${i.qty} x ${i.name}${chosen ? ` — _${chosen}_` : ''}`;
    }),
  ].join('\n');

/* ------------------------------------------------------------------ delivery associates */

const DRIVER_HELP = [
  '*Delivery associate commands*',
  '',
  '`jobs` — uplifts waiting',
  '`7 uplifted` — you have the food',
  '`7 delivered` — dropped off, cash taken',
  '',
  'Share your location to be offered uplifts near you.',
  '',
  'Order numbers work as `7`, `ORD-7` or `ORD-00007`.',
].join('\n');

/**
 * A delivery associate texting the shop number.
 *
 * Collect and deliver, nothing else. A delivery associate cannot confirm an order, cancel
 * one, or see the queue — those are decisions for the shop and the kitchen, and
 * a mis-tap on a bike should not be able to void somebody's dinner.
 */
export async function handleDriverMessage(
  text: string,
  phone = '',
  location?: LocationPin,
): Promise<OutboundMessage[]> {
  const reply = (t: string): OutboundMessage[] => [{ kind: 'text', text: t }];
  const trimmed = text.trim();
  const holding = repo.activeJobsFor(phone);

  // A pin from an associate says where they are, which decides which jobs are
  // near enough to be worth offering them.
  if (location) {
    repo.saveAssociateLocation(phone, location, 'shared');
    const radius = config.associateRadiusMiles;
    return reply(
      [
        `📍 Got it${location.label ? ` — ${location.label}` : ''}.`,
        radius > 0
          ? `You will be offered uplifts within ${radius} miles of here. Send another pin when you move.`
          : 'Noted. Send another pin when you move.',
      ].join(chr10),
    );
  }

  if (/^(help|\?|commands)$/i.test(trimmed)) return reply(DRIVER_HELP);

  if (/^(jobs|job|queue|pickups?|collections?|uplifts?)$/i.test(trimmed)) {
    const waiting = repo.ordersAwaitingPickup(10);

    // What they are already carrying is shown, never used to refuse more. Two
    // orders from the same kitchen are one trip, and an associate standing at
    // that counter is exactly the right person for the second.
    const mine = holding.length > 0
      ? [`*With you now (${holding.length})*`, ...holding.map(describeForDriver)]
      : [];

    if (waiting.length === 0 && mine.length === 0) return reply('Nothing to uplift right now.');

    // Anything ready at a kitchen they are already going to is worth flagging:
    // it costs them nothing to pick up both.
    const sameStop = new Set(holding.map((o) => o.outlet?.id).filter(Boolean));
    const label = (o: repo.OrderRecord): string =>
      sameStop.has(o.outlet?.id) ? ' — *same stop as yours*' : '';

    return reply(
      [
        ...mine,
        ...(waiting.length > 0
          ? [
              `*${waiting.length} ready to uplift*`,
              ...waiting.map((o) => describeForDriver(o) + label(o)),
            ]
          : []),
      ].join('\n\n'),
    );
  }

  const ref = trimmed.match(/(?:ord[-\s]?)?0*(\d{1,6})/i);
  if (!ref) return reply(`Didn't catch an order number.\n\n${DRIVER_HELP}`);

  const order = repo.findOrder(ref[1] ?? '');
  if (!order) return reply(`No order ${ref[1]}. Send \`jobs\` to see what's waiting.`);

  const matched = STATUS_WORDS.find(([pattern]) => pattern.test(trimmed));
  if (!matched) return reply(describeForDriver(order));

  const status = matched[1];
  if (status !== 'on_the_way' && status !== 'delivered') {
    return reply('A delivery associate can mark an order uplifted or delivered. Anything else is for the shop.');
  }
  // One delivery at a time. Somebody already carrying hot food across town
  // cannot also be collecting from another kitchen, and a second job is how
  // both arrive cold.
  if (
    status === 'on_the_way' &&
    config.maxJobsPerAssociate > 0 &&
    order.driverPhone !== phone.replace(/[^0-9]/g, '') &&
    holding.length >= config.maxJobsPerAssociate
  ) {
    return reply(
      [
        `You already have ${holding.map((o) => o.orderNo).join(', ')} with you.`,
        '',
        'Deliver that first, then come back for this one. Someone else can take it in the meantime.',
      ].join('\n'),
    );
  }

  // Collecting food nobody has cooked is how an order gets marked delivered
  // while it is still in a fryer.
  if (status === 'on_the_way' && order.outlet && order.status !== 'ready') {
    return reply(
      `${order.orderNo} is ${STATUS_LABEL[order.status]} — wait for the kitchen to mark it ready.`,
    );
  }
  if (order.status === status) return reply(`${order.orderNo} is already ${STATUS_LABEL[status]}.`);

  if (status === 'on_the_way' && phone) repo.assignDriver(order.orderNo, phone);

  // A completed delivery is the one position we never have to ask for: they
  // were demonstrably at that doorstep when they tapped the button.
  if (status === 'delivered' && phone && order.location) {
    repo.saveAssociateLocation(phone, order.location, 'delivery');
  }

  const { body } = await applyStatus(order, status);
  const actions = nextActions(order.orderNo, status, 'driver');
  return actions.length > 0 ? [{ kind: 'buttons', text: body, buttons: actions }] : reply(body);
}

const describeForDriver = (o: repo.OrderRecord): string =>
  [
    `*${o.orderNo}* — ${STATUS_LABEL[o.status]}`,
    ...(o.outlet ? [`Pick up: ${o.outlet.name}${o.outlet.pickupAddress ? `, ${o.outlet.pickupAddress}` : ''}`] : []),
    `To: ${o.customerName}`,
    ...(o.address ? [o.address] : []),
    `📞 +${o.contactPhone || o.phone}`,
    ...(o.location ? [mapsLink(o.location)] : ['⚠️ No pin — ring the customer']),
    `Collect ${money(o.total)} cash`,
  ].join('\n');

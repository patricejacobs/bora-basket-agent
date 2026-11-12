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
import { sendLocationRequest, sendText } from './channels/whatsapp-send.ts';
import {
  STATUS_LABEL,
  STATUS_WORDS,
  cancelButtons,
  findCancelReason,
  isBackwards,
  nextActions,
  noCodeButton,
  type Audience,
} from './order-status.ts';
import {
  dispatchToDrivers,
  flushOutletTickets,
  onTheWayCard,
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
/**
 * What a terminal order says, to the person who just tried to move it.
 *
 * One sentence of fact and one instruction, and the instruction depends
 * entirely on who is reading. "Do not prepare it" is a kitchen's instruction;
 * an associate cannot unprepare anything, and told that while standing
 * somewhere holding the food they learn nothing they can act on.
 */
function terminalMessage(order: repo.OrderRecord, who: 'staff' | 'outlet' | 'driver'): string {
  if (order.status === 'delivered') {
    return `${order.orderNo} is already *delivered* — nothing more to do.`;
  }

  // The reason, because an associate at a door may be facing the customer and
  // "it was cancelled" with no explanation makes them look like the problem.
  const reason = order.cancelReason
    ? ` — ${order.cancelReason.charAt(0).toLowerCase()}${order.cancelReason.slice(1)}`
    : '';

  if (who === 'driver') {
    // Somewhere to put it, which costs nothing to say and is the difference
    // between an instruction and a dead end - there is nobody on the
    // administrative end to ring for a decision.
    const back =
      order.outlet?.name ?? (order.kind === 'parcel' ? order.customerName : 'the shop');
    return [
      `🛑 ${order.orderNo} was cancelled${reason}.`,
      '',
      'Do not deliver it, and do not collect any money.',
      `Take it back to ${back}.`,
    ].join(chr10);
  }

  // The reason trails, rather than sitting mid-sentence: "was cancelled -
  // kitchen ran out and cannot be changed" reads as though the kitchen running
  // out is the thing that cannot be changed.
  if (who === 'outlet') {
    return `${order.orderNo} was cancelled and cannot be changed. Do not prepare it.${reason ? ` Reason:${reason.replace(/^ — /, " ")}.` : ''}`;
  }
  return `${order.orderNo} was cancelled and cannot be changed.${reason ? ` Reason:${reason.replace(/^ — /, " ")}.` : ''}`;
}

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
    return { body: terminalMessage(order, reportedBy), status: order.status };
  }

  // A delivery associate cannot cancel, ever.
  //
  // Their own handler already refuses anything but uplifted and delivered, so
  // this is defence in depth - put here because every actor passes through
  // this function and nothing else is a single choke point. An associate is at
  // a door with the food in their hand; whatever has gone wrong there, voiding
  // the order is not the answer, and a cancellation is the one move with no
  // way back. If a code will not verify they deliver it unverified; if nobody
  // is home that is a conversation for the shop, not a button on a bike.
  if (reportedBy === 'driver' && status === 'cancelled') {
    return {
      body: `${order.orderNo} cannot be cancelled from here. Deliver it, or ring the shop.`,
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
  // The two moments an order is measured by, stamped as they happen. Written
  // once each, so a tap on an old message cannot move them.
  if (status === 'ready') repo.markReadyAt(order.orderNo);
  if (status === 'on_the_way') repo.markUpliftedAt(order.orderNo);
  const updated = { ...order, status };

  const notes: string[] = [];
  // What a cook can actually do something about. Everything else a status
  // change produces - the customer was told, the shop was told - is the
  // shop's bookkeeping, and a kitchen that reads it after every tap soon
  // reads nothing. Whether an associate is coming is the exception: that one
  // decides whether the food waits on a counter or on nobody.
  const kitchenNotes: string[] = [];

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
      if (how !== 'sent') {
        kitchenNotes.push('⚠️ Nobody has been sent to uplift this yet — ring the shop.');
      }
    } catch (err) {
      console.error('[staff] failed to dispatch a delivery associate:', err);
      notes.push('⚠️ Status saved, but dispatching a delivery associate failed.');
      kitchenNotes.push('⚠️ Nobody has been sent to uplift this yet — ring the shop.');
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
      if (reached === 0) {
        kitchenNotes.push('⚠️ A delivery associate may still turn up for this — turn them away.');
      }
    } catch (err) {
      console.error('[staff] failed to call off an associate:', err);
      notes.push('⚠️ Status saved, but calling off the delivery associate failed.');
      kitchenNotes.push('⚠️ A delivery associate may still turn up for this — turn them away.');
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
    const associate = order.driverPhone
      ? [order.driverName, `+${order.driverPhone}`, order.driverVehicle].filter(Boolean).join(' · ')
      : 'not recorded yet';
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

  // A kitchen is not a dispatcher. After a tap it wants the fact and nothing
  // else: which order, and where it now stands. That the customer was told,
  // that an associate was sent, that the shop was told - all useful to the
  // people running the shop, all bookkeeping to a cook. A cook who reads
  // three lines after every tap soon reads none of them.
  //
  // Warnings survive the cut, and that is the point of the cut rather than an
  // exception to it. "No delivery associate was told" means nobody is coming
  // for the food; dropping it for the sake of brevity would leave a kitchen
  // waiting on somebody who was never sent. Silence when all is well, and a
  // line only when something needs doing.
  if (reportedBy === 'outlet') {
    const problems = kitchenNotes;
    return {
      body: [`*${order.orderNo}* ${STATUS_LABEL[status]}.`, ...problems].join(
        String.fromCharCode(10),
      ),
      status,
    };
  }

  return { body: `${order.orderNo} → *${STATUS_LABEL[status]}*.\n${notes.join('\n')}`, status };
}

/**
 * Where the delivery associates are, as well as anyone can know.
 *
 * WhatsApp gives a business a pin, not a track. Live location is a consumer
 * feature and does not reach a business number, so there is no continuous
 * trace to show - only the last position each associate gave us, and when.
 *
 * Two things give one: a pin they shared, and every doorstep they delivered
 * to, which is the position nobody has to ask for because they were
 * demonstrably standing on it when they tapped Delivered.
 *
 * The age matters more than the position. Six minutes old is where they are;
 * two hours old is where they were, and saying so is the difference between
 * a dispatcher trusting it and being misled by it.
 */
async function describeAssociates(): Promise<string> {
  const roster = config.driverNumbers;
  if (roster.length === 0) return 'No delivery associates are set up (DRIVER_NUMBERS is empty).';

  const now = Date.now();
  const lines = roster.map((phone) => {
    const who = repo.getAssociate(phone);
    const at = repo.getAssociateLocation(phone);
    const carrying = repo.activeJobsFor(phone);

    const title = [who?.name || `+${phone}`, who?.vehicle].filter(Boolean).join(' · ');
    const since = repo.onDutySince(phone);
    // On or off first, because it decides whether the rest matters: a
    // position for somebody who went home is history, not a dispatch.
    const out = [`${since ? '🟢' : '⚪'} *${title}*` + (since ? '' : '  (off duty)')];
    if (who?.name) out.push(`   +${phone}`);

    if (at) {
      const mins = Math.max(0, Math.round((now - new Date(at.updatedAt).getTime()) / 60_000));
      const how = at.source === 'delivery' ? 'last drop-off' : 'pin they sent';
      const stale = mins > 60 ? ' ⚠️' : '';
      out.push(`   📍 ${describeAge(mins)} (${how})${stale}`);
      out.push(`   ${mapsLink(at)}`);
    } else {
      out.push('   📍 no position yet');
    }

    out.push(
      carrying.length > 0
        ? `   Carrying ${carrying.map((o) => o.orderNo).join(', ')}`
        : '   Nothing with them',
    );
    return out.join(String.fromCharCode(10));
  });

  // A blank line between each, so three associates do not read as one block.
  return [
    '*Delivery associates*',
    ...lines,
    'Send `where <name>` to ask one of them for a fresh pin.',
  ].join(String.fromCharCode(10) + String.fromCharCode(10));
}

/** Minutes, in words a dispatcher reads at a glance. */
function describeAge(mins: number): string {
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const HELP = [
  '*Staff commands*',
  '',
  '`orders` — list open orders',
  '`7 confirmed` — accept order 7',
  '`ORD-00007 ready` — food is up, a delivery associate is sent',
  '`ORD-00007 uplifted` — note the time it left you; nothing else happens',
  '`7 on the way` — dispatch, customer is told',
  '`7 delivered` — close it, customer is told',
  '`7 cancel` — cancel it',
  '`7` — show one order',
  '',
  '`wanted` — what customers asked for and we did not have',
  '',
  '`where` — where the delivery associates are',
  '`where <name>` — ask one of them for a fresh pin',
  '',
  '`cash` — what each associate collected today',
  '`backup` — the trading record, sent to you here',
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
    // Durations, not clock times: nobody reads "ready 13:41, uplifted 13:58"
    // and subtracts. The gap is the thing - one says how fast the kitchen is,
    // the other how long the food sat waiting for somebody to come.
    ...carriedBy(o),
    ...timings(o),
  ].join('\n');

/**
 * How long each leg took, in the words a dispatcher would use.
 *
 * Only the legs that have happened. An order still being prepared has nothing
 * to say about how long it waited, and a line reading "waited 0 min" invites
 * somebody to believe it.
 */
/**
 * Who took it: name, number and vehicle, in that order.
 *
 * Read from the order rather than the directory, so it answers who carried
 * THIS one - not who is driving that van today.
 */
function carriedBy(o: repo.OrderRecord): string[] {
  if (!o.driverPhone) return [];
  const who = [o.driverName, `+${o.driverPhone}`, o.driverVehicle].filter(Boolean).join(' · ');
  return [`🛵 ${who}`];
}

function timings(o: repo.OrderRecord): string[] {
  const mins = (from: string, to: string): number | null => {
    if (!from || !to) return null;
    const gap = (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
    return Number.isFinite(gap) && gap >= 0 ? Math.round(gap) : null;
  };

  const prep = mins(o.placedAt, o.readyAt);
  const wait = mins(o.readyAt, o.upliftedAt);
  const out: string[] = [];
  if (prep !== null) out.push(`Ready ${prep} min after ordering`);
  if (wait !== null) out.push(`Uplifted ${wait} min after that`);
  // Still sitting there: the number that matters most is the one still running.
  else if (o.readyAt && o.status === 'ready') {
    const since = mins(o.readyAt, new Date().toISOString());
    if (since !== null) out.push(`Waiting ${since} min for a delivery associate`);
  }
  return out;
}


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

  // What the associates are holding in cash.
  if (/^(cash|takings|money)$/i.test(trimmed)) return reply(cashReport());

  // A copy of the trading record, to this phone, now.
  //
  // Pull as well as push: the daily push can only reach somebody who has
  // written to this number in the last 24 hours, and the one person who is
  // certainly inside that window is whoever just typed this.
  if (/^(backup|back\s*up|export)$/i.test(trimmed)) {
    const { sendOffsiteCopy } = await import('./backup.ts');
    const result = await sendOffsiteCopy(phone);
    return reply(
      result === 'sent'
        ? 'Sending it now — two files. Save them somewhere off your phone as well.'
        : 'Could not send the files. Check the logs on Render.',
    );
  }

  // Where everyone is, and a way to ask one of them for a fresh pin.
  if (/^(where|associates|drivers|riders)$/i.test(trimmed)) {
    return reply(await describeAssociates());
  }

  const asking = trimmed.match(/^where\s+(.+)$/i);
  if (asking) {
    const named = (asking[1] ?? '').trim();
    // By name or by number, because a dispatcher knows the person and not
    // always the digits.
    const digits = named.replace(/[^0-9]/g, '');
    const match = config.driverNumbers.find((p2) => {
      if (digits.length >= 6 && p2.includes(digits)) return true;
      const who = repo.getAssociate(p2);
      return Boolean(who?.name && who.name.toLowerCase().includes(named.toLowerCase()));
    });

    if (!match) return reply(`No delivery associate matching "${named}". Send \`where\` to see them all.`);

    const who = repo.getAssociate(match);
    // A request they can answer with one tap, rather than a message asking
    // somebody riding a bike to type an address.
    const sent = await sendLocationRequest(
      match,
      'The shop is asking where you are. Tap below to send your location.',
    );
    return reply(
      sent
        ? `Asked ${who?.name || `+${match}`} to share their location. It will show in \`where\` when they do.`
        : `Could not reach ${who?.name || `+${match}`} — ring them.`,
    );
  }

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

  // The kitchen handing the food over. A clock, not a status - the order is
  // only on its way when the associate says so, because only they know they
  // have it. So this writes a time and tells nobody: not the customer, who
  // would be promised a delivery that has not started, and not the shop,
  // which learns it from the associate a moment later anyway.
  //
  // Matched before the status words, because "uplifted" means on its way when
  // an associate says it and only a handover when a kitchen does.
  if (/\b(handover|handed\s*over|uplift(ed)?|gone|left|picked\s*up|collected)\b/i.test(trimmed)) {
    if (order.status !== 'ready') {
      return reply(
        `${order.orderNo} is ${STATUS_LABEL[order.status]} - mark it ready before handing it over.`,
      );
    }
    const at = repo.markHandedOver(order.orderNo);
    const clock = new Date(at).toLocaleTimeString('en-GB', {
      timeZone: config.store.timezone,
      hour: 'numeric',
      minute: '2-digit',
    });
    // Anything prepared before this one and still on the counter. A count
    // says there is a problem; the numbers say which bag to look for, which
    // is the difference between a cook knowing and a cook acting.
    //
    // By when the customer ordered, not by when the food was ready: that is
    // the queue the customer is in, and an order that jumped it is exactly
    // what somebody should see.
    const waiting = repo.earlierStillWaiting(outlet.id, order.placedAt);

    return reply(
      [
        `*${order.orderNo}* uplifted at ${clock}`,
        ...(waiting.length > 0
          ? [
              `${waiting.length} earlier order${waiting.length === 1 ? '' : 's'} ready and waiting: ` +
                waiting.map((o) => o.orderNo).join(', '),
            ]
          : []),
      ].join(String.fromCharCode(10)),
    );
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
  if (!['confirmed', 'ready', 'cancelled'].includes(status)) {
    return reply(
      `A kitchen can confirm an order, mark it ready, note that it was uplifted, or cancel it. Delivery is the delivery associate's end.`,
    );
  }
  // Ready before anyone accepted the order. The button is no longer offered
  // at this stage, but messages already sent still carry it, and a tap on a
  // message from last week works exactly as well as one from a minute ago.
  if (status === 'ready' && order.status === 'pending') {
    return reply(
      `${order.orderNo} has not been accepted yet - press *Confirm* first, then *Ready* when the food is up.`,
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
  '`on` — clock on for your shift',
  '`off` — clock off',
  '',
  '`jobs` — uplifts waiting',
  '`7 uplifted` — you have the food',
  '`7 delivered` — dropped off, cash taken',
  '',
  '`cash` — what you are holding this shift',
  '',
  'At the door, ask for the four-digit delivery code and type it in.',
  'No code? Tap *No code* — the order still goes through.',
  '',
  'Share your location to be offered uplifts near you.',
  '',
  'Order numbers work as `7`, `ORD-7` or `ORD-00007`.',
].join('\n');

/**
 * The day's cash, by whoever is holding it.
 *
 * Counted from midnight on the store's own clock. The shop trades around the
 * clock so there is no natural gap to count from, but money is reconciled
 * against the day on the till, not UTC's.
 */
function cashReport(): string {
  const from = repo.startOfStoreDay();
  const rows = repo.cashByAssociate(from);
  const loose = repo.unassignedCash(from);
  const day = from.toLocaleDateString('en-GB', {
    timeZone: config.store.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  if (rows.length === 0 && loose.orders === 0) {
    return [`💰 *Cash today* — ${day}`, '', 'Nothing delivered for cash yet.'].join(chr10);
  }

  const line = (label: string, t: { orders: number; total: number }): string =>
    `${label} — ${t.orders} ${t.orders === 1 ? 'order' : 'orders'}, *${money(t.total)}*`;

  const total = rows.reduce((sum, r) => sum + r.total, 0) + loose.total;
  const count = rows.reduce((sum, r) => sum + r.orders, 0) + loose.orders;

  return [
    `💰 *Cash today* — ${day}`,
    '',
    ...rows.map((r) =>
      line(`${r.name || `+${r.phone}`}${r.vehicle ? ` (${r.vehicle})` : ''}`, r),
    ),
    // Delivered cash with no associate on it: closed by a dispatcher rather
    // than by whoever carried it. Shown rather than dropped, because a total
    // that does not reconcile to the till is worse than an awkward row.
    ...(loose.orders > 0 ? [line('Closed by the shop, nobody named', loose)] : []),
    '',
    `*${count} ${count === 1 ? 'order' : 'orders'}, ${money(total)} in all*`,
    '',
    'Delivered and paid in cash. Card orders are not counted — nothing changes hands.',
  ].join(chr10);
}

/**
 * What dispatch is told when an order is delivered without its code.
 *
 * Named, because an unverified delivery is only worth recording if it can be
 * attributed. One of these is a flat phone battery; a dozen from the same
 * person is something else, and the shop can only see the difference if the
 * name is on each one.
 */
function unverifiedWarning(order: repo.OrderRecord, phone: string, why: string): string {
  const who = repo.getAssociate(phone);
  const named = who?.name
    ? `${who.name}${who.vehicle ? ` (${who.vehicle})` : ''} +${phone}`
    : `+${phone}`;
  return [
    `⚠️ *${order.orderNo} — delivered, code not verified*`,
    '',
    `${named} reports ${why}.`,
    `Customer: ${order.customerName} +${order.contactPhone || order.phone}`,
  ].join(chr10);
}

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
    // Sending a pin is somebody telling you they are out working. Doing both
    // in one action is the difference between a rule people follow and one
    // they forget.
    // A pin clocks somebody on, but not past the day's limit - otherwise
    // the easy way in is also the way round the rule.
    const capped = repo.canWorkAgainAt(phone) !== null;
    const wasOff = !repo.isOnDuty(phone);
    if (!capped) repo.setDuty(phone, true);
    const radius = config.associateRadiusMiles;
    return reply(
      [
        `📍 Got it${location.label ? ` — ${location.label}` : ''}.`,
        ...(capped
          ? [`🛑 You have reached ${config.dutyHoursPerDay} hours in the last 24 and are off duty.`]
          : wasOff
            ? ['You are on duty.']
            : []),
        radius > 0
          ? `You will be offered uplifts within ${radius} miles of here. Send another pin when you move.`
          : 'Noted. Send another pin when you move.',
      ].join(chr10),
    );
  }

  // Two letters to start, one tap to stop.
  //
  // The way out is a button rather than another word on purpose: the end of a
  // shift is when somebody is tired and least likely to type anything.
  if (/^(on|in|start|working|on\s*duty|clock\s*in)$/i.test(trimmed)) {
    // The day's limit, before anything is recorded. Counted across every
    // stretch in the last 24 hours, so stopping and starting cannot reset it.
    const again = repo.canWorkAgainAt(phone);
    if (again) {
      const when = again.toLocaleTimeString('en-GB', {
        timeZone: config.store.timezone,
        hour: 'numeric',
        minute: '2-digit',
      });
      return reply(
        [
          `🛑 You have worked ${Math.floor(repo.hoursWorkedToday(phone))} hours in the last 24.`,
          '',
          `The limit is ${config.dutyHoursPerDay}. You can clock on again from ${when}.`,
        ].join(String.fromCharCode(10)),
      );
    }

    repo.setDuty(phone, true);
    const who = repo.getAssociate(phone);
    return [
      {
        kind: 'buttons',
        text: [
          `🛵 You are on duty${who?.name ? `, ${who.name.split(' ')[0]}` : ''}. Jobs will come to you.`,
          '',
          `You will be clocked off automatically after ${config.dutyHours} hours, so send *on* again tomorrow.`,
        ].join(String.fromCharCode(10)),
        buttons: [{ id: 'duty_off', title: 'Clock off', command: 'clock off' }],
      },
    ];
  }

  if (/^(off|out|stop|done|finished|off\s*duty|clock\s*off)$/i.test(trimmed)) {
    const carrying = repo.activeJobsFor(phone);
    // Read before clocking off, or the shift it refers to no longer exists.
    const since = repo.onDutySince(phone);
    const dayStart = repo.startOfStoreDay();
    const shift = repo.cashCollected(phone, since ? new Date(since) : dayStart);
    // The day as well as the shift, when they differ. Somebody who worked a
    // stretch this morning may still be carrying that money - a figure for
    // this shift alone would understate what they owe, and a figure for the
    // day would double-count anything already handed in. Both, and let the
    // person holding it say which.
    const today = repo.cashCollected(phone, dayStart);
    repo.setDuty(phone, false);
    return reply(
      [
        `👋 You are off duty. No more jobs will come to you.`,
        // The figure they are holding, said once, plainly, at the only moment
        // they are certain to read it. Nobody can hand over money they were
        // never told the amount of.
        ...(shift.orders > 0
          ? [
              '',
              `💰 ${shift.orders} ${shift.orders === 1 ? 'delivery' : 'deliveries'} for cash — *${money(shift.total)}* to hand in.`,
            ]
          : []),
        ...(today.orders > shift.orders
          ? [
              `Across today: ${today.orders} deliveries, ${money(today.total)}. Say if an earlier shift is already handed in.`,
            ]
          : []),
        // Clocking off does not finish what is already in the bag, and
        // somebody with two orders on a bike should be told so plainly.
        ...(carrying.length > 0
          ? ['', `You still have ${carrying.map((o) => o.orderNo).join(', ')} with you — please finish those.`]
          : []),
      ].join(String.fromCharCode(10)),
    );
  }

  if (/^(help|\?|commands)$/i.test(trimmed)) return reply(DRIVER_HELP);

  // What they are holding. Asked for by the person holding it, which is the
  // one party who can check the figure against their own pocket.
  if (/^(cash|money|takings)$/i.test(trimmed)) {
    const since = repo.onDutySince(phone);
    const from = since ? new Date(since) : repo.startOfStoreDay();
    const tally = repo.cashCollected(phone, from);
    return reply(
      tally.orders === 0
        ? 'No cash deliveries yet' + (since ? ' this shift.' : ' today.')
        : [
            `💰 *${money(tally.total)}* to hand in`,
            `${tally.orders} cash ${tally.orders === 1 ? 'delivery' : 'deliveries'}${since ? ' this shift' : ' today'}.`,
          ].join(chr10),
    );
  }

  if (/^(jobs|job|queue|pickups?|collections?|uplifts?)$/i.test(trimmed)) {
    const waiting = repo.ordersAwaitingPickup(10);

    // What they are already carrying is shown, never used to refuse more. Two
    // orders from the same kitchen are one trip, and an associate standing at
    // that counter is exactly the right person for the second.
    // What they are holding leads, because an undelivered order is the only
    // thing on this list they are not allowed to put off.
    const mine = holding.length > 0
      ? [
          `🛑 *Deliver first (${holding.length})*`,
          ...holding.map(describeForDriver),
          holding.length === 1
            ? 'Nothing else can be uplifted until this one is delivered.'
            : 'Nothing else can be uplifted until these are delivered.',
        ]
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

  // Proof of delivery, answered before the order number is parsed.
  //
  // The answer to "what is the code?" is four bare digits, and the parser below
  // reads any bare number as an order number. So this has to come first - and
  // it only fires while an order of theirs is actually waiting on a code, which
  // means an associate who types `1234` meaning order 1234 still gets order
  // 1234 every other time.
  if (config.deliveryCode) {
    const awaiting = holding.filter((o) => repo.deliveryCodeExpected(o.orderNo));

    const noCode = /\bno\s*code\b/i.test(trimmed);
    const paired = /^(?:ord[-\s]?)?0*(\d{1,6})\s+(\d{4})$/.exec(trimmed);
    const bare = /^(\d{4})$/.exec(trimmed);

    // Which order is being proved. Named explicitly, or the only one it could
    // be. Never guessed when two are open: verifying the wrong delivery is
    // worse than asking which.
    const target = paired
      ? repo.findOrder(paired[1] ?? '')
      : bare && awaiting.length === 1
        ? (awaiting[0] ?? null)
        : null;

    // A cancelled or delivered order has nothing left to verify, so it never
    // reaches the code logic below.
    //
    // Without this, a wrong code on a cancelled order was answered "2 tries
    // left" - inviting the associate to keep trying to complete something that
    // is over - and an old order with no code at all was answered "send `23
    // delivered` to close it", which is worse still: an instruction to deliver
    // something that has been cancelled.
    if (target && (target.status === 'cancelled' || target.status === 'delivered')) {
      return reply(terminalMessage(target, 'driver'));
    }

    if (bare && !paired && awaiting.length > 1) {
      const first = String(Number((awaiting[0]?.orderNo ?? '').replace(/[^0-9]/g, '')));
      return reply(
        [
          'Which order is that code for?',
          '',
          ...awaiting.map((o) => `${o.orderNo} - ${o.customerName}`),
          '',
          `Send the order and the code together, like \`${first} ${bare[1]}\`.`,
        ].join(chr10),
      );
    }

    // A code typed against an order they are not carrying.
    //
    // Checked before the code is compared, and that order is left completely
    // alone - no attempt counted against it. Otherwise an associate fumbling
    // the order number burns somebody else's code, three times over, and that
    // delivery can never be verified by the customer who actually holds the
    // digits. The likeliest explanation by far is a mistyped order number, so
    // say which one they are carrying rather than which code was wrong.
    if (paired && target && !holding.some((o) => o.orderNo === target.orderNo)) {
      return reply(
        [
          `${target.orderNo} is not with you.`,
          '',
          ...(holding.length === 0
            ? ['You are not carrying anything right now.', 'Send `jobs` to see what there is to uplift.']
            : [
                `You have ${holding.map((o) => o.orderNo).join(', ')}.`,
                '',
                `Check the order number and send it again, like \`${String(
                  Number((holding[0]?.orderNo ?? '').replace(/[^0-9]/g, '')),
                )} ${paired[2]}\`.`,
              ]),
        ].join(chr10),
      );
    }

    if (target && (paired || bare)) {
      const typed = (paired ? paired[2] : bare?.[1]) ?? '';
      const outcome = repo.verifyDeliveryCode(target.orderNo, typed);

      // Verified, so the gate further down now opens and the ordinary
      // delivered path runs. One route to a delivered order, not two.
      if (outcome === 'verified' || outcome === 'already') {
        return handleDriverMessage(`${target.orderNo} delivered`, phone);
      }

      if (outcome === 'wrong') {
        const left = repo.codeAttemptsLeft(target.orderNo);
        return [
          {
            kind: 'buttons',
            text: [
              `❌ That is not the code for ${target.orderNo}.`,
              '',
              `Ask ${target.customerName.split(/\s+/)[0] || 'the customer'} to read it from our message. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
            ].join(chr10),
            buttons: [noCodeButton(target.orderNo)],
          },
        ];
      }

      // An order that never had a code is not a code that went unconfirmed.
      //
      // These are two different facts and the whole value of the unverified
      // count rests on keeping them apart - which this branch collapsed,
      // warning dispatch that a code "could not be confirmed" on orders that
      // never had one, and then forcing a delivery off what may well have been
      // a mistyped message. Say so instead, and let them close it the ordinary
      // way if that is what they meant.
      if (outcome === 'none') {
        const n = String(Number(target.orderNo.replace(/[^0-9]/g, '')));
        return reply(
          [
            `No code is needed on ${target.orderNo}.`,
            '',
            `Send \`${n} delivered\` to close it.`,
          ].join(chr10),
        );
      }

      // Spent: there was a code, and it is now exhausted. Nothing left to
      // prove, so the delivery goes through rather than somebody standing at a
      // door - and dispatch is told, truthfully this time.
      repo.giveUpOnCode(target.orderNo);
      await warnStaff(unverifiedWarning(target, phone, 'the code could not be confirmed'));
      return handleDriverMessage(`${target.orderNo} delivered`, phone);
    }

    // Four digits and nothing waiting on a code. Answered here rather than
    // left to fall through to the order-number parser below, which would read
    // `2149` as order 2149 - a different order, or none. A code attempt must
    // never be capable of moving some other order, whatever the digits are.
    if (bare && !paired && awaiting.length === 0) {
      const mine = holding.map((o) => o.orderNo);
      return reply(
        mine.length === 0
          ? [
              `Nothing of yours is waiting on a code.`,
              '',
              'Send `jobs` to see what there is to uplift.',
            ].join(chr10)
          : [
              `No code is needed on ${mine.join(', ')}.`,
              '',
              `Send \`${String(Number((mine[0] ?? '').replace(/[^0-9]/g, '')))} delivered\` to close it.`,
            ].join(chr10),
      );
    }

    if (noCode) {
      // A doubled backslash here once made this `\\s` and `\\d` - a regex that
      // matches nothing, so `80 no code` from the button never found order 80
      // and silently fell back to whatever the associate happened to be
      // holding. Right while they held exactly one job, wrong the moment
      // they held two.
      const named = trimmed.match(/(?:ord[-\s]?)?0*(\d{1,6})/i);
      const which = named ? repo.findOrder(named[1] ?? '') : (awaiting[0] ?? null);
      if (which && (which.status === 'cancelled' || which.status === 'delivered')) {
        return reply(terminalMessage(which, 'driver'));
      }
      if (which) {
        repo.giveUpOnCode(which.orderNo);
        await warnStaff(unverifiedWarning(which, phone, 'the customer could not give the code'));
        return handleDriverMessage(`${which.orderNo} delivered`, phone);
      }
    }
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
  // One delivery at a time, and the refusal doubles as the reminder.
  //
  // Somebody already carrying food across town cannot also be collecting from
  // another kitchen, and a second job is how both arrive cold. The default is
  // one; MAX_JOBS_PER_ASSOCIATE raises it, and 0 switches the limit off.
  //
  // The cost, stated plainly: two orders from the same kitchen are one trip,
  // and this refuses the second. An associate standing at that counter is the
  // right person for it. Raise the limit to 2 if that trade is worth more than
  // the certainty of knowing exactly what each associate is holding.
  if (
    status === 'on_the_way' &&
    config.maxJobsPerAssociate > 0 &&
    order.driverPhone !== phone.replace(/[^0-9]/g, '') &&
    holding.length >= config.maxJobsPerAssociate
  ) {
    return reply(
      [
        `🛑 Finish ${holding.map((o) => o.orderNo).join(', ')} first.`,
        '',
        // What is still out, in full, because the reminder is only useful if
        // it says where to go - and the card that said so is now buried up
        // the chat under everything that has happened since.
        ...holding.flatMap((o) => [
          `*${o.orderNo}* — ${o.recipientName || o.customerName}`,
          ...(o.address ? [o.address] : []),
          `📞 +${o.recipientPhone || o.contactPhone || o.phone}`,
          ...(o.location ? [mapsLink(o.location)] : ['⚠️ No pin — ring them']),
          `Collect ${money(o.total)} cash`,
          '',
        ]),
        `${order.orderNo} stays where it is — someone else can take it, or come back for it.`,
      ].join(chr10),
    );
  }

  // Uplifting food nobody has prepared is how an order gets marked delivered
  // while it is still in a fryer.
  //
  // Only the stages BEFORE ready, which is the whole of it. Written as
  // "not ready" this also caught an order already on its way - which the
  // kitchen can now put there itself - and answered a delivery associate
  // tapping Uplifted on their own job card with "wait for the kitchen to
  // mark it ready",
  // about an order the kitchen had marked ready some minutes earlier.
  if (status === 'on_the_way' && order.outlet && ['pending', 'confirmed'].includes(order.status)) {
    return reply(
      `${order.orderNo} is ${STATUS_LABEL[order.status]} — wait for the kitchen to mark it ready.`,
    );
  }
  // Somebody else got there first - most often the kitchen, which can now
  // report the uplift itself. Saying only "already on the way" would leave
  // the associate holding the food with no Delivered button and no drop
  // details, since both of those ride on the message their own tap produces.
  // So they get that message anyway.
  if (order.status === status) {
    const already = nextActions(order.orderNo, status, 'driver', {
      codeExpected: repo.deliveryCodeExpected(order.orderNo),
    });
    const text =
      status === 'on_the_way'
        ? onTheWayCard(order)
        : `${order.orderNo} is already ${STATUS_LABEL[status]}.`;
    return already.length > 0
      ? [{ kind: 'buttons', text, buttons: already }]
      : reply(text);
  }

  if (status === 'on_the_way' && phone) repo.assignDriver(order.orderNo, phone);

  // The door code, asked for instead of completing the delivery.
  //
  // Only when the customer actually has it. An order whose code never left the
  // building - dispatched outside WhatsApp's 24-hour window, where the fixed
  // template cannot carry digits - must not be held up for digits nobody was
  // given, or every such delivery reads as a failed verification by somebody
  // who did nothing wrong.
  // Reachable by typing `7 delivered`, which still works and still has to be
  // answered - the button is gone from the card, the word is not gone from the
  // language.
  if (status === 'delivered' && repo.deliveryCodeExpected(order.orderNo)) {
    const who = order.customerName.split(/\s+/)[0] || 'the customer';
    return [
      {
        kind: 'buttons',
        text: [
          `🔐 *${order.orderNo}* — ask ${who} for their delivery code.`,
          '',
          'Type the four digits to close the order.',
        ].join(chr10),
        buttons: [noCodeButton(order.orderNo)],
      },
    ];
  }

  // A completed delivery is the one position we never have to ask for: they
  // were demonstrably at that doorstep when they tapped the button.
  if (status === 'delivered' && phone && order.location) {
    repo.saveAssociateLocation(phone, order.location, 'delivery');
  }

  const { body, status: landed } = await applyStatus(order, status, 'driver');
  // Read after the move, not before: the code is sent to the customer by the
  // very notification that `applyStatus` fires, so asked before it this would
  // always say no and the card would carry a Delivered button it should not.
  const actions = nextActions(order.orderNo, landed, 'driver', {
    codeExpected: repo.deliveryCodeExpected(order.orderNo),
  });

  // The food is in the bag and only the drop is left, so this message is the
  // one they will work from. WhatsApp cannot retire the job card above it, so
  // the newest message has to be worth more than scrolling back - the address,
  // the phone, the pin and the cash, repeated where they are now needed.
  const fresh = repo.findOrder(order.orderNo) ?? order;
  const shown = landed === 'on_the_way' ? onTheWayCard(fresh) : body;

  // No map card. The card itself opens with a link to the pin, announced as
  // such, which is one message instead of two and puts the thing they act on
  // at the bottom of the chat where they come back to it.
  const out: OutboundMessage[] = [];

  out.push(
    ...(actions.length > 0
      ? ([{ kind: 'buttons', text: shown, buttons: actions }] as OutboundMessage[])
      : reply(shown)),
  );

  return out;
}

const describeForDriver = (o: repo.OrderRecord): string => {
  // Cancelled or delivered: there is no money to take. Printing "Collect
  // $235,000 cash" under the word *cancelled* is an instruction and a
  // contradiction on the same card, and the instruction is the line somebody
  // acts on.
  const settled = o.status === 'cancelled' || o.status === 'delivered';
  return [
    `*${o.orderNo}* — ${STATUS_LABEL[o.status]}`,
    ...(o.outlet ? [`Pick up: ${o.outlet.name}${o.outlet.pickupAddress ? `, ${o.outlet.pickupAddress}` : ''}`] : []),
    `To: ${o.recipientName || o.customerName}`,
    ...(o.address ? [o.address] : []),
    `📞 +${o.recipientPhone || o.contactPhone || o.phone}`,
    ...(settled ? [] : o.location ? [mapsLink(o.location)] : ['⚠️ No pin — ring the customer']),
    settled
      ? o.status === 'cancelled'
        ? 'Nothing to collect — this one is cancelled.'
        : 'Nothing to collect — already delivered.'
      : `Collect ${money(o.total)} cash`,
  ].join('\n');
};

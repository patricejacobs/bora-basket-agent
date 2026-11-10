import { config, money } from '../config.ts';
import * as repo from '../db/repo.ts';
import { serviceContextLine, SERVICES, type Service } from '../services.ts';
import { shopStatus } from '../hours.ts';

export { shopStatus, hoursStatus, type ShopStatus } from '../hours.ts';

const isService = (v: string): v is Service => (SERVICES as readonly string[]).includes(v);
import { checkRange, formatDistance } from '../location.ts';

/**
 * Per-conversation context: what time it is locally, and who this customer is.
 *
 * This is deliberately NOT part of the system prompt. The system prompt is the
 * cached prefix, and a clock in it would invalidate the cache on every single
 * message — slower and more expensive on every turn. It goes in the messages
 * array instead, where it costs nothing to vary.
 */
export const CONTEXT_MARKER = '[Shop context';

/**
 * The clock, refreshed on every turn.
 *
 * A conversation can run for hours, and a time fixed at the first message drifts
 * — "we close in 40 minutes" is wrong an hour later, and "tomorrow" changes
 * meaning at midnight. Kept separate from the customer details below, which do
 * not change mid-conversation and would nag if repeated every turn.
 */
export function buildTimeContext(): string {
  const lines = [
    `${CONTEXT_MARKER} — the customer cannot see this]`,
    `Local time: ${localTime()} — ${partOfDay()}.`,
  ];
  const status = shopStatus();
  if (status.state === 'closed') {
    // Framed around deliveries, not shutters. "We're closed" reads as go away,
    // and the shop loses an order it could perfectly well have filled at eight;
    // "deliveries start at 8" is the same fact and keeps the customer shopping.
    const next = status.opensAt ? `start at ${status.opensAt}` : 'have not started yet';
    const opening =
      status.phase === 'before'
        ? `Deliveries ${next}.`
        : status.phase === 'after'
          ? `Deliveries have finished for today — they ${next}.`
          : `No deliveries today — they ${next}.`;
    lines.push(
      `${opening} Take the order as normal and tell them it goes out from then. Say it that way round: talk about when deliveries run, never about the shop being shut, and never turn them away.`,
    );
  } else if (status.state === 'open' && status.closesInMinutes <= 60) {
    lines.push(
      `The shop closes in about ${status.closesInMinutes} minutes — mention it if they are still browsing.`,
    );
  }
  // 'unknown' deliberately says nothing. Silence is recoverable; telling someone
  // the shop is shut when it is open is not.
  return lines.join('\n');
}

/** The clock, the chosen service and anything parked — every turn after the first. */
export function buildTurnContext(phone: string): string {
  return [buildTimeContext(), serviceLine(phone), parkedLine(phone)].filter(Boolean).join('\n');
}

/**
 * Carts the customer set aside earlier.
 *
 * On every turn, because the moment to offer one back is unpredictable — they
 * may say "and what about my groceries?" twenty messages into a food order, and
 * an agent that has forgotten the list exists will tell them it is gone.
 */
function parkedLine(phone: string): string | null {
  const parked = repo.listParkedCarts(phone);
  if (parked.length === 0) return null;

  const described = parked
    .map((p) => `${p.label} (${p.itemCount} item${p.itemCount === 1 ? '' : 's'})`)
    .join('; ');
  return `Set aside earlier, not lost: ${described}. Offer it back when it fits — resume_parked_cart brings it into the cart, and the cart must be empty first.`;
}

/**
 * The service the customer picked, restated on every turn.
 *
 * On every turn and not just the first: the choice is the one thing that must
 * not drift. Twenty messages into a parcel job, a model that has forgotten
 * which service it is in starts searching the grocery catalogue.
 */
function serviceLine(phone: string): string | null {
  const service = repo.getService(phone);
  if (!service || !isService(service)) return null;
  return serviceContextLine(service);
}

export function buildConversationContext(phone: string): string {
  const lines: string[] = [buildTimeContext()];
  const service = serviceLine(phone);
  if (service) lines.push(service);
  const parked = parkedLine(phone);
  if (parked) lines.push(parked);

  const customer = repo.getCustomer(phone);
  const orders = repo.recentOrders(phone, 1);
  const last = orders[0];

  // A pin with no name and no orders still counts as knowing them: someone who
  // shared their location last week and never finished should not be asked for
  // it again from scratch.
  if (!customer.name && !customer.location && !last) {
    lines.push('This is a new customer with no order history. Introduce the shop briefly.');
    lines.push(
      'They have shared no location pin. Every delivery needs one — call request_location as soon as they start ordering, and keep shopping going in the meantime.',
    );
    return lines.join('\n');
  }

  if (customer.name) lines.push(`Customer: ${customer.name}. Greet them by first name once.`);

  // The pin, not the typed address, is what the delivery goes to — so it is
  // what gets read back for confirmation. Said in words, never in coordinates.
  if (customer.location) {
    const where = customer.location.label
      ? `the pin they shared at ${customer.location.label}`
      : 'the pin they shared before';
    lines.push(
      `Location pin on file: ${where}. Do not ask for a new one unless they say they are somewhere else — just check it is still the right place before ordering.`,
    );
    // Said up front rather than left for checkout to discover. The alternative
    // is letting someone fill a cart the shop was never going to deliver.
    const range = checkRange(customer.location, config.store.serviceArea);
    if (range.state === 'outside') {
      lines.push(
        `That pin is ${formatDistance(range.distanceKm)} from the shop, outside the ${range.radiusKm} km delivery area, so no order can be placed to it. Say so early and warmly, and tell them staff will confirm whether a delivery associate can reach them.`,
      );
    }
  } else {
    lines.push(
      'No location pin on file. They will need to share one before an order can be placed — use request_location once they start ordering.',
    );
  }

  if (customer.address) {
    lines.push(`Doorstep notes on file: ${customer.address}. Do not ask for them again.`);
  }

  if (last) {
    const items = last.items.map((i) => `${i.qty} x ${i.name}`).join(', ');
    lines.push(
      `Last order ${last.orderNo} (${relativeDay(last.placedAt)}): ${items} — ${money(last.total)}.`,
    );
    lines.push(
      'If they seem to want a routine shop, offer to repeat that order rather than starting from scratch.',
    );
  }

  return lines.join('\n');
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: config.store.timezone });
}

function localTime(): string {
  return formatter({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}

/**
 * Which greeting the hour calls for, stated outright.
 *
 * The local time alone leaves the model to do the arithmetic, and "8:15 pm"
 * occasionally came back as "Good afternoon". Naming it removes the guess.
 */
function partOfDay(): string {
  const hour = Number(
    formatter({ hour: '2-digit', hour12: false }).formatToParts(new Date()).find((p) => p.type === 'hour')
      ?.value,
  );
  if (!Number.isFinite(hour)) return 'greet without naming the time of day';
  // Some ICU builds render midnight as 24 rather than 00.
  if (hour < 12 || hour === 24) return 'greet with "Good morning"';
  if (hour < 17) return 'greet with "Good afternoon"';
  return 'greet with "Good evening"';
}

/** "yesterday", "3 days ago", "on 14 August" — how a person would say it. */
function relativeDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'previously';

  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return `on ${formatter({ day: 'numeric', month: 'long' }).format(then)}`;
}

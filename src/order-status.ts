/**
 * Order lifecycle vocabulary, shared by the staff commands and the notifier.
 *
 * Lives in its own module because both sides need it and they already import
 * each other in one direction — putting it in either would make a cycle.
 */
import type { OrderStatus } from './db/repo.ts';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'new, not yet confirmed',
  confirmed: 'confirmed',
  ready: 'cooked, waiting for a rider',
  on_the_way: 'on the way',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/**
 * What each status means to the customer, in the shop's voice.
 *
 * Separate from STATUS_LABEL, which is written for a dispatcher reading a queue.
 * "new, not yet confirmed" is the right words for staff and the wrong ones for
 * the person waiting on their groceries.
 */
export const CUSTOMER_STATUS: Record<OrderStatus, string> = {
  pending: 'received, waiting for the shop to confirm it',
  confirmed: 'confirmed and being prepared',
  ready: 'ready, waiting for the driver to collect it',
  on_the_way: 'out with the driver',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/**
 * "just now", "about 2 hours ago", "yesterday" — how long since a timestamp.
 *
 * Given to the model as words rather than as an ISO string it has to subtract
 * from the clock. An order that is three hours old and one that is three days
 * old want different answers, and arithmetic is a poor place to be approximate.
 */
export function describeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'at an unknown time';

  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 0) return 'just now';
  if (minutes < 5) return 'just now';
  if (minutes < 60) return `about ${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(minutes / 1440);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/* ------------------------------------------------------- cancel reasons */

/**
 * Why an order was cancelled.
 *
 * "Cancelled" on its own tells the customer nothing and tells you less. A
 * kitchen that ran out of goat, a kitchen that is slammed, and an address
 * nobody can reach are three different problems — the first is a stock note,
 * the second is a capacity one, and the third is yours to fix. Recorded so the
 * pattern is visible later, and said to the customer in words that explain
 * rather than just apologise.
 */
export type CancelReason = {
  key: string;
  /** Button title, which is also the typed command. WhatsApp caps these at 20. */
  title: (shortNo: string) => string;
  /** What a person might type instead of tapping. */
  match: RegExp;
  /** Who may give this reason. */
  audiences: Audience[];
  /** How it reads in the shop's own records. */
  internal: string;
  /** What the customer is told, as the end of "...because ___". */
  customer: string;
};

export const CANCEL_REASONS: CancelReason[] = [
  {
    key: 'sold_out',
    title: (n) => `${n} sold out`,
    match: /\b(sold\s*out|out\s*of\s*stock|ran\s*out|finished)\b/i,
    audiences: ['outlet', 'staff'],
    internal: 'Kitchen ran out',
    customer: 'the kitchen has run out of something on it',
  },
  {
    key: 'too_busy',
    title: (n) => `${n} too busy`,
    match: /\b(too\s*busy|busy|slammed|backed\s*up)\b/i,
    audiences: ['outlet', 'staff'],
    internal: 'Kitchen too busy',
    customer: 'the kitchen is too backed up to take it right now',
  },
  {
    key: 'closing',
    title: (n) => `${n} closing`,
    match: /\b(closing|closed|shutting)\b/i,
    audiences: ['outlet', 'staff'],
    internal: 'Kitchen closing',
    customer: 'the kitchen is closing for the day',
  },
  {
    key: 'customer',
    title: (n) => `${n} cust changed`,
    match: /\b(customer|cust|changed\s*mind|they\s*cancelled)\b/i,
    audiences: ['staff'],
    internal: 'Customer changed their mind',
    customer: 'you asked us to',
  },
  {
    key: 'undeliverable',
    title: (n) => `${n} cant deliver`,
    match: /\b(can'?t\s*deliver|cannot\s*deliver|no\s*rider|out\s*of\s*area|too\s*far)\b/i,
    audiences: ['staff'],
    internal: 'Could not be delivered',
    customer: 'we cannot get to that address at the moment',
  },
];

/** The reason named in a message, if any. */
export function findCancelReason(text: string): CancelReason | null {
  return CANCEL_REASONS.find((r) => r.match.test(text)) ?? null;
}

/**
 * The reasons offered as buttons.
 *
 * Three at most, because WhatsApp allows no more — so these are the common
 * ones and anything else is typed. The titles are valid commands, so a tap and
 * a typed reason go through one parser.
 */
export function cancelButtons(orderNo: string, audience: Audience): { id: string; title: string }[] {
  const n = String(Number(orderNo.replace(/[^0-9]/g, '')));
  return CANCEL_REASONS.filter((r) => r.audiences.includes(audience))
    // Reasons only this audience can give come first. Three slots fill quickly
    // with the shared ones, and staff would otherwise never be offered
    // "customer changed their mind" — the reason they use most.
    .sort((a, b) => a.audiences.length - b.audiences.length)
    .slice(0, 3)
    .map((r) => ({ id: `cancel_${r.key}_${n}`, title: r.title(n) }));
}

/** Words a dispatcher might actually type, mapped to a status. */
export const STATUS_WORDS: [RegExp, OrderStatus][] = [
  // "collected" and "picked up" mean a rider has the food and is moving, which
  // is the same state as on the way for everyone downstream.
  [
    /\b(on\s*the\s*way|otw|out\s*for\s*delivery|dispatched|sending|gone|collected|picked\s*up)\b/i,
    'on_the_way',
  ],
  [/\b(delivered|done|complete[d]?|dropped)\b/i, 'delivered'],
  // Before 'confirmed', so a kitchen typing "food ready" is not read as
  // "ready to confirm" and the rider is not sent to an empty counter.
  [/\b(ready|cooked|food\s*up)\b/i, 'ready'],
  [/\b(confirm(ed)?|accept(ed)?|packing|preparing)\b/i, 'confirmed'],
  [/\b(cancel(led)?|void)\b/i, 'cancelled'],
];

/**
 * The next sensible actions for an order, as tappable buttons.
 *
 * The titles are deliberately valid staff commands. Tapping a WhatsApp reply
 * button sends its title back as an ordinary message, so the same parser handles
 * a tap and a typed command with no special case — and the buttons still work in
 * the browser simulator.
 *
 * WhatsApp allows at most 3 buttons with 20-character titles.
 */
/**
 * Who is holding the phone. The same order offers different next steps to a
 * kitchen, a rider and the shop, and showing a cook a "Delivered" button invites
 * an order being closed from behind a fryer.
 */
export type Audience = 'staff' | 'outlet' | 'driver';

export function nextActions(
  orderNo: string,
  status: OrderStatus,
  audience: Audience = 'staff',
): { id: string; title: string }[] {
  // "ORD-00007" -> "7": dispatchers read the short form, and it keeps titles
  // inside the 20-character limit.
  const n = String(Number(orderNo.replace(/[^0-9]/g, '')));

  const confirm = { id: `confirm_${n}`, title: `Confirm ${n}` };
  const ready = { id: `ready_${n}`, title: `Food ready ${n}` };
  const otw = { id: `otw_${n}`, title: `On the way ${n}` };
  const collected = { id: `otw_${n}`, title: `Collected ${n}` };
  const delivered = { id: `delivered_${n}`, title: `Delivered ${n}` };
  const cancel = { id: `cancel_${n}`, title: `Cancel ${n}` };

  // A kitchen only ever accepts, says the food is up, or hands it back. It never
  // dispatches or closes an order — that is the rider's end of the job.
  if (audience === 'outlet') {
    switch (status) {
      case 'pending':
        return [confirm, cancel];
      case 'confirmed':
        return [ready, cancel];
      default:
        return [];
    }
  }

  // A rider collects and delivers. Nothing else is theirs to decide.
  if (audience === 'driver') {
    switch (status) {
      case 'ready':
        return [collected];
      case 'on_the_way':
        return [delivered];
      default:
        return [];
    }
  }

  switch (status) {
    case 'pending':
      return [confirm, otw, cancel];
    case 'confirmed':
      return [ready, otw, cancel];
    case 'ready':
      return [otw, cancel];
    case 'on_the_way':
      return [delivered];
    default:
      // Delivered and cancelled orders are finished; nothing to offer.
      return [];
  }
}

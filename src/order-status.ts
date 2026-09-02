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
  confirmed: 'confirmed and being packed',
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

/** Words a dispatcher might actually type, mapped to a status. */
export const STATUS_WORDS: [RegExp, OrderStatus][] = [
  [/\b(on\s*the\s*way|otw|out\s*for\s*delivery|dispatched|sending|gone)\b/i, 'on_the_way'],
  [/\b(delivered|done|complete[d]?|dropped)\b/i, 'delivered'],
  [/\b(confirm(ed)?|accept(ed)?|packing)\b/i, 'confirmed'],
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
export function nextActions(
  orderNo: string,
  status: OrderStatus,
): { id: string; title: string }[] {
  // "ORD-00007" -> "7": dispatchers read the short form, and it keeps titles
  // inside the 20-character limit.
  const n = String(Number(orderNo.replace(/[^0-9]/g, '')));

  switch (status) {
    case 'pending':
      return [
        { id: `confirm_${n}`, title: `Confirm ${n}` },
        { id: `otw_${n}`, title: `On the way ${n}` },
        { id: `cancel_${n}`, title: `Cancel ${n}` },
      ];
    case 'confirmed':
      return [
        { id: `otw_${n}`, title: `On the way ${n}` },
        { id: `cancel_${n}`, title: `Cancel ${n}` },
      ];
    case 'on_the_way':
      return [{ id: `delivered_${n}`, title: `Delivered ${n}` }];
    default:
      // Delivered and cancelled orders are finished; nothing to offer.
      return [];
  }
}

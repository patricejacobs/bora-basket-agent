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

/**
 * Watching for orders that have stopped moving.
 *
 * Every other stage of an order has somebody waiting on it who will chase. A
 * kitchen chases a ticket it has not been paid for; a customer chases a meal
 * that has not arrived. "Cooked, waiting for a delivery associate" has nobody watching it —
 * the order is not late in the database, it is in a perfectly normal status —
 * which is how food goes cold on a counter while everything reports as fine.
 * The first person to notice is the customer, and by then it is a complaint.
 *
 * This is a sweep rather than a timer per order, deliberately. Timers die with
 * the process, so a deploy at 7:30pm would silently cancel the alarm set at
 * 7:21pm and nobody would ever know. The state lives in the database instead,
 * and the next sweep after a restart picks up exactly where it left off.
 */
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { sendText } from './channels/whatsapp-send.ts';
import { STATUS_LABEL } from './order-status.ts';

/** What staff are told to do about each kind of stall. */
function chase(order: repo.OrderRecord): string {
  switch (order.status) {
    case 'pending':
      return order.outlet
        ? `${order.outlet.name} has not accepted it. Ring the kitchen — they may not have seen the ticket.`
        : 'Nobody has confirmed it yet.';
    case 'ready':
      return order.outlet
        ? `Cooked and sitting at ${order.outlet.name}. No delivery associate has uplifted it.`
        : 'Packed and waiting. No delivery associate has uplifted it.';
    case 'on_the_way':
      return 'With a delivery associate and still not delivered. Ring them.';
    default:
      return 'Not moving.';
  }
}

function describe(stalled: repo.StalledOrder): string {
  const { order, minutes } = stalled;
  const howLong = minutes >= 120 ? `${Math.floor(minutes / 60)} hours` : `${minutes} minutes`;

  return [
    `⏰ *${order.orderNo}* stuck — ${STATUS_LABEL[order.status]} for ${howLong}`,
    '',
    chase(order),
    '',
    `${order.kind === 'parcel' ? order.recipientName : order.customerName} · +${order.contactPhone || order.phone}`,
    ...(order.total > 0 ? [`${money(order.total)} to collect`] : []),
  ].join('\n');
}

/**
 * One pass. Returns how many stalls were reported, for the caller to log.
 *
 * Each order is stamped before the message goes out rather than after: a send
 * that throws must not leave the order eligible to be reported again on the
 * next sweep, two minutes later, and every two minutes after that.
 */
export async function sweepStalls(): Promise<number> {
  if (config.stalls.readyMinutes <= 0) return 0;

  const stalled = repo.stalledOrders(config.stalls);
  if (stalled.length === 0) return 0;

  if (config.staffNumbers.length === 0) {
    // Still stamped, or the warning repeats on every sweep forever.
    for (const s of stalled) repo.markStallAlerted(s.order.orderNo);
    console.warn(
      `[stalls] ${stalled.length} order(s) have stopped moving but STAFF_NUMBERS is empty — nobody was told`,
    );
    return 0;
  }

  for (const s of stalled) {
    repo.markStallAlerted(s.order.orderNo);
    const body = describe(s);
    console.warn(`[stalls] ${s.order.orderNo} stuck in ${s.order.status} for ${s.minutes}m`);
    for (const staff of config.staffNumbers) {
      try {
        await sendText(staff, body);
      } catch (err) {
        console.error(`[stalls] could not tell ${staff} about ${s.order.orderNo}:`, err);
      }
    }
  }
  return stalled.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startStallWatch(): void {
  if (timer) return;
  if (config.stalls.readyMinutes <= 0) {
    console.log('[stalls] watching is off (STALL_ALERT_MINUTES=0)');
    return;
  }

  const every = Math.max(30, config.stalls.sweepSeconds) * 1000;
  timer = setInterval(() => {
    void sweepStalls().catch((err) => console.error('[stalls] sweep failed:', err));
  }, every);
  // Nothing should be kept alive by this alone; a process with no other work
  // has no orders to watch either.
  timer.unref?.();

  console.log(
    `[stalls] watching every ${Math.round(every / 1000)}s — unconfirmed ${config.stalls.pendingMinutes}m, uncollected ${config.stalls.readyMinutes}m, undelivered ${config.stalls.deliveryMinutes}m`,
  );
}

export function stopStallWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

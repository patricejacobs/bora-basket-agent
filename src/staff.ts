/**
 * Staff commands over the same WhatsApp number.
 *
 * Deliberately parsed rather than run through the model: a dispatcher moving
 * twenty orders wants the same words to do the same thing every time, instantly
 * and at no cost per message. Conversation is the wrong tool for a work queue.
 */
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { notifyCustomerOfStatus } from './notifications.ts';
import { STATUS_LABEL, STATUS_WORDS, nextActions } from './order-status.ts';
import type { OutboundMessage } from './channels/types.ts';

export const isStaff = (phone: string): boolean => config.staffNumbers.includes(phone);

const HELP = [
  '*Staff commands*',
  '',
  '`orders` — list open orders',
  '`7 confirmed` — accept order 7',
  '`7 on the way` — dispatch, customer is told',
  '`7 delivered` — close it, customer is told',
  '`7 cancel` — cancel it',
  '`7` — show one order',
  '',
  '`wanted` — what customers asked for and we did not have',
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
    `${o.customerName}, ${o.address}`,
    `📞 +${o.contactPhone || o.phone}`,
    ...(o.deliveryNote ? [`Note: ${o.deliveryNote}`] : []),
  ].join('\n');

/** Never throws — a staff member always gets a readable answer. */
export async function handleStaffMessage(text: string): Promise<OutboundMessage[]> {
  const reply = (t: string): OutboundMessage[] => [{ kind: 'text', text: t }];
  const trimmed = text.trim();

  if (/^(help|\?|commands)$/i.test(trimmed)) return reply(HELP);

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

  const matched = STATUS_WORDS.find(([pattern]) => pattern.test(trimmed));
  if (!matched) return reply(describe(order));

  const status = matched[1];
  if (order.status === status) {
    return reply(`${order.orderNo} is already ${STATUS_LABEL[status]}.`);
  }

  repo.setOrderStatus(order.orderNo, status);
  const updated = { ...order, status };

  let told: string;
  try {
    const how = await notifyCustomerOfStatus(updated, status);
    told =
      how === 'skipped'
        ? '⚠️ Customer NOT notified — outside the 24h window and no template set up.'
        : `Customer notified${how === 'template' ? ' (via template)' : ''}.`;
  } catch (err) {
    console.error('[staff] failed to notify customer:', err);
    told = '⚠️ Status saved, but notifying the customer failed.';
  }

  const body = `${order.orderNo} → *${STATUS_LABEL[status]}*.\n${told}`;
  const actions = nextActions(order.orderNo, status);
  return actions.length > 0 ? [{ kind: 'buttons', text: body, buttons: actions }] : reply(body);
}

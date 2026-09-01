import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { sendText, sendButtons, sendTemplate } from './channels/whatsapp-send.ts';
import { nextActions } from './order-status.ts';

/**
 * Tells the shop an order came in.
 *
 * Without this an order lands in the database and nobody finds out, which is
 * the difference between a demo and a shop that can trade.
 */
export async function notifyStaffOfNewOrder(orderNo: string): Promise<void> {
  if (config.staffNumbers.length === 0) {
    console.warn(`[notify] ${orderNo} placed but STAFF_NUMBERS is empty — nobody was told`);
    return;
  }

  const order = repo.findOrder(orderNo);
  if (!order) return;

  const lines = [
    `🛒 *New order ${order.orderNo}*`,
    '',
    ...order.items.map((i) => `${i.qty} x ${i.name} — ${money(i.lineTotal)}`),
    '',
    `*Total ${money(order.total)}* (${order.status === 'pending' ? 'unconfirmed' : order.status})`,
    '',
    `${order.customerName}`,
    `${order.address}`,
    `📞 +${order.phone}`,
  ];
  if (order.deliveryNote) lines.push(`Note: ${order.deliveryNote}`);

  const body = lines.join('\n');
  const actions = nextActions(order.orderNo, order.status);

  for (const staff of config.staffNumbers) {
    // Buttons so dispatch is a tap rather than a typed command. Their titles are
    // themselves valid commands, so tapping and typing go through one parser and
    // anyone who prefers typing still can.
    if (actions.length > 0) await sendButtons(staff, body, actions);
    else await sendText(staff, body);
  }
}

/**
 * Tells the customer their order moved.
 *
 * WhatsApp only allows free-form messages within 24 hours of the customer's last
 * message. Outside that window an approved template is the only route, so this
 * picks automatically and says plainly when neither is possible.
 */
export async function notifyCustomerOfStatus(
  order: repo.OrderRecord,
  status: repo.OrderStatus,
): Promise<'text' | 'template' | 'skipped'> {
  const firstName = order.customerName.split(/\s+/)[0] ?? order.customerName;

  const freeForm: Partial<Record<repo.OrderStatus, string>> = {
    confirmed: `Thanks ${firstName} — order ${order.orderNo} is confirmed. We'll let you know when it's on the way.`,
    on_the_way: `${firstName}, your order ${order.orderNo} is on its way 🛵\nTotal ${money(order.total)}, payable to the driver.`,
    delivered: `Order ${order.orderNo} delivered. Thanks for shopping with ${config.store.name}!`,
    cancelled: `Order ${order.orderNo} has been cancelled. Message us here if that's not right.`,
  };

  const message = freeForm[status];
  if (!message) return 'skipped';

  if (repo.withinServiceWindow(order.phone)) {
    await sendText(order.phone, message);
    return 'text';
  }

  const templateName =
    status === 'on_the_way'
      ? config.templates.onTheWay
      : status === 'delivered'
        ? config.templates.delivered
        : '';

  if (!templateName) {
    console.warn(
      `[notify] ${order.orderNo} → ${status}: outside the 24h window and no template configured, so the customer was not told`,
    );
    return 'skipped';
  }

  await sendTemplate(order.phone, templateName, [firstName, order.orderNo, money(order.total)]);
  return 'template';
}

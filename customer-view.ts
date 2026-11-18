/**
 * One grocery order, as it looks on the customer's phone.
 *
 *   node customer-view.ts
 *
 * Shopping by number, a timed delivery, and every message the customer gets
 * from hello to the receipt. Drives the real tools and the real notifier
 * against a throwaway database, so the prices, the order number, the delivery
 * code and the receipt are the shop's own output rather than a mock-up - and
 * nothing here can touch real trading data.
 *
 * The shop's lines are written to the rules in the system prompt. Everything
 * in a box, every figure and every status message comes from the code.
 */
process.env.DATABASE_PATH = process.env.TEMP + '/customer-view-' + Date.now() + '.db';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.DRIVER_NUMBERS = '18673464384';
process.env.STAFF_NUMBERS = '5926497570';
process.env.DELIVERY_FEE = '500';
process.env.STORE_HOURS = '24 hours';

const realLog = console.log;
console.log = (...a: unknown[]): void => {
  if (/^\[(db|config|catalog|menu|zones|whatsapp|notify|dispatch|outlets|duty|associates)\]/.test(a.map(String).join(' '))) return;
  realLog(...a);
};
console.warn = console.log;

const fs = await import('node:fs');
const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { importOutletsText } = await import('./src/catalog/import-menu.ts');
const { importCsvText } = await import('./src/catalog/import-csv.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { customerStatusMessage, deliveredMessage } = await import('./src/notifications.ts');
const { money } = await import('./src/config.ts');

importOutletsText(fs.readFileSync('data/outlets.csv', 'utf8'));
importCsvText(fs.readFileSync('data/sample-products.csv', 'utf8'));
// Somebody on the road, or no order can be placed at all.
repo.upsertAssociate({ phone: '18673464384', name: 'Wayne', vehicle: 'CJ 4410', active: true });
repo.setDuty('18673464384', true);

const nl = String.fromCharCode(10);
const WIDTH = 46;
const me = '5926129920';
repo.setService(me, 'grocery');

const call = (tool: string, args: Record<string, unknown> = {}): Record<string, unknown> =>
  JSON.parse(executeTool(tool, args, { phone: me, outbound: [] as never[] } as never)) as Record<string, unknown>;

/** The shop's message, wrapped the way a phone wraps it. */
const shop = (text: string): void => {
  realLog('');
  for (const line of text.split(nl)) {
    if (!line) {
      realLog('  |');
      continue;
    }
    for (const part of line.match(new RegExp(`.{1,${WIDTH}}(\\s|$)`, 'g')) ?? [line]) {
      realLog(`  | ${part.trimEnd()}`);
    }
  }
};
const them = (text: string): void => {
  realLog('');
  realLog(`${' '.repeat(18)}"${text}"  |`);
};
const beat = (what: string): void => {
  realLog('');
  realLog(`${' '.repeat(10)}· · · ${what} · · ·`);
};
const numbered = (rows: { number: number; name: string }[]): string =>
  rows.map((r) => `${r.number}. ${r.name}`).join(nl);

/* ------------------------------------------------------------------ hello */

shop('Good afternoon! 👋 I can get your groceries, food from a restaurant, or send a parcel. What are we doing today?');
them('groceries');

const aisles = (): string =>
  ['What are we getting today?', '', numbered(call('list_categories').categories as { number: number; name: string }[]), '', 'Reply with a number.'].join(nl);
shop(aisles());

/* ----------------------------------------------------------- an aisle */

them('3');
const dairy = call('browse_category', { category: '3' });
const priced = (rows: { ref: string; name: string; unit: string; price: string }[]): string =>
  rows.map((r) => `${r.ref}. ${r.name} — ${r.price} (${r.unit})`).join(nl);
shop(
  [
    `*${String(dairy.category)}*`,
    '',
    priced(dairy.items as { ref: string; name: string; unit: string; price: string }[]),
    '',
    'Put the quantity beside the letter, like *a x2, d x1* — or type *categories* to see the aisles again.',
  ].join(nl),
);

them('c x2, b x1');
const first = call('add_picks', { picks: [{ ref: 'c', quantity: 2 }, { ref: 'b', quantity: 1 }] });
shop(
  `In: ${(first.added as { name: string; quantity: number }[]).map((g) => `${g.quantity} x ${g.name}`).join(', ')}. That's ${String((first.cart as { subtotal: string }).subtotal)} so far.` +
    nl + nl + 'Anything else, or type *categories* for the aisles?',
);

/* --------------------------------------- back to the aisles, by name of it */

// The way out, which is why the line is on every aisle. Items are lettered
// and aisles numbered, so a stray "1" can no longer be read as the first
// product - but a customer still needs to be told how to get back.
them('categories');
shop(aisles());

them('1');
const produce = call('browse_category', { category: '1' });
const rows = produce.items as { ref: string; name: string; unit: string; price: string }[];
shop([`*${String(produce.category)}*`, '', priced(rows.slice(0, 6)), '…'].join(nl));

them('a x2 and k x3');
const second = call('add_picks', { picks: [{ ref: 'a', quantity: 2 }, { ref: 'k', quantity: 3 }] });
shop(`${(second.added as { name: string; quantity: number }[]).map((g) => `${g.quantity} x ${g.name}`).join(' and ')} added.${nl}${nl}That everything?`);

/* ------------------------------------------------------ who and where */

them('yes thats all');
shop("Lovely. Who's it for and where am I sending it?");
them('Patrice Jacobs, 26 Brickdam Georgetown');

const looked = call('delivery_zone', { text: '26 Brickdam, Georgetown' });
shop(`That's ${String(looked.matched)} — is that right?`);
them('yes');
const zone = call('delivery_zone', { place: String(looked.matched), confirmed: true });
repo.saveCustomer(me, { name: 'Patrice Jacobs', address: '26 Brickdam, Georgetown', contactPhone: me });
repo.confirmIdentity(me);

/* ------------------------------------------------------------- and when */

const cart = repo.getCart(me);
shop(
  [
    '*Your basket*',
    ...cart.lines.map((l) => `${l.qty} x ${l.product.name}`),
    '',
    `Goods ${money(cart.subtotal)}`,
    `Delivery ${String(zone.delivery_fee)}`,
    `*Total ${money(cart.total)}*, cash to the delivery associate.`,
    '',
    "When would you like it? I can send it as soon as it's packed, or hold it for a time that suits you.",
  ].join(nl),
);

them('after 5 please, im at work till then');

const five = new Date();
five.setHours(17, 0, 0, 0);
if (five.getTime() < Date.now()) five.setDate(five.getDate() + 1);
const placed = call('place_order', {
  payment_method: 'cash_on_delivery',
  deliver_at: five.toISOString(),
  deliver_note: 'after 5pm',
});
const no = String(placed.order_number ?? '');
if (!no) {
  realLog('');
  realLog(`  the order was refused: ${String(placed.error)}`);
  process.exit(1);
}
shop(`${String(placed.say)} That's for after 5pm.`);

/* -------------------------------------------------- and then it happens */

beat('the shop confirms it');
db.prepare(`UPDATE orders SET status = 'confirmed' WHERE order_no = ?`).run(no);
shop(customerStatusMessage(repo.findOrder(no)!, 'confirmed', 'en'));

beat('after five, an associate takes it');
db.prepare(`UPDATE orders SET status = 'on_the_way' WHERE order_no = ?`).run(no);
repo.markCodeSent(no);
shop(customerStatusMessage(repo.findOrder(no)!, 'on_the_way', 'en'));

beat('at the door, the code checks out');
repo.verifyDeliveryCode(no, repo.deliveryCodeFor(no));
db.prepare(`UPDATE orders SET status = 'delivered' WHERE order_no = ?`).run(no);
repo.recordEvent(no, 'delivered', '18673464384', 'code verified');
shop(deliveredMessage(repo.findOrder(no)!, 'en'));
realLog('');

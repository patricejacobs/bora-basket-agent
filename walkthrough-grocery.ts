/**
 * An end-to-end walkthrough of one GROCERY order, printed as the messages each
 * person actually receives.
 *
 *   node walkthrough-grocery.ts
 *
 * The sister of walkthrough.ts, which follows a restaurant order. This one
 * follows a bag packed off your own shelves, so it shows the piece that has no
 * equivalent in the restaurant journey: the picking ticket that goes to
 * GROCERY_NUMBER the moment the order is placed.
 *
 * Not a test — the suite is the test. This exists to be read: it drives the
 * real handlers against a scratch database and shows what comes out.
 */
import fs from 'node:fs';
import path from 'node:path';

// Point at a scratch database before anything reads the config, and set the
// three numbers the journey needs. Done here rather than in .env so the
// walkthrough reads the same for everybody who runs it.
const WALK_DB = path.resolve('./data/walk-grocery.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;

const SHOP = '5926497570'; // STAFF_NUMBERS — the dispatch desk
const PICKER = '5927410186'; // GROCERY_NUMBER — the grocery shop number
const RIDER = '5926001111'; // DRIVER_NUMBERS — the delivery associate
const BUYER = '5926100001'; // a customer, on none of those lists

// The picking number is deliberately NOT staff. A grocery is an outlet, so it
// is routed by its own record and needs no permissions at all - which is the
// whole point of the change this walkthrough demonstrates.
process.env.STAFF_NUMBERS = SHOP;
process.env.GROCERY_NUMBER = PICKER;
process.env.DRIVER_NUMBERS = RIDER;
process.env.DELIVERY_FEE = '700';
process.env.STORE_NAME = 'Next Minute Delivery';

// Imported after the environment is in place, so config reads the values above.
const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleDriverMessage, handleOutletMessage, handleStaffMessage } = await import('./src/staff.ts');
const { pickingTicket, dropLines } = await import('./src/dispatch.ts');
const { nextActions } = await import('./src/order-status.ts');
const { deliveredMessage, doorCodeLine } = await import('./src/notifications.ts');
const { t } = await import('./src/language.ts');
const { money, config } = await import('./src/config.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
  console.log('');
};
const says = (who: string, text: string): void => console.log(`  ${who} ▸ ${text}`);
const gets = (who: string, text: string): void => {
  console.log(`  ${who} ◂`);
  for (const line of text.split('\n')) console.log(`      ${line}`);
};
const buttons = (acts: { title: string }[]): void => {
  if (acts.length > 0) console.log(`      ${acts.map((a) => `[ ${a.title} ]`).join('  ')}`);
};
const show = async (
  who: string,
  typed: string,
  fn: () => Promise<{ kind: string; text?: string }[]>,
): Promise<void> => {
  says(who, `"${typed}"`);
  for (const m of await fn()) {
    if (m.kind === 'location') continue;
    gets(who, m.text ?? '');
  }
};

/* ---------------------------------------------------------------- set-up */

// No outletId given, so these go to the house grocery — the shop that the
// database created for itself when it opened. Printed below so the walkthrough
// shows where the stock actually landed rather than asserting it.
// Its number, address and pin come from data/outlets.csv the way they do on a
// real boot - nothing is set on the host.
const { fillMissingOutletDetails } = await import('./src/catalog/import-menu.ts');
fillMissingOutletDetails(fs.readFileSync('./data/outlets.csv', 'utf8'));
// Renamed the way a shop would really do it: one message from a staff number.
// The shops file is not re-read on a hosted deployment, so this command is the
// only way to rename a live shop.
await handleStaffMessage('name GROCERY Centro de Gangas', SHOP);
const grocery = repo.defaultGrocery()!;

repo.upsertProduct({
  sku: 'RIC-001', name: 'Karibee Parboiled Rice', description: '', category: 'Rice & Grains',
  unit: '5 kg bag', price: 1850, stock: 40, active: 1, keywords: 'rice', trackStock: 1,
});
repo.upsertProduct({
  sku: 'OIL-002', name: 'Sunflower Cooking Oil', description: '', category: 'Cooking',
  unit: '1.8 L', price: 1420, stock: 25, active: 1, keywords: 'oil', trackStock: 1,
});
repo.upsertProduct({
  sku: 'CHA-003', name: 'Channa', description: '', category: 'Dry Goods',
  unit: '500 g', price: 380, stock: 60, active: 1, keywords: 'channa', trackStock: 1,
});
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);

const id = (sku: string): number =>
  (db.prepare(`SELECT id FROM products WHERE sku=?`).get(sku) as { id: number }).id;

/* ------------------------------------------------- 1. the order is placed */

rule('1. The customer shops and checks out');

// The associate is already on duty, as they would be during trading hours.
// Clock on after the order and the job goes out to everybody with a warning.
await handleDriverMessage('on', RIDER);

// The customer wrote in to do their shopping, which is what opens WhatsApp's
// 24-hour service window. Without it nothing can be sent to them, the delivery
// code included - so leaving this out does not just lose a line of output, it
// changes the journey.
repo.logMessage(BUYER, 'in', 'whatsapp', 'I want to do my shopping');
repo.saveLocationPin(BUYER, { latitude: 6.642, longitude: -58.218, label: 'Diamond' });
repo.saveCustomer(BUYER, {
  name: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
});
repo.setCartQty(BUYER, id('RIC-001'), 2, '');
repo.setCartQty(BUYER, id('OIL-002'), 1, '');
repo.setCartQty(BUYER, id('CHA-003'), 3, '');

const order = repo.placeOrder({
  phone: BUYER,
  customerName: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
  deliveryNote: 'Upstairs flat, white fence',
  paymentMethod: 'cash',
  location: repo.getIdentity(BUYER).location,
});
const n = String(Number(order.orderNo.replace(/\D/g, '')));
console.log(`  ${order.orderNo} placed — ${money(order.total)} including delivery`);

/* ------------------------------------------------------ 2. picking ticket */

rule('2. The grocery shop number gets the picking ticket');

console.log(`  ${grocery.name} (${grocery.code}) — its own number, +${grocery.whatsapp}`);
console.log(`  Reached as a shop, not as staff: ${repo.outletByWhatsapp(PICKER)?.code ?? 'NOT FOUND'}`);
console.log(`  In STAFF_NUMBERS? ${config.staffNumbers.includes(PICKER) ? 'yes' : 'no - and it does not need to be'}`);
console.log('');
console.log(`  (sent the moment the order is placed)`);
console.log('');
const placed = repo.findOrder(order.orderNo)!;
gets('grocery shop', pickingTicket(placed));
buttons(nextActions(order.orderNo, placed.status, 'outlet'));
console.log('');
console.log('  Note: no address, no customer number, no map pin — and the goods');
console.log('  total, not the order total. The delivery fee is not theirs to collect.');

/* ------------------------------------------------------- 3. picking it */

rule('3. The picker accepts, then says the bag is packed');

await show('grocery shop', `${n} confirm`, () => handleOutletMessage(grocery, `${n} confirm`));
const confirmed = repo.findOrder(order.orderNo)!;
buttons(nextActions(order.orderNo, confirmed.status, 'outlet'));
console.log('');
await show('grocery shop', `${n} ready`, () => handleOutletMessage(grocery, `${n} ready`));

/* ------------------------------------------------------ 4. the customer */

rule('4. What the customer is told when it leaves');

const live = repo.findOrder(order.orderNo)!;
gets(
  'Marcia',
  t('on_the_way', 'en', { name: 'Marcia', order: live.orderNo, total: money(live.total) }) +
    doorCodeLine(live, 'en'),
);
const code = repo.deliveryCodeFor(order.orderNo);

/* ----------------------------------------------------- 5. the associate */

rule('5. The associate looks at the queue');

await show('Rider One', 'jobs', () => handleDriverMessage('jobs', RIDER));

rule('6. The job card — uplift from the shop, not a kitchen');

gets('Rider One', dropLines(repo.findOrder(order.orderNo)!).join('\n'));

rule('7. Uplifts it, then the wrong code at the door');

await show('Rider One', `${n} uplifted`, () => handleDriverMessage(`${n} uplifted`, RIDER));
const wrong = code === '1111' ? '2222' : '1111';
await show('Rider One', wrong, () => handleDriverMessage(wrong, RIDER));

rule('8. The customer reads out the real code');

await show('Rider One', code, () => handleDriverMessage(code, RIDER));

rule('9. What the customer gets at the close');

gets('Marcia', deliveredMessage(repo.findOrder(order.orderNo)!, 'en'));

rule('10. The shop counts the money');

await show('shop', 'cash', () => handleStaffMessage('cash', SHOP));

console.log('');

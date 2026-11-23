/**
 * `7 details` on all four services, printed as the associate receives it.
 *
 *   node walkthrough-details.ts
 *
 * Not a test — the suite is the test. This exists to be read: it drives the
 * real handlers against a scratch database and shows what comes out of each
 * of the four journeys, which are four different shapes of job:
 *
 *   grocery     — uplifted from our own shelves, cash at the door
 *   restaurant  — uplifted from a kitchen, cash at the door
 *   parcel      — paid at the uplift, a code at the door, somebody else's name
 *   taxi        — a person, a fare, and a safety code that is spent once used
 *
 * Run with no env file on purpose: no WhatsApp token and no API key, so
 * nothing can reach a real telephone and no agent turn is billed. Everything
 * printed below is the shop's own deterministic text.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-details.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';

const SHOP = '5926497570';
const RIDER = '5926001111';
const BUYER = '5926100001';
const SENDER = '5926100002';
const PAX = '5926100003';

process.env.STAFF_NUMBERS = SHOP;
process.env.DRIVER_NUMBERS = RIDER;
process.env.STORE_NAME = 'Next Minute Delivery';

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { importOutletsText, importMenuText, fillMissingOutletDetails } = await import(
  './src/catalog/import-menu.ts'
);
const { money } = await import('./src/config.ts');

const NL = String.fromCharCode(10);

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
};
const show = async (typed: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One ▸ ${typed}`);
  console.log('');
  for (const m of await handleDriverMessage(typed, RIDER)) {
    if (m.kind === 'location') continue;
    const text = (m as { text?: string }).text ?? '';
    for (const line of text.split(NL)) console.log(`      ${line}`);
    const buttons = (m as { buttons?: { title: string }[] }).buttons ?? [];
    if (buttons.length > 0) console.log(`      ${buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

/* ---------------------------------------------------------------- the shop */

importOutletsText(fs.readFileSync('./data/outlets.csv', 'utf8'));
importMenuText(fs.readFileSync('./data/menu.csv', 'utf8'));
fillMissingOutletDetails(fs.readFileSync('./data/outlets.csv', 'utf8'));
const grocery = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'RIC-001', name: 'Karibee Parboiled Rice', description: '', category: 'Rice & Grains',
  unit: '5 kg bag', price: 1850, stock: 40, active: 1, keywords: 'rice', trackStock: 1,
  outletId: grocery.id,
} as never);
repo.upsertProduct({
  sku: 'OIL-002', name: 'Sunflower Cooking Oil', description: '', category: 'Cooking',
  unit: '1.8 L', price: 1420, stock: 25, active: 1, keywords: 'oil', trackStock: 1,
  outletId: grocery.id,
} as never);
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);

const id = (sku: string): number =>
  (db.prepare(`SELECT id FROM products WHERE sku=?`).get(sku) as { id: number }).id;
const digits = (orderNo: string): string => String(repo.orderDigits(orderNo));

/* --------------------------------------------------------- 1. the grocery */

rule('1. GROCERY — our own shelves, cash at the door');

repo.logMessage(BUYER, 'in', 'whatsapp', 'I want to do my shopping');
repo.chooseLanguage(BUYER, 'en');
repo.saveCustomer(BUYER, {
  name: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
});
repo.saveLocationPin(BUYER, { latitude: 6.642, longitude: -58.218, label: 'Diamond' });
repo.setCartQty(BUYER, id('RIC-001'), 2, '');
repo.setCartQty(BUYER, id('OIL-002'), 1, '');
repo.setDeliveryZone(BUYER, 'Diamond');
repo.setFeeAgreed(BUYER, repo.getCart(BUYER).deliveryFee);
const groceryJob = repo.placeOrder({
  phone: BUYER,
  customerName: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
  deliveryNote: 'Upstairs flat, white fence. Ring from the gate',
  paymentMethod: 'cash_on_delivery',
  location: repo.getIdentity(BUYER).location,
} as never);
console.log(`  ${groceryJob.orderNo} placed — ${money(groceryJob.total)} including delivery`);
repo.setOrderStatus(groceryJob.orderNo, 'ready');
await show(`${digits(groceryJob.orderNo)} uplifted`);
await show(`${digits(groceryJob.orderNo)} details`);
await show('details');
repo.setOrderStatus(groceryJob.orderNo, 'delivered');

/* ------------------------------------------------------ 2. the restaurant */

rule('2. RESTAURANT — uplifted from a kitchen');

const EATER = '5926100004';
const ctxR = { phone: EATER, outbound: [] as unknown[] };
repo.logMessage(EATER, 'in', 'whatsapp', 'I want food');
repo.chooseLanguage(EATER, 'en');
repo.setService(EATER, 'restaurant');
console.log(
  '  choose_outlet TOG -> ' +
    String(executeTool('choose_outlet', { code: 'TOG' }, ctxR as never)).slice(0, 70),
);
console.log(
  '  add_to_cart TOG-001 -> ' +
    String(
      executeTool('add_to_cart', { sku: 'TOG-001', quantity: 2, choices: ['Large'] }, ctxR as never),
    ).slice(0, 90),
);
repo.saveCustomer(EATER, {
  name: 'Anil Ramroop',
  address: '26 Brickdam, Georgetown',
  contactPhone: EATER,
});
repo.saveLocationPin(EATER, { latitude: 6.8092, longitude: -58.1562, label: 'Brickdam' });
repo.confirmIdentity(EATER);
repo.setDeliveryZone(EATER, 'Georgetown');
repo.setFeeAgreed(EATER, repo.getCart(EATER).deliveryFee);
const placedR = JSON.parse(
  executeTool(
    'place_order',
    { payment_method: 'cash_on_delivery', delivery_note: 'Gate is on the side street' },
    ctxR as never,
  ),
);
console.log(`  place_order -> ${placedR.order_number ?? JSON.stringify(placedR).slice(0, 110)}`);
const rJob = repo.findOrder(String(placedR.order_number))!;
repo.setOrderStatus(rJob.orderNo, 'ready');
await show(`${digits(rJob.orderNo)} uplifted`);
await show(`${digits(rJob.orderNo)} details`);
repo.setOrderStatus(rJob.orderNo, 'delivered');

/* ---------------------------------------------------------- 3. the parcel */

rule('3. PARCEL — paid at the uplift, somebody else at the door');

const ctxP = { phone: SENDER, outbound: [] as unknown[] };
repo.logMessage(SENDER, 'in', 'whatsapp', 'I need to send a parcel');
repo.chooseLanguage(SENDER, 'en');
repo.setService(SENDER, 'parcel');
repo.saveCustomer(SENDER, { name: 'Rohan Singh', address: 'Lot 2 Kitty', contactPhone: SENDER });
const madeP = JSON.parse(
  executeTool(
    'create_parcel_job',
    {
      contents: 'A box of documents, about 2 kg',
      sender_name: 'Rohan Singh',
      sender_phone: SENDER,
      recipient_name: 'Jenny Baird',
      recipient_phone: '5926107777',
      pickup_note: 'Lot 2 Kitty, the green house with the gate',
      destination_note: 'Lot 40 Diamond, upstairs flat',
    },
    ctxP as never,
  ),
);
console.log(`  create_parcel_job -> ${madeP.job_number ?? JSON.stringify(madeP).slice(0, 110)}`);
const pJob = repo.findOrder(String(madeP.job_number))!;
await show(`${digits(pJob.orderNo)} details`);
await show(`${digits(pJob.orderNo)} confirm`);
await show(`${digits(pJob.orderNo)} uplifted`);
await show(`${digits(pJob.orderNo)} details`);
repo.setOrderStatus(pJob.orderNo, 'delivered');

/* ------------------------------------------------------------ 4. the taxi */

rule('4. TAXI — a passenger, a fare, and a code spent once used');

const ctxT = { phone: PAX, outbound: [] as unknown[] };
repo.logMessage(PAX, 'in', 'whatsapp', 'I need a car');
repo.chooseLanguage(PAX, 'en');
repo.setService(PAX, 'taxi');
repo.saveCustomer(PAX, { name: 'Shanta Khan', address: 'Kitty', contactPhone: PAX });
const quoteT = JSON.parse(
  executeTool(
    'book_taxi',
    { pickup_address: 'Stabroek', destination_address: 'Diamond', passenger_name: 'Shanta Khan' },
    ctxT as never,
  ),
);
console.log(`  book_taxi (quote) -> ${JSON.stringify(quoteT).slice(0, 130)}`);
const bookedT = JSON.parse(
  executeTool(
    'book_taxi',
    {
      pickup_address: 'Stabroek',
      destination_address: 'Diamond',
      passenger_name: 'Shanta Khan',
      passenger_phone: PAX,
      fare_confirmed: true,
    },
    ctxT as never,
  ),
);
console.log(
  `  book_taxi (booked) -> ${bookedT.job_number ?? JSON.stringify(bookedT).slice(0, 130)}`,
);
const tJob = repo.findOrder(String(bookedT.job_number))!;
await show(`${digits(tJob.orderNo)} confirm`);
console.log('');
console.log(`  (the safety code on this trip is ${repo.safetyCodeFor(tJob.orderNo) || 'not set'})`);
await show(`${digits(tJob.orderNo)} details`);
await show(`${digits(tJob.orderNo)} onboard`);
await show(`${digits(tJob.orderNo)} details`);

/* ------------------------------------------------------------ 5. refusals */

rule('5. The two refusals');

repo.upsertAssociate({
  phone: '5926009999', name: 'Rider Two', vehicle: 'PAA 2', active: 1,
} as never);
db.prepare(`UPDATE orders SET driver_phone = ?, status = 'on_the_way' WHERE order_no = ?`).run(
  '5926009999',
  groceryJob.orderNo,
);
await show(`${digits(groceryJob.orderNo)} details`);
repo.setOrderStatus(tJob.orderNo, 'delivered');
await show('details');

console.log('');

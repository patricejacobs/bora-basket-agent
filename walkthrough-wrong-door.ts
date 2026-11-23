/**
 * The checkout sequence, for a customer whose saved door is somewhere else.
 *
 *   node walkthrough-wrong-door.ts
 *
 * Shawn's journey, from the screenshot: a man with a street saved in
 * Georgetown and a pin saved in Uitvlugt, ordering to Mocha, who taps Skip.
 * Run twice — once as the shop behaved, once as it behaves now.
 *
 * No WhatsApp token and no API key, so nothing reaches a telephone and no
 * agent turn is billed. Every line is the shop's own deterministic text.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-door.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const SHAWN = '5926100001';
const RIDER = '5926001111';
process.env.DRIVER_NUMBERS = RIDER;

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { dropLines } = await import('./src/dispatch.ts');
const { money } = await import('./src/config.ts');

const NL = String.fromCharCode(10);
const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
};
const say = async (what: string, label?: string): Promise<void> => {
  console.log('');
  console.log(`  Shawn ▸ ${label ?? what}`);
  for (const m of await handleIncoming({ phone: SHAWN, text: what, channel: 'whatsapp' } as never)) {
    const mm = m as {
      kind: string;
      text?: string;
      button?: string;
      rows?: { title: string; description?: string }[];
      buttons?: { title: string }[];
    };
    console.log('');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.button) console.log(`      [ ☰ ${mm.button} ]`);
    for (const r of (mm.rows ?? []).slice(0, 4)) console.log(`        · ${r.title}`);
    if ((mm.rows ?? []).length > 4) console.log(`        · … ${(mm.rows ?? []).length - 4} more rows`);
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

/* ---------------------------------------------------------------- the shop */

const outlet = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'CHE-001', name: 'Cheese Roll', description: '', category: 'Bakery',
  unit: 'each', price: 300, stock: 90, active: 1, keywords: 'cheese roll', trackStock: 1,
  outletId: outlet.id,
} as never);
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);
const roll = (db.prepare(`SELECT id FROM products WHERE sku='CHE-001'`).get() as { id: number }).id;

/* ----------------------------------------- the record Shawn already has */

rule('What the shop already knows about Shawn');

repo.chooseLanguage(SHAWN, 'en');
repo.logMessage(SHAWN, 'in', 'whatsapp', 'hello');
repo.setService(SHAWN, 'grocery');
repo.saveCustomer(SHAWN, {
  name: 'Shawn. Harry',
  address: '4 Water St, Georgetown',
  contactPhone: SHAWN,
});
// The pin he sent on some earlier order, from where he happened to be.
repo.saveLocationPin(SHAWN, {
  latitude: 6.4109,
  longitude: -58.2881,
  label: 'VMGW+PR7, Estate Rd, Uitvlugt, Guyana',
});
console.log(`  name:    ${repo.getCustomer(SHAWN).name}`);
console.log(`  address: ${repo.getCustomer(SHAWN).address}`);
console.log(`  pin:     ${repo.getCustomer(SHAWN).location?.label}`);
console.log(`  address recorded as being in: "${repo.addressZone(SHAWN) || '(nothing)'}"`);
console.log(`  pin recorded as being in:     "${repo.pinZone(SHAWN) || '(nothing)'}"`);

/* -------------------------------------------------------- 1. the basket */

rule('1. He puts five cheese rolls in the basket');

repo.setCartQty(SHAWN, roll, 5, '');
console.log('');
console.log(`  5 x Cheese Roll — ${money(repo.getCart(SHAWN).subtotal)}`);

/* ---------------------------------------------------- 2. checkout opens */

rule('2. Check out — where is it going?');

const { askPlace } = await import('./src/delivery-checkout.ts');
for (const line of ((askPlace(SHAWN, 'en') as { text?: string }).text ?? '').split(NL)) {
  console.log(`      ${line}`);
}
console.log('      [ ☰ Choose a place ]');

/* ------------------------------------------------------- 3. he says Mocha */

rule('3. He types the village');

await say('Mocha');

/* ------------------------------------------------------------ 4. he skips */

rule('4. He taps Skip');

await say('pick:drop:skip', 'taps [ Skip ]');

/* ------------------------------------------------- 5. the street, then gate */

rule('5. He gives the street at Mocha');

await say('Lot 12 Mocha Scheme, the yellow house');

/* ------------------------------------------------------------- 6. he books */

rule('6. He taps Book it');

await say('drop:gate:book', 'taps [ Book it ]');

/* ------------------------------------------------- 7. what the associate sees */

rule('7. What the associate is driving by');

const placed = repo.recentOrders(SHAWN, 1)[0];
const order = placed ? repo.findOrder(placed.orderNo) : null;
if (order) {
  console.log('');
  for (const line of dropLines(order)) console.log(`      ${line}`);
  console.log('');
  console.log(`  address on the order: ${order.address}`);
  console.log(`  zone it is priced in: ${order.deliveryZone}`);
  console.log(`  pin on the order:     ${order.location ? JSON.stringify(order.location.label) : 'none'}`);
  console.log(`  saved address now recorded in: "${repo.addressZone(SHAWN)}"`);
  console.log(`  saved pin still recorded in:   "${repo.pinZone(SHAWN) || '(nothing)'}"`);
}

/* ------------------------------------------- 8. and the next order, to Mocha */

rule('8. His NEXT order, to Mocha again');

repo.setCartQty(SHAWN, roll, 2, '');
repo.setCheckoutStep(SHAWN, 'place');
await say('Mocha');
await say('pick:drop:skip', 'taps [ Skip ]');

console.log('');

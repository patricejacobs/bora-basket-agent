/**
 * A street in the wrong village, typed at the street question.
 *
 *   node walkthrough-wrong-street.ts
 *
 * The pin has a check: drop one 9 km from the village you chose and the shop
 * says so. The STREET has none. Choose Mocha, decline the map, and type a
 * Buxton address, and the three things on the associate's card disagree with
 * one another: a Mocha price, a Buxton street, and a village name nobody
 * reads twice.
 *
 * Mocha is on the East Bank. Buxton is on the East Coast. They are not
 * neighbours and they are not the same fare.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no
 * agent turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-street.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.DRIVER_NUMBERS = '5926001111';

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { dropLines } = await import('./src/dispatch.ts');
const { findZone } = await import('./src/zones.ts');
const { GATE_BOOK, STREET_AGAIN, streetMoveId } = await import('./src/delivery-checkout.ts');
const { coordsFor, straightKm } = await import('./src/place-coords.ts');

const NL = String.fromCharCode(10);
const RIDER = '5926001111';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
};

const shop = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'R1', name: 'Rice', description: '', category: 'Rice', unit: 'bag', price: 1850,
  stock: 60, active: 1, keywords: 'rice', trackStock: 1, outletId: shop.id,
} as never);
const rice = (db.prepare(`SELECT id FROM products WHERE sku='R1'`).get() as { id: number }).id;
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);

const M = coordsFor('Mocha');
const B = coordsFor('Buxton');
console.log('');
if (M && B) console.log(`  Mocha to Buxton, straight line: ${straightKm(M, B).toFixed(1)} km`);
const mochaFee = findZone('Mocha');
const buxtonFee = findZone('Buxton');
if (mochaFee.kind === 'found') console.log(`  Mocha is priced at   $${mochaFee.match.fee}`);
if (buxtonFee.kind === 'found') console.log(`  Buxton is priced at  $${buxtonFee.match.fee}`);

const say = async (phone: string, who: string, label: string, body: Record<string, unknown>) => {
  console.log('');
  console.log(`  ${who} ▸ ${label}`);
  for (const m of await handleIncoming({ phone, channel: 'whatsapp', text: '', ...body } as never)) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    if (mm.kind === 'location') continue;
    console.log('');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.kind === 'location_request') console.log('      [ 📍 Send location ]');
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

/* --------------------------------------------------------------- the order */

rule('Ann orders rice to Mocha, and cannot pin');

const ANN = '5926100001';
repo.chooseLanguage(ANN, 'en');
repo.logMessage(ANN, 'in', 'whatsapp', 'hello');
repo.setService(ANN, 'grocery');
repo.saveCustomer(ANN, { name: 'Ann Persaud', contactPhone: ANN });
repo.setCartQty(ANN, rice, 1, '');
repo.setCheckoutStep(ANN, 'place');

await say(ANN, 'Ann', 'Mocha', { text: 'Mocha' });
await say(ANN, 'Ann', 'skip', { text: 'skip' });

rule('And types an address on the other side of the country');

await say(ANN, 'Ann', 'Lot 12 Buxton Public Road', { text: 'Lot 12 Buxton Public Road' });

rule('What the shop holds while she decides');

const showHeld = (phone: string): void => {
  const held = repo.getCustomer(phone);
  console.log('');
  console.log(`  address       ${JSON.stringify(held.address)}`);
  console.log(`  address zone  ${JSON.stringify(repo.addressZone(phone))}`);
  console.log(`  priced as     ${JSON.stringify(held.deliveryZone)} at $${repo.getCart(phone).deliveryFee}`);
};
showHeld(ANN);
console.log('');
console.log('  The door is written down where it IS, so it cannot answer');
console.log('  for Mocha - and nothing has been priced for Buxton either.');

/* ------------------------------------------------- 1. the street was right */

rule('1. She tapped the wrong row: Change the village');

await say(ANN, 'Ann', '[ Change the village ]', { text: streetMoveId('Buxton') });
showHeld(ANN);

rule('And the associate is sent one village, not two');

await say(ANN, 'Ann', '[ Book it ]', { text: GATE_BOOK });
const hers = repo.recentOrders(ANN, 1)[0];
if (hers) {
  repo.setOrderStatus(hers.orderNo, 'ready');
  console.log('');
  for (const line of dropLines(repo.findOrder(hers.orderNo)!, 'en')) {
    for (const part of line.split(NL)) console.log(`      ${part}`);
  }
}

/* ------------------------------------------------- 2. the village was right */

rule('2. Ben meant Mocha, and mistyped: Fix the address');

const BEN = '5926100002';
repo.chooseLanguage(BEN, 'en');
repo.logMessage(BEN, 'in', 'whatsapp', 'hello');
repo.setService(BEN, 'grocery');
repo.saveCustomer(BEN, { name: 'Ben Ali', contactPhone: BEN });
repo.setCartQty(BEN, rice, 1, '');
repo.setCheckoutStep(BEN, 'place');

await say(BEN, 'Ben', 'Mocha', { text: 'Mocha' });
await say(BEN, 'Ben', 'skip', { text: 'skip' });
await say(BEN, 'Ben', 'Lot 12 Buxton Public Road', { text: 'Lot 12 Buxton Public Road' });
await say(BEN, 'Ben', '[ Fix the address ]', { text: STREET_AGAIN });
await say(BEN, 'Ben', 'Lot 12 Mocha Scheme', { text: 'Lot 12 Mocha Scheme' });
showHeld(BEN);

/* ----------------------------------------------- 3. the ones it must not ask */

rule('3. The addresses it must NOT argue with');

const { streetNamesElsewhere } = await import('./src/delivery-place.ts');
console.log('');
for (const [said, chosen] of [
  ['Lot 12 Mocha Scheme', 'Mocha'],
  ['the yellow house by the mosque', 'Mocha'],
  ['second gate after the church', 'Mocha'],
  ['Lot 2 Bel Air Street, Mocha', 'Mocha'],
  ['Lot 8 BV', 'Beterverwagting'],
  ['Lot 4 Little Diamond', 'Diamond'],
  ['Lot 12 Buxton Public Road', 'Mocha'],
  ['Lot 5 Georgetown', 'Mocha'],
] as const) {
  const named = streetNamesElsewhere(said, chosen);
  console.log(
    `  ${said.padEnd(32)} chosen ${chosen.padEnd(16)} ` +
      (named === null ? 'taken as written' : `-> asks about ${named}`),
  );
}
console.log('');

/**
 * A pin in the wrong village, down all four roads it can take.
 *
 *   node walkthrough-wrong-village.ts
 *
 *   1. the ordinary case — wrong pin, right pin, on to the price
 *   2. the stubborn case — the same wrong pin again, and again
 *   3. the honest case  — somebody who cannot pin at all, and says so
 *   4. the dispatched case — asked twice while an associate waits, then taken
 *
 * No WhatsApp token and no API key: nothing reaches a telephone, no agent
 * turn is billed, and every line below is the shop's own deterministic text.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-village.db');
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

const MOCHA = coordsFor('Mocha')!;
const UITVLUGT = coordsFor('Uitvlugt')!;
console.log('');
console.log(`  Mocha is at    ${MOCHA.latitude}, ${MOCHA.longitude}`);
console.log(`  Uitvlugt is at ${UITVLUGT.latitude}, ${UITVLUGT.longitude}`);
console.log(`  which are ${straightKm(MOCHA, UITVLUGT).toFixed(1)} km apart`);

const start = async (phone: string, name: string): Promise<void> => {
  repo.chooseLanguage(phone, 'en');
  repo.logMessage(phone, 'in', 'whatsapp', 'hello');
  repo.setService(phone, 'grocery');
  repo.saveCustomer(phone, { name, contactPhone: phone });
  repo.setCartQty(phone, rice, 1, '');
  repo.setCheckoutStep(phone, 'place');
};

const say = async (phone: string, who: string, label: string, body: Record<string, unknown>) => {
  console.log('');
  console.log(`  ${who} ▸ ${label}`);
  for (const m of await handleIncoming({ phone, channel: 'whatsapp', text: '', ...body } as never)) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    console.log('');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.kind === 'location_request') console.log('      [ 📍 Send location ]');
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

/* ------------------------------------------------------ 1. the ordinary case */

rule('1. Wrong pin, then the right one');

const ANN = '5926100001';
await start(ANN, 'Ann Persaud');
await say(ANN, 'Ann', 'Mocha', { text: 'Mocha' });
await say(ANN, 'Ann', '(pins a spot in Uitvlugt)', {
  location: { latitude: UITVLUGT.latitude, longitude: UITVLUGT.longitude, label: '' },
});
await say(ANN, 'Ann', '(pins Mocha)', {
  location: { latitude: MOCHA.latitude, longitude: MOCHA.longitude, label: '' },
});

/* ------------------------------------------------------ 2. the stubborn case */

rule('2. The same wrong pin, twice more');

const BEN = '5926100002';
await start(BEN, 'Ben Ali');
await say(BEN, 'Ben', 'Mocha', { text: 'Mocha' });
for (const nth of ['(pins Uitvlugt)', '(pins the very same spot)', '(and again)']) {
  await say(BEN, 'Ben', nth, {
    location: { latitude: UITVLUGT.latitude, longitude: UITVLUGT.longitude, label: '' },
  });
}
console.log('');
console.log('  Nothing is committed during checkout, so it keeps asking —');
console.log('  and the way out is printed in front of him every time.');

/* -------------------------------------------------------- 3. the honest case */

rule('3. Somebody who cannot pin at all');

const CAROL = '5926100003';
await start(CAROL, 'Carol Singh');
await say(CAROL, 'Carol', 'Mocha', { text: 'Mocha' });
await say(CAROL, 'Carol', '(pins Uitvlugt)', {
  location: { latitude: UITVLUGT.latitude, longitude: UITVLUGT.longitude, label: '' },
});
await say(CAROL, 'Carol', 'skip', { text: 'skip' });
await say(CAROL, 'Carol', 'Lot 12 Mocha Scheme, the yellow house', {
  text: 'Lot 12 Mocha Scheme, the yellow house',
});

/* ---------------------------------------------------- 4. while somebody waits */

rule('4. A job already out, and an associate waiting');

const DEV = '5926100004';
await start(DEV, 'Dev Narine');
repo.setDeliveryZone(DEV, 'Mocha');
repo.setFeeAgreed(DEV, repo.getCart(DEV).deliveryFee);
repo.setCheckoutStep(DEV, '');
const job = repo.placeOrder({
  phone: DEV, customerName: 'Dev Narine', address: 'Lot 9 Mocha', contactPhone: DEV,
  deliveryNote: '', paymentMethod: 'cash_on_delivery', location: null,
} as never);
repo.assignDriver(job.orderNo, RIDER);
repo.setOrderStatus(job.orderNo, 'on_the_way');
const n = String(repo.orderDigits(job.orderNo));

console.log('');
console.log(`  Rider One ▸ ${n} pin`);
for (const m of await handleDriverMessage(`${n} pin`, RIDER)) {
  console.log('');
  for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log(`      ${line}`);
}

for (const nth of ['(pins Uitvlugt)', '(pins it again)', '(and once more)']) {
  await say(DEV, 'Dev', nth, {
    location: { latitude: UITVLUGT.latitude, longitude: UITVLUGT.longitude, label: '' },
  });
}

console.log('');
console.log('  --- what Rider One is driving by ---');
console.log('');
for (const line of dropLines(repo.findOrder(job.orderNo)!)) console.log(`      ${line}`);
console.log('');

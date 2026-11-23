/**
 * A delivery where the pin is in the wrong village, both ways round.
 *
 *   node walkthrough-wrong-pin.ts
 *
 * Shawn orders to Mocha and sends a pin that is really in Uitvlugt. Run
 * twice: once where he stands by it, once where he sends it again. The
 * second half shows what the associate is driving by in each case.
 *
 * No WhatsApp token and no API key, so nothing reaches a telephone and no
 * agent turn is billed. Every line is the shop's own deterministic text.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-wrongpin.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const RIDER = '5926001111';
process.env.DRIVER_NUMBERS = RIDER;

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { dropLines } = await import('./src/dispatch.ts');
const { placesLocated, coordsFor } = await import('./src/place-coords.ts');
const { straightKm } = await import('./src/place-coords.ts');

const NL = String.fromCharCode(10);
const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
};

/** A pin that is really in Uitvlugt, with the label WhatsApp would attach. */
const WRONG_PIN = {
  latitude: 6.4109,
  longitude: -58.2881,
  label: 'VMGW+PR7, Estate Rd, Uitvlugt, Guyana',
};
/** And one that is really in Mocha, shared as a bare "current location". */
const RIGHT_PIN = { latitude: 6.7205, longitude: -58.1862, label: '' };

const shop = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'CHE-001', name: 'Cheese Roll', description: '', category: 'Bakery',
  unit: 'each', price: 300, stock: 90, active: 1, keywords: 'cheese roll', trackStock: 1,
  outletId: shop.id,
} as never);
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);
const roll = (db.prepare(`SELECT id FROM products WHERE sku='CHE-001'`).get() as { id: number }).id;

const run = async (who: string, name: string, ending: 'keep' | 'again'): Promise<string> => {
  repo.chooseLanguage(who, 'en');
  repo.logMessage(who, 'in', 'whatsapp', 'hello');
  repo.setService(who, 'grocery');
  repo.saveCustomer(who, { name, contactPhone: who });
  repo.setCartQty(who, roll, 5, '');
  repo.setCheckoutStep(who, 'place');

  const say = async (label: string, body: Record<string, unknown>): Promise<void> => {
    console.log('');
    console.log(`  ${name.split(' ')[0]} ▸ ${label}`);
    for (const m of await handleIncoming({
      phone: who, channel: 'whatsapp', text: '', ...body,
    } as never)) {
      const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
      console.log('');
      for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
      if (mm.kind === 'location_request') console.log('      [ 📍 Send location ]');
      if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
    }
  };

  await say('Mocha', { text: 'Mocha' });
  await say('(sends a pin — it is really in Uitvlugt)', { location: WRONG_PIN });

  if (ending === 'again') {
    await say('taps [ Send it again ]', { text: 'pin:again' });
    await say('(sends a pin in Mocha this time)', { location: RIGHT_PIN });
  } else {
    await say('taps [ Yes, that is right ]', { text: 'pin:keep' });
  }

  await say('taps [ Book it ]', { text: 'drop:gate:book' });
  const placed = repo.recentOrders(who, 1)[0];
  return placed?.orderNo ?? '';
};

/* ---------------------------------------------------------------- the data */

rule('What the shop can check against');

console.log('');
console.log(`  places with a confident coordinate: ${placesLocated()} of 185`);
console.log(`  Mocha is at:    ${JSON.stringify(coordsFor('Mocha'))}`);
console.log(`  Uitvlugt is at: ${JSON.stringify(coordsFor('Uitvlugt'))}`);
const mocha = coordsFor('Mocha');
if (mocha) {
  console.log(`  the pin he sends is ${straightKm(WRONG_PIN, mocha).toFixed(1)} km from Mocha`);
}

/* ------------------------------------------------ 1. he sends it again */

rule('1. He sends it again');

const fixed = await run('5926100001', 'Shawn Harry', 'again');

rule("2. And what the associate drives by");

const fixedOrder = fixed ? repo.findOrder(fixed) : null;
if (fixedOrder) {
  console.log('');
  for (const line of dropLines(fixedOrder)) console.log(`      ${line}`);
}

/* ---------------------------------------------- 3. he stands by the pin */

rule('3. Another customer stands by the pin');

const stood = await run('5926100002', 'Marcia Persaud', 'keep');

rule('4. The associate is told anyway');

const stoodOrder = stood ? repo.findOrder(stood) : null;
if (stoodOrder) {
  console.log('');
  for (const line of dropLines(stoodOrder)) console.log(`      ${line}`);
}

console.log('');

/**
 * Accept first, then Uplifted — and what the one who was too slow sees.
 *
 *   node walkthrough-accept-first.ts
 *
 * Two associates on duty, one job. Both are offered it, one takes it, and
 * the other finds it gone. Then the sequence from there: uplifted, the code
 * at the door, closed.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-accept.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
const ONE = '5926001111';
const TWO = '5926002222';
process.env.DRIVER_NUMBERS = `${ONE},${TWO}`;

const NL = String.fromCharCode(10);
const BUYER = '5926100001';
const WHO: Record<string, string> = { [ONE]: 'Rider One', [TWO]: 'Rider Two', [BUYER]: 'Ann' };
let watching = false;

const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  const first = String(args[0] ?? '');
  if (watching && first.startsWith('[whatsapp] not configured')) {
    try {
      const p = JSON.parse(String(args[1] ?? '{}')) as {
        to?: string;
        text?: { body?: string };
        interactive?: {
          body?: { text?: string };
          action?: { buttons?: { reply: { id: string; title: string } }[] };
        };
      };
      const body = p.text?.body ?? p.interactive?.body?.text ?? '';
      const buttons = p.interactive?.action?.buttons ?? [];
      console.log('');
      console.log('  → ' + (WHO[p.to ?? ''] ?? '+' + (p.to ?? '')));
      for (const line of body.split(NL)) console.log('      ' + line);
      if (buttons.length > 0) {
        console.log('      ' + buttons.map((b) => '[ ' + b.reply.title + ' ]').join('  '));
      }
    } catch {
      realWarn(...args);
    }
    return;
  }
  if (!first.startsWith('[whatsapp]')) realWarn(...args);
};

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { readButtonId } = await import('./src/button-ids.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);
};

const shop = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'R1', name: 'Rice', description: '', category: 'Rice', unit: 'bag', price: 1850,
  stock: 60, active: 1, keywords: 'rice', trackStock: 1, outletId: shop.id,
} as never);
const rice = (db.prepare(`SELECT id FROM products WHERE sku='R1'`).get() as { id: number }).id;
for (const [phone, name, van] of [[ONE, 'Rider One', 'NEW 5678'], [TWO, 'Rider Two', 'PAA 2222']] as const) {
  repo.upsertAssociate({ phone, name, vehicle: van, active: 1 } as never);
  await handleDriverMessage('on', phone);
}

repo.chooseLanguage(BUYER, 'en');
repo.logMessage(BUYER, 'in', 'whatsapp', 'hello');
repo.setService(BUYER, 'grocery');
repo.saveCustomer(BUYER, { name: 'Ann Persaud', contactPhone: BUYER, address: 'Lot 4 Diamond' });
repo.setCartQty(BUYER, rice, 2, '');
repo.setDeliveryZone(BUYER, 'Diamond');
repo.setFeeAgreed(BUYER, repo.getCart(BUYER).deliveryFee);
const job = repo.placeOrder({
  phone: BUYER, customerName: 'Ann Persaud', address: 'Lot 4 Diamond', contactPhone: BUYER,
  deliveryNote: '', paymentMethod: 'cash_on_delivery',
  location: { latitude: 6.7558, longitude: -58.1699, label: 'Diamond' },
} as never);
const n = String(repo.orderDigits(job.orderNo));

/** One tap, as WhatsApp sends it: an id, translated the way the webhook does. */
const tap = async (phone: string, id: string, title: string): Promise<void> => {
  console.log('');
  console.log(`  ${WHO[phone]} taps [ ${title} ]`);
  const text = readButtonId(id) ?? title;
  for (const m of await handleDriverMessage(text, phone)) {
    if (m.kind === 'location') continue;
    console.log('');
    console.log(`  → ${WHO[phone]}`);
    for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log('      ' + line);
    const b = (m as { buttons?: { title: string }[] }).buttons ?? [];
    if (b.length > 0) console.log('      ' + b.map((x) => `[ ${x.title} ]`).join('  '));
  }
};

/* ------------------------------------------------------- the job goes out */

rule('The food is up, and both of them are offered it');

watching = true;
const { dispatchToDrivers } = await import('./src/dispatch.ts');
repo.setOrderStatus(job.orderNo, 'ready');
await dispatchToDrivers(job.orderNo);

/* ------------------------------------------------------------ one takes it */

rule('Rider One takes it');

await tap(ONE, `take_${n}`, 'Accept');

rule('Rider Two taps the Accept still sitting in his chat');

await tap(TWO, `take_${n}`, 'Accept');

rule('And cannot move it either');

await tap(TWO, `otw_${n}`, 'Uplifted');

/* ------------------------------------------------------ the sequence runs on */

rule('Rider One carries on');

await tap(ONE, `otw_${n}`, 'Uplifted');
const code = repo.deliveryCodeFor(job.orderNo);
console.log('');
console.log(`  (Ann's delivery code is ${code})`);
await tap(ONE, code, code);

console.log('');
console.log(`  ${job.orderNo} is now ${repo.findOrder(job.orderNo)!.status}.`);
watching = false;
console.log('');

/**
 * Changing the address, with a pin that is nowhere near the new place.
 *
 *   node walkthrough-wrong-pin-change.ts
 *
 *   A. she corrects it      — the proposal goes out clean
 *   B. she types `skip`     — the proposal goes out with the query on it,
 *                             and the associate says no
 *   C. the same, but he takes it anyway — through to the door
 *
 * No WhatsApp token and no API key: nothing reaches a telephone, no agent
 * turn is billed, and every message is captured as it leaves the sender.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-wrongpin-change.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.DRIVER_NUMBERS = '5926001111';

const NL = String.fromCharCode(10);
const RIDER = '5926001111';
const PEOPLE: Record<string, string> = {
  '5926100001': 'Ann',
  '5926100002': 'Ben',
  '5926100003': 'Carol',
  [RIDER]: 'Rider One',
};
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
          action?: { buttons?: { reply: { title: string } }[] };
        };
      };
      const body = p.text?.body ?? p.interactive?.body?.text ?? '';
      const buttons = (p.interactive?.action?.buttons ?? []).map((b) => b.reply.title);
      console.log('');
      console.log('  → ' + (PEOPLE[p.to ?? ''] ?? '+' + (p.to ?? '')));
      for (const line of body.split(NL)) console.log('      ' + line);
      if (buttons.length > 0) console.log('      ' + buttons.map((t) => '[ ' + t + ' ]').join('  '));
    } catch {
      realWarn(...args);
    }
    return;
  }
  if (!first.startsWith('[whatsapp]')) realWarn(...args);
};

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { dropLines } = await import('./src/dispatch.ts');
const { coordsFor, straightKm } = await import('./src/place-coords.ts');
const { money } = await import('./src/config.ts');

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
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);

const BUXTON = coordsFor('Buxton')!;
const UITVLUGT = coordsFor('Uitvlugt')!;
console.log('');
console.log(`  Buxton and Uitvlugt are ${straightKm(BUXTON, UITVLUGT).toFixed(1)} km apart.`);
console.log('  Every pin below is the Uitvlugt one, sent for a change to Buxton.');

const book = (phone: string): { orderNo: string } => {
  const name = PEOPLE[phone]!;
  repo.chooseLanguage(phone, 'en');
  repo.logMessage(phone, 'in', 'whatsapp', 'hello');
  repo.setService(phone, 'grocery');
  repo.saveCustomer(phone, { name, contactPhone: phone, address: 'Lot 4 Diamond' });
  repo.setCartQty(phone, rice, 1, '');
  repo.setDeliveryZone(phone, 'Diamond');
  repo.setFeeAgreed(phone, repo.getCart(phone).deliveryFee);
  const made = repo.placeOrder({
    phone, customerName: name, address: 'Lot 4 Diamond', contactPhone: phone,
    deliveryNote: '', paymentMethod: 'cash_on_delivery',
    location: { latitude: 6.7558, longitude: -58.1699, label: 'Diamond' },
  } as never);
  repo.assignDriver(made.orderNo, RIDER);
  repo.setOrderStatus(made.orderNo, 'on_the_way');
  return made;
};

const say = async (phone: string, label: string, body: Record<string, unknown>): Promise<void> => {
  console.log('');
  console.log(`  ${PEOPLE[phone]} ▸ ${label}`);
  for (const m of await handleIncoming({ phone, channel: 'whatsapp', text: '', ...body } as never)) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    console.log('');
    console.log(`  → ${PEOPLE[phone]}`);
    for (const line of (mm.text ?? '').split(NL)) console.log('      ' + line);
    if (mm.kind === 'location_request') console.log('      [ 📍 Send location ]');
    if (mm.buttons) console.log('      ' + mm.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  }
};

const rider = async (typed: string, label = typed): Promise<void> => {
  console.log('');
  console.log(`  Rider One ▸ ${label}`);
  for (const m of await handleDriverMessage(typed, RIDER)) {
    if (m.kind === 'location') continue;
    console.log('');
    console.log('  → Rider One');
    for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log('      ' + line);
  }
};

const askForBuxton = (phone: string): void => {
  const ctx = { phone, outbound: [] as unknown[] };
  executeTool('change_destination', { new_destination: 'Buxton' }, ctx as never);
  executeTool('change_destination', { new_destination: 'Buxton', confirmed: true }, ctx as never);
  for (const m of ctx.outbound as { text?: string; buttons?: { title: string }[] }[]) {
    console.log('');
    console.log(`  → ${PEOPLE[phone]}`);
    for (const line of (m.text ?? '').split(NL)) console.log('      ' + line);
    if (m.buttons) console.log('      ' + m.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  }
};

const wrongPin = { latitude: UITVLUGT.latitude, longitude: UITVLUGT.longitude, label: '' };
const rightPin = { latitude: BUXTON.latitude, longitude: BUXTON.longitude, label: '' };

/* ================================================== A. she corrects it */

rule('A. Wrong pin, then the right one');

const ANN = '5926100001';
const a = book(ANN);
watching = true;
console.log('');
console.log('  Ann ▸ "take it to Buxton instead"');
askForBuxton(ANN);
await say(ANN, '(pins Uitvlugt)', { location: wrongPin });
await say(ANN, '(pins Buxton)', { location: rightPin });
await rider(`dest_ok_${repo.orderDigits(a.orderNo)}`, 'taps [ Acknowledged ]');

/* ============================================== B. she skips, he says no */

watching = false;
rule('B. She skips — and the associate says no');

const BEN = '5926100002';
const b = book(BEN);
watching = true;
console.log('');
console.log('  Ben ▸ "take it to Buxton instead"');
askForBuxton(BEN);
await say(BEN, '(pins Uitvlugt)', { location: wrongPin });
await say(BEN, 'skip', { text: 'skip' });
await rider(`dest_no_${repo.orderDigits(b.orderNo)}`, 'taps [ No, as booked ]');
console.log('');
console.log(`  ${b.orderNo} is still going to ${repo.findOrder(b.orderNo)!.address}` +
  `, delivery ${money(repo.findOrder(b.orderNo)!.deliveryFee)}`);

/* ========================================= C. she skips, he takes it anyway */

watching = false;
rule('C. The same, but he takes it');

const CAROL = '5926100003';
const c = book(CAROL);
watching = true;
console.log('');
console.log('  Carol ▸ "take it to Buxton instead"');
askForBuxton(CAROL);
await say(CAROL, '(pins Uitvlugt)', { location: wrongPin });
await say(CAROL, 'skip', { text: 'skip' });
await rider(`dest_ok_${repo.orderDigits(c.orderNo)}`, 'taps [ Acknowledged ]');

console.log('');
console.log('  --- what Rider One is driving by ---');
console.log('');
for (const line of dropLines(repo.findOrder(c.orderNo)!)) console.log('      ' + line);
watching = false;
console.log('');

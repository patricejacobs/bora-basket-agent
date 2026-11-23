/**
 * A delivery redirected to Buxton, both ways the pin question can be answered.
 *
 *   node walkthrough-buxton.ts
 *
 *   A. the customer types `skip`  — the associate is asked, with no pin
 *   B. the customer sends the pin — the associate is asked, with the door on it
 *
 * Both run to the end: acknowledged, re-priced, delivered, and what the
 * associate was driving by at each step.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed. Every message below is captured as it leaves the sender.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-buxton.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.DRIVER_NUMBERS = '5926001111';

const NL = String.fromCharCode(10);
const RIDER = '5926001111';
const ANN = '5926100001';
const BEN = '5926100002';
const WHO: Record<string, string> = { [RIDER]: 'Rider One', [ANN]: 'Ann', [BEN]: 'Ben' };
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
      console.log('  → ' + (WHO[p.to ?? ''] ?? '+' + (p.to ?? '')));
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
const { coordsFor } = await import('./src/place-coords.ts');
const { money } = await import('./src/config.ts');

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

const BUXTON = coordsFor('Buxton')!;

const book = (phone: string, name: string): { orderNo: string } => {
  repo.chooseLanguage(phone, 'en');
  repo.logMessage(phone, 'in', 'whatsapp', 'hello');
  repo.setService(phone, 'grocery');
  repo.saveCustomer(phone, { name, contactPhone: phone, address: 'Lot 4 Diamond' });
  repo.setAddressZone(phone, 'Diamond');
  repo.setCartQty(phone, rice, 1, '');
  repo.setDeliveryZone(phone, 'Diamond');
  repo.setFeeAgreed(phone, repo.getCart(phone).deliveryFee);
  const made = repo.placeOrder({
    phone, customerName: name, address: 'Lot 4 Diamond', contactPhone: phone,
    deliveryNote: '', paymentMethod: 'cash_on_delivery',
    location: { latitude: 6.7558, longitude: -58.1699, label: 'Diamond' },
  } as never);
  repo.setPinZone(phone, 'Diamond');
  repo.assignDriver(made.orderNo, RIDER);
  repo.setOrderStatus(made.orderNo, 'on_the_way');
  return made;
};

const say = async (phone: string, label: string, body: Record<string, unknown>): Promise<void> => {
  console.log('');
  console.log(`  ${WHO[phone]} ▸ ${label}`);
  for (const m of await handleIncoming({ phone, channel: 'whatsapp', text: '', ...body } as never)) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    console.log('');
    console.log(`  → ${WHO[phone]}`);
    for (const line of (mm.text ?? '').split(NL)) console.log('      ' + line);
    if (mm.kind === 'location_request') console.log('      [ 📍 Send location ]');
    if (mm.buttons) console.log('      ' + mm.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  }
};

const rider = async (typed: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One ▸ ${typed}`);
  for (const m of await handleDriverMessage(typed, RIDER)) {
    if (m.kind === 'location') continue;
    console.log('');
    console.log('  → Rider One');
    for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log('      ' + line);
    const b = (m as { buttons?: { title: string }[] }).buttons ?? [];
    if (b.length > 0) console.log('      ' + b.map((x) => `[ ${x.title} ]`).join('  '));
  }
};

const ask = (phone: string): void => {
  const ctx = { phone, outbound: [] as unknown[] };
  executeTool('change_destination', { new_destination: 'Buxton' }, ctx as never);
  executeTool('change_destination', { new_destination: 'Buxton', confirmed: true }, ctx as never);
  for (const m of ctx.outbound as { text?: string; buttons?: { title: string }[] }[]) {
    console.log('');
    console.log(`  → ${WHO[phone]}`);
    for (const line of (m.text ?? '').split(NL)) console.log('      ' + line);
    if (m.buttons) console.log('      ' + m.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  }
};

/* ============================================ A. the customer types skip */

rule('A. "take it to Buxton" — and she types skip');

const a = book(ANN, 'Ann Persaud');
const aDigits = String(repo.orderDigits(a.orderNo));
console.log('');
console.log(`  ${a.orderNo} — Lot 4 Diamond, delivery ${money(repo.findOrder(a.orderNo)!.deliveryFee)}`);
watching = true;
console.log('');
console.log('  Ann ▸ "can you take it to Buxton instead"');
ask(ANN);
await say(ANN, 'skip', { text: 'skip' });
await rider(`dest_ok_${aDigits}`);

console.log('');
console.log('  --- what Rider One is driving by ---');
console.log('');
for (const line of dropLines(repo.findOrder(a.orderNo)!)) console.log('      ' + line);

/* ========================================== B. the customer sends the pin */

watching = false;
rule('B. The same change, answered with the pin');

const b = book(BEN, 'Ben Ali');
const bDigits = String(repo.orderDigits(b.orderNo));
watching = true;
console.log('');
console.log('  Ben ▸ "can you take it to Buxton instead"');
ask(BEN);
await say(BEN, '(sends a pin in Buxton)', {
  location: { latitude: BUXTON.latitude, longitude: BUXTON.longitude, label: '' },
});
await rider(`dest_ok_${bDigits}`);

console.log('');
console.log('  --- what Rider One is driving by ---');
console.log('');
for (const line of dropLines(repo.findOrder(b.orderNo)!)) console.log('      ' + line);

rule('And the money, both ways');

for (const [who, made] of [['Ann', a], ['Ben', b]] as const) {
  const fresh = repo.findOrder(made.orderNo)!;
  console.log(
    `  ${who}: ${fresh.address} — delivery ${money(fresh.deliveryFee)}, total ${money(fresh.total)}`,
  );
}
watching = false;
console.log('');

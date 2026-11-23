/**
 * The Call customer button, through the channel that used to swallow it.
 *
 *   node walkthrough-call-customer.ts
 *
 * The tap is fed in as WhatsApp actually sends it — an interactive
 * `button_reply` carrying an id and a title — and put through the same two
 * steps the webhook performs: decide which of the two to act on, then hand
 * that to the staff handler. That first step is where this button died: the
 * id was not recognised, so the title went through instead, and "📞 Call
 * customer" has no order number in it.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-callcust.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.DRIVER_NUMBERS = '5926001111';

const NL = String.fromCharCode(10);
const RIDER = '5926001111';
const ANN = '5926100001';
const WHO: Record<string, string> = { [RIDER]: 'Rider One', [ANN]: 'Ann' };
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
        console.log('      ' + buttons.map((b) => '(' + b.reply.id + ')').join('  '));
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
const { handleIncoming } = await import('./src/conversation.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { readButtonId } = await import('./src/button-ids.ts');
const { coordsFor } = await import('./src/place-coords.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
};

const shop = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'R1', name: 'Rice', description: '', category: 'Rice', unit: 'bag', price: 1850,
  stock: 20, active: 1, keywords: 'rice', trackStock: 1, outletId: shop.id,
} as never);
const rice = (db.prepare(`SELECT id FROM products WHERE sku='R1'`).get() as { id: number }).id;
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);

repo.chooseLanguage(ANN, 'en');
repo.logMessage(ANN, 'in', 'whatsapp', 'hello');
repo.setService(ANN, 'grocery');
repo.saveCustomer(ANN, { name: 'Ann Persaud', contactPhone: ANN, address: 'Lot 4 Diamond' });
repo.setCartQty(ANN, rice, 1, '');
repo.setDeliveryZone(ANN, 'Diamond');
repo.setFeeAgreed(ANN, repo.getCart(ANN).deliveryFee);
const job = repo.placeOrder({
  phone: ANN, customerName: 'Ann Persaud', address: 'Lot 4 Diamond', contactPhone: ANN,
  deliveryNote: '', paymentMethod: 'cash_on_delivery',
  location: { latitude: 6.7558, longitude: -58.1699, label: 'Diamond' },
} as never);
repo.assignDriver(job.orderNo, RIDER);
repo.setOrderStatus(job.orderNo, 'on_the_way');
const n = String(repo.orderDigits(job.orderNo));

/**
 * One tap, as WhatsApp sends it, through the two steps the webhook performs.
 */
const tap = async (id: string, title: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One taps [ ${title} ]`);
  console.log(`      WhatsApp sends:  id "${id}", title "${title}"`);
  const text = readButtonId(id) ?? title;
  console.log(`      the channel acts on: "${text}"` +
    (readButtonId(id) === null ? '   ← the TITLE, because the id was not recognised' : ''));
  for (const m of await handleDriverMessage(text, RIDER)) {
    if (m.kind === 'location') continue;
    console.log('');
    console.log('  → Rider One');
    for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log('      ' + line);
    const b = (m as { buttons?: { id: string; title: string }[] }).buttons ?? [];
    if (b.length > 0) {
      console.log('      ' + b.map((x) => `[ ${x.title} ]`).join('  '));
      console.log('      ' + b.map((x) => `(${x.id})`).join('  '));
    }
  }
};

/* ------------------------------------------------- the card with the button */

rule('The change of address, with a pin that does not match');

watching = true;
const ctx = { phone: ANN, outbound: [] as unknown[] };
executeTool('change_destination', { new_destination: 'Buxton' }, ctx as never);
executeTool('change_destination', { new_destination: 'Buxton', confirmed: true }, ctx as never);
const uitvlugt = coordsFor('Uitvlugt')!;
await handleIncoming({
  phone: ANN, text: '', channel: 'whatsapp',
  location: { latitude: uitvlugt.latitude, longitude: uitvlugt.longitude, label: '' },
} as never);
await handleIncoming({ phone: ANN, text: 'skip', channel: 'whatsapp' } as never);

/* ------------------------------------------------------------- the tap */

rule('He taps it');

await tap(`callcust_${n}`, '📞 Call customer');

rule('And the answer still settles it');

await tap(`dest_ok_${n}`, 'Acknowledged');

const settled = repo.findOrder(job.orderNo)!;
console.log('');
console.log(`  ${settled.orderNo} is now going to ${settled.address}.`);

/* ------------------------------------------- what it used to do, for contrast */

rule('What it did before the fix');

console.log('');
console.log('  The channel had no reader for that id, so it acted on the title:');
console.log('');
console.log('  Rider One taps [ 📞 Call customer ]');
for (const m of await handleDriverMessage('📞 Call customer', RIDER)) {
  for (const line of ((m as { text?: string }).text ?? '').split(NL).slice(0, 2)) {
    console.log('      ' + line);
  }
}
watching = false;
console.log('');

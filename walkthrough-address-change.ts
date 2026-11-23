/**
 * A delivery redirected on the road, and the points message that follows it.
 *
 *   node walkthrough-address-change.ts
 *
 * The journey that found the fault: an order booked to Uitvlugt, moved to
 * Stanleytown while the associate was carrying it, and closed at the new
 * door. The congratulation underneath the receipt used to name Uitvlugt —
 * the one village the customer had just moved the delivery away from.
 *
 * Every message below is captured as it leaves: with no WhatsApp token
 * configured the sender drops each payload to the console, so what is
 * printed here is the actual body that would have gone to the actual
 * number. Nothing reaches a real telephone and no agent turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-move.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';

const RIDER = '5926001111';
const BUYER = '5926100001';
process.env.DRIVER_NUMBERS = RIDER;
process.env.STORE_NAME = 'Next Minute Delivery';

/* ------------------------------------------------- catching what goes out */

const NL = String.fromCharCode(10);
const WHO: Record<string, string> = { [RIDER]: 'Rider One', [BUYER]: 'Marcia' };
let watching = false;

const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  const first = String(args[0] ?? '');
  if (watching && first.startsWith('[whatsapp] not configured')) {
    try {
      const payload = JSON.parse(String(args[1] ?? '{}')) as {
        to?: string;
        text?: { body?: string };
        interactive?: { body?: { text?: string }; action?: { buttons?: { reply: { title: string } }[] } };
      };
      const to = payload.to ?? '';
      const body = payload.text?.body ?? payload.interactive?.body?.text ?? '';
      const buttons = (payload.interactive?.action?.buttons ?? []).map((b) => b.reply.title);
      console.log('');
      console.log(`  → ${WHO[to] ?? `+${to}`}`);
      for (const line of body.split(NL)) console.log(`      ${line}`);
      if (buttons.length > 0) console.log(`      ${buttons.map((t) => `[ ${t} ]`).join('  ')}`);
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
const { handleIncoming } = await import('./src/conversation.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { money } = await import('./src/config.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
};
const rider = async (typed: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One ▸ ${typed}`);
  for (const m of await handleDriverMessage(typed, RIDER)) {
    if (m.kind === 'location') continue;
    console.log('');
    console.log('  → Rider One');
    for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log(`      ${line}`);
    const buttons = (m as { buttons?: { title: string }[] }).buttons ?? [];
    if (buttons.length > 0) console.log(`      ${buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

/* ---------------------------------------------------------------- the shop */

const grocery = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'CUR-001', name: 'Goat Curry', description: '', category: 'Main Dishes',
  unit: 'plate', price: 2700, stock: 40, active: 1, keywords: 'curry goat', trackStock: 1,
  outletId: grocery.id,
} as never);
repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);
const curry = (db.prepare(`SELECT id FROM products WHERE sku='CUR-001'`).get() as { id: number }).id;

/* --------------------------------------------------- 1. booked to Uitvlugt */

rule('1. Booked to Uitvlugt');

repo.logMessage(BUYER, 'in', 'whatsapp', 'I want to order');
repo.chooseLanguage(BUYER, 'en');
repo.saveCustomer(BUYER, { name: 'Marcia Persaud', address: 'Uitvlugt', contactPhone: BUYER });
repo.saveLocationPin(BUYER, { latitude: 6.7995, longitude: -58.3542, label: 'Uitvlugt' });
repo.setCartQty(BUYER, curry, 2, '');
repo.setDeliveryZone(BUYER, 'Uitvlugt');
repo.setFeeAgreed(BUYER, repo.getCart(BUYER).deliveryFee);
const job = repo.placeOrder({
  phone: BUYER,
  customerName: 'Marcia Persaud',
  address: 'Uitvlugt',
  contactPhone: BUYER,
  deliveryNote: '',
  paymentMethod: 'cash_on_delivery',
  location: repo.getIdentity(BUYER).location,
} as never);
const n = String(repo.orderDigits(job.orderNo));
const booked = repo.findOrder(job.orderNo)!;
console.log(`  ${booked.orderNo} — ${booked.address}, delivery ${money(booked.deliveryFee)}, total ${money(booked.total)}`);
console.log(`  the zone saved on Marcia's record: ${repo.getCustomer(BUYER).deliveryZone}`);

repo.setOrderStatus(job.orderNo, 'ready');
watching = true;
await rider(`${n} uplifted`);

/* --------------------------------------- 2. she moves it while it is out */

rule('2. She moves it to Stanleytown, mid-flight');

const ctx = { phone: BUYER, outbound: [] as unknown[] };
console.log('');
console.log('  Marcia ▸ "can you take it to Stanleytown instead"');
const quote = JSON.parse(
  executeTool('change_destination', { new_destination: 'Stanleytown' }, ctx as never),
);
console.log(`  change_destination (quote) -> ${JSON.stringify(quote).slice(0, 150)}`);
const agreed = JSON.parse(
  executeTool(
    'change_destination',
    { new_destination: 'Stanleytown', confirmed: true },
    ctx as never,
  ),
);
console.log(`  change_destination (yes)   -> ${JSON.stringify(agreed).slice(0, 150)}`);
for (const m of ctx.outbound as { kind: string; text?: string; buttons?: { title: string }[] }[]) {
  console.log('');
  console.log('  → Marcia');
  for (const line of (m.text ?? '').split(NL)) console.log(`      ${line}`);
  if (m.buttons) console.log(`      ${m.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
}

rule('3. She pins the new door, then the associate is asked');

console.log('');
console.log('  Marcia ▸ (sends a location pin)');
const backFromPin = await handleIncoming({
  phone: BUYER,
  text: '',
  channel: 'whatsapp',
  location: { latitude: 6.0023, longitude: -58.6114, label: 'Stanleytown' },
} as never);
for (const m of backFromPin as { kind: string; text?: string }[]) {
  console.log('');
  console.log(`  → Marcia  (${m.kind})`);
  for (const line of (m.text ?? '').split(NL)) console.log(`      ${line}`);
}


rule('4. The associate acknowledges it');

await rider(`dest_ok_${n}`);
const moved = repo.findOrder(job.orderNo)!;
console.log('');
console.log(`  ${moved.orderNo} is now ${moved.address}, delivery ${money(moved.deliveryFee)}, total ${money(moved.total)}`);
console.log(`  the zone saved on Marcia's record is still: ${repo.getCustomer(BUYER).deliveryZone}`);

/* -------------------------------------------------- 5. closed at the door */

rule('5. Closed at the new door');

await rider(repo.deliveryCodeFor(job.orderNo));

rule('6. What the points message says');

console.log('');
console.log(`  (the order was charged under: ${repo.findOrder(job.orderNo)!.deliveryZone})`);
console.log(`  (the record still says:       ${repo.getCustomer(BUYER).deliveryZone})`);
console.log('');

watching = false;

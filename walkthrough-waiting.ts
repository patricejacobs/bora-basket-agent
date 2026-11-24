/**
 * Three people turned away, and what happens when a car finally comes on.
 *
 *   node walkthrough-waiting.ts
 *
 * The fault this follows: a passenger gave the shop his pickup, his
 * destination, four passengers and no luggage, and was told
 *
 *   "Message me when you are ready and I will check again straight away."
 *
 * He WAS ready. The shop was not, and the sentence handed him the next move
 * anyway — so the booking it was holding sat there until he thought to ask
 * again, which most people never do.
 *
 * Now the waiting is the shop's, and the shop goes back to them.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed. Every line below is the shop's own deterministic text.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-waiting.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.WAITING_LIST_MINUTES = '120';

const RIDER = '5926001111';
process.env.DRIVER_NUMBERS = RIDER;

const NL = String.fromCharCode(10);
const SHAWN = '5926100001';
const ANN = '5926100002';
const REEAZ = '5926100003';
const WHO: Record<string, string> = {
  [SHAWN]: 'Shawn',
  [ANN]: 'Ann',
  [REEAZ]: 'Reeaz',
  [RIDER]: 'Rider One',
};

// Everything the shop sends on its own — the callbacks — arrives through the
// sender, which has no token, so it is caught here instead.
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  const first = String(args[0] ?? '');
  if (first.startsWith('[whatsapp] not configured')) {
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
      if (body === '' && buttons.length === 0) return;
      console.log('');
      console.log(`  → ${WHO[p.to ?? ''] ?? '+' + (p.to ?? '')}`);
      for (const line of body.split(NL)) console.log(`      ${line}`);
      if (buttons.length > 0) {
        console.log(`      ${buttons.map((b) => `[ ${b.reply.title} ]`).join('  ')}`);
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
const { WAIT_GO, WAIT_NO } = await import('./src/waiting-list.ts');
const { readButtonId } = await import('./src/button-ids.ts');
const { GATE_BOOK } = await import('./src/delivery-checkout.ts');
import type { OutboundMessage } from './src/channels/types.ts';

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

const show = (phone: string, out: OutboundMessage[]): void => {
  for (const m of out) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    if (mm.kind === 'location') continue;
    console.log('');
    console.log(`  → ${WHO[phone]}`);
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

const say = async (phone: string, label: string, text: string): Promise<void> => {
  console.log('');
  console.log(`  ${WHO[phone]} ▸ ${label}`);
  show(phone, await handleIncoming({ phone, channel: 'whatsapp', text } as never));
};

/* ------------------------------------------------- nobody on the road */

rule('Nobody is on duty');
console.log('');
console.log(`  anyone out? ${repo.anyoneOnDuty()}`);

/* 1. Shawn, who wants a car. Through the agent's own tool, which is what the
      model calls — the refusal and the words it is given are printed. */

rule('11:57  Shawn wants a car, Kitty to Diamond');

repo.chooseLanguage(SHAWN, 'en');
repo.logMessage(SHAWN, 'in', 'whatsapp', 'taxi');
repo.setService(SHAWN, 'taxi');
repo.saveCustomer(SHAWN, { name: 'Shawn Adams', contactPhone: SHAWN });
const ctx = { phone: SHAWN, outbound: [] as OutboundMessage[] };
const refused = JSON.parse(
  executeTool('book_taxi', { pickup_address: 'Kitty', destination_address: 'Diamond', passenger_name: 'Shawn Adams' }, ctx as never),
) as { error?: string };
console.log('');
console.log('  the tool refuses, and tells the agent how to say it:');
for (const line of (refused.error ?? '').replace(/\. /g, `.${NL}`).split(NL)) {
  console.log(`      ${line}`);
}

/* 2. Ann, who has shopped and tapped Book it on the shop's own gate. */

rule('12:04  Ann has shopped, and taps Book it');

repo.chooseLanguage(ANN, 'en');
repo.logMessage(ANN, 'in', 'whatsapp', 'rice');
repo.setService(ANN, 'grocery');
repo.saveCustomer(ANN, { name: 'Ann Persaud', contactPhone: ANN, address: 'Lot 4 Diamond' });
repo.setCartQty(ANN, rice, 2, '');
repo.setDeliveryZone(ANN, 'Diamond');
repo.setAddressZone(ANN, 'Diamond');
repo.setFeeAgreed(ANN, repo.getCart(ANN).deliveryFee);
repo.setCheckoutStep(ANN, 'gate');
await say(ANN, '[ Book it ]', GATE_BOOK);

/* 3. Reeaz, a second passenger. */

rule('12:09  Reeaz wants a car too');

repo.chooseLanguage(REEAZ, 'en');
repo.logMessage(REEAZ, 'in', 'whatsapp', 'taxi');
repo.setService(REEAZ, 'taxi');
repo.saveCustomer(REEAZ, { name: 'Reeaz Khan', contactPhone: REEAZ });
const ctx2 = { phone: REEAZ, outbound: [] as OutboundMessage[] };
executeTool('book_taxi', { pickup_address: 'Vreed-en-Hoop', destination_address: 'Georgetown', passenger_name: 'Reeaz Khan' }, ctx2 as never);

rule('What the shop is holding');
console.log('');
for (const row of repo.waitingList(120)) {
  console.log(`  ${WHO[row.phone].padEnd(7)} ${row.service.padEnd(8)} ${row.summary}`);
}

/* --------------------------------------------- 12:21, a car comes on */

rule('12:21  Rider One types `on`');

console.log('');
console.log(`  Rider One ▸ on`);
show(RIDER, (await handleDriverMessage('on', RIDER)) as never);
// The callbacks are sent by the shop itself, through the sender, so they are
// printed by the catcher above. Give them a moment to go out.
await new Promise((done) => setTimeout(done, 300));

console.log('');
console.log('  Reeaz is not told: one car cannot carry two parties, and he');
console.log('  is behind Shawn. A delivery queues; a ride does not.');

/* ------------------------------------------------------- the answers */

rule('Shawn taps [ Yes, send it ]');

await say(SHAWN, '[ Yes, send it ]', readButtonId(WAIT_GO) ?? WAIT_GO);

rule('And Ann taps [ Place it ]');

await say(ANN, '[ Place it ]', readButtonId(WAIT_GO) ?? WAIT_GO);

/* ------------------------------------------------- the slot moves on */

rule('If Shawn had said no instead');

repo.noteWaiting(SHAWN, 'taxi', 'Kitty to Diamond');
repo.noteWaiting(REEAZ, 'taxi', 'Vreed-en-Hoop to Georgetown');
await say(SHAWN, '[ Not now ]', readButtonId(WAIT_NO) ?? WAIT_NO);
await new Promise((done) => setTimeout(done, 300));
console.log('');
console.log('  the car passes to the next one waiting rather than being wasted.');

/* ------------------------------------------------------- the stale ask */

rule('And an ask nobody could answer for two hours');

repo.noteWaiting(REEAZ, 'taxi', 'Vreed-en-Hoop to Georgetown');
db.prepare(`UPDATE waiting_customers SET asked_at = ?, told_at = '' WHERE phone = ?`)
  .run(new Date(Date.now() - 3 * 3600_000).toISOString(), REEAZ);
console.log('');
console.log(`  waiting now: ${repo.waitingList(120).length}`);
console.log(`  dropped as stale: ${repo.dropStaleWaiting(120)}`);
console.log('');
console.log('  No "sorry, still nothing" three hours later: his plans have');
console.log('  changed, and a second apology is worse than silence.');
console.log('');

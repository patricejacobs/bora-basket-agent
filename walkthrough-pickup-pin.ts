/**
 * "I'm at Timehri" — pinned 38 km away at Beterverwagting.
 *
 *   node walkthrough-pickup-pin.ts
 *
 * Reported from the live shop. The passenger said one place and pinned
 * another, and nothing was said to anybody. The fare is priced FROM the
 * pickup, so the shop was about to quote Beterverwagting's $1,200 for a
 * ride that costs $3,800 out of Timehri — and send a driver to the wrong
 * end of the coast on a figure it had already promised.
 *
 * `checkPin` has read exactly this for weeks. It was never called on a taxi.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-pickup.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const DRIVER = '5926001111';
process.env.DRIVER_NUMBERS = DRIVER;

const NL = String.fromCharCode(10);
const SHAWN = '5926100001';

const repo = await import('./src/db/repo.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { coordsFor, straightKm } = await import('./src/place-coords.ts');
const { PICKUP_HERE, PICKUP_AGAIN } = await import('./src/taxi-pickup.ts');
const { fareBetween } = await import('./src/zones.ts');
import type { OutboundMessage } from './src/channels/types.ts';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
};

const show = (out: OutboundMessage[]): void => {
  for (const m of out) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    if (mm.kind === 'location') continue;
    console.log('');
    console.log('  → Shawn');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.kind === 'location_request') console.log('      [ 📍 Send location ]');
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
};

repo.upsertAssociate({ phone: DRIVER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', DRIVER);

repo.chooseLanguage(SHAWN, 'en');
repo.logMessage(SHAWN, 'in', 'whatsapp', 'taxi');
repo.setService(SHAWN, 'taxi');
repo.saveCustomer(SHAWN, { name: 'Shawn Adams', contactPhone: SHAWN });

const TIMEHRI = coordsFor('Timehri')!;
const BV = coordsFor('Beterverwagting')!;
console.log('');
console.log(`  Timehri and Beterverwagting are ${straightKm(TIMEHRI, BV).toFixed(1)} km apart`);
console.log(`  Timehri → Georgetown         $${fareBetween('Timehri', 'Georgetown')?.fee}`);
console.log(`  Beterverwagting → Georgetown $${fareBetween('Beterverwagting', 'Georgetown')?.fee}`);

/* ------------------------------------------------------- the two facts */

rule('He says Timehri, and pins Beterverwagting');

console.log('');
console.log('  Shawn ▸ (sends a pin at Beterverwagting)');
repo.addParcelPin(SHAWN, { latitude: BV.latitude, longitude: BV.longitude, label: '' }, 'pickup');

const ctx = { phone: SHAWN, outbound: [] as OutboundMessage[] };
const book = (input: unknown): Record<string, unknown> => {
  ctx.outbound.length = 0;
  const out = JSON.parse(executeTool('book_taxi', input, ctx as never)) as Record<string, unknown>;
  show(ctx.outbound);
  return out;
};

console.log('');
console.log('  Shawn ▸ "take me from Timehri to Georgetown"');
const asked = book({
  pickup_address: 'Timehri',
  destination_address: 'Georgetown',
  passenger_name: 'Shawn Adams',
});
console.log('');
console.log(`  booked? ${asked.booked} · asked? ${asked.asked} · ${asked.said} vs ${asked.pinned}, ${asked.apart}`);

/* ----------------------------------------------- 1. the pin was right */

rule('1. He really is at Beterverwagting');

show(await handleIncoming({ phone: SHAWN, channel: 'whatsapp', text: PICKUP_HERE } as never));
console.log('');
console.log(`  the pickup is now ${repo.taxiPicks(SHAWN).from}`);

/* ------------------------------------------------- 2. the word was right */

rule('2. Or he is at Timehri and the pin was a slip');

repo.clearTaxiPicks(SHAWN);
repo.addParcelPin(SHAWN, { latitude: BV.latitude, longitude: BV.longitude, label: '' }, 'pickup');
book({ pickup_address: 'Timehri', destination_address: 'Georgetown', passenger_name: 'Shawn Adams' });
show(await handleIncoming({ phone: SHAWN, channel: 'whatsapp', text: PICKUP_AGAIN } as never));
console.log('');
console.log(`  the wrong pin is gone: ${repo.getParcelDraft(SHAWN).pickup === null}`);

console.log('');
console.log('  He sends the right one, and the booking carries on.');
repo.addParcelPin(SHAWN, { latitude: TIMEHRI.latitude, longitude: TIMEHRI.longitude, label: '' }, 'pickup');
const fine = book({
  pickup_address: 'Timehri',
  destination_address: 'Georgetown',
  passenger_name: 'Shawn Adams',
});
console.log('');
console.log(`  asked again? ${fine.asked === true} — and the fare is ${fine.fare ?? '(quoted above)'}`);
console.log('');

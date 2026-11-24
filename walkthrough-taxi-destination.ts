/**
 * A passenger changes where they are going, and the driver gets a say.
 *
 *   node walkthrough-taxi-destination.ts
 *
 * Reported from the live shop, on TXI-00013: the passenger changed the
 * destination and the driver never got to acknowledge it. The trip changed
 * the instant the fare was agreed and the driver was told afterwards, with
 * the ordinary trip buttons underneath — informed, never asked, and no way
 * to say "I cannot take them there".
 *
 * A delivery redirected by the customer has always been a proposal. So has a
 * destination the DRIVER raises: the passenger gets two figures and two
 * buttons and nothing moves until they tap. Only the passenger's own change
 * skipped the gate. Now it does not.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-taxi-dest.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const DRIVER = '5926001111';
process.env.DRIVER_NUMBERS = DRIVER;

const NL = String.fromCharCode(10);
const SHAWN = '5926100001';
const WHO: Record<string, string> = { [DRIVER]: 'Rider One', [SHAWN]: 'Shawn' };

// The shop's own messages — the driver's card, and what it tells the
// passenger afterwards — go through the sender, which has no token.
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

const repo = await import('./src/db/repo.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { destAnswerButtons } = await import('./src/order-status.ts');
const { readButtonId } = await import('./src/button-ids.ts');
import type { OutboundMessage } from './src/channels/types.ts';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);
};

repo.upsertAssociate({ phone: DRIVER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', DRIVER);

repo.chooseLanguage(SHAWN, 'en');
repo.logMessage(SHAWN, 'in', 'whatsapp', 'taxi');
repo.setService(SHAWN, 'taxi');
repo.saveCustomer(SHAWN, { name: 'Shawn Adams', contactPhone: SHAWN });

const job = repo.createTaxiJob({
  phone: SHAWN, fare: 70000, passengerName: 'Shawn Adams', passengerPhone: SHAWN,
  pickup: null, pickupAddress: 'Diamond', destination: null, destinationAddress: 'Grove',
  note: '', wantedAt: '', wantedNote: '',
} as never);
repo.assignDriver(job.orderNo, DRIVER);
repo.setOrderStatus(job.orderNo, 'on_the_way');
const digits = repo.orderDigits(job.orderNo);

const ctx = { phone: SHAWN, outbound: [] as OutboundMessage[] };
const change = (input: unknown): Record<string, unknown> => {
  ctx.outbound.length = 0;
  const out = JSON.parse(executeTool('change_destination', input, ctx as never)) as Record<string, unknown>;
  for (const m of ctx.outbound) {
    const mm = m as { text?: string; buttons?: { title: string }[] };
    console.log('');
    console.log(`  → Shawn`);
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
  return out;
};

const tap = async (label: string, id: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One taps [ ${label} ]`);
  for (const m of await handleDriverMessage(readButtonId(id) ?? id, DRIVER)) {
    const mm = m as { text?: string };
    console.log('');
    console.log(`  → Rider One`);
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
  }
};

const where = (): string => {
  const o = repo.findOrder(job.orderNo)!;
  return `${o.address} at ${o.quotedFare > 0 ? '$' + o.quotedFare : 'a fare with the driver'}`;
};

/* --------------------------------------------------------- the change */

rule('In the car, Shawn wants to go somewhere else');
console.log('');
console.log(`  ${job.orderNo} is going to ${where()}`);

console.log('');
console.log('  Shawn ▸ actually, take me to Zeelugt');
const quote = change({ new_destination: 'Zeelugt' });
console.log('');
console.log(`  the shop quotes: ${quote.old_fare} → ${quote.new_fare}`);
console.log(`  and changes nothing: still ${where()}`);

rule('He agrees the fare');

const asked = change({ new_destination: 'Zeelugt', confirmed: true });
console.log('');
console.log(`  changed? ${asked.changed} · asked the driver? ${asked.asked}`);
console.log(`  the trip is still going to ${where()}`);

/* ------------------------------------------------- the driver's answer */

rule('And the driver gets a say');

const { proposeDestinationToDriver } = await import('./src/dispatch.ts');
await proposeDestinationToDriver(job.orderNo);

rule('Rider One can take them');

await tap('Acknowledged', destAnswerButtons(digits, 'Acknowledged', 'No, as booked')[0]!.id);
console.log('');
console.log(`  ${job.orderNo} is now going to ${where()}`);

/* ----------------------------------------------------- the other road */

rule('And the road where he cannot');

repo.setTaxiFareShown(SHAWN, -1);
change({ new_destination: 'Parika' });
const again = change({ new_destination: 'Parika', confirmed: true });
console.log('');
console.log(`  changed? ${again.changed} · asked the driver? ${again.asked}`);
await proposeDestinationToDriver(job.orderNo);
await tap('No, as booked', destAnswerButtons(digits, 'Acknowledged', 'No, as booked')[1]!.id);
console.log('');
console.log(`  ${job.orderNo} is still going to ${where()}`);
console.log('');

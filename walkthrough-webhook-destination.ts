/**
 * Acknowledged / No, as booked — driven through the REAL webhook.
 *
 *   node walkthrough-webhook-destination.ts
 *
 * Not the handlers: the HTTP endpoint Meta posts to. The driver's two
 * answers are built as the payload WhatsApp actually sends — an interactive
 * `button_reply` carrying an id and a title — signed with the app secret the
 * way Meta signs it, and POSTed to a running server.
 *
 * Each title is sent as "⬜". `dest_ok_` is one of the ids that has already
 * shipped dead in this shop: a button whose id nothing reads falls back to
 * its TITLE, and a title that matches no command is answered with the help
 * text. Sending nonsense titles means only the id can possibly work, so a
 * reader that goes missing shows up here as a driver tapping Acknowledged
 * and nothing happening — which is what it looks like on a phone.
 *
 * The outbound side has no token, so every message the shop sends is dropped
 * to the console and printed here instead of reaching a telephone.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WALK_DB = path.resolve('./data/walk-webhook-dest.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const SECRET = 'a-test-app-secret-not-a-real-one';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.PORT = '3989';

const DRIVER = '5926001111';
process.env.DRIVER_NUMBERS = DRIVER;

const NL = String.fromCharCode(10);
const SHAWN = '5926100001';
const WHO: Record<string, string> = { [DRIVER]: 'Rider One', [SHAWN]: 'Shawn' };

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
const { destAnswerButtons } = await import('./src/order-status.ts');
// Importing it starts it: the server listens as a side effect of being
// loaded, which is what `npm start` relies on.
await import('./src/server.ts');
import type { OutboundMessage } from './src/channels/types.ts';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
};

repo.upsertAssociate({ phone: DRIVER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
repo.setDuty(DRIVER, true);

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
const answers = destAnswerButtons(digits, 'Acknowledged', 'No, as booked');

const base = `http://127.0.0.1:${process.env.PORT}`;
for (let tries = 0; tries < 40; tries += 1) {
  try {
    const up = await fetch(`${base}/health`);
    if (up.ok) break;
  } catch {
    /* not listening yet */
  }
  await new Promise((done) => setTimeout(done, 150));
}

let eventNo = 0;
const post = async (from: string, message: Record<string, unknown>): Promise<number> => {
  eventNo += 1;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
              contacts: [{ wa_id: from, profile: { name: WHO[from] ?? 'Someone' } }],
              messages: [{ from, id: `wamid.test.${eventNo}`, timestamp: '1', ...message }],
            },
          },
        ],
      },
    ],
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const res = await fetch(`${base}/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body: raw,
  });
  await new Promise((done) => setTimeout(done, 500));
  return res.status;
};

const tap = async (label: string, id: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One taps [ ${label} ]   (id "${id}", title sent as "⬜")`);
  const status = await post(DRIVER, {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title: '⬜' } },
  });
  if (status !== 200) console.log(`      !! the webhook answered ${status}`);
};

const ctx = { phone: SHAWN, outbound: [] as OutboundMessage[] };
const change = (input: unknown): Record<string, unknown> => {
  ctx.outbound.length = 0;
  const out = JSON.parse(executeTool('change_destination', input, ctx as never)) as Record<string, unknown>;
  for (const m of ctx.outbound) {
    const mm = m as { text?: string };
    console.log('');
    console.log('  → Shawn');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
  }
  return out;
};

const where = (): string => {
  const o = repo.findOrder(job.orderNo)!;
  return `${o.address}, $${o.quotedFare}`;
};

/* ----------------------------------------------------------- the change */

rule('In the car, Shawn asks for Zeelugt');
console.log('');
console.log(`  ${job.orderNo} is going to ${where()}`);

change({ new_destination: 'Zeelugt' });
const asked = change({ new_destination: 'Zeelugt', confirmed: true });
const { proposeDestinationToDriver } = await import('./src/dispatch.ts');
await proposeDestinationToDriver(job.orderNo);
console.log('');
console.log(`  changed? ${asked.changed} · still going to ${where()}`);

/* ------------------------------------------------------- the first tap */

rule('He can take them');

await tap('Acknowledged', answers[0]!.id);
console.log('');
console.log(`  ${job.orderNo} is now going to ${where()}`);

/* ------------------------------------------------------ the other tap */

rule('And a second change he cannot take');

repo.setTaxiFareShown(SHAWN, -1);
change({ new_destination: 'Parika' });
change({ new_destination: 'Parika', confirmed: true });
await proposeDestinationToDriver(job.orderNo);
await tap('No, as booked', answers[1]!.id);
console.log('');
console.log(`  ${job.orderNo} is still going to ${where()}`);

/* ------------------------------------------------------ and the guards */

rule('A tap on a question already settled');

await tap('Acknowledged', answers[0]!.id);

rule('And an unsigned request');

const bad = await fetch(`${base}/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
});
console.log('');
console.log(`      a webhook with no signature: ${bad.status}`);
console.log('');

process.exit(0);

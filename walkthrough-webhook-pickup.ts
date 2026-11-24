/**
 * "I'm at Timehri" — pinned at BV, driven through the REAL webhook.
 *
 *   node walkthrough-webhook-pickup.ts
 *
 * Not the handlers: the HTTP endpoint Meta posts to. The pin is sent as a
 * real `location` message, signed the way Meta signs it, and the two
 * answers come back as `button_reply` payloads — each with its title sent
 * as "⬜", so only the id can possibly work. Four buttons have shipped dead
 * in this shop by falling back to a title; these two are new, and this is
 * the test that would have caught every one of them.
 *
 * The booking itself is called directly, because the agent turn in the
 * middle needs an API key and this walkthrough bills nothing.
 *
 * The outbound side has no token, so every message the shop sends is
 * dropped to the console and printed here instead of reaching a telephone.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WALK_DB = path.resolve('./data/walk-webhook-pickup.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const SECRET = 'a-test-app-secret-not-a-real-one';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.PORT = '3990';

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
          action?: { buttons?: { reply: { id: string; title: string } }[]; name?: string };
        };
      };
      const body = p.text?.body ?? p.interactive?.body?.text ?? '';
      const buttons = p.interactive?.action?.buttons ?? [];
      const asksForMap = p.interactive?.action?.name === 'send_location';
      if (body === '' && buttons.length === 0) return;
      console.log('');
      console.log(`  → ${WHO[p.to ?? ''] ?? '+' + (p.to ?? '')}`);
      for (const line of body.split(NL)) console.log(`      ${line}`);
      if (asksForMap) console.log('      [ 📍 Send location ]');
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
const { coordsFor } = await import('./src/place-coords.ts');
const { PICKUP_HERE, PICKUP_AGAIN } = await import('./src/taxi-pickup.ts');
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

const TIMEHRI = coordsFor('Timehri')!;
const BV = coordsFor('Beterverwagting')!;

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
  // Long enough for the handler to finish, not just to answer. The route
  // replies 200 before it works, and at 500ms a message belonging to the
  // PIN was still arriving while the transcript had moved on to the tap —
  // which reads as the tap having sent it. A walkthrough that misleads is
  // worse than a slow one.
  await new Promise((done) => setTimeout(done, 3000));
  return res.status;
};

/** A pin, exactly as WhatsApp sends one. */
const sendPin = async (at: { latitude: number; longitude: number }, what: string): Promise<void> => {
  console.log('');
  console.log(`  Shawn ▸ 📍 (shares a location — ${what})`);
  const status = await post(SHAWN, {
    type: 'location',
    location: { latitude: at.latitude, longitude: at.longitude },
  });
  if (status !== 200) console.log(`      !! the webhook answered ${status}`);
};

const tap = async (label: string, id: string): Promise<void> => {
  console.log('');
  console.log(`  Shawn taps [ ${label} ]   (id "${id}", title sent as "⬜")`);
  const status = await post(SHAWN, {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title: '⬜' } },
  });
  if (status !== 200) console.log(`      !! the webhook answered ${status}`);
};

const ctx = { phone: SHAWN, outbound: [] as OutboundMessage[] };
const book = (input: unknown): Record<string, unknown> => {
  ctx.outbound.length = 0;
  const out = JSON.parse(executeTool('book_taxi', input, ctx as never)) as Record<string, unknown>;
  for (const m of ctx.outbound) {
    const mm = m as { kind: string; text?: string; buttons?: { title: string }[] };
    console.log('');
    console.log('  → Shawn');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
  return out;
};

/* ------------------------------------------------------- the two facts */

rule('The pin arrives through the webhook');

await sendPin(BV, 'Beterverwagting');
const held = repo.getParcelDraft(SHAWN).pickup;
console.log('');
console.log(`      the shop filed it as the pickup: ${held ? `${held.latitude}, ${held.longitude}` : 'nothing'}`);

rule('And he says he is at Timehri');

const asked = book({
  pickup_address: 'Timehri',
  destination_address: 'Georgetown',
  passenger_name: 'Shawn Adams',
});
console.log('');
console.log(`  booked? ${asked.booked} · ${asked.said} vs ${asked.pinned}, ${asked.apart}`);

/* --------------------------------------------------- 1. the pin was right */

rule('He taps [ I am at the pin ]');

await tap('I am at the pin', PICKUP_HERE);
console.log('');
console.log(`  the pickup is now ${repo.taxiPicks(SHAWN).from}`);

/* ------------------------------------------------- 2. the word was right */

rule('Or, from the same standoff, [ Send it again ]');

repo.clearTaxiPicks(SHAWN);
repo.clearParcelDraft(SHAWN);
await sendPin(BV, 'Beterverwagting again');
book({ pickup_address: 'Timehri', destination_address: 'Georgetown', passenger_name: 'Shawn Adams' });
await tap('Send it again', PICKUP_AGAIN);
console.log('');
console.log(`  the disowned pin is gone: ${repo.getParcelDraft(SHAWN).pickup === null}`);

rule('He sends the right one');

await sendPin(TIMEHRI, 'Timehri');
const fine = book({
  pickup_address: 'Timehri',
  destination_address: 'Georgetown',
  passenger_name: 'Shawn Adams',
});
console.log('');
console.log(`  asked again? ${fine.asked === true}`);

/* ------------------------------------- a pickup the tariff cannot place */

rule('A street corner, with no pin at all');

repo.clearParcelDraft(SHAWN);
repo.clearTaxiPicks(SHAWN);

console.log('');
console.log('  Shawn ▸ "pick up from King St and take me to Timehri"');
console.log('');
console.log('  [MODEL] the agent takes that and calls book_taxi. There is no API key');
console.log('          here, so the walkthrough makes that call itself.');
const street = book({
  pickup_address: 'King St',
  destination_address: 'Timehri',
  passenger_name: 'Shawn Adams',
  fare_confirmed: true,
});
console.log('');
console.log(`  booked? ${street.booked} · asked for the spot? ${street.asked}`);
console.log(`  (nothing on the record: ${repo.liveTaxi(SHAWN) === null ? 'no trip' : 'a trip!'})`);

rule('He sends the spot, through the webhook');

await sendPin(TIMEHRI, 'where he is actually standing');

console.log('');
console.log('  [MODEL] and the agent books it now that there is somewhere to go.');
const nowBooked = book({
  pickup_address: 'King St',
  destination_address: 'Timehri',
  passenger_name: 'Shawn Adams',
  fare_confirmed: true,
});
console.log('');
console.log(`  booked? ${nowBooked.booked} · ${nowBooked.job_number ?? ''} · ${nowBooked.fare ?? ''}`);
const card = repo.findOrder(String(nowBooked.job_number ?? ''));
console.log(`  the driver gets a pin: ${card?.pickup?.latitude != null}`);

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

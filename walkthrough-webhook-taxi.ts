/**
 * A whole taxi booking, end to end, through the REAL webhook.
 *
 *   node walkthrough-webhook-taxi.ts
 *
 * Every message below is built as the payload WhatsApp actually sends — a
 * text, a location, a button tap, a list row — signed with the app secret
 * the way Meta signs it, and POSTed to a running server. Nothing calls a
 * handler directly.
 *
 * Two steps are stood in for, and they are marked [MODEL] where they
 * happen: after both ends are chosen, and after *Book it*, the shop hands
 * the conversation to the agent with a note telling it to call `book_taxi`.
 * There is no API key here, so this walkthrough makes that call itself with
 * exactly the arguments the note asks for. Everything else — the service
 * menu, the pickup pin, both place lists, the fare gate, the dispatch, the
 * driver's cards and the close — is the shop's own deterministic work and
 * runs for real.
 *
 * The outbound side has no token, so every message the shop sends is
 * dropped to the console and printed here instead of reaching a telephone.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WALK_DB = path.resolve('./data/walk-webhook-taxi.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const SECRET = 'a-test-app-secret-not-a-real-one';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.PORT = '3991';

const DRIVER = '5926001111';
process.env.DRIVER_NUMBERS = DRIVER;

const NL = String.fromCharCode(10);
const SHAWN = '5926100001';
const WHO: Record<string, string> = { [DRIVER]: 'Rider One', [SHAWN]: 'Shawn' };

let lastRows: { id: string; title: string }[] = [];
const lastButtonsFor: Record<string, { id: string; title: string }[]> = {};
let lastButtons: { id: string; title: string }[] = [];
const realError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (String(args[0] ?? '').startsWith('[agent]')) {
    console.log('');
    console.log('  [MODEL] the shop handed the turn to the agent here. There is no API');
    console.log('          key in this walkthrough, so what the passenger sees next is');
    console.log('          the shop apologising rather than the agent speaking.');
    return;
  }
  realError(...args);
};

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
          action?: {
            buttons?: { reply: { id: string; title: string } }[];
            name?: string;
            sections?: { rows: { id: string; title: string }[] }[];
          };
        };
      };
      const body = p.text?.body ?? p.interactive?.body?.text ?? '';
      const buttons = p.interactive?.action?.buttons ?? [];
      const rows = (p.interactive?.action?.sections ?? []).flatMap((x) => x.rows);
      const asksForMap = p.interactive?.action?.name === 'send_location';
      if (body === '' && buttons.length === 0 && rows.length === 0) return;
      console.log('');
      console.log(`  → ${WHO[p.to ?? ''] ?? '+' + (p.to ?? '')}   [${(p as { type?: string }).type ?? '?'}]`);
      for (const line of body.split(NL)) console.log(`      ${line}`);
      if (asksForMap) console.log('      [ 📍 Send location ]');
      if (buttons.length > 0) {
        lastButtons = buttons.map((b) => b.reply);
        lastButtonsFor[p.to ?? ''] = lastButtons;
        console.log(`      ${buttons.map((b) => `[ ${b.reply.title} ]`).join('  ')}`);
      }
      if (rows.length > 0) {
        lastRows = rows;
        console.log(`      ▾ ${rows.slice(0, 6).map((r) => r.title).join(' · ')}` +
          (rows.length > 6 ? ` … ${rows.length} rows` : ''));
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
const { executeTool } = await import('./src/agent/tools.ts');
const { coordsFor } = await import('./src/place-coords.ts');
await import('./src/server.ts');
import type { OutboundMessage } from './src/channels/types.ts';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);
};

repo.upsertAssociate({ phone: DRIVER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
repo.chooseLanguage(SHAWN, 'en');
repo.saveCustomer(SHAWN, { name: 'Shawn Adams', contactPhone: SHAWN });

const DIAMOND = coordsFor('Diamond')!;

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

/**
 * Waits until the shop stops talking.
 *
 * The route answers 200 before it does the work, so waiting on the reply
 * proves nothing, and waiting a fixed time is no better: at 1500ms the
 * SECOND message of a step was still arriving while the transcript had
 * moved on, which reads as the next tap having sent it. Choosing a taxi
 * sends two messages, a pin sends two, and a booking sends the job card to
 * an associate after it has answered the passenger.
 */
const settle = async (): Promise<void> => {
  const before = outboundCount();
  let last = before;
  let still = 0;
  for (let tick = 0; tick < 40; tick += 1) {
    await new Promise((done) => setTimeout(done, 200));
    const now = outboundCount();
    if (now !== last) {
      last = now;
      still = 0;
      continue;
    }
    still += 1;
    if (now > before && still >= 3) break;
    if (now === before && tick >= 10) break;
  }
};

/** How many messages the shop has sent, from its own log. */
const outboundCount = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM message_log WHERE direction = 'out'`).get() as { n: number }).n;

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
  // The route answers 200 before it does the work, so waiting on the reply
  // proves nothing. Waiting a fixed time is no better: at 1500ms the SECOND
  // message of a step was still arriving while the transcript had moved on,
  // which reads as the next tap having sent it — choosing a taxi sends two
  // messages, and so does a pin.
  //
  // So this waits until the shop stops talking: the outbound log must hold
  // still for a moment before the next step is allowed to begin.
  await settle();
  return res.status;
};

const says = async (who: string, what: string): Promise<void> => {
  console.log('');
  console.log(`  ${WHO[who]} ▸ ${what}`);
  await post(who, { type: 'text', text: { body: what } });
};

const taps = async (who: string, label: string, id: string): Promise<void> => {
  console.log('');
  console.log(`  ${WHO[who]} taps [ ${label} ]`);
  await post(who, {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title: label } },
  });
};

const picks = async (label: string, id: string): Promise<void> => {
  console.log('');
  console.log(`  Shawn picks “${label}” off the list`);
  await post(SHAWN, {
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id, title: label } },
  });
};

const pins = async (at: { latitude: number; longitude: number }, what: string): Promise<void> => {
  console.log('');
  console.log(`  Shawn ▸ 📍 (shares a location — ${what})`);
  await post(SHAWN, { type: 'location', location: { latitude: at.latitude, longitude: at.longitude } });
};

/** Taps a button the shop has just sent, by what it says. */
const tapOffered = async (wanted: string): Promise<void> => {
  const button = lastButtons.find((b) => b.title.toLowerCase().includes(wanted.toLowerCase()));
  if (!button) {
    throw new Error(
      `no button saying "${wanted}" — offered: ${lastButtons.map((b) => b.title).join(', ')}`,
    );
  }
  await taps(SHAWN, button.title, button.id);
};

/**
 * Taps a row off the list the shop has just sent, by what it says — paging
 * on through "More places" exactly as a passenger would, because a long
 * corridor does not fit WhatsApp's ten rows.
 */
const pickRow = async (wanted: string): Promise<void> => {
  for (let page = 0; page < 6; page += 1) {
    const row = lastRows.find((r) => r.title.toLowerCase().includes(wanted.toLowerCase()));
    if (row) {
      await picks(row.title, row.id);
      return;
    }
    const more = lastRows.find((r) => /more places/i.test(r.title));
    if (!more) break;
    await picks(more.title, more.id);
  }
  throw new Error(
    `no row saying "${wanted}" — the list offered: ${lastRows.map((r) => r.title).join(', ')}`,
  );
};

const model = (what: string): void => {
  console.log('');
  console.log(`  [MODEL] ${what}`);
};

/* ------------------------------------------------------------ the booking */

rule('Rider One clocks on');

// Through the webhook, because WhatsApp will not carry a job card to a
// number that has never messaged the shop — and because it is how a shift
// actually starts.
await says(DRIVER, 'on');

rule('Shawn opens the chat');

await says(SHAWN, 'hello');

rule('And asks for a car');

await says(SHAWN, '1');

rule('He sends where he is standing');

await pins(DIAMOND, 'Diamond');

rule('And confirms the area off the list');

// The list opens on corridors and then offers the places in one.
await pickRow('East Bank Demerara');
await pickRow('Diamond');

rule('He has already pinned, so he skips the second ask');

await tapOffered('Skip');

rule('Then where he is going');

await pickRow('Georgetown');
await pickRow('Georgetown');

/* --------------------------------------------------------- the fare gate */

model('the shop handed over a note: call book_taxi with Diamond → Georgetown.');

const ctx = { phone: SHAWN, outbound: [] as OutboundMessage[] };
const callBook = (input: Record<string, unknown>): Record<string, unknown> => {
  ctx.outbound.length = 0;
  const out = JSON.parse(executeTool('book_taxi', input, ctx as never)) as Record<string, unknown>;
  for (const m of ctx.outbound) {
    const mm = m as { text?: string; buttons?: { title: string }[] };
    console.log('');
    console.log('  → Shawn');
    for (const line of (mm.text ?? '').split(NL)) console.log(`      ${line}`);
    if (mm.buttons) console.log(`      ${mm.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
  }
  return out;
};

callBook({
  pickup_address: 'Diamond',
  destination_address: 'Georgetown',
  passenger_name: 'Shawn Adams',
});

rule('He agrees the fare');

const { fareButtons } = await import('./src/place-picker.ts');
const bookIt = fareButtons('$1,800', 'en').buttons![0]!;
await taps(SHAWN, bookIt.title, bookIt.id);

model('and the note says: book it now, fare_confirmed true.');
const booked = callBook({
  pickup_address: 'Diamond',
  destination_address: 'Georgetown',
  passenger_name: 'Shawn Adams',
  fare_confirmed: true,
});
console.log('');
console.log(`  ${booked.job_number ?? '(not booked)'} — ${booked.fare ?? ''}`);

// Booking dispatches: the job card goes out to the associates after the
// passenger has been answered, and this walkthrough called the tool
// directly, so nothing has waited for it.
await settle();

/* ------------------------------------------------------------ the driver */

const job = String(booked.job_number ?? '');

/** Taps whatever the shop has just put in front of the DRIVER. */
const driverTaps = async (wanted: RegExp): Promise<boolean> => {
  const offered = lastButtonsFor[DRIVER] ?? [];
  const button = offered.find((b) => wanted.test(b.title));
  if (!button) {
    console.log('');
    console.log(`  (nothing matching ${wanted} on his card — he has: ${offered.map((b) => b.title).join(', ') || 'nothing'})`);
    return false;
  }
  await taps(DRIVER, button.title, button.id);
  return true;
};

rule('The job reaches Rider One');

await driverTaps(/accept|take/i);
console.log('');
console.log(`  ${job} is ${repo.findOrder(job)?.status}, carried by ` +
  `${repo.getAssociate(repo.findOrder(job)?.driverPhone ?? '')?.name ?? 'nobody'}`);

rule('And carries the trip through');

// Whatever is on his card, taking the way FORWARD each time — never the
// cancel, never the clock, never a change of destination. Four steps is
// more than the trip needs; it stops when there is nothing left to tap.
for (let leg = 0; leg < 4; leg += 1) {
  const onward = (lastButtonsFor[DRIVER] ?? []).find(
    (b) => !/cancel|clock off|change destination|waiting/i.test(b.title),
  );
  if (!onward) break;
  await taps(DRIVER, onward.title, onward.id);
  if (repo.findOrder(job)?.status === 'delivered') break;
}

const done = repo.findOrder(job);
console.log('');
console.log(`  ${job} is ${done?.status}, fare $${done?.quotedFare}, ` +
  `carried by ${repo.getAssociate(done?.driverPhone ?? '')?.name ?? 'nobody'}`);
console.log('');

process.exit(0);

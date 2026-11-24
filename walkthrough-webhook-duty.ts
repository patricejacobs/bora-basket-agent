/**
 * The duty taps, driven through the REAL webhook.
 *
 *   node walkthrough-webhook-duty.ts
 *
 * Not the handlers: the HTTP endpoint Meta posts to. Each tap is built as the
 * payload WhatsApp actually sends — an interactive `button_reply` carrying an
 * id and a title — signed with the app secret the way Meta signs it, and
 * POSTed to a running server.
 *
 * That is the whole point for these two buttons. `duty_off` shipped with no
 * reader at all and worked only because the webhook falls back to a button's
 * TITLE, and "Clock off" happens to match what a driver can type. The id and
 * the title are deliberately made to disagree below: the title is sent as
 * nonsense, so if anything is still reading titles instead of ids, these
 * taps do nothing and this walkthrough says so.
 *
 * The outbound side has no token, so every message the shop sends is dropped
 * to the console and printed here instead of reaching a telephone.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WALK_DB = path.resolve('./data/walk-webhook-duty.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.ASSOCIATE_DUTY_HOURS = '12';
process.env.ASSOCIATE_MAX_HOURS_PER_DAY = '0';
process.env.DUTY_CHECK_IN_MINUTES = '15';

const SECRET = 'a-test-app-secret-not-a-real-one';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.PORT = '3988';

const RIDER = '5926001111';
process.env.DRIVER_NUMBERS = RIDER;

const NL = String.fromCharCode(10);
const WHO: Record<string, string> = { [RIDER]: 'Rider One' };

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
      console.log('  → ' + (WHO[p.to ?? ''] ?? '+' + (p.to ?? '')));
      for (const line of body.split(NL)) console.log('      ' + line);
      if (buttons.length > 0) {
        console.log('      ' + buttons.map((b) => `[ ${b.reply.title} ]`).join('  '));
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
const { sweepCheckIns } = await import('./src/duty-check-in.ts');
const { DUTY_ON, DUTY_OFF } = await import('./src/duty-buttons.ts');
// Importing it starts it: the server listens as a side effect of being
// loaded, which is what `npm start` relies on.
await import('./src/server.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
};

repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);

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
/** One inbound message, signed the way Meta signs it. */
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
  // The route answers 200 before it works, so give the handler a moment.
  await new Promise((done) => setTimeout(done, 400));
  return res.status;
};

/**
 * A tap, with a title that means nothing on purpose.
 *
 * If the shop is reading titles rather than ids, "⬜" matches no command and
 * the tap is answered with the help text — which is exactly what a dead
 * button looks like on a phone.
 */
const tap = async (id: string, label: string): Promise<void> => {
  console.log('');
  console.log(`  Rider One taps [ ${label} ]   (id "${id}", title sent as "⬜")`);
  const status = await post(RIDER, {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title: '⬜' } },
  });
  if (status !== 200) console.log(`      !! the webhook answered ${status}`);
};

const state = (): void => {
  const since = repo.onDutySince(RIDER);
  console.log('');
  console.log(
    `      · on duty ${repo.isOnDuty(RIDER)}` +
      ` · clocked on ${since ? `${((Date.now() - new Date(since).getTime()) / 3600_000).toFixed(2)}h ago` : 'no'}` +
      ` · worked ${repo.hoursWorkedToday(RIDER).toFixed(2)}h`,
  );
};

/* ----------------------------------------------------------- the sequence */

rule('He types `on`');

await post(RIDER, { type: 'text', text: { body: 'on' } });
state();

rule('Eleven hours and fifty minutes later');

const backdate = (hours: number): void => {
  const when = new Date(Date.now() - hours * 3600_000).toISOString();
  db.prepare(`UPDATE associates SET on_duty_at = ? WHERE phone = ?`).run(when, RIDER);
  db.prepare(`UPDATE associate_shifts SET started_at = ? WHERE phone = ? AND ended_at = ''`)
    .run(when, RIDER);
};
backdate(11 + 50 / 60);
console.log('');
console.log(`  the sweep asks ${await sweepCheckIns()}`);

rule('He taps [ Yes, still working ]');

await tap(DUTY_ON, 'Yes, still working');
state();
console.log('      (a fresh stretch — the lapse clock is back to zero, the hours are not)');

rule('And at the end of the night, [ Clock off ]');

await tap(DUTY_OFF, 'Clock off');
state();

rule('An unsigned request is still refused');

const bad = await fetch(`${base}/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
});
console.log('');
console.log(`      a webhook with no signature: ${bad.status}`);
console.log('');

// The server has no stop: it listens for the life of the process.
process.exit(0);

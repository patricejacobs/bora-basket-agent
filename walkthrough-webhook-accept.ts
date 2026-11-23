/**
 * Accept → Uplifted → delivered, driven through the REAL webhook.
 *
 *   node walkthrough-webhook-accept.ts
 *
 * Not the handlers this time: the HTTP endpoint Meta posts to. Each tap is
 * built as the payload WhatsApp actually sends — an interactive
 * `button_reply` carrying an id and a title — signed with the app secret the
 * way Meta signs it, and POSTed to a running server. That exercises the parts
 * no handler test reaches: the signature check, the de-duplication of
 * retries, the staff/customer routing, and the id-versus-title decision that
 * has silently killed three buttons.
 *
 * The outbound side has no token, so every message the shop sends is dropped
 * to the console and printed here instead of reaching a telephone.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WALK_DB = path.resolve('./data/walk-webhook.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';

const SECRET = 'a-test-app-secret-not-a-real-one';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
process.env.PORT = '3987';

const ONE = '5926001111';
const TWO = '5926002222';
process.env.DRIVER_NUMBERS = `${ONE},${TWO}`;

const NL = String.fromCharCode(10);
const BUYER = '5926100001';
const WHO: Record<string, string> = { [ONE]: 'Rider One', [TWO]: 'Rider Two', [BUYER]: 'Ann' };

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
      // The read receipt the shop sends for every inbound message. It has no
      // recipient and no body, and printing it as a blank message makes the
      // transcript harder to read than the thing it documents.
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
const { handleDriverMessage } = await import('./src/staff.ts');
// Importing it starts it: the server listens as a side effect of being
// loaded, which is what `npm start` relies on.
await import('./src/server.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
};

/* ---------------------------------------------------------------- the shop */

const shop = repo.defaultGrocery()!;
repo.upsertProduct({
  sku: 'R1', name: 'Rice', description: '', category: 'Rice', unit: 'bag', price: 1850,
  stock: 60, active: 1, keywords: 'rice', trackStock: 1, outletId: shop.id,
} as never);
const rice = (db.prepare(`SELECT id FROM products WHERE sku='R1'`).get() as { id: number }).id;
for (const [phone, name, van] of [[ONE, 'Rider One', 'NEW 5678'], [TWO, 'Rider Two', 'PAA 2222']] as const) {
  repo.upsertAssociate({ phone, name, vehicle: van, active: 1 } as never);
  await handleDriverMessage('on', phone);
}
repo.chooseLanguage(BUYER, 'en');
repo.logMessage(BUYER, 'in', 'whatsapp', 'hello');
repo.setService(BUYER, 'grocery');
repo.saveCustomer(BUYER, { name: 'Ann Persaud', contactPhone: BUYER, address: 'Lot 4 Diamond' });
repo.setCartQty(BUYER, rice, 2, '');
repo.setDeliveryZone(BUYER, 'Diamond');
repo.setFeeAgreed(BUYER, repo.getCart(BUYER).deliveryFee);
const job = repo.placeOrder({
  phone: BUYER, customerName: 'Ann Persaud', address: 'Lot 4 Diamond', contactPhone: BUYER,
  deliveryNote: '', paymentMethod: 'cash_on_delivery',
  location: { latitude: 6.7558, longitude: -58.1699, label: 'Diamond' },
} as never);
const n = String(repo.orderDigits(job.orderNo));

/* ------------------------------------------------------------- the server */

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
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body: raw,
  });
  // The route answers 200 before it works, so give the handler a moment.
  await new Promise((done) => setTimeout(done, 400));
  return res.status;
};

const tap = async (from: string, id: string, title: string): Promise<void> => {
  console.log('');
  console.log(`  ${WHO[from]} taps [ ${title} ]   (id "${id}")`);
  const status = await post(from, {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id, title } },
  });
  if (status !== 200) console.log(`      !! the webhook answered ${status}`);
};

/* ----------------------------------------------------------- the sequence */

rule('The food is up, and both are offered it');

const { dispatchToDrivers } = await import('./src/dispatch.ts');
repo.setOrderStatus(job.orderNo, 'ready');
await dispatchToDrivers(job.orderNo);

rule('Rider One taps Accept');
await tap(ONE, `take_${n}`, 'Accept');

rule('Rider Two taps the Accept in his chat');
await tap(TWO, `take_${n}`, 'Accept');

rule('Rider One taps Uplifted');
await tap(ONE, `otw_${n}`, 'Uplifted');

rule('At the door, Ann reads her code and he types it');
const code = repo.deliveryCodeFor(job.orderNo);
console.log('');
console.log(`  Rider One types ${code}`);
await post(ONE, { type: 'text', text: { body: code } });

rule('And an unsigned request is refused');
const bad = await fetch(`${base}/whatsapp/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
});
console.log('');
console.log(`      a webhook with no signature: ${bad.status}`);

console.log('');
console.log(`  ${job.orderNo} is now ${repo.findOrder(job.orderNo)!.status}, carried by ` +
  `${repo.getAssociate(repo.findOrder(job.orderNo)!.driverPhone)?.name ?? 'nobody'}.`);
console.log('');

// The server has no stop: it listens for the life of the process, which is
// what a deployment wants and what this walkthrough has to live with.
process.exit(0);

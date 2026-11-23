/**
 * A PARCEL redirected on the road, end to end.
 *
 *   node walkthrough-parcel-move.ts
 *
 * The sister of walkthrough-address-change.ts, which follows a grocery
 * delivery. A parcel is the harder one and for a specific reason: it is
 * priced from BOTH ends, it is paid by the sender at the uplift, and the
 * person at the door is not the person who can change the address — so the
 * question goes to whoever booked it.
 *
 * Every message below is captured as it leaves: with no WhatsApp token
 * configured the sender drops each payload to the console, so what is
 * printed is the actual body that would have gone to the actual number.
 * Nothing reaches a real telephone and no agent turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-parcel-move.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';

const RIDER = '5926001111';
const SENDER = '5926100002';
const RECIPIENT = '5926107777';
process.env.DRIVER_NUMBERS = RIDER;
process.env.STORE_NAME = 'Next Minute Delivery';

/* ------------------------------------------------- catching what goes out */

const NL = String.fromCharCode(10);
const WHO: Record<string, string> = {
  [RIDER]: 'Rider One',
  [SENDER]: 'Rohan (sender)',
  [RECIPIENT]: 'Jenny (at the door)',
};
let watching = false;

const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  const first = String(args[0] ?? '');
  if (watching && first.startsWith('[whatsapp] not configured')) {
    try {
      const payload = JSON.parse(String(args[1] ?? '{}')) as {
        to?: string;
        text?: { body?: string };
        interactive?: {
          body?: { text?: string };
          action?: { buttons?: { reply: { title: string } }[] };
        };
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

const repo = await import('./src/db/repo.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { money } = await import('./src/config.ts');
const { fareBetween, findZone } = await import('./src/zones.ts');

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
const customer = async (what: string, body: Record<string, unknown>): Promise<void> => {
  console.log('');
  console.log(`  Rohan ▸ ${what}`);
  for (const m of await handleIncoming({ phone: SENDER, channel: 'whatsapp', ...body } as never)) {
    console.log('');
    console.log(`  → Rohan (sender)`);
    for (const line of ((m as { text?: string }).text ?? '').split(NL)) console.log(`      ${line}`);
  }
};

repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
await handleDriverMessage('on', RIDER);

/* ------------------------------------------------- 1. booked, Kitty → Diamond */

rule('1. Booked — Kitty to Diamond');

repo.logMessage(SENDER, 'in', 'whatsapp', 'I need to send a parcel');
repo.chooseLanguage(SENDER, 'en');
repo.setService(SENDER, 'parcel');
repo.saveCustomer(SENDER, { name: 'Rohan Singh', address: 'Lot 2 Kitty', contactPhone: SENDER });

const ctx = { phone: SENDER, outbound: [] as unknown[] };

// Priced the way the parcel service prices: both ends together, the uplift
// zone and the destination zone, not the destination alone.
const { settleDeliveryPlace } = await import('./src/delivery-place.ts');
repo.saveParcelParty(SENDER, 'sender', {
  name: 'Rohan Singh', address: 'Kitty', phone: SENDER,
});
repo.saveParcelParty(SENDER, 'recipient', {
  name: 'Jenny Baird', address: 'Diamond', phone: RECIPIENT,
});
const settled = settleDeliveryPlace(SENDER, 'Diamond');
console.log(`  priced Kitty → Diamond: ${settled ? money(settled.fee) : 'not priced'}` +
  `${settled?.pricedBy ? ` — ${settled.pricedBy}` : ''}`);

const made = JSON.parse(
  executeTool(
    'create_parcel_job',
    {
      contents: 'A box of documents, about 2 kg',
      sender_name: 'Rohan Singh',
      sender_phone: SENDER,
      recipient_name: 'Jenny Baird',
      recipient_phone: RECIPIENT,
      pickup_note: 'Lot 2 Kitty, the green house with the gate',
      destination_note: 'Lot 40 Diamond, upstairs flat',
    },
    ctx as never,
  ),
);
console.log(`  create_parcel_job -> ${made.job_number ?? JSON.stringify(made).slice(0, 140)}`);
const job = repo.findOrder(String(made.job_number))!;
const n = String(repo.orderDigits(job.orderNo));
console.log(`  ${job.orderNo} — to ${job.address}, fee ${money(job.deliveryFee)}, zone "${job.deliveryZone}"`);

watching = true;
await rider(`${n} confirm`);
await rider(`${n} uplifted`);

/* ---------------------------------------- 2. the sender moves the delivery */

rule('2. Rohan moves it to Parika, while it is out');

console.log('');
console.log('  What the two ways of pricing would say:');
const bothEnds = fareBetween('Kitty', 'Parika');
const destOnly = findZone('Parika');
console.log(`    both ends (Kitty → Parika): ${bothEnds ? money(bothEnds.fee) : 'not priced'}` +
  `${bothEnds?.explanation ? ` — ${bothEnds.explanation}` : ''}`);
console.log(
  `    destination alone (Parika): ${destOnly.kind === 'found' ? money(destOnly.match.fee) : 'not priced'}`,
);

const quote = JSON.parse(executeTool('change_destination', { new_destination: 'Parika' }, ctx as never));
console.log('');
console.log(`  change_destination (quote) -> ${JSON.stringify(quote).slice(0, 180)}`);
const agreed = JSON.parse(
  executeTool('change_destination', { new_destination: 'Parika', confirmed: true }, ctx as never),
);
console.log(`  change_destination (yes)   -> ${JSON.stringify(agreed).slice(0, 180)}`);
for (const m of ctx.outbound as { kind: string; text?: string; buttons?: { title: string }[] }[]) {
  console.log('');
  console.log('  → Rohan (sender)');
  for (const line of (m.text ?? '').split(NL)) console.log(`      ${line}`);
  if (m.buttons) console.log(`      ${m.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
}

rule('3. He pins the new door');

await customer('(sends a location pin)', {
  text: '',
  location: { latitude: 6.8167, longitude: -58.4167, label: 'Parika' },
});

rule('4. The associate acknowledges it');

await rider(`dest_ok_${n}`);
const moved = repo.findOrder(job.orderNo)!;
console.log('');
console.log(`  ${moved.orderNo} — to ${moved.address}, fee ${money(moved.deliveryFee)}, total ${money(moved.total)}`);

rule('5. The associate asks for the details, then the door');

await rider(`${n} details`);

rule('6. Closed at the new door');

await rider(repo.deliveryCodeFor(job.orderNo));

watching = false;
console.log('');

const after = repo.findOrder(job.orderNo)!;
console.log(`  [check] pin on the order:  ${JSON.stringify(after.location)}`);
console.log(`  [check] marked for Jenny:  ${after.recipientPin}`);
console.log('');
console.log('  The two pricings, for a parcel going the OTHER way:');
const back1 = fareBetween('Parika', 'Diamond');
const back2 = findZone('Diamond');
console.log(`    both ends (Parika → Diamond): ${back1 ? money(back1.fee) : 'not priced'}`);
console.log(`    destination alone (Diamond):  ${back2.kind === 'found' ? money(back2.match.fee) : 'not priced'}`);
console.log('');
console.log(`  Paid at the uplift: ${money(1800)}. Charged after the move: ${money(after.deliveryFee)}.`);
console.log(`  Difference nobody collected: ${money(after.deliveryFee - 1800)}.`);

/**
 * One collection job, end to end: cardboard from a store, taken to a customer.
 *
 * A collection is a parcel whose "sender" is a shop rather than a person. It
 * exercises the unpriced path, since PARCEL_FEE_BASE is 0 — which is where the
 * new "the delivery associate will confirm the cost" wording lives.
 */
process.env.DATABASE_PATH = process.argv[2]!;
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.STAFF_NUMBERS = '5926497570';
process.env.DRIVER_NUMBERS = '5926001111';
// Left at 0 deliberately: this is the shop's live setting, so the run shows
// what a real customer is told today.
process.env.PARCEL_FEE_BASE = '0';
process.env.PARCEL_FEE_PER_KM = '0';

const repo = await import('./src/db/repo.ts');
const { executeTool } = await import('./src/agent/tools.ts');
const { handleDriverMessage, handleStaffMessage } = await import('./src/staff.ts');
const { parcelOfferCard, parcelUpliftCard, dropLines, offerParcel } = await import('./src/dispatch.ts');
const { notifyStaffOfNewOrder, customerStatusMessage } = await import('./src/notifications.ts');

const DESK = '5926497570';
const RIDER = '5926001111';
const BOOKER = '5926100001';

repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'GSS 1234', active: 1 } as never);
await handleDriverMessage('on', RIDER);
for (const p of [DESK, RIDER, BOOKER]) repo.logMessage(p, 'in', 'whatsapp', 'hello');

const nl = String.fromCharCode(10);
const rule = (t: string): void => {
  console.log('');
  console.log(`████  ${t}  ${'█'.repeat(Math.max(0, 48 - t.length))}`);
};
const card = (who: string, body: string, buttons?: string[]): void => {
  console.log('');
  console.log(`╔═ → ${who}`);
  for (const l of body.split(nl)) console.log(l ? `║ ${l}` : '║');
  if (buttons?.length) console.log(`║ ${buttons.map((b) => `[ ${b} ]`).join('  ')}`);
  console.log('╚' + '═'.repeat(58));
};
const says = async (who: string, typed: string, fn: () => Promise<{ kind: string; text?: string }[]>): Promise<void> => {
  console.log('');
  console.log(`  ${who} ▸ "${typed}"`);
  for (const m of await fn()) {
    if (m.kind === 'location') continue;
    for (const l of (m.text ?? '').split(nl)) console.log(`      ${l}`);
    const b = (m as { buttons?: { title: string }[] }).buttons;
    if (b) console.log(`      ${b.map((x) => `[ ${x.title} ]`).join('  ')}`);
  }
};

/* ------------------------------------------------- the customer books it */

rule('1. THE BOOKING');

repo.setService(BOOKER, 'parcel');
// Where it is collected from: the store. A pin, as the agent would have
// collected one.
repo.saveLocationPin(BOOKER, { latitude: 6.8101, longitude: -58.1575, label: 'Brickdam' });

const booked = JSON.parse(
  executeTool(
    'create_parcel_job',
    {
      contents: '6 flattened cardboard boxes',
      sender_name: 'Brickdam Hardware',
      sender_phone: '5926105555',
      recipient_name: 'Marcia Persaud',
      recipient_phone: '5926100077',
      pickup_note: 'Ask at the back counter for Shawn',
      destination_note: 'Blue gate, leave inside the fence',
    },
    { phone: BOOKER },
  ),
) as Record<string, unknown>;

console.log('');
console.log('  the booking tool returned:');
for (const [k, v] of Object.entries(booked)) {
  console.log(`      ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

const orderNo = String(booked.job_number ?? booked.order_number ?? '');
const n = String(Number(orderNo.replace(/[^0-9]/g, '')));
const order = () => repo.findOrder(orderNo)!;

/* ------------------------------------------------------------ dispatched */

rule('2. WHO IS TOLD');

await notifyStaffOfNewOrder(orderNo);
card('the dispatch desk', 'see the staff card above in the log');
card('every free associate', parcelOfferCard(order()), ['Accept']);
await offerParcel(orderNo);

rule('3. THE ASSOCIATE TAKES IT');

await says('Rider One', `${n} accept`, () => handleDriverMessage(`${n} accept`, RIDER));
card('Rider One — the uplift card', parcelUpliftCard(order()));

rule('4. COLLECTED, AND ON ITS WAY');

await says('Rider One', `${n} uplifted`, () => handleDriverMessage(`${n} uplifted`, RIDER));
card('Brickdam Hardware (the sender)', customerStatusMessage(order(), 'on_the_way', 'en'));
card('Rider One — the drop', dropLines(order()).filter(Boolean).join(nl));

rule('5. AT THE GATE');

const code = repo.deliveryCodeFor(orderNo);
const wrong = code === '1111' ? '2222' : '1111';
await says('Rider One', wrong, () => handleDriverMessage(wrong, RIDER));
await says('Rider One', code, () => handleDriverMessage(code, RIDER));

rule('6. THE RECORD');

card('the shop', (await handleStaffMessage(`${n} history`, DESK))[0]?.text ?? '');
console.log('');

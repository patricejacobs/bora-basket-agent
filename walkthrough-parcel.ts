/**
 * One parcel, booked to delivered — and one that comes back.
 *
 * Drives the real handlers against a scratch database and prints what each
 * person receives. Companion to walkthrough.ts, which does the food round.
 */
import { db } from './src/db/index.ts';
import * as repo from './src/db/repo.ts';
import { handleDriverMessage, handleStaffMessage } from './src/staff.ts';
import { offerParcel } from './src/dispatch.ts';
import { notifyCustomerOfStatus } from './src/notifications.ts';
import { money } from './src/config.ts';

const RIDER = '5926001111';
const STAFF = '5926497570';
const SENDER = '5926100001';

const rule = (t: string): void => {
  console.log('');
  console.log(`──────── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);
  console.log('');
};
const gets = (who: string, text: string): void => {
  console.log(`  ${who} ◂`);
  for (const line of text.split('\n')) console.log(`      ${line}`);
};
const show = async (who: string, typed: string): Promise<void> => {
  console.log(`  ${who} ▸ "${typed}"`);
  for (const m of await handleDriverMessage(typed, RIDER)) {
    if (m.kind === 'location') continue;
    gets(who, m.text ?? '');
  }
};

repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
repo.setDuty(RIDER, true);

const book = (no: string) =>
  db
    .prepare(
      `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone,
         delivery_note, kind, recipient_name, recipient_phone, recipient_pin,
         pickup_address, pickup_lat, pickup_lng, delivery_code, code_sent_at,
         latitude, longitude, location_label,
         subtotal, delivery_fee, total, payment_method, status, created_at)
       VALUES (?, ?, 'Patrice', '94 Thomas St, Georgetown', ?, '', 'parcel',
         'Harry Paul', '5926100099', 1, 'Lot 12, Kitty', 6.8013, -58.1551,
         '2149', '2026-11-12T18:40:00Z', 6.8124, -58.1591, '',
         0, 150000, 150000, 'cash_on_delivery', 'pending', '2026-11-12T18:00:00Z')`,
    )
    .run(no, SENDER, SENDER);

/* ------------------------------------------------------------------ */

rule('1. Patrice books a parcel to Harry Paul');
book('ORD-00001');
console.log(`  ORD-00001 — ${money(150000)}, Lot 12 Kitty → 94 Thomas St`);
repo.logMessage(SENDER, 'in', 'whatsapp', 'I want to send a parcel');

rule('2. Offered to every free associate the moment it is booked');
const offered = await offerParcel('ORD-00001');
console.log(`  offerParcel → ${offered}`);

rule('3. Rider One accepts it');
await show('Rider One', '1 confirm');

rule('4. Uplifts it, taking the cash from Patrice');
await show('Rider One', '1 uplifted');

rule('5. What Patrice is told');
await notifyCustomerOfStatus(repo.findOrder('ORD-00001')!, 'on_the_way');

rule('6. Harry reads out the code');
await show('Rider One', '2149');

rule('7. Now the one that comes back');
book('ORD-00002');
repo.logMessage(SENDER, 'in', 'whatsapp', 'another one please');
await offerParcel('ORD-00002');
await show('Rider One', '2 confirm');
await show('Rider One', '2 uplifted');

rule('8. Nobody at the door');
await show('Rider One', '2 nobody home');

rule('9. What Patrice is told');
const back = repo.findOrder('ORD-00002')!;
const { t } = await import('./src/language.ts');
gets('Patrice', t('returned_to_sender', 'en', { order: back.orderNo, name: 'Harry Paul' }));

rule('10. The money, counted from the uplift — both of them');
for (const m of await handleStaffMessage('cash', STAFF)) gets('shop', m.text ?? '');
console.log('');

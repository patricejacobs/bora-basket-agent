/**
 * One parcel, booked to delivered — and one that comes back.
 *
 * Booked from an office number by somebody who is neither the sender nor the
 * recipient, with no pins at either end and a telephone number carelessly
 * written into the pickup address. That is the awkward case, and it is the one
 * worth printing.
 *
 * Drives the real handlers against a scratch database. Companion to
 * walkthrough.ts, which does the food round.
 */
import { db } from './src/db/index.ts';
import * as repo from './src/db/repo.ts';
import { handleDriverMessage, handleStaffMessage } from './src/staff.ts';
import { offerParcel } from './src/dispatch.ts';
import { customerStatusMessage, notifyCustomerOfStatus } from './src/notifications.ts';
import { money } from './src/config.ts';

const RIDER = '5926001111';
const STAFF = '5926497570';
const OFFICE = '5926499999';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
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
// A number saved against the booking account from some past delivery. Nothing
// about this parcel may come from it.
repo.saveCustomer(OFFICE, { name: 'Reception', contactPhone: '9998887' });
repo.logMessage(OFFICE, 'in', 'whatsapp', 'I need to send a parcel');

const book = () =>
  repo.createParcelJob({
    phone: OFFICE,
    senderName: 'Peter Higg',
    pickup: null,
    pickupAddress: '23 High St, Georgetown, ring 677 1234 on arrival',
    destination: null,
    destinationAddress: '54 Kier Street, Georgetown — white fence',
    recipientName: 'Frank Doly',
    recipientPhone: '5926588596',
    contents: 'A box of papers, about 10 lbs',
    fee: 150000,
    contactPhone: '5926771234',
  });

/* ------------------------------------------------------------------ */

rule('1. Booked from an office, for two other people');
const first = book();
const o = repo.findOrder(first.orderNo)!;
console.log(`  booked from : ${o.phone}  (saved contact on that account: 9998887)`);
console.log(`  sender      : ${o.customerName} ${o.contactPhone}`);
console.log(`  recipient   : ${o.recipientName} ${o.recipientPhone}`);
console.log(`  fee         : ${money(o.total)}`);
console.log(`  pickup typed: "${o.pickup?.address}"`);

rule('2. Offered to every free associate');
console.log(`  offerParcel → ${await offerParcel(first.orderNo)}`);

rule('3. Accepts it — note the address and the number');
await show('Rider One', `${Number(first.orderNo.replace(/\D/g, ''))} confirm`);

rule('4. Uplifts it, taking the cash from the sender');
await show('Rider One', `${Number(first.orderNo.replace(/\D/g, ''))} uplifted`);

rule('5. What the booker is told');
await notifyCustomerOfStatus(repo.findOrder(first.orderNo)!, 'on_the_way');
// The real composition, not a rebuilt copy of it.
gets('Reception', customerStatusMessage(repo.findOrder(first.orderNo)!, 'on_the_way'));

rule('6. Frank reads out the code');
await show('Rider One', repo.deliveryCodeFor(first.orderNo));

rule('7. A second parcel — nobody at the door');
const second = book();
const n2 = String(Number(second.orderNo.replace(/\D/g, '')));
await offerParcel(second.orderNo);
await show('Rider One', `${n2} confirm`);
await show('Rider One', `${n2} uplifted`);
await show('Rider One', `${n2} nobody home`);

rule('8. What the booker is told about that one');
gets('Reception', customerStatusMessage(repo.findOrder(second.orderNo)!, 'returned'));

rule('9. The money — both, counted from the uplift');
for (const m of await handleStaffMessage('cash', STAFF)) gets('shop', m.text ?? '');
console.log('');

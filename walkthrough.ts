/**
 * An end-to-end walkthrough of one delivery, printed as the messages each
 * person actually receives.
 *
 * Not a test — the suite is the test. This exists to be read: it drives the
 * real handlers against a scratch database and shows what comes out, so the
 * shop can see the journey rather than take a passing check count on trust.
 */
import { db } from './src/db/index.ts';
import * as repo from './src/db/repo.ts';
import { handleDriverMessage, handleOutletMessage, handleStaffMessage } from './src/staff.ts';
import { deliveredMessage, doorCodeLine } from './src/notifications.ts';
import { dropLines } from './src/dispatch.ts';
import { t } from './src/language.ts';
import { money } from './src/config.ts';

const RIDER = '5926001111';
const STAFF = '5926497570';
const BUYER = '5926100001';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
  console.log('');
};
const says = (who: string, text: string): void => console.log(`  ${who} ▸ ${text}`);
const gets = (who: string, text: string): void => {
  console.log(`  ${who} ◂`);
  for (const line of text.split('\n')) console.log(`      ${line}`);
};
const show = async (
  who: string,
  typed: string,
  fn: () => Promise<{ kind: string; text?: string }[]>,
): Promise<void> => {
  says(who, `"${typed}"`);
  for (const m of await fn()) {
    if (m.kind === 'location') continue;
    gets(who, m.text ?? '');
  }
};

/* ---------------------------------------------------------------- set-up */

repo.upsertOutlet({
  code: 'TOG',
  name: 'A Taste of Guyana',
  hours: '24 hours',
  prepMinutes: 20,
  pickupAddress: 'Sheriff Street, Georgetown',
  pickupLat: 6.8042,
  pickupLng: -58.1409,
  whatsapp: '5926105555',
  accepting: 1,
  active: 1,
});
const outlet = repo.getOutlet('TOG')!;
repo.upsertAssociate({
  phone: RIDER,
  name: 'Rider One',
  vehicle: 'NEW 5678',
  active: 1,
} as never);

repo.upsertProduct({
  sku: 'TOG-ROTI',
  name: 'Chicken Curry with Roti',
  description: '',
  category: 'Mains',
  unit: 'each',
  price: 185000,
  stock: 0,
  active: 1,
  keywords: 'roti curry',
  outletId: outlet.id,
  trackStock: 0,
});
repo.upsertProduct({
  sku: 'TOG-CHOW',
  name: 'Chicken Chow Mein',
  description: '',
  category: 'Mains',
  unit: 'each',
  price: 150000,
  stock: 0,
  active: 1,
  keywords: 'chow mein',
  outletId: outlet.id,
  trackStock: 0,
});
const roti = (db.prepare(`SELECT id FROM products WHERE sku='TOG-ROTI'`).get() as { id: number }).id;
const chow = (db.prepare(`SELECT id FROM products WHERE sku='TOG-CHOW'`).get() as { id: number }).id;

/* ------------------------------------------------- 1. the order is placed */

rule('1. Marcia orders, for Dave, at an address she is not at');

repo.saveLocationPin(BUYER, { latitude: 6.642, longitude: -58.218, label: 'Diamond' });
repo.saveCustomer(BUYER, {
  name: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
});
repo.logMessage(BUYER, 'in', 'whatsapp', 'I want to send food to my son');
repo.setCartQty(BUYER, roti, 1, '');
const first = repo.placeOrder({
  phone: BUYER,
  customerName: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
  deliveryNote: 'Upstairs flat, white fence',
  paymentMethod: 'cash',
  location: repo.getIdentity(BUYER).location,
  recipientName: 'Dave Singh',
  recipientPhone: '5926100099',
});
// A second order from the same kitchen, for the one-at-a-time case below.
repo.setCartQty(BUYER, chow, 1, '');
const second = repo.placeOrder({
  phone: BUYER,
  customerName: 'Marcia Persaud',
  address: 'Lot 4 Section C, Diamond — white fence, upstairs',
  contactPhone: BUYER,
  deliveryNote: '',
  paymentMethod: 'cash',
  location: repo.getIdentity(BUYER).location,
});
const n1 = String(Number(first.orderNo.replace(/\D/g, '')));
const n2 = String(Number(second.orderNo.replace(/\D/g, '')));
console.log(`  ${first.orderNo} — for Dave Singh, ${money(235000)}`);
console.log(`  ${second.orderNo} — for Marcia herself`);

/* ------------------------------------------------ 2. kitchen and dispatch */

rule('2. The kitchen accepts and cooks');

await show('kitchen', `${n1} confirm`, () => handleOutletMessage(outlet, `${n1} confirm`));
await show('kitchen', `${n1} ready`, () => handleOutletMessage(outlet, `${n1} ready`));
await show('kitchen', `${n2} confirm`, () => handleOutletMessage(outlet, `${n2} confirm`));
await show('kitchen', `${n2} ready`, () => handleOutletMessage(outlet, `${n2} ready`));

rule('3. What Marcia is told when it leaves — note whose code it is');

const live = repo.findOrder(first.orderNo)!;
gets(
  'Marcia',
  t('on_the_way', 'en', { name: 'Marcia', order: live.orderNo, total: money(live.total) }) +
    doorCodeLine(live, 'en'),
);
const code = repo.deliveryCodeFor(first.orderNo);

/* ----------------------------------------------------- 4. the associate */

rule('4. Rider One clocks on and looks at the queue');

await show('Rider One', 'on', () => handleDriverMessage('on', RIDER));
await show('Rider One', 'jobs', () => handleDriverMessage('jobs', RIDER));

rule('5. The job card — who ordered, who receives, who pays');

gets('Rider One', dropLines(repo.findOrder(first.orderNo)!).join('\n'));

rule('6. Uplifts it');

await show('Rider One', `${n1} uplifted`, () => handleDriverMessage(`${n1} uplifted`, RIDER));

rule('7. Tries to take the second order while the first is undelivered');

await show('Rider One', `${n2} uplifted`, () => handleDriverMessage(`${n2} uplifted`, RIDER));

rule('8. At the door, types the wrong ORDER NUMBER with a code');

await show('Rider One', `${n2} ${code}`, () => handleDriverMessage(`${n2} ${code}`, RIDER));
console.log(
  `      (${second.orderNo} attempts used: ${repo.deliveryCodeState(second.orderNo).attempts} — untouched)`,
);

rule('9. Right order, wrong code');

const wrong = code === '1111' ? '2222' : '1111';
await show('Rider One', wrong, () => handleDriverMessage(wrong, RIDER));

rule('10. Dave reads out the real code');

await show('Rider One', code, () => handleDriverMessage(code, RIDER));

rule('11. What Marcia gets at the close');

gets('Marcia', deliveredMessage(repo.findOrder(first.orderNo)!, 'en'));

rule('12. Free again — the second order can now be uplifted');

await show('Rider One', `${n2} uplifted`, () => handleDriverMessage(`${n2} uplifted`, RIDER));
await show('Rider One', 'cash', () => handleDriverMessage('cash', RIDER));

rule('13. A cancellation while he is carrying it');

repo.setOrderStatus(second.orderNo, 'cancelled');
db.prepare(`UPDATE orders SET cancel_reason = 'Customer changed their mind' WHERE order_no = ?`).run(
  second.orderNo,
);
await show('Rider One', `${n2} delivered`, () => handleDriverMessage(`${n2} delivered`, RIDER));

rule('14. The shop counts the money');

await show('shop', 'cash', () => handleStaffMessage('cash', STAFF));

console.log('');

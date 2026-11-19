/**
 * The question at the end of a delivery, and both ways it can go.
 *
 *   node walkthrough-rating.ts
 *
 * Two customers. One taps five stars and is left alone; the other taps two,
 * is asked what went wrong, and says. The shop reads the month afterwards.
 *
 * The third case is the one worth watching: a customer who ignores the
 * question and gets on with ordering. Their "2" has to mean the second
 * kitchen, not two stars, and that is the only part of this that can quietly
 * eat somebody's order.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-rating.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.STAFF_NUMBERS = '5926497570';
process.env.STORE_NAME = 'Next Minute Delivery';

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { handleStaffMessage } = await import('./src/staff.ts');
const { ratingAsk, shouldAsk } = await import('./src/ratings.ts');

const SHOP = '5926497570';
const HAPPY = '5926200001';
const CROSS = '5926200002';

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
  console.log('');
};
const gets = (who: string, text: string): void => {
  console.log(`  ${who} ◂`);
  for (const line of text.split('\n')) console.log(`      ${line}`);
};
const says = async (who: string, phone: string, text: string): Promise<void> => {
  console.log(`  ${who} ▸ "${text}"`);
  for (const m of await handleIncoming({ phone, text, channel: 'simulator' })) {
    if (m.kind === 'list') {
      gets(who, `${m.text}${'\n'}          [ ${m.button} ▾ ]`);
      for (const r of m.rows) console.log(`           ${r.title}  ${r.description ?? ''}`);
      continue;
    }
    gets(who, m.text ?? '');
  }
};

const delivered = (no: string, phone: string, name: string, driver: string) => {
  db.prepare(
    `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone, delivery_note,
       kind, outlet_name, driver_name, driver_phone, delivery_code, subtotal, delivery_fee, total,
       payment_method, status, created_at)
     VALUES (?, ?, ?, 'Lot 4 Kitty', ?, '', 'restaurant', 'A Taste of Guyana', ?, '5926001111',
       '', 320000, 50000, 370000, 'cash', 'delivered', ?)`,
  ).run(no, phone, name, phone, driver, new Date().toISOString());
  repo.saveCustomer(phone, { name });
  return repo.findOrder(no)!;
};

/* ------------------------------------------------------------------ */

rule('1. A delivery closes, and the question follows it');
const first = delivered('ORD-00041', HAPPY, 'Marcia Younge', 'Wayne');
console.log(`  shouldAsk → ${shouldAsk(first)}`);
const ask = ratingAsk(first);
if (ask.kind === 'list') {
  gets('Marcia', `${ask.text}${'\n'}          [ ${ask.button} ▾ ]`);
  for (const r of ask.rows) console.log(`           ${r.title}  ${r.description ?? ''}`);
}
repo.recordRatingAsk(first.orderNo, HAPPY);

rule('2. She taps five, and that is the end of it');
await says('Marcia', HAPPY, '⭐⭐⭐⭐⭐');

rule('3. Another delivery, and this one went badly');
const second = delivered('ORD-00042', CROSS, 'Ravi Persaud', 'Wayne');
repo.recordRatingAsk(second.orderNo, CROSS);
await says('Ravi', CROSS, '⭐⭐');

rule('4. He says what went wrong');
await says('Ravi', CROSS, 'the rice was cold and it came late');

rule('5. What the shop was sent at the moment he tapped');
const { poorRatingAlert } = await import('./src/ratings.ts');
gets('shop', poorRatingAlert(second.orderNo));

rule('6. A third customer ignores it and orders instead');
const third = delivered('ORD-00043', '5926200003', 'Tina Khan', 'Wayne');
repo.recordRatingAsk(third.orderNo, '5926200003');
// "2" here must be the second service on the menu, not two stars — the
// question was asked, but this is a different conversation now.
await says('Tina', '5926200003', 'I need food');
await says('Tina', '5926200003', '2');

rule('7. A taxi passenger, rating the ride');
// A taxi has no kitchen to attribute anything to, so it counts under the
// driver alone — and the question it was asked was about the trip, not about
// an order number.
db.prepare(
  `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone, delivery_note,
     kind, outlet_name, driver_name, driver_phone, pickup_address, delivery_code,
     subtotal, delivery_fee, total, payment_method, status, created_at)
   VALUES ('ORD-00044', '5926200004', 'Anita Persaud', 'Georgetown', '5926200004', '',
     'taxi', '', 'Shanta', '5926002222', 'Diamond, East Bank', '',
     0, 0, 0, 'cash_on_delivery', 'delivered', ?)`,
).run(new Date().toISOString());
repo.saveCustomer('5926200004', { name: 'Anita Persaud' });
const ride = repo.findOrder('ORD-00044')!;
const trip = ratingAsk(ride);
if (trip.kind === 'list') {
  gets('Anita', `${trip.text}${'\n'}          [ ${trip.button} ▾ ]`);
}
repo.recordRatingAsk(ride.orderNo, '5926200004');
await says('Anita', '5926200004', '⭐⭐⭐⭐');

rule('8. The month, from the shop number');
for (const m of await handleStaffMessage('ratings', SHOP)) gets('shop', m.text ?? '');
console.log('');

db.close();

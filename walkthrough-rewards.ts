/**
 * Reward points, from the first delivery to the one that is paid for.
 *
 *   node walkthrough-rewards.ts
 *
 * Points come off the DELIVERY CHARGE, not the shopping, which is the shop's
 * decision and has a consequence this prints plainly: a customer out at
 * Parika pays $5,000 to be reached and earns 500 points for it, while one in
 * Kitty pays $500 and earns 50. The far customer reaches a reward in two
 * deliveries; the near one needs twenty.
 *
 * Not a test — the suite is the test. This exists to be read.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-rewards.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.STORE_NAME = 'Next Minute Delivery';

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { money } = await import('./src/config.ts');
const { balanceLines, pointsFor, REWARD_POINTS, REWARD_VALUE } = await import('./src/rewards.ts');
const { receiptLines } = await import('./src/notifications.ts');

const KITTY = '5926300011';
const PARIKA = '5926300022';
repo.saveCustomer(KITTY, { name: 'Marcia Younge', address: 'Lot 4 Kitty', contactPhone: KITTY });
repo.saveCustomer(PARIKA, { name: 'Ravi Persaud', address: 'Lot 9 Parika', contactPhone: PARIKA });

const gets = (who: string, text: string): void => {
  console.log(`  ${who} ◂`);
  for (const line of text.split('\n')) console.log(`      ${line}`);
};

/** A delivered order with a given delivery charge. */
let n = 0;
const delivered = (phone: string, name: string, zone: string, goods: number, fee: number): string => {
  n += 1;
  const no = `GRO-9${String(n).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone, delivery_note,
       kind, delivery_zone, driver_name, delivery_code, subtotal, delivery_fee, total,
       payment_method, status, created_at)
     VALUES (?, ?, ?, ?, ?, '', 'grocery', ?, 'Wayne', '', ?, ?, ?, 'cash', 'pending', ?)`,
  ).run(no, phone, name, `Lot 1 ${zone}`, phone, zone, goods, fee, goods + fee, new Date().toISOString());
  repo.setOrderStatus(no, 'delivered');
  return no;
};

console.log('');
console.log(`  the rate: ${money(10)} of delivery charges = 1 point · ${REWARD_POINTS} points = ${money(REWARD_VALUE)}`);
console.log(`  so a ${money(500)} Kitty delivery earns ${pointsFor(500)}, and a ${money(5000)} Parika one earns ${pointsFor(5000)}`);

console.log('');
console.log('──────── Marcia, in town, after one delivery ─────────────────');
console.log('');
delivered(KITTY, 'Marcia Younge', 'Kitty', 3200, 500);
console.log(`  earned on that order: ${repo.pointsBalance(KITTY)} points`);
gets('Marcia', balanceLines(repo.pointsBalance(KITTY)).join('\n'));

console.log('');
console.log('──────── Ravi, out at Parika, after two ──────────────────────');
console.log('');
delivered(PARIKA, 'Ravi Persaud', 'Parika', 8000, 5000);
delivered(PARIKA, 'Ravi Persaud', 'Parika', 6000, 5000);
console.log(`  balance: ${repo.pointsBalance(PARIKA)} points`);
gets('Ravi', balanceLines(repo.pointsBalance(PARIKA)).join('\n'));

console.log('');
console.log('──────── Ravi spends it on his next order ────────────────────');
console.log('');
repo.confirmIdentity(PARIKA);
repo.upsertProduct({
  sku: 'RIC-001', name: 'Karibee Parboiled Rice', description: '', category: 'Rice & Grains',
  unit: '5 kg bag', price: 1850, stock: 40, active: 1, keywords: 'rice', trackStock: 1,
} as never);
const productId = (db.prepare(`SELECT id FROM products WHERE sku = 'RIC-001'`).get() as { id: number }).id;
{
  repo.setCartQty(PARIKA, productId, 2, '');
  const order = repo.placeOrder({
    phone: PARIKA, customerName: 'Ravi Persaud', address: 'Lot 9 Parika',
    contactPhone: PARIKA, deliveryNote: '', paymentMethod: 'cash_on_delivery',
    location: null, useReward: true,
  } as never);
  const placed = repo.findOrder(order.orderNo)!;
  console.log(`  ${placed.orderNo}: goods ${money(placed.subtotal)} + delivery ${money(placed.deliveryFee)}`);
  console.log(`  reward applied: ${placed.rewardPoints} points, ${money(placed.rewardValue)}`);
  console.log(`  the associate collects: ${money(placed.total)}`);
  console.log(`  balance now: ${repo.pointsBalance(PARIKA)} points`);

  console.log('');
  repo.setOrderStatus(placed.orderNo, 'delivered');
  gets('Ravi — receipt', receiptLines(repo.findOrder(placed.orderNo)!, 'en').join('\n'));
}

console.log('');
console.log('──────── and the statement behind it ─────────────────────────');
console.log('');
for (const line of repo.pointsHistory(PARIKA)) {
  // The shop's own clock. The ledger stores UTC, and a statement printed in
  // it reads an hour or four out to everybody who will ever check it.
  const when = new Date(line.createdAt).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'America/Guyana',
  });
  console.log(`  ${when}  ${String(line.points).padStart(6)}  ${line.reason.padEnd(9)} ${line.orderNo}`);
}
console.log('');

db.close();

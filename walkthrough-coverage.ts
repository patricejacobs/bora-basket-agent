/**
 * The coverage report, against a month of invented trading.
 *
 *   node walkthrough-coverage.ts
 *
 * Twenty-odd jobs spread across the corridors the way a real month might
 * spread them — most of the work close to town, a steady trickle up the East
 * Bank, a couple of long ones. Then two associates, one based in Georgetown
 * and one out at Diamond, and the report that tells a shop where the third
 * belongs.
 *
 * Not a test — the suite is the test. This exists to be read.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-coverage.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.STAFF_NUMBERS = '5926497570';
process.env.STORE_NAME = 'Next Minute Delivery';

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleStaffMessage } = await import('./src/staff.ts');

const SHOP = '5926497570';
const TOWN = '5926001111';
const BANK = '5926002222';

repo.upsertAssociate({ phone: TOWN, name: 'Wayne', vehicle: 'CC 1122', active: true });
repo.upsertAssociate({ phone: BANK, name: 'Shanta', vehicle: 'PAA 9900', active: true });
repo.setDuty(TOWN, true);

// A month of trading, as destinations. Deliveries are counted by where they
// went; the shop is always the other end of them.
const WORK: [string, number][] = [
  ['Kitty', 4],
  ['Campbellville', 3],
  ['Sophia', 2],
  ['Diamond', 5],
  ['Providence', 4],
  ['Eccles', 3],
  ['Grove', 2],
  ['Mon Repos', 3],
  ['Beterverwagting', 2],
  ['Enmore', 1],
  ['Vreed-en-Hoop', 2],
  ['Parika', 1],
];

let n = 0;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
for (const [place, count] of WORK) {
  for (let i = 0; i < count; i += 1) {
    n += 1;
    db.prepare(
      `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone, delivery_note,
         kind, delivery_zone, delivery_code, driver_phone, subtotal, delivery_fee, total,
         payment_method, status, created_at)
       VALUES (?, '5926100001', 'A Customer', ?, '5926100001', '',
         'grocery', ?, '', '', 200000, 50000, 250000, 'cash', 'delivered', ?)`,
    ).run(`ORD-9${String(n).padStart(4, '0')}`, `Lot 1 ${place}`, place, ago(n % 28));
  }
}

const say = async (text: string): Promise<void> => {
  console.log('');
  console.log(`  shop ▸ "${text}"`);
  for (const m of await handleStaffMessage(text, SHOP)) {
    console.log('  shop ◂');
    for (const line of (m.text ?? '').split('\n')) console.log(`      ${line}`);
  }
};

console.log(`${n} jobs over the last month, nobody based anywhere yet.`);
await say('zones');

console.log('');
console.log('──────── The shop puts Shanta out at Diamond ─────────────────');
await say('base Shanta Diamond');
repo.setDuty(BANK, true);

console.log('');
console.log('──────── And reads it again ──────────────────────────────────');
await say('zones');

db.close();

/**
 * One taxi, offered outward in rings until somebody takes it.
 *
 *   node walkthrough-dispatch.ts
 *
 * Three associates, none of whom has shared a location with anybody. All the
 * shop knows is where each of them last finished a delivery and when:
 *
 *   Shanta  — finished in Diamond two minutes ago      (the same band)
 *   Wayne   — finished at Providence eight minutes ago (the same corridor)
 *   Rohan   — finished in Kitty an hour ago            (town, and stale)
 *
 * A car is wanted at Diamond. Shanta should hear about it alone; Wayne a few
 * seconds later; Rohan only if neither of them moves.
 *
 * The waits are cut to a second apiece here so the thing can be watched. In
 * the shop they are twenty seconds and fifteen.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-dispatch.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.DISPATCH_BAND_WAIT_SECONDS = '1';
process.env.DISPATCH_CORRIDOR_WAIT_SECONDS = '1';

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { offerNearestFirst } = await import('./src/dispatch.ts');
const { standings, jobStartsAt } = await import('./src/nearby.ts');
const { handleDriverMessage } = await import('./src/staff.ts');

const SHANTA = '5926001111';
const WAYNE = '5926002222';
const ROHAN = '5926003333';

for (const [phone, name] of [
  [SHANTA, 'Shanta'],
  [WAYNE, 'Wayne'],
  [ROHAN, 'Rohan'],
] as const) {
  repo.upsertAssociate({ phone, name, vehicle: '', active: true });
  repo.setDuty(phone, true);
}

/** A delivery somebody finished, at a place, a number of minutes ago. */
let n = 0;
const finished = (phone: string, place: string, minutesAgo: number): void => {
  n += 1;
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const no = `ORD-8${String(n).padStart(4, '0')}`;
  db.prepare(
    `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone, delivery_note,
       kind, delivery_zone, driver_phone, delivery_code, delivered_at,
       subtotal, delivery_fee, total, payment_method, status, created_at)
     VALUES (?, '5926100001', 'A Customer', ?, '5926100001', '', 'grocery', ?, ?, '', ?,
       100000, 50000, 150000, 'cash', 'delivered', ?)`,
  ).run(no, `Lot 1 ${place}`, place, phone, at, at);
};

finished(SHANTA, 'Diamond', 2);
finished(WAYNE, 'Providence', 8);
finished(ROHAN, 'Kitty', 60);

const job = repo.createTaxiJob({
  phone: '5926200001',
  passengerName: 'Marcia Younge',
  passengerPhone: '5926200001',
  pickup: null,
  pickupAddress: 'Diamond, East Bank',
  destination: null,
  destinationAddress: 'Georgetown',
  note: '',
  wantedAt: '',
  wantedNote: '',
});

const start = jobStartsAt(repo.findOrder(job.orderNo)!);
console.log(`  the job starts in: ${start?.zone} (${start?.corridor})`);
console.log('');
for (const s of standings([SHANTA, WAYNE, ROHAN])) {
  const who = repo.getAssociate(s.phone)?.name ?? s.phone;
  console.log(
    `  ${who.padEnd(8)} last finished in ${(s.at?.zone ?? 'nowhere known').padEnd(16)} ${Math.round(s.minutesAgo)} min ago`,
  );
}
console.log('');
console.log('──────── offering it ─────────────────────────────────────────');
console.log('');

const first = await offerNearestFirst(job.orderNo);
console.log(`  first ring → ${first}`);

// Let the widening run. Nobody accepts, so it should reach all three.
await new Promise((r) => setTimeout(r, 2600));

console.log('');
console.log('──────── and again, with Shanta taking it in time ────────────');
console.log('');

const second = repo.createTaxiJob({
  phone: '5926200002',
  passengerName: 'Ravi Persaud',
  passengerPhone: '5926200002',
  pickup: null,
  pickupAddress: 'Diamond, East Bank',
  destination: null,
  destinationAddress: 'Georgetown',
  note: '',
  wantedAt: '',
  wantedNote: '',
});
await offerNearestFirst(second.orderNo);
const no = String(Number(second.orderNo.replace(/\D/g, '')));
await handleDriverMessage(`${no} confirm`, SHANTA);
console.log(`  Shanta accepted ${second.orderNo}`);
await new Promise((r) => setTimeout(r, 2600));
console.log(`  after the timers: ${JSON.stringify({
  status: repo.findOrder(second.orderNo)?.status,
  driver: repo.getAssociate(repo.findOrder(second.orderNo)?.driverPhone ?? '')?.name,
})}`);
console.log('');

db.close();

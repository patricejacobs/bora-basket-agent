/**
 * One taxi, booked to dropped off — both ends and every message.
 *
 * Booked by somebody standing where they want collecting (a pin) and going
 * somewhere they can only describe (words), which is the ordinary case: a
 * phone knows where it is and does not know where it is going.
 *
 * It exists to print what the PASSENGER reads, because that is where this
 * went wrong. A taxi runs through the same statuses as a delivery, and the
 * delivery wording underneath them quoted a total of $0, handed over a
 * receipt for nothing and thanked somebody for trusting us with a parcel.
 * None of those are visible from the associate's side, which looked fine
 * throughout.
 *
 * Drives the real handlers against a scratch database. Companion to
 * walkthrough-parcel.ts and walkthrough.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

// Its own database file, deleted and rebuilt on every run, pointed at before
// anything reads the config. A walkthrough that writes into the working
// database leaves a passenger and an associate behind that nobody put there.
const WALK_DB = path.resolve('./data/walk-taxi.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;

const RIDER = '5926001111';
const PASSENGER = '5926482233';
process.env.DRIVER_NUMBERS = RIDER;
process.env.STORE_NAME = 'Next Minute Delivery';

// Imported after the environment is in place, so config reads the values above.
const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { offerParcel } = await import('./src/dispatch.ts');
const { customerStatusMessage } = await import('./src/notifications.ts');

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
repo.saveCustomer(PASSENGER, { name: 'Marcia Younge' });
repo.logMessage(PASSENGER, 'in', 'whatsapp', 'I need a taxi');

const job = repo.createTaxiJob({
  phone: PASSENGER,
  passengerName: 'Marcia Younge',
  passengerPhone: PASSENGER,
  // Collected where she is standing: a pin, dropped on the pavement.
  pickup: { latitude: 6.8013, longitude: -58.1551, label: 'Stabroek Market' },
  pickupAddress: 'Stabroek Market, by the clock',
  // Going somewhere she can only name.
  destination: null,
  destinationAddress: '14 Delph Street, Campbellville',
  note: '2 passengers, one small case',
  wantedAt: '',
  wantedNote: '',
});
const n = String(Number(job.orderNo.replace(/\D/g, '')));
const live = () => repo.findOrder(job.orderNo)!;

/* ------------------------------------------------------------------ */

rule('1. What the shop stored');
const o = live();
console.log(`  passenger   : ${o.customerName} ${o.contactPhone}`);
console.log(`  collect from: ${o.pickup?.address}  (pin: ${o.pickup?.latitude ? 'yes' : 'no'})`);
console.log(`  take to     : ${o.address}  (pin: ${o.location ? 'yes' : 'no'})`);
console.log(`  note        : ${o.parcelDetails}`);
console.log(`  fare        : ${o.total === 0 ? 'not set — agreed in the car' : String(o.total)}`);

rule('2. Offered to every free associate');
console.log(`  offer → ${await offerParcel(job.orderNo)}`);

rule('3. Takes the job');
await show('Rider One', `${n} confirm`);

rule('4. What Marcia is told then');
gets('Marcia', customerStatusMessage(live(), 'confirmed'));
// The same four digits in two places, which is the whole of the safety check:
// the driver says them, and she checks them against her own screen.
console.log('');
console.log(`  both of them are holding code ${repo.safetyCodeFor(job.orderNo)}`);

rule('5. She is in the car');
await show('Rider One', `${n} uplifted`);
gets('Marcia', customerStatusMessage(live(), 'on_the_way'));

rule('6. She asks him to stop at the pharmacy');
await show('Rider One', `${n} waiting`);
// Twelve minutes later, by the clock the shop keeps.
db.prepare(`UPDATE orders SET waiting_since = ? WHERE order_no = ?`).run(
  new Date(Date.now() - 12 * 60_000).toISOString(),
  job.orderNo,
);
await show('Rider One', `${n} moving`);

rule('7. And again at her mother’s gate');
await show('Rider One', `${n} waiting`);
db.prepare(`UPDATE orders SET waiting_since = ? WHERE order_no = ?`).run(
  new Date(Date.now() - 8 * 60_000).toISOString(),
  job.orderNo,
);
await show('Rider One', `${n} moving`);

rule('8. Dropped off');
await show('Rider One', `${n} delivered`);
gets('Marcia', customerStatusMessage(live(), 'delivered'));

rule('9. Where it ended up');
console.log(`  ${JSON.stringify({ kind: live().kind, status: live().status, total: live().total })}`);

rule('10. A second trip — nobody at the pickup');
const second = repo.createTaxiJob({
  phone: PASSENGER,
  passengerName: 'Marcia Younge',
  passengerPhone: PASSENGER,
  pickup: null,
  pickupAddress: 'Corner of Light and Charlotte',
  destination: null,
  destinationAddress: 'Diamond, East Bank',
  note: '',
  wantedAt: '',
  wantedNote: '',
});
const n2 = String(Number(second.orderNo.replace(/\D/g, '')));
await offerParcel(second.orderNo);
await show('Rider One', `${n2} confirm`);
await show('Rider One', `${n2} nobody there`);
gets('Marcia', customerStatusMessage(repo.findOrder(second.orderNo)!, 'returned'));
console.log('');

db.close();

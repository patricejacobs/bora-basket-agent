/**
 * A driver who works straight through, and one who goes home.
 *
 *   node walkthrough-duty.ts
 *
 * Two things used to end a shift. The rolling cap refused `on` outright once
 * somebody had worked twelve hours in any twenty-four; the clock-in lapse
 * expired quietly after twelve, and the jobs just stopped arriving with
 * nothing said. The cap is off now, and the lapse asks first.
 *
 * The clock is moved by hand here — the shift rows are backdated — because
 * waiting eleven and three quarter hours is not a walkthrough.
 *
 * No WhatsApp token and no API key: nothing reaches a telephone and no agent
 * turn is billed.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-duty.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.ASSOCIATE_DUTY_HOURS = '12';
// The decision: no cap. Set to 12 further down to show what it used to say.
process.env.ASSOCIATE_MAX_HOURS_PER_DAY = '0';
process.env.DUTY_CHECK_IN_MINUTES = '15';

const RIDER = '5926001111';
process.env.DRIVER_NUMBERS = RIDER;

const { db } = await import('./src/db/index.ts');
const repo = await import('./src/db/repo.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { sweepCheckIns, checkInMessage } = await import('./src/duty-check-in.ts');
const { readButtonId } = await import('./src/button-ids.ts');

const NL = String.fromCharCode(10);
const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);
};

const show = (m: { kind: string; text?: string; buttons?: { title: string }[] }): void => {
  console.log('');
  for (const line of (m.text ?? '').split(NL)) console.log(`      ${line}`);
  if (m.buttons) console.log(`      ${m.buttons.map((b) => `[ ${b.title} ]`).join('  ')}`);
};

const say = async (label: string, text: string): Promise<void> => {
  console.log('');
  console.log(`  Rider ▸ ${label}`);
  for (const m of await handleDriverMessage(text, RIDER)) show(m as never);
};

repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);

/** Moves their clock-in and its open shift row back by this many hours. */
const backdate = (hours: number): void => {
  const when = new Date(Date.now() - hours * 3600_000).toISOString();
  db.prepare(`UPDATE associates SET on_duty_at = ? WHERE phone = ?`).run(when, RIDER);
  db.prepare(`UPDATE associate_shifts SET started_at = ? WHERE phone = ? AND ended_at = ''`)
    .run(when, RIDER);
};

/* ----------------------------------------------------------- clocking on */

rule('He clocks on');
await say('on', 'on');

/* ---------------------------------------------------- eleven hours later */

rule('11 hours in — nothing is said, and nothing should be');

backdate(11);
console.log('');
console.log(`  on duty: ${repo.isOnDuty(RIDER)} · asked so far: ` +
  `${repo.checkInDue(15).length} due`);
console.log(`  (worked ${repo.hoursWorkedToday(RIDER).toFixed(1)} hours)`);

/* ------------------------------------------- a quarter of an hour to go */

rule('11h 50m in — the shop asks');

backdate(11 + 50 / 60);
const asked = await sweepCheckIns();
console.log('');
console.log(`  the sweep asked ${asked}:`);
show(checkInMessage(repo.getAssociate(RIDER)?.name ?? '') as never);

rule('And it does not ask twice');

console.log('');
console.log(`  a second sweep asks ${await sweepCheckIns()}`);

/* ----------------------------------------------------------- he taps Yes */

rule('He taps [ Yes, still working ]');

console.log('');
console.log(`  the id "duty_on" reads as "${readButtonId('duty_on')}"`);
await say('[ Yes, still working ]', readButtonId('duty_on') ?? 'on');
console.log('');
console.log(`  the clock-in has restarted, so he lapses in ` +
  `${((new Date(repo.onDutySince(RIDER)).getTime() + 12 * 3600_000 - Date.now()) / 3600_000).toFixed(1)} hours`);
console.log(`  on duty: ${repo.isOnDuty(RIDER)} · hours worked today still ` +
  `${repo.hoursWorkedToday(RIDER).toFixed(1)}`);

/* ------------------------------------------------- and the old refusal */

rule('What the cap used to say at this point');

const { dutyLimits } = await import('./src/config.ts');
console.log('');
console.log(`  the cap is ${dutyLimits().maxPerDay === 0 ? 'off' : dutyLimits().maxPerDay + ' hours'}` +
  ', so `on` is never refused for hours any more.');
console.log('  With ASSOCIATE_MAX_HOURS_PER_DAY=12 the same driver, having');
console.log('  worked 11.8 hours, would shortly have been told:');
console.log('');
console.log('      🛑 You have worked 12 hours in the last 24.');
console.log('');
console.log('      The limit is 12. You can clock on again from 8:00 am.');

/* ------------------------------------------------- the one who went home */

rule('And the driver who went home without clocking off');

const GONE = '5926002222';
repo.upsertAssociate({ phone: GONE, name: 'Rider Two', vehicle: 'PAA 2222', active: 1 } as never);
await handleDriverMessage('on', GONE);
db.prepare(`UPDATE associates SET on_duty_at = ? WHERE phone = ?`)
  .run(new Date(Date.now() - (11 + 50 / 60) * 3600_000).toISOString(), GONE);

console.log('');
console.log(`  asked: ${repo.checkInDue(15).includes(GONE)} — the same question goes to him`);
repo.markCheckInAsked(GONE);

// He does not answer. Thirteen hours after clocking on, the lapse has him.
db.prepare(`UPDATE associates SET on_duty_at = ? WHERE phone = ?`)
  .run(new Date(Date.now() - 13 * 3600_000).toISOString(), GONE);
console.log(`  he ignores it, and an hour later: on duty ${repo.isOnDuty(GONE)}`);
console.log(`  asked again: ${repo.checkInDue(15).includes(GONE)} — the window has closed,`);
console.log('  so nothing reaches him at three in the morning.');
console.log('');

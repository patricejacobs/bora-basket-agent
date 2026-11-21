/**
 * A destination changed in the car, from the tap that starts it.
 *
 *   node walkthrough-destination.ts
 *
 * The passenger leans forward and says they are going somewhere else. The
 * driver is the one who hears it, so the driver is who raises it — but a
 * driver who could settle it could raise the fare, so they cannot: the shop
 * prices the new place, puts BOTH figures to the passenger, and nothing on
 * the trip moves until the passenger answers.
 *
 * Driven by the BUTTONS, through the webhook parser, because that is where
 * this flow broke twice. A tap does not send the words on the button — it
 * sends a hidden id, and an id that nothing downstream reads falls through to
 * the button's own title. A title carries no order number, and it is written
 * in whichever language the person reads, so a router matching on it matches
 * on a translation. Both halves of this flow had that fault. Both looked
 * perfect from a test that fed the id straight in.
 *
 * Not a test — the suite is the test. This exists to be read.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALK_DB = path.resolve('./data/walk-destination.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(WALK_DB + suffix, { force: true });
process.env.DATABASE_PATH = WALK_DB;

const DRIVER = '5926001111';
const PASSENGER = '5926482233';
process.env.DRIVER_NUMBERS = DRIVER;
process.env.STORE_NAME = 'Next Minute Delivery';

const repo = await import('./src/db/repo.ts');
const { handleDriverMessage } = await import('./src/staff.ts');
const { handleIncoming } = await import('./src/conversation.ts');
const { nextActions } = await import('./src/order-status.ts');
const { parseWebhook } = await import('./src/channels/whatsapp.ts');
const { taxiFare } = await import('./src/taxi.ts');
const { money } = await import('./src/config.ts');
const { t } = await import('./src/language.ts');

const rule = (title: string): void => {
  console.log('');
  console.log(`──────── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
  console.log('');
};
const gets = (who: string, text: string): void => {
  console.log(`  ${who} ◂`);
  for (const line of text.split(String.fromCharCode(10))) console.log(`      ${line}`);
};
const buttons = (acts: { title: string }[]): void => {
  if (acts.length > 0) console.log(`      ${acts.map((a) => `[ ${a.title} ]`).join('  ')}`);
};

/**
 * What a real tap puts on the wire, and what comes back off it.
 *
 * The whole point of this walkthrough: the id goes in, and whatever the
 * parser makes of it is what the shop actually receives.
 */
const tap = (buttonId: string, title: string, from: string): string =>
  parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from,
                  id: 'wamid.tap',
                  type: 'interactive',
                  interactive: { button_reply: { id: buttonId, title } },
                },
              ],
            },
          },
        ],
      },
    ],
  } as never)[0]?.text ?? '';

/* ------------------------------------------------------------- set-up */

repo.upsertAssociate({ phone: DRIVER, name: 'Rider One', vehicle: 'NEW 5678', active: 1 } as never);
repo.setDuty(DRIVER, true);
repo.saveCustomer(PASSENGER, { name: 'Marcia Younge', contactPhone: PASSENGER });
repo.setService(PASSENGER, 'taxi');
// Opens WhatsApp's 24-hour window. Without it nothing can be sent to her at
// all, which would hide the only message this flow turns on.
repo.logMessage(PASSENGER, 'in', 'whatsapp', 'I need a taxi');

const booked = taxiFare('Diamond', 'Grove');
const ride = repo.createTaxiJob({
  phone: PASSENGER,
  passengerName: 'Marcia Younge',
  passengerPhone: PASSENGER,
  pickup: null,
  pickupAddress: 'Diamond',
  destination: null,
  destinationAddress: 'Grove',
  note: '',
  wantedAt: '',
  wantedNote: '',
  fare: booked?.fee ?? 0,
});
repo.assignDriver(ride.orderNo, DRIVER);
repo.setOrderStatus(ride.orderNo, 'on_the_way');
const digits = String(Number(ride.orderNo.replace(/\D/g, '')));
const live = (): ReturnType<typeof repo.findOrder> => repo.findOrder(ride.orderNo);

rule('1. The trip as booked');
console.log(`  ${ride.orderNo}  Diamond → Grove, ${money(live()?.quotedFare ?? 0)}, Marcia onboard`);

/* --------------------------------------------- 2. the card in his hand */

rule('2. What the driver is holding');

const card = nextActions(ride.orderNo, 'on_the_way', 'driver', { canWait: true });
gets('Rider One', `🚕 ${ride.orderNo} — Marcia Younge onboard, taking her to Grove`);
buttons(card);
console.log('');
for (const b of card) {
  console.log(`      [ ${b.title.padEnd(18)} ] sends the id  ${b.id}`);
}

/* ------------------------------------------------- 3. he taps the button */

rule('3. He taps Change destination');

const tapped = card.find((b) => b.title === 'Change destination')!;
const asDriverSent = tap(tapped.id, tapped.title, DRIVER);
console.log(`  the tap puts  ${tapped.id}  on the wire`);
console.log(`  the shop reads it as  "${asDriverSent}"`);
console.log('');
console.log('  Before today it read it as "Change destination" — no order number');
console.log('  in it, so the shop could not tell which trip, and answered with');
console.log('  the whole driver help text. The flow below was never reached.');
console.log('');
for (const m of await handleDriverMessage(asDriverSent, DRIVER)) gets('Rider One', m.text ?? '');

/* ----------------------------------------------- 4. he names the place */

rule('4. He names where she is going now');

console.log('  Rider One ▸ "Buxton"');
for (const m of await handleDriverMessage('Buxton', DRIVER)) gets('Rider One', m.text ?? '');

const proposal = repo.destProposal(ride.orderNo);
console.log('');
console.log(`  written down as a proposal : ${proposal?.place} at ${money(proposal?.fare ?? 0)}`);
console.log(`  the trip itself still says : ${live()?.address} at ${money(live()?.quotedFare ?? 0)}`);

/* -------------------------------------------------- 5. she is asked */

rule('5. What Marcia is asked');

// The same string the dispatcher put on the wire. Rendered here rather than
// read back out of her log, because a buttoned message is sent straight to
// the channel and the log keeps the plain ones.
gets(
  'Marcia',
  t('dest_ask', 'en', {
    place: proposal?.place ?? '',
    was: money(booked?.fee ?? 0),
    now: money(proposal?.fare ?? 0),
  }),
);
console.log('      [ Acknowledged ]  [ No, as booked ]');

/* ------------------------------------------- 6. she declines, then agrees */

rule('6. She taps No, as booked');

const no = tap(`dest_no_${digits}`, 'No, as booked', PASSENGER);
console.log(`  the tap puts  dest_no_${digits}  on the wire, read as  "${no}"`);
console.log('');
for (const m of await handleIncoming({ phone: PASSENGER, text: no, channel: 'whatsapp' } as never)) {
  gets('Marcia', (m as { text?: string }).text ?? '');
}
console.log('');
console.log(`  the trip is still : ${live()?.address} at ${money(live()?.quotedFare ?? 0)}`);
console.log(`  the proposal is   : ${repo.destProposal(ride.orderNo) === null ? 'spent' : 'still open'}`);

rule('7. He raises it again, and this time she agrees');

await handleDriverMessage(tap(`changedest_${digits}`, 'Change destination', DRIVER), DRIVER);
await handleDriverMessage('Buxton', DRIVER);

const yes = tap(`dest_ok_${digits}`, 'Acknowledged', PASSENGER);
console.log(`  the tap puts  dest_ok_${digits}  on the wire, read as  "${yes}"`);
console.log('');
for (const m of await handleIncoming({ phone: PASSENGER, text: yes, channel: 'whatsapp' } as never)) {
  gets('Marcia', (m as { text?: string }).text ?? '');
}

const after = live();
console.log('');
console.log(`  taking her to : ${after?.address}`);
console.log(`  fare          : ${money(after?.quotedFare ?? 0)}`);
console.log(`  collected from: ${after?.pickup?.address ?? 'Diamond'} — untouched, she has not moved`);
console.log('');
console.log('  the trail:');
for (const e of repo.orderHistory(ride.orderNo)) {
  if (/Buxton|Grove/.test(e.detail ?? '')) console.log(`      ${e.detail}`);
}

/* ------------------------------------ 8. what he is left holding */

rule('8. What he is left holding, after the change went through');

const afterCard = nextActions(ride.orderNo, 'on_the_way', 'driver', { canWait: true });
gets('Rider One', `⚠️ ${ride.orderNo} — the passenger changed where they are going.`);
buttons(afterCard);
console.log('');
console.log('  This is the fix. A WhatsApp button is spent the moment it is tapped,');
console.log('  so answering him in plain text left him with nothing to tap and no');
console.log('  way to ask for a SECOND change. Every message to a driver carrying');
console.log('  somebody now ends in the card for that moment.');
console.log('');
repo.startWaiting(ride.orderNo);
console.log('  and while he is stopped with the clock running:');
buttons(nextActions(ride.orderNo, 'on_the_way', 'driver', { canWait: true, waitingOpen: true }));
console.log('      one button on purpose — the others are ways to end a trip');
console.log('      without closing a clock worth $30 a minute to him');
repo.stopWaiting(ride.orderNo);

/* ------------------------------------------------- 9. the two refusals */

rule('9. What it refuses');

const again = await handleIncoming({ phone: PASSENGER, text: yes, channel: 'whatsapp' } as never);
console.log('  she taps Acknowledged a second time:');
gets('Marcia', (again[0] as { text?: string }).text ?? '');

repo.setOrderStatus(ride.orderNo, 'confirmed');
const early = await handleDriverMessage(tap(`changedest_${digits}`, 'Change destination', DRIVER), DRIVER);
console.log('');
console.log('  he raises it before she is in the car:');
gets('Rider One', (early[0] as { text?: string }).text ?? '');

console.log('');

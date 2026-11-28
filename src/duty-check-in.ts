/**
 * "Still out?" — asked before a clock-in lapses, so working does not stop
 * for want of a word.
 *
 * A clock-in lasts twelve hours and then expires on its own. That rule is
 * there for the associate who forgets to clock off: without it, a forgotten
 * shift sends job cards at three in the morning, and after two of those
 * somebody mutes the chat and is lost for the shifts that matter.
 *
 * But the lapse is silent, and silence is the wrong thing to say to somebody
 * who is still out working. The jobs simply stop arriving. Nothing is
 * refused, nothing is explained, and the first they know of it is an hour of
 * quiet on a Friday night — which reads, from a saddle, exactly like a shop
 * with no work.
 *
 * So the base asks, a quarter of an hour before the clock runs out, and a tap
 * carries them straight into a fresh stretch. The driver who went home gets
 * the same question, ignores it, and lapses as before: the protection is
 * untouched, because the question is the thing that was missing.
 *
 * A sweep rather than a timer per shift, for the reason the stall watch gives:
 * timers die with the process, and a deploy at seven would silently cancel the
 * alarm set at half past six. The state is in the database, so the next sweep
 * after a restart picks up where this one left off.
 */
import { config } from './config.ts';
import * as repo from './db/repo.ts';
import { dutyLimits } from './config.ts';
import { deliver } from './channels/whatsapp-send.ts';
import { DUTY_ON, DUTY_OFF } from './duty-buttons.ts';
import type { OutboundMessage } from './channels/types.ts';

const nl = String.fromCharCode(10);

/**
 * The question, with its two answers.
 *
 * Exported so the suite can sweep its ids: a button whose id nothing reads
 * falls back to its title, and that fallback has killed four buttons in this
 * shop already.
 */
export function checkInMessage(name: string): OutboundMessage {
  const first = name.trim().split(' ')[0] ?? '';
  const { lapseHours } = dutyLimits();

  return {
    kind: 'buttons',
    text: [
      `🛵 Still out${first ? `, ${first}` : ''}?`,
      '',
      `You clocked on nearly ${lapseHours} hours ago, and a clock-in runs out ` +
        'after that so nobody gets job cards in their sleep.',
      '',
      'Tap below and the jobs keep coming. Ignore this and you will be ' +
        'clocked off shortly — nothing you are already carrying is affected.',
    ].join(nl),
    buttons: [
      { id: DUTY_ON, title: 'Yes, still working', command: 'on' },
      { id: DUTY_OFF, title: 'Clock off', command: 'clock off' },
    ],
  };
}

/**
 * One pass. Returns how many were asked, for the caller to log.
 *
 * Stamped before the send rather than after, like the stall watch: a send
 * that throws must not leave somebody eligible to be asked again on the next
 * sweep, and every sweep after that.
 */
export async function sweepCheckIns(): Promise<number> {
  const due = repo.checkInDue(config.dutyCheckInMinutes);
  if (due.length === 0) return 0;

  let asked = 0;
  for (const phone of due) {
    repo.markCheckInAsked(phone);
    const who = repo.getAssociate(phone);
    console.log(`[duty] asking ${phone} whether they are still out`);
    try {
      await deliver(phone, [checkInMessage(who?.name ?? '')]);
      asked += 1;
    } catch (err) {
      console.error(`[duty] could not ask ${phone}:`, err);
    }
  }
  return asked;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startDutyWatch(): void {
  if (timer) return;
  if (config.dutyCheckInMinutes <= 0) {
    console.log('[duty] not asking before a clock-in lapses (DUTY_CHECK_IN_MINUTES=0)');
    return;
  }

  // Often enough that the window cannot be stepped over, rarely enough that
  // it costs nothing: the sweep reads one row per associate and sends nothing
  // unless somebody is actually due.
  const every = 120_000;
  timer = setInterval(() => {
    void sweepCheckIns().catch((err) => console.error('[duty] sweep failed:', err));
  }, every);
  // Nothing should be kept alive by this alone.
  timer.unref?.();

  console.log(
    `[duty] asking "still out?" ${config.dutyCheckInMinutes} minutes before a ` +
      `${dutyLimits().lapseHours}-hour clock-in lapses`,
  );
}

export function stopDutyWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

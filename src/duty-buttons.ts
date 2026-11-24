/**
 * The two taps that start and end a shift.
 *
 * They live in their own file for one reason: `duty_off` has been shipping
 * with no reader behind it. It worked by accident — the webhook falls back to
 * a button's TITLE when nothing reads its id, and "Clock off" happens to
 * match the same regex a typed `off` does. Four buttons have already been
 * killed by that fallback (`changedest_`, `dest_ok_`, `callcust_`, and a
 * `take_` with no verb), and this one was one translated word away from
 * being the fifth.
 *
 * So the meaning is in the id, as it is everywhere else, and the title is
 * free to read like something a tired person wants to tap at the end of a
 * twelve-hour day.
 */

/** "Yes, still working" — a fresh stretch, offered before the clock-in lapses. */
export const DUTY_ON = 'duty_on';
/** "Clock off" — the end of a shift. */
export const DUTY_OFF = 'duty_off';

/**
 * What a duty tap means, in the words the staff handler already reads.
 *
 * Deliberately the same two words a driver can type, so there is one handler
 * and not two: a tap and a typed `on` are the same thing and must stay the
 * same thing.
 */
export function dutyCommandFor(id: string): string | null {
  const said = String(id ?? '').trim();
  if (said === DUTY_ON) return 'on';
  if (said === DUTY_OFF) return 'off';
  return null;
}

export function isDutyId(id: string): boolean {
  return dutyCommandFor(id) !== null;
}

/**
 * Running out of something for a while.
 *
 * A kitchen runs out of duck at lunchtime and has more at four. That is not the
 * same as taking a dish off the menu, and it is not the same as running out for
 * the day — but until now the only thing a kitchen could say was "sold out",
 * which lasted until somebody remembered to undo it. Dishes stayed off for days
 * because the undo is the step nobody does.
 *
 * So a shortage carries a time, and comes back on by itself. The customer is
 * told when, which turns "we don't have that" into "that one is back at four" —
 * a different conversation, and often still a sale.
 *
 * Times are handled as minutes-from-now rather than by building a local date.
 * Constructing "3pm in Georgetown" from a Date means tz arithmetic that is
 * wrong twice a year in places with daylight saving; asking what the clock
 * currently reads there, and adding the difference, is right everywhere.
 */
import { config } from './config.ts';

const MINUTES_IN_DAY = 1440;

/** What the clock reads in the store's own timezone, in minutes past midnight. */
function localMinutes(now: Date): number | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.store.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // Some ICU builds render midnight as 24.
  return (hour % 24) * 60 + minute;
}

/** The next time the local clock reads this, today or tomorrow. */
function minutesUntilClock(now: Date, targetMinutes: number): number | null {
  const current = localMinutes(now);
  if (current === null) return null;
  const diff = targetMinutes - current;
  // Already past today, so they mean tomorrow. A kitchen saying "until 9am" at
  // 10am means the morning that is coming, not the one that has gone.
  return diff > 0 ? diff : diff + MINUTES_IN_DAY;
}

export type Shortage = {
  /** When it comes back, or null for "off until somebody says otherwise". */
  until: Date | null;
  /** What was left after the duration was taken off the end — the dish. */
  item: string;
};

/**
 * Pulls a duration off the end of what the kitchen typed.
 *
 * Matched at the end on purpose: a dish is whatever comes before it, so
 * "sold out dhal puri until 3pm" needs no punctuation and no fixed word order
 * to teach. A message with no duration is an open-ended shortage, which is
 * what `sold out` has always meant, so nothing an outlet already types changes
 * meaning.
 */
export function parseShortage(text: string, now = new Date()): Shortage {
  const trimmed = text.trim().replace(/\.$/, '');

  const add = (minutes: number | null, item: string): Shortage => ({
    until: minutes === null ? null : new Date(now.getTime() + minutes * 60_000),
    item: item.trim().replace(/[,\s]+$/, ''),
  });

  // "for 90 minutes", "for 2 hours", "2 hrs"
  const span = trimmed.match(
    /^(.*?)[,\s]+(?:for\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i,
  );
  if (span) {
    const amount = Number(span[2]);
    const unit = (span[3] ?? '').toLowerCase();
    const minutes = unit.startsWith('m') ? amount : amount * 60;
    if (Number.isFinite(minutes) && minutes > 0) {
      return add(Math.round(minutes), span[1] ?? '');
    }
  }

  // "until 3pm", "till 3:30pm", "until 15:00"
  const clock = trimmed.match(
    /^(.*?)[,\s]+(?:un)?til+\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (clock) {
    let hour = Number(clock[2]);
    const minute = Number(clock[3] ?? '0');
    const meridiem = clock[4]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      return add(minutesUntilClock(now, hour * 60 + minute), clock[1] ?? '');
    }
  }

  // "today", "for today", "for the rest of the day", "until tomorrow" — all of
  // which mean the same thing: back when the day turns over.
  const today = trimmed.match(
    /^(.*?)[,\s]+(?:for\s+)?(?:the\s+)?(?:rest\s+of\s+(?:the\s+)?(?:day|today)|today|(?:un)?til+\s+tomorrow)$/i,
  );
  if (today) {
    const current = localMinutes(now);
    return add(current === null ? null : MINUTES_IN_DAY - current, today[1] ?? '');
  }

  return { until: null, item: trimmed };
}

/** The clock time in the store's own timezone, as a person writes it. */
function localClock(when: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.store.timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(when)
    .replace(/\s/g, '')
    .toLowerCase();
}

/**
 * How long it is off, in words a customer can act on.
 *
 * The clock time rather than a countdown: "back at 4:00pm" is something
 * somebody can plan around, and stays true in a message read ten minutes later,
 * which "back in 40 minutes" does not.
 */
export function describeShortage(until: Date | null, now = new Date()): string {
  if (!until) return 'until further notice';

  const minutesAway = Math.round((until.getTime() - now.getTime()) / 60_000);
  if (minutesAway <= 0) return 'until further notice';

  const current = localMinutes(now);
  // Landing exactly on midnight is the "rest of today" case, and "until
  // 12:00am" reads as a riddle.
  if (current !== null && current + minutesAway === MINUTES_IN_DAY) {
    return 'for the rest of today';
  }
  if (minutesAway > MINUTES_IN_DAY) return 'until further notice';

  return `until ${localClock(until)}`;
}

/** Whether a recorded shortage has run out and the dish is back on. */
export function shortageExpired(soldOutUntil: string, now = new Date()): boolean {
  if (!soldOutUntil) return false;
  const when = new Date(soldOutUntil).getTime();
  if (!Number.isFinite(when)) return false;
  return when <= now.getTime();
}

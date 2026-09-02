import { config, money } from '../config.ts';
import * as repo from '../db/repo.ts';

/**
 * Per-conversation context: what time it is locally, and who this customer is.
 *
 * This is deliberately NOT part of the system prompt. The system prompt is the
 * cached prefix, and a clock in it would invalidate the cache on every single
 * message — slower and more expensive on every turn. It goes in the messages
 * array instead, where it costs nothing to vary.
 */
export const CONTEXT_MARKER = '[Shop context';

/**
 * The clock, refreshed on every turn.
 *
 * A conversation can run for hours, and a time fixed at the first message drifts
 * — "we close in 40 minutes" is wrong an hour later, and "tomorrow" changes
 * meaning at midnight. Kept separate from the customer details below, which do
 * not change mid-conversation and would nag if repeated every turn.
 */
export function buildTimeContext(): string {
  const lines = [
    `${CONTEXT_MARKER} — the customer cannot see this]`,
    `Local time: ${localTime()} — ${partOfDay()}.`,
  ];
  const status = shopStatus();
  if (status.state === 'closed') {
    lines.push('The shop is closed now — any order will go out when it next opens.');
  } else if (status.state === 'open' && status.closesInMinutes <= 60) {
    lines.push(
      `The shop closes in about ${status.closesInMinutes} minutes — mention it if they are still browsing.`,
    );
  }
  // 'unknown' deliberately says nothing. Silence is recoverable; telling someone
  // the shop is shut when it is open is not.
  return lines.join('\n');
}

export function buildConversationContext(phone: string): string {
  const lines: string[] = [buildTimeContext()];

  const customer = repo.getCustomer(phone);
  const orders = repo.recentOrders(phone, 1);
  const last = orders[0];

  if (!customer.name && !last) {
    lines.push('This is a new customer with no order history. Introduce the shop briefly.');
    return lines.join('\n');
  }

  if (customer.name) lines.push(`Customer: ${customer.name}. Greet them by first name once.`);
  if (customer.address) {
    lines.push(`Delivery address on file: ${customer.address}. Do not ask for it again.`);
  }

  if (last) {
    const items = last.items.map((i) => `${i.qty} x ${i.name}`).join(', ');
    lines.push(
      `Last order ${last.orderNo} (${relativeDay(last.placedAt)}): ${items} — ${money(last.total)}.`,
    );
    lines.push(
      'If they seem to want a routine shop, offer to repeat that order rather than starting from scratch.',
    );
  }

  return lines.join('\n');
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: config.store.timezone });
}

function localTime(): string {
  return formatter({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}

/**
 * Which greeting the hour calls for, stated outright.
 *
 * The local time alone leaves the model to do the arithmetic, and "8:15 pm"
 * occasionally came back as "Good afternoon". Naming it removes the guess.
 */
function partOfDay(): string {
  const hour = Number(
    formatter({ hour: '2-digit', hour12: false }).formatToParts(new Date()).find((p) => p.type === 'hour')
      ?.value,
  );
  if (!Number.isFinite(hour)) return 'greet without naming the time of day';
  // Some ICU builds render midnight as 24 rather than 00.
  if (hour < 12 || hour === 24) return 'greet with "Good morning"';
  if (hour < 17) return 'greet with "Good afternoon"';
  return 'greet with "Good evening"';
}

/** "yesterday", "3 days ago", "on 14 August" — how a person would say it. */
function relativeDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'previously';

  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return `on ${formatter({ day: 'numeric', month: 'long' }).format(then)}`;
}


/* ------------------------------------------------------------ opening hours */

/**
 * Whether the shop is open, and for how much longer.
 *
 * STORE_HOURS is free text written for customers to read, so this is best-effort
 * by design — but it must fail to 'unknown', never to a confident wrong answer.
 * An earlier version took the last time in the string, which read Sunday's
 * closing time out of "Mon-Sat 8am-8pm, Sun 9am-4pm" and applied it to every day
 * of the week, telling Wednesday shoppers the shop shut at four.
 */
export type ShopStatus =
  | { state: 'open'; closesInMinutes: number }
  | { state: 'closed' }
  | { state: 'unknown' };

const DAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const DAY_WORD = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?/gi;
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;

/** Minutes past midnight, or null when the text is not a time we understand. */
function toMinutes(rawHour: string, rawMinute: string | undefined, meridiem: string): number | null {
  let hour = Number(rawHour);
  const minute = Number(rawMinute ?? '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 12 || minute > 59) return null;
  if (/pm/i.test(meridiem) && hour !== 12) hour += 12;
  if (/am/i.test(meridiem) && hour === 12) hour = 0;
  return hour * 60 + minute;
}

/** Which days a fragment such as "Mon-Sat" or "Sun" covers. Empty means "unstated". */
function daysCovered(text: string): Set<number> {
  const days = new Set<number>();
  const found = [...text.matchAll(DAY_WORD)].map((m) => DAY_INDEX[(m[1] ?? '').toLowerCase()]);
  if (found.length === 0) return days;

  // A hyphen between the first two day words means a range: Mon-Sat is six days,
  // not two. Anything else is a plain list.
  const range = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s*(?:-|–|—|to|thru|through)\s*(sun|mon|tue|wed|thu|fri|sat)/i;
  const asRange = text.match(range);
  if (asRange) {
    const from = DAY_INDEX[(asRange[1] ?? '').toLowerCase()];
    const to = DAY_INDEX[(asRange[2] ?? '').toLowerCase()];
    if (from !== undefined && to !== undefined) {
      // Walks forward so Fri-Mon wraps the weekend rather than coming out empty.
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === to) break;
      }
      return days;
    }
  }

  for (const d of found) if (d !== undefined) days.add(d);
  return days;
}

export function shopStatus(now = new Date()): ShopStatus {
  const hours = config.store.hours.trim();
  if (!hours) return { state: 'unknown' };

  const today = DAY_INDEX[
    formatter({ weekday: 'short' }).format(now).slice(0, 3).toLowerCase()
  ];
  if (today === undefined) return { state: 'unknown' };

  const parts = formatter({ hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const nowHour = Number(parts.find((p) => p.type === 'hour')?.value);
  const nowMinute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(nowHour) || !Number.isFinite(nowMinute)) return { state: 'unknown' };
  // Some ICU builds render midnight as 24.
  const nowMinutes = (nowHour % 24) * 60 + nowMinute;

  // "Mon-Sat 8am-8pm, Sun 9am-4pm" splits into one clause per group of days.
  const clauses = hours.split(/[,;]|\band\b/i).map((c) => c.trim()).filter(Boolean);

  let sawTodaysClause = false;
  let anyClauseUnderstood = false;

  for (const clause of clauses) {
    const covered = daysCovered(clause);
    // A clause naming no days applies to every day, but only when it is the
    // whole setting — otherwise it is a stray fragment of a split gone wrong.
    const appliesToday = covered.size === 0 ? clauses.length === 1 : covered.has(today);

    if (/\bclosed\b/i.test(clause)) {
      if (appliesToday) return { state: 'closed' };
      anyClauseUnderstood = true;
      continue;
    }

    const times = [...clause.matchAll(TIME)];
    if (times.length < 2) continue;

    const first = times[0]!;
    const last = times[times.length - 1]!;
    const opens = toMinutes(first[1]!, first[2], first[3]!);
    let closes = toMinutes(last[1]!, last[2], last[3]!);
    if (opens === null || closes === null) continue;
    // A closing time at or before opening runs past midnight.
    if (closes <= opens) closes += 1440;

    anyClauseUnderstood = true;
    if (!appliesToday) continue;
    sawTodaysClause = true;

    // Small hours of a session that began yesterday evening: at 00:30 under
    // "6pm - 2am" the shop is open, and the clock reads before opening time.
    if (closes > 1440 && nowMinutes + 1440 < closes) {
      return { state: 'open', closesInMinutes: closes - nowMinutes - 1440 };
    }
    if (nowMinutes < opens) return { state: 'closed' };
    if (nowMinutes >= closes) return { state: 'closed' };
    return { state: 'open', closesInMinutes: closes - nowMinutes };
  }

  // Understood the setting, and today is simply not in it — a shop that lists
  // Mon-Sat is shut on Sunday.
  if (anyClauseUnderstood && !sawTodaysClause) return { state: 'closed' };
  return { state: 'unknown' };
}

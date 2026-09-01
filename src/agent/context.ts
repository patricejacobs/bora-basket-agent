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
export function buildConversationContext(phone: string): string {
  const lines: string[] = ['[Shop context — the customer cannot see this]'];

  lines.push(`Local time: ${localTime()}.`);
  const closing = minutesUntilClosing();
  if (closing !== null && closing <= 60) {
    lines.push(
      `The shop closes in about ${closing} minutes — mention it if they are still browsing.`,
    );
  }

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

/**
 * Minutes until closing, or null when the hours string cannot be read. Parsing
 * free-text opening hours is best-effort by design: STORE_HOURS is written for
 * customers to read, so a shop with unusual hours simply gets no reminder
 * rather than a wrong one.
 */
function minutesUntilClosing(): number | null {
  const match = config.store.hours.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*$/i);
  if (!match) return null;

  const [, rawHour, rawMinute, meridiem] = match;
  let hour = Number(rawHour);
  if (!Number.isFinite(hour)) return null;
  if (/pm/i.test(meridiem ?? '') && hour !== 12) hour += 12;
  if (/am/i.test(meridiem ?? '') && hour === 12) hour = 0;

  const parts = formatter({ hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(
    new Date(),
  );
  const nowHour = Number(parts.find((p) => p.type === 'hour')?.value);
  const nowMinute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!Number.isFinite(nowHour) || !Number.isFinite(nowMinute)) return null;

  const remaining = (hour * 60 + Number(rawMinute ?? 0)) - (nowHour * 60 + nowMinute);
  return remaining > 0 ? remaining : null;
}

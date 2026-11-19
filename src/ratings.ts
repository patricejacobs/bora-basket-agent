/**
 * What the customer thought of it.
 *
 * One tappable list at the end of a delivery, five rows, one tap. Asked as its
 * own message rather than at the foot of the delivered one: that message
 * already carries the closing line, the receipt and the goodbye, and a
 * question under all of that is scrolled past.
 *
 * Three rules that are not about stars at all, and matter more than they do:
 *
 *  - A customer who had a good delivery says so in one tap and is left alone.
 *    Only three stars or fewer gets a second question.
 *  - Nobody is asked often. Somebody who orders three times a week and is
 *    asked three times a week mutes the shop, and then the shop has no way to
 *    reach them about an order.
 *  - Nothing is asked about an order that went wrong. The shop knows it went
 *    wrong; asking for a score is salt in it.
 */
import * as repo from './db/repo.ts';
import { config } from './config.ts';
import type { OutboundMessage } from './channels/types.ts';

/** How long a rating question stays live. */
export const RATING_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * How long a bare digit is read as stars, which is far shorter.
 *
 * A tap can be honoured for the full window: nobody sends a row of star
 * glyphs by accident, and it can only have come from the list the shop sent.
 * A digit is a different thing. "2" is the second service on the menu, the
 * second kitchen, the second aisle - so it counts as two stars only while the
 * question is plainly the last thing that happened, and is a menu choice
 * again a quarter of an hour later. Getting this wrong does not lose a
 * rating, it eats somebody's order.
 */
export const RATING_DIGIT_TTL_MS = 15 * 60 * 1000;

/**
 * The quietest a customer is left between questions, PER SERVICE.
 *
 * Counted per service rather than per customer. Somebody who shops weekly is
 * still only asked about their shopping once a fortnight, but their taxi is
 * asked about on its own account - the two have nothing to do with one
 * another, and a ride is the only job where the shop never sees the customer.
 *
 * The cost, stated plainly: a customer who uses all four services inside a
 * fortnight could be asked four times. That is the price of hearing about
 * each of them.
 */
export const RATING_EVERY_DAYS = 14;

/** At or below this, the shop asks what went wrong. */
export const POOR = 3;

const STARS: { stars: number; title: string; description: string }[] = [
  { stars: 5, title: '⭐⭐⭐⭐⭐', description: 'Perfect — nothing to fix' },
  { stars: 4, title: '⭐⭐⭐⭐', description: 'Good — small things' },
  { stars: 3, title: '⭐⭐⭐', description: 'Alright' },
  { stars: 2, title: '⭐⭐', description: 'Not good' },
  { stars: 1, title: '⭐', description: 'Bad — please get in touch' },
];

/**
 * Whether to ask this customer about this order at all.
 *
 * Every no here is deliberate. A returned or cancelled order is not rated
 * because the shop already knows; a taxi is, because it is the one service
 * where nobody from the shop ever sees the customer.
 */
export function shouldAsk(order: repo.OrderRecord, now = new Date()): boolean {
  if (order.status !== 'delivered') return false;
  if (repo.ratingFor(order.orderNo)) return false;

  const last = repo.lastRatingAsk(order.phone, order.kind);
  if (!last) return true;
  const quiet = RATING_EVERY_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - new Date(last).getTime() >= quiet;
}

/** The question itself, as a list of five. */
export function ratingAsk(order: repo.OrderRecord): OutboundMessage {
  const what =
    order.kind === 'taxi'
      ? `How was the trip, ${order.customerName.split(/\s+/)[0] ?? 'there'}?`
      : order.kind === 'parcel'
        ? `How did we do with ${order.orderNo}?`
        : `How did we do with ${order.orderNo}?`;

  return {
    kind: 'list',
    text: what,
    button: order.kind === 'taxi' ? 'Rate this trip' : 'Rate this order',
    rows: STARS.map((s) => ({
      id: `rate_${s.stars}_${order.orderNo}`,
      title: s.title,
      description: s.description,
    })),
  };
}

/**
 * Reads a customer's answer, from a tap or from a typed digit.
 *
 * The tap arrives as the row's title - a run of stars - because that is what
 * WhatsApp sends back for a list. The digit is accepted too: a customer whose
 * client renders the list badly, or who simply types, has still answered.
 *
 * Returns 0 for anything that is not an answer, which includes "4 bags of
 * rice" - a message with other words in it is not a rating, and reading it as
 * one would swallow an order.
 */
export function readStars(text: string): number {
  const said = text.trim();
  if (!said) return 0;

  const starred = said.match(/^⭐+$/u);
  if (starred) return Math.min(5, starred[0].length);

  const digit = said.match(/^([1-5])\s*(?:⭐|stars?|\*)?$/i);
  if (digit) return Number(digit[1]);

  return 0;
}

/** What the customer is told once they have answered. */
export function thanksForStars(stars: number): string {
  if (stars > POOR) {
    return stars === 5 ? 'Thank you! 🙏' : 'Thank you — good to know. 🙏';
  }
  // The promise is made only where it can be kept. With no staff number set
  // there is nobody for this to reach, and saying otherwise to somebody who
  // has just had a bad delivery is the worst moment to be caught out.
  return config.staffNumbers.length > 0
    ? 'Sorry to hear that. What went wrong? Whatever you write goes straight to the manager.'
    : 'Sorry to hear that. What went wrong? I will write it down for the shop.';
}

/**
 * Puts a poor rating in front of a person, twice if they also wrote words.
 *
 * Sent the moment the stars arrive rather than waiting for the complaint:
 * most people tap and never write, and two stars with no explanation is still
 * the most useful thing the shop will hear today. The second alert, when the
 * words come, repeats the whole thing - the first one is buried by then.
 */
export async function tellStaffOfPoorRating(orderNo: string): Promise<void> {
  const body = poorRatingAlert(orderNo);
  if (!body) return;
  const { sendText } = await import('./channels/whatsapp-send.ts');
  for (const staff of config.staffNumbers) await sendText(staff, body);
  if (config.staffNumbers.length === 0) {
    // Written down where somebody will trip over it, since there is nobody to
    // send it to. A complaint that reaches neither a person nor a log is a
    // complaint the shop has thrown away.
    console.warn(`[ratings] ${orderNo} rated poorly and STAFF_NUMBERS is empty — nobody was told:
${body}`);
  }
}

/** The alert the shop gets about a poor one, or '' when there is nothing to say. */
export function poorRatingAlert(orderNo: string): string {
  const order = repo.findOrder(orderNo);
  const rated = repo.ratingFor(orderNo);
  if (!order || !rated || rated.stars === 0 || rated.stars > POOR) return '';

  const driver = order.driverName || (order.driverPhone ? `+${order.driverPhone}` : '');
  const nl = String.fromCharCode(10);
  return [
    `⚠️ *${'⭐'.repeat(rated.stars)} on ${order.orderNo}* — ${order.customerName} +${order.contactPhone || order.phone}`,
    ...(rated.comment ? [`"${rated.comment}"`] : ['_No words yet — they were asked._']),
    [order.outlet?.name, driver ? `delivered by ${driver}` : '']
      .filter(Boolean)
      .join(' · '),
  ]
    .filter(Boolean)
    .join(nl);
}

/** The shop's own view of the last month. */
export function ratingsReport(days = 30): string {
  const rows = repo.ratingsSince(new Date(Date.now() - days * 86_400_000));
  const nl = String.fromCharCode(10);
  const answered = rows.filter((r) => r.stars > 0);

  if (answered.length === 0) {
    return [
      `*Ratings* — last ${days} days`,
      '',
      rows.length === 0
        ? 'Nobody has been asked yet. The question goes out after a delivery.'
        : `${rows.length} asked, none answered yet.`,
    ].join(nl);
  }

  const mean = (list: { stars: number }[]): string =>
    (list.reduce((sum, r) => sum + r.stars, 0) / list.length).toFixed(1);

  const by = (key: 'driver' | 'outlet'): string[] => {
    const groups = new Map<string, { stars: number }[]>();
    for (const r of answered) {
      const name = key === 'driver' ? r.driverName : r.outletName;
      if (!name) continue;
      groups.set(name, [...(groups.get(name) ?? []), r]);
    }
    return [...groups.entries()]
      .sort((a, b) => Number(mean(b[1])) - Number(mean(a[1])))
      .map(([name, list]) => `${name} — ${mean(list)} (${list.length})`);
  };

  const poor = answered.filter((r) => r.stars <= POOR);
  const drivers = by('driver');
  const outlets = by('outlet');

  return [
    `*Ratings* — last ${days} days`,
    `${answered.length} of ${rows.length} answered · average *${mean(answered)}* ⭐`,
    ...(drivers.length > 0 ? ['', '*By associate*', ...drivers] : []),
    ...(outlets.length > 0 ? ['', '*By outlet*', ...outlets] : []),
    ...(poor.length > 0
      ? [
          '',
          `*${POOR}★ and below (${poor.length})*`,
          ...poor.map(
            (r) =>
              `${r.orderNo} ${'⭐'.repeat(r.stars)}${r.comment ? ` "${r.comment}"` : ' — no words'}`,
          ),
        ]
      : ['', 'Nothing below ' + POOR + '★. 🎉']),
  ].join(nl);
}

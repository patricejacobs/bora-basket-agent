/**
 * Reward points: five per cent back, counted in points so it reads as a
 * scheme rather than as a discount somebody decided to give.
 *
 *   $10 of DELIVERY CHARGES   1 point
 *   $10,000 of delivery       1,000 points
 *   1,000 points              $500 off an order
 *
 * So a point is fifty cents, and the scheme gives back five per cent of what
 * a customer has paid to have things carried. Both figures are written here
 * once, and everything that quotes them reads them from here — a scheme whose
 * arithmetic is spelled out in four places is one that will eventually pay
 * two different amounts.
 *
 * THE DELIVERY CHARGE EARNS, NOT THE SHOPPING. That is the shop's decision
 * and it has a consequence worth saying out loud: the tariff runs from $500
 * in Georgetown to $5,000 at Parika, so a customer out at Parika reaches a
 * reward in two deliveries and one in Kitty needs twenty. The scheme pays
 * back the people who pay the most to be reached, which is defensible — they
 * are the dearest to serve and the easiest to lose — but it is not the same
 * thing as rewarding the biggest shoppers, and nobody should discover that
 * from a customer.
 *
 * A parcel's fee is a delivery charge and earns. A taxi earns on the whole
 * trip - the fare and the waiting together, which is what the passenger paid
 * to be carried and what the receipt in their hand says. A trip the tariff
 * could not price earns nothing, the shop never having learned what was paid.
 *
 * Two rules that matter more than the rate:
 *
 *  - Points are credited at DELIVERY, never at ordering. An order that is
 *    cancelled, returned or never arrives has earned nothing, and a scheme
 *    that pays out before the goods are in somebody's hands is one that pays
 *    for orders that did not happen.
 *  - Nothing is ever spent that was not earned. The ledger is the authority
 *    and the balance is read from it, so the worst case is a point that was
 *    never awarded rather than a reward given twice.
 */
import { config, money } from './config.ts';
import { t, type Language } from './language.ts';
import { zoneFeeFor } from './zones.ts';
import * as repo from './db/repo.ts';

/** Delivery charges, in money, that earn one point. */
export const PER_POINT = 10 * config.currency.minorPerUnit;

/** Points that make up one reward. */
export const REWARD_POINTS = 1000;

/** What one reward is worth, in money. */
export const REWARD_VALUE = 500 * config.currency.minorPerUnit;

/** What a pile of points is worth, rounded down to whole rewards. */
export function rewardsIn(points: number): number {
  return Math.floor(Math.max(0, points) / REWARD_POINTS);
}

/** The money a pile of points can take off an order right now. */
export function valueOf(points: number): number {
  return rewardsIn(points) * REWARD_VALUE;
}

/**
 * What an order earns: what it cost to carry, not what was in the bag.
 *
 * Rounded down. A customer is never shown a fraction of a point, and rounding
 * up would hand out a point for a dollar.
 */
export function pointsFor(deliveryCharge: number): number {
  if (deliveryCharge <= 0) return 0;
  return Math.floor(deliveryCharge / PER_POINT);
}

/** Delivery charges still to pay before the next reward, in money. */
export function spendToNextReward(points: number): number {
  const have = Math.max(0, points) % REWARD_POINTS;
  return (REWARD_POINTS - have) * PER_POINT;
}

/**
 * The most deliveries the shop will put a number on.
 *
 * Past this it stops being encouragement. A Georgetown customer two
 * deliveries in is eighteen away, which is true and is not an advertisement -
 * so the distance in points is still shown, always, and the shop simply does
 * not volunteer the harder number. Anybody who wants it can work it out.
 */
export const MAX_SHOWN_DELIVERIES = 5;

/**
 * The delivery that has just concluded: where it went, and what it cost.
 *
 * Read from the ORDER, which is the only record of where it actually went.
 * The customer's saved zone is where they usually are, and a delivery that
 * was redirected mid-flight is precisely the case where the two differ — so
 * the message congratulating them on that delivery named the village they
 * had just moved it away from.
 *
 * The fee charged, not the fee the tariff would quote today. Points are
 * earned on what was actually paid, and a price list that changes next week
 * must not change what last week's delivery was worth.
 */
export function deliveryOn(order: {
  deliveryZone: string;
  deliveryFee: number;
}): { zone: string; fee: number } | null {
  const place = order.deliveryZone.trim();
  if (!place || order.deliveryFee <= 0) return null;
  return { zone: place, fee: order.deliveryFee };
}

/**
 * What a delivery to this customer usually costs, or null.
 *
 * The last one they actually took, by preference: it is a delivery that
 * really happened, at a price really charged, and it is the answer to "how
 * many more of these" that a customer would give themselves.
 *
 * Their saved zone is the fallback, for somebody who has never completed a
 * delivery yet — priced from the tariff, since there is no charged figure to
 * read. Null where the shop has never learned where they live, or where the
 * place is not in the tariff, and then the deliveries line is left out
 * rather than guessed at.
 */
export function usualDelivery(phone: string): { zone: string; fee: number } | null {
  const last = repo.lastDeliveryTo(phone);
  if (last) return last;
  const place = repo.getCustomer(phone).deliveryZone;
  if (!place) return null;
  const priced = zoneFeeFor(place);
  return priced ? { zone: priced.place, fee: priced.fee } : null;
}

/**
 * What a customer is told about their points, whenever they ask.
 *
 * Two shapes, and the difference is the whole scheme: either there is
 * something to spend, or there is a distance left to go. Nobody is told "you
 * have 340 points" and left to work out what that is worth.
 *
 * The distance is counted in POINTS TO GO, never in money still to spend.
 * The base is the delivery charge, so "spend $8,200 more" would read as "pay
 * us more in fees" — and a customer cannot go and acquire points anyway.
 * What they can do is order again, which is what the deliveries line says,
 * priced from the zone already on their record.
 */
/**
 * The welcome gift this customer still has coming, or 0.
 *
 * Offered to somebody the base has no name for and who has never had it.
 * The name is the whole of what registering ever meant here — the number
 * came with WhatsApp — so the offer belongs on the question that asks for
 * it, and nowhere else. There is no sign-up screen to put it on.
 */
export function welcomeOnOffer(phone: string): number {
  const points = config.store.welcomePoints;
  if (points <= 0) return 0;
  if (repo.welcomePointsGiven(phone)) return 0;
  if ((repo.getCustomer(phone).name ?? '').trim() !== '') return 0;
  return points;
}

export function balanceLines(
  points: number,
  lang: Language = 'en',
  /** Where they usually get deliveries, and what one costs. */
  usual?: { zone: string; fee: number } | null,
): string[] {
  const value = valueOf(points);

  if (value > 0) {
    return [
      t('points_ready', lang, { points: String(points), value: money(value) }),
      t('points_use_hint', lang),
    ];
  }

  const togo = REWARD_POINTS - (Math.max(0, points) % REWARD_POINTS);
  const lines = [
    t('points_to_go', lang, {
      points: String(points),
      togo: String(togo),
      value: money(REWARD_VALUE),
    }),
  ];

  // How many more deliveries that is, where the shop knows what one costs
  // them and the answer is near enough to be worth saying.
  const each = usual ? pointsFor(usual.fee) : 0;
  if (each > 0) {
    const trips = Math.ceil(togo / each);
    if (trips === 1) lines.push(t('points_one_delivery', lang, { zone: usual!.zone }));
    else if (trips <= MAX_SHOWN_DELIVERIES) {
      lines.push(t('points_deliveries', lang, { n: String(trips), zone: usual!.zone }));
    }
  }

  return lines;
}

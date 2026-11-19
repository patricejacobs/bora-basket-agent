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
 * A parcel's fee is a delivery charge and earns. A taxi earns nothing,
 * because the shop never learns the fare: the driver agrees it in the car.
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
 * What a customer is told about their points, whenever they ask.
 *
 * Two shapes, and the difference is the whole scheme: either there is
 * something to spend, or there is a distance left to go. Nobody is told "you
 * have 340 points" and left to work out what that is worth.
 */
export function balanceLines(points: number, lang: Language = 'en'): string[] {
  const value = valueOf(points);
  const lines = [t('points_balance', lang, { points: String(points) })];

  if (value > 0) {
    lines.push(t('points_ready', lang, { value: money(value) }));
    return lines;
  }

  // Short of the first reward. The target is what they are working towards,
  // not what they have, because a number with no destination is not an
  // incentive.
  const target = (rewardsIn(points) + 1) * REWARD_POINTS;
  lines.push(
    t('points_progress', lang, {
      spend: money(spendToNextReward(points)),
      target: String(target),
      value: money(REWARD_VALUE),
    }),
  );
  return lines;
}

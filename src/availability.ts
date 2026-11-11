/**
 * Whether a thing can be ordered right now.
 *
 * Groceries and cooked food answer this differently, and conflating them breaks
 * both. A shop holds 42 bags of rice and cannot sell the 43rd. A kitchen holds
 * no quantity at all: it cooks to order, and the only real state is whether it
 * has run out for the day. Reading a menu item's stock column would find 0 and
 * refuse every burger in the building.
 *
 * Kept in its own module because the catalogue search, the cart tools and the
 * checkout transaction all need the same answer, and search cannot import the
 * repo without a cycle.
 */
import type { Product } from './db/repo.ts';
import { describeShortage, shortageExpired } from './shortages.ts';

/** Null means no limit — a kitchen will cook as many as you order. */
export function availableQty(product: Product): number | null {
  if (!product.trackStock) return null;
  return product.stock;
}

/**
 * Whether a shortage is still running.
 *
 * Judged on the end time rather than the flag, so a dish is back on the moment
 * its hour arrives — not whenever a sweep next happens to run. Without this
 * there is a window where a customer is told something is off while the shop
 * believes it is back, and the length of that window is an implementation
 * detail nobody should be able to feel.
 */
export function soldOutNow(product: Product, now = new Date()): boolean {
  if (!product.soldOut) return false;
  return !shortageExpired(product.soldOutUntil ?? '', now);
}

/** The end of a shortage, or null when none was set or it is unreadable. */
function timedUntil(product: Product, now = new Date()): Date | null {
  if (!soldOutNow(product, now) || !product.soldOutUntil) return null;
  const until = new Date(product.soldOutUntil);
  return Number.isFinite(until.getTime()) ? until : null;
}

/** When it comes back, in words, or empty when it is on the menu. */
export function backWhen(product: Product, now = new Date()): string {
  if (!soldOutNow(product, now)) return '';
  return describeShortage(timedUntil(product, now), now);
}

export function available(product: Product, now = new Date()): boolean {
  if (soldOutNow(product, now)) return false;
  const qty = availableQty(product);
  return qty === null || qty > 0;
}

/** Can this many be ordered? Returns the reason it cannot, or null. */
export function refuseQty(product: Product, qty: number, now = new Date()): string | null {
  if (soldOutNow(product, now)) {
    // The return time is the useful half, when there is one. "We don't have
    // it" ends the conversation; "that one is back at four" often keeps the
    // order. With no end set there is nothing to promise, and "sold out" is
    // plainer than a phrase built to sound like a time.
    const until = timedUntil(product, now);
    return until
      ? `${product.name} is unavailable ${describeShortage(until, now)}. ` +
        `Tell the customer when it is back, offer something else, and do not add it.`
      : `${product.name} is sold out for today. Say so and offer something else — do not add it.`;
  }
  const limit = availableQty(product);
  if (limit === null) return null;
  if (limit <= 0) return `${product.name} is out of stock.`;
  if (qty > limit) {
    return `Only ${limit} x ${product.name} left (the order asks for ${qty}).`;
  }
  return null;
}

/** How availability should be described to the agent. */
export function availabilityLabel(product: Product, now = new Date()): string {
  if (soldOutNow(product, now)) {
    const until = timedUntil(product, now);
    return until ? `unavailable ${describeShortage(until, now)}` : 'sold out today';
  }
  const limit = availableQty(product);
  if (limit === null) return 'available';
  if (limit <= 0) return 'out of stock';
  if (limit <= 5) return `only ${limit} left`;
  return 'in stock';
}

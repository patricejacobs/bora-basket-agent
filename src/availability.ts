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

/** Null means no limit — a kitchen will cook as many as you order. */
export function availableQty(product: Product): number | null {
  if (!product.trackStock) return null;
  return product.stock;
}

export function available(product: Product): boolean {
  if (product.soldOut) return false;
  const qty = availableQty(product);
  return qty === null || qty > 0;
}

/** Can this many be ordered? Returns the reason it cannot, or null. */
export function refuseQty(product: Product, qty: number): string | null {
  if (product.soldOut) {
    return `${product.name} is sold out for today. Say so and offer something else — do not add it.`;
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
export function availabilityLabel(product: Product): string {
  if (product.soldOut) return 'sold out today';
  const limit = availableQty(product);
  if (limit === null) return 'available';
  if (limit <= 0) return 'out of stock';
  if (limit <= 5) return `only ${limit} left`;
  return 'in stock';
}

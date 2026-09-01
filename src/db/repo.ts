import { db, nowIso } from './index.ts';
import { config } from '../config.ts';

export type Product = {
  id: number;
  sku: string;
  name: string;
  description: string;
  category: string;
  unit: string;
  price: number;
  stock: number;
  active: number;
  keywords: string;
};

export type CartLine = { product: Product; qty: number; lineTotal: number };

export type CartSummary = {
  lines: CartLine[];
  itemCount: number;
  subtotal: number;
  deliveryFee: number;
  total: number;
};

export type Customer = { phone: string; name: string | null; address: string | null };

/* ------------------------------------------------------------------ catalog */

export function listCategories(): { category: string; count: number }[] {
  return db
    .prepare(
      `SELECT category, COUNT(*) AS count FROM products
       WHERE active = 1 GROUP BY category ORDER BY category`,
    )
    .all() as { category: string; count: number }[];
}

export function getProductBySku(sku: string): Product | null {
  const row = db
    .prepare(`SELECT * FROM products WHERE sku = ? COLLATE NOCASE AND active = 1`)
    .get(sku.trim());
  return (row as Product | undefined) ?? null;
}

/**
 * Ranked keyword search. Candidates are pulled with a broad LIKE, then scored in
 * JS so a name hit can be weighted far above a description hit without pushing a
 * pile of CASE expressions into SQL.
 */
export function searchProducts(query: string, category?: string, limit = 8): Product[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);

  const params: string[] = [];
  const where: string[] = ['active = 1'];

  if (category) {
    where.push('category = ? COLLATE NOCASE');
    params.push(category.trim());
  }

  if (tokens.length > 0) {
    const ors = tokens.map(
      () => `(name LIKE ? OR keywords LIKE ? OR category LIKE ? OR description LIKE ?)`,
    );
    where.push(`(${ors.join(' OR ')})`);
    for (const t of tokens) params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
  }

  const rows = db
    .prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} LIMIT 200`)
    .all(...params) as unknown as Product[];

  if (tokens.length === 0) return rows.slice(0, limit);

  const scored = rows.map((p) => {
    const name = p.name.toLowerCase();
    const keywords = p.keywords.toLowerCase();
    const cat = p.category.toLowerCase();
    const desc = p.description.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name === t) score += 100;
      else if (name.startsWith(t)) score += 40;
      else if (name.includes(t)) score += 25;
      if (keywords.includes(t)) score += 12;
      if (cat.includes(t)) score += 6;
      if (desc.includes(t)) score += 3;
    }
    // Prefer things the customer can actually buy today.
    if (p.stock <= 0) score -= 15;
    return { p, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((s) => s.p);
}

export function upsertProduct(p: {
  sku: string;
  name: string;
  description: string;
  category: string;
  unit: string;
  price: number;
  stock: number;
  active: number;
  keywords: string;
}): void {
  db.prepare(
    `INSERT INTO products (sku, name, description, category, unit, price, stock, active, keywords, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET
       name = excluded.name, description = excluded.description, category = excluded.category,
       unit = excluded.unit, price = excluded.price, stock = excluded.stock,
       active = excluded.active, keywords = excluded.keywords, updated_at = excluded.updated_at`,
  ).run(
    p.sku,
    p.name,
    p.description,
    p.category,
    p.unit,
    p.price,
    p.stock,
    p.active,
    p.keywords,
    nowIso(),
  );
}

export function productCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1`).get() as {
    n: number;
  };
  return row.n;
}

/* ---------------------------------------------------------------- customers */

export function getCustomer(phone: string): Customer {
  const row = db.prepare(`SELECT phone, name, address FROM customers WHERE phone = ?`).get(phone) as
    | Customer
    | undefined;
  return row ?? { phone, name: null, address: null };
}

export function saveCustomer(phone: string, fields: { name?: string; address?: string }): Customer {
  const existing = getCustomer(phone);
  const name = fields.name?.trim() || existing.name;
  const address = fields.address?.trim() || existing.address;
  db.prepare(
    `INSERT INTO customers (phone, name, address, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       name = excluded.name, address = excluded.address, updated_at = excluded.updated_at`,
  ).run(phone, name, address, nowIso(), nowIso());
  return { phone, name: name ?? null, address: address ?? null };
}

/* --------------------------------------------------------------------- cart */

export function calcDeliveryFee(subtotal: number): number {
  if (subtotal <= 0) return 0;
  const { deliveryFee, freeDeliveryOver } = config.store;
  if (freeDeliveryOver > 0 && subtotal >= freeDeliveryOver) return 0;
  return deliveryFee;
}

export function getCart(phone: string): CartSummary {
  const rows = db
    .prepare(
      `SELECT p.*, c.qty AS cart_qty FROM cart_items c
       JOIN products p ON p.id = c.product_id
       WHERE c.phone = ? ORDER BY c.added_at`,
    )
    .all(phone) as unknown as (Product & { cart_qty: number })[];

  const lines: CartLine[] = rows.map((r) => {
    const { cart_qty, ...product } = r;
    return { product: product as Product, qty: cart_qty, lineTotal: cart_qty * product.price };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const itemCount = lines.reduce((sum, l) => sum + l.qty, 0);
  const deliveryFee = calcDeliveryFee(subtotal);
  return { lines, itemCount, subtotal, deliveryFee, total: subtotal + deliveryFee };
}

export function setCartQty(phone: string, productId: number, qty: number): void {
  if (qty <= 0) {
    db.prepare(`DELETE FROM cart_items WHERE phone = ? AND product_id = ?`).run(phone, productId);
    return;
  }
  db.prepare(
    `INSERT INTO cart_items (phone, product_id, qty, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(phone, product_id) DO UPDATE SET qty = excluded.qty`,
  ).run(phone, productId, qty, nowIso());
}

export function getCartQty(phone: string, productId: number): number {
  const row = db
    .prepare(`SELECT qty FROM cart_items WHERE phone = ? AND product_id = ?`)
    .get(phone, productId) as { qty: number } | undefined;
  return row?.qty ?? 0;
}

export function clearCart(phone: string): void {
  db.prepare(`DELETE FROM cart_items WHERE phone = ?`).run(phone);
}

/* ------------------------------------------------------------------- orders */

export type PlacedOrder = {
  orderNo: string;
  lines: { name: string; qty: number; unit: string; lineTotal: number }[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  address: string;
  customerName: string;
  paymentMethod: string;
};

/**
 * Creates the order, decrements stock and empties the cart as one unit, so a
 * failure part-way through can never leave a confirmed order with a stale cart.
 */
export function placeOrder(args: {
  phone: string;
  customerName: string;
  address: string;
  deliveryNote: string;
  paymentMethod: string;
}): PlacedOrder {
  const cart = getCart(args.phone);
  if (cart.lines.length === 0) throw new Error('Cart is empty.');

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check stock inside the transaction; the catalog may have moved since search.
    for (const line of cart.lines) {
      const fresh = db.prepare(`SELECT stock, name FROM products WHERE id = ?`).get(line.product.id) as
        | { stock: number; name: string }
        | undefined;
      if (!fresh) throw new Error(`${line.product.name} is no longer available.`);
      if (fresh.stock < line.qty) {
        throw new Error(
          `Only ${fresh.stock} x ${fresh.name} left in stock (the cart asks for ${line.qty}).`,
        );
      }
    }

    const nextIdRow = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM orders`).get() as {
      next: number;
    };
    const orderNo = `ORD-${String(nextIdRow.next).padStart(5, '0')}`;

    const info = db
      .prepare(
        `INSERT INTO orders
           (order_no, phone, customer_name, address, delivery_note,
            subtotal, delivery_fee, total, payment_method, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        orderNo,
        args.phone,
        args.customerName,
        args.address,
        args.deliveryNote,
        cart.subtotal,
        cart.deliveryFee,
        cart.total,
        args.paymentMethod,
        nowIso(),
      );

    const orderId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, sku, name, unit, qty, unit_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const decStock = db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?`);

    for (const line of cart.lines) {
      insertItem.run(
        orderId,
        line.product.sku,
        line.product.name,
        line.product.unit,
        line.qty,
        line.product.price,
        line.lineTotal,
      );
      decStock.run(line.qty, line.product.id);
    }

    db.prepare(`DELETE FROM cart_items WHERE phone = ?`).run(args.phone);
    db.exec('COMMIT');

    return {
      orderNo,
      lines: cart.lines.map((l) => ({
        name: l.product.name,
        qty: l.qty,
        unit: l.product.unit,
        lineTotal: l.lineTotal,
      })),
      subtotal: cart.subtotal,
      deliveryFee: cart.deliveryFee,
      total: cart.total,
      address: args.address,
      customerName: args.customerName,
      paymentMethod: args.paymentMethod,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function recentOrders(phone: string, limit = 5) {
  const orders = db
    .prepare(`SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT ?`)
    .all(phone, limit) as unknown as {
    id: number;
    order_no: string;
    total: number;
    status: string;
    created_at: string;
  }[];

  return orders.map((o) => ({
    orderNo: o.order_no,
    total: o.total,
    status: o.status,
    placedAt: o.created_at,
    items: db
      .prepare(`SELECT name, qty, unit, line_total FROM order_items WHERE order_id = ?`)
      .all(o.id) as unknown as { name: string; qty: number; unit: string; line_total: number }[],
  }));
}

/* ------------------------------------------------------- conversation state */

export function loadHistory(phone: string): { history: unknown[]; updatedAt: string | null } {
  const row = db.prepare(`SELECT history, updated_at FROM conversations WHERE phone = ?`).get(phone) as
    | { history: string; updated_at: string }
    | undefined;
  if (!row) return { history: [], updatedAt: null };
  try {
    const parsed: unknown = JSON.parse(row.history);
    return { history: Array.isArray(parsed) ? parsed : [], updatedAt: row.updated_at };
  } catch {
    return { history: [], updatedAt: row.updated_at };
  }
}

export function saveHistory(phone: string, history: unknown[]): void {
  db.prepare(
    `INSERT INTO conversations (phone, history, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at`,
  ).run(phone, JSON.stringify(history), nowIso());
}

export function resetConversation(phone: string): void {
  db.prepare(`DELETE FROM conversations WHERE phone = ?`).run(phone);
}

/* ------------------------------------------------------------- housekeeping */

/** Returns true the first time an event id is seen, false on every redelivery. */
export function claimEvent(eventId: string): boolean {
  try {
    db.prepare(`INSERT INTO processed_events (event_id, received_at) VALUES (?, ?)`).run(
      eventId,
      nowIso(),
    );
    return true;
  } catch {
    return false;
  }
}

export function logMessage(
  phone: string,
  direction: 'in' | 'out',
  channel: string,
  body: string,
): void {
  db.prepare(
    `INSERT INTO message_log (phone, direction, channel, body, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(phone, direction, channel, body, nowIso());
}

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

export type Customer = {
  phone: string;
  name: string | null;
  address: string | null;
  /** The number to ring on delivery; defaults to the WhatsApp number. */
  contactPhone: string | null;
};

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
  const row = db
    .prepare(`SELECT phone, name, address, contact_phone FROM customers WHERE phone = ?`)
    .get(phone) as
    | { phone: string; name: string | null; address: string | null; contact_phone: string | null }
    | undefined;
  if (!row) return { phone, name: null, address: null, contactPhone: null };
  return { phone: row.phone, name: row.name, address: row.address, contactPhone: row.contact_phone };
}

export function saveCustomer(
  phone: string,
  fields: { name?: string; address?: string; contactPhone?: string },
): Customer {
  const existing = getCustomer(phone);
  const name = fields.name?.trim() || existing.name;
  const address = fields.address?.trim() || existing.address;
  // Falls back to the WhatsApp number, so there is always a number to ring.
  const contactPhone = fields.contactPhone?.replace(/[^0-9+]/g, '') || existing.contactPhone || phone;

  db.prepare(
    `INSERT INTO customers (phone, name, address, contact_phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       name = excluded.name, address = excluded.address,
       contact_phone = excluded.contact_phone, updated_at = excluded.updated_at`,
  ).run(phone, name, address, contactPhone, nowIso(), nowIso());
  return { phone, name: name ?? null, address: address ?? null, contactPhone };
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
  contactPhone: string;
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
           (order_no, phone, customer_name, address, contact_phone, delivery_note,
            subtotal, delivery_fee, total, payment_method, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        orderNo,
        args.phone,
        args.customerName,
        args.address,
        args.contactPhone,
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

/* ------------------------------------------------------------ order status */

/** The lifecycle a staff member can move an order through. */
export const ORDER_STATUSES = ['pending', 'confirmed', 'on_the_way', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderRecord = {
  orderNo: string;
  phone: string;
  customerName: string;
  address: string;
  contactPhone: string;
  deliveryNote: string;
  total: number;
  status: OrderStatus;
  placedAt: string;
  items: { name: string; qty: number; unit: string; lineTotal: number }[];
};

function hydrateOrder(row: {
  id: number;
  order_no: string;
  phone: string;
  customer_name: string;
  address: string;
  contact_phone: string;
  delivery_note: string;
  total: number;
  status: string;
  created_at: string;
}): OrderRecord {
  return {
    orderNo: row.order_no,
    phone: row.phone,
    customerName: row.customer_name,
    address: row.address,
    contactPhone: row.contact_phone || row.phone,
    deliveryNote: row.delivery_note,
    total: row.total,
    status: row.status as OrderStatus,
    placedAt: row.created_at,
    items: (
      db
        .prepare(`SELECT name, qty, unit, line_total FROM order_items WHERE order_id = ?`)
        .all(row.id) as unknown as { name: string; qty: number; unit: string; line_total: number }[]
    ).map((i) => ({ name: i.name, qty: i.qty, unit: i.unit, lineTotal: i.line_total })),
  };
}

/** Accepts "ORD-00007", "ord-7" or plain "7" — dispatchers will not type the padding. */
export function findOrder(reference: string): OrderRecord | null {
  const digits = reference.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const orderNo = `ORD-${String(Number(digits)).padStart(5, '0')}`;

  const row = db.prepare(`SELECT * FROM orders WHERE order_no = ?`).get(orderNo) as
    | Parameters<typeof hydrateOrder>[0]
    | undefined;
  return row ? hydrateOrder(row) : null;
}

export function setOrderStatus(orderNo: string, status: OrderStatus): void {
  db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE order_no = ?`).run(
    status,
    nowIso(),
    orderNo,
  );
}

/** Orders still needing action, oldest first — the dispatcher's work queue. */
export function openOrders(limit = 10): OrderRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM orders WHERE status IN ('pending','confirmed','on_the_way')
       ORDER BY id ASC LIMIT ?`,
    )
    .all(limit) as unknown as Parameters<typeof hydrateOrder>[0][];
  return rows.map(hydrateOrder);
}

/**
 * When this customer last messaged us. WhatsApp only permits free-form replies
 * within 24 hours of that moment; outside it a approved template is required.
 */
export function lastInboundAt(phone: string): Date | null {
  const row = db
    .prepare(
      `SELECT created_at FROM message_log WHERE phone = ? AND direction = 'in'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(phone) as { created_at: string } | undefined;
  if (!row) return null;
  const at = new Date(row.created_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function withinServiceWindow(phone: string): boolean {
  const last = lastInboundAt(phone);
  if (!last) return false;
  return Date.now() - last.getTime() < 24 * 60 * 60 * 1000;
}

/* ---------------------------------------------------------------- identity */

/**
 * How long a confirmation lasts. Matched to the conversation session: a customer
 * who confirmed an hour ago should not be asked again mid-order, but someone
 * returning next week is re-checked, because a phone can change hands.
 */
const IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;

export type CustomerIdentity = {
  phone: string;
  /** Confirmed by the customer, and safe to deliver to. */
  name: string | null;
  address: string | null;
  contactPhone: string | null;
  /** From WhatsApp. A hint to offer, never a fact to rely on. */
  profileName: string | null;
  confirmedAt: string | null;
  confirmed: boolean;
};

export function getIdentity(phone: string): CustomerIdentity {
  const row = db
    .prepare(
      `SELECT phone, name, address, contact_phone, profile_name, identity_confirmed_at
       FROM customers WHERE phone = ?`,
    )
    .get(phone) as
    | {
        phone: string;
        name: string | null;
        address: string | null;
        contact_phone: string | null;
        profile_name: string | null;
        identity_confirmed_at: string | null;
      }
    | undefined;

  if (!row) {
    return {
      phone,
      name: null,
      address: null,
      contactPhone: null,
      profileName: null,
      confirmedAt: null,
      confirmed: false,
    };
  }

  const at = row.identity_confirmed_at ? new Date(row.identity_confirmed_at) : null;
  const fresh =
    at !== null && !Number.isNaN(at.getTime()) && Date.now() - at.getTime() < IDENTITY_TTL_MS;

  return {
    phone: row.phone,
    name: row.name,
    address: row.address,
    contactPhone: row.contact_phone,
    profileName: row.profile_name,
    confirmedAt: row.identity_confirmed_at,
    confirmed: fresh,
  };
}

/** Records the WhatsApp profile name without treating it as the customer's name. */
export function setProfileName(phone: string, profileName: string): void {
  db.prepare(
    `INSERT INTO customers (phone, profile_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET profile_name = excluded.profile_name, updated_at = excluded.updated_at`,
  ).run(phone, profileName.trim(), nowIso(), nowIso());
}

export function confirmIdentity(phone: string): void {
  db.prepare(`UPDATE customers SET identity_confirmed_at = ?, updated_at = ? WHERE phone = ?`).run(
    nowIso(),
    nowIso(),
    phone,
  );
}

/* ------------------------------------------------------- transaction record */

export type CustomerRecord = {
  phone: string;
  name: string | null;
  profileName: string | null;
  address: string | null;
  contactPhone: string | null;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  orderCount: number;
  totalSpend: number;
  orders: OrderRecord[];
};

/** The full trading history for one phone number. */
export function customerRecord(phone: string, orderLimit = 20): CustomerRecord {
  const identity = getIdentity(phone);
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS spend,
              MIN(created_at) AS first, MAX(created_at) AS last
       FROM orders WHERE phone = ? AND status != 'cancelled'`,
    )
    .get(phone) as { count: number; spend: number; first: string | null; last: string | null };

  const rows = db
    .prepare(`SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT ?`)
    .all(phone, orderLimit) as unknown as Parameters<typeof hydrateOrder>[0][];

  return {
    phone,
    name: identity.name,
    profileName: identity.profileName,
    address: identity.address,
    contactPhone: identity.contactPhone,
    firstOrderAt: summary.first,
    lastOrderAt: summary.last,
    orderCount: summary.count,
    totalSpend: summary.spend,
    orders: rows.map(hydrateOrder),
  };
}

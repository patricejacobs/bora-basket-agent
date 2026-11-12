import { randomInt } from 'node:crypto';
import { db, nowIso } from './index.ts';
import { config } from '../config.ts';
import { searchCatalog, invalidateSearchIndex } from '../catalog/search.ts';
import { parseOptionSpec, applySelection, summariseStored } from '../menu-options.ts';
import { parseCoordinates, type LocationPin, type SavedPin } from '../location.ts';

export type { LocationPin, SavedPin };

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
  /** Publicly reachable HTTPS image, or empty if the product has no photo. */
  imageUrl: string;
  /** The outlet whose menu this belongs to; null for the house grocery catalogue. */
  outletId: number | null;
  /** Modifier groups in menu-options text form. Empty for groceries. */
  options: string;
  /** 0 for menu items: a kitchen cooks to order and holds no quantity. */
  trackStock: number;
  /** Set by the outlet when it has run out for the day. */
  soldOut: number;
};

/**
 * The SQLite columns are snake_case and the type is camelCase, so every read of
 * a product has to alias them. Centralised because forgetting one does not
 * fail — it silently returns undefined, which is how `image_url` once read back
 * as "no photo" on every product in the shop.
 */
export const PRODUCT_COLUMNS = `
  image_url AS imageUrl, outlet_id AS outletId,
  track_stock AS trackStock, sold_out AS soldOut`;

export type Outlet = {
  id: number;
  code: string;
  name: string;
  cuisine: string;
  hours: string;
  prepMinutes: number;
  minOrder: number;
  /** Null means the shop's own delivery fee applies. */
  deliveryFee: number | null;
  pickupAddress: string;
  pickupLat: number | null;
  pickupLng: number | null;
  whatsapp: string;
  accepting: number;
  active: number;
};

const OUTLET_COLUMNS = `
  prep_minutes AS prepMinutes, min_order AS minOrder, delivery_fee AS deliveryFee,
  pickup_address AS pickupAddress, pickup_lat AS pickupLat, pickup_lng AS pickupLng`;

export type CartLine = {
  product: Product;
  qty: number;
  lineTotal: number;
  /** Canonical option string, the part of this line's identity beyond the SKU. */
  options: string;
  /** The same choices without group names, for reading out. */
  optionsSummary: string;
  /** What the options add to each unit. */
  surcharge: number;
};

export type CartSummary = {
  lines: CartLine[];
  itemCount: number;
  subtotal: number;
  deliveryFee: number;
  total: number;
  /**
   * The outlet everything in the cart came from, or null for groceries.
   *
   * One order is one kitchen. A burger from one place and a roti from another
   * are two prep times and two collections, so a cart cannot straddle them.
   */
  outlet: Outlet | null;
};

export type Customer = {
  phone: string;
  name: string | null;
  address: string | null;
  /** The number to ring on delivery; defaults to the WhatsApp number. */
  contactPhone: string | null;
  /** Where deliveries go. Null until the customer has shared a pin. */
  location: SavedPin | null;
};

/**
 * Reads a pin off a customer or order row.
 *
 * Validated on the way out as well as in: a row written by an older build, or
 * by hand, could hold anything, and half a coordinate pair is not a place.
 */
function pinFromRow(row: {
  latitude: number | null;
  longitude: number | null;
  location_label?: string | null;
  location_pinned_at?: string | null;
}): SavedPin | null {
  const coords = parseCoordinates(row.latitude, row.longitude);
  if (!coords) return null;
  return {
    ...coords,
    label: row.location_label ?? '',
    pinnedAt: row.location_pinned_at ?? '',
  };
}

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
    .prepare(
      `SELECT *, ${PRODUCT_COLUMNS} FROM products WHERE sku = ? COLLATE NOCASE AND active = 1`,
    )
    .get(sku.trim());
  return (row as Product | undefined) ?? null;
}

/* ------------------------------------------------------------------ outlets */

export function listOutlets(): Outlet[] {
  return db
    .prepare(`SELECT *, ${OUTLET_COLUMNS} FROM outlets WHERE active = 1 ORDER BY name`)
    .all() as unknown as Outlet[];
}

export function getOutlet(code: string): Outlet | null {
  const row = db
    .prepare(`SELECT *, ${OUTLET_COLUMNS} FROM outlets WHERE code = ? COLLATE NOCASE AND active = 1`)
    .get(code.trim());
  return (row as Outlet | undefined) ?? null;
}

/**
 * The outlet changed most recently.
 *
 * Used to attach a location pin to the restaurant a staff member has just set
 * up. Ordered by when it was last written, not by name — an earlier version
 * took the last of an alphabetical list, which quietly put the collection pin
 * on whichever outlet happened to sort last.
 */
export function mostRecentlyTouchedOutlet(): Outlet | null {
  const row = db
    .prepare(`SELECT *, ${OUTLET_COLUMNS} FROM outlets WHERE active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1`)
    .get();
  return (row as Outlet | undefined) ?? null;
}

export function outletById(id: number): Outlet | null {
  const row = db.prepare(`SELECT *, ${OUTLET_COLUMNS} FROM outlets WHERE id = ?`).get(id);
  return (row as Outlet | undefined) ?? null;
}

/** The outlet whose WhatsApp number this is, for routing a kitchen's replies. */
export function outletByWhatsapp(phone: string): Outlet | null {
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const row = db
    .prepare(`SELECT *, ${OUTLET_COLUMNS} FROM outlets WHERE whatsapp = ? AND active = 1`)
    .get(digits);
  return (row as Outlet | undefined) ?? null;
}

export function upsertOutlet(o: {
  code: string;
  name: string;
  cuisine?: string;
  hours?: string;
  prepMinutes?: number;
  minOrder?: number;
  deliveryFee?: number | null;
  pickupAddress?: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  whatsapp?: string;
  accepting?: number;
  active?: number;
}): void {
  db.prepare(
    `INSERT INTO outlets
       (code, name, cuisine, hours, prep_minutes, min_order, delivery_fee,
        pickup_address, pickup_lat, pickup_lng, whatsapp, accepting, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, cuisine = excluded.cuisine, hours = excluded.hours,
       prep_minutes = excluded.prep_minutes, min_order = excluded.min_order,
       delivery_fee = excluded.delivery_fee, pickup_address = excluded.pickup_address,
       pickup_lat = excluded.pickup_lat, pickup_lng = excluded.pickup_lng,
       whatsapp = excluded.whatsapp, active = excluded.active,
       updated_at = excluded.updated_at`,
  ).run(
    o.code,
    o.name,
    o.cuisine ?? '',
    o.hours ?? '',
    o.prepMinutes ?? 20,
    o.minOrder ?? 0,
    o.deliveryFee ?? null,
    o.pickupAddress ?? '',
    o.pickupLat ?? null,
    o.pickupLng ?? null,
    (o.whatsapp ?? '').replace(/[^0-9]/g, ''),
    o.accepting ?? 1,
    o.active ?? 1,
    nowIso(),
  );
  invalidateSearchIndex();
}

/**
 * The outlet's own switch for "we are slammed" or "closing early".
 *
 * Deliberately not `active`: that is whether you trade with them at all, and a
 * kitchen must never be able to remove itself from your books.
 */
export function setOutletAccepting(code: string, accepting: boolean): void {
  db.prepare(`UPDATE outlets SET accepting = ?, updated_at = ? WHERE code = ? COLLATE NOCASE`).run(
    accepting ? 1 : 0,
    nowIso(),
    code,
  );
}

/**
 * Which menu this customer is looking at, if any.
 *
 * Stored rather than carried in the conversation because the agent cannot be
 * relied on to remember it for twenty turns, and a search that quietly widens
 * back to the whole catalogue would offer frozen wings to someone ordering from
 * a fried-chicken counter.
 */
export function getBrowsingOutlet(phone: string): Outlet | null {
  const row = db
    .prepare(`SELECT browsing_outlet_id AS id FROM customers WHERE phone = ?`)
    .get(phone) as { id: number | null } | undefined;
  if (!row?.id) return null;
  const outlet = outletById(row.id);
  // An outlet withdrawn mid-conversation stops being browsable.
  return outlet && outlet.active ? outlet : null;
}

export function setBrowsingOutlet(phone: string, outletId: number | null): void {
  // Touch-insert first: a customer may pick a restaurant before we hold any
  // other detail about them, and there would be no row to update.
  db.prepare(
    `INSERT INTO customers (phone, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO NOTHING`,
  ).run(phone, nowIso(), nowIso());
  db.prepare(`UPDATE customers SET browsing_outlet_id = ?, updated_at = ? WHERE phone = ?`).run(
    outletId,
    nowIso(),
    phone,
  );
}

/* ----------------------------------------------------------------- service */

/**
 * Which service this customer picked for the conversation they are in.
 *
 * Null means they have not chosen yet, which is what makes the opening menu
 * appear. Cleared when the conversation is reset or expires, so every new
 * conversation starts with the welcome.
 */
export function getService(phone: string): string | null {
  const row = db.prepare(`SELECT service FROM customers WHERE phone = ?`).get(phone) as
    | { service: string | null }
    | undefined;
  return row?.service ?? null;
}

export function setService(phone: string, service: string | null): void {
  // A customer may choose a service before we know anything else about them.
  db.prepare(
    `INSERT INTO customers (phone, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO NOTHING`,
  ).run(phone, nowIso(), nowIso());
  db.prepare(
    `UPDATE customers SET service = ?, service_chosen_at = ?, updated_at = ? WHERE phone = ?`,
  ).run(service, service ? nowIso() : null, nowIso(), phone);
}

export function setItemSoldOut(sku: string, soldOut: boolean): void {
  db.prepare(`UPDATE products SET sold_out = ?, updated_at = ? WHERE sku = ? COLLATE NOCASE`).run(
    soldOut ? 1 : 0,
    nowIso(),
    sku,
  );
  invalidateSearchIndex();
}

/**
 * Ranked catalogue search. The matching itself lives in catalog/search.ts.
 *
 * Kept here as a thin pass-through so callers that only want products are not
 * forced to think about which query words went unanswered.
 */
export function searchProducts(
  query: string,
  category?: string,
  limit = 8,
  scope?: number | null,
): Product[] {
  return searchCatalog(query, category, limit, scope).results;
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
  imageUrl?: string;
  /** Null (the default) files the row in the house grocery catalogue. */
  outletId?: number | null;
  options?: string;
  /** 0 for anything cooked to order; see availability.ts. */
  trackStock?: number;
}): void {
  db.prepare(
    `INSERT INTO products
       (sku, name, description, category, unit, price, stock, active, keywords, image_url,
        outlet_id, options, track_stock, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET
       name = excluded.name, description = excluded.description, category = excluded.category,
       unit = excluded.unit, price = excluded.price, stock = excluded.stock,
       active = excluded.active, keywords = excluded.keywords,
       image_url = excluded.image_url, outlet_id = excluded.outlet_id,
       options = excluded.options, track_stock = excluded.track_stock,
       updated_at = excluded.updated_at`,
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
    p.imageUrl ?? '',
    p.outletId ?? null,
    p.options ?? '',
    p.trackStock ?? 1,
    nowIso(),
  );
  invalidateSearchIndex();
}

/** How much of the catalogue has a photo — the number that tells you if it is worth using. */
export function photoCoverage(): { withPhoto: number; total: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN image_url != '' THEN 1 ELSE 0 END) AS withPhoto
       FROM products WHERE active = 1`,
    )
    .get() as { total: number; withPhoto: number | null };
  return { withPhoto: row.withPhoto ?? 0, total: row.total };
}

/** Active menu items across every outlet, as distinct from grocery stock. */
export function menuItemCount(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND outlet_id IS NOT NULL`)
    .get() as { n: number };
  return row.n;
}

export function productCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1`).get() as {
    n: number;
  };
  return row.n;
}

/* ---------------------------------------------------------------- customers */

type CustomerRow = {
  phone: string;
  name: string | null;
  address: string | null;
  contact_phone: string | null;
  latitude: number | null;
  longitude: number | null;
  location_label: string | null;
  location_pinned_at: string | null;
};

const CUSTOMER_COLUMNS =
  'phone, name, address, contact_phone, latitude, longitude, location_label, location_pinned_at';

export function getCustomer(phone: string): Customer {
  const row = db
    .prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE phone = ?`)
    .get(phone) as CustomerRow | undefined;
  if (!row) return { phone, name: null, address: null, contactPhone: null, location: null };
  return {
    phone: row.phone,
    name: row.name,
    address: row.address,
    contactPhone: row.contact_phone,
    location: pinFromRow(row),
  };
}

/**
 * Records the pin the customer just shared, replacing any earlier one.
 *
 * Written straight from the channel rather than through the agent: the
 * coordinates arrive as structured data from WhatsApp, and asking a language
 * model to copy nine significant figures into a tool call is a transcription
 * error waiting to put a delivery in the wrong street.
 */
/**
 * Remembers what language a customer writes in.
 *
 * Only ever set from something they actually wrote, never guessed, and never
 * cleared by a message that gives nothing away - "ok" is not evidence that
 * somebody has switched to English.
 */
export function setCustomerLanguage(phone: string, language: string): void {
  // Upsert, because a language is usually learned from somebody's very first
  // message - before they have given a name or an address, and so before
  // there is a row to update.
  db.prepare(
    `INSERT INTO customers (phone, name, address, language, created_at, updated_at)
     VALUES (?, '', '', ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at`,
  ).run(phone, language, nowIso(), nowIso());
}

export function customerLanguage(phone: string): string {
  const row = db.prepare(`SELECT language FROM customers WHERE phone = ?`).get(phone) as
    | { language: string }
    | undefined;
  return row?.language ?? '';
}

export function saveLocationPin(phone: string, pin: LocationPin): SavedPin {
  const pinnedAt = nowIso();
  db.prepare(
    `INSERT INTO customers (phone, latitude, longitude, location_label, location_pinned_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       latitude = excluded.latitude, longitude = excluded.longitude,
       location_label = excluded.location_label,
       location_pinned_at = excluded.location_pinned_at,
       updated_at = excluded.updated_at`,
  ).run(phone, pin.latitude, pin.longitude, pin.label, pinnedAt, pinnedAt, pinnedAt);
  return { ...pin, pinnedAt };
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
  // The pin is untouched by this write — it is saved from the channel, not here.
  return { phone, name: name ?? null, address: address ?? null, contactPhone, location: existing.location };
}

/* --------------------------------------------------------------------- cart */

/**
 * An outlet may charge its own delivery fee; without one the shop's applies.
 *
 * Free delivery over a threshold is deliberately not extended to restaurant
 * orders: the delivery associate still has to go and collect, and giving that away on a
 * large food order means paying to deliver it.
 */
export function calcDeliveryFee(subtotal: number, outlet?: Outlet | null): number {
  if (subtotal <= 0) return 0;
  const { deliveryFee, freeDeliveryOver } = config.store;

  if (outlet) return outlet.deliveryFee ?? deliveryFee;
  if (freeDeliveryOver > 0 && subtotal >= freeDeliveryOver) return 0;
  return deliveryFee;
}

export function getCart(phone: string): CartSummary {
  const rows = db
    .prepare(
      `SELECT p.*, p.image_url AS imageUrl, p.outlet_id AS outletId,
              p.track_stock AS trackStock, p.sold_out AS soldOut,
              c.qty AS cart_qty, c.options AS cart_options
         FROM cart_items c
         JOIN products p ON p.id = c.product_id
        WHERE c.phone = ? ORDER BY c.added_at`,
    )
    .all(phone) as unknown as (Product & { cart_qty: number; cart_options: string })[];

  const lines: CartLine[] = rows.map((r) => {
    const { cart_qty, cart_options, ...product } = r;
    // Recomputed from the spec rather than stored on the line: if the menu's
    // prices change, a cart that is still open should reprice, not hold a
    // figure the kitchen no longer charges.
    const groups = parseOptionSpec(product.options ?? '');
    const picked = cart_options ? cart_options.split(';').flatMap((part) => {
      const labels = part.slice(part.indexOf('=') + 1);
      const group = part.slice(0, part.indexOf('=')).trim();
      return labels.split(',').map((l) => `${group}: ${l.trim()}`);
    }) : [];
    const applied = applySelection(groups, picked);
    const surcharge = applied.ok ? applied.surcharge : 0;
    const unit = product.price + surcharge;

    return {
      product: product as Product,
      qty: cart_qty,
      lineTotal: cart_qty * unit,
      options: cart_options,
      optionsSummary: summariseStored(cart_options),
      surcharge,
    };
  });

  // Every line in a cart belongs to the same outlet, enforced on the way in.
  const outletId = lines.find((l) => l.product.outletId !== null)?.product.outletId ?? null;
  const outlet = outletId === null ? null : outletById(outletId);

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const itemCount = lines.reduce((sum, l) => sum + l.qty, 0);
  const deliveryFee = calcDeliveryFee(subtotal, outlet);
  return { lines, itemCount, subtotal, deliveryFee, total: subtotal + deliveryFee, outlet };
}

/**
 * Which outlet the open cart belongs to, without loading the whole thing.
 *
 * Used to refuse a second kitchen before any work is done, and to tell the
 * agent what clearing the cart would cost the customer.
 */
export function cartOutletId(phone: string): number | null {
  const row = db
    .prepare(
      `SELECT p.outlet_id AS outletId FROM cart_items c
         JOIN products p ON p.id = c.product_id
        WHERE c.phone = ? AND p.outlet_id IS NOT NULL LIMIT 1`,
    )
    .get(phone) as { outletId: number } | undefined;
  return row?.outletId ?? null;
}

/** True when the cart holds house groceries, which cannot mix with a menu. */
export function cartHasGroceries(phone: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found FROM cart_items c
         JOIN products p ON p.id = c.product_id
        WHERE c.phone = ? AND p.outlet_id IS NULL LIMIT 1`,
    )
    .get(phone) as { found: number } | undefined;
  return row !== undefined;
}

export function setCartQty(phone: string, productId: number, qty: number, options = ''): void {
  if (qty <= 0) {
    db.prepare(`DELETE FROM cart_items WHERE phone = ? AND product_id = ? AND options = ?`).run(
      phone,
      productId,
      options,
    );
    return;
  }
  db.prepare(
    `INSERT INTO cart_items (phone, product_id, options, qty, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(phone, product_id, options) DO UPDATE SET qty = excluded.qty`,
  ).run(phone, productId, options, qty, nowIso());
}

export function getCartQty(phone: string, productId: number, options = ''): number {
  const row = db
    .prepare(`SELECT qty FROM cart_items WHERE phone = ? AND product_id = ? AND options = ?`)
    .get(phone, productId, options) as { qty: number } | undefined;
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
  /** The pin this order goes to, as it stood when the order was placed. */
  location: SavedPin | null;
};

/**
 * Creates the order, decrements stock and empties the cart as one unit, so a
 * failure part-way through can never leave a confirmed order with a stale cart.
 */
/**
 * A four-digit code for one order.
 *
 * `randomInt` rather than `Math.random`, and not derived from the order number
 * in any way: order numbers are sequential and read out loud, so anything
 * computed from one is a code the next customer can work out. This is the one
 * number in the system that has to be unguessable.
 *
 * 1000-9999, so it is always four digits. A code with a leading zero gets
 * written down as three and read back as wrong.
 */
function newDeliveryCode(): string {
  return String(randomInt(1000, 10000));
}

export function placeOrder(args: {
  phone: string;
  customerName: string;
  address: string;
  contactPhone: string;
  deliveryNote: string;
  paymentMethod: string;
  /**
   * Where to deliver, or null when the customer could not send a pin and gave
   * a written address instead.
   *
   * Null is allowed reluctantly. A pin is the only unambiguous way to describe
   * a door, and checkout asks for one twice before giving up - but refusing
   * the order outright, which is what this used to do, loses it entirely.
   * There is nobody on the administrative end to take it by hand, so the real
   * choice is a flagged order with a phone call attached, or no order.
   */
  location: SavedPin | null;
}): PlacedOrder {
  const cart = getCart(args.phone);
  if (cart.lines.length === 0) throw new Error('Cart is empty.');

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check availability inside the transaction; the catalogue may have moved
    // since the search, and a kitchen may have sold out mid-conversation.
    for (const line of cart.lines) {
      const fresh = db
        .prepare(
          `SELECT name, stock, track_stock AS trackStock, sold_out AS soldOut
             FROM products WHERE id = ? AND active = 1`,
        )
        .get(line.product.id) as
        | { name: string; stock: number; trackStock: number; soldOut: number }
        | undefined;
      if (!fresh) throw new Error(`${line.product.name} is no longer available.`);
      if (fresh.soldOut) throw new Error(`${fresh.name} has sold out.`);
      if (fresh.trackStock && fresh.stock < line.qty) {
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
            latitude, longitude, location_label,
            outlet_id, outlet_name, pickup_address, pickup_lat, pickup_lng, prep_minutes,
            kind, delivery_code,
            subtotal, delivery_fee, total, payment_method, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        orderNo,
        args.phone,
        args.customerName,
        args.address,
        args.contactPhone,
        args.deliveryNote,
        args.location?.latitude ?? null,
        args.location?.longitude ?? null,
        args.location?.label ?? '',
        // Where the food is cooked, copied onto the row rather than read back
        // off the outlet later. An outlet that moves premises next month must
        // not relocate a collection that already happened.
        cart.outlet?.id ?? null,
        cart.outlet?.name ?? '',
        cart.outlet?.pickupAddress ?? '',
        cart.outlet?.pickupLat ?? null,
        cart.outlet?.pickupLng ?? null,
        cart.outlet?.prepMinutes ?? 0,
        // What this order IS, written down rather than left to the column
        // default. Without it every restaurant order was filed as a grocery
        // one: the outlet name was right, so nothing broke, but counting
        // orders by service answered the wrong question and the archive
        // carried the wrong label for good.
        cart.outlet ? 'restaurant' : 'grocery',
        // Written at placing time, not at dispatch. One code per order for its
        // whole life, so a retried or re-sent message carries the same digits
        // as the first one - a customer holding two different codes has no
        // code at all.
        newDeliveryCode(),
        cart.subtotal,
        cart.deliveryFee,
        cart.total,
        args.paymentMethod,
        nowIso(),
      );

    const orderId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, sku, name, unit, options, qty, unit_price, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const decStock = db.prepare(
      `UPDATE products SET stock = stock - ? WHERE id = ? AND track_stock = 1`,
    );

    for (const line of cart.lines) {
      insertItem.run(
        orderId,
        line.product.sku,
        line.product.name,
        line.product.unit,
        line.options,
        line.qty,
        // The unit price carries the options surcharge, so the line total on the
        // order matches what the customer was quoted and what the delivery associate collects.
        line.product.price + line.surcharge,
        line.lineTotal,
      );
      // Guarded in SQL as well as here: a menu item has no quantity to decrement
      // and driving its stock negative would make it look out of stock forever.
      if (line.product.trackStock) decStock.run(line.qty, line.product.id);
    }

    db.prepare(`DELETE FROM cart_items WHERE phone = ?`).run(args.phone);
    db.exec('COMMIT');
    // Stock moved, and stock affects ranking — the next search should see it.
    invalidateSearchIndex();

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
      location: args.location,
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
    updated_at: string;
  }[];

  return orders.map((o) => ({
    orderNo: o.order_no,
    total: o.total,
    status: o.status,
    placedAt: o.created_at,
    // Empty on orders placed before the column existed, and on any order whose
    // status has never been touched. Callers fall back to placedAt.
    statusChangedAt: o.updated_at || o.created_at,
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

/**
 * Whether WhatsApp will still carry a plain message to this number.
 *
 * Meta only allows free-form messages within 24 hours of that number's last
 * message TO the shop; outside it, nothing but an approved template gets
 * through. A customer is almost never a problem — they just messaged to order,
 * so the window is open by definition. A kitchen is the opposite: it has no
 * reason to message the shop each morning, so the first ticket of the day
 * routinely lands on a shut window.
 *
 * Read from the inbound log, which is written for every sender before routing,
 * so it covers kitchens and associates as well as customers. A tapped button
 * counts as an inbound message, which is what makes the template worth sending.
 *
 * An hour of margin is taken off, because the window is measured by Meta from
 * its own receipt time, and a send that loses a race with the deadline fails
 * for a reason nobody can see afterwards.
 */
export function serviceWindowOpen(phone: string, marginMinutes = 60): boolean {
  const row = db
    .prepare(
      `SELECT created_at FROM message_log
        WHERE phone = ? AND direction = 'in'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(phone) as { created_at: string } | undefined;
  if (!row) return false;

  const age = Date.now() - new Date(row.created_at).getTime();
  if (!Number.isFinite(age)) return false;
  return age < (24 * 60 - marginMinutes) * 60_000;
}

/** Records that the kitchen was handed the real ticket, not just a nudge. */
export function markOutletNotified(orderNo: string): void {
  db.prepare(`UPDATE orders SET outlet_notified_at = ? WHERE order_no = ?`).run(nowIso(), orderNo);
}

/**
 * Orders this kitchen was never actually given.
 *
 * Only live ones: an order already cancelled, delivered, or long since cooked
 * is not something to hand over now. Oldest first, so a kitchen that reopens
 * the window gets them in the order they were placed.
 */
export function ordersAwaitingTicket(outletId: number): OrderRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM orders
        WHERE outlet_id = ? AND outlet_notified_at = '' AND status = 'pending'
        ORDER BY id ASC`,
    )
    .all(outletId) as unknown as Parameters<typeof hydrateOrder>[0][];
  return rows.map(hydrateOrder);
}

/* ------------------------------------------------------------ unmet demand */

/**
 * Reduces a search phrase to a grouping key.
 *
 * People type "Channa", "channa?", "CHANNA 1kg". Those are one request, and a
 * report that lists them as three tells you nothing. Quantities and units go
 * because "2 lbs channa" and "channa" are the same want.
 */
const UNITS = /\b(\d+(\.\d+)?)?\s*(kg|kgs|g|gram[s]?|lb[s]?|pound[s]?|ml|l|litre[s]?|liter[s]?|pack[s]?|tin[s]?|bottle[s]?|box(es)?|dozen|each)\b/g;

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(UNITS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Records a search that found nothing.
 *
 * Silently ignores anything too short or too long to be a real product request,
 * so the report stays readable — a stray "?" or a pasted paragraph is noise, not
 * demand.
 */
export function logSearchMiss(phone: string, query: string): void {
  const normalized = normalizeQuery(query);
  if (normalized.length < 2 || normalized.length > 60) return;

  db.prepare(
    `INSERT INTO search_misses (phone, query, normalized, created_at) VALUES (?, ?, ?, ?)`,
  ).run(phone, query.slice(0, 200), normalized, nowIso());
}

export type SearchMiss = {
  normalized: string;
  /** The most recent raw phrasing, for reading back in the shop's own words. */
  example: string;
  /** How many times it was asked for. */
  times: number;
  /** How many different people asked. The number that decides whether to stock it. */
  people: number;
  lastAskedAt: string;
};

/**
 * What customers asked for and did not find, most-wanted first.
 *
 * Ordered by distinct people rather than raw count on purpose. Twelve people
 * asking for one thing is a gap in the catalogue; one person asking twelve times
 * is a gap in the search. Ranking by people separates the two at a glance.
 */
export function topSearchMisses(days = 30, limit = 20): SearchMiss[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT normalized,
              COUNT(*)              AS times,
              COUNT(DISTINCT phone) AS people,
              MAX(created_at)       AS last_asked_at,
              (SELECT query FROM search_misses inner_m
                WHERE inner_m.normalized = m.normalized
                ORDER BY inner_m.id DESC LIMIT 1) AS example
         FROM search_misses m
        WHERE created_at >= ?
        GROUP BY normalized
        ORDER BY people DESC, times DESC, last_asked_at DESC
        LIMIT ?`,
    )
    .all(since, limit) as unknown as {
    normalized: string;
    times: number;
    people: number;
    last_asked_at: string;
    example: string;
  }[];

  return rows.map((r) => ({
    normalized: r.normalized,
    example: r.example ?? r.normalized,
    times: r.times,
    people: r.people,
    lastAskedAt: r.last_asked_at,
  }));
}

export function searchMissCount(days = 30): number {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM search_misses WHERE created_at >= ?`)
    .get(since) as { n: number } | undefined;
  return row?.n ?? 0;
}

/* ------------------------------------------------------------ order status */

/** The lifecycle a staff member can move an order through. */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  // Food is cooked and waiting on the counter. Only restaurant orders reach it,
  // and it is the moment a delivery associate is sent — any earlier and the delivery associate stands in
  // the shop watching a fryer.
  'ready',
  'on_the_way',
  'delivered',
  'cancelled',
] as const;
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
  /**
   * Where this order goes. Null only on orders placed before pins existed —
   * every new order has one, because checkout will not complete without it.
   */
  location: SavedPin | null;
  /**
   * The kitchen this was cooked in, or null for a grocery order picked from the
   * shop's own shelves. Present on the order rather than looked up, so a change
   * of premises cannot move a collection that already happened.
   */
  outlet: {
    id: number;
    name: string;
    pickupAddress: string;
    pickupLat: number | null;
    pickupLng: number | null;
    prepMinutes: number;
  } | null;
  /**
   * Where the delivery associate collects, whoever it belongs to — a restaurant for food, a
   * sender's door for a parcel. Read from the order's own columns rather than
   * through the outlet, so a parcel (which has no outlet) still has a pickup.
   */
  pickup: { address: string; latitude: number | null; longitude: number | null } | null;
  /**
   * When the kitchen handed the food over, or empty. Separate from the status
   * on purpose: a kitchen knows when food left its counter, but only the
   * associate knows they are carrying it.
   */
  handedOverAt: string;
  /** When the food was marked ready, and when an associate took it. */
  readyAt: string;
  upliftedAt: string;
  /** Who carried it, as they were when they took it. Empty until uplifted. */
  driverName: string;
  driverVehicle: string;
  /** The delivery associate this was dispatched to, empty until the food is ready. */
  driverPhone: string;
  /** 'grocery' | 'restaurant' | 'parcel'. A parcel carries no items. */
  kind: string;
  /**
   * Who receives a parcel, which is not the customer who sent it. Empty on a
   * shopping order, where the customer is also the recipient.
   */
  recipientName: string;
  recipientPhone: string;
  /** What is being sent, in the sender's words. */
  parcelDetails: string;
  /** Why it was cancelled, empty unless it was. */
  cancelReason: string;
  /** Who cancelled it: 'outlet', 'staff', 'customer', or empty. */
  cancelledBy: string;
  items: { name: string; qty: number; unit: string; options: string; lineTotal: number }[];
};

function hydrateOrder(row: {
  id: number;
  order_no: string;
  phone: string;
  customer_name: string;
  address: string;
  contact_phone: string;
  delivery_note: string;
  latitude: number | null;
  longitude: number | null;
  location_label: string | null;
  outlet_id: number | null;
  outlet_name: string | null;
  pickup_address: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  prep_minutes: number | null;
  driver_phone: string | null;
  handed_over_at: string | null;
  driver_name: string | null;
  driver_vehicle: string | null;
  ready_at: string | null;
  uplifted_at: string | null;
  kind: string | null;
  /** Written on every status change; empty on rows that predate the column. */
  updated_at: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  parcel_details: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  total: number;
  status: string;
  created_at: string;
}): OrderRecord {
  const pin = pinFromRow(row);
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
    // An order's pin was fixed at checkout; `pinnedAt` on an order means the
    // moment it was placed, not when the customer first shared the location.
    location: pin ? { ...pin, pinnedAt: row.created_at } : null,
    outlet:
      row.outlet_id === null || row.outlet_id === undefined
        ? null
        : {
            id: row.outlet_id,
            name: row.outlet_name ?? '',
            pickupAddress: row.pickup_address ?? '',
            pickupLat: row.pickup_lat ?? null,
            pickupLng: row.pickup_lng ?? null,
            prepMinutes: row.prep_minutes ?? 0,
          },
    pickup:
      row.pickup_lat !== null && row.pickup_lng !== null
        ? {
            address: row.pickup_address ?? '',
            latitude: row.pickup_lat,
            longitude: row.pickup_lng,
          }
        : row.pickup_address
          ? { address: row.pickup_address, latitude: null, longitude: null }
          : null,
    handedOverAt: row.handed_over_at ?? '',
    readyAt: row.ready_at ?? '',
    upliftedAt: row.uplifted_at ?? '',
    driverPhone: row.driver_phone ?? '',
    driverName: row.driver_name ?? '',
    driverVehicle: row.driver_vehicle ?? '',
    kind: row.kind ?? 'grocery',
    recipientName: row.recipient_name ?? '',
    recipientPhone: row.recipient_phone ?? '',
    parcelDetails: row.parcel_details ?? '',
    cancelReason: row.cancel_reason ?? '',
    cancelledBy: row.cancelled_by ?? '',
    items: (
      db
        .prepare(
          `SELECT name, qty, unit, options, line_total FROM order_items WHERE order_id = ?`,
        )
        .all(row.id) as unknown as {
        name: string; qty: number; unit: string; options: string; line_total: number;
      }[]
    ).map((i) => ({
      name: i.name, qty: i.qty, unit: i.unit, options: i.options ?? '', lineTotal: i.line_total,
    })),
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

/**
 * One order, but only if it belongs to this phone.
 *
 * Order numbers are sequential and are read out to customers, so guessing a
 * neighbour's is trivial. Everything a customer-facing tool looks up must be
 * scoped to the number they are messaging from — this is that scope, kept in one
 * place so no caller can forget it.
 */
export function customerOrder(phone: string, reference: string): OrderRecord | null {
  const order = findOrder(reference);
  return order && order.phone === phone ? order : null;
}

/* ------------------------------------------------- proof of delivery code */

/** How many wrong guesses before a code is spent. */
const CODE_ATTEMPT_LIMIT = 3;

export type DeliveryCodeState = {
  /** Whether this order has a code at all. Old rows do not. */
  exists: boolean;
  /** Whether the digits actually reached the customer. */
  sent: boolean;
  /** When it was read back correctly, or empty. */
  verifiedAt: string;
  /** Wrong guesses so far. */
  attempts: number;
  /** Spent: too many wrong guesses, so it can no longer be verified. */
  burnt: boolean;
};

function codeRow(orderNo: string): {
  code: string;
  sentAt: string;
  verifiedAt: string;
  attempts: number;
} | null {
  const row = db
    .prepare(
      `SELECT delivery_code AS code, code_sent_at AS sentAt,
              code_verified_at AS verifiedAt, code_attempts AS attempts
         FROM orders WHERE order_no = ?`,
    )
    .get(orderNo) as
    | { code: string; sentAt: string; verifiedAt: string; attempts: number }
    | undefined;
  return row ?? null;
}

/**
 * What the associate's side needs to know, and nothing more.
 *
 * Deliberately returns no digits. The code is not on `OrderRecord` either, and
 * that is the whole safeguard: every operator message - the job card, `jobs`,
 * the dispatch alert, the CSV - is built from an `OrderRecord`, so there is no
 * code on the object for a future edit to print by accident. A code the person
 * at the door can read off their own screen proves nothing.
 */
export function deliveryCodeState(orderNo: string): DeliveryCodeState {
  const row = codeRow(orderNo);
  if (!row || !row.code) {
    return { exists: false, sent: false, verifiedAt: '', attempts: 0, burnt: false };
  }
  return {
    exists: true,
    sent: Boolean(row.sentAt),
    verifiedAt: row.verifiedAt || '',
    attempts: row.attempts,
    burnt: row.attempts >= CODE_ATTEMPT_LIMIT,
  };
}

/**
 * The digits themselves, for the customer's own message and nowhere else.
 *
 * One caller: the on-its-way notification. If a second one ever appears it
 * wants reading very carefully.
 */
export function deliveryCodeFor(orderNo: string): string {
  return codeRow(orderNo)?.code ?? '';
}

/**
 * Records that the code reached the customer.
 *
 * Called only after the message has actually gone, and only when it went as
 * free text. The template route cannot carry the digits, so an order dispatched
 * outside the 24-hour window has a code that nobody has seen - and the
 * associate must not then be asked for it, or every such order reads as a
 * failed verification by somebody who did nothing wrong.
 */
export function markCodeSent(orderNo: string): void {
  db.prepare(`UPDATE orders SET code_sent_at = ? WHERE order_no = ? AND code_sent_at = ''`).run(
    nowIso(),
    orderNo,
  );
}

export type CodeCheck = 'verified' | 'already' | 'wrong' | 'spent' | 'none';

/**
 * Checks what the associate typed against what the customer holds.
 *
 * Write-once, like the other delivery stamps: a code verified at 18:42 was
 * verified at 18:42, and re-reading it later must not move that. A wrong guess
 * is counted whether or not it was honest, because the count is the only thing
 * standing between nine thousand possibilities and a free verification.
 */
export function verifyDeliveryCode(orderNo: string, typed: string): CodeCheck {
  const row = codeRow(orderNo);
  if (!row || !row.code) return 'none';
  if (row.verifiedAt) return 'already';
  if (row.attempts >= CODE_ATTEMPT_LIMIT) return 'spent';

  const digits = typed.replace(/[^0-9]/g, '');
  if (digits === row.code) {
    db.prepare(
      `UPDATE orders SET code_verified_at = ? WHERE order_no = ? AND code_verified_at = ''`,
    ).run(nowIso(), orderNo);
    return 'verified';
  }

  db.prepare(`UPDATE orders SET code_attempts = code_attempts + 1 WHERE order_no = ?`).run(orderNo);
  // 'spent' when that was the last one, so the caller can say so in the same
  // breath rather than inviting a fourth guess it would then refuse.
  return (codeRow(orderNo)?.attempts ?? 0) >= CODE_ATTEMPT_LIMIT ? 'spent' : 'wrong';
}

/**
 * Whether this order's code was read back at the door.
 *
 * The other half of `deliveryCodeUnconfirmed`, and not its negation: an order
 * that never had a code is neither confirmed nor unconfirmed, and must be told
 * neither thing.
 */
export function deliveryCodeConfirmed(orderNo: string): boolean {
  if (!config.deliveryCode) return false;
  const st = deliveryCodeState(orderNo);
  return st.exists && Boolean(st.verifiedAt);
}

/**
 * Whether a code reached this customer and was never read back.
 *
 * Not the same question as `deliveryCodeExpected`, and the difference is the
 * whole point. By the time such an order is delivered its code has been spent,
 * so "expected" is already false - what remains true, permanently, is that
 * digits were issued and never confirmed. That is what the customer is told
 * and what the export records.
 *
 * False when no code was ever issued: an old order, or one dispatched outside
 * WhatsApp's 24-hour window where the fixed template could not carry digits.
 * Those customers had nothing to confirm, and telling them a code went
 * unconfirmed would be nonsense.
 */
export function deliveryCodeUnconfirmed(orderNo: string): boolean {
  if (!config.deliveryCode) return false;
  const st = deliveryCodeState(orderNo);
  return st.exists && st.sent && !st.verifiedAt;
}

/**
 * Whether this order is waiting on a code right now.
 *
 * The one predicate, in one place. Three callers need it - the card that tells
 * an associate what to do, the gate that will not close an order without it,
 * and the parser that reads four bare digits as an answer - and three copies of
 * it would eventually disagree about which orders are exempt.
 */
export function deliveryCodeExpected(orderNo: string): boolean {
  if (!config.deliveryCode) return false;
  const st = deliveryCodeState(orderNo);
  return st.exists && st.sent && !st.verifiedAt && !st.burnt;
}

/**
 * Gives up on a code: the associate is at the door and the customer has none.
 *
 * Spends it rather than deleting it. The order can then be delivered, and the
 * record keeps the shape that matters - a code was issued, it reached the
 * customer, and it was never read back - which is exactly what an unverified
 * delivery is. Deleting the code would make the order look like one that never
 * had one, and those are nobody's fault.
 */
export function giveUpOnCode(orderNo: string): void {
  db.prepare(`UPDATE orders SET code_attempts = ? WHERE order_no = ? AND code_verified_at = ''`).run(
    CODE_ATTEMPT_LIMIT,
    orderNo,
  );
}

/** How many guesses are left, for the message that tells them. */
export function codeAttemptsLeft(orderNo: string): number {
  const row = codeRow(orderNo);
  return Math.max(0, CODE_ATTEMPT_LIMIT - (row?.attempts ?? 0));
}

/**
 * Every order ever placed, oldest first, with the money broken out.
 *
 * For the backup, and nothing else. `OrderRecord` deliberately omits the
 * subtotal, the delivery fee and the payment method because no message ever
 * needs them — but a record you are keeping in case the disk dies has to hold
 * the whole transaction, not the parts that happened to be worth saying out
 * loud. Oldest first so an export read top to bottom is the order of trading.
 */
export type ArchivedOrder = OrderRecord & {
  subtotal: number;
  deliveryFee: number;
  paymentMethod: string;
  /** When the status last moved. Falls back to the placing time on old rows. */
  statusChangedAt: string;
  /**
   * Proof of delivery, as two facts rather than one flag.
   *
   * Whether the code reached the customer, and whether it was read back. The
   * digits themselves are deliberately absent: the export is the file that
   * gets emailed around, and codes for orders still in flight have no business
   * travelling with it.
   */
  codeSentAt: string;
  codeVerifiedAt: string;
};

export function allOrders(): ArchivedOrder[] {
  const rows = db.prepare(`SELECT * FROM orders ORDER BY id ASC`).all() as unknown as (
    Parameters<typeof hydrateOrder>[0] & {
      subtotal: number;
      delivery_fee: number;
      payment_method: string;
      code_sent_at: string | null;
      code_verified_at: string | null;
    }
  )[];

  return rows.map((row) => ({
    ...hydrateOrder(row),
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    paymentMethod: row.payment_method ?? '',
    statusChangedAt: row.updated_at || row.created_at,
    codeSentAt: row.code_sent_at ?? '',
    codeVerifiedAt: row.code_verified_at ?? '',
  }));
}

/**
 * A parcel job.
 *
 * Written straight to the orders table rather than a table of its own, so it
 * inherits the whole machinery an order already has: a number, a status
 * lifecycle, staff commands, delivery associate dispatch and customer notifications. The
 * fields line up: pickup_* is where the delivery associate collects — a restaurant for food,
 * the sender's door for a parcel — and the delivery pin is where it goes.
 *
 * It carries no products, so anything reading order_items must cope with an
 * order that has none.
 */
export function createParcelJob(args: {
  phone: string;
  senderName: string;
  pickup: { latitude: number; longitude: number; label?: string };
  pickupAddress: string;
  destination: { latitude: number; longitude: number; label?: string };
  destinationAddress: string;
  recipientName: string;
  recipientPhone: string;
  contents: string;
  fee: number;
  contactPhone: string;
}): { orderNo: string } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM orders`).get() as {
      next: number;
    };
    const orderNo = `ORD-${String(next.next).padStart(5, '0')}`;

    db.prepare(
      `INSERT INTO orders
         (order_no, kind, phone, customer_name, address, contact_phone, delivery_note,
          latitude, longitude, location_label,
          pickup_address, pickup_lat, pickup_lng,
          recipient_name, recipient_phone, parcel_details, delivery_code,
          subtotal, delivery_fee, total, payment_method, status, created_at)
       VALUES (?, 'parcel', ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'cash_on_delivery', 'pending', ?)`,
    ).run(
      orderNo,
      args.phone,
      args.senderName,
      args.destinationAddress,
      args.contactPhone,
      args.destination.latitude,
      args.destination.longitude,
      args.destination.label ?? '',
      args.pickupAddress,
      args.pickup.latitude,
      args.pickup.longitude,
      args.recipientName,
      args.recipientPhone,
      args.contents,
      // A parcel is the strongest case for a code: the person at the door is
      // not the person who placed the order. The sender gets the digits and
      // passes them to whoever is receiving - which is the only way the shop
      // can show the parcel reached the right hands rather than a doorstep.
      newDeliveryCode(),
      args.fee,
      args.fee,
      nowIso(),
    );
    db.exec('COMMIT');
    return { orderNo };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ----------------------------------------------------------- parked carts */

/**
 * A cart set aside, identified by what it was for.
 *
 * 0 is the grocery cart; any other value is that outlet's id. Not null, because
 * it is part of a primary key and SQLite does not treat nulls as equal.
 */
const GROCERY_KEY = 0;
const cartKey = (outletId: number | null): number => outletId ?? GROCERY_KEY;

export type ParkedCart = {
  /** Null for the grocery cart. */
  outletId: number | null;
  /** The outlet's name, or 'Groceries'. */
  label: string;
  itemCount: number;
  lines: { name: string; qty: number; options: string }[];
  parkedAt: string;
};

/**
 * Moves the live cart aside so another one can be built.
 *
 * Returns what was parked, or null when there was nothing in it. Replaces any
 * cart already parked under the same key: a customer who parks groceries twice
 * means the second lot, not both.
 */
export function parkCart(phone: string): ParkedCart | null {
  const cart = getCart(phone);
  if (cart.lines.length === 0) return null;

  const key = cartKey(cart.outlet?.id ?? null);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM parked_cart_items WHERE phone = ? AND outlet_key = ?`).run(phone, key);
    const insert = db.prepare(
      `INSERT INTO parked_cart_items (phone, outlet_key, product_id, options, qty, parked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const line of cart.lines) {
      insert.run(phone, key, line.product.id, line.options, line.qty, nowIso());
    }
    db.prepare(`DELETE FROM cart_items WHERE phone = ?`).run(phone);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    outletId: cart.outlet?.id ?? null,
    label: cart.outlet?.name ?? 'Groceries',
    itemCount: cart.itemCount,
    lines: cart.lines.map((l) => ({
      name: l.product.name,
      qty: l.qty,
      options: l.optionsSummary,
    })),
    parkedAt: nowIso(),
  };
}

export function listParkedCarts(phone: string): ParkedCart[] {
  const rows = db
    .prepare(
      `SELECT p.outlet_key AS outletKey, p.options, p.qty, p.parked_at AS parkedAt,
              pr.name AS name
         FROM parked_cart_items p
         JOIN products pr ON pr.id = p.product_id
        WHERE p.phone = ? ORDER BY p.outlet_key, p.parked_at`,
    )
    .all(phone) as unknown as {
    outletKey: number;
    options: string;
    qty: number;
    parkedAt: string;
    name: string;
  }[];

  const byKey = new Map<number, ParkedCart>();
  for (const row of rows) {
    const outletId = row.outletKey === GROCERY_KEY ? null : row.outletKey;
    let cart = byKey.get(row.outletKey);
    if (!cart) {
      cart = {
        outletId,
        label: outletId === null ? 'Groceries' : (outletById(outletId)?.name ?? 'a restaurant'),
        itemCount: 0,
        lines: [],
        parkedAt: row.parkedAt,
      };
      byKey.set(row.outletKey, cart);
    }
    cart.itemCount += row.qty;
    cart.lines.push({ name: row.name, qty: row.qty, options: summariseStored(row.options) });
  }
  return [...byKey.values()];
}

/**
 * Brings a parked cart back into the live cart.
 *
 * Refuses rather than merging when something is already in the cart — two carts
 * silently becoming one is how an order goes out with somebody's lunch in it.
 */
export function restoreCart(phone: string, outletId: number | null): number {
  if (getCart(phone).lines.length > 0) {
    throw new Error('The cart is not empty. Park or clear it before restoring another.');
  }

  const key = cartKey(outletId);
  const rows = db
    .prepare(`SELECT product_id AS productId, options, qty FROM parked_cart_items WHERE phone = ? AND outlet_key = ?`)
    .all(phone, key) as unknown as { productId: number; options: string; qty: number }[];
  if (rows.length === 0) return 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(
      `INSERT INTO cart_items (phone, product_id, options, qty, added_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(phone, product_id, options) DO UPDATE SET qty = excluded.qty`,
    );
    let restored = 0;
    for (const row of rows) {
      // A dish withdrawn or sold out while parked is dropped rather than
      // restored, so a customer is never handed back something unbuyable.
      const product = db
        .prepare(`SELECT id FROM products WHERE id = ? AND active = 1 AND sold_out = 0`)
        .get(row.productId) as { id: number } | undefined;
      if (!product) continue;
      insert.run(phone, row.productId, row.options, row.qty, nowIso());
      restored += row.qty;
    }
    db.prepare(`DELETE FROM parked_cart_items WHERE phone = ? AND outlet_key = ?`).run(phone, key);
    db.exec('COMMIT');
    return restored;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function discardParkedCart(phone: string, outletId: number | null): void {
  db.prepare(`DELETE FROM parked_cart_items WHERE phone = ? AND outlet_key = ?`).run(
    phone,
    cartKey(outletId),
  );
}

/* ------------------------------------------------------------ menu drafts */

export type MenuDraftRow = { code: string; payload: string; pages: number };

export function getMenuDraft(phone: string): MenuDraftRow | null {
  const row = db
    .prepare(`SELECT code, payload, pages FROM menu_drafts WHERE phone = ?`)
    .get(phone) as MenuDraftRow | undefined;
  return row ?? null;
}

export function saveMenuDraft(phone: string, code: string, payload: string, pages: number): void {
  db.prepare(
    `INSERT INTO menu_drafts (phone, code, payload, pages, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       code = excluded.code, payload = excluded.payload,
       pages = excluded.pages, updated_at = excluded.updated_at`,
  ).run(phone, code, payload, pages, nowIso());
}

export function clearMenuDraft(phone: string): void {
  db.prepare(`DELETE FROM menu_drafts WHERE phone = ?`).run(phone);
}

/** Every menu item an outlet currently has, for replacing a published menu. */
export function outletMenu(outletId: number): Product[] {
  return db
    .prepare(`SELECT *, ${PRODUCT_COLUMNS} FROM products WHERE outlet_id = ?`)
    .all(outletId) as unknown as Product[];
}

export function deactivateOutletMenu(outletId: number): number {
  const info = db
    .prepare(`UPDATE products SET active = 0, updated_at = ? WHERE outlet_id = ? AND active = 1`)
    .run(nowIso(), outletId);
  invalidateSearchIndex();
  return Number(info.changes);
}

/* ---------------------------------------------------------- parcel drafts */

export type ParcelDraft = {
  pickup: { latitude: number; longitude: number; label: string } | null;
  destination: { latitude: number; longitude: number; label: string } | null;
};

export function getParcelDraft(phone: string): ParcelDraft {
  const row = db.prepare(`SELECT * FROM parcel_drafts WHERE phone = ?`).get(phone) as
    | {
        pickup_lat: number | null;
        pickup_lng: number | null;
        pickup_label: string;
        dest_lat: number | null;
        dest_lng: number | null;
        dest_label: string;
      }
    | undefined;
  if (!row) return { pickup: null, destination: null };

  return {
    pickup:
      row.pickup_lat !== null && row.pickup_lng !== null
        ? { latitude: row.pickup_lat, longitude: row.pickup_lng, label: row.pickup_label ?? '' }
        : null,
    destination:
      row.dest_lat !== null && row.dest_lng !== null
        ? { latitude: row.dest_lat, longitude: row.dest_lng, label: row.dest_label ?? '' }
        : null,
  };
}

/**
 * Files an incoming pin into the parcel being built.
 *
 * Pickup first, then destination, because that is the order a person describes
 * a journey in. Returns which slot it filled so the customer can be told —
 * silently overwriting the wrong one is how a parcel goes back where it came
 * from.
 */
export function addParcelPin(
  phone: string,
  pin: { latitude: number; longitude: number; label?: string },
  slot?: 'pickup' | 'destination',
): 'pickup' | 'destination' {
  const draft = getParcelDraft(phone);
  const target = slot ?? (draft.pickup === null ? 'pickup' : 'destination');

  db.prepare(
    `INSERT INTO parcel_drafts (phone, updated_at) VALUES (?, ?)
     ON CONFLICT(phone) DO NOTHING`,
  ).run(phone, nowIso());

  if (target === 'pickup') {
    db.prepare(
      `UPDATE parcel_drafts SET pickup_lat = ?, pickup_lng = ?, pickup_label = ?, updated_at = ?
        WHERE phone = ?`,
    ).run(pin.latitude, pin.longitude, pin.label ?? '', nowIso(), phone);
  } else {
    db.prepare(
      `UPDATE parcel_drafts SET dest_lat = ?, dest_lng = ?, dest_label = ?, updated_at = ?
        WHERE phone = ?`,
    ).run(pin.latitude, pin.longitude, pin.label ?? '', nowIso(), phone);
  }
  return target;
}

export function clearParcelDraft(phone: string): void {
  db.prepare(`DELETE FROM parcel_drafts WHERE phone = ?`).run(phone);
}

/** Records which delivery associate an order went to, so a second alert cannot send two. */
export type Associate = {
  phone: string;
  name: string;
  vehicle: string;
  active: number;
};

/**
 * Clocks an associate on or off.
 *
 * Upserts, because duty has to work for somebody who is in DRIVER_NUMBERS but
 * not yet in the directory - which is every associate until ASSOCIATES is
 * set. A row with no name is still a row that can hold a shift.
 */
export function setDuty(phone: string, on: boolean): void {
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return;
  const now = nowIso();

  db.prepare(
    `INSERT INTO associates (phone, name, vehicle, active, on_duty_at, updated_at)
     VALUES (?, '', '', 1, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET on_duty_at = excluded.on_duty_at, updated_at = excluded.updated_at`,
  ).run(digits, on ? now : '', now);

  // The log of stretches worked, kept alongside the current state. One
  // answers "are they working"; only the other can answer "for how long
  // today", which is the question a limit actually needs.
  if (on) {
    const open = db
      .prepare(`SELECT id FROM associate_shifts WHERE phone = ? AND ended_at = '' LIMIT 1`)
      .get(digits);
    // Clocking on twice does not start a second shift on top of the first.
    if (!open) {
      db.prepare(`INSERT INTO associate_shifts (phone, started_at) VALUES (?, ?)`).run(digits, now);
    }
  } else {
    db.prepare(`UPDATE associate_shifts SET ended_at = ? WHERE phone = ? AND ended_at = ''`).run(
      now,
      digits,
    );
  }
}

/**
 * Hours worked in the last 24, counting every stretch rather than the current
 * one.
 *
 * A shift still running counts up to now. A shift nobody closed counts only as
 * far as it would have lapsed - somebody who forgot to clock off last night
 * did not thereby work all night, and banking those hours would lock them out
 * of a shift they are entitled to.
 */
/**
 * Each stretch worked, with an end that can be relied on.
 *
 * A stretch still running has no recorded end, and three things can have
 * stopped it: the clock, the twelve-hour lapse, or the day's cap. The cap is
 * the subtle one. It takes somebody off duty without closing their shift, so a
 * row left open would go on accruing hours they did not work - and those
 * phantom hours sit in the rolling window keeping them off duty long after
 * they should be back.
 *
 * So an open stretch ends at the earliest of: now, when it would lapse, and
 * the moment it carried them to the day's limit.
 */
function effectiveShifts(
  phone: string,
  now: Date,
): { from: number; to: number }[] {
  const rows = db
    .prepare(
      `SELECT started_at AS startedAt, ended_at AS endedAt FROM associate_shifts
        WHERE phone = ? ORDER BY started_at ASC`,
    )
    .all(phone.replace(/[^0-9]/g, '')) as unknown as { startedAt: string; endedAt: string }[];

  const lapseMs = config.dutyHours * 3600_000;
  const limitMs = config.dutyHoursPerDay > 0 ? config.dutyHoursPerDay * 3600_000 : Infinity;
  const windowStart = now.getTime() - 24 * 3600_000;

  const out: { from: number; to: number }[] = [];
  let running = 0;

  for (const row of rows) {
    const from = new Date(row.startedAt).getTime();
    if (!Number.isFinite(from)) continue;

    let to: number;
    if (row.endedAt) {
      to = new Date(row.endedAt).getTime();
      if (!Number.isFinite(to)) continue;
    } else {
      // Whichever stopped them first.
      const room = Math.max(0, limitMs - running);
      to = Math.min(now.getTime(), from + lapseMs, from + room);
    }

    out.push({ from, to });
    const inWindow = Math.min(to, now.getTime()) - Math.max(from, windowStart);
    if (inWindow > 0) running += inWindow;
  }
  return out;
}

/**
 * Hours worked in the last 24, counting every stretch rather than the current
 * one. A limit that reset each time somebody clocked off would be no limit:
 * four hours on, off, then twelve more.
 */
export function hoursWorkedToday(phone: string, now = new Date()): number {
  const windowStart = now.getTime() - 24 * 3600_000;
  let worked = 0;
  for (const { from, to } of effectiveShifts(phone, now)) {
    const overlap = Math.min(to, now.getTime()) - Math.max(from, windowStart);
    if (overlap > 0) worked += overlap;
  }
  return worked / 3600_000;
}

/**
 * When somebody who has hit the cap may work again.
 *
 * Worked out by stepping to the moment each past stretch falls out of the
 * rolling window, rather than guessing at an interval. Null when they are not
 * capped.
 */
export function canWorkAgainAt(phone: string, now = new Date()): Date | null {
  const limit = config.dutyHoursPerDay;
  if (limit <= 0 || hoursWorkedToday(phone, now) < limit) return null;

  const shifts = effectiveShifts(phone, now);
  // A minute past the moment a stretch leaves the window, so the comparison
  // is not decided by whether it lands exactly on the boundary.
  const candidates = shifts
    .map((sft) => new Date(sft.from + 24 * 3600_000 + 60_000))
    .filter((d) => d > now)
    .sort((a, b) => a.getTime() - b.getTime());

  for (const candidate of candidates) {
    if (hoursWorkedToday(phone, candidate) < limit) return candidate;
  }
  return null;
}

/**
 * When they clocked on, or empty for off duty.
 *
 * A shift older than the limit reads as off without anything having to sweep
 * for it. The expiry is worked out here, once, so no caller can forget it and
 * send a job to somebody who went home last night.
 */
export function onDutySince(phone: string, now = new Date()): string {
  const row = db
    .prepare(`SELECT on_duty_at AS at FROM associates WHERE phone = ?`)
    .get(phone.replace(/[^0-9]/g, '')) as { at: string } | undefined;
  if (!row?.at) return '';

  const since = new Date(row.at).getTime();
  if (!Number.isFinite(since)) return '';
  const lapsed = now.getTime() - since > config.dutyHours * 3600_000;
  return lapsed ? '' : row.at;
}

export function isOnDuty(phone: string, now = new Date()): boolean {
  if (onDutySince(phone, now) === '') return false;

  const limit = config.dutyHoursPerDay;
  if (limit <= 0) return true;
  if (hoursWorkedToday(phone, now) < limit) return true;

  // Over the limit. Write down that the shift ended, rather than leaving it
  // open to be inferred again later.
  //
  // An open shift's end has to be guessed at, and the guess depends on when
  // you ask: hours that have aged out of the rolling window make the same
  // shift look longer. That is how somebody capped at 5pm was told to come
  // back at 8am the next day instead of 11pm the same night. Recording the
  // moment makes it a fact, and facts do not move.
  closeShiftAtCap(phone, now);
  return false;
}

/** Closes a running shift at the moment the day's limit stopped it. */
function closeShiftAtCap(phone: string, now: Date): void {
  const digits = phone.replace(/[^0-9]/g, '');
  const open = db
    .prepare(`SELECT id, started_at AS startedAt FROM associate_shifts WHERE phone = ? AND ended_at = '' LIMIT 1`)
    .get(digits) as { id: number; startedAt: string } | undefined;
  if (!open) return;

  const ends = effectiveShifts(digits, now).at(-1)?.to ?? now.getTime();
  db.prepare(`UPDATE associate_shifts SET ended_at = ? WHERE id = ?`).run(
    new Date(Math.min(ends, now.getTime())).toISOString(),
    open.id,
  );
  // And off duty, so the two never disagree.
  db.prepare(`UPDATE associates SET on_duty_at = '', updated_at = ? WHERE phone = ?`).run(
    nowIso(),
    digits,
  );
}

export function getAssociate(phone: string): Associate | null {
  const row = db
    .prepare(`SELECT phone, name, vehicle, active FROM associates WHERE phone = ?`)
    .get(phone.replace(/[^0-9]/g, '')) as Associate | undefined;
  return row ?? null;
}

export function listAssociates(): Associate[] {
  return db
    .prepare(`SELECT phone, name, vehicle, active FROM associates ORDER BY name ASC`)
    .all() as unknown as Associate[];
}

export function upsertAssociate(a: {
  phone: string;
  name: string;
  vehicle?: string;
  active?: boolean;
}): void {
  db.prepare(
    `INSERT INTO associates (phone, name, vehicle, active, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       name = excluded.name,
       vehicle = excluded.vehicle,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  ).run(
    a.phone.replace(/[^0-9]/g, ''),
    a.name.trim(),
    (a.vehicle ?? '').trim(),
    a.active === false ? 0 : 1,
    nowIso(),
  );
}

/**
 * Records who took an order, by name and vehicle as well as number.
 *
 * Copied onto the order rather than looked up when somebody reads it later.
 * An associate who changes vehicle next month must not rewrite which van
 * carried an order last week, and one who leaves must not erase themselves
 * from the orders they delivered.
 *
 * A number with no directory entry still records the number. Knowing a little
 * is better than losing the one fact there was.
 */
export function assignDriver(orderNo: string, driverPhone: string): void {
  const phone = driverPhone.replace(/[^0-9]/g, '');
  const who = getAssociate(phone);
  db.prepare(
    `UPDATE orders SET driver_phone = ?, driver_name = ?, driver_vehicle = ?, updated_at = ?
      WHERE order_no = ?`,
  ).run(phone, who?.name ?? '', who?.vehicle ?? '', nowIso(), orderNo);
}

/**
 * How many orders sit in each status.
 *
 * Operational, not analytical: when somebody reports that a ticket never
 * arrived, the first question is whether an order was ever placed, and nothing
 * else in /health could answer it.
 */
export function orderCounts(): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM orders GROUP BY status`)
    .all() as unknown as { status: string; n: number }[];

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    counts[row.status] = row.n;
    total += row.n;
  }
  return { total, ...counts };
}

/* --------------------------------------------------- associate locations */

export type AssociateLocation = {
  latitude: number;
  longitude: number;
  label: string;
  /** 'shared' when they sent a pin, 'delivery' when inferred from a drop-off. */
  source: string;
  updatedAt: string;
};

export function saveAssociateLocation(
  phone: string,
  at: { latitude: number; longitude: number; label?: string },
  source: 'shared' | 'delivery',
): void {
  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return;
  db.prepare(
    `INSERT INTO associate_locations (phone, latitude, longitude, label, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       latitude = excluded.latitude, longitude = excluded.longitude,
       label = excluded.label, source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(digits, at.latitude, at.longitude, at.label ?? '', source, nowIso());
}

export function getAssociateLocation(phone: string): AssociateLocation | null {
  const row = db
    .prepare(`SELECT * FROM associate_locations WHERE phone = ?`)
    .get(phone.replace(/[^0-9]/g, '')) as
    | { latitude: number; longitude: number; label: string; source: string; updated_at: string }
    | undefined;
  if (!row) return null;
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    label: row.label,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

/**
 * Deliveries an associate is currently holding.
 *
 * "Holding" means collected but not yet delivered — the window in which they
 * are physically carrying somebody's dinner. An order merely offered to them
 * does not count: it is not theirs until they collect it.
 */
export function activeJobsFor(associatePhone: string): OrderRecord[] {
  const digits = associatePhone.replace(/[^0-9]/g, '');
  if (!digits) return [];
  const rows = db
    .prepare(
      `SELECT * FROM orders WHERE driver_phone = ? AND status = 'on_the_way' ORDER BY id ASC`,
    )
    .all(digits) as unknown as Parameters<typeof hydrateOrder>[0][];
  return rows.map(hydrateOrder);
}

/** Orders cooked and waiting for a delivery associate, oldest first — food goes cold. */
export function ordersAwaitingPickup(limit = 10): OrderRecord[] {
  const rows = db
    .prepare(`SELECT * FROM orders WHERE status = 'ready' ORDER BY id ASC LIMIT ?`)
    .all(limit) as unknown as Parameters<typeof hydrateOrder>[0][];
  return rows.map(hydrateOrder);
}

export function setCancelReason(
  orderNo: string,
  reason: string,
  by: 'outlet' | 'staff' | 'customer',
): void {
  db.prepare(`UPDATE orders SET cancel_reason = ?, cancelled_by = ? WHERE order_no = ?`).run(
    reason.slice(0, 200),
    by,
    orderNo,
  );
}

/**
 * Notes that the food left the kitchen, and when.
 *
 * Written once and never overwritten: the first handover is the one that
 * answers how long the food waited, and a second tap on an old message must
 * not move it later. Returns the time that stands, whether it was just set or
 * was already there.
 */
/**
 * Stamps a moment on an order, once.
 *
 * Never overwritten, because the question these answer is how long something
 * took - and a second tap on an old message would quietly make every number
 * derived from it wrong, in the flattering direction.
 */
function stampOnce(orderNo: string, column: 'ready_at' | 'uplifted_at'): void {
  db.prepare(
    `UPDATE orders SET ${column} = ? WHERE order_no = ? AND ${column} = ''`,
  ).run(nowIso(), orderNo);
}

export function markReadyAt(orderNo: string): void {
  stampOnce(orderNo, 'ready_at');
}

export function markUpliftedAt(orderNo: string): void {
  stampOnce(orderNo, 'uplifted_at');
}

/**
 * Earlier orders of this kitchen's that are prepared and still on the counter.
 *
 * Ready, and not yet uplifted. Orders still being prepared are not counted -
 * nothing is going cold that has not been made - and neither are ones already
 * gone, whether the kitchen reported the uplift or an associate did, since
 * taking an order moves it past 'ready' on its own.
 *
 * Ordered by when the customer placed it, because that is the queue the
 * customer experiences and an order that jumped it is the thing worth seeing.
 */
export function earlierStillWaiting(outletId: number, before: string): OrderRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM orders
        WHERE outlet_id = ? AND status = 'ready' AND handed_over_at = '' AND created_at < ?
        ORDER BY created_at ASC`,
    )
    .all(outletId, before) as unknown as Parameters<typeof hydrateOrder>[0][];
  return rows.map(hydrateOrder);
}

export function markHandedOver(orderNo: string): string {
  const existing = db
    .prepare(`SELECT handed_over_at AS at FROM orders WHERE order_no = ?`)
    .get(orderNo) as { at: string } | undefined;
  if (existing?.at) return existing.at;

  const now = nowIso();
  db.prepare(`UPDATE orders SET handed_over_at = ? WHERE order_no = ?`).run(now, orderNo);
  return now;
}

export function setOrderStatus(orderNo: string, status: OrderStatus): void {
  // The stall stamp is cleared with every move, so each stage gets its own
  // alarm. An order warned about while waiting for a delivery associate must be able to
  // raise a second warning if the delivery then drags.
  //
  // A cancellation reason is cleared on any move that is not a cancellation.
  // A reason is only ever written, so one set during a cancellation that was
  // then abandoned used to stay on the order through to delivery — leaving a
  // row that reads as both delivered and cancelled, which is unreadable in an
  // archive six months later.
  const keepReason = status === 'cancelled';
  const now = nowIso();
  // The delivery stamp is written here rather than by a caller, unlike the
  // ready and uplift stamps. Cash is counted from it, and a stamp a handler
  // has to remember to write is a stamp some future handler will not - which
  // would not break anything visible, it would just quietly leave money out
  // of the day's total.
  const delivering = status === 'delivered';
  db.prepare(
    `UPDATE orders
        SET status = ?,
            updated_at = ?,
            stall_alerted_at = NULL,
            delivered_at = CASE WHEN ? AND delivered_at = '' THEN ? ELSE delivered_at END,
            cancel_reason = CASE WHEN ? THEN cancel_reason ELSE '' END,
            cancelled_by = CASE WHEN ? THEN cancelled_by ELSE '' END
      WHERE order_no = ?`,
  ).run(
    status,
    now,
    delivering ? 1 : 0,
    now,
    keepReason ? 1 : 0,
    keepReason ? 1 : 0,
    orderNo,
  );
}

/* ------------------------------------------------------------------- cash */

/**
 * How far ahead of UTC a zone is at a given instant, in milliseconds.
 *
 * Read out of the zone's own formatted parts. The tempting one-liner -
 * `new Date(d.toLocaleString('en-US', { timeZone }))` - reparses a formatted
 * string in the *server's* timezone, so it only gives the right answer when the
 * server happens to be somewhere else. On a server already set to Guyana time
 * it returns a zero offset and the day starts at 20:00 the evening before.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at: Record<string, number> = {};
  for (const part of parts) if (part.type !== 'literal') at[part.type] = Number(part.value);

  const asIfUtc = Date.UTC(
    at.year ?? 1970,
    (at.month ?? 1) - 1,
    at.day ?? 1,
    at.hour ?? 0,
    at.minute ?? 0,
    at.second ?? 0,
  );
  return asIfUtc - instant.getTime();
}

/**
 * Midnight in the store's own timezone, as an instant.
 *
 * The shop trades around the clock, so there is no natural gap to count a day
 * from - but money still has to be reconciled against something, and the day
 * staff recognise is the day on their own clock, not UTC's.
 */
export function startOfStoreDay(now = new Date()): Date {
  const tz = config.store.timezone;
  // en-CA gives YYYY-MM-DD, the one locale format that parses back predictably.
  const day = now.toLocaleDateString('en-CA', { timeZone: tz });
  const naive = new Date(`${day}T00:00:00Z`).getTime();

  // One correction, then a second against the corrected instant. The second
  // matters only on a daylight-saving boundary, where the offset at midnight
  // differs from the offset now - Guyana has none, but the next shop might,
  // and a day that starts an hour out is a day of cash counted into the wrong
  // one.
  let guess = naive - zoneOffsetMs(new Date(naive), tz);
  guess = naive - zoneOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

export type CashTally = { orders: number; total: number };

/**
 * What one associate took in cash over a window.
 *
 * Delivered orders only: an order on its way is money nobody is holding yet,
 * and a cancelled one is money that never existed. Cash only, because a card
 * payment leaves nothing for anybody to hand over at the end of a shift -
 * counting it would overstate what the associate owes and the first
 * reconciliation would be a row about nothing.
 */
export function cashCollected(phone: string, from: Date, to = new Date()): CashTally {
  const digits = phone.replace(/[^0-9]/g, '');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
         FROM orders
        WHERE driver_phone = ?
          AND status = 'delivered'
          AND payment_method LIKE 'cash%'
          AND delivered_at >= ? AND delivered_at <= ?`,
    )
    .get(digits, from.toISOString(), to.toISOString()) as { orders: number; total: number };
  return { orders: row.orders, total: row.total };
}

export type AssociateCash = CashTally & { phone: string; name: string; vehicle: string };

/**
 * The same, for everybody who carried anything, most money first.
 *
 * Driven off the orders rather than off the associate directory: somebody who
 * has been removed from the directory may still owe for a delivery they made
 * this morning, and a reconciliation that forgets them is worse than useless.
 */
export function cashByAssociate(from: Date, to = new Date()): AssociateCash[] {
  const rows = db
    .prepare(
      `SELECT driver_phone AS phone, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
         FROM orders
        WHERE status = 'delivered'
          AND payment_method LIKE 'cash%'
          AND driver_phone != ''
          AND delivered_at >= ? AND delivered_at <= ?
        GROUP BY driver_phone
        ORDER BY total DESC`,
    )
    .all(from.toISOString(), to.toISOString()) as unknown as {
    phone: string;
    orders: number;
    total: number;
  }[];

  return rows.map((r) => {
    const who = getAssociate(r.phone);
    return {
      phone: r.phone,
      name: who?.name ?? '',
      vehicle: who?.vehicle ?? '',
      orders: r.orders,
      total: r.total,
    };
  });
}

/**
 * Delivered cash with nobody's name on it.
 *
 * An order closed by a dispatcher rather than by the associate carrying it
 * never gets a driver_phone, so it would vanish from every per-person total
 * and the day's figures would not add up to the till. Reported separately
 * rather than hidden or attributed to a guess.
 */
export function unassignedCash(from: Date, to = new Date()): CashTally {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
         FROM orders
        WHERE status = 'delivered'
          AND payment_method LIKE 'cash%'
          AND driver_phone = ''
          AND delivered_at >= ? AND delivered_at <= ?`,
    )
    .get(from.toISOString(), to.toISOString()) as { orders: number; total: number };
  return { orders: row.orders, total: row.total };
}

/* ----------------------------------------------------------------- stalls */

export type StalledOrder = {
  order: OrderRecord;
  /** How long it has sat in this status. */
  minutes: number;
};

/**
 * Orders that have stopped moving, and have not already been reported.
 *
 * Measured from `updated_at`, which every status change writes — except for a
 * brand new order, where nothing has moved yet and `created_at` is the honest
 * clock. Orders placed before this column existed have an empty updated_at,
 * hence the fallback rather than a null check.
 */
export function stalledOrders(thresholds: {
  pendingMinutes: number;
  readyMinutes: number;
  deliveryMinutes: number;
}): StalledOrder[] {
  const limits: Partial<Record<OrderStatus, number>> = {
    pending: thresholds.pendingMinutes,
    ready: thresholds.readyMinutes,
    on_the_way: thresholds.deliveryMinutes,
  };

  const rows = db
    .prepare(
      `SELECT * FROM orders
        WHERE status IN ('pending', 'ready', 'on_the_way')
          AND stall_alerted_at IS NULL
        ORDER BY id ASC`,
    )
    .all() as unknown as Parameters<typeof hydrateOrder>[0][];

  const now = Date.now();
  const stalled: StalledOrder[] = [];

  for (const row of rows) {
    const order = hydrateOrder(row);
    const limit = limits[order.status];
    // A threshold of 0 or less switches that stage off rather than alerting on
    // everything the moment it is placed.
    if (!limit || limit <= 0) continue;

    const since = new Date(row.updated_at || row.created_at).getTime();
    if (!Number.isFinite(since)) continue;

    const minutes = Math.floor((now - since) / 60_000);
    if (minutes >= limit) stalled.push({ order, minutes });
  }
  return stalled;
}

/** Marks an order as reported, so the same stall is not announced twice. */
export function markStallAlerted(orderNo: string): void {
  db.prepare(`UPDATE orders SET stall_alerted_at = ? WHERE order_no = ?`).run(nowIso(), orderNo);
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
  /** The delivery pin. Null until the customer shares one; checkout needs it. */
  location: SavedPin | null;
  /** From WhatsApp. A hint to offer, never a fact to rely on. */
  profileName: string | null;
  confirmedAt: string | null;
  confirmed: boolean;
};

export function getIdentity(phone: string): CustomerIdentity {
  const row = db
    .prepare(
      `SELECT ${CUSTOMER_COLUMNS}, profile_name, identity_confirmed_at
       FROM customers WHERE phone = ?`,
    )
    .get(phone) as
    | (CustomerRow & { profile_name: string | null; identity_confirmed_at: string | null })
    | undefined;

  if (!row) {
    return {
      phone,
      name: null,
      address: null,
      contactPhone: null,
      location: null,
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
    location: pinFromRow(row),
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
  location: SavedPin | null;
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
    location: identity.location,
    firstOrderAt: summary.first,
    lastOrderAt: summary.last,
    orderCount: summary.count,
    totalSpend: summary.spend,
    orders: rows.map(hydrateOrder),
  };
}

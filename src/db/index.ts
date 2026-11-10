import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

const dir = path.dirname(path.resolve(config.databasePath));
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.resolve(config.databasePath));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT 'General',
  unit        TEXT    NOT NULL DEFAULT 'each',
  price       INTEGER NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  keywords    TEXT    NOT NULL DEFAULT '',
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);

-- Restaurants and fast-food outlets the customer can order from.
--
-- The house grocery catalogue has no outlet (products.outlet_id IS NULL); every
-- menu item belongs to exactly one of these. Each keeps its own hours, because
-- a roti shop shutting at three and a fried-chicken counter open till eleven
-- cannot share one setting, and its own prep time, because the delivery promise
-- is cooking plus driving and only the kitchen knows the first half.
CREATE TABLE IF NOT EXISTS outlets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  cuisine        TEXT    NOT NULL DEFAULT '',
  hours          TEXT    NOT NULL DEFAULT '',
  prep_minutes   INTEGER NOT NULL DEFAULT 20,
  min_order      INTEGER NOT NULL DEFAULT 0,
  -- NULL means fall back to the shop's own delivery fee.
  delivery_fee   INTEGER,
  -- Where the driver collects. A pin, for the same reason customers get one.
  pickup_address TEXT    NOT NULL DEFAULT '',
  pickup_lat     REAL,
  pickup_lng     REAL,
  -- The outlet's own WhatsApp number, where its kitchen tickets go.
  whatsapp       TEXT    NOT NULL DEFAULT '',
  -- Flipped by the outlet itself when it is slammed or closing early. Distinct
  -- from active, which is whether you trade with them at all.
  accepting      INTEGER NOT NULL DEFAULT 1,
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outlets_active ON outlets(active);

CREATE TABLE IF NOT EXISTS customers (
  phone      TEXT PRIMARY KEY,
  name       TEXT,
  address    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  phone      TEXT    NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  added_at   TEXT    NOT NULL,
  PRIMARY KEY (phone, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT    NOT NULL UNIQUE,
  phone          TEXT    NOT NULL,
  customer_name  TEXT    NOT NULL,
  address        TEXT    NOT NULL,
  delivery_note  TEXT    NOT NULL DEFAULT '',
  subtotal       INTEGER NOT NULL,
  delivery_fee   INTEGER NOT NULL,
  total          INTEGER NOT NULL,
  payment_method TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku        TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  unit       TEXT    NOT NULL,
  qty        INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS conversations (
  phone      TEXT PRIMARY KEY,
  history    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Guards against Meta re-delivering the same webhook, which it does on any
-- non-2xx response or timeout. Without this, one message can be ordered twice.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id    TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- Every customer search that found nothing.
--
-- A miss is the one thing a shop cannot see from its own sales figures: what
-- people came in wanting and left without. Recorded raw for reading back, and
-- normalized so "Channa", "channa " and "CHANNA" group into one line.
CREATE TABLE IF NOT EXISTS search_misses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  query      TEXT NOT NULL,
  normalized TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_misses_norm ON search_misses(normalized);
CREATE INDEX IF NOT EXISTS idx_search_misses_at   ON search_misses(created_at);

-- A parcel being put together, before it becomes an order.
--
-- Two pins are needed and they arrive in separate messages, so they are parked
-- here rather than on the customer. That separation matters: a pickup pin for a
-- parcel is somebody else's doorstep, and letting it overwrite the customer's
-- saved delivery address would quietly send next week's groceries there.
CREATE TABLE IF NOT EXISTS parcel_drafts (
  phone        TEXT PRIMARY KEY,
  pickup_lat   REAL,
  pickup_lng   REAL,
  pickup_label TEXT NOT NULL DEFAULT '',
  dest_lat     REAL,
  dest_lng     REAL,
  dest_label   TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL
);

-- A menu read off a photograph, before a person has approved it.
--
-- Held apart from the live catalogue on purpose. A model reading small print
-- off a laminated menu in bad light will occasionally get a price wrong, and a
-- wrong price is money — so nothing reaches a customer until a staff member has
-- read it back and published it. Keyed by the staff member, so two people can
-- onboard two restaurants at once without colliding.
-- A cart set aside so the customer can do something else first.
--
-- Someone halfway through a grocery list who suddenly wants lunch should not
-- have to abandon the list or finish it first. The live cart holds one source
-- at a time, so the other one is parked here and brought back later.
--
-- Keyed by what the cart was for: NULL outlet_id is the grocery cart, and each
-- restaurant can hold one of its own. Stored as rows rather than a blob so a
-- parked cart reprices itself when it comes back — a price that moved overnight
-- should not come back at yesterday's figure.
CREATE TABLE IF NOT EXISTS parked_cart_items (
  phone      TEXT    NOT NULL,
  outlet_key INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  options    TEXT    NOT NULL DEFAULT '',
  qty        INTEGER NOT NULL CHECK (qty > 0),
  parked_at  TEXT    NOT NULL,
  PRIMARY KEY (phone, outlet_key, product_id, options)
);
CREATE INDEX IF NOT EXISTS idx_parked_phone ON parked_cart_items(phone);

CREATE TABLE IF NOT EXISTS menu_drafts (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  pages      INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  direction  TEXT NOT NULL,
  channel    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_log_phone ON message_log(phone);
`);

/**
 * Additive migrations for databases created by an earlier build. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so each column is checked before it is added.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migrated: added ${table}.${column}`);
}

addColumnIfMissing('orders', 'updated_at', "TEXT NOT NULL DEFAULT ''");

// The WhatsApp profile name is a hint, not the customer's name — it is often a
// nickname, a business, or the relative whose phone it is. Kept apart from the
// delivery name so it can be offered for confirmation rather than assumed.
addColumnIfMissing('customers', 'profile_name', "TEXT");
// When this customer last confirmed who they are and where they are. Deliveries
// go to a person, so this is required before an order can be placed.
addColumnIfMissing('customers', 'identity_confirmed_at', "TEXT");
// The number the driver should call. Usually the WhatsApp number, but not
// always: people order from a work phone, or want the household number rung.
addColumnIfMissing('customers', 'contact_phone', "TEXT");
addColumnIfMissing('orders', 'contact_phone', "TEXT NOT NULL DEFAULT ''");
// A publicly reachable HTTPS image for the product. WhatsApp fetches the URL
// itself, so nothing is stored here but the address.
addColumnIfMissing('products', 'image_url', "TEXT NOT NULL DEFAULT ''");

// The customer's delivery pin, as shared from WhatsApp. This is where the goods
// actually go — a typed address is supporting detail for the doorstep.
addColumnIfMissing('customers', 'latitude', 'REAL');
addColumnIfMissing('customers', 'longitude', 'REAL');
// WhatsApp's own name or street address for the pin, when it sent one.
addColumnIfMissing('customers', 'location_label', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('customers', 'location_pinned_at', 'TEXT');

// The pin is copied onto the order rather than read back off the customer,
// because people move. A pin shared next month must not silently relocate a
// delivery that already went out last week.
addColumnIfMissing('orders', 'latitude', 'REAL');
addColumnIfMissing('orders', 'longitude', 'REAL');
addColumnIfMissing('orders', 'location_label', "TEXT NOT NULL DEFAULT ''");

/* ------------------------------------------------- restaurants and menus */

// Which outlet a row belongs to. NULL is the house grocery catalogue, so every
// existing product keeps working untouched.
addColumnIfMissing('products', 'outlet_id', 'INTEGER REFERENCES outlets(id)');
// Modifier groups, in the compact text form the menu CSV uses. Empty for
// groceries: a bag of rice has no size, spice level or "no onions".
addColumnIfMissing('products', 'options', "TEXT NOT NULL DEFAULT ''");
// A kitchen counts nothing. It cooks to order and occasionally runs out, so a
// menu item is available or sold out rather than holding a quantity — and
// nothing may decrement its stock at checkout.
addColumnIfMissing('products', 'track_stock', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('products', 'sold_out', 'INTEGER NOT NULL DEFAULT 0');

// Where an order was cooked, copied onto the row for the same reason the pin is:
// an outlet that changes address must not move last week's collection.
addColumnIfMissing('orders', 'outlet_id', 'INTEGER');
addColumnIfMissing('orders', 'outlet_name', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'pickup_address', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'pickup_lat', 'REAL');
addColumnIfMissing('orders', 'pickup_lng', 'REAL');
addColumnIfMissing('orders', 'prep_minutes', 'INTEGER NOT NULL DEFAULT 0');
// Which driver the dispatch went to, so a second "food ready" does not send two
// riders and a driver's later taps can be attributed.
addColumnIfMissing('orders', 'driver_phone', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('order_items', 'options', "TEXT NOT NULL DEFAULT ''");
// Which menu the customer is currently looking at. Held in the database rather
// than inferred from the conversation so a search cannot drift back to the
// grocery aisle halfway through ordering a burger.
addColumnIfMissing('customers', 'browsing_outlet_id', 'INTEGER');

// When staff were last warned that this order had stopped moving. Cleared every
// time the status changes, so each stage can raise its own alarm once and an
// order that stalls twice is reported twice.
addColumnIfMissing('orders', 'stall_alerted_at', 'TEXT');

/* --------------------------------------------------------------- services */

// Which service the customer picked at the start of this conversation:
// groceries, a restaurant, a parcel, or something a person has to handle.
// Persisted rather than inferred, because a shopping cart and a parcel job are
// not interchangeable and a conversation that drifts between them produces an
// order nobody can fulfil. Cleared when a conversation ends, so the next one
// opens with the menu again.
addColumnIfMissing('customers', 'service', 'TEXT');
addColumnIfMissing('customers', 'service_chosen_at', 'TEXT');

// A parcel has a sender and a recipient, and they are different people in
// different places. The customer is the sender; these are who receives it.
addColumnIfMissing('orders', 'recipient_name', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'recipient_phone', "TEXT NOT NULL DEFAULT ''");
// What the job is. 'grocery' and 'restaurant' are product orders; 'parcel'
// carries no products at all, so anything reading order_items must tolerate
// an order with none.
addColumnIfMissing('orders', 'kind', "TEXT NOT NULL DEFAULT 'grocery'");
addColumnIfMissing('orders', 'parcel_details', "TEXT NOT NULL DEFAULT ''");

/**
 * Two of the same burger with different options are two cart lines, so the
 * primary key has to include the choices. SQLite cannot alter a primary key, so
 * the table is rebuilt — carrying any live carts across rather than clearing
 * them, since someone is mid-shop when a deploy lands.
 */
{
  const columns = db.prepare(`PRAGMA table_info(cart_items)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === 'options')) {
    // Foreign keys cannot be toggled inside a transaction, so this sits outside.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE cart_items_rebuilt (
        phone      TEXT    NOT NULL,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        options    TEXT    NOT NULL DEFAULT '',
        qty        INTEGER NOT NULL CHECK (qty > 0),
        added_at   TEXT    NOT NULL,
        PRIMARY KEY (phone, product_id, options)
      );
      INSERT INTO cart_items_rebuilt (phone, product_id, options, qty, added_at)
        SELECT phone, product_id, '', qty, added_at FROM cart_items;
      DROP TABLE cart_items;
      ALTER TABLE cart_items_rebuilt RENAME TO cart_items;
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[db] migrated: cart lines can now carry menu options');
  }
}

/**
 * One-off compliance removal.
 *
 * BEV-001 (Banks Beer) shipped in the original sample catalogue, and WhatsApp's
 * Commerce Policy prohibits selling alcohol over the channel — a violation can
 * cost the phone number. It is removed from the CSV, but a database seeded
 * before that still holds it, and a hosted deployment has no shell to fix it
 * from. This runs on every boot regardless of configuration.
 *
 * Deactivated rather than deleted, so past orders keep their item history.
 * Idempotent, and cheap enough to leave in place.
 */
{
  const info = db.prepare(`UPDATE products SET active = 0 WHERE sku = 'BEV-001' AND active = 1`).run();
  if (info.changes > 0) console.log('[db] deactivated BEV-001 — alcohol is not permitted on WhatsApp');
}

export const nowIso = (): string => new Date().toISOString();

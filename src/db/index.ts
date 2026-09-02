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

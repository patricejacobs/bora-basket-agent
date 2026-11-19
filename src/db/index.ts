import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { CATEGORY_RENAMES } from '../categories.ts';

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

-- The shops the customer can order from: kitchens that cook, and groceries that
-- pack off a shelf. Told apart by the kind column.
--
-- Every product belongs to exactly one of these. Groceries used to be the
-- exception — a house catalogue with products.outlet_id IS NULL and its number
-- in an environment variable — which meant one implicit shop, no confirm step
-- of its own, and a number that had to be staff to press a button. A grocery is
-- an outlet now, so it has the same record, the same tickets and the same
-- Confirm as a kitchen, and there can be more than one of them.
--
-- Each keeps its own hours, because a roti shop shutting at three and a
-- fried-chicken counter open till eleven cannot share one setting, and its own
-- prep time, because the delivery promise is preparing plus driving and only
-- the shop knows the first half.
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
  -- Where the delivery associate collects. A pin, for the same reason customers get one.
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

-- Where a delivery associate was last known to be.
--
-- WhatsApp does not report anyone's position, so this is only ever as good as
-- the last thing that told us: a pin they shared, or the doorstep of their last
-- delivery, which is where they demonstrably were when they tapped Delivered.
-- Both go stale, which is why nothing here is ever used to exclude somebody
-- whose location we are guessing at.
-- Who carries the orders. A phone number alone answers "which one of them"
-- with a number somebody has to look up, and answers "whose van is that"
-- not at all.
-- Every stretch an associate was clocked on. The current state alone cannot
-- answer how long somebody has worked today, and a limit that resets each
-- time they clock off is not a limit: four hours on, off, then twelve more.
--
-- ended_at empty means the shift is still running. A shift nobody closed is
-- treated as ending when it would have lapsed, so a forgotten clock-off
-- cannot bank hours that were never worked.
CREATE TABLE IF NOT EXISTS associate_shifts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_shifts_phone ON associate_shifts(phone, started_at);

CREATE TABLE IF NOT EXISTS associates (
  phone      TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  vehicle    TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS associate_locations (
  phone      TEXT PRIMARY KEY,
  latitude   REAL NOT NULL,
  longitude  REAL NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'shared',
  updated_at TEXT NOT NULL
);

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

-- Facts about the database itself rather than about the shop's trade. Small
-- on purpose: it exists so a one-shot operation can record that it has run,
-- and so a restart - a deploy, a crash, a plan change - cannot run it again.
-- A customer asking for a person, written down before anybody is told.
--
-- The telling can fail: there may be no staff number configured, or WhatsApp
-- may refuse the message. Recording it first is what makes "someone will come
-- back to you" true rather than a hope - the request survives the failure and
-- is delivered when there is somebody to deliver it to.
CREATE TABLE IF NOT EXISTS help_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  urgent       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  /** Empty until staff have actually received it. */
  delivered_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_help_pending ON help_requests(delivered_at);

-- What the customer thought of it, asked once per order and never twice.
--
-- One row per order, written when the question goes out rather than when it
-- is answered: an unanswered row is how the shop knows not to ask again, and
-- how a bare "4" arriving two minutes later is read as four stars instead of
-- as the fourth item on some list.
--
-- A comment is only ever asked for below three stars. A customer who had a
-- good delivery has already said so in one tap and must not be interviewed
-- about it.
CREATE TABLE IF NOT EXISTS ratings (
  order_no     TEXT PRIMARY KEY,
  phone        TEXT NOT NULL,
  /** 1-5, or 0 while the question is still out. */
  stars        INTEGER NOT NULL DEFAULT 0,
  comment      TEXT NOT NULL DEFAULT '',
  asked_at     TEXT NOT NULL,
  answered_at  TEXT NOT NULL DEFAULT '',
  commented_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ratings_phone ON ratings(phone, asked_at);

-- The last numbered list a customer was shown.
--
-- "3" means nothing on its own. A customer picks from a list of aisles and
-- then from a list of products, and both are numbered from one, so the shop
-- has to know which list was on the screen when they answered. Rewritten
-- every time a list is sent, because only the newest one is being read.
CREATE TABLE IF NOT EXISTS numbered_lists (
  phone     TEXT NOT NULL,
  position  INTEGER NOT NULL,
  /** 'category' or 'product' — what a number means right now. */
  kind      TEXT NOT NULL,
  /** The category name, or the product SKU. */
  value     TEXT NOT NULL,
  label     TEXT NOT NULL DEFAULT '',
  shown_at  TEXT NOT NULL,
  PRIMARY KEY (phone, position)
);

CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
// The number the delivery associate should call. Usually the WhatsApp number, but not
// always: people order from a work phone, or want the household number rung.
addColumnIfMissing('customers', 'contact_phone', "TEXT");
// The delivery zone the customer has AGREED to, by name.
//
// The name and not the fee, so a price changed in the tariff reprices the
// next order instead of leaving a figure nobody charges any more - the same
// rule the cart follows for menu options.
addColumnIfMissing('customers', 'delivery_zone', "TEXT NOT NULL DEFAULT ''");
// And what the order was actually charged under, kept on the order so a
// receipt a month old still says where it went.
addColumnIfMissing('orders', 'delivery_zone', "TEXT NOT NULL DEFAULT ''");
// When the customer asked for it, and in whose words.
//
// Two columns because they answer different questions. The timestamp is what
// a shop sorts and schedules by; the words are what the customer actually
// said, and "before six" or "after I finish work" is not a point in time
// however hard you squint at it. The associate reads the words; the shop
// works from the time.
addColumnIfMissing('orders', 'deliver_at', "TEXT NOT NULL DEFAULT ''");
// Whether this order's goods have been put back on the shelf.
//
// A flag and not an inference, because the question "has this been
// restocked?" cannot be answered from the status: an order can reach
// cancelled twice - a retried webhook, a second tap on the button - and the
// second one must not put the same four bottles of milk back again.
addColumnIfMissing('orders', 'stock_returned', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('orders', 'deliver_note', "TEXT NOT NULL DEFAULT ''");
// The two parties to a parcel, held while they are being collected.
//
// A parcel needs two names, two addresses and two numbers, and nobody gives
// all six in one message. Each half is written down the moment the customer
// agrees it is right, so a conversation that wanders - or a reply that
// arrives an hour later - never asks for the same thing twice.
for (const side of ['sender', 'recipient'] as const) {
  for (const field of ['name', 'address', 'phone'] as const) {
    addColumnIfMissing('parcel_drafts', `${side}_${field}`, "TEXT NOT NULL DEFAULT ''");
  }
}
addColumnIfMissing('parcel_drafts', 'contents', "TEXT NOT NULL DEFAULT ''");
// And the zone the parcel is priced under, which is the RECIPIENT's.
//
// Kept on the draft rather than on the customer. A parcel goes where the
// customer is not, so a zone confirmed while booking one to Diamond must not
// price their own groceries next week as if they lived there.
addColumnIfMissing('parcel_drafts', 'zone', "TEXT NOT NULL DEFAULT ''");
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

// Which outlet a row belongs to. NULL meant the house grocery catalogue until
// groceries became outlets of their own; the migration near the foot of this
// file adopts any row still carrying NULL, so nothing is stranded.
addColumnIfMissing('products', 'outlet_id', 'INTEGER REFERENCES outlets(id)');
// A kitchen or a grocery. Defaulting to 'restaurant' is right for every row
// that existed before this column did — the only outlets then were kitchens.
addColumnIfMissing('outlets', 'kind', "TEXT NOT NULL DEFAULT 'restaurant'");
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
// Which delivery associate the dispatch went to, so a second "food ready" does not send two
// delivery associates and a delivery associate's later taps can be attributed.
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
// Why a cancelled order was cancelled. "Cancelled" alone tells the customer
// nothing and leaves no pattern to read later.
addColumnIfMissing('orders', 'cancel_reason', "TEXT NOT NULL DEFAULT ''");
// Who cancelled: 'outlet' or 'staff'. The customer is told which, and naming
// the restaurant for a cancellation the shop made would be a lie.
addColumnIfMissing('orders', 'cancelled_by', "TEXT NOT NULL DEFAULT ''");

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
// When the kitchen was handed the real ticket. Empty means it never arrived —
// almost always because the 24-hour window was shut — and the ticket is owed
// to them the moment they next message.
addColumnIfMissing('orders', 'outlet_notified_at', "TEXT NOT NULL DEFAULT ''");
// When the kitchen handed the food over. A clock, not a status: the order is
// only on its way when the delivery associate says so, because only they know
// they have it. This measures the wait between food being prepared and food
// leaving, which is the gap a kitchen and a shop argue about.
addColumnIfMissing('orders', 'handed_over_at', "TEXT NOT NULL DEFAULT ''");
// The two moments worth measuring an order by: when the food was ready, and
// when somebody actually took it. updated_at cannot answer this - it is
// overwritten by every later move, so by the time an order is delivered it
// has forgotten when it was ready.
// Copied onto the order when an associate takes it, not looked up later. An
// associate who changes vehicle next month must not rewrite which van carried
// an order last week, and one who leaves must not erase themselves from it.
// The language this customer writes in, remembered so a notification sent
// hours later matches the conversation they had. Empty until something they
// wrote gave it away.
// When an associate clocked on. Empty means off duty. A time rather than a
// flag, so going off can happen by itself after a long enough silence - a
// flag would leave somebody on duty overnight and getting job cards at 3am.
addColumnIfMissing('associates', 'on_duty_at', "TEXT NOT NULL DEFAULT ''");
// Where an associate works from, as a place name out of the tariff — "Diamond",
// "Mon Repos". Empty for somebody who works out of town, which is everybody
// until a shop says otherwise.
//
// Deliberately a declared base and not the live pin in `associate_locations`.
// A pin says where somebody was forty minutes ago, which is the right fact for
// "who is nearest this pickup right now" and the wrong one for "which parts of
// the coast do we cover at all". The two answer different questions and the
// shop needs both.
addColumnIfMissing('associates', 'base_place', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('customers', 'language', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'driver_name', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'driver_vehicle', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'ready_at', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'uplifted_at', "TEXT NOT NULL DEFAULT ''");

// Proof of delivery. Four digits the customer reads out at the door.
//
// Three columns rather than one, because "the code was wrong" and "the code
// never reached them" are different events and only the first is anybody's
// fault. Outside WhatsApp's 24-hour window the on-its-way message goes as a
// fixed template, which cannot carry a code - so an order can reach a doorstep
// with no code in the customer's hands, and the associate must not be asked for
// one. `code_sent_at` is how that is known.
addColumnIfMissing('orders', 'delivery_code', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'code_sent_at', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'code_verified_at', "TEXT NOT NULL DEFAULT ''");
// Wrong guesses. Four digits is 9,000 possibilities, which a person tapping a
// phone will never exhaust - but an associate who can guess freely can verify a
// delivery without the customer, which is the one thing the code exists to
// prevent. Five wrong and the code is spent: the order can still be delivered,
// only never as verified.
addColumnIfMissing('orders', 'code_attempts', 'INTEGER NOT NULL DEFAULT 0');
// A taxi's safety code, which is the delivery code turned around and therefore
// its own column rather than a share of that one.
//
// A delivery code travels customer → associate and proves the person at the
// door is the one who ordered: the associate must never see it. A taxi's
// travels driver → passenger and proves the car at the kerb is the one the
// shop sent: the driver is the one who says it, and the passenger checks it
// against their own message before getting in.
//
// Sharing `delivery_code` would have put digits the driver must read out into
// every branch built to keep digits away from them — the verification parser,
// the "type the code to close it" instruction, the confirmed/unverified
// wording on the customer's receipt. Two meanings, two columns, and no
// exception to be forgotten.
addColumnIfMissing('orders', 'safety_code', "TEXT NOT NULL DEFAULT ''");
// Which service the rated job was, copied onto the rating.
//
// The quiet period that stops a customer being asked too often is counted per
// service: groceries on Monday must not silence a taxi on Thursday. Read off
// the order it would stop working for a job that has been archived or
// cleared, so it is written down here at the moment the question goes out.
addColumnIfMissing('ratings', 'kind', "TEXT NOT NULL DEFAULT ''");
// Ratings asked before the column existed know which order they belong to,
// so the kind can be filled in from it. Without this every one of them would
// match no service, the quiet period would read as "never asked" the first
// time round, and every customer on the books would be asked once more than
// they should be. Only touches rows that have no kind, so it is idempotent.
db.prepare(
  `UPDATE ratings
      SET kind = COALESCE((SELECT o.kind FROM orders o WHERE o.order_no = ratings.order_no), '')
    WHERE kind = ''`,
).run();

// When the money changed hands.
//
// `updated_at` would nearly do, since delivered is terminal and nothing moves
// it afterwards - but "nearly" is not a basis for counting cash. Its own
// column, written once, inside the same statement that sets the status, so no
// future code path can set one without the other.
addColumnIfMissing('orders', 'delivered_at', "TEXT NOT NULL DEFAULT ''");

// Whether the pin on this order is the RECIPIENT's, when the order is going to
// somebody other than the buyer.
//
// Every order copies the buyer's saved pin at checkout. On a third-party
// delivery that pin is the buyer's own door, so a map link built from it sends
// an associate confidently to the wrong house while the written address above
// it says somewhere else. Absent, this is 0, and no link is shown - the safe
// answer, because the associate then rings.
addColumnIfMissing('orders', 'recipient_pin', 'INTEGER NOT NULL DEFAULT 0');

// Why a parcel came back.
//
// Its own column rather than `cancel_reason`, because a return is not a
// cancellation: the job was accepted, collected, paid for and driven across
// town. 'nobody_there' or 'wrong_code' - the two are different things to the
// person who sent it. Nobody there is a missed appointment; a code that would
// not verify means the parcel may have been offered to the wrong person, and
// the sender is the only one who can find out which.
addColumnIfMissing('orders', 'return_reason', "TEXT NOT NULL DEFAULT ''");

// Who uplifted it, which is not always who delivers it.
//
// A job can be transferred between associates mid-journey. For food that moves
// the money too - it is collected at the door by whoever gets there. For a
// parcel it does not: the fee was taken at the pickup and is in the uplifter's
// pocket whatever happens next. Without this, one transfer would move an
// already-collected fee onto somebody who never touched it, and the first
// associate would end the shift short by exactly what he is carrying.
addColumnIfMissing('orders', 'uplifted_by', "TEXT NOT NULL DEFAULT ''");

// What happened to an order, in order, with who did it.
//
// The order row holds the current state: who has it now, what it says now. It
// cannot answer "who had it before" or "when did it change hands", and after a
// transfer it shows only whoever finished the job - as though the first
// associate never touched it. For a parcel that is also the person who took
// the money, so the row and the till disagree with nothing to explain why.
//
// Append-only. A row here is a thing that happened; it is never edited and
// never deleted, which is the whole value of it.
db.exec(`
  CREATE TABLE IF NOT EXISTS order_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no   TEXT NOT NULL,
    at         TEXT NOT NULL,
    event      TEXT NOT NULL,
    actor      TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT ''
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS order_events_by_order ON order_events (order_no, id)`);
db.exec(`CREATE INDEX IF NOT EXISTS order_events_by_time ON order_events (at)`);

/**
 * Repairs rows written before the two bugs above were fixed.
 *
 * Both are rewrites of what the row already meant, not guesses. An order with
 * a *restaurant* outlet was cooked in a kitchen whatever its `kind` column
 * says, and a cancellation reason on an order that is not cancelled described
 * something that did not happen.
 *
 * The outlet kind in that first statement is not decoration. Before groceries
 * became outlets, "has an outlet" and "is a restaurant order" were the same
 * fact, so the repair tested the cheaper one. They are different facts now: a
 * grocery order has an outlet too, and without the kind check this would
 * relabel every grocery order as a restaurant one on every single boot.
 *
 * Nor is `status <> 'pending'` in the third. That statement mends rows written
 * before the column existed, so that a kitchen saying hello is not buried under
 * a month of history it can do nothing about. Without the status check it did
 * far more than mending: an empty `outlet_notified_at` is also how a live order
 * records that its ticket could NOT be sent — the kitchen was outside
 * WhatsApp's 24-hour window — and that it is still owed one. Marking those as
 * delivered on every boot is the system writing down that it did something it
 * did not do, and `flushOutletTickets` then has nothing left to hand over when
 * the kitchen finally writes in.
 *
 * On a host that sleeps when idle, "every boot" is several times a day. The
 * result is a queue of pending orders the kitchen has never seen and will never
 * be sent, with nothing anywhere saying so. A settled order cannot be owed a
 * ticket, so restricting the mend to those keeps its purpose and drops the harm.
 *
 * Idempotent, and cheap once there is nothing left to mend: both run on every
 * boot and match no rows after the first.
 */
db.exec(`
  UPDATE orders SET kind = 'restaurant'
   WHERE outlet_id IS NOT NULL AND kind = 'grocery'
     AND outlet_id IN (SELECT id FROM outlets WHERE kind = 'restaurant');

  UPDATE orders SET cancel_reason = '', cancelled_by = ''
   WHERE status <> 'cancelled' AND (cancel_reason <> '' OR cancelled_by <> '');

  UPDATE orders SET outlet_notified_at = created_at
   WHERE outlet_notified_at = '' AND outlet_id IS NOT NULL
     AND status <> 'pending';
`);

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

/**
 * Groceries become a shop with a record, rather than the absence of one.
 *
 * A grocery used to be implied: products with no outlet, a number in
 * GROCERY_NUMBER, and the shop's own staff pressing Confirm on its behalf.
 * That worked for exactly one grocery and gave it no identity — no hours of its
 * own, no pickup address for the associate, and a telephone number that had to
 * be staff before it could press a button.
 *
 * So one house grocery is created here, and every product still carrying NULL
 * is adopted into it. After this runs there is no such thing as a product
 * without a shop, which is what lets the restaurant path — tickets, Confirm,
 * Ready, dispatch, per-outlet hours and fees — serve groceries unchanged.
 *
 * Runs on every boot and is idempotent: the insert is ignored once the row
 * exists, and the adoption matches nothing once nothing is orphaned.
 *
 * It is deliberately unconditional rather than only running when orphans
 * exist. `upsertProduct` files a product with no outlet into this shop, so it
 * has to be here before the first product is, including on a database created
 * from scratch a moment ago.
 */
export const HOUSE_GROCERY_CODE = 'GROCERY';
{
  const centre = config.store.serviceArea;
  db.prepare(
    `INSERT INTO outlets
       (code, name, kind, cuisine, hours, prep_minutes, min_order, delivery_fee,
        pickup_address, pickup_lat, pickup_lng, whatsapp, accepting, active, updated_at)
     VALUES (?, ?, 'grocery', ?, ?, 20, 0, NULL, '', ?, ?, ?, 1, 1, ?)
     ON CONFLICT(code) DO NOTHING`,
  ).run(
    HOUSE_GROCERY_CODE,
    config.store.name,
    'Groceries and household goods',
    // Open round the clock: a shelf does not shut the way a kitchen does, and
    // an hours string that disagreed with the shop would refuse real orders.
    '24 hours',
    centre?.latitude ?? null,
    centre?.longitude ?? null,
    // Seeded from GROCERY_NUMBER where it was set, so a shop that configured
    // the picking number keeps it without doing the work twice. The outlet's
    // own column is the home for it from here on.
    config.groceryNumber,
    new Date().toISOString(),
  );

  const house = db.prepare(`SELECT id FROM outlets WHERE code = ?`).get(HOUSE_GROCERY_CODE) as
    | { id: number }
    | undefined;

  if (house) {
    const adopted = db
      .prepare(`UPDATE products SET outlet_id = ? WHERE outlet_id IS NULL`)
      .run(house.id);
    if (adopted.changes > 0) {
      console.log(`[db] migrated: ${adopted.changes} grocery products now belong to a shop`);
    }
    // Carts parked under the old grocery sentinel, so somebody mid-shop across
    // the deploy finds their list where they left it rather than empty.
    const moved = db
      .prepare(`UPDATE parked_cart_items SET outlet_key = ? WHERE outlet_key = 0`)
      .run(house.id);
    if (moved.changes > 0) console.log(`[db] migrated: ${moved.changes} parked grocery cart lines`);
  }
}

/**
 * Every number in DRIVER_NUMBERS becomes a row in the associates table.
 *
 * The table is what dispatch reads now. Before this there were two lists that
 * never met: a shop could import its associates, see them listed, watch one
 * clock on - and every job still went to whoever was named in an environment
 * variable, because that variable WAS the pool. Someone on the table and not
 * in the variable was invisible; the log even said "nobody is clocked on"
 * while they were standing there clocked on.
 *
 * So the variable is demoted to a seed. Anything in it is written into the
 * table once, and from then on the table is edited the way everything else
 * about an associate is edited.
 *
 * DO NOTHING, never an update: a name, a vehicle or a deliberate `active = 0`
 * set through the shop must not be undone on the next restart by a value in
 * an environment variable nobody has looked at for months.
 *
 * Here rather than in the server's boot, because smoke tests, the walkthroughs
 * and the card gallery all open the database directly and must see the same
 * shop the server does.
 */
/**
 * The grocery aisles, renamed and reordered.
 *
 * Scoped to grocery products, never to a menu: the roti shop has a Snacks
 * category of its own, and a blanket rename would have re-labelled its food
 * as "Drinks & Snacks". Having an outlet is not the same as being a kitchen,
 * and this code has made that mistake before.
 *
 * Idempotent by construction - a second run finds nothing left under the old
 * names and changes nothing.
 */
{
  const grocery = db
    .prepare(`SELECT id FROM outlets WHERE kind = 'grocery'`)
    .all() as unknown as { id: number }[];

  if (grocery.length > 0) {
    const ids = grocery.map((g) => g.id);
    const holes = ids.map(() => '?').join(',');
    let moved = 0;

    for (const [from, to] of Object.entries(CATEGORY_RENAMES)) {
      moved += Number(
        db
          .prepare(
            `UPDATE products SET category = ?
              WHERE category = ? AND outlet_id IN (${holes})`,
          )
          .run(to, from, ...ids).changes,
      );
    }

    // Pasta leaves the tins it was filed with. It has always had its own SKU
    // prefix, which is the only reason this can be done without guessing.
    moved += Number(
      db
        .prepare(
          `UPDATE products SET category = 'Rice, Peas & Pasta'
            WHERE sku LIKE 'PAS-%' AND category <> 'Rice, Peas & Pasta'
              AND outlet_id IN (${holes})`,
        )
        .run(...ids).changes,
    );

    if (moved > 0) console.log(`[db] migrated: ${moved} product(s) into the new grocery aisles`);
  }
}

export function seedAssociatesFromDriverNumbers(): number {
  const seeded = db.prepare(
    `INSERT INTO associates (phone, name, vehicle, active, updated_at)
     VALUES (?, '', '', 1, ?) ON CONFLICT(phone) DO NOTHING`,
  );
  const now = new Date().toISOString();
  let added = 0;
  for (const phone of config.driverNumbers) {
    added += Number(seeded.run(phone, now).changes);
  }
  return added;
}

{
  const added = seedAssociatesFromDriverNumbers();
  if (added > 0) {
    console.log(`[db] migrated: ${added} delivery associate(s) seeded from DRIVER_NUMBERS`);
  }
}

export const nowIso = (): string => new Date().toISOString();

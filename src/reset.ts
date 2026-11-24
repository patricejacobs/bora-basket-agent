/**
 * Wiping the shop's trading data, once, on purpose.
 *
 * A shop that has been testing in public ends up with a database full of
 * rehearsals: orders nobody will deliver, baskets nobody will pay for,
 * customers who were the owner trying something. At some point the sensible
 * thing is to start the count at one again - and there is no shell on the host
 * to do it from, so it has to be something the service itself can be asked to
 * do on its way up.
 *
 * Three things make that safe enough to ship:
 *
 * It needs a token, not a flag. `RESET_SHOP` must begin with `erase-`, which
 * is not a value anybody sets by accident while debugging something else.
 *
 * It runs once. The token is written to `meta` after it has been applied, and
 * a boot that finds the same token already recorded does nothing. Without that
 * a variable left in place would erase a day's trading on every deploy, every
 * crash and every restart - which is the version of this feature that destroys
 * a business.
 *
 * It takes a snapshot first, before deleting anything, so the thing being
 * thrown away is on disk under its own name a second before it goes.
 *
 * What it keeps is as deliberate as what it removes: the catalogue, the
 * outlets and the delivery associates are how the shop works, not what it has
 * done. Wiping those would leave a service that cannot trade at all.
 */
import { db, nowIso } from './db/index.ts';
import { config } from './config.ts';
import { writeSnapshot } from './backup.ts';
import { warnStaff } from './notifications.ts';

/** Everything that is a record of trade, in an order children-first. */
const WIPED = [
  // The orders themselves and everything hanging off them.
  'order_events',
  'order_items',
  'orders',
  // Shopping in progress.
  'cart_items',
  'parked_cart_items',
  'parcel_drafts',
  'menu_drafts',
  // The list last on somebody's screen, which means nothing once the
  // conversation it belonged to is gone.
  'numbered_lists',
  // Customers still waiting for a person. Left behind, the next boot would
  // send staff a request naming somebody the wipe has just deleted.
  'help_requests',
  'waiting_customers',
  // What customers thought of orders that no longer exist. Left behind, the
  // ratings report would average stars against missing jobs, and a customer
  // the wipe deleted would still be inside the quiet period that stops the
  // shop asking them anything.
  'ratings',
  // Points earned on orders that are being deleted. A balance that outlived
  // the deliveries behind it is money the shop cannot account for, and the
  // ledger exists precisely so every point can be traced to an order.
  'points_ledger',
  // Who the shop knows, and everything said to them.
  'conversations',
  'customers',
  'message_log',
  // What was asked for and not stocked. Demand measured against a catalogue
  // that is about to be the only thing left is not a reading worth keeping.
  'search_misses',
] as const;

export type ResetOutcome =
  | { ran: false; reason: 'not asked' | 'already applied' | 'bad token' }
  | { ran: true; token: string; snapshot: string; cleared: Record<string, number> };

const applied = (): string =>
  (db.prepare(`SELECT value FROM meta WHERE key = 'reset_applied'`).get() as
    | { value: string }
    | undefined)?.value ?? '';

/**
 * Clears the tables and restarts the numbering. Exported for the test suite,
 * which must be able to prove what survives without going near a token.
 */
export function wipeTradingData(): Record<string, number> {
  const cleared: Record<string, number> = {};

  db.exec('BEGIN');
  try {
    for (const table of WIPED) {
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      db.prepare(`DELETE FROM ${table}`).run();
      if (before > 0) cleared[table] = before;
    }

    // The next order is ORD-00001 again.
    //
    // All three, because nextOrderNumber() takes the highest of them: the
    // table's own ids, SQLite's sequence, and the order numbers in the event
    // trail. Clearing the orders alone would hand out ORD-00100 to the first
    // order of the new life, which is the opposite of what was asked for.
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('orders', 'order_events')`).run();

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return cleared;
}

/**
 * Applies the reset if RESET_SHOP asks for one that has not been done.
 *
 * Called on the server's way up, before anything is served. Deliberately not
 * called from the database module: opening the database to run a test, a
 * walkthrough or the card gallery must never be able to wipe a shop.
 */
export async function applyScheduledReset(): Promise<ResetOutcome> {
  const token = config.resetShop;
  if (!token) return { ran: false, reason: 'not asked' };

  if (!token.startsWith('erase-') || token.length < 8) {
    console.warn(
      `[reset] RESET_SHOP is set to "${token}", which is not a reset token — it must begin with "erase-", e.g. erase-2026-11-17. Nothing has been changed.`,
    );
    return { ran: false, reason: 'bad token' };
  }

  if (applied() === token) {
    // The ordinary case for every boot after the one that did the work.
    console.log(`[reset] ${token} has already been applied — nothing to do`);
    return { ran: false, reason: 'already applied' };
  }

  // Before, not after. If anything below fails, the thing that was about to
  // be destroyed is already on disk under its own name.
  const snapshot = await writeSnapshot();
  console.warn(`[reset] ${token}: snapshot written to ${snapshot.file} (${snapshot.bytes} bytes)`);

  const cleared = wipeTradingData();

  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES ('reset_applied', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(token, nowIso());

  const summary = Object.entries(cleared)
    .map(([table, n]) => `${table} ${n}`)
    .join(', ');
  console.warn(`[reset] ${token}: cleared ${summary || 'nothing — it was already empty'}`);
  console.warn('[reset] the next order will be ORD-00001');

  // Said out loud to whoever runs the shop, because this is not a thing to
  // discover from a log. Fire-and-forget: a shop that has just been wiped
  // must still finish booting if the message cannot be sent.
  void warnStaff(
    [
      `🧹 The shop's trading data has been cleared (${token}).`,
      summary ? `Removed: ${summary}.` : 'There was nothing to remove.',
      `A snapshot was written first: ${snapshot.file}`,
      'The next order will be ORD-00001.',
      '',
      'Remove RESET_SHOP from the environment — leaving it set is harmless, but it is one less thing to wonder about.',
    ].join(String.fromCharCode(10)),
  ).catch(() => {});

  return { ran: true, token, snapshot: snapshot.file, cleared };
}

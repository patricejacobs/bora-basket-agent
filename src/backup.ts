/**
 * Keeping a copy of the trading record.
 *
 * Every order, every customer and every saved address lives in one SQLite file
 * on one hosted disk. That is fine until the day it is not, and the thing that
 * makes it unrecoverable is not the orders — it is the addresses and pins, which
 * were typed once by a customer who will not type them again.
 *
 * Two layers, because they fail differently:
 *
 *   a snapshot on the disk  — survives a bad write, a bad migration, a mistaken
 *                             delete. Does NOT survive losing the disk, because
 *                             it is on the disk.
 *   a download off the disk — the only copy that survives the host. Taking it is
 *                             a human act; this module's job is to make it one
 *                             click rather than a shell session.
 *
 * The export is deliberately readable. A JSON dump restores; a CSV is what
 * somebody actually opens six months later when they need to know what an
 * address was, and it opens in Excel without being taught how.
 */
import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { db } from './db/index.ts';
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import { mapsLink } from './location.ts';
import { summariseStored } from './menu-options.ts';
import { sendDocument } from './channels/whatsapp-send.ts';

/* ------------------------------------------------------------------- CSV */

/**
 * One cell, escaped for RFC 4180 and defanged for spreadsheets.
 *
 * The quoting is ordinary. The leading apostrophe is not: customer names and
 * delivery notes are text typed by strangers over WhatsApp, and a cell opening
 * with `=` or `+` is a formula to Excel, not a name. Somebody who calls
 * themselves `=cmd|...` would otherwise be a live payload sitting in the shop's
 * own backup, waiting for the one person who opens it to click through a
 * warning.
 *
 * A plain number is exempt, and has to be: every longitude in Guyana is
 * negative, so guarding on a leading `-` turned the entire column into text
 * that Excel would not add up or plot. `-83.321167` is a number, not a
 * formula — but `-2+3` is not a plain number and stays guarded, so the
 * exemption cannot be used to smuggle an expression in.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

function cell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (!PLAIN_NUMBER.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values: unknown[]): string {
  return values.map(cell).join(',');
}

/**
 * The columns, in the order a person reads them: which order, who it was for,
 * where it went, who carried it, what was in it, what it cost.
 *
 * Money is written as plain minor units in its own column *and* formatted, so
 * the file is both arithmetic and legible. A spreadsheet can sum the first; a
 * human reads the second.
 */
const HEADER = [
  'Order',
  'Placed',
  'Status',
  'Type',
  'Customer',
  'Customer phone',
  'Contact phone',
  'Address',
  'Latitude',
  'Longitude',
  'Map',
  'Delivery note',
  'Restaurant',
  'Pickup address',
  'Uplifted by',
  'Delivered by',
  'Associate phone',
  'Associate vehicle',
  'Items',
  'Subtotal',
  'Delivery fee',
  'Total',
  'Total (formatted)',
  'Payment',
  'Recipient',
  'Recipient phone',
  'Parcel contents',
  'Ready at',
  'Uplifted at',
  'Kitchen handover',
  'Minutes to ready',
  'Minutes waiting for uplift',
  'Code sent',
  'Code verified',
  'Returned because',
  'Cancelled by',
  'Cancel reason',
  'Status changed',
];

/** An uplifting associate by name, or their number, or blank. */
function upliftName(phone: string): string {
  if (!phone) return '';
  const who = repo.getAssociate(phone);
  return who?.name ? `${who.name} +${phone}` : `+${phone}`;
}

/** Local wall-clock time in the store's own zone — the timestamps staff recognise. */
function localTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    timeZone: config.store.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** What was ordered, as one cell. Semicolons between lines, so commas stay safe. */
function itemsCell(order: repo.ArchivedOrder): string {
  if (order.kind === 'parcel') {
    return order.parcelDetails ? `Parcel: ${order.parcelDetails}` : 'Parcel';
  }
  return order.items
    .map((i) => {
      const chosen = summariseStored(i.options);
      return `${i.qty} x ${i.name}${chosen ? ` (${chosen})` : ''}`;
    })
    .join('; ');
}

/** Whole minutes between two stamps, or blank when either leg never happened. */
function gapMinutes(from: string, to: string): string {
  if (!from || !to) return '';
  const gap = (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
  return Number.isFinite(gap) && gap >= 0 ? String(Math.round(gap)) : '';
}

function orderRow(o: repo.ArchivedOrder): string {
  const pin = o.location;
  return csvRow([
    o.orderNo,
    localTime(o.placedAt),
    o.status,
    o.kind,
    o.customerName,
    o.phone,
    o.contactPhone,
    o.address,
    pin ? pin.latitude.toFixed(6) : '',
    pin ? pin.longitude.toFixed(6) : '',
    pin ? mapsLink(pin) : '',
    o.deliveryNote,
    o.outlet?.name ?? '',
    o.pickup?.address ?? '',
    // Who took it from the pickup and who finished it, which differ whenever
    // a job changed hands. The orders row alone shows only the second, as
    // though the first associate never had it - and on a parcel that first
    // associate is the one holding the money.
    upliftName(o.upliftedBy),
    o.driverName,
    o.driverPhone,
    o.driverVehicle,
    itemsCell(o),
    o.subtotal,
    o.deliveryFee,
    o.total,
    money(o.total),
    o.paymentMethod,
    o.recipientName,
    o.recipientPhone,
    o.parcelDetails,
    localTime(o.readyAt),
    localTime(o.upliftedAt),
    localTime(o.handedOverAt),
    // Plain numbers, so a spreadsheet can average them. Blank rather than
    // zero where the leg never happened: a zero would be averaged in and
    // would flatter every figure it touched.
    gapMinutes(o.placedAt, o.readyAt),
    gapMinutes(o.readyAt, o.upliftedAt),
    // Two columns, so the three cases stay distinguishable: no code issued,
    // a code the customer never received, and a code read back at the door.
    // One combined flag would file the middle case as a failure, and it is the
    // one nobody is at fault for.
    localTime(o.codeSentAt),
    localTime(o.codeVerifiedAt),
    o.returnReason,
    o.cancelledBy,
    o.cancelReason,
    localTime(o.statusChangedAt),
  ]);
}

/**
 * Every order as a spreadsheet.
 *
 * Starts with a byte-order mark because Excel on Windows otherwise reads UTF-8
 * as the local code page, and the first customer with an accent in their name
 * turns into mojibake in the permanent record.
 */
export function ordersCsv(): string {
  const rows = repo.allOrders().map(orderRow);
  return `﻿${[csvRow(HEADER), ...rows].join('\r\n')}\r\n`;
}

/**
 * Every event, oldest first: one row per thing that happened to an order.
 *
 * Its own file rather than more columns on the orders sheet, because an order
 * has one row and an unbounded number of events - a job that changed hands
 * twice has two transfers to account for, and widening the sheet to fit the
 * worst case leaves every other row mostly empty.
 */
const EVENT_HEADER = ['When', 'Order', 'What happened', 'Who', 'Their number', 'Detail'];

export function eventsCsv(): string {
  const rows = repo.allEvents().map((e) =>
    csvRow([
      localTime(e.at),
      e.orderNo,
      e.event,
      e.actorName,
      e.actor,
      e.detail,
    ]),
  );
  return `﻿${[csvRow(EVENT_HEADER), ...rows].join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ JSON */

/**
 * The same orders, complete and nested — items as items, pins as numbers.
 *
 * This is the one to keep if only one can be kept. The CSV flattens an order to
 * fit a row; this loses nothing, so it can rebuild the table.
 */
export function ordersJson(): string {
  const orders = repo.allOrders();
  return JSON.stringify(
    {
      store: config.store.name,
      currency: config.currency.code,
      // Totals are integer minor units; this is the divisor to read them by.
      minorUnitsPerDollar: config.currency.minorPerUnit,
      exportedAt: new Date().toISOString(),
      orderCount: orders.length,
      orders,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------- snapshots */

/** Where snapshots go: alongside the database unless told otherwise. */
export function backupDirectory(): string {
  if (config.backup.dir) return path.resolve(config.backup.dir);
  return path.join(path.dirname(path.resolve(config.databasePath)), 'backups');
}

/** `store-2026-11-10.db` — one per day, dated in the store's own timezone. */
function snapshotName(now = new Date()): string {
  const day = now.toLocaleDateString('en-CA', { timeZone: config.store.timezone });
  return `store-${day}.db`;
}

/**
 * A consistent copy of the whole database file.
 *
 * `backup()` uses SQLite's own online backup, so it is safe to run while the
 * agent is serving: it copies pages under a read lock rather than reading a
 * file somebody is mid-write on. A plain `cp` of a live SQLite file can produce
 * a torn copy that only reveals itself when you need it.
 *
 * Written to a temporary name and renamed on success, so an interrupted backup
 * can never replace yesterday's good one with half a file.
 */
export async function writeSnapshot(): Promise<{ file: string; bytes: number }> {
  const dir = backupDirectory();
  fs.mkdirSync(dir, { recursive: true });

  const final = path.join(dir, snapshotName());
  const temp = `${final}.partial`;
  if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });

  await backup(db, temp);
  fs.renameSync(temp, final);

  return { file: final, bytes: fs.statSync(final).size };
}

/** Oldest first, so trimming is a slice from the front. */
export function listSnapshots(): { file: string; bytes: number; modified: string }[] {
  const dir = backupDirectory();
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('store-') && f.endsWith('.db'))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { file: full, bytes: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Drops the oldest snapshots past the keep count.
 *
 * A keep count of 0 or less switches trimming off entirely, which is the right
 * behaviour for a disk somebody is managing by hand: never delete a backup
 * because a number was misread as zero.
 */
function trimSnapshots(): number {
  const keep = config.backup.keep;
  if (keep <= 0) return 0;

  const all = listSnapshots();
  const excess = all.slice(0, Math.max(0, all.length - keep));
  for (const old of excess) {
    try {
      fs.rmSync(old.file, { force: true });
    } catch (err) {
      console.error(`[backup] could not remove ${path.basename(old.file)}:`, err);
    }
  }
  return excess.length;
}

/**
 * Takes a snapshot now, then one every BACKUP_EVERY_HOURS.
 *
 * Immediately on boot, deliberately: a deploy is exactly when a schema change
 * lands, and the state just before one is the state worth having. It also means
 * a host that restarts the process regularly still produces backups even if the
 * interval never gets the chance to fire.
 *
 * Failures are logged and swallowed. A backup that cannot be written is bad; an
 * agent that stops taking orders because a backup failed is worse.
 */
export function startBackupSchedule(): void {
  if (config.backup.everyHours <= 0) {
    console.log('[backup] BACKUP_EVERY_HOURS=0 — automatic snapshots are off');
    return;
  }

  const run = async (): Promise<void> => {
    try {
      const { file, bytes } = await writeSnapshot();
      const dropped = trimSnapshots();
      console.log(
        `[backup] ${path.basename(file)} — ${Math.round(bytes / 1024)} KB` +
          (dropped > 0 ? `, ${dropped} old snapshot(s) removed` : ''),
      );
    } catch (err) {
      console.error('[backup] snapshot failed:', err);
    }
  };

  void run();
  const timer = setInterval(() => void run(), config.backup.everyHours * 3_600_000);
  timer.unref();

  startOffsiteSchedule();
}

/**
 * The off-site push, on its own clock.
 *
 * Separate from the snapshot schedule because the two protect against different
 * failures and want different frequencies - and because this one can fail for a
 * reason the local snapshot never can: WhatsApp refuses a business-initiated
 * message more than 24 hours after the recipient last wrote in. Staff send
 * commands to this number all day, so in practice the window is open; when it
 * is not, this says so plainly rather than appearing to have worked.
 *
 * Deliberately NOT run on boot, unlike the snapshot. A host that restarts the
 * process a few times would otherwise send the owner a backup each time.
 */
function startOffsiteSchedule(): void {
  if (config.backup.sendHours <= 0) {
    console.log('[backup] BACKUP_SEND_HOURS=0 — nothing is copied off the machine');
    return;
  }
  if (!config.backup.to && config.staffNumbers.length === 0) {
    console.warn(
      '[backup] off-site copies are on but there is nobody to send them to — set BACKUP_TO',
    );
  }

  const push = async (): Promise<void> => {
    try {
      const result = await sendOffsiteCopy();
      if (result === 'failed') {
        console.error(
          '[backup] the off-site copy did not go. If this is a 24-hour window error, send any message to the shop number and it will go on the next run.',
        );
      }
    } catch (err) {
      console.error('[backup] off-site copy threw:', err);
    }
  };

  const timer = setInterval(() => void push(), config.backup.sendHours * 3_600_000);
  timer.unref();
  console.log(`[backup] off-site copy every ${config.backup.sendHours}h`);
}

/* --------------------------------------------------------------- off-site */

/** `orders-2026-11-12` — dated in the store's own timezone. */
function exportStem(now = new Date()): string {
  return `orders-${now.toLocaleDateString('en-CA', { timeZone: config.store.timezone })}`;
}

export type OffsiteResult = 'sent' | 'no_recipient' | 'failed';

/**
 * Pushes a copy of the trading record off the machine, over WhatsApp.
 *
 * WhatsApp rather than email on purpose: the credentials already exist, so this
 * needs no new account, no SMTP host and no third service to go wrong - and it
 * lands on the phone the shop is already run from. A backup that requires
 * somebody to remember a password is a backup that stops happening.
 *
 * Two files, because they fail differently. The CSV is what a person opens six
 * months later to find out what an address was; the JSON is what rebuilds the
 * table, since flattening an order into a row loses the item lines.
 *
 * The file holds every customer's name, address and GPS pin. That is the point
 * of keeping it and the reason to be careful where it goes - which is why it is
 * sent to one number, not broadcast to staff.
 */
export async function sendOffsiteCopy(to = ''): Promise<OffsiteResult> {
  const recipient = (to || config.backup.to || config.staffNumbers[0] || '').replace(
    /[^0-9]/g,
    '',
  );
  if (!recipient) {
    console.warn('[backup] no off-site recipient — set BACKUP_TO or STAFF_NUMBERS');
    return 'no_recipient';
  }

  const count = repo.allOrders().length;
  const stem = exportStem();
  const encoder = new TextEncoder();

  const eventsOk = await sendDocument(recipient, {
    bytes: encoder.encode(eventsCsv()),
    filename: `${stem}-events.csv`,
    mime: 'text/csv',
    caption: 'Every hand-off and every close, in order. The orders file says where things ended; this says how they got there.',
  });

  const csvOk = await sendDocument(recipient, {
    bytes: encoder.encode(ordersCsv()),
    filename: `${stem}.csv`,
    mime: 'text/csv',
    caption: [
      `🗄️ *${config.store.name}* — ${count} ${count === 1 ? 'order' : 'orders'}`,
      '',
      'Keep this. It is the only copy that is not on the server.',
      'It holds customer names, addresses and map pins — do not forward it.',
    ].join(String.fromCharCode(10)),
  });

  // The restorable one. Sent second so the readable file is the one they see
  // first, and attempted even if the CSV failed - either arriving is better
  // than neither.
  const jsonOk = await sendDocument(recipient, {
    bytes: encoder.encode(ordersJson()),
    filename: `${stem}.json`,
    mime: 'application/json',
    caption: 'The same orders, complete. This is the file that can rebuild the database.',
  });

  void eventsOk;
  if (!csvOk && !jsonOk) {
    console.error('[backup] off-site copy failed — nothing left the machine');
    return 'failed';
  }
  console.log(`[backup] off-site copy sent to +${recipient} (${count} orders)`);
  return 'sent';
}

/* ------------------------------------------------------------------- CLI */

/**
 * `npm run backup` — writes the three files into the backup directory.
 *
 * For a machine with a shell. The hosted copy is taken by the schedule above
 * and fetched over HTTP.
 */
async function main(): Promise<void> {
  const dir = backupDirectory();
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10);
  const csv = path.join(dir, `orders-${stamp}.csv`);
  const json = path.join(dir, `orders-${stamp}.json`);
  const events = path.join(dir, `orders-${stamp}-events.csv`);

  fs.writeFileSync(csv, ordersCsv(), 'utf8');
  fs.writeFileSync(json, ordersJson(), 'utf8');
  fs.writeFileSync(events, eventsCsv(), 'utf8');
  const snap = await writeSnapshot();

  const count = repo.allOrders().length;
  console.log('');
  console.log(`  ${count} order(s) backed up to ${dir}`);
  console.log(`    ${path.basename(csv)}`);
  console.log(`    ${path.basename(json)}`);
  console.log(`    ${path.basename(events)}  (${repo.allEvents().length} event(s))`);
  console.log(
    `    ${path.basename(snap.file)}  (${Math.round(snap.bytes / 1024)} KB, whole database)`,
  );
  console.log('');
  console.log('  This is on the same machine as the database. Copy it somewhere else.');
  console.log('');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

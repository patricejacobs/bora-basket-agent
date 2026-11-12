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
  'Delivery associate',
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
  'Cancelled by',
  'Cancel reason',
  'Status changed',
];

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

  fs.writeFileSync(csv, ordersCsv(), 'utf8');
  fs.writeFileSync(json, ordersJson(), 'utf8');
  const snap = await writeSnapshot();

  const count = repo.allOrders().length;
  console.log('');
  console.log(`  ${count} order(s) backed up to ${dir}`);
  console.log(`    ${path.basename(csv)}`);
  console.log(`    ${path.basename(json)}`);
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

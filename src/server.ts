import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config, assertWhatsAppConfigured, money } from './config.ts';
import { productCount, photoCoverage, searchMissCount, listOutlets, menuItemCount, orderCounts } from './db/repo.ts';
import { importCsvText } from './catalog/import-csv.ts';
import { importOutletsText, importMenuText } from './catalog/import-menu.ts';
import { startStallWatch } from './stalls.ts';
import {
  ordersCsv,
  ordersJson,
  listSnapshots,
  writeSnapshot,
  backupDirectory,
  startBackupSchedule,
} from './backup.ts';
import { hoursStatus } from './hours.ts';
import { whatsappRouter, webhookStats } from './channels/whatsapp.ts';
import { sendStats } from './channels/whatsapp-send.ts';
import { simulatorRouter } from './channels/simulator.ts';
import { ensureImagesDirectory, imagesDirectory, refreshImages, imageCount } from './product-images.ts';

/**
 * Loads the catalogue from the committed CSV.
 *
 * Two modes. By default it only seeds an empty catalogue — first boot on a fresh
 * hosted disk. With CATALOG_SYNC_ON_BOOT it re-imports every time and
 * deactivates anything absent from the file, which makes the committed CSV the
 * source of truth: on a host with no shell, that is the only way to correct a
 * live catalogue, including removing a product that must not be sold.
 *
 * Deactivation is safe by construction — the importer skips it when no rows
 * parsed, so a truncated or unreadable CSV cannot empty the shop. Products are
 * marked inactive rather than deleted, so past orders keep their history.
 */
/**
 * Restaurants and menus, on the same principle as the grocery catalogue.
 *
 * Outlets first — a menu row names its outlet and is skipped if that outlet is
 * not there yet. Re-imported on every boot when syncing, since a menu changes
 * far more often than a shop's shelves and is the thing an owner will want to
 * correct from a commit rather than a shell they do not have.
 */
function loadMenus(): void {
  if (!config.seedOutletsPath || !config.seedMenuPath) return;

  const outletsFile = path.resolve(config.seedOutletsPath);
  const menuFile = path.resolve(config.seedMenuPath);
  for (const [name, file] of [
    ['SEED_OUTLETS_PATH', outletsFile],
    ['SEED_MENU_PATH', menuFile],
  ] as const) {
    if (!fs.existsSync(file)) {
      console.warn(`[menu] ${name} points at a missing file: ${file}`);
      return;
    }
  }

  const existing = listOutlets().length;
  if (existing > 0 && !config.catalogSyncOnBoot) return;

  try {
    const outlets = importOutletsText(fs.readFileSync(outletsFile, 'utf8'));
    const menu = importMenuText(fs.readFileSync(menuFile, 'utf8'));
    console.log(`[menu] ${outlets.imported} outlet(s), ${menu.items} menu item(s)`);

    for (const bad of [...outlets.skipped, ...menu.skipped].slice(0, 5)) {
      console.warn(`[menu] line ${bad.line}: ${bad.reason}`);
    }
    // Logged loudly on every boot, not once: an item WhatsApp prohibits is the
    // kind of thing that quietly reappears when somebody re-exports a menu.
    for (const refused of menu.refused) {
      console.log(`[menu] refused "${refused.name}" — ${refused.reason}`);
    }
  } catch (err) {
    console.error('[menu] import failed; outlets left as they were:', err);
  }
}

function loadCatalogue(): void {
  if (!config.seedCatalogPath) return;

  const file = path.resolve(config.seedCatalogPath);
  if (!fs.existsSync(file)) {
    console.warn(`[catalog] SEED_CATALOG_PATH points at a missing file: ${file}`);
    return;
  }

  const existing = productCount();
  const syncing = config.catalogSyncOnBoot;
  if (existing > 0 && !syncing) return;

  try {
    const result = importCsvText(
      fs.readFileSync(file, 'utf8'),
      syncing && existing > 0,
      config.restrictedSkus,
    );
    const mode = existing === 0 ? 'seeded empty catalogue' : 'synced from CSV';
    console.log(`[catalog] ${mode}: ${result.imported} product(s) from ${path.basename(file)}`);

    const excluded = result.skipped.filter((s) => s.reason.includes('restricted'));
    if (excluded.length > 0) {
      console.log(`[catalog] held back ${excluded.length} restricted SKU(s): ${config.restrictedSkus.join(', ')}`);
    }
    const other = result.skipped.length - excluded.length;
    if (other > 0) {
      console.warn(`[catalog] skipped ${other} bad row(s); run the importer locally to see why`);
    }
    if (syncing && existing > 0 && result.imported > 0) {
      console.log(`[catalog] anything absent from the CSV is now inactive (was ${existing}, now ${productCount()})`);
    } else if (syncing && result.imported === 0) {
      console.warn('[catalog] CSV yielded no rows — catalogue left untouched rather than emptied');
    }
  } catch (err) {
    console.error('[catalog] import failed, leaving the existing catalogue alone:', err);
  }
}

loadCatalogue();
loadMenus();
startStallWatch();
startBackupSchedule();

const app = express();
app.disable('x-powered-by');

// The raw body is kept so the WhatsApp webhook signature can be verified against
// the exact bytes Meta signed — a re-serialised object would not match.
app.use(
  express.json({
    // A base64 photo of a shopping list runs to several megabytes; the default
    // 100kb, and even 1mb, silently rejects them.
    limit: '8mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

/**
 * Health and configuration status.
 *
 * Reports only whether each secret is *present*, never its value — enough to
 * diagnose a half-configured deploy from outside without leaking anything. The
 * commit hash comes from Render and confirms which build is actually serving.
 */
app.get('/health', (_req: Request, res: Response) => {
  const wa = config.whatsapp;
  const whatsapp = {
    phoneNumberId: Boolean(wa.phoneNumberId),
    accessToken: Boolean(wa.accessToken),
    appSecret: Boolean(wa.appSecret),
    verifyToken: Boolean(wa.verifyToken),
  };

  res.json({
    ok: true,
    store: config.store.name,
    products: productCount(),
    productsWithPhotos: photoCoverage().withPhoto,
    localImageFiles: imageCount(),
    // A count only. The phrases themselves are customer-typed text and go to
    // staff over WhatsApp, not onto a public URL.
    unmetSearches30d: searchMissCount(30),
    menuItems: menuItemCount(),
    outlets: listOutlets().length,
    outletsTakingOrders: listOutlets().filter((o) => o.accepting).length,
    // Enough to diagnose "the kitchen never got its ticket" without a shell:
    // whether each outlet has somewhere to send one, and whether any order has
    // ever been placed. Booleans rather than the number itself — this URL is
    // public and a kitchen's phone number is not ours to publish.
    outletDetail: listOutlets().map((o) => ({
      code: o.code,
      name: o.name,
      kitchenNumber: Boolean(o.whatsapp),
      pickupPin: o.pickupLat !== null && o.pickupLng !== null,
      accepting: Boolean(o.accepting),
      open: hoursStatus(o.hours).state,
    })),
    orders: orderCounts(),
    // Whether the trading record is being copied, and how recently. Never the
    // token, and never a path to the data itself — a count and a timestamp are
    // enough to notice that backups have silently stopped.
    backup: {
      configured: Boolean(config.backup.token),
      snapshots: listSnapshots().length,
      latest: listSnapshots().at(-1)?.modified ?? null,
    },
    whatsappReady: Object.values(whatsapp).every(Boolean),
    config: {
      anthropicKey: Boolean(config.anthropic.apiKey),
      effort: config.anthropic.effort,
      whatsapp,
      simulatorEnabled: config.enableSimulator,
      // A count, never the numbers — enough to confirm dispatch is wired up.
      staffNumbers: config.staffNumbers.length,
      driverNumbers: config.driverNumbers.length,
      databasePath: config.databasePath,
    },
    webhooks: webhookStats,
    outbound: sendStats,
    commit: (process.env.RENDER_GIT_COMMIT ?? 'local').slice(0, 7),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Product photos. WhatsApp fetches these itself, so they must be public and
// unauthenticated — they are pictures of groceries, nothing sensitive.
ensureImagesDirectory();
app.use(
  '/images',
  express.static(imagesDirectory(), {
    dotfiles: 'deny',
    index: false,
    maxAge: '7d',
    // Falls through on a miss so a missing photo is a plain 404, not a 500 from
    // the error handler.
  }),
);

/**
 * The backup downloads.
 *
 * This is the one route on the service that hands out customer names, home
 * addresses and GPS pins in bulk, so it is the one route with a password. Three
 * rules, in order of how much they matter:
 *
 *   1. No token, no routes. Not a 401 — the paths simply do not exist, so a
 *      half-configured deploy cannot leave the customer list open while
 *      somebody means to get round to setting it.
 *   2. A short token is refused like no token at all. A four-character password
 *      on a URL that returns every address is worse than nothing, because it
 *      reads as protection.
 *   3. The comparison is timing-safe, and a wrong token gets a flat 404 — the
 *      same answer as an unconfigured service, so probing cannot tell the
 *      difference between "wrong password" and "no such thing here".
 */
const BACKUP_TOKEN_MIN = 24;

function mountBackupRoutes(): void {
  const token = config.backup.token;
  if (!token) {
    console.log('[backup] BACKUP_TOKEN is not set — download routes are off');
    return;
  }
  if (token.length < BACKUP_TOKEN_MIN) {
    console.warn(
      `[backup] BACKUP_TOKEN is only ${token.length} characters. Downloads stay off: this URL ` +
        `returns every customer address, so it needs at least ${BACKUP_TOKEN_MIN}.`,
    );
    return;
  }

  const expected = Buffer.from(token, 'utf8');

  /**
   * Accepts the token as a bearer header or as `?key=`.
   *
   * The query form exists because the person who needs this is holding a phone,
   * not a terminal, and a link they can tap is the difference between a backup
   * taken weekly and one taken never. The cost is real and worth stating: a URL
   * lands in the host's request log, so treat the link itself as the password
   * and rotate BACKUP_TOKEN if it goes anywhere it should not.
   */
  function authorised(req: Request): boolean {
    const header = req.get('authorization') ?? '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const supplied = bearer || String(req.query.key ?? '');
    if (!supplied) return false;

    const given = Buffer.from(supplied, 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself leak the
    // length, so the lengths are compared into the same boolean first.
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  const router = express.Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!authorised(req)) {
      res.sendStatus(404);
      return;
    }
    // Belt and braces for anything between here and the browser: a customer
    // list must not sit in a proxy cache or a history entry.
    res.set('Cache-Control', 'no-store, private');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  /** What there is to download, and when the last snapshot was taken. */
  router.get('/', (req: Request, res: Response) => {
    const key = String(req.query.key ?? '');
    const link = (p: string): string => (key ? `${p}?key=${encodeURIComponent(key)}` : p);
    const snapshots = listSnapshots();

    res.json({
      orders: orderCounts(),
      download: {
        spreadsheet: link('/backup/orders.csv'),
        json: link('/backup/orders.json'),
        database: link('/backup/store.db'),
      },
      snapshotsOnDisk: snapshots.length,
      latestSnapshot: snapshots.at(-1)?.modified ?? null,
      snapshotDirectory: backupDirectory(),
      note: 'Snapshots live on the same disk as the database. Download a copy to keep one elsewhere.',
    });
  });

  /** Every order as a spreadsheet. Dated filename, so copies do not overwrite. */
  router.get('/orders.csv', (_req: Request, res: Response) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="orders-${stamp}.csv"`);
    res.send(ordersCsv());
  });

  router.get('/orders.json', (_req: Request, res: Response) => {
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="orders-${stamp}.json"`);
    res.send(ordersJson());
  });

  /**
   * The whole database.
   *
   * A snapshot is taken on demand rather than serving yesterday's file, because
   * somebody who asks for the database wants the state now — and because
   * streaming the live file while SQLite is writing to it is how you get a
   * backup that restores into a corrupt database.
   */
  router.get('/store.db', async (_req: Request, res: Response) => {
    try {
      const snap = await writeSnapshot();
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="${path.basename(snap.file)}"`);
      res.sendFile(snap.file);
    } catch (err) {
      console.error('[backup] on-demand snapshot failed:', err);
      res.status(500).send('Could not take a snapshot. Check the service logs.');
    }
  });

  app.use('/backup', router);
  console.log('[backup] downloads at /backup (token required)');
}

mountBackupRoutes();

app.use('/whatsapp', whatsappRouter);

if (config.enableSimulator) {
  app.use('/simulator', simulatorRouter);
  app.get('/', (_req: Request, res: Response) => res.redirect('/simulator'));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] unhandled error:', err);
  if (!res.headersSent) res.sendStatus(500);
});

app.listen(config.port, () => {
  const missing = assertWhatsAppConfigured();
  const products = productCount();

  console.log('');
  console.log(`  ${config.store.name} — WhatsApp delivery agent`);
  console.log(`  listening on http://localhost:${config.port}`);
  console.log('');
  const photos = photoCoverage();
  const onDisk = refreshImages();
  // Split, because one total hides the thing an operator wants to check: that
  // the groceries are there AND that the restaurants arrived.
  const outlets = listOutlets();
  const menuItems = outlets.length === 0 ? 0 : menuItemCount();
  console.log(
    `  catalog       ${products - menuItems} grocery item(s), ${photos.withPhoto} with photo URLs`,
  );
  if (outlets.length > 0) {
    const paused = outlets.filter((o) => !o.accepting).length;
    console.log(
      `  restaurants   ${outlets.length} outlet(s), ${menuItems} menu item(s)` +
        (paused > 0 ? ` — ${paused} paused` : ''),
    );
  }
  console.log(`  images        ${onDisk} file(s) in ${imagesDirectory()}`);
  if (onDisk > 0 && !config.publicBaseUrl) {
    console.warn('  ! PUBLIC_BASE_URL is not set, so disk photos cannot be sent to WhatsApp.');
  }
  console.log(
    `  delivery      ${money(config.store.deliveryFee)}` +
      (config.store.freeDeliveryOver > 0 ? `, free over ${money(config.store.freeDeliveryOver)}` : ''),
  );
  console.log(`  model         ${config.anthropic.model} (effort: ${config.anthropic.effort})`);
  if (config.enableSimulator) {
    console.log(`  simulator     http://localhost:${config.port}/simulator`);
  }
  console.log(`  webhook       POST /whatsapp/webhook`);
  console.log('');

  if (!config.anthropic.apiKey) {
    console.warn('  ! ANTHROPIC_API_KEY is not set — the agent cannot reply until it is.');
  }
  if (products === 0) {
    console.warn('  ! Catalog is empty. Run: npm run import:catalog -- ./data/sample-products.csv');
  }
  if (missing.length > 0) {
    console.warn(`  ! WhatsApp not configured (${missing.join(', ')}). The simulator still works.`);
  }
  console.log('');
});

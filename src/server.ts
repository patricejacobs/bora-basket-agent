import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config, assertWhatsAppConfigured, money } from './config.ts';
import { productCount, photoCoverage } from './db/repo.ts';
import { importCsvText } from './catalog/import-csv.ts';
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
    whatsappReady: Object.values(whatsapp).every(Boolean),
    config: {
      anthropicKey: Boolean(config.anthropic.apiKey),
      effort: config.anthropic.effort,
      whatsapp,
      simulatorEnabled: config.enableSimulator,
      // A count, never the numbers — enough to confirm dispatch is wired up.
      staffNumbers: config.staffNumbers.length,
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
  console.log(`  ${config.store.name} — WhatsApp grocery agent`);
  console.log(`  listening on http://localhost:${config.port}`);
  console.log('');
  const photos = photoCoverage();
  const onDisk = refreshImages();
  console.log(
    `  catalog       ${products} active product(s), ${photos.withPhoto} with photo URLs`,
  );
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

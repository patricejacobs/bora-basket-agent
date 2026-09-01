import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config, assertWhatsAppConfigured, money } from './config.ts';
import { productCount } from './db/repo.ts';
import { importCsvText } from './catalog/import-csv.ts';
import { whatsappRouter, webhookStats } from './channels/whatsapp.ts';
import { simulatorRouter } from './channels/simulator.ts';

/** First boot on a hosted disk has no catalogue and often no shell to load one. */
function seedCatalogIfEmpty(): void {
  if (!config.seedCatalogPath || productCount() > 0) return;

  const file = path.resolve(config.seedCatalogPath);
  if (!fs.existsSync(file)) {
    console.warn(`[seed] SEED_CATALOG_PATH points at a missing file: ${file}`);
    return;
  }

  try {
    const result = importCsvText(fs.readFileSync(file, 'utf8'));
    console.log(`[seed] catalogue was empty — imported ${result.imported} product(s) from ${path.basename(file)}`);
    if (result.skipped.length > 0) {
      console.warn(`[seed] skipped ${result.skipped.length} row(s); run the importer locally to see why`);
    }
  } catch (err) {
    console.error('[seed] catalogue import failed:', err);
  }
}

seedCatalogIfEmpty();

const app = express();
app.disable('x-powered-by');

// The raw body is kept so the WhatsApp webhook signature can be verified against
// the exact bytes Meta signed — a re-serialised object would not match.
app.use(
  express.json({
    limit: '1mb',
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
    whatsappReady: Object.values(whatsapp).every(Boolean),
    config: {
      anthropicKey: Boolean(config.anthropic.apiKey),
      effort: config.anthropic.effort,
      whatsapp,
      simulatorEnabled: config.enableSimulator,
      databasePath: config.databasePath,
    },
    webhooks: webhookStats,
    commit: (process.env.RENDER_GIT_COMMIT ?? 'local').slice(0, 7),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

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
  console.log(`  catalog       ${products} active product(s)`);
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

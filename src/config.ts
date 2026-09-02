/** Central runtime configuration, read once at startup from the environment. */

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  return '';
}

function num(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function effortLevel(): Effort {
  const v = str('AGENT_EFFORT', 'low').toLowerCase();
  if (EFFORT_LEVELS.includes(v)) return v as Effort;
  console.warn(`[config] AGENT_EFFORT="${v}" is not a valid level; falling back to "low".`);
  return 'low';
}

const decimals = num('CURRENCY_DECIMALS', 0);
/** Multiplier between a display price (e.g. 12.50) and stored minor units (1250). */
const minorPerUnit = 10 ** decimals;

export const config = {
  port: num('PORT', 3000),
  databasePath: str('DATABASE_PATH', './data/store.db'),
  enableSimulator: bool('ENABLE_SIMULATOR', true),
  /**
   * CSV to import at startup when the catalogue is empty. A hosted deploy gets a
   * blank persistent disk on first boot and often has no shell to run the
   * importer from, so this is how the catalogue gets there. Ignored once any
   * product exists, so it never overwrites live data.
   */
  seedCatalogPath: str('SEED_CATALOG_PATH', ''),
  /**
   * Folder of product photos named by SKU (RIC-001.jpg). Served at /images and
   * used when a product has no image URL in the catalogue. On a hosted deploy
   * this belongs on the persistent disk, or photos vanish on every deploy.
   */
  productImagesDir: str('PRODUCT_IMAGES_DIR', './data/product-images'),
  /**
   * This server's own public address. WhatsApp fetches image URLs from its
   * servers, so a relative path would resolve against Meta rather than us.
   * Render provides RENDER_EXTERNAL_URL automatically.
   */
  publicBaseUrl: str('PUBLIC_BASE_URL', process.env.RENDER_EXTERNAL_URL ?? ''),
  /**
   * Re-import SEED_CATALOG_PATH on every boot, deactivating anything absent from
   * it. Makes the committed CSV the source of truth for a hosted deployment,
   * where there is no shell to run the importer from — without this, the seed
   * runs once and the live catalogue can never be corrected.
   */
  catalogSyncOnBoot: bool('CATALOG_SYNC_ON_BOOT', false),
  /**
   * SKUs kept out of the catalogue entirely. WhatsApp's Commerce Policy
   * prohibits alcohol and tobacco, and a strike can cost the phone number.
   */
  restrictedSkus: str('RESTRICTED_SKUS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Voice notes. Claude reads images and documents but not audio, so a voice
   * note must be transcribed first — the one external service in this project
   * besides Anthropic. Leave the provider as "none" and voice notes get a
   * polite "please type that" instead.
   */
  transcription: {
    provider: (['openai', 'deepgram'] as const).find(
      (p) => p === str('TRANSCRIBE_PROVIDER').toLowerCase(),
    ) ?? ('none' as const),
    openaiKey: str('OPENAI_API_KEY'),
    deepgramKey: str('DEEPGRAM_API_KEY'),
    /** Blank uses each provider's sensible default. */
    model: str('TRANSCRIBE_MODEL'),
  },

  anthropic: {
    apiKey: str('ANTHROPIC_API_KEY'),
    model: 'claude-opus-5',
    effort: effortLevel(),
    maxTokens: 4096,
    /** Hard stop so a confused model can never loop forever on one message. */
    maxToolIterations: 12,
  },

  whatsapp: {
    phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
    accessToken: str('WHATSAPP_ACCESS_TOKEN'),
    appSecret: str('WHATSAPP_APP_SECRET'),
    verifyToken: str('WHATSAPP_VERIFY_TOKEN'),
    graphVersion: str('WHATSAPP_GRAPH_VERSION', 'v23.0'),
  },

  /**
   * Staff who receive new-order alerts and may drive order status by texting the
   * shop number. E.164 digits, no '+', comma separated.
   */
  staffNumbers: str('STAFF_NUMBERS')
    .split(',')
    .map((n) => n.replace(/[^0-9]/g, ''))
    .filter(Boolean),

  /**
   * Approved WhatsApp template names, used when a customer notification falls
   * outside the 24-hour service window. Leave unset and out-of-window updates
   * are skipped rather than failing.
   */
  templates: {
    onTheWay: str('TEMPLATE_ORDER_ON_THE_WAY'),
    delivered: str('TEMPLATE_ORDER_DELIVERED'),
    language: str('TEMPLATE_LANGUAGE', 'en'),
  },

  /**
   * What the driver can take. Cash only by default. Anything the shop cannot
   * actually accept must not be offered — a customer told "card is fine" who
   * then cannot pay is a failed delivery and an argument on the doorstep.
   */
  paymentMethods: (() => {
    const raw = str('PAYMENT_METHODS', 'cash')
      .split(',')
      .map((m) => m.trim().toLowerCase())
      .filter((m) => m === 'cash' || m === 'card');
    return raw.length > 0 ? [...new Set(raw)] : ['cash'];
  })() as ('cash' | 'card')[],

  store: {
    name: str('STORE_NAME', 'Our Grocery Store'),
    hours: str('STORE_HOURS', 'Mon-Sat 8:00am - 8:00pm'),
    /** IANA zone, so the agent can greet by time of day and warn before closing. */
    timezone: str('STORE_TIMEZONE', 'America/Guyana'),
    deliveryAreas: str('DELIVERY_AREAS', 'local delivery area'),
    /** All money below is in minor units (see CURRENCY_DECIMALS). */
    deliveryFee: Math.round(num('DELIVERY_FEE', 0) * minorPerUnit),
    freeDeliveryOver: Math.round(num('FREE_DELIVERY_OVER', 0) * minorPerUnit),
    minOrderTotal: Math.round(num('MIN_ORDER_TOTAL', 0) * minorPerUnit),
  },

  currency: {
    code: str('CURRENCY_CODE', 'GYD'),
    symbol: str('CURRENCY_SYMBOL', '$'),
    decimals,
    minorPerUnit,
  },
} as const;

/** Format minor units for display, e.g. 125000 -> "$1,250". */
export function money(minorUnits: number): string {
  const value = minorUnits / config.currency.minorPerUnit;
  return (
    config.currency.symbol +
    value.toLocaleString('en-US', {
      minimumFractionDigits: config.currency.decimals,
      maximumFractionDigits: config.currency.decimals,
    })
  );
}

/** Parse a human price string ("1,250.50") into minor units. */
export function toMinorUnits(price: string | number): number {
  const n = typeof price === 'number' ? price : Number(String(price).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * config.currency.minorPerUnit);
}

/** Fail fast on missing config the given feature genuinely cannot run without. */
export function assertWhatsAppConfigured(): string[] {
  const missing: string[] = [];
  if (!config.whatsapp.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!config.whatsapp.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!config.whatsapp.verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');
  if (!config.whatsapp.appSecret) missing.push('WHATSAPP_APP_SECRET');
  return missing;
}

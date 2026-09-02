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

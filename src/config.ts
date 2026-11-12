/** Central runtime configuration, read once at startup from the environment. */
import { parseCoordinates, type ServiceArea } from './location.ts';

export type { ServiceArea };

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

  /**
   * Keeping a copy of the orders, customers and saved addresses.
   *
   * `token` is the only thing standing between a public URL and every
   * customer's home address, so the download routes are not mounted at all
   * unless it is set and long enough to be worth having. Unset is the safe
   * default: no endpoint rather than a weak one.
   *
   * `dir` defaults to a `backups` folder beside the database, which on a hosted
   * deploy means the persistent disk. That protects against a bad write, not
   * against losing the disk — the download is what covers that.
   */
  backup: {
    token: str('BACKUP_TOKEN'),
    dir: str('BACKUP_DIR', ''),
    keep: num('BACKUP_KEEP', 14),
    everyHours: num('BACKUP_EVERY_HOURS', 24),
  },
  enableSimulator: bool('ENABLE_SIMULATOR', true),
  /**
   * CSV to import at startup when the catalogue is empty. A hosted deploy gets a
   * blank persistent disk on first boot and often has no shell to run the
   * importer from, so this is how the catalogue gets there. Ignored once any
   * product exists, so it never overwrites live data.
   */
  seedCatalogPath: str('SEED_CATALOG_PATH', ''),
  /**
   * Restaurants and their menus, imported at boot for the same reason as the
   * grocery catalogue above: a hosted deploy has no shell, so a committed CSV
   * is the only way to add an outlet or correct a price. Re-read on every boot
   * when CATALOG_SYNC_ON_BOOT is set, which also makes it the way to take an
   * item off a menu.
   */
  seedOutletsPath: str('SEED_OUTLETS_PATH', ''),
  /**
   * The delivery associates by name and vehicle, on the same principle as the
   * outlets above. DRIVER_NUMBERS still decides who is sent a job; this says
   * who they are once one is taken.
   */
  seedAssociatesPath: str('SEED_ASSOCIATES_PATH', ''),
  /**
   * The same CSV, inline, for the real list.
   *
   * Names and mobile numbers of people who work for you are not catalogue
   * data, and this repository is public. A menu can be committed; a list of
   * employees cannot. Set in the host's dashboard, where the secrets live.
   *
   * Takes precedence over the file, so a sample can ship in the repository
   * without ever being mistaken for the real thing.
   */
  associates: str('ASSOCIATES', ''),
  seedMenuPath: str('SEED_MENU_PATH', ''),
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
   * Delivery associates. They receive a dispatch when food is cooked, and drive an order to
   * delivered by tapping buttons on it. Kept apart from STAFF_NUMBERS because
   * the jobs are different: staff run the shop and see everything, a delivery associate sees
   * the collection and the drop and nothing else.
   */
  driverNumbers: str('DRIVER_NUMBERS')
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
    /**
     * Reaches a kitchen whose 24-hour window has shut, which is most first
     * orders of the day: a restaurant has no reason to message the shop each
     * morning, so the window a customer opens by ordering does not exist here.
     *
     * One body variable, the order number. It carries no detail on purpose —
     * it exists to make the kitchen tap, and a tap reopens the window for the
     * real ticket.
     */
    kitchenNewOrder: str('TEMPLATE_KITCHEN_NEW_ORDER'),
    language: str('TEMPLATE_LANGUAGE', 'en'),
  },

  /**
   * What the delivery associate can take. Cash only by default. Anything the shop cannot
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

  /**
   * Only offer a job to associates within this many miles of the pickup.
   *
   * 0 disables it, which is the default. Switched on, it never excludes
   * somebody whose position is unknown or stale — an associate who has not
   * shared a pin would otherwise silently stop receiving work and nobody would
   * understand why. And if the filter leaves nobody at all, every associate is
   * told anyway: a long trip beats an order nobody hears about.
   */
  associateRadiusMiles: Math.max(0, num('ASSOCIATE_RADIUS_MILES', 0)),
  /** How long a known position is trusted before it counts as unknown. */
  associateLocationTtlMinutes: Math.max(5, num('ASSOCIATE_LOCATION_TTL_MINUTES', 180)),

  /**
   * How many deliveries one associate may hold at once. 0 means no limit.
   *
   * Off by default, because the obvious rule is wrong: several orders from one
   * kitchen are collected in a single trip, and refusing the second would stop
   * an associate doing exactly what they are standing there to do. A limit is
   * only sensible once it can tell a second pickup across town from a second
   * bag off the same counter.
   */
  maxJobsPerAssociate: Math.max(0, num('MAX_JOBS_PER_ASSOCIATE', 0)),

  /**
   * Watching for orders that have stopped moving.
   *
   * Every other stage of an order has somebody waiting on it who will chase:
   * a kitchen chases an unconfirmed ticket, a customer chases an undelivered
   * meal. "Cooked, waiting for a delivery associate" has nobody watching it, which is how
   * food goes cold on a counter while the system reports everything as normal.
   *
   * Each threshold is minutes in that status before staff are told. Set
   * STALL_ALERT_MINUTES to 0 to switch the whole thing off.
   */
  stalls: {
    /** Cooked and waiting for a delivery associate. The one this was built for. */
    readyMinutes: num('STALL_ALERT_MINUTES', 15),
    /** Placed and the kitchen has not accepted it. */
    pendingMinutes: num('STALL_PENDING_MINUTES', 10),
    /** With a delivery associate and still not delivered. */
    deliveryMinutes: num('STALL_DELIVERY_MINUTES', 60),
    /**
     * How often to look. A sweep rather than a timer per order: timers die with
     * the process, and an alarm that silently vanishes on deploy is worse than
     * none, because you believe you are covered.
     */
    sweepSeconds: num('STALL_SWEEP_SECONDS', 120),
  },

  /**
   * Parcel delivery pricing.
   *
   * Both default to 0, which means "not priced". The agent then takes the job
   * and says staff will confirm the cost before pickup, rather than inventing a
   * figure — a quoted price is a promise, and a wrong one is an argument on a
   * doorstep. Set a base, and optionally a rate per kilometre between the two
   * pins, to have it quote.
   */
  parcel: {
    baseFee: Math.round(num('PARCEL_FEE_BASE', 0) * minorPerUnit),
    perKm: Math.round(num('PARCEL_FEE_PER_KM', 0) * minorPerUnit),
    /** Beyond this the job needs a person to agree it. 0 disables the cap. */
    maxKm: num('PARCEL_MAX_KM', 0),
  },

  store: {
    name: str('STORE_NAME', 'Our Delivery Service'),
    hours: str('STORE_HOURS', 'Mon-Sat 8:00am - 8:00pm'),
    /** IANA zone, so the agent can greet by time of day and warn before closing. */
    timezone: str('STORE_TIMEZONE', 'America/Guyana'),
    deliveryAreas: str('DELIVERY_AREAS', 'local delivery area'),
    /**
     * The geofence every location pin is checked against: where the shop is,
     * and how far it will drive. `DELIVERY_AREAS` above is the same fact in
     * words for customers to read; this is the one a computer can check.
     *
     * Null unless both a valid centre and a positive radius are configured, and
     * a null fence accepts every pin. That default is deliberate: a shop that
     * has not drawn its area has not said a pin is unreachable, and a fence
     * enabled by accident — a missing variable, a radius of 0 — would refuse
     * every order in the city and look exactly like a broken bot.
     */
    serviceArea: (() => {
      const centre = parseCoordinates(str('SERVICE_CENTRE_LAT'), str('SERVICE_CENTRE_LNG'));
      const radiusKm = num('SERVICE_RADIUS_KM', 0);
      if (!centre) return null;
      if (!(radiusKm > 0)) return null;
      return { ...centre, radiusKm };
    })(),
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

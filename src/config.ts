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
    /**
     * How often to push a copy off the machine, in hours. 0 switches it off.
     *
     * The snapshots above live on the same disk as the database they protect.
     * That survives a bad write or a mistaken delete; it does not survive
     * losing the disk, which is the failure that ends a business rather than
     * inconveniencing it. This is the only copy that is somewhere else.
     */
    sendHours: num('BACKUP_SEND_HOURS', 24),
    /**
     * Who receives it. Defaults to the first staff number, since that is
     * whoever set the shop up.
     */
    to: str('BACKUP_TO', ''),
  },
  enableSimulator: bool('ENABLE_SIMULATOR', true),

  /**
   * Troubleshooting: tell the customer which telephone number moved their
   * order.
   *
   * Off, and it must stay off except while somebody is watching. It puts a
   * kitchen's telephone number into a customer's chat, which is not the
   * shop's to give away — it is here because "the restaurant never confirmed
   * that" is impossible to settle from the outside, and a line in the chat
   * the shop is already staring at settles it in one order.
   *
   * The server log carries the same fact on every status change whether this
   * is on or not, and so does the order's own history. This only exists for
   * when neither of those is to hand.
   */
  diagnoseSource: bool('DIAGNOSE_SOURCE', false),
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
   * Superseded. Read once, to seed the house grocery's own number.
   *
   * This used to be where a grocery order went to be picked, because a grocery
   * was not a shop: it had no record, so its telephone number had nowhere to
   * live but here, and the person holding it had to be staff before the
   * ticket's buttons would do anything.
   *
   * A grocery is an outlet now, with its number in its own row, so the number
   * lives in the database where a restaurant's does and the person holding it
   * needs no permissions at all. The migration in db/index.ts copies this
   * value into the house grocery the first time it runs, so a shop that had
   * configured it keeps working without touching anything.
   *
   * Nothing else reads this. Change the number with
   * `number GROCERY <digits>` or in the outlets CSV; changing it here after
   * the first boot does nothing.
   */
  groceryNumber: str('GROCERY_NUMBER', '').replace(/[^0-9]/g, ''),

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
   * Wipes the shop's trading data on the next boot. Empty means never.
   *
   * A token rather than a flag, and it must begin with `erase-`. Two reasons.
   * A value like `true` or `1` is a thing somebody sets while debugging
   * something else; `erase-` has to be typed on purpose. And the exact token
   * is written down once it has been applied, so leaving the variable in place
   * does nothing on the restarts that follow - a deploy, a crash, a plan
   * change - and the only way to wipe again is to change it. Without that,
   * a forgotten variable would erase a day's trading every time the service
   * happened to restart.
   *
   * Date it, so the record says when and so the next one differs:
   * `RESET_SHOP=erase-2026-11-17`.
   */
  resetShop: str('RESET_SHOP', '').trim(),

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
   * A job is offered outward in three rings, timed in seconds.
   *
   * First to whoever finished a delivery in the same band in the last few
   * minutes - they are standing there now. Then, if nobody takes it, to the
   * whole corridor, including the first group, who keep the card they already
   * have. Then to everybody.
   *
   * The waits are short on purpose. Every second of a stage is a second a
   * customer waits for a car nobody has accepted yet, and the cost of
   * widening too early is only that a job somebody nearer might have taken
   * goes to somebody further away. Set either wait to 0 to go straight out to
   * everyone, which is how this behaved before.
   */
  /**
   * What waiting costs on a taxi.
   *
   * The fare itself comes from the delivery tariff; this is the other half,
   * and the only part the shop sets by hand. TAXI_WAIT_PER_MINUTE at 0
   * removes the charge and the line on the driver's card with it, which is
   * the shop saying waiting is the driver's business too.
   */
  taxi: {
    /** Free minutes before the meter starts. 0 charges from the first. */
    waitFreeMinutes: Math.max(0, num('TAXI_WAIT_FREE_MINUTES', 0)),
    /**
     * What a minute of waiting costs.
     *
     * By the minute, not by the half hour. Blocks are easy to apply at a
     * kerb and wrong at both ends of the scale: a two-minute stop cost the
     * same $800 as a thirty-minute one, and the thirty-first minute doubled
     * the bill. A rate per minute is what a passenger thinks they are paying
     * for a car standing still.
     *
     * 0 removes the charge, and the line on the driver's card with it.
     */
    waitPerMinute: Math.round(Math.max(0, num('TAXI_WAIT_PER_MINUTE', 30)) * minorPerUnit),
  },

  /**
   * The quietest a customer is left between rating questions, per service.
   *
   * 0 asks after every delivery, which is what a shop testing the thing
   * wants and what a shop trading would regret: somebody who orders three
   * times a week and is asked three times a week mutes it.
   */
  ratingEveryDays: Math.max(0, num('RATING_EVERY_DAYS', 14)),

  dispatch: {
    bandMinutes: Math.max(0, num('DISPATCH_BAND_MINUTES', 5)),
    bandWaitSeconds: Math.max(0, num('DISPATCH_BAND_WAIT_SECONDS', 20)),
    corridorMinutes: Math.max(0, num('DISPATCH_CORRIDOR_MINUTES', 10)),
    corridorWaitSeconds: Math.max(0, num('DISPATCH_CORRIDOR_WAIT_SECONDS', 15)),
  },

  /**
   * How many deliveries one associate may hold at once. 0 means no limit.
   *
   * ONE by default, and 0 switches it off.
   *
   * The comment here used to say it was off by default, directly above a
   * default of one - which cost a day of diagnosis, since a shop whose
   * dispatch had silently stopped looked like it could not possibly be the
   * cap. Say what the line below actually does.
   *
   * Whether one is the right number is a separate argument, and a good one:
   * several orders from one kitchen are collected in a single trip, and
   * refusing the second stops an associate doing exactly what they are
   * standing there to do. A limit only earns its keep once it can tell a
   * second pickup across town from a second bag off the same counter. Set
   * MAX_JOBS_PER_ASSOCIATE=0 to take it off.
   */
  maxJobsPerAssociate: Math.max(0, num('MAX_JOBS_PER_ASSOCIATE', 1)),
  /**
   * How long a clock-in lasts before it lapses on its own.
   *
   * Somebody will forget to clock off, and the shop trades around the clock,
   * so a forgotten shift means job cards at three in the morning. After two of
   * those an associate mutes the chat and is lost for the shifts that matter.
   */
  dutyHours: Math.max(1, num('ASSOCIATE_DUTY_HOURS', 12)),
  /**
   * The most an associate may work in any rolling 24 hours.
   *
   * Rolling rather than per calendar day, because a limit that resets at
   * midnight lets somebody work eleven at night through to eleven the next
   * evening and never break it. Rolling closes that; a calendar day does not.
   *
   * 0 switches the cap off.
   */
  dutyHoursPerDay: Math.max(0, num('ASSOCIATE_MAX_HOURS_PER_DAY', 12)),
  /**
   * How long before a clock-in lapses the shop asks "still out?".
   *
   * The lapse protects somebody who forgot to clock off; it does nothing for
   * somebody still working, who just stops getting jobs without being told.
   * This is the question that closes that gap, and the same figure is the
   * grace AFTER the lapse: a question put hours late would reach somebody who
   * went home at midnight. 0 switches the asking off and the lapse goes back
   * to being silent.
   */
  dutyCheckInMinutes: Math.max(0, num('DUTY_CHECK_IN_MINUTES', 15)),
  /**
   * A busy few days, and the hours that go with them — with an end date.
   *
   * Both duty limits are raised to this figure until the date passes, and
   * then they are not. The date is the point: a cap lifted by hand is a cap
   * somebody has to remember to put back, and nobody remembers on the
   * Saturday of a busy week. This expires whether anyone is paying attention
   * or not.
   *
   * ASSOCIATE_HOURS_OVERRIDE=24 with
   * ASSOCIATE_HOURS_OVERRIDE_UNTIL=2026-11-21 means round the clock through
   * the end of the 21st, in the shop's own timezone, then back to twelve.
   */
  hoursOverride: Math.max(0, num('ASSOCIATE_HOURS_OVERRIDE', 0)),
  hoursOverrideUntil: str('ASSOCIATE_HOURS_OVERRIDE_UNTIL', '').trim(),
  /**
   * Whether a customer gets a four-digit code to read out at the door.
   *
   * Proof the right bag reached the right person, and - just as much - proof
   * for the associate that it did. A disputed delivery otherwise comes down to
   * two accounts of the same doorstep.
   *
   * It never blocks. An associate whose customer cannot produce the code can
   * deliver anyway; the order is recorded unverified and dispatch is told. Food
   * going cold at a door while somebody hunts for a message is a worse failure
   * than an unverified drop, and the record is what makes a pattern visible.
   */
  deliveryCode: bool('DELIVERY_CODE', true),

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
   * and says the delivery associate will confirm the cost at the pickup, rather
   * than inventing a figure — a quoted price is a promise, and a wrong one is an
   * argument on a doorstep. Set a base, and optionally a rate per kilometre
   * between the two pins, to have it quote.
   *
   * The associate rather than the shop, because the associate is the one who
   * turns up, sees the parcel and agrees a figure with the sender face to face.
   * Telling the customer the shop would do it left them waiting for a message
   * nobody was going to send.
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
     * The delivery tariff: a CSV of place, zone and fee, read on every boot.
     *
     * A file rather than an environment variable because it is a hundred and
     * eighty lines of village names that the shop will keep editing, and
     * because a price list belongs where the catalogue lives. Unset, or
     * missing, and delivery stays at the flat DELIVERY_FEE.
     */
    zonesPath: str('ZONES_PATH', './data/delivery-zones.csv'),
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
    /**
     * How far a pin may sit from the village it was sent for before the
     * shop asks about it.
     *
     * Deliberately wide. These villages are 600 metres apart at the median
     * and 1.7 km at the ninetieth percentile — Beterverwagting to Triumph is
     * 1.3 km — so anything tighter accuses people who pinned their own house
     * on a boundary, and a warning that cries wolf is a warning nobody
     * reads. At 8 km it catches the wrong corridor and the wrong side of the
     * river, which is the mistake that actually happens.
     *
     * 0 switches the check off.
     */
    pinToleranceKm: num('PIN_TOLERANCE_KM', 8),
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

/**
 * The duty limits in force right now.
 *
 * One function rather than reading the config in five places, because the
 * override has to apply to both limits or it does nothing useful: a rolling
 * cap of 24 hours with a clock-in that still lapses at 12 just means
 * somebody is clocked off at lunchtime and allowed to clock on again.
 *
 * The date is compared as the shop's own calendar day, so "until the 21st"
 * means through the end of the 21st in Georgetown and not 8pm on the 20th
 * because the server is in London.
 */
export function dutyLimits(now = new Date()): {
  /** How long a clock-in lasts before it lapses on its own. */
  lapseHours: number;
  /** The most an associate may work in any rolling 24 hours. 0 is no cap. */
  maxPerDay: number;
  /** Set while an override is in force, so it can be said out loud. */
  override: { hours: number; until: string } | null;
} {
  const { hoursOverride, hoursOverrideUntil, dutyHours, dutyHoursPerDay } = config;
  const normal = { lapseHours: dutyHours, maxPerDay: dutyHoursPerDay, override: null };
  if (hoursOverride <= 0 || !hoursOverrideUntil) return normal;

  const today = now.toLocaleDateString('en-CA', { timeZone: config.store.timezone });
  if (today > hoursOverrideUntil) return normal;

  return {
    lapseHours: hoursOverride,
    maxPerDay: hoursOverride,
    override: { hours: hoursOverride, until: hoursOverrideUntil },
  };
}

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

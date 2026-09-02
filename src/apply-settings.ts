/**
 * Applies store-settings.json to every place a setting lives.
 *
 *   npm run settings:apply
 *
 * Store settings were spread across .env (local) and render.yaml (deploy), which
 * drift apart silently. Worse, Render's dashboard overrides render.yaml for any
 * variable that already exists, so a pushed change can look applied and not be.
 * This makes the JSON the single source of truth, writes both files, and prints
 * exactly what to paste into the dashboard — the one step no script can do.
 *
 * Secrets are never touched. They stay in .env and the Render dashboard.
 */
import fs from 'node:fs';
import path from 'node:path';

const SETTINGS = path.resolve('./store-settings.json');
const ENV = path.resolve('./.env');
const RENDER = path.resolve('./render.yaml');

const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[90m${s}\x1b[0m`;

type Settings = {
  storeName: string;
  hours: string;
  timezone: string;
  deliveryAreas: string;
  deliveryFee: number;
  freeDeliveryOver: number;
  minOrderTotal: number;
  currency: { code: string; symbol: string; decimals: number };
  staffNumbers: string[];
  restrictedSkus: string[];
  templates: { onTheWay: string; delivered: string; language: string };
  agentEffort: string;
};

function die(message: string): never {
  console.error(`\n${red('Cannot apply settings')}\n  ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(SETTINGS)) die(`${SETTINGS} does not exist.`);

let settings: Settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) as Settings;
} catch (err) {
  die(`store-settings.json is not valid JSON — ${err instanceof Error ? err.message : err}`);
}

/* ------------------------------------------------------------- validation */

const problems: string[] = [];
const warnings: string[] = [];

const nonEmpty = (value: unknown, label: string): void => {
  if (typeof value !== 'string' || value.trim() === '') problems.push(`${label} must not be empty`);
};
const whole = (value: unknown, label: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    problems.push(`${label} must be a number of 0 or more`);
  }
};

nonEmpty(settings.storeName, 'storeName');
nonEmpty(settings.hours, 'hours');
nonEmpty(settings.timezone, 'timezone');
nonEmpty(settings.deliveryAreas, 'deliveryAreas');
whole(settings.deliveryFee, 'deliveryFee');
whole(settings.freeDeliveryOver, 'freeDeliveryOver');
whole(settings.minOrderTotal, 'minOrderTotal');

if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(settings.agentEffort)) {
  problems.push('agentEffort must be low, medium, high, xhigh or max');
}

try {
  new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone });
} catch {
  problems.push(`timezone "${settings.timezone}" is not a valid IANA zone (e.g. America/Guyana)`);
}

const decimals = settings.currency?.decimals;
if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
  problems.push('currency.decimals must be a whole number between 0 and 4');
}

// A threshold at or below the minimum makes delivery unconditionally free — legal,
// but almost always a typo rather than an intent.
if (settings.freeDeliveryOver > 0 && settings.freeDeliveryOver <= settings.minOrderTotal) {
  warnings.push('freeDeliveryOver is at or below minOrderTotal, so delivery is always free');
}

const badNumbers = (settings.staffNumbers ?? []).filter((n) => !/^\d{7,15}$/.test(n));
if (badNumbers.length > 0) {
  problems.push(`staffNumbers must be digits only, no '+' or spaces: ${badNumbers.join(', ')}`);
}
if ((settings.staffNumbers ?? []).length === 0) {
  warnings.push('staffNumbers is empty — nobody will be told when an order arrives');
}

// The defaults I scaffolded with. Shipping them means quoting invented prices.
if (settings.deliveryFee === 500 && settings.freeDeliveryOver === 10000 && settings.minOrderTotal === 1000) {
  warnings.push('delivery figures are still the scaffolded defaults — confirm they are your real prices');
}

if (problems.length > 0) {
  console.error(`\n${red('store-settings.json has problems:')}`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

/* --------------------------------------------------------------- the values */

const VALUES: Record<string, string> = {
  STORE_NAME: settings.storeName,
  STORE_HOURS: settings.hours,
  STORE_TIMEZONE: settings.timezone,
  DELIVERY_AREAS: settings.deliveryAreas,
  DELIVERY_FEE: String(settings.deliveryFee),
  FREE_DELIVERY_OVER: String(settings.freeDeliveryOver),
  MIN_ORDER_TOTAL: String(settings.minOrderTotal),
  CURRENCY_CODE: settings.currency.code,
  CURRENCY_SYMBOL: settings.currency.symbol,
  CURRENCY_DECIMALS: String(settings.currency.decimals),
  STAFF_NUMBERS: (settings.staffNumbers ?? []).join(','),
  TEMPLATE_ORDER_ON_THE_WAY: settings.templates?.onTheWay ?? '',
  TEMPLATE_ORDER_DELIVERED: settings.templates?.delivered ?? '',
  TEMPLATE_LANGUAGE: settings.templates?.language ?? 'en',
  AGENT_EFFORT: settings.agentEffort,
};

/* ------------------------------------------------------------------- .env */

const changed: string[] = [];

if (fs.existsSync(ENV)) {
  let env = fs.readFileSync(ENV, 'utf8');
  for (const [key, value] of Object.entries(VALUES)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(env)) {
      const current = env.match(pattern)?.[0];
      if (current !== line) changed.push(key);
      env = env.replace(pattern, line);
    } else {
      changed.push(key);
      env = env.trimEnd() + `\n${line}\n`;
    }
  }
  fs.writeFileSync(ENV, env);
  console.log(`${green('updated')} .env${changed.length > 0 ? dim(`  (${changed.length} changed)`) : dim('  (no changes)')}`);
} else {
  warnings.push('.env does not exist — copy .env.example first if you want to run locally');
}

/* -------------------------------------------------------------- render.yaml */

if (fs.existsSync(RENDER)) {
  let render = fs.readFileSync(RENDER, 'utf8');
  for (const [key, value] of Object.entries(VALUES)) {
    // Quote everything: YAML would otherwise read 500 as a number and an empty
    // value as null, and Render wants strings.
    const replacement = `      - key: ${key}\n        value: ${JSON.stringify(value)}`;
    // \r?\n because the file has picked up mixed line endings on Windows; a
    // bare \n silently fails to match a CRLF line and looks like a missing entry.
    const pattern = new RegExp(`      - key: ${key}\\r?\\n        value: .*`, 'm');
    if (pattern.test(render)) render = render.replace(pattern, replacement);
    else warnings.push(`render.yaml has no ${key} entry — add it by hand`);
  }
  fs.writeFileSync(RENDER, render);
  console.log(`${green('updated')} render.yaml`);
}

/* ------------------------------------------------------------------ output */

if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) console.log(`${yellow('warning')} ${w}`);
}

console.log('');
console.log('Paste these into Render → your service → Environment.');
console.log(dim('The dashboard overrides render.yaml for any variable that already exists,'));
console.log(dim('so pushing alone will not change a value that is already set there.'));
console.log('');
for (const [key, value] of Object.entries(VALUES)) {
  console.log(`  ${key}=${value}`);
}

const restricted = settings.restrictedSkus ?? [];
console.log('');
if (restricted.length > 0) {
  console.log(`Then reload the catalogue without the restricted SKUs (${restricted.join(', ')}):`);
  console.log('');
  console.log(
    `  npm run import:catalog -- ./data/sample-products.csv --deactivate-missing ${restricted
      .map((s) => `--exclude-sku ${s}`)
      .join(' ')}`,
  );
} else {
  console.log(`${yellow('warning')} restrictedSkus is empty — check nothing in the catalogue is alcohol or tobacco.`);
}
console.log('');

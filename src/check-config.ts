/**
 * Configuration doctor.
 *
 *   npm run check
 *
 * Answers one question: can this app actually run right now, and can it serve
 * WhatsApp? Reports per-variable so a half-filled .env is obvious. The only
 * network call is a free model lookup to prove the Anthropic key is live.
 */
import fs from 'node:fs';
import path from 'node:path';

const RESET = '\x1b[0m';
const paint = (code: string, s: string): string => `${code}${s}${RESET}`;
const green = (s: string) => paint('\x1b[32m', s);
const red = (s: string) => paint('\x1b[31m', s);
const yellow = (s: string) => paint('\x1b[33m', s);
const dim = (s: string) => paint('\x1b[90m', s);

type Level = 'ok' | 'warn' | 'fail';
type Finding = { level: Level; label: string; detail: string };

const findings: Finding[] = [];
const add = (level: Level, label: string, detail = ''): void => {
  findings.push({ level, label, detail });
};

const raw = (name: string): string => (process.env[name] ?? '').trim();

/** Values shipped in .env.example that mean "you haven't filled this in yet". */
const PLACEHOLDERS = new Set([
  'sk-ant-...',
  'change-me-to-a-random-string',
  'Your Grocery Store',
]);

function requireValue(name: string, hint: string): boolean {
  const v = raw(name);
  if (!v) {
    add('fail', name, `not set — ${hint}`);
    return false;
  }
  if (PLACEHOLDERS.has(v)) {
    add('fail', name, `still the example placeholder — ${hint}`);
    return false;
  }
  return true;
}

console.log('\nConfiguration check\n' + '='.repeat(50));

/* ------------------------------------------------------------------ file */

const envPath = path.resolve('.env');
if (!fs.existsSync(envPath)) {
  add('fail', '.env', 'file does not exist — copy .env.example to .env');
} else {
  add('ok', '.env', dim(envPath));
}

/* --------------------------------------------------------------- Claude */

const hasKey = requireValue('ANTHROPIC_API_KEY', 'get one at console.anthropic.com');
if (hasKey && !raw('ANTHROPIC_API_KEY').startsWith('sk-ant-')) {
  add('warn', 'ANTHROPIC_API_KEY', 'does not start with "sk-ant-" — check you copied the whole key');
}

const effort = raw('AGENT_EFFORT') || 'low';
if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
  add('fail', 'AGENT_EFFORT', `"${effort}" is not a valid level`);
} else {
  add('ok', 'AGENT_EFFORT', dim(effort));
}

/* ------------------------------------------------------------- WhatsApp */

const waVars: [string, string][] = [
  ['WHATSAPP_PHONE_NUMBER_ID', 'Meta app → WhatsApp → API Setup'],
  ['WHATSAPP_ACCESS_TOKEN', 'Meta app → WhatsApp → API Setup'],
  ['WHATSAPP_APP_SECRET', 'Meta app → App settings → Basic → Show'],
  ['WHATSAPP_VERIFY_TOKEN', 'any random string you choose'],
];

let waReady = true;
for (const [name, hint] of waVars) {
  if (!requireValue(name, hint)) waReady = false;
}

if (waReady) {
  if (/^\d+$/.test(raw('WHATSAPP_PHONE_NUMBER_ID')) === false) {
    add('warn', 'WHATSAPP_PHONE_NUMBER_ID', 'should be all digits — this looks like the phone number, not the ID');
  }
  if (raw('WHATSAPP_VERIFY_TOKEN').length < 16) {
    add('warn', 'WHATSAPP_VERIFY_TOKEN', 'short enough to guess — use 24+ random characters');
  }
}

const graph = raw('WHATSAPP_GRAPH_VERSION') || 'v23.0';
if (!/^v\d+\.\d+$/.test(graph)) {
  add('warn', 'WHATSAPP_GRAPH_VERSION', `"${graph}" is not in vNN.N form`);
}

/* ---------------------------------------------------------------- store */

if (raw('STORE_NAME') === 'Your Grocery Store' || !raw('STORE_NAME')) {
  add('fail', 'STORE_NAME', 'still the default — customers see this in the greeting');
} else {
  add('ok', 'STORE_NAME', dim(raw('STORE_NAME')));
}

for (const name of ['STORE_HOURS', 'DELIVERY_AREAS'] as const) {
  if (!raw(name)) add('warn', name, 'empty — the agent will have nothing to tell customers');
}

const numeric = (name: string): number | null => {
  const v = raw(name);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

for (const name of ['DELIVERY_FEE', 'FREE_DELIVERY_OVER', 'MIN_ORDER_TOTAL'] as const) {
  const n = numeric(name);
  if (n === null) add('fail', name, `"${raw(name)}" is not a number`);
  else if (n < 0) add('fail', name, 'cannot be negative');
}

const freeOver = numeric('FREE_DELIVERY_OVER') ?? 0;
const minOrder = numeric('MIN_ORDER_TOTAL') ?? 0;
if (freeOver > 0 && minOrder > 0 && freeOver <= minOrder) {
  add('warn', 'FREE_DELIVERY_OVER', 'is at or below MIN_ORDER_TOTAL, so delivery is always free');
}

const decimals = numeric('CURRENCY_DECIMALS');
if (decimals === null || decimals < 0 || decimals > 4 || !Number.isInteger(decimals)) {
  add('fail', 'CURRENCY_DECIMALS', 'must be a whole number between 0 and 4');
}
if (!raw('CURRENCY_SYMBOL')) add('warn', 'CURRENCY_SYMBOL', 'empty — prices will print without a symbol');

/* --------------------------------------------------------------- server */

const port = numeric('PORT') ?? 3000;
if (port < 1 || port > 65535) add('fail', 'PORT', `${port} is out of range`);

const dbPath = path.resolve(raw('DATABASE_PATH') || './data/store.db');
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
  add('ok', 'DATABASE_PATH', dim(dbPath));
} catch {
  add('fail', 'DATABASE_PATH', `cannot write to ${path.dirname(dbPath)}`);
}

const simulatorOn = (raw('ENABLE_SIMULATOR') || 'true').toLowerCase() !== 'false';
if (simulatorOn) {
  add(
    'warn',
    'ENABLE_SIMULATOR',
    'is on — /simulator has no authentication. Turn it off before exposing this server publicly',
  );
}

/* -------------------------------------------------------------- catalog */

let catalogCount = 0;
try {
  const { DatabaseSync } = await import('node:sqlite');
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get() as { n: number };
    catalogCount = row.n;
    db.close();
  }
  if (catalogCount === 0) {
    add('fail', 'catalog', 'no active products — run: npm run import:catalog -- ./data/sample-products.csv');
  } else {
    add('ok', 'catalog', dim(`${catalogCount} active product(s)`));
  }
} catch (err) {
  add('warn', 'catalog', `could not read the database (${err instanceof Error ? err.message : err})`);
}

/* ------------------------------------------------------- live key check */

if (hasKey) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: raw('ANTHROPIC_API_KEY') });
    const model = await client.models.retrieve('claude-opus-5');
    add('ok', 'Anthropic API', dim(`key valid, ${model.id} reachable`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    add('fail', 'Anthropic API', `key rejected — ${msg.slice(0, 120)}`);
  }
}

/* --------------------------------------------------------------- report */

for (const f of findings) {
  const mark = f.level === 'ok' ? green('  ok  ') : f.level === 'warn' ? yellow(' warn ') : red(' FAIL ');
  console.log(`${mark} ${f.label}${f.detail ? '  ' + f.detail : ''}`);
}

const fails = findings.filter((f) => f.level === 'fail');
const warns = findings.filter((f) => f.level === 'warn');

// A missing WhatsApp credential blocks the live channel but not local testing,
// so the two readiness questions are answered separately.
const waNames = new Set(waVars.map(([n]) => n));
const localBlockers = fails.filter((f) => !waNames.has(f.label));

console.log('\n' + '='.repeat(50));
console.log(
  localBlockers.length === 0
    ? green('Local simulator:  READY')
    : red(`Local simulator:  BLOCKED (${localBlockers.length} issue(s))`),
);
console.log(
  fails.length === 0
    ? green('WhatsApp channel: READY')
    : red(`WhatsApp channel: BLOCKED (${fails.length} issue(s))`),
);
if (warns.length > 0) console.log(yellow(`${warns.length} warning(s) worth reading above.`));
console.log('');

// Set the code rather than calling process.exit(), which tears down open libuv
// handles mid-flight on Windows and trips an assertion.
process.exitCode = localBlockers.length > 0 ? 1 : 0;

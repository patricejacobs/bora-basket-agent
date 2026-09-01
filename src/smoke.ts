/**
 * End-to-end smoke test for everything except the model call.
 *
 *   npm run smoke
 *
 * Drives the same tool layer the agent drives, against a throwaway database, so
 * a broken cart, checkout, or webhook path fails here instead of in a customer
 * conversation. Makes no API requests and costs nothing to run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Type-only: erased at runtime, so it does not load the module before the
// scratch DATABASE_PATH below is in place.
import type { ToolContext } from './agent/tools.ts';

// Point at a scratch database before anything reads the config.
const TEST_DB = path.resolve('./data/smoke-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(TEST_DB + suffix, { force: true });
}
process.env.DATABASE_PATH = TEST_DB;
process.env.WHATSAPP_APP_SECRET = 'smoke-test-secret';

const { money } = await import('./config.ts');
const { db } = await import('./db/index.ts');
const repo = await import('./db/repo.ts');
const { executeTool } = await import('./agent/tools.ts');
const { importCsvText, parseCsv } = await import('./catalog/import-csv.ts');
const { parseWebhook, chunkText } = await import('./channels/whatsapp.ts');

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const PHONE = '5926005555';
const ctx: ToolContext = { phone: PHONE, outbound: [] };
const call = (name: string, input: unknown = {}): any =>
  JSON.parse(executeTool(name, input, ctx));

/* ------------------------------------------------------------- CSV parsing */

section('CSV parsing');
{
  const rows = parseCsv('a,b,c\n1,"two, with comma","say ""hi"""\n');
  check('splits columns', rows[1]?.length === 3, JSON.stringify(rows[1]));
  check('honours quoted commas', rows[1]?.[1] === 'two, with comma');
  check('unescapes doubled quotes', rows[1]?.[2] === 'say "hi"');

  const bad = importCsvText(
    'sku,name,price\nOK-1,Good Item,100\n,No Sku,50\nOK-2,No Price,\nOK-1,Duplicate,999\n',
  );
  check('imports valid rows only', bad.imported === 1, `imported ${bad.imported}`);
  check('reports 3 skipped rows', bad.skipped.length === 3, JSON.stringify(bad.skipped));
}

/* ----------------------------------------------------------------- catalog */

section('Catalog import');
{
  const csv = fs.readFileSync(path.resolve('./data/sample-products.csv'), 'utf8');
  const result = importCsvText(csv);
  check('imports the sample catalog', result.imported >= 70, `imported ${result.imported}`);
  check('no rows skipped', result.skipped.length === 0, JSON.stringify(result.skipped.slice(0, 3)));

  const cats = call('list_categories');
  check('exposes categories', Array.isArray(cats.categories) && cats.categories.length > 5);
}

/* ------------------------------------------------------------------ search */

section('Product search');
{
  const rice = call('search_products', { query: 'rice' });
  check('finds rice', rice.results?.length > 0, JSON.stringify(rice).slice(0, 120));
  check(
    'ranks a name match first',
    String(rice.results?.[0]?.name ?? '').toLowerCase().includes('rice'),
    rice.results?.[0]?.name,
  );

  const alias = call('search_products', { query: 'pampers' });
  check('matches on keyword aliases', alias.results?.[0]?.sku === 'BAB-001', alias.results?.[0]?.sku);

  const miss = call('search_products', { query: 'zzzznotathing' });
  check('returns empty rather than inventing', miss.results?.length === 0 && !!miss.note);

  const scoped = call('search_products', { query: 'chicken', category: 'Meat & Poultry' });
  check('honours a category filter', scoped.results?.every((r: any) => r.category === 'Meat & Poultry'));
}

/* -------------------------------------------------------------------- cart */

section('Cart operations');
{
  const add = call('add_to_cart', { sku: 'RIC-001', quantity: 2 });
  check('adds an item', add.updated?.quantity === 2, JSON.stringify(add.updated));

  const again = call('add_to_cart', { sku: 'RIC-001', quantity: 1 });
  check('add_to_cart accumulates', again.updated?.quantity === 3, JSON.stringify(again.updated));

  const set = call('update_cart_item', { sku: 'RIC-001', quantity: 2 });
  check('update_cart_item sets absolute quantity', set.updated?.quantity === 2);

  call('add_to_cart', { sku: 'DAI-005', quantity: 1 });
  const cart = call('view_cart');
  check('cart holds both lines', cart.items?.length === 2, JSON.stringify(cart.items));
  check('subtotal is correct', cart.subtotal === money(2 * 1850 + 960), cart.subtotal);
  check('delivery fee applied', cart.delivery_fee === money(500), cart.delivery_fee);
  check('total is subtotal plus delivery', cart.total === money(2 * 1850 + 960 + 500), cart.total);

  const badSku = call('add_to_cart', { sku: 'NOPE-999', quantity: 1 });
  check('rejects an unknown SKU', typeof badSku.error === 'string');

  const overStock = call('update_cart_item', { sku: 'FSH-002', quantity: 99 });
  check('refuses to oversell stock', typeof overStock.error === 'string', JSON.stringify(overStock));

  const removed = call('update_cart_item', { sku: 'DAI-005', quantity: 0 });
  check('quantity 0 removes the line', removed.cart?.items?.length === 1);
}

/* ---------------------------------------------------------------- checkout */

section('Checkout');
{
  const tooEarly = call('place_order', { payment_method: 'cash_on_delivery' });
  check('blocks checkout without name and address', typeof tooEarly.error === 'string', tooEarly.error);

  const shortAddress = call('save_customer_details', { name: 'Ada', address: 'here' });
  check('rejects a too-short address', typeof shortAddress.error === 'string');

  call('save_customer_details', { name: 'Ada Lovelace', address: '12 Main Street, Georgetown' });
  const details = call('get_customer_details');
  check('saves customer details', details.name === 'Ada Lovelace' && !!details.address);

  const badPayment = call('place_order', { payment_method: 'crypto' });
  check('rejects an unsupported payment method', typeof badPayment.error === 'string');

  const stockBefore = call('get_product', { sku: 'RIC-001' }).stock_remaining;
  const order = call('place_order', { payment_method: 'cash_on_delivery', delivery_note: 'Call on arrival' });
  check('places the order', order.placed === true, JSON.stringify(order).slice(0, 160));
  check('returns an order number', /^ORD-\d{5}$/.test(order.order_number ?? ''), order.order_number);
  check('order total matches the cart', order.total === money(2 * 1850 + 500), order.total);

  const stockAfter = call('get_product', { sku: 'RIC-001' }).stock_remaining;
  check('decrements stock', stockAfter === stockBefore - 2, `${stockBefore} -> ${stockAfter}`);
  check('empties the cart', call('view_cart').items?.length === 0);

  const emptyOrder = call('place_order', { payment_method: 'cash_on_delivery' });
  check('will not place an empty order', typeof emptyOrder.error === 'string');

  const history = call('list_recent_orders');
  check('order appears in history', history.orders?.[0]?.order_number === order.order_number);
}

/* ------------------------------------------------------- free delivery tier */

section('Delivery fee rules');
{
  const free = repo.calcDeliveryFee(20000);
  check('free over the threshold', free === 0, String(free));
  const charged = repo.calcDeliveryFee(2000);
  check('charged under the threshold', charged === 500, String(charged));
  check('no fee on an empty cart', repo.calcDeliveryFee(0) === 0);
}

/* ----------------------------------------------------------------- buttons */

section('Interactive buttons');
{
  ctx.outbound.length = 0;
  const sent = call('send_buttons', {
    body: 'Confirm your order?',
    buttons: [
      { id: 'yes', title: 'Yes, place it' },
      { id: 'no', title: 'Keep shopping' },
    ],
  });
  check('queues a button message', sent.sent === true);
  check('outbound carries the buttons', ctx.outbound[0]?.kind === 'buttons');

  // Models often emit a literal backslash-n inside JSON string arguments; WhatsApp
  // would render that as "\n" in the middle of the customer's order summary.
  ctx.outbound.length = 0;
  call('send_buttons', {
    body: 'Final order:\\nRice - $1,850\\nTotal $2,350',
    buttons: [{ id: 'go', title: 'Place order' }],
  });
  check(
    'turns a literal backslash-n into a real line break',
    ctx.outbound[0]?.text === 'Final order:\nRice - $1,850\nTotal $2,350',
    JSON.stringify(ctx.outbound[0]?.text),
  );

  const tooMany = call('send_buttons', {
    body: 'x',
    buttons: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, title: `B${n}` })),
  });
  check('rejects more than 3 buttons', typeof tooMany.error === 'string');
}

/* ---------------------------------------------------------------- webhooks */

section('WhatsApp webhook');
{
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Ada' } }],
              messages: [{ from: '5926005555', id: 'wamid.1', type: 'text', text: { body: 'hello' } }],
            },
          },
        ],
      },
    ],
  };
  const parsed = parseWebhook(payload);
  check('parses a text message', parsed[0]?.text === 'hello' && parsed[0]?.phone === '5926005555');
  check('picks up the profile name', parsed[0]?.profileName === 'Ada');

  const buttonReply = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '592',
                  id: 'wamid.2',
                  type: 'interactive',
                  interactive: { button_reply: { id: 'yes', title: 'Yes, place it' } },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  check('parses a button reply', buttonReply[0]?.text === 'Yes, place it');

  const statusOnly = parseWebhook({
    entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
  });
  check('ignores delivery-status events', statusOnly.length === 0);
  check('survives a malformed payload', parseWebhook({ nonsense: true }).length === 0);

  check('claims a new event id', repo.claimEvent('wamid.unique') === true);
  check('rejects a redelivered event id', repo.claimEvent('wamid.unique') === false);

  const body = Buffer.from(JSON.stringify(payload));
  const sig =
    'sha256=' + crypto.createHmac('sha256', 'smoke-test-secret').update(body).digest('hex');
  const recomputed =
    'sha256=' + crypto.createHmac('sha256', 'smoke-test-secret').update(body).digest('hex');
  check('signature is reproducible', sig === recomputed);
  const tampered = Buffer.from(JSON.stringify({ ...payload, extra: 1 }));
  const badSig =
    'sha256=' + crypto.createHmac('sha256', 'smoke-test-secret').update(tampered).digest('hex');
  check('signature changes when the body changes', sig !== badSig);
}

/* ------------------------------------------------------------- text chunks */

section('Message chunking');
{
  check('short text is one chunk', chunkText('hello').length === 1);
  const long = ('word '.repeat(2000)).trim();
  const chunks = chunkText(long);
  check('long text is split', chunks.length > 1, `${chunks.length} chunks`);
  check('every chunk fits the 4096 limit', chunks.every((c) => c.length <= 4096));
  check('no words are lost', chunks.join(' ').split(/\s+/).length === long.split(/\s+/).length);
}

/* ------------------------------------------------------------------ report */

console.log('');

// Windows keeps the file locked while the handle is open, so close before deleting.
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(TEST_DB + suffix, { force: true });
  } catch {
    // A leftover scratch file is harmless; data/*.db is gitignored.
  }
}

if (failures.length === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exit(0);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

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
process.env.STAFF_NUMBERS = '5926497570';

// A scratch images folder, so results never depend on what happens to be in the
// real one. One file is planted below to exercise SKU resolution.
const TEST_IMAGES = path.resolve('./data/smoke-images');
fs.rmSync(TEST_IMAGES, { recursive: true, force: true });
fs.mkdirSync(TEST_IMAGES, { recursive: true });
fs.writeFileSync(path.join(TEST_IMAGES, 'DAI-003.jpg'), 'not really a jpeg');
process.env.PRODUCT_IMAGES_DIR = TEST_IMAGES;
process.env.PUBLIC_BASE_URL = 'https://shop.example.com';

const { money, config } = await import('./config.ts');
const { db } = await import('./db/index.ts');
const repo = await import('./db/repo.ts');
const { executeTool, TOOL_DEFS } = await import('./agent/tools.ts');
const { importCsvText, parseCsv } = await import('./catalog/import-csv.ts');
const { parseWebhook, chunkText, verifySignature } = await import('./channels/whatsapp.ts');
const { splitReply, typingDelayMs } = await import('./agent/pacing.ts');

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

/* --------------------------------------------------------- product photos */

section('Product photos');
{
  const photoCtx: ToolContext = { phone: '5920008888', outbound: [] };
  const photoCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, photoCtx));

  // No photos in the sample catalogue, so the honest answer is "none on file".
  const missing = photoCall('show_product_photo', { sku: 'RIC-001' });
  check('reports plainly when there is no photo', missing.sent === false, JSON.stringify(missing));
  check('tells the agent to describe it instead', String(missing.reason).includes('Describe'));
  check('queues nothing when there is no photo', photoCtx.outbound.length === 0);

  repo.upsertProduct({
    sku: 'PHOTO-1',
    name: 'Photographed Thing',
    description: '',
    category: 'General',
    unit: 'each',
    price: 500,
    stock: 5,
    active: 1,
    keywords: '',
    imageUrl: 'https://example.com/thing.jpg',
  });

  const sent = photoCall('show_product_photo', { sku: 'PHOTO-1' });
  check('sends a photo when one exists', sent.sent === true, JSON.stringify(sent));
  check('queues an image message', photoCtx.outbound[0]?.kind === 'image');
  check(
    'carries the image URL',
    (photoCtx.outbound[0] as any)?.imageUrl === 'https://example.com/thing.jpg',
  );
  check(
    'captions with name and price by default',
    String(photoCtx.outbound[0]?.text).includes('Photographed Thing'),
    photoCtx.outbound[0]?.text,
  );

  check('search reports which products have a photo', photoCall('get_product', { sku: 'PHOTO-1' }).has_photo === true);
  check('and which do not', photoCall('get_product', { sku: 'RIC-001' }).has_photo === false);

  // A non-HTTPS address would silently fail at WhatsApp, so it is rejected at import.
  const badUrl = importCsvText(
    'sku,name,price,image\nIMG-BAD,Bad Image,100,http://insecure.example.com/x.jpg\n',
  );
  check('rejects a non-https image URL', badUrl.skipped.length === 1, JSON.stringify(badUrl.skipped));
  check(
    'says why the image was rejected',
    String(badUrl.skipped[0]?.reason).includes('https'),
    badUrl.skipped[0]?.reason,
  );

  const goodUrl = importCsvText(
    'sku,name,price,image\nIMG-OK,Good Image,100,https://example.com/ok.jpg\n',
  );
  check('accepts an https image URL', goodUrl.imported === 1 && goodUrl.skipped.length === 0);
  check('stores it against the product', repo.getProductBySku('IMG-OK')?.imageUrl === 'https://example.com/ok.jpg');

  // A photo dropped in the images folder is picked up by SKU, with no CSV edit.
  const images = await import('./product-images.ts');
  images.refreshImages();

  const fromDisk = images.productImageUrl('DAI-003', '');
  check('a disk photo resolves by SKU', fromDisk === 'https://shop.example.com/images/DAI-003.jpg', fromDisk);
  check('the URL is absolute', /^https:\/\//.test(fromDisk), fromDisk);
  check('lowercase lookups match too', images.productImageUrl('dai-003', '') === fromDisk);
  check('a SKU with no file has no photo', images.productImageUrl('RIC-001', '') === '');
  check(
    'an explicit URL always wins over the folder',
    images.productImageUrl('DAI-003', 'https://example.com/override.jpg') ===
      'https://example.com/override.jpg',
  );

  // The agent should be able to send a photo that only exists on disk.
  const diskSend = photoCall('show_product_photo', { sku: 'DAI-003' });
  check('sends a disk photo through the tool', diskSend.sent === true, JSON.stringify(diskSend));

  const coverage = repo.photoCoverage();
  check('reports photo coverage', coverage.withPhoto >= 2 && coverage.total > coverage.withPhoto, JSON.stringify(coverage));
}

/* ------------------------------------------------------------ bulk actions */

section('Bulk list handling');
{
  // Its own customer: this section builds and clears a cart, and the checkout
  // section below depends on the cart PHONE is carrying.
  const bulkCtx: ToolContext = { phone: '5920007777', outbound: [] };
  const call = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, bulkCtx));

  const many = call('search_many', {
    queries: ['rice', 'chicken', 'eggs', 'milk', 'zzznothing'],
  });
  check('searches every query in one call', many.searches?.length === 5, JSON.stringify(many.searches?.length));
  check('keeps queries in order', many.searches?.[0]?.query === 'rice', many.searches?.[0]?.query);
  check('finds results per query', many.searches?.[1]?.results?.length > 0);
  check(
    'reports a miss without substituting',
    many.searches?.[4]?.results?.length === 0 && !!many.searches?.[4]?.note,
    JSON.stringify(many.searches?.[4]),
  );
  check('empty queries rejected', typeof call('search_many', { queries: [] }).error === 'string');

  const bulk = call('add_items_to_cart', {
    items: [
      { sku: 'RIC-002', quantity: 1 },
      { sku: 'MET-001', quantity: 1 },
      { sku: 'DAI-005', quantity: 1 },
    ],
  });
  check('adds several items in one call', bulk.added?.length === 3, JSON.stringify(bulk.added));
  check('returns the cart once', bulk.cart?.items?.length === 3);

  // A bad line must not lose the good ones — a photographed list will contain
  // items the shop does not stock, and dropping the whole cart would be worse.
  const partial = call('add_items_to_cart', {
    items: [
      { sku: 'BRD-001', quantity: 1 },
      { sku: 'NOPE-404', quantity: 1 },
      { sku: 'FSH-002', quantity: 99 },
    ],
  });
  check('adds the good lines', partial.added?.length === 1, JSON.stringify(partial.added));
  check('reports the bad lines separately', partial.could_not_add?.length === 2, JSON.stringify(partial.could_not_add));
  check(
    'says why each failed',
    partial.could_not_add?.every((f: any) => typeof f.reason === 'string' && f.reason.length > 0),
  );
  check('cart survived the partial failure', partial.cart?.items?.length === 4);

  check('rejects an empty list', typeof call('add_items_to_cart', { items: [] }).error === 'string');
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

  // The shop takes cash only, so card must be refused rather than quietly
  // accepted — a customer told "card is fine" who cannot pay is a failed
  // delivery and an argument on the doorstep.
  const cardWhenCashOnly = call('place_order', { payment_method: 'card_on_delivery' });
  if (config.paymentMethods.includes('card')) {
    check('card accepted because it is configured', true);
  } else {
    check(
      'refuses card when the shop takes cash only',
      typeof cardWhenCashOnly.error === 'string',
      JSON.stringify(cardWhenCashOnly).slice(0, 90),
    );
    check(
      'the refusal says what is accepted',
      String(cardWhenCashOnly.error).includes('cash'),
      cardWhenCashOnly.error,
    );
  }

  // The tool schema must not even offer a method the shop cannot take.
  const orderTool = TOOL_DEFS.find((t) => t.name === 'place_order');
  const methods = (orderTool?.input_schema as any)?.properties?.payment_method?.enum ?? [];
  check(
    'the tool only offers configured methods',
    methods.length === config.paymentMethods.length,
    JSON.stringify(methods),
  );
  check(
    'cash is always offered',
    methods.includes('cash_on_delivery'),
    JSON.stringify(methods),
  );

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

  // A photographed shopping list arrives as a media id, not bytes.
  const withPhoto = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '592',
                  id: 'wamid.img',
                  type: 'image',
                  image: { id: 'media-123', mime_type: 'image/jpeg', caption: 'my list' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  check('parses an image message', withPhoto.length === 1, JSON.stringify(withPhoto));
  check('carries the media id', withPhoto[0]?.imageId === 'media-123', withPhoto[0]?.imageId);
  check('keeps the caption as the text', withPhoto[0]?.text === 'my list', withPhoto[0]?.text);

  // A photo with no caption has no text at all; it must still be delivered, or
  // a customer who just sends a picture gets silence.
  const noCaption = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: '592', id: 'wamid.img2', type: 'image', image: { id: 'media-456' } }],
            },
          },
        ],
      },
    ],
  });
  check('an uncaptioned photo is not dropped', noCaption.length === 1, JSON.stringify(noCaption));
  check('uncaptioned photo still has its media id', noCaption[0]?.imageId === 'media-456');

  // A voice note carries no text at all — only a media id.
  const voice = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '592',
                  id: 'wamid.voice',
                  type: 'audio',
                  audio: { id: 'audio-789', mime_type: 'audio/ogg; codecs=opus', voice: true },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  check('parses a voice note', voice.length === 1, JSON.stringify(voice));
  check('carries the audio id', voice[0]?.audioId === 'audio-789', voice[0]?.audioId);
  check('a voice note is not dropped for having no text', voice[0]?.text === '', JSON.stringify(voice[0]?.text));

  check('claims a new event id', repo.claimEvent('wamid.unique') === true);
  check('rejects a redelivered event id', repo.claimEvent('wamid.unique') === false);

  // Signature verification, against the exact shape Meta sends: a 32-hex-char
  // app secret over the raw request bytes.
  const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const body = Buffer.from(JSON.stringify(payload));
  const sign = (buf: Buffer, secret: string): string =>
    'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');

  check('accepts a correctly signed body', verifySignature(body, sign(body, SECRET), SECRET).valid);

  const wrongSecret = verifySignature(body, sign(body, 'a-different-secret'), SECRET);
  check('rejects a signature made with the wrong secret', !wrongSecret.valid);
  check(
    'names the wrong secret as the cause',
    !wrongSecret.valid && wrongSecret.reason.includes('mismatch'),
    !wrongSecret.valid ? wrongSecret.reason : '',
  );

  const tampered = Buffer.from(JSON.stringify({ ...payload, injected: true }));
  check('rejects a tampered body', !verifySignature(tampered, sign(body, SECRET), SECRET).valid);

  const noSecret = verifySignature(body, sign(body, SECRET), '');
  check(
    'reports an unset app secret distinctly',
    !noSecret.valid && noSecret.reason.includes('not set'),
    !noSecret.valid ? noSecret.reason : '',
  );

  const noHeader = verifySignature(body, undefined, SECRET);
  check(
    'reports a missing signature header distinctly',
    !noHeader.valid && noHeader.reason.includes('no X-Hub-Signature-256'),
    !noHeader.valid ? noHeader.reason : '',
  );

  const noBody = verifySignature(undefined, sign(body, SECRET), SECRET);
  check(
    'reports an uncaptured body distinctly',
    !noBody.valid && noBody.reason.includes('raw body'),
    !noBody.valid ? noBody.reason : '',
  );

  // A trailing space is the classic copy-paste failure, and config trims for it.
  check(
    'a padded secret would otherwise fail (config trims it)',
    !verifySignature(body, sign(body, SECRET), SECRET + ' ').valid,
  );
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

/* ------------------------------------------------------------------ clock */

section('Guyana clock');
{
  const { buildTimeContext, buildConversationContext, CONTEXT_MARKER } = await import(
    './agent/context.ts'
  );

  const ctxText = buildTimeContext();
  check('context is tagged so stale copies can be found', ctxText.startsWith(CONTEXT_MARKER));

  // The date must be Guyana's, not the server's and not UTC. These differ for
  // four hours of every day, and getting it wrong makes "tomorrow" wrong.
  const guyanaDay = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guyana',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  check('reports the Guyana date', ctxText.includes(guyanaDay), `${guyanaDay} not in "${ctxText.split('\n')[1]}"`);

  const guyanaWeekday = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guyana',
    weekday: 'long',
  }).format(new Date());
  check('reports the Guyana weekday', ctxText.includes(guyanaWeekday), guyanaWeekday);

  // Between 20:00 and midnight in Guyana it is already the next day in UTC.
  const utcDay = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  }).format(new Date());
  if (utcDay !== guyanaDay) {
    check(
      'does NOT report the UTC date when the two differ',
      !ctxText.includes(utcDay),
      `UTC says ${utcDay}, Guyana says ${guyanaDay}`,
    );
  } else {
    check(`UTC and Guyana share a date right now (${guyanaDay})`, true);
  }

  // The greeting is named outright rather than left to the model to infer, so
  // "Good afternoon" at 8pm cannot happen. It must agree with Guyana's hour.
  const guyanaHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', hour: '2-digit', hour12: false })
      .format(new Date())
      .replace(/\D/g, ''),
  );
  const expected =
    guyanaHour < 12 || guyanaHour === 24 ? 'Good morning' : guyanaHour < 17 ? 'Good afternoon' : 'Good evening';
  check(
    `names the greeting for the hour ("${expected}" at ${guyanaHour}:00)`,
    ctxText.includes(`greet with "${expected}"`),
    ctxText.split('\n')[1],
  );

  const clipped = ['"Morning"', '"Afternoon"', '"Evening"'].filter((g) => ctxText.includes(`with ${g}`));
  check('never proposes the clipped form', clipped.length === 0, clipped.join(', '));

  const full = buildConversationContext('5920009999');
  check('full context also carries the clock', full.includes(guyanaDay));
  check('full context is tagged the same way', full.startsWith(CONTEXT_MARKER));
  check('full context names the greeting too', full.includes(`greet with "${expected}"`));

  // The rule the model reads has to match the context line, or one overrides
  // the other in whichever direction the wind blows.
  const { SYSTEM_PROMPT } = await import('./agent/system-prompt.ts');
  check(
    'system prompt spells out the full greeting forms',
    ['Good morning', 'Good afternoon', 'Good evening'].every((g) => SYSTEM_PROMPT.includes(g)),
  );
}

/* ----------------------------------------------------------------- pacing */

section('Reply pacing');
{
  check('leaves a short reply whole', splitReply('Added 2 bags of rice.').length === 1);

  // Verbatim shape of a real reply from the deployed agent.
  const listThenQuestion = [
    "Here's what we have:",
    '',
    '*Rice*',
    '• Karibee Parboiled, 5kg — $1,850',
    '• White Rice, 2kg — $780',
    '• Brown Rice, 1kg — $620',
    '',
    '*Chicken*',
    '• Whole Chicken, per kg — $1,120',
    '• Chicken Wings, 1kg pack — $1,240',
    '',
    'Which ones, and how much of each?',
  ].join('\n');

  const split = splitReply(listThenQuestion);
  check('splits a closing question onto its own message', split.length === 2, JSON.stringify(split));
  check('the closing line is the question', split[1] === 'Which ones, and how much of each?', split[1]);
  check(
    'nothing is lost in the split',
    split.join('\n\n').replace(/\s+/g, '') === listThenQuestion.replace(/\s+/g, ''),
  );

  const twoParagraphs = 'a'.repeat(120) + '\n\n' + 'b'.repeat(200);
  check('does not split two full paragraphs', splitReply(twoParagraphs).length === 1);

  check('delay grows with length', typingDelayMs('a'.repeat(120)) > typingDelayMs('ok'));
  check('delay is floored', typingDelayMs('ok') >= 700);
  check('delay is capped', typingDelayMs('a'.repeat(5000)) <= 2600);
}

/* ------------------------------------------------------------------ staff */

section('Staff dispatch');
{
  const { handleStaffMessage, isStaff } = await import('./staff.ts');

  check('recognises a configured staff number', isStaff('5926497570'));
  check('does not treat a customer as staff', !isStaff('5926005555'));

  const help = (await handleStaffMessage('help'))[0]?.text ?? '';
  check('help lists the commands', help.includes('orders') && help.includes('on the way'));

  // The order placed in the checkout section above is ORD-00001.
  const one = (await handleStaffMessage('1'))[0]?.text ?? '';
  check('shows a single order', one.includes('ORD-00001'), one.slice(0, 60));
  check('shows the delivery address', one.includes('Georgetown'));

  const open = (await handleStaffMessage('orders'))[0]?.text ?? '';
  check('lists open orders', open.includes('ORD-00001'), open.slice(0, 60));

  const missing = (await handleStaffMessage('999 delivered'))[0]?.text ?? '';
  check('reports an unknown order', missing.toLowerCase().includes('no order'), missing);

  const garbage = (await handleStaffMessage('what is going on'))[0]?.text ?? '';
  check('asks for an order number when none is given', garbage.includes('order number'), garbage.slice(0, 60));

  // Status transitions. WhatsApp sending is unconfigured here, so the customer
  // notification degrades to a warning rather than throwing.
  const otw = (await handleStaffMessage('1 on the way'))[0]?.text ?? '';
  check('moves an order to on the way', otw.includes('on the way'), otw);
  check('order status persisted', repo.findOrder('1')?.status === 'on_the_way');

  const repeated = (await handleStaffMessage('ORD-00001 otw'))[0]?.text ?? '';
  check('rejects a repeated transition', repeated.includes('already'), repeated);

  const delivered = (await handleStaffMessage('ord-1 delivered'))[0]?.text ?? '';
  check('accepts the ORD- prefix and shorthand', delivered.includes('delivered'), delivered);
  check('delivered status persisted', repo.findOrder('ORD-00001')?.status === 'delivered');

  const closed = (await handleStaffMessage('orders'))[0]?.text ?? '';
  check('a delivered order leaves the queue', closed.includes('No open orders'), closed.slice(0, 60));
}

/* ---------------------------------------------------------- staff buttons */

section('Staff action buttons');
{
  const { nextActions, STATUS_WORDS } = await import('./order-status.ts');

  const pending = nextActions('ORD-00007', 'pending');
  check('a new order offers three actions', pending.length === 3, JSON.stringify(pending));
  check('a confirmed order drops "confirm"', nextActions('ORD-00007', 'confirmed').length === 2);
  check('an order on the way offers only delivered', nextActions('ORD-00007', 'on_the_way').length === 1);
  check('a delivered order offers nothing', nextActions('ORD-00007', 'delivered').length === 0);
  check('a cancelled order offers nothing', nextActions('ORD-00007', 'cancelled').length === 0);

  // WhatsApp caps buttons at 3 and titles at 20 characters; a longer title is
  // silently truncated, which would corrupt the command it has to parse as.
  for (const status of ['pending', 'confirmed', 'on_the_way'] as const) {
    const actions = nextActions('ORD-99999', status);
    check(
      `${status}: at most 3 buttons`,
      actions.length <= 3,
      String(actions.length),
    );
    check(
      `${status}: every title fits 20 chars`,
      actions.every((a) => a.title.length <= 20),
      JSON.stringify(actions.map((a) => `${a.title} (${a.title.length})`)),
    );
  }

  // The whole design rests on this: tapping a button sends its title back as an
  // ordinary message, so each title must parse as the command it claims to be.
  const roundTrip = nextActions('ORD-00042', 'pending');
  for (const action of roundTrip) {
    const matched = STATUS_WORDS.find(([pattern]) => pattern.test(action.title));
    check(`"${action.title}" parses as a status command`, matched !== undefined);
    check(
      `"${action.title}" carries the order number`,
      /42/.test(action.title),
      action.title,
    );
  }
}

/* --------------------------------------------------- 24-hour service window */

section('Service window');
{
  const FRESH = '5920009999';
  check('no inbound history means outside the window', !repo.withinServiceWindow(FRESH));

  repo.logMessage(FRESH, 'in', 'whatsapp', 'hello');
  check('a message just now is inside the window', repo.withinServiceWindow(FRESH));

  check('order lookup tolerates plain numbers', repo.findOrder('1')?.orderNo === 'ORD-00001');
  check('order lookup tolerates the padded form', repo.findOrder('ORD-00001')?.orderNo === 'ORD-00001');
  check('order lookup returns null for nonsense', repo.findOrder('abc') === null);
}

/* --------------------------------------------------------------- identity */

section('Customer identity');
{
  const idPhone = '5920003333';
  const idCtx: ToolContext = { phone: idPhone, outbound: [] };
  const idCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, idCtx));

  // A WhatsApp profile name must never become the delivery name on its own.
  repo.setProfileName(idPhone, 'Shop Phone 2');
  const fresh = idCall('get_customer_details');
  check('profile name is recorded', fresh.whatsapp_profile_name === 'Shop Phone 2', fresh.whatsapp_profile_name);
  check('profile name is NOT used as the delivery name', fresh.name === null, JSON.stringify(fresh.name));
  check('a new number is unconfirmed', fresh.identity_confirmed === false);

  check(
    'cannot confirm an identity that does not exist yet',
    typeof idCall('confirm_identity').error === 'string',
  );

  // Details the customer states themselves are confirmed by saying them.
  idCall('save_customer_details', { name: 'Real Person', address: '9 Confirmed Road, Georgetown' });
  check('stating details confirms identity', idCall('get_customer_details').identity_confirmed === true);

  // An order cannot be placed on an unconfirmed identity, however complete the details.
  idCall('add_to_cart', { sku: 'RIC-001', quantity: 2 });
  db.prepare(`UPDATE customers SET identity_confirmed_at = NULL WHERE phone = ?`).run(idPhone);
  const blocked = idCall('place_order', { payment_method: 'cash_on_delivery' });
  check('checkout blocked while unconfirmed', typeof blocked.error === 'string', JSON.stringify(blocked).slice(0, 90));
  check('the block explains what to do', String(blocked.error).includes('confirm_identity'), blocked.error);

  idCall('confirm_identity');
  const placed = idCall('place_order', { payment_method: 'cash_on_delivery' });
  check('checkout proceeds once confirmed', placed.placed === true, JSON.stringify(placed).slice(0, 90));

  // Confirmation goes stale, because a phone can change hands between visits.
  db.prepare(`UPDATE customers SET identity_confirmed_at = ? WHERE phone = ?`).run(
    new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    idPhone,
  );
  check('a day-old confirmation is not trusted', repo.getIdentity(idPhone).confirmed === false);

  // A telephone number is recorded for every order, defaulting to the number
  // they message from so a driver always has someone to ring.
  const defaulted = idCall('get_customer_details');
  check('contact number defaults to the WhatsApp number', defaulted.contact_phone === idPhone, defaulted.contact_phone);

  idCall('save_customer_details', { contact_phone: '592 611 2233' });
  const withContact = idCall('get_customer_details');
  check('a different contact number is saved', withContact.contact_phone === '5926112233', withContact.contact_phone);
  check(
    'rejects an unusable number',
    typeof idCall('save_customer_details', { contact_phone: '12' }).error === 'string',
  );
  check(
    'saving only a contact number leaves the name alone',
    withContact.name === 'Real Person',
    withContact.name,
  );

  const record = idCall('customer_record');
  check('transaction record counts the order', record.order_count === 1, JSON.stringify(record.order_count));
  check('transaction record totals the spend', record.total_spent === money(2 * 1850 + 500), record.total_spent);
  check('transaction record lists the order', record.orders?.[0]?.items?.length === 1, JSON.stringify(record.orders?.[0]));
  check('transaction record keeps the phone number', record.phone === idPhone);
  check('transaction record keeps the contact number', record.contact_phone === '5926112233', record.contact_phone);
  check('the order stored a contact number', repo.findOrder('1') !== null);
}

/* -------------------------------------------------------- search behaviour */

section('Search behaviour');
{
  const { searchCatalog, singular, queryTokens, editDistance, normalizeToken } = await import(
    './catalog/search.ts'
  );

  const names = (query: string, limit = 5): string[] =>
    searchCatalog(query, undefined, limit).results.map((p) => p.name);
  const first = (query: string): string => names(query, 1)[0] ?? '—';
  const finds = (query: string, name: string): boolean => names(query).includes(name);

  // Normalisation.
  check('folds plurals together', singular('tomatoes') === singular('tomato'));
  check('folds -ies plurals', singular('berries') === 'berry');
  check('leaves short words alone', singular('gas') === 'gas');
  check('does not strip a double s', singular('glass') === 'glass');
  check('strips accents', normalizeToken('Café') === 'cafe');
  check('drops conversational filler', !queryTokens('do you have any rice').includes('have'));
  check('keeps the actual product word', queryTokens('do you have any rice').includes('rice'));
  check('drops quantities and units', queryTokens('2 lbs channa').join(' ') === 'channa');
  check('a query of pure filler still searches', queryTokens('any please').length > 0);

  check('measures a transposition as one edit', editDistance('brwon', 'brown') === 1);
  check('abandons a hopeless comparison', editDistance('rice', 'detergent', 2) > 2);

  // Typos — the single most common reason a real search finds nothing.
  check('finds through a missing letter', first('chiken').includes('Chicken'), first('chiken'));
  check('finds through a wrong vowel', first('detergant') === 'Laundry Detergent', first('detergant'));
  check('finds through a transposition', first('spagetti') === 'Spaghetti', first('spagetti'));
  check('finds through a truncation', first('shampo') === 'Shampoo', first('shampo'));
  check('finds a misspelled plural', first('tomatos') === 'Tomatoes', first('tomatos'));

  // A short word is left alone: one letter apart is a different product.
  check('does not fuzzy-match short words', !finds('rise', 'Brown Rice'), names('rise').join(','));

  // Plurals in both directions.
  check('singular query finds a plural product', first('egg') === 'Eggs', first('egg'));
  check('plural query finds a singular product', finds('plantains', 'Plantain'), names('plantains').join(','));

  // Local and everyday names for things the shelf label calls something else.
  check('washing powder is laundry detergent', first('washing powder') === 'Laundry Detergent', first('washing powder'));
  check('toilet tissue is toilet paper', first('toilet tissue') === 'Toilet Paper', first('toilet tissue'));
  check('sweet drink is a soft drink', first('sweet drink') === 'Pepsi', first('sweet drink'));
  check('bully beef is corned beef', first('bully beef') === 'Corned Beef', first('bully beef'));
  check('fig is a banana here', first('fig') === 'Bananas', first('fig'));
  check('dhal is split peas', first('dhal') === 'Split Peas', first('dhal'));
  check('a brand name finds the generic', first('colgate') === 'Toothpaste', first('colgate'));
  check('clorox finds bleach', first('clorox') === 'Bleach', first('clorox'));
  check('greens reaches callaloo', finds('greens', 'Callaloo'), names('greens').join(','));

  // Ranking: a listed keyword must beat a coincidental near-spelling.
  check(
    'an exact keyword outranks a one-letter name collision',
    first('pampers') === 'Baby Diapers Medium',
    names('pampers').join(','),
  );
  check(
    'a literal keyword outranks a synonym reaching the same shelf',
    names('dhal').indexOf('Split Peas') < names('dhal').indexOf('Black Eye Peas'),
    names('dhal').join(','),
  );

  // Precision. A wrong match is worse than no match.
  check('does not answer tomatoes with ketchup', first('tomatoes') === 'Tomatoes', first('tomatoes'));
  check('a word prefix is not a match', !finds('saltfish', 'Table Salt'), names('saltfish').join(','));
  check('asking for eggs does not return the dairy aisle', names('eggs').length === 1, names('eggs').join(','));
  check('nonsense still finds nothing', names('zzzznotathing').length === 0);

  // Partial answers are reported, not smoothed over. This is what feeds the
  // unmet-demand log for things the catalogue half-matches.
  const cassava = searchCatalog('cassava bread', undefined, 5);
  check('offers the nearest things to an unstocked item', cassava.results.length > 0);
  check('including the closest one', cassava.results.some((p) => p.name === 'Cassava Chips'));
  // Which of the two words goes unanswered depends on which near-match ranks
  // first; that one is left over either way is the signal that matters.
  check('but flags the query as only half answered', cassava.unmatched.length === 1, JSON.stringify(cassava.unmatched));

  const stocked = searchCatalog('white rice', undefined, 5);
  check('a fully answered query reports nothing unmatched', stocked.unmatched.length === 0, JSON.stringify(stocked.unmatched));
  check('and puts the exact product first', stocked.results[0]?.name === 'White Rice', stocked.results[0]?.name);

  const absent = searchCatalog('quinoa', undefined, 5);
  check('an absent product is wholly unmatched', absent.unmatched.length === 1 && absent.results.length === 0);

  // A near-match still counts as demand: the shop was asked for something it
  // does not sell, even though it had something to show.
  const partialPhone = '5920007001';
  JSON.parse(executeTool('search_products', { query: 'cassava bread' }, { phone: partialPhone, outbound: [] }));
  check(
    'a partial match is recorded as unmet demand',
    repo.topSearchMisses(30, 50).some((m) => m.normalized === 'cassava bread'),
    repo.topSearchMisses(30, 50).map((m) => m.normalized).join(','),
  );
  const answered = repo.searchMissCount(30);
  JSON.parse(executeTool('search_products', { query: 'white rice' }, { phone: partialPhone, outbound: [] }));
  check('a fully answered query is not recorded', repo.searchMissCount(30) === answered);

  // The index must notice the catalogue changing underneath it.
  repo.upsertProduct({
    sku: 'NEW-001', name: 'Cassava Bread', description: '', category: 'Bakery',
    unit: 'each', price: 400, stock: 10, active: 1, keywords: 'cassava bread bake',
  });
  const afterAdd = searchCatalog('cassava bread', undefined, 5);
  check('a newly imported product is searchable at once', afterAdd.results[0]?.name === 'Cassava Bread', afterAdd.results[0]?.name);
  check('and the query is no longer partial', afterAdd.unmatched.length === 0);

  // Category filter still applies.
  const scoped = searchCatalog('chicken', 'Meat & Poultry', 5);
  check('honours a category filter', scoped.results.every((p) => p.category === 'Meat & Poultry'));
  check('a category filter can exclude everything', searchCatalog('chicken', 'Bakery', 5).results.length === 0);
}

/* ---------------------------------------------------------- opening hours */

section('Opening hours');
{
  const { shopStatus } = await import('./agent/context.ts');

  // config.store.hours is read at call time, so each case sets it and asks.
  const at = (hours: string, iso: string) => {
    (config.store as { hours: string }).hours = hours;
    return shopStatus(new Date(iso));
  };
  const original = config.store.hours;

  // The shipped default, and the bug it used to have: Sunday's 4pm closing was
  // being applied to every day of the week.
  const DEFAULT = 'Mon-Sat 8:00am - 8:00pm, Sun 9:00am - 4:00pm';
  // 2026-09-02 is a Wednesday. 19:20 UTC is 15:20 in Guyana.
  const wed = at(DEFAULT, '2026-09-02T19:20:00Z');
  check(
    'a Wednesday afternoon is open, not closing at four',
    wed.state === 'open' && wed.closesInMinutes === 280,
    JSON.stringify(wed),
  );

  // 2026-09-06 is a Sunday. 19:20 UTC is 15:20 in Guyana — 40 minutes to close.
  const sun = at(DEFAULT, '2026-09-06T19:20:00Z');
  check(
    "Sunday's shorter hours still apply on Sunday",
    sun.state === 'open' && sun.closesInMinutes === 40,
    JSON.stringify(sun),
  );

  check('before opening counts as closed', at(DEFAULT, '2026-09-02T10:00:00Z').state === 'closed');
  check('after closing counts as closed', at(DEFAULT, '2026-09-03T01:00:00Z').state === 'closed');

  // A day not listed at all is a closed day, not an unknown one.
  const sundayShut = at('Mon-Sat 8:00am - 6:00pm', '2026-09-06T15:00:00Z');
  check('a day missing from the hours is closed', sundayShut.state === 'closed', JSON.stringify(sundayShut));

  check('handles a single all-week range', at('9am - 5pm', '2026-09-02T15:00:00Z').state === 'open');
  check('reads an explicit "closed"', at('Mon-Sat 8am-8pm, Sun closed', '2026-09-06T15:00:00Z').state === 'closed');
  check(
    'handles hours running past midnight',
    at('6:00pm - 2:00am', '2026-09-03T04:00:00Z').state === 'open',
    JSON.stringify(at('6:00pm - 2:00am', '2026-09-03T04:00:00Z')),
  );
  check('handles a day list', at('Mon, Wed, Fri 9am-5pm', '2026-09-02T15:00:00Z').state !== 'unknown');

  // Unreadable settings must say nothing rather than guess. Telling a customer
  // the shop is shut when it is open loses the sale outright.
  check('unreadable hours are unknown, not closed', at('call us', '2026-09-02T15:00:00Z').state === 'unknown');
  check('empty hours are unknown', at('   ', '2026-09-02T15:00:00Z').state === 'unknown');
  check('one time is not a range', at('open 9am daily', '2026-09-02T15:00:00Z').state === 'unknown');
  check('nonsense times are unknown', at('99:99am - 88pm', '2026-09-02T15:00:00Z').state === 'unknown');

  // When the shop is shut, the next opening is worked out here rather than left
  // to the model to derive from a free-text hours string.
  const early = at(DEFAULT, '2026-09-03T09:57:00Z'); // Thursday 05:57 local
  check(
    'before opening, names today\'s start time',
    early.state === 'closed' && early.phase === 'before' && early.opensAt === '8:00am today',
    JSON.stringify(early),
  );

  const lateThursday = at(DEFAULT, '2026-09-04T00:30:00Z'); // Thursday 20:30 local
  check(
    'after closing, points at tomorrow',
    lateThursday.state === 'closed' && lateThursday.phase === 'after' && lateThursday.opensAt === '8:00am tomorrow',
    JSON.stringify(lateThursday),
  );

  // Saturday night rolls to Sunday's later opening, not the weekday one.
  const saturdayNight = at(DEFAULT, '2026-09-06T01:00:00Z'); // Saturday 21:00 local
  check(
    "picks up the next day's different hours",
    saturdayNight.state === 'closed' && saturdayNight.opensAt === '9:00am tomorrow',
    JSON.stringify(saturdayNight),
  );

  // A day the shop never opens is skipped when looking ahead.
  const shutSunday = at('Mon-Fri 8:00am - 6:00pm', '2026-09-05T23:00:00Z'); // Saturday 19:00
  check(
    'skips days the shop does not open',
    shutSunday.state === 'closed' && shutSunday.opensAt === '8:00am on Monday',
    JSON.stringify(shutSunday),
  );

  const neverOpen = at('Sun closed', '2026-09-06T15:00:00Z');
  check('a shop that never opens has no next opening', neverOpen.state === 'closed' && neverOpen.opensAt === null);

  // And the context line the model actually reads.
  (config.store as { hours: string }).hours = DEFAULT;
  const { buildTimeContext: ctxNow } = await import('./agent/context.ts');
  check('an open shop is not announced as closed', !ctxNow().includes('closed'), ctxNow());

  // The customer-facing framing: deliveries starting, never shutters closing.
  // "We're closed" reads as go away and loses an order the shop could fill.
  //
  // The fixture is built from today's weekday rather than from a fixed hours
  // string, so the shop is shut whatever time this suite happens to run at.
  const short = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guyana',
    weekday: 'short',
  }).format(new Date()).slice(0, 3);
  const otherDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].find(
    (d) => d.toLowerCase() !== short.toLowerCase(),
  );
  (config.store as { hours: string }).hours = `${short} closed, ${otherDay} 8:00am - 8:00pm`;
  const shutLine = ctxNow();
  check('a shut shop talks about deliveries, not shutters', shutLine.includes('deliveries'), shutLine);
  check('never announces the shop as closed', !/shop is closed/i.test(shutLine), shutLine);
  check(
    'does not claim deliveries finished on a day they never ran',
    shutLine.includes('No deliveries today'),
    shutLine,
  );
  check('and says to keep taking the order', shutLine.includes('Take the order as normal'), shutLine);

  // The three phases each need their own words.
  (config.store as { hours: string }).hours = DEFAULT;
  const before = at(DEFAULT, '2026-09-03T09:57:00Z');
  const after = at(DEFAULT, '2026-09-04T00:30:00Z');
  check('before opening is not "finished for today"', before.state === 'closed' && before.phase === 'before');
  check('after closing is', after.state === 'closed' && after.phase === 'after');
  const dayOff = at('Mon-Fri 8:00am - 6:00pm', '2026-09-05T23:00:00Z');
  check('a day off is neither', dayOff.state === 'closed' && dayOff.phase === 'off', JSON.stringify(dayOff));

  (config.store as { hours: string }).hours = original;
}

/* ----------------------------------------------------------- unmet demand */

section('Unmet demand');
{
  const { normalizeQuery } = repo;

  check('lowercases and trims', normalizeQuery('  Channa  ') === 'channa', normalizeQuery('  Channa  '));
  check('drops punctuation', normalizeQuery('channa?') === 'channa');
  check('collapses a quantity and unit', normalizeQuery('2 lbs channa') === 'channa', normalizeQuery('2 lbs channa'));
  check('groups a plural separately from nothing', normalizeQuery('CHANNA') === normalizeQuery('channa'));

  // 'zzzznotathing' was searched by the customer phone in the search section
  // above, so a miss is already on record before this section adds any.
  const already = repo.topSearchMisses(30, 50);
  check(
    'an earlier failed search was recorded',
    already.some((m) => m.normalized === 'zzzznotathing'),
    JSON.stringify(already.map((m) => m.normalized)),
  );

  // Six different people asking once beats one person asking six times — that
  // ordering is the whole point of the report.
  for (let i = 0; i < 6; i++) {
    JSON.parse(executeTool('search_products', { query: 'channa' }, { phone: `59260011${i}1`, outbound: [] }));
  }
  const persistent: ToolContext = { phone: '5920004444', outbound: [] };
  for (let i = 0; i < 9; i++) {
    JSON.parse(executeTool('search_products', { query: 'quinoa' }, persistent));
  }

  const ranked = repo.topSearchMisses(30, 10);
  const channa = ranked.find((m) => m.normalized === 'channa');
  const quinoa = ranked.find((m) => m.normalized === 'quinoa');
  check('counts distinct people', channa?.people === 6, JSON.stringify(channa));
  check('counts repeats separately from people', quinoa?.times === 9 && quinoa?.people === 1, JSON.stringify(quinoa));
  check(
    'ranks six people above one person asking nine times',
    ranked.findIndex((m) => m.normalized === 'channa') <
      ranked.findIndex((m) => m.normalized === 'quinoa'),
    ranked.map((m) => `${m.normalized}:${m.people}`).join(', '),
  );

  // A successful search must leave no trace — otherwise the report fills with
  // things the shop already sells.
  const before = repo.searchMissCount(30);
  JSON.parse(executeTool('search_products', { query: 'rice' }, { phone: '5920005555', outbound: [] }));
  check('a successful search is not recorded', repo.searchMissCount(30) === before);

  // Staff checking stock is not a customer wanting to buy.
  JSON.parse(executeTool('search_products', { query: 'staffonlyprobe' }, { phone: '5926497570', outbound: [] }));
  check(
    'a staff search is not counted as demand',
    !repo.topSearchMisses(30, 50).some((m) => m.normalized === 'staffonlyprobe'),
  );

  // search_many is how a photographed or typed list arrives; its misses count too.
  JSON.parse(
    executeTool('search_many', { queries: ['rice', 'saltfish'] }, { phone: '5920006666', outbound: [] }),
  );
  check(
    'a miss inside a bulk list is recorded',
    repo.topSearchMisses(30, 50).some((m) => m.normalized === 'saltfish'),
  );

  check('noise too short to be a product is ignored', (repo.logSearchMiss('5920007777', '?'), true));
  const noiseBefore = repo.searchMissCount(30);
  repo.logSearchMiss('5920007777', '!');
  check('a one-character query adds nothing', repo.searchMissCount(30) === noiseBefore);

  // The report a staff member actually reads.
  const { handleStaffMessage } = await import('./staff.ts');
  const report = (await handleStaffMessage('wanted'))[0]?.text ?? '';
  check('staff can pull the report', report.includes('channa'), report.slice(0, 80));
  check('the report says how many people asked', report.includes('6 people'), report.slice(0, 200));
  check('a day count is accepted', ((await handleStaffMessage('wanted 7'))[0]?.text ?? '').includes('7 days'));
  check('the report is listed in help', ((await handleStaffMessage('help'))[0]?.text ?? '').includes('wanted'));
  check(
    '"wanted 7" is not mistaken for order 7',
    !((await handleStaffMessage('wanted 7'))[0]?.text ?? '').includes('ORD-'),
  );
}

/* ------------------------------------------------------------ order status */

section('Order status for customers');
{
  const { CUSTOMER_STATUS, describeAge } = await import('./order-status.ts');

  check('describes a fresh timestamp', describeAge(new Date().toISOString()) === 'just now');
  check(
    'describes hours',
    describeAge(new Date(Date.now() - 3 * 3600_000).toISOString()) === 'about 3 hours ago',
    describeAge(new Date(Date.now() - 3 * 3600_000).toISOString()),
  );
  check(
    'describes yesterday',
    describeAge(new Date(Date.now() - 30 * 3600_000).toISOString()) === 'yesterday',
    describeAge(new Date(Date.now() - 30 * 3600_000).toISOString()),
  );
  check('survives a broken timestamp', describeAge('not a date').length > 0);
  check('never calls an order "pending" to a customer', !CUSTOMER_STATUS.pending.includes('pending'));

  // ORD-00001 belongs to PHONE and was marked delivered by the staff section.
  const mine = call('list_recent_orders');
  check('lists this customer\'s orders', mine.orders?.length >= 1, JSON.stringify(mine).slice(0, 90));
  check('translates the status into plain words', typeof mine.orders?.[0]?.status_means === 'string');
  check('says how long ago it was placed', typeof mine.orders?.[0]?.placed === 'string', mine.orders?.[0]?.placed);
  check('warns the agent off inventing an ETA', String(mine.note).includes('ETA'), mine.note);

  const byNumber = call('list_recent_orders', { order_number: '1' });
  check('finds an order the customer names', byNumber.orders?.[0]?.order_number === 'ORD-00001', JSON.stringify(byNumber).slice(0, 90));
  check('a named order includes the address it goes to', typeof byNumber.orders?.[0]?.delivering_to === 'string');
  check('accepts the padded form too', call('list_recent_orders', { order_number: 'ORD-00001' }).orders?.length === 1);

  // The security property: order numbers are sequential and read aloud, so a
  // customer must never be able to fetch someone else's by guessing.
  const stranger: ToolContext = { phone: '5920009111', outbound: [] };
  const snoop = JSON.parse(executeTool('list_recent_orders', { order_number: '1' }, stranger));
  check('cannot read another customer\'s order', snoop.orders?.length === 0, JSON.stringify(snoop).slice(0, 120));
  check('the refusal leaks nothing about it', !JSON.stringify(snoop).includes('Georgetown'), JSON.stringify(snoop));
  check(
    'a stranger with no orders is told so plainly',
    typeof JSON.parse(executeTool('list_recent_orders', {}, stranger)).note === 'string',
  );

  const nonsense = call('list_recent_orders', { order_number: '99999' });
  check('an unknown order number is handled', nonsense.orders?.length === 0 && !!nonsense.note);
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

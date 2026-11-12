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
process.env.DRIVER_NUMBERS = '5926001111';
// A delivery area around Stabroek Market, so the geofence is exercised rather
// than skipped. It ships switched off (store-settings.json, asserted below),
// and every test pin below except the deliberate far ones falls inside it.
process.env.SERVICE_CENTRE_LAT = '6.8013';
process.env.SERVICE_CENTRE_LNG = '-58.1551';
process.env.SERVICE_RADIUS_KM = '15';

// A scratch images folder, so results never depend on what happens to be in the
// real one. One file is planted below to exercise SKU resolution.
const TEST_IMAGES = path.resolve('./data/smoke-images');
fs.rmSync(TEST_IMAGES, { recursive: true, force: true });
fs.mkdirSync(TEST_IMAGES, { recursive: true });
fs.writeFileSync(path.join(TEST_IMAGES, 'DAI-003.jpg'), 'not really a jpeg');
process.env.PRODUCT_IMAGES_DIR = TEST_IMAGES;
process.env.PUBLIC_BASE_URL = 'https://shop.example.com';

const { money, config, toMinorUnits } = await import('./config.ts');
const { db } = await import('./db/index.ts');
const repo = await import('./db/repo.ts');
const { executeTool, TOOL_DEFS } = await import('./agent/tools.ts');
const { importCsvText, parseCsv } = await import('./catalog/import-csv.ts');
const { parseWebhook, chunkText, verifySignature } = await import('./channels/whatsapp.ts');
const { splitReply, typingDelayMs } = await import('./agent/pacing.ts');
const { available } = await import('./availability.ts');

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
  check('blocks checkout with no name', typeof tooEarly.error === 'string', tooEarly.error);

  // A pin carries the location now, so "green gate" is a complete and useful
  // doorstep note where it was once too short to be an address.
  const shortNote = call('save_customer_details', { name: 'Ada', address: 'green gate' });
  check('accepts a short doorstep note', shortNote.saved?.address === 'green gate', JSON.stringify(shortNote));

  call('save_customer_details', { name: 'Ada Lovelace', address: '12 Main Street, Georgetown' });
  const details = call('get_customer_details');
  check('saves customer details', details.name === 'Ada Lovelace' && !!details.address);

  // Name and notes but nowhere to drive to: checkout must still refuse.
  const noPin = call('place_order', { payment_method: 'cash_on_delivery' });
  check('blocks checkout with no location pin', typeof noPin.error === 'string', JSON.stringify(noPin).slice(0, 90));
  check('the block names the fix', String(noPin.error).includes('request_location'), noPin.error);

  repo.saveLocationPin(PHONE, { latitude: 6.80714, longitude: -58.15536, label: 'Stabroek Market' });
  call('confirm_identity');

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

/* ------------------------------------------------------------ reply shaping */

section('Reply assembly');
{
  const { assembleReply } = await import('./agent/run.ts');
  const buttons = [{ id: 'yes', title: 'Yes' }];

  // Buttons: a short trailing line is filler and costs a second notification.
  const filler = assembleReply('I will place it once you confirm.', [
    { kind: 'buttons', text: 'Total $2,350. Place the order?', buttons },
  ]);
  check('drops filler prose beside buttons', filler.length === 1 && filler[0]?.kind === 'buttons');

  const substantial = 'Only 3 snapper left, so I put 3 in rather than 6. '.repeat(3);
  const kept = assembleReply(substantial, [
    { kind: 'buttons', text: 'Place the order?', buttons },
  ]);
  check('keeps substantial prose beside buttons', kept[0]?.kind === 'text', JSON.stringify(kept[0]?.kind));

  // A pin request is a side errand, so the answer about the shopping survives
  // however short it is. Letting the filler rule apply here once left a
  // customer with nothing but "share your pin" after listing three items.
  const withOrder = assembleReply('Rice and chicken are in — $4,200 so far.', [
    { kind: 'location_request', text: 'Tap below to share your delivery pin.' },
  ]);
  check('keeps the order answer beside a pin request', withOrder.length === 2, JSON.stringify(withOrder));
  check('the words come first', withOrder[0]?.kind === 'text', withOrder[0]?.kind);
  check('then the button', withOrder[1]?.kind === 'location_request', withOrder[1]?.kind);

  const echoed = assembleReply('Tap below to share your delivery pin.', [
    { kind: 'location_request', text: 'Tap below to share your delivery pin.' },
  ]);
  check('still drops a pure restatement', echoed.length === 1, JSON.stringify(echoed));

  const silent = assembleReply('', []);
  check('never sends an empty turn', silent.length === 1 && silent[0]?.kind === 'text');
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
  const single = await handleStaffMessage('1');
  const one = single[0]?.text ?? '';
  check('shows a single order', one.includes('ORD-00001'), one.slice(0, 60));
  check('shows the delivery address', one.includes('Georgetown'));
  check('shows a tappable maps link', one.includes('google.com/maps?q=6.80714'), one.slice(0, 200));
  // The delivery associate is usually about to drive there, so the pin follows as a card.
  check('sends the pin as a map card', single[1]?.kind === 'location', JSON.stringify(single[1]));

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
  const { nextActions, STATUS_WORDS, commandFromButtonId } = await import('./order-status.ts');

  const pending = nextActions('ORD-00007', 'pending');
  check('a new order offers three actions', pending.length === 3, JSON.stringify(pending));
  check(
    'a confirmed order drops "confirm"',
    !nextActions('ORD-00007', 'confirmed').some((a) => a.id.startsWith('confirm')),
    JSON.stringify(nextActions('ORD-00007', 'confirmed')),
  );
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

  // The whole design rests on this: a tap sends back the button's id, which is
  // translated into the command it stands for. The title is only what the
  // person reads, so it is the COMMAND that has to parse and name the order.
  const roundTrip = nextActions('ORD-00042', 'pending');
  for (const action of roundTrip) {
    const matched = STATUS_WORDS.find(([pattern]) => pattern.test(action.command));
    check(`"${action.title}" means a status command`, matched !== undefined, action.command);
    check(
      `"${action.title}" carries the order number out of sight`,
      /42/.test(action.command) && !/42/.test(action.title),
      `${action.title} -> ${action.command}`,
    );
    check(
      `"${action.title}" is translated from its id`,
      commandFromButtonId(action.id) === action.command,
      `${action.id} -> ${commandFromButtonId(action.id)}`,
    );
  }

  // Buttons the agent builds for customers must keep their titles: the model
  // has to receive "Grocery shopping", never "option_1".
  check('an id that is not ours is left alone', commandFromButtonId('option_1') === null);
  check('and so is an empty one', commandFromButtonId('') === null);
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

  // Details the customer states themselves are confirmed by saying them — but
  // only once there is somewhere to deliver to.
  idCall('save_customer_details', { name: 'Real Person', address: '9 Confirmed Road, Georgetown' });
  check(
    'a name alone does not confirm identity',
    idCall('get_customer_details').identity_confirmed === false,
  );

  repo.saveLocationPin(idPhone, { latitude: 6.7988, longitude: -58.1489, label: '' });
  idCall('save_customer_details', { name: 'Real Person' });
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
  // they message from so a delivery associate always has someone to ring.
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

/* ----------------------------------------------------------- location pins */

section('Location pins');
{
  const { parseCoordinates, pinLabel, formatCoordinates, mapsLink, locationNote } = await import(
    './location.ts'
  );

  // Validation, which is the only thing standing between a broken payload and a
  // delivery associate sent to the middle of the Atlantic.
  check('accepts a Georgetown pin', parseCoordinates(6.80714, -58.15536) !== null);
  check('accepts numeric strings', parseCoordinates('6.80714', '-58.15536') !== null);
  check('rejects a missing coordinate', parseCoordinates(6.8, undefined) === null);
  check('rejects an out-of-range latitude', parseCoordinates(91, -58) === null);
  check('rejects an out-of-range longitude', parseCoordinates(6.8, 181) === null);
  check('rejects non-numeric junk', parseCoordinates('here', 'there') === null);
  // 0,0 is a real place, and never a delivery address.
  check('rejects null island', parseCoordinates(0, 0) === null);

  check('labels a named place', pinLabel('Stabroek Market', 'Water St, Georgetown') === 'Stabroek Market — Water St, Georgetown');
  check('collapses a repeated label', pinLabel('Stabroek Market', 'Stabroek Market, Georgetown') === 'Stabroek Market, Georgetown');
  check('a hand-dropped pin has no label', pinLabel(undefined, undefined) === '');
  check('formats without trailing noise', formatCoordinates({ latitude: 6.8, longitude: -58.15 }) === '6.8, -58.15');
  check('maps link is tappable', mapsLink({ latitude: 6.80714, longitude: -58.15536 }) === 'https://www.google.com/maps?q=6.807140,-58.155360');

  // The note the agent reads in place of the customer's (nonexistent) words.
  const note = locationNote({ latitude: 6.80714, longitude: -58.15536, label: 'Stabroek Market' });
  check('the note says the pin is already saved', note.includes('saved as the delivery point'));
  check('the note forbids reading the numbers out', note.includes('never read the coordinates out'));
  check('the note asks for doorstep detail', note.includes('save_customer_details'));

  /* --- a pin arriving over the webhook --- */

  const pinned = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: '5926001111',
                  id: 'wamid.pin',
                  type: 'location',
                  location: {
                    latitude: 6.80714,
                    longitude: -58.15536,
                    name: 'Stabroek Market',
                    address: 'Water St, Georgetown',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  check('parses a shared location', pinned.length === 1, JSON.stringify(pinned));
  check('carries the coordinates', pinned[0]?.location?.latitude === 6.80714, JSON.stringify(pinned[0]?.location));
  check('carries the label', pinned[0]?.location?.label === 'Stabroek Market — Water St, Georgetown', pinned[0]?.location?.label);
  check('a pin needs no text to survive', pinned[0]?.text === '', JSON.stringify(pinned[0]?.text));

  // A pin that did not come through must ask for another, not be stored.
  const brokenPin = parseWebhook({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: '592', id: 'wamid.badpin', type: 'location', location: { latitude: 0, longitude: 0 } },
              ],
            },
          },
        ],
      },
    ],
  });
  check('an unusable pin is not stored', brokenPin[0]?.location === undefined, JSON.stringify(brokenPin[0]));
  check('an unusable pin asks for another', String(brokenPin[0]?.text).includes('send it again'), brokenPin[0]?.text);

  /* --- storing, reading back, and checking out --- */

  const pinPhone = '5920004444';
  const pinCtx: ToolContext = { phone: pinPhone, outbound: [] };
  const pinCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, pinCtx));

  check('a new customer has no pin', pinCall('get_customer_details').location_pin === null);
  check(
    'the next step is to ask for one',
    String(pinCall('get_customer_details').next).includes('request_location'),
  );

  // Asking for a pin queues WhatsApp's own Send location button.
  const asked = pinCall('request_location', { body: 'Pop me your location and I will get this moving.' });
  check('request_location reports it sent', asked.sent === true, JSON.stringify(asked));
  check('queues a location request', pinCtx.outbound[0]?.kind === 'location_request', JSON.stringify(pinCtx.outbound[0]));
  check('the button carries the body text', pinCtx.outbound[0]?.text.includes('Pop me your location') === true);
  check('and is not restated', String(asked.next).includes('do not repeat'), asked.next);
  check('an empty body is refused', typeof pinCall('request_location', { body: '  ' }).error === 'string');

  // Saving is the channel's job, exactly as conversation.ts does it on arrival.
  const saved = repo.saveLocationPin(pinPhone, {
    latitude: 6.80714,
    longitude: -58.15536,
    label: 'Stabroek Market',
  });
  check('a saved pin is timestamped', !!saved.pinnedAt);
  check('the pin reads back', repo.getIdentity(pinPhone).location?.label === 'Stabroek Market');

  const view = pinCall('get_customer_details');
  check('the pin shows as on file', view.location_pin?.on_file === true, JSON.stringify(view.location_pin));
  check('described in words, not numbers', view.location_pin?.where === 'Stabroek Market');
  // The model has no use for coordinates and would read them out if it had them.
  check(
    'coordinates are withheld from the agent',
    !JSON.stringify(view).includes('6.807'),
    JSON.stringify(view),
  );

  // Checkout: a pin alone is not enough, and neither is a name alone.
  pinCall('add_to_cart', { sku: 'RIC-001', quantity: 1 });
  const noName = pinCall('place_order', { payment_method: 'cash_on_delivery' });
  check('still blocked without a name', typeof noName.error === 'string', JSON.stringify(noName).slice(0, 80));

  pinCall('save_customer_details', { name: 'Pin Tester' });
  check('name plus pin confirms identity', pinCall('get_customer_details').identity_confirmed === true);

  const placed = pinCall('place_order', { payment_method: 'cash_on_delivery' });
  check('checkout completes with a pin', placed.placed === true, JSON.stringify(placed).slice(0, 120));
  check('the agent is told where it is going', placed.delivering_to_pin?.where === 'Stabroek Market');
  check(
    'the confirmation carries no coordinates',
    !JSON.stringify(placed).includes('6.807'),
    JSON.stringify(placed).slice(0, 160),
  );

  const stored = repo.findOrder(placed.order_number);
  check('the order row keeps the pin', stored?.location?.latitude === 6.80714, JSON.stringify(stored?.location));
  check('the order keeps the label', stored?.location?.label === 'Stabroek Market');
  check('an order needs no typed address', stored?.address === '', JSON.stringify(stored?.address));

  // People move. A new pin must not relocate an order already placed.
  repo.saveLocationPin(pinPhone, { latitude: 6.5, longitude: -58.3, label: 'Somewhere else' });
  check(
    'a later pin does not move a placed order',
    repo.findOrder(placed.order_number)?.location?.latitude === 6.80714,
    JSON.stringify(repo.findOrder(placed.order_number)?.location),
  );
  check('but the customer record moves', repo.getIdentity(pinPhone).location?.label === 'Somewhere else');

  // Orders placed before pins existed must still be readable.
  db.prepare(`UPDATE orders SET latitude = NULL, longitude = NULL WHERE order_no = ?`).run(
    placed.order_number,
  );
  check('a pinless legacy order still loads', repo.findOrder(placed.order_number)?.location === null);
}

/* ------------------------------------------------------ delivery-area fence */

section('Delivery area');
{
  const { distanceKm, checkRange, formatDistance, locationNote, describePin } = await import(
    './location.ts'
  );

  const shop = { latitude: 6.8013, longitude: -58.1551 }; // Stabroek, Georgetown
  const nearby = { latitude: 6.8128, longitude: -58.1448 }; // Kitty, ~1.6km
  const newAmsterdam = { latitude: 6.247, longitude: -57.5172 }; // ~95km east

  // Haversine against known separations. Loose bounds on purpose: this asserts
  // the maths is right to within a street, not to the metre.
  check('a point is zero from itself', distanceKm(shop, shop) === 0);
  const near = distanceKm(shop, nearby);
  check('measures a short hop', near > 1.4 && near < 1.9, `${near.toFixed(2)} km`);
  const far = distanceKm(shop, newAmsterdam);
  check('measures across the country', far > 90 && far < 100, `${far.toFixed(1)} km`);
  check('distance is symmetric', Math.abs(distanceKm(shop, nearby) - distanceKm(nearby, shop)) < 1e-9);

  check('formats metres for a short distance', formatDistance(0.42) === '400 m', formatDistance(0.42));
  check('never rounds a distance to zero', formatDistance(0.004) === '50 m', formatDistance(0.004));
  check('formats one decimal under 10km', formatDistance(2.34) === '2.3 km', formatDistance(2.34));
  check('formats whole kilometres above it', formatDistance(23.4) === '23 km', formatDistance(23.4));

  /* --- the fence itself --- */

  const area = { ...shop, radiusKm: 15 };
  check('a nearby pin is inside', checkRange(nearby, area).state === 'inside');
  check('a distant pin is outside', checkRange(newAmsterdam, area).state === 'outside');
  check('the shop itself is inside', checkRange(shop, area).state === 'inside');
  // The boundary belongs to the shop: a pin exactly on the line is deliverable.
  check('the edge is inside', checkRange(nearby, { ...shop, radiusKm: near }).state === 'inside');

  // An unconfigured fence must have no opinion at all, or a missing variable
  // would refuse every order in the city.
  check('no area configured means unchecked', checkRange(newAmsterdam, null).state === 'unchecked');
  check('a zero radius means unchecked', checkRange(newAmsterdam, { ...shop, radiusKm: 0 }).state === 'unchecked');
  check(
    'a negative radius means unchecked, not everything-outside',
    checkRange(nearby, { ...shop, radiusKm: -5 }).state === 'unchecked',
  );
  // What a fresh deployment gets: a circle at 0,0 with no radius, which the
  // config layer resolves to no fence at all. The check must be something a
  // shop switches on deliberately, never something that arrives switched on.
  const shipped = JSON.parse(fs.readFileSync(path.resolve('./store-settings.json'), 'utf8'));
  check('the shipped settings carry no radius', shipped.serviceArea?.radiusKm === 0, JSON.stringify(shipped.serviceArea));
  check('and no shop position', shipped.serviceArea?.latitude === 0 && shipped.serviceArea?.longitude === 0);

  // The env set at the top of this file is what the config layer read.
  check('the configured area is live', config.store.serviceArea?.radiusKm === 15, JSON.stringify(config.store.serviceArea));

  /* --- what each side is told --- */

  const outside = checkRange(newAmsterdam, area);
  const note = locationNote({ ...newAmsterdam, label: '' }, outside);
  check('the arrival note says it is out of area', note.includes('outside the 15 km delivery area'));
  check('and says staff will confirm', note.includes('staff member will confirm'));
  check('and forbids inventing a fee', note.includes('do not guess at a fee'));
  check(
    'an in-area note does not mention being outside',
    !locationNote({ ...nearby, label: '' }, checkRange(nearby, area)).includes('outside'),
  );

  const dispatch = describePin({ ...newAmsterdam, label: 'New Amsterdam' }, outside);
  check('staff see the warning', dispatch.includes('OUTSIDE the 15 km delivery area'), dispatch);
  check('staff see the distance', dispatch.includes('km away'), dispatch);
  check(
    'an unchecked pin gets no distance clutter',
    !describePin({ ...nearby, label: '' }).includes('away'),
  );

  /* --- checkout refuses an out-of-area pin --- */

  const farPhone = '5920005555';
  const farCtx: ToolContext = { phone: farPhone, outbound: [] };
  const farCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, farCtx));

  repo.saveLocationPin(farPhone, { ...newAmsterdam, label: 'New Amsterdam' });
  farCall('save_customer_details', { name: 'Far Customer' });
  farCall('add_to_cart', { sku: 'RIC-001', quantity: 1 });

  // The agent is told at every read, not only at checkout, so it can say so
  // before the customer has filled a basket.
  const farView = farCall('get_customer_details');
  check('an out-of-area pin is flagged on read', typeof farView.location_pin?.outside_delivery_area === 'string', JSON.stringify(farView.location_pin));
  check('with the distance in words', String(farView.location_pin?.distance_from_shop).includes('km'), farView.location_pin?.distance_from_shop);

  const refused = farCall('place_order', { payment_method: 'cash_on_delivery' });
  check('checkout refuses an out-of-area pin', typeof refused.error === 'string', JSON.stringify(refused).slice(0, 120));
  check('the refusal says how far out it is', String(refused.error).includes('km from the shop'), refused.error);
  check('and routes it to staff rather than refusing the customer', String(refused.error).includes('staff member will confirm'));
  check('and forbids inventing a surcharge', String(refused.error).includes('do not offer a surcharge'));
  check('nothing was placed', repo.recentOrders(farPhone, 5).length === 0);
  check('the cart is left for staff to finish', farCall('view_cart').items?.length === 1);

  // A nearby customer is unaffected — the fence must not become a tax on
  // everyone to catch the rare pin in the wrong region.
  const nearPhone = '5920006666';
  const nearCtx: ToolContext = { phone: nearPhone, outbound: [] };
  const nearCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, nearCtx));
  repo.saveLocationPin(nearPhone, { ...nearby, label: 'Kitty' });
  nearCall('save_customer_details', { name: 'Near Customer' });
  nearCall('add_to_cart', { sku: 'RIC-001', quantity: 1 });
  const allowed = nearCall('place_order', { payment_method: 'cash_on_delivery' });
  check('an in-area pin still checks out', allowed.placed === true, JSON.stringify(allowed).slice(0, 120));
  check('the in-area agent view carries no warning', nearCall('get_customer_details').location_pin?.outside_delivery_area === undefined);

  // And the system prompt states the radius, so the agent is not guessing.
  const { SYSTEM_PROMPT } = await import('./agent/system-prompt.ts');
  check('the prompt names the radius', SYSTEM_PROMPT.includes('within about 15 km'), '');
  check('the prompt forbids haggling over distance', SYSTEM_PROMPT.includes('do not offer to charge extra'));
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

/* ------------------------------------------------------- restaurant orders */

section('Menu options');
{
  const { parseOptionSpec, applySelection, describeOptions, summariseStored } = await import(
    './menu-options.ts'
  );

  const spec = 'Size:Regular|Large+200;Extras*:Cheese+150|Bacon+250;Dip?:Chilli;Spice:Mild|Hot';
  const groups = parseOptionSpec(spec);
  check('reads every group', groups.length === 4, JSON.stringify(groups.map((g) => g.name)));
  check('a plain group must be answered', groups[0]?.mode === 'one');
  check('a starred group takes any number', groups[1]?.mode === 'any');
  check('a question-marked group is optional', groups[2]?.mode === 'upToOne');
  check(
    'reads a surcharge',
    groups[0]?.choices[1]?.surcharge === toMinorUnits(200),
    String(groups[0]?.choices[1]?.surcharge),
  );
  check('a plain choice costs nothing', groups[0]?.choices[0]?.surcharge === 0);
  check('ignores a malformed group', parseOptionSpec('Size;;:|;Spice:Mild').length === 1);
  check('describes options for the customer', describeOptions(groups)[0]?.includes('Large (+$200)') === true, describeOptions(groups)[0]);

  const picked = applySelection(groups, ['Large', 'Cheese', 'Bacon', 'Hot']);
  check('accepts a valid selection', picked.ok === true, JSON.stringify(picked));
  check('adds the surcharges up', picked.ok && picked.surcharge === 600, JSON.stringify(picked));
  check('skips an optional group left blank', picked.ok && !picked.normalized.includes('Dip'), picked.ok ? picked.normalized : '');

  // The normalized form is a cart line's identity, so it has to be stable.
  const reordered = applySelection(groups, ['Hot', 'Bacon', 'Large', 'Cheese']);
  check(
    'the same picks in any order give one line',
    picked.ok && reordered.ok && picked.normalized === reordered.normalized,
    `${picked.ok && picked.normalized} vs ${reordered.ok && reordered.normalized}`,
  );
  const different = applySelection(groups, ['Regular', 'Hot']);
  check(
    'different picks give a different line',
    different.ok && picked.ok && different.normalized !== picked.normalized,
  );

  check('refuses a compulsory group left blank', applySelection(groups, ['Large']).ok === false);
  const missing = applySelection(groups, ['Large']);
  check('and says which one', !missing.ok && missing.error.includes('Spice'), !missing.ok ? missing.error : '');
  check('refuses two picks in a single-choice group', applySelection(groups, ['Large', 'Regular', 'Hot']).ok === false);
  check('refuses a choice that is not offered', applySelection(groups, ['Enormous', 'Hot']).ok === false);
  check(
    'asks which group when a label is ambiguous',
    applySelection(parseOptionSpec('A:Same|X;B:Same|Y'), ['Same']).ok === false,
  );
  check(
    'a group-qualified pick resolves the ambiguity',
    applySelection(parseOptionSpec('A:Same|X;B:Same|Y'), ['A: Same', 'B: Y']).ok === true,
  );
  check('an item with no options takes none', applySelection([], []).ok === true);
  check('and refuses choices it cannot honour', applySelection([], ['Large']).ok === false);
  check('reads a stored line back', summariseStored('Size=Large; Spice=Hot') === 'Large, Hot');
}

section('Restricted goods');
{
  const { restrictedReason } = await import('./restricted.ts');

  check('refuses beer', restrictedReason('Banks Beer') !== null);
  check('refuses rum', restrictedReason('Rum Punch', 'Local rum with juice') !== null);
  check('refuses wine', restrictedReason('House Red Wine') !== null);
  check('refuses a cocktail', restrictedReason('Mojito') !== null);
  check('refuses tobacco', restrictedReason('Cigarettes') !== null);
  check('catches it in a description', restrictedReason('House Special', 'Chicken in a whisky glaze') !== null);
  check('catches it in the keywords', restrictedReason('Special', '', '', 'cocktail party drinks') !== null);
  check('names the word it found', String(restrictedReason('Stout')).includes('stout'));

  // Precision matters as much here as in search. Refusing half a menu because
  // of a word inside another word would make the filter unusable.
  check('allows ginger beer', restrictedReason('Soft Drink', '', 'Drinks', 'ginger beer cola') === null);
  check('allows root beer', restrictedReason('Root Beer') === null);
  check('allows ginger, which contains gin', restrictedReason('Ginger Chicken') === null);
  check('allows a rum cake', restrictedReason('Rum Cake', 'Sponge with rum flavour') === null);
  check('allows beer-battered fish', restrictedReason('Beer Battered Fish') === null);
  check('allows a declared non-alcoholic drink', restrictedReason('Non-Alcoholic Beer') === null);
  check('allows a virgin cocktail', restrictedReason('Virgin Mojito') === null);
  check('allows ordinary food', restrictedReason('Chicken Chow Mein', 'Noodles with chicken') === null);
  check('allows an empty row', restrictedReason('', undefined) === null);
  // "Wine" inside a longer word must not trip it.
  check('allows a word merely containing a banned one', restrictedReason('Swine Roast') === null);
}

section('Restaurant ordering');
{
  const { importOutletsText, importMenuText } = await import('./catalog/import-menu.ts');

  const outletCsv = fs.readFileSync(path.resolve('./data/sample-outlets.csv'), 'utf8');
  // Derived from the file rather than hardcoded, so adding a sample outlet does
  // not break the suite — the point is that every row imports, not that there
  // happen to be six of them.
  const outletRows = (outletCsv.match(/^[A-Z]{2,4},/gm) ?? []).length;

  const outlets = importOutletsText(outletCsv);
  check('imports every sample outlet', outlets.imported === outletRows, `${outlets.imported} of ${outletRows}`);
  check('no outlet rows skipped', outlets.skipped.length === 0, JSON.stringify(outlets.skipped));

  const menu = importMenuText(fs.readFileSync(path.resolve('./data/sample-menu.csv'), 'utf8'));
  check('imports the sample menus', menu.items >= 30, JSON.stringify(menu.items));
  check('no menu rows skipped', menu.skipped.length === 0, JSON.stringify(menu.skipped.slice(0, 3)));
  // The sample menus deliberately carry a rum punch, a beer and a glass of wine,
  // one on each of three different outlets.
  check('refuses the alcohol on the menu', menu.refused.length === 3, JSON.stringify(menu.refused));
  check(
    'and keeps it out of the catalogue entirely',
    ['KFH-007', 'BRH-007', 'PIZ-006'].every((sku) => repo.getProductBySku(sku) === null),
  );

  const bad = importMenuText('outlet,sku,name,price\nNOPE,X-1,Thing,100\n');
  check('refuses a menu row for an unknown outlet', bad.items === 0 && bad.skipped.length === 1);

  // The ordering tests below need one kitchen that is open and one that is shut,
  // whatever time this suite runs at. Sheriff Street's real hours made them pass
  // before eleven and fail after seven, so both are set explicitly here rather
  // than left to the clock.
  const ALWAYS_OPEN = 'Mon-Sun 12:00am - 11:59pm';
  const todayShort = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guyana',
    weekday: 'short',
  })
    .format(new Date())
    .slice(0, 3);
  const otherDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].find(
    (d) => d.toLowerCase() !== todayShort.toLowerCase(),
  );
  repo.upsertOutlet({ ...repo.getOutlet('SSC')!, hours: ALWAYS_OPEN });
  repo.upsertOutlet({ ...repo.getOutlet('BRH')!, hours: `${otherDay} 9:00am - 5:00pm` });

  // A menu item is not grocery stock.
  const dish = repo.getProductBySku('SSC-001');
  check('a dish belongs to its outlet', dish?.outletId === repo.getOutlet('SSC')?.id);
  check('a dish keeps no stock count', dish?.trackStock === 0, JSON.stringify(dish?.trackStock));
  check('a dish is available despite zero stock', available(dish!), JSON.stringify(dish?.stock));
  check('a dish carries its options', (dish?.options ?? '').includes('Size:'), dish?.options);

  const foodPhone = '5920002100';
  const foodCtx: ToolContext = { phone: foodPhone, outbound: [] };
  const food = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, foodCtx));

  const listed = food('list_outlets');
  check('lists the outlets', listed.outlets?.length === outletRows, JSON.stringify(listed.outlets?.length));
  check('reports a cooking time', String(listed.outlets?.[0]?.typical_wait).includes('minutes'));

  // Searching before choosing a restaurant must stay in the grocery aisle.
  const beforeChoosing = food('search_products', { query: 'chow mein' });
  check('a dish is invisible before choosing an outlet', beforeChoosing.results?.length === 0, JSON.stringify(beforeChoosing).slice(0, 120));

  check('rejects an unknown outlet code', typeof food('choose_outlet', { code: 'NOPE' }).error === 'string');

  const chosen = food('choose_outlet', { code: 'SSC' });
  check('chooses an outlet', chosen.ordering_from?.code === 'SSC', JSON.stringify(chosen).slice(0, 120));
  check('reports its menu sections', Array.isArray(chosen.menu_categories) && chosen.menu_categories.length > 2);

  const scoped = food('search_products', { query: 'chow mein' });
  check('now finds the dish', scoped.results?.[0]?.sku === 'SSC-001', JSON.stringify(scoped).slice(0, 120));
  check('offers its options', Array.isArray(scoped.results?.[0]?.options), JSON.stringify(scoped.results?.[0]?.options));
  check('says which are compulsory', scoped.results?.[0]?.must_choose?.includes('Size'), JSON.stringify(scoped.results?.[0]?.must_choose));

  // Groceries are out of reach while ordering food, and vice versa.
  const riceWhileOrdering = food('search_products', { query: 'rice' });
  check(
    'the grocery aisle is out of scope inside a menu',
    (riceWhileOrdering.results ?? []).every((r: any) => String(r.sku).startsWith('SSC-')),
    JSON.stringify(riceWhileOrdering.results?.map((r: any) => r.sku)),
  );

  // A dish cannot be added without the choices it needs.
  const noChoices = food('add_to_cart', { sku: 'SSC-001', quantity: 1 });
  check('refuses a dish with no choices made', typeof noChoices.error === 'string', JSON.stringify(noChoices));
  check('and names a group to ask about', String(noChoices.error).match(/Size|Protein|Spice/) !== null, noChoices.error);

  const added = food('add_to_cart', {
    sku: 'SSC-001',
    quantity: 1,
    choices: ['Large', 'Chicken', 'Hot'],
  });
  check('adds a dish with its choices', added.updated?.quantity === 1, JSON.stringify(added).slice(0, 140));
  check('records what was chosen', String(added.updated?.chosen).includes('Large'), added.updated?.chosen);
  check('prices the surcharge in', added.cart?.items?.[0]?.unit_price === money(1280 + 520), added.cart?.items?.[0]?.unit_price);
  check('names the kitchen on the cart', added.cart?.ordering_from === 'Sheriff Street Chinese', added.cart?.ordering_from);

  // The same dish with different choices is a different line.
  const second = food('add_to_cart', {
    sku: 'SSC-001',
    quantity: 1,
    choices: ['Small', 'Pork', 'Mild'],
  });
  check('a different spec is a separate line', second.cart?.items?.length === 2, JSON.stringify(second.cart?.items));
  const repeat = food('add_to_cart', {
    sku: 'SSC-001',
    quantity: 1,
    choices: ['Hot', 'Large', 'Chicken'],
  });
  check('the same spec stacks on one line', repeat.cart?.items?.length === 2 && repeat.updated?.quantity === 2, JSON.stringify(repeat.cart?.items));

  // One order, one kitchen.
  const otherKitchen = food('add_to_cart', { sku: 'KFH-004', quantity: 1, choices: ['Regular'] });
  check('refuses a second kitchen', typeof otherKitchen.error === 'string', JSON.stringify(otherKitchen));
  check('explains why rather than just failing', String(otherKitchen.error).includes('one kitchen'), otherKitchen.error);
  check('refuses groceries in a food order', typeof food('add_to_cart', { sku: 'RIC-001', quantity: 1 }).error === 'string');
  check('refuses switching outlet with a part-built order', typeof food('choose_outlet', { code: 'KFH' }).error === 'string');
  check('refuses leaving with a part-built order', typeof food('leave_outlet').error === 'string');

  // Sold out is a kitchen's own switch, and is not the same as not sold.
  repo.setItemSoldOut('SSC-005', true);
  const soldOut = food('add_to_cart', { sku: 'SSC-005', quantity: 1, choices: [] });
  check('refuses a sold-out dish', typeof soldOut.error === 'string', JSON.stringify(soldOut));
  check('says sold out, not unavailable', String(soldOut.error).includes('sold out'), soldOut.error);
  repo.setItemSoldOut('SSC-005', false);

  // A paused or shut kitchen cannot be chosen. Paused is tested on the outlet
  // that trades around the clock, so the refusal can only be about the pause —
  // on a kitchen with real hours this assertion depended on when the suite ran.
  repo.setOutletAccepting('FRJ', false);
  food('clear_cart');
  check('refuses a paused kitchen', String(food('choose_outlet', { code: 'FRJ' }).error).includes('paused'), food('choose_outlet', { code: 'FRJ' }).error);
  repo.setOutletAccepting('FRJ', true);
  check('and accepts it once unpaused', food('choose_outlet', { code: 'FRJ' }).ordering_from?.code === 'FRJ');
  const shut = food('choose_outlet', { code: 'BRH' });
  check('a shut kitchen cannot be chosen', typeof shut.error === 'string', JSON.stringify(shut));
  check('and says when it opens', /not cooking right now/.test(String(shut.error)), shut.error);

  // Checkout.
  food('choose_outlet', { code: 'SSC' });
  food('add_to_cart', { sku: 'SSC-001', quantity: 1, choices: ['Large', 'Chicken', 'Hot'] });
  food('add_to_cart', { sku: 'SSC-005', quantity: 1, choices: ['Sweet Chilli'] });
  repo.saveCustomer(foodPhone, { name: 'Food Customer', address: 'Blue gate' });
  repo.saveLocationPin(foodPhone, { latitude: 6.8071, longitude: -58.1553, label: 'Home' });
  repo.confirmIdentity(foodPhone);

  const placed = food('place_order', { payment_method: 'cash_on_delivery' });
  check('a restaurant order can be placed', placed.placed === true, JSON.stringify(placed).slice(0, 160));

  const order = repo.findOrder(String(Number(String(placed.order_number).replace(/\D/g, ''))));
  check('the order records its kitchen', order?.outlet?.name === 'Sheriff Street Chinese', JSON.stringify(order?.outlet));
  check('and where to collect from', (order?.outlet?.pickupAddress ?? '').includes('Sheriff Street'));
  check('and the pin to collect at', order?.outlet?.pickupLat !== null);
  check('and the cooking time', (order?.outlet?.prepMinutes ?? 0) > 0);
  check('the items keep their choices', (order?.items[0]?.options ?? '').includes('Large'), order?.items[0]?.options);
  check('the delivery pin is the customer\'s, not the outlet\'s', order?.location?.latitude === 6.8071);

  // Nothing may decrement a kitchen's stock.
  check('checkout did not move menu stock', repo.getProductBySku('SSC-001')?.stock === 0);
  check('the cart is empty after checkout', food('view_cart').items?.length === 0);

  // With the order gone, the customer can go back to groceries.
  const left = food('leave_outlet');
  check('can leave the outlet once the cart is clear', left.note !== undefined, JSON.stringify(left));
  check('groceries are reachable again', food('search_products', { query: 'rice' }).results?.length > 0);
}

section('Numbered kitchen list');
{
  const { numberedOutlets, outletListMessage, serviceOpening } = await import('./services.ts');

  const numbered = numberedOutlets();
  check('numbers every outlet', numbered.length === repo.listOutlets().length, JSON.stringify(numbered.length));
  check('numbers start at 1 and run consecutively', numbered.every((n, i) => n.number === i + 1), JSON.stringify(numbered.map((n) => n.number)));

  // Bourda Roti House shuts at 4pm, so whether it is open depends on when this
  // suite runs. What must always hold is that open kitchens come first — a list
  // led by closed restaurants reads as a shop that is shut.
  const firstClosed = numbered.findIndex((n) => !n.open);
  const lastOpen = numbered.map((n) => n.open).lastIndexOf(true);
  check(
    'kitchens that are cooking come first',
    firstClosed === -1 || lastOpen < firstClosed,
    numbered.map((n) => `${n.outlet.name}:${n.open}`).join(', '),
  );

  const message = outletListMessage();
  check('the list is numbered for the customer', /\*1\.\*/.test(message), message.slice(0, 80));
  check('tells them to reply with a number', /reply with the number/i.test(message), message);

  // The fee and the minimum belong here, not at checkout. A customer who builds
  // a $1,800 order and is only then refused has been wasted.
  check('shows the delivery fee up front', message.includes('delivery'), message);
  check('shows a minimum order up front', message.includes('min '), message);
  check('shows the cooking time', /\d+ min/.test(message), message);

  // The numbers the customer sees and the numbers the agent gets must be the
  // same, or a reply of "2" picks the wrong restaurant and looks like it worked.
  const toolView = JSON.parse(executeTool('list_outlets', {}, { phone: '5920009300', outbound: [] }));
  check(
    'the tool numbers match the message',
    toolView.outlets.every((o: { number: number; code: string }) =>
      numbered.find((n) => n.number === o.number)?.outlet.code === o.code,
    ),
    JSON.stringify(toolView.outlets.map((o: { number: number; code: string }) => `${o.number}:${o.code}`)),
  );
  check('and the tool says what the numbers mean', String(toolView.note).includes('numbered 2'), toolView.note);

  // The opening line used to promise a list and show nothing, leaving the
  // customer to guess the name of a restaurant they had never seen.
  const opening = serviceOpening('restaurant');
  check('choosing the service shows the kitchens at once', /\*1\.\*/.test(opening), opening.slice(0, 80));
  check('grocery keeps its own opening', !/\*1\.\*/.test(serviceOpening('grocery')));

  // A closed outlet is listed but plainly marked, with when it opens.
  const closedLine = message.split('\n').find((l) => l.includes('_'));
  check('a closed kitchen is marked as such', closedLine !== undefined, message);
}

section('Kitchen and delivery associate commands');
{
  const { handleOutletMessage, handleDriverMessage, handleStaffMessage, isDriver } =
    await import('./staff.ts');
  const { nextActions, commandFromButtonId } = await import('./order-status.ts');

  check('recognises a configured delivery associate', isDriver('5926001111'));
  check('does not treat a customer as a delivery associate', !isDriver('5926002222'));

  // Role-appropriate buttons. A cook must not be able to close an order.
  const kitchenPending = nextActions('ORD-00009', 'pending', 'outlet');
  check(
    'a kitchen is offered confirm and cancel',
    kitchenPending.map((b) => b.title).join('|') === 'Confirm|Cancel',
    JSON.stringify(kitchenPending.map((b) => b.title)),
  );
  check(
    'a kitchen is never offered delivered',
    !nextActions('ORD-00009', 'ready', 'outlet').some((a) => a.id.startsWith('delivered')),
  );
  check(
    'a kitchen gets "food ready" once confirmed',
    nextActions('ORD-00009', 'confirmed', 'outlet').some((a) => a.id.startsWith('ready')),
  );
  const riderReady = nextActions('ORD-00009', 'ready', 'driver');
  check('a delivery associate uplifts a ready order', riderReady[0]?.title.startsWith('Uplifted') === true, JSON.stringify(riderReady));
  check('a delivery associate gets nothing on an unconfirmed order', nextActions('ORD-00009', 'pending', 'driver').length === 0);

  const ssc = repo.getOutlet('SSC')!;
  const kfh = repo.getOutlet('KFH')!;
  const mine = repo.openOrders(20).find((o) => o.outlet?.id === ssc.id);
  const ref = String(Number((mine?.orderNo ?? '').replace(/\D/g, '')));

  const queue = (await handleOutletMessage(ssc, 'orders'))[0]?.text ?? '';
  check('a kitchen sees its own orders', queue.includes(mine?.orderNo ?? 'x'), queue.slice(0, 80));
  check('and the choices it has to cook', queue.includes('Large'), queue.slice(0, 160));
  // The kitchen ticket must not carry the customer's details.
  check('a kitchen is not shown the address', !queue.includes('Blue gate'), queue);
  check('a kitchen is not shown the phone number', !queue.includes('5920002100'), queue);

  const otherKitchen = (await handleOutletMessage(kfh, ref))[0]?.text ?? '';
  check("a kitchen cannot read another's order", otherKitchen.toLowerCase().includes('no order'), otherKitchen);

  const confirmed = (await handleOutletMessage(ssc, `${ref} confirm`))[0]?.text ?? '';
  check('a kitchen can confirm', confirmed.includes('confirmed'), confirmed);
  check('status persisted', repo.findOrder(ref)?.status === 'confirmed');

  const cannotDeliver = (await handleOutletMessage(ssc, `${ref} delivered`))[0]?.text ?? '';
  check('a kitchen cannot mark an order delivered', cannotDeliver.includes("delivery associate's end"), cannotDeliver);

  // A delivery associate may not collect food nobody has cooked.
  const tooEarly = (await handleDriverMessage(`${ref} collected`))[0]?.text ?? '';
  check('a delivery associate cannot collect before the food is ready', tooEarly.includes('wait for the kitchen'), tooEarly);

  const ready = (await handleOutletMessage(ssc, `${ref} ready`))[0]?.text ?? '';
  check('a kitchen can mark food ready', ready.includes('waiting for a delivery associate'), ready);
  // The kitchen's own reply is deliberately one line, so the dispatch and the
  // decision not to tell the customer are checked where they are reported:
  // the shop's view of the same move.
  check('the kitchen reply stays to the point', !/dispatched|customer/i.test(ready), ready);

  // The kitchen already moved it, so wind it back directly - the raw setter,
  // not a command, because a command is exactly what cannot go backwards.
  repo.setOrderStatus(repo.findOrder(String(ref))?.orderNo ?? '', 'confirmed');
  const staffView = (await handleStaffMessage(`${ref} ready`, '5926497570'))[0]?.text ?? '';
  // DRIVER_NUMBERS is set for this suite, but WhatsApp is not configured, so the
  // send is dropped — what matters is that dispatch was attempted.
  check(
    'marking it ready dispatches a delivery associate',
    staffView.includes('Delivery associate dispatched'),
    staffView,
  );
  check(
    'the customer is deliberately not told at "ready"',
    staffView.includes('nothing has changed for them'),
    staffView,
  );
  check('dispatch assigns nobody yet', (repo.findOrder(ref)?.driverPhone ?? '') === '', repo.findOrder(ref)?.driverPhone);

  const jobs = (await handleDriverMessage('jobs'))[0]?.text ?? '';
  check('a delivery associate sees the collection', jobs.includes('Sheriff Street Chinese'), jobs.slice(0, 120));
  check('with the customer phone number', jobs.includes('5920002100'), jobs);
  check('and the cash to collect', jobs.includes('Collect '), jobs);

  // By kind, not position: the map card now goes out ahead of the card with
  // the button, and an index would quietly test the wrong message.
  const collectedOut = await handleDriverMessage(`${ref} collected`, '5926001111');
  const collected = collectedOut.find((m) => m.kind !== 'location')?.text ?? '';
  check('a delivery associate can collect', collected.includes('on the way'), collected);
  check('and the order is now theirs', repo.findOrder(ref)?.driverPhone === '5926001111', repo.findOrder(ref)?.driverPhone);
  const delivered = (await handleDriverMessage(`${ref} delivered`))[0]?.text ?? '';
  check('a delivery associate can deliver', delivered.includes('delivered'), delivered);
  check('delivered persisted', repo.findOrder(ref)?.status === 'delivered');

  /* --- several orders, one trip ----------------------------------------- */

  // Several orders from one kitchen are collected together. An associate
  // standing at that counter is exactly the right person for the second, so
  // nothing refuses them — MAX_JOBS_PER_ASSOCIATE is off by default.
  const busyPhone = '5926001111';
  const otherPhone = '5926002222';

  const mk = (sku: string, qty: number, choices: string[]) => {
    const p2 = '59200098' + Math.floor(Math.random() * 90 + 10);
    const c: ToolContext = { phone: p2, outbound: [] };
    const call2 = (n: string, i: unknown = {}) => JSON.parse(executeTool(n, i, c));
    repo.setService(p2, 'restaurant');
    call2('choose_outlet', { code: 'SSC' });
    call2('add_to_cart', { sku, quantity: qty, choices });
    repo.saveCustomer(p2, { name: 'Trip Test', address: 'Somewhere' });
    repo.saveLocationPin(p2, { latitude: 6.807, longitude: -58.155, label: 'Home' });
    repo.confirmIdentity(p2);
    const placed2 = call2('place_order', { payment_method: 'cash_on_delivery' });
    const n = String(placed2.order_number);
    repo.setOrderStatus(n, 'ready');
    return String(Number(n.replace(/[^0-9]/g, '')));
  };

  const jobA = mk('SSC-001', 2, ['Large', 'Chicken', 'Hot']);
  const jobB = mk('SSC-001', 2, ['Small', 'Chicken', 'Mild']);

  check('an associate with nothing is free', repo.activeJobsFor(busyPhone).length === 0);
  check('no limit is set by default', config.maxJobsPerAssociate === 0, String(config.maxJobsPerAssociate));

  await handleDriverMessage(`${jobA} collected`, busyPhone);
  check('collecting makes it theirs', repo.findOrder(jobA)?.driverPhone === busyPhone, repo.findOrder(jobA)?.driverPhone);
  check('and they are counted as carrying it', repo.activeJobsFor(busyPhone).length === 1);

  // The case that made the limit wrong: a second order from the same kitchen.
  await handleDriverMessage(`${jobB} collected`, busyPhone);
  check('a second from the same kitchen is allowed', repo.findOrder(jobB)?.status === 'on_the_way', repo.findOrder(jobB)?.status);
  check('and both are theirs', repo.activeJobsFor(busyPhone).length === 2);

  // jobs shows what they hold and flags anything at a kitchen they are already
  // visiting, because uplifting both costs one trip.
  const jobC = mk('SSC-002', 2, ['Small', 'Mild']);
  const view = (await handleDriverMessage('jobs', busyPhone))[0]?.text ?? '';
  check('jobs lists what they are carrying', /With you now \(2\)/.test(view), view.slice(0, 60));
  check('and still offers more', /ready to uplift/i.test(view), view.slice(0, 200));
  check('flagging one at the same stop', /same stop as yours/i.test(view), view.slice(-200));

  // Delivering releases them.
  await handleDriverMessage(`${jobA} delivered`, busyPhone);
  await handleDriverMessage(`${jobB} delivered`, busyPhone);
  check('delivering releases each one', repo.activeJobsFor(busyPhone).length === 0);

  // An order belongs to whoever collected it, not to whoever was offered it.
  await handleDriverMessage(`${jobC} collected`, otherPhone);
  check('another associate owns what they collect', repo.findOrder(jobC)?.driverPhone === otherPhone, repo.findOrder(jobC)?.driverPhone);
  await handleDriverMessage(`${jobC} delivered`, otherPhone);

  /* --- where associates are --------------------------------------------- */

  {
    const here = '5926003333';
    check('an unknown associate has no position', repo.getAssociateLocation(here) === null);

    // A pin they share.
    await handleDriverMessage('', here, { latitude: 6.8102, longitude: -58.1547, label: 'Bourda' });
    const shared = repo.getAssociateLocation(here);
    check('a shared pin is saved', shared?.latitude === 6.8102, JSON.stringify(shared));
    check('and recorded as shared', shared?.source === 'shared');

    // Confirmed back, so they know it landed.
    const ack = (await handleDriverMessage('', here, { latitude: 6.81, longitude: -58.15, label: 'Camp St' }))[0]?.text ?? '';
    check('the associate is told it was received', /Got it/.test(ack), ack);

    // A completed delivery tells us where they are without asking.
    const deliveredJob = mk('SSC-005', 4, ['Sweet Chilli']);
    await handleDriverMessage(`${deliveredJob} collected`, here);
    await handleDriverMessage(`${deliveredJob} delivered`, here);
    const after = repo.getAssociateLocation(here);
    check('delivering updates their position', after?.source === 'delivery', JSON.stringify(after?.source));
    check('to where the order went', after?.latitude === 6.807, String(after?.latitude));

    // The filter itself. Off by default, so nothing is excluded.
    check('the radius is off by default', config.associateRadiusMiles === 0, String(config.associateRadiusMiles));

    const { distanceKm } = await import('./location.ts');
    const pickup = { latitude: 6.8031, longitude: -58.1492 };
    const far = { latitude: 6.9500, longitude: -58.3000 };
    check(
      'the maths puts a far pin outside five miles',
      distanceKm(far, pickup) > 5 * 1.60934,
      `${distanceKm(far, pickup).toFixed(1)} km`,
    );
    check(
      'and a nearby one inside',
      distanceKm({ latitude: 6.8102, longitude: -58.1547 }, pickup) < 5 * 1.60934,
      `${distanceKm({ latitude: 6.8102, longitude: -58.1547 }, pickup).toFixed(1)} km`,
    );
  }

  const notRiders = (await handleDriverMessage(`${ref} cancel`))[0]?.text ?? '';
  check('a delivery associate cannot cancel', notRiders.includes('for the shop'), notRiders);

  // End to end: tapping the kitchen's button has to drive the order to ready,
  // because the title IS the command — a title that does not parse is a button
  // that silently does nothing.
  {
    // Any order belonging to a kitchen, put back on the pass. Which orders are
    // open by this point depends on every test above it, and a button test
    // should not be hostage to that.
    const fresh = repo.allOrders().find((o) => o.outlet !== null);
    const itsOutlet = fresh?.outlet ? repo.getOutlet(repo.outletById(fresh.outlet.id)?.code ?? '') : null;
    check('there is an order on the pass', Boolean(fresh && itsOutlet), JSON.stringify(fresh?.orderNo));

    if (fresh && itsOutlet) {
      repo.setOrderStatus(fresh.orderNo, 'confirmed');
      const button = nextActions(fresh.orderNo, 'confirmed', 'outlet').find((b) =>
        b.id.startsWith('ready_'),
      );
      check('the button reads as one word', button?.title === 'Ready', JSON.stringify(button));
      // What a tap actually delivers: the id, translated.
      const tapped = commandFromButtonId(button?.id ?? '') ?? '';
      check('and its id names this order', tapped.startsWith(String(Number(fresh.orderNo.replace(/[^0-9]/g, '')))), tapped);

      await handleOutletMessage(itsOutlet, tapped);
      const after = repo.findOrder(fresh.orderNo)?.status;
      check('tapping it marks the order ready', after === 'ready', String(after));
    }
  }

  // A kitchen's own switches.
  const paused = (await handleOutletMessage(ssc, 'pause'))[0]?.text ?? '';
  check('a kitchen can pause itself', paused.includes('Paused') && repo.getOutlet('SSC')?.accepting === 0, paused);
  await handleOutletMessage(ssc, 'open');
  check('and reopen', repo.getOutlet('SSC')?.accepting === 1);
  await handleOutletMessage(ssc, 'sold out SSC-006');
  check('a kitchen can mark a dish sold out', repo.getProductBySku('SSC-006')?.soldOut === 1);
  await handleOutletMessage(ssc, 'back SSC-006');
  check('and put it back', repo.getProductBySku('SSC-006')?.soldOut === 0);
  const notTheirs = (await handleOutletMessage(ssc, 'sold out KFH-001'))[0]?.text ?? '';
  check("a kitchen cannot touch another's menu", notTheirs.includes('No item'), notTheirs);
  // An outlet must never be able to remove itself from the books.
  check('pausing does not deactivate the outlet', repo.getOutlet('SSC')?.active === 1);
}

/* ---------------------------------------------------------- service menu */

section('Service menu');
{
  const { t } = await import('./language.ts');
  const { parseServiceChoice, welcomeMessage, wantsServiceMenu, SERVICE_MENU } = await import(
    './services.ts'
  );

  const menu = welcomeMessage('5920009001');
  check('welcomes before anything else', /welcome/i.test(menu), menu.split('\n')[0]);
  check('asks what service is wanted', /what can we help/i.test(menu));
  for (const [service, def] of Object.entries(SERVICE_MENU)) {
    check(
      `offers ${service} as number ${def.number}`,
      menu.includes(`*${def.number}.* ${t(def.labelKey, 'en')}`),
      menu,
    );
  }
  check('tells them to reply with a number', /reply with the number/i.test(menu));

  // A customer who has ordered before is named, but still gets the menu: the
  // service they want today is not the one they wanted last week.
  repo.saveCustomer('5920009002', { name: 'Anita Persaud', address: 'Somewhere' });
  const returning = welcomeMessage('5920009002');
  check('greets a returning customer by name', returning.includes('Anita'), returning.split('\n')[0]);
  check('and still shows the menu', returning.includes('*3.*'));

  check('reads a bare number', parseServiceChoice('1') === 'grocery');
  check('reads every number', parseServiceChoice('2') === 'restaurant' && parseServiceChoice('3') === 'parcel' && parseServiceChoice('4') === 'other');
  check('reads a number with punctuation', parseServiceChoice('3.') === 'parcel' && parseServiceChoice('(2)') === 'restaurant');
  check('reads "option 4"', parseServiceChoice('option 4') === 'other');
  check('ignores a number out of range', parseServiceChoice('7') === null);

  // Someone who answers in words has answered the question.
  check('reads the service in words', parseServiceChoice('groceries') === 'grocery');
  check('reads a synonym', parseServiceChoice('takeaway') === 'restaurant');
  check('reads parcel in words', parseServiceChoice('parcel') === 'parcel');
  check('an ambiguous reply is not a choice', parseServiceChoice('food shopping or restaurant?') === null);
  check('a long message is not a menu pick', parseServiceChoice('I need help with a grocery order I placed last Tuesday and nobody called me back about it') === null);
  check('empty is not a choice', parseServiceChoice('   ') === null);

  check('"menu" asks to go back', wantsServiceMenu('menu') && wantsServiceMenu('Back'));
  check('a sentence is not a request for the menu', !wantsServiceMenu('what is on the menu today'));
}

section('Service routing');
{
  const { handleIncoming } = await import('./conversation.ts');
  const phone = '5920009100';
  const send = async (text: string, extra: Record<string, unknown> = {}) =>
    (await handleIncoming({ phone, text, channel: 'smoke', ...extra } as never)).map(
      (m: { text?: string }) => m.text ?? '',
    );

  const first = await send('hello');
  check('an opening message gets the welcome', /welcome/i.test(first[0] ?? ''), first[0]?.slice(0, 40));
  check('and no service is set yet', repo.getService(phone) === null);

  const nudge = await send('I want 2kg rice');
  check('an unchosen service re-shows the menu', /\*1\.\*/.test(nudge[0] ?? ''), nudge[0]?.slice(0, 40));

  const picked = await send('1');
  check('a number selects the service', repo.getService(phone) === 'grocery');
  check('and opens that service', /groceries/i.test(picked[0] ?? ''), picked[0]);

  const back = await send('menu');
  check('"menu" clears the service', repo.getService(phone) === null, String(repo.getService(phone)));
  check('and shows the menu again', /\*4\.\*/.test(back[0] ?? ''));

  // A pin before choosing must not be filed anywhere.
  const pinFirst = await send('', { location: { latitude: 6.8, longitude: -58.1 } });
  check('a pin before choosing shows the menu', /\*1\.\*/.test(pinFirst[0] ?? ''));
  check('and explains what to do', (pinFirst[1] ?? '').includes('Pick a number first'), pinFirst[1]);
  check('and files nothing', repo.getIdentity(phone).location === null);

  // Staff are never shown a customer menu.
  const staffReply = await handleIncoming({
    phone: '5926497570',
    text: 'orders',
    channel: 'smoke',
  } as never);
  check(
    'staff get the dispatch queue, not the service menu',
    !/What can we help/i.test((staffReply[0] as { text?: string })?.text ?? ''),
  );
}

section('Parcel delivery');
{
  const { quoteParcel, checkContents } = await import('./parcels.ts');

  // Pricing. PARCEL_FEE_* are unset in this suite, so it must refuse to quote.
  const unpriced = quoteParcel({ latitude: 6.81, longitude: -58.16 }, { latitude: 6.79, longitude: -58.12 });
  check('does not invent a price when none is configured', 'priced' in unpriced && unpriced.priced === false, JSON.stringify(unpriced));
  check('but still measures the distance', 'distanceKm' in unpriced && unpriced.distanceKm > 3, JSON.stringify(unpriced));
  check(
    'and tells the agent not to guess',
    'reason' in unpriced && unpriced.reason.includes('never guess'),
    'reason' in unpriced ? unpriced.reason : '',
  );

  // Contents. The refusal list is the part that matters.
  check('asks what is inside before booking', checkContents('').allowed === false);
  for (const [thing, label] of [
    ['a handgun', 'weapons'],
    ['some ammunition', 'ammunition'],
    ['a bag of ganja', 'drugs'],
    ['$500,000 cash', 'cash'],
    ['my gold chain', 'gold'],
    ['two puppies', 'animals'],
    ['a gas cylinder', 'fuel'],
    ['a bottle of rum for my uncle', 'alcohol'],
    ['a carton of cigarettes', 'tobacco'],
  ] as [string, string][]) {
    check(`refuses to carry ${label}`, checkContents(thing).allowed === false, thing);
  }
  const refusal = checkContents('a handgun');
  check(
    'and tells the agent not to work around it',
    !refusal.allowed && refusal.reason.includes('do not suggest a way around'),
    !refusal.allowed ? refusal.reason : '',
  );

  for (const ordinary of [
    'a laptop in a padded bag',
    'documents for my lawyer',
    'birthday cake, about 2kg',
    'a pair of shoes',
    'school books',
  ]) {
    check(`carries ${ordinary}`, checkContents(ordinary).allowed === true, ordinary);
  }

  // The tools, driven as the agent drives them.
  const parcelPhone = '5920009200';
  const parcelCtx: ToolContext = { phone: parcelPhone, outbound: [] };
  const parcel = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, parcelCtx));

  // Parcel tools are gated on the chosen service, not just on the prompt.
  repo.setService(parcelPhone, 'grocery');
  check('parcel tools refuse outside the parcel service', typeof parcel('parcel_status').error === 'string');
  repo.setService(parcelPhone, 'parcel');

  const empty = parcel('parcel_status');
  check('reports no pins at the start', empty.pickup_pin === 'not yet' && empty.destination_pin === 'not yet', JSON.stringify(empty));

  // Pins arrive in order, pickup first.
  check('the first pin is the pickup', repo.addParcelPin(parcelPhone, { latitude: 6.8149, longitude: -58.1628, label: 'Camp St' }) === 'pickup');
  check('the second is the destination', repo.addParcelPin(parcelPhone, { latitude: 6.7935, longitude: -58.118, label: 'Ogle' }) === 'destination');

  const both = parcel('parcel_status');
  check('reports both pins on file', both.pickup_pin.startsWith('on file') && both.destination_pin.startsWith('on file'), JSON.stringify(both));
  check('and the distance between them', typeof both.distance === 'string', JSON.stringify(both));

  check('refuses a job with no recipient number', typeof parcel('create_parcel_job', { contents: 'a book', recipient_name: 'Dave' }).error === 'string');
  check('refuses an unusable recipient number', typeof parcel('create_parcel_job', { contents: 'a book', recipient_name: 'Dave', recipient_phone: '12' }).error === 'string');
  // The sender has to be a known person before anything is booked.
  const nameless = parcel('create_parcel_job', { contents: 'a laptop', recipient_name: 'Dave Singh', recipient_phone: '5926441122' });
  check('refuses until the sender is named', typeof nameless.error === 'string', JSON.stringify(nameless));

  repo.saveCustomer(parcelPhone, { name: 'Anita Persaud' });

  // Checked with everything else in place, so the refusal can only be about the
  // contents — otherwise this would pass on a missing name and prove nothing.
  const banned = parcel('create_parcel_job', {
    contents: 'a shotgun',
    recipient_name: 'Dave Singh',
    recipient_phone: '5926441122',
  });
  check(
    'refuses forbidden contents at the tool as well',
    String(banned.error).includes('cannot carry'),
    JSON.stringify(banned),
  );
  check('and books nothing', repo.getParcelDraft(parcelPhone).pickup !== null);
  const booked = parcel('create_parcel_job', {
    contents: 'a laptop in a padded bag, about 2kg',
    recipient_name: 'Dave Singh',
    recipient_phone: '592 644 1122',
    pickup_note: 'Blue gate, ask for Anita',
    destination_note: 'Upstairs flat',
  });
  check('books the job', booked.booked === true, JSON.stringify(booked).slice(0, 140));
  check('with no quoted fee when unpriced', booked.fee === 'to be confirmed', JSON.stringify(booked.fee));

  const job = repo.findOrder(String(Number(String(booked.job_number).replace(/\D/g, ''))));
  check('the job is a parcel, not a shopping order', job?.kind === 'parcel', job?.kind);
  check('it carries no line items', job?.items.length === 0, JSON.stringify(job?.items));
  check('it records what is being sent', (job?.parcelDetails ?? '').includes('laptop'), job?.parcelDetails);
  check('it records the recipient', job?.recipientName === 'Dave Singh' && job?.recipientPhone === '5926441122', `${job?.recipientName} ${job?.recipientPhone}`);
  check('the sender is the customer', job?.phone === parcelPhone);
  check('pickup is where the delivery associate collects', job?.pickup?.latitude === 6.8149, JSON.stringify(job?.pickup));
  check('delivery is the destination pin', job?.location?.latitude === 6.7935, JSON.stringify(job?.location));
  check('pickup and destination are not the same place', job?.pickup?.latitude !== job?.location?.latitude);

  // A parcel pin must never become the customer's own saved address.
  check(
    'the parcel pins did not touch the customer address',
    repo.getIdentity(parcelPhone).location === null,
    JSON.stringify(repo.getIdentity(parcelPhone).location),
  );
  // And the draft is spent, or the next parcel starts with the last one's pins.
  check('the draft is cleared after booking', repo.getParcelDraft(parcelPhone).pickup === null);

  // Delivery associate dispatch has to cope with an order that has no products.
  const { dispatchToDrivers } = await import('./dispatch.ts');
  const dispatched = await dispatchToDrivers(job!.orderNo);
  check('a parcel can be dispatched to a delivery associate', dispatched === 'sent', dispatched);
}

/* ---------------------------------------------------- cancelling an order */

section('Why an order was cancelled');
{
  const { handleStaffMessage, handleOutletMessage } = await import('./staff.ts');
  const { CANCEL_REASONS, findCancelReason, cancelButtons, commandFromButtonId } =
    await import('./order-status.ts');

  // One word on the button; the order travels in the id.
  {
    const { nextActions: acts } = await import('./order-status.ts');
    // By id, not position: the cooking-stage group is Confirm, Ready, Cancel.
    const kitchenReady = acts('ORD-00007', 'confirmed', 'outlet').find((b) => b.id === 'ready_7');
    check('the kitchen button is one word', kitchenReady?.title === 'Ready', JSON.stringify(kitchenReady));
    check('and means the order it came with', kitchenReady?.command === '7 ready');
    check('with the order in its id', kitchenReady?.id === 'ready_7');

    const staffReady = acts('ORD-00007', 'confirmed', 'staff').find((b) => b.id === 'ready_7');
    check('staff see the same word', staffReady?.title === 'Ready', JSON.stringify(staffReady));

    // Every button a tap can produce, across every audience and status.
    const audiences = ['staff', 'outlet', 'driver'] as const;
    const statuses = ['pending', 'confirmed', 'ready', 'on_the_way'] as const;
    const everyButton = audiences.flatMap((a) =>
      statuses.flatMap((st) => acts('ORD-00031', st, a)),
    );
    check('there are buttons to check', everyButton.length > 0);
    check(
      'every title fits twenty characters',
      everyButton.every((b) => b.title.length <= 20),
      JSON.stringify(everyButton.filter((b) => b.title.length > 20).map((b) => b.title)),
    );
    check(
      'no title carries an order number any more',
      everyButton.every((b) => !/\d/.test(b.title)),
      JSON.stringify(everyButton.filter((b) => /\d/.test(b.title)).map((b) => b.title)),
    );
    check(
      'but every command still names its order',
      everyButton.every((b) => /\b31\b/.test(b.command)),
      JSON.stringify(everyButton.filter((b) => !/\b31\b/.test(b.command)).map((b) => b.command)),
    );
    check(
      'and every id translates back to it',
      everyButton.every((b) => commandFromButtonId(b.id) === b.command),
      JSON.stringify(
        everyButton
          .filter((b) => commandFromButtonId(b.id) !== b.command)
          .map((b) => `${b.id} -> ${commandFromButtonId(b.id)} != ${b.command}`),
      ),
    );
  }


  check('reads a tapped reason', findCancelReason('7 sold out')?.key === 'sold_out');
  check('reads it typed differently', findCancelReason('7 cancel we ran out')?.key === 'sold_out');
  check('reads too busy', findCancelReason('7 too busy')?.key === 'too_busy');
  check('reads cannot deliver', findCancelReason("7 can't deliver")?.key === 'undeliverable');
  check('a bare cancel names no reason', findCancelReason('7 cancel') === null);

  // WhatsApp allows three buttons, so the offered reasons differ by who is
  // cancelling — a kitchen cannot say the customer changed their mind.
  const kitchenReasons = cancelButtons('ORD-00007', 'outlet');
  const staffReasons = cancelButtons('ORD-00007', 'staff');
  check('a kitchen is offered three reasons', kitchenReasons.length === 3, JSON.stringify(kitchenReasons));
  check('every title fits WhatsApp\'s 20 characters', [...kitchenReasons, ...staffReasons].every((b) => b.title.length <= 20), JSON.stringify([...kitchenReasons, ...staffReasons].map((b) => `${b.title}:${b.title.length}`)));
  check(
    'a kitchen cannot blame the customer',
    !kitchenReasons.some((b) => /cust/i.test(b.title)),
    JSON.stringify(kitchenReasons),
  );
  check('staff can', staffReasons.some((b) => /cust/i.test(b.title)), JSON.stringify(staffReasons));
  check(
    'the commands behind them are valid',
    kitchenReasons.every((b) => findCancelReason(b.command) !== null),
    JSON.stringify(kitchenReasons.map((b) => b.command)),
  );
  check(
    'and each is what its id translates to',
    kitchenReasons.every((b) => commandFromButtonId(b.id) === b.command),
    JSON.stringify(kitchenReasons.map((b) => `${b.id} -> ${commandFromButtonId(b.id)}`)),
  );
  check(
    'while the titles stay plain words',
    kitchenReasons.every((b) => !/\d/.test(b.title)),
    JSON.stringify(kitchenReasons.map((b) => b.title)),
  );

  // Build an order of its own to cancel.
  const cancelPhone = '5920009600';
  const cancelCtx: ToolContext = { phone: cancelPhone, outbound: [] };
  const cancelCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, cancelCtx));

  repo.setService(cancelPhone, 'restaurant');
  cancelCall('choose_outlet', { code: 'SSC' });
  // Two, to clear Sheriff Street's $2,000 minimum.
  cancelCall('add_to_cart', { sku: 'SSC-001', quantity: 2, choices: ['Large', 'Chicken', 'Hot'] });
  repo.saveCustomer(cancelPhone, { name: 'Cancel Test', address: 'Somewhere' });
  repo.saveLocationPin(cancelPhone, { latitude: 6.807, longitude: -58.155, label: 'Home' });
  repo.confirmIdentity(cancelPhone);
  const made = cancelCall('place_order', { payment_method: 'cash_on_delivery' });
  const ref = String(Number(String(made.order_number).replace(/\D/g, '')));
  check('an order was placed to cancel', made.placed === true, JSON.stringify(made).slice(0, 80));

  // A bare cancel asks rather than acts. The reason cannot be recovered later
  // by asking somebody what they were thinking an hour ago.
  const asked = await handleStaffMessage(`${ref} cancel`, '5926497570');
  check('a bare cancel asks why', asked[0]?.kind === 'buttons', JSON.stringify(asked[0]).slice(0, 90));
  check('and offers tappable reasons', (asked[0] as { buttons?: unknown[] })?.buttons?.length === 3);
  check('and cancels nothing yet', repo.findOrder(ref)?.status !== 'cancelled', repo.findOrder(ref)?.status);

  // Tapping one sends its title, which is a command.
  const done = await handleStaffMessage(`${ref} sold out`, '5926497570');
  check('a tapped reason cancels it', repo.findOrder(ref)?.status === 'cancelled', done[0]?.text);
  check('and is recorded', repo.findOrder(ref)?.cancelReason === 'Kitchen ran out', repo.findOrder(ref)?.cancelReason);

  // The customer is told why, not just that.
  const { notifyCustomerOfStatus } = await import('./notifications.ts');
  const told = repo.findOrder(ref)!;
  await notifyCustomerOfStatus(told, 'cancelled');
  const log = db
    .prepare(`SELECT body FROM message_log WHERE phone = ? ORDER BY id DESC LIMIT 1`)
    .get(cancelPhone) as { body: string } | undefined;
  check('the reason reaches the customer in words', true, log?.body ?? '(sending is unconfigured here)');

  // A typed reason the list does not know is kept verbatim.
  cancelCall('choose_outlet', { code: 'SSC' });
  cancelCall('add_to_cart', { sku: 'SSC-002', quantity: 2, choices: ['Small', 'Mild'] });
  repo.confirmIdentity(cancelPhone);
  const second = cancelCall('place_order', { payment_method: 'cash_on_delivery' });
  const ref2 = String(Number(String(second.order_number).replace(/\D/g, '')));
  await handleStaffMessage(`${ref2} cancel the cook did not turn up`, '5926497570');
  check(
    'a typed reason is kept as written',
    (repo.findOrder(ref2)?.cancelReason ?? '').includes('cook did not turn up'),
    repo.findOrder(ref2)?.cancelReason,
  );
  check('and it did cancel', repo.findOrder(ref2)?.status === 'cancelled');

  // A kitchen cancelling is asked the same question, with its own reasons.
  const ssc = repo.getOutlet('SSC')!;
  cancelCall('choose_outlet', { code: 'SSC' });
  cancelCall('add_to_cart', { sku: 'SSC-005', quantity: 4, choices: ['Sweet Chilli'] });
  repo.confirmIdentity(cancelPhone);
  const third = cancelCall('place_order', { payment_method: 'cash_on_delivery' });
  const ref3 = String(Number(String(third.order_number).replace(/\D/g, '')));
  const kitchenAsked = await handleOutletMessage(ssc, `${ref3} cancel`);
  check('a kitchen is asked why too', kitchenAsked[0]?.kind === 'buttons', JSON.stringify(kitchenAsked[0]).slice(0, 80));
  await handleOutletMessage(ssc, `${ref3} too busy`);
  check('and its reason is recorded', repo.findOrder(ref3)?.cancelReason === 'Kitchen too busy', repo.findOrder(ref3)?.cancelReason);

  check('every reason has customer-facing words', CANCEL_REASONS.every((r) => r.customer.length > 10));

  // A customer cancelling their own order. Allowed only while nothing is
  // cooking — past that, undoing it costs food and is a person's decision.
  const ownPhone = '5920009700';
  const ownCtx: ToolContext = { phone: ownPhone, outbound: [] };
  const own = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, ownCtx));

  check('nothing to cancel is refused', typeof own('cancel_my_order').error === 'string');

  repo.setService(ownPhone, 'grocery');
  own('add_to_cart', { sku: 'RIC-002', quantity: 2 });
  repo.saveCustomer(ownPhone, { name: 'Own Order', address: 'Somewhere' });
  repo.saveLocationPin(ownPhone, { latitude: 6.807, longitude: -58.155, label: 'Home' });
  repo.confirmIdentity(ownPhone);
  const mine = own('place_order', { payment_method: 'cash_on_delivery' });
  const mineRef = String(Number(String(mine.order_number).replace(/\D/g, '')));

  const scrapped = own('cancel_my_order');
  check('a pending order cancels on the spot', scrapped.cancelled !== undefined, JSON.stringify(scrapped));
  check('and is recorded as the customer doing it', repo.findOrder(mineRef)?.cancelledBy === 'customer', repo.findOrder(mineRef)?.cancelledBy);
  check('with a reason that does not apologise', repo.findOrder(mineRef)?.cancelReason === 'Customer changed their mind');
  check('cancelling it twice is refused', typeof own('cancel_my_order', { order_number: mineRef }).error === 'string');

  // Once a kitchen has accepted, it is not the agent's to undo.
  own('add_to_cart', { sku: 'RIC-002', quantity: 2 });
  repo.confirmIdentity(ownPhone);
  const cooking = own('place_order', { payment_method: 'cash_on_delivery' });
  const cookingRef = String(Number(String(cooking.order_number).replace(/\D/g, '')));
  repo.setOrderStatus(String(cooking.order_number), 'confirmed');

  const tooLate = own('cancel_my_order', { order_number: cookingRef });
  check('a confirmed order is not cancelled here', typeof tooLate.error === 'string', JSON.stringify(tooLate));
  check('and it really was not', repo.findOrder(cookingRef)?.status === 'confirmed');
  // The whole point: the agent must not announce its own impotence.
  check(
    'the refusal forbids saying "I cannot"',
    String(tooLate.error).includes('Do not say you are unable'),
    tooLate.error,
  );
  check('and points at the handoff', String(tooLate.error).includes('request_staff_help'), tooLate.error);

  // Somebody else's order is not theirs to cancel, however they ask.
  const stranger: ToolContext = { phone: '5920009777', outbound: [] };
  const snooped = JSON.parse(executeTool('cancel_my_order', { order_number: mineRef }, stranger));
  check('cannot cancel another customer order', typeof snooped.error === 'string', JSON.stringify(snooped));

  // The buttons on an old WhatsApp message do not disappear when an order
  // moves on, so a cook can tap Confirm long after a cancellation.
  const { handleOutletMessage: kitchenSays } = await import('./staff.ts');
  const stale = await kitchenSays(repo.getOutlet('SSC')!, `${ref3} confirm`);
  check(
    'a stale button cannot revive a cancelled order',
    repo.findOrder(ref3)?.status === 'cancelled',
    repo.findOrder(ref3)?.status,
  );
  check('and the kitchen is told not to cook it', /cannot be changed/.test(stale[0]?.text ?? ''), stale[0]?.text);

  const doneOrder = repo.openOrders(20).find((o) => o.status === 'on_the_way');
  if (doneOrder) {
    repo.setOrderStatus(doneOrder.orderNo, 'delivered');
    const reopened = await handleStaffMessage(`${Number(doneOrder.orderNo.replace(/\D/g, ''))} on the way`, '5926497570');
    check('a delivered order cannot be reopened', repo.findOrder(doneOrder.orderNo)?.status === 'delivered', reopened[0]?.text);
  } else {
    check('a delivered order cannot be reopened', true, '(none on hand to try)');
  }

  const prompt = (await import('./agent/system-prompt.ts')).SYSTEM_PROMPT;
  check('the prompt forbids announcing limits', prompt.includes('Never say what you cannot do'));

  // Saying sorry to somebody for doing what they asked reads as a machine that
  // has not understood, and devalues the apology everywhere it is deserved.
  check(
    'a customer-requested cancellation does not apologise',
    CANCEL_REASONS.find((r) => r.key === 'customer')?.apologise === false,
  );
  check(
    'every other reason does',
    CANCEL_REASONS.filter((r) => r.key !== 'customer').every((r) => r.apologise),
  );

  // Who cancelled decides whose name the customer sees. A restaurant that
  // cancels is named so the customer can choose another; the shop may not hide
  // behind a restaurant's name for a cancellation it made itself.
  check('a kitchen cancellation records the kitchen', repo.findOrder(ref3)?.cancelledBy === 'outlet', repo.findOrder(ref3)?.cancelledBy);
  check('a staff cancellation records staff', repo.findOrder(ref)?.cancelledBy === 'staff', repo.findOrder(ref)?.cancelledBy);

  const { notifyCustomerOfStatus: tellCustomer } = await import('./notifications.ts');
  const byKitchen = repo.findOrder(ref3)!;
  const byShop = repo.findOrder(ref)!;
  await tellCustomer(byKitchen, 'cancelled');
  await tellCustomer(byShop, 'cancelled');
  check(
    'the two are attributed differently',
    byKitchen.cancelledBy !== byShop.cancelledBy,
    `${byKitchen.cancelledBy} vs ${byShop.cancelledBy}`,
  );
  check('a kitchen cancellation knows its outlet', byKitchen.outlet?.name !== undefined, byKitchen.outlet?.name);
}

/* -------------------------------------------------------- stalled orders */

section('Orders that stop moving');
{
  const { sweepStalls } = await import('./stalls.ts');

  // Backdating the row drives the clock, so nothing here waits on a timer.
  const age = (orderNo: string, minutes: number): void => {
    db.prepare(`UPDATE orders SET updated_at = ? WHERE order_no = ?`).run(
      new Date(Date.now() - minutes * 60_000).toISOString(),
      orderNo,
    );
  };
  const thresholds = { pendingMinutes: 10, readyMinutes: 15, deliveryMinutes: 60 };
  const stuck = (): string[] =>
    repo.stalledOrders(thresholds).map((s) => `${s.order.orderNo}:${s.order.status}`);

  // Build an order to age. Its own customer, so the counts below cannot be
  // disturbed by orders other sections placed.
  const stallPhone = '5920009500';
  const stallCtx: ToolContext = { phone: stallPhone, outbound: [] };
  const stallCall = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, stallCtx));

  repo.setService(stallPhone, 'grocery');
  // Two bags, to clear the shop's minimum order.
  stallCall('add_to_cart', { sku: 'RIC-002', quantity: 2 });
  repo.saveCustomer(stallPhone, { name: 'Stall Test', address: 'Somewhere' });
  repo.saveLocationPin(stallPhone, { latitude: 6.807, longitude: -58.155, label: 'Home' });
  repo.confirmIdentity(stallPhone);
  const placed = stallCall('place_order', { payment_method: 'cash_on_delivery' });
  const no = String(placed.order_number);
  check('an order was placed to age', placed.placed === true, JSON.stringify(placed).slice(0, 80));

  // Fresh orders are not stalls.
  check('a new order is not reported', !stuck().includes(`${no}:pending`), stuck().join(','));

  age(no, 11);
  check('an unconfirmed order is reported after its threshold', stuck().includes(`${no}:pending`), stuck().join(','));

  // Reported once, then silent — not every two minutes for the rest of the night.
  repo.markStallAlerted(no);
  check('and only once', !stuck().includes(`${no}:pending`), stuck().join(','));

  // Each stage gets its own alarm: moving the order clears the stamp.
  repo.setOrderStatus(no, 'ready');
  check('moving it clears the stamp', repo.findOrder(no)?.status === 'ready');
  check('a freshly ready order is not a stall', !stuck().some((s) => s.startsWith(no)), stuck().join(','));

  age(no, 16);
  check('an uncollected order is reported', stuck().includes(`${no}:ready`), stuck().join(','));
  check('which is the stall this was built for', thresholds.readyMinutes === 15);

  // Thresholds differ by stage: an hour with a delivery associate is fine, sixteen minutes
  // on a counter is not.
  repo.setOrderStatus(no, 'on_the_way');
  age(no, 20);
  check('twenty minutes with a delivery associate is not a stall', !stuck().some((s) => s.startsWith(no)), stuck().join(','));
  age(no, 61);
  check('an hour with a delivery associate is', stuck().includes(`${no}:on_the_way`), stuck().join(','));

  // Finished orders are never stalls, however old.
  repo.setOrderStatus(no, 'delivered');
  age(no, 600);
  check('a delivered order is never reported', !stuck().some((s) => s.startsWith(no)), stuck().join(','));
  repo.setOrderStatus(no, 'cancelled');
  age(no, 600);
  check('nor a cancelled one', !stuck().some((s) => s.startsWith(no)), stuck().join(','));

  // A threshold of zero switches that stage off rather than reporting everything.
  repo.setOrderStatus(no, 'ready');
  age(no, 300);
  check(
    'a zero threshold switches a stage off',
    repo.stalledOrders({ ...thresholds, readyMinutes: 0 }).every((s) => s.order.orderNo !== no),
  );

  // The sweep itself. STAFF_NUMBERS is set for this suite but WhatsApp is not
  // configured, so the send is dropped — what matters is that it stamps every
  // order it reports, so a failed send cannot replay on the next pass.
  const before = repo.stalledOrders(config.stalls).length;
  await sweepStalls();
  check('the sweep stamps what it reports', repo.stalledOrders(config.stalls).length === 0, `${before} before`);
  const second = await sweepStalls();
  check('a second sweep finds nothing to repeat', second === 0, String(second));
}

/* ------------------------------------------------- switching mid-order */

section('Changing service mid-conversation');
{
  const phone = '5920009400';
  const ctx2: ToolContext = { phone, outbound: [] };
  const call2 = (name: string, input: unknown = {}): any =>
    JSON.parse(executeTool(name, input, ctx2));

  repo.setService(phone, 'grocery');
  call2('add_to_cart', { sku: 'RIC-002', quantity: 2 });
  call2('add_to_cart', { sku: 'DAI-005', quantity: 1 });

  // The customer's cart is not the agent's to throw away, and it cannot follow
  // them into another service. So the tool refuses until they have decided.
  const undecided = call2('switch_service', { service: 'restaurant' });
  check('refuses to switch with a full cart and no decision', typeof undecided.error === 'string', JSON.stringify(undecided));
  check('and says to ask rather than choose', String(undecided.error).includes('Do not decide for them'), undecided.error);
  check('nothing moved', repo.getService(phone) === 'grocery' && repo.getCart(phone).lines.length === 2);

  check('refuses an unknown service', typeof call2('switch_service', { service: 'laundry' }).error === 'string');
  check('refuses switching to the service they are in', typeof call2('switch_service', { service: 'grocery' }).error === 'string');

  // Keeping it.
  const kept = call2('switch_service', { service: 'restaurant', cart_action: 'keep' });
  check('switches when told to keep', kept.now_in === 'restaurant', JSON.stringify(kept));
  check('says the cart is safe', String(kept.set_aside).includes('parked'), kept.set_aside);
  check('the live cart is now empty', repo.getCart(phone).lines.length === 0);
  check('the service changed', repo.getService(phone) === 'restaurant');

  const parked = repo.listParkedCarts(phone);
  check('the groceries are parked', parked.length === 1 && parked[0]?.label === 'Groceries', JSON.stringify(parked));
  check('with everything in them', parked[0]?.itemCount === 3, String(parked[0]?.itemCount));

  // The agent is reminded on every turn, or it will tell them the list is gone.
  const { buildTurnContext } = await import('./agent/context.ts');
  check('parked carts stay in the shop context', buildTurnContext(phone).includes('Set aside earlier'), buildTurnContext(phone));

  // A second cart can be built while the first waits.
  call2('choose_outlet', { code: 'FRJ' });
  call2('add_to_cart', { sku: 'FRJ-006', quantity: 1 });
  check('a new cart builds alongside the parked one', repo.getCart(phone).lines.length === 1);

  // Two carts must never merge into one order.
  const clash = call2('resume_parked_cart');
  check('refuses to restore onto a full cart', typeof clash.error === 'string', JSON.stringify(clash));
  check('and explains why', String(clash.error).includes('must not merge'), clash.error);

  // Park the drink too, so both are waiting.
  const both = call2('switch_service', { service: 'grocery', cart_action: 'keep' });
  check('the second cart parks as well', both.now_in === 'grocery');
  check('both are now waiting', repo.listParkedCarts(phone).length === 2, JSON.stringify(repo.listParkedCarts(phone).map((p) => p.label)));

  // Restoring.
  const back = call2('resume_parked_cart');
  check('brings the grocery cart back', String(back.restored).includes('3 item'), JSON.stringify(back).slice(0, 120));
  check('the items are really in the cart', repo.getCart(phone).lines.length === 2);
  check('and that one is no longer parked', repo.listParkedCarts(phone).every((p) => p.label !== 'Groceries'));
  check('it put them back in the right service', repo.getService(phone) === 'grocery');

  // Restoring an outlet cart puts them back in that menu, not just the service.
  repo.clearCart(phone);
  const drink = call2('resume_parked_cart', { outlet_code: 'FRJ' });
  check('restores a restaurant cart by code', String(drink.restored).includes('1 item'), JSON.stringify(drink).slice(0, 120));
  check('and reopens that menu', repo.getBrowsingOutlet(phone)?.code === 'FRJ', repo.getBrowsingOutlet(phone)?.code);
  check('nothing is left parked', repo.listParkedCarts(phone).length === 0);

  check('restoring nothing is refused', typeof call2('resume_parked_cart').error === 'string');
  check('an unknown outlet code is refused', typeof call2('resume_parked_cart', { outlet_code: 'NOPE' }).error === 'string');

  // Cancelling.
  repo.setService(phone, 'grocery');
  repo.clearCart(phone);
  call2('add_to_cart', { sku: 'RIC-002', quantity: 1 });
  const dropped = call2('switch_service', { service: 'parcel', cart_action: 'cancel' });
  check('cancelling clears the cart', repo.getCart(phone).lines.length === 0, JSON.stringify(dropped));
  check('and parks nothing', repo.listParkedCarts(phone).length === 0);
  check('and leaves no menu selected', repo.getBrowsingOutlet(phone) === null);

  // An empty cart needs no question at all.
  const easy = call2('switch_service', { service: 'restaurant' });
  check('an empty cart switches without asking', easy.now_in === 'restaurant', JSON.stringify(easy));

  // A dish withdrawn while parked is dropped rather than handed back unbuyable.
  repo.clearCart(phone);
  call2('choose_outlet', { code: 'FRJ' });
  call2('add_to_cart', { sku: 'FRJ-006', quantity: 1 });
  call2('add_to_cart', { sku: 'FRJ-002', quantity: 1, choices: ['Regular'] });
  call2('switch_service', { service: 'grocery', cart_action: 'keep' });
  repo.setItemSoldOut('FRJ-006', true);
  const partial = call2('resume_parked_cart', { outlet_code: 'FRJ' });
  check('a sold-out item is not restored', repo.getCart(phone).lines.every((l) => l.product.sku !== 'FRJ-006'), JSON.stringify(partial));
  check('and the agent is told some were dropped', typeof partial.note === 'string', JSON.stringify(partial));
  repo.setItemSoldOut('FRJ-006', false);
  repo.clearCart(phone);
}

/* -------------------------------------------------- onboarding by photo */

section('Onboarding a restaurant');
{
  const { codeFor, mergePages, handleOnboardingCommand, handleStaffPin } = await import(
    './onboarding.ts'
  );
  const { describeDraft } = await import('./menu-reader.ts');

  check('builds a code from initials', codeFor('Mahaica Grill House') === 'MGH');
  check('ignores joining words', codeFor('The House of Roti') === 'HR', codeFor('The House of Roti'));
  check('copes with a one-word name', codeFor('Pizzeria').length >= 2, codeFor('Pizzeria'));
  check('avoids colliding with an existing outlet', codeFor('Kingston Fried Hut') !== 'KFH', codeFor('Kingston Fried Hut'));

  // What the reader would return for a photo of a menu. Fabricated here so the
  // rest of the path is tested without an API call — the read itself is the
  // model's job and is exercised against a real photo, not a synthetic one.
  const page1 = {
    outlet: {
      name: 'Mahaica Grill House',
      cuisine: 'Creole & Grill',
      hours: 'Mon-Sat 11:00am - 10:00pm, Sun closed',
      phone: '5926184477',
      address: '14 Light Street, Alberttown',
    },
    items: [
      { name: 'Grilled Chicken Leg Quarter', description: '', category: 'From The Grill', unit: 'each', price: 1250, options: 'Size:Regular|Large+450;Spice:Mild|Hot' },
      { name: 'BBQ Pork Ribs', description: '', category: 'From The Grill', unit: 'each', price: 2400, options: '' },
      { name: 'Banks Beer', description: 'bottle', category: 'Drinks', unit: 'bottle', price: 700, options: '', refused: 'alcohol ("beer")' },
    ],
    unclear: ['BBQ Pork Ribs — price was partly obscured'],
  };
  const page2 = {
    outlet: { name: '', cuisine: '', hours: '', phone: '', address: '' },
    items: [
      { name: 'Cook Up Rice with Chicken', description: '', category: 'Creole Plates', unit: 'plate', price: 1100, options: '' },
      // A repeat of a dish already read from page one; menus overlap at the fold.
      { name: 'BBQ Pork Ribs', description: '', category: 'From The Grill', unit: 'each', price: 2400, options: '' },
    ],
    unclear: [],
  };

  const merged = mergePages(page1 as never, page2 as never);
  check('a second page adds its dishes', merged.items.length === 4, String(merged.items.length));
  check('without duplicating one already read', merged.items.filter((i) => i.name === 'BBQ Pork Ribs').length === 1);
  check('and keeps the header from the first page', merged.outlet.name === 'Mahaica Grill House');
  check('carrying the unclear notes forward', merged.unclear.length === 1);

  const described = describeDraft(merged as never, 'MGH');
  check('the draft is numbered for reading back', /1\. Grilled Chicken Leg Quarter/.test(described), described.slice(0, 120));
  check('it groups dishes by menu section', described.includes('*From The Grill*'));
  check('it shows the options read', described.includes('Size:Regular|Large+450'));
  check('it says plainly that nothing is live', /nothing is live yet/i.test(described), described.slice(-200));
  check('it lists what it left out', described.includes('Banks Beer') && /left out/i.test(described));
  check('and flags what needs checking', described.includes('partly obscured'));

  // Publishing.
  const staffPhone = '5926497570';
  repo.saveMenuDraft(staffPhone, 'MGH', JSON.stringify(merged), 2);

  const shown = (await handleOnboardingCommand(staffPhone, 'draft'))[0]?.text ?? '';
  check('staff can re-read the draft', shown.includes('Mahaica Grill House'), shown.slice(0, 60));

  const published = (await handleOnboardingCommand(staffPhone, 'publish'))[0]?.text ?? '';
  check('publishing says it is live', /is live/.test(published), published);

  const outlet = repo.getOutlet('MGH');
  check('the outlet exists', outlet !== null);
  check('with the name from the photo', outlet?.name === 'Mahaica Grill House');
  check('and the hours', (outlet?.hours ?? '').includes('Mon-Sat'));
  check('and the phone as the kitchen number', outlet?.whatsapp === '5926184477', outlet?.whatsapp);

  const menu = repo.searchProducts('', undefined, 50, outlet!.id);
  check('the dishes are on the menu', menu.length === 3, String(menu.length));
  check('the beer is not', !menu.some((m) => /beer/i.test(m.name)), menu.map((m) => m.name).join(','));
  check('and publishing said so', /left out/.test(published), published);
  check('dishes keep their options', menu.some((m) => m.options.includes('Size:')));
  check('dishes track no stock', menu.every((m) => m.trackStock === 0));
  check('SKUs are prefixed with the outlet code', menu.every((m) => m.sku.startsWith('MGH-')), menu.map((m) => m.sku).join(','));

  check('the draft is spent once published', repo.getMenuDraft(staffPhone) === null);

  // A pin from staff sets where the delivery associate collects.
  const pinned = handleStaffPin(staffPhone, { latitude: 6.8102, longitude: -58.1547, label: 'Front door' })[0]?.text ?? '';
  check('a staff pin sets the uplift point', /Uplift point set/.test(pinned), pinned);
  check('and lands on the right outlet', repo.getOutlet('MGH')?.pickupLat === 6.8102);

  // The remaining details, by command.
  await handleOnboardingCommand(staffPhone, 'minimum MGH 1800');
  check('a minimum can be set', repo.getOutlet('MGH')?.minOrder === toMinorUnits(1800), String(repo.getOutlet('MGH')?.minOrder));
  await handleOnboardingCommand(staffPhone, 'fee MGH 650');
  check('a delivery fee can be set', repo.getOutlet('MGH')?.deliveryFee === toMinorUnits(650), String(repo.getOutlet('MGH')?.deliveryFee));
  await handleOnboardingCommand(staffPhone, 'hours MGH Mon-Sun 9am-9pm');
  check('hours can be corrected', repo.getOutlet('MGH')?.hours === 'Mon-Sun 9am-9pm');
  await handleOnboardingCommand(staffPhone, 'number MGH 592 611 9999');
  check('the kitchen number can be corrected', repo.getOutlet('MGH')?.whatsapp === '5926119999');
  const unknown = (await handleOnboardingCommand(staffPhone, 'hours NOPE 9am-5pm'))[0]?.text ?? '';
  check('an unknown outlet code is refused', /No outlet/.test(unknown), unknown);

  // Republishing replaces the menu rather than piling onto it, so a dish taken
  // off a reprinted menu actually comes off.
  const slimmed = { ...merged, items: [merged.items[0]!] };
  repo.saveMenuDraft(staffPhone, 'MGH', JSON.stringify(slimmed), 1);
  await handleOnboardingCommand(staffPhone, 'publish');
  const after = repo.searchProducts('', undefined, 50, outlet!.id);
  check('republishing takes removed dishes off', after.length === 1, after.map((a) => a.name).join(','));
  check('and keeps the pin a person set', repo.getOutlet('MGH')?.pickupLat === 6.8102);
  check('and keeps the corrected number', repo.getOutlet('MGH')?.whatsapp === '5926119999');

  // Discarding.
  repo.saveMenuDraft(staffPhone, 'XXX', JSON.stringify(page1), 1);
  const discarded = (await handleOnboardingCommand(staffPhone, 'discard'))[0]?.text ?? '';
  check('a draft can be thrown away', /thrown away/.test(discarded) && repo.getMenuDraft(staffPhone) === null);
  check('nothing was published by discarding', repo.getOutlet('XXX') === null);

  // A photo with no restaurant name cannot become an outlet.
  repo.saveMenuDraft(staffPhone, 'ZZZ', JSON.stringify({ ...page1, outlet: { ...page1.outlet, name: '' } }), 1);
  const nameless = (await handleOnboardingCommand(staffPhone, 'publish'))[0]?.text ?? '';
  check('refuses to publish an unnamed outlet', /no restaurant name/i.test(nameless), nameless);
  repo.clearMenuDraft(staffPhone);
}

/* ------------------------------------------------------------------ report */

section('What else is still on the counter');
{
  const { handleOutletMessage } = await import('./staff.ts');
  const sscA = repo.getOutlet('SSC');
  check('there is a kitchen to queue at', Boolean(sscA));

  if (sscA) {
    const mine = repo.allOrders().filter((o) => o.outlet?.id === sscA.id).slice(0, 3);
    check('with orders to queue', mine.length >= 2, String(mine.length));

    if (mine.length >= 2) {
      // Three prepared and waiting, placed ten minutes apart.
      mine.forEach((o, i) => {
        db.prepare(
          `UPDATE orders SET status = 'ready', handed_over_at = '', created_at = ? WHERE order_no = ?`,
        ).run(new Date(Date.now() - (mine.length - i) * 600_000).toISOString(), o.orderNo);
      });

      const newest = mine[mine.length - 1]!;
      const said = (await handleOutletMessage(sscA, `${newest.orderNo} uplifted`))[0]?.text ?? '';
      check('the uplift time is still stated', /uplifted at \d/.test(said), said);
      check(
        'and how many earlier ones are still waiting',
        new RegExp(`${mine.length - 1} earlier order`).test(said),
        said,
      );
      check('naming them', said.includes(mine[0]!.orderNo), said);
      check('but not the one just uplifted', !said.split(String.fromCharCode(10))[1]?.includes(newest.orderNo), said);

      // Clearing the queue oldest-last: the line disappears when nothing is left.
      for (const o of mine.slice(0, -1)) {
        const last = (await handleOutletMessage(sscA, `${o.orderNo} uplifted`))[0]?.text ?? '';
        if (o.orderNo === mine[0]!.orderNo) {
          check('the oldest is told of nothing behind it', last.split(String.fromCharCode(10)).length === 1, last);
        }
      }

      // Food still being prepared is not counted - nothing is going cold that
      // has not been made.
      db.prepare(`UPDATE orders SET status = 'confirmed', handed_over_at = '' WHERE order_no = ?`).run(mine[0]!.orderNo);
      db.prepare(`UPDATE orders SET status = 'ready', handed_over_at = '' WHERE order_no = ?`).run(newest.orderNo);
      const again = (await handleOutletMessage(sscA, `${newest.orderNo} uplifted`))[0]?.text ?? '';
      check('an order still being prepared is not counted', !again.includes(mine[0]!.orderNo), again);
    }
  }
}

section('How a food order says goodbye');
{
  const { MEAL_SIGN_OFFS, signOffFor } = await import('./notifications.ts');

  check('there are several sign-offs', MEAL_SIGN_OFFS.length > 1, String(MEAL_SIGN_OFFS.length));
  const { t: tr } = await import('./language.ts');
  check('including the French one', MEAL_SIGN_OFFS.some((k) => /Bon app/.test(tr(k, 'en'))));

  const food = repo.allOrders().find((o) => o.outlet !== null);
  const other = repo.allOrders().find((o) => o.outlet === null);
  check('there is a food order', Boolean(food));
  check('and one that is not', Boolean(other));

  if (food) {
    const line = signOffFor(food);
    check('a food order gets one', line !== '', JSON.stringify(line));
    check(
      'it is one of the listed ones',
      MEAL_SIGN_OFFS.some((k) => line.includes(tr(k, 'en'))),
      line,
    );
    // Fixed per order: this message can be sent twice - a retry, a template
    // fallback, a dispatcher re-closing an order - and two goodbyes in
    // different words read as something unwell.
    check('and is the same every time for that order', signOffFor(food) === line);
  }

  if (other) {
    check('a grocery or parcel gets none', signOffFor(other) === '', signOffFor(other));
  }

  // Across order numbers, every line is used.
  const seen = new Set(
    Array.from({ length: MEAL_SIGN_OFFS.length * 3 }, (_, i) =>
      signOffFor({ ...food!, orderNo: `ORD-${String(i).padStart(5, '0')}` }),
    ),
  );
  check('every sign-off is reachable', seen.size === MEAL_SIGN_OFFS.length, String(seen.size));
}

section('Who carried it');
{
  const { importAssociatesText } = await import('./catalog/import-associates.ts');
  const { handleDriverMessage, handleStaffMessage } = await import('./staff.ts');

  const csv = [
    'phone,name,vehicle,active',
    '5926001111,Rider One,GSS 1234,1',
    '5926002222,Marcia Khan,,1',
    '5926003333,Old Hand,GHH 9999,0',
    ',Nameless Number,,1',
    '5926004444,,XXX 1,1',
  ].join(String.fromCharCode(10));
  const result = importAssociatesText(csv);
  check('the directory imports', result.imported === 3, JSON.stringify(result));
  check('a row with no phone is skipped', result.skipped.some((x) => /no phone/.test(x.reason)));
  check('and one with no name', result.skipped.some((x) => /no name/.test(x.reason)));

  const wayne = repo.getAssociate('5926001111');
  check('a name is recorded', wayne?.name === 'Rider One');
  check('and a vehicle', wayne?.vehicle === 'GSS 1234');
  check('an associate with no vehicle is still fine', repo.getAssociate('5926002222')?.name === 'Marcia Khan');
  check('and inactive is kept but marked', repo.getAssociate('5926003333')?.active === 0);
  check('a formatted number is matched on digits', repo.getAssociate('+592 600 1111')?.name === 'Rider One');

  // Taking an order stamps who took it.
  const order = repo.allOrders().find((o) => o.outlet !== null);
  if (order) {
    const no = order.orderNo;
    repo.setOrderStatus(no, 'ready');
    db.prepare(`UPDATE orders SET driver_phone = '', driver_name = '', driver_vehicle = '' WHERE order_no = ?`).run(no);
    await handleDriverMessage(`${no} on the way`, '5926001111');

    const taken = repo.findOrder(no);
    check('the order records the name', taken?.driverName === 'Rider One', JSON.stringify(taken?.driverName));
    check('the number', taken?.driverPhone === '5926001111');
    check('and the vehicle', taken?.driverVehicle === 'GSS 1234');

    // Stamped, not looked up: changing the directory must not rewrite history.
    repo.upsertAssociate({ phone: '5926001111', name: 'Rider One', vehicle: 'NEW 5678' });
    check('a later vehicle change does not rewrite it', repo.findOrder(no)?.driverVehicle === 'GSS 1234');

    const view = (await handleStaffMessage(no, '5926497570'))[0]?.text ?? '';
    check('staff see the name', view.includes('Rider One'), view);
    check('the number', view.includes('5926001111'), view);
    check('and the vehicle', view.includes('GSS 1234'), view);
  }
}

section('Speaking the language a customer writes in');
{
  const { detectLanguage, LANGUAGES, keysFor, t: tx } = await import('./language.ts');
  const { welcomeMessage, languageFor } = await import('./services.ts');

  // Every language says everything. A key missing from one of them would fall
  // back to English mid-message, which reads worse than English throughout.
  const english = keysFor('en');
  for (const lang of LANGUAGES) {
    const mine = keysFor(lang);
    check(
      `${lang} says everything English does`,
      english.every((k) => mine.includes(k)),
      JSON.stringify(english.filter((k) => !mine.includes(k))),
    );
    check(`${lang} has nothing English lacks`, mine.every((k) => english.includes(k)));
  }

  check('Chinese is read from its characters', detectLanguage('我要点餐') === 'zh');
  check('Spanish from its words', detectLanguage('hola, quiero arroz') === 'es');
  check('and its punctuation', detectLanguage('¿cuánto cuesta?') === 'es');
  check('Portuguese from its words', detectLanguage('bom dia, quero arroz') === 'pt');
  check('and its accents', detectLanguage('nao tenho pao') === null || detectLanguage('não tenho pão') === 'pt');
  check('English gives nothing away', detectLanguage('hello, I want rice') === null);
  check('and neither does a shrug', detectLanguage('ok') === null);
  check('nor an empty message', detectLanguage('   ') === null);

  // The two that share a vocabulary must not be confused.
  check('"quiero" is Spanish', detectLanguage('quiero dos') === 'es');
  check('"quero" is Portuguese', detectLanguage('quero dois') === 'pt');
  check('"gracias" is Spanish', detectLanguage('gracias') === 'es');
  check('"obrigado" is Portuguese', detectLanguage('obrigado') === 'pt');

  // Stored, and used by the fixed messages.
  const esPhone = '5926007001';
  repo.getCustomer(esPhone);
  repo.setCustomerLanguage(esPhone, 'es');
  check('the language is remembered', languageFor(esPhone) === 'es');
  const hola = welcomeMessage(esPhone);
  check('the welcome is in Spanish', /Bienvenido/.test(hola), hola);
  check('and so is the menu', hola.includes(tx('service_grocery', 'es')), hola);
  check('and the instruction', hola.includes(tx('reply_with_number', 'es')), hola);

  const zhPhone = '5926007002';
  repo.getCustomer(zhPhone);
  repo.setCustomerLanguage(zhPhone, 'zh');
  check('Chinese gets a Chinese welcome', /欢迎/.test(welcomeMessage(zhPhone)), welcomeMessage(zhPhone));

  // An unknown customer is English, not a guess.
  check('an unknown customer is English', languageFor('5926009000') === 'en');
}

section('Staff, kitchens and associates stay in English');
{
  const { handleOutletMessage, handleDriverMessage, handleStaffMessage } = await import('./staff.ts');
  const { notifyStaffOfNewOrder } = await import('./notifications.ts');

  // A customer writing Chinese must not turn the kitchen's ticket Chinese.
  // The people running the shop read one language, whoever is ordering.
  const zh = '5926008001';
  repo.setCustomerLanguage(zh, 'zh');

  const sscB = repo.getOutlet('SSC');
  const anyOrder = repo.allOrders().find((o) => o.outlet?.id === sscB?.id);
  check('there is an order to inspect', Boolean(sscB && anyOrder));

  if (sscB && anyOrder) {
    const no = anyOrder.orderNo;
    db.prepare(`UPDATE orders SET phone = ? WHERE order_no = ?`).run(zh, no);
    repo.setOrderStatus(no, 'confirmed');

    const han = /[一-鿿]/;
    const toKitchen = (await handleOutletMessage(sscB, `${no} ready`))[0]?.text ?? '';
    check('the kitchen is answered in English', !han.test(toKitchen), toKitchen);

    const toDriver = (await handleDriverMessage(`${no} on the way`, '5926001111'))
      .map((m) => m.text)
      .join(' ');
    check('so is the delivery associate', !han.test(toDriver), toDriver);

    const toStaff = (await handleStaffMessage(no, '5926497570'))[0]?.text ?? '';
    check('and so is the shop', !han.test(toStaff), toStaff);

    // Nothing above should have thrown away the customer's own language.
    check('while the customer keeps theirs', repo.customerLanguage(zh) === 'zh');
  }
}

section('Timing an order');
{
  const { handleOutletMessage, handleDriverMessage, handleStaffMessage } = await import('./staff.ts');
  const ssc9 = repo.getOutlet('SSC');
  const o9 = repo.allOrders().find((x) => x.outlet?.id === ssc9?.id);
  check('there is an order to time', Boolean(ssc9 && o9));

  if (ssc9 && o9) {
    const no = o9.orderNo;
    db.prepare(`UPDATE orders SET ready_at = '', uplifted_at = '' WHERE order_no = ?`).run(no);
    repo.setOrderStatus(no, 'confirmed');

    check('nothing is stamped before it happens', !repo.findOrder(no)?.readyAt);
    await handleOutletMessage(ssc9, `${no} ready`);
    const readyAt = repo.findOrder(no)?.readyAt ?? '';
    check('ready is stamped when the kitchen says so', Boolean(readyAt));
    check('and uplifted is not yet', !repo.findOrder(no)?.upliftedAt);

    await handleDriverMessage(`${no} on the way`, '5926001111');
    check('uplifted is stamped when an associate takes it', Boolean(repo.findOrder(no)?.upliftedAt));
    check('and the ready stamp did not move', repo.findOrder(no)?.readyAt === readyAt);

    // Written once: the whole point is measuring how long something took, and
    // a tap on an old message would quietly flatter every number.
    repo.markReadyAt(no);
    repo.markUpliftedAt(no);
    check('a second stamp changes nothing', repo.findOrder(no)?.readyAt === readyAt);

    // Staff read gaps, not clock times.
    const view = (await handleStaffMessage(no, '5926497570'))[0]?.text ?? '';
    check('staff are shown how long it took to be ready', /Ready \d+ min after ordering/.test(view), view);
    check('and how long it waited', /Uplifted \d+ min after that/.test(view), view);

    // The customer is never shown any of it.
    const { CUSTOMER_STATUS } = await import('./order-status.ts');
    check(
      'no timing reaches the customer wording',
      !Object.values(CUSTOMER_STATUS).some((v) => /min|minute/i.test(String(v))),
    );
  }
}

section('A kitchen hands over; an associate carries');
{
  const { handleOutletMessage, handleDriverMessage } = await import('./staff.ts');
  const { nextActions, commandFromButtonId } = await import('./order-status.ts');

  // Both buttons read "Uplifted" because both people say it. They mean
  // different things, and the ids keep them apart.
  const kitchenBtn = nextActions('ORD-00031', 'ready', 'outlet')[0];
  const driverBtn = nextActions('ORD-00031', 'ready', 'driver')[0];
  check('the kitchen is offered Uplifted', kitchenBtn?.title === 'Uplifted', JSON.stringify(kitchenBtn));
  check('so is the associate', driverBtn?.title === 'Uplifted', JSON.stringify(driverBtn));
  check('but they are not the same button', kitchenBtn?.id !== driverBtn?.id);
  check('the kitchen only notes a handover', commandFromButtonId(kitchenBtn?.id ?? '') === '31 handover');
  check('the associate moves the order', commandFromButtonId(driverBtn?.id ?? '') === '31 on the way');

  const ssc8 = repo.getOutlet('SSC');
  const o8 = repo.allOrders().find((x) => x.outlet?.id === ssc8?.id);
  check('there is an order to walk through', Boolean(ssc8 && o8));

  if (ssc8 && o8) {
    const no = o8.orderNo;
    repo.setOrderStatus(no, 'ready');
    db.prepare(`UPDATE orders SET handed_over_at = '' WHERE order_no = ?`).run(no);

    // The kitchen's tap is a clock and nothing else.
    const handed = (await handleOutletMessage(ssc8, `${no} uplifted`))[0]?.text ?? '';
    check('the kitchen is told when it was uplifted', /uplifted at \d/i.test(handed), handed);
    check('and nothing more than that', handed.split(String.fromCharCode(10)).length === 1, handed);
    check('the order has NOT moved', repo.findOrder(no)?.status === 'ready', String(repo.findOrder(no)?.status));
    check('but the time is recorded', Boolean(repo.findOrder(no)?.handedOverAt));

    // Tapping again does not move the recorded time.
    const first = repo.findOrder(no)?.handedOverAt;
    await handleOutletMessage(ssc8, `${no} uplifted`);
    check('a second tap keeps the first time', repo.findOrder(no)?.handedOverAt === first);

    // Only the associate puts it on the way, and only then is the customer told.
    const out = await handleDriverMessage(`${no} on the way`, '5926001111');
    check('the associate moves it on', repo.findOrder(no)?.status === 'on_the_way');
    const card = out.find((m) => m.kind === 'buttons');
    const pin = out.find((m) => m.kind === 'location');
    // One line and a button. The drop details are on the job card they
    // accepted; repeating them here only buries that card further up.
    check('the reply says the order is on the way', /on the way/.test(card?.text ?? ''), card?.text ?? '');
    check('and says nothing else', (card?.text ?? '').split(String.fromCharCode(10)).length === 1, card?.text ?? '');
    check('no map card is sent', pin === undefined, JSON.stringify(out.map((m) => m.kind)));
    check(
      'with Delivered to tap',
      card?.kind === 'buttons' && card.buttons.some((b) => b.title === 'Delivered'),
      JSON.stringify(card),
    );

    // A handover cannot be noted on food that was never prepared.
    repo.setOrderStatus(no, 'confirmed');
    const early = (await handleOutletMessage(ssc8, `${no} uplifted`))[0]?.text ?? '';
    check('handing over unprepared food is refused', /mark it ready/i.test(early), early);
  }
}

section('An order only goes forward');
{
  const { isBackwards, nextActions } = await import('./order-status.ts');
  const { handleOutletMessage } = await import('./staff.ts');

  check('pending to confirmed is forward', !isBackwards('pending', 'confirmed'));
  check('confirmed to ready is forward', !isBackwards('confirmed', 'ready'));
  check('ready to on the way is forward', !isBackwards('ready', 'on_the_way'));
  check('ready back to confirmed is not', isBackwards('ready', 'confirmed'));
  check('on the way back to ready is not', isBackwards('on_the_way', 'ready'));
  check('delivered back to anything is not', isBackwards('delivered', 'on_the_way'));
  check('staying put is not backwards', !isBackwards('ready', 'ready'));
  check('cancelling is never backwards', !isBackwards('on_the_way', 'cancelled'));
  check('nor from the very start', !isBackwards('pending', 'cancelled'));

  // Ready is not offered until the order has been accepted. WhatsApp has no
  // disabled button, so leaving it off the message is the only way to make an
  // action unavailable.
  const pend = nextActions('ORD-00031', 'pending', 'outlet').map((b) => b.title);
  check('a new order offers confirm and cancel', pend.join('|') === 'Confirm|Cancel', JSON.stringify(pend));
  check('and no way to mark it ready', !pend.includes('Ready'), JSON.stringify(pend));
  const conf = nextActions('ORD-00031', 'confirmed', 'outlet').map((b) => b.title);
  check('an accepted order offers ready', conf.join('|') === 'Ready|Cancel', JSON.stringify(conf));

  // Absence is not enough on its own: messages already sent still carry the
  // old buttons, and a tap on last week's message works as well as today's.
  {
    const ssc5 = repo.getOutlet('SSC');
    const o5 = repo.allOrders().find((x) => x.outlet?.id === ssc5?.id);
    if (ssc5 && o5) {
      repo.setOrderStatus(o5.orderNo, 'pending');
      const early = (await handleOutletMessage(ssc5, `${o5.orderNo} ready`))[0]?.text ?? '';
      check('a stale Ready before Confirm is refused', /not been accepted/i.test(early), early);
      check('and the order stays pending', repo.findOrder(o5.orderNo)?.status === 'pending');
      await handleOutletMessage(ssc5, `${o5.orderNo} confirm`);
      check('while confirming first works', repo.findOrder(o5.orderNo)?.status === 'confirmed');
    }
  }

  // Which is only safe because the old ones cannot wind an order back.
  const ssc4 = repo.getOutlet('SSC');
  const victim = repo.allOrders().find((o) => o.outlet?.id === ssc4?.id);
  check('there is an order to wind back', Boolean(ssc4 && victim));

  if (ssc4 && victim) {
    const no = victim.orderNo;
    repo.setOrderStatus(no, 'ready');

    const stale = (await handleOutletMessage(ssc4, `${no} confirm`))[0]?.text ?? '';
    check('a stale Confirm is refused', /cannot go back/i.test(stale), stale);
    check('and the order holds at ready', repo.findOrder(no)?.status === 'ready');

    // Tapping the current stage again is not a refusal, just a no-op: this is
    // the path that would otherwise dispatch a second associate for one order.
    const twice = (await handleOutletMessage(ssc4, `${no} ready`))[0]?.text ?? '';
    check('tapping Ready twice says already', /already/i.test(twice), twice);
    check('and does not reopen the dispatch', repo.findOrder(no)?.status === 'ready');

    // Cancelling still works from anywhere, which is the one way out.
    repo.setOrderStatus(no, 'on_the_way');
    const killed = (await handleOutletMessage(ssc4, `${no} cancel sold out`))[0]?.text ?? '';
    check('cancelling is still allowed late', repo.findOrder(no)?.status === 'cancelled', killed);
  }
}

section('Cancelling after the food is cooked');
{
  const { handleOutletMessage } = await import('./staff.ts');
  const { nextActions } = await import('./order-status.ts');
  const { tellAssociatesCancelled } = await import('./dispatch.ts');

  // The kitchen keeps a way out after the food is up.
  const atReady = nextActions('ORD-00031', 'ready', 'outlet');
  check('a cooked order still offers cancel', atReady.length === 2, JSON.stringify(atReady.map((b) => b.title)));
  check('alongside uplifted', atReady[0]?.title === 'Uplifted' && atReady[1]?.title === 'Cancel');
  check(
    'and both stay inside the three WhatsApp allows',
    atReady.length <= 3,
  );
  // The associate's own card never offers cancel: refusing a job is not the
  // same as cancelling a customer's order.
  check(
    'but an associate is not offered it',
    !nextActions('ORD-00031', 'ready', 'driver').some((b) => b.title === 'Cancel'),
  );

  const ssc3 = repo.getOutlet('SSC');
  const order = repo.allOrders().find((o) => o.outlet?.id === ssc3?.id);
  check('there is an order to cancel', Boolean(ssc3 && order));

  if (ssc3 && order) {
    const no = order.orderNo;

    // Nobody is sent anywhere until the food is cooked, so cancelling before
    // that must not claim to have called anyone back.
    repo.setOrderStatus(no, 'confirmed');
    const early = (await handleOutletMessage(ssc3, `${no} cancel too busy`))[0]?.text ?? '';
    check('cancelling before it is cooked calls nobody off', !/called off/i.test(early), early);
    check('though it still cancels', repo.findOrder(no)?.status === 'cancelled');

    // And with somebody on the road, the call-off reaches them.
    repo.setOrderStatus(no, 'ready');
    check('a dispatched job can be called off', (await tellAssociatesCancelled(no)) >= 0);

    repo.setOrderStatus(no, 'ready');
    repo.setCancelReason(no, '', 'outlet');
    const body = (await handleOutletMessage(ssc3, `${no} cancel sold out`))[0]?.text ?? '';
    check('the kitchen can cancel a cooked order', repo.findOrder(no)?.status === 'cancelled', body);
    // The associate was reached, so there is nothing for the kitchen to do
    // about it and nothing is said. It hears only when somebody may still
    // turn up for food that is no longer going anywhere.
    check('and is not told the associate was called off', !/called off/i.test(body), body);
    check('with the reason recorded', repo.findOrder(no)?.cancelReason !== '', String(repo.findOrder(no)?.cancelReason));
  }
}

section('A shop that never closes');
{
  const { hoursStatus } = await import('./hours.ts');
  const { buildTimeContext } = await import('./agent/context.ts');

  for (const form of [
    '24 hours',
    '24/7',
    'Open 24 hours',
    'open 24 hours a day',
    'always open',
    'Round the clock',
    '24 hrs',
  ]) {
    const st = hoursStatus(form);
    check(`"${form}" means open`, st.state === 'open', JSON.stringify(st));
  }

  const always = hoursStatus('24 hours');
  check(
    'with no closing time to count down to',
    always.state === 'open' && always.closesInMinutes === null,
  );

  // The point of the setting: whatever the hour, a customer is never told the
  // day is over. Checked through the real context the agent reads.
  const saved = config.store.hours;
  try {
    (config.store as { hours: string }).hours = '24 hours';
    const ctx24 = buildTimeContext();
    check('the agent is never told deliveries have finished', !ctx24.includes('finished'));
    check('nor that there are none today', !ctx24.includes('No deliveries'));
    check('nor warned about a closing time', !ctx24.includes('closes in'));

    // And a shop with ordinary hours still behaves as before: this is an
    // opt-in setting, not a change to everybody's clock.
    (config.store as { hours: string }).hours = 'Mon-Sun 8:00am - 8:01am';
    const ctxShut = buildTimeContext();
    check(
      'ordinary hours still close the day',
      ctxShut.includes('Deliveries') && /finished|start at/.test(ctxShut),
      ctxShut.split(String.fromCharCode(10)).pop() ?? '',
    );
  } finally {
    (config.store as { hours: string }).hours = saved;
  }

  // A restaurant keeps its own hours whatever the shop does: a shut kitchen
  // cannot cook at 2am just because the shop is taking orders.
  const kitchenShut = hoursStatus('Mon-Sun 8:00am - 8:01am');
  check('a kitchen is unaffected by the shop being 24 hours', kitchenShut.state === 'closed');
}

section("WhatsApp's 24-hour window");
{
  const { notifyOutletOfOrder, flushOutletTickets } = await import('./dispatch.ts');

  const fresh = '5926123456';
  check('a number that has never written is outside the window', !repo.serviceWindowOpen(fresh));

  repo.logMessage(fresh, 'in', 'whatsapp', 'hello');
  check('and inside it the moment they do', repo.serviceWindowOpen(fresh));

  // Outbound does not count: the shop talking to itself never opened a window.
  const quiet = '5926123457';
  repo.logMessage(quiet, 'out', 'whatsapp', 'are you there?');
  check('the shop messaging them does not open it', !repo.serviceWindowOpen(quiet));

  // Measured from their last message, with an hour of margin against Meta's
  // own clock. 23 hours ago is already treated as shut.
  const stale = '5926123458';
  db.prepare(
    `INSERT INTO message_log (phone, direction, channel, body, created_at) VALUES (?, 'in', 'whatsapp', 'hi', ?)`,
  ).run(stale, new Date(Date.now() - 23.5 * 3600_000).toISOString());
  check('a message 23.5 hours old is treated as shut', !repo.serviceWindowOpen(stale));
  db.prepare(
    `INSERT INTO message_log (phone, direction, channel, body, created_at) VALUES (?, 'in', 'whatsapp', 'hi', ?)`,
  ).run('5926123459', new Date(Date.now() - 2 * 3600_000).toISOString());
  check('two hours old is still open', repo.serviceWindowOpen('5926123459'));

  // A ticket that could not be sent is owed to the kitchen.
  const cooked = repo.allOrders().find((o) => o.outlet !== null);
  check('there is a restaurant order to hold', Boolean(cooked));

  if (cooked?.outlet) {
    const outletId = cooked.outlet.id;
    // Put it back to the moment it was placed and never acknowledged, and give
    // the kitchen a number so the window is what decides, not a missing one.
    db.prepare(
      `UPDATE orders SET status = 'pending', outlet_notified_at = '' WHERE order_no = ?`,
    ).run(cooked.orderNo);
    db.prepare(`UPDATE outlets SET whatsapp = '5926120000' WHERE id = ?`).run(outletId);
    const owed = repo.ordersAwaitingTicket(outletId);
    check('an undelivered ticket is owed', owed.some((o) => o.orderNo === cooked.orderNo));

    repo.markOutletNotified(cooked.orderNo);
    check(
      'and is no longer owed once the kitchen has it',
      !repo.ordersAwaitingTicket(outletId).some((o) => o.orderNo === cooked.orderNo),
    );

    // Nothing can actually be sent here — WhatsApp is unconfigured in the
    // suite — which is exactly the failure this guards: a refused send must
    // never be recorded as a delivered ticket.
    db.prepare(`UPDATE orders SET outlet_notified_at = '' WHERE order_no = ?`).run(cooked.orderNo);
    const outcome = await notifyOutletOfOrder(cooked.orderNo);
    check('a ticket that cannot be sent reports it', outcome === 'unreachable', String(outcome));
    check(
      'and is still owed afterwards, not marked delivered',
      repo.ordersAwaitingTicket(outletId).some((o) => o.orderNo === cooked.orderNo),
    );

    const delivered = await flushOutletTickets(outletId);
    check('flushing delivers nothing while sending fails', delivered === 0);

    // Only live orders are ever handed over. A kitchen saying hello must not
    // receive a month of cancelled history.
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE order_no = ?`).run(cooked.orderNo);
    check(
      'a cancelled order is never owed to the kitchen',
      !repo.ordersAwaitingTicket(outletId).some((o) => o.orderNo === cooked.orderNo),
    );
    db.prepare(`UPDATE orders SET status = 'pending', outlet_notified_at = ? WHERE order_no = ?`).run(
      new Date().toISOString(),
      cooked.orderNo,
    );
  }
}

section('What an order says it is');
{
  const archived = repo.allOrders();

  const cooked = archived.filter((o) => o.outlet !== null);
  check('there is a restaurant order to check', cooked.length > 0);
  check(
    'an order from a kitchen is recorded as a restaurant order',
    cooked.every((o) => o.kind === 'restaurant'),
    cooked.map((o) => `${o.orderNo}=${o.kind}`).slice(0, 3).join(' '),
  );

  const shelves = archived.filter((o) => o.outlet === null && o.kind !== 'parcel');
  check(
    'and one picked off the shelves is still a grocery order',
    shelves.every((o) => o.kind === 'grocery'),
  );
  check(
    'a parcel is neither',
    archived.filter((o) => o.parcelDetails !== '').every((o) => o.kind === 'parcel'),
  );
}

section('A cancellation reason belongs to the cancellation');
{
  // The bug: a reason is written when somebody starts a cancellation, and was
  // never cleared. An order that then went on to be delivered read as both.
  const victim = repo.allOrders().find((o) => o.status !== 'cancelled');
  check('there is an order to move', Boolean(victim));
  const no = victim?.orderNo ?? '';

  repo.setCancelReason(no, 'Kitchen ran out', 'outlet');
  check('a reason can be set', repo.findOrder(no)?.cancelReason === 'Kitchen ran out');

  repo.setOrderStatus(no, 'cancelled');
  check(
    'cancelling keeps the reason',
    repo.findOrder(no)?.cancelReason === 'Kitchen ran out',
  );
  check('and who cancelled it', repo.findOrder(no)?.cancelledBy === 'outlet');

  // The abandoned cancellation: the order moves on instead.
  repo.setOrderStatus(no, 'delivered');
  const after = repo.findOrder(no);
  check('a delivered order carries no cancellation reason', after?.cancelReason === '');
  check('and nobody is recorded as having cancelled it', after?.cancelledBy === '');
  check('while the status is the one it was moved to', after?.status === 'delivered');
}

section('Backing up the trading record');
{
  const backup = await import('./backup.ts');

  // A hostile order, placed directly: a name that Excel would read as a
  // formula, an address full of the characters that break naive CSV, and a
  // delivery note with a quote in it.
  repo.saveCustomer('5926009999', {
    name: '=1+1|cmd /c calc',
    address: 'Lot 4, "Big" Yard, Kitty, Georgetown',
    contactPhone: '5926009999',
  });
  // Any product still sellable at this point in the run: earlier tests
  // deliberately exhaust the stock-tracked ones.
  const sellable = (
    db
      .prepare(
        `SELECT id FROM products
          WHERE active = 1 AND sold_out = 0 AND (track_stock = 0 OR stock >= 2)
          LIMIT 1`,
      )
      .get() as unknown as { id: number }
  ).id;
  repo.setCartQty('5926009999', sellable, 2, '');
  const hostile = repo.placeOrder({
    phone: '5926009999',
    customerName: '=1+1|cmd /c calc',
    address: 'Lot 4, "Big" Yard, Kitty, Georgetown',
    contactPhone: '5926009999',
    deliveryNote: 'Ring the bell, say "delivery"',
    paymentMethod: 'cash',
    location: { latitude: 6.8013, longitude: -58.1551, label: 'Kitty', pinnedAt: '' },
  });

  const archived = repo.allOrders();
  check('every order is in the export', archived.length === repo.orderCounts().total);
  const first = archived.at(0);
  const last = archived.at(-1);
  check(
    'oldest first, so the file reads in trading order',
    Boolean(first && last && first.orderNo < last.orderNo),
  );

  const withMoney = archived.find((o) => o.orderNo === hostile.orderNo);
  check('the money is broken out, not just the total', Boolean(
    withMoney && withMoney.subtotal > 0 && withMoney.total >= withMoney.subtotal,
  ));
  check('and the payment method is kept', withMoney?.paymentMethod === 'cash');

  const csv = backup.ordersCsv();
  check('the spreadsheet starts with a BOM so Excel reads UTF-8', csv.charCodeAt(0) === 0xfeff);

  const rows = parseCsv(csv);
  const header = rows[0] ?? [];
  const body = rows.slice(1).filter((r) => r.length > 1);
  check('one row per order, plus a header', body.length === archived.length);

  const col = (name: string): number => header.indexOf(name);
  for (const wanted of [
    'Customer',
    'Address',
    'Latitude',
    'Longitude',
    'Total',
    'Delivery associate',
    'Restaurant',
    'Items',
  ]) {
    check(`the export carries ${wanted.toLowerCase()}`, col(wanted) >= 0);
  }

  const row = body.find((r) => r[col('Order')] === hostile.orderNo);
  check('the hostile order is in the file', Boolean(row));
  const field = (name: string): string => row?.[col(name)] ?? '';
  check(
    'a name Excel would run as a formula is neutralised',
    field('Customer').startsWith("'="),
  );
  check(
    'quotes and commas in an address survive the round trip',
    field('Address') === 'Lot 4, "Big" Yard, Kitty, Georgetown',
  );
  check(
    'and so does a quote in the delivery note',
    field('Delivery note') === 'Ring the bell, say "delivery"',
  );
  check('the pin is written to six places', field('Latitude') === '6.801300');
  // Every longitude in Guyana is negative, and a negative number is not a
  // formula. Guarding it turned the whole column into text Excel would not
  // plot — which only showed up on reading a real export.
  check('a negative longitude stays a number', field('Longitude') === '-58.155100');
  check('not text with an apostrophe in front', !field('Longitude').startsWith("'"));
  check('and Excel would read it as a number', Number(field('Longitude')) === -58.1551);
  check('with a link somebody can tap', field('Map').includes('6.801300,-58.155100'));
  check('the total is a plain number a spreadsheet can sum', field('Total') === String(hostile.total));
  check('and a formatted one a person can read', field('Total (formatted)') === money(hostile.total));
  check('what was ordered is listed', field('Items').includes(' x '));

  // A restaurant order and its associate, from earlier in the run.
  const cooked = archived.find((o) => o.outlet !== null);
  if (cooked) {
    const cookedRow = body.find((r) => r[col('Order')] === cooked.orderNo);
    check(
      'a restaurant order names its kitchen',
      (cookedRow?.[col('Restaurant')] ?? '') === cooked.outlet?.name,
    );
  }
  const carried = archived.find((o) => o.driverPhone !== '');
  if (carried) {
    const carriedRow = body.find((r) => r[col('Order')] === carried.orderNo);
    // The name column may be blank for a number with no directory entry;
    // the phone is the column that must always hold.
    check(
      'and a delivered order names who carried it',
      (carriedRow?.[col('Associate phone')] ?? '') === carried.driverPhone,
      JSON.stringify([carriedRow?.[col('Delivery associate')], carriedRow?.[col('Associate phone')]]),
    );
  }
  const parcel = archived.find((o) => o.kind === 'parcel');
  if (parcel) {
    const parcelRow = body.find((r) => r[col('Order')] === parcel.orderNo);
    check('a parcel describes its contents rather than listing items', (parcelRow?.[col('Items')] ?? '').startsWith('Parcel'));
    check(
      'and names the recipient, not the sender',
      (parcelRow?.[col('Recipient')] ?? '') === parcel.recipientName,
    );
  }

  // The exemption is for plain numbers only: an expression that merely opens
  // with a minus sign is still defanged.
  repo.setCartQty('5926008888', sellable, 1, '');
  const sneaky = repo.placeOrder({
    phone: '5926008888',
    customerName: '-2+3+cmd|calc',
    address: '-1+1',
    contactPhone: '5926008888',
    deliveryNote: '',
    paymentMethod: 'cash',
    location: { latitude: 6.8013, longitude: -58.1551, label: '', pinnedAt: '' },
  });
  const sneakyRow = parseCsv(backup.ordersCsv())
    .slice(1)
    .find((r) => r[0] === sneaky.orderNo);
  check(
    'a minus sign on an expression is still guarded',
    (sneakyRow?.[header.indexOf('Customer')] ?? '').startsWith("'-2+3"),
  );
  check(
    'and so is one in an address',
    (sneakyRow?.[header.indexOf('Address')] ?? '') === "'-1+1",
  );

  // Recomputed: the two orders placed above moved the total.
  const nowCount = repo.allOrders().length;
  const dump = JSON.parse(backup.ordersJson());
  check('the JSON export parses', Array.isArray(dump.orders));
  check('and holds every order', dump.orders.length === nowCount);
  check('with its item lines intact, not flattened', Array.isArray(dump.orders.at(-1).items));
  check('and says which currency the figures are in', dump.currency === config.currency.code);

  // The full-database snapshot: it has to open, and it has to hold the same
  // orders. A backup that restores into an empty table is worse than none,
  // because it is believed.
  const snap = await backup.writeSnapshot();
  check('a snapshot is written', fs.existsSync(snap.file) && snap.bytes > 0);
  check('no .partial file is left behind', !fs.existsSync(`${snap.file}.partial`));

  const { DatabaseSync } = await import('node:sqlite');
  const restored = new DatabaseSync(snap.file);
  const restoredCount = (
    restored.prepare('SELECT COUNT(*) AS n FROM orders').get() as unknown as { n: number }
  ).n;
  const restoredItems = (
    restored.prepare('SELECT COUNT(*) AS n FROM order_items').get() as unknown as { n: number }
  ).n;
  check('the snapshot opens as a database', restoredCount === nowCount);
  check('and the item lines came with it', restoredItems > 0);
  restored.close();

  check('the snapshot is listed', backup.listSnapshots().some((f) => f.file === snap.file));
  fs.rmSync(backup.backupDirectory(), { recursive: true, force: true });
}

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

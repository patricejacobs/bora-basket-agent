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

  const full = buildConversationContext('5920009999');
  check('full context also carries the clock', full.includes(guyanaDay));
  check('full context is tagged the same way', full.startsWith(CONTEXT_MARKER));
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

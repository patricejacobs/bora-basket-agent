/**
 * Every card the agent sends, for all three kinds of business, printed as the
 * message each person actually receives.
 *
 *   node cards-gallery.ts
 *
 * Not a test. It drives the real notify and dispatch functions against a
 * scratch database and captures what they hand to WhatsApp, so what it prints
 * is the message itself rather than a description of one.
 */
import fs from 'node:fs';
import path from 'node:path';

const DB = path.resolve('./data/cards-gallery.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
process.env.DATABASE_PATH = DB;

// Every number here is invented, including the shops'. A shop's number only
// decides where a card is sent and never appears in one, so using the real ones
// would put them in a public repository to no effect - and would go stale the
// first time a shop changed its number.
const DESK = '5926120001'; // the shop's dispatch desk
const GROCERY = '5926120002'; // Centro de Gangas
const KITCHEN = '5926120003'; // A Taste of Guyana
const RIDER = '5926120004';
const BUYER = '5926120005';
const SENDER = '5926120006';

process.env.STAFF_NUMBERS = DESK;
process.env.DRIVER_NUMBERS = RIDER;
process.env.DELIVERY_FEE = '700';
process.env.STORE_NAME = 'Next Minute Delivery';
process.env.PARCEL_FEE_BASE = '500';
process.env.PARCEL_FEE_PER_KM = '100';

/* Capture every outbound message instead of letting it vanish into a log. */
type Sent = { to: string; body: string; buttons: string[] };
const sent: Sent[] = [];
const original = console.log;
const originalWarn = console.warn;
console.warn = (...args: unknown[]): void => {
  const line = args.map((a) => String(a)).join(' ');
  const at = line.indexOf('dropping outbound message: ');
  if (!line.startsWith('[whatsapp]') || at === -1) {
    originalWarn(...(args as []));
    return;
  }
  try {
    const m = JSON.parse(line.slice(at + 'dropping outbound message: '.length));
    sent.push({
      to: String(m.to),
      body: String(m.interactive?.body?.text ?? m.text?.body ?? ''),
      buttons: (m.interactive?.action?.buttons ?? []).map((b: never) =>
        String((b as { reply: { title: string } }).reply.title),
      ),
    });
  } catch {
    originalWarn(...(args as []));
  }
};

const repo = await import('./src/db/repo.ts');
const { db } = await import('./src/db/index.ts');
const { notifyStaffOfNewOrder } = await import('./src/notifications.ts');
const { notifyOutletOfOrder, dispatchToDrivers, offerParcel, pickingTicket } = await import(
  './src/dispatch.ts'
);
const { nextActions } = await import('./src/order-status.ts');
const { handleOutletMessage } = await import('./src/staff.ts');

const WHO: Record<string, string> = {
  [DESK]: 'THE SHOP (dispatch desk)',
  [GROCERY]: 'CENTRO DE GANGAS (the grocery)',
  [KITCHEN]: 'A TASTE OF GUYANA (the kitchen)',
  [RIDER]: 'RIDER ONE (delivery associate)',
  [BUYER]: 'THE CUSTOMER',
  [SENDER]: 'THE SENDER',
};

const seen = new Set<string>();
const show = (title: string): void => {
  const taken = sent.splice(0, sent.length).filter((m) => {
    // A pin is a location message with no text of its own, and there is
    // nothing to print for it.
    if (!m.body.trim()) return false;
    // WhatsApp is not configured here, so every send is refused and the agent
    // correctly falls back to warning the desk. Real on a dead number, noise
    // in a gallery - and it is the same fallback that resends each ticket, so
    // identical bodies are shown once.
    if (m.body.includes('could not reach')) return false;
    const key = m.to + m.body;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (taken.length === 0) return;
  for (const m of taken) {
    original('');
    original(`╔═ ${title} → ${WHO[m.to] ?? '+' + m.to}`);
    for (const l of m.body.split('\n')) original(`║ ${l}`);
    if (m.buttons.length > 0) original(`║ ${m.buttons.map((b) => `[ ${b} ]`).join('  ')}`);
    original('╚' + '═'.repeat(60));
  }
};
const rule = (t: string): void => {
  original('');
  original('');
  original(`████  ${t}  ${'█'.repeat(Math.max(0, 50 - t.length))}`);
};

/* ------------------------------------------------------------------ set-up */

repo.upsertOutlet({
  code: 'GROCERY', name: 'Centro de Gangas', kind: 'grocery', hours: '24 hours',
  cuisine: 'Groceries, fresh produce and household goods',
  pickupAddress: 'Lot 9 Meadow Bank Road, Meadowbank, Georgetown',
  pickupLat: 6.7902, pickupLng: -58.16872, whatsapp: GROCERY,
});
repo.upsertOutlet({
  code: 'TOG', name: 'A Taste of Guyana', kind: 'restaurant', hours: '24 hours',
  cuisine: 'Guyanese roti, curry, fried rice, bakery', prepMinutes: 20, minOrder: 150000,
  pickupAddress: 'Lot 14 Lamaha Street, Queenstown, Georgetown',
  pickupLat: 6.8124, pickupLng: -58.1591, whatsapp: KITCHEN,
});
const grocery = repo.getOutlet('GROCERY')!;
const kitchen = repo.getOutlet('TOG')!;

repo.upsertAssociate({ phone: RIDER, name: 'Rider One', vehicle: 'GSS 1234', active: 1 } as never);
await (await import('./src/staff.ts')).handleDriverMessage('on', RIDER);

// Everybody has written in, so WhatsApp's 24-hour window is open for all of them.
for (const p of [GROCERY, KITCHEN, BUYER, SENDER, DESK]) repo.logMessage(p, 'in', 'whatsapp', 'hello');

const stock = (sku: string, name: string, cat: string, unit: string, price: number, outletId: number) => {
  repo.upsertProduct({ sku, name, description: '', category: cat, unit, price, stock: 50, active: 1, keywords: name.toLowerCase(), outletId, trackStock: outletId === grocery.id ? 1 : 0 });
  return (db.prepare(`SELECT id FROM products WHERE sku = ?`).get(sku) as { id: number }).id;
};
const rice = stock('RIC-001', 'Karibee Parboiled Rice', 'Rice, Peas & Pasta', '5 kg bag', 1850, grocery.id);
const oil = stock('OIL-002', 'Sunflower Cooking Oil', 'Cooking', '1.8 L', 1420, grocery.id);
const roti = stock('TOG-001', 'Chicken Curry with Roti', 'Main Dishes', 'plate', 1850, kitchen.id);
const chow = stock('TOG-002', 'Chicken Chow Mein', 'Main Dishes', 'plate', 1500, kitchen.id);

repo.saveLocationPin(BUYER, { latitude: 6.642, longitude: -58.218, label: 'Diamond' });
repo.saveCustomer(BUYER, { name: 'Marcia Persaud', address: 'Lot 4 Section C, Diamond — white fence, upstairs', contactPhone: BUYER });

const place = (items: [number, number][], extra: Record<string, unknown> = {}) => {
  for (const [id, qty] of items) repo.setCartQty(BUYER, id, qty, '');
  return repo.placeOrder({
    phone: BUYER, customerName: 'Marcia Persaud',
    address: 'Lot 4 Section C, Diamond — white fence, upstairs',
    contactPhone: BUYER, deliveryNote: 'Upstairs flat, white fence', paymentMethod: 'cash',
    location: repo.getIdentity(BUYER).location, ...extra,
  });
};
const n = (o: string) => String(Number(o.replace(/\D/g, '')));

/* ============================================================== GROCERY == */

rule('GROCERY — Centro de Gangas');

const g = place([[rice, 2], [oil, 1]]);
await notifyStaffOfNewOrder(g.orderNo);
show('1. placed');
await notifyOutletOfOrder(g.orderNo);
show('2. the picking ticket');

await handleOutletMessage(grocery, `${n(g.orderNo)} confirm`);
show('3. after Confirm');
await handleOutletMessage(grocery, `${n(g.orderNo)} ready`);
show('4. after Ready — the associate is sent');

/* ============================================================ RESTAURANT = */

rule('RESTAURANT — A Taste of Guyana');

const r = place([[roti, 1], [chow, 1]], { recipientName: 'Dave Singh', recipientPhone: '5926100099' });
await notifyStaffOfNewOrder(r.orderNo);
show('1. placed — for somebody else');
await notifyOutletOfOrder(r.orderNo);
show('2. the kitchen ticket');

await handleOutletMessage(kitchen, `${n(r.orderNo)} confirm`);
show('3. after Confirm');
await handleOutletMessage(kitchen, `${n(r.orderNo)} ready`);
show('4. after Ready — the associate is sent');

/* ================================================================ PARCEL = */

rule('PARCEL');

repo.saveCustomer(SENDER, { name: 'Ramesh Khan', address: 'Lot 2 Robb Street, Georgetown', contactPhone: SENDER });
repo.saveLocationPin(SENDER, { latitude: 6.8102, longitude: -58.1547, label: 'Robb Street' });
// A parcel is not built from a cart, so it is written as the booking tool
// writes it.
const PARCEL = 'ORD-90001';
db.prepare(
  `INSERT INTO orders (order_no, phone, customer_name, address, contact_phone, delivery_note,
     kind, parcel_details, recipient_name, recipient_phone,
     pickup_address, pickup_lat, pickup_lng,
     latitude, longitude, location_label,
     subtotal, delivery_fee, total, payment_method, status, created_at)
   VALUES (?, ?, 'Ramesh Khan', '88 Sheriff Street, Campbellville', ?, 'Blue gate, ask for Anita',
     'parcel', 'A4 envelope, documents', 'Anita Khan', '5926100077',
     'Lot 2 Robb Street, Georgetown', 6.8102, -58.1547,
     6.8031, -58.1492, 'Campbellville',
     0, 1200, 1200, 'cash', 'pending', ?)`,
).run(PARCEL, SENDER, SENDER, new Date().toISOString());
const p = repo.findOrder(PARCEL)!;
await notifyStaffOfNewOrder(p.orderNo);
show('1. booked');
await offerParcel(p.orderNo);
show('2. offered to the associates');

/* ====================================================== SIDE BY SIDE ===== */

rule('THE SAME ORDER, AS EACH SHOP SEES IT');

original('');
original('A grocery is told to pick; a kitchen is told to cook. One send path,');
original('two shapes, chosen by what kind of shop it is.');
original('');
original('── Centro de Gangas ──');
for (const l of pickingTicket(repo.findOrder(g.orderNo)!).split('\n')) original(`║ ${l}`);
original(`║ ${nextActions(g.orderNo, 'pending', 'outlet').map((a) => `[ ${a.title} ]`).join('  ')}`);
original('');
original('── A Taste of Guyana (its ticket, from the capture above) ──');
original('   see "2. the kitchen ticket"');
original('');

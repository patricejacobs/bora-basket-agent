/**
 * A sweep of the dispatch map, pass or fail, with no eyeballs needed.
 *
 *   npm run map:check
 *
 * The map is a page and a JSON endpoint behind a token, which is three
 * things the test suite cannot reach: it does not start a server, does not
 * speak HTTP, and does not render. So this does - against a throwaway shop
 * on a spare port, seeded with the three cases that matter: a job with a
 * pin, a job without one, and a delivery already made.
 *
 * What it is really guarding is the authentication. Everything else on this
 * page is a convenience; the 404 is the only thing standing between every
 * customer's address and the open internet.
 */
import fs from 'node:fs';
import path from 'node:path';
const DB = path.resolve('./data/map-check.db');
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
process.env.DATABASE_PATH = DB;
process.env.ANTHROPIC_API_KEY = '';
process.env.BACKUP_TOKEN = 'a-long-enough-token-for-the-map-1234';
process.env.PORT = '8098';
process.env.STORE_NAME = 'Next Minute Delivery';

const repo = await import('./db/repo.ts');
const { db } = await import('./db/index.ts');
const shop = repo.defaultGrocery()!;
repo.upsertProduct({ sku: 'R', name: 'Rice', description: '', category: 'Rice', unit: 'bag',
  price: 1850, stock: 99, active: 1, keywords: 'rice', trackStock: 1, outletId: shop.id } as never);
const rice = (db.prepare(`SELECT id FROM products WHERE sku='R'`).get() as { id: number }).id;
const order = (phone: string, pin: { latitude: number; longitude: number; label: string } | null) => {
  repo.saveCustomer(phone, { name: 'Tester', contactPhone: phone });
  repo.setCartQty(phone, rice, 1);
  repo.setFeeAgreed(phone, 1200);
  return repo.placeOrder({ phone, customerName: 'Tester', address: '', contactPhone: phone,
    deliveryNote: '', paymentMethod: 'cash_on_delivery', location: pin } as never);
};
repo.setDeliveryZone('5926200001', 'Diamond');
const open1 = order('5926200001', { latitude: 6.76, longitude: -58.17, label: 'Diamond' });
const open2 = order('5926200002', null);
const done1 = order('5926200003', { latitude: 6.7725, longitude: -58.0636, label: 'BV' });
repo.setOrderStatus(done1.orderNo, 'delivered');

await import('./server.ts');
await new Promise((r) => setTimeout(r, 1200));

const KEY = 'a-long-enough-token-for-the-map-1234';
const base = 'http://127.0.0.1:8098';
let pass = 0, fail = 0;
const check = async (what: string, run: () => Promise<boolean>) => {
  let ok = false;
  try { ok = await run(); } catch { ok = false; }
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  ok ? pass++ : fail++;
};
const get = (p: string) => fetch(base + p, { redirect: 'manual' });
/**
 * What these two endpoints answer with, written down once.
 *
 * `Response.json()` is typed `unknown`, which is correct and which made
 * every reading below an error. Saying the shape here types all of them and
 * doubles as the only description of the contract this file is checking.
 */
type Answered = {
  jobs: { orderNo: string; address: string; lat: number | null; lng: number | null }[];
  done: { orderNo: string }[];
  doneValue: string;
  withoutPin: number;
  days: number;
  dispatchMap: boolean;
};

const json = async (p: string): Promise<Answered> => (await get(p)).json() as Promise<Answered>;

await check('no key is 404', async () => (await get('/dispatch')).status === 404);
await check('a wrong key is 404', async () => (await get('/dispatch?key=nope')).status === 404);
await check('a key of the right length but wrong is 404',
  async () => (await get('/dispatch?key=' + 'x'.repeat(KEY.length))).status === 404);
await check('the data endpoint is shut too', async () => (await get('/dispatch/data')).status === 404);
await check('the right key opens the page', async () => (await get('/dispatch?key=' + KEY)).status === 200);
await check('the page is not cached', async () =>
  ((await get('/dispatch?key=' + KEY)).headers.get('cache-control') ?? '').includes('no-store'));
await check('and not indexed', async () =>
  ((await get('/dispatch?key=' + KEY)).headers.get('x-robots-tag') ?? '').includes('noindex'));
await check('a bearer header works too', async () =>
  (await fetch(base + '/dispatch', { headers: { authorization: 'Bearer ' + KEY } })).status === 200);

await check('open jobs are listed', async () => (await json('/dispatch/data?key=' + KEY)).jobs.length === 2);
await check('the one with no pin is counted', async () => (await json('/dispatch/data?key=' + KEY)).withoutPin === 1);
await check('a delivered job is not open', async () =>
  (await json('/dispatch/data?key=' + KEY)).jobs.every((j: { orderNo: string }) => j.orderNo !== done1.orderNo));
await check('history is off unless asked', async () => (await json('/dispatch/data?key=' + KEY)).done.length === 0);
await check('7 days finds the delivered one', async () =>
  (await json('/dispatch/data?key=' + KEY + '&days=7')).done.length === 1);
await check('with its money, as the ORDER records it', async () => {
  const { money } = await import('./config.ts');
  const expected = money(repo.findOrder(done1.orderNo)!.total);
  return (await json('/dispatch/data?key=' + KEY + '&days=7')).doneValue === expected;
});
await check('days=0 means none', async () => (await json('/dispatch/data?key=' + KEY + '&days=0')).done.length === 0);
await check('nonsense days is treated as none', async () =>
  (await json('/dispatch/data?key=' + KEY + '&days=abc')).days === 0);
await check('days is capped at 90', async () =>
  (await json('/dispatch/data?key=' + KEY + '&days=9999')).days === 90);
await check('a job with no street shows its zone', async () =>
  (await json('/dispatch/data?key=' + KEY)).jobs.some((j: { orderNo: string; address: string }) =>
    j.orderNo === open1.orderNo && j.address === 'Diamond'));
await check('every drawn job carries coordinates', async () =>
  (await json('/dispatch/data?key=' + KEY)).jobs
    .filter((j) => j.lat !== null)
    .every((j) => Math.abs(j.lat ?? 0) <= 90 && Math.abs(j.lng ?? 0) <= 180));
await check('health says the map is on', async () => (await json('/health')).dispatchMap === true);
void open2;

const page = await (await get('/dispatch?key=' + KEY)).text();
await check('the page fetches its data absolutely', async () => page.includes("fetch('/dispatch/data?key="));
await check('it does not shadow window.history', async () => !/var history =/.test(page));
await check('the key is not left in the page twice', async () => (page.match(new RegExp(KEY, 'g')) ?? []).length === 1);
await check('leaflet is pinned to a version', async () => /leaflet\/1\.9\.4\//.test(page));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

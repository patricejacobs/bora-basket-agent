/**
 * Restaurant and menu importer.
 *
 *   npm run import:menu -- ./data/sample-outlets.csv ./data/sample-menu.csv
 *
 * Two files, because they are two different things maintained on different
 * clocks: an outlet's hours and pickup address change rarely, its menu and
 * prices change often.
 *
 * Menu rows are refused rather than trusted where they name drink or tobacco.
 * Almost every place that sells a burger also sells a beer, so the menu you are
 * handed will list it, and WhatsApp's Commerce Policy can cost you the number.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toMinorUnits } from '../config.ts';
import { db } from '../db/index.ts';
import { upsertOutlet, getOutlet, upsertProduct, listOutlets } from '../db/repo.ts';
import { parseCsv } from './import-csv.ts';
import { parseOptionSpec } from '../menu-options.ts';
import { restrictedReason } from '../restricted.ts';

export type MenuImportResult = {
  outlets: number;
  items: number;
  skipped: { line: number; reason: string }[];
  /** Separated from ordinary skips: these are compliance refusals worth reading. */
  refused: { line: number; name: string; reason: string }[];
};

const OUTLET_HEADERS: Record<string, string> = {
  code: 'code', outlet: 'code', outlet_code: 'code',
  name: 'name', outlet_name: 'name',
  kind: 'kind', shop_kind: 'kind', shop_type: 'kind',
  cuisine: 'cuisine', serves: 'cuisine', type: 'cuisine',
  hours: 'hours', opening_hours: 'hours',
  prep_minutes: 'prep', prep: 'prep', prep_time: 'prep', cook_time: 'prep',
  min_order: 'min_order', minimum: 'min_order', minimum_order: 'min_order',
  delivery_fee: 'delivery_fee', fee: 'delivery_fee',
  pickup_address: 'address', address: 'address', location: 'address',
  pickup_lat: 'lat', lat: 'lat', latitude: 'lat',
  pickup_lng: 'lng', lng: 'lng', longitude: 'lng', lon: 'lng',
  whatsapp: 'whatsapp', phone: 'whatsapp', number: 'whatsapp',
  active: 'active', enabled: 'active',
};

const MENU_HEADERS: Record<string, string> = {
  outlet: 'outlet', outlet_code: 'outlet', restaurant: 'outlet',
  sku: 'sku', code: 'sku', item_code: 'sku',
  name: 'name', item: 'name', dish: 'name',
  description: 'description', desc: 'description',
  category: 'category', section: 'category', course: 'category',
  unit: 'unit', size: 'unit', serving: 'unit',
  price: 'price', unit_price: 'price',
  options: 'options', choices: 'options', modifiers: 'options',
  keywords: 'keywords', tags: 'keywords', aliases: 'keywords',
  active: 'active', enabled: 'active',
  image: 'image_url', image_url: 'image_url', photo: 'image_url',
};

const mapHeader = (aliases: Record<string, string>) => (h: string): string =>
  aliases[h.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? '';

const truthy = (v: string | undefined): boolean =>
  v === undefined || v.trim() === '' || !/^(0|no|false|n)$/i.test(v.trim());

function numberOrNull(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/* ----------------------------------------------------------------- outlets */

export function importOutletsText(text: string): { imported: number; skipped: MenuImportResult['skipped'] } {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error('Outlets CSV is empty.');

  const columns = header.map(mapHeader(OUTLET_HEADERS));
  for (const required of ['code', 'name'] as const) {
    if (!columns.includes(required)) {
      throw new Error(`Outlets CSV needs a "${required}" column. Found: ${header.join(', ')}`);
    }
  }

  const skipped: MenuImportResult['skipped'] = [];
  let imported = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 1; i < rows.length; i++) {
      const line = i + 1;
      const row = rows[i]!;
      const get = (field: string): string => {
        const at = columns.indexOf(field);
        return at === -1 ? '' : (row[at] ?? '').trim();
      };

      const code = get('code');
      const name = get('name');
      if (!code || !name) {
        skipped.push({ line, reason: 'needs both a code and a name' });
        continue;
      }

      // An outlet name is read out to customers, so it goes through the same
      // compliance check as a dish — "Joe's Bar & Grill" is a judgement call,
      // but a name that is literally a drink is not one to make silently.
      const banned = restrictedReason(name, get('cuisine'));
      if (banned) {
        skipped.push({ line, reason: `"${name}" names ${banned}` });
        continue;
      }

      // A column the file does not have is a field the shop did not mean to
      // change.
      //
      // This matters more than it looks. The upsert writes every column, so a
      // CSV that leaves one out used to overwrite it with a blank — and the
      // natural reason to re-import this file is to edit one field. Setting the
      // grocery's pickup address from a file with no `whatsapp` column wiped
      // the number its orders are sent to, and the file you were reading looked
      // exactly right. Numbers are often set by `number KFH 5926123456` rather
      // than in the CSV, which is precisely how they end up absent from it.
      //
      // So an absent column falls back to what the shop already has, and only
      // a shop being created for the first time takes a default.
      const prev = getOutlet(code);
      const has = (field: string): boolean => columns.includes(field);
      const text = (field: string, current: string | undefined, fallback = ''): string =>
        has(field) ? get(field) : (current ?? fallback);

      const pinGiven = has('lat') || has('lng');
      const lat = pinGiven ? numberOrNull(get('lat')) : (prev?.pickupLat ?? null);
      const lng = pinGiven ? numberOrNull(get('lng')) : (prev?.pickupLng ?? null);
      if ((lat === null) !== (lng === null)) {
        skipped.push({ line, reason: 'a pickup pin needs both a latitude and a longitude' });
        continue;
      }

      // A kitchen unless the row says otherwise, because that is what every
      // row written before this column existed meant. Anything unrecognised is
      // refused rather than quietly filed as a restaurant: a grocery listed
      // among the kitchens is a supermarket offered to somebody who asked for
      // takeaway, and the shop would have no way to see why.
      const rawKind = get('kind').toLowerCase();
      const kind =
        // Said nothing. For a shop that already exists this means "leave it as
        // it is", never "make it a kitchen" — otherwise editing the grocery's
        // pickup address in a CSV with no kind column would turn the grocery
        // into a restaurant, take it out of the list its customers are shown,
        // and leave the shop reading a file that looks right.
        rawKind === ''
          ? (prev?.kind ?? ('restaurant' as const))
          : rawKind === 'restaurant' || rawKind === 'kitchen'
            ? ('restaurant' as const)
            : rawKind === 'grocery' || rawKind === 'shop' || rawKind === 'supermarket'
              ? ('grocery' as const)
              : null;
      if (kind === null) {
        skipped.push({ line, reason: `"${rawKind}" is not a kind — use restaurant or grocery` });
        continue;
      }

      const fee = has('delivery_fee') ? numberOrNull(get('delivery_fee')) : null;
      upsertOutlet({
        code,
        name,
        kind,
        cuisine: text('cuisine', prev?.cuisine),
        hours: text('hours', prev?.hours),
        prepMinutes: has('prep')
          ? (numberOrNull(get('prep')) ?? 20)
          : (prev?.prepMinutes ?? 20),
        minOrder: has('min_order')
          ? toMinorUnits(get('min_order') || '0')
          : (prev?.minOrder ?? 0),
        deliveryFee: has('delivery_fee')
          ? (fee === null ? null : toMinorUnits(String(fee)))
          : (prev?.deliveryFee ?? null),
        pickupAddress: text('address', prev?.pickupAddress),
        pickupLat: lat,
        pickupLng: lng,
        // The one that cost a shop its tickets. See the note above.
        whatsapp: text('whatsapp', prev?.whatsapp),
        active: has('active') ? (truthy(get('active')) ? 1 : 0) : (prev?.active ?? 1),
      });
      imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { imported, skipped };
}

/* -------------------------------------------------------------------- menus */

export function importMenuText(text: string): MenuImportResult {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error('Menu CSV is empty.');

  const columns = header.map(mapHeader(MENU_HEADERS));
  for (const required of ['outlet', 'sku', 'name', 'price'] as const) {
    if (!columns.includes(required)) {
      throw new Error(`Menu CSV needs an "${required}" column. Found: ${header.join(', ')}`);
    }
  }

  const skipped: MenuImportResult['skipped'] = [];
  const refused: MenuImportResult['refused'] = [];
  const seen = new Set<string>();
  let items = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 1; i < rows.length; i++) {
      const line = i + 1;
      const row = rows[i]!;
      const get = (field: string): string => {
        const at = columns.indexOf(field);
        return at === -1 ? '' : (row[at] ?? '').trim();
      };

      const sku = get('sku');
      const name = get('name');
      const outletCode = get('outlet');
      if (!sku || !name || !outletCode) {
        skipped.push({ line, reason: 'needs an outlet, a sku and a name' });
        continue;
      }
      if (seen.has(sku.toLowerCase())) {
        skipped.push({ line, reason: `duplicate sku "${sku}"` });
        continue;
      }

      const outlet = getOutlet(outletCode);
      if (!outlet) {
        skipped.push({ line, reason: `no outlet "${outletCode}" — import the outlets file first` });
        continue;
      }

      // The compliance gate. Reads every descriptive field, because the item
      // called "House Special" is the one with rum in its description — and the
      // options column too, since "add a shot" is a choice, not a dish.
      const banned = restrictedReason(
        name,
        get('description'),
        get('category'),
        get('keywords'),
        get('options'),
      );
      if (banned) {
        refused.push({ line, name, reason: banned });
        continue;
      }

      const price = toMinorUnits(get('price'));
      if (!(price > 0)) {
        skipped.push({ line, reason: `"${name}" needs a price above zero` });
        continue;
      }

      // Parsed here so a typo in the options column fails at import, where
      // somebody is reading output, rather than mid-conversation.
      const optionText = get('options');
      if (optionText && parseOptionSpec(optionText).length === 0) {
        skipped.push({
          line,
          reason: `"${name}" has options that could not be read: ${optionText.slice(0, 60)}`,
        });
        continue;
      }

      const image = get('image_url');
      if (image && !/^https:\/\/\S+$/i.test(image)) {
        skipped.push({ line, reason: `"${name}" image must be a public https:// URL` });
        continue;
      }

      upsertProduct({
        sku,
        name,
        description: get('description'),
        category: get('category') || 'Menu',
        unit: get('unit') || 'each',
        price,
        // A kitchen cooks to order, so there is no quantity to hold and nothing
        // may decrement one. Availability is the sold-out flag instead.
        stock: 0,
        trackStock: 0,
        active: truthy(get('active')) ? 1 : 0,
        keywords: get('keywords'),
        imageUrl: image,
        outletId: outlet.id,
        options: optionText,
      });
      seen.add(sku.toLowerCase());
      items++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { outlets: listOutlets().length, items, skipped, refused };
}

/* ---------------------------------------------------------------------- CLI */

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [outletsPath, menuPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!outletsPath || !menuPath) {
    console.error('Usage: npm run import:menu -- <outlets.csv> <menu.csv>');
    process.exit(1);
  }

  const outletResult = importOutletsText(fs.readFileSync(path.resolve(outletsPath), 'utf8'));
  console.log(`\nOutlets: ${outletResult.imported} imported`);
  for (const s of outletResult.skipped) console.log(`  line ${s.line}: ${s.reason}`);

  const menuResult = importMenuText(fs.readFileSync(path.resolve(menuPath), 'utf8'));
  console.log(`Menu items: ${menuResult.items} imported`);
  for (const s of menuResult.skipped) console.log(`  line ${s.line}: ${s.reason}`);

  if (menuResult.refused.length > 0) {
    console.log(`\n⚠️  ${menuResult.refused.length} item(s) refused on policy grounds:`);
    for (const r of menuResult.refused) console.log(`  line ${r.line}: ${r.name} — ${r.reason}`);
    console.log(
      '\nThese are not import errors. WhatsApp prohibits selling them over the channel and a\n' +
        'strike can cost the phone number, so they are kept off the menu deliberately.',
    );
  }
  console.log('');
}

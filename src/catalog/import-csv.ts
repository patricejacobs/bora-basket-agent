/**
 * Catalog importer.
 *
 *   npm run import:catalog -- ./data/sample-products.csv
 *
 * Rows are matched on SKU and upserted, so re-running the import is how you
 * refresh prices and stock. Products absent from the file are left untouched
 * unless you pass --deactivate-missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toMinorUnits, money } from '../config.ts';
import { db } from '../db/index.ts';
import { upsertProduct, productCount } from '../db/repo.ts';

/** Minimal RFC 4180 parser: handles quoted fields, embedded commas, and "" escapes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel adds and which otherwise corrupts the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // handled by the \n branch
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER_ALIASES: Record<string, string> = {
  sku: 'sku',
  code: 'sku',
  item_code: 'sku',
  itemcode: 'sku',
  name: 'name',
  product: 'name',
  product_name: 'name',
  description: 'description',
  desc: 'description',
  category: 'category',
  dept: 'category',
  department: 'category',
  unit: 'unit',
  uom: 'unit',
  size: 'unit',
  price: 'price',
  unit_price: 'price',
  cost: 'price',
  stock: 'stock',
  qty: 'stock',
  quantity: 'stock',
  on_hand: 'stock',
  keywords: 'keywords',
  tags: 'keywords',
  aliases: 'keywords',
  active: 'active',
  enabled: 'active',
};

const normalizeHeader = (h: string): string =>
  HEADER_ALIASES[h.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? '';

export type ImportResult = { imported: number; skipped: { line: number; reason: string }[] };

export function importCsvText(text: string, deactivateMissing = false): ImportResult {
  const rows = parseCsv(text);
  const headerRow = rows[0];
  if (!headerRow) throw new Error('CSV file is empty.');

  const columns = headerRow.map(normalizeHeader);
  for (const required of ['sku', 'name', 'price'] as const) {
    if (!columns.includes(required)) {
      throw new Error(
        `CSV is missing a "${required}" column. Found headers: ${headerRow.join(', ')}`,
      );
    }
  }

  const skipped: ImportResult['skipped'] = [];
  const seenSkus = new Set<string>();
  let imported = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r] ?? [];
      const get = (key: string): string => {
        const idx = columns.indexOf(key);
        return idx === -1 ? '' : (cells[idx] ?? '').trim();
      };

      const sku = get('sku');
      const name = get('name');
      const priceRaw = get('price');

      if (!sku || !name) {
        skipped.push({ line: r + 1, reason: 'missing sku or name' });
        continue;
      }
      if (seenSkus.has(sku.toLowerCase())) {
        skipped.push({ line: r + 1, reason: `duplicate sku "${sku}"` });
        continue;
      }
      const price = toMinorUnits(priceRaw);
      if (!priceRaw || price <= 0) {
        skipped.push({ line: r + 1, reason: `invalid price "${priceRaw}"` });
        continue;
      }

      const stockRaw = get('stock');
      const stock = stockRaw === '' ? 0 : Math.max(0, Math.round(Number(stockRaw) || 0));
      const activeRaw = get('active').toLowerCase();
      const active = activeRaw === '' || ['1', 'true', 'yes', 'y'].includes(activeRaw) ? 1 : 0;

      upsertProduct({
        sku,
        name,
        description: get('description'),
        category: get('category') || 'General',
        unit: get('unit') || 'each',
        price,
        stock,
        active,
        keywords: get('keywords'),
      });

      seenSkus.add(sku.toLowerCase());
      imported++;
    }

    if (deactivateMissing && seenSkus.size > 0) {
      const placeholders = [...seenSkus].map(() => '?').join(',');
      db.prepare(
        `UPDATE products SET active = 0 WHERE lower(sku) NOT IN (${placeholders})`,
      ).run(...seenSkus);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { imported, skipped };
}

// --- CLI -------------------------------------------------------------------

const isCli = process.argv[1] && path.resolve(process.argv[1]).endsWith('import-csv.ts');

if (isCli) {
  const args = process.argv.slice(2);
  const deactivateMissing = args.includes('--deactivate-missing');
  const file = args.find((a) => !a.startsWith('--')) ?? './data/sample-products.csv';
  const resolved = path.resolve(file);

  if (!fs.existsSync(resolved)) {
    console.error(`No such file: ${resolved}`);
    console.error('Usage: npm run import:catalog -- ./path/to/products.csv [--deactivate-missing]');
    process.exit(1);
  }

  const result = importCsvText(fs.readFileSync(resolved, 'utf8'), deactivateMissing);
  console.log(`Imported ${result.imported} product(s) from ${path.basename(resolved)}.`);
  if (result.skipped.length > 0) {
    console.log(`Skipped ${result.skipped.length} row(s):`);
    for (const s of result.skipped.slice(0, 20)) console.log(`  line ${s.line}: ${s.reason}`);
    if (result.skipped.length > 20) console.log(`  ...and ${result.skipped.length - 20} more`);
  }
  console.log(`Catalog now holds ${productCount()} active product(s).`);
  console.log(`Example price formatting: ${money(125000)}`);
}

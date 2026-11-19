/**
 * What still needs a photograph, aisle by aisle.
 *
 *   npm run photos:wanted
 *
 * Open Food Facts is a database of branded packaged goods. This shop sells
 * bora, callaloo, plantain, tennis rolls and snapper by the kilo, and no
 * amount of matching will find a photograph of this shop's tomatoes in it.
 * Those have to be taken, and the system is already built for it: drop
 * `RIC-001.jpg` into the images folder and it is live, no CDN, no upload, no
 * restart.
 *
 * So this prints the job rather than another apology: every product with no
 * photo, grouped by aisle in the order somebody walks the shop, with the
 * filename to save each one under. Also written to a CSV, for a phone.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as repo from './db/repo.ts';
import { productImageUrl, imagesDirectory } from './product-images.ts';
import { inShoppingOrder } from './categories.ts';

const OUT = path.resolve('./data/photos-wanted.csv');
const dim = (s: string): string => `\u001b[90m${s}\u001b[0m`;
const green = (s: string): string => `\u001b[32m${s}\u001b[0m`;

const grocery = repo.listOutlets('grocery')[0];
if (!grocery) {
  console.log('No grocery is set up, so there is nothing to photograph yet.');
  process.exit(0);
}

type Wanted = { sku: string; name: string; unit: string; category: string };
const wanted: Wanted[] = [];
let have = 0;

for (const { category } of inShoppingOrder(repo.listCategories(grocery.id))) {
  for (const p of repo.productsInCategory(grocery.id, category)) {
    if (productImageUrl(p.sku, p.imageUrl ?? '')) {
      have++;
      continue;
    }
    wanted.push({ sku: p.sku, name: p.name, unit: p.unit, category });
  }
}

const total = have + wanted.length;
console.log('');
console.log(`  ${grocery.name} — ${green(String(have))} of ${total} products have a photo`);
console.log(`  save each one as its SKU in ${dim(imagesDirectory())}`);

let aisle = '';
for (const w of wanted) {
  if (w.category !== aisle) {
    aisle = w.category;
    console.log('');
    console.log(`  ${aisle}`);
  }
  console.log(`     ${w.sku.padEnd(10)} ${w.name.padEnd(26).slice(0, 26)} ${dim(w.unit)}`);
}

fs.writeFileSync(
  OUT,
  ['aisle,sku,name,unit,save_as']
    .concat(
      wanted.map((w) =>
        [w.category, w.sku, w.name, w.unit, `${w.sku}.jpg`]
          .map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
          .join(','),
      ),
    )
    .join('\n') + '\n',
);

console.log('');
if (wanted.length === 0) {
  console.log(`  ${green('Nothing left to photograph.')}`);
} else {
  console.log(`  ${wanted.length} to go — list also written to ${dim(path.relative(process.cwd(), OUT))}`);
}
console.log('');

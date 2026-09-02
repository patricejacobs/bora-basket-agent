/**
 * Finds product photos on Open Food Facts.
 *
 *   npm run photos:find            propose matches, write them for review
 *   npm run photos:find -- --apply write the accepted ones into the catalogue CSV
 *
 * Open Food Facts is an open database (ODbL) whose photos are contributed under
 * CC-BY-SA. That makes it one of the few sources a shop can legitimately use
 * without licensing brand photography.
 *
 * The hard part is not fetching but matching. Searching "tomatoes" returns
 * "Ketchup star"; searching a generic term returns whatever is popular. A wrong
 * photo is worse than none — a customer who orders Tomatoes and is shown a
 * ketchup bottle trusts nothing else on the screen. So every candidate is scored
 * against the product name, anything doubtful is left for a human, and the
 * proposals are always written out in full whether or not they are applied.
 */
import fs from 'node:fs';
import path from 'node:path';

const CSV = path.resolve('./data/sample-products.csv');
const CANDIDATES = path.resolve('./data/photo-candidates.csv');

// Open Food Facts asks callers to identify themselves and to go gently. Search
// is rate limited; this pace plus backoff keeps a full catalogue run polite.
const USER_AGENT = 'BoraBasketGroceryAgent/1.0 (grocery catalogue photo matching)';
const DELAY_MS = 2200;
const MAX_RETRIES = 3;

/** Below this a match is written out for review but never applied. */
const ACCEPT_SCORE = 0.6;

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- matching */

/** Words that say nothing about which product this is. */
const NOISE = new Set([
  'fresh', 'local', 'the', 'and', 'with', 'pack', 'bag', 'bottle', 'tin', 'box',
  'each', 'per', 'kg', 'ml', 'litre', 'liter', 'l', 'g', 'dozen', 'pure', 'whole',
  'assorted', 'premium', 'quality', 'brand', 'size', 'medium', 'large', 'small',
]);

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 2 && !NOISE.has(t));

/**
 * How well an Open Food Facts product matches ours.
 *
 * Requires the distinctive words of our name to appear in theirs. "Tomatoes"
 * scores zero against "Ketchup star", which is the entire point.
 */
function score(ourName: string, theirName: string, theirBrand: string): number {
  const ours = tokens(ourName);
  if (ours.length === 0) return 0;
  const theirs = new Set(tokens(`${theirName} ${theirBrand}`));
  if (theirs.size === 0) return 0;

  const hits = ours.filter((t) => theirs.has(t)).length;
  const base = hits / ours.length;

  // The first word of a grocery name is usually the thing itself — "Tomatoes",
  // "Shampoo". If that is missing, the rest is coincidence.
  const head = ours[0];
  return head && !theirs.has(head) ? base * 0.4 : base;
}

/* ------------------------------------------------------------------ fetching */

type Candidate = { name: string; brand: string; imageUrl: string; code: string };

async function searchOFF(term: string): Promise<Candidate[]> {
  const url =
    'https://world.openfoodfacts.org/api/v2/search?page_size=5' +
    '&fields=product_name,brands,image_front_url,code&search_terms=' +
    encodeURIComponent(term);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.status === 503 || res.status === 429) {
        // Rate limited rather than broken; back off and try again.
        await wait(DELAY_MS * (attempt + 2));
        continue;
      }
      if (!res.ok) return [];

      const body = (await res.json()) as {
        products?: { product_name?: string; brands?: string; image_front_url?: string; code?: string }[];
      };
      return (body.products ?? [])
        .filter((p) => p.image_front_url && p.product_name)
        .map((p) => ({
          name: p.product_name ?? '',
          brand: p.brands ?? '',
          imageUrl: p.image_front_url ?? '',
          code: p.code ?? '',
        }));
    } catch {
      await wait(DELAY_MS * (attempt + 2));
    }
  }
  return [];
}

/* ---------------------------------------------------------------------- CSV */

function parseCsvLines(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const split = (line: string): string[] => {
    const out: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
    out.push(field);
    return out;
  };
  const [head, ...rest] = lines;
  return { header: split(head ?? ''), rows: rest.map(split) };
}

const quote = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/* ---------------------------------------------------------------------- run */

const apply = process.argv.includes('--apply');
const { header, rows } = parseCsvLines(fs.readFileSync(CSV, 'utf8'));

const col = (name: string): number => header.findIndex((h) => h.trim().toLowerCase() === name);
const skuAt = col('sku');
const nameAt = col('name');
const keywordsAt = col('keywords');
let imageAt = col('image');

if (skuAt === -1 || nameAt === -1) {
  console.error('data/sample-products.csv needs at least sku and name columns.');
  process.exit(1);
}

// Add the image column if the catalogue does not have one yet.
if (imageAt === -1) {
  header.push('image');
  imageAt = header.length - 1;
  for (const row of rows) while (row.length < header.length) row.push('');
}

const needing = rows.filter((r) => !(r[imageAt] ?? '').trim());
console.log(
  `\nOpen Food Facts photo search — ${needing.length} product(s) without a photo` +
    dim(`\n(${DELAY_MS / 1000}s between requests; this takes a few minutes)\n`),
);

type Proposal = {
  sku: string;
  ourName: string;
  theirName: string;
  brand: string;
  imageUrl: string;
  code: string;
  score: number;
};

const proposals: Proposal[] = [];

for (const [index, row] of needing.entries()) {
  const sku = (row[skuAt] ?? '').trim();
  const ourName = (row[nameAt] ?? '').trim();
  // Keywords carry the words customers actually use, which often match the
  // database better than a shelf label does.
  const keywords = keywordsAt === -1 ? '' : (row[keywordsAt] ?? '').trim();

  const results = await searchOFF(`${ourName} ${keywords.split(' ').slice(0, 2).join(' ')}`.trim());
  const best = results
    .map((c) => ({ ...c, score: score(ourName, c.name, c.brand) }))
    .sort((a, b) => b.score - a.score)[0];

  const label = `${String(index + 1).padStart(3)}/${needing.length}  ${ourName.padEnd(28).slice(0, 28)}`;
  if (!best || best.score < 0.35) {
    console.log(`${dim(label)} ${dim('no usable match')}`);
  } else {
    proposals.push({
      sku,
      ourName,
      theirName: best.name,
      brand: best.brand,
      imageUrl: best.imageUrl,
      code: best.code,
      score: best.score,
    });
    const shown = `${best.name.slice(0, 34)}${best.brand ? ` (${best.brand.split(',')[0]})` : ''}`;
    console.log(
      `${label} ${best.score >= ACCEPT_SCORE ? green(shown) : yellow(shown + '  ← review')}` +
        dim(`  ${best.score.toFixed(2)}`),
    );
  }
  await wait(DELAY_MS);
}

/* ------------------------------------------------------------------ output */

const accepted = proposals.filter((p) => p.score >= ACCEPT_SCORE);

fs.writeFileSync(
  CANDIDATES,
  ['sku,our_product,off_product,off_brand,score,accepted,image_url,off_barcode']
    .concat(
      proposals.map((p) =>
        [
          p.sku,
          p.ourName,
          p.theirName,
          p.brand,
          p.score.toFixed(2),
          p.score >= ACCEPT_SCORE ? 'yes' : 'no',
          p.imageUrl,
          p.code,
        ]
          .map(quote)
          .join(','),
      ),
    )
    .join('\n') + '\n',
);

console.log('');
console.log(`  ${proposals.length} candidate(s), ${green(String(accepted.length))} scored above ${ACCEPT_SCORE}`);
console.log(`  written to ${dim(path.relative(process.cwd(), CANDIDATES))} — review before trusting them`);

if (!apply) {
  console.log(`\n  Nothing changed. Re-run with ${green('--apply')} to write the accepted ones into the catalogue.\n`);
  process.exit(0);
}

const byS = new Map(accepted.map((p) => [p.sku, p.imageUrl]));
let written = 0;
for (const row of rows) {
  const url = byS.get((row[skuAt] ?? '').trim());
  if (url) {
    row[imageAt] = url;
    written++;
  }
}

fs.writeFileSync(
  CSV,
  [header.map(quote).join(',')].concat(rows.map((r) => r.map(quote).join(','))).join('\n') + '\n',
);

console.log(`\n  ${green(`Wrote ${written} image URL(s)`)} into ${path.relative(process.cwd(), CSV)}.`);
console.log(dim('  Import or deploy to apply. Attribution: Open Food Facts contributors, CC-BY-SA.\n'));

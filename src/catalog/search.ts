/**
 * Catalogue search.
 *
 * The naive version — LIKE '%token%' against a few columns — fails in the three
 * ways customers actually type. "tomatos" finds nothing because of one letter.
 * "eggs" and "egg" are different words. "washing powder" finds nothing because
 * the shelf label says Laundry Detergent.
 *
 * Each of those is a lost sale on a product the shop is holding, so matching
 * here is deliberately forgiving: spelling is repaired, plurals are folded
 * together, and local names are understood.
 *
 * Forgiving is not the same as loose. A wrong match is worse than no match — a
 * customer shown ketchup when they asked for tomatoes stops trusting the rest of
 * the screen — so every query word has to be accounted for, and the words a
 * product did NOT match are reported back rather than quietly dropped. That is
 * what lets "cassava bread" show cassava chips as the nearest thing while still
 * being recorded as something the shop was asked for and did not have.
 */
import { db } from '../db/index.ts';
import type { Product } from '../db/repo.ts';

export type SearchOutcome = {
  results: Product[];
  /**
   * Query words the best result did not account for. Empty means the catalogue
   * answered the whole request; anything here means it answered part of it.
   */
  unmatched: string[];
};

/* --------------------------------------------------------------- vocabulary */

/**
 * Words that carry no product meaning. Customers write sentences — "do you have
 * any fresh tomatoes" — and without this the filler words drag in matches of
 * their own.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'is', 'are',
  'do', 'does', 'did', 'you', 'your', 'yall', 'we', 'i', 'me', 'my', 'have', 'has',
  'got', 'get', 'want', 'need', 'like', 'looking', 'look', 'send', 'give', 'gimme',
  'please', 'pls', 'plz', 'any', 'some', 'more', 'also', 'too', 'can', 'could',
  'would', 'there', 'that', 'this', 'it', 'im', 'am', 'still', 'sell', 'selling',
  'stock', 'available', 'price', 'cost', 'much', 'how', 'what', 'whats', 'where',
]);

/**
 * Quantities and packaging, stripped before matching.
 *
 * "2 lbs channa" and "channa" are one request. Left in, the numbers and units
 * dilute the score of every word that actually names the product.
 */
const QUANTITY =
  /\b\d+(\.\d+)?\s*(kg|kgs|g|gram|grams|lb|lbs|pound|pounds|oz|ml|l|litre|litres|liter|liters|pk|pack|packs|tin|tins|bottle|bottles|box|boxes|bag|bags|dozen|doz|each|piece|pieces)?\b/g;

/**
 * Words that mean the same thing on this coast.
 *
 * Each line is a group: any word in it matches any other. These are the general
 * ones — Creole names, British/American splits, and the brand names people use
 * as the word for the thing. Aliases for one specific product belong in that
 * product's `keywords` column in the catalogue CSV, not here.
 */
const SYNONYM_GROUPS: string[][] = [
  // Local and Caribbean names.
  ['channa', 'chickpea', 'chana', 'garbanzo'],
  ['dhal', 'dal', 'daal', 'split', 'pea'],
  ['bora', 'longbean', 'bodi', 'stringbean'],
  ['callaloo', 'calaloo', 'spinach', 'greens'],
  ['fig', 'banana'],
  ['provision', 'provisions', 'ground'],
  ['wiri', 'hot', 'spicy'],
  ['bully', 'corned', 'corn'],
  ['fowl', 'chicken'],
  ['seasoning', 'geera', 'masala', 'spice'],
  ['sweetdrink', 'softdrink', 'soda', 'cola', 'pepsi', 'coke'],

  // Same product, different word.
  ['washing', 'laundry', 'detergent'],
  ['tissue', 'toilet', 'paper'],
  ['garbage', 'trash', 'refuse', 'rubbish'],
  ['dish', 'dishwashing', 'washingup'],
  ['biscuit', 'cookie', 'cracker'],
  ['chip', 'crisp'],
  ['pasta', 'macaroni', 'spaghetti'],
  ['prawn', 'shrimp'],
  ['drink', 'juice', 'beverage'],
  ['nappy', 'diaper', 'pamper'],
  ['soap', 'soup'], // a near-universal typo, not a synonym — but it costs nothing

  // Brands used as the generic word.
  ['colgate', 'toothpaste'],
  ['clorox', 'bleach'],
  ['maggi', 'seasoning'],
];

/**
 * Word -> every word it should also match. Built once at load.
 *
 * Stored in singular form, because queries and product text are singularised
 * before they get here — a group listing "greens" would never be consulted, as
 * the token arriving is "green".
 */
const SYNONYMS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    const words = [...new Set(group.map((w) => singular(normalizeToken(w))))];
    for (const word of words) {
      const others = words.filter((w) => w !== word);
      map.set(word, [...new Set([...(map.get(word) ?? []), ...others])]);
    }
  }
  return map;
})();

/* ------------------------------------------------------------ normalisation */

/** Strips accents and anything that is not a letter or digit. */
export function normalizeToken(token: string): string {
  return token
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Crude singular form, applied to both sides so they meet in the middle.
 *
 * Not linguistically correct and does not need to be: "tomatoes" and "tomato"
 * only have to land on the same string as each other.
 */
export function singular(token: string): string {
  if (token.length < 4) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('oes')) return token.slice(0, -2);
  if (/(ches|shes|sses|xes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

function toTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(QUANTITY, ' ').split(/[^a-z0-9]+/i)) {
    const token = singular(normalizeToken(raw));
    if (token.length > 1) out.push(token);
  }
  return out;
}

/**
 * Joins adjacent words that are one term.
 *
 * "soft drink" and "sweet drink" are single things, and splitting them leaves
 * "drink" to match tea and coffee while "sweet" matches sugar. Only pairs that
 * are actually known terms are joined, so ordinary two-word queries are left
 * exactly as they are.
 */
function joinKnownPairs(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const joined = `${tokens[i]}${tokens[i + 1] ?? ''}`;
    if (tokens[i + 1] && SYNONYMS.has(joined)) {
      out.push(joined);
      i++;
    } else {
      out.push(tokens[i]!);
    }
  }
  return out;
}

/** The words of a query that actually name a product. */
export function queryTokens(query: string): string[] {
  const tokens = toTokens(query).filter((t) => !STOPWORDS.has(t));
  // A query made entirely of filler still deserves an attempt — "bread please"
  // reduced to nothing would be a miss for no reason.
  return joinKnownPairs(tokens.length > 0 ? tokens : toTokens(query));
}

/* ------------------------------------------------------------------ fuzzy */

/**
 * Damerau-Levenshtein distance, abandoned once it exceeds `max`.
 *
 * The transposition case is here because it is the typo people actually make on
 * a phone keyboard: "brwon" for "brown", "recipt" for "receipt".
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = [];

  for (let i = 1; i <= a.length; i++) {
    current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (prev[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (prev2[j - 2] ?? 0) + 1);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    // Every remaining path can only add to the row's minimum.
    if (best > max) return max + 1;
    prev2 = prev;
    prev = current;
  }
  return prev[b.length] ?? max + 1;
}

/** How much misspelling to forgive. Short words get none — "rice" is not "race". */
function tolerance(token: string): number {
  if (token.length <= 4) return 0;
  if (token.length <= 7) return 1;
  return 2;
}

/* ------------------------------------------------------------------ index */

type Indexed = {
  product: Product;
  name: string[];
  keywords: string[];
  category: string[];
  description: string[];
  /** The full name as one normalized string, for exact and prefix bonuses. */
  flatName: string;
};

/**
 * Matching runs in JavaScript over every active product rather than in SQL.
 *
 * Fuzzy matching cannot be expressed as a LIKE, and a shop's catalogue is small
 * — this is a scan of a few thousand rows at most, in memory, taking under a
 * millisecond. The index is rebuilt only when the catalogue actually changes.
 */
let cache: { version: number; rows: Indexed[] } | null = null;
let version = 0;

/** Called by the repo whenever a product row changes. */
export function invalidateSearchIndex(): void {
  version++;
}

function index(): Indexed[] {
  if (cache && cache.version === version) return cache.rows;

  const products = db
    .prepare(`SELECT *, image_url AS imageUrl FROM products WHERE active = 1`)
    .all() as unknown as Product[];

  const rows = products.map((product) => ({
    product,
    name: toTokens(product.name),
    keywords: toTokens(product.keywords),
    category: toTokens(product.category),
    description: toTokens(product.description),
    flatName: toTokens(product.name).join(' '),
  }));

  cache = { version, rows };
  return rows;
}

/* ---------------------------------------------------------------- scoring */

/** How much a hit in each field is worth. A name is what the product IS. */
const FIELD_WEIGHT = { name: 1, keywords: 0.72, category: 0.4, description: 0.25 };

/**
 * A synonym hit is real but weaker, so a literal match always ranks above it.
 *
 * Set just below the keyword field weight deliberately: "dhal" must rank Split
 * Peas, which lists dhal as a keyword, above Black Eye Peas, which merely shares
 * the word "peas" with dhal's synonym group.
 */
const SYNONYM_PENALTY = 0.7;

/**
 * Below this, a query word counts as unanswered by that product.
 *
 * Measured against the raw match strength, never the field-weighted score. A
 * word found in a description is genuinely accounted for even though a
 * description hit is worth little for ranking — judging it on the weighted
 * value would mark "soft drink" as something the shop does not sell because
 * "drink" only appears in Pepsi's description.
 */
const MET = 0.5;

/** Best strength for one query word against one list of product words. */
function matchStrength(token: string, candidates: string[]): number {
  let best = 0;
  const allowed = tolerance(token);

  for (const candidate of candidates) {
    if (candidate === token) return 1;

    let strength = 0;
    if (token.length >= 4 && candidate.startsWith(token)) strength = 0.9;
    // The query word extending a product word, as in "shampoos" over "shampoo".
    // Bounded tightly: without the length guard "saltfish" matches Table Salt
    // and "toothpaste" matches anything beginning "tooth".
    else if (candidate.length >= 4 && token.startsWith(candidate) && token.length - candidate.length <= 2)
      strength = 0.8;
    else if (token.length >= 4 && candidate.includes(token)) strength = 0.6;
    else if (allowed > 0) {
      // Kept below the keyword field weight on purpose: "pampers" must rank
      // Baby Diapers, which lists it as a keyword, above Toilet Paper, which is
      // one letter away from "pamper" by accident.
      const distance = editDistance(token, candidate, allowed);
      if (distance <= allowed) strength = distance === 1 ? 0.7 : 0.5;
    }

    if (strength > best) best = strength;
  }
  return best;
}

/**
 * How one query word fares against one product.
 *
 * `raw` is how well the word was found at all, and decides whether the product
 * answered it. `weighted` discounts by where it was found, and decides ranking.
 * Keeping them apart is what lets a description hit count as an answer without
 * pretending it is as good as a name.
 */
function scoreToken(token: string, row: Indexed): { raw: number; weighted: number } {
  const fields: [string[], number][] = [
    [row.name, FIELD_WEIGHT.name],
    [row.keywords, FIELD_WEIGHT.keywords],
    [row.category, FIELD_WEIGHT.category],
    [row.description, FIELD_WEIGHT.description],
  ];

  let raw = 0;
  let weighted = 0;
  for (const [candidates, weight] of fields) {
    const strength = matchStrength(token, candidates);
    if (strength > raw) raw = strength;
    if (strength * weight > weighted) weighted = strength * weight;
  }
  if (raw >= 1 && weighted >= 1) return { raw, weighted };

  for (const alias of SYNONYMS.get(token) ?? []) {
    // Descriptions are skipped for synonyms: a word two steps from what the
    // customer typed, found in prose, is coincidence more often than not.
    for (const [candidates, weight] of fields.slice(0, 3)) {
      const strength = matchStrength(alias, candidates) * SYNONYM_PENALTY;
      if (strength > raw) raw = strength;
      if (strength * weight > weighted) weighted = strength * weight;
    }
  }
  return { raw, weighted };
}

/* ------------------------------------------------------------------ search */

export function searchCatalog(query: string, category?: string, limit = 8): SearchOutcome {
  const tokens = queryTokens(query);
  const wanted = category?.trim().toLowerCase();

  let rows = index();
  if (wanted) rows = rows.filter((r) => r.product.category.toLowerCase() === wanted);
  if (tokens.length === 0) {
    return { results: rows.slice(0, limit).map((r) => r.product), unmatched: [] };
  }

  const flatQuery = tokens.join(' ');

  const scored = rows.map((row) => {
    const matches = tokens.map((token) => scoreToken(token, row));
    const strengths = matches.map((m) => m.raw);
    // The mean, not the sum: a product must answer the whole request, not score
    // highly on one word out of three. This is what stops "cassava bread" from
    // ranking Cassava Chips as though it were the thing asked for.
    const coverage = matches.reduce((a, m) => a + m.weighted, 0) / tokens.length;

    let score = coverage;
    if (row.flatName === flatQuery) score += 0.6;
    else if (row.flatName.startsWith(flatQuery)) score += 0.25;
    // Prefer what the customer can actually have today.
    if (row.product.stock <= 0) score -= 0.2;

    return { row, score, strengths, coverage };
  });

  // A product has to answer at least one word properly and be more than noise
  // overall, or it is a distraction rather than a suggestion. The floor sits
  // just above a category-only match, so asking for "eggs" returns eggs rather
  // than everything filed under Dairy & Eggs.
  const surviving = scored
    .filter((s) => s.coverage >= 0.45 && s.strengths.some((v) => v >= MET))
    .sort(
      (a, b) =>
        b.score - a.score ||
        // Equally good matches are broken by depth of stock. A shop holds most
        // of what it sells most, so this puts the staple ahead of the specialty.
        b.row.product.stock - a.row.product.stock ||
        a.row.product.name.localeCompare(b.row.product.name),
    );

  const top = surviving.slice(0, limit);
  const best = top[0];

  return {
    results: top.map((s) => s.row.product),
    // Reported against the best result alone. Judging the union of results would
    // call "cassava bread" fully answered because chips matched one word and a
    // loaf matched the other, which is exactly the demand worth recording.
    unmatched: best ? tokens.filter((_, i) => (best.strengths[i] ?? 0) < MET) : tokens,
  };
}

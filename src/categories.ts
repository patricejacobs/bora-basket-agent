/**
 * The grocery aisles, in the order somebody shops them.
 *
 * Fourteen categories came out of the catalogue import alphabetically, which
 * opened the list with Baby, Bakery, Baking and buried fresh produce in the
 * middle. Four of them held two or three items - a tap that opens three
 * things is not worth the tap - and three of them overlapped: flour and sugar
 * under Baking, oil and salt under Cooking Essentials, rice and split peas
 * under Rice & Grains, all of it dry store, with a customer hunting flour
 * able to reasonably try any of the three.
 *
 * Eleven now, nothing smaller than two, nothing larger than twelve, and
 * ordered fresh first and household last rather than by first letter.
 */
export const GROCERY_CATEGORIES = [
  'Fresh Produce',
  'Meat, Fish & Poultry',
  'Dairy & Eggs',
  'Bread & Bakery',
  'Rice, Peas & Pasta',
  'Cooking Basics',
  'Flour, Sugar & Baking',
  'Tinned Food',
  'Drinks & Snacks',
  'Household & Personal Care',
  'Baby',
] as const;

/**
 * What the old names became.
 *
 * Applied to grocery products only. The roti shop's menu has a Snacks
 * category of its own, and renaming that to "Drinks & Snacks" would re-label
 * somebody else's food - the same mistake as treating every shop as a
 * kitchen, which this code has made before.
 */
export const CATEGORY_RENAMES: Record<string, string> = {
  // Every aisle is named in English, including this one, which was briefly
  // Básico de Cocina after the shop's own Spanish name. One Spanish label
  // among ten English ones reads as an oversight rather than a choice, and
  // the agent translates what it says about an aisle anyway - so the name in
  // the data is the shop's working language and the customer still hears
  // their own.
  'Básico de Cocina': 'Cooking Basics',
  'Cooking & Seasoning': 'Cooking Basics',
  'Cooking Essentials': 'Cooking Basics',
  'Meat & Poultry': 'Meat, Fish & Poultry',
  'Fish & Seafood': 'Meat, Fish & Poultry',
  Bakery: 'Bread & Bakery',
  'Rice & Grains': 'Rice, Peas & Pasta',
  Baking: 'Flour, Sugar & Baking',
  'Canned & Packaged': 'Tinned Food',
  Beverages: 'Drinks & Snacks',
  Snacks: 'Drinks & Snacks',
  Household: 'Household & Personal Care',
  'Personal Care': 'Household & Personal Care',
};

/**
 * Where a category sits in the list. Anything the shop has invented for
 * itself sorts after the known ones, alphabetically among themselves, rather
 * than being hidden or forced into an order it was never given.
 */
export function categoryRank(category: string): number {
  const at = (GROCERY_CATEGORIES as readonly string[]).indexOf(category);
  return at === -1 ? GROCERY_CATEGORIES.length : at;
}

/** Sorts categories into shopping order, unknown ones last and alphabetical. */
export function inShoppingOrder<T extends { category: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => categoryRank(a.category) - categoryRank(b.category) || a.category.localeCompare(b.category),
  );
}

/* --------------------------------------------- labelling a list of items */

/**
 * The label an item carries in a list: a, b, c.
 *
 * Letters for items and numbers for aisles, so the two can never be confused.
 * They were both numbered, and after an aisle had been opened a bare "1"
 * meant the first product - while a customer who wanted a different aisle was
 * also reaching for "1". The shop could tell which list was last on the
 * screen; the customer could not, and "1" is exactly what somebody types when
 * they mean the first thing they can see.
 *
 * Past z it doubles up - aa, ab - which no aisle here needs, the largest
 * being twelve, but a shop that imports a catalogue of its own will.
 */
export function itemLabel(position: number): string {
  if (position < 1) return '';
  let n = position;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The position a label refers to, or null if it is not a label at all. */
export function labelPosition(label: string): number | null {
  const clean = label.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!clean) return null;
  let n = 0;
  for (const ch of clean) n = n * 26 + (ch.charCodeAt(0) - 96);
  return n > 0 ? n : null;
}

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
  'Básico de Cocina',
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
  // The shop's own name is Spanish and so is this aisle. Kept as one name
  // rather than translated per customer: a category is a shelf in a
  // particular shop, and the agent says what is on it in whatever language
  // the customer is writing.
  'Cooking & Seasoning': 'Básico de Cocina',
  'Cooking Essentials': 'Básico de Cocina',
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

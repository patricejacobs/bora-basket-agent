/**
 * Goods WhatsApp will not let you sell, caught at import.
 *
 * The Commerce Policy prohibits alcohol and tobacco, and a strike can cost the
 * phone number the whole business runs on. Groceries only brush against this —
 * one beer in a sample catalogue, which we removed by SKU. Restaurant menus run
 * straight into it: almost every place that sells a burger also sells a beer,
 * and the menu you are handed will list it.
 *
 * So a menu is filtered rather than trusted. A row naming drink is refused at
 * import with a reason, which is noisier than silently dropping it and much
 * safer than discovering it on the channel.
 *
 * Matched on words, not brands. Brand lists go stale and misfire — a restaurant
 * legitimately called after a brewery is not selling beer — while "rum" in a
 * product name means rum in every menu anyone has ever written.
 */

/** Word-boundary matches, so "ginger" is not caught by "gin". */
const ALCOHOL = [
  'alcohol', 'alcoholic', 'beer', 'beers', 'lager', 'stout', 'ale', 'ales', 'cider',
  'wine', 'wines', 'champagne', 'prosecco', 'sangria', 'rum', 'whisky', 'whiskey',
  'vodka', 'gin', 'brandy', 'tequila', 'liqueur', 'liquor', 'spirits', 'shandy',
  'cocktail', 'cocktails', 'mojito', 'margarita', 'daiquiri', 'martini', 'sake',
  'bourbon', 'schnapps', 'absinthe', 'vermouth', 'shot', 'shots', 'chaser',
];

const TOBACCO = [
  'cigarette', 'cigarettes', 'cigar', 'cigars', 'tobacco', 'vape', 'vapes',
  'nicotine', 'shisha', 'hookah', 'rolling paper', 'snuff',
];

/**
 * Compounds that contain a banned word but are not the banned thing.
 *
 * Removed from the text before matching, so "Ginger Beer" leaves nothing for
 * "beer" to catch while a row that also lists rum is still refused. Ginger beer
 * matters here: it is on half the menus in Guyana and refusing every soft drink
 * that offers it would be absurd.
 */
const SAFE_COMPOUNDS = [
  'ginger beer', 'root beer', 'sarsaparilla', 'rum cake', 'rum raisin', 'rum flavour',
  'rum flavoured', 'wine glass', 'coq au vin', 'beer batter', 'beer battered',
];

/**
 * An explicit statement by whoever wrote the menu that this is not alcohol.
 *
 * Trusted for the whole row, because it is a deliberate claim rather than an
 * accident of wording — "virgin mojito", "non-alcoholic beer".
 */
const DECLARED_FREE = [
  'non-alcoholic', 'nonalcoholic', 'non alcoholic', 'alcohol-free', 'alcohol free',
  'virgin', 'mocktail', 'zero alcohol', 'no alcohol', '0% abv',
];

function has(haystack: string, words: string[]): string | null {
  for (const word of words) {
    // Escaped because a phrase may contain a '%', and padded with boundaries so
    // a word inside a longer one does not match.
    const pattern = new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`, 'i');
    if (pattern.test(haystack)) return word;
  }
  return null;
}

/**
 * Why this item may not be sold here, or null if it may.
 *
 * Reads every field it is given, because a menu that calls an item "House
 * Special" puts the word rum in the description.
 */
export function restrictedReason(...fields: (string | undefined)[]): string | null {
  const raw = fields.filter(Boolean).join(' ').toLowerCase();
  if (!raw.trim()) return null;

  // An explicit "non-alcoholic" is the menu-writer's own statement; trusted.
  if (has(raw, DECLARED_FREE)) return null;

  // Then take out the compounds that merely contain a banned word, so what
  // remains is only text that genuinely names drink or tobacco.
  let text = raw;
  for (const safe of SAFE_COMPOUNDS) text = text.split(safe).join(' ');

  const alcohol = has(text, ALCOHOL);
  if (alcohol) return `alcohol ("${alcohol}") — WhatsApp's Commerce Policy prohibits selling it`;

  const tobacco = has(text, TOBACCO);
  if (tobacco) return `tobacco ("${tobacco}") — WhatsApp's Commerce Policy prohibits selling it`;

  return null;
}

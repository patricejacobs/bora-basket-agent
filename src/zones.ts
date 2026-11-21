/**
 * What a delivery costs, by the place it goes to.
 *
 * A tariff of named villages rather than a distance formula, because
 * straight-line kilometres lie about exactly the trips that cost most: the
 * west bank is five kilometres from Stabroek across the water and
 * twenty-five by road, and `location.ts` says so in as many words. A zone
 * knows the bridge is there.
 *
 * Read from a CSV so the shop can edit its own prices without a deploy, and
 * re-read on every boot. The place name is what gets stored against a
 * customer, never the figure - a price changed in the file must reprice the
 * next order rather than leaving a number nobody charges any more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, money } from './config.ts';

export type Zone = {
  /** The name as the shop wrote it, which is what gets read back to a customer. */
  place: string;
  /** The band it belongs to, for the receipt and the associate's card. */
  zone: string;
  fee: number;
  /**
   * The road it is on, from the file's own section headings.
   *
   * Bands say how far; corridors say which way. Dispatch needs the second to
   * decide who is "in the general area" of a pickup - two places 20 minutes
   * apart on the same road are nearer each other than two bands of the same
   * price on opposite sides of the river.
   */
  corridor: string;
};

export type ZoneMatch = Zone & {
  /** True when the customer's words name the place outright. */
  exact: boolean;
  /** Edit distance between the two sound-alike forms. 0 on an exact match. */
  distance: number;
};

export type ZoneLookup =
  /** One place, and the shop is sure of it. Still read it back before quoting. */
  | { kind: 'found'; match: ZoneMatch }
  /**
   * Several places fit and they are not the same price, so nothing can be
   * quoted until the customer says which. Two villages share the name Golden
   * Grove on different corridors, eight hundred dollars apart.
   */
  | { kind: 'ambiguous'; candidates: ZoneMatch[] }
  /** Nothing in the tariff is close enough to say out loud. */
  | { kind: 'unknown' };

/* ------------------------------------------------------------- the tariff */

let TARIFF: Zone[] = [];

/** Parses the tariff CSV. Comment lines and blanks are skipped. */
export function parseZones(text: string): Zone[] {
  const out: Zone[] = [];
  const lines = text.split(/\r?\n/);
  // The section headings are the corridors, and they are the only thing in
  // this file that says which places are on the road to one another. Read
  // from the headings rather than inferred from the band names: "Highway" is
  // the East Bank continuing and "Outer" is the East Coast, and no amount of
  // reading those two words tells you so.
  let corridor = '';
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#\s*-{3,}\s*(.+?)\s*$/);
    if (heading) {
      corridor = heading[1]!.replace(/,.*$/, '').trim();
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 3) continue;
    // The header, in whatever case it was written.
    if (cells[0]!.toLowerCase() === 'place') continue;
    const fee = Number(cells[2]!.replace(/[^0-9.]/g, ''));
    if (!cells[0] || !Number.isFinite(fee)) continue;
    out.push({
      place: cells[0]!,
      zone: cells[1] || cells[0]!,
      fee,
      corridor: corridor || cells[1] || cells[0]!,
    });
  }
  return out;
}

export function loadZones(text: string): number {
  tried = true;
  TARIFF = parseZones(text);
  return TARIFF.length;
}

let tried = false;

/**
 * Every place in the tariff, longest name first, which is how matching reads
 * it.
 *
 * Loads the file on first use rather than waiting to be asked. The server
 * loads it at boot anyway; this is so the test suite, the walkthroughs and the
 * card gallery price a delivery the same way the shop does, instead of
 * quietly falling back to the flat fee and proving nothing.
 */
export function zones(): Zone[] {
  if (TARIFF.length === 0 && !tried) {
    tried = true;
    loadZonesFromDisk();
  }
  return [...TARIFF].sort((a, b) => b.place.length - a.place.length);
}

export function zoneCount(): number {
  return zones().length;
}

/**
 * The tariff in the order the file lists it, which runs outward from town.
 *
 * `zones()` sorts by name length, because that is the order matching has to
 * read it in. A list put in front of a customer needs the shop's own order
 * instead: "Georgetown, Kingston, Cummingsburg" is a road, and the same places
 * sorted by how long their names are is nothing at all.
 */
export function tariff(): Zone[] {
  // Through zones() rather than TARIFF directly, so the file still loads on
  // first use.
  zones();
  return [...TARIFF];
}

/**
 * The corridors, in the order the tariff lists them.
 *
 * Four roads out of town and the town itself, read from the section headings
 * rather than from the band names — see parseZones, which explains why those
 * two are not the same thing.
 */
export function corridors(): string[] {
  const out: string[] = [];
  for (const z of tariff()) if (!out.includes(z.corridor)) out.push(z.corridor);
  return out;
}

/** Every place on one corridor, in the tariff's own order. */
export function placesIn(corridor: string): Zone[] {
  return tariff().filter((z) => z.corridor === corridor);
}

/**
 * Loads the tariff from disk. Called once at boot; silent when there is no
 * file, because a shop that has not written one simply charges its flat fee.
 */
export function loadZonesFromDisk(): number {
  const where = config.store.zonesPath;
  if (!where) return 0;
  const file = path.resolve(where);
  if (!fs.existsSync(file)) {
    console.warn(`[zones] no tariff at ${file} — delivery stays at the flat fee`);
    return 0;
  }
  try {
    const n = loadZones(fs.readFileSync(file, 'utf8'));
    console.log(`[zones] ${n} place(s) priced`);
    return n;
  } catch (err) {
    console.error('[zones] tariff could not be read:', err);
    return 0;
  }
}

/* ------------------------------------------------------------- the matching */

/** Punctuation and case gone, so "Vreed-en-Hoop" and "vreed en hoop" are one. */
function plain(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * How a name sounds, roughly, so a spelling nobody agrees on still matches.
 *
 * Guyanese place names are Dutch, French and English in one breath and are
 * written a dozen ways: Klien and Klein Pouderoyen, Pouderoyan, Vreed-en-Hoop
 * and Freed en Hoop, Mon Repos and Mon Repose, Beterverwagting with any number
 * of letters. Spelling is not what a customer is being asked about.
 *
 * Deliberately crude: doubled letters collapse, the digraphs that vary most
 * are flattened, and voiced and unvoiced pairs that swap in Dutch spelling are
 * treated as one. It is only ever used to RANK candidates - the name is then
 * read back to the customer for a yes, so a wrong guess costs a question
 * rather than a price.
 */
export function soundalike(s: string): string {
  let t = plain(s);
  t = t
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/th/g, 't')
    .replace(/gh/g, 'g')
    .replace(/sch/g, 'sk')
    // Dutch -cht is the -gt the same village is spelled with elsewhere:
    // Uitvlucht and Uitvlugt are one place. Before c becomes k below, or the
    // two spellings end up two letters apart.
    .replace(/cht/g, 'gt')
    // ij, ei and y all land on the same sound in these names.
    .replace(/ij/g, 'i')
    .replace(/ei/g, 'i')
    .replace(/y/g, 'i')
    // oe and ou are u; oo is long but spelled both ways. So is ow, and it has
    // to be flattened HERE rather than left to the w rule below — Powderoyen
    // and Pouderoyen are the same village, and "pof" against "pu" is two
    // letters apart for no reason anybody said out loud.
    .replace(/oe/g, 'u')
    .replace(/ou/g, 'u')
    .replace(/ow/g, 'u')
    .replace(/oo/g, 'u')
    // v, w and f swap constantly between Dutch and English spellings.
    .replace(/w/g, 'v')
    .replace(/v/g, 'f')
    .replace(/z/g, 's')
    .replace(/c/g, 'k')
    // A trailing e is silent in most of these.
    .replace(/e\b/g, '')
    // And then any letter doubled is one letter.
    .replace(/(.)\1+/g, '$1');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Edit distance where swapping two neighbouring letters costs one, not two.
 *
 * Plain edit distance charges a transposition twice — once to take the letter
 * out and once to put it back — which is wrong about thumbs. Typing "Leonroa"
 * for Leonora is one slip, and counting it as two put it in the same bracket
 * as Mahdia against Mahaica, which is two deliberate differences between two
 * real towns several hundred kilometres apart. The slack then had to be set
 * loose enough for the typo, which left it loose enough for the town.
 *
 * Counting the swap as the single slip it is separates them, so the allowance
 * can be tight and still forgive the commonest mistake anybody makes.
 *
 * Capped, so a long mismatch costs nothing to reject.
 */
function distance(a: string, b: string, cap = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  // Three rows rather than two: a transposition needs the row before last.
  let twoBack: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      // The two letters either side swapped over.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j]!, twoBack[j - 2]! + 1);
      }
    }
    twoBack = prev;
    prev = row;
    if (Math.min(...row) > cap) return cap + 1;
  }
  return prev[b.length]!;
}

/** Whole words only, so Diamond is not found inside Diamondback Street. */
function holds(whole: string, part: string): boolean {
  if (!whole || !part) return false;
  return ` ${whole} `.includes(` ${part} `);
}

/**
 * How much slack a name of this length gets: one letter per seven, at least
 * one and never more than three.
 *
 * Proportional, because the thing that matters is not how many letters are
 * wrong but what share of the name they are. Two wrong letters in
 * Beterverwagting is a thumb on a phone; two in Mahaica is a different place.
 *
 * It used to be banded — one letter up to five, two up to nine, three beyond —
 * which gave a seven-letter name two letters of slack, nearly a third of it.
 * That is how *Mahdia*, a mining town several hundred kilometres inland, was
 * silently read as *Mahaica* on the coast and quoted $4,800. Measured against
 * a typo of every place in the tariff, every wrong answer the matcher gave sat
 * in that second letter of slack; at one letter it gave none at all.
 *
 * The cost is that a name mistyped twice now goes unmatched instead of being
 * guessed at, and the agent asks. For a fare that is the right way round: a
 * question costs a message, a wrong village costs the difference between $700
 * and $4,800 and nobody notices until the car arrives.
 */
function allowance(name: string): number {
  // A letter of slack per seven, counted WORD BY WORD and never less than one
  // a word, up to three for the whole name.
  //
  // Per word rather than over the whole string, because a budget spent on one
  // word is a different word. "Meadow Bank" is eleven characters and used to
  // get three letters of slack, which let it answer to "Diamond, East Bank" —
  // every one of those three spent turning "east" into "meadow", with "bank"
  // doing all the work. Per word it gets one and one, and the match fails as
  // it should.
  //
  // Proportional rather than banded, because what matters is not how many
  // letters are wrong but what share of the word they are. Two wrong letters
  // in Beterverwagting is a thumb on a phone. Two in Mahaica is *Mahdia*, a
  // mining town several hundred kilometres inland, silently quoted $4,800 as
  // though it were on the coast.
  //
  // One letter is enough to forgive the commonest mistakes because the
  // distance below counts a swapped pair as one, and because soundalike has
  // already flattened the spellings people genuinely disagree about.
  const perWord = name
    .split(' ')
    .reduce((sum, word) => sum + Math.max(1, Math.floor(word.length / 7)), 0);
  return Math.min(3, perWord);
}

/**
 * Finds the place in an address.
 *
 * Three passes, strongest first. A name written outright wins; the longest
 * such name wins over a shorter one inside it, so Golden Grove is not priced
 * as Grove and Good Hope is not priced as Hope. Only then are near-spellings
 * considered, and only against windows of the same word count, so a long
 * address cannot drift into a short village name.
 */
/**
 * The tariff's own spelling of a place somebody typed.
 *
 * The near-matcher has always been able to price a misspelling — `Bagotvile`
 * is priced as Bagotville and always was — but what got written down, read
 * back and put in front of the passenger was the typing. So a passenger was
 * asked to agree to `Bagotvile`: a place that does not exist, at a price
 * they cannot check against anything, with no way to tell whether the shop
 * had understood them or guessed.
 *
 * Only a SPELLING match is rewritten, which is what `exact: false` means
 * here. The other way a lookup succeeds is by containing the place —
 * `14 Delph Street, Campbellville` finds Campbellville — and rewriting that
 * one would throw away the street and leave a driver with a village to
 * search. So:
 *
 *   Bagotvile                       -> Bagotville   (corrected)
 *   14 Delph Street, Campbellville  -> unchanged
 *   Diamond                         -> unchanged
 *   somewhere nobody has heard of   -> unchanged
 */
export function asTariffPlace(text: string): { place: string; corrected: boolean } {
  const said = String(text ?? '').trim();
  const found = findZone(said);
  if (found.kind !== 'found' || found.match.exact !== false) {
    return { place: said, corrected: false };
  }
  return { place: found.match.place, corrected: found.match.place !== said };
}

/**
 * What a place is called by the people who go there.
 *
 * Not nicknames and not slang: these are the ordinary names. Nobody asks for
 * a car to Beterverwagting, they ask for BV, and the tariff had never heard
 * of it — the lookup came back `unknown` and the passenger was asked again
 * for a place they had already named correctly. The gazetteer these names
 * were geocoded against does not list them either, because it lists what is
 * on a map rather than what is in a mouth.
 *
 * Keyed and valued in the plain form, and substituted WORD BY WORD, so "BV
 * public road" and "GT" both land. Added only on the word of somebody who
 * lives there — a wrong alias is a car sent to the wrong village, and
 * nothing downstream would question it.
 */
const ALIASES: Record<string, string> = {
  bv: 'beterverwagting',
  gt: 'georgetown',
};

const expandAliases = (said: string): string =>
  said
    .split(' ')
    .map((word) => ALIASES[word] ?? word)
    .join(' ');

/**
 * The tariff's answer to what somebody typed.
 *
 * A short form is swapped for the name before anything else happens, and
 * what comes back is marked as not being what they wrote — which is true,
 * and is what has the trip written down as Beterverwagting rather than as
 * BV. See asTariffPlace, which is where that matters.
 */
export function findZone(text: string): ZoneLookup {
  const said = plain(text);

  // The short form ON ITS OWN is the place, and is not what the place is
  // called, so the trip gets written down under the name. `B.V.` arrives
  // here as `b v`, which is why the spaces come out before the lookup.
  const alone = ALIASES[said.replace(/\s+/g, '')];
  if (alone) {
    const found = lookupZone(alone);
    return found.kind === 'found'
      ? { kind: 'found', match: { ...found.match, exact: false } }
      : found;
  }

  // Inside a longer address it is a word like any other: swapped so the
  // matcher can read the rest, and the address kept exactly as written.
  // `Lot 8 BV` is where a driver is going; `Beterverwagting` is only how
  // the trip is priced, and overwriting one with the other loses the lot
  // number.
  return lookupZone(expandAliases(said));
}

function lookupZone(said: string): ZoneLookup {
  const table = zones();
  if (table.length === 0) return { kind: 'unknown' };

  if (!said) return { kind: 'unknown' };
  const saidWords = said.split(' ');

  /* What they said IS a place, exactly. First, before anything else.
     
     Without this, "Diamond" was answered with Little Diamond - which is a
     real village containing the whole of what the customer said, so the
     next rule claimed it, and the shop read back the wrong name. The price
     happened to be the same, which is worse: nothing would have caught it. */
  const named = table.find((z) => plain(z.place) === said);
  if (named) return { kind: 'found', match: { ...named, exact: true, distance: 0 } };

  /* What they said is PART of a longer name - "Golden Grove" against "Golden
     Grove East Bank". That is a question rather than an answer when the
     candidates disagree about the price: two villages share that name on
     different corridors, eight hundred dollars apart. */
  const wider = table.filter((z) => holds(plain(z.place), said));
  if (wider.length > 0) {
    const fees = new Set(wider.map((c) => c.fee));
    if (wider.length === 1 || fees.size === 1) {
      // The shortest, being the nearest to what they actually said.
      const nearest = [...wider].sort((a, b) => a.place.length - b.place.length)[0]!;
      return { kind: 'found', match: { ...nearest, exact: true, distance: 0 } };
    }
    return {
      kind: 'ambiguous',
      candidates: wider.slice(0, 4).map((z) => ({ ...z, exact: false, distance: 0 })),
    };
  }

  /* Everything the address could be naming, gathered before anything is
     ranked.
     
     Collecting first and judging afterwards is the whole point. Taking the
     first good answer in pass order is what made "Metin Meer Zorg" cost
     $2,600: Meer Zorg is spelled perfectly inside it and Meten-Meer-Zorg is
     one letter out, so an exact match on the shorter name beat a near match
     on the longer one - and quoted a village $1,400 cheaper with complete
     confidence. */
  const found = new Map<string, ZoneMatch & { words: number }>();
  const keep = (z: Zone, exact: boolean, d: number, words: number): void => {
    const had = found.get(z.place);
    if (had && (had.distance < d || (had.distance === d && had.exact))) return;
    found.set(z.place, { ...z, exact, distance: d, words });
  };

  const squashedSaid = soundalike(said).replace(/ /g, '');

  for (const z of table) {
    const written = plain(z.place);
    const target = soundalike(z.place);
    const words = target.split(' ').length;

    // The name as written, whole words only, so Diamond is not found inside
    // Diamondback Street.
    if (holds(said, written)) {
      keep(z, true, 0, words);
      continue;
    }

    // Written as one word - Vreedenhoop, Monrepos, Metenmeerzorg. Only for
    // names that have a space in them: matching a one-word name inside a run
    // of letters is how Diamondback Street gets priced as Diamond.
    if (written.includes(' ') && squashedSaid.includes(target.replace(/ /g, ''))) {
      keep(z, false, 0, words);
      continue;
    }

    // A near spelling, compared on sound rather than letters, against every
    // window of the address with the same number of words as the name.
    const slack = allowance(target);
    let best = slack + 1;
    for (let i = 0; i + words <= saidWords.length; i++) {
      const window = soundalike(saidWords.slice(i, i + words).join(' '));
      if (Math.abs(window.length - target.length) > slack) continue;
      const d = distance(window, target, slack);
      if (d < best) best = d;
    }
    if (best <= slack) keep(z, false, best, words);
  }

  const all = [...found.values()];
  if (all.length === 0) return { kind: 'unknown' };

  // The most specific name wins before the closest spelling does. A name that
  // accounts for more of what the customer wrote beats one that accounts for
  // less, however well spelled; only then does spelling break the tie, and
  // then the longer name.
  all.sort(
    (a, b) =>
      b.words - a.words ||
      a.distance - b.distance ||
      Number(b.exact) - Number(a.exact) ||
      b.place.length - a.place.length,
  );

  const top = all[0]!;
  const tied = all.filter(
    (c) => c.words === top.words && c.distance === top.distance && c.exact === top.exact,
  );
  if (tied.length > 1 && new Set(tied.map((t) => t.fee)).size > 1) {
    return { kind: 'ambiguous', candidates: tied.slice(0, 4) };
  }
  return { kind: 'found', match: top };
}

/** The fee for an address, or null when the tariff cannot answer. */
export function zoneFeeFor(text: string): { place: string; zone: string; fee: number } | null {
  const found = findZone(text);
  if (found.kind !== 'found') return null;
  const { place, zone, fee } = found.match;
  return { place, zone, fee };
}

/** How the fee is said: "East Bank — $1,800". */
export function describeZone(z: { zone: string; fee: number }): string {
  return `${z.zone} — ${money(z.fee)}`;
}

/* ------------------------------------------------- two-ended journeys */

/**
 * The cheapest fee in the tariff: a delivery that goes nowhere.
 *
 * Read from the file rather than written down, so a shop that reprices its
 * own tariff reprices this with it. Every fare below is this plus the road.
 */
function baseFee(): number {
  const fees = zones().map((z) => z.fee);
  return fees.length > 0 ? Math.min(...fees) : config.store.deliveryFee;
}

/**
 * What the river costs, read off the cheapest place on the far side.
 *
 * The west is priced from the bridge, not from the map: Vreed-en-Hoop is five
 * kilometres from Stabroek and twenty-five by road. That crossing is inside
 * every west-side fee, so a journey between two places that are both already
 * over there must not be charged for it twice.
 */
function bridgeCost(): number {
  const west = zones().filter((z) => z.corridor.startsWith('West'));
  if (west.length === 0) return 0;
  return Math.min(...west.map((z) => z.fee)) - baseFee();
}

/** What the two corridors share before they part company. */
function sharedTrunk(a: Zone, b: Zone, base: number): number {
  const outA = a.fee - base;
  const outB = b.fee - base;
  // Georgetown is the hub and is on the way to everywhere, so a journey from
  // it is the difference between the two and not the sum.
  if (a.corridor === b.corridor || a.corridor === 'Georgetown' || b.corridor === 'Georgetown') {
    return Math.min(outA, outB);
  }
  // Both sides of the river share the bridge and the run up to it, parting
  // at Vreed-en-Hoop — one going south, one going west.
  if (a.corridor.startsWith('West') && b.corridor.startsWith('West')) return bridgeCost();
  // Everything else parts company in Georgetown itself: one leg in, one out.
  return 0;
}

export type Fare = {
  fee: number;
  from: { place: string; zone: string };
  to: { place: string; zone: string };
  /** Said plainly, for a read-back: "Parika to Diamond". */
  explanation: string;
};

/**
 * What it costs to carry something from one place to another.
 *
 * The tariff prices ONE journey — out of Georgetown — which is the right
 * answer for a delivery, because the shop is always at one end of it. A
 * parcel is a two-ended job the same table can only half-describe: priced by
 * its destination alone, a parcel from Parika to Diamond costs what a
 * Diamond delivery costs, and nobody is paid for the seventy kilometres in
 * between.
 *
 * Strip the base off each end and what is left is the road out of town. Same
 * corridor, the fare is the difference; different corridors, the sum, because
 * you come into town and go back out. The bridge is charged once.
 *
 * It reduces to the tariff exactly whenever one end is Georgetown, which is
 * every delivery the shop makes — so this is a generalisation of the existing
 * prices, not a second set of them.
 *
 * Null when either end is not in the tariff: better no figure than one made
 * up from half a journey.
 */
export function fareBetween(fromText: string, toText: string): Fare | null {
  const from = findZone(fromText);
  const to = findZone(toText);
  if (from.kind !== 'found' || to.kind !== 'found') return null;

  const base = baseFee();
  const trunk = sharedTrunk(from.match, to.match, base);
  const fee =
    base +
    Math.max(0, from.match.fee - base - trunk) +
    Math.max(0, to.match.fee - base - trunk);

  return {
    fee,
    from: { place: from.match.place, zone: from.match.zone },
    to: { place: to.match.place, zone: to.match.zone },
    explanation: `${from.match.place} to ${to.match.place}`,
  };
}

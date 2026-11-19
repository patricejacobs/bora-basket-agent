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
    // ij, ei and y all land on the same sound in these names.
    .replace(/ij/g, 'i')
    .replace(/ei/g, 'i')
    .replace(/y/g, 'i')
    // oe and ou are u; oo is long but spelled both ways.
    .replace(/oe/g, 'u')
    .replace(/ou/g, 'u')
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

/** Ordinary edit distance, capped so a long mismatch costs nothing to reject. */
function distance(a: string, b: string, cap = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
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

/** How much slack a name of this length gets. Short names get almost none. */
function allowance(name: string): number {
  if (name.length <= 5) return 1;
  if (name.length <= 9) return 2;
  return 3;
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
export function findZone(text: string): ZoneLookup {
  const table = zones();
  if (table.length === 0) return { kind: 'unknown' };

  const said = plain(text);
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

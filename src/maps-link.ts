/**
 * Reading a location out of something a customer pasted.
 *
 * WhatsApp's own location button is the best way to get a pin, and nothing
 * here replaces it. But plenty of people never use it: they are on desktop,
 * they are forwarding an address somebody else sent them, or — the case this
 * service hits constantly — they are booking a parcel to a door they are not
 * standing at and cannot drop a pin on. What they send instead is a Google
 * Maps link or a plus code.
 *
 * Until now that arrived as plain text and nothing read it. The customer
 * believes they have answered the question. That is the failure this fixes: not
 * a refusal, which a person can see, but a silent one.
 *
 * Three sources, in order of how much they can be trusted:
 *
 *   plus code      pure arithmetic, no network, no key, no ambiguity
 *   long Maps URL  the coordinates are in the URL, if you read the right ones
 *   short link     opaque; one redirect to follow, then as above
 *
 * None of this makes a resolved point as good as a pin. A link to a town
 * resolves to the middle of the town, and the caller is told so rather than
 * being handed a number that looks like a doorstep.
 */
import { parseCoordinates, type Coordinates } from './location.ts';

/* ------------------------------------------------------------- plus codes */

/**
 * The Open Location Code alphabet. Twenty characters, chosen to avoid ones
 * that look alike or spell words by accident — there is no I, L, O, S, U or Z.
 */
const ALPHABET = '23456789CFGHJMPQRVWX';

/**
 * How much of a degree each character pair resolves, in order.
 *
 * 20°, then 1°, then twentieths, and so on. The last pair of a ten-character
 * code narrows it to about 14 m by 14 m — a building, not a point, which is
 * why the decoded value is the centre of that box rather than a corner.
 */
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125];

/** A full code: eight characters, a plus, then two or three more. */
const FULL_PLUS_CODE = /\b([23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;

/**
 * A short code: four characters, a plus, then two or three.
 *
 * On its own it means nothing — it is a position relative to somewhere else,
 * and without that somewhere it could be any of several hundred places on
 * earth. See `decodeShortPlusCode` for what is used as the reference and why
 * that is only safe locally.
 */
const SHORT_PLUS_CODE = /\b([23456789CFGHJMPQRVWX]{4,6}\+[23456789CFGHJMPQRVWX]{2,3})\b/i;

/**
 * Decodes a full plus code to the centre of the box it describes.
 *
 * Returns null rather than throwing on anything malformed: this is fed by
 * whatever a customer typed, and a near-miss is far more likely than a
 * well-formed code.
 */
export function decodePlusCode(code: string): Coordinates | null {
  const cleaned = code.toUpperCase().replace(/\s+/g, '');
  const plus = cleaned.indexOf('+');
  if (plus !== 8) return null;

  const digits = cleaned.replace('+', '');
  // Padding ('0') marks a deliberately vague code — a whole region rather than
  // a place. Refused: there is nothing useful to deliver to.
  if (digits.includes('0')) return null;
  if (digits.length < 10 || digits.length > 11) return null;
  if (![...digits].every((c) => ALPHABET.includes(c))) return null;

  let lat = -90;
  let lng = -180;

  for (let pair = 0; pair < 5; pair += 1) {
    const resolution = PAIR_RESOLUTIONS[pair];
    if (resolution === undefined) break;
    const latChar = digits[pair * 2];
    const lngChar = digits[pair * 2 + 1];
    if (latChar === undefined || lngChar === undefined) break;
    lat += ALPHABET.indexOf(latChar) * resolution;
    lng += ALPHABET.indexOf(lngChar) * resolution;
  }

  // The centre of the smallest box the code resolved, not its corner. Half a
  // box is about 7 m here, which is the difference between a gate and next
  // door's gate.
  const half = (PAIR_RESOLUTIONS[4] ?? 0) / 2;
  return parseCoordinates(lat + half, lng + half);
}

/**
 * Recovers a short plus code against a nearby reference point.
 *
 * A short code drops the leading characters that say which part of the world
 * you are in, because everybody in the conversation already knows. Here the
 * reference is the shop's own centre, which is sound for a delivery business
 * whose customers are by definition nearby — and wrong for anything else, so a
 * code recovered more than half a degree from the reference is refused rather
 * than quietly resolved to a place in the next region.
 */
export function decodeShortPlusCode(code: string, near: Coordinates): Coordinates | null {
  const cleaned = code.toUpperCase().replace(/\s+/g, '');
  const plus = cleaned.indexOf('+');
  if (plus < 2 || plus >= 8) return null;

  // Build the reference's own full code and borrow its leading characters.
  const prefix = encodePlusCode(near).slice(0, 8 - plus);
  const recovered = decodePlusCode(prefix + cleaned);
  if (!recovered) return null;

  // A short code is only meaningful close to its reference. Further than this
  // and the prefix borrowed above is a guess, not a recovery.
  if (Math.abs(recovered.latitude - near.latitude) > 0.5) return null;
  if (Math.abs(recovered.longitude - near.longitude) > 0.5) return null;
  return recovered;
}

/** The ten-character plus code for a point. Used to borrow a prefix from. */
export function encodePlusCode(point: Coordinates): string {
  let lat = Math.min(Math.max(point.latitude, -90), 89.999999) + 90;
  let lng = ((point.longitude + 180) % 360 + 360) % 360;
  let out = '';

  for (let pair = 0; pair < 5; pair += 1) {
    const resolution = PAIR_RESOLUTIONS[pair];
    if (resolution === undefined) break;
    const latIndex = Math.floor(lat / resolution);
    const lngIndex = Math.floor(lng / resolution);
    out += (ALPHABET[Math.min(latIndex, 19)] ?? '2') + (ALPHABET[Math.min(lngIndex, 19)] ?? '2');
    lat -= latIndex * resolution;
    lng -= lngIndex * resolution;
  }

  return `${out.slice(0, 8)}+${out.slice(8)}`;
}

/* -------------------------------------------------------------- Maps URLs */

/**
 * How much the caller should trust what came back.
 *
 * This is the whole reason the parse returns a shape rather than a pair of
 * numbers. "A place Google has a record of" and "roughly where the map was
 * pointing" are both coordinates, and treating them the same is how somebody
 * gets sent to the wrong end of a runway.
 */
export type LinkPrecision =
  /** A specific place, from the fields Google writes for the pin itself. */
  | 'place'
  /** A plus code: a box of about 14 m, decoded rather than looked up. */
  | 'plus_code'
  /** Coordinates the customer typed or pasted directly. */
  | 'coordinates'
  /**
   * The map's viewport centre. Present in every Maps URL and never the pin:
   * it drifts with the zoom and the label. Good enough to place somebody in a
   * region, not good enough to drive to.
   */
  | 'viewport';

export type LinkParse = { found: true; point: Coordinates; precision: LinkPrecision; label: string }
  | { found: false; reason: string };

/**
 * The place name Google puts in the path, turned back into words.
 *
 * Useful beyond decoration: a label with no street number in it — "Timehri,
 * Guyana" — is the tell that a link points at a locality rather than a door.
 */
function labelFromUrl(url: string): string {
  const named = /\/maps\/place\/([^/@?]+)/.exec(url);
  if (!named?.[1]) return '';
  try {
    return decodeURIComponent(named[1].replace(/\+/g, ' ')).trim().slice(0, 120);
  } catch {
    return named[1].replace(/\+/g, ' ').trim().slice(0, 120);
  }
}

/**
 * Pulls a point out of a full Google Maps URL.
 *
 * Order matters here more than anything else in this file. A Maps URL for a
 * place carries two different coordinate pairs, and the obvious one is the
 * wrong one:
 *
 *   .../@33.9408089,-83.3227756,14z/data=...!8m2!3d33.9517494!4d-83.3239147
 *        ^ the viewport, 1.2 km out        ^ the actual place
 *
 * So `!3d`/`!4d` first, then an explicit `q=`, and only then `@` — which is
 * returned as 'viewport' so the caller knows not to treat it as a doorstep.
 */
export function parseMapsUrl(url: string): LinkParse {
  const label = labelFromUrl(url);

  // The pin itself, as Google records it.
  const place = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(url);
  if (place) {
    const point = parseCoordinates(place[1], place[2]);
    if (point) return { found: true, point, precision: 'place', label };
  }

  // An explicit query, which is what a "share coordinates" link looks like.
  const query = /[?&]q=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i.exec(url);
  if (query) {
    const point = parseCoordinates(query[1], query[2]);
    if (point) return { found: true, point, precision: 'coordinates', label };
  }

  // A plus code can appear in the path of a shared link.
  const coded = FULL_PLUS_CODE.exec(decodeURIComponent(url));
  if (coded?.[1]) {
    const point = decodePlusCode(coded[1]);
    if (point) return { found: true, point, precision: 'plus_code', label };
  }

  // Last, and flagged for what it is.
  const viewport = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url);
  if (viewport) {
    const point = parseCoordinates(viewport[1], viewport[2]);
    if (point) return { found: true, point, precision: 'viewport', label };
  }

  return { found: false, reason: 'No coordinates in that link.' };
}

/* ------------------------------------------------------------ short links */

/**
 * Hosts a short link is allowed to be, and to redirect to.
 *
 * This is a security boundary, not tidiness. The URL being fetched came from
 * whoever messaged the service, so without an allowlist a customer could point
 * the server at anything it can reach — including addresses only reachable
 * from inside the host. Checked on the original URL and again on whatever it
 * redirects to.
 */
const ALLOWED_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'google.com',
  'g.co',
  'maps.app.google.com',
]);

const isAllowed = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** Any Google link worth trying to resolve. */
const MAPS_URL = /https?:\/\/(?:[a-z0-9-]+\.)*(?:google\.[a-z.]+|goo\.gl|g\.co)\/[^\s<>"']+/i;

/**
 * Follows a short link far enough to read the real URL out of it.
 *
 * Deliberately does not fetch the body: the redirect target carries everything
 * needed, and downloading a page from a link a stranger sent is a larger
 * surface than this is worth. One hop, a short timeout, and the allowlist
 * applied again to wherever it points — a redirect is somebody else choosing
 * the next address.
 */
export async function resolveShortLink(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string | null> {
  if (!isAllowed(url)) return null;

  const stop = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: stop });
    const location = response.headers.get('location');
    if (!location) return null;
    const absolute = new URL(location, url).toString();
    // The redirect target is chosen by the other end, so it is checked too.
    return isAllowed(absolute) ? absolute : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ entry */

/**
 * Everything above, applied to whatever the customer actually sent.
 *
 * Tries the sources that cost nothing first — a plus code is arithmetic, a
 * long URL is a regex — so the network is only touched for a short link, which
 * is the one case that genuinely needs it.
 *
 * `near` is the shop's own position, used only to recover a short plus code.
 * Without it those are refused rather than guessed at.
 */
export function readLocationSync(
  text: string,
  options: { near?: Coordinates | null } = {},
): LinkParse {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { found: false, reason: 'Nothing to read.' };

  // A full plus code needs no reference and no network.
  const full = FULL_PLUS_CODE.exec(trimmed);
  if (full?.[1]) {
    const point = decodePlusCode(full[1]);
    if (point) return { found: true, point, precision: 'plus_code', label: full[1].toUpperCase() };
  }

  // A long Maps URL carries its own coordinates.
  const link = MAPS_URL.exec(trimmed);
  if (link?.[0] && /\/maps|[?&]q=/.test(link[0])) {
    const parsed = parseMapsUrl(link[0]);
    if (parsed.found) return parsed;
  }

  // Bare coordinates, which people paste more often than you would think.
  const bare = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/.exec(trimmed);
  if (bare) {
    const point = parseCoordinates(bare[1], bare[2]);
    if (point) return { found: true, point, precision: 'coordinates', label: '' };
  }

  // A short plus code, last, because it is the only one that can be wrong in a
  // way that still looks right — and only when there is a reference for it.
  const short = SHORT_PLUS_CODE.exec(trimmed);
  if (short?.[1] && options.near) {
    const point = decodeShortPlusCode(short[1], options.near);
    if (point) return { found: true, point, precision: 'plus_code', label: short[1].toUpperCase() };
  }

  // A short link that was never expanded. Said plainly rather than guessed at:
  // the caller is told there is a link it could not read, not that the message
  // contained nothing.
  if (link?.[0]) return { found: false, reason: 'That link could not be read.' };

  return { found: false, reason: 'No location in that message.' };
}

/**
 * Expands any Google short link in a message to the URL it points at.
 *
 * This runs once, at the edge, before the conversation starts — rather than
 * inside a tool, because the tool layer is synchronous and following a
 * redirect is not. Making that layer asynchronous would turn a loop that runs
 * tools strictly in order into one that runs them at once, and tools here
 * mutate a shopping cart.
 *
 * So by the time anything reads the message, a short link has already become a
 * long one and every reader stays synchronous. A link that will not resolve is
 * left exactly as it was: the customer still said something, and a message
 * silently edited to remove it would be worse than one nobody could read.
 */
export async function expandShortLinks(
  text: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  if (!text) return text;

  // Only the short hosts: a long google.com/maps URL already carries its
  // coordinates, and fetching it would buy nothing.
  const shorteners = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl|g\.co)\/[^\s<>"']+/gi;
  const links = [...new Set(text.match(shorteners) ?? [])];
  if (links.length === 0) return text;

  let expanded = text;
  // Two at most. A message with a wall of links is not somebody telling you
  // where they live, and each one is a request leaving the machine.
  for (const link of links.slice(0, 2)) {
    const resolved = await resolveShortLink(link, options.fetchImpl ?? fetch, options.timeoutMs);
    if (resolved) expanded = expanded.split(link).join(resolved);
  }
  return expanded;
}

/**
 * The whole thing, including following a short link.
 *
 * Kept for callers that are already asynchronous and have no edge to expand
 * at — the test suite, and anything run from the command line.
 */
export async function readLocationFrom(
  text: string,
  options: { near?: Coordinates | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LinkParse> {
  const direct = readLocationSync(text, options);
  if (direct.found) return direct;

  const expanded = await expandShortLinks(text, options);
  if (expanded === text) return direct;

  const second = readLocationSync(expanded, options);
  return second.found ? second : { found: false, reason: 'That link did not resolve to a place.' };
}

/**
 * Whether a resolved point is good enough to send somebody to on its own.
 *
 * Only a place or a plus code is. A viewport is the middle of a map view, and
 * a label with no number in it — "Timehri, Guyana" — is a town however precise
 * its coordinates look. Both are enough to decide which warehouse serves
 * somebody and not enough to knock on.
 */
export function isDoorstep(parse: LinkParse): boolean {
  if (!parse.found) return false;
  if (parse.precision === 'viewport') return false;
  // A locality: words, commas, and nothing that looks like a street number.
  if (parse.label && /^[^\d]+$/.test(parse.label) && parse.label.includes(',')) return false;
  return true;
}

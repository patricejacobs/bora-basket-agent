/**
 * "What does Georgetown to Mahaica pay?" — asked by the person driving it.
 *
 * An associate at a kerb is asked this by passengers all day, and until now
 * the only way to find out was to start a booking or ring somebody. The
 * tariff has had the answer the whole time; nothing let a driver ask it.
 *
 * The shape is the one a tired person types one-handed:
 *
 *     fare Georgetown to Mahaica
 *     fare gt to mahica          — aliases and near-misses, as everywhere
 *     fare Georgetown Mahaica    — `to` is optional
 *     fare Mahaica               — from where they are now
 *
 * It is a QUESTION, not a quote. Nothing is written down, no trip exists,
 * and the figure is the same one `book_taxi` would put in front of a
 * passenger — which is the whole point: a driver who has been told $2,500
 * at the kerb and a passenger who is shown $2,500 in the chat are not about
 * to have an argument.
 */
import * as repo from './db/repo.ts';
import { money } from './config.ts';
import { findZone, fareBetween } from './zones.ts';
import { nearestPlace } from './place-coords.ts';
import { waitingLine } from './taxi.ts';

const nl = String.fromCharCode(10);

/** `fare A to B`, `fare A B`, or `fare B` — or null when it is not one. */
export function readFareAsk(text: string): { from: string; to: string } | null {
  const said = String(text ?? '').trim();
  const opener = /^(?:fare|price|cost|how much)\s+(.+)$/i.exec(said);
  if (!opener) return null;

  const rest = opener[1]!.trim().replace(/\?+$/, '');
  if (!rest) return null;

  // The separator people actually type, including the arrow and the dash.
  const split = /\s+(?:to|->|→|–|—|-)\s+/i.exec(rest);
  if (split) {
    const from = rest.slice(0, split.index).trim();
    const to = rest.slice(split.index + split[0].length).trim();
    return from && to ? { from, to } : null;
  }

  // Two names with nothing between them: the tariff decides where the first
  // ends, by trying the longest first half that it knows.
  const words = rest.split(/\s+/);
  for (let cut = words.length - 1; cut >= 1; cut -= 1) {
    const from = words.slice(0, cut).join(' ');
    const to = words.slice(cut).join(' ');
    if (findZone(from).kind === 'found' && findZone(to).kind === 'found') return { from, to };
  }

  // One place: from wherever they are.
  return { from: '', to: rest };
}

/** Where the shop last saw them, for the one-place form. */
function whereTheyAre(phone: string): { place: string; how: string } {
  const pin = repo.getAssociateLocation(phone);
  if (pin) {
    const named = findZone(pin.label ?? '');
    if (named.kind === 'found') return { place: named.match.place, how: 'your last pin' };
    const near = nearestPlace({ latitude: pin.latitude, longitude: pin.longitude });
    if (near) return { place: near.place, how: 'your last pin' };
  }

  const base = repo.getAssociate(phone)?.basePlace ?? '';
  return base ? { place: base, how: 'your base' } : { place: '', how: '' };
}

/**
 * The answer, or a line saying plainly why there is not one.
 *
 * Never a shrug: a driver who asked a fair question and got "I don't know"
 * will not ask twice, and the next passenger gets a number somebody made up.
 */
export function answerFareAsk(phone: string, ask: { from: string; to: string }): string {
  const standing = ask.from ? { place: ask.from, how: '' } : whereTheyAre(phone);

  if (!standing.place) {
    return [
      '🚕 I do not know where you are, so I cannot price from here.',
      '',
      'Send your pin, or ask with both ends — *fare Georgetown to Mahaica*.',
    ].join(nl);
  }

  const from = findZone(standing.place);
  const to = findZone(ask.to);

  // A name that means two places. Both are named with their own figures:
  // "Golden Grove" is a real question and the two answers are different
  // money, so picking one quietly would send somebody to a kerb with the
  // wrong number.
  for (const [lookup, said] of [
    [from, standing.place],
    [to, ask.to],
  ] as const) {
    if (lookup.kind !== 'ambiguous') continue;
    const other = lookup === from ? to : from;
    const otherName = other.kind === 'found' ? other.match.place : '';
    return [
      `🚕 *${said}* is more than one place. Which one?`,
      '',
      ...lookup.candidates.map((c) => {
        const each = otherName
          ? fareBetween(lookup === from ? c.place : otherName, lookup === from ? otherName : c.place)
          : null;
        return `• ${c.place}${each ? ` — *${money(each.fee)}*` : ''}`;
      }),
      '',
      'Ask again with the full name.',
    ].join(nl);
  }

  // Which end is the problem, said as such. "Not in the tariff" about a
  // trip with two ends in it is a riddle.
  if (from.kind !== 'found' || to.kind !== 'found') {
    const missing = [
      from.kind !== 'found' ? standing.place : '',
      to.kind !== 'found' ? ask.to : '',
    ].filter(Boolean);
    return [
      `🚕 The tariff does not carry ${missing.map((m) => `*${m}*`).join(' or ')}.`,
      '',
      'Agree that one with the passenger. Everything it does carry is priced both ways.',
    ].join(nl);
  }

  const fromPlace = from.match.place;
  const toPlace = to.match.place;

  const fare = fareBetween(fromPlace, toPlace);
  if (!fare) {
    return [`🚕 *${fromPlace} → ${toPlace}* is not priced.`, '', 'Agree it with the passenger.'].join(nl);
  }

  const waiting = waitingLine();
  return [
    `🚕 *${fromPlace} → ${toPlace}*: *${money(fare.fee)}*`,
    // Which way round it was read, when the shop filled in an end itself or
    // corrected a spelling. A driver reading back "$2,500" to a passenger
    // should know it was Georgetown the shop priced, not Georgetown Park.
    ...(standing.how ? [`From ${fromPlace} — ${standing.how}.`] : []),
    ...(fare.explanation && fare.explanation !== `${fromPlace} to ${toPlace}`
      ? [fare.explanation]
      : []),
    ...(waiting ? ['', waiting] : []),
  ].join(nl);
}

/** The whole thing: null when the message was not a fare question. */
export function fareAnswerFor(phone: string, text: string): string | null {
  const ask = readFareAsk(text);
  return ask ? answerFareAsk(phone, ask) : null;
}

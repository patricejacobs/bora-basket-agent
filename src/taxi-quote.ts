/**
 * What a trip costs, asked before anybody books it.
 *
 * A passenger asking "how much to Timehri?" used to be asked to book first.
 * The fare belonged to `book_taxi`, and the agent was told — rightly — never
 * to say a figure of its own: the number decides money, names repeat across
 * the country, and the model does not hold the tariff. That reasoning was
 * sound and its conclusion was not. The answer was never the model's to
 * invent, but it was always the base's to give, and somebody who has to
 * commit to a car to find out what it costs is being asked to trust a
 * figure they cannot see.
 *
 * So the same tariff that prices a booking prices a question, and the words
 * are the base's own fixed strings rather than the model's paraphrase of a
 * number it was shown.
 *
 * Both ends are required. The associate's `fare` command fills a missing
 * pickup from where they are standing, which is right for somebody holding
 * a telephone at a kerb; a customer's saved village is where their shopping
 * goes, and guessing a trip starts there would quote one journey and sell
 * another.
 */
import { findZone, fareBetween } from './zones.ts';
import { money } from './config.ts';
import { t, type Language } from './language.ts';

const nl = String.fromCharCode(10);

export type TripQuote =
  /** Both ends in the tariff, and a figure between them. */
  | { kind: 'priced'; from: string; to: string; fee: number }
  /** Both ends known, no fare set for the pair. */
  | { kind: 'unpriced'; from: string; to: string }
  /** One end is a name that means more than one place. */
  | { kind: 'which'; said: string; candidates: { place: string; fee: number | null }[] }
  /** One or both ends are not in the tariff at all. */
  | { kind: 'unknown'; missing: string[] }
  /** They named one end and the other is still missing. */
  | { kind: 'need_end'; end: 'from' | 'to' };

/**
 * Reads a trip and prices it, or says precisely what is in the way.
 *
 * The order of the checks matters. An ambiguous name is reported before a
 * missing one, because "Golden Grove is two places" is answerable and "the
 * tariff does not carry it" would be false.
 */
export function quoteTrip(fromText: string, toText: string): TripQuote {
  const said = {
    from: String(fromText ?? '').trim(),
    to: String(toText ?? '').trim(),
  };
  if (!said.from) return { kind: 'need_end', end: 'from' };
  if (!said.to) return { kind: 'need_end', end: 'to' };

  const from = findZone(said.from);
  const to = findZone(said.to);

  // A name that means two places is a real question, and the two answers
  // are different money. Each candidate is priced against the end that IS
  // known, so the customer picks between figures rather than between names.
  for (const [lookup, written] of [
    [from, said.from],
    [to, said.to],
  ] as const) {
    if (lookup.kind !== 'ambiguous') continue;
    const other = lookup === from ? to : from;
    const otherName = other.kind === 'found' ? other.match.place : '';
    return {
      kind: 'which',
      said: written,
      candidates: lookup.candidates.map((c) => ({
        place: c.place,
        fee: otherName
          ? (fareBetween(
              lookup === from ? c.place : otherName,
              lookup === from ? otherName : c.place,
            )?.fee ?? null)
          : null,
      })),
    };
  }

  // Which end is the problem, said as such. "Not in the tariff" about a
  // trip with two ends in it is a riddle.
  if (from.kind !== 'found' || to.kind !== 'found') {
    return {
      kind: 'unknown',
      missing: [
        from.kind !== 'found' ? said.from : '',
        to.kind !== 'found' ? said.to : '',
      ].filter(Boolean),
    };
  }

  const fromPlace = from.match.place;
  const toPlace = to.match.place;
  const fare = fareBetween(fromPlace, toPlace);
  if (!fare) return { kind: 'unpriced', from: fromPlace, to: toPlace };

  return { kind: 'priced', from: fromPlace, to: toPlace, fee: fare.fee };
}

/**
 * The words the base says about it.
 *
 * A figure with no judgement in it is a fixed string from the base, not
 * model prose: the places are named back as the tariff spells them, so a
 * customer who meant the other Golden Grove can see that it was not the one
 * priced.
 */
export function quoteMessage(quote: TripQuote, lang: Language = 'en'): string {
  switch (quote.kind) {
    case 'priced':
      return t('fare_quote', lang, {
        from: quote.from,
        to: quote.to,
        fare: money(quote.fee),
        nl,
      });

    case 'unpriced':
      return t('fare_quote_unpriced', lang, { from: quote.from, to: quote.to });

    case 'which':
      return t('fare_quote_which', lang, {
        nl,
        said: quote.said,
        options: quote.candidates
          .map((c) => `• ${c.place}${c.fee === null ? '' : ` — *${money(c.fee)}*`}`)
          .join(nl),
      });

    case 'unknown':
      return t('fare_quote_unknown', lang, {
        missing: quote.missing.map((m) => `*${m}*`).join(' or '),
      });

    case 'need_end':
      return t(quote.end === 'from' ? 'fare_quote_need_from' : 'fare_quote_need_to', lang);
  }
}

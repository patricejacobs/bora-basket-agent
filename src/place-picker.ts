/**
 * The taxi place picker: two ends chosen by tapping, not typing.
 *
 * WHAT THIS REPLACES, AND WHAT IT DOES NOT. A village name is enough to PRICE
 * a trip. It is not enough to FIND anybody — "Diamond" sets the fare and does
 * not say which gate. So the picker answers the pricing question only, and the
 * pin and the typed address stay exactly where they were: on every screen, and
 * never paged away. A passenger going somewhere the tariff has never heard of
 * must still be able to book a car.
 *
 * WHY IT IS HERE AND NOT IN A TOOL. Same reason the service menu is fixed text
 * in services.ts: a tapped row is structured data, and routing it through a
 * language model only adds a chance of it coming back as a different place. A
 * model asked to "always send the picker" will one day send something else,
 * and a picker that is sometimes there is worse than none. The taps are read
 * here, before the agent runs, and the agent is told what was chosen.
 *
 * THE SHAPE OF THE PROBLEM. WhatsApp allows ten rows in a list. The tariff
 * holds about 185 places on five corridors, Georgetown alone some 45. So the
 * picker gets from 185 to 10 twice: corridor first, then the places on it,
 * nine at a time.
 *
 * HOW A PAGE IS ORDERED. By fare from the pickup, cheapest first — which is
 * nearest first in the only sense a passenger cares about. It needs no trading
 * history, so it is right on the first day, and it puts the right places on
 * page one: from Diamond you get Farm and Great Diamond, where ordering by
 * distance from town would have given you Agricola and McDoom. Alphabetical is
 * the one ordering to avoid; it puts Agricola on page one of every corridor it
 * touches whether anybody goes there or not.
 */
import { config, money } from './config.ts';
import { t, type Language } from './language.ts';
import * as repo from './db/repo.ts';
import { corridors, placesIn, fareBetween, findZone } from './zones.ts';
import type { OutboundMessage } from './channels/types.ts';

/**
 * Places on one page of a corridor.
 *
 * Eight, not nine, because "Type the address" has to survive to the bottom of
 * every page. Ten rows, less one for typing and one for "More…", leaves eight
 * — and a page that pushed typing off the end would be the picker becoming a
 * gate, which is the one thing it must never be. The last page has no "More…"
 * and so may show nine; the offsets still step by eight, which is why a short
 * final page never overlaps the one before it.
 */
const PER_PAGE = 8;

/** WhatsApp's own ceiling on a list. */
const MAX_ROWS = 10;

/**
 * Every row id this module issues begins here.
 *
 * A tapped row arrives from WhatsApp carrying both its title and its id. The
 * title is the answer for most lists in this shop — a rating row's title is a
 * run of stars, and that IS the rating — so the id is only read when it is one
 * of ours. `isPickerId` is that guard, and it is why the ratings list is
 * untouched by any of this.
 */
const PREFIX = 'pick';

export type PickSide = 'from' | 'to';

export type Pick =
  | { kind: 'here'; side: PickSide }
  | { kind: 'type'; side: PickSide }
  | { kind: 'place'; side: PickSide; place: string }
  | { kind: 'corridor'; side: PickSide; corridor: string; page: number }
  | { kind: 'fare'; answer: 'book' | 'change' | 'cancel' };

/** True when this is one of our row ids rather than somebody else's. */
export function isPickerId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(`${PREFIX}:`);
}

/**
 * Reads a tapped row.
 *
 * Returns null for anything unrecognised rather than guessing. A tap on a list
 * sent before a deploy can arrive after it, and a half-understood id must not
 * book a trip to the wrong place.
 */
export function readPick(id: string): Pick | null {
  if (!isPickerId(id)) return null;
  const parts = id.split(':');

  // The fare's three answers. Not a side of the journey, so it is read before
  // the side is insisted on.
  if (parts[1] === 'fare') {
    const answer = parts[2] ?? '';
    if (answer === 'book' || answer === 'change' || answer === 'cancel') {
      return { kind: 'fare', answer };
    }
    return null;
  }

  const side = parts[1] === 'to' ? 'to' : parts[1] === 'from' ? 'from' : null;
  if (!side) return null;

  const kind = parts[2] ?? '';
  if (kind === 'here') return { kind: 'here', side };
  if (kind === 'type') return { kind: 'type', side };
  if (kind === 'place') {
    // The place itself may hold anything but a colon, so it is the whole rest
    // of the id rather than the next field: "Vryheid's Lust" survives, and so
    // would a name with a comma in it.
    const place = parts.slice(3).join(':').trim();
    return place ? { kind: 'place', side, place } : null;
  }
  if (kind === 'corr') {
    const page = Number(parts[3]);
    const corridor = parts.slice(4).join(':').trim();
    if (!corridor || !Number.isInteger(page) || page < 0) return null;
    return { kind: 'corridor', side, corridor, page };
  }
  return null;
}

const placeRow = (side: PickSide, place: string, description?: string) => ({
  id: `${PREFIX}:${side}:place:${place}`,
  // WhatsApp truncates a row title at 24 characters anyway; doing it here
  // keeps what the customer reads and what the log records the same thing.
  title: place.slice(0, 24),
  ...(description ? { description } : {}),
});

const corridorRow = (side: PickSide, corridor: string, page = 0) => ({
  id: `${PREFIX}:${side}:corr:${page}:${corridor}`,
  title: corridor.slice(0, 24),
});

/**
 * The first screen for one end of the journey.
 *
 * Ordered by how likely it is to end the question. Where I am now, then the
 * address the shop already holds, then places this passenger has used before,
 * and only then the five corridors. Most pickups never open a second list.
 */
export function endPicker(phone: string, side: PickSide, lang: Language = 'en'): OutboundMessage {
  const rows: { id: string; title: string; description?: string }[] = [];

  // Only for a pickup. Nobody shares a pin for where they are going, and a
  // row that cannot be meant is a row in the way.
  if (side === 'from') {
    rows.push({
      id: `${PREFIX}:from:here`,
      title: t('pick_here', lang),
      description: t('pick_here_hint', lang),
    });
  }

  const saved = repo.getIdentity(phone).address?.trim() ?? '';
  // Only when the tariff can price it. An address the picker cannot turn into
  // a fare is not a shortcut, it is the typed path wearing a row's clothes.
  const savedZone = saved ? findZone(saved) : null;
  if (savedZone?.kind === 'found') {
    rows.push(placeRow(side, savedZone.match.place, t('pick_saved', lang)));
  }

  for (const place of repo.recentTaxiPlaces(phone, 2)) {
    const found = findZone(place);
    if (found.kind !== 'found') continue;
    if (rows.some((r) => r.title === found.match.place.slice(0, 24))) continue;
    rows.push(placeRow(side, found.match.place, t('pick_recent', lang)));
  }

  // The corridors fill whatever is left, with one row kept back for typing.
  // In practice there is always room: the most that can be above them is a
  // location row, a saved address and two recents.
  for (const corridor of corridors()) {
    if (rows.length >= MAX_ROWS - 1) break;
    rows.push(corridorRow(side, corridor));
  }

  rows.push({ id: `${PREFIX}:${side}:type`, title: t('pick_type', lang) });

  return {
    kind: 'list',
    text: side === 'from' ? t('pick_from_ask', lang) : t('pick_to_ask', lang),
    button: t('pick_button', lang),
    rows: rows.slice(0, MAX_ROWS),
  };
}

/**
 * One page of a corridor, priced against the pickup.
 *
 * The fare on every row is the whole point: a passenger choosing a
 * destination is choosing a price, and making them pick first and learn the
 * cost afterwards is how a shop gets arguments. Where no pickup is known yet
 * the rows carry the tariff's own figure instead, which is what a delivery to
 * that place costs and the right answer when the trip starts in town.
 */
export function corridorPicker(
  phone: string,
  side: PickSide,
  corridor: string,
  page: number,
  lang: Language = 'en',
): OutboundMessage | null {
  const from = side === 'to' ? repo.taxiPicks(phone).from : '';

  const priced = placesIn(corridor)
    .map((z) => {
      const fare = from ? (fareBetween(from, z.place)?.fee ?? null) : z.fee;
      return { place: z.place, fare };
    })
    // The pickup itself is not a destination.
    .filter((r) => r.place.toLowerCase() !== from.toLowerCase());

  // Cheapest first, then by name so the order never wobbles between two
  // places that cost the same. A row the tariff could not price sorts last
  // rather than being dropped — it is still somewhere a passenger may be
  // going, and the driver settles that fare in the car.
  priced.sort(
    (a, b) => (a.fare ?? Infinity) - (b.fare ?? Infinity) || a.place.localeCompare(b.place),
  );

  const start = page * PER_PAGE;
  const left = priced.length - start;
  if (left <= 0) return null;

  // Everything that is left, when it fits beside the typing row. Otherwise a
  // page of eight with "More…" after it.
  const take = left <= MAX_ROWS - 1 ? MAX_ROWS - 1 : PER_PAGE;
  const slice = priced.slice(start, start + take);

  const rows = slice.map((r) =>
    placeRow(side, r.place, r.fare === null ? t('pick_fare_unknown', lang) : money(r.fare)),
  );

  if (left > take) {
    // The same id a corridor row carries, one page on — but it has to READ as
    // more, not as the corridor over again.
    rows.push({ ...corridorRow(side, corridor, page + 1), title: t('pick_more', lang) });
  }

  // Last, and on every page. See PER_PAGE.
  rows.push({ id: `${PREFIX}:${side}:type`, title: t('pick_type', lang) });

  return {
    kind: 'list',
    text: t('pick_corridor_ask', lang, { corridor }),
    button: t('pick_button', lang),
    rows: rows.slice(0, MAX_ROWS),
  };
}

/**
 * The fare, and the three things a passenger can do about it.
 *
 * Three answers, which is exactly WhatsApp's limit on buttons — and the
 * reason this is buttons rather than a question in words. "Is that fare all
 * right?" has two answers and leaves the third, the commonest one, unsaid:
 * somebody who balks at a figure usually wants a different destination, not
 * no taxi at all. A yes/no makes them type their way back to a list they have
 * already used.
 *
 * It is built here and not by the model because it is a gate. The fare has to
 * be seen and answered before a car is dispatched, and a gate a language
 * model is asked to hold is a gate that one day swings open.
 */
export function fareButtons(fare: string, lang: Language = 'en'): OutboundMessage {
  return {
    kind: 'buttons',
    text: t('taxi_fare_quoted', lang, { fare }),
    buttons: [
      { id: `${PREFIX}:fare:book`, title: t('fare_book', lang) },
      { id: `${PREFIX}:fare:change`, title: t('fare_change', lang) },
      { id: `${PREFIX}:fare:cancel`, title: t('fare_cancel', lang) },
    ],
  };
}

/** What a tap did, for the caller to act on. */
export type PickResult =
  /** Send these and stop; the agent is not involved. */
  | { kind: 'reply'; outbound: OutboundMessage[] }
  /** Hand this to the agent in place of the customer's words. */
  | { kind: 'note'; note: string }
  /** The passenger called it off. Clear the service and show the menu. */
  | { kind: 'cancelled'; outbound: OutboundMessage[] };

/**
 * Acts on a tapped row.
 *
 * Everything that is still part of choosing a place is answered here with the
 * next screen. Only a finished choice, or a passenger stepping out of the
 * picker, reaches the agent — and then as a note saying plainly what happened,
 * because a tap has no words of its own.
 */
export function handlePick(phone: string, id: string, lang: Language = 'en'): PickResult | null {
  const pick = readPick(id);
  if (!pick) return null;

  if (pick.kind === 'fare') {
    if (pick.answer === 'cancel') {
      // Both ends and both pins, because a passenger who called this off is
      // not half way through anything any more.
      repo.clearTaxiPicks(phone);
      repo.clearParcelDraft(phone);
      return {
        kind: 'cancelled',
        outbound: [{ kind: 'text', text: t('taxi_cancelled', lang) }],
      };
    }

    if (pick.answer === 'change') {
      // The destination only. Where they are being collected from has not
      // changed, and asking it again would be the picker wasting their time
      // over a figure they did not like.
      repo.setTaxiPick(phone, 'to', '');
      return { kind: 'reply', outbound: [endPicker(phone, 'to', lang)] };
    }

    return {
      kind: 'note',
      note: '[The passenger tapped *Book it*: they have seen the fare and agreed it. Call book_taxi again with the same details and fare_confirmed true. Do not quote the fare again and do not ask whether it is all right — they have already answered that.]',
    };
  }

  if (pick.kind === 'here') {
    return {
      kind: 'reply',
      outbound: [{ kind: 'location_request', text: t('pick_here_prompt', lang) }],
    };
  }

  if (pick.kind === 'type') {
    return {
      kind: 'note',
      note:
        pick.side === 'from'
          ? '[The passenger tapped "Type the address" for the pickup. Ask for it in words. Do not send the picker again.]'
          : '[The passenger tapped "Type the address" for the destination. Ask for it in words. Do not send the picker again.]',
    };
  }

  if (pick.kind === 'corridor') {
    const screen = corridorPicker(phone, pick.side, pick.corridor, pick.page, lang);
    // A corridor with nothing left to show is a tap on a stale list. Start
    // that end again rather than answering with an empty sheet.
    return { kind: 'reply', outbound: [screen ?? endPicker(phone, pick.side, lang)] };
  }

  repo.setTaxiPick(phone, pick.side, pick.place);

  if (pick.side === 'from') {
    return { kind: 'reply', outbound: [endPicker(phone, 'to', lang)] };
  }

  const picks = repo.taxiPicks(phone);
  const fare = picks.from ? fareBetween(picks.from, picks.to) : null;

  // The note tells the agent what it would otherwise have to guess, including
  // the fare — so it reads back a figure this module worked out rather than
  // one it invented. It still has to call book_taxi to get the fare properly
  // and book anything; nothing here books a car.
  return {
    kind: 'note',
    note: [
      `[The passenger chose their trip from the place picker: pickup *${picks.from}*, destination *${picks.to}*.`,
      fare
        ? `The tariff prices that at ${money(fare.fee)}.`
        : 'The tariff cannot price that pair, so the driver will agree the fare.',
      'Ask how many are travelling and anything the driver should know, then call book_taxi with',
      `pickup_address "${picks.from}" and destination_address "${picks.to}" exactly as written here.`,
      'Quote the fare and get a yes before booking, as always.]',
    ].join(' '),
  };
}

/**
 * Whether this conversation should be shown the picker at all.
 *
 * Only for taxis, and only while the shop has a tariff to pick from. A shop
 * running on the flat fee has no places to list, and an empty picker is worse
 * than the question it replaced.
 */
export function pickerAvailable(): boolean {
  return corridors().length > 0 && Boolean(config.store.zonesPath);
}

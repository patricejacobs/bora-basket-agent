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
 * Six, because four rows have to survive to the bottom of every page: the
 * pin, "More…", "Type the address" and the way back. Ten rows less those
 * four leaves six. A page that pushed any of them off the end would be the
 * picker becoming a gate, which is the one thing it must never be.
 *
 * It was seven until the pin went on these pages too. That costs a page on
 * the longer corridors — the East Coast runs to nine rather than eight —
 * which is the trade: somebody whose destination has no name in the tariff
 * can now say where it is from any screen, instead of having to find their
 * way back to the areas first.
 *
 * The last page has no "More…" and so may show seven; the offsets still step
 * by six, which is why a short final page never overlaps the one before it.
 */
const PER_PAGE = 6;

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
  | { kind: 'menu'; side: PickSide }
  | { kind: 'back'; side: PickSide }
  | { kind: 'list'; side: PickSide }
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
  if (kind === 'menu') return { kind: 'menu', side };
  if (kind === 'back') return { kind: 'back', side };
  if (kind === 'list') return { kind: 'list', side };
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

/**
 * The two rows that end every picker screen, in this order.
 *
 * Typing, so somebody going where the tariff has never heard of can still
 * book; and the way out, so nobody is ever stuck in a list. Neither is ever
 * paged away — see PER_PAGE, which is seven so that these two and "More…"
 * all fit under WhatsApp's ten.
 */
/**
 * The pin row, worded for the end it is asking about.
 *
 * On both screens of both ends now. It was the first screen only, which
 * meant somebody three pages into a corridor, looking for a gate the tariff
 * has no name for, had to find their way back to the areas before they could
 * say where it was.
 */
const pinRow = (side: PickSide, lang: Language) =>
  side === 'from'
    ? {
        id: `${PREFIX}:from:here`,
        title: t('pick_here', lang),
        description: t('pick_here_hint', lang),
      }
    : {
        id: `${PREFIX}:to:here`,
        title: t('pick_pin', lang),
        description: t('pick_pin_hint', lang),
      };

const wayOutRows = (side: PickSide, lang: Language, within: 'corridor' | 'top' = 'top') => [
  // The description is the instruction: it says WHY you would tap this, and
  // it is read before anybody is stuck rather than after.
  {
    id: `${PREFIX}:${side}:type`,
    title: t('pick_type', lang),
    description: t('pick_type_hint', lang),
  },
  // Where the row sits matters more than where it goes.
  //
  // Deep in a corridor the useful move is one step back to the list of
  // areas: picking the wrong road then costs a tap to undo rather than the
  // whole booking, and the front door is still one tap further on from
  // there. On the first screen there is nowhere back to go, so that row IS
  // the way out of the service.
  within === 'corridor'
    ? { id: `${PREFIX}:${side}:back`, title: t('pick_back', lang) }
    : { id: `${PREFIX}:${side}:menu`, title: t('pick_menu', lang) },
];

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

  // A pin, offered at both ends but worded for each.
  //
  // It used to be the pickup only, on the reasoning that nobody shares a pin
  // for where they are GOING. That was too narrow: WhatsApp's attachment
  // lets you search a place and send its pin, which is exactly how somebody
  // specifies a hotel, an office or a gate the tariff has no name for.
  rows.push(pinRow(side, lang));

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

  // The corridors fill whatever is left, with two rows kept back for the way
  // out. In practice there is always room: the most that can be above them is
  // a location row, a saved address and two recents.
  for (const corridor of corridors()) {
    if (rows.length >= MAX_ROWS - 2) break;
    rows.push(corridorRow(side, corridor));
  }

  rows.push(...wayOutRows(side, lang));

  return {
    kind: 'list',
    text: side === 'from' ? t('pick_from_ask', lang) : t('pick_to_ask', lang),
    button: t('pick_button', lang),
    rows: rows.slice(0, MAX_ROWS),
  };
}

/**
 * The question that opens an end, as two buttons rather than a list.
 *
 * Both ways of answering are now visible without opening anything. Sending a
 * location was always offered — as the first ROW of a list whose button read
 * "Choose a place", so you had to open the place picker to discover you
 * needn't use it. A passenger standing on a road with a phone in their hand
 * is the likeliest person in the shop to want that row and the least likely
 * to go looking for it.
 *
 * It costs a tap for whoever does want the list. That is the trade: one more
 * tap on the path people can already see, against making the other path
 * visible at all.
 */
export function openEnd(side: PickSide, lang: Language = 'en'): OutboundMessage {
  return {
    kind: 'buttons',
    text: t(side === 'from' ? 'pick_from_ask' : 'pick_to_ask', lang),
    buttons: [
      { id: `${PREFIX}:${side}:list`, title: t('pick_button', lang) },
      {
        id: `${PREFIX}:${side}:here`,
        // Worded for the end being asked about, and kept short: a button
        // title is twenty characters and WhatsApp truncates in silence.
        title: t(side === 'from' ? 'pick_send_location' : 'pick_send_pin', lang),
      },
    ],
  };
}

/**
 * The areas alone, for a pin the tariff cannot price.
 *
 * A pin says where to stop; it does not say what the trip costs. WhatsApp
 * sends a name and address when somebody shares a PLACE — "Ogle Airport,
 * Ogle" prices perfectly — but a live position carries no name at all, and
 * the tariff is a list of place names with no coordinates anywhere in it. So
 * a bare pin used to book a car with no fare, which is the quiet failure the
 * fare gate exists to prevent.
 *
 * The pin is kept, because it is the best thing the driver will get. This
 * asks the one question that turns it into a price. No pin row and no saved
 * addresses: they have just given their location, and the only thing missing
 * is which area it is in.
 */
export function areaPicker(side: PickSide, lang: Language = 'en'): OutboundMessage {
  const rows = corridors()
    .slice(0, MAX_ROWS - 3)
    .map((corridor) => corridorRow(side, corridor));

  // The pin row stays. It was left off on the reasoning that somebody who has
  // just shared their location does not need to be asked for one — true of
  // the pin they sent, and wrong about the next one. A passenger whose first
  // pin landed on the wrong spot, or who pinned one end and now wants to pin
  // the other, had nothing on this screen but a list of areas.
  rows.push(pinRow(side, lang));
  rows.push(...wayOutRows(side, lang));

  return {
    kind: 'list',
    // Which end is being asked about, said out loud. "Which area is that"
    // reads as the destination question to somebody who has just pinned
    // their pickup, and they answer it with where they are going.
    text: t(side === 'from' ? 'pick_area_from' : 'pick_area_to', lang),
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

  // Everything that is left, when it fits beside the pin and the two way-out
  // rows. Otherwise a page of six with "More…" after it.
  const take = left <= MAX_ROWS - 3 ? MAX_ROWS - 3 : PER_PAGE;
  const slice = priced.slice(start, start + take);

  const rows = slice.map((r) =>
    placeRow(side, r.place, r.fare === null ? t('pick_fare_unknown', lang) : money(r.fare)),
  );

  if (left > take) {
    // The same id a corridor row carries, one page on — but it has to READ as
    // more, not as the corridor over again.
    //
    // And it says HOW MUCH more. "More…" on its own tells a passenger
    // nothing: the East Coast runs to eight pages, so somebody heading for
    // Belfield taps it five times without ever being told that is what they
    // are in for. The count is the instruction, and it is honest about the
    // length — seeing "45 more places" is what tells somebody far out to
    // type the address instead.
    rows.push({
      ...corridorRow(side, corridor, page + 1),
      title: t('pick_more', lang),
      description: t('pick_more_hint', lang, { n: String(left - take) }),
    });
  }

  // Last, and on every page. See PER_PAGE.
  rows.push(pinRow(side, lang));
  rows.push(...wayOutRows(side, lang, 'corridor'));

  return {
    kind: 'list',
    // The question, then one line saying how the list works. Said once, where
    // the eye already is, and only on a page that HAS more behind it — a
    // corridor that fits on one screen has nothing to explain.
    text:
      left > take
        ? `${t('pick_corridor_ask', lang, { corridor })}
${t('pick_corridor_help', lang)}`
        : t('pick_corridor_ask', lang, { corridor }),
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

/**
 * What the booking needs next, once an end has just been settled.
 *
 * ONE place decides it, because the order matters and used to be spread
 * across the callers. A pin with no name had the area asked the moment it
 * arrived — so pinning your pickup on a map was answered with "which area is
 * that?" instead of "where are you going?", which is not what somebody
 * booking a car is thinking about and was read as the destination question.
 *
 * Both ends first, then the price. An end is SETTLED when the shop knows
 * where it is — tapped off the tariff or pinned on a map — and PRICEABLE
 * only when it has a name the tariff carries. So the journey is collected
 * first, and anything that cannot be priced is asked about last, one end at
 * a time, immediately before the fare that needs it.
 *
 * The gate is unchanged: nothing is quoted or booked while an end has no
 * price. The question only moved to where it belongs.
 */
export function nextStep(
  phone: string,
  lang: Language = 'en',
): Extract<PickResult, { kind: 'reply' } | { kind: 'note' }> {
  const picks = repo.taxiPicks(phone);
  const pins = repo.getParcelDraft(phone);

  if (!picks.from && !pins.pickup) return { kind: 'reply', outbound: [openEnd('from', lang)] };
  if (!picks.to && !pins.destination) return { kind: 'reply', outbound: [openEnd('to', lang)] };

  // Both ends known. Now the ones the tariff cannot price.
  if (!picks.from) return { kind: 'reply', outbound: [areaPicker('from', lang)] };
  if (!picks.to) return { kind: 'reply', outbound: [areaPicker('to', lang)] };

  const fare = fareBetween(picks.from, picks.to);
  return {
    kind: 'note',
    note: [
      `[The passenger has given both ends of the trip: pickup *${picks.from}*, destination *${picks.to}*.`,
      fare
        ? `The tariff prices that at ${money(fare.fee)}.`
        : 'The tariff cannot price that pair, so the driver will agree the fare.',
      'Ask how many are travelling and anything the driver should know, then call book_taxi with',
      `pickup_address "${picks.from}" and destination_address "${picks.to}" exactly as written here.`,
      'Quote the fare and get a yes before booking, as always.]',
    ].join(' '),
  };
}

/** What a tap did, for the caller to act on. */
export type PickResult =
  /** Send these and stop; the agent is not involved. */
  | { kind: 'reply'; outbound: OutboundMessage[] }
  /** Hand this to the agent in place of the customer's words. */
  | { kind: 'note'; note: string }
  /** The passenger called it off. Clear the service and show the menu. */
  | { kind: 'cancelled'; outbound: OutboundMessage[] }
  /** They want the service menu. Clear the trip and send it. */
  | { kind: 'menu' };

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
      return { kind: 'reply', outbound: [openEnd('to', lang)] };
    }

    return {
      kind: 'note',
      note: '[The passenger tapped *Book it*: they have seen the fare and agreed it. Call book_taxi again with the same details and fare_confirmed true. Do not quote the fare again and do not ask whether it is all right — they have already answered that.]',
    };
  }

  if (pick.kind === 'list') {
    return { kind: 'reply', outbound: [endPicker(phone, pick.side, lang)] };
  }

  if (pick.kind === 'back') {
    // One step, not all the way out: the end they are choosing starts again
    // and the other end stays exactly where they put it.
    return { kind: 'reply', outbound: [endPicker(phone, pick.side, lang)] };
  }

  if (pick.kind === 'menu') {
    // The trip goes with them. Somebody who has walked back to the front door
    // is not half way through choosing a car any more, and leaving a pickup
    // on file would have the next taxi start wherever this one was going to.
    repo.clearTaxiPicks(phone);
    repo.clearParcelDraft(phone);
    return { kind: 'menu' };
  }

  if (pick.kind === 'here') {
    return {
      kind: 'reply',
      outbound: [
        {
          kind: 'location_request',
          text: t(pick.side === 'from' ? 'pick_here_prompt' : 'pick_pin_prompt', lang),
        },
      ],
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
  return nextStep(phone, lang);
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

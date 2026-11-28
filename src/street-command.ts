/**
 * Teaching the shop a street, and reading back what it does not know.
 *
 * The shop learns streets from finished deliveries and from the map, and
 * both are slow: a delivery has to happen, and the map has what the map
 * has — Garnet Street is not in it at all. Meanwhile an associate who has
 * driven Georgetown for years knows exactly where it is.
 *
 *     street Garnet Street = Kitty     teaches it, at once
 *     street Garnet Street             what the shop has
 *     streets                          what it has been asked and cannot place
 *
 * The last one is the point of the other two. A street nobody could place
 * used to become a question and vanish; kept, the misses are a worklist of
 * exactly the streets customers ask for, and the first command fixes them
 * one message at a time.
 */
import * as repo from './db/repo.ts';
import { findZone } from './zones.ts';
import { streetKey } from './street-memory.ts';

const nl = String.fromCharCode(10);

export type StreetCommand =
  | { kind: 'teach'; street: string; place: string }
  | { kind: 'lookup'; street: string }
  | { kind: 'misses' };

/** Reads one of the three, or null when it is not one of them. */
export function readStreetCommand(text: string): StreetCommand | null {
  const said = String(text ?? '').trim();

  if (/^streets?\s*$/i.test(said) || /^(street\s+)?misses\s*$/i.test(said)) {
    return { kind: 'misses' };
  }

  const opener = /^street\s+(.+)$/i.exec(said);
  if (!opener) return null;

  const rest = opener[1]!.trim();
  // "= Kitty", "is Kitty", "in Kitty" — the three ways somebody writes it.
  const taught = /^(.+?)\s*(?:=|\bis\b|\bin\b)\s*(.+)$/i.exec(rest);
  if (taught) {
    const street = taught[1]!.trim();
    const place = taught[2]!.trim();
    if (street && place) return { kind: 'teach', street, place };
  }

  return { kind: 'lookup', street: rest };
}

/** Does it, and says what happened. */
export function answerStreetCommand(cmd: StreetCommand): string {
  if (cmd.kind === 'misses') {
    const missing = repo.streetsNobodyCanPlace(15);
    if (missing.length === 0) {
      return '🛣 Nothing outstanding — every street anybody has asked about is placed.';
    }
    return [
      `🛣 *${missing.length} street(s) the shop cannot place*`,
      '',
      ...missing.map(
        (m) => `• ${m.wrote || m.street} — asked ${m.asked} time${m.asked === 1 ? '' : 's'}`,
      ),
      '',
      'Teach one with `street Garnet Street = Kitty`.',
    ].join(nl);
  }

  if (cmd.kind === 'lookup') {
    const places = repo.areasForStreet(cmd.street);
    if (places.length === 0) {
      return [
        `🛣 The shop cannot place *${cmd.street}*.`,
        '',
        `Teach it with \`street ${cmd.street} = <the area>\`.`,
      ].join(nl);
    }
    return [
      `🛣 *${cmd.street}*`,
      '',
      ...places.map(
        (p) =>
          `• ${p.place}${p.seen > 0 ? ` — delivered ${p.seen} time${p.seen === 1 ? '' : 's'}` : ' — from the map'}`,
      ),
    ].join(nl);
  }

  // Teaching it. The place has to be one the tariff carries, or the shop
  // has learned something it cannot price from — which is the only reason
  // it wanted to know.
  const known = findZone(cmd.place);
  if (known.kind !== 'found') {
    return [
      `🛣 The tariff does not carry *${cmd.place}*, so a street there could not be priced.`,
      '',
      'Use the name as the tariff spells it.',
    ].join(nl);
  }

  const key = streetKey(cmd.street);
  if (!key) {
    return [
      `🛣 *${cmd.street}* is not a street name the shop can file.`,
      '',
      'It needs the kind of road in it — street, road, dam, scheme, avenue.',
    ].join(nl);
  }

  repo.rememberStreetArea(cmd.street, known.match.place);
  const now = repo.areasForStreet(cmd.street);

  return [
    `🛣 Noted — *${cmd.street}* is in *${known.match.place}*.`,
    ...(now.length > 1
      ? ['', `It is also on file for ${now.filter((p) => p.place !== known.match.place).map((p) => p.place).join(', ')}, so the shop will still ask which one.`]
      : ['', 'The shop will use it from now on.']),
  ].join(nl);
}

/** The whole thing: null when the message was not one of these. */
export function streetCommandFor(text: string): string | null {
  const cmd = readStreetCommand(text);
  return cmd ? answerStreetCommand(cmd) : null;
}

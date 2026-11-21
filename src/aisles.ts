/**
 * The grocery aisles, and the two ways out that stay on the screen.
 *
 * Choosing groceries used to open with a sentence — *"tell me what you need"*
 * — which is an invitation to somebody who already knows what they want and a
 * blank wall to somebody who does not. A shop's answer to "what do you
 * sell?" is its aisles, so that is what arrives: all of them, numbered, with
 * what is in each, and in plain words how to move around them.
 *
 * And two buttons that never go away. A customer three lists deep in a
 * conversation had no way back to the front of the shop except by typing
 * something and hoping — so every message the shop sends while they are
 * shopping carries *Categories* and *Leave groceries*, which is the one
 * thing a WhatsApp conversation cannot otherwise offer: a way out that is
 * always on screen.
 */
import * as repo from './db/repo.ts';
import { t, type Language } from './language.ts';
import { config, money } from './config.ts';
import type { OutboundMessage } from './channels/types.ts';

const nl = String.fromCharCode(10);

export const AISLE_BACK = 'aisle:categories';
export const AISLE_LEAVE = 'aisle:leave';
export const AISLE_BASKET = 'aisle:basket';
export const AISLE_CHECKOUT = 'aisle:checkout';

export function isAisleId(id: string): boolean {
  const said = String(id ?? '').trim();
  return (
    said === AISLE_BACK ||
    said === AISLE_LEAVE ||
    said === AISLE_BASKET ||
    said === AISLE_CHECKOUT
  );
}

/**
 * The way out, and the way back to the aisles.
 *
 * Both, except on the aisle list itself: a button that goes where you
 * already are is a button that does nothing, and the one thing somebody
 * standing at the front of the shop might want is the door.
 */
export function wayOutButtons(
  phone: string,
  lang: Language,
  { onTheAisleList = false, onTheBasket = false } = {},
): { id: string; title: string }[] {
  const leave = { id: AISLE_LEAVE, title: t('aisle_leave', lang) };
  const back = { id: AISLE_BACK, title: t('aisle_back', lang) };
  const cart = repo.getCart(phone);

  // Nothing in the basket: the two that were always there.
  if (cart.lines.length === 0) return onTheAisleList ? [leave] : [back, leave];

  // Something in it, and three buttons to fit four things into. The basket
  // carries its own total, so it is a figure AND a way in; checkout is the
  // thing they are here to do. What gives way is the button that would go
  // where they already are - Categories on the aisle list, the basket on
  // the basket - and Leave, which lives on the basket page and has always
  // answered to the word "menu" as well.
  const basket = {
    id: AISLE_BASKET,
    // The GOODS, not the total. `total` carries a delivery fee that nobody
    // has agreed to yet - the shop's flat rate, standing in until a zone is
    // settled - and a button that quotes it is quoting a figure the
    // customer has never been shown and may never be charged.
    title: t('aisle_basket', lang, { total: money(cart.subtotal) }).slice(0, 20),
  };
  const checkout = { id: AISLE_CHECKOUT, title: t('aisle_checkout', lang) };

  if (onTheBasket) return [checkout, back, leave];
  if (onTheAisleList) return [basket, checkout, leave];
  return [basket, checkout, back];
}

/**
 * The basket, as something to read and to change.
 *
 * Lettered like an aisle, and for the same reason: `a x2` is how the thing
 * got in, so `a x3` and `a x0` are how it changes and goes. Nothing new to
 * learn, and the letters are written down as the page is sent so the letter
 * they answer with is the line they were looking at.
 */
export function basketPage(phone: string, lang: Language = 'en'): OutboundMessage {
  const cart = repo.getCart(phone);
  if (cart.lines.length === 0) {
    return { kind: 'buttons', text: t('basket_empty', lang), buttons: wayOutButtons(phone, lang) };
  }

  repo.rememberNumberedList(
    phone,
    'product',
    cart.lines.map((l) => ({ value: l.product.sku, label: l.product.name })),
  );

  return {
    kind: 'buttons',
    text: [
      t('basket_head', lang),
      '',
      ...cart.lines.map(
        (l, i) =>
          `(${letterFor(i)}) ${l.qty} x ${l.product.name}` +
          `${l.optionsSummary ? ` — _${l.optionsSummary}_` : ''} — ${money(l.lineTotal)}`,
      ),
      '',
      t('basket_total', lang, { goods: money(cart.subtotal) }),
      '',
      t('basket_how', lang),
    ].join(nl),
    buttons: wayOutButtons(phone, lang, { onTheBasket: true }),
  };
}

/**
 * What stands between this basket and checkout, said to the customer.
 *
 * Empty when nothing does. The minimum used to be enforced only by
 * `place_order`, at the last tap of the sequence, so a basket under it was
 * taken through the place, the pin, the name and a price with *Book it* on
 * it and then refused - which a customer reads as the shop breaking rather
 * than as a rule they could have met by adding a tin of milk.
 */
export function cannotCheckOutYet(phone: string, lang: Language): string {
  const cart = repo.getCart(phone);
  if (cart.lines.length === 0) return t('basket_empty', lang);

  const least = cart.outlet && cart.outlet.minOrder > 0
    ? cart.outlet.minOrder
    : config.store.minOrderTotal;
  if (least <= 0 || cart.subtotal >= least) return '';

  return t('basket_minimum', lang, {
    goods: money(cart.subtotal),
    least: money(least),
    short: money(least - cart.subtotal),
  });
}

/** a, b, c … then aa, ab, for a basket nobody should have but might. */
function letterFor(i: number): string {
  return i < 26
    ? String.fromCharCode(97 + i)
    : `${String.fromCharCode(96 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
}

/**
 * Every aisle, numbered, with how to use them.
 *
 * The numbering is written down as it is sent, so the number a customer
 * answers with is the number the shop will resolve. A list renumbered in the
 * retelling sends somebody to the wrong aisle — which is the whole reason
 * this is built here and not asked of the model.
 */
export function aislesMessage(phone: string, lang: Language = 'en'): OutboundMessage {
  const shop = repo.defaultGrocery();
  const aisles = repo.listCategories(shop?.id ?? null);

  if (aisles.length === 0) {
    return { kind: 'text', text: t('aisles_empty', lang) };
  }

  repo.rememberNumberedList(
    phone,
    'category',
    aisles.map((a) => ({ value: a.category, label: a.category })),
  );

  return {
    kind: 'buttons',
    text: [
      t('aisles_head', lang, { n: String(aisles.length) }),
      '',
      ...aisles.map((a, i) => `${i + 1}. ${a.category} (${a.count})`),
      '',
      t('aisles_how', lang, { last: String(aisles.length), nl }),
    ].join(nl),
    buttons: wayOutButtons(phone, lang, { onTheAisleList: true }),
  };
}

/**
 * Puts the way out on a turn that has not got one.
 *
 * Only where there is nothing interactive already: a message that is itself
 * a list, or that is asking for a location, or that already carries its own
 * three answers, is a question being put — and hanging two more buttons off
 * it would make the answer ambiguous.
 *
 * The buttons go on the LAST text of the turn, because that is the message
 * left at the bottom of their screen, and a button higher up the chat is a
 * button nobody finds.
 */
export function withWayOut(
  phone: string,
  outbound: OutboundMessage[],
  lang: Language,
): OutboundMessage[] {
  if (outbound.some((m) => m.kind === 'buttons' || m.kind === 'list' || m.kind === 'location_request')) {
    return outbound;
  }

  const last = outbound.map((m) => m.kind).lastIndexOf('text');
  if (last === -1) return outbound;

  const said = outbound[last] as { kind: 'text'; text: string };
  return outbound.map((m, i) =>
    i === last ? { kind: 'buttons', text: said.text, buttons: wayOutButtons(phone, lang) } : m,
  );
}

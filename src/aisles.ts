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
import type { OutboundMessage } from './channels/types.ts';

const nl = String.fromCharCode(10);

export const AISLE_BACK = 'aisle:categories';
export const AISLE_LEAVE = 'aisle:leave';

export function isAisleId(id: string): boolean {
  const said = String(id ?? '').trim();
  return said === AISLE_BACK || said === AISLE_LEAVE;
}

/**
 * The way out, and the way back to the aisles.
 *
 * Both, except on the aisle list itself: a button that goes where you
 * already are is a button that does nothing, and the one thing somebody
 * standing at the front of the shop might want is the door.
 */
export function wayOutButtons(
  lang: Language,
  { onTheAisleList = false } = {},
): { id: string; title: string }[] {
  const leave = { id: AISLE_LEAVE, title: t('aisle_leave', lang) };
  return onTheAisleList ? [leave] : [{ id: AISLE_BACK, title: t('aisle_back', lang) }, leave];
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
    buttons: wayOutButtons(lang, { onTheAisleList: true }),
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
export function withWayOut(outbound: OutboundMessage[], lang: Language): OutboundMessage[] {
  if (outbound.some((m) => m.kind === 'buttons' || m.kind === 'list' || m.kind === 'location_request')) {
    return outbound;
  }

  const last = outbound.map((m) => m.kind).lastIndexOf('text');
  if (last === -1) return outbound;

  const said = outbound[last] as { kind: 'text'; text: string };
  return outbound.map((m, i) =>
    i === last ? { kind: 'buttons', text: said.text, buttons: wayOutButtons(lang) } : m,
  );
}

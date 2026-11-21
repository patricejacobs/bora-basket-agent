/**
 * The first screen anybody sees: which language shall we speak?
 *
 * Asked before the service menu and before the model, in all three languages
 * at once, because a customer who cannot read the question cannot answer it.
 * The language was worked out from what they wrote until now — which is a
 * guess, and a poor one on a first message, since "hi" is the same word in
 * most of them and a pin is no word at all. A shop that guesses wrong greets
 * somebody in a language they do not read and is judged on it before it has
 * sold anything.
 *
 * ONCE, on first contact. A customer who has answered is never asked again:
 * the choice is kept against their number, and the screen does not come back
 * when a conversation goes cold the way the service menu does. The one way
 * back is asking for it by name, which is for the person who taps the wrong
 * button and would otherwise be stranded in a language they cannot read.
 *
 * Chinese has no button and this is deliberate. WhatsApp allows three, the
 * shop speaks four, and the fourth is the one its speakers can declare
 * without help: anybody who writes a single Chinese character is switched to
 * Chinese by detection, which is a surer signal than a tap.
 */
import type { OutboundMessage } from './channels/types.ts';
import { LANGUAGES, type Language } from './language.ts';

const PREFIX = 'lang';

/** What each button says, in the language it is for — never translated. */
const ENDONYM: Record<Language, string> = {
  en: 'English',
  es: 'Español',
  pt: 'Português',
  zh: '中文',
};

/** The three with a button. Order is fixed: it is the order of the lines above. */
const OFFERED: Language[] = ['en', 'es', 'pt'];

/** True for a tap on this screen, so the channel passes the id through. */
export function isLanguageId(id: string): boolean {
  return typeof id === 'string' && /^lang:(en|es|pt|zh)$/.test(id.trim());
}

/** Which language was tapped, or null. */
export function readLanguageId(id: string): Language | null {
  const tapped = /^lang:([a-z]{2})$/.exec(String(id).trim());
  const code = tapped?.[1] ?? '';
  return (LANGUAGES as readonly string[]).includes(code) ? (code as Language) : null;
}

/**
 * Asking for it back, in any of the four.
 *
 * Short and exact. "Language" inside a sentence is somebody talking about
 * languages; this is somebody typing one word because they are stuck.
 */
export function wantsLanguageScreen(text: string): boolean {
  return /^\s*(language|lang|idioma|idiomas|língua|lingua|語言|语言)\s*[?？]?\s*$/i.test(text);
}

/**
 * The screen itself.
 *
 * Three greetings and three questions, one per language, then the three
 * buttons. No emoji per line beyond the one wave: the body is already three
 * blocks long and the buttons are what they are looking for.
 */
export function languageScreen(store: string): OutboundMessage {
  return {
    kind: 'buttons',
    text: [
      `👋 *Welcome to ${store}.*`,
      'Please select your language.',
      '',
      `👋 *Bienvenido a ${store}.*`,
      'Por favor, elija su idioma.',
      '',
      `👋 *Bem-vindo a ${store}.*`,
      'Escolha o seu idioma, por favor.',
    ].join(String.fromCharCode(10)),
    buttons: OFFERED.map((code) => ({ id: `${PREFIX}:${code}`, title: ENDONYM[code] })),
  };
}

/**
 * Whether to put it in front of this customer.
 *
 * All three parts matter. Never asked before; this is the first thing they
 * have ever sent — the inbound being handled is already logged, so one is a
 * stranger and two is somebody mid-conversation; and there is no job of
 * theirs on the books. Without the last two, every customer the shop already
 * has would be stopped for a language screen on their next message, some of
 * them in the middle of booking a car, and somebody whose number was first
 * written down by a dispatcher would be greeted as a stranger while their
 * parcel was already on a van.
 */
export function shouldAskLanguage(
  chosen: boolean,
  inboundSoFar: number,
  ordersSoFar: number,
): boolean {
  return !chosen && inboundSoFar <= 1 && ordersSoFar === 0;
}

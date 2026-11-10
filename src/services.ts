/**
 * The service menu every conversation opens with.
 *
 * Handled here rather than by the model, deliberately. The greeting and the four
 * options are fixed text, and a fixed message does not need a language model: it
 * arrives instantly, costs nothing, and reads identically to every customer
 * every time. A model asked to "always open with the menu" will one day open
 * with something else.
 *
 * Numbered rather than tappable because WhatsApp reply buttons stop at three and
 * there are four services. A numbered list also works in the simulator, in a
 * quoted reply, and for the customer who would rather type.
 */
import { config } from './config.ts';
import * as repo from './db/repo.ts';
import type { OutboundMessage } from './channels/types.ts';

export const SERVICES = ['grocery', 'restaurant', 'parcel', 'other'] as const;
export type Service = (typeof SERVICES)[number];

type Definition = {
  number: number;
  label: string;
  /** Words a customer might type instead of the number. */
  spoken: RegExp;
  /** The line that opens that service, once chosen. */
  opening: string;
};

export const SERVICE_MENU: Record<Service, Definition> = {
  grocery: {
    number: 1,
    label: 'Grocery shopping',
    spoken: /\b(grocer(y|ies)|shopping|shop|market|food\s*shop|supermarket|provisions?)\b/i,
    opening: 'Groceries it is. Tell me what you need — type a list, send a photo of one, or just say it.',
  },
  restaurant: {
    number: 2,
    label: 'Restaurant ordering',
    spoken: /\b(restaurant|takeaway|take\s*out|fast\s*food|cooked|hot\s*food|lunch|dinner|meal|eat)\b/i,
    opening: "Let's get you fed. I'll show you which kitchens are cooking right now.",
  },
  parcel: {
    number: 3,
    label: 'Parcel delivery',
    spoken: /\b(parcel|package|courier|delivery\s*only|send\s*(something|a\s*thing)|drop\s*off|pick\s*up\s*something)\b/i,
    opening:
      "Parcel delivery. I'll need to know where it's coming from, where it's going, and who's receiving it.",
  },
  other: {
    number: 4,
    label: 'Other',
    spoken: /\b(other|something\s*else|help|complain|complaint|speak\s*to|talk\s*to|manager|staff|problem)\b/i,
    opening:
      "No problem — tell me what you need and I'll pass it straight to the team with your number.",
  },
};

const ORDERED = SERVICES.map((key) => ({ key, ...SERVICE_MENU[key] })).sort(
  (a, b) => a.number - b.number,
);

/**
 * The opening message: a welcome, then the numbered services.
 *
 * A returning customer is named, because being recognised is the whole value of
 * a shop knowing your number — but they still get the menu, since the service
 * they want today is not the one they wanted last week.
 */
export function welcomeMessage(phone: string): string {
  const customer = repo.getCustomer(phone);
  const firstName = customer.name?.trim().split(/\s+/)[0] ?? '';

  const greeting = firstName
    ? `Welcome back to ${config.store.name}, ${firstName}! 👋`
    : `Welcome to ${config.store.name}! 👋`;

  return [
    greeting,
    '',
    'What can we help you with today?',
    '',
    ...ORDERED.map((s) => `*${s.number}.* ${s.label}`),
    '',
    'Just reply with the number.',
  ].join('\n');
}

export function serviceOpening(service: Service): string {
  return SERVICE_MENU[service].opening;
}

/**
 * Reads a customer's reply to the menu.
 *
 * Accepts the number, the number with punctuation ("2.", "#2"), and the service
 * named in words — somebody who types "groceries" has answered the question and
 * should not be asked it again for failing to use a digit.
 */
export function parseServiceChoice(text: string): Service | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // A bare number, possibly with a dot, bracket, hash or "option" in front.
  const asNumber = trimmed.match(/^(?:option\s*|no\.?\s*|#)?\(?([1-9])\)?[.)]?$/i);
  if (asNumber) {
    const picked = ORDERED.find((s) => s.number === Number(asNumber[1]));
    return picked?.key ?? null;
  }

  // Only treat words as a choice when the whole message is short. "1" is a
  // choice; a paragraph mentioning "lunch" is a request, and swallowing it as a
  // menu selection would lose what they actually said.
  if (trimmed.length > 40) return null;

  const matches = ORDERED.filter((s) => s.spoken.test(trimmed));
  // Ambiguity is not a selection: "food shopping or restaurant?" is a question.
  return matches.length === 1 ? (matches[0]!.key as Service) : null;
}

/** True when the customer is asking to go back to the service menu. */
export function wantsServiceMenu(text: string): boolean {
  return /^(menu|services?|back|start|change\s*service|options?)$/i.test(text.trim());
}

export function serviceMenuReply(phone: string): OutboundMessage[] {
  return [{ kind: 'text', text: welcomeMessage(phone) }];
}

/** How the chosen service is described to the agent. */
export function serviceContextLine(service: Service): string {
  const lines: Record<Service, string> = {
    grocery:
      "Service chosen: *grocery shopping* from the shop's own catalogue. Stay in it — do not offer restaurant menus or parcel delivery unless they ask to change service.",
    restaurant:
      'Service chosen: *restaurant ordering*. Call list_outlets and choose_outlet; the grocery catalogue is out of scope unless they ask to change service.',
    parcel:
      'Service chosen: *parcel delivery*. No catalogue is involved: collect the pickup point, the destination, the recipient and what is being sent, then call create_parcel_job. Do not search for products.',
    other:
      'Service chosen: *other*. You cannot resolve this yourself. Find out what they need in one or two questions, then call request_staff_help so a person picks it up. Do not promise a time.',
  };
  return lines[service];
}

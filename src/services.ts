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
import { config, money } from './config.ts';
import * as repo from './db/repo.ts';
import type { Outlet } from './db/repo.ts';
import { hoursStatus } from './hours.ts';
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
    // Unused: serviceOpening renders the live kitchen list for this one.
    opening: "Let's get you fed.",
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

/* --------------------------------------------------------------- kitchens */

export type NumberedOutlet = { number: number; outlet: Outlet; open: boolean };

/**
 * The outlets in the order a customer sees them, each with its number.
 *
 * One ordering, used by both the message the customer reads and the tool the
 * agent calls. If those two disagreed, a customer replying "2" would get the
 * wrong restaurant — the worst kind of bug, because it looks like it worked.
 *
 * Kitchens that are cooking come first: a list led by three closed restaurants
 * reads as a shop that is shut.
 */
export function numberedOutlets(): NumberedOutlet[] {
  const withState = repo.listOutlets().map((outlet) => ({
    outlet,
    open: hoursStatus(outlet.hours).state !== 'closed' && Boolean(outlet.accepting),
  }));

  withState.sort(
    (a, b) =>
      Number(b.open) - Number(a.open) || a.outlet.name.localeCompare(b.outlet.name),
  );

  return withState.map((entry, index) => ({ number: index + 1, ...entry }));
}

/**
 * The kitchens, numbered, with what it costs before anything is added.
 *
 * The fee and the minimum are here rather than at checkout deliberately. A
 * customer who builds a $1,800 order and is only then told the kitchen will not
 * take it under $2,000 has been wasted, and it reads as a bait and switch.
 */
export function outletListMessage(): string {
  const outlets = numberedOutlets();
  if (outlets.length === 0) {
    return 'No restaurants are set up yet, so there is nothing to order from — but I can help you with groceries. Send *menu* to switch.';
  }

  const line = ({ number, outlet, open }: NumberedOutlet): string => {
    const facts = [
      outlet.cuisine,
      `${outlet.prepMinutes} min`,
      `${money(outlet.deliveryFee ?? config.store.deliveryFee)} delivery`,
      ...(outlet.minOrder > 0 ? [`min ${money(outlet.minOrder)}`] : []),
    ].filter(Boolean);

    if (open) return `*${number}.* ${outlet.name} — ${facts.join(' · ')}`;

    const status = hoursStatus(outlet.hours);
    const why =
      !outlet.accepting
        ? 'kitchen paused'
        : status.state === 'closed' && status.opensAt
          ? `opens ${status.opensAt}`
          : 'closed';
    return `*${number}.* ${outlet.name} — _${why}_`;
  };

  const cooking = outlets.filter((o) => o.open);
  const shut = outlets.filter((o) => !o.open);

  return [
    cooking.length > 0 ? 'Kitchens cooking right now:' : 'Nothing is cooking right now:',
    '',
    ...cooking.map(line),
    ...(shut.length > 0 ? ['', ...shut.map(line)] : []),
    '',
    cooking.length > 0 ? 'Reply with the number.' : 'Send *menu* if you would rather shop groceries.',
  ].join('\n');
}

/**
 * The line that opens a service.
 *
 * Restaurant ordering renders its kitchens straight away rather than promising
 * to: the static version said "I'll show you which kitchens are cooking" and
 * then showed nothing, leaving the customer to guess the name of a restaurant
 * they had never been shown.
 */
export function serviceOpening(service: Service): string {
  if (service === 'restaurant') return outletListMessage();
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
      "Service chosen: *grocery shopping* from the shop's own catalogue. Do not offer restaurant menus or parcel delivery unasked — but if they ask for one, switch_service takes them there in the same breath.",
    restaurant:
      'Service chosen: *restaurant ordering*. Call list_outlets and choose_outlet; the grocery catalogue is out of scope. If they ask for groceries or a parcel, call switch_service rather than sending them back to a menu.',
    parcel:
      'Service chosen: *parcel delivery*. No catalogue is involved: ask for the uplift point, the destination, the recipient and what is being sent, then call create_parcel_job. Do not search for products. If they ask for food or groceries instead, call switch_service.',
    other:
      'Service chosen: *other*. You cannot resolve this yourself. Find out what they need in one or two questions, then call request_staff_help so a person picks it up. Do not promise a time.',
  };
  return lines[service];
}

/**
 * Onboarding a restaurant from a photograph of its menu.
 *
 * The alternative was editing two CSVs and redeploying, which is fine for a
 * developer and wrong for the person actually signing restaurants up — they are
 * standing in one, holding a phone, and the menu is on the wall.
 *
 * Nothing a photograph produces goes live. It becomes a draft the staff member
 * reads back and publishes, because a model reading small print off a laminated
 * menu in bad light will occasionally get a price wrong, and a wrong price is
 * money. Further photos add pages to the same draft, since menus rarely fit on
 * one sheet.
 */
import { config, money, toMinorUnits } from './config.ts';
import * as repo from './db/repo.ts';
import { readMenuPhoto, describeDraft, type ReadMenu } from './menu-reader.ts';
import { restrictedReason } from './restricted.ts';
import type { IncomingImage, OutboundMessage } from './channels/types.ts';
import type { LocationPin } from './location.ts';

const reply = (text: string): OutboundMessage[] => [{ kind: 'text', text }];

/**
 * A short code for the outlet, derived from its name.
 *
 * Staff type this to refer to the outlet later, so it has to be guessable from
 * the name rather than a random string: Kingston Fried Hut becomes KFH.
 */
export function codeFor(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^(the|and|of|a|an)$/i.test(w));

  const initials = words.map((w) => w[0]!.toUpperCase()).join('').slice(0, 4);
  const base = initials.length >= 2 ? initials : (name.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'OUT').slice(0, 4);

  // Collisions are real: two "Bourda Roti House" style names share initials.
  if (!repo.getOutlet(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}${n}`;
    if (!repo.getOutlet(candidate)) return candidate;
  }
  return `${base}${Date.now().toString().slice(-4)}`;
}

/** Merges a newly read page into the draft already in progress. Exported for tests. */
export function mergePages(existing: ReadMenu, incoming: ReadMenu): ReadMenu {
  const seen = new Set(existing.items.map((i) => i.name.toLowerCase()));
  const added = incoming.items.filter((i) => !seen.has(i.name.toLowerCase()));

  return {
    // Later pages rarely repeat the header, so anything already known wins.
    outlet: {
      name: existing.outlet.name || incoming.outlet.name,
      cuisine: existing.outlet.cuisine || incoming.outlet.cuisine,
      hours: existing.outlet.hours || incoming.outlet.hours,
      phone: existing.outlet.phone || incoming.outlet.phone,
      address: existing.outlet.address || incoming.outlet.address,
    },
    items: [...existing.items, ...added],
    unclear: [...existing.unclear, ...incoming.unclear],
  };
}

/* ------------------------------------------------------------------ photo */

/**
 * A staff member sent a photograph. Read it, and add it to their draft.
 */
export async function handleMenuPhoto(
  phone: string,
  image: IncomingImage,
): Promise<OutboundMessage[]> {
  if (!config.anthropic.apiKey) {
    return reply('Cannot read photos — ANTHROPIC_API_KEY is not set on the server.');
  }

  let read: ReadMenu;
  try {
    read = await readMenuPhoto(image);
  } catch (err) {
    console.error('[onboarding] could not read a menu photo:', err);
    return reply(
      "Couldn't read that one. Try again with the menu flat, filling the frame, in good light — or send one section at a time.",
    );
  }

  if (read.items.length === 0) {
    return reply(
      `No dishes could be read from that photo.${
        read.unclear.length > 0 ? `\n\n${read.unclear.map((u) => `• ${u}`).join('\n')}` : ''
      }\n\nIf it is a menu, try a closer shot of one section.`,
    );
  }

  const existing = repo.getMenuDraft(phone);
  let menu = read;
  let pages = 1;
  let code: string;

  if (existing) {
    menu = mergePages(JSON.parse(existing.payload) as ReadMenu, read);
    pages = existing.pages + 1;
    code = existing.code;
  } else {
    code = codeFor(read.outlet.name || 'outlet');
  }

  repo.saveMenuDraft(phone, code, JSON.stringify(menu), pages);

  const header = pages > 1 ? `Page ${pages} added.\n\n` : '';
  return reply(header + describeDraft(menu, code));
}

/* --------------------------------------------------------------- commands */

export const ONBOARDING_HELP = [
  '*Adding a restaurant*',
  '',
  'Send a photo of the menu. Repeat for more pages.',
  '',
  '`draft` — show what has been read',
  '`publish` — put it on the menu',
  '`discard` — throw the draft away',
  '',
  'After publishing:',
  '`hours KFH Mon-Sat 10am-10pm`',
  '`number KFH 5926123456` — the kitchen\'s WhatsApp',
  '`minimum KFH 1500` / `fee KFH 700`',
  'Share a location pin to set where the delivery associate uplifts.',
].join('\n');

/** True when this looks like an onboarding command rather than a dispatch one. */
export function isOnboardingCommand(text: string): boolean {
  return /^(draft|publish|discard|new\s*outlet|add\s*restaurant|hours|number|minimum|fee)\b/i.test(
    text.trim(),
  );
}

export async function handleOnboardingCommand(
  phone: string,
  text: string,
): Promise<OutboundMessage[]> {
  const trimmed = text.trim();

  if (/^(new\s*outlet|add\s*restaurant)$/i.test(trimmed)) {
    return reply(ONBOARDING_HELP);
  }

  if (/^draft$/i.test(trimmed)) {
    const draft = repo.getMenuDraft(phone);
    if (!draft) return reply('No draft in progress. Send a photo of a menu to start one.');
    return reply(describeDraft(JSON.parse(draft.payload) as ReadMenu, draft.code));
  }

  if (/^discard$/i.test(trimmed)) {
    const draft = repo.getMenuDraft(phone);
    if (!draft) return reply('Nothing to discard.');
    repo.clearMenuDraft(phone);
    return reply(`Draft for ${draft.code} thrown away. Nothing was published.`);
  }

  if (/^publish$/i.test(trimmed)) return publishDraft(phone);

  // Everything below edits an outlet that already exists.
  const parts = trimmed.split(/\s+/);
  const verb = (parts[0] ?? '').toLowerCase();
  const code = parts[1] ?? '';
  const rest = parts.slice(2).join(' ').trim();

  const outlet = code ? repo.getOutlet(code) : null;
  if (!outlet) {
    return reply(`No outlet with code "${code}". Send \`outlets\` to see them.`);
  }

  if (verb === 'hours') {
    if (!rest) return reply(`Hours for ${outlet.name} are "${outlet.hours || 'not set'}".`);
    repo.upsertOutlet({ ...outlet, hours: rest });
    return reply(`${outlet.name} now opens ${rest}.`);
  }

  if (verb === 'number') {
    const digits = rest.replace(/[^0-9]/g, '');
    if (digits.length < 7) return reply('That does not look like a telephone number.');
    repo.upsertOutlet({ ...outlet, whatsapp: digits });
    return reply(
      `${outlet.name} kitchen tickets will go to +${digits}. They can reply \`orders\`, \`7 confirm\`, \`7 ready\`.`,
    );
  }

  if (verb === 'minimum' || verb === 'fee') {
    const amount = toMinorUnits(rest);
    if (!(amount >= 0) || !rest) return reply(`Give an amount, e.g. \`${verb} ${outlet.code} 1500\`.`);
    repo.upsertOutlet(
      verb === 'minimum' ? { ...outlet, minOrder: amount } : { ...outlet, deliveryFee: amount },
    );
    return reply(
      verb === 'minimum'
        ? `${outlet.name} minimum order is now ${money(amount)}.`
        : `${outlet.name} delivery fee is now ${money(amount)}.`,
    );
  }

  return reply(ONBOARDING_HELP);
}

/* -------------------------------------------------------------- publishing */

async function publishDraft(phone: string): Promise<OutboundMessage[]> {
  const draft = repo.getMenuDraft(phone);
  if (!draft) return reply('No draft to publish. Send a photo of a menu first.');

  const menu = JSON.parse(draft.payload) as ReadMenu;
  if (!menu.outlet.name) {
    return reply(
      'The draft has no restaurant name — the photo did not show one. Send a photo of the top of the menu, or the shopfront.',
    );
  }

  const existing = repo.getOutlet(draft.code);
  repo.upsertOutlet({
    code: draft.code,
    name: menu.outlet.name,
    cuisine: menu.outlet.cuisine,
    hours: menu.outlet.hours,
    // Keep anything a person has already set; a re-publish must not wipe the
    // pickup pin or the kitchen's number back to blank.
    prepMinutes: existing?.prepMinutes ?? 20,
    minOrder: existing?.minOrder ?? 0,
    deliveryFee: existing?.deliveryFee ?? null,
    pickupAddress: existing?.pickupAddress || menu.outlet.address,
    pickupLat: existing?.pickupLat ?? null,
    pickupLng: existing?.pickupLng ?? null,
    whatsapp: existing?.whatsapp || menu.outlet.phone,
    active: 1,
  });

  const outlet = repo.getOutlet(draft.code)!;

  // Republishing replaces the menu rather than adding to it, so a dish taken
  // off a reprinted menu actually comes off. Deactivated, not deleted, because
  // past orders keep their item history.
  const retired = repo.deactivateOutletMenu(outlet.id);

  let published = 0;
  let refused = 0;
  menu.items.forEach((item, index) => {
    // The filter runs again at publish, not only at read. Between the two a
    // person may have edited the draft, and this is the gate that matters.
    if (item.refused || restrictedReason(item.name, item.description, item.category, item.options)) {
      refused++;
      return;
    }
    repo.upsertProduct({
      sku: `${outlet.code}-${String(index + 1).padStart(3, '0')}`,
      name: item.name,
      description: item.description,
      category: item.category,
      unit: item.unit,
      price: item.price,
      stock: 0,
      trackStock: 0,
      active: 1,
      keywords: '',
      outletId: outlet.id,
      options: item.options,
    });
    published++;
  });

  repo.clearMenuDraft(phone);

  const missing: string[] = [];
  if (!outlet.hours) missing.push(`\`hours ${outlet.code} Mon-Sat 10am-10pm\``);
  if (!outlet.whatsapp) missing.push(`\`number ${outlet.code} 5926123456\``);
  if (outlet.pickupLat === null) missing.push('share a location pin from outside the restaurant');

  return reply(
    [
      `✅ *${outlet.name}* is live — ${published} item(s) on the menu.`,
      ...(refused > 0 ? [`${refused} left out (alcohol or tobacco).`] : []),
      ...(retired > published ? [`${retired - published} old item(s) taken off.`] : []),
      '',
      ...(missing.length > 0
        ? ['Still needed before customers can order properly:', ...missing.map((m) => `• ${m}`)]
        : ['Everything is set — customers can order from them now.']),
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------- pins */

/**
 * A staff member shared a location while onboarding.
 *
 * Standing outside the restaurant, the pin is one tap and exactly right — which
 * is the whole reason onboarding happens on a phone rather than in a
 * spreadsheet, where somebody would be typing coordinates.
 */
export function handleStaffPin(phone: string, pin: LocationPin): OutboundMessage[] {
  const draft = repo.getMenuDraft(phone);
  const target = draft ? repo.getOutlet(draft.code) : mostRecentOutlet();

  if (!target) {
    return reply(
      'Got a pin, but no restaurant to attach it to. Send a menu photo first, or `publish` the draft and share the pin again.',
    );
  }

  repo.upsertOutlet({ ...target, pickupLat: pin.latitude, pickupLng: pin.longitude });
  return reply(
    `📍 Uplift point set for *${target.name}*${pin.label ? ` (${pin.label})` : ''}. Delivery associates will navigate here.`,
  );
}

/** The outlet touched most recently, which is the one being set up. */
function mostRecentOutlet(): repo.Outlet | null {
  return repo.mostRecentlyTouchedOutlet();
}

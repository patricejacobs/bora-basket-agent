/**
 * Reading a restaurant's menu off a photograph.
 *
 * Onboarding an outlet by editing two CSVs and redeploying is fine for a
 * developer and wrong for the person actually signing up restaurants, who is
 * standing in one holding a phone. A printed menu already contains almost
 * everything needed: the name at the top, the dishes, the prices, and usually
 * the sizes and the add-ons.
 *
 * This is a single structured extraction rather than a conversation. It is given
 * a picture and returns rows; it books nothing and changes nothing. What comes
 * back is a draft that a person reads before any of it reaches a customer,
 * because a misread price is money and a model reading a photograph of a
 * laminated menu in poor light will sometimes get one wrong.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, toMinorUnits, money } from './config.ts';
import { restrictedReason } from './restricted.ts';
import { parseOptionSpec } from './menu-options.ts';

const client = new Anthropic({ apiKey: config.anthropic.apiKey || undefined });

export type ReadItem = {
  name: string;
  description: string;
  category: string;
  unit: string;
  /** Minor units, as every price in this app is. */
  price: number;
  options: string;
  /** Set when the item may not be sold here; it is kept, shown, never published. */
  refused?: string;
};

export type ReadMenu = {
  outlet: { name: string; cuisine: string; hours: string; phone: string; address: string };
  items: ReadItem[];
  /** Anything the reader could not make out, for a person to resolve. */
  unclear: string[];
};

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const mediaType = (mime: string): MediaType =>
  (MEDIA_TYPES as readonly string[]).includes(mime) ? (mime as MediaType) : 'image/jpeg';

/**
 * The shape the model must answer in.
 *
 * A tool rather than free text, so the result is parsed rather than interpreted
 * — and `tool_choice` forces it, so there is no prose to strip.
 */
const RECORD_MENU: Anthropic.Tool = {
  name: 'record_menu',
  description: 'Record what the menu photograph says.',
  input_schema: {
    type: 'object',
    properties: {
      outlet_name: {
        type: 'string',
        description: "The restaurant's name as printed. Empty string if the photo does not show one.",
      },
      cuisine: { type: 'string', description: 'A few words: what they cook. Empty if unclear.' },
      hours: {
        type: 'string',
        description:
          'Opening hours exactly as printed, e.g. "Mon-Sat 10:00am - 10:00pm, Sun closed". Empty if not shown.',
      },
      phone: { type: 'string', description: 'Telephone number as printed. Empty if not shown.' },
      address: { type: 'string', description: 'Street address as printed. Empty if not shown.' },
      items: {
        type: 'array',
        description: 'Every dish on the menu, in the order printed.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The dish name as printed.' },
            description: { type: 'string', description: 'Any description printed under it, else empty.' },
            category: {
              type: 'string',
              description: 'The menu section it sits under, e.g. "Burgers". Use "Menu" if there are no sections.',
            },
            unit: {
              type: 'string',
              description: 'What one costs: "each", "plate", "6 pieces". Use "each" when not stated.',
            },
            price: {
              type: 'string',
              description:
                'The printed price as digits only, no currency symbol. If a dish has several sizes, put the cheapest here and express the rest as options.',
            },
            options: {
              type: 'string',
              description:
                'Choices, in this exact syntax: "Size:Regular|Large+350;Spice:Mild|Hot;Extras*:Cheese+150". A plain group must be chosen, Name? is optional single, Name* is any number, +N adds N to the price. Empty string when the dish has no choices.',
            },
          },
          required: ['name', 'description', 'category', 'unit', 'price', 'options'],
          additionalProperties: false,
        },
      },
      unclear: {
        type: 'array',
        description:
          'Anything you could not read with confidence — a smudged price, a cut-off line, a dish whose size you had to guess. Say which dish and what was unclear.',
        items: { type: 'string' },
      },
    },
    required: ['outlet_name', 'cuisine', 'hours', 'phone', 'address', 'items', 'unclear'],
    additionalProperties: false,
  },
};

const INSTRUCTIONS = `You are reading a photograph of a restaurant menu so a delivery service can put it online.

Record exactly what is printed. Do not round prices, do not tidy up dish names, and do not invent anything that is not on the page — a dish that does not exist, or a price that is wrong, reaches a real customer.

Where a dish is printed with several sizes or variants, put the cheapest price in \`price\` and express the rest as options with the difference. A burger at 920 regular and 1270 large is price 920 and options "Size:Regular|Large+350".

If a price is smudged, cut off, or you are guessing at it, still record your best reading but say so in \`unclear\`. A flagged price gets checked by a person; a confident wrong one does not.

Include every dish you can see, including drinks.`;

/* ------------------------------------------------------------------ reading */

export async function readMenuPhoto(image: { base64: string; mediaType: string }): Promise<ReadMenu> {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    // Reading small print off a photograph is the one place in this app where
    // more thinking is plainly worth the wait: a staff member onboarding a
    // restaurant is not waiting on a reply the way a customer is.
    output_config: { effort: 'high' },
    tools: [RECORD_MENU],
    tool_choice: { type: 'tool', name: 'record_menu' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType(image.mediaType), data: image.base64 },
          },
          { type: 'text', text: INSTRUCTIONS },
        ],
      },
    ],
  });

  const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!call) throw new Error('The reader returned nothing usable for that photo.');

  return normalise(call.input as Record<string, unknown>);
}

/* -------------------------------------------------------------- normalising */

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function normalise(raw: Record<string, unknown>): ReadMenu {
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  const items: ReadItem[] = [];
  const unclear = (Array.isArray(raw.unclear) ? raw.unclear : []).map(text).filter(Boolean);

  for (const entry of rawItems) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const name = text(row.name);
    if (!name) continue;

    const price = toMinorUnits(text(row.price));
    if (!(price > 0)) {
      unclear.push(`${name} — no price could be read, so it was left out`);
      continue;
    }

    const options = text(row.options);
    // A malformed options string would fail silently at import, long after
    // anyone was looking. Dropped here, with the dish kept and flagged.
    const optionsUsable = options === '' || parseOptionSpec(options).length > 0;
    if (!optionsUsable) {
      unclear.push(`${name} — the choices could not be read, so it has none`);
    }

    items.push({
      name,
      description: text(row.description),
      category: text(row.category) || 'Menu',
      unit: text(row.unit) || 'each',
      price,
      options: optionsUsable ? options : '',
      // The compliance filter runs on what was read, not on what gets published,
      // so a refused item is visible to the person reviewing rather than
      // vanishing — they should know the beer was seen and left out.
      ...(restrictedReason(name, text(row.description), text(row.category), options)
        ? { refused: restrictedReason(name, text(row.description), text(row.category), options)! }
        : {}),
    });
  }

  return {
    outlet: {
      name: text(raw.outlet_name),
      cuisine: text(raw.cuisine),
      hours: text(raw.hours),
      phone: text(raw.phone).replace(/[^0-9]/g, ''),
      address: text(raw.address),
    },
    items,
    unclear,
  };
}

/* ----------------------------------------------------------------- display */

/** The draft as a staff member reads it back on a phone. */
export function describeDraft(menu: ReadMenu, code: string): string {
  const sellable = menu.items.filter((i) => !i.refused);
  const refused = menu.items.filter((i) => i.refused);

  const bySection = new Map<string, ReadItem[]>();
  for (const item of sellable) {
    bySection.set(item.category, [...(bySection.get(item.category) ?? []), item]);
  }

  const lines: string[] = [
    `📋 *Draft — ${menu.outlet.name || 'unnamed outlet'}* (${code})`,
    '',
    ...(menu.outlet.cuisine ? [`Serves: ${menu.outlet.cuisine}`] : []),
    ...(menu.outlet.hours ? [`Hours: ${menu.outlet.hours}`] : ['⚠️ No hours read — send `hours ' + code + ' Mon-Sat 10am-10pm`']),
    ...(menu.outlet.address ? [`At: ${menu.outlet.address}`] : []),
    ...(menu.outlet.phone ? [`Tel: ${menu.outlet.phone}`] : []),
    '',
  ];

  let n = 0;
  for (const [section, items] of bySection) {
    lines.push(`*${section}*`);
    for (const item of items) {
      n++;
      const opts = item.options ? `\n     _${item.options}_` : '';
      lines.push(`${n}. ${item.name} — ${money(item.price)}${opts}`);
    }
    lines.push('');
  }

  if (refused.length > 0) {
    lines.push(
      `🚫 *Left out (${refused.length})* — WhatsApp does not allow selling these:`,
      ...refused.map((i) => `• ${i.name}`),
      '',
    );
  }

  if (menu.unclear.length > 0) {
    lines.push('⚠️ *Check these:*', ...menu.unclear.map((u) => `• ${u}`), '');
  }

  lines.push(
    `${sellable.length} item(s) ready. *Nothing is live yet.*`,
    '',
    'Send another photo to add more pages,',
    '`publish` to put it on the menu, or `discard` to drop it.',
  );

  return lines.join('\n');
}

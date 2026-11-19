import type Anthropic from '@anthropic-ai/sdk';
import { config, money } from '../config.ts';
import * as repo from '../db/repo.ts';
import type { OutboundMessage } from '../channels/types.ts';
import { announceNewOrder, offerParcel, tellKitchenCancelled } from '../dispatch.ts';
import { notifyStaffOfRequest } from '../notifications.ts';
import { quoteParcel, flatParcelQuote, checkContents } from '../parcels.ts';
import { productImageUrl } from '../product-images.ts';
import { CUSTOMER_STATUS, describeAge } from '../order-status.ts';
import { searchCatalog } from '../catalog/search.ts';
import { hoursStatus } from '../hours.ts';
import { numberedOutlets, serviceOpening, languageFor, SERVICES } from '../services.ts';
import { t } from '../language.ts';
import { available, availabilityLabel, refuseQty } from '../availability.ts';
import { parseOptionSpec, describeOptions, applySelection } from '../menu-options.ts';
import { checkRange, formatDistance, saysTheSamePlace } from '../location.ts';
import { findZone, zoneCount, describeZone, zoneFeeFor } from '../zones.ts';
import { itemLabel, labelPosition } from '../categories.ts';
import { readLocationSync, isDoorstep } from '../maps-link.ts';

const chr10 = String.fromCharCode(10);

export type ToolContext = {
  phone: string;
  /** Messages the agent has queued to send via the channel this turn. */
  outbound: OutboundMessage[];
};

/**
 * Tool definitions. Order and content are stable across requests so the prompt
 * cache prefix stays intact — do not build these per-request.
 */
export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'list_categories',
    description:
      'List every product category in the store with how many items each holds. Use this when the customer asks what you sell or seems unsure where to start.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'switch_service',
    description:
      "Move the customer to a different service when they ask for one — groceries, restaurant food, a parcel, or something a person must handle. Call this instead of telling them to send 'menu'. If they have anything in their cart you must first ask whether to keep it for later or drop it, and pass their answer as cart_action; the tool refuses without it.",
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: "'grocery', 'restaurant', 'parcel' or 'other'.",
        },
        cart_action: {
          type: 'string',
          description:
            "What to do with what is already in the cart: 'keep' sets it aside to come back to, 'cancel' drops it. Required whenever the cart has anything in it. Ask the customer — never choose for them.",
        },
      },
      required: ['service'],
      additionalProperties: false,
    },
  },
  {
    name: 'resume_parked_cart',
    description:
      'Bring back a cart the customer set aside earlier. Only works when the current cart is empty. Pass the outlet code for a restaurant cart, or omit it for the grocery cart.',
    input_schema: {
      type: 'object',
      properties: {
        outlet_code: {
          type: 'string',
          description: 'The outlet whose cart to bring back. Omit for the grocery cart.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_outlets',
    description:
      'List the restaurants and fast-food outlets the customer can order from, with whether each is taking orders right now and how long it typically takes to prepare. Call this when they ask about food, takeaway, or a particular restaurant — never name an outlet or claim it is open without calling this first.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'choose_outlet',
    description:
      "Set which outlet's menu the customer is ordering from. Every search after this returns only that menu, so call it before looking for dishes. Refuses if the outlet is closed or has paused orders. To go back to grocery shopping, call leave_outlet.",
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The outlet code from list_outlets.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'leave_outlet',
    description:
      'Stop ordering from a restaurant and go back to the grocery catalogue. Does not touch the cart — if there is a restaurant order in it, ask the customer what they want to do with it first.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browse_category',
    description:
      "Everything in one aisle, written out as `lines` with a letter in brackets against each item, so the customer can answer with letters and quantities. Call it when they pick an aisle from the list, by its number or its name. The lettering is remembered: their next reply can be \"a x2, d x1\" or \"two of the first one\" and `add_picks` resolves it.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: "The aisle name, or the number it had in the list you just sent — \"3\" is as good as \"Dairy & Eggs\".",
        },
      },
      required: ['category'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_picks',
    description:
      "Add items the customer picked by letter from the aisle you last showed them. Use it for any reply that refers to that list — \"a x2, d\", \"two of b\", \"the first and the last\". For anything named rather than lettered, use add_items_to_cart.",
    input_schema: {
      type: 'object',
      properties: {
        picks: {
          type: 'array',
          description: 'One entry per line of the list they referred to.',
          items: {
            type: 'object',
            properties: {
              ref: {
                type: 'string',
                description: 'The letter as it appeared in the list — "a", "d", "aa".',
              },
              quantity: { type: 'integer', description: 'How many. Defaults to 1.' },
              options: {
                type: 'string',
                description: 'For a menu item that needs a choice, e.g. "Large". Leave out for groceries.',
              },
            },
            required: ['ref'],
            additionalProperties: false,
          },
        },
      },
      required: ['picks'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_products',
    description:
      "Search for items by name, keyword, or category. Searches the chosen outlet's menu when one is chosen, and the grocery catalogue otherwise. Always call this before claiming an item is or is not available — never guess at products, prices, or stock.",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What the customer is looking for, e.g. "chicken", "rice 5kg", "milk".',
        },
        category: {
          type: 'string',
          description: 'Optional exact category name to narrow the search.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum results to return (1-15). Defaults to 8.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_many',
    description:
      'Search for several different items in one call. Use this whenever the customer gives you a list — typed or photographed — instead of calling search_products once per item. One call is far faster for the customer than ten.',
    input_schema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          description: 'One search phrase per item on the list, in the order they appear.',
          items: { type: 'string' },
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_product',
    description: 'Fetch one product by its exact SKU, including live price and stock.',
    input_schema: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'Exact product SKU.' } },
      required: ['sku'],
      additionalProperties: false,
    },
  },
  {
    name: 'show_product_photo',
    description:
      "Send the customer a photo of a product, when they ask what something looks like or which of two similar items they mean. Only some products have photos — this reports plainly when one does not, and you should then describe it in words rather than apologising at length.",
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact SKU of the product to show.' },
        caption: { type: 'string', description: 'Short line shown under the photo.' },
      },
      required: ['sku'],
      additionalProperties: false,
    },
  },
  {
    name: 'view_cart',
    description:
      "Read the customer's current cart with line totals, delivery fee, and order total.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_to_cart',
    description:
      'Add a quantity of one product to the cart. If the item is already there, this adds to the existing quantity.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Exact SKU from search_products or get_product.' },
        quantity: { type: 'integer', description: 'How many units to add (1-99).' },
        choices: {
          type: 'array',
          description:
            'The option choices for a menu item, as the labels the customer picked, e.g. ["Large","Extra cheese","Hot"]. Required where the item lists must_choose options. Omit for groceries.',
          items: { type: 'string' },
        },
      },
      required: ['sku', 'quantity'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_items_to_cart',
    description:
      'Add several products to the cart in one call. Use this after search_many rather than calling add_to_cart repeatedly. Items that cannot be added are reported individually, so a single bad line does not lose the rest.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The products to add.',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string' },
              quantity: { type: 'integer', description: 'How many units (1-99).' },
            },
            required: ['sku', 'quantity'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_cart_item',
    description:
      'Set the exact quantity of a cart line. Pass quantity 0 to remove the item entirely.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        quantity: { type: 'integer', description: 'New absolute quantity (0-99). 0 removes it.' },
        choices: {
          type: 'array',
          description:
            'For a menu item, the exact choices of the line being changed — a cart can hold the same dish twice with different options.',
          items: { type: 'string' },
        },
      },
      required: ['sku', 'quantity'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_cart',
    description: 'Empty the cart completely. Only call this when the customer clearly asks for it.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_customer_details',
    description:
      'Check the delivery name, location pin and address already saved for this customer. Call this before asking them for details they have already given.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'request_location',
    description:
      "Send the customer a 'Send location' button so they can share the delivery pin from WhatsApp. Every order needs a pin, so call this as soon as you know they intend to order and none is on file. Keep the body to the request for the pin alone — one short line — and say everything else about their order in your normal reply, which is sent with it. A sentence is appended for you telling them they can move the pin to the destination rather than sending where they are standing, so do not say that yourself and do not paraphrase it. Their pin arrives on its own and is saved automatically; you never record coordinates yourself.",
    input_schema: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description:
            'Short message shown above the button, explaining why you need the pin. Max 1024 characters.',
        },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_location_link',
    description:
      "Read a location out of something the customer pasted: a Google Maps link, a plus code (like 865RXM2G+MC or XM2G+MC), or bare coordinates. Call this whenever a message contains one, instead of asking them to send a pin again — they believe they have already told you where they are. Pass their message text exactly as they sent it. The result says how precise it is: a 'place' or 'plus_code' is somewhere an associate can be sent, while a town or a map view is only good enough to know roughly where they are, and you must still ask for a pin. Nothing is saved unless you pass save: true.",
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The customer message containing the link, plus code or coordinates.',
        },
        save: {
          type: 'boolean',
          description:
            'Save it as their delivery pin. Only pass true when the result came back precise enough to deliver to AND the customer has confirmed it is the delivery address — never for a town, and never on a guess.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm_identity',
    description:
      "Record that the customer has confirmed who they are and where to deliver. Call this only after they have actually said yes to the name and delivery point you read back to them — never on an assumption, and never on a name that only came from their WhatsApp profile. An order cannot be placed until this is done.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'customer_record',
    description:
      "The trading history for this phone number: how many orders, total spent, when they first and last ordered, and the orders themselves. Use it to answer questions about past spending or to recognise a regular.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'save_customer_details',
    description:
      'Save or update the delivery name and doorstep details. Only pass a field when the customer has actually stated it. The location pin is never passed here — it is saved automatically when the customer shares it.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name for the delivery.' },
        address: {
          type: 'string',
          description:
            'What the delivery associate needs at the door once the pin has got them to the street: house or gate description, flat or floor, a landmark. Optional — the pin is what the delivery goes to.',
        },
        contact_phone: {
          type: 'string',
          description:
            "The CUSTOMER'S own alternative number — where to ring THEM, when the phone they are writing from is not the one to call. It is saved against them and reused on every future order, so it must never be anybody else's. A number for whoever is receiving a delivery goes in recipient_phone on place_order; a number for a parcel's recipient goes in recipient_phone on create_parcel_job. Only pass this when the customer names a second number for themselves.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'place_order',
    description:
      'Place the order for everything currently in the cart. Only call this after the customer has seen the full itemised total and explicitly confirmed. Requires a saved name and a shared location pin. If the delivery is going to somebody other than the customer, pass recipient_name and recipient_phone so the delivery associate has the right name and number at the door.',
    input_schema: {
      type: 'object',
      properties: {
        delivery_address: {
          type: 'string',
          description:
            "Where THIS order goes, in words, when that is not the address saved against the customer — somebody else's house, their office, a friend's. The address only: no instructions, no explanation, nothing about pins or ringing, all of which the delivery associate's card prints for itself. Leave it out when the delivery goes to the customer's usual address.",
        },
        recipient_name: {
          type: 'string',
          description:
            'Who will receive it, when the customer is ordering for somebody else. Leave it out when the customer is receiving it themselves. The delivery associate needs this: at the door the buyer\'s name is the wrong name.',
        },
        recipient_phone: {
          type: 'string',
          description:
            "The recipient's own number, digits only. Ask for it whenever recipient_name is set — it is the number the associate rings at the door. Leave it out if the customer does not know it; the card then falls back to ringing the customer.",
        },
        recipient_pin_shared: {
          type: 'boolean',
          description:
            "True only when the customer has shared a location pin for the RECIPIENT during this order. Leave it out if the pin on file is the customer's own from a previous delivery — the delivery associate is then told there is no pin and rings instead, which is right, because the saved pin is the buyer's door and not where this one goes.",
        },
        payment_method: {
          type: 'string',
          // Only what the shop can actually take, so an unsupported method
          // cannot be selected in the first place.
          enum: config.paymentMethods.map((m) => `${m}_on_delivery`),
          description: 'How the customer will pay the delivery associate.',
        },
        deliver_at: {
          type: 'string',
          description:
            "When the customer asked for it, as a full ISO timestamp in the shop's timezone, e.g. \"2026-11-18T17:00:00-04:00\". Work it out from what they said and the local time you were given. Leave it out when they want it as soon as possible — never guess at a time they did not ask for.",
        },
        deliver_note: {
          type: 'string',
          description:
            'Their own words about the time — "before 6", "after work", "any time this evening". Pass it alongside deliver_at whenever they said something rather than named a clock time, because "before six" is not a point in time and the associate needs to read what they actually said. Under 60 characters.',
        },
        delivery_note: {
          type: 'string',
          description:
            'One short line of doorstep detail, and only that: "white fence, upstairs", "blue gate, ring twice". Under 80 characters. It is NOT a place to repeat the address, the names, the phone numbers, or whether there is a pin — the delivery associate\'s card prints all of those itself, and anything repeated here is read twice and trusted less. Leave it out when there is nothing to add.',
        },
      },
      required: ['payment_method'],
      additionalProperties: false,
    },
  },
  {
    name: 'delivery_zone',
    description:
      "What the delivery costs, by where it is going. Call it as soon as you have an area or an address, BEFORE quoting any delivery charge or total. Two steps, on purpose: call it with `text` to find out which place the shop thinks they mean, read that place back to them in your own words, and only once they have agreed call it again with `place` and `confirmed` true. Never quote a delivery figure you have not confirmed this way — a price the customer did not agree to is one the delivery associate has to argue about at their gate.",
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'What the customer said about where they are — an area, a village, a whole address. Spelling does not matter; the shop matches on how a name sounds.',
        },
        place: {
          type: 'string',
          description:
            'The place name EXACTLY as the shop gave it back to you, when confirming. Not the customer\'s spelling.',
        },
        confirmed: {
          type: 'boolean',
          description:
            'True only when the customer has been told the place by name and has agreed it is right. Never true on the same turn you first looked it up.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'parcel_party',
    description:
      "Writes down one end of a parcel - the sender or the recipient - once the customer has AGREED it. Call it with `side` and whatever of the name, address and telephone number they gave. It reads the half back for you to show them; call it again with `confirmed` true once they have said it is right. Nothing is booked until both ends are confirmed, so this is how the six facts a parcel needs get collected without asking twice.",
    input_schema: {
      type: 'object',
      properties: {
        side: {
          type: 'string',
          enum: ['sender', 'recipient'],
          description: 'Which end of the journey this is.',
        },
        name: { type: 'string', description: 'Their name, as they gave it.' },
        address: {
          type: 'string',
          description:
            'Where the parcel is collected from, or delivered to, in words. The address only - no telephone number and no instructions.',
        },
        phone: { type: 'string', description: 'Their telephone number, digits only.' },
        confirmed: {
          type: 'boolean',
          description:
            'True only once this half has been read back to the customer and they have agreed it. Never on the same turn you first wrote it down.',
        },
      },
      required: ['side'],
      additionalProperties: false,
    },
  },
  {
    name: 'parcel_status',
    description:
      'Check what you already have for the parcel being arranged: which pins are on file, how far apart they are, and the fee if one can be quoted. Call this before asking the customer for anything, so you do not ask twice.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_parcel_job',
    description:
      "Book the parcel once you know where it is uplifted from, where it is going, the recipient's name and number, and what is being sent. Each end can be a location pin, an address in words, or both — a pin is better, so ask for one first, but take the address when they cannot share one. Creates the job and dispatches it. Call it once, only after reading the whole thing back and getting a clear yes.",
    input_schema: {
      type: 'object',
      properties: {
        contents: {
          type: 'string',
          description:
            "What is in the parcel, in the customer's own words, plus rough size or weight. Required — a delivery associate has to know what they are carrying.",
        },
        sender_name: {
          type: 'string',
          description:
            'Who the parcel is collected FROM. Required. Ask — it is not necessarily the person you are talking to, and never assume it is.',
        },
        sender_phone: {
          type: 'string',
          description:
            'The number the delivery associate rings to collect it. Required, and asked for every time: never the number they are messaging from unless they have confirmed that is the one, and never a number saved from a past order.',
        },
        recipient_name: { type: 'string', description: 'Who receives it. Required.' },
        recipient_phone: {
          type: 'string',
          description: "The recipient's telephone number, so the delivery associate can ring on arrival.",
        },
        pickup_note: {
          type: 'string',
          description:
            'The uplift address in words, and the doorstep detail that goes with it: street, lot or house number, which gate or floor, who to ask for at the door. Required when no pin has been shared for the uplift, and worth taking alongside a pin — the two together are what gets somebody to a door. NO telephone numbers and no instructions: the card prints the sender\'s name and number on their own line directly beneath this, so a number written in here is the same number twice.',
        },
        destination_note: {
          type: 'string',
          description:
            "The same for the drop-off, under the same rule: the address and doorstep detail only, with no telephone number written into it. The recipient's name and number are printed on their own lines. Required when no pin has been shared for the destination.",
        },
      },
      required: ['contents', 'sender_name', 'sender_phone', 'recipient_name', 'recipient_phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_my_order',
    description:
      "Cancel one of this customer's own orders. Works only while the kitchen has not accepted it yet — after that food may already be cooking, so it needs a person and you should use request_staff_help instead. The tool tells you which case you are in; call it before promising anything.",
    input_schema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description: "The order to cancel, e.g. 'ORD-00007' or '7'. Omit to cancel their most recent one.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_staff_help',
    description:
      "Hand this conversation to a person. Use it for the 'Other' service, and any time a customer needs something you cannot do — a complaint, a refund, a change to a placed order. Summarise what they want; staff get it with their number and decide for themselves whether to write or ring, so tell the customer it has been passed on and nothing about how or when.",
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            "What the customer needs, in one or two plain sentences. Write what they actually said, not an interpretation.",
        },
        urgency: {
          type: 'string',
          description: "'normal' or 'urgent'. Urgent means someone is waiting on a delivery that has gone wrong.",
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'repeat_last_order',
    description:
      "Fill the basket with what they bought last time. Use it the moment a returning customer says anything like \"the usual\", \"same as last week\", \"same again\" — and offer it to a regular before walking them through the aisles. It reports what is no longer available and anything whose price has changed, so you can say both before they agree. The cart must be empty.",
    input_schema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description:
            "A particular past order, e.g. 'ORD-00007' or '7'. Omit for their last one, which is what they almost always mean.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_recent_orders',
    description:
      "Look up this customer's own recent orders, with where each one has got to. Call this whenever they ask about an order — 'where is my order', 'has it left yet', 'did it go through' — and when they want to reorder the same items. Never answer from memory: a status can change between messages.",
    input_schema: {
      type: 'object',
      properties: {
        order_number: {
          type: 'string',
          description:
            "Optional. A specific order the customer named, e.g. 'ORD-00007' or '7'. Omit to list their recent orders.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_buttons',
    description:
      'Send the customer up to 3 tappable reply buttons instead of a plain text reply. Use this for clear yes/no choices such as confirming an order. The body text you pass here IS your reply — do not repeat it afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message text shown above the buttons (max 1024 chars).' },
        buttons: {
          type: 'array',
          description: 'Between 1 and 3 buttons.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short machine id, e.g. "confirm_order".' },
              title: { type: 'string', description: 'Button label, max 20 characters.' },
            },
            required: ['id', 'title'],
            additionalProperties: false,
          },
        },
      },
      required: ['body', 'buttons'],
      additionalProperties: false,
    },
  },
];

/* --------------------------------------------------------------- rendering */

const productView = (p: repo.Product) => {
  const groups = parseOptionSpec(p.options);
  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    unit: p.unit,
    price: money(p.price),
    available: available(p),
    availability: availabilityLabel(p),
    // Only meaningful where a count is kept. A kitchen holds no quantity, and
    // reporting "0 remaining" for a burger reads as out of stock.
    ...(p.trackStock ? { stock_remaining: p.stock } : {}),
    has_photo: Boolean(productImageUrl(p.sku, p.imageUrl)),
    ...(p.description ? { description: p.description } : {}),
    // Choices the customer has to make before this can be added. Offered to the
    // model as readable lines rather than a spec to interpret.
    ...(groups.length > 0
      ? {
          options: describeOptions(groups),
          must_choose: groups.filter((g) => g.mode === 'one').map((g) => g.name),
        }
      : {}),
  };
};

/**
 * Refuses a tool that does not belong to the service the customer chose.
 *
 * The prompt already says which service this is, but a prompt is guidance and
 * this is a gate. Booking a parcel from inside a grocery conversation would
 * create a job against pins nobody shared.
 */
function requireService(phone: string, needed: string): string | null {
  const current = repo.getService(phone);
  if (current === needed) return null;
  return `This is the ${current ?? 'unchosen'} service, not ${needed}. If the customer wants ${needed}, call switch_service — do not make them send "menu".`;
}

/**
 * Which catalogue this customer's searches should see.
 *
 * The chosen outlet's menu while they are ordering food, and the grocery
 * catalogue otherwise — never both. Someone ordering from a chicken counter who
 * asks for "wings" must not be offered a frozen pack from the freezer aisle.
 */
/**
 * Which shop's shelves a search looks at.
 *
 * Null means no shop is settled on, and a search scoped to null finds nothing
 * at all — every product belongs to a shop now, so "belongs to none" is empty
 * rather than meaning the grocery catalogue. Callers must handle null by asking
 * the customer which shop, not by searching anyway.
 *
 * A customer who has chosen nothing falls back to the single grocery, which is
 * what keeps grocery shopping free of a choosing step while there is only one.
 */
function browsingScope(phone: string): number | null {
  const chosen = repo.getBrowsingOutlet(phone);
  if (chosen) return chosen.id;
  return repo.defaultGrocery()?.id ?? null;
}

/** What to tell the model when there is no shop to search. */
const NO_SHOP_SELECTED =
  'No shop is selected and there is more than one to choose from. Call list_outlets and ask the customer which they want, then choose_outlet, before searching.';

/**
 * Refuses a cart that would span two shops.
 *
 * One order is one collection. A burger from one place and a roti from another
 * are two prep times, two pickups and two delivery associates; a kitchen and a
 * grocery are worse still. So the cart holds one shop, and switching is a
 * deliberate act the customer has to agree to rather than something that
 * happens silently.
 *
 * This used to be three rules, because groceries were not a shop and had to be
 * tested for separately. They are a shop now, so there is one rule.
 */
function refuseMixedCart(phone: string, product: repo.Product): string | null {
  const wanted = product.outletId ?? null;
  const current = repo.cartOutletId(phone);
  if (wanted === null || current === null || current === wanted) return null;

  const from = repo.outletById(current);
  const to = repo.outletById(wanted);
  // Two kitchens, two groceries, and one of each are three different
  // conversations, so the reason given is the real one rather than a generic
  // refusal the customer cannot argue with.
  const why =
    from && to && from.kind !== to.kind
      ? 'Shopping and cooked food go out as separate deliveries'
      : to?.kind === 'restaurant'
        ? 'One order comes from one kitchen'
        : 'One order comes from one shop';
  return `The cart is from ${from?.name ?? 'another shop'} and this item is from ${to?.name ?? 'a different shop'}. ${why} — tell them switching clears what they have so far, and only call clear_cart if they agree.`;
}

/** Validates the customer's option picks against what the item offers. */
function resolveOptions(
  product: repo.Product,
  raw: unknown,
): { normalized: string; summary: string } | { error: string } {
  const groups = parseOptionSpec(product.options);
  const picked = Array.isArray(raw) ? raw.map(asString).filter(Boolean) : [];

  const applied = applySelection(groups, picked);
  if (!applied.ok) return { error: applied.error };
  return { normalized: applied.normalized, summary: applied.summary };
}

/** An outlet's minimum order, or the shop's where it sets none. */
function minimumFor(outlet: repo.Outlet | null): number {
  if (outlet && outlet.minOrder > 0) return outlet.minOrder;
  return config.store.minOrderTotal;
}

/** How an outlet is described to the model, with whether it can take an order. */
function outletView(outlet: repo.Outlet) {
  const status = hoursStatus(outlet.hours);
  const open = status.state === 'open' || status.state === 'unknown';
  return {
    code: outlet.code,
    name: outlet.name,
    ...(outlet.cuisine ? { serves: outlet.cuisine } : {}),
    hours: outlet.hours || 'not stated',
    // Two separate reasons a kitchen cannot take an order, and the customer
    // deserves the real one: shut for the night, or open but overwhelmed.
    taking_orders: open && Boolean(outlet.accepting),
    ...(open ? {} : { closed_now: true }),
    ...(open && !outlet.accepting ? { paused: 'Kitchen has paused new orders.' } : {}),
    ...(status.state === 'closed' && status.opensAt ? { opens: status.opensAt } : {}),
    typical_wait: `about ${outlet.prepMinutes} minutes to prepare`,
    delivery_fee: money(outlet.deliveryFee ?? config.store.deliveryFee),
    ...(outlet.minOrder > 0 ? { minimum_order: money(outlet.minOrder) } : {}),
  };
}

function cartView(phone: string) {
  const cart = repo.getCart(phone);
  return {
    ...(cart.outlet ? { ordering_from: cart.outlet.name } : {}),
    items: cart.lines.map((l) => ({
      sku: l.product.sku,
      name: l.product.name,
      unit: l.product.unit,
      ...(l.optionsSummary ? { chosen: l.optionsSummary } : {}),
      quantity: l.qty,
      unit_price: money(l.product.price + l.surcharge),
      line_total: money(l.lineTotal),
    })),
    item_count: cart.itemCount,
    subtotal: money(cart.subtotal),
    delivery_fee: cart.deliveryFee === 0 ? 'free' : money(cart.deliveryFee),
    total: money(cart.total),
    // An outlet may set a higher floor than the shop's own, because sending a
    // delivery associate across town for one soft drink costs more than it earns.
    ...(minimumFor(cart.outlet) > 0 && cart.subtotal < minimumFor(cart.outlet)
      ? {
          below_minimum: `Subtotal is under the ${money(minimumFor(cart.outlet))} minimum${
            cart.outlet ? ` for ${cart.outlet.name}` : ' order'
          }.`,
        }
      : {}),
  };
}

/**
 * How a saved pin is described to the model.
 *
 * Deliberately without the coordinates. The model has no use for them — the
 * delivery associate gets the pin itself — and a number in context is a number that ends up
 * read out loud as "I have you at 6.80714, -58.15536", which tells a customer
 * nothing and sounds like surveillance.
 */
function locationView(pin: repo.SavedPin | null) {
  if (!pin) return null;
  const range = checkRange(pin, config.store.serviceArea);
  return {
    on_file: true,
    where: pin.label || 'a pin dropped on the map, with no place name attached',
    shared: pin.pinnedAt ? describeAge(pin.pinnedAt) : 'at an unknown time',
    // A distance is fine to say out loud, unlike coordinates: "about 3 km
    // away" is something a person can picture.
    ...(range.state === 'unchecked' ? {} : { distance_from_shop: formatDistance(range.distanceKm) }),
    ...(range.state === 'outside'
      ? {
          outside_delivery_area: `This pin is ${formatDistance(range.distanceKm)} from the shop, beyond the ${range.radiusKm} km delivery area, so an order cannot be placed to it. Say plainly that it looks outside the area and that a staff member will confirm on this chat whether a delivery associate can reach them. Do not promise delivery or invent a surcharge.`,
        }
      : {}),
  };
}

const ok = (data: unknown): string => JSON.stringify(data);
const fail = (message: string): string => JSON.stringify({ error: message });

/**
 * Notes a search that found nothing, for the unmet-demand report.
 *
 * Staff are excluded: a dispatcher checking whether something is in stock is not
 * a customer wanting to buy it, and their probing would drown out the signal.
 *
 * Wrapped because this is bookkeeping. A customer asking for peanut butter must
 * get an answer even if the write fails; losing a row of analytics is nothing,
 * losing the reply is the whole conversation.
 */
function recordMiss(phone: string, query: string): void {
  if (config.staffNumbers.includes(phone)) return;
  try {
    repo.logSearchMiss(phone, query);
  } catch (err) {
    console.error('[demand] could not record a search miss:', err);
  }
}

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Models routinely write a literal backslash-n inside a JSON string argument.
 * JSON.parse leaves that as two characters, which WhatsApp then renders as "\n"
 * in the middle of the message. Turn them back into real line breaks.
 */
const unescapeLineBreaks = (s: string): string =>
  s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
const asInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/* --------------------------------------------------------------- execution */

/**
 * Runs one tool call. Every failure is returned as a JSON `error` string rather
 * than thrown, so the model can read what went wrong and recover in-conversation.
 */
export function executeTool(name: string, rawInput: unknown, ctx: ToolContext): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'list_categories': {
      const scope = browsingScope(ctx.phone);
      if (scope === null) return fail(NO_SHOP_SELECTED);
      const cats = repo.listCategories(scope);
      if (cats.length === 0) {
        return fail('This shop has nothing in it. No products have been imported for it yet.');
      }

      // Numbered by the shop, and written down, so the number the customer
      // answers with is the number the shop will resolve. A list renumbered
      // in the retelling sends somebody to the wrong aisle.
      repo.rememberNumberedList(
        ctx.phone,
        'category',
        cats.map((c) => ({ value: c.category, label: c.category })),
      );

      return ok({
        // Written out for the same reason as a shelf: the order and the
        // numbering are the shop's, and they are what the customer is about
        // to answer with.
        lines: cats.map((c, i) => `${i + 1}. ${c.category}`),
        categories: cats.map((c, i) => ({ number: i + 1, name: c.category, items: c.count })),
        say: 'Send the `lines` exactly as they are, one aisle per line. Do not renumber them, reorder them or add prices or products.',
        next: 'Tell them to reply with a number. When they do, call browse_category with it.',
      });
    }

    /**
     * One aisle, numbered.
     *
     * The numbering is the interface. WhatsApp gives three reply buttons and
     * eleven aisles, so buttons were never going to carry this; a numbered
     * list costs nothing, fits any length, and lets somebody answer three
     * lines of it in one message - "1 x2, 4, 9 x3" - which is how a person
     * writes a shopping list anyway.
     */
    case 'browse_category': {
      const scope = browsingScope(ctx.phone);
      if (scope === null) return fail(NO_SHOP_SELECTED);

      const asked = asString(input.category).trim();
      if (!asked) return fail('category is required — the aisle name or the number it had.');

      // A number means the aisle at that position in the list just sent.
      let name = asked;
      if (/^[0-9]+$/.test(asked)) {
        const pick = repo.numberedPick(ctx.phone, Number(asked));
        if (!pick || pick.kind !== 'category') {
          return fail(
            `There is no aisle ${asked} on their screen — either the last list was a shelf rather than the aisles, or it is more than two hours old. Call list_categories again and send it before taking a number.`,
          );
        }
        name = pick.value;
      }

      const items = repo.productsInCategory(scope, name);
      if (items.length === 0) {
        const aisles = repo.listCategories(scope).map((c) => c.category);
        return fail(
          `Nothing is filed under "${name}". The aisles are: ${aisles.join(', ')}. Do not invent one.`,
        );
      }

      repo.rememberNumberedList(
        ctx.phone,
        'product',
        items.map((p) => ({ value: p.sku, label: p.name })),
      );

      return ok({
        category: name,
        // Numbered here rather than left to the model, so the numbers it
        // sends are the numbers the shop will resolve. A list renumbered in
        // the retelling is a customer ordering the wrong thing.
        // The lines, written out, not the parts to build them from.
        //
        // The shop used to hand back a letter, a name, a price and a unit,
        // with a sentence asking for "(a) Name — price (unit)". That is a
        // request, and the brackets came and went with it. Formatting a list
        // is the shop's job: a letter that is sometimes in brackets and
        // sometimes not is a list that looks different every time it is
        // opened, and the labels are what the customer is about to type back.
        lines: items.map((p, i) => {
          const label = itemLabel(i + 1);
          const note = available(p) ? '' : ` — _${availabilityLabel(p)}_`;
          return `(${label}) ${p.name} — ${money(p.price)} (${p.unit})${note}`;
        }),
        // Still itemised, for talking about one of them - "the milk is $780"
        // - but never for rebuilding the list.
        items: items.map((p, i) => ({
          // A letter, not a number. Aisles are numbered; items are lettered,
          // so "1" always means an aisle and "a" always means a thing on a
          // shelf - and a customer who types the first thing they can see
          // cannot land in the wrong list.
          ref: itemLabel(i + 1),
          name: p.name,
          unit: p.unit,
          price: money(p.price),
          ...(available(p) ? {} : { note: availabilityLabel(p) }),
        })),
        say: `Send *${name}* as the heading, then the \`lines\` exactly as they are, one per line. Do not reletter them, reorder them, reword them, add to them or leave any out.`,
        // The way back, said on the list itself rather than left to be
        // guessed. Somebody in the wrong aisle with no visible way out
        // scrolls up hunting for the last message, or gives up.
        next: 'End the list with both: how to answer it — "Put the quantity beside the letter, like *a x2, d x1*" — and how to get out of it: "or type *categories* to see the aisles again". Say the second one every time you send an aisle.',
      });
    }

    /**
     * What they picked, by position.
     *
     * Resolved against the list the shop sent rather than against anything
     * the model remembers, because the two can disagree: a model that
     * renumbers a list while retelling it would add the wrong item with
     * complete confidence, and the customer would not find out until a bag
     * arrived.
     */
    case 'add_picks': {
      const scope = browsingScope(ctx.phone);
      if (scope === null) return fail(NO_SHOP_SELECTED);

      const picks = Array.isArray(input.picks) ? (input.picks as Record<string, unknown>[]) : [];
      if (picks.length === 0) return fail('picks is required — the letters they gave.');

      const shown = repo.numberedList(ctx.phone);
      if (shown.length === 0 || shown[0]!.kind !== 'product') {
        return fail(
          'No aisle is on their screen, so a letter means nothing — either none has been shown, or the last one is more than two hours old. Call browse_category, send the list, and let them answer it.',
        );
      }

      const added: Record<string, unknown>[] = [];
      const refused: Record<string, unknown>[] = [];

      for (const raw of picks) {
        const ref = asString(raw.ref).trim();
        const qty = Math.max(1, asInt(raw.quantity) ?? 1);
        // A letter, or a number from somebody who typed one anyway. Both are
        // resolved against the same list rather than one of them being
        // refused on principle - a customer who writes "3 x2" when the list
        // says "c" has told you exactly what they want.
        const at = /^[0-9]+$/.test(ref) ? Number(ref) : labelPosition(ref);
        if (at === null) {
          refused.push({ ref, reason: 'not a letter from the list' });
          continue;
        }
        const pick = repo.numberedPick(ctx.phone, at);
        if (!pick || pick.kind !== 'product') {
          refused.push({
            ref,
            reason: `the list only went up to ${itemLabel(shown.length)}. Ask which one they meant rather than guessing.`,
          });
          continue;
        }
        const product = repo.getProductBySku(pick.value);
        if (!product) {
          refused.push({ ref, reason: 'that product is no longer in the catalogue' });
          continue;
        }
        const refusal = refuseQty(product, qty);
        if (refusal) {
          refused.push({ ref, name: product.name, reason: refusal });
          continue;
        }
        repo.setCartQty(ctx.phone, product.id, repo.getCartQty(ctx.phone, product.id, asString(raw.options)) + qty, asString(raw.options));
        added.push({ ref, name: product.name, quantity: qty });
      }

      const cart = repo.getCart(ctx.phone);
      return ok({
        added,
        ...(refused.length > 0 ? { could_not_add: refused } : {}),
        cart: {
          items: cart.lines.map((l) => `${l.qty} x ${l.product.name}`),
          subtotal: money(cart.subtotal),
        },
        next: 'Say what went in, in one short line. Then ask whether that is everything, and remind them they can type *categories* for the aisles. Do not list the whole cart back unless they ask.',
      });
    }

    case 'search_products': {
      const query = asString(input.query);
      if (!query) return fail('query is required.');
      const limit = Math.min(Math.max(asInt(input.limit) ?? 8, 1), 15);
      const category = asString(input.category) || undefined;
      const scope = browsingScope(ctx.phone);
      if (scope === null) return fail(NO_SHOP_SELECTED);
      const { results, unmatched } = searchCatalog(query, category, limit, scope);
      if (results.length === 0) {
        recordMiss(ctx.phone, query);
        return ok({
          results: [],
          note: `No match for "${query}". Suggest a related item or offer to check a category — do not invent products.`,
        });
      }

      // Something came back, but not the thing they named — "cassava bread"
      // answered with cassava chips. Worth showing, and worth recording: the
      // shop was asked for something it does not sell.
      if (unmatched.length > 0) {
        recordMiss(ctx.phone, query);
        return ok({
          results: results.map(productView),
          note: `No "${query}" in the catalogue. What follows are near matches, not the thing asked for — say plainly that you do not have it, then offer these as alternatives.`,
        });
      }
      return ok({ results: results.map(productView) });
    }

    case 'search_many': {
      const raw = Array.isArray(input.queries) ? input.queries : [];
      const queries = raw.map(asString).filter(Boolean).slice(0, 20);
      if (queries.length === 0) return fail('queries must contain at least one search phrase.');
      const manyScope = browsingScope(ctx.phone);
      if (manyScope === null) return fail(NO_SHOP_SELECTED);

      // Fewer results each than a single search: a list needs breadth, not depth,
      // and a wall of options per line is unreadable on a phone.
      return ok({
        searches: queries.map((query) => {
          const { results, unmatched } = searchCatalog(query, undefined, 3, manyScope);
          if (results.length === 0) {
            recordMiss(ctx.phone, query);
            return { query, results: [], note: 'No match — say so plainly, do not substitute silently.' };
          }
          if (unmatched.length > 0) {
            recordMiss(ctx.phone, query);
            return {
              query,
              results: results.map(productView),
              note: `No "${query}" in the catalogue — these are near matches only. Do not add one without asking.`,
            };
          }
          return { query, results: results.map(productView) };
        }),
      });
    }

    case 'add_items_to_cart': {
      const raw = Array.isArray(input.items) ? input.items : [];
      if (raw.length === 0) return fail('items must contain at least one product.');
      if (raw.length > 30) return fail('Too many items at once. Add up to 30 and repeat.');

      const added: { sku: string; name: string; chosen?: string; quantity: number }[] = [];
      const failed: { sku: string; reason: string }[] = [];

      for (const entry of raw) {
        const obj = (entry ?? {}) as Record<string, unknown>;
        const sku = asString(obj.sku);
        const qty = asInt(obj.quantity);

        if (!sku || qty === null || qty < 1 || qty > 99) {
          failed.push({ sku: sku || '(missing)', reason: 'needs a sku and a quantity of 1-99' });
          continue;
        }
        const product = repo.getProductBySku(sku);
        if (!product) {
          failed.push({ sku, reason: 'no such product' });
          continue;
        }

        const mixing = refuseMixedCart(ctx.phone, product);
        if (mixing) {
          failed.push({ sku, reason: mixing });
          continue;
        }

        // A dish needing a choice cannot be bulk-added: "a burger" is not an
        // order until someone says which size. Sent back for a single
        // add_to_cart once the customer has picked.
        const chosen = resolveOptions(product, obj.choices);
        if ('error' in chosen) {
          failed.push({ sku, reason: chosen.error });
          continue;
        }

        const target = repo.getCartQty(ctx.phone, product.id, chosen.normalized) + qty;
        const refusal = refuseQty(product, target);
        if (refusal) {
          failed.push({ sku, reason: refusal });
          continue;
        }
        repo.setCartQty(ctx.phone, product.id, Math.min(target, 99), chosen.normalized);
        added.push({
          sku: product.sku,
          name: product.name,
          ...(chosen.summary ? { chosen: chosen.summary } : {}),
          quantity: Math.min(target, 99),
        });
      }

      // A partial result is still useful: report what failed so the customer can
      // be told about those lines specifically, rather than losing the whole list.
      return ok({
        added,
        ...(failed.length > 0 ? { could_not_add: failed } : {}),
        cart: cartView(ctx.phone),
      });
    }

    case 'get_product': {
      const sku = asString(input.sku);
      if (!sku) return fail('sku is required.');
      const p = repo.getProductBySku(sku);
      return p ? ok(productView(p)) : fail(`No active product with SKU "${sku}".`);
    }

    case 'show_product_photo': {
      const sku = asString(input.sku);
      if (!sku) return fail('sku is required.');
      const product = repo.getProductBySku(sku);
      if (!product) return fail(`No active product with SKU "${sku}".`);
      const imageUrl = productImageUrl(product.sku, product.imageUrl);
      if (!imageUrl) {
        return ok({
          sent: false,
          reason: `No photo on file for ${product.name}. Describe it in words instead — do not dwell on the missing picture.`,
        });
      }
      const caption =
        asString(input.caption) || `${product.name} — ${money(product.price)} / ${product.unit}`;
      ctx.outbound.push({ kind: 'image', text: caption, imageUrl });
      return ok({ sent: true, product: product.name, note: 'Photo queued — do not repeat the caption.' });
    }

    case 'view_cart':
      return ok(cartView(ctx.phone));

    case 'switch_service': {
      const wanted = asString(input.service).toLowerCase();
      if (!(SERVICES as readonly string[]).includes(wanted)) {
        return fail(`service must be one of: ${SERVICES.join(', ')}.`);
      }
      const current = repo.getService(ctx.phone);
      if (current === wanted) return fail(`They are already in the ${wanted} service.`);

      const cart = repo.getCart(ctx.phone);
      const action = asString(input.cart_action).toLowerCase();

      // The customer's cart is not ours to throw away, and silently carrying it
      // into another service is worse — one order, one source. So the decision
      // is theirs, and this refuses until they have actually made it.
      if (cart.lines.length > 0 && action !== 'keep' && action !== 'cancel') {
        const what = cart.outlet ? `${cart.outlet.name} order` : 'grocery list';
        return fail(
          `They have ${cart.itemCount} item(s) in a ${what}. Ask first: keep it for later, or drop it? Then call this again with cart_action="keep" or "cancel". Do not decide for them.`,
        );
      }

      let parked: repo.ParkedCart | null = null;
      if (cart.lines.length > 0) {
        if (action === 'keep') parked = repo.parkCart(ctx.phone);
        else repo.clearCart(ctx.phone);
      }

      repo.setService(ctx.phone, wanted);
      // Leaving a menu selected would scope the next search to a restaurant the
      // customer has moved away from. Groceries are the exception: they are a
      // shop now, so moving into grocery shopping means moving into one, and
      // with a single grocery that happens without anybody being asked.
      const grocery = wanted === 'grocery' ? repo.defaultGrocery() : null;
      if (wanted === 'grocery') repo.setBrowsingOutlet(ctx.phone, grocery?.id ?? null);
      else if (wanted !== 'restaurant') repo.setBrowsingOutlet(ctx.phone, null);

      return ok({
        now_in: wanted,
        ...(parked
          ? {
              set_aside: `${parked.itemCount} item(s) from their ${parked.label} order are parked. Tell them it is safe and they can pick it up later.`,
            }
          : {}),
        ...(cart.lines.length > 0 && action === 'cancel' ? { dropped: 'Their previous cart was cleared, as they asked.' } : {}),
        ...(wanted === 'restaurant'
          ? { next: 'Call list_outlets and show the kitchens, numbered.' }
          : wanted === 'grocery' && !grocery
            ? { next: 'Call list_outlets and show the grocery shops, numbered — there is more than one.' }
            : { next: serviceOpening(wanted as never, languageFor(ctx.phone)) }),
        ...(grocery ? { shopping_at: grocery.name } : {}),
      });
    }

    case 'resume_parked_cart': {
      const code = asString(input.outlet_code);
      // No code means the grocery cart, which used to be the cart belonging to
      // no shop. It belongs to a shop now, so "the grocery cart" has to be
      // resolved to one rather than left as an absence.
      const outlet = code ? repo.getOutlet(code) : repo.defaultGrocery();
      if (code && !outlet) return fail(`No outlet with code "${code}".`);

      const parkedCarts = repo.listParkedCarts(ctx.phone);
      if (parkedCarts.length === 0) return fail('Nothing is parked for this customer.');

      const target = outlet ? outlet.id : null;
      const match = parkedCarts.find((p) => p.outletId === target);
      if (!match) {
        return fail(
          `Nothing parked for that. They have: ${parkedCarts.map((p) => p.label).join(', ')}.`,
        );
      }

      if (repo.getCart(ctx.phone).lines.length > 0) {
        return fail(
          'Their cart is not empty. Finish or set that aside first — two carts must not merge into one order.',
        );
      }

      const restored = repo.restoreCart(ctx.phone, target);
      if (restored === 0) {
        return fail(
          `Nothing could be brought back — those items are no longer available. Tell them and start fresh.`,
        );
      }

      // Put them back in the right service and menu, or the restored cart would
      // sit in a conversation that cannot add to it.
      //
      // Decided by the shop's kind, not by whether there is a shop at all.
      // "Has an outlet" used to mean "is a restaurant order"; a grocery cart
      // has one now, and reading it the old way dropped a customer restoring
      // their shopping into the restaurant service.
      repo.setService(ctx.phone, outlet?.kind === 'restaurant' ? 'restaurant' : 'grocery');
      repo.setBrowsingOutlet(ctx.phone, target);

      return ok({
        restored: `${restored} item(s) back from their ${match.label} order.`,
        cart: cartView(ctx.phone),
        ...(restored < match.itemCount
          ? { note: `${match.itemCount - restored} item(s) were dropped — no longer available. Say which, if they ask.` }
          : {}),
      });
    }

    case 'list_outlets': {
      // A grocery customer is shown groceries and a restaurant customer
      // kitchens. One tool, because to the customer it is one question — which
      // shop? — and the agent should not have to pick between two tools to ask
      // it.
      const kind: repo.OutletKind = repo.getService(ctx.phone) === 'grocery' ? 'grocery' : 'restaurant';
      const numbered = numberedOutlets(kind);
      if (numbered.length === 0) {
        return ok({
          outlets: [],
          note:
            kind === 'grocery'
              ? 'No grocery shop is set up yet. Say the shop is not open for grocery orders — do not invent one.'
              : 'No restaurants are set up yet. Offer grocery shopping instead — do not invent outlets.',
        });
      }

      // The numbers come from the same ordering the customer was shown when
      // they picked this service. If the two ever drifted apart, "2" would
      // choose the wrong restaurant and look to everyone like it had worked.
      const views = numbered.map((n) => ({ number: n.number, ...outletView(n.outlet) }));
      return ok({
        outlets: views,
        note: 'The customer has already been shown this list with these numbers. A reply of "2" means the outlet numbered 2 here.',
        ...(views.every((v) => !v.taking_orders)
          ? { closed: 'Nothing is taking orders right now. Say when the nearest one opens rather than listing them all as shut.' }
          : {}),
      });
    }

    case 'choose_outlet': {
      const code = asString(input.code);
      if (!code) return fail('code is required — take it from list_outlets.');

      const outlet = repo.getOutlet(code);
      if (!outlet) return fail(`No outlet with code "${code}". Call list_outlets and use a code from it.`);

      const hours = hoursStatus(outlet.hours);
      if (hours.state === 'closed') {
        return fail(
          `${outlet.name} is not cooking right now${hours.opensAt ? ` — they start at ${hours.opensAt}` : ''}. Say so and offer somewhere that is open.`,
        );
      }
      if (!outlet.accepting) {
        return fail(
          `${outlet.name} has paused new orders — the kitchen is backed up. Tell the customer plainly and offer an alternative.`,
        );
      }

      // Switching away from a part-built order of someone else's food would
      // silently lose it, so the swap is refused until the cart is dealt with.
      const current = repo.cartOutletId(ctx.phone);
      if (current !== null && current !== outlet.id) {
        const from = repo.outletById(current);
        return fail(
          `There is still a ${from?.name ?? 'another shop'} order in the cart. Ask whether to drop it before switching to ${outlet.name}, and only call clear_cart if they say yes.`,
        );
      }

      repo.setBrowsingOutlet(ctx.phone, outlet.id);
      const menu = repo.searchProducts('', undefined, 60, outlet.id);
      return ok({
        ordering_from: outletView(outlet),
        menu_categories: [...new Set(menu.map((m) => m.category))],
        note: 'Searches now return this menu only. Show a few categories or ask what they feel like rather than listing everything.',
      });
    }

    case 'leave_outlet': {
      const outlet = repo.getBrowsingOutlet(ctx.phone);
      if (repo.cartOutletId(ctx.phone) !== null) {
        return fail(
          `The cart still holds a ${outlet?.name ?? 'restaurant'} order. Deal with that first — check it out, or ask before clearing it.`,
        );
      }
      // Back to the grocery rather than to nothing. Clearing the selection
      // outright used to mean "the house catalogue"; it now means no shop at
      // all, and the next search would find nothing.
      const grocery = repo.defaultGrocery();
      repo.setBrowsingOutlet(ctx.phone, grocery?.id ?? null);
      return ok({
        left: outlet?.name ?? null,
        note: grocery
          ? `Back to shopping at ${grocery.name}.`
          : 'No shop is selected now. Call list_outlets and ask which grocery they want.',
      });
    }

    case 'add_to_cart':
    case 'update_cart_item': {
      const sku = asString(input.sku);
      const qty = asInt(input.quantity);
      if (!sku) return fail('sku is required.');
      if (qty === null) return fail('quantity must be a whole number.');

      const isAdd = name === 'add_to_cart';
      if (isAdd && qty < 1) return fail('quantity must be at least 1. To remove an item use update_cart_item with quantity 0.');
      if (qty < 0 || qty > 99) return fail('quantity must be between 0 and 99.');

      const product = repo.getProductBySku(sku);
      if (!product) return fail(`No active product with SKU "${sku}".`);

      const mixing = refuseMixedCart(ctx.phone, product);
      if (mixing) return fail(mixing);

      const chosen = resolveOptions(product, input.choices);
      if ('error' in chosen) return fail(chosen.error);

      const target = isAdd ? repo.getCartQty(ctx.phone, product.id, chosen.normalized) + qty : qty;
      if (target > 99) return fail('Cart lines are capped at 99 units. Ask the customer to split the order or call the store.');

      if (target > 0) {
        const refusal = refuseQty(product, target);
        if (refusal) return fail(refusal);
      }

      repo.setCartQty(ctx.phone, product.id, target, chosen.normalized);
      return ok({
        updated: {
          sku: product.sku,
          name: product.name,
          ...(chosen.summary ? { chosen: chosen.summary } : {}),
          quantity: target,
        },
        cart: cartView(ctx.phone),
      });
    }

    case 'clear_cart': {
      repo.clearCart(ctx.phone);
      return ok({ cleared: true, cart: cartView(ctx.phone) });
    }

    case 'get_customer_details': {
      const id = repo.getIdentity(ctx.phone);
      const missing = [!id.name && 'name', !id.location && 'location pin'].filter(Boolean);
      return ok({
        name: id.name,
        // Doorstep detail, not the delivery point. Can be empty on a good order.
        address: id.address,
        location_pin: locationView(id.location),
        contact_phone: id.contactPhone ?? ctx.phone,
        // A hint from WhatsApp, not a fact. Offer it; never deliver on it.
        whatsapp_profile_name: id.profileName,
        identity_confirmed: id.confirmed,
        missing,
        next: !id.location
          ? 'No pin on file. Call request_location — an order cannot be placed without one.'
          : id.confirmed
            ? 'Identity already confirmed in this conversation.'
            : id.name
              ? 'Read the name and the saved place back, get a yes, then call confirm_identity.'
              : 'Ask who the delivery is for, then call confirm_identity.',
      });
    }

    case 'request_location': {
      const body = unescapeLineBreaks(asString(input.body));
      if (!body) return fail('body is required — say why you need the pin.');

      const existing = repo.getIdentity(ctx.phone).location;

      // One sentence, appended here rather than left to the model.
      //
      // It is the whole answer to a customer who is not at the address they
      // want delivered to. WhatsApp's location screen is not only "send where
      // I am": the map can be dragged and the pin follows it, and a place can
      // be searched for. Almost nobody knows that unless they are told, and a
      // model that paraphrases it four times out of five loses the fifth
      // order. So it is fixed text, in every language, on every ask.
      const hint = t('pin_elsewhere', languageFor(ctx.phone));
      const asked = body.includes(hint) ? body : `${body}${chr10}${chr10}${hint}`;
      ctx.outbound.push({ kind: 'location_request', text: asked.slice(0, 1024) });
      return ok({
        sent: true,
        ...(existing ? { note_already_on_file: locationView(existing) } : {}),
        next: 'The button has already been sent — do not repeat its text. Carry on with your reply about their order as normal; it goes out alongside the button. Their pin arrives as a separate message and is saved for you, so wait for it rather than asking again.',
      });
    }

    case 'read_location_link': {
      const text = typeof input.text === 'string' ? input.text : '';
      // The shop's own centre, used only to recover a short plus code — one
      // that says where somebody is relative to here. Without it those are
      // refused rather than resolved to a place in another region.
      const parsed = readLocationSync(text, { near: config.store.serviceArea ?? null });

      if (!parsed.found) {
        return ok({
          found: false,
          reason: parsed.reason,
          next: 'Nothing usable was in that message. Ask them to share a pin with the location button, or give the address in words — do not guess at a place from the text.',
        });
      }

      const doorstep = isDoorstep(parsed);
      const range = checkRange(parsed.point, config.store.serviceArea);

      if (!doorstep) {
        // A town, or the centre of a map view. Precise-looking coordinates for
        // somewhere nobody can be sent. Saving this would put a map link on an
        // associate's card pointing confidently at the middle of a village.
        return ok({
          found: true,
          precision: parsed.precision,
          place: parsed.label || 'an area, with no place name',
          ...(range.state === 'unchecked' ? {} : { distance_from_shop: formatDistance(range.distanceKm) }),
          // Said here too. An area 35 km out is outside the delivery area
          // whether or not it is a doorstep, and that is the more useful thing
          // to tell somebody before they are asked to pin it exactly.
          ...(range.state === 'outside'
            ? {
                outside_delivery_area: `That area is ${formatDistance(range.distanceKm)} from the shop, beyond the ${range.radiusKm} km delivery area. Say that first — asking them to pin it exactly, then refusing the order, wastes their time. Say plainly that it looks outside the area and that a staff member will confirm on this chat. Do not promise delivery or invent a surcharge.`,
              }
            : {}),
          saved: false,
          next: `That points at ${parsed.label || 'a general area'} rather than a doorstep, so it cannot be used as the delivery pin. Tell them you can see roughly where they mean, name it back to them, and ask for the exact spot — the location button, or the house and street in words.`,
        });
      }

      if (input.save === true) {
        const saved = repo.saveLocationPin(ctx.phone, {
          latitude: parsed.point.latitude,
          longitude: parsed.point.longitude,
          label: parsed.label,
        });
        return ok({
          found: true,
          precision: parsed.precision,
          place: parsed.label || 'the point in the link',
          saved: true,
          location_pin: locationView(saved),
          next: 'Saved as their delivery pin. Read the place back to them so they can correct it if it is wrong.',
        });
      }

      return ok({
        found: true,
        precision: parsed.precision,
        place: parsed.label || 'the point in the link',
        ...(range.state === 'unchecked' ? {} : { distance_from_shop: formatDistance(range.distanceKm) }),
        ...(range.state === 'outside'
          ? {
              outside_delivery_area: `That point is ${formatDistance(range.distanceKm)} from the shop, beyond the ${range.radiusKm} km delivery area. Say plainly that it looks outside the area and that a staff member will confirm on this chat. Do not promise delivery or invent a surcharge.`,
            }
          : {}),
        saved: false,
        next: 'Read the place back to them and ask whether that is where the delivery goes. Call this again with save: true once they say yes.',
      });
    }

    case 'confirm_identity': {
      const id = repo.getIdentity(ctx.phone);
      if (!id.name) return fail('Nothing to confirm yet — save a delivery name first.');
      if (!id.location) {
        return fail('No location pin on file. Call request_location and wait for the pin first.');
      }
      repo.confirmIdentity(ctx.phone);
      return ok({ confirmed: true, name: id.name, location_pin: locationView(id.location) });
    }

    case 'customer_record': {
      const record = repo.customerRecord(ctx.phone, 20);
      return ok({
        phone: record.phone,
        name: record.name,
        whatsapp_profile_name: record.profileName,
        address: record.address,
        location_pin: locationView(record.location),
        contact_phone: record.contactPhone ?? record.phone,
        order_count: record.orderCount,
        total_spent: money(record.totalSpend),
        first_order: record.firstOrderAt,
        last_order: record.lastOrderAt,
        orders: record.orders.map((o) => ({
          order_number: o.orderNo,
          placed_at: o.placedAt,
          status: o.status,
          total: money(o.total),
          items: o.items.map((i) => `${i.qty} x ${i.name}`),
        })),
      });
    }

    case 'save_customer_details': {
      const nameField = asString(input.name);
      const address = asString(input.address);
      const contactPhone = asString(input.contact_phone);
      if (!nameField && !address && !contactPhone) {
        return fail('Pass at least one of name, address or contact_phone.');
      }
      if (contactPhone && contactPhone.replace(/[^0-9]/g, '').length < 7) {
        return fail('That does not look like a usable telephone number. Ask them to repeat it.');
      }
      // No length floor any more: with a pin carrying the location, "green gate,
      // upstairs" is a complete and useful answer where a street address was
      // once the only thing standing between the delivery associate and the wrong house.
      const saved = repo.saveCustomer(ctx.phone, {
        ...(nameField ? { name: nameField } : {}),
        ...(address ? { address } : {}),
        ...(contactPhone ? { contactPhone } : {}),
      });

      // Details the customer has just stated in their own words are confirmed by
      // definition, and a pin they shared themselves is too. Only details
      // already on file need reading back.
      if (saved.name && saved.location) repo.confirmIdentity(ctx.phone);

      return ok({
        saved: {
          name: saved.name,
          address: saved.address,
          contact_phone: saved.contactPhone,
          location_pin: locationView(saved.location),
        },
        identity_confirmed: repo.getIdentity(ctx.phone).confirmed,
        ...(saved.location
          ? {}
          : { next: 'Still no location pin. Call request_location before trying to place the order.' }),
      });
    }

    case 'place_order': {
      const paymentMethod = asString(input.payment_method);
      const allowed = config.paymentMethods.map((m) => `${m}_on_delivery`);
      if (!allowed.includes(paymentMethod)) {
        return fail(
          `This shop only takes ${config.paymentMethods.join(' or ')} on delivery, so payment_method must be one of: ${allowed.join(', ')}.`,
        );
      }

      // Nobody on the road, so nothing can be delivered.
      //
      // Refused here and not left to the prompt, because this is the one
      // refusal that costs nothing to get right and a great deal to get
      // wrong: an order taken with no associate on duty is food packed for a
      // counter, sitting at `ready` while the customer waits and nobody can
      // tell them why. The shop being open is a different fact - it can be
      // wide open with nobody out.
      if (!repo.anyoneOnDuty()) {
        return fail(
          'Cannot place the order — no delivery associate is on duty, so nothing can be delivered right now. Tell them kindly: there is nobody out on deliveries at the moment, so you cannot get an order to them just yet. Do not say when, you do not know. Offer to hold their list with park_cart and invite them to message again.',
        );
      }

      const customer = repo.getIdentity(ctx.phone);
      if (!customer.name) {
        return fail(
          "Cannot place the order yet — still need the customer's name. Ask who the delivery is for, then call save_customer_details.",
        );
      }
      // Somewhere to go. A pin or an address in words - either is an answer,
      // and only having neither is a refusal.
      //
      // This used to demand the pin and accept an address solely as a
      // concession, unlocked by a `without_pin` flag the model could set once
      // the customer had been asked and said no. Somebody who simply typed
      // their address was asked for a pin anyway, again, and the order did not
      // exist until they produced one - so the kitchen had not heard of it and
      // the customer was answering the same question twice.
      //
      // It also disagreed with the card that gets driven from, where a written
      // address BEATS a pin and the pin is not even printed beside it. The
      // shop cannot hold both positions. An address is what the customer meant
      // to say; the pin is where they happened to be standing.
      //
      // The pin is still worth asking for and the prompt still asks, because
      // it is the only thing the delivery radius can be measured against. It
      // is a question now, not a gate.
      if (!customer.location && !(customer.address ?? '').trim()) {
        return fail(
          'Cannot place the order with neither a pin nor a written address — the delivery associate would have nowhere to go and nothing to read out on the phone. Ask where it is going, save it with save_customer_details, or call request_location, then try again.',
        );
      }
      // Outside the delivery area. Refused here for the same reason a missing
      // pin is: once the van has gone, nobody can undo it.
      //
      // Unmeasurable without a pin, which is the real cost of allowing one
      // through: a written address cannot be checked against the delivery
      // radius. The associate reading it before setting off is what is left.
      const range = customer.location
        ? checkRange(customer.location, config.store.serviceArea)
        : { state: 'unchecked' as const, distanceKm: null, radiusKm: 0 };
      if (range.state === 'outside') {
        return fail(
          `Cannot place the order — the pin is ${formatDistance(range.distanceKm)} from the shop, outside the ${range.radiusKm} km delivery area. Tell the customer plainly that it looks outside the area and that a staff member will confirm on this chat whether a delivery associate can reach them. Do not promise delivery, and do not offer a surcharge. If they say the pin is wrong, call request_location for a new one.`,
        );
      }

      // Goods go to a person at a place. Confirming who and where is not
      // something to leave to the model's discretion.
      if (!customer.confirmed) {
        const where =
          customer.location?.label || customer.address || 'the pin they shared';
        return fail(
          `Identity not confirmed. Read back "${customer.name}, ${where}", get a clear yes, then call confirm_identity before ordering.`,
        );
      }

      const cart = repo.getCart(ctx.phone);
      if (cart.lines.length === 0) return fail('The cart is empty.');
      const minimum = minimumFor(cart.outlet);
      if (minimum > 0 && cart.subtotal < minimum) {
        return fail(`Subtotal ${money(cart.subtotal)} is below the ${money(minimum)} minimum${cart.outlet ? ` for ${cart.outlet.name}` : ' order'}. Invite the customer to add more.`);
      }

      // Settled before the order is written, because both fields are about to
      // be stored and the card is not the only place they are read.
      const deliveryAddress = asString(input.delivery_address) || customer.address || '';
      // Capped rather than trusted. A note is a line read at a gate; left open
      // it collected whole briefings, including a second address that
      // contradicted the first.
      const noteAsked = asString(input.delivery_note).slice(0, 120);
      // A note that only repeats the address is dropped here rather than at
      // the card, so it is never in the record either. The tool schema asks
      // the model not to do this; this is what happens when it does anyway.
      const deliveryNote = saysTheSamePlace(deliveryAddress, noteAsked) ? '' : noteAsked;

      // When they asked for it, checked rather than trusted.
      //
      // A time in the past is the commonest way this goes wrong: a customer
      // says "five o'clock" at six, and the shop would file an order wanted
      // an hour ago and sort it to the front of the queue for ever.
      const wantedRaw = asString(input.deliver_at).trim();
      const wantedNote = asString(input.deliver_note).trim().slice(0, 60);
      let deliverAt = '';
      if (wantedRaw) {
        const at = new Date(wantedRaw);
        if (Number.isNaN(at.getTime())) {
          return fail(
            'deliver_at is not a time I can read. Pass a full ISO timestamp, or leave it out and say it in deliver_note instead.',
          );
        }
        // Five minutes of slack, for the gap between them saying it and you
        // writing it down.
        if (at.getTime() < Date.now() - 5 * 60_000) {
          return fail(
            'That time has already passed. Ask whether they meant later today or tomorrow — do not file an order wanted in the past.',
          );
        }
        if (at.getTime() > Date.now() + 7 * 24 * 3600_000) {
          return fail(
            'That is more than a week out, which this shop does not take. Say so plainly and offer the nearest day it will take.',
          );
        }
        deliverAt = at.toISOString();
      }

      try {
        const order = repo.placeOrder({
          phone: ctx.phone,
          customerName: customer.name,
          // This order's own address. Saved per order rather than on the
          // customer, because an order for somebody else goes somewhere else -
          // and writing it to the customer would overwrite the buyer's own
          // address with a friend's.
          //
          // Without this the model had one slot for two different addresses
          // and did the only thing it could: it put one of them in the field
          // and the other in the free-text note, so the card carried two
          // delivery addresses that disagreed.
          address: deliveryAddress,
          contactPhone: customer.contactPhone ?? ctx.phone,
          deliveryNote,
          deliverAt,
          deliverNote: wantedNote,
          paymentMethod,
          location: customer.location,
          recipientName: asString(input.recipient_name),
          recipientPhone: asString(input.recipient_phone),
          recipientPinShared: input.recipient_pin_shared === true,
        });
        // Fire-and-forget: the shop needs to know immediately, but the customer
        // should not wait on a Graph API round trip to see their confirmation.
        void announceNewOrder(order.orderNo).catch((err) =>
          console.error('[tools] order announcement failed:', err),
        );

        // Deliberately no name, address, pin or telephone number in here.
        //
        // They were all handed back before, and the model did the natural
        // thing with them: read them out. A customer who has just typed their
        // address does not need it recited, and a receipt that repeats where
        // somebody lives is a receipt they would rather not have on a shared
        // phone. The order has them; this reply does not need them.
        // What is deliberately absent matters more here than what is present.
        //
        // No name, address, pin or telephone number: the customer typed those
        // a moment ago and the model read them straight back, which tells them
        // nothing and puts their address on the screen of a shared phone.
        //
        // No money either, and no payment method. Nothing is owed on an order
        // nobody has accepted yet — the shop may refuse it, the kitchen may be
        // shut — and a sum quoted beside a payment method reads as a bill. It
        // belongs in the message that says the order is going ahead.
        //
        // The prices were in the question the customer answered to get here,
        // one message earlier, so nothing is hidden by leaving them out.
        // Written here rather than left to the model, and handed over as the
        // words to send rather than as a brief.
        //
        // This is the one message in the conversation that has to be exact.
        // Everything the model was free to add to it was something it did not
        // know: that a kitchen had the order, that it would take twenty
        // minutes, what was owed and where to pay it. None of that is true at
        // the moment an order is placed, and a customer reading it believes
        // the shop, not the model.
        //
        // The shop that confirms is named only when the customer chose it by
        // name. With a single grocery they are never shown which shop they are
        // in, so naming it here would introduce one in the same breath as
        // telling them to wait for it.
        const whoConfirms =
          cart.outlet && cart.outlet.kind === 'restaurant' ? cart.outlet.name : 'the shop';

        return ok({
          placed: true,
          received_not_confirmed: true,
          order_number: order.orderNo,
          say: `Got it — ${order.orderNo} received, but not yet confirmed. The moment ${whoConfirms} confirms it, we'll let you know.`,
          next: [
            'Send `say` as your whole reply, word for word.',
            'If the customer has been writing in another language, send it in theirs — that is the only thing you may change.',
            'Add nothing to it. Not the total, not the delivery fee, not how or where they pay: nothing is owed on an order nobody has confirmed, and a sum beside a payment method reads as a bill. That comes with the confirmation.',
            'Not their name, address, map pin or telephone number either — they gave you those a moment ago.',
            'And no preparation time and no delivery time. What they are waiting for is the shop confirming the order, not the cooking.',
          ].join(' '),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Could not place the order.');
      }
    }

    /**
     * The delivery price, and the question that has to come before it.
     *
     * Two calls rather than one, and the shape of the tool is what enforces
     * it: looking a place up tells the model what to ASK, and nothing is
     * stored. Only a second call carrying `confirmed` sets the zone, and only
     * then is there a figure to say out loud.
     *
     * The reason is not politeness. Spelling is matched on sound, so the shop
     * will cheerfully read "Metin Meer Zorg" as Meten-Meer-Zorg and charge
     * $4,000 — and two villages called Golden Grove sit $800 apart on
     * different corridors. A quote nobody agreed to is a quote the delivery
     * associate has to defend at a gate, with the order already in the bag.
     */
    case 'delivery_zone': {
      if (zoneCount() === 0) {
        return ok({
          priced: false,
          note: `This shop has no zone tariff, so delivery is the flat ${money(config.store.deliveryFee)}. Nothing to confirm — carry on.`,
        });
      }

      const confirming = input.confirmed === true;
      const place = asString(input.place).trim();

      if (confirming) {
        if (!place) {
          return fail('To confirm a zone, pass `place` exactly as the shop gave it to you.');
        }
        const known = findZone(place);
        if (known.kind !== 'found') {
          return fail(
            `"${place}" is not a place in the tariff. Look it up with \`text\` first and use the name the shop gives back.`,
          );
        }
        // A parcel's zone belongs to the parcel, not to the customer.
        //
        // A parcel goes where the customer is not. Writing the recipient's
        // zone onto the customer record would price their own shopping next
        // week as if they lived at the far end of a delivery they paid for
        // once - and nobody would connect the two.
        const forParcel = repo.getService(ctx.phone) === 'parcel';
        if (forParcel) repo.setParcelZone(ctx.phone, known.match.place);
        else repo.setDeliveryZone(ctx.phone, known.match.place);

        return ok({
          confirmed: true,
          place: known.match.place,
          zone: known.match.zone,
          delivery_fee: money(known.match.fee),
          say: forParcel
            ? `Delivery to ${known.match.place} is ${money(known.match.fee)}.`
            : `Delivery to ${known.match.place} is ${money(known.match.fee)}.`,
          next: forParcel
            ? 'Now you may quote it. create_parcel_job will charge it.'
            : 'Now you may quote it. It is already in the cart total.',
        });
      }

      const text = asString(input.text).trim();
      if (!text) return fail('Pass `text` — whatever the customer said about where they are.');

      const found = findZone(text);

      if (found.kind === 'unknown') {
        return ok({
          priced: false,
          matched: null,
          note: `Nothing in the tariff is close to "${text}". Ask which village or area it is, in their own words — do not guess, and do not quote a delivery charge yet.`,
        });
      }

      if (found.kind === 'ambiguous') {
        return ok({
          priced: false,
          // Said as a question, with the prices, because the difference
          // between them is the whole reason this is being asked.
          ask: found.candidates.map((c) => `${c.place} (${describeZone(c)})`),
          note: `More than one place fits "${text}" and they are not the same price. Ask which one, naming them. Quote nothing until they answer.`,
        });
      }

      const m = found.match;
      return ok({
        priced: true,
        matched: m.place,
        zone: m.zone,
        // Deliberately NOT called the delivery fee here. It is what the fee
        // WOULD be, and handing the model a field called `delivery_fee`
        // before the place is agreed is how it ends up in a sentence.
        would_be: money(m.fee),
        spelling: m.exact ? 'as they wrote it' : 'a near spelling, matched on sound',
        say: `Read the place back and get a yes: "that's ${m.place}, is that right?"`,
        next: `Say nothing about the price yet. When they agree, call delivery_zone again with place "${m.place}" and confirmed true.`,
      });
    }

    /**
     * One end of a parcel, written down and then agreed.
     *
     * A parcel needs six facts - two names, two addresses, two numbers - and
     * nobody gives six facts in one message. They used to live in the model's
     * context until `create_parcel_job` was called, which meant a
     * conversation that wandered, or a reply an hour later, started again.
     *
     * Each half is stored the moment it arrives and marked agreed only when
     * the customer has had it read back. The reason for the second step is
     * that a parcel is the one order where getting a name wrong cannot be
     * undone by apologising: it has already gone somewhere.
     */
    case 'parcel_party': {
      const side = asString(input.side) === 'recipient' ? 'recipient' : 'sender';
      const draft = repo.getParcelDraft(ctx.phone);
      const other = side === 'sender' ? 'recipient' : 'sender';

      if (input.confirmed === true) {
        const held = draft[side];
        const missing = (['name', 'address', 'phone'] as const).filter((f) => !held[f]);
        if (missing.length > 0) {
          return fail(
            `Nothing to confirm yet for the ${side} — still missing ${missing.join(', ')}. Ask for it, save it, then confirm.`,
          );
        }
        repo.saveParcelParty(ctx.phone, side, {});
        const both = repo.getParcelDraft(ctx.phone);
        const ready = (['name', 'address', 'phone'] as const).every((f) => both[other][f]);
        return ok({
          confirmed: side,
          sender: both.sender,
          recipient: both.recipient,
          next: ready
            ? 'Both ends are agreed. Ask what is in the parcel, then call create_parcel_job.'
            : `Now the ${other}. Ask for their name, address and telephone number in one message.`,
        });
      }

      const saved = repo.saveParcelParty(ctx.phone, side, {
        name: asString(input.name),
        address: asString(input.address),
        phone: asString(input.phone),
      });
      const missing = (['name', 'address', 'phone'] as const).filter((f) => !saved[f]);

      if (missing.length > 0) {
        return ok({
          side,
          have: saved,
          note: `Still need the ${side}'s ${missing.join(' and ')}. Ask for just that - do not ask again for what is already here.`,
        });
      }

      return ok({
        side,
        have: saved,
        // Read back as the shop will print it, so what the customer agrees to
        // is what the delivery associate ends up holding.
        read_back: [
          side === 'sender' ? '*From:*' : '*To:*',
          saved.name,
          saved.address,
          `📞 +${saved.phone}`,
        ].join(' '),
        say: `Show them the three lines and ask "is that right?" with a Yes and a Change it button.`,
        next: `When they say yes, call parcel_party again with side "${side}" and confirmed true.`,
      });
    }

    case 'parcel_status': {
      const wrong = requireService(ctx.phone, 'parcel');
      if (wrong) return fail(wrong);

      const draft = repo.getParcelDraft(ctx.phone);
      const quote = draft.pickup && draft.destination ? quoteParcel(draft.pickup, draft.destination) : null;

      // Both halves, so nothing already agreed gets asked for twice. The
      // commonest way to lose a parcel booking is to make somebody repeat
      // themselves at the fourth question.
      const half = (p: repo.ParcelParty): string => {
        const missing = (['name', 'address', 'phone'] as const).filter((f) => !p[f]);
        if (missing.length === 3) return 'nothing yet';
        if (missing.length > 0) return `${p.name || 'unnamed'} — still needs ${missing.join(' and ')}`;
        return `${p.name}, ${p.address}, +${p.phone}`;
      };

      const zoneHeld = draft.zone ? zoneFeeFor(draft.zone) : null;

      return ok({
        sender: half(draft.sender),
        recipient: half(draft.recipient),
        contents: draft.contents || 'not said yet',
        ...(zoneHeld
          ? { delivery_fee: money(zoneHeld.fee), priced_by: `${zoneHeld.place} (${zoneHeld.zone})` }
          : {
              delivery_fee:
                "not agreed yet — confirm the recipient's area with delivery_zone",
            }),
        pickup_pin: draft.pickup ? `on file${draft.pickup.label ? ` (${draft.pickup.label})` : ''}` : 'not yet',
        destination_pin: draft.destination
          ? `on file${draft.destination.label ? ` (${draft.destination.label})` : ''}`
          : 'not yet',
        ...(quote === null
          ? { next: 'Ask for whichever pin is missing with request_location, one at a time.' }
          : 'tooFar' in quote
            ? {
                too_far: `${formatDistance(quote.distanceKm)} apart, over the ${quote.limitKm} km limit. Say we cannot cover that distance and offer to pass it to staff.`,
              }
            : quote.priced
              ? { distance: formatDistance(quote.distanceKm), fee: money(quote.fee), how: quote.explanation }
              : { distance: formatDistance(quote.distanceKm), fee: 'not priced', note: quote.reason }),
      });
    }

    case 'create_parcel_job': {
      const wrong = requireService(ctx.phone, 'parcel');
      if (wrong) return fail(wrong);

      // Same rule as a delivery: a parcel nobody can uplift is a promise the
      // shop cannot keep, and a sender waiting at a door is worse than a
      // customer waiting for groceries.
      if (!repo.anyoneOnDuty()) {
        return fail(
          'Cannot book the parcel — no delivery associate is on duty, so nothing can be uplifted right now. Tell them kindly, say nothing about when, and invite them to message again.',
        );
      }

      const contents = asString(input.contents) || repo.getParcelDraft(ctx.phone).contents;

      // What is inside is checked first, before any question of who or where.
      //
      // Refusing to carry a weapon must not depend on whether a name was
      // supplied: somebody booking one and leaving a field blank would
      // otherwise be told about the field, try again with it filled in, and
      // only then be refused.
      const allowed = checkContents(contents);
      if (!allowed.allowed) return fail(allowed.reason);

      // Whatever was agreed earlier stands in for what is not passed here.
      //
      // The two halves were collected and confirmed one at a time through
      // `parcel_party`, so making the model repeat all six facts in this call
      // is both pointless and a chance to get one of them wrong - and a name
      // retyped from memory is exactly the sort of thing that sends a parcel
      // to the wrong door.
      const held = repo.getParcelDraft(ctx.phone);
      const senderName = asString(input.sender_name) || held.sender.name;
      const senderPhone =
        asString(input.sender_phone).replace(/[^0-9+]/g, '') || held.sender.phone;
      const recipientName = asString(input.recipient_name) || held.recipient.name;
      const recipientPhone =
        asString(input.recipient_phone).replace(/[^0-9+]/g, '') || held.recipient.phone;

      // Both ends are asked for and neither is assumed.
      //
      // Whoever is booking is not necessarily the sender: an office arranges a
      // courier, a daughter sends something from her mother's house, a shop
      // books a run for a customer. Taking the WhatsApp number as the sender's
      // sends an associate to a door where nobody is expecting them, with a
      // number that rings somewhere else entirely.
      if (!senderName) {
        return fail(
          'sender_name is required. Ask who the parcel is being collected from — it is not necessarily the person you are talking to.',
        );
      }
      if (senderPhone.replace(/\D/g, '').length < 7) {
        return fail(
          'sender_phone is required and must be a usable number — the delivery associate rings it to collect. Ask for it rather than assuming the number they are writing from.',
        );
      }
      if (!recipientName) return fail('recipient_name is required — a delivery associate delivers to a person.');
      if (recipientPhone.replace(/\D/g, '').length < 7) {
        return fail('recipient_phone must be a usable number — the delivery associate rings it on arrival.');
      }

      const draft = repo.getParcelDraft(ctx.phone);
      const pickupNote = asString(input.pickup_note) || held.sender.address;
      const destinationNote = asString(input.destination_note) || held.recipient.address;

      // Each end needs a pin or an address in words. A pin is better and is
      // asked for first, but somebody booking a parcel is often standing at
      // neither end of it and cannot drop a pin on a door they are not at.
      // Refusing those bookings loses them; the associate reads the address
      // and rings.
      if (!draft.pickup && !pickupNote) {
        return fail(
          'Nothing says where to uplift it. Ask for a pin with request_location, or take the address in words and pass it as pickup_note.',
        );
      }
      if (!draft.destination && !destinationNote) {
        return fail(
          'Nothing says where it is going. Ask for a pin with request_location, or take the address in words and pass it as destination_note.',
        );
      }

      // The agreed zone first, then distance, then nothing.
      //
      // A parcel used to be priced only by the distance between two pins -
      // which needs two pins, and since an address alone became enough to
      // book one, most parcels have fewer than two. So they went out
      // unpriced, and ORD-00007 was booked with the customer told only that
      // the associate would confirm the cost at the uplift.
      //
      // The zone is the better answer anyway, and it is already agreed: the
      // recipient's address is read back during booking, and that read-back
      // is where a zone comes from. It needs no pins, and it is the same
      // tariff every other delivery is priced from.
      const zoned = held.zone ? zoneFeeFor(held.zone) : null;

      const quote =
        draft.pickup && draft.destination
          ? quoteParcel(draft.pickup, draft.destination)
          : flatParcelQuote();
      // Still refused on distance where both pins exist, zone or no zone: a
      // tariff that happens to name a village thirty kilometres away does not
      // make the trip possible.
      if ('tooFar' in quote) {
        return fail(
          `${formatDistance(quote.distanceKm)} is beyond the ${quote.limitKm} km we cover. Do not book it — offer to pass it to staff instead.`,
        );
      }

      const fee = zoned ? zoned.fee : quote.priced ? quote.fee : 0;
      // Every detail from this booking, and nothing from the customer record.
      //
      // A name or number saved from a past delivery is a different
      // transaction's fact. Falling back to it is how an associate is sent to
      // last month's address with last month's number, confidently.
      const job = repo.createParcelJob({
        phone: ctx.phone,
        senderName,
        pickup: draft.pickup,
        // Capped, like the delivery note. An address is a line read at a gate;
        // left open these collected whole briefings, with numbers and names
        // the card prints for itself immediately below them.
        pickupAddress: pickupNote.slice(0, 160),
        destination: draft.destination,
        destinationAddress: destinationNote.slice(0, 160),
        recipientName,
        recipientPhone,
        contents,
        fee,
        contactPhone: senderPhone,
      });

      // The draft is spent. Left behind, the next parcel would start with the
      // last one's pins already filled in.
      repo.clearParcelDraft(ctx.phone);

      void announceNewOrder(job.orderNo).catch((err) =>
        console.error('[tools] parcel announcement failed:', err),
      );
      // Offered to associates the moment it is booked, rather than waiting for
      // a confirmation step a parcel has nobody to perform. There is no
      // kitchen here: the contents were checked, the distance was checked and
      // the fee is set, so the job is ready by the time it exists.
      void offerParcel(job.orderNo).catch((err) =>
        console.error('[tools] could not offer the parcel:', err),
      );

      return ok({
        booked: true,
        job_number: job.orderNo,
        distance: formatDistance(quote.distanceKm),
        ...(zoned
          ? {
              fee: money(zoned.fee),
              priced_by: `${zoned.place} (${zoned.zone})`,
              payment: 'Cash, collected on delivery.',
            }
          : quote.priced
            ? { fee: money(fee), payment: 'Cash, collected on delivery.' }
            : {
                fee: 'to be confirmed',
                note: 'Tell them the delivery associate will confirm the cost with them before it is uplifted. Do not quote a figure.',
              }),
        next: 'Give them the job number and what happens next: a delivery associate uplifts it, then delivers. No time promise.',
      });
    }

    case 'cancel_my_order': {
      const reference = asString(input.order_number);
      const order = reference
        ? repo.customerOrder(ctx.phone, reference)
        : (() => {
            const recent = repo.recentOrders(ctx.phone, 1)[0];
            return recent ? repo.customerOrder(ctx.phone, recent.orderNo) : null;
          })();

      if (!order) {
        return fail(
          reference
            ? `No order ${reference} on this number. Offer to list their recent orders.`
            : 'They have no orders to cancel.',
        );
      }
      if (order.status === 'cancelled') return fail(`${order.orderNo} is already cancelled.`);
      if (order.status === 'delivered') {
        return fail(
          `${order.orderNo} has already been delivered. If something was wrong with it, use request_staff_help.`,
        );
      }

      // Past 'pending' somebody has started work — food on a stove, or a rider
      // already moving. Undoing that costs money and is a person's decision.
      if (order.status !== 'pending') {
        return fail(
          `${order.orderNo} is already ${CUSTOMER_STATUS[order.status]}, so it cannot be cancelled here — call request_staff_help and tell them the team is on it. Do not say you are unable to do it.`,
        );
      }

      repo.setCancelReason(order.orderNo, 'Customer changed their mind', 'customer');
      repo.setOrderStatus(order.orderNo, 'cancelled');

      // The kitchen was told to cook this when it was placed, and has not
      // answered yet — it must not accept it ten minutes from now.
      // Only reachable while still pending, so the kitchen never accepted it.
      void tellKitchenCancelled(order.orderNo, false).catch((err) =>
        console.error('[tools] could not tell the kitchen about a cancellation:', err),
      );

      return ok({
        cancelled: order.orderNo,
        next: 'Confirm it plainly and say nothing has been charged. Do not apologise — they asked for this.',
      });
    }

    case 'request_staff_help': {
      const summary = asString(input.summary);
      if (!summary) return fail('summary is required — say what the customer needs.');

      const urgent = asString(input.urgency).toLowerCase() === 'urgent';

      // Written down first, so the request survives a failure to deliver it.
      const id = repo.recordHelpRequest(ctx.phone, summary, urgent);

      // Whether there is anybody to tell is known without sending anything,
      // and it is the case that actually happens: a shop that has not set
      // STAFF_NUMBERS.
      //
      // This tool used to report `passed_on: true` whatever became of the
      // notification - it was fired off without waiting - so such a shop told
      // the customer their number had gone to the manager while the log said
      // nobody had been told. The shop saying something untrue is worse than
      // the setting being missing.
      const somebodyToTell = config.staffNumbers.length > 0;

      // Still fire-and-forget, because the reply to the customer must not wait
      // on a Graph API round trip. The record is what closes the gap: it is
      // marked delivered only when the send actually succeeds, so one that
      // fails stays pending and goes out with the rest at the next boot.
      void notifyStaffOfRequest(ctx.phone, summary, urgent)
        .then((told) => {
          if (told === 'sent') repo.markHelpDelivered(id);
        })
        .catch((err) => console.error('[tools] staff help request failed:', err));

      if (somebodyToTell) {
        return ok({
          passed_on: true,
          next: 'Say only that it has been passed on. Not when, and not where — the manager may ring rather than write, and a customer watching this chat for a reply that comes as a phone call has been told the wrong thing.',
        });
      }

      return ok({
        passed_on: false,
        written_down: true,
        next: 'Nobody could be reached just now, so do not say it has been passed on. Say it is written down and somebody will come back to them — that much is true, the request is saved and goes out the moment there is somebody to send it to. Still no promise of when. Do not explain why, do not mention settings, and do not apologise more than once.',
      });
    }

    /**
     * Last week's shopping, back in the basket.
     *
     * Groceries are the same rice and the same milk every week, and the shop
     * already knew it: the prompt has told the agent for months to "greet a
     * regular by name and offer their usual order rather than starting from
     * scratch" - with no tool that could do it. The agent could read a past
     * order out and then had to walk the customer through the aisles anyway.
     *
     * What it will not do is pretend. A product withdrawn since, sold out, or
     * short of stock is named rather than quietly dropped, and a price that
     * has moved is reported, because the one thing worse than a basket
     * missing an item is a basket the customer believes is complete.
     */
    case 'repeat_last_order': {
      const asked = asString(input.order_number).trim();
      const orderNo = asked
        ? repo.findOrder(asked)?.orderNo ?? ''
        : repo.lastRepeatableOrder(ctx.phone);

      if (!orderNo) {
        return fail(
          asked
            ? `No order ${asked} to repeat.`
            : 'They have no past order to repeat. Offer the aisles instead, with list_categories.',
        );
      }

      const past = repo.findOrder(orderNo);
      if (!past || past.phone !== ctx.phone) {
        return fail(`${orderNo} is not theirs to repeat.`);
      }

      const lines = repo.orderLines(orderNo);
      if (lines.length === 0) {
        return fail(`${orderNo} has nothing in it to repeat — a parcel, most likely.`);
      }

      // An existing basket is not quietly doubled. Somebody who has already
      // started shopping and then says "and the usual" means both, and the
      // only honest way to get there is to ask.
      const existing = repo.getCart(ctx.phone);
      if (existing.lines.length > 0) {
        return fail(
          'Their basket is not empty, so repeating an order would mix two shops into one. Read back what is already in it and ask whether to keep that, start again (clear_cart), or set it aside (park_cart).',
        );
      }

      const added: Record<string, unknown>[] = [];
      const missing: Record<string, unknown>[] = [];
      const dearer: Record<string, unknown>[] = [];

      for (const line of lines) {
        const product = repo.getProductBySku(line.sku);
        if (!product) {
          missing.push({ name: line.name, reason: 'not in the catalogue any more' });
          continue;
        }
        const refusal = refuseQty(product, line.qty);
        if (refusal) {
          missing.push({ name: product.name, reason: refusal });
          continue;
        }
        repo.setCartQty(ctx.phone, product.id, line.qty, line.options);
        added.push({ name: product.name, quantity: line.qty });

        // Said out loud rather than absorbed. A customer who agreed to "the
        // usual" and is then charged more for it was not told the truth.
        if (line.wasUnitPrice > 0 && product.price !== line.wasUnitPrice) {
          dearer.push({
            name: product.name,
            was: money(line.wasUnitPrice),
            now: money(product.price),
          });
        }
      }

      const cart = repo.getCart(ctx.phone);
      if (cart.lines.length === 0) {
        repo.clearCart(ctx.phone);
        return fail(
          `Nothing from ${orderNo} can be had today: ${missing.map((m) => `${String(m.name)} (${String(m.reason)})`).join('; ')}. Say so plainly and offer the aisles.`,
        );
      }

      return ok({
        repeated: orderNo,
        when: describeAge(past.placedAt),
        added,
        ...(missing.length > 0 ? { could_not_add: missing } : {}),
        ...(dearer.length > 0 ? { price_changed: dearer } : {}),
        cart: {
          items: cart.lines.map((l) => `${l.qty} x ${l.product.name}`),
          subtotal: money(cart.subtotal),
          total: money(cart.total),
        },
        say: 'Read the basket back as a short list with the total, and name anything that could not be added and anything that costs more than last time. Then ask whether to change anything before ordering.',
        next: 'Nothing is ordered yet. Carry on as normal from here.',
      });
    }

    case 'list_recent_orders': {
      const reference = asString(input.order_number);

      // A named order is looked up scoped to this phone. Order numbers are
      // sequential and get read aloud, so an unscoped lookup would hand any
      // customer their neighbour's name, address and shopping.
      if (reference) {
        const found = repo.customerOrder(ctx.phone, reference);
        if (!found) {
          return ok({
            orders: [],
            note: `No order ${reference} on this number. Ask them to check the number, or offer to list their recent orders.`,
          });
        }
        return ok({
          orders: [
            {
              order_number: found.orderNo,
              status: found.status,
              status_means: CUSTOMER_STATUS[found.status],
              placed: describeAge(found.placedAt),
              total: money(found.total),
              // Named in words the customer will recognise. Never the pin's
              // numbers, which mean nothing read back over chat.
              delivering_to:
                found.location?.label || found.address || 'the location pin you shared',
              items: found.items.map((i) => `${i.qty} x ${i.name}`),
            },
          ],
        });
      }

      const orders = repo.recentOrders(ctx.phone, 5);
      if (orders.length === 0) return ok({ orders: [], note: 'This customer has no previous orders.' });
      return ok({
        orders: orders.map((o) => ({
          order_number: o.orderNo,
          status: o.status,
          // Spelled out because the raw status is a database word. Left to
          // itself the model says "your order is pending", which sounds to a
          // customer like something has gone wrong.
          status_means: CUSTOMER_STATUS[o.status as repo.OrderStatus] ?? o.status,
          placed: describeAge(o.placedAt),
          status_changed: describeAge(o.statusChangedAt),
          total: money(o.total),
          items: o.items.map((i) => `${i.qty} x ${i.name}`),
        })),
        note: 'Report the status as it is. Do not promise a delivery time — you have no ETA.',
      });
    }

    case 'send_buttons': {
      const body = unescapeLineBreaks(asString(input.body));
      const raw = Array.isArray(input.buttons) ? input.buttons : [];
      if (!body) return fail('body is required.');
      if (raw.length < 1 || raw.length > 3) return fail('Provide between 1 and 3 buttons.');

      const buttons = raw.slice(0, 3).map((b, i) => {
        const obj = (b ?? {}) as Record<string, unknown>;
        return {
          id: (asString(obj.id) || `option_${i + 1}`).slice(0, 256),
          title: asString(obj.title).slice(0, 20),
        };
      });
      if (buttons.some((b) => !b.title)) return fail('Every button needs a non-empty title.');

      ctx.outbound.push({ kind: 'buttons', text: body.slice(0, 1024), buttons });
      return ok({ sent: true, note: 'Buttons queued and already sent to the customer. Do not repeat this text — add another line only if it says something new.' });
    }

    default:
      return fail(`Unknown tool "${name}".`);
  }
}

import type Anthropic from '@anthropic-ai/sdk';
import { config, money } from '../config.ts';
import * as repo from '../db/repo.ts';
import type { OutboundMessage } from '../channels/types.ts';
import { notifyStaffOfNewOrder } from '../notifications.ts';

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
    name: 'search_products',
    description:
      'Search the catalogue by name, keyword, or category. Always call this before claiming an item is or is not available — never guess at products, prices, or stock.',
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
      'Check the delivery name and address already saved for this customer. Call this before asking them for details they have already given.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'confirm_identity',
    description:
      "Record that the customer has confirmed who they are and where to deliver. Call this only after they have actually said yes to the name and address you read back to them — never on an assumption, and never on a name that only came from their WhatsApp profile. An order cannot be placed until this is done.",
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
      'Save or update the delivery name and address. Only pass a field when the customer has actually stated it.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name for the delivery.' },
        address: {
          type: 'string',
          description: 'Full delivery address including street, area, and any landmark.',
        },
        contact_phone: {
          type: 'string',
          description:
            'The number the driver should call, if the customer gives a different one. Defaults to the number they are messaging from, so only pass this when they name another.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'place_order',
    description:
      'Place the order for everything currently in the cart. Only call this after the customer has seen the full itemised total and explicitly confirmed. Requires a saved name and address.',
    input_schema: {
      type: 'object',
      properties: {
        payment_method: {
          type: 'string',
          // Only what the shop can actually take, so an unsupported method
          // cannot be selected in the first place.
          enum: config.paymentMethods.map((m) => `${m}_on_delivery`),
          description: 'How the customer will pay the driver.',
        },
        delivery_note: {
          type: 'string',
          description: 'Optional instructions for the driver, e.g. "call on arrival".',
        },
      },
      required: ['payment_method'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_recent_orders',
    description:
      "Look up this customer's recent orders and their status. Useful for 'where is my order' and for reordering the same items.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
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

const productView = (p: repo.Product) => ({
  sku: p.sku,
  name: p.name,
  category: p.category,
  unit: p.unit,
  price: money(p.price),
  in_stock: p.stock > 0,
  stock_remaining: p.stock,
  has_photo: Boolean(p.imageUrl),
  ...(p.description ? { description: p.description } : {}),
});

function cartView(phone: string) {
  const cart = repo.getCart(phone);
  return {
    items: cart.lines.map((l) => ({
      sku: l.product.sku,
      name: l.product.name,
      unit: l.product.unit,
      quantity: l.qty,
      unit_price: money(l.product.price),
      line_total: money(l.lineTotal),
    })),
    item_count: cart.itemCount,
    subtotal: money(cart.subtotal),
    delivery_fee: cart.deliveryFee === 0 ? 'free' : money(cart.deliveryFee),
    total: money(cart.total),
    ...(config.store.minOrderTotal > 0 && cart.subtotal < config.store.minOrderTotal
      ? {
          below_minimum: `Subtotal is under the ${money(config.store.minOrderTotal)} minimum order.`,
        }
      : {}),
  };
}

const ok = (data: unknown): string => JSON.stringify(data);
const fail = (message: string): string => JSON.stringify({ error: message });

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
      const cats = repo.listCategories();
      if (cats.length === 0) return fail('The catalogue is empty. No products have been imported yet.');
      return ok({ categories: cats });
    }

    case 'search_products': {
      const query = asString(input.query);
      if (!query) return fail('query is required.');
      const limit = Math.min(Math.max(asInt(input.limit) ?? 8, 1), 15);
      const category = asString(input.category) || undefined;
      const results = repo.searchProducts(query, category, limit);
      if (results.length === 0) {
        return ok({
          results: [],
          note: `No match for "${query}". Suggest a related item or offer to check a category — do not invent products.`,
        });
      }
      return ok({ results: results.map(productView) });
    }

    case 'search_many': {
      const raw = Array.isArray(input.queries) ? input.queries : [];
      const queries = raw.map(asString).filter(Boolean).slice(0, 20);
      if (queries.length === 0) return fail('queries must contain at least one search phrase.');

      // Fewer results each than a single search: a list needs breadth, not depth,
      // and a wall of options per line is unreadable on a phone.
      return ok({
        searches: queries.map((query) => {
          const results = repo.searchProducts(query, undefined, 3);
          return results.length > 0
            ? { query, results: results.map(productView) }
            : { query, results: [], note: 'No match — say so plainly, do not substitute silently.' };
        }),
      });
    }

    case 'add_items_to_cart': {
      const raw = Array.isArray(input.items) ? input.items : [];
      if (raw.length === 0) return fail('items must contain at least one product.');
      if (raw.length > 30) return fail('Too many items at once. Add up to 30 and repeat.');

      const added: { sku: string; name: string; quantity: number }[] = [];
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
        const target = repo.getCartQty(ctx.phone, product.id) + qty;
        if (product.stock <= 0) {
          failed.push({ sku, reason: `${product.name} is out of stock` });
          continue;
        }
        if (target > product.stock) {
          failed.push({ sku, reason: `only ${product.stock} x ${product.name} in stock` });
          continue;
        }
        repo.setCartQty(ctx.phone, product.id, Math.min(target, 99));
        added.push({ sku: product.sku, name: product.name, quantity: Math.min(target, 99) });
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
      if (!product.imageUrl) {
        return ok({
          sent: false,
          reason: `No photo on file for ${product.name}. Describe it in words instead — do not dwell on the missing picture.`,
        });
      }
      const caption =
        asString(input.caption) || `${product.name} — ${money(product.price)} / ${product.unit}`;
      ctx.outbound.push({ kind: 'image', text: caption, imageUrl: product.imageUrl });
      return ok({ sent: true, product: product.name, note: 'Photo queued — do not repeat the caption.' });
    }

    case 'view_cart':
      return ok(cartView(ctx.phone));

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

      const target = isAdd ? repo.getCartQty(ctx.phone, product.id) + qty : qty;
      if (target > 99) return fail('Cart lines are capped at 99 units. Ask the customer to split the order or call the store.');

      if (target > 0) {
        if (product.stock <= 0) return fail(`${product.name} is out of stock right now.`);
        if (target > product.stock) {
          return fail(`Only ${product.stock} x ${product.name} in stock. Offer that quantity or an alternative.`);
        }
      }

      repo.setCartQty(ctx.phone, product.id, target);
      return ok({
        updated: { sku: product.sku, name: product.name, quantity: target },
        cart: cartView(ctx.phone),
      });
    }

    case 'clear_cart': {
      repo.clearCart(ctx.phone);
      return ok({ cleared: true, cart: cartView(ctx.phone) });
    }

    case 'get_customer_details': {
      const id = repo.getIdentity(ctx.phone);
      return ok({
        name: id.name,
        address: id.address,
        contact_phone: id.contactPhone ?? ctx.phone,
        // A hint from WhatsApp, not a fact. Offer it; never deliver on it.
        whatsapp_profile_name: id.profileName,
        identity_confirmed: id.confirmed,
        missing: [!id.name && 'name', !id.address && 'address'].filter(Boolean),
        next: id.confirmed
          ? 'Identity already confirmed in this conversation.'
          : id.name || id.address
            ? 'Read the name and address back and get a yes before ordering, then call confirm_identity.'
            : 'Ask for the delivery name and address.',
      });
    }

    case 'confirm_identity': {
      const id = repo.getIdentity(ctx.phone);
      if (!id.name || !id.address) {
        return fail('Nothing to confirm yet — save a name and address first.');
      }
      repo.confirmIdentity(ctx.phone);
      return ok({ confirmed: true, name: id.name, address: id.address });
    }

    case 'customer_record': {
      const record = repo.customerRecord(ctx.phone, 20);
      return ok({
        phone: record.phone,
        name: record.name,
        whatsapp_profile_name: record.profileName,
        address: record.address,
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
      if (address && address.length < 8) {
        return fail('That address looks too short to deliver to. Ask for street, area, and a landmark.');
      }
      const saved = repo.saveCustomer(ctx.phone, {
        ...(nameField ? { name: nameField } : {}),
        ...(address ? { address } : {}),
        ...(contactPhone ? { contactPhone } : {}),
      });

      // Details the customer has just stated in their own words are confirmed by
      // definition. Only details already on file need reading back.
      if (saved.name && saved.address) repo.confirmIdentity(ctx.phone);

      return ok({
        saved: { name: saved.name, address: saved.address, contact_phone: saved.contactPhone },
        identity_confirmed: repo.getIdentity(ctx.phone).confirmed,
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

      const customer = repo.getIdentity(ctx.phone);
      const missing = [!customer.name && 'name', !customer.address && 'address'].filter(Boolean);
      if (missing.length > 0) {
        return fail(`Cannot place the order yet — still need the customer's ${missing.join(' and ')}. Ask, then call save_customer_details.`);
      }
      // Goods go to a person at an address. Confirming who and where is not
      // something to leave to the model's discretion.
      if (!customer.confirmed) {
        return fail(
          `Identity not confirmed. Read back "${customer.name}, ${customer.address}", get a clear yes, then call confirm_identity before ordering.`,
        );
      }

      const cart = repo.getCart(ctx.phone);
      if (cart.lines.length === 0) return fail('The cart is empty.');
      if (config.store.minOrderTotal > 0 && cart.subtotal < config.store.minOrderTotal) {
        return fail(`Subtotal ${money(cart.subtotal)} is below the ${money(config.store.minOrderTotal)} minimum order. Invite the customer to add more.`);
      }

      try {
        const order = repo.placeOrder({
          phone: ctx.phone,
          customerName: customer.name as string,
          address: customer.address as string,
          contactPhone: customer.contactPhone ?? ctx.phone,
          deliveryNote: asString(input.delivery_note),
          paymentMethod,
        });
        // Fire-and-forget: the shop needs to know immediately, but the customer
        // should not wait on a Graph API round trip to see their confirmation.
        void notifyStaffOfNewOrder(order.orderNo).catch((err) =>
          console.error('[tools] staff notification failed:', err),
        );

        return ok({
          placed: true,
          order_number: order.orderNo,
          items: order.lines.map((l) => `${l.qty} x ${l.name} — ${money(l.lineTotal)}`),
          subtotal: money(order.subtotal),
          delivery_fee: order.deliveryFee === 0 ? 'free' : money(order.deliveryFee),
          total: money(order.total),
          pay: paymentMethod.replace('_on_delivery', '') + ' on delivery',
          deliver_to: `${order.customerName}, ${order.address}`,
          contact_number: customer.contactPhone ?? ctx.phone,
          next: 'Tell the customer the order number and total, and that the store will confirm the delivery window shortly.',
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Could not place the order.');
      }
    }

    case 'list_recent_orders': {
      const orders = repo.recentOrders(ctx.phone, 5);
      if (orders.length === 0) return ok({ orders: [], note: 'This customer has no previous orders.' });
      return ok({
        orders: orders.map((o) => ({
          order_number: o.orderNo,
          status: o.status,
          placed_at: o.placedAt,
          total: money(o.total),
          items: o.items.map((i) => `${i.qty} x ${i.name}`),
        })),
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

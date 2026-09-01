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
          enum: ['cash_on_delivery', 'card_on_delivery'],
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

    case 'get_product': {
      const sku = asString(input.sku);
      if (!sku) return fail('sku is required.');
      const p = repo.getProductBySku(sku);
      return p ? ok(productView(p)) : fail(`No active product with SKU "${sku}".`);
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
      const c = repo.getCustomer(ctx.phone);
      return ok({
        name: c.name,
        address: c.address,
        missing: [!c.name && 'name', !c.address && 'address'].filter(Boolean),
      });
    }

    case 'save_customer_details': {
      const nameField = asString(input.name);
      const address = asString(input.address);
      if (!nameField && !address) return fail('Pass at least one of name or address.');
      if (address && address.length < 8) {
        return fail('That address looks too short to deliver to. Ask for street, area, and a landmark.');
      }
      const saved = repo.saveCustomer(ctx.phone, {
        ...(nameField ? { name: nameField } : {}),
        ...(address ? { address } : {}),
      });
      return ok({ saved: { name: saved.name, address: saved.address } });
    }

    case 'place_order': {
      const paymentMethod = asString(input.payment_method);
      if (!['cash_on_delivery', 'card_on_delivery'].includes(paymentMethod)) {
        return fail('payment_method must be "cash_on_delivery" or "card_on_delivery".');
      }

      const customer = repo.getCustomer(ctx.phone);
      const missing = [!customer.name && 'name', !customer.address && 'address'].filter(Boolean);
      if (missing.length > 0) {
        return fail(`Cannot place the order yet — still need the customer's ${missing.join(' and ')}. Ask, then call save_customer_details.`);
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
          pay: paymentMethod === 'cash_on_delivery' ? 'cash on delivery' : 'card on delivery',
          deliver_to: `${order.customerName}, ${order.address}`,
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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { config, money } from '../config.ts';
import * as repo from '../db/repo.ts';
import { handleIncoming } from '../conversation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A browser stand-in for WhatsApp. It goes through exactly the same
 * handleIncoming path as the real channel, so behaviour you test here is the
 * behaviour customers get.
 */
export const simulatorRouter = express.Router();

/**
 * The simulator can place real orders and spend real API credit, and it has no
 * authentication — so it must never answer a request that arrived from outside
 * this machine. Checking the socket address is not enough: a tunnel (ngrok,
 * cloudflared) forwards to localhost, so every request looks local. The Host
 * header is what actually distinguishes them, and any proxy header at all means
 * the request came through something.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip', 'x-real-ip'];

simulatorRouter.use((req: Request, res: Response, next) => {
  const hostname = (req.get('host') ?? '').split(':')[0] ?? '';
  const viaProxy = PROXY_HEADERS.some((h) => req.get(h));

  if (!LOCAL_HOSTS.has(hostname) || viaProxy) {
    console.warn(`[simulator] refused a non-local request (host: ${req.get('host') ?? 'none'})`);
    res.status(403).type('text/plain').send(
      'The test simulator is only available on localhost. It is disabled for remote access ' +
        'because it can place orders without authentication.',
    );
    return;
  }
  next();
});

simulatorRouter.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(here, '..', 'public', 'simulator.html'));
});

simulatorRouter.post('/api/message', async (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? '').trim() || '5920000000';
  const text = String(req.body?.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  try {
    const outbound = await handleIncoming({ phone, text, channel: 'simulator' });
    res.json({ outbound, state: stateFor(phone) });
  } catch (err) {
    console.error('[simulator] handler failed:', err);
    res.status(500).json({ error: 'handler failed' });
  }
});

simulatorRouter.post('/api/reset', (req: Request, res: Response) => {
  const phone = String(req.body?.phone ?? '').trim() || '5920000000';
  repo.resetConversation(phone);
  repo.clearCart(phone);
  res.json({ ok: true, state: stateFor(phone) });
});

simulatorRouter.get('/api/state', (req: Request, res: Response) => {
  const phone = String(req.query.phone ?? '').trim() || '5920000000';
  res.json(stateFor(phone));
});

function stateFor(phone: string) {
  const cart = repo.getCart(phone);
  const customer = repo.getCustomer(phone);
  return {
    storeName: config.store.name,
    catalogSize: repo.productCount(),
    customer: { name: customer.name, address: customer.address },
    cart: {
      items: cart.lines.map((l) => ({
        name: l.product.name,
        qty: l.qty,
        lineTotal: money(l.lineTotal),
      })),
      subtotal: money(cart.subtotal),
      deliveryFee: cart.deliveryFee === 0 ? 'free' : money(cart.deliveryFee),
      total: money(cart.total),
    },
    orders: repo.recentOrders(phone, 3).map((o) => ({
      orderNo: o.orderNo,
      total: money(o.total),
      status: o.status,
    })),
  };
}

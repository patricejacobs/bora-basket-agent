import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { config } from '../config.ts';
import { claimEvent } from '../db/repo.ts';
import { handleIncoming } from '../conversation.ts';
import type { OutboundMessage } from './types.ts';

/** WhatsApp hard-limits a text body to 4096 characters. */
const MAX_TEXT_LENGTH = 4096;

const graphUrl = (): string =>
  `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

/* ------------------------------------------------------------ outbound API */

async function callGraph(payload: Record<string, unknown>): Promise<void> {
  if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) {
    console.warn('[whatsapp] not configured — dropping outbound message:', JSON.stringify(payload));
    return;
  }

  const res = await fetch(graphUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Logged rather than thrown: one failed send should not abort the rest of the reply.
    console.error(`[whatsapp] send failed ${res.status}: ${detail}`);
  }
}

/** Splits on paragraph boundaries where possible so a long reply reads naturally. */
export function chunkText(text: string, limit = MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const at = cut > limit * 0.5 ? cut : limit;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendText(to: string, text: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await callGraph({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: chunk },
    });
  }
}

export async function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  await callGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/** Marks the message read and shows the typing indicator while the agent thinks. */
async function markReadAndTyping(messageId: string): Promise<void> {
  await callGraph({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  });
}

export async function deliver(to: string, messages: OutboundMessage[]): Promise<void> {
  for (const msg of messages) {
    if (msg.kind === 'buttons') await sendButtons(to, msg.text, msg.buttons);
    else await sendText(to, msg.text);
  }
}

/* ------------------------------------------------------------- inbound API */

type WebhookRequest = Request & { rawBody?: Buffer };

/**
 * Meta signs every webhook body with the app secret. An unsigned or mismatched
 * request means someone other than Meta is posting to this endpoint.
 */
function signatureIsValid(req: WebhookRequest): boolean {
  // Without a configured secret every signature would "match" the empty-key HMAC,
  // so an unconfigured deployment must reject webhooks outright rather than trust them.
  if (!config.whatsapp.appSecret) return false;

  const header = req.get('x-hub-signature-256');
  if (!header || !req.rawBody) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.whatsapp.appSecret).update(req.rawBody).digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type ParsedInbound = { phone: string; text: string; messageId: string; profileName?: string };

/** Pulls the customer-authored messages out of a webhook payload, ignoring status events. */
export function parseWebhook(body: unknown): ParsedInbound[] {
  const out: ParsedInbound[] = [];
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      const messages = value?.messages;
      if (!Array.isArray(messages)) continue;

      const contacts = value?.contacts as { profile?: { name?: string } }[] | undefined;
      const profileName = contacts?.[0]?.profile?.name;

      for (const raw of messages) {
        const m = raw as Record<string, any>;
        const phone: string = m.from ?? '';
        const messageId: string = m.id ?? '';
        if (!phone || !messageId) continue;

        let text = '';
        switch (m.type) {
          case 'text':
            text = m.text?.body ?? '';
            break;
          case 'interactive':
            text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
            break;
          case 'button':
            text = m.button?.text ?? '';
            break;
          default:
            // Voice notes, images, locations and the rest: acknowledge rather than ignore.
            text = `[The customer sent a ${m.type} message, which you cannot open. Ask them to type what they need.]`;
        }

        if (text) out.push({ phone, text, messageId, ...(profileName ? { profileName } : {}) });
      }
    }
  }
  return out;
}

export const whatsappRouter = express.Router();

// Meta's one-time subscription handshake.
whatsappRouter.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken && config.whatsapp.verifyToken) {
    console.log('[whatsapp] webhook verified');
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  console.warn('[whatsapp] webhook verification rejected');
  res.sendStatus(403);
});

whatsappRouter.post('/webhook', (req: Request, res: Response) => {
  if (!signatureIsValid(req as WebhookRequest)) {
    console.warn('[whatsapp] rejected webhook with bad or missing signature');
    res.sendStatus(401);
    return;
  }

  // Meta retries anything that is not a prompt 200, so acknowledge before working.
  res.sendStatus(200);

  const inbound = parseWebhook(req.body);
  for (const msg of inbound) {
    if (!claimEvent(msg.messageId)) {
      console.log(`[whatsapp] duplicate delivery ${msg.messageId} ignored`);
      continue;
    }
    void processInbound(msg);
  }
});

async function processInbound(msg: ParsedInbound): Promise<void> {
  try {
    await markReadAndTyping(msg.messageId);
    const outbound = await handleIncoming({
      phone: msg.phone,
      text: msg.text,
      channel: 'whatsapp',
      ...(msg.profileName ? { profileName: msg.profileName } : {}),
    });
    await deliver(msg.phone, outbound);
  } catch (err) {
    console.error('[whatsapp] failed to handle inbound message:', err);
  }
}

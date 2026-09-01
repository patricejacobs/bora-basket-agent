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
export type SignatureCheck = { valid: true } | { valid: false; reason: string; fix: string };

/**
 * Verifies Meta's X-Hub-Signature-256 over the exact bytes received.
 *
 * Returns *why* a check failed rather than a bare boolean: the four causes need
 * four different fixes and are indistinguishable from outside the server, which
 * made a rejected webhook impossible to diagnose from the logs alone.
 */
export function verifySignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  secret: string,
): SignatureCheck {
  // Without a configured secret every signature would "match" the empty-key HMAC,
  // so an unconfigured deployment must reject webhooks outright rather than trust them.
  if (!secret) {
    return {
      valid: false,
      reason: 'WHATSAPP_APP_SECRET is not set on this instance',
      fix: 'Add it in Render → Environment, from Meta → App settings → Basic → Show',
    };
  }
  if (!header) {
    return {
      valid: false,
      reason: 'no X-Hub-Signature-256 header on the request',
      fix: 'This did not come from Meta — check what else is posting to this URL',
    };
  }
  if (!rawBody) {
    return {
      valid: false,
      reason: 'raw body was not captured, so there was nothing to verify',
      fix: 'Content-Type was probably not application/json',
    };
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(header);
  const computed = Buffer.from(expected);

  if (received.length !== computed.length || !crypto.timingSafeEqual(received, computed)) {
    return {
      valid: false,
      // Length is the giveaway when someone pastes the App ID instead of the
      // secret; a Meta app secret is 32 hex characters.
      reason: `signature mismatch over ${rawBody.length} bytes (loaded secret is ${secret.length} chars, ending "${secret.slice(-4)}")`,
      fix: 'The app secret in Render differs from the one in Meta — re-copy it, watching for a trailing space',
    };
  }

  return { valid: true };
}

function signatureIsValid(req: WebhookRequest): SignatureCheck {
  return verifySignature(
    req.rawBody,
    req.get('x-hub-signature-256'),
    config.whatsapp.appSecret,
  );
}

/**
 * In-memory tally of what the webhook endpoint has actually seen, surfaced on
 * /health so a deployment can be diagnosed without log access. Deliberately
 * carries only the *category* of a rejection — the detail that would identify
 * the loaded secret stays in the logs, which are private.
 */
export const webhookStats = {
  received: 0,
  accepted: 0,
  rejected: 0,
  messagesHandled: 0,
  lastRejection: null as string | null,
  lastEventAt: null as string | null,
};

function rejectionCategory(reason: string): string {
  if (reason.includes('not set')) return 'app secret not configured';
  if (reason.includes('no X-Hub-Signature-256')) return 'no signature header';
  if (reason.includes('raw body')) return 'body not captured';
  if (reason.includes('mismatch')) return 'signature mismatch (wrong app secret)';
  return 'unknown';
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
  webhookStats.received++;
  webhookStats.lastEventAt = new Date().toISOString();

  const check = signatureIsValid(req as WebhookRequest);
  if (!check.valid) {
    webhookStats.rejected++;
    webhookStats.lastRejection = rejectionCategory(check.reason);
    console.warn(`[whatsapp] REJECTED webhook — ${check.reason}`);
    console.warn(`[whatsapp] fix: ${check.fix}`);
    res.sendStatus(401);
    return;
  }

  webhookStats.accepted++;

  // Meta retries anything that is not a prompt 200, so acknowledge before working.
  res.sendStatus(200);

  const inbound = parseWebhook(req.body);
  webhookStats.messagesHandled += inbound.length;
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

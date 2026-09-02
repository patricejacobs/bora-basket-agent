import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { config } from '../config.ts';
import { claimEvent } from '../db/repo.ts';
import { handleIncoming } from '../conversation.ts';
import { deliver, markReadAndTyping } from './whatsapp-send.ts';
import { downloadMedia, downloadAudio, mediaFailureMessage } from './whatsapp-media.ts';
import { transcribeAudio, transcriptionAvailable } from '../transcribe.ts';

// Re-exported so the webhook module stays the single import point for callers.
export { chunkText, deliver, sendText, sendButtons, sendTemplate } from './whatsapp-send.ts';

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

type ParsedInbound = {
  phone: string;
  text: string;
  messageId: string;
  profileName?: string;
  /** Set when the customer sent a photo; the bytes are fetched separately. */
  imageId?: string;
  /** Set when the customer sent a voice note. */
  audioId?: string;
};

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
        let imageId: string | undefined;
        let audioId: string | undefined;

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
          case 'image':
            // A photographed shopping list. The caption, if any, is the customer's
            // own words about it; the bytes are fetched before the agent runs.
            imageId = m.image?.id;
            text = m.image?.caption ?? '';
            break;
          case 'audio':
            // A spoken shopping list. Transcribed before the agent runs.
            audioId = m.audio?.id;
            break;
          default:
            // Locations, contacts, documents and the rest: acknowledge rather than ignore.
            text = `[The customer sent a ${m.type} message, which you cannot open. Ask them to type what they need.]`;
        }

        if (text || imageId || audioId) {
          out.push({
            phone,
            text,
            messageId,
            ...(profileName ? { profileName } : {}),
            ...(imageId ? { imageId } : {}),
            ...(audioId ? { audioId } : {}),
          });
        }
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

/**
 * Turns a voice note into the words the agent will act on.
 *
 * The transcript is marked as spoken rather than typed, because that changes how
 * it should be treated: speech recognition mishears product names, and a
 * misheard item silently added to a cart is worse than one confirmed aloud.
 */
async function transcribeVoiceNote(audioId: string): Promise<string> {
  if (!transcriptionAvailable()) {
    return '[The customer sent a voice note, but this shop cannot listen to recordings. Apologise briefly and ask them to type or photograph their list.]';
  }

  const downloaded = await downloadAudio(audioId);
  if (!downloaded.ok) {
    console.warn(`[voice] could not fetch ${audioId}: ${downloaded.reason}`);
    return '[The customer sent a voice note that could not be opened. Apologise briefly and ask them to send it again or type the list.]';
  }

  const result = await transcribeAudio(downloaded.audio.bytes, downloaded.audio.mediaType);
  if (!result.ok) {
    console.error(`[voice] transcription failed: ${result.reason}`);
    return '[The customer sent a voice note that could not be understood. Apologise briefly and ask them to type the list or send it again.]';
  }

  const { text, language } = result.transcription;
  console.log(`[voice] transcribed ${language ?? 'unknown language'}: ${text.slice(0, 80)}`);
  return `[Voice note, transcribed${language ? ` from ${language}` : ''}] ${text}`;
}

async function processInbound(msg: ParsedInbound): Promise<void> {
  try {
    await markReadAndTyping(msg.messageId);

    let text = msg.text;
    let image: { base64: string; mediaType: string } | undefined;

    if (msg.imageId) {
      const result = await downloadMedia(msg.imageId);
      if (result.ok) {
        image = result.media;
        // A photo with no caption still needs a prompt, or the turn has no words.
        if (!text) text = 'I sent a photo of my shopping list.';
      } else {
        text = mediaFailureMessage(result.reason);
      }
    }

    if (msg.audioId) {
      text = await transcribeVoiceNote(msg.audioId);
    }

    const outbound = await handleIncoming({
      phone: msg.phone,
      text,
      channel: 'whatsapp',
      ...(msg.profileName ? { profileName: msg.profileName } : {}),
      ...(image ? { image } : {}),
    });
    await deliver(msg.phone, outbound);
  } catch (err) {
    console.error('[whatsapp] failed to handle inbound message:', err);
  }
}

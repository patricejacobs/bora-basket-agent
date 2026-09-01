/**
 * Outbound WhatsApp Graph API calls.
 *
 * Deliberately separate from the webhook router: notifications need to send
 * messages without importing the conversation layer, and the router imports the
 * conversation layer. Keeping sending here breaks what would otherwise be a cycle.
 */
import { config } from '../config.ts';
import { typingDelayMs, wait } from '../agent/pacing.ts';
import type { OutboundMessage } from './types.ts';

/** WhatsApp hard-limits a text body to 4096 characters. */
const MAX_TEXT_LENGTH = 4096;

const graphUrl = (): string =>
  `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

/** Returns true when the send succeeded, so callers can fall back. */
export async function callGraph(payload: Record<string, unknown>): Promise<boolean> {
  if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) {
    console.warn('[whatsapp] not configured — dropping outbound message:', JSON.stringify(payload));
    return false;
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
    return false;
  }
  return true;
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

export async function sendText(to: string, text: string): Promise<boolean> {
  let ok = true;
  for (const chunk of chunkText(text)) {
    const sent = await callGraph({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: chunk },
    });
    ok = ok && sent;
  }
  return ok;
}

export async function sendButtons(
  to: string,
  body: string,
  buttons: { id: string; title: string }[],
): Promise<boolean> {
  return callGraph({
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

/**
 * Sends a pre-approved template. This is the only way to reach a customer more
 * than 24 hours after their last message — plain text is rejected by Meta there.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  params: string[],
): Promise<boolean> {
  return callGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: config.templates.language },
      components:
        params.length > 0
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : [],
    },
  });
}

/** Marks the message read and shows the typing indicator while the agent thinks. */
export async function markReadAndTyping(messageId: string): Promise<void> {
  await callGraph({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  });
}

export async function deliver(to: string, messages: OutboundMessage[]): Promise<void> {
  for (const [index, msg] of messages.entries()) {
    // The first message needs no delay — the model has already spent a few
    // seconds thinking, which reads as typing. Later ones would otherwise all
    // land in the same instant, which nothing human does. The typing indicator
    // raised when the message arrived runs for ~25s, covering these pauses.
    if (index > 0) await wait(typingDelayMs(msg.text));
    if (msg.kind === 'buttons') await sendButtons(to, msg.text, msg.buttons);
    else await sendText(to, msg.text);
  }
}

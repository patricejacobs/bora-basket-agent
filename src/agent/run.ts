import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import * as repo from '../db/repo.ts';
import { SYSTEM_PROMPT } from './system-prompt.ts';
import { TOOL_DEFS, executeTool, type ToolContext } from './tools.ts';
import { buildConversationContext, buildTimeContext, CONTEXT_MARKER } from './context.ts';
import { splitReply } from './pacing.ts';
import type { OutboundMessage, IncomingImage } from '../channels/types.ts';

const client = new Anthropic({ apiKey: config.anthropic.apiKey || undefined });

/** Conversations older than this start fresh — a shopper returning next week is not mid-order. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Roughly a dozen exchanges of scrollback; older context is dropped at turn boundaries. */
const MAX_HISTORY_MESSAGES = 40;
/** Trailing text shorter than this, sent alongside buttons, is treated as filler. */
const FILLER_TEXT_LIMIT = 80;

/**
 * Server-side refusal fallback (Claude Opus 5). Disabled automatically if the
 * account or SDK build rejects the beta, so a prototype never hard-fails on it.
 */
let useRefusalFallback = true;

/**
 * Drops the oldest messages, but only ever cuts at the start of a customer turn,
 * so a tool_use block is never separated from its tool_result.
 */
function trimHistory(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  let start = history.length - MAX_HISTORY_MESSAGES;
  while (start < history.length) {
    const msg = history[start];
    // A customer turn is a valid cut point; a tool_result turn is not, because
    // it must stay attached to the assistant message that requested it. Photo
    // turns carry array content, so testing for a plain string is not enough.
    const isCustomerTurn =
      msg?.role === 'user' &&
      (typeof msg.content === 'string' || !msg.content.some((b) => b.type === 'tool_result'));
    if (isCustomerTurn) break;
    start++;
  }
  // No clean cut point found — safest is to start over rather than send a broken transcript.
  return start >= history.length ? [] : history.slice(start);
}

/**
 * Narrows a MIME type to what the API accepts. The channel already filters, but
 * this keeps the guarantee at the boundary where it is actually used, rather
 * than asserting a type we merely hope is right.
 */
type ClaudeMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
function toClaudeMediaType(mime: string): ClaudeMediaType {
  switch (mime) {
    case 'image/png':
      return 'image/png';
    case 'image/gif':
      return 'image/gif';
    case 'image/webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

/**
 * Removes context notes from earlier turns.
 *
 * Each turn injects the current time. Without this the transcript would fill
 * with stale timestamps that contradict the newest one, and a model reading back
 * over them has no way to tell which is now.
 */
function dropStaleContext(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.filter(
    (m) =>
      !(m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(CONTEXT_MARKER)),
  );
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The API rejects text blocks that are empty or whitespace-only. One such block
 * stored in the transcript fails every later request for that customer, so strip
 * them before they are ever persisted. If stripping empties the message, keep a
 * truthful placeholder rather than an invalid zero-block message.
 */
function sanitizeBlocks(
  content: readonly Anthropic.ContentBlock[],
  fallbackText: string,
): Anthropic.ContentBlockParam[] {
  const kept = content.filter((b) => b.type !== 'text' || b.text.trim().length > 0);
  if (kept.length > 0) return kept as unknown as Anthropic.ContentBlockParam[];
  return [{ type: 'text', text: fallbackText.trim() || '(sent without text)' }];
}

/**
 * Replaces image blocks with a short note before the transcript is stored.
 *
 * A photographed list is a megabyte or more of base64. Keeping it in history
 * would persist it to disk and re-send it on every later turn of the
 * conversation, which is slow and expensive for no benefit — the model has
 * already read it, and what matters afterwards is what it found.
 */
function stripImages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    if (!msg.content.some((b) => b.type === 'image')) return msg;
    return {
      ...msg,
      content: msg.content.map((b) =>
        b.type === 'image' ? { type: 'text' as const, text: '[photo of a shopping list]' } : b,
      ),
    };
  });
}

/** Repairs transcripts written before the sanitiser existed, or by an older build. */
function sanitizeHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') return msg;
    const kept = msg.content.filter((b) => b.type !== 'text' || b.text.trim().length > 0);
    if (kept.length === msg.content.length) return msg;
    return {
      ...msg,
      content: kept.length > 0 ? kept : [{ type: 'text', text: '(sent without text)' }],
    };
  });
}

async function createMessage(
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  const params = {
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ] as Anthropic.TextBlockParam[],
    thinking: { type: 'adaptive' } as const,
    output_config: { effort: config.anthropic.effort },
    tools: TOOL_DEFS,
    messages,
  };

  if (useRefusalFallback) {
    try {
      // On a policy decline the API re-runs the request on a suitable fallback
      // model inside the same call, rather than leaving the customer with nothing.
      const response = await client.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      return response as Anthropic.Message;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(message)) {
        console.warn('[agent] refusal fallback unavailable, continuing without it:', message);
        useRefusalFallback = false;
      } else {
        throw err;
      }
    }
  }

  return client.messages.create(params);
}

export type AgentResult = { outbound: OutboundMessage[] };

/**
 * Runs one customer message through the agent loop and returns everything that
 * should be sent back. Persisting conversation state is part of this call.
 */
export async function runAgent(
  phone: string,
  userText: string,
  image?: IncomingImage,
): Promise<AgentResult> {
  const stored = repo.loadHistory(phone);
  const expired =
    stored.updatedAt !== null && Date.now() - new Date(stored.updatedAt).getTime() > SESSION_TTL_MS;

  const messages: Anthropic.MessageParam[] = expired
    ? []
    : dropStaleContext(sanitizeHistory(trimHistory(stored.history as Anthropic.MessageParam[])));

  const startingFresh = messages.length === 0;

  // The image goes before the text: Claude reads a document more reliably when
  // it arrives before the question about it.
  messages.push(
    image
      ? {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: toClaudeMediaType(image.mediaType),
                data: image.base64,
              },
            },
            { type: 'text', text: userText },
          ],
        }
      : { role: 'user', content: userText },
  );

  // Every turn gets the current time; the first also gets who this customer is,
  // so a regular is greeted as one rather than asked their name again.
  //
  // Sent as a mid-conversation system message: it must follow a user turn and be
  // last, and it keeps the volatile clock out of the cached system prefix. The
  // previous turn's copy is dropped first (see dropStaleContext) so the
  // transcript never accumulates contradicting timestamps.
  messages.push({
    role: 'system',
    content: startingFresh ? buildConversationContext(phone) : buildTimeContext(),
  });

  const ctx: ToolContext = { phone, outbound: [] };
  let finalText = '';

  for (let iteration = 0; iteration < config.anthropic.maxToolIterations; iteration++) {
    const response = await createMessage(messages);

    if (response.stop_reason === 'refusal') {
      repo.saveHistory(phone, stripImages(messages));
      return {
        outbound: [
          {
            kind: 'text',
            text: "Sorry, I can't help with that one. Ask me about groceries and I'll get right on it — or a staff member can follow up here.",
          },
        ],
      };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0 && response.stop_reason !== 'pause_turn') {
      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      // When the model deliberately returns no text after send_buttons, the button
      // body is what the customer actually received — record that, not a blank turn.
      const lastButtons = ctx.outbound.filter((m) => m.kind === 'buttons').at(-1);
      messages.push({
        role: 'assistant',
        content: sanitizeBlocks(response.content, finalText || lastButtons?.text || ''),
      });
      break;
    }

    messages.push({ role: 'assistant', content: sanitizeBlocks(response.content, '') });

    if (response.stop_reason === 'pause_turn') continue;

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tool) => {
      let content: string;
      try {
        content = executeTool(tool.name, tool.input, ctx);
      } catch (err) {
        console.error(`[agent] tool ${tool.name} threw:`, err);
        content = JSON.stringify({
          error: 'That step failed unexpectedly. Apologise briefly and offer to try again.',
        });
      }
      return { type: 'tool_result', tool_use_id: tool.id, content };
    });

    messages.push({ role: 'user', content: toolResults });
  }

  repo.saveHistory(phone, stripImages(trimHistory(messages)));

  // Assemble the reply. Buttons queued via send_buttons carry their own body text,
  // so drop trailing prose that just restates it.
  const outbound: OutboundMessage[] = [];
  // Photos come first: a picture then a question reads the way a person sends it.
  outbound.push(...ctx.outbound.filter((m) => m.kind === 'image'));
  const buttonMessages = ctx.outbound.filter((m) => m.kind === 'buttons');

  if (buttonMessages.length > 0) {
    const lastBody = normalize(buttonMessages[buttonMessages.length - 1]?.text ?? '');
    const textNorm = normalize(finalText);
    const isRestatement =
      textNorm.length === 0 || lastBody.includes(textNorm) || textNorm.includes(lastBody);
    // A short line alongside buttons is almost always filler ("I'll place it once
    // you confirm") and costs the customer a second notification for nothing.
    // Anything substantial enough to carry new information survives.
    const isFiller = textNorm.length < FILLER_TEXT_LIMIT;
    if (!isRestatement && !isFiller) outbound.push({ kind: 'text', text: finalText });
    outbound.push(...buttonMessages);
  } else if (finalText) {
    for (const part of splitReply(finalText)) outbound.push({ kind: 'text', text: part });
  } else {
    outbound.push({
      kind: 'text',
      text: "Sorry, I lost my train of thought there. Could you say that again?",
    });
  }

  return { outbound };
}

/** Maps an API failure to something a customer can read, and logs the real cause. */
export function friendlyErrorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error('[agent] ANTHROPIC_API_KEY is missing or invalid.');
    return "We're having a technical problem on our side. A staff member will follow up here shortly.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "We're busier than usual right now — please send that again in a moment.";
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`[agent] API error ${err.status}:`, err.message);
    return "Something went wrong on our side. Please try again in a moment.";
  }
  console.error('[agent] unexpected error:', err);
  return "Something went wrong on our side. Please try again in a moment.";
}

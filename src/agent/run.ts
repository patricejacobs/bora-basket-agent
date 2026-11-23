import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import * as repo from '../db/repo.ts';
import { SYSTEM_PROMPT } from './system-prompt.ts';
import { TOOL_DEFS, executeTool, type ToolContext } from './tools.ts';
import { expandShortLinks } from '../maps-link.ts';
import { buildConversationContext, buildTurnContext, CONTEXT_MARKER } from './context.ts';
import { splitReply } from './pacing.ts';
import type { OutboundMessage, IncomingImage } from '../channels/types.ts';

const client = new Anthropic({ apiKey: config.anthropic.apiKey || undefined });

/** Conversations older than this start fresh — a shopper returning next week is not mid-order. */
/**
 * How long a conversation stays open. Exported so the service menu expires on
 * exactly the same clock — if the two disagreed, a customer could be mid-service
 * with an agent that had forgotten the conversation, or re-greeted while the
 * agent still held their cart.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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
  // A short Google link becomes the URL it points at before anything reads the
  // message. Done here, at the edge, because every reader below this line is
  // synchronous and following a redirect is not - and because a customer who
  // pasted a link has already told us where they are. The raw text is logged
  // before this runs, so nothing about what they actually sent is lost.
  userText = await expandShortLinks(userText);

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
    content: startingFresh ? buildConversationContext(phone) : buildTurnContext(phone),
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

      // When the model deliberately returns no text after send_buttons or
      // request_location, that message's body is what the customer actually
      // received — record that, not a blank turn.
      const lastButtons = ctx.outbound
        .filter((m) => m.kind === 'buttons' || m.kind === 'location_request')
        .at(-1);
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

  return { outbound: assembleReply(finalText, ctx.outbound) };
}

/**
 * Turns the model's closing words plus whatever its tools queued into the
 * messages the customer actually receives.
 *
 * Pulled out of the loop above so it can be tested without a model call. The
 * rules here are about what a phone screen should show, not about the agent:
 * a customer should never get the same sentence twice, nor a notification that
 * says nothing, nor — as this once did — a bare "share your pin" in place of
 * the answer to what they just asked for.
 */
/**
 * Takes a greeting off the front of a reply that should not have one.
 *
 * The guard behind the instruction, because an instruction is a request. The
 * shop told the agent not to greet a conversation already under way and the
 * agent greeted anyway, six taps into a booking: "Good evening, Shawn. I can
 * get a car to you..." — and good evening is not a thing you say to somebody
 * you have been talking to for five minutes.
 *
 * Only the opening clause goes, and only when something is left after it.
 * The rest of the sentence is the actual answer and must survive: "Good
 * evening, Shawn. I can get a car to you" becomes "I can get a car to you".
 *
 * All four languages, because the greeting is written in whichever one the
 * customer uses.
 */
const HELLO =
  '(?:good\\s+(?:morning|afternoon|evening|day)|hello|hi|hey|welcome(?:\\s+back)?' +
  '|buen(?:os|as)\\s+(?:d[ií]as|tardes|noches)|hola|bienvenid[oa]' +
  '|bom\\s+dia|boa\\s+(?:tarde|noite)|ol[áa]|bem[-\\s]vind[oa]' +
  '|您好|你好|早上好|下午好|晚上好|欢迎(?:回来)?)';

// The whole opening SENTENCE, not just the hello. "Good evening, Shawn." is
// one greeting, and stopping at the comma would leave the customer reading
// "Shawn. I can get a car to you" — which is worse than the greeting was.
// So the run to the first full stop goes with it, and a comma is not a full
// stop.
const GREETING = new RegExp('^\\s*' + HELLO + '[^.!?。！\\n—–]{0,40}[.!?。！—–]+\\s*', 'iu');

export function sanitizeGreeting(text: string, underway: boolean): string {
  if (!underway || !text) return text;
  const trimmed = text.replace(GREETING, '').trimStart();
  // A reply that was nothing BUT a greeting stays as it was: removing it
  // would leave the customer with an empty message, which is worse.
  if (trimmed.length === 0) return text;

  // The greeting took the capital letter with it — "Hi Shawn — your driver
  // is on the way" must not come back starting in lower case.
  const first = trimmed[0]!;
  return first === first.toLowerCase() && first !== first.toUpperCase()
    ? first.toUpperCase() + trimmed.slice(1)
    : trimmed;
}

/**
 * Words about the shop's own plumbing, which a customer never needs.
 *
 * Reported from a live trip: *"That's Meadow Bank to Belfield, five of you —
 * the fare's just gone over with buttons, so tap Book it when you're ready."*
 * The first half is a proper read-back. The second half is the tool's own
 * note to the model — `the fare and its three buttons have already gone` —
 * repeated to the passenger, who does not know what a button message is and
 * can see the thing itself arriving underneath.
 *
 * The instruction said to say nothing further about the fare, and it was
 * followed to the letter: no figure was repeated. A prompt is a request,
 * not a guard.
 */
const MECHANISM = /\b(button|buttons|tap|taps|tapping|tapped|press|click|clicking)\b/i;

/** Where one clause of a sentence ends and the next begins. */
const CLAUSES = /\s*(?:[—–]|;|,\s*(?:so|and then)\b)\s*/;

/**
 * Takes the plumbing back out of a reply that is going out WITH buttons.
 *
 * Clause by clause, not sentence by sentence, because the offending half is
 * usually hung off a perfectly good one with a dash. What is left keeps its
 * meaning: the read-back survives, the narration goes.
 *
 * Only when buttons are actually attached. Elsewhere "tap the link" may be
 * the only instruction a customer has, and a guard that eats it would be
 * worse than the thing it guards against.
 */
export function stripMechanism(text: string): string {
  if (!text || !MECHANISM.test(text)) return text;

  const kept = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      if (!MECHANISM.test(sentence)) return sentence;
      const clauses = sentence.split(CLAUSES).filter((c) => c.trim() !== '');
      const left = clauses.filter((c) => !MECHANISM.test(c));
      if (left.length === 0) return '';
      // The terminator went with the clause that carried it.
      const rejoined = left.join(' — ').replace(/[\s,;—–]+$/, '');
      return /[.!?]$/.test(rejoined) ? rejoined : `${rejoined}.`;
    })
    .filter((s) => s.trim() !== '')
    .join(' ')
    .trim();

  // Nothing but plumbing: the buttons are the whole message, which is what
  // they are for.
  return kept;
}

export function assembleReply(finalText: string, queued: OutboundMessage[]): OutboundMessage[] {
  const outbound: OutboundMessage[] = [];
  const photoMessages = queued.filter((m) => m.kind === 'image');
  const buttonMessages = queued.filter((m) => m.kind === 'buttons');
  const listMessages = queued.filter((m) => m.kind === 'list');
  const locationRequests = queued.filter((m) => m.kind === 'location_request');

  /** True when the prose only says again what the prompt's own body already says. */
  const restates = (body: string, prose: string = finalText): boolean => {
    const bodyNorm = normalize(body);
    const textNorm = normalize(prose);
    return textNorm.length === 0 || bodyNorm.includes(textNorm) || textNorm.includes(bodyNorm);
  };

  // A list, which is a screen the SHOP built and the whole content of the
  // turn.
  //
  // There was no branch for one. `start_delivery` hands checkout over and
  // queues "Where are we delivering?" with its list of places — and that
  // message was dropped on the floor, every time, leaving the customer with
  // whatever courtesy line the model had added ("Checkout is open for you")
  // and nothing to tap. Worse when the model obeyed its instruction to say
  // nothing: the turn then had no content at all and fell through to "Sorry,
  // I lost my train of thought there", which is the shop apologising for a
  // screen it had just thrown away.
  //
  // Read before buttons, and by the same rule: the list is the message, and
  // prose beside it is plumbing.
  if (listMessages.length > 0) {
    const lastBody = listMessages[listMessages.length - 1]?.text ?? '';
    const said = stripMechanism(finalText);
    const isFiller = normalize(said).length < FILLER_TEXT_LIMIT;
    if (!restates(lastBody, said) && !isFiller) outbound.push({ kind: 'text', text: said });
    outbound.push(...photoMessages);
    outbound.push(...listMessages);
    outbound.push(...buttonMessages);
    outbound.push(...locationRequests);
  } else if (buttonMessages.length > 0) {
    const lastBody = buttonMessages[buttonMessages.length - 1]?.text ?? '';
    // Without the narration, and measured without it too: a line that is
    // only plumbing becomes nothing and is dropped as the filler it was.
    const said = stripMechanism(finalText);
    // A short line alongside buttons is almost always filler ("I'll place it once
    // you confirm") and costs the customer a second notification for nothing.
    // Anything substantial enough to carry new information survives.
    const isFiller = normalize(said).length < FILLER_TEXT_LIMIT;
    if (!restates(lastBody, said) && !isFiller) outbound.push({ kind: 'text', text: said });
    outbound.push(...photoMessages);
    outbound.push(...buttonMessages);
    outbound.push(...locationRequests);
  } else if (locationRequests.length > 0) {
    // Unlike buttons, a pin request is a side errand: the turn's real content is
    // the answer about the shopping, and the button body only asks for the
    // location. So short prose is kept here — dropping it as filler left a
    // customer who had just listed three items with nothing back but "share
    // your pin", and no word on whether anything had gone in the cart.
    const lastBody = locationRequests[locationRequests.length - 1]?.text ?? '';
    if (!restates(lastBody)) {
      for (const part of splitReply(finalText)) outbound.push({ kind: 'text', text: part });
    }
    outbound.push(...photoMessages);
    outbound.push(...locationRequests);
  } else if (finalText) {
    for (const part of splitReply(finalText)) outbound.push({ kind: 'text', text: part });
    // After the words: a photo arriving before "good morning" reads oddly.
    outbound.push(...photoMessages);
  } else if (photoMessages.length > 0) {
    outbound.push(...photoMessages);
  } else {
    outbound.push({
      kind: 'text',
      text: "Sorry, I lost my train of thought there. Could you say that again?",
    });
  }

  return outbound;
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

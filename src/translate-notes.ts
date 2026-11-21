/**
 * The customer's own words, put into English for the people who act on them.
 *
 * Everything the shop SAYS to a driver or a kitchen is written in English
 * already. Two things are not, because they are not the shop's words: the
 * doorstep note and the note to the kitchen. Those are copied onto the card
 * exactly as the customer typed them — which is right, and which left a
 * driver holding *"Ligue quando chegar"* and a cook holding *"sou alérgico a
 * amendoim"*.
 *
 * So they are translated ONCE, when the order is dispatched, and both are
 * kept. Three rules, all of them about what happens when this goes wrong:
 *
 *   - The original is never replaced, only accompanied. A driver who cannot
 *     make sense of the English has the customer's own words underneath to
 *     show somebody or read down the phone.
 *   - Nothing waits on it. It runs on the dispatch path, which is already
 *     talking to WhatsApp, and never on the path that replies to a customer.
 *   - A failure is silence, not an error. No key, no network, a slow model,
 *     anything at all: the card goes out with the original alone, exactly as
 *     it does today.
 *
 * Only notes. Never an address: `Lot 8 BV` is not a sentence, and a place
 * name translated is a driver sent somewhere else.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.ts';
import { LANGUAGE_NAME, type Language } from './language.ts';

const client = new Anthropic({ apiKey: config.anthropic.apiKey || undefined });

/** Small, because this is one line of plain speech and the card is waiting. */
const MODEL = 'claude-haiku-5-5';

/** Past this, the card goes out without it. A driver waiting is worse. */
const TIMEOUT_MS = 6000;

const PROMPT = [
  'Translate this note from a delivery customer into English.',
  '',
  'It is one short instruction to a driver or a cook: where a door is, what to',
  'leave out of the food, what somebody is allergic to. Translate it plainly',
  'and completely, as an instruction, and keep it about the same length.',
  '',
  'Keep place names, street names, lot numbers, shop names and people’s names',
  'exactly as written — they are addresses, not words. If it is already',
  'English, or is only a name or a number, reply with it unchanged.',
  '',
  'Reply with the translation and nothing else: no quotes, no explanation, no',
  'note about what you did.',
].join('\n');

/**
 * The note in English, or '' when there is nothing to add.
 *
 * Empty rather than the original when it does not translate, so the caller
 * can tell "this is the English" from "there is no English to show" and does
 * not print the same line twice.
 */
export async function noteInEnglish(note: string, from: Language): Promise<string> {
  const said = note.trim();
  if (!said || from === 'en' || !config.anthropic.apiKey) return '';

  try {
    const answer = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 200,
        system: PROMPT,
        messages: [
          { role: 'user', content: `Language: ${LANGUAGE_NAME[from]}\nNote: ${said}` },
        ],
      },
      { timeout: TIMEOUT_MS },
    );

    const text = answer.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()
      // A model that answers in quotes is answering correctly in the wrong
      // clothes. Stripped here rather than asked for again.
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .slice(0, 200);

    // Unchanged is the same as nothing: the card would print one line twice.
    return text.toLowerCase() === said.toLowerCase() ? '' : text;
  } catch (err) {
    console.error('[translate] note not translated:', err);
    return '';
  }
}

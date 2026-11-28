/**
 * Going back to the people the base had to turn away.
 *
 * A customer who asks for a car when nobody is on the road is told no. That
 * much is honest and unavoidable. What was not honest was what came next:
 *
 *   "Message me when you are ready and I will check again straight away."
 *
 * He WAS ready. He had given the base his pickup, his destination, how many
 * of them there were and that they had no luggage, and the base had written
 * every word of it down. The only party not ready was the base — and the
 * sentence put the next move on him, so the booking it was holding would sit
 * there until he thought to ask again. Most people do not ask twice.
 *
 * So the waiting is recorded where it belongs. When an associate comes on
 * duty, the base goes back to whoever it turned away, with what they asked
 * for read back to them and one tap to go ahead.
 *
 * Two rules decide who hears about it, and they differ by service because
 * the jobs differ:
 *
 *   a delivery or a parcel QUEUES. One associate on the road can take Ann's
 *   order and three more behind it, which is how the base has always worked,
 *   so everybody waiting for one is told.
 *
 *   a ride does NOT queue. Four people standing at Kitty need a car now, and
 *   telling two passengers there is a car when there is one is the same lie
 *   told twice. So taxis are told oldest first, one per associate arriving.
 */
import { config } from './config.ts';
import * as repo from './db/repo.ts';
import { t, type Language } from './language.ts';
import { languageFor } from './services.ts';
import { deliver } from './channels/whatsapp-send.ts';
import type { OutboundMessage } from './channels/types.ts';

const nl = String.fromCharCode(10);

/** The two answers to "somebody is on the road now". */
export const WAIT_GO = 'wait:go';
export const WAIT_NO = 'wait:no';

export function isWaitingId(id: string): boolean {
  const said = String(id ?? '').trim();
  return said === WAIT_GO || said === WAIT_NO;
}

/**
 * Records somebody turned away, and gives back the words to tell them.
 *
 * One function for both paths into a refusal — the agent's tools and the
 * shop's own checkout gate — because a customer refused at the gate was
 * getting a generic "something went wrong" while a customer refused through
 * the agent got an explanation. Same fact, two answers, and the gate's was
 * the worse one.
 */
export function recordTurnedAway(
  phone: string,
  service: string,
  summary: string,
  payload = '',
): void {
  if (config.waitingListMinutes <= 0) return;
  repo.noteWaiting(phone, service, summary, payload);
}

/** What the base says when there is nobody out. Held basket included. */
export function nobodyOutMessage(lang: Language, held: string): OutboundMessage {
  return {
    kind: 'text',
    text: [
      t('nobody_out', lang),
      ...(held ? [t('nobody_out_held', lang, { what: held })] : []),
      '',
      // Only promised when the base can keep it. With the list switched off
      // there is nothing coming, and saying otherwise is the original fault
      // wearing better clothes.
      config.waitingListMinutes > 0 ? t('nobody_out_back', lang) : t('wait_dropped', lang),
    ].join(nl),
  };
}

/** The message that goes back when somebody comes on duty. */
export function callbackMessage(row: repo.WaitingCustomer, lang: Language): OutboundMessage {
  const taxi = row.service === 'taxi';
  const parcel = row.service === 'parcel';

  return {
    kind: 'buttons',
    text: t(taxi ? 'wait_taxi' : parcel ? 'wait_parcel' : 'wait_order', lang, {
      what: row.summary,
      nl,
    }),
    buttons: [
      {
        id: WAIT_GO,
        title: t(taxi ? 'wait_go_taxi' : parcel ? 'wait_go_parcel' : 'wait_go_order', lang),
      },
      { id: WAIT_NO, title: t('wait_no', lang) },
    ],
  };
}

/**
 * One pass, run when an associate comes on duty.
 *
 * Returns the phones told, for the caller to log. Stale rows are dropped on
 * the way through rather than by a sweep of their own: this is the only
 * moment the list is read, so it is the only moment it needs tidying.
 */
export async function tellWhoeverIsWaiting(): Promise<string[]> {
  const window = config.waitingListMinutes;
  if (window <= 0) return [];

  repo.dropStaleWaiting(window);
  const waiting = repo.waitingList(window);
  if (waiting.length === 0) return [];

  // One car, one passenger. The rest of the list keeps its place.
  let ridesToGive = 1;
  const told: string[] = [];

  for (const row of waiting) {
    if (row.service === 'taxi') {
      if (ridesToGive <= 0) continue;
      ridesToGive -= 1;
    }

    repo.markWaitingTold(row.phone);
    try {
      await deliver(row.phone, [callbackMessage(row, languageFor(row.phone))]);
      told.push(row.phone);
    } catch (err) {
      console.error(`[waiting] could not go back to ${row.phone}:`, err);
    }
  }

  if (told.length > 0) console.log(`[waiting] went back to ${told.length} customer(s)`);
  return told;
}

/**
 * The next passenger in line, after one declines or goes unanswered.
 *
 * A slot given up must not be wasted: it is the only car there is, and the
 * person behind them has been waiting longer than anybody else left.
 */
export async function offerTheRideOn(after: string): Promise<string> {
  const window = config.waitingListMinutes;
  if (window <= 0) return '';
  if (!repo.anyoneOnDuty()) return '';

  const next = repo.waitingList(window).find((row) => row.service === 'taxi' && row.phone !== after);
  if (!next) return '';

  repo.markWaitingTold(next.phone);
  try {
    await deliver(next.phone, [callbackMessage(next, languageFor(next.phone))]);
    return next.phone;
  } catch (err) {
    console.error(`[waiting] could not pass the ride to ${next.phone}:`, err);
    return '';
  }
}

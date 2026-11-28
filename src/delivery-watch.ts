/**
 * Watching whether WhatsApp is actually carrying the base's messages.
 *
 * The base sent 165 messages, Meta accepted all 165, and delivered 20 of
 * them nowhere: `(131042) Message failed to send because your WhatsApp
 * Business account has unsettled payments`. From the base's side everything
 * looked sent. From the customer's side it had gone quiet. That ran for
 * nineteen hours and the first anybody knew was somebody noticing.
 *
 * It was all there the whole time — a counter on /health and a line in the
 * log, neither of which anybody reads at one in the morning. A number
 * nobody is watching is not a warning.
 *
 * Two kinds of failure, and they mean opposite things:
 *
 *   ACCOUNT-LEVEL — unpaid, restricted, token dead. The whole shop is mute,
 *   every customer at once, and it will not fix itself. Raised on the FIRST
 *   one, because the second is already too late.
 *
 *   PER-RECIPIENT — a number not on WhatsApp, a closed 24-hour window. One
 *   customer, routine, and raising it every time would teach everybody to
 *   ignore the alarm. Raised only when the RATE says something is wrong.
 *
 * And the cruel part: the channel that breaks is the channel the alarm
 * would use. So it goes out twice — over WhatsApp, which may well work
 * since these blocks are usually partial, and to a URL that is not WhatsApp
 * at all.
 */
import { config } from './config.ts';
import * as repo from './db/repo.ts';
import { sendText } from './channels/whatsapp-send.ts';

const nl = String.fromCharCode(10);

/**
 * Meta's codes for "the base itself is the problem".
 *
 * Matched on the number rather than the words, because the words change —
 * the same block read "unsettled payments" at nine o'clock and "one or more
 * errors related to your payment method" twenty minutes later.
 */
const ACCOUNT_LEVEL = new Set([
  131042, // payment issue: unsettled, declined, no method
  131031, // account locked or restricted
  133010, // the number is not registered
  133004, // the business account is unavailable
  368, // temporarily blocked for policy violations
  131051, // sender account restricted
]);

/** The words, for a code the list has not met yet. */
const ACCOUNT_WORDS =
  /unsettled|payment|billing|pay now|restricted|disabled|suspend|not registered|blocked/i;

export function isAccountLevel(code: number, reason = ''): boolean {
  return ACCOUNT_LEVEL.has(code) || ACCOUNT_WORDS.test(reason);
}

/** How long between repeats while a fault persists. Nagging, not flooding. */
const REPEAT_MS = 60 * 60 * 1000;

/** The alarm itself, out by every road that is not the broken one. */
async function raise(body: string): Promise<void> {
  console.error(`[delivery] ${body.replace(/\n/g, ' ')}`);

  // Not WhatsApp. One setting, any service that pings a telephone.
  const url = config.alertWebhookUrl;
  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
    } catch (err) {
      console.error('[delivery] the alert webhook could not be reached:', err);
    }
  }

  // And WhatsApp anyway: a block like this is usually partial, so the
  // message that says "nothing is getting through" often gets through.
  for (const staff of config.staffNumbers) {
    try {
      await sendText(staff, body);
    } catch (err) {
      console.error(`[delivery] could not tell ${staff}:`, err);
    }
  }

  if (!url && config.staffNumbers.length === 0) {
    console.error(
      '[delivery] NOBODY WAS TOLD — STAFF_NUMBERS is empty and ALERT_WEBHOOK_URL is not set.',
    );
  }
}

/** A message Meta would not deliver. */
export async function noteDeliveryFailure(
  phone: string,
  code: number,
  reason: string,
  now = new Date(),
): Promise<void> {
  const state = repo.noteSendFailure(phone, code, reason, isAccountLevel(code, reason), now);

  if (state.accountLevel) {
    const since = state.failingSince ? new Date(state.failingSince) : now;
    const hours = Math.max(0, (now.getTime() - since.getTime()) / 3_600_000);
    if (state.alertNow) {
      await raise(
        [
          '🛑 *WhatsApp is not delivering the base’s messages.*',
          '',
          `Meta refused delivery to +${phone}:`,
          reason || `error ${code}`,
          '',
          state.failures === 1
            ? 'That is the first one. Customers are being answered into silence from now until it is fixed.'
            : `${state.failures} messages have failed${hours >= 1 ? ` over ${hours.toFixed(1)} hours` : ''}.`,
          '',
          'Nothing on this side can fix it — it is the WhatsApp Business account. Check the Billing Hub in Meta Business Manager.',
        ].join(nl),
      );
    }
    return;
  }

  // One recipient at a time is ordinary. A lot of them is not.
  if (state.alertNow) {
    await raise(
      [
        '⚠️ *Messages are failing to reach customers.*',
        '',
        `${state.windowFailures} of the last ${state.windowFailures + state.windowSent} failed.`,
        `Most recent: +${phone} — ${reason || `error ${code}`}`,
        '',
        'Not a billing block, so it is worth looking at what is being sent and to whom.',
      ].join(nl),
    );
  }
}

/** A message that arrived. Which is also how the base learns it is well again. */
export async function noteDeliverySuccess(now = new Date()): Promise<void> {
  const healed = repo.noteSendSuccess(now);
  if (!healed) return;

  const hours = healed.since ? (now.getTime() - new Date(healed.since).getTime()) / 3_600_000 : 0;
  await raise(
    [
      '✅ *WhatsApp is delivering again.*',
      '',
      `${healed.failures} message${healed.failures === 1 ? '' : 's'} failed` +
        `${hours >= 1 ? ` over ${hours.toFixed(1)} hours` : ''}, and the last one has now gone through.`,
    ].join(nl),
  );
}

/** What /health says about it, as a fault rather than a number. */
export function deliveryFault(): {
  failing: boolean;
  since?: string;
  failures?: number;
  reason?: string;
} {
  const state = repo.sendHealth();
  if (!state.failingSince) return { failing: false };
  return {
    failing: true,
    since: state.failingSince,
    failures: state.failures,
    reason: state.lastReason,
  };
}

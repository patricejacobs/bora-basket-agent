/**
 * The taxi tariff — which is, for now, the waiting charge and nothing else.
 *
 * The shop quotes no fare. The driver agrees that with the passenger in the
 * car, and every message in the system is written to keep it that way. What
 * the shop does set is the waiting rate, so that two drivers kept waiting the
 * same twenty minutes do not charge two different figures and leave the shop
 * explaining why.
 *
 * It goes on the DRIVER's card and nowhere near the passenger's messages.
 * Publishing half a fare — the waiting but not the fare it is added to —
 * invites the obvious question, and the shop has no answer to it.
 *
 * Ten minutes are free. A passenger locking a door, finding a bag, saying
 * goodbye to somebody is not a passenger who has kept a car waiting, and
 * $800 for three minutes is a fare nobody will pay twice. After that it is
 * blocks: any part of a block is a whole one, because a driver sitting at a
 * kerb cannot be asked to bill by the minute.
 */
import { config, money } from './config.ts';
import { fareBetween } from './zones.ts';

/**
 * What the shop charges for a trip, from the same tariff as everything else.
 *
 * The delivery table prices one journey - out of Georgetown - and a taxi runs
 * from anywhere to anywhere, which is why this was left to the driver for so
 * long. `fareBetween` prices both ends, so the same file that says what a
 * delivery to Farm costs now says what a trip from Georgetown to Farm costs,
 * and they are the same figure.
 *
 * Null when either end is not in the tariff. Better to say the driver will
 * agree it than to invent a number for a place the shop cannot name.
 */
export function taxiFare(pickup: string, destination: string): { fee: number; say: string } | null {
  const quoted = fareBetween(pickup, destination);
  if (!quoted) return null;
  return { fee: quoted.fee, say: `${quoted.explanation} is ${money(quoted.fee)}` };
}

/**
 * What a wait costs, in money.
 *
 * Rounded UP to the block. That is the rule as the shop set it and it is the
 * only version a driver can apply without a calculator: eleven minutes is a
 * block, forty-one is two.
 */
export function waitingCharge(minutes: number): number {
  const { waitFreeMinutes, waitBlockMinutes, waitBlockFee } = config.taxi;
  if (waitBlockMinutes <= 0 || waitBlockFee <= 0) return 0;

  const chargeable = Math.max(0, minutes - waitFreeMinutes);
  if (chargeable <= 0) return 0;
  return Math.ceil(chargeable / waitBlockMinutes) * waitBlockFee;
}

/**
 * The line the driver reads, or '' when the shop charges nothing for waiting.
 *
 * Written out in full rather than as a rate, because a rate is something to
 * work out at a kerb and a sentence is something to read.
 */
export function waitingLine(): string {
  const { waitFreeMinutes, waitBlockMinutes, waitBlockFee } = config.taxi;
  if (waitBlockMinutes <= 0 || waitBlockFee <= 0) return '';

  const free = waitFreeMinutes > 0 ? `First ${waitFreeMinutes} min free, then ` : '';
  return `⏱ *Waiting:* ${free}${money(waitBlockFee)} per ${waitBlockMinutes} min — part of a block counts as a whole one.`;
}

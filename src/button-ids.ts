/**
 * What a tapped button means, decided in one place.
 *
 * WhatsApp sends back both the TITLE a button showed and the ID the shop
 * gave it. The title is the right answer for most of them — the agent's own
 * buttons say "Grocery shopping", and the model has to receive those words —
 * but an id can carry what no 24-character title can: an order number, a
 * corridor and a page, a meaning that survives translation into Spanish.
 *
 * The failure this exists to stop has now happened three times:
 *
 *   `changedest_7` had no reader, so the driver's "Change destination" sent
 *   its own title and was answered with the help text.
 *
 *   `dest_ok_7` had none, so the passenger's answer arrived as a translated
 *   title and matched nothing.
 *
 *   `callcust_7` had none, so "📞 Call customer" sent three words with no
 *   order number in them and the shop replied that it could not find one.
 *
 * Each time the button looked right, did nothing, and the person tapping it
 * had no way to know. So the chain lives here rather than inside the webhook,
 * and the suite sweeps every id the shop can send through it: an id with
 * nothing behind it is now a failing test rather than a silent dead button.
 *
 * Returns the text to act on, or null to fall back to the title — which is
 * still the main path, and deliberately so.
 */
import { commandFromButtonId, isCallCustomerId, isDestAnswerId } from './order-status.ts';
import { isPickerId } from './place-picker.ts';
import { isLanguageId } from './language-choice.ts';
import { isCheckoutId } from './delivery-checkout.ts';
import { isAisleId } from './aisles.ts';
import { dutyCommandFor } from './duty-buttons.ts';
import { isWaitingId } from './waiting-list.ts';

/** Every id whose MEANING is in the id rather than in what it said. */
const PASSED_THROUGH: ((id: string) => boolean)[] = [
  // The place picker: a corridor and a page, which no title could hold.
  isPickerId,
  // A passenger answering the destination their driver raised. Titles are
  // words in their own language, so matching on those is matching on a
  // translation.
  isDestAnswerId,
  // The opening screen's three. Their titles ARE the language names, which
  // is the one case where the title would nearly work — read anyway, so the
  // shop never acts on a word somebody could type by accident.
  isLanguageId,
  // Checkout's own: the three answers to a price, and the two about a pin.
  isCheckoutId,
  // The two that ride on every message in the grocery.
  isAisleId,
  // "Call customer", on a change of address whose pin does not match.
  isCallCustomerId,
  // "Somebody is on the road now", sent to whoever was turned away.
  isWaitingId,
];

export function readButtonId(id: string): string | null {
  const said = String(id ?? '').trim();
  if (said === '') return null;
  // A dispatch button, whose id carries the order number and whose title is
  // therefore free to be a plain word.
  const asCommand = commandFromButtonId(said);
  if (asCommand !== null) return asCommand;
  // Clock on and clock off, which mean the same as the words a driver can
  // type. `duty_off` had no reader at all and worked only because its title
  // happens to match the typed form — one translated word from being dead.
  const asDuty = dutyCommandFor(said);
  if (asDuty !== null) return asDuty;
  return PASSED_THROUGH.some((reads) => reads(said)) ? said : null;
}

/** True when something downstream will act on this id. For the suite. */
export function idIsRead(id: string): boolean {
  return readButtonId(id) !== null;
}

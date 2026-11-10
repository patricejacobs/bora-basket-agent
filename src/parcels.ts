/**
 * Parcel delivery: a rider collects something from one address and takes it to
 * another. No catalogue, no cart, no kitchen.
 *
 * Two things here are not like the rest of the app.
 *
 * Pricing, because a parcel's cost depends on how far it goes rather than what
 * is in it. Unpriced by default: with no fee configured the job is still taken
 * and staff confirm the cost, rather than the agent inventing a figure. A quoted
 * price is a promise, and a wrong one is an argument on a doorstep.
 *
 * And what may be carried. A shop chooses what to stock, but a courier is handed
 * a closed bag, so what is inside has to be asked about and some answers have to
 * be refused.
 */
import { config, money } from './config.ts';
import { distanceKm, type Coordinates } from './location.ts';
import { restrictedReason } from './restricted.ts';

/* ----------------------------------------------------------------- pricing */

export type ParcelQuote =
  | { priced: true; fee: number; distanceKm: number; explanation: string }
  | { priced: false; distanceKm: number; reason: string }
  | { tooFar: true; distanceKm: number; limitKm: number };

export function quoteParcel(from: Coordinates, to: Coordinates): ParcelQuote {
  const km = distanceKm(from, to);

  if (config.parcel.maxKm > 0 && km > config.parcel.maxKm) {
    return { tooFar: true, distanceKm: km, limitKm: config.parcel.maxKm };
  }

  const { baseFee, perKm } = config.parcel;
  if (baseFee <= 0 && perKm <= 0) {
    return {
      priced: false,
      distanceKm: km,
      reason:
        'No parcel pricing is configured, so you cannot quote a fee. Take the job and say the shop will confirm the cost before collecting — never guess a price.',
    };
  }

  // Rounded up to the kilometre: a courier price that varies by the metre is
  // impossible to say out loud and impossible to check afterwards.
  const chargeableKm = Math.max(0, Math.ceil(km));
  const fee = baseFee + perKm * chargeableKm;

  const explanation =
    perKm > 0
      ? `${money(baseFee)} base + ${money(perKm)} x ${chargeableKm} km`
      : `${money(baseFee)} flat`;

  return { priced: true, fee, distanceKm: km, explanation };
}

/* -------------------------------------------------------------- what is in it */

/**
 * Things a rider must not be asked to carry.
 *
 * Alcohol and tobacco come from the same Commerce Policy rule that filters
 * menus — moving them is still selling them over this channel. The rest is the
 * ordinary refusal list of any courier: nothing illegal, nothing that can hurt
 * the rider, nothing alive, and no cash, because a bag of money on a motorbike
 * is a robbery waiting to happen and an argument about who lost it afterwards.
 */
const FORBIDDEN: [RegExp, string][] = [
  [
    // The compounds are listed because a word boundary before "gun" does not
    // match inside "handgun", and that is exactly how somebody would say it.
    /\b(guns?|handguns?|shotguns?|airguns?|firearms?|ammunition|ammo|bullets?|rifles?|pistols?|revolvers?|weapons?|knives|knife|machete|explosives?|fireworks?|grenades?)\b/i,
    'weapons or explosives',
  ],
  [
    /\b(drug|drugs|cocaine|ganja|weed|marijuana|cannabis|heroin|pills?|narcotics?)\b/i,
    'drugs or medicines we cannot verify',
  ],
  [
    /\b(cash|money|currency|notes|gold|jewel(le)?ry|diamonds?|bullion)\b/i,
    'cash, gold or jewellery',
  ],
  [
    /\b(animal|animals|puppy|puppies|kitten|kittens|dog|dogs|cat|cats|bird|birds|fish|chicks?|livestock|pet|pets)\b/i,
    'live animals',
  ],
  [
    /\b(petrol|gasoline|diesel|kerosene|propane|butane|gas\s*cylinder|acid|bleach\s*drum|corrosive|flammable|poison|pesticide)\b/i,
    'fuel, gas or anything corrosive or flammable',
  ],
  [/\b(human|blood|organ|organs|specimen|medical\s*sample)\b/i, 'medical or human material'],
];

export type ContentsCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether this parcel can be carried, judged on the sender's description.
 *
 * It cannot see inside a bag, and is not meant to: it catches the person who
 * tells you honestly, which is most people. What it must never do is let the
 * agent accept something it has just been told is a gun.
 */
export function checkContents(description: string): ContentsCheck {
  const text = description.trim();
  if (!text) {
    return {
      allowed: false,
      reason: 'Ask what is in the parcel before taking the job — a rider has to know what they are carrying.',
    };
  }

  const banned = restrictedReason(text);
  if (banned) {
    return {
      allowed: false,
      reason: `We cannot carry that — ${banned.split('—')[0]?.trim() ?? 'it is not permitted on this channel'}. Say so plainly and do not create the job.`,
    };
  }

  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(text)) {
      return {
        allowed: false,
        reason: `We cannot carry ${label}. Tell the customer plainly, do not suggest a way around it, and do not create the job.`,
      };
    }
  }

  return { allowed: true };
}

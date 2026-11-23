/**
 * A working model of the errand service, printed as the messages each person
 * would receive.
 *
 *   node errand-model.ts
 *
 * Not wired into anything. It exists to be read and argued with before a line
 * of it reaches the real system — the state machine and the arithmetic are
 * real, so the awkward cases (over the cap, refused goods) behave here the way
 * they would behave at a till.
 *
 * An errand is a parcel whose pickup is not known when it is booked. The
 * difference that matters is the money: a grocery order has a price before
 * anybody moves, and an errand does not have one until the associate is
 * standing at the counter.
 */
import { money } from './src/config.ts';
import { restrictedReason } from './src/restricted.ts';

/* ------------------------------------------------------------------ model */

type Errand = {
  orderNo: string;
  what: string;
  /** The most the customer has agreed to spend on the goods. */
  cap: number;
  /** What the shop charges to run it. Known at booking; the goods are not. */
  fee: number;
  customer: string;
  address: string;
  /** Filled in when the associate is at the till. */
  spent: number | null;
  status: 'received' | 'accepted' | 'bought' | 'held_over_cap' | 'delivered';
};

/** What an errand may not be. The parcel list, re-read for a different job. */
const REFUSED: [RegExp, string][] = [
  [/\b(guns?|firearms?|ammunition|knives|knife|machete|explosives?|fireworks?)\b/i, 'weapons'],
  // Prescription only. Sealed over-the-counter medicine from a pharmacy is an
  // ordinary errand; a prescription needs the prescription, usually
  // identification, and a pharmacy willing to hand it to somebody else.
  [/\b(prescription|controlled|codeine|tramadol|morphine|narcotics?)\b/i, 'prescription medicine'],
  // A cylinder on a motorbike is a hazard whatever the policy says. Worth
  // revisiting the day there is a van.
  [/\b(gas\s*cylinder|propane|butane|petrol|gasoline|diesel|kerosene)\b/i, 'gas or fuel'],
  [/\b(cash|money|currency|gold|jewel(le)?ry|bullion)\b/i, 'cash or valuables'],
  // Said with a figure instead of the word. "Pick up $40,000 from my brother"
  // names no forbidden word and is the errand you least want to run: an
  // associate carrying somebody else's money is a robbery with a timetable,
  // and moving money for people is a regulated business rather than a favour.
  //
  // Anchored on collecting rather than on the figure, so "buy a gas stove, up
  // to $40,000" is still an ordinary errand.
  [/\b(pick\s*up|collect|fetch|get)\b[^.]{0,40}\$\s?[\d,]+/i, 'cash or valuables'],
];

function refuse(what: string): string | null {
  const banned = restrictedReason(what);
  if (banned) return banned.split('—')[0]?.trim() ?? 'goods we cannot carry';
  for (const [pattern, label] of REFUSED) if (pattern.test(what)) return label;
  return null;
}

/* --------------------------------------------------------------- messages */

const nl = String.fromCharCode(10);

/** To the customer, the moment it is booked. Nothing is owed yet. */
const booked = (e: Errand): string =>
  [
    `Got it — ${e.orderNo} received, but not yet confirmed. The moment the shop confirms it, we'll let you know.`,
    '',
    `*${e.what}*`,
    `Up to ${money(e.cap)} for the goods, plus ${money(e.fee)} to run it.`,
    `You pay what it actually costs, not the limit — we'll tell you the figure before we set off from the shop.`,
  ].join(nl);

/** To the dispatch desk. */
const deskCard = (e: Errand): string =>
  [
    `🏃 *New errand ${e.orderNo}*`,
    '',
    e.what,
    '',
    `Spend limit ${money(e.cap)}`,
    `Fee ${money(e.fee)}`,
    '',
    `${e.customer}`,
    e.address,
  ].join(nl);

/** To every free associate, as an offer. */
const offer = (e: Errand): string =>
  [
    `🏃 *Errand ${e.orderNo}*`,
    `${money(e.fee)} to run it`,
    '',
    `*Buy:* ${e.what}`,
    `*Spend up to:* ${money(e.cap)} — ring the shop before going over`,
    '',
    `*Take to:* ${e.customer}, ${e.address}`,
    '',
    `You pay at the shop and collect ${money(e.fee)} plus what you spent, at the door.`,
  ].join(nl);

/** To the associate once they have accepted — how to report the cost. */
const accepted = (e: Errand): string =>
  [
    `${e.orderNo} is yours.`,
    '',
    `Buy it, then send a photo of the receipt with the amount, like \`${short(e)} spent 2450\`.`,
    `The customer is told the figure before you set off.`,
  ].join(nl);

/** To the customer, the first time a real number exists. */
const costed = (e: Errand): string =>
  [
    `${e.orderNo} — bought.`,
    '',
    `${e.what}: ${money(e.spent ?? 0)}`,
    `Delivery: ${money(e.fee)}`,
    `*To pay at the door: ${money((e.spent ?? 0) + e.fee)}*`,
    '',
    `On its way to you now.`,
  ].join(nl);

/** When the till says more than the customer agreed to. */
const overCap = (e: Errand): string =>
  [
    `⚠️ ${e.orderNo} — ${money(e.spent ?? 0)} is over the ${money(e.cap)} limit.`,
    '',
    `Nothing has been bought. Ring ${e.customer} and ask whether to go ahead at the new price.`,
    `If they agree, send \`${short(e)} approve ${(e.spent ?? 0) / 100}\`. If not, send \`${short(e)} nobody there\`.`,
  ].join(nl);

/** To the customer, asked rather than told. */
const askCustomer = (e: Errand): string =>
  [
    `${e.orderNo} — the price is higher than we agreed.`,
    '',
    `${e.what} is ${money(e.spent ?? 0)}, not ${money(e.cap)}.`,
    `Shall we go ahead? Reply *yes* and we'll buy it, or *no* and we'll cancel with nothing owed.`,
  ].join(nl);

const short = (e: Errand): string => String(Number(e.orderNo.replace(/[^0-9]/g, '')));

/* ------------------------------------------------------------------- walk */

const rule = (t: string): void => {
  console.log('');
  console.log(`████  ${t}  ${'█'.repeat(Math.max(0, 46 - t.length))}`);
};
const to = (who: string, body: string): void => {
  console.log('');
  console.log(`╔═ → ${who}`);
  for (const l of body.split(nl)) console.log(l ? `║ ${l}` : '║');
  console.log('╚' + '═'.repeat(58));
};

const base: Errand = {
  orderNo: 'ORD-00091',
  what: '2 x 5-gallon bottles of water',
  cap: 3000,
  fee: 700,
  customer: 'Marcia Persaud',
  address: '26 Brickdam, Georgetown',
  spent: null,
  status: 'received',
};

rule('1. AN ORDINARY ERRAND — within the limit');
to('the customer', booked(base));
to('the shop', deskCard(base));
to('every free associate', offer(base));
to('Rider One, who accepted', accepted(base));

const bought: Errand = { ...base, spent: 2450, status: 'bought' };
console.log('');
console.log('  Rider One ▸ sends a photo of the receipt: "91 spent 2450"');
to('the customer', costed(bought));

rule('2. THE TILL SAYS MORE THAN AGREED');
const dear: Errand = { ...base, spent: 3800, status: 'held_over_cap' };
console.log('');
console.log('  Rider One ▸ "91 spent 3800"');
to('Rider One', overCap(dear));
to('the customer', askCustomer(dear));

rule('3. THINGS THE SHOP WILL NOT RUN');
for (const what of [
  '2 x 5-gallon bottles of water',
  'a bottle of paracetamol from the pharmacy',
  'my prescription from Meadow Bank pharmacy',
  'a 20 lb gas cylinder',
  'a bottle of rum',
  'pick up $40,000 from my brother',
  'buy a gas stove, up to $40,000',
  'collect my parcel from the depot',
]) {
  const no = refuse(what);
  console.log(`  ${no ? '✗' : '✓'} ${what.padEnd(46)} ${no ? `refused — ${no}` : 'taken'}`);
}

console.log('');

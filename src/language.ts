/**
 * The customer's own language, for the messages the model does not write.
 *
 * The conversation itself has always been multilingual — the agent is told to
 * match the customer's language and does. What was not were the fixed
 * messages: the welcome, the four services, and every status notification.
 * They are deliberately fixed so they read identically every time and cannot
 * drift, which is right, and meant a customer could order entirely in Spanish
 * and be thanked in English.
 *
 * So the fixed messages are written out once per language rather than
 * translated at send time. A translation produced on the fly costs a call per
 * message, adds latency to a notification, and — the part that matters — would
 * put text in front of a customer that nobody at the shop can read. A wrong
 * price or a garbled cancellation reason would go out unreviewed.
 */

export const LANGUAGES = ['en', 'es', 'pt', 'zh'] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------- detection */

/**
 * Words that give a language away, chosen for being unambiguous.
 *
 * Spanish and Portuguese share most of a vocabulary, so the markers here are
 * the ones that differ: `quiero` against `quero`, `gracias` against
 * `obrigado`. Words both share — `por favor` — are deliberately absent,
 * because a wrong guess is worse than no guess: it would answer a Brazilian in
 * Spanish with perfect confidence.
 */
const MARKERS: [Language, RegExp][] = [
  // Portuguese first: its markers are the more distinctive of the pair, and a
  // Portuguese sentence is more likely to contain a Spanish-looking word than
  // the other way round.
  [
    'pt',
    /\b(não|nao|obrigado|obrigada|você|voce|bom dia|boa tarde|boa noite|quero|quanto custa|olá|ola|entrega|pedido de|até|pequeno-almoço)\b|[ãõ]/i,
  ],
  [
    'es',
    /\b(hola|gracias|quiero|cuánto|cuanto cuesta|dónde|donde está|buenos días|buenas tardes|buenas noches|usted|necesito|quisiera|pedido para)\b|[ñ¿¡]/i,
  ],
  // English last, and detected rather than assumed.
  //
  // It had no markers at all: English was the absence of the others, which
  // returns null, and null never updates the stored language because a one-word
  // reply must not reset somebody who has been writing Portuguese all along.
  //
  // The two rules together were a trap. One "gracias" from an English speaker
  // latched the account to Spanish, and nothing they wrote afterwards could
  // ever unlatch it, because English was unsayable. Their order confirmations,
  // delivery codes and receipts went out in Spanish for good, while the agent's
  // own replies followed the English they were actually writing - so the
  // conversation came back in two languages and only the fixed half was wrong.
  //
  // Checked after the others on purpose, exactly as Portuguese is checked
  // before Spanish: a Spanish sentence carrying one English word is still
  // Spanish, and matches above before it reaches here.
  [
    'en',
    /\b(the|and|is|are|was|you|your|please|thanks|thank you|i want|i need|i would|how much|where|what|when|good morning|good afternoon|good evening|hello|order|delivery|deliver|send|have|can)\b/i,
  ],
];

/** Han characters. Unambiguous in a way no word list can be. */
const HAN = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * The language a message is written in, or null when nothing gives it away.
 *
 * Null rather than a guess of English: "ok" and "👍" are not evidence of
 * anything, and a customer who has been writing Spanish should not be reset to
 * English by a one-word reply.
 */
export function detectLanguage(text: string): Language | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (HAN.test(trimmed)) return 'zh';

  for (const [language, pattern] of MARKERS) {
    if (pattern.test(trimmed)) return language;
  }
  return null;
}

/** What to tell the agent, so its own replies match the fixed messages. */
export const LANGUAGE_NAME: Record<Language, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese',
};

/* ---------------------------------------------------------- translations */

type Dictionary = Record<string, string>;

/**
 * Every fixed message a customer can receive, in each language.
 *
 * `{name}`, `{store}`, `{order}`, `{total}`, `{outlet}` and `{reason}` are
 * filled in at send time. Keeping the placeholders identical across languages
 * is what lets one call site serve all four.
 */
const chr10 = String.fromCharCode(10);

const STRINGS: Record<Language, Dictionary> = {
  en: {
    welcome: 'Welcome to {store}! 👋',
    welcome_back: 'Welcome back to {store}, {name}! 👋',
    how_can_we_help: 'What can we help you with today?',
    reply_with_number: 'Just reply with the number.',

    service_taxi: 'Taxi',
    service_grocery: 'Grocery shopping',
    service_restaurant: 'Restaurant ordering',
    service_parcel: 'Parcel delivery',
    service_other: 'Other',

    confirmed: "Thanks {name} — order {order} is confirmed. We'll let you know when it's on the way.",
    on_the_way:
      '{name}, your order {order} is on its way 🛵\nTotal {total}, payable to the delivery associate.',
    delivered: 'Order {order} delivered.',
    // The thanks, split out of the three lines above so each kind of order can
    // be thanked for what the customer actually did. "Shopping" is only true
    // of a grocery order, and nothing was bought at all on a parcel job.
    thanks_grocery: 'Thank you for shopping with us!',
    // One thanks for everything the shop carries, in the shop's own name.
    // A kitchen's food is the kitchen's; the delivery is the shop's, and the
    // shop is who the customer is talking to.
    thanks_store: 'Thank you for choosing {store}!',

    // The receipt, printed above the three lines of thanks. Labels only - the
    // figures and the item lines are built from the order itself.
    receipt_title: 'Receipt',
    receipt_goods: 'Goods',
    receipt_delivery: 'Delivery',
    receipt_total: 'Total',
    receipt_paid_cash: 'paid in cash',
    receipt_paid_card: 'paid by card',
    // A parcel bought nothing, and its fee was handed over at the uplift by
    // the person who sent it - so neither the goods line nor "paid at the
    // door" is true of one.
    receipt_parcel_fee: 'Delivery fee',
    receipt_paid_at_pickup: 'paid at pickup',
    pin_elsewhere: 'Not where you are now? Drag the map, or search for the place, before you send it.',
    returned_wrong_code: 'Parcel {order} is coming back to you — the delivery code {name} gave did not match, so the delivery associate did not hand it over. Check with {name} that they had the code you passed on. The fee covers the trip, which was made, so it is not refunded.',
    parcel_on_the_way: 'Parcel {order} has been collected and is on its way to {name}.',
    // A taxi quotes no figure anywhere. The shop never priced the trip — the
    // driver and the passenger agree it between them — so every line here is
    // written to say what is happening without naming money the shop does
    // not know. "Total $0" was the alternative, and it was a lie.
    taxi_confirmed: 'Thanks {name} — a driver is on the way to collect you. Trip {order}. 🚕',
    taxi_on_the_way: '{name}, you are on your way 🚕',
    taxi_fare_with_driver: 'The fare is agreed with the driver.',
    taxi_fare_quoted: 'Your fare is *{fare}*, payable to the driver. Waiting after pickup is charged separately.',
    taxi_fare_from: 'Your fare is *{fare}*, payable to the driver — priced from *{place}*, the nearest area to the spot you sent. Waiting after pickup is charged separately.',
    taxi_dropped_off: 'Trip {order} complete — you have arrived. 🚕',
    // A passenger who was not at the pickup. The parcel wording has nothing
    // coming back to them and the delivery wording has nobody at a door, and
    // neither is what happened: the car waited and left.
    taxi_no_show: 'Trip {order} was closed — the driver could not find you at the pickup. Message us when you are ready and we will send another car.',
    // The safety code, which runs the opposite way to a delivery code: the
    // driver says it, the passenger checks it. Written so the one line that
    // matters - do not get in if it does not match - is the one they read.
    taxi_driver_outside: 'Your driver is outside 🚕 They will say your safety code *{code}* before you get in.',
    taxi_safety_code: '🔐 Your safety code is *{code}*. The driver will say these four digits to you before you get in. If they say anything else, do not get into the car — message us.',
    // Reward points. Said in points, because that is what the shop promised,
    // with the money beside it so nobody has to work out what a point is.
    points_earned: '⭐ *+{points} points* on this delivery.',
    // Counted in points to go, never in money still to spend. The base is
    // the delivery charge, so "spend more" would read as "pay us more in
    // fees" - and a customer cannot go and acquire points anyway. What they
    // can do is order again, which is what the deliveries line says.
    points_to_go: 'You have *{points} points* — *{togo} to go* for {value} off.',
    points_ready: 'You have *{points} points* — that is *{value}* off an order, whenever you want it.',
    points_use_hint: 'Just say *use my points*.',
    points_deliveries: 'About {n} more deliveries to {zone}.',
    points_one_delivery: 'About 1 more delivery to {zone}.',
    points_used: 'Reward used: *{points} points* — *{value}* off.',
    receipt_reward: 'Reward',
    receipt_fare: 'Fare',
    receipt_waiting: 'Waiting',
    receipt_trip: 'Trip',
    receipt_points: 'You earned *{points} points* on this trip.',

    opening_taxi_picked:
      'A car it is. 🚕 I will tell you the fare before anything is booked.',
    fare_book: 'Book it',
    fare_change: 'Change destination',
    fare_cancel: 'Cancel',
    taxi_cancelled: 'No problem — nothing has been booked. Send *menu* when you need us.',
    spot_ask_from: '*{place}* — got it. If you are there now, send your exact location and the driver will come straight to you.',
    spot_ask_drop: '*{place}* — got it, delivery is {fee}. Tap below to send your exact spot and the associate will come straight to your door. No map? Reply *skip* — or type anything they should know (a gate, a floor, a landmark).',
    spot_ask_to: '*{place}* — got it. If you know the exact spot, send it on the map and the driver will take you right there.',
    spot_same_as_pickup: 'That is the spot you are being collected FROM — about {km} from it.{nl}{nl}WhatsApp sends where you are standing unless you move the map. If you are going somewhere else, drag the map or search for the place before you send it — or just tell me the area.',
    spot_send: '📍 Send location',
    spot_skip: 'Skip',
    // Asked, never refused: they know their own address better than a
    // geocoded village centre does, and the figure is there so they can
    // judge it rather than take our word for it.
    pin_far: 'That spot is about {km} from *{place}*, and the delivery is priced for {place}.',
    pin_far_named: 'That spot is {km} from *{place}* — it is in *{near}*. The delivery is priced for {place}.',
    // One answer, and a way through for somebody who genuinely cannot pin
    // their own door. Saying "that one is right" is not an option: it costs
    // an associate a ride across the country.
    pin_send_again: 'Tap below and send the spot at *{place}*. No map? Reply *skip* and tell me the street instead.',
    pin_keep: 'Yes, that is right',
    pin_again: 'Send it again',
    street_elsewhere: '⚠️ You chose *{place}*, but that address reads like *{named}*.',
    street_elsewhere_km: '⚠️ You chose *{place}*, but that address reads like *{named}* — about {km} away.',
    street_which: 'Which is it? Tap *{move}* to send it to {named} for {fee}, or *{again}* to give me the {place} address.',
    street_move: 'Change the village',
    street_again: 'Fix the address',
    nobody_out: 'There is nobody out on deliveries just now, so I cannot get this to you yet.',
    nobody_out_held: 'Your list is held exactly as it is — {what}.',
    nobody_out_back: 'Nothing for you to do. I will come straight back to you the moment somebody is on the road.',
    wait_taxi: '🚕 There is a car on the road now.{nl}{nl}{what} — still on?',
    wait_order: '🛵 Somebody is on the road now.{nl}{nl}{what}{nl}{nl}Shall I place it?',
    wait_parcel: '📦 Somebody is on the road now.{nl}{nl}{what}{nl}{nl}Shall I get it moving?',
    wait_go_taxi: 'Yes, send it',
    wait_go_order: 'Place it',
    wait_go_parcel: 'Book it',
    wait_no: 'Not now',
    wait_dropped: 'No problem — message me whenever you are ready and I will check again.',
    wait_gone: 'Sorry — that one has just been taken. You are still first in line, and I will come back the moment there is another.',
    spot_prompt_from: 'Tap below to send where exactly you are.',
    spot_prompt_to: 'Tap below to send the exact spot you are going to.',
    spot_saved: 'Got it — the driver will have that. 📍',
    dest_ask: 'Your driver says you are now going to *{place}*. That makes the fare *{now}* rather than *{was}*.',
    dest_gone: 'That one is already settled — nothing further to answer.',
    dest_ack: 'Acknowledged',
    dest_keep: 'No, as booked',
    dest_changed: 'Done — you are going to *{place}*, *{fare}*. Your driver has been told.',
    dest_kept: 'No change — you are going to *{place}* as booked, *{fare}*. Your driver has been told.',
    dest_asked: 'Asked your driver about *{place}* — nothing changes until they say they can take you there. I will tell you either way.',
    dest_refused: 'Your driver cannot take you there, so you are going to *{place}* as booked, *{fare}*. Message us if that does not work.',
    pickup_far: '⚠️ You said *{said}*, but the spot you sent looks like *{pinned}*.',
    pickup_far_named: '⚠️ You said *{said}*, but the spot you sent is {km} away, in *{pinned}*.',
    pickup_fares: 'It matters for the fare: from {said} it is {said_fare}, from {pinned} it is {pin_fare}.',
    pickup_which: 'Which one are you at? If you are at {pinned}, tap below and I will price it from there. If you are at {said}, send me the spot again.',
    pickup_here: 'I am at the pin',
    pickup_again: 'Send it again',
    pickup_unplaced: 'Tap below to send your exact pickup point, so the driver comes straight to you — or tell me exactly where to look for you: opposite which place, or how far from which corner, and which way.',
    pick_button: 'Choose a place',
    pick_which_place: 'There is more than one *{said}*, and they are not the same price. Which one?',
    checkout_street_ask: 'What is the street address at {place}? Lot number and road, so they come to the right door.',
    checkout_name_ask: 'And what name is the delivery in?',
    checkout_gate_parcel: '📦 {contents}{nl}To *{to}* at {where}{nl}*Delivery {fee}*, collected from you when it is picked up.{nl}{nl}Shall I book it?',
    checkout_gate: '{items}{nl}Delivery to {place} — {fee}{nl}*Total {total}*, cash to the associate at your door.{nl}{nl}For *{name}*, at {where}.{spot}{nl}{nl}Shall I place it?',
    // Printed in place of a pin, because silence here reads as "they have
    // my exact spot" to somebody who skipped it three messages ago.
    checkout_no_spot: 'No exact spot sent — your associate will ring when they are close.',
    checkout_failed: 'Something went wrong placing that, and nothing has been ordered. Let me take another look — one moment.',
    checkout_the_shop: 'The shop',
    checkout_booked_parcel: 'Parcel {order} is booked. I will tell you the moment an associate takes it.',
    addr_pin_first: 'Before I ask your associate: send your exact spot at *{place}* on the map, so they can see the door when they answer — or tap Skip and I will ask them anyway.',
    pin_asked_by_rider: 'Your delivery associate is on the way with {order} and cannot find the door. Send your exact spot on the map and they will come straight to it — or tap Skip and they will ring you.',
    addr_pin_ask: 'Now send your exact spot at *{place}* on the map and your associate will come straight to the door — or tap Skip and they will ring when they are close.',
    spot_skipped: 'No problem — your associate will ring when they are close.',
    addr_pinned: 'Got it — your associate has the new spot on their map.',
    addr_changed: 'Done — {order} is going to *{place}* instead. New total *{total}*. Your associate has been told.',
    addr_kept: 'Your associate cannot take it there, so {order} is going to *{place}* as booked. Message us if that does not work.',
    addr_asked: 'Asked your associate about *{place}* — nothing changes until they say they can take it there. I will tell you either way.',
    checkout_placed: 'Order {order} is in. {kitchen} will confirm shortly, and I will tell you the moment it is on its way.',
    checkout_cancelled: 'Left it there — nothing has been ordered. Your basket is still here when you want it.',
    aisles_head: '🛒 *The shop* — {n} aisles. Here is everything we carry:',
    aisle_items_how: '_Reply with a letter and how many — *a x2* — or just type what you want. A number is always an aisle and a letter is always a thing on a shelf._',
    aisle_basket: '🛒 Basket · {total}',
    aisle_checkout: '✅ Check out',
    basket_head: '🛒 *Your basket*',
    basket_total: '*Goods {goods}* — delivery is worked out when you say where it goes.',
    basket_how: 'To change something: *a x3* makes it three, *a x0* takes it out. Or just say it.',
    basket_minimum: '🛒 Your basket is *{goods}*, and the smallest order we can send out is *{least}* — *{short}* to go. Add anything and we are away.',
    basket_empty: 'Your basket is empty. Pick an aisle, or type what you want.',
    aisles_how: 'Reply with an aisle number — *1* to *{last}* — to see what is in it.{nl}{nl}Tap *Leave groceries* at any point to go back to the main menu; from inside an aisle there is a *Categories* button to bring this page back.',
    aisles_empty: 'Nothing has been put on the shelves yet. Message us and somebody will sort it out.',
    aisle_back: '🛒 Categories',
    aisle_leave: '⬅️ Leave groceries',
    pick_drop_ask: 'Where are we delivering?',
    pick_from_ask: 'Where are we collecting you from?',
    pick_to_ask: 'And where are you going?',
    // Under every one of the three questions above, and the most valuable
    // words on the screen: they show in the chat BEFORE anybody opens the
    // list. The 'Type the name' row lives INSIDE the list, which is no use
    // to somebody deciding whether to open it. The examples are doing work
    // too — they say what counts as a place here, and that BV is understood.
    pick_or_type: 'Just type it — Diamond, Beterverwagting, BV. Or tap below to browse.',
    pick_corridor_ask: 'Which part of {corridor}?',
    pick_saved: 'Your saved address',
    pick_recent: 'You have used this before',
    pick_back: '⬅️ Back to the areas',
    pick_menu: '⬅️ Main menu',
    pick_type: '✏️ Type the name',
    pick_more: 'More places',
    pick_more_hint: '{n} more places, nearest first',
    pick_more_plain: '{n} more places on this road',
    pick_type_hint: 'Quicker than scrolling — any spelling will do',
    pick_corridor_help_from: 'Just type the name instead — any spelling will do, and I will find it.',
    pick_corridor_help_to: 'Nearest first. Tap More places, or just type the name — that is quicker.',
    pick_fare_unknown: 'Fare agreed with the driver',
    returned_to_sender: 'Parcel {order} is coming back to you — {name} could not take it. The delivery associate will bring it to where it was collected. The fee covers the trip, which was made, so it is not refunded.',
    // The customer IS the one who was not there, so none of the parcel
    // wording fits: nothing is "coming back to you", and nobody else needs
    // checking with. Nothing is said about money either, because nothing was
    // paid - it is collected at the door, and there was no door.
    returned_nobody_home: 'Order {order} has come back — there was nobody at the door to take it. Message us when you are ready and we will arrange another delivery.',
    delivered_confirmed: 'Order {order} delivered.' + chr10 + 'Delivery code: confirmed.',
    delivered_unverified: 'Order {order} delivered.' + chr10 + 'Delivery code: not confirmed.',
    delivered_check: chr10 + chr10 + 'Anything wrong with this order? Just message us.',
    door_code_for: chr10 + chr10 + 'The delivery code is *{code}* \u2014 give it to {name}, who reads it to the delivery associate at the door, so we know the order reached the right hands.',
    door_code: chr10 + chr10 + 'Your delivery code is *{code}* — read it to the delivery associate at the door, so we know your order reached the right hands.',

    cancel_sorry: 'Sorry about this {name} —',
    cancel_done: 'Done {name} —',
    cancel_by_outlet: '*{outlet}* has cancelled your order',
    cancel_plain: 'Order {order} has been cancelled',
    cancel_plain_taxi: 'Trip {order} has been cancelled',
    cancel_with_reason: '{opening} {subject}: {reason}. Nothing has been charged.',
    cancel_no_reason: '{opening} {subject}. Nothing has been charged.',

    reason_sold_out: 'the kitchen has run out of something on it',
    reason_too_busy: 'the kitchen is too backed up to take it right now',
    reason_closing: 'the kitchen is closing for the day',
    reason_customer: 'you asked us to cancel it',
    reason_undeliverable: 'we could not get to the address',

    opening_taxi:
      'A car it is. 🚕 Where are we collecting you from, where are you going, and when? Tell me how many of you as well, and I will find you a car.' +
      chr10 +
      chr10 +
      'I will tell you the fare before anything is booked.',
    opening_grocery:
      'Groceries it is. Tell me what you need — type a list, send a photo of one, or just say it.',
    opening_parcel:
      "Parcel delivery. I'll need to know where it's coming from, where it's going, and who's receiving it.",
    opening_other:
      "No problem — tell me what you need and I'll pass it straight to the team with your number.",

    outlets_cooking_now: 'Kitchens cooking right now:',
    outlets_none_cooking: 'Nothing is cooking right now:',
    outlets_switch_groceries: 'Send *menu* if you would rather shop groceries.',
    outlets_none_setup:
      'No restaurants are set up yet, so there is nothing to order from — but I can help you with groceries. Send *menu* to switch.',
    outlet_minutes: '{n} min',
    outlet_delivery: '{total} delivery',
    outlet_min_order: 'min {total}',
    outlet_paused: 'kitchen paused',
    outlet_opens: 'opens {time}',
    outlet_closed: 'closed',

    signoff_order_again: 'Enjoy your meal! Message us any time to order again. 💬',
    signoff_next_time: 'Enjoy your meal, see you next time! 👋',
    signoff_meal: 'Enjoy your meal! 🍽️',
    signoff_food: 'Enjoy your food! 😋',
    signoff_enjoy: 'Enjoy! 😊',
    signoff_every_bite: 'Enjoy every bite! 😋',
    signoff_appetit: 'Bon appétit! 🥘',
    // Groceries. Not "enjoy your meal" — a bag of rice and bleach is not a
    // meal, and a wish about eating it reads as a message meant for somebody
    // else.
    signoff_just_right: 'Hope it’s all just right! 😊',
    signoff_see_you_next: 'See you next time! 👋',
    signoff_next_order: 'Message any time for your next order. 💬',
    signoff_here_for_you: 'We’re here whenever you need us. 🙌',
    signoff_rest_of_day: 'Enjoy the rest of your day! ☀️',
    // Parcels. Nothing was bought, so there is nothing to enjoy — what was
    // given was trust, and the sender is the one being thanked.
    signoff_moved_any_time: 'Message any time you need something moved. 💬',
    signoff_trusting_us: 'Thanks for trusting us with it. 📦',
    signoff_next_one: 'We’re here for the next one. 🙌',
    signoff_carried: 'Any time you need something carried, you know where we are. 💬',
    signoff_good_to_help: 'Good to have helped. 👋',
  },

  es: {
    welcome: '¡Bienvenido a {store}! 👋',
    welcome_back: '¡Bienvenido de nuevo a {store}, {name}! 👋',
    how_can_we_help: '¿En qué podemos ayudarle hoy?',
    reply_with_number: 'Responda con el número.',

    service_taxi: 'Taxi',
    service_grocery: 'Compra de supermercado',
    service_restaurant: 'Pedido de restaurante',
    service_parcel: 'Envío de paquetes',
    service_other: 'Otro',

    confirmed:
      'Gracias {name} — el pedido {order} está confirmado. Le avisaremos cuando vaya en camino.',
    on_the_way:
      '{name}, su pedido {order} va en camino 🛵\nTotal {total}, a pagar al asociado de entrega.',
    delivered: 'Pedido {order} entregado.',
    thanks_grocery: '¡Gracias por comprar con nosotros!',
    thanks_store: '¡Gracias por elegir {store}!',

    receipt_title: 'Recibo',
    receipt_goods: 'Productos',
    receipt_delivery: 'Entrega',
    receipt_total: 'Total',
    receipt_paid_cash: 'pagado en efectivo',
    receipt_paid_card: 'pagado con tarjeta',
    receipt_parcel_fee: 'Costo de entrega',
    receipt_paid_at_pickup: 'pagado al recoger',
    pin_elsewhere: '¿No está ahí ahora? Mueva el mapa, o busque el lugar, antes de enviarlo.',
    returned_wrong_code: 'El paquete {order} vuelve a usted — el código que dio {name} no coincidió, así que el asociado de entrega no lo entregó. Confirme con {name} que tenía el código que usted le pasó. La tarifa cubre el viaje, que sí se hizo, por lo que no se reembolsa.',
    parcel_on_the_way: 'El paquete {order} ha sido recogido y va camino a {name}.',
    taxi_confirmed: 'Gracias {name} — un conductor va en camino a recogerle. Viaje {order}. 🚕',
    taxi_on_the_way: '{name}, ya va en camino 🚕',
    taxi_fare_with_driver: 'La tarifa se acuerda con el conductor.',
    taxi_fare_quoted: 'Su tarifa es *{fare}*, a pagar al conductor. La espera después de la recogida se cobra aparte.',
    taxi_fare_from: 'Su tarifa es *{fare}*, a pagar al conductor — calculada desde *{place}*, la zona más cercana al punto que envió. La espera después de la recogida se cobra aparte.',
    taxi_dropped_off: 'Viaje {order} completado — ha llegado. 🚕',
    taxi_no_show: 'El viaje {order} se cerró — el conductor no pudo encontrarle en el punto de recogida. Escríbanos cuando esté listo y enviaremos otro coche.',
    taxi_driver_outside: 'Su conductor está afuera 🚕 Le dirá su código de seguridad *{code}* antes de que suba.',
    taxi_safety_code: '🔐 Su código de seguridad es *{code}*. El conductor le dirá estas cuatro cifras antes de que suba. Si dice otras, no suba al coche — escríbanos.',
    points_earned: '⭐ *+{points} puntos* por esta entrega.',
    points_to_go: 'Tiene *{points} puntos* — *faltan {togo}* para {value} de descuento.',
    points_ready: 'Tiene *{points} puntos* — son *{value}* de descuento en un pedido, cuando quiera.',
    points_use_hint: 'Solo diga *usar mis puntos*.',
    points_deliveries: 'Unas {n} entregas más a {zone}.',
    points_one_delivery: 'Una entrega más a {zone}.',
    points_used: 'Recompensa usada: *{points} puntos* — *{value}* de descuento.',
    receipt_reward: 'Recompensa',
    receipt_fare: 'Tarifa',
    receipt_waiting: 'Espera',
    receipt_trip: 'Viaje',
    receipt_points: 'Ha ganado *{points} puntos* en este viaje.',

    opening_taxi_picked:
      'Un coche entonces. 🚕 Le diré la tarifa antes de reservar nada.',
    fare_book: 'Reservar',
    fare_change: 'Cambiar destino',
    fare_cancel: 'Cancelar',
    taxi_cancelled: 'Sin problema — no se ha reservado nada. Envíe *menu* cuando nos necesite.',
    spot_ask_from: '*{place}* — listo. Si ya está ahí, envíe su ubicación exacta y el conductor irá directo a usted.',
    spot_ask_drop: '*{place}* — listo, el envío cuesta {fee}. Toque abajo para enviar su punto exacto y el asociado llegará a su puerta. ¿Sin mapa? Responda *omitir* — o escriba algo que deba saber (un portón, un piso, una referencia).',
    spot_ask_to: '*{place}* — listo. Si sabe el punto exacto, envíelo en el mapa y el conductor le llevará justo ahí.',
    spot_same_as_pickup: 'Ese es el punto donde le recogen — a unos {km} de él.{nl}{nl}WhatsApp envía donde usted está parado si no mueve el mapa. Si va a otro sitio, mueva el mapa o busque el lugar antes de enviarlo — o dígame la zona.',
    spot_send: '📍 Enviar ubicación',
    spot_skip: 'Omitir',
    pin_far: 'Ese punto está a unos {km} de *{place}*, y el envío está calculado para {place}.',
    pin_far_named: 'Ese punto está a {km} de *{place}* — está en *{near}*. El envío está calculado para {place}.',
    pin_send_again: 'Toque abajo y envíe el punto en *{place}*. ¿Sin mapa? Responda *omitir* y dígame la calle.',
    pin_keep: 'Sí, es correcto',
    pin_again: 'Enviar de nuevo',
    street_elsewhere: '⚠️ Usted eligió *{place}*, pero esa dirección parece ser de *{named}*.',
    street_elsewhere_km: '⚠️ Usted eligió *{place}*, pero esa dirección parece ser de *{named}* — a unos {km}.',
    street_which: '¿Cuál es? Toque *{move}* para enviarlo a {named} por {fee}, o *{again}* para darme la dirección en {place}.',
    street_move: 'Cambiar el pueblo',
    street_again: 'Corregir dirección',
    nobody_out: 'No hay nadie en la calle ahora mismo, así que todavía no puedo llevárselo.',
    nobody_out_held: 'Su lista queda tal cual — {what}.',
    nobody_out_back: 'Usted no tiene que hacer nada. Le escribo en cuanto haya alguien en la calle.',
    wait_taxi: '🚕 Ya hay un carro en la calle.{nl}{nl}{what} — ¿sigue en pie?',
    wait_order: '🛵 Ya hay alguien en la calle.{nl}{nl}{what}{nl}{nl}¿Lo hago?',
    wait_parcel: '📦 Ya hay alguien en la calle.{nl}{nl}{what}{nl}{nl}¿Lo pongo en marcha?',
    wait_go_taxi: 'Sí, envíelo',
    wait_go_order: 'Hacer el pedido',
    wait_go_parcel: 'Reservar',
    wait_no: 'Ahora no',
    wait_dropped: 'Sin problema — escríbame cuando quiera y vuelvo a mirar.',
    wait_gone: 'Lo siento — ese acaba de tomarse. Usted sigue primero en la fila y le aviso en cuanto haya otro.',
    spot_prompt_from: 'Toque abajo para enviar dónde está exactamente.',
    spot_prompt_to: 'Toque abajo para enviar el punto exacto al que va.',
    spot_saved: 'Listo — el conductor lo tendrá. 📍',
    dest_ask: 'Su conductor dice que ahora va a *{place}*. Eso hace la tarifa *{now}* en vez de *{was}*.',
    dest_gone: 'Eso ya está resuelto — no hay nada que responder.',
    dest_ack: 'Entendido',
    dest_keep: 'No, como estaba',
    dest_changed: 'Listo — va a *{place}*, *{fare}*. Su conductor ya lo sabe.',
    dest_kept: 'Sin cambios — va a *{place}* como estaba, *{fare}*. Su conductor ya lo sabe.',
    dest_asked: 'Le pregunté a su conductor por *{place}* — nada cambia hasta que diga que puede llevarlo. Le aviso igualmente.',
    dest_refused: 'Su conductor no puede llevarlo allí, así que va a *{place}* como estaba, *{fare}*. Escríbanos si eso no le sirve.',
    pickup_far: '⚠️ Usted dijo *{said}*, pero el punto que envió parece ser *{pinned}*.',
    pickup_far_named: '⚠️ Usted dijo *{said}*, pero el punto que envió está a {km}, en *{pinned}*.',
    pickup_fares: 'Importa para la tarifa: desde {said} son {said_fare}, desde {pinned} son {pin_fare}.',
    pickup_which: '¿En cuál está? Si está en {pinned}, toque abajo y lo calculo desde allí. Si está en {said}, envíeme el punto otra vez.',
    pickup_here: 'Estoy en el punto',
    pickup_again: 'Enviar de nuevo',
    pickup_unplaced: 'Toque abajo para enviar su punto exacto de recogida, así el conductor llega directo a usted — o dígame exactamente dónde buscarlo: frente a qué lugar, o a cuántas casas de qué esquina, y hacia qué lado.',
    pick_button: 'Elegir lugar',
    pick_which_place: 'Hay más de un *{said}*, y no cuestan lo mismo. ¿Cuál es?',
    checkout_street_ask: '¿Cuál es la dirección en {place}? Número de lote y calle, para llegar a la puerta correcta.',
    checkout_name_ask: '¿A nombre de quién va la entrega?',
    checkout_gate_parcel: '📦 {contents}{nl}Para *{to}* en {where}{nl}*Envío {fee}*, se cobra a usted en la recogida.{nl}{nl}¿Lo reservo?',
    checkout_gate: '{items}{nl}Envío a {place} — {fee}{nl}*Total {total}*, en efectivo al asociado en su puerta.{nl}{nl}A nombre de *{name}*, en {where}.{spot}{nl}{nl}¿Hago el pedido?',
    checkout_no_spot: 'No envió la ubicación exacta — su asociado le llamará cuando esté cerca.',
    checkout_failed: 'Algo falló al registrar el pedido y no se ha pedido nada. Déjeme revisarlo — un momento.',
    checkout_the_shop: 'La tienda',
    checkout_booked_parcel: 'Paquete {order} reservado. Le aviso en cuanto un asociado lo tome.',
    addr_pin_first: 'Antes de preguntar a su asociado: envíe su punto exacto en *{place}* en el mapa, para que vea la puerta al responder — o pulse Omitir y le pregunto igual.',
    pin_asked_by_rider: 'Su asociado va en camino con {order} y no encuentra la puerta. Envíe su punto exacto en el mapa y llegará directo — o pulse Omitir y le llamará.',
    addr_pin_ask: 'Ahora envíe su punto exacto en *{place}* en el mapa y el asociado llegará a la puerta — o pulse Omitir y le llamarán al acercarse.',
    spot_skipped: 'Sin problema — el asociado le llamará al acercarse.',
    addr_pinned: 'Listo — su asociado ya tiene el punto en su mapa.',
    addr_changed: 'Listo — {order} va a *{place}*. Nuevo total *{total}*. Su asociado ya lo sabe.',
    addr_kept: 'Su asociado no puede llevarlo allí, así que {order} va a *{place}* como se reservó. Escríbanos si eso no le sirve.',
    addr_asked: 'Le pregunté a su asociado por *{place}* — nada cambia hasta que diga que puede llevarlo. Le aviso igualmente.',
    checkout_placed: 'Pedido {order} registrado. {kitchen} lo confirmará en breve y le aviso en cuanto salga.',
    checkout_cancelled: 'Lo dejamos ahí — no se ha pedido nada. Su cesta sigue aquí cuando quiera.',
    aisles_head: '🛒 *La tienda* — {n} secciones. Esto es todo lo que tenemos:',
    aisle_items_how: '_Responda con una letra y cuántos — *a x2* — o escriba directamente lo que quiere. Un número es siempre una sección y una letra siempre algo del estante._',
    aisle_basket: '🛒 Cesta · {total}',
    aisle_checkout: '✅ Pagar',
    basket_head: '🛒 *Su cesta*',
    basket_total: '*Productos {goods}* — el envío se calcula cuando diga a dónde va.',
    basket_how: 'Para cambiar algo: *a x3* lo pone en tres, *a x0* lo quita. O simplemente dígalo.',
    basket_minimum: '🛒 Su cesta es de *{goods}*, y el pedido mínimo que podemos enviar es *{least}* — faltan *{short}*. Añada algo y listo.',
    basket_empty: 'Su cesta está vacía. Elija una sección, o escriba lo que quiere.',
    aisles_how: 'Responda con el número de una sección — *1* a *{last}* — para ver qué hay en ella.{nl}{nl}Pulse *Salir de víveres* para volver al menú principal; dentro de una sección hay un botón *Secciones* para volver a esta página.',
    aisles_empty: 'Todavía no hay nada en los estantes. Escríbanos y alguien lo resolverá.',
    aisle_back: '🛒 Secciones',
    aisle_leave: '⬅️ Salir de víveres',
    pick_drop_ask: '¿Dónde entregamos?',
    pick_from_ask: '¿De dónde le recogemos?',
    pick_to_ask: '¿Y a dónde va?',
    pick_or_type: 'Solo escríbalo — Diamond, Beterverwagting, BV. O toque abajo para ver la lista.',
    pick_corridor_ask: '¿Qué parte de {corridor}?',
    pick_saved: 'Su dirección guardada',
    pick_recent: 'Ya ha usado este lugar',
    pick_back: '⬅️ Volver a las zonas',
    pick_menu: '⬅️ Menú principal',
    pick_type: '✏️ Escribir el nombre',
    pick_more: 'Más lugares',
    pick_more_hint: '{n} lugares más, los más cercanos primero',
    pick_more_plain: '{n} lugares más en esta zona',
    pick_type_hint: 'Más rápido que buscar — escríbalo como quiera',
    pick_corridor_help_from: 'Mejor escríbalo — como quiera escribirlo, yo lo encuentro.',
    pick_corridor_help_to: 'De más cerca a más lejos. Toque Más lugares, o escriba el nombre — es más rápido.',
    pick_fare_unknown: 'Tarifa acordada con el conductor',
    returned_to_sender: 'El paquete {order} vuelve a usted — {name} no pudo recibirlo. El asociado de entrega lo llevará al lugar donde lo recogió. La tarifa cubre el viaje, que sí se hizo, por lo que no se reembolsa.',
    returned_nobody_home: 'El pedido {order} ha regresado — no había nadie en la puerta para recibirlo. Escríbanos cuando pueda y organizamos otra entrega.',
    delivered_confirmed: 'Pedido {order} entregado.' + chr10 + 'Código de entrega: confirmado.',
    delivered_unverified: 'Pedido {order} entregado.' + chr10 + 'Código de entrega: no confirmado.',
    delivered_check: chr10 + chr10 + '¿Algo va mal con este pedido? Escríbanos.',
    door_code_for: chr10 + chr10 + 'El código de entrega es *{code}* \u2014 déselo a {name}, quien se lo dirá al asociado de entrega en la puerta, para que sepamos que el pedido llegó a las manos correctas.',
    door_code: chr10 + chr10 + 'Su código de entrega es *{code}* — dígaselo al asociado de entrega en la puerta, para que sepamos que su pedido llegó a las manos correctas.',

    cancel_sorry: 'Lo sentimos {name} —',
    cancel_done: 'Listo {name} —',
    cancel_by_outlet: '*{outlet}* ha cancelado su pedido',
    cancel_plain: 'El pedido {order} ha sido cancelado',
    cancel_plain_taxi: 'El viaje {order} ha sido cancelado',
    cancel_with_reason: '{opening} {subject}: {reason}. No se ha cobrado nada.',
    cancel_no_reason: '{opening} {subject}. No se ha cobrado nada.',

    reason_sold_out: 'a la cocina se le ha acabado algo del pedido',
    reason_too_busy: 'la cocina está demasiado ocupada para aceptarlo ahora',
    reason_closing: 'la cocina está cerrando por hoy',
    reason_customer: 'usted nos pidió cancelarlo',
    reason_undeliverable: 'no pudimos llegar a la dirección',

    opening_taxi:
      'Un coche. 🚕 ¿De dónde le recogemos, a dónde va y a qué hora? Dígame también cuántas personas son y le buscaré un coche.' +
      chr10 +
      chr10 +
      'Le diré la tarifa antes de reservar nada.',
    opening_grocery:
      'Supermercado entonces. Dígame qué necesita — escriba una lista, envíe una foto, o simplemente dígamelo.',
    opening_parcel:
      'Envío de paquetes. Necesito saber de dónde sale, a dónde va y quién lo recibe.',
    opening_other:
      'Sin problema — dígame qué necesita y lo paso directamente al equipo con su número.',

    outlets_cooking_now: 'Cocinas abiertas ahora mismo:',
    outlets_none_cooking: 'Ninguna cocina está abierta ahora mismo:',
    outlets_switch_groceries: 'Envíe *menu* si prefiere hacer la compra del supermercado.',
    outlets_none_setup:
      'Todavía no hay restaurantes disponibles, así que no hay de dónde pedir — pero puedo ayudarle con el supermercado. Envíe *menu* para cambiar.',
    outlet_minutes: '{n} min',
    outlet_delivery: 'envío {total}',
    outlet_min_order: 'mínimo {total}',
    outlet_paused: 'cocina en pausa',
    outlet_opens: 'abre {time}',
    outlet_closed: 'cerrado',

    signoff_order_again: '¡Buen provecho! Escríbanos cuando quiera para pedir de nuevo. 💬',
    signoff_next_time: '¡Buen provecho, hasta la próxima! 👋',
    signoff_meal: '¡Buen provecho! 🍽️',
    signoff_food: '¡Que aproveche! 😋',
    signoff_enjoy: '¡Que lo disfrute! 😊',
    signoff_every_bite: '¡Disfrute cada bocado! 😋',
    signoff_appetit: '¡Buen provecho! 🥘',
    signoff_just_right: '¡Espero que todo esté tal como lo quería! 😊',
    signoff_see_you_next: '¡Hasta la próxima! 👋',
    signoff_next_order: 'Escríbanos cuando quiera para su próximo pedido. 💬',
    signoff_here_for_you: 'Estamos aquí cuando nos necesite. 🙌',
    signoff_rest_of_day: '¡Que tenga un buen día! ☀️',
    signoff_moved_any_time: 'Escríbanos cuando necesite enviar algo. 💬',
    signoff_trusting_us: 'Gracias por confiarnos el envío. 📦',
    signoff_next_one: 'Aquí estamos para el próximo. 🙌',
    signoff_carried: 'Cuando necesite llevar algo, ya sabe dónde estamos. 💬',
    signoff_good_to_help: 'Un gusto poder ayudar. 👋',
  },

  pt: {
    welcome: 'Bem-vindo a {store}! 👋',
    welcome_back: 'Bem-vindo de volta a {store}, {name}! 👋',
    how_can_we_help: 'Em que podemos ajudar hoje?',
    reply_with_number: 'Responda com o número.',

    service_taxi: 'Táxi',
    service_grocery: 'Compras de supermercado',
    service_restaurant: 'Pedido de restaurante',
    service_parcel: 'Entrega de encomendas',
    service_other: 'Outro',

    confirmed:
      'Obrigado {name} — o pedido {order} está confirmado. Avisaremos quando estiver a caminho.',
    on_the_way:
      '{name}, o seu pedido {order} está a caminho 🛵\nTotal {total}, a pagar ao associado de entrega.',
    delivered: 'Pedido {order} entregue.',
    thanks_grocery: 'Obrigado por comprar connosco!',
    thanks_store: 'Obrigado por escolher {store}!',

    receipt_title: 'Recibo',
    receipt_goods: 'Produtos',
    receipt_delivery: 'Entrega',
    receipt_total: 'Total',
    receipt_paid_cash: 'pago em dinheiro',
    receipt_paid_card: 'pago com cartão',
    receipt_parcel_fee: 'Taxa de entrega',
    receipt_paid_at_pickup: 'pago na coleta',
    pin_elsewhere: 'Não está lá agora? Arraste o mapa, ou procure o local, antes de enviar.',
    returned_wrong_code: 'A encomenda {order} está a voltar para si — o código que {name} deu não coincidiu, por isso o associado de entrega não a entregou. Confirme com {name} que tinha o código que lhe passou. A taxa cobre a viagem, que foi feita, por isso não é reembolsada.',
    parcel_on_the_way: 'A encomenda {order} foi recolhida e está a caminho de {name}.',
    taxi_confirmed: 'Obrigado {name} — um motorista está a caminho para o recolher. Viagem {order}. 🚕',
    taxi_on_the_way: '{name}, está a caminho 🚕',
    taxi_fare_with_driver: 'A tarifa é combinada com o motorista.',
    taxi_fare_quoted: 'A sua tarifa é *{fare}*, a pagar ao motorista. A espera após a recolha é cobrada à parte.',
    taxi_fare_from: 'A sua tarifa é *{fare}*, a pagar ao motorista — calculada a partir de *{place}*, a zona mais próxima do ponto que enviou. A espera após a recolha é cobrada à parte.',
    taxi_dropped_off: 'Viagem {order} concluída — chegou ao destino. 🚕',
    taxi_no_show: 'A viagem {order} foi encerrada — o motorista não o encontrou no local de recolha. Escreva-nos quando estiver pronto e enviaremos outro carro.',
    taxi_driver_outside: 'O seu motorista está lá fora 🚕 Vai dizer-lhe o seu código de segurança *{code}* antes de entrar.',
    taxi_safety_code: '🔐 O seu código de segurança é *{code}*. O motorista vai dizer-lhe estes quatro algarismos antes de entrar. Se disser outros, não entre no carro — escreva-nos.',
    points_earned: '⭐ *+{points} pontos* por esta entrega.',
    points_to_go: 'Tem *{points} pontos* — *faltam {togo}* para {value} de desconto.',
    points_ready: 'Tem *{points} pontos* — são *{value}* de desconto num pedido, quando quiser.',
    points_use_hint: 'Basta dizer *usar os meus pontos*.',
    points_deliveries: 'Mais cerca de {n} entregas para {zone}.',
    points_one_delivery: 'Mais uma entrega para {zone}.',
    points_used: 'Recompensa usada: *{points} pontos* — *{value}* de desconto.',
    receipt_reward: 'Recompensa',
    receipt_fare: 'Tarifa',
    receipt_waiting: 'Espera',
    receipt_trip: 'Viagem',
    receipt_points: 'Ganhou *{points} pontos* nesta viagem.',

    opening_taxi_picked:
      'Um carro então. 🚕 Digo-lhe a tarifa antes de reservar seja o que for.',
    fare_book: 'Reservar',
    fare_change: 'Mudar destino',
    fare_cancel: 'Cancelar',
    taxi_cancelled: 'Sem problema — não foi reservado nada. Envie *menu* quando precisar de nós.',
    spot_ask_from: '*{place}* — certo. Se já está aí, envie a sua localização exata e o motorista vai direto ter consigo.',
    spot_ask_drop: '*{place}* — certo, a entrega custa {fee}. Toque abaixo para enviar o seu ponto exato e o associado vai direito à sua porta. Sem mapa? Responda *ignorar* — ou escreva algo que ele deva saber (um portão, um andar, uma referência).',
    spot_ask_to: '*{place}* — certo. Se sabe o local exato, envie-o no mapa e o motorista leva-o mesmo até lá.',
    spot_same_as_pickup: 'Esse é o ponto onde o vão buscar — a cerca de {km} dele.{nl}{nl}O WhatsApp envia onde está parado se não mexer no mapa. Se vai para outro sítio, arraste o mapa ou procure o lugar antes de enviar — ou diga-me a zona.',
    spot_send: '📍 Enviar local',
    spot_skip: 'Ignorar',
    pin_far: 'Esse ponto fica a cerca de {km} de *{place}*, e a entrega está calculada para {place}.',
    pin_far_named: 'Esse ponto fica a {km} de *{place}* — está em *{near}*. A entrega está calculada para {place}.',
    pin_send_again: 'Toque abaixo e envie o ponto em *{place}*. Sem mapa? Responda *ignorar* e diga-me a rua.',
    pin_keep: 'Sim, está certo',
    pin_again: 'Enviar outra vez',
    street_elsewhere: '⚠️ Escolheu *{place}*, mas essa morada parece ser de *{named}*.',
    street_elsewhere_km: '⚠️ Escolheu *{place}*, mas essa morada parece ser de *{named}* — a cerca de {km}.',
    street_which: 'Qual é? Toque *{move}* para enviar para {named} por {fee}, ou *{again}* para me dar a morada em {place}.',
    street_move: 'Mudar a aldeia',
    street_again: 'Corrigir morada',
    nobody_out: 'Não há ninguém na estrada neste momento, por isso ainda não consigo levar-lhe isto.',
    nobody_out_held: 'A sua lista fica tal como está — {what}.',
    nobody_out_back: 'Não tem de fazer nada. Volto a falar consigo assim que houver alguém na estrada.',
    wait_taxi: '🚕 Já há um carro na estrada.{nl}{nl}{what} — ainda quer?',
    wait_order: '🛵 Já há alguém na estrada.{nl}{nl}{what}{nl}{nl}Faço o pedido?',
    wait_parcel: '📦 Já há alguém na estrada.{nl}{nl}{what}{nl}{nl}Ponho isto a andar?',
    wait_go_taxi: 'Sim, mande',
    wait_go_order: 'Fazer o pedido',
    wait_go_parcel: 'Reservar',
    wait_no: 'Agora não',
    wait_dropped: 'Sem problema — escreva quando quiser e volto a ver.',
    wait_gone: 'Desculpe — esse acabou de ser tomado. Continua a ser o primeiro e aviso assim que houver outro.',
    spot_prompt_from: 'Toque abaixo para enviar onde está exatamente.',
    spot_prompt_to: 'Toque abaixo para enviar o local exato para onde vai.',
    spot_saved: 'Certo — o motorista vai ter isso. 📍',
    dest_ask: 'O seu motorista diz que agora vai para *{place}*. Isso faz a tarifa *{now}* em vez de *{was}*.',
    dest_gone: 'Isso já ficou resolvido — não há nada a responder.',
    dest_ack: 'Entendido',
    dest_keep: 'Não, como reservado',
    dest_changed: 'Pronto — vai para *{place}*, *{fare}*. O seu motorista já sabe.',
    dest_kept: 'Sem alteração — vai para *{place}* como reservado, *{fare}*. O seu motorista já sabe.',
    dest_asked: 'Perguntei ao seu motorista sobre *{place}* — nada muda até ele dizer que consegue lá ir. Aviso de qualquer forma.',
    dest_refused: 'O seu motorista não consegue levá-lo lá, por isso vai para *{place}* como reservado, *{fare}*. Escreva-nos se isso não servir.',
    pickup_far: '⚠️ Disse *{said}*, mas o ponto que enviou parece ser *{pinned}*.',
    pickup_far_named: '⚠️ Disse *{said}*, mas o ponto que enviou fica a {km}, em *{pinned}*.',
    pickup_fares: 'Conta para o preço: de {said} são {said_fare}, de {pinned} são {pin_fare}.',
    pickup_which: 'Em qual está? Se está em {pinned}, toque abaixo e calculo a partir daí. Se está em {said}, envie-me o ponto outra vez.',
    pickup_here: 'Estou no ponto',
    pickup_again: 'Enviar outra vez',
    pickup_unplaced: 'Toque abaixo para enviar o seu ponto exato de recolha, para o motorista ir direito a si — ou diga-me exatamente onde o procurar: em frente a que lugar, ou a quantas casas de que esquina, e para que lado.',
    pick_button: 'Escolher local',
    pick_which_place: 'Há mais do que um *{said}*, e não custam o mesmo. Qual deles?',
    checkout_street_ask: 'Qual é a morada em {place}? Número do lote e rua, para chegarem à porta certa.',
    checkout_name_ask: 'E em que nome fica a entrega?',
    checkout_gate_parcel: '📦 {contents}{nl}Para *{to}* em {where}{nl}*Entrega {fee}*, cobrada a si no levantamento.{nl}{nl}Reservo?',
    checkout_gate: '{items}{nl}Entrega para {place} — {fee}{nl}*Total {total}*, em dinheiro ao associado à sua porta.{nl}{nl}Em nome de *{name}*, em {where}.{spot}{nl}{nl}Faço o pedido?',
    checkout_no_spot: 'Não enviou o local exato — o seu associado liga quando estiver perto.',
    checkout_failed: 'Algo correu mal ao registar o pedido e nada foi pedido. Deixe-me ver outra vez — um momento.',
    checkout_the_shop: 'A loja',
    checkout_booked_parcel: 'Encomenda {order} reservada. Aviso assim que um associado a aceitar.',
    addr_pin_first: 'Antes de perguntar ao seu associado: envie o seu ponto exato em *{place}* no mapa, para ele ver a porta quando responder — ou toque em Saltar e pergunto na mesma.',
    pin_asked_by_rider: 'O seu associado vai a caminho com {order} e não encontra a porta. Envie o seu ponto exato no mapa e ele vai direito lá — ou toque em Saltar e ele liga-lhe.',
    addr_pin_ask: 'Agora envie o seu ponto exato em *{place}* no mapa e o associado vai direito à porta — ou toque em Saltar e ele liga quando estiver perto.',
    spot_skipped: 'Sem problema — o associado liga quando estiver perto.',
    addr_pinned: 'Certo — o seu associado já tem o ponto no mapa dele.',
    addr_changed: 'Feito — {order} vai para *{place}*. Novo total *{total}*. O seu associado já sabe.',
    addr_kept: 'O seu associado não consegue levar lá, por isso {order} vai para *{place}* como reservado. Escreva-nos se isso não servir.',
    addr_asked: 'Perguntei ao seu associado sobre *{place}* — nada muda até ele dizer que consegue lá ir. Aviso de qualquer forma.',
    checkout_placed: 'Pedido {order} registado. {kitchen} confirma em breve e aviso assim que sair.',
    checkout_cancelled: 'Ficamos por aqui — nada foi pedido. O seu cesto continua à espera.',
    aisles_head: '🛒 *A loja* — {n} secções. Isto é tudo o que temos:',
    aisle_items_how: '_Responda com uma letra e quantos — *a x2* — ou escreva directamente o que quer. Um número é sempre uma secção e uma letra é sempre algo da prateleira._',
    aisle_basket: '🛒 Cesto · {total}',
    aisle_checkout: '✅ Finalizar',
    basket_head: '🛒 *O seu cesto*',
    basket_total: '*Produtos {goods}* — a entrega é calculada quando disser para onde vai.',
    basket_how: 'Para mudar algo: *a x3* põe três, *a x0* tira. Ou basta dizer.',
    basket_minimum: '🛒 O seu cesto está em *{goods}*, e o pedido mínimo que conseguimos enviar é *{least}* — faltam *{short}*. Junte alguma coisa e seguimos.',
    basket_empty: 'O seu cesto está vazio. Escolha uma secção, ou escreva o que quer.',
    aisles_how: 'Responda com o número de uma secção — *1* a *{last}* — para ver o que tem lá dentro.{nl}{nl}Toque em *Sair da mercearia* para voltar ao menu principal; dentro de uma secção há um botão *Secções* para voltar a esta página.',
    aisles_empty: 'Ainda não há nada nas prateleiras. Escreva-nos e alguém trata disso.',
    aisle_back: '🛒 Secções',
    aisle_leave: '⬅️ Sair da mercearia',
    pick_drop_ask: 'Onde entregamos?',
    pick_from_ask: 'Onde o vamos recolher?',
    pick_to_ask: 'E para onde vai?',
    pick_or_type: 'É só escrever — Diamond, Beterverwagting, BV. Ou toque abaixo para ver a lista.',
    pick_corridor_ask: 'Que parte de {corridor}?',
    pick_saved: 'A sua morada guardada',
    pick_recent: 'Já usou este local',
    pick_back: '⬅️ Voltar às zonas',
    pick_menu: '⬅️ Menu principal',
    pick_type: '✏️ Escrever o nome',
    pick_more: 'Mais locais',
    pick_more_hint: 'Mais {n} locais, os mais próximos primeiro',
    pick_more_plain: 'Mais {n} locais nesta zona',
    pick_type_hint: 'Mais rápido do que procurar — escreva como quiser',
    pick_corridor_help_from: 'Prefira escrever o nome — como quiser escrevê-lo, eu encontro-o.',
    pick_corridor_help_to: 'Do mais perto ao mais longe. Toque em Mais locais, ou escreva o nome — é mais rápido.',
    pick_fare_unknown: 'Tarifa combinada com o motorista',
    returned_to_sender: 'A encomenda {order} está a voltar para si — {name} não a pôde receber. O associado de entrega levá-la-á ao local onde a recolheu. A taxa cobre a viagem, que foi feita, por isso não é reembolsada.',
    returned_nobody_home: 'O pedido {order} voltou — não estava ninguém à porta para o receber. Escreva-nos quando puder e combinamos outra entrega.',
    delivered_confirmed: 'Pedido {order} entregue.' + chr10 + 'Código de entrega: confirmado.',
    delivered_unverified: 'Pedido {order} entregue.' + chr10 + 'Código de entrega: não confirmado.',
    delivered_check: chr10 + chr10 + 'Algo errado com este pedido? Envie-nos uma mensagem.',
    door_code_for: chr10 + chr10 + 'O código de entrega é *{code}* \u2014 dê-o a {name}, que o informará ao associado de entrega à porta, para sabermos que o pedido chegou às mãos certas.',
    door_code: chr10 + chr10 + 'O seu código de entrega é *{code}* — informe-o ao associado de entrega à porta, para sabermos que o seu pedido chegou às mãos certas.',

    cancel_sorry: 'Lamentamos {name} —',
    cancel_done: 'Pronto {name} —',
    cancel_by_outlet: '*{outlet}* cancelou o seu pedido',
    cancel_plain: 'O pedido {order} foi cancelado',
    cancel_plain_taxi: 'A viagem {order} foi cancelada',
    cancel_with_reason: '{opening} {subject}: {reason}. Não foi cobrado nada.',
    cancel_no_reason: '{opening} {subject}. Não foi cobrado nada.',

    reason_sold_out: 'a cozinha ficou sem um dos itens',
    reason_too_busy: 'a cozinha está cheia demais para aceitar agora',
    reason_closing: 'a cozinha está a fechar por hoje',
    reason_customer: 'você pediu para cancelar',
    reason_undeliverable: 'não conseguimos chegar ao endereço',

    opening_taxi:
      'Um carro. 🚕 De onde o buscamos, para onde vai e a que horas? Diga-me também quantas pessoas são e vou procurar-lhe um carro.' +
      chr10 +
      chr10 +
      'Digo-lhe a tarifa antes de reservar seja o que for.',
    opening_grocery:
      'Compras, então. Diga-me o que precisa — escreva uma lista, envie uma foto, ou diga por voz.',
    opening_parcel:
      'Entrega de encomendas. Preciso de saber de onde sai, para onde vai e quem a recebe.',
    opening_other:
      'Sem problema — diga-me o que precisa e passo diretamente à equipa com o seu número.',

    outlets_cooking_now: 'Cozinhas a trabalhar agora:',
    outlets_none_cooking: 'Nenhuma cozinha está aberta agora:',
    outlets_switch_groceries: 'Envie *menu* se preferir fazer compras de supermercado.',
    outlets_none_setup:
      'Ainda não há restaurantes disponíveis, por isso não há onde pedir — mas posso ajudar com as compras. Envie *menu* para mudar.',
    outlet_minutes: '{n} min',
    outlet_delivery: 'entrega {total}',
    outlet_min_order: 'mínimo {total}',
    outlet_paused: 'cozinha em pausa',
    outlet_opens: 'abre {time}',
    outlet_closed: 'fechado',

    signoff_order_again: 'Bom apetite! Escreva-nos quando quiser para pedir novamente. 💬',
    signoff_next_time: 'Bom apetite, até à próxima! 👋',
    signoff_meal: 'Bom apetite! 🍽️',
    signoff_food: 'Aproveite a refeição! 😋',
    signoff_enjoy: 'Aproveite! 😊',
    signoff_every_bite: 'Aproveite cada garfada! 😋',
    signoff_appetit: 'Bom apetite! 🥘',
    signoff_just_right: 'Espero que esteja tudo como queria! 😊',
    signoff_see_you_next: 'Até à próxima! 👋',
    signoff_next_order: 'Escreva-nos quando quiser para o próximo pedido. 💬',
    signoff_here_for_you: 'Estamos aqui sempre que precisar. 🙌',
    signoff_rest_of_day: 'Tenha um bom resto de dia! ☀️',
    signoff_moved_any_time: 'Escreva-nos sempre que precisar de enviar algo. 💬',
    signoff_trusting_us: 'Obrigado por nos confiar a entrega. 📦',
    signoff_next_one: 'Estamos aqui para o próximo. 🙌',
    signoff_carried: 'Quando precisar de levar algo, já sabe onde estamos. 💬',
    signoff_good_to_help: 'Foi um gosto ajudar. 👋',
  },

  zh: {
    welcome: '欢迎来到 {store}！👋',
    welcome_back: '{name}，欢迎回到 {store}！👋',
    how_can_we_help: '今天需要什么服务？',
    reply_with_number: '请回复数字。',

    service_taxi: '出租车',
    service_grocery: '超市代购',
    service_restaurant: '餐厅订餐',
    service_parcel: '包裹递送',
    service_other: '其他',

    confirmed: '谢谢{name}，订单 {order} 已确认。出发时我们会通知您。',
    on_the_way: '{name}，您的订单 {order} 已出发 🛵\n共计 {total}，请付给配送专员。',
    delivered: '订单 {order} 已送达。',
    thanks_grocery: '感谢您在我们这里购物！',
    thanks_store: '感谢您选择 {store}！',

    receipt_title: '收据',
    receipt_goods: '商品',
    receipt_delivery: '配送',
    receipt_total: '合计',
    receipt_paid_cash: '现金支付',
    receipt_paid_card: '刷卡支付',
    receipt_parcel_fee: '配送费',
    receipt_paid_at_pickup: '取件时已付',
    pin_elsewhere: '现在不在那里？发送前请拖动地图，或搜索该地点。',
    returned_wrong_code: '包裹 {order} 正在退回给您 — {name} 提供的收货码不正确，配送专员因此没有交付。请与 {name} 核对您转告的收货码。费用已用于本次行程，故不予退还。',
    parcel_on_the_way: '包裹 {order} 已提取，正在送往 {name}。',
    taxi_confirmed: '谢谢{name}，司机正在前往接您。行程 {order}。🚕',
    taxi_on_the_way: '{name}，您已出发 🚕',
    taxi_fare_with_driver: '车费请与司机商定。',
    taxi_fare_quoted: '您的车费为 *{fare}*，请付给司机。上车后的等候另行收费。',
    taxi_fare_from: '您的车费为 *{fare}*，请付给司机 — 按离您发送位置最近的地区 *{place}* 计算。上车后的等候另行收费。',
    taxi_dropped_off: '行程 {order} 已完成，您已到达。🚕',
    taxi_no_show: '行程 {order} 已结束，司机在接您的地点没有找到您。您准备好后请告诉我们，我们会再派一辆车。',
    taxi_driver_outside: '司机已在外面等候 🚕 上车前他会先告知您安全码 *{code}*。',
    taxi_safety_code: '🔐 您的安全码是 *{code}*。上车前司机会把这四位数字告诉您。如果数字不符，请不要上车，并立即联系我们。',
    points_earned: '⭐ 本次配送获得 *+{points} 积分*。',
    points_to_go: '您现有 *{points} 积分*——再 *{togo} 分*即可减 {value}。',
    points_ready: '您现有 *{points} 积分*——相当于订单减 *{value}*，随时可用。',
    points_use_hint: '告诉我们*使用积分*即可。',
    points_deliveries: '大约再送 {n} 次到{zone}。',
    points_one_delivery: '再送 1 次到{zone}。',
    points_used: '已使用奖励：*{points} 积分*，减 *{value}*。',
    receipt_reward: '奖励',
    receipt_fare: '车费',
    receipt_waiting: '等候',
    receipt_trip: '行程',
    receipt_points: '本次行程获得 *{points} 积分*。',

    opening_taxi_picked: '好的，为您叫车。🚕 预订前我会先告诉您车费。',
    fare_book: '确认预订',
    fare_change: '更改目的地',
    fare_cancel: '取消',
    taxi_cancelled: '没问题，尚未预订任何行程。需要时请发送 *menu*。',
    spot_ask_from: '*{place}* — 好的。如果您已经到了，请发送您的确切位置，司机会直接来找您。',
    spot_ask_drop: '*{place}* — 好的，配送费 {fee}。点击下方发送您的准确位置，配送员会直接送到您家门口。没有地图？回复 *跳过* — 或输入需要告知的信息（门、楼层、地标）。',
    spot_ask_to: '*{place}* — 好的。如果您知道确切地点，请在地图上发送，司机会直接送您过去。',
    spot_same_as_pickup: '那是接您的地点 — 距离它约 {km}。{nl}{nl}如果不移动地图，WhatsApp 发送的是您当前所在位置。如果您要去别的地方，请先拖动地图或搜索该地点再发送 — 或直接告诉我地区。',
    spot_send: '📍 发送位置',
    spot_skip: '跳过',
    pin_far: '这个位置距离 *{place}* 约 {km}，而配送费是按 {place} 计算的。',
    pin_far_named: '这个位置距离 *{place}* {km}，位于 *{near}*。配送费是按 {place} 计算的。',
    pin_send_again: '请点击下方发送 *{place}* 的位置。没有地图？回复 *跳过* 并告诉我街道地址。',
    pin_keep: '是的，没错',
    pin_again: '重新发送',
    street_elsewhere: '⚠️ 您选择的是 *{place}*，但这个地址看起来在 *{named}*。',
    street_elsewhere_km: '⚠️ 您选择的是 *{place}*，但这个地址看起来在 *{named}* — 相距约 {km}。',
    street_which: '是哪一个？点击 *{move}* 改送 {named}，费用 {fee}；或点击 *{again}* 告诉我 {place} 的地址。',
    street_move: '改送那个地区',
    street_again: '修改地址',
    nobody_out: '现在路上没有配送员，所以暂时还送不了。',
    nobody_out_held: '您的清单原样保留 — {what}。',
    nobody_out_back: '您不用做任何事。一有人上路我就立刻回复您。',
    wait_taxi: '🚕 现在路上有车了。{nl}{nl}{what} — 还需要吗？',
    wait_order: '🛵 现在有人上路了。{nl}{nl}{what}{nl}{nl}要下单吗？',
    wait_parcel: '📦 现在有人上路了。{nl}{nl}{what}{nl}{nl}要安排吗？',
    wait_go_taxi: '好，派车',
    wait_go_order: '下单',
    wait_go_parcel: '预订',
    wait_no: '暂时不用',
    wait_dropped: '没问题 — 您随时发消息，我再帮您查。',
    wait_gone: '抱歉 — 那位刚被别人约走了。您仍排在第一位，一有新的我就通知您。',
    spot_prompt_from: '点击下方发送您的确切位置。',
    spot_prompt_to: '点击下方发送您要前往的确切地点。',
    spot_saved: '好的 — 司机会收到。📍',
    dest_ask: '司机说您现在要去 *{place}*。车费将从 *{was}* 变为 *{now}*。',
    dest_gone: '该事项已经处理完毕，无需再回复。',
    dest_ack: '已知悉',
    dest_keep: '不，按原订单',
    dest_changed: '好了 — 您前往 *{place}*，*{fare}*。已告知司机。',
    dest_kept: '不更改 — 按原订单前往 *{place}*，*{fare}*。已告知司机。',
    dest_asked: '已向司机确认 *{place}* — 在他确认可以前往之前不会有任何变动。无论结果如何我都会通知您。',
    dest_refused: '司机无法前往那里，所以按原订单前往 *{place}*，*{fare}*。如不合适请告诉我们。',
    pickup_far: '⚠️ 您说的是 *{said}*，但您发送的位置看起来在 *{pinned}*。',
    pickup_far_named: '⚠️ 您说的是 *{said}*，但您发送的位置在 {km} 外的 *{pinned}*。',
    pickup_fares: '这会影响车费：从 {said} 出发是 {said_fare}，从 {pinned} 出发是 {pin_fare}。',
    pickup_which: '您在哪一个？如果在 {pinned}，请点击下方，我按那里计算。如果在 {said}，请重新发送位置。',
    pickup_here: '我在定位处',
    pickup_again: '重新发送',
    pickup_unplaced: '请点击下方发送您的准确上车地点，司机就能直接到您那里 — 或详细告诉我在哪里接您：在哪个地方对面，或离哪个路口几间房，朝哪个方向。',
    pick_button: '选择地点',
    pick_which_place: '有多个 *{said}*，价格不同。是哪一个？',
    checkout_street_ask: '{place} 的详细地址是？门牌号和街道，以便送到正确的门口。',
    checkout_name_ask: '这次配送用什么名字？',
    checkout_gate_parcel: '📦 {contents}{nl}送给 *{to}*，地址 {where}{nl}*运费 {fee}*，取件时向您收取。{nl}{nl}要下单吗？',
    checkout_gate: '{items}{nl}配送至 {place} — {fee}{nl}*合计 {total}*，到门后以现金支付给配送员。{nl}{nl}收件人 *{name}*，地址 {where}。{spot}{nl}{nl}要下单吗？',
    checkout_no_spot: '未发送精确位置 — 配送员快到时会打电话给您。',
    checkout_failed: '下单时出了点问题，什么都没有订。让我再看一下 — 请稍候。',
    checkout_the_shop: '本店',
    checkout_booked_parcel: '包裹 {order} 已下单。配送员接单后我会马上通知您。',
    addr_pin_first: '在我询问配送员之前：请在地图上发送您在 *{place}* 的准确位置，让他回复时能看到门口 — 或点击跳过，我照样询问。',
    pin_asked_by_rider: '配送员正在送 {order}，但找不到门。请在地图上发送您的准确位置，他会直接过去 — 或点击跳过，他会给您打电话。',
    addr_pin_ask: '现在在地图上发送您在 *{place}* 的准确位置，配送员会直接到门口 — 或点击跳过，他们快到时会打电话。',
    spot_skipped: '没问题 — 配送员快到时会打电话给您。',
    addr_pinned: '好的 — 配送员的地图上已经有新位置了。',
    addr_changed: '好了 — {order} 改送到 *{place}*。新的合计 *{total}*。已通知配送员。',
    addr_kept: '配送员无法送到那里，所以 {order} 仍按原地址 *{place}* 配送。如不合适请告诉我们。',
    addr_asked: '已向配送员确认 *{place}* — 在他确认可以送达之前不会有任何变动。无论结果如何我都会通知您。',
    checkout_placed: '订单 {order} 已收到。{kitchen} 会尽快确认，出发时我会通知您。',
    checkout_cancelled: '那就先这样 — 没有下单。您的购物篮还在。',
    aisles_head: '🛒 *本店* — 共 {n} 个分类。以下是我们所有的货品：',
    aisle_items_how: '_回复字母和数量 — *a x2* — 或直接输入您要的东西。数字永远代表分类，字母永远代表货架上的东西。_',
    aisle_basket: '🛒 购物篮 · {total}',
    aisle_checkout: '✅ 结账',
    basket_head: '🛒 *您的购物篮*',
    basket_total: '*商品 {goods}* — 配送费会在您说明送货地址后计算。',
    basket_how: '要修改：*a x3* 改成三份，*a x0* 移除。或直接告诉我们。',
    basket_minimum: '🛒 您的购物篮是 *{goods}*，我们的最低订单金额是 *{least}* — 还差 *{short}*。再加一点就可以了。',
    basket_empty: '购物篮是空的。选一个分类，或直接输入您要的东西。',
    aisles_how: '回复分类编号 — *1* 到 *{last}* — 查看里面有什么。{nl}{nl}随时点击*离开超市*回到主菜单；在分类里面有*分类*按钮可以回到这一页。',
    aisles_empty: '货架上还没有东西。给我们留言，会有人处理。',
    aisle_back: '🛒 分类',
    aisle_leave: '⬅️ 离开超市',
    pick_drop_ask: '送到哪里？',
    pick_from_ask: '请问在哪里接您？',
    pick_to_ask: '您要去哪里？',
    pick_or_type: '直接输入地名 — Diamond、Beterverwagting、BV。或点击下方浏览列表。',
    pick_corridor_ask: '{corridor} 的哪一带？',
    pick_saved: '您保存的地址',
    pick_recent: '您之前用过',
    pick_back: '⬅️ 返回地区列表',
    pick_menu: '⬅️ 主菜单',
    pick_type: '✏️ 输入地名',
    pick_more: '更多地点',
    pick_more_hint: '还有 {n} 个地点，由近到远',
    pick_more_plain: '这一带还有 {n} 个地点',
    pick_type_hint: '比翻找更快 — 怎么写都行',
    pick_corridor_help_from: '直接输入地名就好 — 怎么写都行，我帮您找。',
    pick_corridor_help_to: '按由近到远排列。可点「更多地点」，或直接输入地名，这样更快。',
    pick_fare_unknown: '车费由司机商定',
    returned_to_sender: '包裹 {order} 正在退回给您 — {name} 无法签收。配送专员会将其送回取件地点。费用已用于本次行程，故不予退还。',
    returned_nobody_home: '订单 {order} 已退回 — 门口无人接收。方便时请联系我们，我们会再安排一次配送。',
    delivered_confirmed: '订单 {order} 已送达。' + chr10 + '收货码：已确认。',
    delivered_unverified: '订单 {order} 已送达。' + chr10 + '收货码：未确认。',
    delivered_check: chr10 + chr10 + '这笔订单有任何问题吗？请给我们发消息。',
    door_code_for: chr10 + chr10 + '收货码是 *{code}* — 请转告 {name}，在门口告知配送专员，以确认订单送到正确的人手中。',
    door_code: chr10 + chr10 + '您的收货码是 *{code}* — 配送专员到达时请告知对方，以确认订单送到正确的人手中。',

    cancel_sorry: '很抱歉{name}，',
    cancel_done: '好的{name}，',
    cancel_by_outlet: '*{outlet}* 取消了您的订单',
    cancel_plain: '订单 {order} 已取消',
    cancel_plain_taxi: '行程 {order} 已取消',
    cancel_with_reason: '{opening}{subject}：{reason}。未收取任何费用。',
    cancel_no_reason: '{opening}{subject}。未收取任何费用。',

    reason_sold_out: '厨房的某样食材已用完',
    reason_too_busy: '厨房太忙，暂时无法接单',
    reason_closing: '厨房今天即将打烊',
    reason_customer: '您要求取消',
    reason_undeliverable: '我们无法到达该地址',

    opening_taxi:
      '好的，出租车。🚕 请问在哪里接您、去哪里、什么时间？也请告知几位乘客，我这就为您找车。' +
      chr10 +
      chr10 +
      '预订前我会先告知您车费。',
    opening_grocery:
      '好的，超市代购。请告诉我您需要什么——可以打字列清单、发照片，或者直接说。',
    opening_parcel:
      '包裹递送。我需要知道从哪里取件、送到哪里，以及由谁接收。',
    opening_other:
      '没问题——告诉我您需要什么，我会连同您的号码直接转给团队。',

    outlets_cooking_now: '现在营业的餐厅：',
    outlets_none_cooking: '现在没有餐厅在营业：',
    outlets_switch_groceries: '如果您想改为超市代购，请发送 *menu*。',
    outlets_none_setup:
      '目前还没有餐厅可供订餐——不过我可以帮您代购超市商品。发送 *menu* 切换。',
    outlet_minutes: '{n} 分钟',
    outlet_delivery: '配送费 {total}',
    outlet_min_order: '最低 {total}',
    outlet_paused: '暂停接单',
    outlet_opens: '{time} 开始营业',
    outlet_closed: '已打烊',

    signoff_order_again: '请慢用！随时可以给我们发消息再次订餐。💬',
    signoff_next_time: '请慢用，期待下次光临！👋',
    signoff_meal: '请慢用！🍽️',
    signoff_food: '祝您用餐愉快！😋',
    signoff_enjoy: '请享用！😊',
    signoff_every_bite: '每一口都好好享受！😋',
    signoff_appetit: '祝您胃口大开！🥘',
    signoff_just_right: '希望一切都合您心意！😊',
    signoff_see_you_next: '下次再见！👋',
    signoff_next_order: '下次需要下单，随时给我们发消息。💬',
    signoff_here_for_you: '随时需要，我们都在。🙌',
    signoff_rest_of_day: '祝您今天愉快！☀️',
    signoff_moved_any_time: '需要寄送物品时，随时给我们发消息。💬',
    signoff_trusting_us: '感谢您把它交给我们。📦',
    signoff_next_one: '下一件，我们同样为您效劳。🙌',
    signoff_carried: '需要送东西时，您知道去哪儿找我们。💬',
    signoff_good_to_help: '很高兴能帮上忙。👋',
  },
};

/**
 * One fixed message, in one language, with its blanks filled.
 *
 * Falls back to English for a key a language is missing rather than printing
 * the key itself: an untranslated sentence is a small embarrassment, and
 * `signoff_appetit` appearing in a customer's chat is a broken shop.
 */
export function t(key: string, language: Language, vars: Record<string, string> = {}): string {
  const text = STRINGS[language]?.[key] ?? STRINGS.en[key] ?? '';
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** Every key, for the test that proves no language has gaps. */
export function keysFor(language: Language): string[] {
  return Object.keys(STRINGS[language]);
}

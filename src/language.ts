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
    pick_button: 'Choose a place',
    pick_from_ask: 'Where are we collecting you from?',
    pick_to_ask: 'And where are you going?',
    pick_corridor_ask: 'Which part of {corridor}?',
    pick_saved: 'Your saved address',
    pick_recent: 'You have used this before',
    pick_back: '⬅️ Back to the areas',
    pick_menu: '⬅️ Main menu',
    pick_type: '✏️ Type the address',
    pick_more: 'More places',
    pick_more_hint: '{n} more places, nearest first',
    pick_type_hint: 'If your place is not on this list',
    pick_corridor_help: 'Listed nearest first — tap More places if you do not see yours.',
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
    pick_button: 'Elegir lugar',
    pick_from_ask: '¿De dónde le recogemos?',
    pick_to_ask: '¿Y a dónde va?',
    pick_corridor_ask: '¿Qué parte de {corridor}?',
    pick_saved: 'Su dirección guardada',
    pick_recent: 'Ya ha usado este lugar',
    pick_back: '⬅️ Volver a las zonas',
    pick_menu: '⬅️ Menú principal',
    pick_type: '✏️ Escribir dirección',
    pick_more: 'Más lugares',
    pick_more_hint: '{n} lugares más, los más cercanos primero',
    pick_type_hint: 'Si su lugar no está en esta lista',
    pick_corridor_help: 'De más cerca a más lejos — toque Más lugares si no ve el suyo.',
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
    pick_button: 'Escolher local',
    pick_from_ask: 'Onde o vamos recolher?',
    pick_to_ask: 'E para onde vai?',
    pick_corridor_ask: 'Que parte de {corridor}?',
    pick_saved: 'A sua morada guardada',
    pick_recent: 'Já usou este local',
    pick_back: '⬅️ Voltar às zonas',
    pick_menu: '⬅️ Menu principal',
    pick_type: '✏️ Escrever a morada',
    pick_more: 'Mais locais',
    pick_more_hint: 'Mais {n} locais, os mais próximos primeiro',
    pick_type_hint: 'Se o seu local não estiver nesta lista',
    pick_corridor_help: 'Do mais perto ao mais longe — toque em Mais locais se não vir o seu.',
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
    pick_button: '选择地点',
    pick_from_ask: '请问在哪里接您？',
    pick_to_ask: '您要去哪里？',
    pick_corridor_ask: '{corridor} 的哪一带？',
    pick_saved: '您保存的地址',
    pick_recent: '您之前用过',
    pick_back: '⬅️ 返回地区列表',
    pick_menu: '⬅️ 主菜单',
    pick_type: '✏️ 手动输入地址',
    pick_more: '更多地点',
    pick_more_hint: '还有 {n} 个地点，由近到远',
    pick_type_hint: '如果列表中没有您的地点',
    pick_corridor_help: '按由近到远排列 — 没看到就点「更多地点」。',
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

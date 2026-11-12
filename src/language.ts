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

    service_grocery: 'Grocery shopping',
    service_restaurant: 'Restaurant ordering',
    service_parcel: 'Parcel delivery',
    service_other: 'Other',

    confirmed: "Thanks {name} — order {order} is confirmed. We'll let you know when it's on the way.",
    on_the_way:
      '{name}, your order {order} is on its way 🛵\nTotal {total}, payable to the delivery associate.',
    delivered: 'Order {order} delivered. Thank you for choosing {store}!',
    pin_elsewhere: 'Not where you are now? Drag the map, or search for the place, before you send it.',
    returned_to_sender: 'Parcel {order} is coming back to you — {name} could not take it. The delivery associate will bring it to where it was collected. The fee covers the trip, which was made, so it is not refunded.',
    delivered_confirmed: 'Order {order} delivered.' + chr10 + 'Delivery code: confirmed.' + chr10 + chr10 + 'Thank you for choosing {store}!',
    delivered_unverified: 'Order {order} delivered.' + chr10 + 'Delivery code: not confirmed.' + chr10 + chr10 + 'Thank you for choosing {store}!',
    delivered_check: chr10 + chr10 + 'Anything wrong with this order? Just message us.',
    door_code_for: chr10 + chr10 + 'The delivery code is *{code}* \u2014 give it to {name}, who reads it to the delivery associate at the door, so we know the order reached the right hands.',
    door_code: chr10 + chr10 + 'Your delivery code is *{code}* — read it to the delivery associate at the door, so we know your order reached the right hands.',

    cancel_sorry: 'Sorry about this {name} —',
    cancel_done: 'Done {name} —',
    cancel_by_outlet: '*{outlet}* has cancelled your order',
    cancel_plain: 'Order {order} has been cancelled',
    cancel_with_reason: '{opening} {subject}: {reason}. Nothing has been charged.',
    cancel_no_reason: '{opening} {subject}. Nothing has been charged.',

    reason_sold_out: 'the kitchen has run out of something on it',
    reason_too_busy: 'the kitchen is too backed up to take it right now',
    reason_closing: 'the kitchen is closing for the day',
    reason_customer: 'you asked us to cancel it',
    reason_undeliverable: 'we could not get to the address',

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
  },

  es: {
    welcome: '¡Bienvenido a {store}! 👋',
    welcome_back: '¡Bienvenido de nuevo a {store}, {name}! 👋',
    how_can_we_help: '¿En qué podemos ayudarle hoy?',
    reply_with_number: 'Responda con el número.',

    service_grocery: 'Compra de supermercado',
    service_restaurant: 'Pedido de restaurante',
    service_parcel: 'Envío de paquetes',
    service_other: 'Otro',

    confirmed:
      'Gracias {name} — el pedido {order} está confirmado. Le avisaremos cuando vaya en camino.',
    on_the_way:
      '{name}, su pedido {order} va en camino 🛵\nTotal {total}, a pagar al asociado de entrega.',
    delivered: 'Pedido {order} entregado. ¡Gracias por elegir {store}!',
    pin_elsewhere: '¿No está ahí ahora? Mueva el mapa, o busque el lugar, antes de enviarlo.',
    returned_to_sender: 'El paquete {order} vuelve a usted — {name} no pudo recibirlo. El asociado de entrega lo llevará al lugar donde lo recogió. La tarifa cubre el viaje, que sí se hizo, por lo que no se reembolsa.',
    delivered_confirmed: 'Pedido {order} entregado.' + chr10 + 'Código de entrega: confirmado.' + chr10 + chr10 + '¡Gracias por elegir {store}!',
    delivered_unverified: 'Pedido {order} entregado.' + chr10 + 'Código de entrega: no confirmado.' + chr10 + chr10 + '¡Gracias por elegir {store}!',
    delivered_check: chr10 + chr10 + '¿Algo va mal con este pedido? Escríbanos.',
    door_code_for: chr10 + chr10 + 'El código de entrega es *{code}* \u2014 déselo a {name}, quien se lo dirá al asociado de entrega en la puerta, para que sepamos que el pedido llegó a las manos correctas.',
    door_code: chr10 + chr10 + 'Su código de entrega es *{code}* — dígaselo al asociado de entrega en la puerta, para que sepamos que su pedido llegó a las manos correctas.',

    cancel_sorry: 'Lo sentimos {name} —',
    cancel_done: 'Listo {name} —',
    cancel_by_outlet: '*{outlet}* ha cancelado su pedido',
    cancel_plain: 'El pedido {order} ha sido cancelado',
    cancel_with_reason: '{opening} {subject}: {reason}. No se ha cobrado nada.',
    cancel_no_reason: '{opening} {subject}. No se ha cobrado nada.',

    reason_sold_out: 'a la cocina se le ha acabado algo del pedido',
    reason_too_busy: 'la cocina está demasiado ocupada para aceptarlo ahora',
    reason_closing: 'la cocina está cerrando por hoy',
    reason_customer: 'usted nos pidió cancelarlo',
    reason_undeliverable: 'no pudimos llegar a la dirección',

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
  },

  pt: {
    welcome: 'Bem-vindo a {store}! 👋',
    welcome_back: 'Bem-vindo de volta a {store}, {name}! 👋',
    how_can_we_help: 'Em que podemos ajudar hoje?',
    reply_with_number: 'Responda com o número.',

    service_grocery: 'Compras de supermercado',
    service_restaurant: 'Pedido de restaurante',
    service_parcel: 'Entrega de encomendas',
    service_other: 'Outro',

    confirmed:
      'Obrigado {name} — o pedido {order} está confirmado. Avisaremos quando estiver a caminho.',
    on_the_way:
      '{name}, o seu pedido {order} está a caminho 🛵\nTotal {total}, a pagar ao associado de entrega.',
    delivered: 'Pedido {order} entregue. Obrigado por escolher {store}!',
    pin_elsewhere: 'Não está lá agora? Arraste o mapa, ou procure o local, antes de enviar.',
    returned_to_sender: 'A encomenda {order} está a voltar para si — {name} não a pôde receber. O associado de entrega levá-la-á ao local onde a recolheu. A taxa cobre a viagem, que foi feita, por isso não é reembolsada.',
    delivered_confirmed: 'Pedido {order} entregue.' + chr10 + 'Código de entrega: confirmado.' + chr10 + chr10 + 'Obrigado por escolher {store}!',
    delivered_unverified: 'Pedido {order} entregue.' + chr10 + 'Código de entrega: não confirmado.' + chr10 + chr10 + 'Obrigado por escolher {store}!',
    delivered_check: chr10 + chr10 + 'Algo errado com este pedido? Envie-nos uma mensagem.',
    door_code_for: chr10 + chr10 + 'O código de entrega é *{code}* \u2014 dê-o a {name}, que o informará ao associado de entrega à porta, para sabermos que o pedido chegou às mãos certas.',
    door_code: chr10 + chr10 + 'O seu código de entrega é *{code}* — informe-o ao associado de entrega à porta, para sabermos que o seu pedido chegou às mãos certas.',

    cancel_sorry: 'Lamentamos {name} —',
    cancel_done: 'Pronto {name} —',
    cancel_by_outlet: '*{outlet}* cancelou o seu pedido',
    cancel_plain: 'O pedido {order} foi cancelado',
    cancel_with_reason: '{opening} {subject}: {reason}. Não foi cobrado nada.',
    cancel_no_reason: '{opening} {subject}. Não foi cobrado nada.',

    reason_sold_out: 'a cozinha ficou sem um dos itens',
    reason_too_busy: 'a cozinha está cheia demais para aceitar agora',
    reason_closing: 'a cozinha está a fechar por hoje',
    reason_customer: 'você pediu para cancelar',
    reason_undeliverable: 'não conseguimos chegar ao endereço',

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
  },

  zh: {
    welcome: '欢迎来到 {store}！👋',
    welcome_back: '{name}，欢迎回到 {store}！👋',
    how_can_we_help: '今天需要什么服务？',
    reply_with_number: '请回复数字。',

    service_grocery: '超市代购',
    service_restaurant: '餐厅订餐',
    service_parcel: '包裹递送',
    service_other: '其他',

    confirmed: '谢谢{name}，订单 {order} 已确认。出发时我们会通知您。',
    on_the_way: '{name}，您的订单 {order} 已出发 🛵\n共计 {total}，请付给配送专员。',
    delivered: '订单 {order} 已送达。感谢您选择 {store}！',
    pin_elsewhere: '现在不在那里？发送前请拖动地图，或搜索该地点。',
    returned_to_sender: '包裹 {order} 正在退回给您 — {name} 无法签收。配送专员会将其送回取件地点。费用已用于本次行程，故不予退还。',
    delivered_confirmed: '订单 {order} 已送达。' + chr10 + '收货码：已确认。' + chr10 + chr10 + '感谢您选择 {store}！',
    delivered_unverified: '订单 {order} 已送达。' + chr10 + '收货码：未确认。' + chr10 + chr10 + '感谢您选择 {store}！',
    delivered_check: chr10 + chr10 + '这笔订单有任何问题吗？请给我们发消息。',
    door_code_for: chr10 + chr10 + '收货码是 *{code}* — 请转告 {name}，在门口告知配送专员，以确认订单送到正确的人手中。',
    door_code: chr10 + chr10 + '您的收货码是 *{code}* — 配送专员到达时请告知对方，以确认订单送到正确的人手中。',

    cancel_sorry: '很抱歉{name}，',
    cancel_done: '好的{name}，',
    cancel_by_outlet: '*{outlet}* 取消了您的订单',
    cancel_plain: '订单 {order} 已取消',
    cancel_with_reason: '{opening}{subject}：{reason}。未收取任何费用。',
    cancel_no_reason: '{opening}{subject}。未收取任何费用。',

    reason_sold_out: '厨房的某样食材已用完',
    reason_too_busy: '厨房太忙，暂时无法接单',
    reason_closing: '厨房今天即将打烊',
    reason_customer: '您要求取消',
    reason_undeliverable: '我们无法到达该地址',

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

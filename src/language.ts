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
      '{name}, su pedido {order} va en camino 🛵\nTotal {total}, a pagar al repartidor.',
    delivered: 'Pedido {order} entregado. ¡Gracias por elegir {store}!',

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
      '{name}, o seu pedido {order} está a caminho 🛵\nTotal {total}, a pagar ao entregador.',
    delivered: 'Pedido {order} entregue. Obrigado por escolher {store}!',

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
    on_the_way: '{name}，您的订单 {order} 已出发 🛵\n共计 {total}，请付给配送员。',
    delivered: '订单 {order} 已送达。感谢您选择 {store}！',

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

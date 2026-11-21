import {
  runAgent,
  friendlyErrorMessage,
  sanitizeGreeting,
  SESSION_TTL_MS as CONVERSATION_TTL_MS,
} from './agent/run.ts';
import { detectLanguage, t } from './language.ts';
import { languageFor } from './services.ts';
import {
  isStaff,
  isDriver,
  handleStaffMessage,
  handleDriverMessage,
  handleOutletMessage,
} from './staff.ts';
import * as repo from './db/repo.ts';
import { config } from './config.ts';
import {
  checkRange,
  formatCoordinates,
  formatDistance,
  locationNote,
  type LocationPin,
} from './location.ts';
import {
  parseServiceChoice,
  serviceMenuReply,
  serviceOpening,
  wantsServiceMenu,
} from './services.ts';
import { findZone } from './zones.ts';
import { destAnswerFromButtonId } from './order-status.ts';
import { settleDeliveryPlace } from './delivery-place.ts';
import {
  GATE_CANCEL,
  GATE_CHANGE,
  askPlace,
  endCheckout,
  isCheckoutId,
  isGateId,
  nextAfter,
  priceGate,
  placeTheOrder,
} from './delivery-checkout.ts';
import {
  languageScreen,
  readLanguageId,
  readTypedLanguage,
  shouldAskLanguage,
  wantsLanguageScreen,
} from './language-choice.ts';
import { tellDriverOfNewDestination, tellDriverDestKept } from './dispatch.ts';
import { money } from './config.ts';
import {
  handleDropPick,
  readPick,
  describeTap,
  endPicker,
  handlePick,
  isPickerId,
  nextStep,
  pickerAvailable,
  spotAsk,
} from './place-picker.ts';
import type { IncomingMessage, OutboundMessage } from './channels/types.ts';

/**
 * Saves a shared pin and returns the note the agent reads in place of the
 * message, since a WhatsApp location carries no words of its own.
 *
 * Saving happens here rather than in a tool the model calls. The coordinates
 * arrive as structured data; routing them through a language model only
 * introduces the chance of a digit changing, and a digit in the fifth decimal
 * place is a different street.
 */
export function recordLocationPin(phone: string, pin: LocationPin): string {
  const saved = repo.saveLocationPin(phone, pin);
  // Saved either way, even when it falls outside the delivery area: it is still
  // where the customer is, staff may decide to make the trip, and a pin the
  // shop threw away is one the customer has to send again.
  const range = checkRange(saved, config.store.serviceArea);
  const how =
    range.state === 'unchecked' ? '' : ` — ${formatDistance(range.distanceKm)} away, ${range.state}`;
  console.log(
    `[location] ${phone} pinned ${formatCoordinates(saved)}${saved.label ? ` (${saved.label})` : ''}${how}`,
  );
  return locationNote(saved, range);
}

/**
 * Files a pin into the parcel being arranged, rather than onto the customer.
 *
 * Pickup first, destination second, which is the order a person describes a
 * journey in. The slot it filled is named back to the agent so it can read it
 * aloud — a parcel sent back where it came from because two pins were swapped
 * is a wasted trip nobody notices until the delivery associate arrives.
 */
export function recordParcelPin(phone: string, pin: LocationPin): string {
  const slot = repo.addParcelPin(phone, pin);
  const draft = repo.getParcelDraft(phone);

  console.log(`[parcel] ${phone} pinned ${slot} ${formatCoordinates(pin)}`);

  const which = slot === 'pickup' ? 'uplift point' : 'destination';
  const label = pin.label ? ` (${pin.label})` : '';
  const stillNeeded =
    draft.pickup && draft.destination
      ? 'Both pins are now on file.'
      : 'Still need the other one — ask for it with request_location.';

  return `[The customer shared a location pin. Saved as the parcel's ${which}${label}. ${stillNeeded} Read back which one you took it as, so a mix-up is caught now rather than by the delivery associate.]`;
}

/**
 * What a sent message looks like in the log.
 *
 * A map card and a "Send location" button have no prose of their own, so
 * logging `text` alone would record them as blank lines — and the message log
 * is how anyone later reconstructs what a customer was actually shown.
 */
function outboundLogBody(msg: OutboundMessage): string {
  if (msg.kind === 'location') {
    return `[pin sent] ${formatCoordinates(msg.pin)}${msg.text ? ` — ${msg.text}` : ''}`;
  }
  if (msg.kind === 'location_request') return `[send-location button] ${msg.text}`;
  if (msg.kind === 'list') return `[list: ${msg.button}] ${msg.text}`;
  return msg.text;
}

/**
 * Sends what the SHOP answered, and writes it into the agent's account.
 *
 * The second half is the point. A picker tap is answered here and returns
 * before the agent is ever called, so without this the agent's history skips
 * every one of those turns — and on the next turn it opens an empty
 * conversation, says good evening, and offers to settle a pickup the
 * passenger chose four taps ago. It is not confused; it is answering from
 * the only account it has.
 *
 * `said` is what the passenger actually saw themselves tap, not the row id:
 * "Zeelugt", not "pick:to:place:Zeelugt".
 */
/**
 * The passenger's answer to a destination their driver raised.
 *
 * Read off the button id, not its words: the titles are written in whichever
 * language they use, and "Acknowledged" in Portuguese is not a string this
 * file should be matching on.
 */
function destAnswer(text: string): { ok: boolean; said: string } | null {
  const tapped = destAnswerFromButtonId(text);
  if (!tapped) return null;
  return { ok: tapped.ok, said: tapped.ok ? 'Acknowledged' : 'No, as booked' };
}

const chr10 = String.fromCharCode(10);

function shopAnswered(
  msg: IncomingMessage,
  outbound: OutboundMessage[],
  said: string,
): OutboundMessage[] {
  for (const out of outbound) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
  repo.rememberExchange(msg.phone, said, outbound.map(outboundLogBody).join(chr10));
  return outbound;
}

/** Serialises per-customer work so two fast messages can't race on the same cart. */
const inFlight = new Map<string, Promise<OutboundMessage[]>>();

/**
 * The single entry point every channel shares: log the inbound message, run the
 * agent, log what goes back. Never throws — failures become a customer-safe reply.
 */
export function handleIncoming(msg: IncomingMessage): Promise<OutboundMessage[]> {
  const previous = inFlight.get(msg.phone) ?? Promise.resolve<OutboundMessage[]>([]);
  const next = previous.catch(() => []).then(() => processMessage(msg));
  inFlight.set(msg.phone, next);
  void next.finally(() => {
    if (inFlight.get(msg.phone) === next) inFlight.delete(msg.phone);
  });
  return next;
}

async function processMessage(msg: IncomingMessage): Promise<OutboundMessage[]> {
  const logBody = msg.location
    ? `[pin] ${formatCoordinates(msg.location)}${msg.location.label ? ` ${msg.location.label}` : ''}`
    : msg.image
      ? `[photo] ${msg.text}`
      : msg.text;
  repo.logMessage(msg.phone, 'in', msg.channel, logBody);

  // What language this customer writes in, noticed from what they wrote.
  //
  // Only ever set, never cleared: "ok" and a thumbs up give nothing away,
  // and a one-word reply must not reset somebody who has been writing
  // Portuguese all along. Done before anything replies, so even the welcome
  // comes back in their language.
  const spoken = detectLanguage(msg.text);
  if (spoken && repo.customerLanguage(msg.phone) !== spoken) {
    repo.getCustomer(msg.phone);
    repo.setCustomerLanguage(msg.phone, spoken);
  }

  // Staff, delivery associates and kitchens all share the shop number, and none of them get
  // the shopping agent — a dispatcher clearing twenty orders wants the same
  // words to do the same thing every time, instantly and at no cost per message.
  //
  // Checked in this order on purpose. Staff first, so someone who is both staff
  // and a delivery associate keeps the full queue; then delivery associates; then outlets, which are
  // recognised by their own number rather than by configuration.
  const operator = isStaff(msg.phone)
    ? // Staff get the image and the pin too. A photo from a staff number is a
      // menu being onboarded, and a pin is where a delivery associate collects — neither has
      // any meaning in the dispatch queue, so there is nothing to disambiguate.
      () => handleStaffMessage(msg.text, msg.phone, msg.image, msg.location)
    : isDriver(msg.phone)
      ? () => handleDriverMessage(msg.text, msg.phone, msg.location)
      : (() => {
          const outlet = repo.outletByWhatsapp(msg.phone);
          return outlet ? () => handleOutletMessage(outlet, msg.text) : null;
        })();

  if (operator) {
    const operatorReply = await operator();
    for (const out of operatorReply) {
      repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    }
    return operatorReply;
  }

  // Record the WhatsApp profile name, but do not treat it as the customer's
  // name. It is frequently a nickname, a business, or the relative whose phone
  // this is — and deliveries go to a person.
  if (msg.profileName) repo.setProfileName(msg.phone, msg.profileName);

  let text = msg.text.trim();

  /* ------------------------------------------------------------ language */

  // Before everything. A customer who cannot read the question cannot answer
  // it, so the first screen is the same three greetings in three languages
  // and three buttons — and until one is tapped there is nothing else worth
  // sending them, the service menu least of all.
  {
    const tapped = readLanguageId(text);
    if (tapped) {
      repo.chooseLanguage(msg.phone, tapped);
      // Straight on to the menu, in what they just picked. The tap is an
      // answer, not a conversation, so nothing goes to the model.
      return shopAnswered(msg, serviceMenuReply(msg.phone), text);
    }

    const asked = shouldAskLanguage(
      repo.languageChosen(msg.phone),
      repo.inboundCount(msg.phone),
      repo.recentOrders(msg.phone, 1).length,
      repo.languageAsked(msg.phone),
    );

    // Written rather than tapped, and only while the question is open: the
    // screen comes back until it is answered, so a customer whose WhatsApp
    // will not draw buttons has to have some way to answer it in words.
    const written = asked ? readTypedLanguage(text) : null;
    if (written) {
      repo.chooseLanguage(msg.phone, written);
      return shopAnswered(msg, serviceMenuReply(msg.phone), text);
    }

    // Asking for it back by name, which is the way out for somebody who
    // tapped the wrong one and cannot read a word of what came next.
    if (asked || wantsLanguageScreen(text)) {
      // Written down the first time, which is what lets it be asked again
      // without the question ever starting for a customer of long standing.
      repo.markLanguageAsked(msg.phone);
      return shopAnswered(msg, [languageScreen(config.store.name)], text);
    }
  }

  // Small operator escape hatch, useful during testing and when a customer is stuck.
  if (/^(reset|restart|start over)$/i.test(text)) {
    repo.resetConversation(msg.phone);
    repo.clearCart(msg.phone);
    repo.setService(msg.phone, null);
    repo.setBrowsingOutlet(msg.phone, null);
    repo.clearTaxiPicks(msg.phone);
    const reply = serviceMenuReply(msg.phone);
    for (const out of reply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    return reply;
  }

  /* -------------------------------------------------------------- ratings */

  // Before the service menu and before the model, because a rating is a bare
  // digit and this shop is full of bare digits: "4" is the fourth aisle, the
  // fourth kitchen, the fourth item on a list. It is four stars only in the
  // short window after the shop has asked, and only when the message is
  // nothing else - `readStars` refuses "4 bags of rice", which is an order.
  //
  // Nothing here goes near the agent. A rating is two fixed messages and a
  // row in a table; handing it to a language model would make it slower, cost
  // money per star, and put the one number the shop will be judged on behind
  // an instruction that can be ignored.
  {
    const { readStars, thanksForStars, tellStaffOfPoorRating, RATING_TTL_MS, RATING_DIGIT_TTL_MS, POOR } =
      await import('./ratings.ts');

    const pending = repo.pendingRating(msg.phone, RATING_TTL_MS);
    const tapped = /^⭐+$/u.test(text.trim());
    const asked = pending ? Date.now() - new Date(pending.askedAt).getTime() : 0;
    // A tap counts for the whole window; a digit only while the question is
    // still obviously the last thing that happened.
    const stars = pending && (tapped || asked <= RATING_DIGIT_TTL_MS) ? readStars(text) : 0;
    if (pending && stars > 0) {
      repo.saveStars(pending.orderNo, stars);
      const out: OutboundMessage[] = [{ kind: 'text', text: thanksForStars(stars) }];
      // A good one ends here. Nobody is interviewed about a delivery that
      // went well, and the row is closed so the next message they send is
      // read as whatever it actually is.
      if (stars > POOR) repo.saveRatingComment(pending.orderNo, '');
      else void tellStaffOfPoorRating(pending.orderNo);
      for (const o of out) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(o));
      return out;
    }

    // The words after a poor one. Whatever they write next is the complaint,
    // and it is taken whole rather than parsed - somebody describing what
    // went wrong is not choosing from a menu.
    const owed = repo.awaitingComment(msg.phone, RATING_TTL_MS);
    if (owed && owed.stars <= POOR && text && !msg.image && !msg.location) {
      repo.saveRatingComment(owed.orderNo, text);
      void tellStaffOfPoorRating(owed.orderNo);
      const said: OutboundMessage[] = [
        {
          kind: 'text',
          text:
            config.staffNumbers.length > 0
              ? 'Thank you — that has gone to the manager, who will come back to you on this number.'
              : 'Thank you — that is written down for the shop.',
        },
      ];
      for (const o of said) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(o));
      return said;
    }

    // Asked, and answered with something that is not a rating. The question
    // is let go rather than kept in the way: somebody who replies "where is
    // my change" wants an answer, not another star prompt, and leaving the
    // row open would read their next digit as a rating.
    if (pending && stars === 0 && text && !tapped) repo.closeRatingUnanswered(pending.orderNo);
  }

  /* ------------------------------------------------------- service choice */

  // Every conversation opens with a welcome and the four services, and nothing
  // else happens until one is picked. Answered here rather than by the model:
  // fixed text needs no language model, arrives instantly, costs nothing per
  // message, and reads the same way to every customer every time.
  // A choice belongs to a conversation, not to the customer. When the last one
  // went cold the next message is a new visit, so it opens with the welcome
  // again — matching the agent's own session window, or the two would disagree
  // about whether this is a fresh conversation.
  const lastTurn = repo.loadHistory(msg.phone).updatedAt;
  if (lastTurn && Date.now() - new Date(lastTurn).getTime() > CONVERSATION_TTL_MS) {
    repo.setService(msg.phone, null);
    repo.setBrowsingOutlet(msg.phone, null);
  }

  const chosen = repo.getService(msg.phone);

  if (chosen && wantsServiceMenu(text)) {
    repo.setService(msg.phone, null);
    repo.setBrowsingOutlet(msg.phone, null);
    repo.clearTaxiPicks(msg.phone);
    const reply = serviceMenuReply(msg.phone);
    for (const out of reply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    return reply;
  }

  if (!chosen) {
    const picked = parseServiceChoice(text);
    if (!picked) {
      // Includes the case where their very first message is a photo, a voice
      // note or a pin. Those are not a service choice, and guessing one from a
      // picture would start the wrong job.
      const reply = serviceMenuReply(msg.phone);
      if (msg.image || msg.location || !text) {
        reply.push({
          kind: 'text',
          text: 'Pick a number first and then send that again — I’ll read it properly once I know which service you want.',
        });
      }
      for (const out of reply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      return reply;
    }

    repo.setService(msg.phone, picked);
    // The conversation starts here, not at the menu: the agent's first turn
    // should be the service opening, with none of the menu in its history.
    repo.resetConversation(msg.phone);

    const lang = languageFor(msg.phone);

    // A taxi opens with the place picker rather than a question in words.
    // The shorter opening goes with it: the long one asks for both ends and
    // the time at once, which reads as a demand when the next message is a
    // list answering the first half of it.
    //
    // Only when there is a tariff to pick from. A shop running on the flat
    // fee has no places to list, and an empty picker is worse than the
    // question it replaced.
    const reply: OutboundMessage[] =
      picked === 'taxi' && pickerAvailable()
        ? [
            { kind: 'text', text: t('opening_taxi_picked', lang) },
            endPicker(msg.phone, 'from', lang),
          ]
        : [{ kind: 'text', text: serviceOpening(picked, lang) }];

    // Last trip's ends must never start this one.
    if (picked === 'taxi') repo.clearTaxiPicks(msg.phone);
    return shopAnswered(msg, reply, text);
  }

  /* ------------------------------ a destination the driver has raised */

  // Settled here, before the agent and before the picker, because it is the
  // fare gate doing its job: the passenger was shown two figures and these
  // are the two answers. Nothing on the trip moved when the driver raised
  // it; this is where it moves, or does not.
  if (destAnswer(text)) {
    const answer = destAnswer(text)!;
    const open = repo.openProposalFor(msg.phone);
    const lang = languageFor(msg.phone);

    if (!open) {
      // Tapped twice, or tapped after it was settled some other way. Say so
      // rather than acting on a proposal that is no longer there.
      return shopAnswered(msg, [{ kind: 'text', text: t('dest_gone', lang) }], answer.said);
    }

    const order = repo.findOrder(open.orderNo);
    if (answer.ok) {
      repo.changeTaxiDestination(open.orderNo, open.place, open.fare > 0 ? open.fare : 0);
      repo.clearDestProposal(open.orderNo);
      void tellDriverOfNewDestination(open.orderNo).catch((err) =>
        console.error('[taxi] could not tell the driver the change was agreed:', err),
      );
      return shopAnswered(
        msg,
        [
          {
            kind: 'text',
            text: t('dest_changed', lang, {
              place: open.place,
              fare: open.fare > 0 ? money(open.fare) : t('taxi_fare_with_driver', lang),
            }),
          },
        ],
        answer.said,
      );
    }

    repo.clearDestProposal(open.orderNo);
    void tellDriverDestKept(open.orderNo).catch((err: unknown) =>
      console.error('[taxi] could not tell the driver the change was refused:', err),
    );
    return shopAnswered(
      msg,
      [
        {
          kind: 'text',
          text: t('dest_kept', lang, {
            place: order?.address || 'where you were going',
            fare: order && order.quotedFare > 0
              ? money(order.quotedFare)
              : t('taxi_fare_with_driver', lang),
          }),
        },
      ],
      answer.said,
    );
  }

  /* --------------------------------------------------- taxi place picker */

  // An end the passenger was asked to TYPE, answered.
  //
  // Read BEFORE the tapped rows below, and only for text that is not a tap.
  // Tapping "Type the name" is what sets the marker, and its own reply is a
  // note to the agent — so running this first, on a tap, would have the
  // shop swallow its own instructions as the address.
  //
  // Taken whatever it says, because they were asked for it: "Lot 5 Public
  // Road" is a perfectly good pickup and the tariff has never heard of it.
  // A name the tariff does know is stored as the tariff spells it, so the
  // trip prices; anything else is stored as written, and the driver agrees
  // the fare in the car. Either way the exact spot is offered next, which is
  // the whole point of taking an address the shop cannot price.
  // Neither of the two blocks below may run while a taxi is already on the
  // road. book_taxi clears the picker when it books, so a passenger saying
  // "actually, Buxton" looks identical to one starting a fresh trip — and
  // Buxton was taken as the PICKUP of a booking that did not exist, asked
  // for its exact spot, and then asked where they were going. They had
  // already said. They were changing it, which is change_destination's job
  // and therefore the agent's.
  const onTheRoad = chosen === 'taxi' ? repo.liveTaxi(msg.phone) : null;

  if (chosen === 'taxi' && !onTheRoad && text && !msg.location && !isPickerId(text)) {
    const typing = repo.typingEnd(msg.phone);
    if (typing) {
      const lang = languageFor(msg.phone);
      const said = text.trim().slice(0, 160);
      const found = findZone(said);
      const place = found.kind === 'found' ? found.match.place : said;

      repo.setTypingEnd(msg.phone, '');
      repo.setTaxiPick(msg.phone, typing, place);
      return shopAnswered(msg, [spotAsk(typing, place, lang)], said);
    }
  }



  // A tapped row, read here rather than by the model. The id carries a
  // corridor and a page, which no 24-character title could, and the places
  // themselves come straight out of the tariff — so there is nothing for a
  // language model to add except the chance of a different village coming
  // back. Only a finished choice reaches the agent, as a note.
  /* ----------------------------------------- the shop's own checkout */

  // A fixed sequence, run here rather than by the model: the place, the pin,
  // the street if there was no pin, anything for the door, a name if the
  // shop has none, and the price with its three answers. Every one of those
  // is a question with a right answer and no judgement in it.
  //
  // Before the delivery list below, because a tapped row means something
  // more here than it does on its own: it is one step of six, and the step
  // after it is decided by this block.
  {
    const step = repo.checkoutStep(msg.phone);
    if (step) {
      const lang = languageFor(msg.phone);
      const ask = (out: OutboundMessage, said: string): OutboundMessage[] =>
        shopAnswered(msg, [out], said);

      // The price, answered.
      if (isGateId(text)) {
        if (text === GATE_CANCEL) {
          endCheckout(msg.phone);
          return shopAnswered(msg, [{ kind: 'text', text: t('checkout_cancelled', lang) }], text);
        }
        if (text === GATE_CHANGE) {
          // The address only. The basket has not changed and asking about it
          // again would be the shop wasting their time over a figure they
          // did not like.
          return ask(askPlace(msg.phone, lang), describeTap(text));
        }
        const placed = await placeTheOrder(msg.phone, lang);
        return shopAnswered(msg, placed, text);
      }

      // A row off the list of places.
      if (isPickerId(text)) {
        const tapped = readPick(text);
        const result = handleDropPick(msg.phone, text, lang);

        if (tapped?.kind === 'place' && result?.kind === 'reply') {
          repo.setCheckoutStep(msg.phone, 'pin');
          return shopAnswered(msg, result.outbound, describeTap(text));
        }
        if (tapped?.kind === 'skip') {
          return ask(nextAfter(msg.phone, 'skip', lang), describeTap(text));
        }
        if (result?.kind === 'reply') {
          return shopAnswered(msg, result.outbound, describeTap(text));
        }
        if (result?.kind === 'menu') {
          endCheckout(msg.phone);
          repo.setService(msg.phone, null);
          const menu = serviceMenuReply(msg.phone);
          for (const out of menu) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
          return menu;
        }
        // Type the address: out of the list, still in checkout.
        repo.setCheckoutStep(msg.phone, 'place');
        return shopAnswered(msg, [{ kind: 'text', text: t('pick_type_hint', lang) }], describeTap(text));
      }

      // The exact spot, arriving. Saved HERE, because this block runs
      // before the one that ordinarily saves a pin - and a checkout that
      // moved on without writing it down reached the gate with nothing for
      // the associate to steer by, which place_order rightly refuses.
      if (msg.location && step === 'pin') {
        // A parcel's pin is the RECIPIENT's door, not the customer's. Saving
        // it against the customer would quietly move where next week's
        // groceries go, which is the fault this split exists to prevent.
        if (chosen === 'parcel') repo.addParcelPin(msg.phone, msg.location, 'destination');
        else recordLocationPin(msg.phone, msg.location);
        return ask(nextAfter(msg.phone, 'pin', lang), '(sent their location)');
      }

      // A tap that has arrived at the wrong step - a button from a message
      // further back, or one sent before the step moved on. It must never
      // be WRITTEN DOWN as an answer: without this, `drop:note:none`
      // landing while the street was being asked for became somebody's
      // address, and the associate was sent to a button id.
      const ourId = isPickerId(text) || isCheckoutId(text);
      if (ourId) return ask(nextAfter(msg.phone, 'name', lang), describeTap(text));

      if (text) {
        // Typed instead of tapped, which the list always offers.
        if (step === 'place') {
          const settled = settleDeliveryPlace(msg.phone, text);
          if (settled) {
            repo.setCheckoutStep(msg.phone, 'pin');
            return ask(
              spotAsk('drop', settled.place, lang, money(settled.fee)),
              text,
            );
          }
          // Not a place the tariff carries. The list again, rather than a
          // third round of asking in words.
          return ask(askPlace(msg.phone, lang), text);
        }
        if (step === 'street') {
          const written = text.slice(0, 160);
          if (chosen === 'parcel') {
            repo.saveParcelParty(msg.phone, 'recipient', { address: written });
          } else {
            repo.saveCustomer(msg.phone, { address: written });
          }
          return ask(nextAfter(msg.phone, 'street', lang), text);
        }
        // Typed where the pin was offered: that is the doorstep note, and
        // it goes down as one. The three answers to that message are a pin,
        // Skip, or words - asking for the words separately was a fourth
        // question between a village and a price.
        if (step === 'pin' || step === 'note') {
          repo.setCheckoutNote(msg.phone, text);
          return ask(nextAfter(msg.phone, 'note', lang), text);
        }
        if (step === 'name') {
          repo.saveCustomer(msg.phone, { name: text.slice(0, 60) });
          return ask(nextAfter(msg.phone, 'name', lang), text);
        }
        // Words while the price is on the screen. The question stands, so
        // it is put again rather than handed to the agent - which is where
        // it used to go, and the agent has no idea an order is waiting on
        // a tap.
        if (step === 'gate') {
          return ask(priceGate(msg.phone, lang), text);
        }
      }
    }
  }

  // The delivery list, which is the same list asked by a different service.
  // Read here for the same reason the taxi's is: the id carries a corridor
  // and a page, the places come straight out of the tariff, and there is
  // nothing for a model to add except the chance of a different village.
  if (chosen && chosen !== 'taxi' && isPickerId(text)) {
    const lang = languageFor(msg.phone);
    const result = handleDropPick(msg.phone, text, lang);

    if (result?.kind === 'reply') return shopAnswered(msg, result.outbound, describeTap(text));

    if (result?.kind === 'menu') {
      repo.setService(msg.phone, null);
      repo.setBrowsingOutlet(msg.phone, null);
      repo.resetConversation(msg.phone);
      const menu = serviceMenuReply(msg.phone);
      for (const out of menu) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      return menu;
    }

    // Settled, or handed back: the agent is told what happened in place of
    // the row id, which would mean nothing to it.
    if (result?.kind === 'note') text = result.note;
  }

  if (chosen === 'taxi' && isPickerId(text)) {
    const lang = languageFor(msg.phone);
    const result = handlePick(msg.phone, text, lang);

    if (result?.kind === 'reply') {
      return shopAnswered(msg, result.outbound, describeTap(text));
    }

    // Straight back to the front door, from any screen of the picker.
    if (result?.kind === 'menu') {
      repo.setService(msg.phone, null);
      repo.setBrowsingOutlet(msg.phone, null);
      repo.resetConversation(msg.phone);
      const menu = serviceMenuReply(msg.phone);
      for (const out of menu) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      return menu;
    }

    // Called off at the fare. The service goes with it, so the next message
    // is read as a fresh visit rather than as more of a trip that is not
    // happening.
    if (result?.kind === 'cancelled') {
      repo.setService(msg.phone, null);
      repo.resetConversation(msg.phone);
      for (const out of result.outbound) {
        repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      }
      return result.outbound;
    }

    if (result?.kind === 'note') {
      text = result.note;
    } else {
      // An id this build cannot read: a tap on a list sent before a deploy,
      // or one that arrived mangled. Start that end again rather than
      // guessing at a place — a car sent to the wrong village is a worse
      // answer than one more question.
      return shopAnswered(msg, [endPicker(msg.phone, 'from', lang)], describeTap(text));
    }
  }

  // A TYPED place answers the same question a tapped one does.
  //
  // Only a tap settled an end, so typing "Meadow Bank" went to the agent
  // instead — and with it went everything the tap would have brought: the
  // offer of the exact spot for the driver, the line telling the agent what
  // was chosen, and the stored place book_taxi falls back on. Somebody who
  // typed their destination was never asked for its pin, and nor was
  // somebody who typed their pickup.
  //
  // Guarded three ways, because this intercepts free text. Only while an end
  // is still missing — once both are known, "2 of us" is an answer to a
  // different question and belongs to the agent. Only a short message, which
  // is what an answer looks like. And only an unambiguous match, so a place
  // the tariff is unsure of is argued out in words rather than assumed.
  if (chosen === 'taxi' && !onTheRoad && pickerAvailable() && text && !msg.location) {
    const picks = repo.taxiPicks(msg.phone);
    const missing: 'from' | 'to' | null = !picks.from ? 'from' : !picks.to ? 'to' : null;
    const said = text.trim();

    if (missing && said.length <= 40) {
      const found = findZone(said);
      if (found.kind === 'found') {
        const lang = languageFor(msg.phone);
        repo.setTaxiPick(msg.phone, missing, found.match.place);
        return shopAnswered(msg, [spotAsk(missing, found.match.place, lang)], said);
      }
    }
  }

  // A pin is saved the moment it arrives, and the agent is handed a note about
  // it rather than the customer's (nonexistent) words.
  //
  // After the service choice rather than before, because where a pin belongs
  // depends on which service this is: in parcel delivery it is somebody else's
  // doorstep, and letting it overwrite the customer's saved address would
  // quietly redirect next week's groceries to wherever they last sent a package.
  if (msg.location) {
    // A TAXI's pin refines an end; it never settles one.
    //
    // The place was chosen by name and has already priced the trip, so what
    // arrives here is the exact spot the driver should stop at. Which end it
    // belongs to is whichever one was just settled: the pickup while the
    // destination is still unknown, the destination once both are.
    //
    // Handled before the others and on its own, because a taxi's pin must not
    // also become the customer's saved home address — where somebody is
    // standing today is not where they live.
    if (chosen === 'taxi') {
      const lang = languageFor(msg.phone);
      const picks = repo.taxiPicks(msg.phone);
      const slot: 'pickup' | 'destination' = picks.from && !picks.to ? 'pickup' : 'destination';
      repo.addParcelPin(msg.phone, msg.location, slot);
      console.log(`[taxi] ${msg.phone} pinned ${slot} ${formatCoordinates(msg.location)}`);

      const onward: OutboundMessage[] = [{ kind: 'text', text: t('spot_saved', lang) }];
      const step = nextStep(msg.phone, lang);
      if (step.kind === 'reply') {
        onward.push(...step.outbound);
        return shopAnswered(msg, onward, '(sent their location)');
      }
      for (const out of onward) {
        repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      }

      // Both ends settled and priced: the acknowledgement goes now, and the
      // agent takes the note from here.
      text = step.note;
      const said = onward.slice(0, 1);
      const rest = await (async () => {
        try {
          return (await runAgent(msg.phone, text, msg.image)).outbound;
        } catch (err) {
          return [{ kind: 'text', text: friendlyErrorMessage(err) } as OutboundMessage];
        }
      })();
      for (const out of rest) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      return [...said, ...rest];
    }

    const note =
      chosen === 'parcel'
        ? recordParcelPin(msg.phone, msg.location)
        : recordLocationPin(msg.phone, msg.location);
    text = text ? `${note}

${text}` : note;
  }

  // Read BEFORE the agent runs, because running it writes the turn and would
  // make every conversation look as though it were already going.
  const underway = repo.loadHistory(msg.phone).history.length > 0;

  let outbound: OutboundMessage[];
  try {
    const result = await runAgent(msg.phone, text, msg.image);
    // The agent is asked not to greet a conversation already under way. This
    // is the guard behind the asking: it greeted anyway, six taps into a
    // booking, and good evening is not a thing you say to somebody you have
    // been talking to for five minutes.
    outbound = result.outbound.map((out) =>
      out.kind === 'text' ? { ...out, text: sanitizeGreeting(out.text, underway) } : out,
    );
  } catch (err) {
    outbound = [{ kind: 'text', text: friendlyErrorMessage(err) }];
  }

  for (const out of outbound) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
  return outbound;
}

import { runAgent, friendlyErrorMessage, SESSION_TTL_MS as CONVERSATION_TTL_MS } from './agent/run.ts';
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
import { endPicker, handlePick, isPickerId, nextStep, pickerAvailable } from './place-picker.ts';
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
    for (const out of reply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    return reply;
  }

  /* --------------------------------------------------- taxi place picker */

  // A tapped row, read here rather than by the model. The id carries a
  // corridor and a page, which no 24-character title could, and the places
  // themselves come straight out of the tariff — so there is nothing for a
  // language model to add except the chance of a different village coming
  // back. Only a finished choice reaches the agent, as a note.
  if (chosen === 'taxi' && isPickerId(text)) {
    const lang = languageFor(msg.phone);
    const result = handlePick(msg.phone, text, lang);

    if (result?.kind === 'reply') {
      for (const out of result.outbound) {
        repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      }
      return result.outbound;
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
      const again = [endPicker(msg.phone, 'from', lang)];
      for (const out of again) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      return again;
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
      if (step.kind === 'reply') onward.push(...step.outbound);
      for (const out of onward) {
        repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
      }
      if (step.kind === 'reply') return onward;

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

  let outbound: OutboundMessage[];
  try {
    const result = await runAgent(msg.phone, text, msg.image);
    outbound = result.outbound;
  } catch (err) {
    outbound = [{ kind: 'text', text: friendlyErrorMessage(err) }];
  }

  for (const out of outbound) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
  return outbound;
}

import { runAgent, friendlyErrorMessage, SESSION_TTL_MS as CONVERSATION_TTL_MS } from './agent/run.ts';
import { detectLanguage } from './language.ts';
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
import { tellAssociatePinArrived } from './dispatch.ts';
import {
  parseServiceChoice,
  serviceMenuReply,
  serviceOpening,
  wantsServiceMenu,
} from './services.ts';
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

  // A pin that answers an order already out on the road.
  //
  // Written onto the order, not just onto the customer: the order carries its
  // own copy of where it is going so that a later change of address cannot
  // move a delivery that already happened - which means a pin saved only on
  // the customer would never reach the associate holding the bag.
  //
  // Oldest first, and only one. Two pin-less orders at once is rare and the
  // customer has just sent one pin, not two; guessing that it answers both
  // would silently send a second delivery to an address nobody confirmed.
  const waiting = repo.ordersAwaitingPin(phone);
  const answered = waiting[0];
  let attached = '';
  if (answered && repo.attachPinToOrder(answered.orderNo, saved)) {
    void tellAssociatePinArrived(answered.orderNo).catch((err) =>
      console.error('[location] could not pass the pin on:', err),
    );
    attached =
      waiting.length > 1
        ? ` Put on ${answered.orderNo}, the oldest of ${waiting.length} orders of theirs with no pin — say which one you have taken it as, and ask about the others.`
        : ` Put on ${answered.orderNo}, which went out without one. The delivery associate has been sent it.`;
  }

  return locationNote(saved, range) + attached;
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
    const reply = serviceMenuReply(msg.phone);
    for (const out of reply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    return reply;
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

    const reply: OutboundMessage[] = [
      { kind: 'text', text: serviceOpening(picked, languageFor(msg.phone)) },
    ];
    for (const out of reply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    return reply;
  }

  // A pin is saved the moment it arrives, and the agent is handed a note about
  // it rather than the customer's (nonexistent) words.
  //
  // After the service choice rather than before, because where a pin belongs
  // depends on which service this is: in parcel delivery it is somebody else's
  // doorstep, and letting it overwrite the customer's saved address would
  // quietly redirect next week's groceries to wherever they last sent a package.
  if (msg.location) {
    const note =
      chosen === 'parcel'
        ? recordParcelPin(msg.phone, msg.location)
        : recordLocationPin(msg.phone, msg.location);
    text = text ? `${note}\n\n${text}` : note;
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

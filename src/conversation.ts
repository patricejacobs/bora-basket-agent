import { runAgent, friendlyErrorMessage } from './agent/run.ts';
import { isStaff, handleStaffMessage } from './staff.ts';
import * as repo from './db/repo.ts';
import { config } from './config.ts';
import {
  checkRange,
  formatCoordinates,
  formatDistance,
  locationNote,
  type LocationPin,
} from './location.ts';
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

  // Staff share the shop number but get the dispatch queue, not the shopping agent.
  if (isStaff(msg.phone)) {
    const staffReply = await handleStaffMessage(msg.text);
    for (const out of staffReply) repo.logMessage(msg.phone, 'out', msg.channel, outboundLogBody(out));
    return staffReply;
  }

  // Record the WhatsApp profile name, but do not treat it as the customer's
  // name. It is frequently a nickname, a business, or the relative whose phone
  // this is — and deliveries go to a person.
  if (msg.profileName) repo.setProfileName(msg.phone, msg.profileName);

  let text = msg.text.trim();

  // A pin is saved the moment it arrives, and the agent is handed a note about
  // it rather than the customer's (nonexistent) words. Done before the reset
  // check below, which only ever matches typed text.
  if (msg.location) {
    const note = recordLocationPin(msg.phone, msg.location);
    text = text ? `${note}\n\n${text}` : note;
  }

  // Small operator escape hatch, useful during testing and when a customer is stuck.
  if (/^(reset|restart|start over)$/i.test(text)) {
    repo.resetConversation(msg.phone);
    repo.clearCart(msg.phone);
    const reply: OutboundMessage[] = [
      { kind: 'text', text: "Fresh start — your cart is empty. What would you like to order?" },
    ];
    repo.logMessage(msg.phone, 'out', msg.channel, reply[0]!.text);
    return reply;
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

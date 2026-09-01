import { runAgent, friendlyErrorMessage } from './agent/run.ts';
import { isStaff, handleStaffMessage } from './staff.ts';
import * as repo from './db/repo.ts';
import type { IncomingMessage, OutboundMessage } from './channels/types.ts';

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
  repo.logMessage(msg.phone, 'in', msg.channel, msg.text);

  // Staff share the shop number but get the dispatch queue, not the shopping agent.
  if (isStaff(msg.phone)) {
    const staffReply = await handleStaffMessage(msg.text);
    for (const out of staffReply) repo.logMessage(msg.phone, 'out', msg.channel, out.text);
    return staffReply;
  }

  // Seed the delivery name from the WhatsApp profile so we don't ask for what we know.
  if (msg.profileName) {
    const existing = repo.getCustomer(msg.phone);
    if (!existing.name) repo.saveCustomer(msg.phone, { name: msg.profileName });
  }

  const text = msg.text.trim();

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
    const result = await runAgent(msg.phone, text);
    outbound = result.outbound;
  } catch (err) {
    outbound = [{ kind: 'text', text: friendlyErrorMessage(err) }];
  }

  for (const out of outbound) repo.logMessage(msg.phone, 'out', msg.channel, out.text);
  return outbound;
}

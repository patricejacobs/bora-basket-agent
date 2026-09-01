/**
 * Channel-neutral outbound message. The agent produces these; each channel
 * (WhatsApp, the browser simulator) decides how to render them.
 */
export type OutboundMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: { id: string; title: string }[] };

export type IncomingMessage = {
  /** E.164 digits without '+', e.g. "5926001234". The stable customer key. */
  phone: string;
  text: string;
  channel: 'whatsapp' | 'simulator';
  /** Display name from the channel, if it offers one. */
  profileName?: string;
};

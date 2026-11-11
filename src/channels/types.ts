import type { LocationPin } from '../location.ts';

/**
 * Channel-neutral outbound message. The agent produces these; each channel
 * (WhatsApp, the browser simulator) decides how to render them.
 */
export type OutboundMessage =
  | { kind: 'text'; text: string }
  | {
      kind: 'buttons';
      text: string;
      /**
       * `title` is what the person reads; `command` is what the tap means.
       *
       * They were the same thing until the titles had to carry an order number
       * to stay unambiguous, which spent most of WhatsApp's 20 characters on
       * bookkeeping. The order now rides in the button's id, which the person
       * never sees, so the title can be a plain word.
       */
      buttons: { id: string; title: string; command?: string }[];
    }
  /** A product photo. `text` is the caption shown beneath it. */
  | { kind: 'image'; text: string; imageUrl: string }
  /**
   * A prompt with WhatsApp's own "Send location" button. The customer taps it
   * and their phone shares a pin — far more reliable than asking in words and
   * hoping they find the paperclip menu.
   */
  | { kind: 'location_request'; text: string }
  /**
   * A pin we send out, for the delivery associate. Arrives in WhatsApp as a map card that
   * opens straight in their maps app. `text` is what a channel without map
   * support falls back to showing.
   */
  /**
   * A map card. WhatsApp allows it a name and an address and nothing else -
   * no body, no buttons - so anything that must be read or tapped travels in
   * its own message. `name` and `address` are what the card itself shows.
   */
  | { kind: 'location'; text: string; pin: LocationPin; name?: string; address?: string };

/** A photo the customer sent, already fetched and base64-encoded. */
export type IncomingImage = { base64: string; mediaType: string };

export type IncomingMessage = {
  /** E.164 digits without '+', e.g. "5926001234". The stable customer key. */
  phone: string;
  text: string;
  channel: 'whatsapp' | 'simulator';
  /** Display name from the channel, if it offers one. */
  profileName?: string;
  /** A photographed shopping list, if one came with the message. */
  image?: IncomingImage;
  /** A shared location pin, if the customer sent one instead of text. */
  location?: LocationPin;
};

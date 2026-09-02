/**
 * Fetching media a customer sent.
 *
 * WhatsApp does not put the image in the webhook — it sends an id, and the bytes
 * are collected in two authenticated steps: resolve the id to a short-lived URL,
 * then fetch that URL with the access token. Both need the token; the URL alone
 * is useless.
 */
import { config } from '../config.ts';

/** Formats Claude can read. WhatsApp photos are jpeg in practice. */
const READABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** WhatsApp voice notes are audio/ogg; codecs=opus. */
const HEARABLE = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/amr', 'audio/aac', 'audio/wav', 'audio/webm']);

/**
 * Beyond this we ask the customer to retake it rather than spend the tokens.
 * WhatsApp caps images at 5MB; base64 inflates by about a third on top.
 */
const MAX_BYTES = 4 * 1024 * 1024;

export type DownloadedMedia = { base64: string; mediaType: string };
/** Voice notes are handed to a transcription service as bytes, not base64. */
export type DownloadedBytes = { bytes: Buffer; mediaType: string };

export type MediaFailure =
  | 'not-configured'
  | 'lookup-failed'
  | 'unsupported-type'
  | 'too-large'
  | 'download-failed';

export type MediaResult =
  | { ok: true; media: DownloadedMedia }
  | { ok: false; reason: MediaFailure };

/** Fetches audio for transcription. Same two-step dance, different accept list. */
export async function downloadAudio(
  mediaId: string,
): Promise<{ ok: true; audio: DownloadedBytes } | { ok: false; reason: MediaFailure }> {
  const raw = await fetchMedia(mediaId, HEARABLE);
  if (!raw.ok) return raw;
  return { ok: true, audio: { bytes: raw.bytes, mediaType: raw.mediaType } };
}

export async function downloadMedia(mediaId: string): Promise<MediaResult> {
  const raw = await fetchMedia(mediaId, READABLE);
  if (!raw.ok) return raw;
  return {
    ok: true,
    media: { base64: raw.bytes.toString('base64'), mediaType: raw.mediaType },
  };
}

/**
 * The two authenticated steps every media fetch needs: resolve the id to a
 * short-lived URL, then fetch that URL. Both require the access token; the URL
 * alone is useless.
 */
async function fetchMedia(
  mediaId: string,
  accept: Set<string>,
): Promise<{ ok: true; bytes: Buffer; mediaType: string } | { ok: false; reason: MediaFailure }> {
  const { accessToken, graphVersion } = config.whatsapp;
  if (!accessToken) return { ok: false, reason: 'not-configured' };

  const auth = { Authorization: `Bearer ${accessToken}` };

  const lookup = await fetch(`https://graph.facebook.com/${graphVersion}/${mediaId}`, {
    headers: auth,
  });
  if (!lookup.ok) {
    console.error(`[media] lookup failed ${lookup.status}: ${await lookup.text().catch(() => '')}`);
    return { ok: false, reason: 'lookup-failed' };
  }

  const meta = (await lookup.json()) as { url?: string; mime_type?: string; file_size?: number };
  const mediaType = (meta.mime_type ?? '').split(';')[0]?.trim() ?? '';

  if (!meta.url) return { ok: false, reason: 'lookup-failed' };
  if (!accept.has(mediaType)) {
    console.warn(`[media] ${mediaId} is ${mediaType || 'an unknown type'}, which cannot be used here`);
    return { ok: false, reason: 'unsupported-type' };
  }
  if ((meta.file_size ?? 0) > MAX_BYTES) return { ok: false, reason: 'too-large' };

  const download = await fetch(meta.url, { headers: auth });
  if (!download.ok) {
    console.error(`[media] download failed ${download.status}`);
    return { ok: false, reason: 'download-failed' };
  }

  const bytes = Buffer.from(await download.arrayBuffer());
  // file_size can be absent or wrong; the real bytes are the authority.
  if (bytes.byteLength > MAX_BYTES) return { ok: false, reason: 'too-large' };

  console.log(`[media] read ${mediaType}, ${Math.round(bytes.byteLength / 1024)}KB`);
  return { ok: true, bytes, mediaType };
}

/** What to tell the customer when a photo could not be read. */
export function mediaFailureMessage(reason: MediaFailure): string {
  switch (reason) {
    case 'too-large':
      return '[The customer sent a photo that is too large to open. Ask them to send a smaller one, or to type the list.]';
    case 'unsupported-type':
      return '[The customer sent a file that is not a photo. Ask them to send a photo or type what they need.]';
    default:
      return '[The customer sent a photo but it could not be opened. Apologise briefly and ask them to send it again or type the list.]';
  }
}

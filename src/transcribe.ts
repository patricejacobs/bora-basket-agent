/**
 * Speech to text for voice notes.
 *
 * Claude reads images and documents but not audio, so a voice note has to be
 * transcribed before the agent can act on it. That means one external service
 * beyond Anthropic — the only one in this project — so the provider is behind a
 * seam and chosen by configuration rather than baked in.
 *
 * WhatsApp sends voice notes as OGG/Opus, which both providers accept directly.
 * No transcoding, and therefore no ffmpeg on the server.
 */
import { config } from './config.ts';

export type Transcription = { text: string; language?: string };

export type TranscribeResult =
  | { ok: true; transcription: Transcription }
  | { ok: false; reason: string };

export function transcriptionAvailable(): boolean {
  return config.transcription.provider !== 'none' && Boolean(currentKey());
}

function currentKey(): string {
  return config.transcription.provider === 'deepgram'
    ? config.transcription.deepgramKey
    : config.transcription.openaiKey;
}

export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<TranscribeResult> {
  const { provider } = config.transcription;

  if (provider === 'none') {
    return { ok: false, reason: 'TRANSCRIBE_PROVIDER is not set' };
  }
  if (!currentKey()) {
    return { ok: false, reason: `no API key configured for ${provider}` };
  }

  try {
    const result =
      provider === 'deepgram'
        ? await viaDeepgram(audio, mimeType)
        : await viaOpenAI(audio, mimeType);

    if (!result.ok) return result;
    if (!result.transcription.text.trim()) {
      return { ok: false, reason: 'the recording produced no words' };
    }
    return result;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * OpenAI transcription. Strong on accented English and code-switching, which
 * matters for Creole and for a list that mixes languages mid-sentence.
 * Deliberately does NOT pass a language hint — forcing one makes mixed-language
 * speech worse, and auto-detection is the point.
 */
async function viaOpenAI(audio: Buffer, mimeType: string): Promise<TranscribeResult> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), fileNameFor(mimeType));
  form.append('model', config.transcription.model || 'gpt-4o-transcribe');
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.transcription.openaiKey}` },
    body: form,
  });

  if (!res.ok) {
    return { ok: false, reason: `transcription failed ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }

  const body = (await res.json()) as { text?: string; language?: string };
  return {
    ok: true,
    transcription: { text: body.text ?? '', ...(body.language ? { language: body.language } : {}) },
  };
}

/** Deepgram, for anyone who would rather not add an OpenAI account. */
async function viaDeepgram(audio: Buffer, mimeType: string): Promise<TranscribeResult> {
  const params = new URLSearchParams({
    model: config.transcription.model || 'nova-3',
    detect_language: 'true',
    smart_format: 'true',
  });

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.transcription.deepgramKey}`,
      'Content-Type': mimeType,
    },
    body: new Uint8Array(audio),
  });

  if (!res.ok) {
    return { ok: false, reason: `transcription failed ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }

  const body = (await res.json()) as {
    results?: {
      channels?: { alternatives?: { transcript?: string }[]; detected_language?: string }[];
    };
  };
  const channel = body.results?.channels?.[0];
  return {
    ok: true,
    transcription: {
      text: channel?.alternatives?.[0]?.transcript ?? '',
      ...(channel?.detected_language ? { language: channel.detected_language } : {}),
    },
  };
}

/** The upload needs a filename with a real extension or the format is rejected. */
function fileNameFor(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim();
  switch (base) {
    case 'audio/mpeg':
      return 'note.mp3';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'note.m4a';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'note.wav';
    case 'audio/webm':
      return 'note.webm';
    default:
      // WhatsApp voice notes are audio/ogg; codecs=opus.
      return 'note.ogg';
  }
}

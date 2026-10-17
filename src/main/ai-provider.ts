import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import type { Language } from '../shared/types';
import { turnPolicy } from '../shared/transcript';

export { turnPolicy };

export type KeyGetter = () => string | null | Promise<string | null>;
export class APIError extends Error {
  constructor(
    message: string,
    public status = 0,
    public code = '',
    public retryAfter = 0,
  ) {
    super(message);
    this.name = 'APIError';
  }
}
export interface TextRequest {
  model: string;
  instructions: string;
  input: string;
  web?: boolean;
}
export interface TextResult {
  text: string;
  usage: Record<string, unknown>;
  sources: { title: string; url: string }[];
}
export interface TranscribeRequest {
  model: string;
  /** WAV file on disk (legacy segments, imported audio). */
  path?: string;
  /** In-memory WAV (disk ranges assembled from recorded segments); preferred over `path`. */
  audio?: Buffer;
  /** Callers resolve the lecture language; 'auto' is never sent. */
  language: Language;
  glossary: string;
  context: string;
  /** Retry after a language rejection: selected language only, no English allowance, no context. */
  strict?: boolean;
}
export interface TranscriptResult {
  text: string;
  usage: Record<string, unknown>;
  languages?: unknown[];
  timestamps?: unknown[];
}
export interface Provider {
  models(key?: string, signal?: AbortSignal): Promise<string[]>;
  text(request: TextRequest, signal: AbortSignal): Promise<TextResult>;
  transcribe(request: TranscribeRequest, signal: AbortSignal): Promise<TranscriptResult>;
}
export type SocketFactory = (key: string) => WebSocket;
export const createRealtimeSocket: SocketFactory = (key) =>
  new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 12000,
    maxPayload: 2 * 1024 * 1024,
  });

/** Localized description of the recording; the speech model writes in the language of its prompt. */
const SETTING: Record<Language, { lecture: string; english: string; terms: string }> = {
  pl: {
    lecture: 'Wykład uniwersytecki po polsku.',
    english: 'Mogą pojawiać się angielskie terminy.',
    terms: 'Terminy:',
  },
  ru: {
    lecture: 'Университетская лекция на русском языке.',
    english: 'Могут встречаться английские термины.',
    terms: 'Термины:',
  },
  uk: {
    lecture: 'Університетська лекція українською мовою.',
    english: 'Можуть траплятися англійські терміни.',
    terms: 'Терміни:',
  },
  en: { lecture: 'University lecture in English.', english: '', terms: 'Terms:' },
};
const family = (model: string, bases: string[]) =>
  bases.some((base) => model === base || model.startsWith(`${base}-`));
/** Models that take plural `languages` (+ `keywords`) instead of the singular `language` field. */
export const usesLanguages = (model: string) => family(model, ['gpt-live-transcribe', 'gpt-transcribe']);

export function transcriptionSettings(
  model: string,
  language: Language,
  glossary: string,
  realtime = false,
  strict = false,
  context = '',
) {
  const settings: Record<string, unknown> = { model };
  const setting = SETTING[language];
  // Hints are vocabulary data. They are never instructions for the application.
  const clean = glossary.replace(/[<>\r]/g, ' ').trim();
  const limit = model === 'whisper-1' ? 650 : 1800;
  const header = [setting.lecture, !strict && language !== 'en' ? setting.english : '']
    .filter(Boolean)
    .join(' ');
  const vocabulary = clean ? `\n${setting.terms} ${clean.slice(0, model === 'whisper-1' ? 300 : 900)}` : '';
  const previous = !strict && context.trim() ? `\n${context.trim().slice(-700)}` : '';
  settings.prompt = `${header}${vocabulary}${previous}`.slice(0, limit);
  if (usesLanguages(model)) {
    // Never send both fields: the plural one replaces `language` for these models.
    settings.languages = strict || language === 'en' ? [language] : [language, 'en'];
    const keywords = clean
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 60);
    if (keywords.length) settings.keywords = keywords;
    if (realtime && family(model, ['gpt-live-transcribe'])) settings.delay = 'medium';
  } else settings.language = language;
  return settings;
}

/**
 * session.update for a realtime transcription window. 'server' policy lets OpenAI detect speech
 * turns (semantic_vad with low eagerness, server_vad as fallback); 'local' disables turn detection
 * and the application commits at pauses itself (required for gpt-live-transcribe / gpt-transcribe).
 */
export function realtimeSession(
  model: string,
  language: Language,
  glossary: string,
  policy: 'server' | 'local',
  vadVariant: 'semantic' | 'server' = 'semantic',
  eventId?: string,
) {
  return {
    type: 'session.update',
    ...(eventId ? { event_id: eventId } : {}),
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: transcriptionSettings(model, language, glossary, true),
          turn_detection:
            policy === 'local'
              ? null
              : vadVariant === 'semantic'
                ? { type: 'semantic_vad', eagerness: 'low' }
                : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 },
        },
      },
    },
  };
}

/** Production adapter. Tests inject a separate Provider; this adapter never returns demo output. */
export class OpenAIProvider implements Provider {
  constructor(
    private getKey: KeyGetter,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(endpoint: string, body: BodyInit | undefined, signal?: AbortSignal, key?: string) {
    const secret = key ?? (await this.getKey());
    if (!secret)
      throw new APIError('Connect an OpenAI API key in Settings to process this task.', 401, 'missing_key');
    let response: Response;
    try {
      response = await this.fetcher(`https://api.openai.com/v1/${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(15000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new APIError(
        'OpenAI could not be reached. The saved task will retry when connectivity returns.',
        0,
        'network_error',
      );
    }
    const json = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      // Do not propagate raw requests, authorization headers, or a provider message containing the key.
      const message = String(json.error?.message ?? `OpenAI request failed (${response.status}).`)
        .replaceAll(secret, '[redacted]')
        .slice(0, 600);
      throw new APIError(
        message,
        response.status,
        String(json.error?.code ?? ''),
        Math.max(0, Number(response.headers.get('retry-after')) || 0),
      );
    }
    return json;
  }
  async models(key?: string, signal?: AbortSignal) {
    const data = await this.request('models', undefined, signal, key);
    return (data.data ?? []).map((m: any) => String(m.id));
  }
  async text(request: TextRequest, signal: AbortSignal): Promise<TextResult> {
    const data = await this.request(
      'responses',
      JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        store: false,
        ...(request.web
          ? { tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] }
          : {}),
      }),
      signal,
    );
    const pieces: string[] = [],
      sources: TextResult['sources'] = [];
    for (const output of data.output ?? [])
      for (const content of output.content ?? []) {
        if (content.type === 'output_text' && typeof content.text === 'string') pieces.push(content.text);
        if (content.type === 'refusal')
          throw new APIError(String(content.refusal ?? 'The model declined this request.'), 400, 'refusal');
        for (const a of content.annotations ?? [])
          if (a.type === 'url_citation' && /^https?:\/\//i.test(a.url))
            sources.push({ title: String(a.title || a.url), url: a.url });
      }
    if (data.status === 'incomplete')
      throw new APIError(
        'The model returned an incomplete result. Retry or select a different compatible model.',
        400,
        'incomplete_response',
      );
    const text = pieces.join('\n');
    if (!text.trim()) throw new APIError('The model returned no text.', 502, 'empty_response');
    return {
      text,
      sources: sources.filter((s, i) => sources.findIndex((x) => x.url === s.url) === i),
      usage: data.usage ?? {},
    };
  }
  async transcribe(request: TranscribeRequest, signal: AbortSignal): Promise<TranscriptResult> {
    if (!request.audio && request.path && (await stat(request.path)).size > 25 * 1024 * 1024)
      throw new APIError(
        'Audio segment exceeds the 25 MB transcription limit. Import it again so it can be split.',
        400,
        'audio_too_large',
      );
    const audio = request.audio ?? (request.path ? await readFile(request.path) : undefined);
    if (!audio) throw new APIError('No audio was supplied for transcription.', 400, 'missing_audio');
    if (audio.length > 25 * 1024 * 1024)
      throw new APIError(
        'Audio segment exceeds the 25 MB transcription limit. Import it again so it can be split.',
        400,
        'audio_too_large',
      );
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(audio)], { type: 'audio/wav' }),
      request.path ? path.basename(request.path) : 'lecture-audio.wav',
    );
    for (const [key, value] of Object.entries(
      transcriptionSettings(
        request.model,
        request.language,
        request.glossary,
        false,
        request.strict,
        request.context,
      ),
    )) {
      if (Array.isArray(value)) for (const item of value) form.append(`${key}[]`, String(item));
      else form.set(key, String(value));
    }
    if (request.model === 'whisper-1') {
      form.set('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
    } else form.set('response_format', 'json');
    const data = await this.request('audio/transcriptions', form, signal);
    if (typeof data.text !== 'string')
      throw new APIError('The transcription response did not include text.', 502, 'invalid_response');
    return { text: data.text, usage: data.usage ?? {}, languages: data.languages, timestamps: data.segments };
  }
}

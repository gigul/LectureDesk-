import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { Store } from '../src/main/store';
import { AIService } from '../src/main/ai';
import {
  APIError,
  OpenAIProvider,
  realtimeSession,
  transcriptionSettings,
  type Provider,
  type TextRequest,
  type TranscribeRequest,
} from '../src/main/ai-provider';
import { failureState, finalizedUnits, orderedTranscript, textSections, words } from '../src/main/ai-logic';
import { LocalRetrieval } from '../src/main/ai-retrieval';
import { wavHeader } from '../src/main/audio-format';
import { transcriptUnits } from '../src/shared/transcript';
import type { AppEvent, Segment, Task } from '../src/shared/types';

// Separate test adapter: production contains no fixture transcripts or successful fake API calls.
class TestProvider implements Provider {
  textCalls: TextRequest[] = [];
  audioCalls: TranscribeRequest[] = [];
  textImpl: (request: TextRequest, signal: AbortSignal) => Promise<string> = async (r) =>
    `Result: ${r.input.slice(0, 100)}`;
  audioImpl: (request: TranscribeRequest, signal: AbortSignal) => Promise<string> = async (r) =>
    path.basename(r.path ?? 'range.wav');
  async models() {
    return ['gpt-transcribe', 'gpt-live-transcribe', 'gpt-6.1-sol'];
  }
  async text(request: TextRequest, signal: AbortSignal) {
    this.textCalls.push(request);
    return { text: await this.textImpl(request, signal), usage: { input_tokens: 20 }, sources: [] };
  }
  async transcribe(request: TranscribeRequest, signal: AbortSignal) {
    this.audioCalls.push(request);
    return { text: await this.audioImpl(request, signal), usage: {} };
  }
}
class TestSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  terminate() {
    this.readyState = 3;
    this.emit('close');
  }
  event(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}
const cleanup: (() => void)[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'lecturedesk-ai-')),
    store = new Store(directory),
    provider = new TestProvider();
  const service = new AIService(
    store,
    () => 'test-secret-never-a-real-key',
    () => {},
    { provider },
  );
  cleanup.push(() => {
    service.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, provider, service };
}
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function segment(store: Store, lectureId: string, sequence: number, text = '', done = false) {
  const value: Segment = {
    id: randomUUID(),
    lectureId,
    sequence,
    start: sequence * 10,
    end: (sequence + 1) * 10,
    path: path.join(store.root, `${sequence}.wav`),
    text,
    status: done ? 'done' : 'queued',
    error: null,
  };
  writeFileSync(value.path, Buffer.alloc(44));
  store.segmentSave(value);
  return value;
}
async function until(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for test queue.');
    await new Promise((r) => setTimeout(r, 8));
  }
}

// ── Synthetic 24 kHz PCM16 audio: speech-like noise at -20 dBFS and digital silence. ──
const ms = (value: number) => Math.round(value * 48);
function tone(duration: number) {
  const pcm = Buffer.alloc(ms(duration));
  for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(index % 2 ? 3277 : -3277, index * 2);
  return pcm;
}
const quiet = (duration: number) => Buffer.alloc(ms(duration));
/** Saves recorded audio the way capture does: 10-second WAV files kept as 'audio' segments. */
function writeAudio(store: Store, lectureId: string, pcm: Buffer) {
  const directory = path.join(store.root, 'audio', lectureId);
  mkdirSync(directory, { recursive: true });
  for (let offset = 0, sequence = 0; offset < pcm.length; offset += 480000, sequence++) {
    const data = pcm.subarray(offset, offset + 480000);
    const file = path.join(directory, `${String(sequence).padStart(6, '0')}-${(offset / 48000) * 1000}.wav`);
    writeFileSync(file, Buffer.concat([wavHeader(data.length), data]));
    store.segmentSave({
      id: randomUUID(),
      lectureId,
      sequence,
      start: offset / 48000,
      end: (offset + data.length) / 48000,
      path: file,
      text: '',
      status: 'audio',
      error: null,
    });
  }
}
/** Streams durable audio like the recorder: 250 ms slices at their lecture byte offsets. */
function feed(service: AIService, lectureId: string, pcm: Buffer, offset: number) {
  for (let index = 0; index < pcm.length; index += 12000)
    service.liveAppend(lectureId, pcm.subarray(index, index + 12000), offset + index);
  return offset + pcm.length;
}
/** Byte positions (audio appended so far) at which the client sent events of a type. */
function positions(socket: TestSocket, type: string) {
  let bytes = 0;
  const result: number[] = [];
  for (const event of socket.sent) {
    if (event.type === 'input_audio_buffer.append') bytes += Buffer.from(event.audio, 'base64').length;
    if (event.type === type) result.push(bytes);
  }
  return result;
}
const flushPromises = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
function liveFixture(options: { now?: () => number } = {}) {
  const base = fixture();
  base.service.stop();
  const sockets: TestSocket[] = [],
    events: AppEvent[] = [];
  const service = new AIService(base.store, () => 'test-secret', (event) => events.push(event), {
    provider: base.provider,
    now: options.now,
    socketFactory: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  cleanup.unshift(() => service.stop());
  return { ...base, service, sockets, events };
}
const ranges = (store: Store, lectureId: string): Task[] =>
  store
    .tasks()
    .filter((task) => task.lectureId === lectureId && task.kind === 'transcribe-range')
    .sort((a, b) => Number(a.payload.startByte) - Number(b.payload.startByte));
const completed = (item_id: string, transcript: string) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id,
  transcript,
});

describe('durable AI processing', () => {
  it('runs at most two audio tasks and preserves sequence when responses finish out of order', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    const segments = [0, 1, 2, 3].map((n) => segment(store, lecture.id, n));
    const resolve = new Map<string, (text: string) => void>();
    provider.audioImpl = (request) => new Promise((r) => resolve.set(request.path!, r));
    for (const s of segments)
      store.taskAdd('transcribe', lecture.id, { segmentId: s.id }, `transcribe:${s.id}`);
    service.start();
    await until(() => resolve.size === 2);
    expect(provider.audioCalls).toHaveLength(2);
    expect(store.tasks().filter((t) => t.status === 'running')).toHaveLength(2);
    resolve.get(segments[1].path)!('second');
    await until(() => resolve.size === 3);
    expect(store.lectureGet(lecture.id).versions).toHaveLength(0); // The first turn is still missing.
    resolve.get(segments[2].path)!('third');
    await until(() => resolve.size === 4);
    resolve.get(segments[3].path)!('fourth');
    resolve.get(segments[0].path)!('first');
    await until(() => store.tasks().every((t) => t.status === 'done'));
    const original = store.lectureGet(lecture.id).versions.find((v) => v.kind === 'original')!;
    expect(original.content).toBe('[0:00] first\n\n[0:10] second\n\n[0:20] third\n\n[0:30] fourth');
  });
  it('distinguishes exhausted quota, allows manual retry, and does not discard saved audio', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate(),
      s = segment(store, lecture.id, 0);
    const task = store.taskAdd('transcribe', lecture.id, { segmentId: s.id });
    provider.audioImpl = async () => {
      throw new APIError('Quota exhausted', 429, 'insufficient_quota');
    };
    service.start();
    await until(() => store.tasks()[0].status === 'quota');
    expect(store.lectureGet(lecture.id).segments[0].path).toBe(s.path);
    provider.audioImpl = async () => 'recovered text';
    service.retry(task.id);
    await until(() => store.tasks()[0].status === 'done');
    expect(store.lectureGet(lecture.id).segments[0].text).toBe('recovered text');
  });
  it('aborts a cancelled request and stores no output version', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'An immutable lecture.',
    });
    provider.textImpl = (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }),
      );
    const task = service.runAction({ lectureId: lecture.id, versionId: original.id, action: 'summary' });
    service.start();
    await until(() => provider.textCalls.length === 1);
    service.cancel(task.id);
    await until(() => store.tasks()[0].status === 'cancelled');
    expect(store.lectureGet(lecture.id).versions).toHaveLength(1);
    expect(store.lectureGet(lecture.id).versions[0].content).toBe(original.content);
  });
  it('caches identical actions and preserves the original across processed versions', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: 'Immutable source.',
    });
    const args = { lectureId: lecture.id, versionId: original.id, action: 'summary' };
    const task = service.runAction(args);
    service.start();
    await until(() => store.tasks()[0].status === 'done');
    expect(service.runAction(args).id).toBe(task.id);
    expect(provider.textCalls).toHaveLength(1);
    const versions = store.lectureGet(lecture.id).versions;
    expect(versions).toHaveLength(2);
    expect(versions.find((v) => v.kind === 'original')?.content).toBe(original.content);
    expect(versions.find((v) => v.kind === 'action')?.sourceVersionId).toBe(original.id);
  });
  it('resumes saved section checkpoints and synthesizes notes from every section', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    const text = 'first source topic. '.repeat(800) + '\n\n' + 'last source deadline. '.repeat(800);
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: text,
    });
    const task = service.runAction({ lectureId: lecture.id, versionId: original.id, action: 'notes' });
    const count = textSections(text).length;
    store.taskUpdate(task.id, { payload: { ...task.payload, mapResults: ['saved first section'] } });
    service.start();
    await until(() => store.tasks()[0].status === 'done');
    expect(provider.textCalls).toHaveLength(count); // count-1 unfinished map calls + one synthesis.
    expect(provider.textCalls.at(-1)?.input).toContain('saved first section');
    expect(provider.textCalls.some((call) => call.input.includes('last source deadline'))).toBe(true);
  });
  it('pauses without a key and resumes saved tasks after replacement without abort-state races', async () => {
    const { store, provider, service: unused } = fixture();
    unused.stop();
    let key: string | null = null;
    const service = new AIService(
      store,
      () => key,
      () => {},
      { provider },
    );
    cleanup.push(() => service.stop());
    const lecture = store.lectureCreate(),
      s = segment(store, lecture.id, 0),
      task = store.taskAdd('transcribe', lecture.id, { segmentId: s.id });
    service.start();
    await (service as any).tick();
    expect(store.tasks()[0].status).toBe('queued');
    expect(provider.audioCalls).toHaveLength(0);
    provider.audioImpl = (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Aborted old request')), { once: true }),
      );
    service.stop();
    key = 'first-test-key';
    service.start();
    await until(() => provider.audioCalls.length === 1);
    service.stop();
    key = 'replacement-test-key';
    provider.audioImpl = async () => 'Resumed after credential change';
    service.start();
    await until(() => store.tasks().find((t) => t.id === task.id)?.status === 'done');
    expect(store.lectureGet(lecture.id).segments[0].text).toBe('Resumed after credential change');
    expect(provider.audioCalls).toHaveLength(2);
  });
  it('does not freeze an interrupted original before a recovered tail exists', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    segment(store, lecture.id, 0, 'Saved before crash', true);
    store.saveSettings({ finalNotes: true });
    store.lectureSave({ id: lecture.id, status: 'interrupted' });
    service.start();
    service.flush(lecture.id);
    await (service as any).tick();
    expect(store.lectureGet(lecture.id).versions).toHaveLength(0);
    expect(provider.textCalls).toHaveLength(0);
    segment(store, lecture.id, 1, 'Recovered tail', true);
    store.lectureSave({ id: lecture.id, status: 'ready' });
    service.flush(lecture.id);
    expect(store.lectureGet(lecture.id).versions[0].content).toContain('Recovered tail');
    await until(() => store.tasks().find((t) => t.kind === 'final-notes')?.status === 'done');
    expect(provider.textCalls[0].input).toContain('Recovered tail');
  });
  it('flushes translation remnants below the threshold and excludes preliminary/out-of-order text', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    store.saveSettings({ liveTranslation: true, translationWords: 50 });
    store.lectureSave({ id: lecture.id, status: 'recording' });
    const first = segment(store, lecture.id, 0),
      second = segment(store, lecture.id, 1, 'A short final sentence.', true);
    service.start();
    await (service as any).tick();
    expect(store.tasks().filter((t) => t.kind === 'translation')).toHaveLength(0);
    store.segmentUpdate(first.id, { status: 'done', text: 'Opening statement.' });
    store.lectureSave({ id: lecture.id, status: 'ready' });
    service.flush(lecture.id);
    await until(() =>
      store
        .tasks()
        .filter((t) => t.kind === 'translation')
        .some((t) => t.status === 'done'),
    );
    expect(provider.textCalls[0].input).toContain('Opening statement.');
    expect(provider.textCalls[0].input).toContain(second.text);
    expect(store.tasks().filter((t) => t.kind === 'translation')).toHaveLength(1);
  });
});

describe('continuous realtime transcription', () => {
  it('streams continuously and commits locally only inside pauses (gpt-live-transcribe)', async () => {
    const { store, provider, service, sockets, events } = liveFixture();
    store.saveSettings({ liveModel: 'gpt-live-transcribe', lectureLanguage: 'en' });
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    // 8 s speech, 1 s pause, 12 s speech across the 10 s and 20 s file boundaries, 8 s silence.
    const pcm = Buffer.concat([tone(8000), quiet(1000), tone(12000), quiet(1000), quiet(7000)]);
    writeAudio(store, lecture.id, pcm);
    service.start();
    let offset = feed(service, lecture.id, pcm.subarray(0, 12000), 0);
    await until(() => sockets.length === 1);
    const socket = sockets[0];
    socket.emit('open');
    socket.event({ type: 'session.updated' });
    offset = feed(service, lecture.id, pcm.subarray(offset), offset);
    const session = socket.sent[0].session.audio.input;
    expect(session.turn_detection).toBe(null);
    expect(session.transcription).toMatchObject({ model: 'gpt-live-transcribe', languages: ['en'], delay: 'medium' });
    // Commits only after trailing silence; never at the 480000-byte (10 s) file boundaries.
    expect(positions(socket, 'input_audio_buffer.commit')).toEqual([ms(8500), ms(21500)]);
    // The speechless turn is cleared, never committed.
    expect(positions(socket, 'input_audio_buffer.clear')).toEqual([ms(27500)]);
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'item-2' });
    socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-2', delta: 'Second' });
    expect(events.filter((e) => e.type === 'partial').at(-1)).toMatchObject({ text: 'Second', start: 8.8 });
    // Out-of-order completion: the later turn finishes first.
    socket.event(completed('item-2', 'Second live turn.'));
    store.lectureSave({ id: lecture.id, status: 'ready' });
    service.liveStop(lecture.id);
    service.flush(lecture.id);
    expect(store.lectureGet(lecture.id).versions).toHaveLength(0); // The first turn is still missing.
    socket.event(completed('item-1', 'First live turn.'));
    const detail = store.lectureGet(lecture.id);
    expect(detail.items.map((item) => [item.start, item.text, item.source])).toEqual([
      [0, 'First live turn.', 'live'],
      [8.8, 'Second live turn.', 'live'],
    ]);
    expect(detail.versions.find((v) => v.kind === 'original')?.content).toBe(
      '[0:00] First live turn.\n\n[0:08] Second live turn.',
    );
    // The closing tail was cleared (silent), so the whole window is covered: no disk work.
    expect(ranges(store, lecture.id).map((task) => [task.status, task.payload.endByte, task.payload.gaps])).toEqual(
      [['done', pcm.length, []]],
    );
    expect(provider.audioCalls).toHaveLength(0);
    expect(socket.readyState).toBe(3);
  });

  it('uses server turn detection for gpt-4o-transcribe with fallback and renews at a pause', async () => {
    let now = Date.now();
    const { store, provider, service, sockets } = liveFixture({ now: () => now });
    store.saveSettings({ lectureLanguage: 'en' });
    expect(store.settings().liveModel).toBe('gpt-4o-transcribe');
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    const pcm = Buffer.concat([tone(2000), quiet(500), tone(1000), quiet(500)]);
    writeAudio(store, lecture.id, pcm);
    service.start();
    let offset = feed(service, lecture.id, pcm.subarray(0, ms(2000)), 0);
    await until(() => sockets.length === 1);
    const first = sockets[0];
    first.emit('open');
    expect(first.sent[0].session.audio.input.turn_detection).toEqual({ type: 'semantic_vad', eagerness: 'low' });
    expect(first.sent[0].session.audio.input.transcription).toMatchObject({ model: 'gpt-4o-transcribe', language: 'en' });
    expect(first.sent[0].session.audio.input.transcription).not.toHaveProperty('languages');
    // semantic_vad rejected before the session is ready → same socket, server_vad.
    first.event({
      type: 'error',
      error: { code: 'invalid_value', param: 'session.audio.input.turn_detection', event_id: first.sent[0].event_id },
    });
    expect(first.sent[1].session.audio.input.turn_detection).toEqual({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 700,
    });
    first.event({ type: 'session.updated' });
    expect(positions(first, 'session.update')).toEqual([0, 0]);
    first.event({ type: 'input_audio_buffer.speech_started', item_id: 'item_a', audio_start_ms: 200 });
    first.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_a', audio_end_ms: 2000 });
    first.event({ type: 'input_audio_buffer.committed', item_id: 'item_a' });
    first.event(completed('item_a', 'Opening words.'));
    expect(first.sent.filter((e) => e.type === 'input_audio_buffer.commit')).toHaveLength(0);
    // 55 minutes later the session is renewed at the next pause without losing audio.
    now += 55 * 60 * 1000 + 1;
    offset = feed(service, lecture.id, pcm.subarray(offset, offset + ms(500)), offset);
    await until(() => sockets.length === 2);
    expect(first.readyState).toBe(3);
    const second = sockets[1];
    second.emit('open');
    second.event({ type: 'session.updated' });
    offset = feed(service, lecture.id, pcm.subarray(offset), offset);
    second.event({ type: 'input_audio_buffer.speech_started', item_id: 'item_b', audio_start_ms: 100 });
    second.event({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_b', audio_end_ms: 1100 });
    second.event({ type: 'input_audio_buffer.committed', item_id: 'item_b' });
    second.event(completed('item_b', 'After renewal.'));
    // Offsets are relative to each session's own audio: window start + audio_start_ms.
    expect(store.lectureGet(lecture.id).items.map((item) => [item.start, item.end, item.text])).toEqual([
      [0.2, 2, 'Opening words.'],
      [2.6, 3.6, 'After renewal.'],
    ]);
    const windows = ranges(store, lecture.id);
    expect(windows.map((task) => [task.payload.startByte, task.payload.endByte])).toEqual([
      [0, ms(2500)],
      [ms(2500), null],
    ]);
    // The silence after the first turn is checked on disk and costs no request.
    expect(windows[0].payload.gaps).toEqual([{ startByte: ms(2000), endByte: ms(2500) }]);
    await until(() => ranges(store, lecture.id)[0].status === 'done');
    expect(provider.audioCalls).toHaveLength(0);
  });

  it('turns a failed connection into exact disk gaps without duplicates or late writes', async () => {
    const { store, provider, service, sockets } = liveFixture();
    store.saveSettings({ liveModel: 'gpt-live-transcribe', lectureLanguage: 'en' });
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    const pcm = Buffer.concat([tone(7000), quiet(1000), tone(7000), quiet(1000), tone(3000), quiet(1000)]);
    writeAudio(store, lecture.id, pcm);
    service.start();
    let offset = feed(service, lecture.id, pcm.subarray(0, 12000), 0);
    await until(() => sockets.length === 1);
    const socket = sockets[0];
    socket.emit('open');
    socket.event({ type: 'session.updated' });
    offset = feed(service, lecture.id, pcm.subarray(offset, ms(18000)), offset);
    expect(positions(socket, 'input_audio_buffer.commit')).toEqual([ms(7500), ms(15500)]);
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'item-2' });
    socket.event(completed('item-1', 'First turn here.'));
    const window = [...(service as any).sessions][0];
    // The connection drops with turn 2 pending and 2.5 s of audio not yet confirmed.
    socket.emit('error', new Error('Network offline'));
    offset = feed(service, lecture.id, pcm.subarray(offset), offset);
    expect(sockets).toHaveLength(1); // No reconnect before the retry delay.
    provider.audioImpl = async () => 'Second turn from disk.';
    store.lectureSave({ id: lecture.id, status: 'ready' });
    service.liveStop(lecture.id);
    const [task] = ranges(store, lecture.id);
    expect(task.payload).toMatchObject({
      livePending: false,
      endByte: pcm.length,
      gaps: [{ startByte: ms(7500), endByte: pcm.length }],
    });
    // A completion arriving after the window was finalized is ignored.
    (service as any).realtimeEvent(window, completed('item-2', 'Late duplicate.'));
    await until(() => ranges(store, lecture.id)[0].status === 'done');
    expect(provider.audioCalls).toHaveLength(1);
    const call = provider.audioCalls[0];
    // The disk request holds exactly the speech of the gap (trimmed to voice ± 300 ms).
    expect(call.audio!.subarray(44)).toEqual(pcm.subarray(ms(7700), ms(19300)));
    expect(call).toMatchObject({ strict: false, context: 'First turn here.', language: 'en' });
    service.flush(lecture.id);
    const detail = store.lectureGet(lecture.id);
    expect(detail.items.map((item) => [item.start, item.text, item.source])).toEqual([
      [0, 'First turn here.', 'live'],
      [7.7, 'Second turn from disk.', 'file'],
    ]);
    expect(detail.versions.find((v) => v.kind === 'original')?.content).toBe(
      '[0:00] First turn here.\n\n[0:07] Second turn from disk.',
    );
  });

  it('reconnects after a failure only at a pause; windows tile the recording without overlap', async () => {
    let now = Date.now();
    const { store, service, sockets } = liveFixture({ now: () => now });
    store.saveSettings({ liveModel: 'gpt-live-transcribe' });
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    service.start();
    let offset = feed(service, lecture.id, tone(2000), 0);
    await until(() => sockets.length === 1);
    sockets[0].emit('error', new Error('offline'));
    now += 16000; // Past the retry delay, but the speaker keeps talking.
    offset = feed(service, lecture.id, tone(2000), offset);
    offset = feed(service, lecture.id, quiet(250), offset);
    expect(ranges(store, lecture.id)).toHaveLength(1); // 240 ms of silence: no cut yet.
    offset = feed(service, lecture.id, quiet(250), offset);
    offset = feed(service, lecture.id, tone(1000), offset);
    await until(() => sockets.length === 2);
    service.liveStop(lecture.id);
    const windows = ranges(store, lecture.id).map((task) => [task.payload.startByte, task.payload.endByte]);
    expect(windows).toEqual([
      [0, ms(4500)],
      [ms(4500), offset],
    ]);
    expect(offset).toBe(ms(5500));
  });

  it('renews local sessions right after a commit, drains, and bounds a missing result with gaps', async () => {
    let now = Date.now();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, service, sockets } = liveFixture({ now: () => now });
      store.saveSettings({ liveModel: 'gpt-live-transcribe' });
      const lecture = store.lectureCreate();
      store.lectureSave({ id: lecture.id, status: 'recording' });
      service.start();
      let offset = feed(service, lecture.id, tone(100), 0);
      await flushPromises();
      sockets[0].emit('open');
      sockets[0].event({ type: 'session.updated' });
      now += 55 * 60 * 1000;
      offset = feed(service, lecture.id, Buffer.concat([tone(6000), quiet(500)]), offset);
      expect(positions(sockets[0], 'input_audio_buffer.commit')).toEqual([ms(6600)]);
      await flushPromises();
      expect(sockets).toHaveLength(2); // Renewed right after the commit.
      expect(sockets[0].readyState).toBe(1); // The pending turn keeps the old session draining.
      expect(ranges(store, lecture.id).map((task) => task.payload.startByte)).toEqual([0, ms(6600)]);
      vi.advanceTimersByTime(45000);
      expect(sockets[0].readyState).toBe(3);
      // The unanswered turn becomes disk work instead of being lost.
      expect(ranges(store, lecture.id)[0].payload).toMatchObject({
        endByte: ms(6600),
        gaps: [{ startByte: 0, endByte: ms(6600) }],
        livePending: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forces renewal at 59.5 minutes even mid-speech and commits the open server turn', async () => {
    let now = Date.now();
    const { store, service, sockets } = liveFixture({ now: () => now });
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    service.start();
    let offset = feed(service, lecture.id, tone(500), 0);
    await until(() => sockets.length === 1);
    sockets[0].emit('open');
    sockets[0].event({ type: 'session.updated' });
    sockets[0].event({ type: 'input_audio_buffer.speech_started', item_id: 'item_x', audio_start_ms: 0 });
    now += 58 * 60 * 1000;
    offset = feed(service, lecture.id, tone(250), offset);
    expect(sockets).toHaveLength(1); // Speaking: no renewal before the hard limit.
    now += 1.5 * 60 * 1000;
    offset = feed(service, lecture.id, tone(250), offset);
    await until(() => sockets.length === 2);
    expect(sockets[0].sent.filter((e) => e.type === 'input_audio_buffer.commit')).toHaveLength(1);
    expect(ranges(store, lecture.id).map((task) => task.payload.startByte)).toEqual([0, offset]);
  });

  it('keeps a crashed window for disk transcription until recovery, then derives its gaps', async () => {
    const { store, provider, service } = fixture();
    store.saveSettings({ lectureLanguage: 'en' });
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'interrupted' });
    const pcm = Buffer.concat([quiet(5000), tone(3000), quiet(2000), tone(3000), quiet(2000)]);
    writeAudio(store, lecture.id, pcm);
    const task = store.taskAdd(
      'transcribe-range',
      lecture.id,
      {
        windowId: 'w1',
        startByte: 0,
        endByte: null,
        frontierByte: ms(5000),
        livePending: true,
        origin: 'live',
        model: 'gpt-transcribe',
        liveModel: 'gpt-live-transcribe',
        language: 'en',
        glossary: '',
      },
      'range:w1',
    );
    store.taskUpdate(task.id, { nextRun: Number.MAX_SAFE_INTEGER });
    store.itemSave({
      lectureId: lecture.id,
      start: 5,
      end: 8,
      text: 'Saved live turn.',
      status: 'done',
      source: 'live',
      model: 'gpt-live-transcribe',
      language: 'en',
      error: null,
      sourceKey: 'live:w1:item_1',
    });
    provider.audioImpl = async () => 'Recovered tail speech.';
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.taskGet(task.id)).toMatchObject({ status: 'queued', payload: { livePending: false } });
    expect(provider.audioCalls).toHaveLength(0); // Waits: the recording is not recovered yet.
    store.lectureSave({ id: lecture.id, status: 'ready' });
    await until(() => store.taskGet(task.id)?.status === 'done');
    expect(provider.audioCalls).toHaveLength(1);
    expect(provider.audioCalls[0].audio!.subarray(44)).toEqual(pcm.subarray(ms(9700), ms(13300)));
    expect(store.lectureGet(lecture.id).items.map((item) => [item.start, item.text])).toEqual([
      [5, 'Saved live turn.'],
      [9.7, 'Recovered tail speech.'],
    ]);
  });

  it('transcribes recorded audio from disk after stop when live transcription is off; silence is free', async () => {
    const { store, provider, service } = fixture();
    store.saveSettings({ liveTranscription: false, lectureLanguage: 'en' });
    const silent = store.lectureCreate();
    writeAudio(store, silent.id, quiet(25000));
    const spoken = store.lectureCreate();
    writeAudio(store, spoken.id, Buffer.concat([quiet(1000), tone(2000), quiet(12000)]));
    provider.audioImpl = async () => 'Spoken after stop.';
    service.start();
    service.flush(silent.id);
    service.flush(spoken.id);
    await until(() => [silent.id, spoken.id].every((id) => ranges(store, id)[0]?.status === 'done'));
    expect(ranges(store, silent.id).map((task) => [task.payload.startByte, task.payload.endByte])).toEqual([
      [0, ms(25000)],
    ]);
    // Only the chunk with speech is sent; the all-zero lecture makes no request at all.
    expect(provider.audioCalls).toHaveLength(1);
    expect(provider.audioCalls[0].audio!.length).toBe(44 + ms(2600));
    await until(() =>
      [silent.id, spoken.id].every((id) => store.lectureGet(id).versions.some((v) => v.kind === 'original')),
    );
    expect(store.lectureGet(spoken.id).versions[0].content).toBe('[0:00] Spoken after stop.');
    expect(store.lectureGet(silent.id).versions[0].content).toBe('');
  });

  it('enforces the lecture language: strict retry, hidden rejection, silent hallucinations', async () => {
    const { store, provider, service } = fixture();
    store.saveSettings({ lectureLanguage: 'pl', liveTranscription: false });
    const replies: string[] = [];
    provider.audioImpl = async () => replies.shift() ?? '';
    service.start();
    const run = async (...answers: string[]) => {
      replies.push(...answers);
      const lecture = store.lectureCreate();
      writeAudio(store, lecture.id, Buffer.concat([tone(2000), quiet(1000)]));
      const calls = provider.audioCalls.length;
      service.flush(lecture.id);
      await until(() => ranges(store, lecture.id)[0]?.status === 'done');
      await until(() => store.lectureGet(lecture.id).versions.some((v) => v.kind === 'original'));
      return { detail: store.lectureGet(lecture.id), calls: provider.audioCalls.slice(calls) };
    };
    // Chinese → strict retry (selected language only, no context) → Polish accepted.
    const retried = await run('今天我们讨论热传导方程。', 'Dzisiaj omówimy równanie ciepła.');
    expect(retried.calls.map((call) => Boolean(call.strict))).toEqual([false, true]);
    expect(retried.calls[1].context).toBe('');
    expect(retried.detail.items.map((item) => [item.status, item.text])).toEqual([
      ['done', 'Dzisiaj omówimy równanie ciepła.'],
    ]);
    // Wrong twice → stored as rejected, hidden from the original.
    const rejected = await run('今天我们讨论热传导方程。', '今天我们讨论热传导方程。');
    expect(rejected.detail.items).toMatchObject([
      { status: 'rejected', text: '今天我们讨论热传导方程。', error: expect.stringContaining('Polish/English') },
    ]);
    expect(rejected.detail.versions[0].content).toBe('');
    expect(orderedTranscript(rejected.detail.segments, rejected.detail.items)).toBe('');
    // A silence hallucination is dropped without a retry.
    const hallucination = await run('Продолжение следует...');
    expect(hallucination.calls).toHaveLength(1);
    expect(hallucination.detail.items).toEqual([]);
    const usage = store.lectureGet(retried.detail.lecture.id).usage.map((row) => row.data.languageCheck);
    expect(usage).toEqual(['reject:foreign-script', 'ok']);
  });

  it('does not send a silent legacy segment and hides a wrong-language legacy segment', async () => {
    const { store, provider, service } = fixture();
    store.saveSettings({ lectureLanguage: 'uk' });
    const lecture = store.lectureCreate();
    const silent = segment(store, lecture.id, 0);
    writeFileSync(silent.path, Buffer.concat([wavHeader(ms(10000)), quiet(10000)]));
    const spoken = segment(store, lecture.id, 1);
    writeFileSync(spoken.path, Buffer.concat([wavHeader(ms(10000)), tone(10000)]));
    for (const s of [silent, spoken]) store.taskAdd('transcribe', lecture.id, { segmentId: s.id }, `transcribe:${s.id}`);
    provider.audioImpl = async () => 'Dzisiaj mówimy o tym, że równanie jest ważne i nie jest trudne.';
    service.start();
    await until(() => store.tasks().every((t) => t.status === 'done'));
    expect(provider.audioCalls.map((call) => call.path)).toEqual([spoken.path, spoken.path]);
    const detail = store.lectureGet(lecture.id);
    expect(detail.segments.map((s) => [s.status, s.text])).toEqual([
      ['done', ''],
      ['done', ''],
    ]);
    expect(detail.items).toMatchObject([{ status: 'rejected', start: 10, end: 20, sourceKey: `segment:${spoken.id}` }]);
  });

  it('retranscribes the whole recording split at pauses into an improved version', async () => {
    const { store, provider, service } = fixture();
    store.saveSettings({ lectureLanguage: 'en' });
    const lecture = store.lectureCreate();
    writeAudio(store, lecture.id, Buffer.concat([quiet(1000), tone(4000), quiet(20000)]));
    const original = store.versionSave({
      lectureId: lecture.id,
      kind: 'original',
      title: 'Original',
      content: '[0:01] live text',
    });
    provider.audioImpl = async () => 'Improved speech.';
    const task = service.improve(lecture.id);
    expect(task.payload).toMatchObject({ mode: 'range', startByte: 0, endByte: ms(25000), language: 'en' });
    service.start();
    await until(() => store.taskGet(task.id)?.status === 'done');
    expect(provider.audioCalls).toHaveLength(1);
    expect(provider.audioCalls[0].audio!.length).toBe(44 + ms(4600));
    const improved = store.lectureGet(lecture.id).versions.find((v) => v.kind === 'improved')!;
    expect(improved).toMatchObject({ content: '[0:00] Improved speech.', sourceVersionId: original.id });
    expect(improved.parameters).not.toHaveProperty('chunks');
  });
  it('closes realtime windows on stop so unconfirmed audio becomes queued disk work', async () => {
    const { store, service, sockets } = liveFixture();
    store.saveSettings({ liveModel: 'gpt-live-transcribe' });
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    service.start();
    feed(service, lecture.id, tone(3000), 0);
    await until(() => sockets.length === 1);
    sockets[0].emit('open');
    sockets[0].event({ type: 'session.updated' });
    service.stop();
    expect(sockets[0].readyState).toBe(3);
    expect(ranges(store, lecture.id)[0]).toMatchObject({
      status: 'queued',
      payload: { livePending: false, endByte: ms(3000), gaps: [{ startByte: 0, endByte: ms(3000) }] },
    });
  });
  it('starts no new work for a lecture while it is purged or in Trash, and resumes after restore', async () => {
    const { store, provider, service } = fixture();
    const lecture = store.lectureCreate();
    segment(store, lecture.id, 0, 'Finalized words before deletion.', true);
    const original = store.versionSave({ lectureId: lecture.id, kind: 'original', title: 'Original', content: 'x' });
    provider.textImpl = (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Aborted')), 60), {
          once: true,
        }),
      );
    service.runAction({ lectureId: lecture.id, versionId: original.id, action: 'summary' });
    service.start();
    await until(() => provider.textCalls.length === 1);
    // Translation becomes due while the lecture is being deleted.
    store.saveSettings({ liveTranslation: true, translationWords: 1 });
    store.lectureTrash(lecture.id);
    const cancelling = service.cancelLecture(lecture.id);
    await (service as any).tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.tasks().filter((t) => t.kind === 'translation')).toHaveLength(0);
    await cancelling;
    await (service as any).tick();
    expect(store.tasks().filter((t) => t.kind === 'translation')).toHaveLength(0);
    expect(provider.textCalls).toHaveLength(1);
    // Queued work of a trashed lecture waits; restoring the lecture resumes it.
    store.saveSettings({ liveTranslation: false });
    const other = store.lectureCreate();
    const s = segment(store, other.id, 0);
    store.lectureTrash(other.id);
    const task = store.taskAdd('transcribe', other.id, { segmentId: s.id });
    provider.audioImpl = async () => 'Restored lecture speech.';
    await (service as any).tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(provider.audioCalls).toHaveLength(0);
    expect(store.taskGet(task.id)?.status).toBe('queued');
    store.lectureRestore(other.id);
    await until(() => store.taskGet(task.id)?.status === 'done');
    expect(provider.audioCalls).toHaveLength(1);
  });
  it('cancels a lecture and resolves only after its running request stopped', async () => {
    const { store, provider, service } = fixture();
    const lecture = store.lectureCreate();
    const s = segment(store, lecture.id, 0);
    store.taskAdd('transcribe', lecture.id, { segmentId: s.id });
    let settled = false;
    provider.audioImpl = (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () =>
            setTimeout(() => {
              settled = true;
              reject(new Error('Aborted'));
            }, 30),
          { once: true },
        ),
      );
    service.start();
    await until(() => provider.audioCalls.length === 1);
    await service.cancelLecture(lecture.id);
    expect(settled).toBe(true);
    expect(store.tasks()[0].status).toBe('cancelled');
  });
});

describe('scoped local retrieval and chat', () => {
  it('filters scope before retrieval, supports Cyrillic, excludes trashed lectures, and covers all subject sources', async () => {
    const { store } = fixture(),
      subject = store.subjectSave({ name: 'Physics' });
    const a = store.lectureCreate({ subjectId: subject.id, title: 'Allowed lecture' }),
      b = store.lectureCreate({ title: 'Forbidden lecture' }),
      trash = store.lectureCreate({ subjectId: subject.id, title: 'Trash lecture' });
    store.versionSave({
      lectureId: a.id,
      kind: 'original',
      title: 'Original',
      content: 'Квантовая механика describes particles.',
    });
    store.versionSave({
      lectureId: b.id,
      kind: 'original',
      title: 'Original',
      content: 'Квантовая механика forbidden content.',
    });
    store.versionSave({
      lectureId: trash.id,
      kind: 'original',
      title: 'Original',
      content: 'Trashed secret quantum content.',
    });
    store.lectureTrash(trash.id);
    const retrieval = new LocalRetrieval(store),
      keys = retrieval.sync({ scope: 'subject', subjectId: subject.id, lectureIds: [], materialIds: [] });
    expect(keys).toEqual([`lecture:${a.id}`]);
    expect(retrieval.retrieve(keys, 'Квантовая')[0].source.lectureId).toBe(a.id);
    expect(
      retrieval
        .all(keys)
        .map((p) => p.text)
        .join(''),
    ).not.toContain('forbidden');
    expect(
      retrieval
        .all(keys)
        .map((p) => p.text)
        .join(''),
    ).not.toContain('secret');
  });
  it('provides only selected passages and enables web tools solely in web mode', async () => {
    const { store, provider, service } = fixture(),
      a = store.lectureCreate({ title: 'Selected' }),
      b = store.lectureCreate({ title: 'Unselected' });
    store.versionSave({
      lectureId: a.id,
      kind: 'original',
      title: 'Original',
      content: 'Scoped quantum lecture.',
    });
    store.versionSave({
      lectureId: b.id,
      kind: 'original',
      title: 'Original',
      content: 'Secret unselected material.',
    });
    provider.textImpl = async () => 'The selected lecture discusses quantum physics. [S1]';
    const context = { scope: 'lecture' as const, lectureIds: [a.id], subjectId: null, materialIds: [] };
    const strict = store.conversationCreate(context, 'strict');
    service.start();
    const answer = await service.chatSend({ conversationId: strict.id, message: 'What is quantum?' });
    expect(provider.textCalls[0].input).toContain('Scoped quantum');
    expect(provider.textCalls[0].input).not.toContain('Secret unselected');
    expect(provider.textCalls[0].web).toBe(false);
    expect(answer.sources[0].lectureId).toBe(a.id);
    expect(store.messages(strict.id)).toHaveLength(2);
    const web = store.conversationCreate(context, 'web');
    await service.chatSend({ conversationId: web.id, message: 'Compare with current findings.' });
    expect(provider.textCalls.at(-1)?.web).toBe(true);
  });
});

describe('provider contracts and critical pure logic', () => {
  it('uses current speech model language fields: selected language + English, strict retries', () => {
    const live = transcriptionSettings('gpt-live-transcribe', 'uk', 'Term, Name', true);
    expect(live).toMatchObject({ languages: ['uk', 'en'], delay: 'medium', keywords: ['Term', 'Name'] });
    expect(live).not.toHaveProperty('language');
    expect(String(live.prompt)).toContain('Університетська лекція українською мовою.');
    expect(String(live.prompt)).toContain('англійські терміни');
    const strict = transcriptionSettings('gpt-transcribe', 'uk', '', false, true, 'Попередній текст.');
    expect(strict).toMatchObject({ languages: ['uk'] });
    expect(String(strict.prompt)).not.toContain('англійські');
    expect(String(strict.prompt)).not.toContain('Попередній текст.');
    const file = transcriptionSettings('gpt-transcribe', 'ru', 'Энтропия', false, false, 'Предыдущий текст.');
    expect(String(file.prompt)).toContain('Термины: Энтропия');
    expect(String(file.prompt)).toContain('Предыдущий текст.');
    expect(transcriptionSettings('gpt-transcribe', 'en', '')).toMatchObject({ languages: ['en'] });
    expect(transcriptionSettings('gpt-4o-transcribe', 'pl', '')).toMatchObject({ language: 'pl' });
    expect(transcriptionSettings('gpt-4o-transcribe', 'pl', '')).not.toHaveProperty('languages');
    expect(String(transcriptionSettings('whisper-1', 'pl', 'x'.repeat(2000)).prompt).length).toBeLessThanOrEqual(650);
    expect(realtimeSession('gpt-live-transcribe', 'pl', '', 'local').session.audio.input.turn_detection).toBe(null);
    expect(realtimeSession('gpt-4o-transcribe', 'pl', '', 'server', 'semantic', 'session_w')).toMatchObject({
      event_id: 'session_w',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-transcribe', language: 'pl' },
            turn_detection: { type: 'semantic_vad', eagerness: 'low' },
          },
        },
      },
    });
    expect(realtimeSession('gpt-4o-transcribe', 'pl', '', 'server', 'server').session.audio.input.turn_detection).toEqual(
      { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 },
    );
  });
  it('uploads in-memory range audio with plural languages and no temporary file', async () => {
    let form: FormData | undefined;
    const fetcher = (async (_: any, options: any) => {
      form = options.body;
      return new Response(JSON.stringify({ text: 'Tekst', languages: [{ code: 'pl' }] }), { status: 200 });
    }) as typeof fetch;
    const audio = Buffer.concat([wavHeader(4800), tone(100)]);
    const result = await new OpenAIProvider(() => 'fake-key', fetcher).transcribe(
      { model: 'gpt-transcribe', audio, language: 'pl', glossary: '', context: '', strict: true },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ text: 'Tekst', languages: [{ code: 'pl' }] });
    expect(form!.getAll('languages[]')).toEqual(['pl']);
    expect(form!.get('language')).toBe(null);
    expect(Buffer.from(await (form!.get('file') as Blob).arrayBuffer())).toEqual(audio);
  });
  it('disables provider response storage and extracts text and safe web citations', async () => {
    let captured: any;
    const fetcher = (async (_: any, options: any) => {
      captured = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Answer',
                  annotations: [
                    { type: 'url_citation', url: 'https://example.org/source', title: 'Source' },
                    { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
                  ],
                },
              ],
            },
          ],
          usage: { output_tokens: 4 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await new OpenAIProvider(() => 'fake-key', fetcher).text(
      { model: 'gpt-6.1-sol', instructions: 'Instructions', input: 'Source', web: true },
      new AbortController().signal,
    );
    expect(captured.store).toBe(false);
    expect(captured.tools).toEqual([{ type: 'web_search' }]);
    expect(result.text).toBe('Answer');
    expect(result.sources).toEqual([{ title: 'Source', url: 'https://example.org/source' }]);
  });
  it('backs off transient failures while preserving repeated lecturer words at independent boundaries', () => {
    expect(failureState(new APIError('rate', 429, 'rate_limit_exceeded', 30), 1, 100)).toMatchObject({
      status: 'queued',
      nextRun: 30100,
    });
    expect(failureState(new APIError('offline'), 50, 100)).toMatchObject({
      status: 'queued',
      nextRun: 120100,
    });
    expect(failureState(new APIError('auth', 401), 1, 100).status).toBe('error');
    expect(words('Український текст, русский текст, English, polski.')).toBe(6);
    const base = { id: '', lectureId: '', start: 0, end: 10, path: '', error: null };
    const turns = [
      { ...base, sequence: 1, start: 10, status: 'done', text: 'Repeat that.' },
      { ...base, sequence: 0, status: 'done', text: 'Repeat that.' },
    ] as Segment[];
    expect(orderedTranscript(turns).match(/Repeat that\./g)).toHaveLength(2);
    // Only text before the coverage frontier is final; later text waits even if it is already done.
    expect(finalizedUnits(transcriptUnits(turns), 10)).toHaveLength(2);
    expect(finalizedUnits(transcriptUnits(turns), 9.5)).toHaveLength(0);
    expect(finalizedUnits(transcriptUnits([{ ...turns[1], status: 'queued' }, turns[0]]), 0)).toHaveLength(0);
    expect(textSections('x'.repeat(42001)).map((s) => s.length)).toEqual([14000, 14000, 14000, 1]);
  });
});

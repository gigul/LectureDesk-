import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { Store } from '../src/main/store';
import { AIService } from '../src/main/ai';
import {
  APIError,
  OpenAIProvider,
  transcriptionSettings,
  type Provider,
  type TextRequest,
  type TranscribeRequest,
} from '../src/main/ai-provider';
import { failureState, finalizedPrefix, orderedTranscript, textSections, words } from '../src/main/ai-logic';
import { LocalRetrieval } from '../src/main/ai-retrieval';
import type { Segment } from '../src/shared/types';

// Separate test adapter: production contains no fixture transcripts or successful fake API calls.
class TestProvider implements Provider {
  textCalls: TextRequest[] = [];
  audioCalls: TranscribeRequest[] = [];
  textImpl: (request: TextRequest, signal: AbortSignal) => Promise<string> = async (r) =>
    `Result: ${r.input.slice(0, 100)}`;
  audioImpl: (request: TranscribeRequest, signal: AbortSignal) => Promise<string> = async (r) =>
    path.basename(r.path);
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

describe('durable AI processing', () => {
  it('runs at most two audio tasks and preserves sequence when responses finish out of order', async () => {
    const { store, provider, service } = fixture(),
      lecture = store.lectureCreate();
    const segments = [0, 1, 2, 3].map((n) => segment(store, lecture.id, n));
    const resolve = new Map<string, (text: string) => void>();
    provider.audioImpl = (request) => new Promise((r) => resolve.set(request.path, r));
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

describe('realtime reconciliation', () => {
  it('maps final responses by item ID, persists ordered text, and avoids ordinary file duplication', async () => {
    const { store, provider, service: unused } = fixture();
    unused.stop();
    const sockets: TestSocket[] = [],
      service = new AIService(
        store,
        () => 'test-secret',
        () => {},
        {
          provider,
          socketFactory: () => {
            const socket = new TestSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        },
      );
    cleanup.push(() => service.stop());
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    service.start();
    service.liveAppend(lecture.id, Buffer.alloc(480000));
    await until(() => sockets.length === 1);
    const socket = sockets[0];
    socket.emit('open');
    socket.event({ type: 'session.updated' });
    const one = segment(store, lecture.id, 0);
    service.liveCommit(lecture.id, one);
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'item-one', previous_item_id: null });
    service.liveAppend(lecture.id, Buffer.alloc(480000));
    const two = segment(store, lecture.id, 1);
    service.liveCommit(lecture.id, two);
    socket.event({ type: 'input_audio_buffer.committed', item_id: 'item-two', previous_item_id: 'item-one' });
    store.lectureSave({ id: lecture.id, status: 'ready' });
    service.liveStop(lecture.id);
    service.flush(lecture.id);
    socket.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-two',
      transcript: 'second live turn',
    });
    expect(store.lectureGet(lecture.id).versions).toHaveLength(0);
    socket.event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-one',
      transcript: 'first live turn',
    });
    await until(() => Boolean(store.lectureGet(lecture.id).versions.find((v) => v.kind === 'original')));
    expect(store.lectureGet(lecture.id).versions[0].content).toContain(
      '[0:00] first live turn\n\n[0:10] second live turn',
    );
    expect(provider.audioCalls).toHaveLength(0);
    expect(socket.sent.filter((e) => e.type === 'input_audio_buffer.commit')).toHaveLength(2);
    expect(socket.sent[0].session.audio.input.turn_detection).toBe(null);
  });
  it('keeps disconnected segments in the durable file queue', async () => {
    const { store, provider, service: unused } = fixture();
    unused.stop();
    const sockets: TestSocket[] = [],
      service = new AIService(
        store,
        () => 'test-secret',
        () => {},
        {
          provider,
          socketFactory: () => {
            const socket = new TestSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        },
      );
    cleanup.push(() => service.stop());
    const lecture = store.lectureCreate();
    service.start();
    service.liveAppend(lecture.id, Buffer.alloc(24000));
    await until(() => sockets.length === 1);
    sockets[0].emit('error', new Error('Network offline'));
    const saved = segment(store, lecture.id, 0);
    service.liveCommit(lecture.id, saved);
    await until(() => store.lectureGet(lecture.id).segments[0].status === 'done');
    expect(provider.audioCalls[0].path).toBe(saved.path);
    expect(store.tasks()[0].status).toBe('done');
  });
  it('renews idle sessions before new audio after 55 minutes and closes draining sockets on stop', async () => {
    const { store, provider, service: unused } = fixture();
    unused.stop();
    let now = Date.now();
    provider.audioImpl = (_, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Stopped file fallback')), { once: true }),
      );
    const sockets: TestSocket[] = [],
      service = new AIService(
        store,
        () => 'test-secret',
        () => {},
        {
          provider,
          now: () => now,
          socketFactory: () => {
            const socket = new TestSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          },
        },
      );
    cleanup.push(() => service.stop());
    const lecture = store.lectureCreate();
    store.lectureSave({ id: lecture.id, status: 'recording' });
    service.start();
    service.liveAppend(lecture.id, Buffer.alloc(480000));
    await until(() => sockets.length === 1);
    sockets[0].emit('open');
    sockets[0].event({ type: 'session.updated' });
    const s = segment(store, lecture.id, 0);
    service.liveCommit(lecture.id, s);
    sockets[0].event({ type: 'input_audio_buffer.committed', item_id: 'pending-item' });
    now += 55 * 60 * 1000 + 1;
    service.liveAppend(lecture.id, Buffer.alloc(12000));
    await until(() => sockets.length === 2);
    expect(sockets[0].readyState).toBe(1); // Pending final turns get a bounded drain, not lost audio.
    service.stop();
    expect(sockets.map((socket) => socket.readyState)).toEqual([3, 3]);
    expect(store.tasks().find((t) => t.payload.segmentId === s.id)?.status).toBe('queued');
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
  it('uses current speech model language fields and honest file timestamps', () => {
    expect(transcriptionSettings('gpt-live-transcribe', 'uk', 'Term, Name', true)).toMatchObject({
      languages: ['uk'],
      delay: 'medium',
      keywords: ['Term', 'Name'],
    });
    expect(transcriptionSettings('gpt-live-transcribe', 'auto', '', true)).not.toHaveProperty('language');
    expect(transcriptionSettings('gpt-4o-transcribe', 'pl', '')).toMatchObject({ language: 'pl' });
    expect(transcriptionSettings('gpt-4o-transcribe', 'pl', '')).not.toHaveProperty('languages');
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
    expect(finalizedPrefix([{ ...turns[1], status: 'queued' }, turns[0]])).toHaveLength(0);
    expect(textSections('x'.repeat(42001)).map((s) => s.length)).toEqual([14000, 14000, 14000, 1]);
  });
});

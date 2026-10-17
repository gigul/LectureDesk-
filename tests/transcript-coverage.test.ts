import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store';
import {
  ensureCoverage,
  mergeSpans,
  subtractSpans,
  turnFrontier,
  windowGaps,
  type CoverageTurn,
} from '../src/main/transcript-coverage';
import { finalizedUnits, renderTranscript, segmentAt, transcriptUnits, turnPolicy } from '../src/shared/transcript';
import type { Segment, TranscriptItem } from '../src/shared/types';

const s = (seconds: number) => seconds * 48000;
describe('coverage span arithmetic', () => {
  it('merges and subtracts byte spans', () => {
    expect(
      mergeSpans([
        { startByte: 10, endByte: 20 },
        { startByte: 0, endByte: 5 },
        { startByte: 18, endByte: 30 },
        { startByte: 30, endByte: 31 },
      ]),
    ).toEqual([
      { startByte: 0, endByte: 5 },
      { startByte: 10, endByte: 31 },
    ]);
    expect(
      subtractSpans(
        [{ startByte: 0, endByte: 100 }],
        [
          { startByte: 10, endByte: 20 },
          { startByte: 50, endByte: Number.POSITIVE_INFINITY },
        ],
      ),
    ).toEqual([
      { startByte: 0, endByte: 10 },
      { startByte: 20, endByte: 50 },
    ]);
  });
  it('advances the frontier only over a time-ordered prefix of finished turns', () => {
    const turns: CoverageTurn[] = [
      { startByte: s(1), endByte: s(3), status: 'done' },
      { startByte: s(5), endByte: s(8), status: 'pending' },
      { startByte: s(9), endByte: s(10), status: 'done' },
    ];
    expect(turnFrontier(turns, 0)).toBe(s(3));
    // Server turns can overlap by their prefix padding: never pass an unfinished turn's start.
    expect(
      turnFrontier(
        [
          { startByte: 0, endByte: s(4), status: 'done' },
          { startByte: s(3.8), endByte: null, status: 'speaking' },
        ],
        0,
      ),
    ).toBe(s(3.8));
    expect(turnFrontier([], s(7))).toBe(s(7));
  });
  it('leaves exactly the unconfirmed audio after the frontier as gaps, strict where language failed', () => {
    const turns: CoverageTurn[] = [
      { startByte: 0, endByte: s(4), status: 'done' },
      { startByte: s(4), endByte: s(9), status: 'failed', strict: true },
      { startByte: s(9), endByte: s(12), status: 'done' },
      { startByte: s(12), endByte: s(15), status: 'failed' },
      { startByte: s(15), endByte: s(15.1), status: 'silent' },
    ];
    const frontier = turnFrontier(turns, 0);
    expect(frontier).toBe(s(4));
    expect(windowGaps(turns, frontier, s(20))).toEqual([
      { startByte: s(4), endByte: s(9), strict: true },
      { startByte: s(12), endByte: s(15) },
      { startByte: s(15.1), endByte: s(20) },
    ]);
    // Slivers under 300 ms are not worth a request.
    expect(windowGaps([{ startByte: 0, endByte: s(10), status: 'done' }], s(10), s(10.2))).toEqual([]);
  });
});

describe('ledger reconciliation', () => {
  let directory = '';
  let store: Store | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it('adds one disk range for recorded audio that no window covered, idempotently', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'lecturedesk-coverage-'));
    store = new Store(directory);
    const lecture = store.lectureCreate();
    for (const sequence of [0, 1, 2])
      store.segmentSave({
        id: randomUUID(),
        lectureId: lecture.id,
        sequence,
        start: sequence * 10,
        end: sequence * 10 + 10,
        path: path.join(directory, `${sequence}.wav`),
        text: '',
        status: 'audio',
        error: null,
      });
    // A window covered 4 s – 12 s, then the app stopped streaming (cancelled windows still count).
    const window = store.taskAdd('transcribe-range', lecture.id, { startByte: s(4), endByte: s(12) });
    store.taskUpdate(window.id, { status: 'cancelled' });
    const added = ensureCoverage(store, lecture.id);
    expect(added.map((task) => [task.payload.startByte, task.payload.endByte])).toEqual([
      [0, s(4)],
      [s(12), s(30)],
    ]);
    expect(added[0].payload).toMatchObject({ origin: 'reconcile', livePending: false, language: 'ru' });
    expect(ensureCoverage(store, lecture.id)).toEqual([]);
    // An unclosed (crashed) window extends to the end of the audio.
    const other = store.lectureCreate();
    store.segmentSave({ ...store.lectureGet(lecture.id).segments[0], id: randomUUID(), lectureId: other.id });
    store.taskAdd('transcribe-range', other.id, { startByte: 0, endByte: null });
    expect(ensureCoverage(store, other.id)).toEqual([]);
  });
});

describe('shared transcript ordering', () => {
  const segment = (sequence: number, text: string, status: Segment['status'] = 'done'): Segment => ({
    id: `s${sequence}`,
    lectureId: 'l',
    sequence,
    start: sequence * 10,
    end: sequence * 10 + 10,
    path: `${sequence}.wav`,
    text,
    status,
    error: null,
  });
  const item = (key: string, start: number, text: string, status: TranscriptItem['status'] = 'done'): TranscriptItem => ({
    id: key,
    lectureId: 'l',
    start,
    end: start + 2,
    text,
    status,
    source: 'live',
    model: 'gpt-4o-transcribe',
    language: 'en',
    error: null,
    sourceKey: key,
    createdAt: '',
  });
  it('merges legacy segment text with items by start time and hides rejected items', () => {
    const units = transcriptUnits(
      [segment(0, 'Legacy first.'), segment(1, '', 'audio'), segment(2, 'Legacy third.')],
      [item('live:w:b', 13, 'Second turn.'), item('live:w:a', 11, 'First turn.'), item('range:t:0', 15, '中文', 'rejected')],
    );
    expect(renderTranscript(units)).toBe(
      '[0:00] Legacy first.\n\n[0:11] First turn.\n\n[0:13] Second turn.\n\n[0:20] Legacy third.',
    );
    expect(units.some((unit) => unit.status === 'rejected')).toBe(false);
    expect(
      transcriptUnits([], [item('range:t:0', 15, '中文', 'rejected')], { includeRejected: true })[0].status,
    ).toBe('rejected');
    expect(finalizedUnits(units, 13).map((unit) => unit.text)).toEqual(['Legacy first.', 'First turn.']);
  });
  it('maps lecture time to a playable segment and offset', () => {
    const segments = [segment(0, ''), segment(1, ''), { ...segment(2, ''), path: '' }];
    expect(segmentAt(segments, 12.5)).toMatchObject({ segment: { id: 's1' }, offset: 2.5 });
    expect(segmentAt(segments, 25)).toMatchObject({ segment: { id: 's1' }, offset: 10 });
    expect(segmentAt([], 3)).toBe(null);
  });
  it('selects the turn-detection policy by model family', () => {
    expect(turnPolicy('gpt-4o-transcribe')).toBe('server');
    expect(turnPolicy('gpt-4o-mini-transcribe-2025-12-15')).toBe('server');
    expect(turnPolicy('gpt-live-transcribe')).toBe('local');
    expect(turnPolicy('gpt-transcribe')).toBe('local');
  });
});

import type { Store } from './store';
import type { Task } from '../shared/types';
import { byteSpan } from './audio-range';

/**
 * Coverage ledger for new recordings. Every byte of recorded audio belongs to exactly one durable
 * `transcribe-range` task (one per realtime window, or a reconcile task for audio no window saw).
 * Pure span arithmetic lives here so the no-loss/no-duplicate rules can be unit tested.
 */
export type Span = { startByte: number; endByte: number };
export type CoverageGap = Span & { strict?: boolean };
export type CoverageTurn = {
  startByte: number;
  endByte: number | null;
  status: 'speaking' | 'pending' | 'done' | 'silent' | 'failed';
  strict?: boolean;
};
/** Gaps shorter than 300 ms (14,400 bytes) carry no transcribable speech. */
export const MIN_GAP_BYTES = 14400;

export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.endByte > s.startByte).sort((a, b) => a.startByte - b.startByte);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.startByte <= last.endByte) last.endByte = Math.max(last.endByte, span.endByte);
    else merged.push({ startByte: span.startByte, endByte: span.endByte });
  }
  return merged;
}

export function subtractSpans(base: Span[], remove: Span[]): Span[] {
  const cuts = mergeSpans(remove);
  const result: Span[] = [];
  for (const span of mergeSpans(base)) {
    let cursor = span.startByte;
    for (const cut of cuts) {
      if (cut.endByte <= cursor || cut.startByte >= span.endByte) continue;
      if (cut.startByte > cursor) result.push({ startByte: cursor, endByte: cut.startByte });
      cursor = Math.max(cursor, cut.endByte);
      if (cursor >= span.endByte) break;
    }
    if (cursor < span.endByte) result.push({ startByte: cursor, endByte: span.endByte });
  }
  return result;
}

const finished = (turn: CoverageTurn) => turn.status === 'done' || turn.status === 'silent';

/**
 * End of the longest time-ordered prefix of finished (done or silent) turns, but never past the
 * start of the first unfinished turn (server turns may overlap by their prefix padding).
 */
export function turnFrontier(turns: CoverageTurn[], startByte: number): number {
  let frontier = startByte;
  for (const turn of [...turns].sort((a, b) => a.startByte - b.startByte)) {
    if (!finished(turn) || turn.endByte === null) return Math.max(startByte, Math.min(frontier, turn.startByte));
    frontier = Math.max(frontier, turn.endByte);
  }
  return frontier;
}

/**
 * Audio of a closed realtime window that still needs disk transcription: [frontier, end) minus the
 * spans of finished turns. Before the frontier, audio between server-detected turns is trusted
 * silence. Parts overlapping a language-rejected turn are marked strict (retry without English).
 */
export function windowGaps(turns: CoverageTurn[], frontierByte: number, endByte: number): CoverageGap[] {
  const covered = turns
    .filter((turn) => finished(turn) && turn.endByte !== null)
    .map((turn) => ({ startByte: turn.startByte, endByte: turn.endByte! }));
  const strict = mergeSpans(
    turns
      .filter((turn) => turn.status === 'failed' && turn.strict && turn.endByte !== null)
      .map((turn) => ({ startByte: turn.startByte, endByte: turn.endByte! })),
  );
  const gaps: CoverageGap[] = [];
  for (const gap of subtractSpans([{ startByte: frontierByte, endByte }], covered)) {
    if (gap.endByte - gap.startByte < MIN_GAP_BYTES) continue;
    const plain = subtractSpans([gap], strict);
    const strictParts = subtractSpans([gap], plain);
    gaps.push(...plain, ...strictParts.map((part) => ({ ...part, strict: true })));
  }
  return gaps.sort((a, b) => a.startByte - b.startByte);
}

/** Byte span a range task accounts for; an unclosed window (crash) extends to the end of the audio. */
export function taskSpan(task: Task): Span {
  const start = Number(task.payload.startByte ?? 0);
  return {
    startByte: start,
    endByte:
      task.payload.endByte === null || task.payload.endByte === undefined
        ? Number.POSITIVE_INFINITY
        : Number(task.payload.endByte),
  };
}

/**
 * Adds a reconcile range task for every part of the lecture's recorded audio that no range task
 * covers (live transcription off, or a window that never opened). Cancelled tasks still count as
 * covered: cancelling is the user's decision. Idempotent through range dedupe keys.
 */
export function ensureCoverage(store: Store, lectureId: string): Task[] {
  const detail = store.lectureGet(lectureId);
  const audio = mergeSpans(detail.segments.filter((s) => s.status === 'audio' && s.path).map(byteSpan));
  if (!audio.length) return [];
  const covered = store
    .tasks()
    .filter((task) => task.lectureId === lectureId && task.kind === 'transcribe-range')
    .map(taskSpan);
  const holes = subtractSpans(audio, covered).filter((hole) => hole.endByte - hole.startByte >= 4800);
  if (!holes.length) return [];
  const settings = store.settings();
  const glossary = detail.lecture.subjectId
    ? ((
        store.db.prepare('SELECT glossary FROM subjects WHERE id=?').get(detail.lecture.subjectId) as
          | { glossary: string }
          | undefined
      )?.glossary ?? '')
    : '';
  return holes.map((hole) =>
    store.taskAdd(
      'transcribe-range',
      lectureId,
      {
        startByte: hole.startByte,
        endByte: hole.endByte,
        frontierByte: hole.startByte,
        origin: 'reconcile',
        livePending: false,
        model: settings.fileModel,
        language: settings.lectureLanguage,
        glossary,
      },
      `range:${lectureId}:${hole.startByte}:${hole.endByte}`,
    ),
  );
}

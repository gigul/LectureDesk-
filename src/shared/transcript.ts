import type { Segment, TranscriptItem } from './types';

/**
 * Pure transcript ordering shared by main and renderer. A lecture transcript is the time-ordered
 * merge of finalized transcript items (new recordings: one per speech turn or silence-split chunk)
 * and legacy per-segment text (older recordings and imported audio).
 */
export interface TranscriptUnit {
  id: string;
  start: number;
  end: number;
  text: string;
  kind: 'item' | 'segment';
  status: 'done' | 'rejected';
  error?: string | null;
  /** Tie-breaker for equal start times: segment sequence (zero-padded) or item source key. */
  order: string;
}

export function timeLabel(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return value >= 3600
    ? `${Math.floor(value / 3600)}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function transcriptUnits(
  segments: Segment[],
  items: TranscriptItem[] = [],
  options: { includeRejected?: boolean } = {},
): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  for (const segment of segments)
    if (segment.status === 'done' && segment.text)
      units.push({
        id: segment.id,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        kind: 'segment',
        status: 'done',
        order: `0:${String(segment.sequence).padStart(12, '0')}`,
      });
  for (const item of items)
    if (item.status === 'done' ? Boolean(item.text) : options.includeRejected)
      units.push({
        id: item.id,
        start: item.start,
        end: item.end,
        text: item.text,
        kind: 'item',
        status: item.status,
        error: item.error,
        order: `1:${item.sourceKey}`,
      });
  return units.sort((a, b) => a.start - b.start || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

/** "[m:ss] text" paragraphs; only finalized, accepted units belong in a transcript. */
export function renderTranscript(units: TranscriptUnit[]) {
  return units
    .filter((unit) => unit.status === 'done')
    .map((unit) => `[${timeLabel(unit.start)}] ${unit.text}`)
    .join('\n\n');
}

/** Units that end at or before the coverage frontier, i.e. text that can no longer change order. */
export function finalizedUnits(units: TranscriptUnit[], frontierSeconds: number) {
  return units.filter((unit) => unit.status === 'done' && unit.end <= frontierSeconds + 1e-9);
}

/** The playable audio segment containing `seconds`, and the offset inside it. */
export function segmentAt(segments: Segment[], seconds: number): { segment: Segment; offset: number } | null {
  const playable = [...segments].filter((s) => s.path !== '').sort((a, b) => a.start - b.start);
  if (!playable.length) return null;
  const segment =
    playable.find((s) => seconds >= s.start && seconds < s.end) ??
    [...playable].reverse().find((s) => s.start <= seconds) ??
    playable[0];
  return { segment, offset: Math.max(0, Math.min(seconds - segment.start, segment.end - segment.start)) };
}

/**
 * Turn-detection policy of a realtime transcription model.
 * 'server': OpenAI decides where phrases end (semantic_vad → server_vad fallback).
 * 'local': the model requires turn_detection null; LectureDesk commits at pauses it detects itself.
 */
export function turnPolicy(model: string): 'server' | 'local' {
  return ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'].some(
    (base) => model === base || model.startsWith(`${base}-`),
  )
    ? 'server'
    : 'local';
}

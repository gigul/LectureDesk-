import { createHash } from 'node:crypto';
import type { Segment, TranscriptItem } from '../shared/types';
import { renderTranscript, timeLabel, transcriptUnits, finalizedUnits } from '../shared/transcript';
import { APIError } from './ai-provider';

export { timeLabel, finalizedUnits };
export const words = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
export const sentenceComplete = (text: string) => /[.!?…。！？][\s\p{Pe}"'»”]*$/u.test(text.trim());
export const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
/**
 * Finalized transcript text in time order: accepted transcript items merged with legacy segment
 * text. For segment-only (legacy) lectures the output is identical to the per-segment format.
 */
export function orderedTranscript(segments: Segment[], items: TranscriptItem[] = []) {
  return renderTranscript(transcriptUnits(segments, items));
}
/** No heuristic boundary deletion: independent, non-overlapping files preserve genuine repetitions. */
export function textSections(text: string, limit = 14000) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let split = rest.lastIndexOf('\n\n', limit);
    if (split < limit / 2) {
      const match = [...rest.slice(0, limit).matchAll(/[.!?…]\s+/g)].at(-1);
      split =
        match && match.index! > limit / 2 ? match.index! + match[0].length : rest.lastIndexOf(' ', limit);
    }
    if (split < limit / 2) split = limit;
    chunks.push(rest.slice(0, split).trim());
    rest = rest.slice(split).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}
export function failureState(error: unknown, attempts: number, now = Date.now()) {
  const e =
    error instanceof APIError
      ? error
      : new APIError(error instanceof Error ? error.message : 'AI request failed.', 400, 'local_error');
  if (e.code === 'insufficient_quota' || e.code === 'billing_hard_limit_reached')
    return { status: 'quota' as const, nextRun: 0, error: e.message };
  const transient = !e.status || e.status === 408 || e.status === 429 || e.status >= 500;
  if (transient && (!e.status || attempts < 5))
    return {
      status: 'queued' as const,
      nextRun: now + Math.max(e.retryAfter * 1000, Math.min(120000, 2000 * 2 ** Math.min(6, attempts - 1))),
      error: e.message,
    };
  return { status: 'error' as const, nextRun: 0, error: e.message };
}

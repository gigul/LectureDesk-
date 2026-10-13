import { createHash } from 'node:crypto';
import type { Segment } from '../shared/types';
import { APIError } from './ai-provider';

export const words = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
export const sentenceComplete = (text: string) => /[.!?…。！？][\s\p{Pe}"'»”]*$/u.test(text.trim());
export const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function timeLabel(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return value >= 3600
    ? `${Math.floor(value / 3600)}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
export function orderedTranscript(segments: Segment[]) {
  return [...segments]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((s) => s.status === 'done')
    .map((s) => `[${timeLabel(s.start)}] ${s.text}`)
    .join('\n\n');
}
export function finalizedPrefix(segments: Segment[]) {
  const result: Segment[] = [];
  for (const segment of [...segments].sort((a, b) => a.sequence - b.sequence)) {
    if (segment.status !== 'done') break;
    result.push(segment);
  }
  return result;
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

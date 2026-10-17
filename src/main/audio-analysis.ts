/**
 * Pure speech/silence analysis of 24 kHz mono PCM16 (no I/O). All decision logic used to place
 * realtime commits and disk transcription boundaries lives here so it can be unit tested.
 * Thresholds are starting points; they still need tuning on real lecture recordings.
 */
export const FRAME_MS = 20;
export const BYTES_PER_MS = 48;
/** 20 ms of 24 kHz 16-bit mono audio. */
export const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;
const SILENT_DB = -100;

function samples(pcm: Buffer): Int16Array {
  const length = pcm.length >> 1;
  if (pcm.byteOffset % 2 === 0) return new Int16Array(pcm.buffer, pcm.byteOffset, length);
  const copy = new Int16Array(length);
  for (let index = 0; index < length; index++) copy[index] = pcm.readInt16LE(index * 2);
  return copy;
}
function rmsDb(view: Int16Array, from: number, to: number): number {
  if (to <= from) return SILENT_DB;
  let sum = 0;
  for (let index = from; index < to; index++) sum += view[index] * view[index];
  const rms = Math.sqrt(sum / (to - from));
  return rms <= 0 ? SILENT_DB : Math.max(SILENT_DB, 20 * Math.log10(rms / 32768));
}

/** RMS level of one frame in dBFS (digital silence = -100). */
export function frameLevel(pcm: Buffer, start = 0, end = pcm.length): number {
  return rmsDb(samples(pcm.subarray(start, end)), 0, (end - start) >> 1);
}

/** Per-frame levels; a trailing partial frame is measured over the samples it has. */
export function frameLevels(pcm: Buffer): Float32Array {
  const view = samples(pcm),
    perFrame = FRAME_BYTES / 2;
  const count = Math.ceil(view.length / perFrame);
  const levels = new Float32Array(count);
  for (let frame = 0; frame < count; frame++)
    levels[frame] = rmsDb(view, frame * perFrame, Math.min(view.length, (frame + 1) * perFrame));
  return levels;
}

/** Speech threshold for a recording: 20th percentile (room floor) + 10 dB, clamped to [-50, -30]. */
export function adaptiveThreshold(levels: ArrayLike<number>): number {
  if (!levels.length) return -40;
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(0.2 * (sorted.length - 1))];
  return Math.min(-30, Math.max(-50, floor + 10));
}

export function speechStats(levels: ArrayLike<number>, threshold: number, from = 0, to = levels.length) {
  let voiced = 0,
    first = -1,
    last = -1;
  for (let frame = from; frame < to; frame++)
    if (levels[frame] > threshold) {
      voiced++;
      if (first < 0) first = frame;
      last = frame;
    }
  return { voicedMs: voiced * FRAME_MS, firstVoicedFrame: first, lastVoicedFrame: last };
}

/**
 * Streaming voice-activity tracker for the realtime path. Frames are aligned to the first byte
 * pushed; a remainder smaller than one frame is carried to the next slice. The noise floor follows
 * quiet frames immediately and rises by at most 0.5 dB per second, so speech cannot raise it.
 */
export class SilenceTracker {
  floorDb: number | null = null;
  trailingSilentMs = 0;
  turnVoicedMs = 0;
  firstVoicedByte: number | null = null;
  lastVoicedByte: number | null = null;
  private remainder = Buffer.alloc(0);
  private remainderStart = 0;
  get threshold() {
    return Math.min(-30, Math.max(-50, (this.floorDb ?? -60) + 10));
  }
  push(pcm: Buffer, offset: number) {
    let data = pcm,
      start = offset;
    if (this.remainder.length && this.remainderStart + this.remainder.length === offset) {
      data = Buffer.concat([this.remainder, pcm]);
      start = this.remainderStart;
    }
    let index = 0;
    for (; index + FRAME_BYTES <= data.length; index += FRAME_BYTES)
      this.frame(frameLevel(data, index, index + FRAME_BYTES), start + index);
    this.remainder = Buffer.from(data.subarray(index));
    this.remainderStart = start + index;
  }
  private frame(level: number, byte: number) {
    if (this.floorDb === null || level < this.floorDb) this.floorDb = level;
    else this.floorDb = Math.min(level, this.floorDb + (0.5 * FRAME_MS) / 1000);
    if (level > this.threshold) {
      this.trailingSilentMs = 0;
      this.turnVoicedMs += FRAME_MS;
      this.firstVoicedByte ??= byte;
      this.lastVoicedByte = byte + FRAME_BYTES;
    } else this.trailingSilentMs += FRAME_MS;
  }
  /** Starts a new turn; the noise floor and the trailing-silence run carry over. */
  resetTurn() {
    this.turnVoicedMs = 0;
    this.firstVoicedByte = null;
    this.lastVoicedByte = null;
  }
}

/**
 * Local commit policy (models without server turn detection): commit only inside a pause, and
 * accept shorter pauses as the open turn grows. Never at fixed audio-length marks except the
 * 90 s safety bound for speech without any measurable pause.
 */
export function shouldCommit(turnMs: number, trailingSilentMs: number): boolean {
  return (
    (turnMs >= 6000 && trailingSilentMs >= 500) ||
    (turnMs >= 20000 && trailingSilentMs >= 250) ||
    (turnMs >= 40000 && trailingSilentMs >= 100) ||
    turnMs >= 90000
  );
}

/**
 * Whether a detached (failed) realtime window may be cut so a new connection can start: the cut
 * must land in silence; after five minutes a short pause is enough, after fifteen any point is.
 */
export function cutAllowed(detachedMs: number, trailingSilentMs: number): boolean {
  return (
    trailingSilentMs >= 300 ||
    (detachedMs >= 5 * 60000 && trailingSilentMs >= 100) ||
    detachedMs >= 15 * 60000
  );
}

export interface PlannedChunk {
  startByte: number;
  endByte: number;
  /** Silent chunks are never sent to the provider. */
  silent: boolean;
  voicedMs: number;
  strict?: boolean;
}

/**
 * Splits a disk range into transcription requests only at pauses: the pause midpoint closest to the
 * target length within [0.5·target, max], otherwise the quietest frame in the last 30 s before max.
 * Non-silent chunks are trimmed to their speech plus padding; chunks with too little speech are
 * marked silent. Byte positions are absolute (baseByte + frame offset) and even.
 */
export function planChunks(
  levels: ArrayLike<number>,
  baseByte: number,
  options: {
    targetMs?: number;
    maxMs?: number;
    minPauseMs?: number;
    padMs?: number;
    minVoicedMs?: number;
    totalBytes?: number;
    threshold?: number;
  } = {},
): PlannedChunk[] {
  const o = { targetMs: 180000, maxMs: 285000, minPauseMs: 250, padMs: 300, minVoicedMs: 400, ...options };
  const count = levels.length;
  const totalBytes = o.totalBytes ?? count * FRAME_BYTES;
  if (!count || totalBytes <= 0) return [];
  const threshold = o.threshold ?? adaptiveThreshold(levels);
  const target = Math.round(o.targetMs / FRAME_MS),
    max = Math.max(1, Math.round(o.maxMs / FRAME_MS)),
    minPause = Math.max(1, Math.ceil(o.minPauseMs / FRAME_MS)),
    pad = Math.round(o.padMs / FRAME_MS);
  const midpoints: number[] = [];
  let run = 0;
  for (let frame = 0; frame <= count; frame++) {
    if (frame < count && !(levels[frame] > threshold)) {
      run++;
      continue;
    }
    if (run >= minPause) midpoints.push(frame - Math.floor(run / 2));
    run = 0;
  }
  const bounds = [0];
  let cursor = 0;
  while (count - cursor > max) {
    const low = cursor + Math.ceil(target / 2),
      high = cursor + max,
      goal = cursor + target;
    let best = -1;
    for (const mid of midpoints)
      if (mid >= low && mid <= high && (best < 0 || Math.abs(mid - goal) < Math.abs(best - goal))) best = mid;
    if (best < 0) {
      // Continuous sound: cut at the quietest frame of the last 30 s before the maximum length.
      for (let frame = Math.max(cursor + 1, high - 1500); frame < high; frame++)
        if (best < 0 || levels[frame] < levels[best]) best = frame;
    }
    bounds.push(best);
    cursor = best;
  }
  bounds.push(count);
  const end = baseByte + totalBytes;
  const chunks: PlannedChunk[] = [];
  for (let index = 0; index + 1 < bounds.length; index++) {
    const from = bounds[index],
      to = bounds[index + 1];
    const stats = speechStats(levels, threshold, from, to);
    const silent = stats.voicedMs < o.minVoicedMs;
    const first = silent ? from : Math.max(from, stats.firstVoicedFrame - pad),
      last = silent ? to : Math.min(to, stats.lastVoicedFrame + 1 + pad);
    const startByte = Math.min(end, baseByte + first * FRAME_BYTES),
      endByte = Math.min(end, baseByte + last * FRAME_BYTES);
    if (endByte > startByte) chunks.push({ startByte, endByte, silent, voicedMs: stats.voicedMs });
  }
  return chunks;
}

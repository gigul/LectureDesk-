import { describe, expect, it } from 'vitest';
import {
  FRAME_BYTES,
  SilenceTracker,
  adaptiveThreshold,
  cutAllowed,
  frameLevels,
  planChunks,
  shouldCommit,
  speechStats,
} from '../src/main/audio-analysis';

const ms = (value: number) => value * 48;
/** Square wave at -20 dBFS (RMS 3277). */
function noise(duration: number, amplitude = 3277) {
  const pcm = Buffer.alloc(ms(duration));
  for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(index % 2 ? amplitude : -amplitude, index * 2);
  return pcm;
}
const silence = (duration: number) => Buffer.alloc(ms(duration));

describe('speech level analysis', () => {
  it('measures dBFS per 20 ms frame including a trailing partial frame', () => {
    const levels = frameLevels(Buffer.concat([noise(40), silence(30)]));
    expect(levels).toHaveLength(4);
    expect(levels[0]).toBeCloseTo(-20, 1);
    expect(levels[1]).toBeCloseTo(-20, 1);
    expect(levels[2]).toBe(-100);
    expect(levels[3]).toBe(-100); // 10 ms remainder
    expect(FRAME_BYTES).toBe(960);
  });
  it('derives an adaptive threshold from the quiet floor, clamped to [-50, -30]', () => {
    expect(adaptiveThreshold(new Float32Array(100).fill(-100))).toBe(-50);
    expect(adaptiveThreshold(new Float32Array(100).fill(-45))).toBe(-35);
    expect(adaptiveThreshold(new Float32Array(100).fill(-10))).toBe(-30);
    const mixed = new Float32Array(100).fill(-20);
    mixed.fill(-70, 0, 30);
    expect(adaptiveThreshold(mixed)).toBe(-50);
    expect(speechStats(mixed, -50)).toEqual({ voicedMs: 1400, firstVoicedFrame: 30, lastVoicedFrame: 99 });
  });
  it('tracks trailing silence and voiced bytes across slices that split frames', () => {
    const tracker = new SilenceTracker();
    const pcm = Buffer.concat([silence(200), noise(500), silence(600)]);
    // Uneven slices (not multiples of a frame) at their lecture byte offsets.
    for (let offset = 0, size = 1234; offset < pcm.length; offset += size)
      tracker.push(pcm.subarray(offset, offset + size), 96000 + offset);
    expect(tracker.turnVoicedMs).toBe(500);
    expect(tracker.firstVoicedByte).toBe(96000 + ms(200));
    expect(tracker.lastVoicedByte).toBe(96000 + ms(700));
    expect(tracker.trailingSilentMs).toBeGreaterThanOrEqual(580);
    tracker.resetTurn();
    expect([tracker.turnVoicedMs, tracker.firstVoicedByte, tracker.lastVoicedByte]).toEqual([0, null, null]);
    tracker.push(noise(100), 96000 + pcm.length - (pcm.length % FRAME_BYTES) + FRAME_BYTES * 100);
    expect(tracker.trailingSilentMs).toBe(0);
  });
  it('keeps the noise floor below speech so a long monologue stays voiced', () => {
    const tracker = new SilenceTracker();
    tracker.push(Buffer.concat([silence(500), noise(60000)]), 0);
    expect(tracker.turnVoicedMs).toBe(60000);
    expect(tracker.trailingSilentMs).toBe(0);
  });
});

describe('commit and cut policies', () => {
  it('commits local turns only inside pauses, accepting shorter pauses as turns grow', () => {
    expect(shouldCommit(5900, 5000)).toBe(false);
    expect(shouldCommit(6000, 480)).toBe(false);
    expect(shouldCommit(6000, 500)).toBe(true);
    expect(shouldCommit(19000, 300)).toBe(false);
    expect(shouldCommit(20000, 250)).toBe(true);
    expect(shouldCommit(39000, 120)).toBe(false);
    expect(shouldCommit(40000, 100)).toBe(true);
    expect(shouldCommit(89000, 0)).toBe(false);
    expect(shouldCommit(90000, 0)).toBe(true);
  });
  it('cuts a failed window at silence; shorter pauses after 5 min, anywhere after 15 min', () => {
    expect(cutAllowed(1000, 280)).toBe(false);
    expect(cutAllowed(1000, 300)).toBe(true);
    expect(cutAllowed(4 * 60000, 120)).toBe(false);
    expect(cutAllowed(5 * 60000, 100)).toBe(true);
    expect(cutAllowed(14 * 60000, 0)).toBe(false);
    expect(cutAllowed(15 * 60000, 0)).toBe(true);
  });
});

describe('disk chunk planning', () => {
  const frames = (seconds: number) => Math.round((seconds * 1000) / 20);
  function speech(totalSeconds: number, pauses: [number, number][]) {
    const levels = new Float32Array(frames(totalSeconds)).fill(-20);
    for (const [from, to] of pauses) levels.fill(-90, frames(from), frames(to));
    return levels;
  }
  it('splits long speech at the pause closest to the target length, never past the maximum', () => {
    const levels = speech(600, [
      [100, 100.4],
      [170, 170.4],
      [200, 200.6],
      [400, 400.4],
    ]);
    const chunks = planChunks(levels, 480000);
    expect(chunks.map((c) => [(c.startByte - 480000) / 48000, (c.endByte - 480000) / 48000])).toEqual([
      [0, 170.2],
      [170.2, 400.2],
      [400.2, 600],
    ]);
    expect(chunks.every((c) => !c.silent && (c.endByte - c.startByte) / 48000 <= 285)).toBe(true);
    expect(chunks.every((c) => c.startByte % 2 === 0 && c.endByte % 2 === 0)).toBe(true);
  });
  it('falls back to the quietest frame of the last 30 s when there is no pause', () => {
    const levels = new Float32Array(frames(400)).fill(-20);
    levels[frames(270)] = -28; // slightly quieter frame inside [255 s, 285 s)
    const chunks = planChunks(levels, 0, { threshold: -30 });
    expect(chunks[0].endByte / 48000).toBe(270);
    expect(chunks[1].startByte / 48000).toBe(270);
  });
  it('marks chunks without enough speech silent and trims speech chunks to their voice plus padding', () => {
    const levels = new Float32Array(frames(20)).fill(-90);
    levels.fill(-20, frames(5), frames(8));
    const [chunk] = planChunks(levels, 0);
    expect(chunk).toMatchObject({ silent: false, voicedMs: 3000 });
    expect([chunk.startByte / 48000, chunk.endByte / 48000]).toEqual([4.7, 8.3]);
    const quiet = new Float32Array(frames(20)).fill(-90);
    quiet.fill(-20, frames(5), frames(5.3)); // a cough: 300 ms
    expect(planChunks(quiet, 0)).toEqual([{ startByte: 0, endByte: 960000, silent: true, voicedMs: 300 }]);
    expect(planChunks(new Float32Array(0), 0)).toEqual([]);
  });
  it('clamps the last chunk to the real byte length of a partial frame', () => {
    const levels = new Float32Array(3).fill(-20);
    expect(planChunks(levels, 100, { totalBytes: 2000, minVoicedMs: 0 })).toEqual([
      { startByte: 100, endByte: 2100, silent: false, voicedMs: 60 },
    ]);
  });
});

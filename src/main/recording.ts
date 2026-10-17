import {
  openSync,
  closeSync,
  writeSync,
  readSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  statfsSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import type { AudioMode, AppEvent, Segment } from '../shared/types';
import { wavHeader, BYTES_PER_SECOND, SEGMENT_SECONDS } from './audio-format';
import { ensureCoverage } from './transcript-coverage';

type Capture = {
  lectureId: string;
  mode: AudioMode;
  directory: string;
  fd: number | null;
  partial: string;
  bytes: number;
  sequence: number;
  start: number;
  chunk: number;
  paused: boolean;
  /** Lecture timeline position (bytes) of the next durable byte; continuous across pauses. */
  total: number;
};
export interface RecordingHooks {
  /** Durable PCM slice at lecture byte `offsetBytes` (live transcription stream). */
  append(lectureId: string, pcm: Buffer, offsetBytes: number): void;
  /** Recording paused after the pause tail was finalized. */
  pause(lectureId: string): void;
  end(lectureId: string): void;
  emit(event: AppEvent): void;
  wake(active: boolean): void;
}

/** A single bounded, disk-first capture. A crash can lose at most the audio batch in transit. */
export class RecordingService {
  private capture: Capture | null = null;
  constructor(
    private store: Store,
    private hooks: RecordingHooks,
  ) {}
  get active(): string | null {
    return this.capture?.lectureId ?? null;
  }
  start(lectureId: string, mode: AudioMode) {
    if (this.capture) throw new Error('A recording is already active');
    const detail = this.store.lectureGet(lectureId);
    if (detail.lecture.deletedAt) throw new Error('Restore this lecture before recording');
    if (detail.lecture.status !== 'ready')
      throw new Error('Finish importing or recover this lecture before recording');
    if (detail.segments.length || detail.versions.length)
      throw new Error('Create a new lecture to preserve this recording');
    const directory = join(this.store.root, 'audio', lectureId);
    mkdirSync(directory, { recursive: true });
    this.checkSpace(directory);
    this.capture = {
      lectureId,
      mode,
      directory,
      fd: null,
      partial: '',
      bytes: 0,
      sequence: 0,
      start: 0,
      chunk: 0,
      paused: false,
      total: 0,
    };
    try {
      this.store.lectureSave({ id: lectureId, status: 'recording' });
    } catch (error) {
      this.capture = null;
      throw error;
    }
    this.hooks.wake(true);
    this.hooks.emit({ type: 'changed', lectureId });
    return { lectureId };
  }
  chunk(lectureId: string, sequence: number, pcm: ArrayBuffer) {
    const c = this.require(lectureId);
    if (c.paused) throw new Error('Recording is paused');
    if (sequence < c.chunk) return { accepted: true, duplicate: true }; // acknowledged retry, never write twice
    if (sequence !== c.chunk) {
      this.store.gap(lectureId, c.start + c.bytes / BYTES_PER_SECOND, 'Missing audio batch');
      throw new Error('Audio batches arrived out of order');
    }
    const input = Buffer.from(pcm);
    if (!input.length || input.length > BYTES_PER_SECOND * 2 || input.length % 2)
      throw new Error('Invalid audio batch');
    try {
      if (c.chunk % 32 === 0) this.checkSpace(c.directory);
      let consumed = 0;
      while (consumed < input.length) {
        if (c.fd === null) {
          c.partial = join(
            c.directory,
            `${String(c.sequence).padStart(6, '0')}-${Math.round(c.start * 1000)}.pcm.part`,
          );
          c.fd = openSync(c.partial, 'wx', 0o600);
        }
        const length = Math.min(input.length - consumed, BYTES_PER_SECOND * SEGMENT_SECONDS - c.bytes);
        const slice = input.subarray(consumed, consumed + length);
        let written = 0;
        while (written < length) written += writeSync(c.fd, slice, written, length - written);
        fsyncSync(c.fd);
        c.bytes += length;
        consumed += length;
        const offset = c.total;
        c.total += length;
        // Append only durable bytes to the network; losing connectivity cannot affect the disk path.
        if (this.store.settings().liveTranscription) this.hooks.append(c.lectureId, slice, offset);
        if (c.bytes === BYTES_PER_SECOND * SEGMENT_SECONDS) this.finalize(c);
      }
      c.chunk++;
      return { accepted: true, duration: c.start + c.bytes / BYTES_PER_SECOND };
    } catch (error) {
      this.interrupt(error instanceof Error ? error.message : 'Audio write failed');
      throw error;
    }
  }
  pause(lectureId: string) {
    const c = this.require(lectureId);
    if (c.paused) return;
    try {
      this.finalize(c);
      c.paused = true;
      this.store.gap(lectureId, c.start, 'Recording paused by user');
      this.store.lectureSave({ id: lectureId, status: 'paused', duration: c.start });
      this.hooks.emit({ type: 'changed', lectureId });
    } catch (error) {
      this.interrupt(error instanceof Error ? error.message : 'Could not finalize pause');
      throw error;
    }
    try {
      this.hooks.pause(lectureId);
    } catch {
      // Live transcription is optional; the disk fallback covers audio of an unclosed window.
    }
  }
  resume(lectureId: string) {
    const c = this.require(lectureId);
    c.paused = false;
    this.store.lectureSave({ id: lectureId, status: 'recording' });
    this.hooks.emit({ type: 'changed', lectureId });
  }
  stop(lectureId: string) {
    try {
      const c = this.require(lectureId);
      this.finalize(c);
      this.store.lectureSave({ id: lectureId, status: 'ready', duration: c.start });
      this.capture = null;
      this.hooks.wake(false);
      this.hooks.end(lectureId);
      this.hooks.emit({ type: 'changed', lectureId });
      return this.store.lectureGet(lectureId);
    } catch (error) {
      this.interrupt(error instanceof Error ? error.message : 'Could not finalize recording');
      throw error;
    }
  }
  interrupt(reason: string) {
    const c = this.capture;
    if (!c) return;
    try {
      if (c.fd !== null) {
        fsyncSync(c.fd);
        closeSync(c.fd);
        c.fd = null;
      }
    } catch {
      /* leave partial for recovery */
    }
    let message = reason;
    try {
      this.store.gap(c.lectureId, c.start + c.bytes / BYTES_PER_SECOND, reason);
    } catch {
      message += ' Database update failed; recover the audio saved on disk after freeing space.';
    }
    try {
      this.store.lectureSave({
        id: c.lectureId,
        status: 'interrupted',
        duration: c.start + c.bytes / BYTES_PER_SECOND,
      });
    } catch {
      if (message === reason)
        message += ' Database update failed; recover the audio saved on disk after freeing space.';
    } finally {
      this.capture = null;
      this.hooks.wake(false);
      try {
        this.hooks.end(c.lectureId);
      } catch {
        // Recovery schedules saved segments even when the task database cannot currently be written.
      }
      this.hooks.emit({ type: 'recording-gap', lectureId: c.lectureId, message });
    }
  }
  recover(lectureId: string) {
    if (this.active) throw new Error('Stop the active recording before recovery');
    const directory = join(this.store.root, 'audio', lectureId);
    const known = new Map(this.store.lectureGet(lectureId).segments.map((s) => [s.sequence, s]));
    if (existsSync(directory)) {
      const files = readdirSync(directory)
        .filter((f) => /^\d+-\d+\.(?:pcm\.part|wav)$/.test(f))
        .sort((a, b) => {
          const sequenceDifference = Number(a.split('-')[0]) - Number(b.split('-')[0]);
          return sequenceDifference || Number(a.endsWith('.pcm.part')) - Number(b.endsWith('.pcm.part'));
        });
      for (const name of files) {
        const match = /^(\d+)-(\d+)\.(pcm\.part|wav)$/.exec(name)!;
        const sequence = Number(match[1]);
        const start = Number(match[2]) / 1000;
        const file = join(directory, name);
        if (known.has(sequence)) {
          if (match[3] === 'pcm.part') {
            renameSync(file, `${file}.conflict`);
            this.store.gap(
              lectureId,
              start,
              'Retained a duplicate partial file for inspection; the finalized original was preserved.',
            );
          }
          continue;
        }
        const bytes = statSync(file).size - (match[3] === 'wav' ? 44 : 0);
        if (bytes <= 0) {
          if (match[3] !== 'wav') unlinkSync(file);
          continue;
        }
        if (match[3] === 'wav') {
          const fd = openSync(file, 'r');
          const header = Buffer.alloc(44);
          try {
            readSync(fd, header, 0, 44, 0);
          } finally {
            closeSync(fd);
          }
          if (!header.equals(wavHeader(bytes)))
            throw new Error('A saved audio segment is corrupt. The original file was preserved.');
        }
        const wav = match[3] === 'wav' ? file : this.toWav(file, bytes - (bytes % 2));
        const segment: Segment = {
          id: randomUUID(),
          lectureId,
          sequence,
          start,
          end: start + (bytes - (bytes % 2)) / BYTES_PER_SECOND,
          path: wav,
          text: '',
          status: 'audio',
          error: null,
        };
        this.store.segmentSave(segment);
        known.set(sequence, segment);
      }
    }
    // Segments of recordings made by earlier versions keep their per-segment transcription.
    for (const segment of known.values())
      if (segment.status !== 'done' && segment.status !== 'audio')
        this.store.taskAdd('transcribe', lectureId, { segmentId: segment.id }, `transcribe:${segment.id}`);
    // Recovered audio that no realtime window accounted for is transcribed from disk.
    ensureCoverage(this.store, lectureId);
    const duration = Math.max(0, ...[...known.values()].map((s) => s.end));
    this.store.lectureSave({ id: lectureId, status: 'ready', duration });
    this.store.gap(
      lectureId,
      duration,
      'Recovered after interrupted recording. Audio after the last durable batch may be absent.',
    );
    this.hooks.emit({ type: 'changed', lectureId });
    return this.store.lectureGet(lectureId);
  }
  private require(id: string) {
    if (!this.capture || this.capture.lectureId !== id)
      throw new Error('No active recording for this lecture');
    return this.capture;
  }
  private checkSpace(directory: string) {
    const s = statfsSync(directory);
    if (s.bavail * s.bsize < 32 * 1024 * 1024)
      throw new Error('Insufficient disk space. Recording saved; free space and recover it.');
  }
  private finalize(c: Capture) {
    if (c.fd === null || !c.bytes) return;
    fsyncSync(c.fd);
    closeSync(c.fd);
    c.fd = null;
    const wav = this.toWav(c.partial, c.bytes);
    const segment: Segment = {
      id: randomUUID(),
      lectureId: c.lectureId,
      sequence: c.sequence,
      start: c.start,
      end: c.start + c.bytes / BYTES_PER_SECOND,
      path: wav,
      text: '',
      // Audio backup and playback only: transcript text comes from the continuous stream or the
      // disk range fallback, never from fixed 10-second cuts.
      status: 'audio',
      error: null,
    };
    this.store.segmentSave(segment);
    c.start = segment.end;
    c.sequence++;
    c.bytes = 0;
    c.partial = '';
    this.store.lectureSave({ id: c.lectureId, duration: c.start });
    this.hooks.emit({ type: 'changed', lectureId: c.lectureId });
  }
  private toWav(partial: string, bytes: number) {
    const wav = partial.replace(/\.pcm\.part$/, '.wav');
    if (existsSync(wav))
      throw new Error('An original audio segment already exists; recover it before recording again.');
    const temp = `${wav}.writing`;
    if (existsSync(temp)) unlinkSync(temp);
    const source = openSync(partial, 'r');
    const target = openSync(temp, 'wx', 0o600);
    try {
      writeSync(target, wavHeader(bytes));
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < bytes) {
        const n = readSync(source, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (!n) throw new Error('Incomplete audio segment');
        let written = 0;
        while (written < n) written += writeSync(target, buffer, written, n - written);
        offset += n;
      }
      fsyncSync(target);
    } finally {
      closeSync(source);
      closeSync(target);
    }
    renameSync(temp, wav);
    unlinkSync(partial);
    return wav;
  }
}

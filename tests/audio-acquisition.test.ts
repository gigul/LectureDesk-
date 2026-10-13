import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioCapture } from '../src/renderer/audio/recorder';

// Test-only media devices. Real device/OS permission checks use scripts/capture-smoke.mjs.
function stream(audio = true) {
  const tracks = [audio ? 'audio' : 'video'].map((kind) => ({
    kind,
    readyState: 'live',
    onended: null,
    stop: vi.fn(function (this: { readyState: string }) {
      this.readyState = 'ended';
    }),
  }));
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  } as unknown as MediaStream;
}
function devices(display: () => Promise<MediaStream>, mic: () => Promise<MediaStream>) {
  const getDisplayMedia = vi.fn(display),
    getUserMedia = vi.fn(mic);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia, getUserMedia } });
  return { getDisplayMedia, getUserMedia };
}
afterEach(() => vi.unstubAllGlobals());
describe('audio acquisition lifecycle', () => {
  it('invokes the system picker synchronously before the microphone permission prompt', async () => {
    const order: string[] = [];
    const display = stream(),
      mic = stream();
    const device = devices(
      async () => {
        order.push('system');
        return display;
      },
      async () => {
        order.push('microphone');
        return mic;
      },
    );
    const capture = new AudioCapture();
    const preparing = capture.prepare('both', 'selected-device');
    expect(order).toEqual(['system']);
    expect(device.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    await preparing;
    expect(order).toEqual(['system', 'microphone']);
    await capture.stop();
    expect([...display.getTracks(), ...mic.getTracks()].every((track) => track.readyState === 'ended')).toBe(
      true,
    );
  });
  it('stops a previously granted system stream if microphone permission is denied', async () => {
    const display = stream();
    devices(
      async () => display,
      async () => {
        throw new Error('Permission denied');
      },
    );
    const capture = new AudioCapture();
    await expect(capture.prepare('both', '')).rejects.toThrow('Permission denied');
    expect(display.getTracks()[0].readyState).toBe('ended');
  });
  it('rejects and releases a screen stream that does not contain system audio', async () => {
    const display = stream(false);
    const device = devices(
      async () => display,
      async () => stream(),
    );
    await expect(new AudioCapture().prepare('both', '')).rejects.toThrow('live audio');
    expect(device.getUserMedia).not.toHaveBeenCalled();
    expect(display.getTracks()[0].readyState).toBe('ended');
  });
  it('releases late native-picker grants after an audio test is closed', async () => {
    const display = stream();
    let grant!: (value: MediaStream) => void;
    devices(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
      async () => stream(),
    );
    const capture = new AudioCapture();
    const preparing = capture.prepare('system', '');
    const rejection = expect(preparing).rejects.toThrow('cancelled');
    await capture.stop();
    grant(display);
    await rejection;
    expect(display.getTracks()[0].readyState).toBe('ended');
  });
  it('microphone mode never asks for screen sharing', async () => {
    const device = devices(
      async () => stream(),
      async () => stream(),
    );
    const capture = new AudioCapture();
    await capture.prepare('microphone', '');
    expect(device.getDisplayMedia).not.toHaveBeenCalled();
    expect(device.getUserMedia).toHaveBeenCalledTimes(1);
    await capture.stop();
  });
});

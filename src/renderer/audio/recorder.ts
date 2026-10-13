import type { AudioMode } from '../../shared/types';

export class AudioCapture {
  private context: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private worklet: AudioWorkletNode | null = null;
  private lectureId = '';
  private sequence = 0;
  private pending = 0;
  private draining: Promise<void> = Promise.resolve();
  private failed = false;
  private acknowledgements = new Map<number, () => void>();
  private acknowledgementId = 0;
  private error: (message: string) => void = () => {};
  private acquisitionGeneration = 0;
  private preparing = false;
  private prepared: { mode: AudioMode; deviceId: string } | null = null;
  async devices(): Promise<MediaDeviceInfo[]> {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  }
  async test(
    mode: AudioMode,
    deviceId: string,
    onLevel: (level: number) => void,
    onError: (message: string) => void = () => {},
  ): Promise<() => Promise<void>> {
    this.error = onError;
    await this.prepare(mode, deviceId);
    await this.open(mode, deviceId, onLevel, false);
    return () => this.stop();
  }
  // Invoke directly from the click handler: the system picker requires transient activation.
  // No IPC, microphone permission prompt, or AudioWorklet loading precedes getDisplayMedia.
  async prepare(mode: AudioMode, deviceId: string): Promise<void> {
    if (this.preparing || this.context || this.streams.length)
      throw new Error('Audio capture is already open');
    this.preparing = true;
    this.failed = false;
    const generation = ++this.acquisitionGeneration;
    const adopt = (stream: MediaStream) => {
      if (generation !== this.acquisitionGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('Audio capture setup was cancelled');
      }
      this.streams.push(stream);
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live'))
        throw new Error(
          'The selected source did not provide live audio. Enable audio sharing and the OS recording permission.',
        );
      for (const track of stream.getAudioTracks())
        track.onended = () => this.fail('An audio device disconnected or capture permission was revoked.');
    };
    try {
      if (mode === 'system' || mode === 'both') {
        adopt(await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }));
      }
      if (mode === 'microphone' || mode === 'both') {
        adopt(
          await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
              ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
              channelCount: 1,
              echoCancellation: mode === 'both',
              noiseSuppression: true,
              autoGainControl: false,
            },
          }),
        );
      }
      if (
        this.failed ||
        !this.streams.every((stream) => stream.getAudioTracks().some((track) => track.readyState === 'live'))
      )
        throw new Error('An audio source disconnected during setup. Try recording again.');
      this.prepared = { mode, deviceId };
    } catch (error) {
      if (generation === this.acquisitionGeneration) await this.close();
      throw error;
    } finally {
      this.preparing = false;
    }
  }
  async start(
    lectureId: string,
    mode: AudioMode,
    deviceId: string,
    onLevel: (level: number) => void,
    onError: (message: string) => void,
  ) {
    this.lectureId = lectureId;
    this.sequence = 0;
    this.error = onError;
    try {
      if (!this.prepared) await this.prepare(mode, deviceId);
      await this.open(mode, deviceId, onLevel, true);
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async pause() {
    await this.control('pause');
    await this.draining;
  }
  async resume() {
    await this.context?.resume();
    await this.control('resume');
  }
  async stop() {
    await this.control('pause');
    await this.draining;
    await this.close();
    this.lectureId = '';
    this.error = () => {};
    this.pending = 0;
  }
  private async open(mode: AudioMode, deviceId: string, onLevel: (level: number) => void, save: boolean) {
    if (this.context) throw new Error('Audio capture is already open');
    try {
      if (!this.prepared || this.prepared.mode !== mode || this.prepared.deviceId !== deviceId)
        throw new Error('Prepare the selected audio sources before starting capture');
      if (
        this.failed ||
        !this.streams.every((stream) => stream.getAudioTracks().some((track) => track.readyState === 'live'))
      )
        throw new Error('An audio source disconnected during setup. Try recording again.');
      for (const stream of this.streams) {
        for (const track of stream.getVideoTracks())
          await track.applyConstraints({ frameRate: 1 }).catch(() => {});
        stream.getVideoTracks().forEach((t) => {
          t.enabled = false;
        });
      }
      this.context = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
      if (this.context.sampleRate !== 24000)
        throw new Error('This device cannot initialize the required 24 kHz audio clock');
      await this.context.audioWorklet.addModule(new URL('../audio/pcm-worklet.js', import.meta.url).href);
      this.worklet = new AudioWorkletNode(this.context, 'lecturedesk-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;
      for (const stream of this.streams) {
        const audio = new MediaStream(stream.getAudioTracks());
        const source = this.context.createMediaStreamSource(audio);
        const gain = this.context.createGain();
        gain.gain.value = this.streams.length > 1 ? 0.5 : 1;
        source.connect(gain).connect(limiter);
        stream.getAudioTracks().forEach((t) => {
          t.onended = () => this.fail('An audio device disconnected or capture permission was revoked.');
        });
      }
      limiter.connect(this.worklet);
      // The worklet emits silence, which keeps processing alive without playing captured audio back.
      this.worklet.connect(this.context.destination);
      this.worklet.port.onmessage = ({
        data,
      }: MessageEvent<{ level?: number; pcm?: ArrayBuffer; ack?: number }>) => {
        if (typeof data.level === 'number') onLevel(data.level);
        if (typeof data.ack === 'number') {
          this.acknowledgements.get(data.ack)?.();
          this.acknowledgements.delete(data.ack);
        }
        if (!data.pcm || !save || this.failed) return;
        if (this.pending >= 16) {
          this.fail(
            'Disk saving is too slow. Recording stopped to keep memory bounded; recover the saved audio.',
          );
          return;
        }
        const pcm = data.pcm;
        const sequence = this.sequence++;
        this.pending++;
        this.draining = this.draining
          .then(async () => {
            if (this.failed) return;
            try {
              await window.lecturedesk.call('record.chunk', { lectureId: this.lectureId, sequence, pcm });
            } catch (e) {
              this.fail(e instanceof Error ? e.message : 'Could not save audio');
            }
          })
          .finally(() => {
            this.pending--;
          });
      };
      await this.context.resume();
      await this.control('resume');
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    this.worklet?.port.postMessage({ type: 'pause' });
    if (this.lectureId)
      void window.lecturedesk
        .call('record.gap', { lectureId: this.lectureId, reason: message })
        .catch(() => {});
    this.error(message);
  }
  private async control(type: 'pause' | 'resume') {
    if (!this.worklet) return;
    const id = ++this.acknowledgementId;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.acknowledgements.delete(id);
        resolve();
      }, 1500);
      this.acknowledgements.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      this.worklet!.port.postMessage({ type, id });
    });
  }
  private async close() {
    ++this.acquisitionGeneration;
    this.prepared = null;
    for (const stream of this.streams)
      stream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
    this.streams = [];
    this.worklet?.disconnect();
    this.worklet = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close();
    for (const acknowledge of this.acknowledgements.values()) acknowledge();
    this.acknowledgements.clear();
  }
}

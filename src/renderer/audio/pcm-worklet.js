// Chromium resamples all inputs into the same 24k AudioContext clock before this processor.
class LecturePCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(6000);
    this.length = 0;
    this.running = false;
    this.frames = 0;
    this.peak = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'pause') {
        this.flush();
        this.running = false;
      }
      if (data.type === 'resume') this.running = true;
      if (data.id) this.port.postMessage({ ack: data.id });
    };
  }
  flush() {
    if (!this.length) return;
    const buffer = this.samples.buffer.slice(0, this.length * 2);
    this.port.postMessage({ pcm: buffer }, [buffer]);
    this.length = 0;
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels && channels.length) {
      for (let i = 0; i < channels[0].length; i++) {
        let value = 0;
        for (const channel of channels) value += channel[i] || 0;
        value /= channels.length;
        this.peak = Math.max(this.peak, Math.abs(value));
        if (this.running) {
          value = Math.max(-1, Math.min(1, value));
          this.samples[this.length++] = Math.round(value * (value < 0 ? 32768 : 32767));
          if (this.length === this.samples.length) this.flush();
        }
      }
    }
    if (++this.frames >= 12) {
      this.port.postMessage({ level: this.peak });
      this.peak = 0;
      this.frames = 0;
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('lecturedesk-pcm', LecturePCM);

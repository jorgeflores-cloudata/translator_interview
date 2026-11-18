class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(240); this.offset = 0; this.energy = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      value = Math.max(-1, Math.min(1, value));
      this.samples[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.energy += value * value;
      if (this.offset === 240) {
        this.port.postMessage({pcm: this.samples.buffer, rms: Math.sqrt(this.energy / 240)}, [this.samples.buffer]);
        this.samples = new Int16Array(240); this.offset = 0; this.energy = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);

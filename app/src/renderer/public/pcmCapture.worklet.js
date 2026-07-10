/* global AudioWorkletProcessor, sampleRate, registerProcessor */

class RepGlassPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceSamples = [];
    this.outputSamples = [];
    this.readOffset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || channels[0].length === 0) return true;

    for (let index = 0; index < channels[0].length; index += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[index] || 0;
      this.sourceSamples.push(mono / channels.length);
    }

    const ratio = sampleRate / 24000;
    while (this.readOffset + 1 < this.sourceSamples.length) {
      const left = Math.floor(this.readOffset);
      const fraction = this.readOffset - left;
      const sample =
        this.sourceSamples[left] * (1 - fraction) +
        this.sourceSamples[left + 1] * fraction;
      this.outputSamples.push(Math.max(-1, Math.min(1, sample)));
      this.readOffset += ratio;
    }

    const consumed = Math.floor(this.readOffset);
    if (consumed > 0) {
      this.sourceSamples.splice(0, consumed);
      this.readOffset -= consumed;
    }

    const frameSize = 2400;
    while (this.outputSamples.length >= frameSize) {
      const frame = this.outputSamples.splice(0, frameSize);
      const pcm = new Int16Array(frameSize);
      let energy = 0;
      for (let index = 0; index < frameSize; index += 1) {
        const value = frame[index];
        energy += value * value;
        pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      this.port.postMessage(
        { pcm: pcm.buffer, rms: Math.sqrt(energy / frameSize), durationMs: 100 },
        [pcm.buffer],
      );
    }

    return true;
  }
}

registerProcessor('repglass-pcm-capture', RepGlassPcmCapture);

class SpectrumBeeperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.readOffset = 0;
    this.queuedSamples = 0;
    this.maxQueuedSamples = Math.round(sampleRate * 0.18);

    this.port.onmessage = (event) => {
      const block = event.data;
      if (!(block instanceof Float32Array) || block.length === 0) return;
      this.blocks.push(block);
      this.queuedSamples += block.length;

      // Keep latency bounded if the main thread is briefly delayed.
      while (this.queuedSamples > this.maxQueuedSamples && this.blocks.length > 1) {
        const removed = this.blocks.shift();
        this.queuedSamples -= removed.length - this.readOffset;
        this.readOffset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    output.fill(0);

    let written = 0;
    while (written < output.length && this.blocks.length > 0) {
      const block = this.blocks[0];
      const available = block.length - this.readOffset;
      const count = Math.min(available, output.length - written);
      output.set(block.subarray(this.readOffset, this.readOffset + count), written);
      written += count;
      this.readOffset += count;
      this.queuedSamples -= count;
      if (this.readOffset >= block.length) {
        this.blocks.shift();
        this.readOffset = 0;
      }
    }
    return true;
  }
}

registerProcessor('spectrum-beeper', SpectrumBeeperProcessor);

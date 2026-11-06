class SidStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.requestPending = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'audio' && event.data.samples instanceof Float32Array) {
        this.queue.push(event.data.samples);
        this.requestPending = false;
        if (this.queue.length > 8) this.queue.shift();
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    left.fill(0);
    if (right !== left) right.fill(0);
    let written = 0;
    while (written < left.length && this.queue.length) {
      const block = this.queue[0];
      const frames = Math.min(left.length - written, Math.floor((block.length - this.offset) / 2));
      for (let i = 0; i < frames; i++) {
        left[written + i] = block[(this.offset + i) * 2];
        right[written + i] = block[(this.offset + i) * 2 + 1];
      }
      written += frames;
      this.offset += frames * 2;
      if (this.offset >= block.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (this.queue.length < 3 && !this.requestPending) {
      this.requestPending = true;
      this.port.postMessage({ type: 'need-data' });
    }
    return true;
  }
}
registerProcessor('sid-stream', SidStreamProcessor);

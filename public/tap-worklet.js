// Source tap (spec §5.3): batches the input into 960-frame (20 ms) stereo blocks for the encoder,
// or for the calibration recorder. `frame` = audio-clock frame index of the block's first sample.
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 0;
    this.start = 0;
    this.l = new Float32Array(960);
    this.r = new Float32Array(960);
    this.port.onmessage = () => { this.n = 0; }; // reset at epoch start
  }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const L = ch[0], R = ch[1] || ch[0];
      for (let i = 0; i < L.length; i++) {
        if (this.n === 0) this.start = currentFrame + i;
        this.l[this.n] = L[i];
        this.r[this.n] = R[i];
        if (++this.n === 960) {
          this.port.postMessage({ frame: this.start, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);
          this.l = new Float32Array(960);
          this.r = new Float32Array(960);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("tap", Tap);

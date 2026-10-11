// Circular spectrum around the cover art. Breathes gently when idle; static under reduced motion.
const BARS = 84;

export class Visualizer {
  private raf = 0;
  private freq = new Uint8Array(0);
  private smooth = new Float32Array(BARS);
  private bins: [number, number][] = [];
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private canvas: HTMLCanvasElement, private analyser: AnalyserNode | null = null) {
    if (analyser) this.attach(analyser);
  }

  attach(a: AnalyserNode) {
    this.analyser = a;
    a.fftSize = 2048;
    a.smoothingTimeConstant = 0.78;
    this.freq = new Uint8Array(a.frequencyBinCount);
    // Log-spaced bands 50 Hz – 12 kHz, so bass and treble get fair space.
    const nyq = a.context.sampleRate / 2, n = a.frequencyBinCount;
    this.bins = Array.from({ length: BARS }, (_, i) => {
      const f0 = 50 * (12000 / 50) ** (i / BARS), f1 = 50 * (12000 / 50) ** ((i + 1) / BARS);
      return [Math.floor((f0 / nyq) * n), Math.max(Math.floor((f0 / nyq) * n) + 1, Math.ceil((f1 / nyq) * n))];
    });
  }

  start() {
    if (this.raf) return;
    const loop = () => { this.frame(); this.raf = this.reduced ? 0 : requestAnimationFrame(loop); };
    loop();
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  private frame() {
    const c = this.canvas, dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, r0 = Math.min(w, h) * 0.34, t = performance.now() / 1000;
    let energy = 0;
    if (this.analyser) this.analyser.getByteFrequencyData(this.freq);
    for (let i = 0; i < BARS; i++) {
      let v = 0;
      if (this.analyser && this.bins.length) {
        const [a, b] = this.bins[i];
        for (let k = a; k < b; k++) v = Math.max(v, this.freq[k] ?? 0);
        v = (v / 255) ** 1.6;
      }
      const idle = 0.06 + 0.04 * Math.sin(t * 1.6 + i * 0.35);
      const target = Math.max(v, this.reduced ? 0.08 : idle);
      this.smooth[i] += (target - this.smooth[i]) * (target > this.smooth[i] ? 0.5 : 0.12);
      energy += this.smooth[i];
    }
    energy /= BARS;
    // Ambient glow that swells with the music.
    const glow = g.createRadialGradient(cx, cy, r0 * 0.6, cx, cy, r0 * (1.5 + energy * 0.8));
    glow.addColorStop(0, `rgba(110, 242, 196, ${0.1 + energy * 0.25})`);
    glow.addColorStop(1, "rgba(110, 242, 196, 0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);
    g.lineCap = "round";
    g.lineWidth = Math.max(2, (2 * Math.PI * r0) / BARS * 0.42);
    for (let i = 0; i < BARS; i++) {
      const ang = (i / BARS) * Math.PI * 2 - Math.PI / 2, v = this.smooth[i];
      const len = r0 * (0.04 + v * 0.52), gap = r0 * 0.08;
      const x0 = cx + Math.cos(ang) * (r0 + gap), y0 = cy + Math.sin(ang) * (r0 + gap);
      const x1 = cx + Math.cos(ang) * (r0 + gap + len), y1 = cy + Math.sin(ang) * (r0 + gap + len);
      // Mint for most of the ring, warming to amber on loud bands.
      const hue = 160 - Math.min(1, v * 1.3) * 125;
      g.strokeStyle = `hsla(${hue}, 85%, ${62 + v * 10}%, ${0.35 + v * 0.65})`;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
  }
}

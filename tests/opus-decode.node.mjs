// Runs under Node (`node --test`): Bun 1.2.6's runtime corrupts opus-decoder's embedded WASM string
// (crc32 failure), while Node and Bun-bundled browser builds load it fine.
// Decodes real WebCodecs-encoded Opus packets (Chromium AudioEncoder, 440 Hz tone) with the WASM decoder
// every listener uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpusDecoder } from "opus-decoder";

test("WASM decoder decodes raw WebCodecs Opus packets incrementally", async () => {
  const b = readFileSync(new URL("./fixtures/opus-tone-440.bin", import.meta.url));
  const packets = [];
  for (let o = 0; o < b.length; ) { const n = (b[o] << 8) | b[o + 1]; packets.push(b.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  assert.equal(packets.length, 50);
  const dec = new OpusDecoder({ channels: 2 });
  await dec.ready;
  let rmsSum = 0, blocks = 0;
  for (let i = 0; i < packets.length; i += 5) {
    const r = dec.decodeFrames(packets.slice(i, i + 5));
    assert.equal(r.errors.length, 0);
    assert.equal(r.samplesDecoded, 4800);
    assert.equal(r.sampleRate, 48000);
    if (i >= 10) {
      const x = r.channelData[0];
      rmsSum += Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
      blocks++;
    }
  }
  const rms = rmsSum / blocks; // 0.5-amplitude sine → ≈ 0.354
  assert.ok(rms > 0.3 && rms < 0.4, `rms ${rms}`);
  dec.free();
});

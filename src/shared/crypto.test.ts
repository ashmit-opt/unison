import { expect, test } from "bun:test";
import { b64urlDecode, b64urlEncode, importRoomKey, newRoomKey, open, seal } from "./crypto.ts";
import { CHUNK_HEADER, chunkHeader, parseBinary } from "./protocol.ts";

const room = "abcdefghjk";
const plain = new TextEncoder().encode("PLAINTEXT-OPUS-PACKETS-".repeat(4));

async function sealed() {
  const key = await importRoomKey(newRoomKey());
  const msg = await seal(key, room, chunkHeader({ epoch: 1, seq: 7, t: 1000 }), plain);
  return { key, msg };
}
const parts = (m: Uint8Array) => ({ header: m.subarray(0, CHUNK_HEADER), body: m.subarray(CHUNK_HEADER) });

test("seal/open round trip and wire format parses", async () => {
  const { key, msg } = await sealed();
  const p = parseBinary(msg)!;
  expect(p).not.toBeNull();
  expect(await open(key, room, p.header, p.body)).toEqual(plain);
});

test("tampering, wrong room or wrong key is rejected", async () => {
  const { key, msg } = await sealed();
  const t1 = msg.slice(); t1[12] ^= 1; // header (t)
  expect(await open(key, room, parts(t1).header, parts(t1).body)).toBeNull();
  const t2 = msg.slice(); t2[t2.length - 20] ^= 1; // ciphertext
  expect(await open(key, room, parts(t2).header, parts(t2).body)).toBeNull();
  expect(await open(key, "zzzzzzzzzz", parts(msg).header, parts(msg).body)).toBeNull();
  const other = await importRoomKey(newRoomKey());
  expect(await open(other, room, parts(msg).header, parts(msg).body)).toBeNull();
});

test("ciphertext hides plaintext and IVs are unique", async () => {
  const key = await importRoomKey(newRoomKey());
  const h = chunkHeader({ epoch: 1, seq: 1, t: 1 });
  const a = await seal(key, room, h, plain), b = await seal(key, room, h, plain);
  expect(Buffer.from(a).includes(Buffer.from("PLAINTEXT"))).toBe(false);
  expect(Buffer.from(a.subarray(CHUNK_HEADER, CHUNK_HEADER + 12)).equals(Buffer.from(b.subarray(CHUNK_HEADER, CHUNK_HEADER + 12)))).toBe(false);
});

test("base64url", () => {
  const k = newRoomKey();
  const s = b64urlEncode(k);
  expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(b64urlDecode(s)).toEqual(k);
  expect(b64urlDecode("ab+c")).toBeNull();
  expect(() => importRoomKey(new Uint8Array(16))).toThrow();
});

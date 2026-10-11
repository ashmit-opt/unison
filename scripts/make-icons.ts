// Generates the PWA icons (concentric sound rings) as PNGs. Run once: bun scripts/make-icons.ts
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function png(size: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const BG: [number, number, number] = [15, 17, 21], FG: [number, number, number] = [124, 196, 255];
function rings(size: number, scale: number) {
  return png(size, (x, y) => {
    const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2) / scale;
    const on = r < 0.16 || (r > 0.32 && r < 0.42) || (r > 0.58 && r < 0.68) || (r > 0.84 && r < 0.94);
    return on ? FG : BG;
  });
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", rings(192, 1));
writeFileSync("public/icons/icon-512.png", rings(512, 1));
writeFileSync("public/icons/icon-maskable-512.png", rings(512, 0.75)); // keep inside the maskable safe zone
writeFileSync("public/icons/apple-touch-icon.png", rings(180, 0.85));
console.log("icons written");

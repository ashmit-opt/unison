// End-to-end sealing (spec §9, ADR-0004): AES-256-GCM, random 96-bit IV, AAD = room ‖ clear header.
import { IV_LEN } from "./protocol.ts";

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export const newRoomKey = () => crypto.getRandomValues(new Uint8Array(32));

export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("room key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(room: string, header: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = enc.encode(room), out = new Uint8Array(r.length + header.length);
  out.set(r);
  out.set(header, r.length);
  return out;
}

/** Returns header ‖ iv ‖ ciphertext+tag. */
export async function seal(key: CryptoKey, room: string, header: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(room, header) }, key, plaintext as Uint8Array<ArrayBuffer>),
  );
  const out = new Uint8Array(header.length + IV_LEN + ct.length);
  out.set(header);
  out.set(iv, header.length);
  out.set(ct, header.length + IV_LEN);
  return out;
}

/** Opens `body` (iv ‖ ciphertext+tag) authenticated against room + header. Null on any failure. */
export async function open(key: CryptoKey, room: string, header: Uint8Array, body: Uint8Array): Promise<Uint8Array | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: body.slice(0, IV_LEN), additionalData: aad(room, header) },
      key,
      body.slice(IV_LEN),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

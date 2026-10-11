// Local library (intent revision 2026-10-12): uploaded songs and playlists saved in this browser
// (IndexedDB). Nothing is sent to the server; it survives reloads and new rooms on this device.
import type { QItem } from "./queue.ts";

export type LibTrack = { id: string; name: string; size: number; type: string; addedAt: number; blob: Blob };
export type Playlist = { id: string; name: string; items: QItem[]; updatedAt: number };

let dbP: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("unison", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("tracks", { keyPath: "id" });
      req.result.createObjectStore("playlists", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbP = null; reject(req.error ?? new Error("Storage unavailable")); };
  });
  return dbP;
}

async function tx<T>(store: "tracks" | "playlists", mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = run(d.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const library = {
  /** Saves a file (deduplicated by name + size). */
  async addFile(f: File): Promise<LibTrack> {
    const existing = (await this.tracks()).find((t) => t.name === f.name && t.size === f.size);
    if (existing) return existing;
    const t: LibTrack = { id: crypto.randomUUID(), name: f.name, size: f.size, type: f.type, addedAt: Date.now(), blob: f };
    await tx("tracks", "readwrite", (s) => s.put(t));
    void navigator.storage?.persist?.(); // ask the browser not to evict the library
    return t;
  },
  tracks: (): Promise<LibTrack[]> => tx("tracks", "readonly", (s) => s.getAll() as IDBRequest<LibTrack[]>).then((a) => a.sort((x, y) => y.addedAt - x.addedAt)),
  track: (id: string): Promise<LibTrack | undefined> => tx("tracks", "readonly", (s) => s.get(id) as IDBRequest<LibTrack | undefined>),
  removeTrack: (id: string) => tx("tracks", "readwrite", (s) => s.delete(id)),
  playlists: (): Promise<Playlist[]> => tx("playlists", "readonly", (s) => s.getAll() as IDBRequest<Playlist[]>).then((a) => a.sort((x, y) => y.updatedAt - x.updatedAt)),
  savePlaylist: (p: Playlist) => tx("playlists", "readwrite", (s) => s.put(p)),
  removePlaylist: (id: string) => tx("playlists", "readwrite", (s) => s.delete(id)),
  async usage(): Promise<string> {
    const e = await navigator.storage?.estimate?.();
    return e?.usage ? `${(e.usage / 1e6).toFixed(1)} MB used on this device` : "";
  },
};

export const trackTitle = (name: string) => name.replace(/\.[a-z0-9]+$/i, "") || name;

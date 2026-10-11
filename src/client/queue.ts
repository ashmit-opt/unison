// Host-owned play queue (intent revision 2026-10-12). Pure logic; the UI and playback live in views/host.ts.
import type { QueueView } from "../shared/protocol.ts";

export type QItem = {
  id: string;
  source: "audius" | "file";
  title: string;
  artist?: string;
  art?: string;
  durationS?: number;
  audiusId?: string; // source = audius
  fileId?: string; // source = file (local library id)
  url?: string; // link back to the artist page (Audius credit)
  by?: string; // who requested it (guest name)
};

export const newId = () => crypto.randomUUID();

export class Queue {
  items: QItem[] = [];
  current: QItem | null = null;

  add(item: QItem) {
    if (!this.items.some((i) => i.id === item.id)) this.items.push(item);
  }

  remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
  }

  /** Move an upcoming item up (−1) or down (+1). */
  move(id: string, delta: -1 | 1) {
    const i = this.items.findIndex((x) => x.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= this.items.length) return;
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
  }

  /** Advance: the first upcoming item becomes current. */
  next(): QItem | null {
    this.current = this.items.shift() ?? null;
    return this.current;
  }

  /** Play something right now (taking it out of the upcoming list if it was there). */
  playNow(item: QItem) {
    this.remove(item.id);
    this.current = item;
  }

  clear() { this.items = []; }

  has(audiusId: string) {
    return this.current?.audiusId === audiusId || this.items.some((i) => i.audiusId === audiusId);
  }

  /** What listeners see (no file data, capped). */
  view(): { now?: QueueView; next: QueueView[] } {
    const v = (i: QItem): QueueView => ({ title: i.title.slice(0, 200), artist: i.artist?.slice(0, 200), art: i.art, by: i.by });
    return { now: this.current ? v(this.current) : undefined, next: this.items.slice(0, 30).map(v) };
  }
}

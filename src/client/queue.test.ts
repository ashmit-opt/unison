import { expect, test } from "bun:test";
import { Queue, type QItem } from "./queue.ts";

const item = (id: string, extra: Partial<QItem> = {}): QItem => ({ id, source: "audius", title: `Song ${id}`, audiusId: `a${id}`, ...extra });

test("add, reorder, remove, advance", () => {
  const q = new Queue();
  ["1", "2", "3"].forEach((i) => q.add(item(i)));
  q.add(item("2")); // duplicates ignored
  expect(q.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
  q.move("3", -1);
  expect(q.items.map((i) => i.id)).toEqual(["1", "3", "2"]);
  q.move("1", -1); // already first: no-op
  q.remove("3");
  expect(q.next()?.id).toBe("1");
  expect(q.current?.id).toBe("1");
  expect(q.items.map((i) => i.id)).toEqual(["2"]);
  expect(q.next()?.id).toBe("2");
  expect(q.next()).toBeNull();
});

test("play now takes the item out of the upcoming list; has() checks current and upcoming", () => {
  const q = new Queue();
  q.add(item("1"));
  q.add(item("2"));
  q.playNow(q.items[1]);
  expect(q.current?.id).toBe("2");
  expect(q.items.map((i) => i.id)).toEqual(["1"]);
  expect(q.has("a2")).toBe(true);
  expect(q.has("a9")).toBe(false);
});

test("listener view carries no file ids and is capped at 30", () => {
  const q = new Queue();
  for (let i = 0; i < 40; i++) q.add(item(String(i), { source: "file", fileId: `f${i}`, by: "cheerful otter" }));
  q.next();
  const v = q.view();
  expect(v.next.length).toBe(30);
  expect(JSON.stringify(v)).not.toContain("fileId");
  expect(v.now).toEqual({ title: "Song 0", artist: undefined, art: undefined, by: "cheerful otter" });
});

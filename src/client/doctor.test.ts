import { expect, test } from "bun:test";
import type { Status } from "../shared/protocol.ts";
import { diagnose, summarize, type Context } from "./doctor.ts";

const base: Status = {
  state: "playing", bufferMs: 780, errMs: 0.3, rate: 1, late: 0, drops: 0, resyncs: 1, authFail: 0,
  rttMs: 12, uncMs: 6, outLatMs: 40, offsetMs: 0, calibrated: false, map: "ots",
};
const ctx: Context = { hostPlaying: true, autoSync: true, heard: false, recentGlitches: 0, recent: { drops: 0, jumps: 0, under: 0 } };

test("healthy synced device: good, and facts are labelled by source", () => {
  const d = diagnose({ ...base, calibrated: true, offsetMs: 41 }, { ...ctx, heard: true });
  expect(d.level).toBe("good");
  expect(d.facts.find((f) => f.label === "Sync correction")).toEqual({ label: "Sync correction", value: "41 ms", source: "measured" });
  expect(d.facts.find((f) => f.label === "Scheduling error")?.source).toBe("estimate");
  expect(d.facts.find((f) => f.label === "Output latency")?.source).toBe("browser");
  expect(d.facts.find((f) => f.label === "Scheduling error")?.value).toBe("<1 ms"); // no fake precision
  expect(diagnose({ ...base, uncMs: 0.3 }, ctx).facts.find((f) => f.label === "Clock uncertainty")?.value).toBe("<1 ms");
});

test("background beats everything else; not-playing explains late audio", () => {
  expect(diagnose({ ...base, hidden: true, calibrated: true }, ctx).title).toContain("background");
  const late = diagnose({ ...base, state: "waiting", bufferMs: -120 }, ctx);
  expect([late.level, late.title]).toEqual(["bad", "Not playing — audio arrives too late"]);
  expect(late.actions).toContain("resync");
});

test("glitch causes pick the dominant one", () => {
  const wifi = diagnose(base, { ...ctx, recentGlitches: 5, recent: { drops: 4, jumps: 1, under: 0 } });
  expect([wifi.level, wifi.detail]).toEqual(["warn", expect.stringContaining("arriving late")]);
  const busy = diagnose(base, { ...ctx, recentGlitches: 3, recent: { drops: 0, jumps: 0, under: 3 } });
  expect(busy.detail).toContain("falling behind");
});

test("not heard: suggests volume/help sync and mentions possible Bluetooth only when latency is high", () => {
  const quiet = diagnose(base, ctx);
  expect(quiet.title).toBe("Not heard by the microphone yet");
  expect(quiet.detail).not.toContain("Bluetooth");
  expect(quiet.actions).toContain("help-sync");
  expect(diagnose({ ...base, outLatMs: 180 }, ctx).detail).toContain("maybe Bluetooth");
});

test("a playing device can always be re-synced", () => {
  expect(diagnose(base, { ...ctx, autoSync: false }).actions).toContain("resync");
  expect(diagnose(base, ctx).actions).toContain("resync"); // not heard yet
});

test("idle and summary", () => {
  expect(diagnose(undefined, ctx).level).toBe("idle");
  expect(diagnose({ ...base, state: "stopped" }, { ...ctx, hostPlaying: false }).title).toBe("Stopped");
  expect(summarize(["good", "bad", "warn"])).toEqual({ level: "bad", text: "1 device needs attention" });
  expect(summarize(["good", "good"]).text).toBe("Everything looks healthy");
  expect(summarize(["idle", "idle"]).text).toBe("All devices ready"); // nothing playing isn't "healthy"
});

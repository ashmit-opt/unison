// Chunk placement on the audio clock (spec §7.3). Pure: no Web Audio here, so it is unit-testable.

export const SCHED = {
  safety: 0.01, // s: never schedule closer than this to "now"
  softLimit: 0.025, // s: larger chain error → resync
  deadband: 0.0005, // s: smaller error → no slew
  maxRate: 0.002, // ±0.2 % playbackRate (~3.5 cents, inaudible)
  slewWindow: 2, // s: spread a correction over this much audio
  maxTrim: 0.2, // s: a backward jump larger than this flushes scheduled audio instead of trimming
};

/** Why the chain restarted: first chunk/after reset, chain fell behind real time, or the target moved. */
export type Why = "start" | "underrun" | "jump" | "flush";
export type Placement =
  | { kind: "play"; when: number; offset: number; rate: number; resync: boolean; late: boolean; err: number; flush: boolean; why: Why | null }
  | { kind: "drop" };

export class Scheduler {
  next: number | null = null;

  reset() { this.next = null; }

  /** desired: ideal start (ctx s) of a chunk lasting `dur` s; now: ctx.currentTime. */
  place(desired: number, dur: number, now: number): Placement {
    const safe = now + SCHED.safety;
    // Far behind the scheduled chain (e.g. clock estimate corrected): drop what's scheduled, restart.
    if (this.next !== null && this.next - desired > SCHED.maxTrim) {
      const err = desired - this.next;
      this.next = null;
      const p = this.resync(desired, dur, safe, err, "flush");
      return p.kind === "play" ? { ...p, flush: true } : p;
    }
    if (this.next === null || Math.abs(desired - this.next) > SCHED.softLimit || this.next < safe) {
      const why: Why = this.next === null ? "start" : this.next < safe ? "underrun" : "jump";
      return this.resync(desired, dur, Math.max(safe, this.next ?? -Infinity), this.next === null ? 0 : desired - this.next, why);
    }
    const err = desired - this.next;
    let rate = 1;
    if (Math.abs(err) >= SCHED.deadband) {
      rate = dur / (dur + err * Math.min(1, dur / SCHED.slewWindow));
      rate = Math.min(1 + SCHED.maxRate, Math.max(1 - SCHED.maxRate, rate));
    }
    const when = this.next;
    this.next = when + dur / rate;
    return { kind: "play", when, offset: 0, rate, resync: false, late: false, err, flush: false, why: null };
  }

  /** Restart the chain at `desired`, but never before `floor` (now + safety, or the end of audio
   *  already scheduled): the part of the chunk that is too late or would overlap is trimmed. */
  private resync(desired: number, dur: number, floor: number, err: number, why: Why): Placement {
    if (desired >= floor) {
      this.next = desired + dur;
      return { kind: "play", when: desired, offset: 0, rate: 1, resync: true, late: false, err, flush: false, why };
    }
    if (desired + dur > floor + 0.002) {
      this.next = desired + dur;
      return { kind: "play", when: floor, offset: floor - desired, rate: 1, resync: true, late: true, err, flush: false, why };
    }
    // Entirely behind: skip it. Keep a still-valid chain end, so the trim continues on the next chunk.
    if (this.next !== null && this.next < floor) this.next = null;
    return { kind: "drop" };
  }
}

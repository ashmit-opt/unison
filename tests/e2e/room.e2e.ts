// Real browser flows (Chromium): create → host plays → listeners join, late join, reconnect, stop, PWA.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Contexts made from the worker-scoped browser outlive the test unless closed: earlier rooms would keep playing
// audio and slow every later test.
const contexts: BrowserContext[] = [];
const newPage = async (browser: Browser) => { const c = await browser.newContext(); contexts.push(c); return c.newPage(); };
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((c) => c.close())); });

/** 8 s, 48 kHz stereo 16-bit WAV with a 440 Hz tone. */
function toneWav(seconds = 8): Buffer {
  const sr = 48000, n = sr * seconds, data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function createRoom(browser: Browser) {
  const host = await newPage(browser);
  await host.goto("/");
  await host.click("#create");
  await expect(host.locator("#link")).toContainText("#k=");
  const link = (await host.locator("#link").textContent())!;
  await expect.poll(() => host.evaluate(() => !!(window as any).__unison.host)).toBe(true);
  return { host, link };
}

async function join(browser: Browser, link: string) {
  const page = await newPage(browser);
  await page.goto(link);
  await page.click("#go");
  await expect(page.locator("#st")).not.toHaveText("Connecting…");
  return page;
}

const stats = (p: Page) => p.evaluate(() => {
  const pl = (window as any).__unison.player;
  return { ...pl.stats, state: pl.state, last: pl.last };
});

test("file source: listener decrypts, decodes and plays in sync; late joiner and reconnect", async ({ browser }) => {
  const { host, link } = await createRoom(browser);
  const a = await join(browser, link);
  await host.setInputFiles("#file", { name: "tone.wav", mimeType: "audio/wav", buffer: toneWav() });
  await expect(a.locator("#st")).toHaveText("Playing", { timeout: 10_000 });
  await expect(a.locator("#title")).toContainText("tone"); // encrypted metadata arrived (extension trimmed)
  await expect.poll(async () => (await stats(a)).chunks, { timeout: 10_000 }).toBeGreaterThan(20);

  // Late joiner starts within 1.5 s and lines up with the first listener (software estimate, same machine).
  const b = await join(browser, link);
  const t0 = Date.now();
  await expect(b.locator("#st")).toHaveText("Playing", { timeout: 5_000 });
  expect(Date.now() - t0).toBeLessThan(1500 + 500);
  await a.waitForTimeout(2500);
  const [sa, sb] = [await stats(a), await stats(b)];
  for (const s of [sa, sb]) {
    expect(s.decodeErrors).toBe(0);
    expect(s.authFail).toBe(0);
    expect(Math.abs(s.errMs)).toBeLessThan(2);
  }
  // Same seq → predicted emission times agree (two tabs on one machine share the system clock).
  const seq = Math.min(sa.last.seq, sb.last.seq) - 2;
  const emit = async (p: Page) => p.evaluate((target) => new Promise<number>((res) => {
    const pl = (window as any).__unison.player;
    const id = setInterval(() => { if (pl.last.seq === target) { clearInterval(id); res(pl.last.emitEpochMs); } }, 5);
  }), seq + 6);
  const [ea, eb] = await Promise.all([emit(a), emit(b)]);
  expect(Math.abs(ea - eb)).toBeLessThan(5);

  // Reconnect: drop the socket; playback resumes without host involvement.
  const before = (await stats(a)).chunks;
  await a.evaluate(() => (window as any).__unison.conn.drop());
  await expect.poll(async () => (await stats(a)).chunks - before, { timeout: 10_000 }).toBeGreaterThan(20);
  await expect(host.locator("#devices .device")).toHaveCount(3); // host + two listeners
});

test("capture source: getDisplayMedia stream reaches listeners (headless auto-selects the screen + system audio)", async ({ playwright }) => {
  const browser = await playwright.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--auto-select-desktop-capture-source=Entire screen", "--use-fake-ui-for-media-stream"] });
  try {
    const { host, link } = await createRoom(browser);
    await expect.poll(() => host.evaluate(() => (window as any).__unison.conn.clock.ready)).toBe(true);
    const a = await join(browser, link);
    await host.click('[data-tab="tab"]');
    await host.click("#cap");
    await expect(a.locator("#st")).toHaveText("Playing", { timeout: 10_000 });
    const kind = await host.evaluate(() => (window as any).__unison.host.kind);
    expect(["tab", "system"]).toContain(kind);
    await expect(a.locator("#title")).toContainText(kind === "tab" ? "Shared tab" : "System audio");
    expect((await stats(a)).decodeErrors).toBe(0);
  } finally {
    await browser.close();
  }
});

test("test clicks source, then stop: listeners see the stop", async ({ browser }) => {
  const { host, link } = await createRoom(browser);
  const a = await join(browser, link);
  await host.click('[data-tab="tab"]');
  await host.click("#clicks");
  await expect(a.locator("#st")).toHaveText("Playing", { timeout: 10_000 });
  await host.click("#stop");
  await expect(a.locator("#st")).toHaveText("Host stopped playback", { timeout: 5_000 });
});

test("calibration round trip runs (fake mic: no chirps are heard, so it must fail gracefully)", async ({ browser }) => {
  const { host, link } = await createRoom(browser);
  await join(browser, link);
  await expect(host.locator("#devices .device")).toHaveCount(2);
  await host.click("#cal");
  await expect(host.locator("#calmsg")).toContainText(/Measured spread|Couldn't hear/, { timeout: 30_000 });
});

test("calibration loop on a real audio graph: measures a 25 ms late device and removes the gap", async ({ browser }) => {
  const { host } = await createRoom(browser);
  await expect.poll(() => host.evaluate(() => (window as any).__unison.conn.clock.ready)).toBe(true);
  const r = await host.evaluate(async () => {
    const u = (window as any).__unison, ctx: AudioContext = u.ctx;
    const loop = ctx.createMediaStreamDestination(); // digital "microphone" hearing both players
    const players = [];
    for (const nudge of [0, -25]) { // second device sounds 25 ms late
      const p = new u.Player(ctx, u.conn.clock);
      await p.init();
      p.out.connect(loop);
      p.nudgeMs = nudge;
      players.push(p);
    }
    const targets = players.map((p: any, i: number) => ({ id: `p${i}`, play: (at: number) => p.playChirp(at), adjust: (d: number) => { p.offsetMs += d; } }));
    const firstLags: (number | null)[] = [];
    const origAdjust = targets.map((t: any) => t.adjust);
    targets.forEach((t: any, i: number) => (t.adjust = (d: number) => { if (firstLags.length < 2) firstLags.push(d); origAdjust[i](d); }));
    const res = await u.calibrate(ctx, u.conn, u.host, targets, () => {}, loop.stream);
    return { res, firstDeltas: firstLags, offsets: players.map((p: any) => p.offsetMs) };
  });
  // Round 1 sees a 25 ms difference (±1 ms); the final verification spread is within the 2 ms goal.
  const [d0, d1] = r.firstDeltas as number[];
  expect(Math.abs(Math.abs(d1 - d0) - 25)).toBeLessThan(1);
  expect(r.res.spreadMs).not.toBeNull();
  expect(r.res.spreadMs).toBeLessThanOrEqual(2);
  expect(Math.abs(Math.abs(r.offsets[1] - r.offsets[0]) - 25)).toBeLessThan(1.5);
});

/** 30 s of "music": tones + noise, stereo 16-bit WAV. */
function musicWav(seconds = 30): Buffer {
  const sr = 48000, n = sr * seconds, data = Buffer.alloc(n * 4);
  let seed = 7, lp = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    lp = 0.9 * lp + 0.1 * (seed / 2147483647 - 0.5);
    const v = Math.round((0.15 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.1 * Math.sin((2 * Math.PI * 1760 * i) / sr) + 0.8 * lp) * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("continuous auto-sync (digital loopback): aligns a 25 ms late device while music plays", async ({ browser }) => {
  test.setTimeout(90_000);
  const { host } = await createRoom(browser);
  await expect.poll(() => host.evaluate(() => (window as any).__unison.conn.clock.ready)).toBe(true);
  // Two simulated devices fed with the host's real stream, both heard by a digital "microphone".
  await host.evaluate(async () => {
    const u = (window as any).__unison, ctx: AudioContext = u.ctx;
    const loop = ctx.createMediaStreamDestination();
    const devs: any[] = [];
    for (const [id, nudge] of [[1, 0], [2, -25]] as const) {
      const p = new u.Player(ctx, u.conn.clock);
      await p.init();
      p.out.disconnect();
      p.out.connect(loop);
      p.nudgeMs = nudge;
      p.pn = { id, db: -30 };
      devs.push(p);
    }
    const push = u.local.push.bind(u.local);
    u.local.push = (...a: any[]) => { push(...a); for (const p of devs) p.push(...a); };
    const mic = new u.MicListener(ctx, u.conn);
    const sync = new u.AutoSyncHost(99, {
      adjust: (id: number, d: number) => { devs[id - 1].offsetMs += d; },
      setLevel: (id: number, db: number) => { devs[id - 1].pn = { id, db }; },
      chainErrMs: (id: number) => devs[id - 1].stats.errMs,
      reset: (id: number) => mic.reset(id),
    });
    mic.ids = () => [1, 2];
    mic.onMeasure = (lags: Map<number, any>) => { sync.ensure([1, 2]); sync.onHostMic(lags); };
    await mic.start(loop.stream);
    Object.assign(u, { testDevs: devs, testSync: sync });
  });
  await host.setInputFiles("#file", { name: "music.wav", mimeType: "audio/wav", buffer: musicWav() });
  const gap = () => host.evaluate(() => {
    const u = (window as any).__unison, [a, b] = u.testDevs;
    return Math.abs((b.offsetMs + b.nudgeMs) - (a.offsetMs + a.nudgeMs));
  });
  const t0 = Date.now();
  await expect.poll(gap, { timeout: 60_000, intervals: [1000] }).toBeLessThan(2);
  console.log(`auto-sync converged in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // After the settle period the loop keeps measuring: spread is reported and stays small, gap stays closed.
  await expect.poll(() => host.evaluate(() => (window as any).__unison.testSync.spreadMs ?? 99), { timeout: 30_000, intervals: [1000] }).toBeLessThan(2);
  const spread = await host.evaluate(() => (window as any).__unison.testSync.spreadMs);
  console.log(`measured spread at steady state: ${spread.toFixed(2)} ms (${((Date.now() - t0) / 1000).toFixed(1)} s after music started)`);
  expect(await gap()).toBeLessThan(2);
});

test("helper microphones (two-way): far-apart devices align at the source, travel time cancels", async ({ browser }) => {
  test.setTimeout(120_000);
  const { host } = await createRoom(browser);
  await expect.poll(() => host.evaluate(() => (window as any).__unison.conn.clock.ready)).toBe(true);
  await host.evaluate(async () => {
    const u = (window as any).__unison, ctx: AudioContext = u.ctx;
    // Devices 1 and 2 each have a mic; they are 20 ms of sound travel apart. Device 2 emits 15 ms late.
    const micA = ctx.createMediaStreamDestination(), micB = ctx.createMediaStreamDestination();
    const devs: any[] = [];
    for (const [id, nudge] of [[1, 0], [2, -15]] as const) {
      const p = new u.Player(ctx, u.conn.clock);
      await p.init();
      p.out.disconnect();
      p.nudgeMs = nudge;
      p.pn = { id, db: -30 };
      const far = ctx.createDelay(1);
      far.delayTime.value = 0.02;
      p.out.connect(far);
      p.out.connect(id === 1 ? micA : micB); // hears itself directly
      far.connect(id === 1 ? micB : micA); // the other mic hears it 20 ms later
      devs.push(p);
    }
    const push = u.local.push.bind(u.local);
    u.local.push = (...a: any[]) => { push(...a); for (const p of devs) p.push(...a); };
    const listenA = new u.MicListener(ctx, u.conn), listenB = new u.MicListener(ctx, u.conn);
    const sync = new u.AutoSyncHost(1, { // device 1 plays the host role; device 2 is a helper phone
      adjust: (id: number, d: number) => { devs[id - 1].offsetMs += d; },
      setLevel: (id: number, db: number) => { devs[id - 1].pn = { id, db }; },
      chainErrMs: (id: number) => devs[id - 1].stats.errMs,
      reset: (id: number) => { listenA.reset(id); listenB.reset(id); },
    });
    listenA.ids = listenB.ids = () => [1, 2];
    listenB.onMeasure = (lags: Map<number, any>) => sync.onHelper(2, Object.fromEntries([...lags].map(([k, v]) => [String(k), v.lagMs])));
    listenA.onMeasure = (lags: Map<number, any>) => { sync.ensure([1, 2]); sync.onHostMic(lags); };
    await listenA.start(micA.stream);
    await listenB.start(micB.stream);
    Object.assign(u, { testDevs: devs, testSync: sync });
  });
  await host.setInputFiles("#file", { name: "music.wav", mimeType: "audio/wav", buffer: musicWav() });
  const emissionGap = () => host.evaluate(() => {
    const [a, b] = (window as any).__unison.testDevs;
    return (b.offsetMs + b.nudgeMs) - (a.offsetMs + a.nudgeMs); // 0 = both emit together
  });
  // Starts at −15 (B late). Correct: → 0. A single mic would instead drive it to −35 (aligned at A's mic).
  await expect.poll(async () => Math.abs(await emissionGap()), { timeout: 60_000, intervals: [1000] }).toBeLessThan(2);
  await host.waitForTimeout(8000);
  console.log(`two-way emission gap at steady state: ${(await emissionGap()).toFixed(2)} ms`);
  expect(Math.abs(await emissionGap())).toBeLessThan(2);
});

test("guest requests a song, host approves, it plays everywhere and shows as now playing", async ({ browser }) => {
  const audiusUp = await fetch("https://api.audius.co/v1/tracks?id=JbKjZ&app_name=unison-test").then((r) => r.ok).catch(() => false);
  test.skip(!audiusUp, "Audius API unreachable");
  const { host, link } = await createRoom(browser);
  const a = await join(browser, link);
  await a.click("#reqBtn");
  const first = a.locator(".sheet .row-item").first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  const title = (await first.locator(".t").textContent())!.trim();
  await first.locator("button").click();
  await expect(host.locator(".request")).toContainText(title, { timeout: 10_000 });
  await host.locator(".request button.btn-primary").click(); // approve
  await expect(host.locator("#npTitle")).toHaveText(title, { timeout: 15_000 }); // queue was empty → plays right away
  await expect(a.locator("#title")).toHaveText(title, { timeout: 15_000 });
});

test("songs added to the library survive a reload; queue auto-advances", async ({ browser }) => {
  const { host } = await createRoom(browser);
  await host.click('[data-tab="file"]');
  await host.setInputFiles("#file", [
    { name: "first.wav", mimeType: "audio/wav", buffer: toneWav(2) },
    { name: "second.wav", mimeType: "audio/wav", buffer: toneWav(2) },
  ]);
  await expect(host.locator("#libList")).toContainText("second", { timeout: 10_000 });
  await expect(host.locator("#npTitle")).toHaveText("first");
  await expect(host.locator("#queue")).toContainText("second");
  await expect(host.locator("#npTitle")).toHaveText("second", { timeout: 10_000 }); // first (2 s) ended → next
  await host.reload();
  await host.click("#go"); // resume hosting
  await host.click('[data-tab="file"]');
  await expect(host.locator("#libList")).toContainText("first", { timeout: 10_000 });
  await expect(host.locator("#libList")).toContainText("second");
});

test("regression: a track that can't play is skipped instead of leaving the room silent", async ({ browser }) => {
  const { host } = await createRoom(browser);
  await host.click('[data-tab="file"]');
  await host.setInputFiles("#file", [
    { name: "broken.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("this is not audio at all".repeat(50)) },
    { name: "fine.wav", mimeType: "audio/wav", buffer: toneWav(3) },
  ]);
  await expect(host.locator("#npTitle")).toHaveText("fine", { timeout: 10_000 });
  await expect(host.locator(".toast").filter({ hasText: "skipping" })).toHaveCount(1);
});

test("Sync Doctor: expand a device, identify it (listener chimes + shows its name), re-sync it", async ({ browser }) => {
  const { host, link } = await createRoom(browser);
  const a = await join(browser, link);
  await host.setInputFiles("#file", { name: "tone.wav", mimeType: "audio/wav", buffer: toneWav(20) });
  await expect(a.locator("#st")).toHaveText("Playing", { timeout: 10_000 });
  const chip = host.locator('#devices [data-expand]:not([data-expand="0"])');
  await expect(chip).toHaveAttribute("aria-expanded", "false", { timeout: 5_000 });
  await chip.click();
  const panel = host.locator("#devices .device .doctor:not([hidden])");
  await expect(panel).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(panel.locator(".facts")).toContainText("Network round trip");
  await expect(panel.locator(".src-measured").first()).toBeVisible(); // every number says where it came from
  await expect(host.locator("#health")).not.toBeEmpty();

  const name = (await a.evaluate(() => (window as any).__unison.conn.name)) as string;
  await panel.locator('[data-act="identify"]').click();
  await expect(a.locator(".identify")).toContainText(name);
  await expect(a.locator(".identify")).toHaveCount(0, { timeout: 5_000 }); // goes away by itself

  await chip.click(); // collapse and reopen: state survives re-renders
  await expect(panel).toHaveCount(0);
  await chip.click();
  const before = (await stats(a)).chunks;
  await panel.locator('[data-act="resync"]').click();
  await expect(a.locator(".toast").filter({ hasText: "Re-syncing" })).toBeVisible();
  await expect.poll(async () => (await stats(a)).chunks - before, { timeout: 10_000 }).toBeGreaterThan(15); // keeps playing
  await expect(a.locator("#st")).toHaveText("Playing");
  expect((await stats(a)).decodeErrors).toBe(0);
});

test("party mode: full-screen display with QR, listener count and guest reactions", async ({ browser }) => {
  const { host, link } = await createRoom(browser);
  const a = await join(browser, link);
  await host.setInputFiles("#file", { name: "party.wav", mimeType: "audio/wav", buffer: toneWav(20) });
  await expect(a.locator("#st")).toHaveText("Playing", { timeout: 10_000 });

  // Outside party mode a reaction floats over the now-playing card.
  await a.locator('.react[data-r="fire"]').click();
  await expect(a.locator("#rx .rx")).toHaveCount(1); // sender's own feedback
  await expect(host.locator("#rx .rx")).toContainText("🔥");

  await host.click("#partyBtn");
  const party = host.locator(".party");
  await expect(party).toBeVisible();
  await expect(party.locator("#pTitle")).toHaveText("party");
  await expect(party.locator("#pCount")).toContainText("1 phone listening");
  await expect(party.locator(".qr svg")).toBeVisible();
  await host.keyboard.press("Tab"); // the page behind the dialog is inert: focus stays inside
  expect(await host.evaluate(() => !!document.activeElement?.closest(".party") || document.activeElement === document.body)).toBe(true);

  // In party mode reactions float on the big screen with the guest's name (rate limits: unit-tested).
  await a.waitForTimeout(600); // guests are throttled to one reaction per 500 ms
  await a.locator('.react[data-r="heart"]').click();
  await expect(party.locator("#pRx .rx")).toContainText(await a.evaluate(() => (window as any).__unison.conn.name));

  await party.locator("#pExit").click();
  await expect(party).toHaveCount(0);
  await expect(host.locator("#partyBtn")).toBeFocused();
});

test("moderation: locked room refuses new devices, members reconnect, removed guest sees why", async ({ browser }) => {
  const { host, link } = await createRoom(browser);
  const a = await join(browser, link);
  await expect(host.locator("#devices .device")).toHaveCount(2);
  await host.locator("#lockRoom").check();
  await expect(host.locator("#lockHint")).toContainText("Locked");

  const late = await newPage(browser);
  await late.goto(link);
  await expect(late.locator("h1")).toHaveText("This room is locked");

  // A member's connection drops: it gets back in (resume token) even though the room is locked.
  const peer = await a.evaluate(() => (window as any).__unison.conn.peer);
  await a.evaluate(() => (window as any).__unison.conn.drop());
  await expect.poll(() => a.evaluate(() => (window as any).__unison.conn.connected), { timeout: 10_000 }).toBe(true);
  expect(await a.evaluate(() => (window as any).__unison.conn.peer)).toBe(peer);

  await host.locator(`#devices [data-expand="${peer}"]`).click();
  await host.locator(`#devices [data-act="remove"][data-id="${peer}"]`).click();
  await expect(a.locator("h1")).toHaveText("You were removed from the room");
  await expect(host.locator("#devices .device")).toHaveCount(1);

  await host.locator("#lockRoom").uncheck();
  await late.getByRole("link", { name: "Try again" }).click();
  await late.click("#go");
  await expect(host.locator("#devices .device")).toHaveCount(2);
});

test("incomplete link and missing room are explained", async ({ page }) => {
  await page.goto("/r/abcdefghjk");
  await expect(page.locator("main")).toContainText("link is incomplete");
  await page.goto("/r/abcdefghjk#k=" + "A".repeat(43));
  await expect(page.locator("#banner")).toContainText("doesn't exist"); // the invite connects first, so it knows before any tap
});

test("PWA: manifest linked, service worker controls the page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});

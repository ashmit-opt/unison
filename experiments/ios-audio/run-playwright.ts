// Drives the experiment in Playwright browsers (desktop proxies only — NOT a substitute for a real iPhone).
// Usage: bun experiments/ios-audio/serve.ts  (in another shell), then: bun experiments/ios-audio/run-playwright.ts webkit
import { chromium, webkit, firefox } from "@playwright/test";

const which = process.argv[2] ?? "webkit";
const engine = { chromium, webkit, firefox }[which]!;
const browser = await engine.launch();
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto("http://localhost:5173/");
await page.waitForTimeout(1500);
await page.click("#start");
await page.waitForFunction(() => ["done", "error"].includes(document.getElementById("phase")!.textContent!), null, { timeout: 180_000 });
const r = JSON.parse((await page.textContent("#out"))!);
console.log(JSON.stringify({ caps: r.caps, verdict: r.verdict, errors: r.events.filter((e: any) => e.name === "error") }, null, 1));
await browser.close();

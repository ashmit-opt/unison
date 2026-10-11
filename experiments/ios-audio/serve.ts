// Experiment server: serves the page, stores the Opus fixture, saves posted results.
// HTTPS (needed on a phone for AudioWorklet/WebCrypto) if certs/key.pem + certs/cert.pem exist.
import page from "./index.html";

const dir = import.meta.dir;
const tls = (await Bun.file(`${dir}/certs/key.pem`).exists())
  ? { key: Bun.file(`${dir}/certs/key.pem`), cert: Bun.file(`${dir}/certs/cert.pem`) }
  : undefined;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  hostname: "0.0.0.0",
  tls,
  routes: {
    "/": page,
    "/fixture.bin": {
      GET: async () => {
        const f = Bun.file(`${dir}/fixture.bin`);
        return (await f.exists()) ? new Response(f) : new Response("none", { status: 404 });
      },
      POST: async (req) => {
        await Bun.write(`${dir}/fixture.bin`, await req.arrayBuffer());
        return new Response("ok");
      },
    },
    "/results": {
      POST: async (req) => {
        const body = await req.json();
        const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        await Bun.write(`${dir}/results/${name}`, JSON.stringify(body, null, 1));
        console.log("saved results", name);
        return new Response("ok");
      },
    },
  },
});
console.log(`experiment on ${server.url}`);

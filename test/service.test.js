import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function withChild(env, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      DATABASE_PATH: ":memory:",
      NODE_ENV: "test",
      OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout\n${stdout}\n${stderr}`)), 15000);
    const onData = () => {
      if (stdout.includes(`on http://localhost:${port}`)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    onData();
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stdout}\n${stderr}`));
    });
  });
  try {
    await fn(base);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("telephony service owns / and keeps Israel in the picker", async () => {
  await withChild({ SERVICE: "telephony", AGENTS_PUBLIC_URL: "https://agents.example" }, async (base) => {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.service, "telephony");
    assert.equal(health.mode, "telephony");

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Telephony/);
    assert.match(html, /data-console-base=""/);
    assert.match(html, /https:\/\/agents\.example\/agents/);
    assert.doesNotMatch(html, /Maison Sol/);

    const buy = await fetch(`${base}/phone-numbers/search`);
    assert.equal(buy.status, 200);

    const legacy = await fetch(`${base}/console/phone-numbers`, { redirect: "manual" });
    assert.equal(legacy.status, 302);
    assert.match(legacy.headers.get("location") || "", /\/phone-numbers$/);

    const picker = await fetch(`${base}/js/console.js`).then((r) => r.text());
    assert.match(picker, /iso: "IL"/);
    assert.match(picker, /name: "Israel"/);
  });
});

test("agents service redirects /console to TELEPHONY_PUBLIC_URL", async () => {
  await withChild(
    { SERVICE: "agents", TELEPHONY_PUBLIC_URL: "https://telephony.example" },
    async (base) => {
      const health = await fetch(`${base}/api/health`).then((r) => r.json());
      assert.equal(health.service, "agents");

      const agents = await fetch(`${base}/agents`);
      assert.equal(agents.status, 200);
      assert.match(await agents.text(), /Agents/);

      const consoleRes = await fetch(`${base}/console`, { redirect: "manual" });
      assert.equal(consoleRes.status, 302);
      assert.equal(consoleRes.headers.get("location"), "https://telephony.example/");

      const nested = await fetch(`${base}/console/phone-numbers/search?country=IL`, { redirect: "manual" });
      assert.equal(nested.status, 302);
      assert.equal(nested.headers.get("location"), "https://telephony.example/phone-numbers/search?country=IL");

      const phone = await fetch(`${base}/phone-numbers`, { redirect: "manual" });
      assert.equal(phone.status, 302);
      assert.equal(phone.headers.get("location"), "https://telephony.example/phone-numbers");
    },
  );
});

/**
 * ezbase realtime test — SSE streams survive idle, heartbeat, and clean up.
 * Run: bun run test/realtime.ts  (from repo root, after test stack is up)
 */

const URL = process.env.URL || "http://localhost:7003";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function waitForHealthy(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("ezbase did not become healthy in time");
}

type StreamProbe = {
  snapshots: number;
  comments: number;
  closed: boolean;
  stop: () => void;
};

function openStream(path: string): StreamProbe {
  const probe: StreamProbe = { snapshots: 0, comments: 0, closed: false, stop: () => {} };
  const controller = new AbortController();
  probe.stop = () => controller.abort();
  (async () => {
    try {
      const res = await fetch(`${URL}${path}`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`connect failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
          if (line.startsWith("event: snapshot")) probe.snapshots++;
          if (line.startsWith(":")) probe.comments++;
        }
      }
    } catch {}
    probe.closed = true;
  })();
  return probe;
}

async function write(collection: string, body: Record<string, unknown>) {
  const res = await fetch(`${URL}/api/collections/${collection}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`write failed: ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("Waiting for ezbase to be healthy...");
  await waitForHealthy();
  console.log("ezbase is up!\n");

  const col = `realtime_test_${Date.now()}`;
  const first = await write(col, { n: 1 });

  console.log("Idle stream survival (25s — outlives any 10s idle kill)");
  {
    const collStream = openStream(`/api/collections/${col}/sse`);
    const docStream = openStream(`/api/collections/${col}/${first.id}/sse`);
    await sleep(25_000);
    assert(!collStream.closed, "collection stream still open after 25s idle");
    assert(!docStream.closed, "document stream still open after 25s idle");
    assert(collStream.comments >= 1, `collection stream got keep-alive comments (${collStream.comments})`);
    assert(docStream.comments >= 1, `document stream got keep-alive comments (${docStream.comments})`);
    assert(collStream.snapshots === 1, "idle collection stream sent exactly the initial snapshot");

    console.log("\nSnapshots still flow after idle period");
    await write(col, { n: 2 });
    await sleep(1_500);
    assert(collStream.snapshots === 2, "collection stream received change snapshot");
    assert(docStream.snapshots === 1, "document stream ignored other-doc change");

    collStream.stop();
    docStream.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * ezbase analytics test — request recording, aggregation, summary/timeseries/live endpoints.
 * Run: bun run test/analytics.ts  (after stack is up)
 */

const URL = process.env.URL || "http://localhost:7003";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
const DB = "anlx";

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

const auth = { Authorization: `Bearer ${ADMIN_KEY}` };
const json = { ...auth, "Content-Type": "application/json" };

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

async function main() {
  console.log("Waiting for ezbase to be healthy...");
  await waitForHealthy();
  console.log("ezbase is up!\n");

  console.log("Permissions");
  {
    const res = await fetch(`${URL}/api/analytics/summary`);
    assert(res.status === 401, "summary without auth → 401");
  }

  console.log("\nRecording");
  // Generate identifiable traffic: writes + reads + an error
  for (let i = 0; i < 5; i++) {
    await fetch(`${URL}/api/db/${DB}/collections/clicks`, { method: "POST", headers: json, body: JSON.stringify({ n: i }) });
  }
  await fetch(`${URL}/api/db/${DB}/collections/clicks`, { headers: auth });
  await fetch(`${URL}/api/db/${DB}/collections/clicks/does-not-exist`, { headers: auth }); // 404 → error count

  const summary = await (await fetch(`${URL}/api/analytics/summary`, { headers: auth })).json();
  assert(summary.requests >= 7, `summary counts requests (${summary.requests})`);
  assert(summary.errors >= 1, "summary counts errors");
  const clicks = summary.topCollections.find((t: any) => t.database === DB && t.collection === "clicks");
  assert(!!clicks && clicks.requests >= 7, "top collections includes test collection");
  assert(clicks.errors >= 1, "per-collection error count recorded");
  const writeOp = summary.byOp.find((o: any) => o.op === "write");
  assert(!!writeOp && writeOp.requests >= 5, "byOp breaks out writes");

  console.log("\nTimeseries");
  {
    const ts = await (await fetch(`${URL}/api/analytics/timeseries?minutes=10`, { headers: auth })).json();
    assert(Array.isArray(ts) && ts.length >= 1, "timeseries returns minute buckets");
    const total = ts.reduce((s: number, p: any) => s + p.requests, 0);
    assert(total >= 7, "timeseries totals include test traffic");
    const filtered = await (await fetch(`${URL}/api/analytics/timeseries?minutes=10&database=${DB}&collection=clicks`, { headers: auth })).json();
    const ftotal = filtered.reduce((s: number, p: any) => s + p.requests, 0);
    assert(ftotal >= 7 && ftotal <= total, "timeseries filters by database/collection");
  }

  console.log("\nLive stream");
  {
    const controller = new AbortController();
    const res = await fetch(`${URL}/api/analytics/live?token=${ADMIN_KEY}`, { signal: controller.signal });
    assert(res.ok && (res.headers.get("content-type") || "").includes("text/event-stream"), "live stream connects via token");
    const reader = res.body!.getReader();
    // Trigger one request so an event arrives, then read the first chunk
    fetch(`${URL}/api/db/${DB}/collections/clicks`, { headers: auth });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert(text.includes("event: request") && text.includes('"path"'), "live stream emits request events");
    controller.abort();
  }

  console.log("\nProtection");
  {
    // The metrics table is internal — unreachable via the collections API
    const res = await fetch(`${URL}/api/collections/_ezbase_metrics`, { headers: auth });
    assert(res.status >= 400, "_ezbase_metrics not reachable as a collection");
  }

  console.log("\nCleanup");
  {
    const res = await fetch(`${URL}/api/db/${DB}`, { method: "DELETE", headers: auth });
    assert(res.ok, "test database deleted");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env bun
// ── ezbase Document Store Stress Test ──────────────────────────
// Hammers the core document CRUD + query API across 3 escalating stages.
// Run: cd test && docker compose up -d && bun run stress.ts

const BASE = process.env.URL || "http://localhost:7003";
const API = `${BASE}/api`;
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
const HEADERS = {
  Authorization: `Bearer ${ADMIN_KEY}`,
  "Content-Type": "application/json",
};
const STAGE_FILTER = process.env.STAGE ? parseInt(process.env.STAGE) : 0;
const SCALE = parseFloat(process.env.SCALE || "1");
const TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────
interface LatencySample {
  op: string;
  ms: number;
  status: number;
  ok: boolean;
}

interface ResourceMetrics {
  containerStats: string;
  dbSize: string;
  pgConns: string;
}

interface StageResult {
  name: string;
  totalDocs: number;
  elapsed: number;
  samples: LatencySample[];
  metrics: ResourceMetrics;
}

// ── Concurrency Pool ───────────────────────────────────────────
class Pool {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(public max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      if (this.queue.length > 0) this.queue.shift()!();
    }
  }
}

// ── Latency Helpers ────────────────────────────────────────────
async function timedFetch(
  op: string,
  url: string,
  init?: RequestInit
): Promise<{ sample: LatencySample; body: any }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = performance.now() - t0;
    const body = res.ok ? await res.json() : null;
    return { sample: { op, ms, status: res.status, ok: res.ok }, body };
  } catch {
    const ms = performance.now() - t0;
    return { sample: { op, ms, status: 0, ok: false }, body: null };
  }
}

function percentiles(samples: LatencySample[], ops?: string[]) {
  const filtered = ops
    ? samples.filter((s) => ops.includes(s.op))
    : samples;
  const ok = filtered.filter((s) => s.ok);
  const times = ok.map((s) => s.ms).sort((a, b) => a - b);
  if (times.length === 0)
    return {
      count: 0,
      errors: filtered.length,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
    };
  const p = (pct: number) =>
    times[Math.min(Math.floor((times.length * pct) / 100), times.length - 1)];
  return {
    count: times.length,
    errors: filtered.filter((s) => !s.ok).length,
    min: times[0],
    p50: p(50),
    p95: p(95),
    p99: p(99),
    max: times[times.length - 1],
    mean: times.reduce((a, b) => a + b, 0) / times.length,
  };
}

// ── Query String Builder ───────────────────────────────────────
function qs(opts: {
  where?: [string, string, unknown][];
  orderBy?: string;
  order?: "asc" | "desc";
  limit?: number;
}): string {
  const p = new URLSearchParams();
  if (opts.where) p.set("where", JSON.stringify(opts.where));
  if (opts.orderBy) p.set("orderBy", opts.orderBy);
  if (opts.order) p.set("order", opts.order);
  if (opts.limit) p.set("limit", String(opts.limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ── Document Generator ─────────────────────────────────────────
const CATEGORIES = [
  "electronics",
  "books",
  "clothing",
  "food",
  "tools",
  "sports",
  "music",
  "art",
];
const REGIONS = ["us_east", "us_west", "eu_west", "eu_east", "apac", "latam"];

function generateDoc(i: number): Record<string, unknown> {
  return {
    title: `Item ${i}`,
    description: `Description for item number ${i} with padding text to simulate realistic payload size`,
    category: CATEGORIES[i % CATEGORIES.length],
    region: REGIONS[i % REGIONS.length],
    price: Math.round((Math.random() * 1000 + 1) * 100) / 100,
    quantity: Math.floor(Math.random() * 500),
    rating: Math.round(Math.random() * 50) / 10,
    tags: [`tag_${i % 20}`, `tag_${(i * 7) % 30}`, `tag_${(i * 13) % 50}`],
    active: i % 5 !== 0,
    metadata: { source: `source_${i % 10}`, version: i % 3, priority: i % 100 },
  };
}

// ── Resource Metrics ───────────────────────────────────────────
async function captureMetrics(): Promise<ResourceMetrics> {
  const run = async (cmd: string[]): Promise<string> => {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      return (await new Response(proc.stdout).text()).trim();
    } catch {
      return "unavailable";
    }
  };

  // Find the container name dynamically
  const containers = await run([
    "docker",
    "ps",
    "--format",
    "{{.Names}}",
    "--filter",
    "ancestor=test-ezbase",
  ]);
  // Fallback: try common names
  let containerName =
    containers.split("\n")[0] || "test-ezbase-1";

  // If that didn't find anything, try broader search
  if (containerName === "test-ezbase-1") {
    const all = await run([
      "docker",
      "ps",
      "--format",
      "{{.Names}}",
    ]);
    const match = all.split("\n").find((n) => n.includes("ezbase"));
    if (match) containerName = match;
  }

  const containerStats = await run([
    "docker",
    "stats",
    "--no-stream",
    "--format",
    "CPU: {{.CPUPerc}}  Mem: {{.MemUsage}} ({{.MemPerc}})",
    containerName,
  ]);

  const dbSize = await run([
    "docker",
    "exec",
    containerName,
    "su",
    "postgres",
    "-c",
    `psql -t -c "SELECT pg_size_pretty(pg_database_size('ezbase'))"`,
  ]);

  const pgConns = await run([
    "docker",
    "exec",
    containerName,
    "su",
    "postgres",
    "-c",
    `psql -t -c "SELECT count(*) FROM pg_stat_activity WHERE datname='ezbase'"`,
  ]);

  return { containerStats, dbSize, pgConns };
}

// ── Output Formatting ──────────────────────────────────────────
function fmtMs(ms: number): string {
  if (ms === 0) return "-";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtRate(count: number, elapsed: number): string {
  if (elapsed === 0) return "-";
  const rate = count / (elapsed / 1000);
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}K/s`;
  return `${Math.round(rate)}/s`;
}

function printTable(
  label: string,
  samples: LatencySample[],
  elapsed: number,
  metrics: ResourceMetrics
) {
  // Group by op
  const ops = [...new Set(samples.map((s) => s.op))];

  console.log();
  console.log("=".repeat(90));
  console.log(`  ${label}`);
  console.log("=".repeat(90));
  console.log();
  console.log(
    "  " +
      "Operation".padEnd(22) +
      "Count".padStart(8) +
      "Errors".padStart(8) +
      "Thru".padStart(10) +
      "p50".padStart(8) +
      "p95".padStart(8) +
      "p99".padStart(8) +
      "max".padStart(8)
  );
  console.log("  " + "\u2500".repeat(86));

  for (const op of ops) {
    const opSamples = samples.filter((s) => s.op === op);
    const p = percentiles(opSamples);
    const thru =
      p.count > 10 ? fmtRate(p.count, elapsed) : "-";
    console.log(
      "  " +
        op.padEnd(22) +
        String(p.count).padStart(8) +
        String(p.errors).padStart(8) +
        thru.padStart(10) +
        fmtMs(p.p50).padStart(8) +
        fmtMs(p.p95).padStart(8) +
        fmtMs(p.p99).padStart(8) +
        fmtMs(p.max).padStart(8)
    );
  }

  console.log();
  console.log(`  Resources:`);
  console.log(`    Container:     ${metrics.containerStats}`);
  console.log(`    Postgres size: ${metrics.dbSize}`);
  console.log(`    PG connections: ${metrics.pgConns}`);
  console.log(`    Total elapsed: ${(elapsed / 1000).toFixed(1)}s`);
  console.log();
}

// ── Health Check ───────────────────────────────────────────────
async function waitForHealthy() {
  console.log(`\nWaiting for ezbase at ${BASE}...`);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log("  healthy!\n");
        return;
      }
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error("ezbase did not become healthy after 120s");
}

// ── Helpers ────────────────────────────────────────────────────
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function scaled(n: number): number {
  return Math.max(1, Math.round(n * SCALE));
}

// ── STAGE 1: Light Load ────────────────────────────────────────
async function stage1(): Promise<StageResult> {
  const DOC_COUNT = scaled(10_000);
  const CONCURRENCY = 50;
  const COL = "stress_s1";
  const samples: LatencySample[] = [];
  const docIds: string[] = [];
  const pool = new Pool(CONCURRENCY);

  console.log(
    `\n${"#".repeat(90)}\n  STAGE 1 — Light Load (${DOC_COUNT.toLocaleString()} docs, ${CONCURRENCY} concurrency, 1 collection)\n${"#".repeat(90)}`
  );

  const stageStart = performance.now();

  // 1. Bulk write
  console.log(`\n  [1/6] Writing ${DOC_COUNT.toLocaleString()} documents...`);
  const writeStart = performance.now();
  let writeCount = 0;
  const writePromises = Array.from({ length: DOC_COUNT }, (_, i) =>
    pool.run(async () => {
      const { sample, body } = await timedFetch(
        "write",
        `${API}/collections/${COL}`,
        { method: "POST", headers: HEADERS, body: JSON.stringify(generateDoc(i)) }
      );
      samples.push(sample);
      if (body?.id) docIds.push(body.id);
      writeCount++;
      if (writeCount % 2000 === 0) {
        const elapsed = (performance.now() - writeStart) / 1000;
        const rate = writeCount / elapsed;
        process.stdout.write(
          `\r    ${writeCount.toLocaleString()}/${DOC_COUNT.toLocaleString()} (${Math.round(rate)}/s)`
        );
      }
    })
  );
  await Promise.all(writePromises);
  const writeElapsed = performance.now() - writeStart;
  console.log(
    `\r    done: ${docIds.length.toLocaleString()} docs in ${(writeElapsed / 1000).toFixed(1)}s (${fmtRate(docIds.length, writeElapsed)})    `
  );

  // 2. Point reads
  const READ_COUNT = Math.min(200, docIds.length);
  console.log(`  [2/6] Point reads (${READ_COUNT})...`);
  const readPromises = Array.from({ length: READ_COUNT }, () =>
    pool.run(async () => {
      const id = pick(docIds);
      const { sample } = await timedFetch(
        "read",
        `${API}/collections/${COL}/${id}`,
        { headers: HEADERS }
      );
      samples.push(sample);
    })
  );
  await Promise.all(readPromises);
  console.log("    done");

  // 3. Full scan (no limit)
  console.log(`  [3/6] Full table scan (all ${docIds.length.toLocaleString()} docs, no limit)...`);
  const { sample: scanSample, body: scanBody } = await timedFetch(
    "full-scan",
    `${API}/collections/${COL}`,
    { headers: HEADERS }
  );
  samples.push(scanSample);
  const scanSize = scanBody ? JSON.stringify(scanBody).length : 0;
  console.log(
    `    done: ${fmtMs(scanSample.ms)}, ${(scanSize / 1024 / 1024).toFixed(1)}MB response`
  );

  // 4. Query battery
  console.log(`  [4/6] Query battery (500 queries, 5 types)...`);
  const queries: { name: string; q: string }[] = [
    { name: "q:equality", q: qs({ where: [["category", "==", "electronics"]] }) },
    { name: "q:range", q: qs({ where: [["price", ">", 500]] }) },
    {
      name: "q:compound",
      q: qs({ where: [["category", "==", "books"], ["price", "<", 200]] }),
    },
    { name: "q:ordered", q: qs({ orderBy: "price", order: "asc", limit: 50 }) },
    {
      name: "q:cursor",
      q: qs({ where: [["created", "<", Date.now()]], orderBy: "created", order: "desc", limit: 50 }),
    },
  ];
  const queryPromises: Promise<void>[] = [];
  for (let i = 0; i < 100; i++) {
    for (const query of queries) {
      queryPromises.push(
        pool.run(async () => {
          const { sample } = await timedFetch(
            query.name,
            `${API}/collections/${COL}${query.q}`,
            { headers: HEADERS }
          );
          samples.push(sample);
        })
      );
    }
  }
  await Promise.all(queryPromises);
  console.log("    done");

  // 5. Read-after-write consistency check
  console.log(`  [5/6] Read-after-write consistency (50 checks)...`);
  let rawConsistency = 0;
  const rawTotal = 50;
  const rawPromises = Array.from({ length: rawTotal }, (_, i) =>
    pool.run(async () => {
      const doc = { consistency_check: true, idx: i, ts: Date.now() };
      const { body: created } = await timedFetch(
        "raw-write",
        `${API}/collections/${COL}`,
        { method: "POST", headers: HEADERS, body: JSON.stringify(doc) }
      );
      if (!created?.id) return;
      const { body: read } = await timedFetch(
        "raw-read",
        `${API}/collections/${COL}/${created.id}`,
        { headers: HEADERS }
      );
      if (read?.data?.consistency_check === true) rawConsistency++;
    })
  );
  await Promise.all(rawPromises);
  console.log(`    ${rawConsistency}/${rawTotal} consistent`);

  // 6. Sustained mixed workload (30s)
  console.log(`  [6/6] Mixed workload (30s, 70/30 read/write)...`);
  const mixedEnd = performance.now() + 30_000;
  const mixedPromises: Promise<void>[] = [];
  let mixedOps = 0;
  while (performance.now() < mixedEnd) {
    const isWrite = Math.random() < 0.3;
    mixedPromises.push(
      pool.run(async () => {
        if (isWrite) {
          const { sample } = await timedFetch(
            "mixed-write",
            `${API}/collections/${COL}`,
            {
              method: "POST",
              headers: HEADERS,
              body: JSON.stringify(generateDoc(mixedOps)),
            }
          );
          samples.push(sample);
        } else {
          const id = pick(docIds);
          const { sample } = await timedFetch(
            "mixed-read",
            `${API}/collections/${COL}/${id}`,
            { headers: HEADERS }
          );
          samples.push(sample);
        }
        mixedOps++;
      })
    );
    // Slight backpressure to avoid runaway promise creation
    if (mixedPromises.length % 200 === 0) {
      await Promise.race(mixedPromises.slice(-50));
    }
  }
  await Promise.all(mixedPromises);
  console.log(`    done: ${mixedOps.toLocaleString()} ops`);

  const elapsed = performance.now() - stageStart;
  const metrics = await captureMetrics();
  printTable(
    `STAGE 1 — Light Load (${DOC_COUNT.toLocaleString()} docs, ${CONCURRENCY} concurrency)`,
    samples,
    elapsed,
    metrics
  );

  return { name: "Stage 1", totalDocs: docIds.length, elapsed, samples, metrics };
}

// ── STAGE 2: Medium Load ───────────────────────────────────────
async function stage2(): Promise<StageResult> {
  const TOTAL_DOCS = scaled(100_000);
  const NUM_COLS = scaled(50);
  const DOCS_PER_COL = Math.ceil(TOTAL_DOCS / NUM_COLS);
  const CONCURRENCY = 200;
  const samples: LatencySample[] = [];
  const docMap: Map<string, string[]> = new Map(); // collection -> ids
  const pool = new Pool(CONCURRENCY);

  console.log(
    `\n${"#".repeat(90)}\n  STAGE 2 — Medium Load (${TOTAL_DOCS.toLocaleString()} docs, ${CONCURRENCY} concurrency, ${NUM_COLS} collections)\n${"#".repeat(90)}`
  );

  const stageStart = performance.now();

  // 1. Spread write across N collections
  console.log(
    `\n  [1/7] Writing ${TOTAL_DOCS.toLocaleString()} docs across ${NUM_COLS} collections (${DOCS_PER_COL}/each)...`
  );
  const writeStart = performance.now();
  let writeCount = 0;
  const firstWriteSamples: LatencySample[] = [];
  const writePromises: Promise<void>[] = [];

  for (let c = 0; c < NUM_COLS; c++) {
    const col = `stress_s2_${String(c).padStart(2, "0")}`;
    docMap.set(col, []);
    for (let d = 0; d < DOCS_PER_COL; d++) {
      const isFirst = d === 0;
      writePromises.push(
        pool.run(async () => {
          const { sample, body } = await timedFetch(
            isFirst ? "first-write" : "write",
            `${API}/collections/${col}`,
            {
              method: "POST",
              headers: HEADERS,
              body: JSON.stringify(generateDoc(c * DOCS_PER_COL + d)),
            }
          );
          samples.push(sample);
          if (isFirst) firstWriteSamples.push(sample);
          if (body?.id) docMap.get(col)!.push(body.id);
          writeCount++;
          if (writeCount % 10_000 === 0) {
            const elapsed = (performance.now() - writeStart) / 1000;
            process.stdout.write(
              `\r    ${writeCount.toLocaleString()}/${TOTAL_DOCS.toLocaleString()} (${Math.round(writeCount / elapsed)}/s)`
            );
          }
        })
      );
    }
  }
  await Promise.all(writePromises);
  const writeElapsed = performance.now() - writeStart;
  const totalWritten = [...docMap.values()].reduce((a, b) => a + b.length, 0);
  console.log(
    `\r    done: ${totalWritten.toLocaleString()} docs in ${(writeElapsed / 1000).toFixed(1)}s (${fmtRate(totalWritten, writeElapsed)})    `
  );

  // Report first-write overhead
  const firstP = percentiles(firstWriteSamples);
  const steadyP = percentiles(samples.filter((s) => s.op === "write"));
  console.log(
    `    first-write p50: ${fmtMs(firstP.p50)} vs steady p50: ${fmtMs(steadyP.p50)} (CREATE TABLE overhead)`
  );

  // 2. Cross-collection queries
  console.log(`  [2/7] Cross-collection queries (250 queries)...`);
  const cols = [...docMap.keys()];
  const queryPromises: Promise<void>[] = [];
  for (const col of cols.slice(0, 50)) {
    const queryTypes: { name: string; q: string }[] = [
      { name: "xq:equality", q: qs({ where: [["category", "==", "electronics"]] }) },
      { name: "xq:range", q: qs({ where: [["price", ">", 500]] }) },
      { name: "xq:compound", q: qs({ where: [["category", "==", "books"], ["price", "<", 200]] }) },
      { name: "xq:ordered", q: qs({ orderBy: "price", order: "desc", limit: 50 }) },
      { name: "xq:cursor", q: qs({ where: [["created", "<", Date.now()]], limit: 50 }) },
    ];
    for (const qt of queryTypes) {
      queryPromises.push(
        pool.run(async () => {
          const { sample } = await timedFetch(qt.name, `${API}/collections/${col}${qt.q}`, {
            headers: HEADERS,
          });
          samples.push(sample);
        })
      );
    }
  }
  await Promise.all(queryPromises);
  console.log("    done");

  // 3. Large result sets
  console.log(`  [3/7] Large result set queries...`);
  const bigCol = cols[0];
  for (const lim of [500, 1000, 2000]) {
    const { sample, body } = await timedFetch(
      `large-${lim}`,
      `${API}/collections/${bigCol}${qs({ limit: lim })}`,
      { headers: HEADERS }
    );
    samples.push(sample);
    const respSize = body ? JSON.stringify(body).length : 0;
    console.log(
      `    limit=${lim}: ${fmtMs(sample.ms)}, ${Math.round(respSize / 1024)}KB, ${body?.length ?? 0} docs`
    );
  }

  // 4. Concurrent write race
  console.log(`  [4/7] Concurrent write race (20 PATCHes x 10 docs)...`);
  const raceCol = cols[0];
  const raceIds = docMap.get(raceCol)!.slice(0, 10);
  let raceErrors = 0;
  const racePromises: Promise<void>[] = [];
  for (const id of raceIds) {
    for (let p = 0; p < 20; p++) {
      racePromises.push(
        pool.run(async () => {
          const { sample } = await timedFetch(
            "race-patch",
            `${API}/collections/${raceCol}/${id}`,
            {
              method: "PATCH",
              headers: HEADERS,
              body: JSON.stringify({ race_counter: p, ts: Date.now() }),
            }
          );
          samples.push(sample);
          if (!sample.ok) raceErrors++;
        })
      );
    }
  }
  await Promise.all(racePromises);
  console.log(`    done: ${raceErrors} errors out of ${raceIds.length * 20} patches`);

  // Verify final state isn't corrupted
  let corrupted = 0;
  for (const id of raceIds) {
    const { body } = await timedFetch("race-verify", `${API}/collections/${raceCol}/${id}`, {
      headers: HEADERS,
    });
    if (!body?.data || typeof body.data.race_counter !== "number") corrupted++;
  }
  console.log(`    corruption check: ${corrupted === 0 ? "PASS" : `FAIL (${corrupted} corrupted)`}`);

  // 5. Upsert storm
  console.log(`  [5/7] Upsert storm (500 PUTs)...`);
  const upsertCol = cols[1];
  const existingIds = docMap.get(upsertCol)!.slice(0, 250);
  const upsertPromises: Promise<void>[] = [];
  for (let i = 0; i < 500; i++) {
    const id = i < 250 ? existingIds[i] : `upsert_new_${i}`;
    upsertPromises.push(
      pool.run(async () => {
        const { sample } = await timedFetch(
          "upsert",
          `${API}/collections/${upsertCol}/${id}`,
          {
            method: "PUT",
            headers: HEADERS,
            body: JSON.stringify(generateDoc(i + 100_000)),
          }
        );
        samples.push(sample);
      })
    );
  }
  await Promise.all(upsertPromises);
  console.log("    done");

  // 6. Sustained mixed (60s) with windowed throughput
  console.log(`  [6/7] Mixed workload (60s, 50/30/20 read/write/update)...`);
  const mixedEnd = performance.now() + 60_000;
  const mixedPromises: Promise<void>[] = [];
  let mixedOps = 0;
  const windowBuckets: Map<number, { reads: number; writes: number; updates: number }> = new Map();

  while (performance.now() < mixedEnd) {
    const r = Math.random();
    const windowKey = Math.floor((performance.now() - stageStart) / 5000);
    if (!windowBuckets.has(windowKey))
      windowBuckets.set(windowKey, { reads: 0, writes: 0, updates: 0 });
    const bucket = windowBuckets.get(windowKey)!;

    if (r < 0.5) {
      // read
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(cols);
          const ids = docMap.get(col)!;
          if (ids.length === 0) return;
          const { sample } = await timedFetch(
            "mixed-read",
            `${API}/collections/${col}/${pick(ids)}`,
            { headers: HEADERS }
          );
          samples.push(sample);
          bucket.reads++;
        })
      );
    } else if (r < 0.8) {
      // write
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(cols);
          const { sample, body } = await timedFetch(
            "mixed-write",
            `${API}/collections/${col}`,
            {
              method: "POST",
              headers: HEADERS,
              body: JSON.stringify(generateDoc(mixedOps)),
            }
          );
          samples.push(sample);
          if (body?.id) docMap.get(col)!.push(body.id);
          bucket.writes++;
        })
      );
    } else {
      // update
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(cols);
          const ids = docMap.get(col)!;
          if (ids.length === 0) return;
          const { sample } = await timedFetch(
            "mixed-update",
            `${API}/collections/${col}/${pick(ids)}`,
            {
              method: "PATCH",
              headers: HEADERS,
              body: JSON.stringify({ updated_at_test: Date.now() }),
            }
          );
          samples.push(sample);
          bucket.updates++;
        })
      );
    }
    mixedOps++;
    if (mixedPromises.length % 500 === 0) {
      await Promise.race(mixedPromises.slice(-100));
    }
  }
  await Promise.all(mixedPromises);
  console.log(`    done: ${mixedOps.toLocaleString()} ops`);

  // Print windowed throughput
  const sortedWindows = [...windowBuckets.entries()].sort((a, b) => a[0] - b[0]);
  if (sortedWindows.length > 2) {
    console.log("    throughput by 5s window:");
    for (const [, b] of sortedWindows.slice(0, 12)) {
      const total = b.reads + b.writes + b.updates;
      console.log(
        `      ${Math.round(total / 5)}/s  (R:${Math.round(b.reads / 5)} W:${Math.round(b.writes / 5)} U:${Math.round(b.updates / 5)})`
      );
    }
  }

  // 7. Delete sweep
  const DELETE_COUNT = Math.min(scaled(10_000), totalWritten);
  console.log(`  [7/7] Delete sweep (${DELETE_COUNT.toLocaleString()} docs)...`);
  let deleteCount = 0;
  const deletePromises: Promise<void>[] = [];
  for (const col of cols) {
    const ids = docMap.get(col)!;
    const toDelete = ids.splice(0, Math.ceil(DELETE_COUNT / cols.length));
    for (const id of toDelete) {
      deletePromises.push(
        pool.run(async () => {
          const { sample } = await timedFetch(
            "delete",
            `${API}/collections/${col}/${id}`,
            { method: "DELETE", headers: HEADERS }
          );
          samples.push(sample);
          deleteCount++;
        })
      );
    }
  }
  await Promise.all(deletePromises);
  console.log(`    done: ${deleteCount.toLocaleString()} deleted`);

  const elapsed = performance.now() - stageStart;
  const metrics = await captureMetrics();
  printTable(
    `STAGE 2 — Medium Load (${TOTAL_DOCS.toLocaleString()} docs, ${CONCURRENCY} concurrency, ${NUM_COLS} collections)`,
    samples,
    elapsed,
    metrics
  );

  return { name: "Stage 2", totalDocs: totalWritten, elapsed, samples, metrics };
}

// ── STAGE 3: Heavy Load ────────────────────────────────────────
async function stage3(): Promise<StageResult> {
  const TOTAL_DOCS = scaled(1_000_000);
  const NUM_COLS = scaled(200);
  const DOCS_PER_COL = Math.ceil(TOTAL_DOCS / NUM_COLS);
  const MAX_CONCURRENCY = 500;
  const samples: LatencySample[] = [];
  const docMap: Map<string, string[]> = new Map();

  // Adaptive concurrency: ramp up
  const pool = new Pool(100);
  const rampThresholds = [
    { at: Math.floor(TOTAL_DOCS * 0.1), conc: 200 },
    { at: Math.floor(TOTAL_DOCS * 0.25), conc: 300 },
    { at: Math.floor(TOTAL_DOCS * 0.5), conc: 400 },
    { at: Math.floor(TOTAL_DOCS * 0.75), conc: MAX_CONCURRENCY },
  ];

  console.log(
    `\n${"#".repeat(90)}\n  STAGE 3 — Heavy Load (${TOTAL_DOCS.toLocaleString()} docs, up to ${MAX_CONCURRENCY} concurrency, ${NUM_COLS} collections)\n${"#".repeat(90)}`
  );

  const stageStart = performance.now();

  // 1. Bulk write 1M docs with adaptive concurrency
  console.log(
    `\n  [1/7] Writing ${TOTAL_DOCS.toLocaleString()} docs across ${NUM_COLS} collections...`
  );
  const writeStart = performance.now();
  let writeCount = 0;
  let errorCount = 0;
  let lastProgress = 0;
  const writePromises: Promise<void>[] = [];

  for (let c = 0; c < NUM_COLS; c++) {
    const col = `stress_s3_${String(c).padStart(3, "0")}`;
    docMap.set(col, []);
    for (let d = 0; d < DOCS_PER_COL; d++) {
      writePromises.push(
        pool.run(async () => {
          const { sample, body } = await timedFetch(
            "write",
            `${API}/collections/${col}`,
            {
              method: "POST",
              headers: HEADERS,
              body: JSON.stringify(generateDoc(c * DOCS_PER_COL + d)),
            }
          );
          samples.push(sample);
          if (body?.id) docMap.get(col)!.push(body.id);
          else errorCount++;
          writeCount++;

          // Adaptive ramp
          for (const t of rampThresholds) {
            if (writeCount >= t.at && pool.max < t.conc) {
              pool.max = t.conc;
              console.log(`\n    -> concurrency ramped to ${t.conc}`);
            }
          }

          // Adaptive backoff on high error rate
          if (
            writeCount > 1000 &&
            errorCount / writeCount > 0.5 &&
            pool.max > 50
          ) {
            pool.max = Math.max(50, Math.floor(pool.max / 2));
            console.log(
              `\n    -> ERROR RATE ${Math.round((errorCount / writeCount) * 100)}%, reducing concurrency to ${pool.max}`
            );
            errorCount = 0; // Reset so we don't keep halving
          }

          // Progress every 10s
          const now = performance.now();
          if (now - lastProgress > 10_000) {
            lastProgress = now;
            const elapsed = (now - writeStart) / 1000;
            const rate = writeCount / elapsed;
            const eta = (TOTAL_DOCS - writeCount) / rate;
            process.stdout.write(
              `\r    ${writeCount.toLocaleString()}/${TOTAL_DOCS.toLocaleString()} (${Math.round(rate)}/s, ETA ${Math.round(eta)}s, errors: ${errorCount}, conc: ${pool.max})`
            );
          }
        })
      );
    }
  }
  await Promise.all(writePromises);
  const writeElapsed = performance.now() - writeStart;
  const totalWritten = [...docMap.values()].reduce((a, b) => a + b.length, 0);
  console.log(
    `\r    done: ${totalWritten.toLocaleString()} docs in ${(writeElapsed / 1000).toFixed(1)}s (${fmtRate(totalWritten, writeElapsed)}, ${errorCount} errors)    `
  );

  // Reset pool to max for read tests
  pool.max = MAX_CONCURRENCY;

  // 2. Point reads at scale
  const READ_COUNT = 1000;
  console.log(`  [2/7] Point reads at scale (${READ_COUNT})...`);
  const allCols = [...docMap.keys()];
  const readPromises = Array.from({ length: READ_COUNT }, () =>
    pool.run(async () => {
      const col = pick(allCols);
      const ids = docMap.get(col)!;
      if (ids.length === 0) return;
      const { sample } = await timedFetch(
        "read",
        `${API}/collections/${col}/${pick(ids)}`,
        { headers: HEADERS }
      );
      samples.push(sample);
    })
  );
  await Promise.all(readPromises);
  console.log("    done");

  // 3. Query performance at scale
  console.log(`  [3/7] Query battery at ${TOTAL_DOCS.toLocaleString()} doc scale...`);
  const testCol = allCols[0];

  // 3a. Narrow filter
  const { sample: narrowS } = await timedFetch(
    "q:narrow",
    `${API}/collections/${testCol}${qs({ where: [["category", "==", "electronics"]] })}`,
    { headers: HEADERS }
  );
  samples.push(narrowS);
  console.log(`    narrow filter: ${fmtMs(narrowS.ms)}`);

  // 3b. Wide filter + limit
  const { sample: wideS } = await timedFetch(
    "q:wide+limit",
    `${API}/collections/${testCol}${qs({ where: [["price", ">", 100]], limit: 100 })}`,
    { headers: HEADERS }
  );
  samples.push(wideS);
  console.log(`    wide filter+limit: ${fmtMs(wideS.ms)}`);

  // 3c. Compound
  const { sample: compS } = await timedFetch(
    "q:compound",
    `${API}/collections/${testCol}${qs({ where: [["category", "==", "books"], ["rating", ">", 4]] })}`,
    { headers: HEADERS }
  );
  samples.push(compS);
  console.log(`    compound filter: ${fmtMs(compS.ms)}`);

  // 3d. Sort on non-indexed field
  const { sample: sortS } = await timedFetch(
    "q:sort-noindex",
    `${API}/collections/${testCol}${qs({ orderBy: "rating", order: "desc", limit: 100 })}`,
    { headers: HEADERS }
  );
  samples.push(sortS);
  console.log(`    sort non-indexed: ${fmtMs(sortS.ms)}`);

  // 3e. Full table scan (no filter, no limit)
  const { sample: fullS, body: fullBody } = await timedFetch(
    "q:full-scan",
    `${API}/collections/${testCol}`,
    { headers: HEADERS }
  );
  samples.push(fullS);
  const scanSize = fullBody ? JSON.stringify(fullBody).length : 0;
  console.log(
    `    full scan: ${fmtMs(fullS.ms)}, ${(scanSize / 1024 / 1024).toFixed(1)}MB, ${fullBody?.length ?? 0} docs`
  );

  // 3f. Concurrent query burst (200 queries)
  console.log("    concurrent query burst (200 mixed queries)...");
  const burstQueries = Array.from({ length: 200 }, (_, i) => {
    const type = i % 4;
    const col = pick(allCols);
    if (type === 0)
      return { name: "burst:eq", q: qs({ where: [["category", "==", pick(CATEGORIES)]] }), col };
    if (type === 1)
      return { name: "burst:range", q: qs({ where: [["price", ">", 300]], limit: 100 }), col };
    if (type === 2)
      return { name: "burst:sort", q: qs({ orderBy: "price", order: "asc", limit: 50 }), col };
    return { name: "burst:cursor", q: qs({ where: [["created", "<", Date.now()]], limit: 50 }), col };
  });
  const burstPromises = burstQueries.map((bq) =>
    pool.run(async () => {
      const { sample } = await timedFetch(bq.name, `${API}/collections/${bq.col}${bq.q}`, {
        headers: HEADERS,
      });
      samples.push(sample);
    })
  );
  await Promise.all(burstPromises);
  console.log("    done");

  // 4. Sustained mixed workload (120s)
  console.log(`  [4/7] Mixed workload (120s, 60/20/10/10 R/W/U/D)...`);
  const mixedEnd = performance.now() + 120_000;
  const mixedPromises: Promise<void>[] = [];
  let mixedOps = 0;
  const secBuckets: Map<number, number> = new Map();

  while (performance.now() < mixedEnd) {
    const r = Math.random();
    const sec = Math.floor((performance.now() - stageStart) / 1000);
    secBuckets.set(sec, (secBuckets.get(sec) || 0) + 1);

    if (r < 0.6) {
      // read
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(allCols);
          const ids = docMap.get(col)!;
          if (ids.length === 0) return;
          const { sample } = await timedFetch(
            "mixed-read",
            `${API}/collections/${col}/${pick(ids)}`,
            { headers: HEADERS }
          );
          samples.push(sample);
        })
      );
    } else if (r < 0.8) {
      // write
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(allCols);
          const { sample, body } = await timedFetch(
            "mixed-write",
            `${API}/collections/${col}`,
            {
              method: "POST",
              headers: HEADERS,
              body: JSON.stringify(generateDoc(mixedOps)),
            }
          );
          samples.push(sample);
          if (body?.id) docMap.get(col)?.push(body.id);
        })
      );
    } else if (r < 0.9) {
      // update
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(allCols);
          const ids = docMap.get(col)!;
          if (ids.length === 0) return;
          const { sample } = await timedFetch(
            "mixed-update",
            `${API}/collections/${col}/${pick(ids)}`,
            {
              method: "PATCH",
              headers: HEADERS,
              body: JSON.stringify({ stress_update: Date.now() }),
            }
          );
          samples.push(sample);
        })
      );
    } else {
      // delete
      mixedPromises.push(
        pool.run(async () => {
          const col = pick(allCols);
          const ids = docMap.get(col)!;
          if (ids.length === 0) return;
          const id = ids.pop()!;
          const { sample } = await timedFetch(
            "mixed-delete",
            `${API}/collections/${col}/${id}`,
            { method: "DELETE", headers: HEADERS }
          );
          samples.push(sample);
        })
      );
    }
    mixedOps++;
    if (mixedPromises.length % 1000 === 0) {
      await Promise.race(mixedPromises.slice(-200));
    }
  }
  await Promise.all(mixedPromises);
  console.log(`    done: ${mixedOps.toLocaleString()} ops`);

  // Print per-second throughput trend (sample a few windows)
  const sortedSecs = [...secBuckets.entries()].sort((a, b) => a[0] - b[0]);
  if (sortedSecs.length > 10) {
    const step = Math.floor(sortedSecs.length / 10);
    console.log("    throughput samples (ops/s):");
    let trend = "    ";
    for (let i = 0; i < sortedSecs.length; i += step) {
      trend += `${sortedSecs[i][1]} `;
    }
    console.log(trend);
  }

  // 5. Thundering herd
  console.log(`  [5/7] Thundering herd (500 simultaneous requests)...`);
  await Bun.sleep(2000);
  const herdStart = performance.now();
  const herdPromises = Array.from({ length: 500 }, (_, i) => {
    const col = pick(allCols);
    const ids = docMap.get(col)!;
    if (i % 2 === 0 && ids.length > 0) {
      return timedFetch("herd-read", `${API}/collections/${col}/${pick(ids)}`, {
        headers: HEADERS,
      });
    } else {
      return timedFetch("herd-write", `${API}/collections/${col}`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(generateDoc(i)),
      });
    }
  });
  const herdResults = await Promise.all(herdPromises);
  const herdElapsed = performance.now() - herdStart;
  const herdOk = herdResults.filter((r) => r.sample.ok).length;
  const herdFail = herdResults.filter((r) => !r.sample.ok).length;
  for (const r of herdResults) samples.push(r.sample);
  console.log(
    `    ${herdOk} succeeded, ${herdFail} failed in ${fmtMs(herdElapsed)}`
  );

  // 6. Collection enumeration
  console.log(`  [6/7] List ${NUM_COLS} collections...`);
  const { sample: listS, body: listBody } = await timedFetch(
    "list-collections",
    `${API}/collections`,
    { headers: HEADERS }
  );
  samples.push(listS);
  console.log(
    `    ${listBody?.length ?? 0} collections listed in ${fmtMs(listS.ms)}`
  );

  // 7. Final DB size
  console.log(`  [7/7] Final measurements...`);
  const finalTotal = [...docMap.values()].reduce((a, b) => a + b.length, 0);
  const elapsed = performance.now() - stageStart;
  const metrics = await captureMetrics();

  // Compute bytes-per-doc
  const sizeMatch = metrics.dbSize.match(/([\d.]+)\s*(bytes|kB|MB|GB)/);
  let bytesTotal = 0;
  if (sizeMatch) {
    const num = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2];
    if (unit === "bytes") bytesTotal = num;
    else if (unit === "kB") bytesTotal = num * 1024;
    else if (unit === "MB") bytesTotal = num * 1024 * 1024;
    else if (unit === "GB") bytesTotal = num * 1024 * 1024 * 1024;
  }
  const bytesPerDoc = finalTotal > 0 ? Math.round(bytesTotal / finalTotal) : 0;

  printTable(
    `STAGE 3 — Heavy Load (${TOTAL_DOCS.toLocaleString()} docs, ${MAX_CONCURRENCY} concurrency, ${NUM_COLS} collections)`,
    samples,
    elapsed,
    metrics
  );

  if (bytesPerDoc > 0) {
    console.log(
      `  Bytes per document: ~${bytesPerDoc} bytes (${finalTotal.toLocaleString()} docs → ${metrics.dbSize})`
    );
  }

  return { name: "Stage 3", totalDocs: finalTotal, elapsed, samples, metrics };
}

// ── Final Synopsis ─────────────────────────────────────────────
function printSynopsis(results: StageResult[]) {
  console.log("\n" + "=".repeat(90));
  console.log("  FINAL SYNOPSIS");
  console.log("=".repeat(90));
  console.log();
  console.log(
    "  " +
      "Stage".padEnd(12) +
      "Docs".padStart(10) +
      "Write/s".padStart(10) +
      "Read/s".padStart(10) +
      "p95 write".padStart(12) +
      "p95 read".padStart(12) +
      "Errors".padStart(8) +
      "DB size".padStart(12)
  );
  console.log("  " + "\u2500".repeat(86));

  for (const r of results) {
    const wp = percentiles(r.samples, ["write", "first-write"]);
    const rp = percentiles(r.samples, ["read"]);
    const totalErrors = r.samples.filter((s) => !s.ok).length;
    console.log(
      "  " +
        r.name.padEnd(12) +
        r.totalDocs.toLocaleString().padStart(10) +
        fmtRate(wp.count, r.elapsed).padStart(10) +
        fmtRate(rp.count, r.elapsed).padStart(10) +
        fmtMs(wp.p95).padStart(12) +
        fmtMs(rp.p95).padStart(12) +
        String(totalErrors).padStart(8) +
        r.metrics.dbSize.padStart(12)
    );
  }

  console.log();
  console.log("  Known bottlenecks to watch for:");
  console.log("    - nginx worker_connections=256 (caps concurrent connections)");
  console.log("    - Postgres pool=10 (postgresjs default, all requests queue through 10 conns)");
  console.log("    - NOTIFY per write (extra Postgres round-trip for every mutation)");
  console.log("    - JSONB range queries use ::numeric cast per-row (GIN index can't help)");
  console.log("    - ORDER BY data->>'field' is text sort, no B-tree index");
  console.log("    - No default query LIMIT — unbounded GET returns ALL docs");
  console.log();
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log("\n  ezbase Stress Test");
  console.log(`  target: ${BASE}`);
  console.log(`  scale:  ${SCALE}x`);
  if (STAGE_FILTER) console.log(`  stage:  ${STAGE_FILTER} only`);
  console.log();

  await waitForHealthy();

  const results: StageResult[] = [];

  if (!STAGE_FILTER || STAGE_FILTER === 1) {
    const r = await stage1();
    results.push(r);

    // Gate: if write throughput is terrible, warn
    const wp = percentiles(r.samples, ["write"]);
    if (wp.count > 0) {
      const rate = wp.count / (r.elapsed / 1000);
      if (rate < 100) {
        console.log(
          `\n  WARNING: Write throughput is only ${Math.round(rate)}/s. Later stages will take a very long time.`
        );
        console.log("  Consider running with SCALE=0.1 or checking the server.\n");
      }
    }
  }

  if (!STAGE_FILTER || STAGE_FILTER === 2) {
    results.push(await stage2());
  }

  if (!STAGE_FILTER || STAGE_FILTER === 3) {
    results.push(await stage3());
  }

  printSynopsis(results);
  console.log("  done.\n");
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

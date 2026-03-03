#!/usr/bin/env bun
// ── ezbase Query Performance Deep-Dive ────────────────────────
// Focused on query latency, document size impact, and SDK overhead.
// Run: cd test && docker compose up -d && bun run query-bench.ts

import EzBase from "../sdk/src/index";

const BASE = process.env.URL || "http://localhost:7003";
const API = `${BASE}/api`;
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
const HEADERS = {
  Authorization: `Bearer ${ADMIN_KEY}`,
  "Content-Type": "application/json",
};
const STAGE_FILTER = process.env.STAGE ? parseInt(process.env.STAGE) : 0;
const TIMEOUT_MS = 60_000;

// ── Types ──────────────────────────────────────────────────────
interface LatencySample {
  op: string;
  ms: number;
  status: number;
  ok: boolean;
  bytes?: number;
}

interface ResourceMetrics {
  containerStats: string;
  dbSize: string;
  pgConns: string;
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
): Promise<{ sample: LatencySample; body: any; rawBytes: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = performance.now() - t0;
    const text = res.ok ? await res.text() : "";
    const rawBytes = text.length;
    const body = text ? JSON.parse(text) : null;
    return {
      sample: { op, ms, status: res.status, ok: res.ok, bytes: rawBytes },
      body,
      rawBytes,
    };
  } catch {
    const ms = performance.now() - t0;
    return { sample: { op, ms, status: 0, ok: false }, body: null, rawBytes: 0 };
  }
}

function percentiles(samples: LatencySample[]) {
  const ok = samples.filter((s) => s.ok);
  const times = ok.map((s) => s.ms).sort((a, b) => a - b);
  if (times.length === 0)
    return { count: 0, errors: samples.length, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const p = (pct: number) =>
    times[Math.min(Math.floor((times.length * pct) / 100), times.length - 1)];
  return {
    count: times.length,
    errors: samples.filter((s) => !s.ok).length,
    p50: p(50),
    p95: p(95),
    p99: p(99),
    max: times[times.length - 1],
    mean: times.reduce((a, b) => a + b, 0) / times.length,
  };
}

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

// ── Output ─────────────────────────────────────────────────────
function fmtMs(ms: number): string {
  if (ms === 0) return "-";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(b: number): string {
  if (b === 0) return "-";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function fmtRate(count: number, elapsed: number): string {
  if (elapsed === 0) return "-";
  const rate = count / (elapsed / 1000);
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}K/s`;
  return `${Math.round(rate)}/s`;
}

function printQueryTable(label: string, groups: Map<string, LatencySample[]>) {
  console.log();
  console.log("=".repeat(94));
  console.log(`  ${label}`);
  console.log("=".repeat(94));
  console.log();
  console.log(
    "  " +
      "Query".padEnd(26) +
      "Runs".padStart(6) +
      "Err".padStart(5) +
      "p50".padStart(9) +
      "p95".padStart(9) +
      "p99".padStart(9) +
      "max".padStart(9) +
      "avg".padStart(9) +
      "resp".padStart(10)
  );
  console.log("  " + "\u2500".repeat(90));

  for (const [name, samples] of groups) {
    const p = percentiles(samples);
    const avgBytes =
      samples.filter((s) => s.ok && s.bytes).reduce((a, s) => a + (s.bytes || 0), 0) /
      Math.max(1, p.count);
    console.log(
      "  " +
        name.padEnd(26) +
        String(p.count).padStart(6) +
        String(p.errors).padStart(5) +
        fmtMs(p.p50).padStart(9) +
        fmtMs(p.p95).padStart(9) +
        fmtMs(p.p99).padStart(9) +
        fmtMs(p.max).padStart(9) +
        fmtMs(p.mean).padStart(9) +
        fmtBytes(avgBytes).padStart(10)
    );
  }
  console.log();
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
  const containers = await run(["docker", "ps", "--format", "{{.Names}}", "--filter", "ancestor=test-ezbase"]);
  let containerName = containers.split("\n")[0] || "test-ezbase-1";
  if (containerName === "test-ezbase-1") {
    const all = await run(["docker", "ps", "--format", "{{.Names}}"]);
    const match = all.split("\n").find((n) => n.includes("ezbase"));
    if (match) containerName = match;
  }
  const containerStats = await run(["docker", "stats", "--no-stream", "--format", "CPU: {{.CPUPerc}}  Mem: {{.MemUsage}} ({{.MemPerc}})", containerName]);
  const dbSize = await run(["docker", "exec", containerName, "su", "postgres", "-c", `psql -t -c "SELECT pg_size_pretty(pg_database_size('ezbase'))"`]);
  const pgConns = await run(["docker", "exec", containerName, "su", "postgres", "-c", `psql -t -c "SELECT count(*) FROM pg_stat_activity WHERE datname='ezbase'"`]);
  return { containerStats, dbSize, pgConns };
}

// ── Health Check ───────────────────────────────────────────────
async function waitForHealthy() {
  console.log(`\nWaiting for ezbase at ${BASE}...`);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) { console.log("  healthy!\n"); return; }
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error("ezbase did not become healthy after 120s");
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Document Generators ────────────────────────────────────────
const STATUSES = ["active", "inactive", "pending", "suspended", "archived"];
const DEPARTMENTS = ["engineering", "sales", "marketing", "support", "finance", "hr", "ops", "legal"];
const TIERS = ["free", "starter", "pro", "enterprise"];

function lightDoc(i: number) {
  return {
    name: `User ${i}`,
    email: `user${i}@example.com`,
    status: STATUSES[i % STATUSES.length],
    score: Math.round(Math.random() * 100),
    tier: TIERS[i % TIERS.length],
    department: DEPARTMENTS[i % DEPARTMENTS.length],
    age: 18 + (i % 50),
    active: i % 3 !== 0,
  };
}

function heavyDoc(i: number) {
  const tags = Array.from({ length: 20 }, (_, j) => `tag_${(i + j) % 100}`);
  const history = Array.from({ length: 10 }, (_, j) => ({
    action: ["login", "purchase", "update", "view", "delete"][j % 5],
    timestamp: Date.now() - j * 86400000,
    details: `Action ${j} for user ${i} with extended description that adds realistic payload size to the document`,
    metadata: { ip: `192.168.${j}.${i % 256}`, ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  }));
  const address = {
    street: `${i} Main Street, Apt ${i % 100}`,
    city: ["New York", "San Francisco", "Chicago", "Austin", "Seattle", "Denver", "Miami", "Boston"][i % 8],
    state: ["NY", "CA", "IL", "TX", "WA", "CO", "FL", "MA"][i % 8],
    zip: `${10000 + (i % 90000)}`,
    country: "US",
  };
  const preferences = {
    theme: i % 2 === 0 ? "dark" : "light",
    language: ["en", "es", "fr", "de", "ja"][i % 5],
    notifications: { email: true, push: i % 3 === 0, sms: false },
    dashboardLayout: Array.from({ length: 5 }, (_, j) => ({ widget: `widget_${j}`, position: j, enabled: j < 3 })),
  };
  return {
    name: `User ${i}`,
    email: `user${i}@example.com`,
    status: STATUSES[i % STATUSES.length],
    score: Math.round(Math.random() * 100),
    tier: TIERS[i % TIERS.length],
    department: DEPARTMENTS[i % DEPARTMENTS.length],
    age: 18 + (i % 50),
    active: i % 3 !== 0,
    bio: `This is a detailed biography for user ${i}. `.repeat(10),
    tags,
    history,
    address,
    preferences,
  };
}

function sizedDoc(targetBytes: number): Record<string, unknown> {
  // Create a document of approximately targetBytes
  const base = { marker: "size-test", size: targetBytes };
  const baseSize = JSON.stringify(base).length;
  const padding = "x".repeat(Math.max(0, targetBytes - baseSize - 20));
  return { ...base, payload: padding };
}

// ── Seed Helper ────────────────────────────────────────────────
async function seedCollection(
  col: string,
  count: number,
  genFn: (i: number) => Record<string, unknown>,
  concurrency: number
): Promise<string[]> {
  const pool = new Pool(concurrency);
  const ids: string[] = [];
  const start = performance.now();
  let written = 0;

  const promises = Array.from({ length: count }, (_, i) =>
    pool.run(async () => {
      const res = await fetch(`${API}/collections/${col}`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(genFn(i)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.id) ids.push(body.id);
      } else {
        try { await res.text(); } catch {}
      }
      written++;
      if (written % 5000 === 0 || written === count) {
        const elapsed = (performance.now() - start) / 1000;
        process.stdout.write(
          `\r    ${written.toLocaleString()}/${count.toLocaleString()} (${Math.round(written / elapsed)}/s)`
        );
      }
    })
  );
  await Promise.all(promises);
  const elapsed = performance.now() - start;
  console.log(
    `\r    done: ${ids.length.toLocaleString()} docs in ${(elapsed / 1000).toFixed(1)}s (${fmtRate(ids.length, elapsed)})    `
  );
  return ids;
}

// ── Query Battery ──────────────────────────────────────────────
interface QueryDef {
  name: string;
  q: string;
}

const QUERY_BATTERY: QueryDef[] = [
  { name: "eq:status", q: qs({ where: [["status", "==", "active"]] }) },
  { name: "eq:department", q: qs({ where: [["department", "==", "engineering"]] }) },
  { name: "eq:status+limit", q: qs({ where: [["status", "==", "active"]], limit: 100 }) },
  { name: "range:score", q: qs({ where: [["score", ">", 75]] }) },
  { name: "range:age", q: qs({ where: [["age", ">=", 30], ["age", "<", 40]] }) },
  { name: "range:score+limit", q: qs({ where: [["score", ">", 75]], limit: 100 }) },
  { name: "compound", q: qs({ where: [["status", "==", "active"], ["score", ">", 50]] }) },
  { name: "compound+limit", q: qs({ where: [["status", "==", "active"], ["score", ">", 50]], limit: 100 }) },
  { name: "sort:score", q: qs({ orderBy: "score", order: "desc", limit: 100 }) },
  { name: "sort:created(idx)", q: qs({ orderBy: "created", order: "desc", limit: 100 }) },
  { name: "sort:age", q: qs({ orderBy: "age", order: "asc", limit: 100 }) },
  { name: "full-scan", q: "" },
];

async function runQueryBattery(
  col: string,
  iterations: number,
  concurrency: number
): Promise<Map<string, LatencySample[]>> {
  const pool = new Pool(concurrency);
  const groups = new Map<string, LatencySample[]>();
  for (const qd of QUERY_BATTERY) groups.set(qd.name, []);

  const promises: Promise<void>[] = [];
  for (let i = 0; i < iterations; i++) {
    for (const qd of QUERY_BATTERY) {
      promises.push(
        pool.run(async () => {
          const { sample } = await timedFetch(qd.name, `${API}/collections/${col}${qd.q}`, {
            headers: HEADERS,
          });
          groups.get(qd.name)!.push(sample);
        })
      );
    }
  }
  await Promise.all(promises);
  return groups;
}

// ── STAGE 1: Lightweight Documents ─────────────────────────────
async function stage1() {
  const DOC_COUNT = 100_000;
  const COL = "qb_light";
  const CONCURRENCY = 100;
  const ITERATIONS = 50;

  console.log(
    `\n${"#".repeat(94)}\n  STAGE 1 — Lightweight Documents (${DOC_COUNT.toLocaleString()} docs, ~200 bytes each)\n${"#".repeat(94)}`
  );

  // Seed
  console.log(`\n  [1/3] Seeding ${DOC_COUNT.toLocaleString()} lightweight documents...`);
  await seedCollection(COL, DOC_COUNT, lightDoc, CONCURRENCY);

  // Verify count
  const { body: allDocs } = await timedFetch("count-check", `${API}/collections/${COL}${qs({ limit: 1 })}`, { headers: HEADERS });

  // Run battery
  console.log(`  [2/3] Running query battery (${ITERATIONS} iterations each, ${CONCURRENCY} concurrency)...`);
  const groups = await runQueryBattery(COL, ITERATIONS, CONCURRENCY);

  // Concurrent burst
  console.log(`  [3/3] Concurrent query burst (200 mixed queries)...`);
  const burstPool = new Pool(200);
  const burstGroups = new Map<string, LatencySample[]>();
  const burstPromises: Promise<void>[] = [];
  for (let i = 0; i < 200; i++) {
    const qd = pick(QUERY_BATTERY);
    const bname = `burst:${qd.name}`;
    if (!burstGroups.has(bname)) burstGroups.set(bname, []);
    burstPromises.push(
      burstPool.run(async () => {
        const { sample } = await timedFetch(bname, `${API}/collections/${COL}${qd.q}`, { headers: HEADERS });
        burstGroups.get(bname)!.push(sample);
      })
    );
  }
  await Promise.all(burstPromises);
  console.log("    done");

  // Merge burst into groups for display
  for (const [name, samples] of burstGroups) {
    groups.set(name, samples);
  }

  const metrics = await captureMetrics();
  printQueryTable(`STAGE 1 — Lightweight (${DOC_COUNT.toLocaleString()} docs, ~200B each)`, groups);
  console.log(`  Resources: ${metrics.containerStats}`);
  console.log(`  DB size: ${metrics.dbSize}  |  PG connections: ${metrics.pgConns}`);

  return groups;
}

// ── STAGE 2: Heavyweight Documents ─────────────────────────────
async function stage2() {
  const DOC_COUNT = 50_000;
  const COL = "qb_heavy";
  const CONCURRENCY = 100;
  const ITERATIONS = 50;

  console.log(
    `\n${"#".repeat(94)}\n  STAGE 2 — Heavyweight Documents (${DOC_COUNT.toLocaleString()} docs, ~10KB each)\n${"#".repeat(94)}`
  );

  // Seed
  console.log(`\n  [1/2] Seeding ${DOC_COUNT.toLocaleString()} heavyweight documents...`);
  await seedCollection(COL, DOC_COUNT, heavyDoc, CONCURRENCY);

  // Run battery
  console.log(`  [2/2] Running query battery (${ITERATIONS} iterations each, ${CONCURRENCY} concurrency)...`);
  const groups = await runQueryBattery(COL, ITERATIONS, CONCURRENCY);

  const metrics = await captureMetrics();
  printQueryTable(`STAGE 2 — Heavyweight (${DOC_COUNT.toLocaleString()} docs, ~10KB each)`, groups);
  console.log(`  Resources: ${metrics.containerStats}`);
  console.log(`  DB size: ${metrics.dbSize}  |  PG connections: ${metrics.pgConns}`);

  return groups;
}

// ── STAGE 3: Document Size Limits ──────────────────────────────
async function stage3() {
  const COL = "qb_sizes";
  const SIZES = [
    { label: "1KB", bytes: 1_024 },
    { label: "10KB", bytes: 10_240 },
    { label: "100KB", bytes: 102_400 },
    { label: "1MB (Firebase limit)", bytes: 1_048_576 },
    { label: "5MB", bytes: 5_242_880 },
    { label: "16MB (MongoDB limit)", bytes: 16_777_216 },
    { label: "50MB", bytes: 52_428_800 },
  ];

  console.log(
    `\n${"#".repeat(94)}\n  STAGE 3 — Document Size Limits (1KB → 50MB)\n${"#".repeat(94)}`
  );

  const groups = new Map<string, LatencySample[]>();

  for (const size of SIZES) {
    const doc = sizedDoc(size.bytes);
    const actualSize = JSON.stringify(doc).length;
    process.stdout.write(`\n  ${size.label} (${fmtBytes(actualSize)})...`);

    // Write
    const writeStart = performance.now();
    let writeOk = false;
    let docId = "";
    try {
      const res = await fetch(`${API}/collections/${COL}`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(doc),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const writeMs = performance.now() - writeStart;
      if (res.ok) {
        const body = await res.json();
        docId = body.id;
        writeOk = true;
        const wName = `write:${size.label}`;
        if (!groups.has(wName)) groups.set(wName, []);
        groups.get(wName)!.push({ op: wName, ms: writeMs, status: res.status, ok: true, bytes: actualSize });
        process.stdout.write(` write=${fmtMs(writeMs)}`);
      } else {
        const text = await res.text();
        const wName = `write:${size.label}`;
        if (!groups.has(wName)) groups.set(wName, []);
        groups.get(wName)!.push({ op: wName, ms: writeMs, status: res.status, ok: false });
        console.log(` WRITE FAILED (${res.status}: ${text.slice(0, 100)})`);
        continue;
      }
    } catch (err) {
      const writeMs = performance.now() - writeStart;
      const wName = `write:${size.label}`;
      if (!groups.has(wName)) groups.set(wName, []);
      groups.get(wName)!.push({ op: wName, ms: writeMs, status: 0, ok: false });
      console.log(` WRITE FAILED (${err})`);
      continue;
    }

    // Read
    if (writeOk && docId) {
      const { sample: readSample } = await timedFetch(
        `read:${size.label}`,
        `${API}/collections/${COL}/${docId}`,
        { headers: HEADERS }
      );
      if (!groups.has(readSample.op)) groups.set(readSample.op, []);
      groups.get(readSample.op)!.push(readSample);
      process.stdout.write(` read=${fmtMs(readSample.ms)}`);

      // Query (find it among other docs)
      const { sample: querySample } = await timedFetch(
        `query:${size.label}`,
        `${API}/collections/${COL}${qs({ where: [["marker", "==", "size-test"]], limit: 10 })}`,
        { headers: HEADERS }
      );
      if (!groups.has(querySample.op)) groups.set(querySample.op, []);
      groups.get(querySample.op)!.push(querySample);
      process.stdout.write(` query=${fmtMs(querySample.ms)}`);
    }
  }

  console.log();
  printQueryTable("STAGE 3 — Document Size Limits", groups);

  const metrics = await captureMetrics();
  console.log(`  Resources: ${metrics.containerStats}`);
  console.log(`  DB size: ${metrics.dbSize}  |  PG connections: ${metrics.pgConns}`);

  return groups;
}

// ── STAGE 4: SDK Performance ───────────────────────────────────
async function stage4() {
  const COL = "qb_light"; // Reuse stage 1 data
  const ITERATIONS = 50;

  console.log(
    `\n${"#".repeat(94)}\n  STAGE 4 — SDK vs Raw Fetch (using Stage 1 data)\n${"#".repeat(94)}`
  );

  const ez = new EzBase({ url: BASE, adminKey: ADMIN_KEY });
  const col = ez.collection(COL);

  // Define matched query pairs: SDK call + equivalent raw fetch
  const queryPairs: {
    name: string;
    sdk: () => Promise<unknown>;
    raw: () => Promise<{ sample: LatencySample; body: any; rawBytes: number }>;
  }[] = [
    {
      name: "eq:status",
      sdk: () => col.where("status", "==", "active").limit(100).get(),
      raw: () => timedFetch("raw", `${API}/collections/${COL}${qs({ where: [["status", "==", "active"]], limit: 100 })}`, { headers: HEADERS }),
    },
    {
      name: "range:score",
      sdk: () => col.where("score", ">", 75).limit(100).get(),
      raw: () => timedFetch("raw", `${API}/collections/${COL}${qs({ where: [["score", ">", 75]], limit: 100 })}`, { headers: HEADERS }),
    },
    {
      name: "compound",
      sdk: () => col.where("status", "==", "active").where("score", ">", 50).limit(100).get(),
      raw: () => timedFetch("raw", `${API}/collections/${COL}${qs({ where: [["status", "==", "active"], ["score", ">", 50]], limit: 100 })}`, { headers: HEADERS }),
    },
    {
      name: "sort:score",
      sdk: () => col.orderBy("score", "desc").limit(100).get(),
      raw: () => timedFetch("raw", `${API}/collections/${COL}${qs({ orderBy: "score", order: "desc", limit: 100 })}`, { headers: HEADERS }),
    },
    {
      name: "sort:created",
      sdk: () => col.orderBy("created", "desc").limit(100).get(),
      raw: () => timedFetch("raw", `${API}/collections/${COL}${qs({ orderBy: "created", order: "desc", limit: 100 })}`, { headers: HEADERS }),
    },
    {
      name: "get-all",
      sdk: () => col.limit(500).get(),
      raw: () => timedFetch("raw", `${API}/collections/${COL}${qs({ limit: 500 })}`, { headers: HEADERS }),
    },
  ];

  const sdkGroups = new Map<string, LatencySample[]>();
  const rawGroups = new Map<string, LatencySample[]>();

  console.log(`\n  Running ${queryPairs.length} query types x ${ITERATIONS} iterations each...`);

  for (const pair of queryPairs) {
    const sdkSamples: LatencySample[] = [];
    const rawSamples: LatencySample[] = [];

    // Warm up (1 each)
    try { await pair.sdk(); } catch {}
    try { await pair.raw(); } catch {}

    for (let i = 0; i < ITERATIONS; i++) {
      // SDK
      const t0 = performance.now();
      try {
        await pair.sdk();
        sdkSamples.push({ op: `sdk:${pair.name}`, ms: performance.now() - t0, status: 200, ok: true });
      } catch {
        sdkSamples.push({ op: `sdk:${pair.name}`, ms: performance.now() - t0, status: 0, ok: false });
      }

      // Raw fetch
      const { sample } = await pair.raw();
      rawSamples.push({ ...sample, op: `raw:${pair.name}` });
    }

    sdkGroups.set(`sdk:${pair.name}`, sdkSamples);
    rawGroups.set(`raw:${pair.name}`, rawSamples);
  }

  // SSE: time to first snapshot
  console.log(`  Testing SDK onSnapshot latency...`);
  const sseSamples: LatencySample[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const unsub = col.where("status", "==", "active").limit(10).onSnapshot(
        () => {
          const ms = performance.now() - t0;
          sseSamples.push({ op: "sdk:onSnapshot", ms, status: 200, ok: true });
          unsub();
          resolve();
        },
        () => {
          const ms = performance.now() - t0;
          sseSamples.push({ op: "sdk:onSnapshot", ms, status: 0, ok: false });
          resolve();
        }
      );
      // Safety timeout
      setTimeout(() => {
        unsub();
        resolve();
      }, 10_000);
    });
  }

  // Merge and display
  const allGroups = new Map<string, LatencySample[]>();
  for (const [name, samples] of rawGroups) allGroups.set(name, samples);
  for (const [name, samples] of sdkGroups) allGroups.set(name, samples);
  if (sseSamples.length > 0) allGroups.set("sdk:onSnapshot", sseSamples);

  printQueryTable("STAGE 4 — SDK vs Raw Fetch", allGroups);

  // Print overhead summary
  console.log("  SDK Overhead Summary:");
  console.log("  " + "Query".padEnd(20) + "Raw p50".padStart(10) + "SDK p50".padStart(10) + "Overhead".padStart(10));
  console.log("  " + "\u2500".repeat(48));
  for (const pair of queryPairs) {
    const rawP = percentiles(rawGroups.get(`raw:${pair.name}`) || []);
    const sdkP = percentiles(sdkGroups.get(`sdk:${pair.name}`) || []);
    const overhead = rawP.p50 > 0 ? ((sdkP.p50 - rawP.p50) / rawP.p50 * 100).toFixed(1) : "-";
    console.log(
      "  " +
        pair.name.padEnd(20) +
        fmtMs(rawP.p50).padStart(10) +
        fmtMs(sdkP.p50).padStart(10) +
        `${overhead}%`.padStart(10)
    );
  }
  console.log();

  return { sdkGroups, rawGroups };
}

// ── STAGE 5: Scaling Comparison ────────────────────────────────
async function stage5() {
  const SCALES = [1_000, 10_000, 50_000, 100_000];
  const CONCURRENCY = 50;
  const ITERATIONS = 30;

  console.log(
    `\n${"#".repeat(94)}\n  STAGE 5 — Scaling Comparison (query latency vs collection size)\n${"#".repeat(94)}`
  );

  // We'll use the same query subset for comparison
  const scaleQueries: QueryDef[] = [
    { name: "eq:status", q: qs({ where: [["status", "==", "active"]] }) },
    { name: "range:score", q: qs({ where: [["score", ">", 75]] }) },
    { name: "compound", q: qs({ where: [["status", "==", "active"], ["score", ">", 50]] }) },
    { name: "sort:score+limit", q: qs({ orderBy: "score", order: "desc", limit: 100 }) },
    { name: "sort:created+limit", q: qs({ orderBy: "created", order: "desc", limit: 100 }) },
    { name: "full-scan", q: "" },
  ];

  // Accumulate results per scale
  const scaleResults: Map<number, Map<string, LatencySample[]>> = new Map();

  for (const scale of SCALES) {
    const col = `qb_scale_${scale}`;
    console.log(`\n  --- ${scale.toLocaleString()} docs ---`);

    // Seed
    console.log(`  Seeding...`);
    await seedCollection(col, scale, lightDoc, CONCURRENCY);

    // Run queries
    console.log(`  Running queries (${ITERATIONS} iterations)...`);
    const pool = new Pool(CONCURRENCY);
    const groups = new Map<string, LatencySample[]>();
    for (const qd of scaleQueries) groups.set(qd.name, []);

    const promises: Promise<void>[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      for (const qd of scaleQueries) {
        promises.push(
          pool.run(async () => {
            const { sample } = await timedFetch(qd.name, `${API}/collections/${col}${qd.q}`, {
              headers: HEADERS,
            });
            groups.get(qd.name)!.push(sample);
          })
        );
      }
    }
    await Promise.all(promises);

    scaleResults.set(scale, groups);

    // Quick summary
    for (const [name, samples] of groups) {
      const p = percentiles(samples);
      process.stdout.write(`    ${name}: p50=${fmtMs(p.p50)} p95=${fmtMs(p.p95)}  `);
    }
    console.log();
  }

  // Print scaling comparison table
  console.log();
  console.log("=".repeat(94));
  console.log("  STAGE 5 — Scaling Comparison (p50 latency by collection size)");
  console.log("=".repeat(94));
  console.log();

  // Header
  const header =
    "  " +
    "Query".padEnd(22) +
    SCALES.map((s) => `${(s / 1000).toFixed(0)}K`.padStart(10)).join("");
  console.log(header);
  console.log("  " + "\u2500".repeat(22 + SCALES.length * 10));

  for (const qd of scaleQueries) {
    let row = "  " + qd.name.padEnd(22);
    for (const scale of SCALES) {
      const samples = scaleResults.get(scale)?.get(qd.name) || [];
      const p = percentiles(samples);
      row += fmtMs(p.p50).padStart(10);
    }
    console.log(row);
  }

  // P95 table
  console.log();
  console.log("  p95 latency:");
  console.log("  " + "Query".padEnd(22) + SCALES.map((s) => `${(s / 1000).toFixed(0)}K`.padStart(10)).join(""));
  console.log("  " + "\u2500".repeat(22 + SCALES.length * 10));

  for (const qd of scaleQueries) {
    let row = "  " + qd.name.padEnd(22);
    for (const scale of SCALES) {
      const samples = scaleResults.get(scale)?.get(qd.name) || [];
      const p = percentiles(samples);
      row += fmtMs(p.p95).padStart(10);
    }
    console.log(row);
  }

  console.log();
  const metrics = await captureMetrics();
  console.log(`  Resources: ${metrics.containerStats}`);
  console.log(`  DB size: ${metrics.dbSize}  |  PG connections: ${metrics.pgConns}`);

  return scaleResults;
}

// ── Final Synopsis ─────────────────────────────────────────────
function printSynopsis(
  lightGroups: Map<string, LatencySample[]> | null,
  heavyGroups: Map<string, LatencySample[]> | null
) {
  if (!lightGroups || !heavyGroups) return;

  console.log();
  console.log("=".repeat(94));
  console.log("  SYNOPSIS — Lightweight vs Heavyweight Query Latency (p50)");
  console.log("=".repeat(94));
  console.log();

  const compareQueries = ["eq:status", "range:score", "compound", "sort:score", "full-scan"];
  console.log(
    "  " +
      "Query".padEnd(22) +
      "Light p50".padStart(12) +
      "Heavy p50".padStart(12) +
      "Ratio".padStart(8)
  );
  console.log("  " + "\u2500".repeat(52));

  for (const name of compareQueries) {
    const lp = percentiles(lightGroups.get(name) || []);
    const hp = percentiles(heavyGroups.get(name) || []);
    const ratio = lp.p50 > 0 ? (hp.p50 / lp.p50).toFixed(1) + "x" : "-";
    console.log(
      "  " +
        name.padEnd(22) +
        fmtMs(lp.p50).padStart(12) +
        fmtMs(hp.p50).padStart(12) +
        ratio.padStart(8)
    );
  }
  console.log();
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log("\n  ezbase Query Performance Deep-Dive");
  console.log(`  target: ${BASE}`);
  if (STAGE_FILTER) console.log(`  stage:  ${STAGE_FILTER} only`);
  console.log();

  await waitForHealthy();

  let lightGroups: Map<string, LatencySample[]> | null = null;
  let heavyGroups: Map<string, LatencySample[]> | null = null;

  if (!STAGE_FILTER || STAGE_FILTER === 1) {
    lightGroups = await stage1();
  }

  if (!STAGE_FILTER || STAGE_FILTER === 2) {
    heavyGroups = await stage2();
  }

  if (!STAGE_FILTER || STAGE_FILTER === 3) {
    await stage3();
  }

  if (!STAGE_FILTER || STAGE_FILTER === 4) {
    if (!lightGroups) {
      // Stage 4 needs stage 1 data — seed if skipped
      console.log("\n  Stage 4 requires Stage 1 data, seeding qb_light...");
      await seedCollection("qb_light", 100_000, lightDoc, 100);
    }
    await stage4();
  }

  if (!STAGE_FILTER || STAGE_FILTER === 5) {
    await stage5();
  }

  printSynopsis(lightGroups, heavyGroups);

  console.log("  done.\n");
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

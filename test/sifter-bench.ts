#!/usr/bin/env bun
// ── Sifter-Realistic SaaS Benchmark ──────────────────────────
// Simulates real usage patterns for a form submission SaaS:
//   - Organizations with members
//   - Contact forms per org (5-10 each)
//   - Form submissions (hundreds per form)
//   - User logs in → loads their forms → views submissions → real-time listener
// Run: cd test && docker compose up -d && bun run sifter-bench.ts

import EzBase from "../sdk/src/index";

const BASE = process.env.URL || "http://localhost:7003";
const API = `${BASE}/api`;
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
const HEADERS = {
  Authorization: `Bearer ${ADMIN_KEY}`,
  "Content-Type": "application/json",
};
const TIMEOUT_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────────
interface Sample { op: string; ms: number; ok: boolean; docs?: number; bytes?: number }

class Pool {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(public max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try { return await fn(); }
    finally { this.active--; if (this.queue.length > 0) this.queue.shift()!(); }
  }
}

function fmtMs(ms: number): string {
  if (ms === 0) return "-";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtBytes(b: number): string {
  if (!b) return "-";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function stats(samples: Sample[]) {
  const ok = samples.filter(s => s.ok);
  const times = ok.map(s => s.ms).sort((a, b) => a - b);
  if (!times.length) return { count: 0, errors: samples.length, p50: 0, p95: 0, p99: 0, max: 0 };
  const p = (pct: number) => times[Math.min(Math.floor(times.length * pct / 100), times.length - 1)];
  return { count: times.length, errors: samples.filter(s => !s.ok).length, p50: p(50), p95: p(95), p99: p(99), max: times[times.length - 1] };
}

function printResults(label: string, groups: [string, Sample[]][]) {
  console.log();
  console.log("=".repeat(96));
  console.log(`  ${label}`);
  console.log("=".repeat(96));
  console.log();
  console.log(
    "  " + "Scenario".padEnd(36) +
    "Runs".padStart(6) + "Err".padStart(5) +
    "p50".padStart(9) + "p95".padStart(9) + "p99".padStart(9) + "max".padStart(9) +
    "docs".padStart(7) + "size".padStart(8)
  );
  console.log("  " + "\u2500".repeat(92));

  for (const [name, samples] of groups) {
    const s = stats(samples);
    const avgDocs = Math.round(samples.filter(s => s.ok && s.docs).reduce((a, s) => a + (s.docs || 0), 0) / Math.max(1, s.count));
    const avgBytes = Math.round(samples.filter(s => s.ok && s.bytes).reduce((a, s) => a + (s.bytes || 0), 0) / Math.max(1, s.count));
    console.log(
      "  " + name.padEnd(36) +
      String(s.count).padStart(6) + String(s.errors).padStart(5) +
      fmtMs(s.p50).padStart(9) + fmtMs(s.p95).padStart(9) + fmtMs(s.p99).padStart(9) + fmtMs(s.max).padStart(9) +
      (avgDocs ? String(avgDocs) : "-").padStart(7) +
      (avgBytes ? fmtBytes(avgBytes) : "-").padStart(8)
    );
  }
  console.log();
}

async function timedFetch(op: string, url: string, init?: RequestInit): Promise<{ sample: Sample; body: any }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = performance.now() - t0;
    const text = res.ok ? await res.text() : "";
    const body = text ? JSON.parse(text) : null;
    const docs = Array.isArray(body) ? body.length : undefined;
    return { sample: { op, ms, ok: res.ok, docs, bytes: text.length }, body };
  } catch {
    return { sample: { op, ms: performance.now() - t0, ok: false }, body: null };
  }
}

function qs(opts: { where?: [string, string, unknown][]; orderBy?: string; order?: "asc" | "desc"; limit?: number }): string {
  const p = new URLSearchParams();
  if (opts.where) p.set("where", JSON.stringify(opts.where));
  if (opts.orderBy) p.set("orderBy", opts.orderBy);
  if (opts.order) p.set("order", opts.order);
  if (opts.limit) p.set("limit", String(opts.limit));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Data Generators ────────────────────────────────────────────
const FIELD_TYPES = ["text", "email", "textarea", "select", "checkbox", "phone", "date", "number"];

function generateForm(orgId: string, formIndex: number) {
  const fields = Array.from({ length: 3 + (formIndex % 5) }, (_, j) => ({
    name: `field_${j}`,
    type: FIELD_TYPES[j % FIELD_TYPES.length],
    label: `Field ${j}`,
    required: j < 2,
  }));
  return {
    orgId,
    name: `Contact Form ${formIndex + 1}`,
    slug: `form-${formIndex + 1}`,
    fields,
    active: formIndex % 7 !== 0,
    createdBy: `user_${orgId}_0`,
  };
}

function generateSubmission(formId: string, orgId: string, submissionIndex: number) {
  return {
    formId,
    orgId,
    field_0: `John Doe ${submissionIndex}`,
    field_1: `user${submissionIndex}@example.com`,
    field_2: `Message from submission ${submissionIndex}. This is a typical contact form message with some details about the inquiry.`,
    field_3: submissionIndex % 3 === 0 ? "sales" : submissionIndex % 3 === 1 ? "support" : "general",
    field_4: submissionIndex % 2 === 0,
    status: submissionIndex % 10 === 0 ? "archived" : submissionIndex % 4 === 0 ? "read" : "unread",
    ip: `192.168.${submissionIndex % 256}.${(submissionIndex * 7) % 256}`,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
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
  throw new Error("Not healthy after 120s");
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log("\n  Sifter-Realistic SaaS Benchmark");
  console.log(`  target: ${BASE}`);
  console.log();

  await waitForHealthy();

  const pool = new Pool(50);

  // ────────────────────────────────────────────────────────────
  // SEED: Organizations, Forms, Submissions
  // ────────────────────────────────────────────────────────────
  const NUM_ORGS = 100;
  const FORMS_PER_ORG = 7; // average, varies 5-10
  const SUBMISSIONS_PER_FORM = 200;

  const orgIds: string[] = [];
  const formsByOrg: Map<string, string[]> = new Map(); // orgId -> formDocIds
  const submissionsByForm: Map<string, string[]> = new Map(); // formDocId -> submissionDocIds
  const formOrgMap: Map<string, string> = new Map(); // formDocId -> orgId

  // Generate org IDs
  for (let i = 0; i < NUM_ORGS; i++) {
    orgIds.push(`org_${String(i).padStart(4, "0")}`);
  }

  const totalForms = NUM_ORGS * FORMS_PER_ORG;
  const totalSubmissions = totalForms * SUBMISSIONS_PER_FORM;

  console.log(`  Seeding: ${NUM_ORGS} orgs, ${totalForms} forms, ${totalSubmissions.toLocaleString()} submissions`);
  console.log();

  // Seed forms
  console.log(`  [seed] Creating ${totalForms} forms...`);
  const formStart = performance.now();
  let formCount = 0;
  const formPromises: Promise<void>[] = [];

  for (const orgId of orgIds) {
    formsByOrg.set(orgId, []);
    const numForms = 5 + (parseInt(orgId.split("_")[1]) % 6); // 5-10 forms
    for (let f = 0; f < numForms; f++) {
      formPromises.push(
        pool.run(async () => {
          const res = await fetch(`${API}/collections/forms`, {
            method: "POST", headers: HEADERS,
            body: JSON.stringify(generateForm(orgId, f)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok) {
            const body = await res.json();
            if (body?.id) {
              formsByOrg.get(orgId)!.push(body.id);
              formOrgMap.set(body.id, orgId);
              submissionsByForm.set(body.id, []);
            }
          } else { try { await res.text(); } catch {} }
          formCount++;
          if (formCount % 100 === 0) {
            process.stdout.write(`\r    ${formCount}/${totalForms}`);
          }
        })
      );
    }
  }
  await Promise.all(formPromises);
  const actualForms = [...formsByOrg.values()].reduce((a, b) => a + b.length, 0);
  console.log(`\r    done: ${actualForms} forms in ${((performance.now() - formStart) / 1000).toFixed(1)}s`);

  // Seed submissions
  console.log(`  [seed] Creating ${totalSubmissions.toLocaleString()} submissions...`);
  const subStart = performance.now();
  let subCount = 0;
  const subPromises: Promise<void>[] = [];
  const allFormIds = [...formOrgMap.keys()];

  for (const formId of allFormIds) {
    const orgId = formOrgMap.get(formId)!;
    for (let s = 0; s < SUBMISSIONS_PER_FORM; s++) {
      subPromises.push(
        pool.run(async () => {
          const res = await fetch(`${API}/collections/submissions`, {
            method: "POST", headers: HEADERS,
            body: JSON.stringify(generateSubmission(formId, orgId, s)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok) {
            const body = await res.json();
            if (body?.id) submissionsByForm.get(formId)!.push(body.id);
          } else { try { await res.text(); } catch {} }
          subCount++;
          if (subCount % 5000 === 0) {
            const elapsed = (performance.now() - subStart) / 1000;
            process.stdout.write(`\r    ${subCount.toLocaleString()}/${totalSubmissions.toLocaleString()} (${Math.round(subCount / elapsed)}/s)`);
          }
        })
      );
    }
  }
  await Promise.all(subPromises);
  const actualSubs = [...submissionsByForm.values()].reduce((a, b) => a + b.length, 0);
  console.log(`\r    done: ${actualSubs.toLocaleString()} submissions in ${((performance.now() - subStart) / 1000).toFixed(1)}s    `);

  console.log();

  // ────────────────────────────────────────────────────────────
  // SCENARIO 1: User Login → Load My Forms
  // "I just logged in, show me my org's forms"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 1 — User logs in, loads their org's forms`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Query: where('orgId', '==', myOrgId) on forms collection`);
  console.log(`  Expected: 5-10 forms per org\n`);

  const sc1Samples: Sample[] = [];
  for (let i = 0; i < 200; i++) {
    const orgId = pick(orgIds);
    const { sample } = await timedFetch(
      "load-my-forms",
      `${API}/collections/forms${qs({ where: [["orgId", "==", orgId]] })}`,
      { headers: HEADERS }
    );
    sc1Samples.push(sample);
  }
  printResults("Scenario 1 — Load My Forms (sequential, 200 iterations)", [["load-my-forms", sc1Samples]]);

  // ────────────────────────────────────────────────────────────
  // SCENARIO 2: View Form Submissions
  // "I clicked a form, show me its submissions"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 2 — Click a form, load its submissions`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Query: where('formId', '==', myFormId).orderBy('created', 'desc')`);
  console.log(`  Expected: ~200 submissions per form\n`);

  const sc2Samples: Sample[] = [];
  const sc2LimitedSamples: Sample[] = [];
  const sc2RecentSamples: Sample[] = [];

  for (let i = 0; i < 200; i++) {
    const formId = pick(allFormIds);

    // All submissions for this form (no limit)
    const { sample: s1 } = await timedFetch(
      "all-submissions",
      `${API}/collections/submissions${qs({ where: [["formId", "==", formId]], orderBy: "created", order: "desc" })}`,
      { headers: HEADERS }
    );
    sc2Samples.push(s1);

    // First page (limit 50)
    const { sample: s2 } = await timedFetch(
      "first-page-50",
      `${API}/collections/submissions${qs({ where: [["formId", "==", formId]], orderBy: "created", order: "desc", limit: 50 })}`,
      { headers: HEADERS }
    );
    sc2LimitedSamples.push(s2);

    // Recent only (limit 10)
    const { sample: s3 } = await timedFetch(
      "recent-10",
      `${API}/collections/submissions${qs({ where: [["formId", "==", formId]], orderBy: "created", order: "desc", limit: 10 })}`,
      { headers: HEADERS }
    );
    sc2RecentSamples.push(s3);
  }
  printResults("Scenario 2 — Form Submissions (sequential, 200 iterations)", [
    ["all-submissions (no limit)", sc2Samples],
    ["first-page (limit 50)", sc2LimitedSamples],
    ["recent-only (limit 10)", sc2RecentSamples],
  ]);

  // ────────────────────────────────────────────────────────────
  // SCENARIO 3: Org-wide Submission Feed
  // "Show me all submissions across all my org's forms"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 3 — Org-wide submission feed`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Query: where('orgId', '==', myOrgId).orderBy('created', 'desc')`);
  console.log(`  Expected: 1000-2000 submissions per org\n`);

  const sc3AllSamples: Sample[] = [];
  const sc3PageSamples: Sample[] = [];
  const sc3RecentSamples: Sample[] = [];

  for (let i = 0; i < 100; i++) {
    const orgId = pick(orgIds);

    // All org submissions
    const { sample: s1 } = await timedFetch(
      "org-all",
      `${API}/collections/submissions${qs({ where: [["orgId", "==", orgId]], orderBy: "created", order: "desc" })}`,
      { headers: HEADERS }
    );
    sc3AllSamples.push(s1);

    // First page
    const { sample: s2 } = await timedFetch(
      "org-page-50",
      `${API}/collections/submissions${qs({ where: [["orgId", "==", orgId]], orderBy: "created", order: "desc", limit: 50 })}`,
      { headers: HEADERS }
    );
    sc3PageSamples.push(s2);

    // Recent 10
    const { sample: s3 } = await timedFetch(
      "org-recent-10",
      `${API}/collections/submissions${qs({ where: [["orgId", "==", orgId]], orderBy: "created", order: "desc", limit: 10 })}`,
      { headers: HEADERS }
    );
    sc3RecentSamples.push(s3);
  }
  printResults("Scenario 3 — Org-Wide Feed (sequential, 100 iterations)", [
    ["org-all (no limit)", sc3AllSamples],
    ["org-page (limit 50)", sc3PageSamples],
    ["org-recent (limit 10)", sc3RecentSamples],
  ]);

  // ────────────────────────────────────────────────────────────
  // SCENARIO 4: Filter Submissions
  // "Show me unread submissions" / "Show me sales inquiries"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 4 — Filtered queries (compound)`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Compound: org + status, org + category, form + status\n`);

  const sc4Groups: [string, Sample[]][] = [];

  // Unread submissions for my org
  const sc4a: Sample[] = [];
  for (let i = 0; i < 100; i++) {
    const orgId = pick(orgIds);
    const { sample } = await timedFetch("org+unread",
      `${API}/collections/submissions${qs({ where: [["orgId", "==", orgId], ["status", "==", "unread"]], orderBy: "created", order: "desc" })}`,
      { headers: HEADERS });
    sc4a.push(sample);
  }
  sc4Groups.push(["org + status=unread", sc4a]);

  // Sales inquiries for my org
  const sc4b: Sample[] = [];
  for (let i = 0; i < 100; i++) {
    const orgId = pick(orgIds);
    const { sample } = await timedFetch("org+sales",
      `${API}/collections/submissions${qs({ where: [["orgId", "==", orgId], ["field_3", "==", "sales"]], orderBy: "created", order: "desc" })}`,
      { headers: HEADERS });
    sc4b.push(sample);
  }
  sc4Groups.push(["org + category=sales", sc4b]);

  // Unread for a specific form
  const sc4c: Sample[] = [];
  for (let i = 0; i < 100; i++) {
    const formId = pick(allFormIds);
    const { sample } = await timedFetch("form+unread",
      `${API}/collections/submissions${qs({ where: [["formId", "==", formId], ["status", "==", "unread"]], orderBy: "created", order: "desc" })}`,
      { headers: HEADERS });
    sc4c.push(sample);
  }
  sc4Groups.push(["form + status=unread", sc4c]);

  printResults("Scenario 4 — Filtered Queries (sequential, 100 each)", sc4Groups);

  // ────────────────────────────────────────────────────────────
  // SCENARIO 5: Real-Time Listeners (SDK)
  // "I have the submissions page open, new one comes in"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 5 — Real-time listeners (SDK onSnapshot)`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Subscribe → receive initial snapshot → write new doc → receive update\n`);

  const ez = new EzBase({ url: BASE, adminKey: ADMIN_KEY });

  // 5a. Time to first snapshot
  const snapshotSamples: Sample[] = [];
  for (let i = 0; i < 20; i++) {
    const formId = pick(allFormIds);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const unsub = ez.collection("submissions")
        .where("formId", "==", formId)
        .orderBy("created", "desc")
        .limit(50)
        .onSnapshot(
          (docs) => {
            const ms = performance.now() - t0;
            snapshotSamples.push({ op: "first-snapshot", ms, ok: true, docs: docs.length });
            unsub();
            resolve();
          },
          () => { unsub(); resolve(); }
        );
      setTimeout(() => { unsub(); resolve(); }, 10_000);
    });
  }

  // 5b. Write → receive update latency
  const updateSamples: Sample[] = [];
  for (let i = 0; i < 10; i++) {
    const formId = pick(allFormIds);
    const orgId = formOrgMap.get(formId)!;

    await new Promise<void>((resolve) => {
      let gotInitial = false;
      let writeTime = 0;

      const unsub = ez.collection("submissions")
        .where("formId", "==", formId)
        .orderBy("created", "desc")
        .limit(50)
        .onSnapshot(
          (docs) => {
            if (!gotInitial) {
              gotInitial = true;
              // Now write a new submission
              writeTime = performance.now();
              fetch(`${API}/collections/submissions`, {
                method: "POST", headers: HEADERS,
                body: JSON.stringify(generateSubmission(formId, orgId, 9999 + i)),
              }).catch(() => {});
            } else {
              // This is the update triggered by our write
              const ms = performance.now() - writeTime;
              updateSamples.push({ op: "write-to-update", ms, ok: true, docs: docs.length });
              unsub();
              resolve();
            }
          },
          () => { unsub(); resolve(); }
        );
      setTimeout(() => { unsub(); resolve(); }, 15_000);
    });
  }

  printResults("Scenario 5 — Real-Time (SDK onSnapshot)", [
    ["time-to-first-snapshot", snapshotSamples],
    ["write-to-update-received", updateSamples],
  ]);

  // ────────────────────────────────────────────────────────────
  // SCENARIO 6: Concurrent Users
  // "20 users all loading their dashboards at once"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 6 — Concurrent users (20 users loading dashboards)`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Each user: load forms + load recent submissions for each form\n`);

  const concPool = new Pool(20);
  const sc6FormSamples: Sample[] = [];
  const sc6SubSamples: Sample[] = [];

  // Simulate 50 users, 20 concurrent
  const userPromises = Array.from({ length: 50 }, () =>
    concPool.run(async () => {
      const orgId = pick(orgIds);
      const forms = formsByOrg.get(orgId)!;

      // Load my forms
      const { sample: formSample } = await timedFetch(
        "concurrent:load-forms",
        `${API}/collections/forms${qs({ where: [["orgId", "==", orgId]] })}`,
        { headers: HEADERS }
      );
      sc6FormSamples.push(formSample);

      // Load recent submissions for each form
      for (const formId of forms) {
        const { sample: subSample } = await timedFetch(
          "concurrent:form-subs",
          `${API}/collections/submissions${qs({ where: [["formId", "==", formId]], orderBy: "created", order: "desc", limit: 20 })}`,
          { headers: HEADERS }
        );
        sc6SubSamples.push(subSample);
      }
    })
  );
  await Promise.all(userPromises);

  printResults("Scenario 6 — Concurrent Users (50 users, 20 concurrent)", [
    ["load-forms", sc6FormSamples],
    ["form-submissions (limit 20)", sc6SubSamples],
  ]);

  // ────────────────────────────────────────────────────────────
  // SCENARIO 7: Point Operations
  // "View single submission detail" / "Mark as read" / "Delete"
  // ────────────────────────────────────────────────────────────
  console.log(`${"#".repeat(96)}`);
  console.log(`  SCENARIO 7 — Point operations (read, update, delete)`);
  console.log(`${"#".repeat(96)}`);
  console.log(`  Single doc read, PATCH status, DELETE\n`);

  const allSubIds = [...submissionsByForm.values()].flat();
  const sc7Read: Sample[] = [];
  const sc7Update: Sample[] = [];

  for (let i = 0; i < 200; i++) {
    const id = pick(allSubIds);
    const { sample: readS } = await timedFetch("read-submission", `${API}/collections/submissions/${id}`, { headers: HEADERS });
    sc7Read.push(readS);

    const { sample: updateS } = await timedFetch("mark-as-read",
      `${API}/collections/submissions/${id}`,
      { method: "PATCH", headers: HEADERS, body: JSON.stringify({ status: "read" }) });
    sc7Update.push(updateS);
  }

  printResults("Scenario 7 — Point Operations (sequential, 200 each)", [
    ["read single submission", sc7Read],
    ["mark-as-read (PATCH)", sc7Update],
  ]);

  // ────────────────────────────────────────────────────────────
  // FINAL SYNOPSIS
  // ────────────────────────────────────────────────────────────
  console.log("=".repeat(96));
  console.log("  FINAL SYNOPSIS — Sifter SaaS Benchmark");
  console.log("=".repeat(96));
  console.log();
  console.log(`  Scale: ${NUM_ORGS} orgs, ${actualForms} forms, ${actualSubs.toLocaleString()} submissions`);
  console.log();

  const synopsis: [string, Sample[]][] = [
    ["Load my forms (5-10 docs)", sc1Samples],
    ["Form submissions, no limit (~200)", sc2Samples],
    ["Form submissions, limit 50", sc2LimitedSamples],
    ["Form submissions, limit 10", sc2RecentSamples],
    ["Org feed, no limit (~1400)", sc3AllSamples],
    ["Org feed, limit 50", sc3PageSamples],
    ["Org + status filter", sc4a],
    ["Form + status filter", sc4c],
    ["SSE first snapshot", snapshotSamples],
    ["SSE write→update", updateSamples],
    ["Concurrent: load forms (20 users)", sc6FormSamples],
    ["Concurrent: form subs (20 users)", sc6SubSamples],
    ["Point read", sc7Read],
    ["Point update (PATCH)", sc7Update],
  ];

  printResults("Summary", synopsis);

  console.log("  done.\n");
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});

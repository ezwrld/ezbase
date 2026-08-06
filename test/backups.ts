/**
 * ezbase backup/restore test — exercises the full backup lifecycle via the REST API.
 * Run: bun run test/backups.ts  (or node test/backups.ts, after test stack is up)
 *
 * Safe to run against a stack with existing data: document-restore semantics are
 * tested against a backup scoped to a throwaway database; the full backup is only
 * used for manifest checks and selective auth/storage/rules restore.
 */

const URL = process.env.URL || "http://localhost:7003";
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin-key";
const DB = "bkmain";

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

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${URL}/api${path}`, { headers: json, ...init });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { res, body };
}

async function addDoc(col: string, data: unknown) {
  const { body } = await api(`/db/${DB}/collections/${col}`, { method: "POST", body: JSON.stringify(data) });
  return body;
}

async function getDoc(col: string, id: string) {
  const { res, body } = await api(`/db/${DB}/collections/${col}/${id}`);
  return res.ok ? body : null;
}

async function listDocs(col: string) {
  const { body } = await api(`/db/${DB}/collections/${col}`);
  return body as any[];
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

async function main() {
  console.log("Waiting for ezbase to be healthy...");
  await waitForHealthy();
  console.log("ezbase is up!\n");

  const createdBackups: string[] = [];

  // ── Seed data ───────────────────────────────────────────────
  console.log("Seed data");
  const docA = await addDoc("todos", { title: "First", org: "acme" });
  await new Promise((r) => setTimeout(r, 30));
  const docB = await addDoc("todos", { title: "Second", org: "other" });
  const docC = await addDoc("events", { kind: "click", n: 1 });
  assert(!!docA?.id && !!docB?.id && !!docC?.id, "seeded docs in two collections");

  // Storage file
  const form = new FormData();
  form.append("file", new File(["backup me"], "note.txt", { type: "text/plain" }));
  const upload = await fetch(`${URL}/api/storage/bkfiles/note.txt`, { method: "POST", headers: auth, body: form });
  const uploaded = await upload.json();
  assert(upload.status === 201 && uploaded.path === "bkfiles/note.txt", "uploaded storage file");

  // Auth user (unique email so reruns don't collide)
  const email = `backup-test-${Date.now()}@example.com`;
  const signup = await fetch(`${URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: URL },
    body: JSON.stringify({ email, password: "password123", name: "Backup Test" }),
  });
  const signupBody = await signup.json();
  const userId = signupBody?.user?.id;
  if (!userId) console.error("    signup response:", signup.status, JSON.stringify(signupBody));
  assert(!!userId, "created test user");

  // ── Permissions ─────────────────────────────────────────────
  console.log("\nPermissions");
  {
    const res = await fetch(`${URL}/api/backups`);
    assert(res.status === 401, "GET /backups without auth → 401");
  }

  // ── Create full backup ──────────────────────────────────────
  console.log("\nCreate full backup");
  const { res: createRes, body: created } = await api("/backups", { method: "POST", body: "{}" });
  assert(createRes.status === 201, "POST /backups → 201");
  assert(typeof created?.name === "string" && created.name.endsWith(".tar.gz"), "backup has a .tar.gz name");
  createdBackups.push(created.name);
  const m = created.manifest;
  assert(m?.version === 1 && m?.type === "full", "manifest has version + type");
  assert(m?.includes?.documents && m?.includes?.auth && m?.includes?.storage && m?.includes?.rules, "full backup includes everything");
  assert(m?.stats?.databases?.[DB]?.collections?.todos?.docCount === 2, "manifest counts todos docs");
  assert((m?.stats?.auth?.userCount ?? 0) >= 1, "manifest counts users");
  assert((m?.stats?.storage?.fileCount ?? 0) >= 1, "manifest counts storage files");

  // ── List + latest ───────────────────────────────────────────
  console.log("\nList and latest");
  {
    const { body: list } = await api("/backups");
    const entry = list.find((b: any) => b.name === created.name);
    assert(!!entry && entry.size > 0 && !!entry.manifest, "backup appears in list with manifest");
  }
  {
    const res = await fetch(`${URL}/api/backups/latest`, { headers: auth });
    assert(res.ok && res.headers.get("x-backup-name") === created.name, "GET /backups/latest resolves newest");
    await res.body?.cancel();
  }

  // ── Selective restore: auth + storage + rules ───────────────
  console.log("\nSelective restore (auth + storage + rules)");
  await fetch(`${URL}/api/storage/bkfiles/note.txt`, { method: "DELETE", headers: auth });
  if (userId) await fetch(`${URL}/api/auth/users/${userId}`, { method: "DELETE", headers: auth });
  {
    const { res, body } = await api(`/backups/${created.name}/restore`, {
      method: "POST",
      body: JSON.stringify({ auth: true, storage: true, rules: true }),
    });
    assert(res.ok, "selective restore succeeds");
    assert(Object.keys(body?.documents ?? {}).length === 0, "selective restore touches no documents");
    assert(body?.rules === true, "rules restored");
    assert((body?.auth?.user?.restored ?? 0) >= 1, "auth users restored");
    assert(body?.storage?.files >= 1 && body?.storage?.metadata >= 1, "storage restored");
  }
  {
    const res = await fetch(`${URL}/api/storage/bkfiles/note.txt`, { headers: auth });
    const text = res.ok ? await res.text() : "";
    assert(text === "backup me", "storage file restored with content");
  }
  if (userId) {
    const res = await fetch(`${URL}/api/auth/users/${userId}`, { headers: auth });
    assert(res.ok, "deleted user restored");
  }

  // ── Scoped backup for document semantics ────────────────────
  console.log("\nScoped backup (single database)");
  const { res: scopedRes, body: scoped } = await api("/backups", {
    method: "POST",
    body: JSON.stringify({ database: DB }),
  });
  assert(scopedRes.status === 201, "scoped backup created");
  createdBackups.push(scoped.name);
  {
    const dbs = Object.keys(scoped.manifest.stats.databases);
    assert(dbs.length === 1 && dbs[0] === DB, "scoped manifest only covers target db");
    assert(!scoped.manifest.includes.auth && !scoped.manifest.includes.storage, "scoped backup excludes auth/storage");
  }
  {
    const { res } = await api("/backups", { method: "POST", body: JSON.stringify({ type: "auth", collection: "events" }) });
    assert(res.status === 400, "auth backup with collection scope rejected");
  }

  // ── Full restore of scoped archive (replace) ────────────────
  console.log("\nRestore (replace)");
  await api(`/db/${DB}/collections/todos/${docA.id}`, { method: "DELETE" });
  await api(`/db/${DB}/collections/todos/${docB.id}`, { method: "PATCH", body: JSON.stringify({ title: "CORRUPTED" }) });
  {
    const { res, body } = await api(`/backups/${scoped.name}/restore`, { method: "POST", body: "{}" });
    assert(res.ok, "restore succeeds");
    assert(body?.documents?.[`${DB}/todos`]?.restored === 2, "restore summary counts todos");
    const a = await getDoc("todos", docA.id);
    const b = await getDoc("todos", docB.id);
    assert(a !== null, "deleted doc came back");
    assert(b?.data?.title === "Second", "corrupted doc reverted (replace)");
    assert(typeof a?.data === "object" && a?.data?.org === "acme", "restored data is a proper object");
  }

  // ── Conflict: skip ──────────────────────────────────────────
  console.log("\nConflict mode: skip");
  await api(`/db/${DB}/collections/todos/${docB.id}`, { method: "PATCH", body: JSON.stringify({ title: "KEEP ME" }) });
  {
    const { body } = await api(`/backups/${scoped.name}/restore`, {
      method: "POST",
      body: JSON.stringify({ collections: [`${DB}/todos`], conflict: "skip" }),
    });
    assert(body?.documents?.[`${DB}/todos`]?.skipped === 2, "skip mode reports skipped docs");
    assert((await getDoc("todos", docB.id))?.data?.title === "KEEP ME", "existing doc untouched in skip mode");
  }

  // ── Conflict: error ─────────────────────────────────────────
  console.log("\nConflict mode: error");
  {
    const { res } = await api(`/backups/${scoped.name}/restore`, {
      method: "POST",
      body: JSON.stringify({ collections: [`${DB}/todos`], conflict: "error" }),
    });
    assert(res.status === 409, "error mode aborts on conflict with 409");
    assert((await getDoc("todos", docB.id))?.data?.title === "KEEP ME", "aborted restore rolled back (doc unchanged)");
  }

  // ── Filtered restore: where ─────────────────────────────────
  console.log("\nFiltered restore (--where)");
  await api(`/db/${DB}/collections/todos/${docA.id}`, { method: "DELETE" });
  await api(`/db/${DB}/collections/todos/${docB.id}`, { method: "DELETE" });
  {
    const { body } = await api(`/backups/${scoped.name}/restore`, {
      method: "POST",
      body: JSON.stringify({ collections: [`${DB}/todos`], where: [["org", "==", "acme"]] }),
    });
    const counts = body?.documents?.[`${DB}/todos`];
    assert(counts?.restored === 1 && counts?.filtered === 1, "where filter restores 1, filters 1");
    const docs = await listDocs("todos");
    assert(docs.length === 1 && docs[0].data.org === "acme", "only matching doc restored");
  }

  // ── Filtered restore: time bounds ───────────────────────────
  console.log("\nFiltered restore (time bounds)");
  {
    const { body: docs } = await api(`/db/${DB}/collections/todos`);
    for (const d of docs) await api(`/db/${DB}/collections/todos/${d.id}`, { method: "DELETE" });
    const { body } = await api(`/backups/${scoped.name}/restore`, {
      method: "POST",
      body: JSON.stringify({ collections: [`${DB}/todos`], before: docB.created, timeField: "created" }),
    });
    const counts = body?.documents?.[`${DB}/todos`];
    assert(counts?.restored === 1, "time filter restores only the older doc");
    const after = await listDocs("todos");
    assert(after.length === 1 && after[0].id === docA.id, "restored doc is the older one");
  }

  // ── Download + upload round-trip ────────────────────────────
  console.log("\nDownload and restore from uploaded file");
  let archive: ArrayBuffer;
  {
    const res = await fetch(`${URL}/api/backups/${scoped.name}`, { headers: auth });
    archive = await res.arrayBuffer();
    const bytes = new Uint8Array(archive);
    assert(res.ok && bytes[0] === 0x1f && bytes[1] === 0x8b, "download is a gzip archive");
  }
  {
    await api(`/db/${DB}/collections/events/${docC.id}`, { method: "DELETE" });
    const options = encodeURIComponent(JSON.stringify({ collections: [`${DB}/events`] }));
    const res = await fetch(`${URL}/api/restore?options=${options}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/gzip" },
      body: archive,
    });
    const body = await res.json();
    assert(res.ok && body?.documents?.[`${DB}/events`]?.restored === 1, "uploaded archive restores");
    assert((await getDoc("events", docC.id))?.data?.kind === "click", "doc restored from uploaded archive");
  }
  {
    const res = await fetch(`${URL}/api/restore`, {
      method: "POST",
      headers: auth,
      body: new Uint8Array([1, 2, 3, 4]),
    });
    assert(res.status === 409, "garbage upload rejected cleanly");
  }

  // ── Delete backups ──────────────────────────────────────────
  console.log("\nDelete backups");
  for (const name of createdBackups) {
    const { res } = await api(`/backups/${name}`, { method: "DELETE" });
    assert(res.ok, `deleted ${name}`);
  }
  {
    // URL-encoded so the path segment reaches the server un-normalized
    const { res } = await api("/backups/..%2F..%2Fetc%2Fpasswd", { method: "DELETE" });
    assert(res.status >= 400 && res.status < 500, "path traversal rejected");
  }

  // ── Cleanup ─────────────────────────────────────────────────
  console.log("\nCleanup");
  {
    const { res } = await api(`/db/${DB}`, { method: "DELETE" });
    assert(res.ok, "test database deleted");
    await fetch(`${URL}/api/storage/bkfiles/note.txt`, { method: "DELETE", headers: auth });
    if (userId) await fetch(`${URL}/api/auth/users/${userId}`, { method: "DELETE", headers: auth });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

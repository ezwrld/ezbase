/**
 * ezbase smoke test — uses the actual SDK to verify everything works.
 * Run: bun run test/smoke.ts  (from repo root, after test stack is up)
 */

import { EzBase } from '../sdk/src/index.js'

const URL = "http://localhost:7003";
const ADMIN_KEY = "test-admin-key";

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

async function main() {
  console.log("Waiting for ezbase to be healthy...");
  await waitForHealthy();
  console.log("ezbase is up!\n");

  // ── Admin client (bypasses permissions) ─────────────────────
  const admin = new EzBase({ url: URL, adminKey: ADMIN_KEY });

  // ── Health (raw fetch, not in SDK) ──────────────────────────
  console.log("Health check");
  {
    const res = await fetch(`${URL}/api/health`);
    const body = await res.json();
    assert(res.ok && body.status === "ok", "GET /health returns ok");
  }

  // ── CRUD via SDK ────────────────────────────────────────────
  console.log("\nCRUD operations (SDK)");
  let docId: string;
  {
    // add()
    const doc = await admin.collection("todos").add({ title: "Test todo", done: false });
    assert(doc.id && typeof doc.id === "string", "add() returns doc with string id");
    assert(doc.data.title === "Test todo", "add() data matches input");
    assert(typeof doc.created === "number", "add() has created timestamp");
    assert(typeof doc.updated === "number", "add() has updated timestamp");
    docId = doc.id;
  }
  {
    // doc().get()
    const doc = await admin.collection("todos").doc(docId).get();
    assert(doc !== null && doc!.id === docId, "doc().get() returns the created document");
  }
  {
    // doc().update() — PATCH
    const doc = await admin.collection("todos").doc(docId).update({ done: true });
    assert(doc.data.done === true, "update() changes field");
    assert(doc.data.title === "Test todo", "update() preserves existing fields");
  }
  {
    // doc().set() — PUT (replace)
    const doc = await admin.collection("todos").doc(docId).set({ title: "Replaced", priority: 1 } as any);
    assert(doc.data.title === "Replaced", "set() replaces document data");
  }
  {
    // collection().get() — list
    const docs = await admin.collection("todos").get();
    assert(Array.isArray(docs) && docs.length >= 1, "collection().get() lists documents");
  }
  {
    // doc().delete()
    await admin.collection("todos").doc(docId).delete();
    const doc = await admin.collection("todos").doc(docId).get();
    assert(doc === null, "doc().get() returns null after delete");
  }

  // ── Queries via SDK ─────────────────────────────────────────
  console.log("\nQuery filtering (SDK)");
  {
    for (let i = 1; i <= 5; i++) {
      await admin.collection("items").add({ name: `item-${i}`, score: i * 10 });
    }

    // where
    const filtered = await admin.collection("items").where("score", ">", 20).get();
    assert(filtered.length === 3, `where(score > 20) returns 3 docs (got ${filtered.length})`);

    // limit
    const limited = await admin.collection("items").limit(2).get();
    assert(limited.length === 2, "limit(2) returns 2 docs");

    // orderBy
    const ordered = await admin.collection("items").orderBy("score", "asc").limit(1).get();
    assert(ordered[0]?.data?.score === 10, "orderBy(score, asc) returns lowest first");

    // chained
    const chained = await admin.collection("items")
      .where("score", ">=", 20)
      .orderBy("score", "desc")
      .limit(2)
      .get();
    assert(chained.length === 2 && chained[0]?.data?.score === 50, "chained query works");
  }

  // ── Auth via SDK ────────────────────────────────────────────
  console.log("\nAuth (SDK)");
  const userClient = new EzBase({ url: URL });
  {
    // signUp
    const result = await userClient.auth.signUp({
      email: "test@example.com",
      password: "testpass123",
    });
    assert(typeof result.token === "string" && result.token.length > 0, "signUp() returns token");
    assert(result.user.email === "test@example.com", "signUp() returns user email");
    assert(userClient.auth.currentUser?.email === "test@example.com", "currentUser set after signUp");
  }
  {
    // signOut + signIn
    await userClient.auth.signOut();
    assert(userClient.auth.currentUser === null, "currentUser null after signOut");

    const result = await userClient.auth.signIn({
      email: "test@example.com",
      password: "testpass123",
    });
    assert(typeof result.token === "string" && result.token.length > 0, "signIn() returns token");
    assert(userClient.auth.currentUser?.email === "test@example.com", "currentUser set after signIn");
  }
  {
    // onAuthStateChanged
    let stateChangeCalled = false;
    const unsub = userClient.auth.onAuthStateChanged((user) => {
      stateChangeCalled = true;
    });
    await userClient.auth.signOut();
    assert(stateChangeCalled, "onAuthStateChanged fires on signOut");
    unsub();
  }

  // ── Permissions via SDK + raw fetch ─────────────────────────
  console.log("\nPermissions");
  {
    // Set to authenticated via raw API (admin)
    await fetch(`${URL}/api/collections/secret/permissions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ level: "authenticated" }),
    });

    // Anonymous client should fail
    const anonClient = new EzBase({ url: URL });
    try {
      await anonClient.collection("secret").add({ data: "nope" });
      assert(false, "Anonymous access to authenticated collection throws");
    } catch (err: any) {
      assert(err.message.includes("401"), "Anonymous access returns 401 error");
    }

    // Authenticated client should work
    const authClient = new EzBase({ url: URL });
    await authClient.auth.signIn({ email: "test@example.com", password: "testpass123" });
    const doc = await authClient.collection("secret").add({ data: "yes" });
    assert(doc.id && doc.data.data === "yes", "Authenticated user can write to authenticated collection");

    // Admin client always works
    const adminDoc = await admin.collection("secret").add({ data: "admin" });
    assert(adminDoc.id && adminDoc.data.data === "admin", "Admin can write to authenticated collection");
  }

  // ── SSE via SDK ─────────────────────────────────────────────
  console.log("\nSSE real-time (SDK)");
  {
    const result = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSE timeout")), 15000);
      let gotInitial = false;

      const unsub = admin.collection("sse_test").onSnapshot((docs) => {
        if (!gotInitial) {
          gotInitial = true;
          // Initial snapshot (empty) — now create a doc
          admin.collection("sse_test").add({ hello: "realtime" });
        } else if (docs.length > 0 && docs.some(d => d.data.hello === "realtime")) {
          clearTimeout(timeout);
          unsub();
          resolve(true);
        }
      }, (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    assert(result === true, "onSnapshot delivers doc after creation");
  }
  {
    // Doc-level SSE
    const seedDoc = await admin.collection("sse_doc").add({ val: 1 });
    const result = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Doc SSE timeout")), 15000);
      let gotInitial = false;

      const unsub = admin.collection("sse_doc").doc(seedDoc.id).onSnapshot((doc) => {
        if (!gotInitial) {
          gotInitial = true;
          admin.collection("sse_doc").doc(seedDoc.id).update({ val: 2 });
        } else if (doc && doc.data.val === 2) {
          clearTimeout(timeout);
          unsub();
          resolve(true);
        }
      }, (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    assert(result === true, "doc().onSnapshot delivers update");
  }

  // ── Collection name validation ──────────────────────────────
  console.log("\nCollection name validation");
  {
    try {
      await admin.collection("user").add({ test: true });
      assert(false, "Reserved name 'user' should be rejected");
    } catch (err: any) {
      assert(true, "Reserved name 'user' is rejected");
    }
  }
  {
    try {
      await admin.collection("session").add({ test: true });
      assert(false, "Reserved name 'session' should be rejected");
    } catch {
      assert(true, "Reserved name 'session' is rejected");
    }
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

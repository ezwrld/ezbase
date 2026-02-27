/**
 * ezbase smoke test — verifies CRUD, auth, SSE, permissions, and list collections.
 * Run: bun run test/smoke.ts  (from repo root, after `docker compose -f test/docker-compose.yml up -d`)
 */

const BASE = "http://localhost:7003/api";
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
      const res = await fetch(`${BASE}/health`);
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

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ADMIN_KEY}`,
  };

  // ── Health ──────────────────────────────────────────────────
  console.log("Health check");
  {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    assert(res.ok && body.status === "ok", "GET /health returns ok");
  }

  // ── CRUD ────────────────────────────────────────────────────
  console.log("\nCRUD operations");
  let docId: string;
  {
    // Create
    const res = await fetch(`${BASE}/collections/todos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Test todo", done: false }),
    });
    assert(res.status === 201, "POST creates document (201)");
    const doc = await res.json();
    assert(doc.id && typeof doc.id === "string", "Document has string id");
    assert(doc.data?.title === "Test todo", "Document data matches");
    assert(typeof doc.created === "number", "Document has created timestamp");
    assert(typeof doc.updated === "number", "Document has updated timestamp");
    docId = doc.id;
  }
  {
    // Read
    const res = await fetch(`${BASE}/collections/todos/${docId}`, { headers });
    const doc = await res.json();
    assert(res.ok && doc.id === docId, "GET returns the created document");
  }
  {
    // Update (PATCH)
    const res = await fetch(`${BASE}/collections/todos/${docId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ done: true }),
    });
    const doc = await res.json();
    assert(res.ok && doc.data.done === true, "PATCH updates document");
    assert(doc.data.title === "Test todo", "PATCH preserves existing fields");
  }
  {
    // Replace (PUT)
    const res = await fetch(`${BASE}/collections/todos/${docId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "Replaced", priority: 1 }),
    });
    const doc = await res.json();
    assert(res.ok && doc.data.title === "Replaced", "PUT replaces document");
  }
  {
    // List
    const res = await fetch(`${BASE}/collections/todos`, { headers });
    const docs = await res.json();
    assert(res.ok && Array.isArray(docs) && docs.length >= 1, "GET lists documents");
  }
  {
    // Delete
    const res = await fetch(`${BASE}/collections/todos/${docId}`, {
      method: "DELETE",
      headers,
    });
    const body = await res.json();
    assert(res.ok && body.success === true, "DELETE removes document");
  }
  {
    // 404 after delete
    const res = await fetch(`${BASE}/collections/todos/${docId}`, { headers });
    assert(res.status === 404, "GET after DELETE returns 404");
  }

  // ── Query filtering ─────────────────────────────────────────
  console.log("\nQuery filtering");
  {
    // Seed some docs
    for (let i = 1; i <= 5; i++) {
      await fetch(`${BASE}/collections/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: `item-${i}`, score: i * 10 }),
      });
    }

    // where filter
    const where = JSON.stringify([["score", ">", 20]]);
    const res = await fetch(`${BASE}/collections/items?where=${encodeURIComponent(where)}`, { headers });
    const docs = await res.json();
    assert(res.ok && docs.length === 3, `WHERE score > 20 returns 3 docs (got ${docs.length})`);

    // limit
    const res2 = await fetch(`${BASE}/collections/items?limit=2`, { headers });
    const docs2 = await res2.json();
    assert(res2.ok && docs2.length === 2, "LIMIT 2 returns 2 docs");

    // orderBy
    const res3 = await fetch(`${BASE}/collections/items?orderBy=score&order=asc&limit=1`, { headers });
    const docs3 = await res3.json();
    assert(res3.ok && docs3[0]?.data?.score === 10, "ORDER BY score ASC returns lowest first");
  }

  // ── List collections ────────────────────────────────────────
  console.log("\nList collections");
  {
    const res = await fetch(`${BASE}/collections`, { headers });
    const cols = await res.json();
    assert(res.ok && Array.isArray(cols), "GET /collections returns array");
    assert(cols.includes("todos"), "Collections include 'todos'");
    assert(cols.includes("items"), "Collections include 'items'");
  }

  // ── Auth (BetterAuth) ──────────────────────────────────────
  console.log("\nAuth");
  let authToken: string;
  {
    // Sign up
    const res = await fetch(`${BASE}/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        password: "testpass123",
        name: "test@example.com",
      }),
    });
    assert(res.status === 200 || res.status === 201, `Sign up succeeds (${res.status})`);
    const data = await res.json();
    authToken = data.session?.token || data.token;
    assert(typeof authToken === "string" && authToken.length > 0, "Sign up returns session token");
    assert(data.user?.email === "test@example.com", "Sign up returns user email");
  }
  {
    // Sign in
    const res = await fetch(`${BASE}/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@example.com",
        password: "testpass123",
      }),
    });
    assert(res.ok, "Sign in succeeds");
    const data = await res.json();
    const token = data.session?.token || data.token;
    assert(typeof token === "string" && token.length > 0, "Sign in returns session token");
  }
  {
    // /me with admin key
    const res = await fetch(`${BASE}/auth/me`, { headers });
    const data = await res.json();
    assert(res.ok && data.role === "admin", "/me with admin key returns admin role");
  }

  // ── Permissions ─────────────────────────────────────────────
  console.log("\nPermissions");
  {
    // Set collection to authenticated
    const res = await fetch(`${BASE}/collections/secret/permissions`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ level: "authenticated" }),
    });
    assert(res.ok, "Set permission to authenticated");
  }
  {
    // Anonymous access should fail
    const res = await fetch(`${BASE}/collections/secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "nope" }),
    });
    assert(res.status === 401, "Anonymous access to authenticated collection returns 401");
  }
  {
    // Authenticated access should work
    const res = await fetch(`${BASE}/collections/secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ data: "yes" }),
    });
    assert(res.status === 201, "Authenticated access to authenticated collection succeeds");
  }

  // ── SSE ─────────────────────────────────────────────────────
  console.log("\nSSE (real-time)");
  {
    const sseResult = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSE timeout")), 10000);
      const controller = new AbortController();

      fetch(`${BASE}/collections/sse_test/sse?token=${ADMIN_KEY}`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      }).then(async (res) => {
        if (!res.ok || !res.body) {
          clearTimeout(timeout);
          reject(new Error(`SSE connect failed: ${res.status}`));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let gotInitial = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          if (buf.includes("event:") && buf.includes("snapshot") && buf.includes("data:")) {
            if (!gotInitial) {
              // First snapshot is the initial empty state — now create a doc
              gotInitial = true;
              buf = "";
              fetch(`${BASE}/collections/sse_test`, {
                method: "POST",
                headers,
                body: JSON.stringify({ hello: "realtime" }),
              });
            } else {
              // Second snapshot should have our doc
              clearTimeout(timeout);
              controller.abort();
              resolve(buf);
              return;
            }
          }
        }
      }).catch((err) => {
        if (err.name !== "AbortError") {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    assert(sseResult.includes("realtime"), "SSE delivers snapshot with created document");
  }

  // ── Collection name validation ──────────────────────────────
  console.log("\nCollection name validation");
  {
    const res = await fetch(`${BASE}/collections/user`, {
      method: "POST",
      headers,
      body: JSON.stringify({ test: true }),
    });
    assert(res.status === 500 || res.status === 400, "Reserved name 'user' is rejected");
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

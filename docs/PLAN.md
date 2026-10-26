# Master plan

## What ezbase is

A backend for web and mobile apps in one Docker image: realtime document database, auth, access rules, file storage, aggregation, backups, and an admin console, on Postgres. It runs on a $5 box and moves to bigger hardware without an SDK change. Firebase-level DX, no lock-in.

## Order of work

| # | Work | State |
|---|------|-------|
| 1 | **Fleet** (`fleet/`): one local page for every instance — health, version drift, traffic, errors, size, backups, one-click console | done |
| 2 | **Data shapes in the console**: per collection, every distinct shape the live documents take (field → types seen, how many documents each), the TypeScript interface derived from it, the documents that don't fit the dominant shape, and a suggested cleanup script for them — so the real data is visible and drift that would produce bad output in the product is caught | next |
| 3 | **Webhooks**: `webhooks.json` → signed POSTs on document create/update/delete, driven by the existing LISTEN/NOTIFY feed, with retries and a delivery log in the console | next |
| 4 | **Landing page** + domain: value prop, quick start, "self-host free" now; "hosted" waitlist once a domain exists | needs a domain |
| 5 | **Split compute from data** (stage 2 below) | when an instance outgrows one box |
| 6 | **ezbase Cloud** starter tier | when someone asks to pay for hosting |

Fleet data decides 5 and 6: an instance whose data size, request rate, or average latency keeps climbing on one box is the trigger, not a calendar.

## Scaling: where one box breaks first

| Piece | Today | Scales out? |
|---|---|---|
| Postgres | inside the image; supervisord pins `DATABASE_URL` to `127.0.0.1` | no — the bottleneck. The server already reads `DATABASE_URL`; the image overrides it |
| Files | written to `/data/files` | no — tied to one disk |
| `rules.json`, `indexes.json`, `auth.json` | files + `fs.watch` | no — a second replica would not see console edits |
| Realtime | Postgres LISTEN/NOTIFY | yes — every replica listens to the same Postgres |
| Analytics | `ON CONFLICT … count = count + EXCLUDED.count` | yes — additive across replicas |
| Automatic index builds | each process may start one | needs a Postgres advisory lock so one replica builds |

## Scaling stages

1. **One box** (now). The all-in-one image stays the default and the free self-hosted product.
2. **Split compute from data.**
   - Image skips its bundled Postgres when `DATABASE_URL` is set.
   - S3-compatible files backend (R2, B2, MinIO).
   - Rules, indexes, and auth settings stored in Postgres; a mounted file stays an override for GitOps.
   - Advisory lock around index builds.
   - N stateless server replicas behind a load balancer. SSE keeps working unchanged.
3. **Read scale.** Read replica for list and `.aggregate()` traffic, PgBouncer, `_ezbase_metrics` off the primary.
4. **Shard by database.** Each `db_<name>` schema is already isolated and auth lives in `public`. A routing table maps database → Postgres cluster, so a write-heavy database (an event firehose) gets its own hardware.

## ezbase Cloud

- **Control plane** = the fleet page grown up: accounts, Stripe billing, provisioning, fleet metrics, one-click upgrades, nightly off-site backups.
- **Starter tier**: one all-in-one container per customer on shared hosts, routed by subdomain. Zero server changes; the fastest path to a paying customer.
- **Scale tier**: stages 2–4 for one customer — dedicated Postgres, N servers, S3.
- **Pitch**: start on a $5 box, move to the scale tier with no SDK change. Firebase can't offer the exit; Supabase can't offer the price.

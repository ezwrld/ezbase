# Observability & Analytics — Future Planning

**Status:** Not built. Notes from architecture discussion.

---

## The Problem

Firebase charges you per document read/write and gives you basic MAU counts, but the analytics are shallow — you can't get granular, can't see specifics, can't understand *who* is using your data and *how*. Since ezbase is self-hosted and targets computationally smaller projects, we have the opportunity to provide real production visibility out of the box.

## What We Want to Track

### Request Analytics
- Document reads and writes (counts, per-collection breakdown)
- Request volume over time (per endpoint, per collection)
- IP ranges making requests — who is reading your data?
- Request latency (p50, p95, p99)
- Error rates (4xx, 5xx breakdown)

### Auth Analytics
- Auth attempts and success/failure rates
- Active sessions (current + over time)
- MAU with actual granularity — per-user activity, not just a count
- Sign-up trends
- OAuth provider breakdown

### Storage / Bandwidth
- Bandwidth in (uploads) and out (downloads) — total and per-bucket
- Storage usage over time
- Most accessed files

### Console Dashboard
- All of the above visualized in the console
- Time range selectors (last hour, day, week, month)
- Per-collection and per-bucket drill-downs

## Architecture Considerations

This is a hard problem because full analytics (logging every request) gets expensive at scale. Options:

1. **Counters only** — maintain atomic counters in Postgres (fast, low overhead, but lose granularity). Could use a dedicated `_ezbase_metrics` table with periodic rollups.

2. **Sampled logging** — log every Nth request to keep volume manageable. Good for patterns, bad for exact counts.

3. **In-memory aggregation + periodic flush** — accumulate metrics in memory, flush to Postgres on an interval (e.g., every 60s). Best balance of accuracy and performance. This is probably the right approach for ezbase's scale.

4. **Time-series buckets** — pre-aggregate into time buckets (per-minute, per-hour, per-day). Allows time-range queries without scanning raw logs. Similar to how Prometheus works but stored in Postgres.

Since ezbase targets smaller projects, option 3 or 4 is probably right — aggregate in memory, flush periodically, roll up into time buckets. No need for a separate time-series database. Postgres can handle this at our scale.

## Key Principle

This should be zero-config. The moment you deploy ezbase, you get a dashboard showing what's happening. No Grafana, no Prometheus, no separate monitoring stack. Just open the console and see your metrics. That's the ezbase way.

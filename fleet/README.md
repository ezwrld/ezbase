# ezbase fleet

One page for every ezbase instance you run: up/down, version against the latest release, 24h traffic, error rate, latency, data size, documents, and backup age. Click a row for its charts, collections, declared indexes, and backups. **Open console** gives each instance its own origin (`<id>.ezbase.localhost:7490`) with the admin key added server-side.

```bash
ez fleet
```

Then open http://ezbase.localhost:7490.

## Instances

Local containers running `ghcr.io/ezwrld/ezbase` are found through the Docker socket, admin key included. Remote instances go in `~/.ezbase/fleet.json`:

```json
{
  "instances": [
    { "name": "Shop", "env": "prod", "url": "https://shop.example.com/ez", "key": { "file": "~/code/shop/.env.prod", "var": "ADMIN_KEY" } },
    { "name": "Shop", "env": "dev", "url": "https://dev.shop.example.com/ez", "key": "…" },
    {
      "name": "Internal",
      "env": "prod",
      "ssh": { "host": "root@203.0.113.7", "password": { "file": "~/.internal-ssh.conf", "var": "PROD_PASS" } },
      "key": { "file": "~/code/internal/.env.prod", "var": "EZBASE_ADMIN_KEY" }
    }
  ]
}
```

- `key` and every `ssh` value take a literal string or `{ file, var }`, read from that env file on each poll.
- `ssh` instances are reached through a tunnel to `127.0.0.1:7003` on that host (`port` to change it), kept open by the fleet server.
- An instance without a key shows health and version only.

The fleet polls `/api/health` and `/api/analytics/*` every 30 seconds; ezbase does not record those in its own analytics. Collection stats, backups, and indexes are read once an hour.

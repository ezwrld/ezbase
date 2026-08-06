# =============================================================================
# ezbase — all-in-one production image
# Runs postgres, API server (Bun), console, and nginx via supervisord
# Single port (7003), single volume (/data)
# =============================================================================

FROM oven/bun:1-alpine AS console-builder

WORKDIR /build/console
COPY console/package.json console/bun.lock* ./
RUN bun install
COPY console/ ./
RUN bun run build

# -----------------------------------------------------------------------------

FROM debian:bookworm-slim

# Install postgres, nginx, supervisor
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates gnupg lsb-release unzip \
    && sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list' \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-16 \
       nginx \
       supervisor \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

ENV NODE_ENV=production

# Release version baked in at build time (workflow passes it); reported by /api/health
ARG EZBASE_VERSION=dev
ENV EZBASE_VERSION=${EZBASE_VERSION}

# Create directories
RUN mkdir -p \
    /data/postgres \
    /data/files \
    /var/log/supervisor \
    /var/run/postgresql \
    && chown postgres:postgres /data/postgres /var/run/postgresql

# Copy built console static files
COPY --from=console-builder /build/console/dist /app/console/dist

# Copy server source + install deps
WORKDIR /app/server
COPY server/package.json server/bun.lock* ./
RUN bun install --production
COPY server/src ./src

# Copy configs
COPY docker/supervisord.conf /etc/supervisor/conf.d/ezbase.conf
COPY docker/nginx.prod.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7003

VOLUME /data

ENTRYPOINT ["/entrypoint.sh"]

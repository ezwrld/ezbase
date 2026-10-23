# ezbase fleet — local control panel for every ezbase instance this machine can see.
# Build context is the repo root so the console can be bundled alongside.

FROM oven/bun:1-alpine AS console
WORKDIR /build
COPY console/package.json console/bun.lock* ./
RUN bun install
COPY console/ ./
RUN bun run build

FROM oven/bun:1-alpine
RUN apk add --no-cache openssh-client sshpass
WORKDIR /app
COPY fleet/package.json fleet/bun.lock* ./
RUN bun install
COPY fleet/ ./
RUN bun run build
COPY --from=console /build/dist ./console
CMD ["bun", "src/server.ts"]

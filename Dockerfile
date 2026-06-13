# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
# ==============================================================================
FROM oven/bun:1.3 AS build

WORKDIR /usr/src/app

# Build tools for native modules: better-sqlite3 (MirrorService) and
# @duckdb/node-api (DataCanvas) compile via node-gyp.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building)
RUN bun install --frozen-lockfile

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.3-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="faostat-mcp-server"
LABEL org.opencontainers.image.description="Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror with a DataCanvas SQL surface, over MCP."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/faostat-mcp-server"

# Copy dependency manifests
COPY package.json bun.lock ./

# Copy node_modules from the build stage — avoids recompiling native modules
# (better-sqlite3 and @duckdb/node-api require python3/make/g++; reusing the
# pre-built artifacts keeps the production image free of build tools).
COPY --from=build /usr/src/app/node_modules ./node_modules

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# These are not bundled by default to keep the base image lean. Enable at build time
# with: docker build --build-arg OTEL_ENABLED=true
ARG OTEL_ENABLED=true
RUN if [ "$OTEL_ENABLED" = "true" ]; then \
      bun add @hono/otel \
        @opentelemetry/instrumentation-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# Mirror CLI scripts. `bun run mirror:init` / `mirror:refresh` / `mirror:verify`
# invoke these directly (Bun runs `.ts` natively) — they must exist in the image
# for an operator to bootstrap, refresh, or inspect the local mirror via
# `docker exec`. The shared context shim is imported by all three.
COPY --from=build /usr/src/app/scripts/faostat-mirror-init.ts \
                  /usr/src/app/scripts/faostat-mirror-refresh.ts \
                  /usr/src/app/scripts/faostat-mirror-verify.ts \
                  /usr/src/app/scripts/_mirror-context.ts \
                  ./scripts/

# Emit a runtime tsconfig so Bun resolves the `@/...` alias the mirror scripts
# import against the compiled `./dist/` (the source tsconfig maps `@/*` → `./src/*`,
# which the production image doesn't carry).
RUN echo '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./dist/*"]}}}' > tsconfig.json

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/faostat-mcp-server && chown -R bun:bun /var/log/faostat-mcp-server

# Writable data dir for the on-disk SQLite mirror (per-domain observation
# stores + the shared dimension DB), owned by the runtime user. Matches the
# FAOSTAT_MIRROR_PATH default; mount a volume here in production to persist the
# corpus across container recreations.
RUN mkdir -p /usr/src/app/.faostat-mirror \
  && chown -R bun:bun /usr/src/app/.faostat-mirror

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/faostat-mcp-server"
ENV MCP_FORCE_CONSOLE_LOGGING="true"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]

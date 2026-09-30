# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to BUILDPLATFORM, not the target platform. `bun run build` emits
# platform-independent JavaScript, so this stage has no reason to run under
# emulation — and under QEMU it does not run at all: Bun's JavaScriptCore
# aborts with a spurious MemoryExhaustion assertion, so a cross-arch build of
# this stage fails outright on an arm64 host. Building natively also removes
# emulation from the slowest stage of a multi-arch build.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# --ignore-scripts skips dependency postinstalls: @duckdb/node-api ships prebuilt
# platform binaries (no build step) and better-sqlite3's node-gyp build is unused
# under Bun (the runtime uses bun:sqlite), so skipping them avoids an exit-127
# abort without losing anything the image needs.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Dependencies Stage
#
# Installs the production dependency tree for the target platform. Every step
# here can run JavaScript — bunfig.toml's security scanner runs as a Bun
# program, and so does the OTel script — so the stage runs on $BUILDPLATFORM
# and cross-installs with `--os`/`--cpu`, which pick each platform-specific
# optional dependency (DuckDB's native binding) for the target. Only
# `node_modules` leaves this stage.
#
# A clean image rather than `FROM build`: the build stage's node_modules holds
# devDependencies.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps

WORKDIR /usr/src/app

# Copy dependency manifests. `bunfig.toml` rides along so every install below
# passes its release-age gate and security scanner, as a local install does.
COPY package.json bun.lock bunfig.toml ./

# The scanner bunfig.toml names is a devDependency, and Bun installs a missing
# scanner through the same production-filtered install, which omits it and
# aborts. Seed it from the build stage's full install instead. Remove this line,
# and the `rm` at the end of this stage, if bunfig.toml stops naming a scanner.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Docker names the target architecture `amd64`/`arm64`; Bun's `--cpu` takes
# `x64`/`arm64`. Mapped once here, read by both installs below. `oven/bun`
# publishes only these two architectures, so any other target fails here.
ARG TARGETOS
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x64 ;; \
      arm64) echo arm64 ;; \
      *) echo "Unsupported TARGETARCH '$TARGETARCH': expected amd64 or arm64" >&2; exit 1 ;; \
    esac > .bun-cpu

# Install only production dependencies. --ignore-scripts skips dependency
# postinstalls: @duckdb/node-api ships prebuilt platform binaries (no build
# step) and better-sqlite3's node-gyp build is unused under Bun (the runtime
# uses bun:sqlite). `--omit=peer` drops the framework's optional peer tiers
# (test runner, service SDKs, parsers) that Bun would otherwise auto-install;
# anything this server imports is in its own `dependencies`.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts \
      --os="$TARGETOS" --cpu="$(cat .bun-cpu)"

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# Installed by default. Omit them for a leaner image at build time
# with: docker build --build-arg OTEL_ENABLED=false
# The script reads the list and each range from the installed framework's
# `peerDependencies` and passes the target flags on to its `bun install`.
COPY scripts/install-otel.ts ./scripts/
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun scripts/install-otel.ts --os="$TARGETOS" --cpu="$(cat .bun-cpu)"; \
    fi

# The seeded scanner served only the installs above; keep it out of the image.
RUN rm -rf node_modules/@socketsecurity/bun-security-scanner


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts. Its only Bun invocations are HEALTHCHECK
# and CMD, which run on the real target at container start.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="faostat-mcp-server"
LABEL org.opencontainers.image.description="Global food & agriculture statistics from the UN FAOSTAT bulk-download corpus, served from a local SQLite mirror with a DataCanvas SQL surface, over MCP."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/faostat-mcp-server"

# The manifest comes from the build context: the deps stage's copy was rewritten
# by the OTel install, and the runtime reads only its name, version, and type.
COPY package.json ./
COPY --from=deps /usr/src/app/node_modules ./node_modules

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

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]

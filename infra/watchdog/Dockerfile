# syntax=docker/dockerfile:1.7
# OpenArt signal watchdog — Node 22 + Google Chrome stable, run daily as a Cloud Run job.
# Build from the REPOSITORY ROOT (the Dockerfile-specific ignore file sits next to this file):
#   docker build --platform linux/amd64 -f infra/watchdog/Dockerfile -t watchdog .
# Local smoke test (no GCP needed; results stay in the container unless WATCHDOG_BUCKET is set):
#   docker run --rm -e WATCHDOG_RUN_ARGS="--journeys meta_one_hop --no-replay --consent-regions none" watchdog
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# procps: `ps`/`pgrep` for the SIGKILL-while-sealed teardown; fonts so pages lay out like a desktop.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg procps fonts-liberation fonts-noto-color-emoji \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The monorepo lockfile drives the install (puppeteer-core, tsx, google-auth-library,
# @google-cloud/bigquery are all in it). --include=dev: tsx + puppeteer-core are dev dependencies.
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY infra/watchdog ./infra/watchdog
# uBlock Origin default lists for the ubo_blocked journey (build-time fetch from uBO's own CDN).
RUN bash packages/watchdog/scripts/fetch-blocklists.sh /app/packages/watchdog/blocklists

RUN useradd --create-home --uid 10001 watchdog \
 && mkdir -p /app/packages/watchdog/.profiles /tmp/watchdog \
 && chown -R watchdog:watchdog /app/packages/watchdog /tmp/watchdog
USER watchdog

# Chrome's setuid/userns sandbox is unavailable in Cloud Run containers; the container itself is the
# isolation boundary (ephemeral, no credentials beyond the job's service account; Chrome's egress is
# only the watchdog's gatekeeper proxy, which tunnels to openart.ai hosts only). WATCHDOG_CHROME_ARGS
# is an allowlist (sandbox/GPU/shm flags); a flag that could re-route Chrome aborts the run.
ENV WATCHDOG_CHROME=/usr/bin/google-chrome \
    WATCHDOG_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage" \
    WATCHDOG_BLOCKLISTS=/app/packages/watchdog/blocklists \
    WATCHDOG_TARGET=live

ENTRYPOINT ["bash", "infra/watchdog/entrypoint.sh"]

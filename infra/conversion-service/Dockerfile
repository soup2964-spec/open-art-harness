# OpenArt signal conversion-service — Cloud Run service (Node 22, one esbuild bundle).
# Build from the REPOSITORY ROOT (the Dockerfile-specific ignore file sits next to this file):
#   docker build --platform linux/amd64 -f infra/conversion-service/Dockerfile \
#     -t REGION-docker.pkg.dev/PROJECT_ID/openart-signal/conversion-service:TAG .
# Local run (dry-run, in-memory stores; nothing is sent anywhere):
#   docker run --rm -p 8080:8080 -e STRIPE_WEBHOOK_SECRETS=whsec_local \
#     -e INTERNAL_EVENTS_HMAC_SECRETS=local-hmac-key-0123456789abcdef0123 conversion-service
# (Those two values are documented examples: live mode refuses them.)
#
# The build runs the package's typecheck and full test suite (CI=true makes a missing payload
# snapshot a failure), so an image only exists if every contract and zero-network test passed.
#
# Base images are pinned BY DIGEST, not by tag: a tag can be re-pointed, a digest cannot. Replace
# both REPLACE_WITH_*_DIGEST placeholders before the first build (the build fails until then), and
# bump them deliberately:
#   docker buildx imagetools inspect node:22-bookworm-slim --format '{{json .Manifest.Digest}}'
#   docker buildx imagetools inspect gcr.io/distroless/nodejs22-debian12:nonroot --format '{{json .Manifest.Digest}}'
ARG NODE_BUILD_IMAGE=node:22-bookworm-slim@sha256:REPLACE_WITH_NODE_22_BOOKWORM_SLIM_DIGEST
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot@sha256:REPLACE_WITH_DISTROLESS_NODEJS22_NONROOT_DIGEST

FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /repo
ENV CI=true
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
RUN npm run typecheck --workspace @openart-signal/conversion-service \
 && npm run test --workspace @openart-signal/conversion-service \
 && npm run build --workspace @openart-signal/conversion-service
# Keep only runtime dependencies for the externals the bundle imports
# (stripe, @google-cloud/bigquery, google-auth-library are root "dependencies").
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/conversion-service/dist/server.mjs ./dist/server.mjs
ENV NODE_ENV=production \
    PORT=8080 \
    CONVERSION_SERVICE_MODE=dry_run
EXPOSE 8080
USER nonroot
# distroless/nodejs's entrypoint is node.
CMD ["dist/server.mjs"]

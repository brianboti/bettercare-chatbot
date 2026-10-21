# Sophia server image.
#
#   docker build -t sophia .
#   docker run -p 8787:8787 --env-file .env -v /path/to/site:/data/site:ro sophia
#
# The build installs production dependencies, downloads the embedding model
# and checks the search vectors against the chunks (npm run build:index), so
# the container starts in seconds and needs no network for search. The
# BetterCare site export is not in the image: mount it at /data/site (a
# Cloud Storage volume on Cloud Run) to serve the website; without it the
# API and the extension still work. See README.md, "Deploying".

FROM node:24-slim AS build
WORKDIR /app
ENV MODEL_CACHE_DIR=/app/.models
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 # The ONNX runtime ships Windows and macOS builds too; keep this platform's (saves ~220 MB).
 && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 -type d ! -name linux -exec rm -rf {} +
COPY . .
RUN node tools/build-index.mjs

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    MODEL_CACHE_DIR=/app/.models \
    SITE_DIR=/data/site \
    SOPHIA_DB=/tmp/sophia/sophia.db \
    TEST_RESULTS_DIR=/tmp/sophia/test-results \
    CHAT_LOG=-
# Owned by root and read-only to the app; it runs as the unprivileged "node"
# user and writes only under /tmp.
COPY --from=build /app /app
USER node
EXPOSE 8787
CMD ["node", "server/index.mjs"]

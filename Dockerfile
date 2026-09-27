# syntax=docker/dockerfile:1
#
# The sync server, with @sc/api from the plugins repository beside this one.
# Compose passes it as the `api` build context; by hand:
#
#   docker build --build-context api=../streaming_center_plugins/api -t streaming-center-sync .

FROM node:24-alpine AS build
# The alias to @sc/api is a relative path, so the source sits where it points.
WORKDIR /src/streaming_center_sync
COPY package.json package-lock.json ./
RUN npm ci
COPY --from=api . /src/streaming_center_plugins/api
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# One bundle for the server, one for its command line: nothing to install.
FROM node:24-alpine
ENV NODE_ENV=production \
    SC_SYNC_DATA=/data \
    SC_SYNC_HOST=0.0.0.0 \
    SC_SYNC_PORT=8730
WORKDIR /app
COPY --from=build /src/streaming_center_sync/dist ./dist
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/dist/cli.mjs "$@"\n' > /usr/local/bin/sc-sync \
 && chmod +x /usr/local/bin/sc-sync \
 && mkdir -p /data \
 && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8730
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.SC_SYNC_PORT || 8730) + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/dist/main.mjs"]

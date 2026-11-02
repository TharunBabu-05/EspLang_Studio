FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/compiler/package.json packages/compiler/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci
COPY packages packages
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp TMPDIR=/tmp
COPY --from=build --chown=node:node /app /app
USER node

FROM app AS gateway
ENV BUILD_MODE=hosted HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node", "--import", "tsx", "packages/server/src/server.ts"]

FROM app AS worker
USER root
COPY --chmod=755 deploy/install-toolchain.sh /usr/local/bin/install-toolchain
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && install-toolchain && rm -rf /var/lib/apt/lists/* /tmp/*
ENV ARDUINO_CLI=/opt/arduino-cli ARDUINO_CONFIG=/opt/arduino-cli.yaml
USER node
CMD ["node", "--import", "tsx", "packages/server/src/buildWorker.ts"]

FROM docker:28-cli AS docker-cli

FROM app AS runner
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# The runner needs the host Docker socket; the public gateway and job containers
# never receive that socket. Treat this private broker as a host administrator.
USER root
EXPOSE 3002
CMD ["node", "--import", "tsx", "packages/server/src/runner.ts"]

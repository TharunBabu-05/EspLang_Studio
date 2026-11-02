#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ]; then echo 'Usage: sh deploy/start.sh studio.your-domain.com' >&2; exit 1; fi
docker compose version >/dev/null
if [ "$(docker info --format '{{.OSType}}/{{.Architecture}}')" != 'linux/x86_64' ]; then
  echo 'This deployment currently requires a Linux x86_64 Docker host.' >&2; exit 1
fi
if [ ! -f deploy/.env ]; then
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/workspace" -w /workspace node:22-bookworm-slim node scripts/init-hosting.mjs "$1"
fi
if ! grep -Fx "DOMAIN=$1" deploy/.env >/dev/null; then
  echo 'The requested domain differs from deploy/.env. Edit that file deliberately before continuing.' >&2; exit 1
fi
docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml build worker-image
docker compose --env-file deploy/.env -f deploy/compose.yml build gateway runner
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
echo "Services started. Once DNS resolves and HTTPS is ready, open https://$1"

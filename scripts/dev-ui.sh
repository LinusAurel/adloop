#!/usr/bin/env bash
# Dev-Server für die Oberflächenarbeit mit HMR.
#
# Die Datenbank des Compose-Stacks hat bewusst keinen Host-Port. Für einen
# Dev-Server auf dem Host braucht es deshalb eine Brücke:
#
#   docker run -d --name adloop-db-bridge --network adloop_adloop -p 5433:5432 \
#     alpine/socat tcp-listen:5432,fork,reuseaddr tcp-connect:db:5432
#
# .env.dev-ui ist die Umgebung des laufenden web-Containers mit DATABASE_URL
# auf 127.0.0.1:5433. Nicht eingecheckt.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.dev-ui ] || { echo "fehlt: .env.dev-ui — siehe Kopf dieser Datei" >&2; exit 1; }
set -a; . ./.env.dev-ui; set +a
# Die Umgebung stammt aus dem Produktions-Container. Bliebe NODE_ENV darin
# auf "production", verhielte sich `next dev` wie ein fertiger Build und
# verarbeitete nicht einmal CSS.
export NODE_ENV=development
exec pnpm exec next dev -p "${PORT:-3400}"

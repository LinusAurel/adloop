#!/usr/bin/env bash
# `next build` needs a schema-valid environment even though it never connects to
# anything. Same placeholders as the Dockerfile — keep both in sync.
set -euo pipefail
export DATABASE_URL="${DATABASE_URL:-postgres://build:build@127.0.0.1:5432/build}"
export SESSION_SECRET="${SESSION_SECRET:-build-time-placeholder-at-least-32-characters}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-YnVpbGQtdGltZS1wbGFjZWhvbGRlci0zMmJ5dGVzIQ==}"
export META_APP_ID="${META_APP_ID:-000000000000000}"
export META_APP_SECRET="${META_APP_SECRET:-build-time-placeholder}"
export META_REDIRECT_URI="${META_REDIRECT_URI:-http://localhost:3000/api/auth/meta/callback}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-build}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-build}"
exec "$@"

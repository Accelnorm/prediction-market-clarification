#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
DEFAULT_ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$DEFAULT_ENV_FILE" ]; then
  DEFAULT_ENV_FILE="$ROOT_DIR/.env.demo"
fi

ENV_FILE="${ENV_FILE:-$DEFAULT_ENV_FILE}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create $ROOT_DIR/.env or $ROOT_DIR/.env.demo before deploying." >&2
  exit 1
fi

REVIEWER_TOKEN="$(awk -F= '
  $1 == "REVIEWER_AUTH_TOKEN" {
    value = substr($0, index($0, "=") + 1)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
    print value
    exit
  }
' "$ENV_FILE" 2>/dev/null || true)"

docker compose \
  --env-file "$ENV_FILE" \
  -f "$ROOT_DIR/docker-compose.demo.yml" \
  up -d --build

echo "Demo deployment started with env file: $ENV_FILE"

if [ -n "$REVIEWER_TOKEN" ]; then
  echo "Reviewer demo auth token: $REVIEWER_TOKEN"
  echo "Use it as the x-reviewer-token header or in the reviewer console session form."
fi

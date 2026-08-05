#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONFIG_FILE="${CLOUDFLARE_CONFIG:-$ROOT_DIR/claudflare}"
BUNDLE_FILE="$ROOT_DIR/.refresh-unverified-d1.mjs"
LOG_FILE="${REFRESH_LOG:-$ROOT_DIR/refresh-unverified-d1.log}"
BATCH_LIMIT="${REFRESH_BATCH_LIMIT:-100}"
CONCURRENCY="${REFRESH_CONCURRENCY:-2}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing Cloudflare config: $CONFIG_FILE" >&2
  exit 1
fi

CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_FILE")"
CLOUDFLARE_API_TOKEN="$(sed -n 's/^CLOUDFLARE_API_TOKEN[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_FILE")"
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" || -z "$CLOUDFLARE_API_TOKEN" ]]; then
  echo "Cloudflare credentials are missing from $CONFIG_FILE" >&2
  exit 1
fi

export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN

node "$ROOT_DIR/node_modules/.bin/esbuild" \
  "$SCRIPT_DIR/refresh-unverified-d1.ts" \
  --bundle --platform=node --format=esm --outfile="$BUNDLE_FILE"

: > "$LOG_FILE"
while true; do
  output="$(REFRESH_LIMIT="$BATCH_LIMIT" REFRESH_DRY_RUN=0 REFRESH_CONCURRENCY="$CONCURRENCY" node "$BUNDLE_FILE" 2>&1)"
  status=$?
  printf '%s\n' "$output" | tee -a "$LOG_FILE"
  if [[ $status -ne 0 ]]; then
    echo "Refresh batch failed; inspect $LOG_FILE" >&2
    exit "$status"
  fi
  refreshed="$(printf '%s\n' "$output" | sed -n 's/.*done refreshed=\([0-9][0-9]*\).*/\1/p' | tail -n 1)"
  pending="$(printf '%s\n' "$output" | sed -n 's/.*pending=\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  if [[ "${pending:-0}" -eq 0 ]]; then
    break
  fi
  if [[ "${refreshed:-0}" -eq 0 ]]; then
    echo "No models were refreshed in the last batch; stopping." | tee -a "$LOG_FILE"
    exit 2
  fi
done

echo "Refresh complete. Log: $LOG_FILE"
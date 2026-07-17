#!/usr/bin/env bash
#
# deploy.sh — one-shot deploy for stats-dashboard.
#
# Idempotent: safe to run repeatedly. It installs deps, applies the D1 schema,
# provisions any missing Worker secrets, deploys the Worker, and smoke-tests it.
#
# Usage:
#   ./deploy.sh                 # install, ensure secrets, deploy, verify
#   ./deploy.sh --refresh       # ...then trigger a live data pull via /run
#   ./deploy.sh --gsc-key PATH  # also (re)set GSC_SA_KEY from a service-account JSON
#   ./deploy.sh --schema        # also (re)apply the D1 schema — needs a token with
#                               #   D1:Edit scope (the analytics token can't; use the
#                               #   Cloudflare dashboard or MCP connector instead).
#
# Requires: node/npm, and ~/Projects/.cloudflare.env holding CLOUDFLARE_API_TOKEN.
# If the file has multiple token lines, the FIRST one is used.

set -euo pipefail
cd "$(dirname "$0")"

CF_ENV="$HOME/Projects/.cloudflare.env"
WORKER="stats-dashboard"
URL="https://stats.davidveksler.com"
KEY_FILE=".deploy/refresh_key.txt"       # gitignored; persists the /run key
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

DO_REFRESH=0
DO_SCHEMA=0
ASSUME_YES=0
GSC_KEY_PATH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --refresh) DO_REFRESH=1; shift ;;
    --schema)  DO_SCHEMA=1; shift ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --gsc-key) GSC_KEY_PATH="${2:?--gsc-key needs a path}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

wr() { npx --no-install wrangler "$@"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[1;32mOK\033[0m   %s\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
DEPLOY_OK=0
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$DEPLOY_OK" -ne 1 ]; then
    printf '\n\033[1;31mERROR: Stats Dashboard deployment failed (exit %s).\033[0m\n' "$rc" >&2
  fi
}
trap on_exit EXIT

step "Preflight"
[ -z "$(git status --porcelain)" ] || die "Working tree is not clean. Commit or stash changes before deploying."
DEPLOY_COMMIT="$(git rev-parse --short HEAD)"
ok "working tree is clean at $DEPLOY_COMMIT"

if [ "$ASSUME_YES" -ne 1 ]; then
  step "Deployment plan"
  printf '  Site:   Stats Dashboard\n  Target: %s\n  Method: Cloudflare Workers\n  Commit: %s\n' "$URL" "$DEPLOY_COMMIT"
  read -r -p "Deploy this production plan? [y/N] " reply
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]] || { echo "Cancelled. Nothing was deployed."; exit 0; }
fi

# --- 1. Auth: take ONLY the first CLOUDFLARE_API_TOKEN line -------------------
# (the env file intentionally holds two; concatenating them makes an invalid header)
[ -f "$CF_ENV" ] || { echo "missing $CF_ENV" >&2; exit 1; }
CLOUDFLARE_API_TOKEN="$(grep -m1 -oE 'CLOUDFLARE_API_TOKEN=[^[:space:]]+' "$CF_ENV" | head -1 | cut -d= -f2)"
[ -n "$CLOUDFLARE_API_TOKEN" ] || { echo "no CLOUDFLARE_API_TOKEN in $CF_ENV" >&2; exit 1; }
export CLOUDFLARE_API_TOKEN

# --- 2. Dependencies ---------------------------------------------------------
if [ ! -d node_modules/wrangler ]; then
  step "Installing dependencies"
  npm install
fi

# --- 3. D1 schema — opt-in; the tables already exist and this needs D1:Edit --
# (CREATE TABLE IF NOT EXISTS is idempotent, but `d1 execute --remote` hits the
#  D1 management API, which the analytics token isn't scoped for. Best-effort.)
if [ "$DO_SCHEMA" = "1" ]; then
  step "Applying D1 schema"
  if wr d1 execute "$WORKER" --remote --file=./schema.sql --yes >/dev/null 2>&1; then
    echo "schema ok"
  else
    echo "⚠ schema apply failed (token likely lacks D1:Edit). Tables already exist;"
    echo "  to change schema, run schema.sql via the Cloudflare D1 console or MCP."
  fi
fi

# --- 4. Secrets — set only the ones not already present ----------------------
step "Checking Worker secrets"
EXISTING="$(wr secret list 2>/dev/null | grep -oE '"name": "[A-Z_]+"' | grep -oE '[A-Z_]+' || true)"
has_secret() { echo "$EXISTING" | grep -qx "$1"; }

if ! has_secret CF_API_TOKEN; then
  echo "setting CF_API_TOKEN (Worker's own analytics token)"
  printf '%s' "$CLOUDFLARE_API_TOKEN" | wr secret put CF_API_TOKEN >/dev/null
fi

if ! has_secret REFRESH_KEY || [ ! -f "$KEY_FILE" ]; then
  mkdir -p "$(dirname "$KEY_FILE")"
  REFRESH="$(openssl rand -hex 16)"
  printf '%s' "$REFRESH" | wr secret put REFRESH_KEY >/dev/null
  echo "$REFRESH" > "$KEY_FILE"
  echo "generated/rotated REFRESH_KEY -> $KEY_FILE"
fi

if [ -n "$GSC_KEY_PATH" ]; then
  [ -f "$GSC_KEY_PATH" ] || { echo "GSC key not found: $GSC_KEY_PATH" >&2; exit 1; }
  echo "setting GSC_SA_KEY from $GSC_KEY_PATH"
  wr secret put GSC_SA_KEY < "$GSC_KEY_PATH" >/dev/null
elif ! has_secret GSC_SA_KEY; then
  echo "⚠ GSC_SA_KEY not set — keywords will be skipped. Set later with: ./deploy.sh --gsc-key PATH"
fi

# --- 5. Deploy ---------------------------------------------------------------
step "Deploy"
wr deploy

# --- 6. Smoke test -----------------------------------------------------------
step "Verify live"
sleep 3
HEALTH="$(curl -fsS -A "$UA" "$URL/health" || echo FAIL)"
echo "GET /health -> $HEALTH"
[ "$HEALTH" = "ok" ] || { echo "health check failed" >&2; exit 1; }

if [ "$DO_REFRESH" = "1" ]; then
  step "Triggering live pull (/run)"
  if [ -f "$KEY_FILE" ]; then
    RK="$(tr -d '\n' < "$KEY_FILE")"
    curl -fsS -A "$UA" "$URL/run?key=$RK" | sed 's/^/  /'
    echo
  else
    echo "no local refresh key ($KEY_FILE); skipping /run"
  fi
fi

DEPLOY_OK=1
step "Deployment complete and verified. $URL"

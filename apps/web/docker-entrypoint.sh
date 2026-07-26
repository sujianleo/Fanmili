#!/bin/sh

set -eu

data_root=${FAMILY_APP_DATA_ROOT:-/app/data}
secrets_file="$data_root/.family-lite-secrets"

mkdir -p "$data_root"

if [ ! -f "$secrets_file" ]; then
  umask 077
  temporary_file="${secrets_file}.tmp.$$"
  node -e '
    const { randomBytes } = require("node:crypto");
    const secret = () => randomBytes(32).toString("hex");
    process.stdout.write([
      `FAMILY_LITE_SESSION_SECRET=${secret()}`,
      `FAMILY_LITE_CONFIRMATION_SECRET=${secret()}`,
      `FAMILY_LITE_INTERNAL_JOB_KEY=${secret()}`
    ].join("\n") + "\n");
  ' > "$temporary_file"
  mv "$temporary_file" "$secrets_file"
fi

# shellcheck disable=SC1090
. "$secrets_file"

: "${FAMILY_APP_LOCAL_AUTH_SESSION_SECRET:=$FAMILY_LITE_SESSION_SECRET}"
: "${FAMILY_APP_CONFIRMATION_SECRET:=$FAMILY_LITE_CONFIRMATION_SECRET}"
: "${FAMILY_APP_INTERNAL_JOB_KEY:=$FAMILY_LITE_INTERNAL_JOB_KEY}"
: "${FAMILY_APP_BACKEND:=sqlite}"
: "${FAMILY_APP_AUTH_REQUIRED:=true}"
: "${FAMILY_APP_SQLITE_PATH:=$data_root/family.sqlite}"
: "${FAMILY_APP_ALLOW_FILE_FALLBACK:=true}"
: "${FAMILY_APP_DEMO_DATA:=false}"

export FAMILY_APP_LOCAL_AUTH_SESSION_SECRET
export FAMILY_APP_CONFIRMATION_SECRET
export FAMILY_APP_INTERNAL_JOB_KEY
export FAMILY_APP_BACKEND
export FAMILY_APP_AUTH_REQUIRED
export FAMILY_APP_SQLITE_PATH
export FAMILY_APP_ALLOW_FILE_FALLBACK
export FAMILY_APP_DEMO_DATA

if [ "$(id -u)" -eq 0 ]; then
  chown -R nextjs:nodejs "$data_root"
  exec su-exec nextjs:nodejs "$@"
fi

exec "$@"

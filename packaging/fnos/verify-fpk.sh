#!/bin/bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <package.fpk> [...]" >&2
  exit 2
fi

portable_md5() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print $1}'
  else
    md5 -q "$1"
  fi
}

manifest_value() {
  awk -F= -v key="$2" '$1 ~ "^[[:space:]]*" key "[[:space:]]*$" {value=$2; sub(/^[[:space:]]+/, "", value); sub(/[[:space:]]+$/, "", value); print value}' "$1"
}

for package_path in "$@"; do
  [ -f "$package_path" ] || { echo "missing package: $package_path" >&2; exit 1; }
  case "$(basename "$package_path")" in
    fanmili_*_x86.fpk) expected_platform=x86 ;;
    fanmili_*_arm.fpk) expected_platform=arm ;;
    *) echo "unexpected package name: $package_path" >&2; exit 1 ;;
  esac

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/fanmili-verify.XXXXXX")"
  trap 'rm -rf "$work_dir"' EXIT
  tar -xzf "$package_path" -C "$work_dir"

  for entry in \
    app.tgz manifest cmd/main cmd/common cmd/installer \
    cmd/install_init cmd/install_callback cmd/config_init cmd/config_callback \
    cmd/upgrade_init cmd/upgrade_callback cmd/uninstall_init cmd/uninstall_callback \
    config/privilege config/resource docker/docker-compose.yaml ui/config \
    wizard/config wizard/install wizard/uninstall Fanmili.sc ICON.PNG ICON_256.PNG; do
    [ -e "$work_dir/$entry" ] || { echo "$(basename "$package_path"): missing $entry" >&2; exit 1; }
  done

  [ "$(manifest_value "$work_dir/manifest" appname)" = "fanmili" ]
  [ "$(manifest_value "$work_dir/manifest" platform)" = "$expected_platform" ]
  [ "$(manifest_value "$work_dir/manifest" checksum)" = "$(portable_md5 "$work_dir/app.tgz")" ]
  [ "$(manifest_value "$work_dir/manifest" checkport)" = "false" ]
  [ "$(manifest_value "$work_dir/manifest" os_min_version)" = "1.1.8" ]

  tar -xzf "$work_dir/app.tgz" -C "$work_dir"
  compose="$work_dir/docker/docker-compose.yaml"
  grep -q 'image: ghcr.io/sujianleo/family:v' "$compose"
  grep -q 'user: "0:0"' "$compose"
  grep -q '\${TRIM_PKGVAR:?}/data:/app/data' "$compose"
  grep -q '\${wizard_port:-3001}:3000' "$compose"
  if grep -Eq '(__IMAGE_TAG__|:latest|DEEPSEEK_API_KEY|OPENAI_API_KEY)' "$compose"; then
    echo "$(basename "$package_path"): unresolved tag or secret field in Compose" >&2
    exit 1
  fi

  for script in "$work_dir"/cmd/*; do
    [ -x "$script" ] || { echo "$(basename "$package_path"): non-executable $script" >&2; exit 1; }
    bash -n "$script"
  done
  jq -e . "$work_dir/config/privilege" "$work_dir/config/resource" \
    "$work_dir/ui/config" "$work_dir/wizard/config" \
    "$work_dir/wizard/install" "$work_dir/wizard/uninstall" >/dev/null
  jq -e '.[0].items[] | select(.field == "wizard_port")' "$work_dir/wizard/install" >/dev/null
  jq -e '.[0].items[] | select(.field == "wizard_port")' "$work_dir/wizard/config" >/dev/null
  jq -e '.[".url"]["fanmili.Application"].port == "${wizard_port}"' "$work_dir/ui/config" >/dev/null
  grep -q '\.fnos-network-defaults\.json' "$work_dir/cmd/service-setup"
  grep -q 'detect_private_ipv4' "$work_dir/cmd/service-setup"

  if tar -tzf "$package_path" | grep -Eiq '(^|/)(\.env|family\.sqlite|data/|node_modules/|test/|tests/|output/)'; then
    echo "$(basename "$package_path"): private or development data found" >&2
    exit 1
  fi

  rm -rf "$work_dir"
  trap - EXIT
  echo "Verified $(basename "$package_path")"
done

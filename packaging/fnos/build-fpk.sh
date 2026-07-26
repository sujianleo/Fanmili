#!/bin/bash
set -euo pipefail
export COPYFILE_DISABLE=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
version="${1:-}"
output_dir="${2:-$repo_root/dist/fnos}"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <version-without-v> [output-directory]" >&2
  exit 2
fi

portable_md5() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print $1}'
  else
    md5 -q "$1"
  fi
}

portable_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/fanmili-fpk.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$output_dir" "$work_dir/app/docker"

cp "$script_dir/docker/docker-compose.yaml" "$work_dir/app/docker/docker-compose.yaml"
sed -i.bak "s/__IMAGE_TAG__/v${version}/g" "$work_dir/app/docker/docker-compose.yaml"
rm -f "$work_dir/app/docker/docker-compose.yaml.bak"
cp -R "$script_dir/ui" "$work_dir/app/ui"
(cd "$work_dir/app" && tar -czf "$work_dir/app.tgz" docker ui)

app_checksum="$(portable_md5 "$work_dir/app.tgz")"
rm -f "$output_dir"/fanmili_*.fpk "$output_dir/SHA256SUMS"

for platform in x86 arm; do
  stage="$work_dir/package-$platform"
  mkdir -p "$stage"
  cp "$work_dir/app.tgz" "$stage/app.tgz"
  cp "$script_dir/manifest" "$stage/manifest"
  sed -i.bak \
    -e "s/^version.*/version         = ${version}/" \
    -e "s/^platform.*/platform        = ${platform}/" \
    -e "s/^checksum.*/checksum        = ${app_checksum}/" \
    "$stage/manifest"
  rm -f "$stage/manifest.bak"

  cp "$script_dir/Fanmili.sc" "$stage/Fanmili.sc"
  cp "$script_dir/ICON.PNG" "$stage/ICON.PNG"
  cp "$script_dir/ICON_256.PNG" "$stage/ICON_256.PNG"
  cp -R "$script_dir/cmd" "$stage/cmd"
  cp -R "$script_dir/config" "$stage/config"
  cp -R "$script_dir/docker" "$stage/docker"
  cp -R "$script_dir/ui" "$stage/ui"
  cp -R "$script_dir/wizard" "$stage/wizard"
  cp "$work_dir/app/docker/docker-compose.yaml" "$stage/docker/docker-compose.yaml"
  chmod 755 "$stage"/cmd/*

  artifact="$output_dir/fanmili_${version}_${platform}.fpk"
  (cd "$stage" && tar -czf "$artifact" \
    app.tgz manifest cmd config wizard docker ui Fanmili.sc ICON.PNG ICON_256.PNG)
done

for artifact in "$output_dir"/fanmili_*.fpk; do
  printf '%s  %s\n' "$(portable_sha256 "$artifact")" "$(basename "$artifact")" >> "$output_dir/SHA256SUMS"
done

"$script_dir/verify-fpk.sh" "$output_dir"/fanmili_*.fpk
printf 'Built fnOS packages in %s\n' "$output_dir"

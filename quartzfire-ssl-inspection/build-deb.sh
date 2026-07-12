#!/usr/bin/env bash
# Build the quartzfire-ssl-inspection package inside a Debian bookworm
# container and drop it in ../packages/ for the ISO build (build-vyos-image
# bakes every packages/*.deb into the image automatically).
#
# Rust-only (no C deps); the build runs on the container's own filesystem so it
# works from a Windows/drvfs checkout too (same scheme as quartzfire-geoip).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"

mkdir -p "$repo_root/packages"

echo "==> Building quartzfire-ssl-inspection in rust:1-bookworm"
docker run --rm \
  -v "$repo_root/quartzfire-ssl-inspection":/src:ro \
  -v "$repo_root/packages":/out \
  rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    build-essential debhelper devscripts rsync >/dev/null

  mkdir -p /build/quartzfire-ssl-inspection
  rsync -a --exclude target/ /src/ /build/quartzfire-ssl-inspection/
  cd /build/quartzfire-ssl-inspection
  chmod 0755 debian/rules debian/postinst debian/postrm scripts/check-squid-caps
  dpkg-buildpackage -us -uc -b
  cp /build/quartzfire-ssl-inspection_*.deb /out/
'

echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/quartzfire-ssl-inspection_*.deb

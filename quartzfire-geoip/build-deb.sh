#!/usr/bin/env bash
# Build the quartzfire-geoip package inside a Debian bookworm container and
# drop it in ../packages/ for the ISO build (build-vyos-image bakes every
# packages/*.deb into the image automatically).
#
# The build needs the Rust toolchain (from the container image) and
# libloc-dev (the C shim in src/shim.c compiles against the real libloc
# headers — see build.rs). The build runs on the container's own filesystem
# so it works from a Windows/drvfs checkout too (same scheme as
# qfappd/build-deb.sh).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"

mkdir -p "$repo_root/packages"

echo "==> Building quartzfire-geoip in rust:1-bookworm"
docker run --rm \
  -v "$repo_root/quartzfire-geoip":/src:ro \
  -v "$repo_root/packages":/out \
  rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    build-essential debhelper devscripts libloc-dev rsync >/dev/null

  mkdir -p /build/quartzfire-geoip
  rsync -a --exclude target/ /src/ /build/quartzfire-geoip/
  cd /build/quartzfire-geoip
  chmod 0755 debian/rules debian/postinst debian/postrm
  dpkg-buildpackage -us -uc -b
  cp /build/quartzfire-geoip_*.deb /out/
'

echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/quartzfire-geoip_*.deb

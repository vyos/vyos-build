#!/usr/bin/env bash
# Build quartzfire-webui_*.deb inside a Debian bookworm container that has a
# current Rust toolchain, then drop the artifact into ../packages/ for the ISO
# build. Run from anywhere; needs Docker. Works from a Windows checkout (mounts
# the repo and fixes exec bits inside the container).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"

echo "==> Building quartzfire-webui .deb in rust:1-bookworm"
docker run --rm -v "$repo_root":/src -w /src/quartzfire-webui rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends nodejs npm debhelper devscripts ca-certificates >/dev/null

  # Windows checkouts drop the exec bit; restore it for the maintainer scripts.
  chmod +x debian/rules debian/postinst debian/postrm

  # 1) Static-export the Next.js frontend into backend/www
  ( cd frontend && npm install && npm run build )

  # 2) Build the .deb (lands in the parent dir, /src)
  dpkg-buildpackage -us -uc -b
'

mkdir -p "$repo_root/packages"
cp "$repo_root"/quartzfire-webui_*.deb "$repo_root/packages/"
echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/quartzfire-webui_*.deb

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
  apt-get install -y --no-install-recommends build-essential debhelper devscripts ca-certificates curl gnupg >/dev/null

  # Tailwind v4 needs Node >= 20; bookworm ships EOL Node 18 — use NodeSource.
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y --no-install-recommends nodejs >/dev/null

  # Windows checkouts drop the exec bit; restore it for the maintainer scripts.
  chmod +x debian/rules debian/postinst debian/postrm

  # 1) Static-export the Next.js frontend into backend/www.
  #    `npm ci` (not `install`) wipes node_modules first — the repo mount may
  #    carry a node_modules from a Windows checkout whose native bindings
  #    (@tailwindcss/oxide, lightningcss) are the wrong platform, and npm would
  #    otherwise consider the tree complete and skip them (npm/cli#4828).
  #    Stale .next/out caches from the host are cleared for the same reason.
  ( cd frontend && rm -rf .next out && npm ci && npm run build )

  # 2) Build the .deb (lands in the parent dir, /src)
  dpkg-buildpackage -us -uc -b
'

mkdir -p "$repo_root/packages"
cp "$repo_root"/quartzfire-webui_*.deb "$repo_root/packages/"
echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/quartzfire-webui_*.deb

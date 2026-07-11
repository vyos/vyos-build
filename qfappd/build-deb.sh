#!/usr/bin/env bash
# Build qfappd_*.deb inside a Debian bookworm container that has Rust, protoc,
# clang, the netfilter -dev headers, and a from-source libndpi >= 4.8, then
# drop the artifact into ../packages/ for the ISO build. Works from a Windows
# checkout (mounts the repo, fixes exec bits inside the container).
#
# Mirrors quartzfire-webui/build-deb.sh. Needs Docker.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
NDPI_REF="${NDPI_REF:-4.8}"

echo "==> Building qfappd .deb in rust:1-bookworm (libndpi ${NDPI_REF})"
docker run --rm -v "$repo_root":/src -w /src/qfappd rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    build-essential debhelper devscripts ca-certificates \
    protobuf-compiler clang libclang-dev pkg-config \
    autoconf automake libtool git libpcap-dev libgcrypt20-dev >/dev/null

  # libndpi is not in Debian at a recent version — build '"$NDPI_REF"' from
  # source into /usr/local (matching the QuartzFire image contract).
  if ! [ -f /usr/local/include/ndpi/ndpi_api.h ]; then
    git clone --depth 1 --branch '"$NDPI_REF"' https://github.com/ntop/nDPI.git /tmp/nDPI
    ( cd /tmp/nDPI && ./autogen.sh && ./configure --prefix=/usr/local && make -j"$(nproc)" && make install )
    ldconfig
  fi

  # Windows checkouts drop the exec bit; restore it.
  chmod +x debian/rules debian/postinst debian/postrm scripts/qfappd-apply

  dpkg-buildpackage -us -uc -b
'

mkdir -p "$repo_root/packages"
cp "$repo_root"/qfappd_*.deb "$repo_root/packages/"
echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/qfappd_*.deb

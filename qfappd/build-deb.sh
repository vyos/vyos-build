#!/usr/bin/env bash
# Build the qfappd packages inside a Debian bookworm container and drop them in
# ../packages/ for the ISO build. Produces TWO debs:
#
#   libndpi-quartzfire_<ver>_amd64.deb  — the nDPI shared library (built from
#                                         source; not in Debian at >= 4.8)
#   qfappd_<ver>_amd64.deb              — the daemon, which Depends on it
#
# build-vyos-image bakes every packages/*.deb into the image, so both are
# installed automatically and qfappd finds libndpi.so at runtime.
#
# The build runs entirely inside the container's own filesystem (not the bind
# mount), so it works from a Windows/drvfs checkout as well as ext4 — only the
# finished debs are copied back to the host. Needs Docker. (The ISO build
# itself still must run on WSL2 ext4; see docs/build-wsl.md.)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
NDPI_REF="${NDPI_REF:-4.8}"

mkdir -p "$repo_root/packages"

echo "==> Building qfappd + libndpi packages in rust:1-bookworm (libndpi ${NDPI_REF})"
docker run --rm \
  -v "$repo_root/qfappd":/src-qfappd:ro \
  -v "$repo_root/packages":/out \
  rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  NDPI_REF="'"$NDPI_REF"'"
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    build-essential debhelper devscripts ca-certificates \
    protobuf-compiler clang libclang-dev pkg-config \
    autoconf automake libtool git libpcap-dev libgcrypt20-dev rsync >/dev/null

  # ── 1. libndpi from source → /usr/local (build headers/lib for qfappd) ──
  git clone --depth 1 --branch "$NDPI_REF" https://github.com/ntop/nDPI.git /tmp/nDPI 2>&1 | tail -1
  ( cd /tmp/nDPI && ./autogen.sh && ./configure --prefix=/usr/local && make -j"$(nproc)" && make install )
  ldconfig

  # ── 2. package the libndpi shared library as a .deb ──
  NDPI_PKG_VER="${NDPI_REF}+qf1"
  stage=/tmp/libndpi-pkg
  rm -rf "$stage"
  install -d -m0755 "$stage/usr/local/lib" "$stage/DEBIAN"
  cp -a /usr/local/lib/libndpi.so* "$stage/usr/local/lib/"
  cat > "$stage/DEBIAN/control" <<EOF
Package: libndpi-quartzfire
Version: ${NDPI_PKG_VER}
Architecture: amd64
Maintainer: QuartzFire <cwellman@quartz.systems>
Depends: libc6, libpcap0.8, libgcrypt20
Section: libs
Priority: optional
Description: nDPI deep-packet-inspection library for QuartzFire qfappd
 Shared library build of ntop nDPI '"$NDPI_REF"', installed under /usr/local
 (Debian does not ship a recent enough libndpi). Required by qfappd.
EOF
  printf "#!/bin/sh\nset -e\nldconfig\n" > "$stage/DEBIAN/postinst"
  chmod 0755 "$stage/DEBIAN/postinst"
  dpkg-deb --build --root-owner-group "$stage" "/out/libndpi-quartzfire_${NDPI_PKG_VER}_amd64.deb"

  # ── 3. build the qfappd .deb on the native fs (correct perms; no drvfs) ──
  #    Copy the source out of the read-only bind mount, minus build output.
  mkdir -p /build/qfappd
  rsync -a --exclude target/ /src-qfappd/ /build/qfappd/
  cd /build/qfappd
  chmod 0755 debian/rules debian/postinst debian/postrm scripts/qfappd-apply
  dpkg-buildpackage -us -uc -b
  cp /build/qfappd_*.deb /out/
'

echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/libndpi-quartzfire_*.deb "$repo_root"/packages/qfappd_*.deb

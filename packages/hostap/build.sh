#!/bin/sh
CWD=$(pwd)
set -e

SRC=hostap
SRC_DEB=wpa

if [ ! -d ${SRC} ]; then
    echo "${SRC} directory does not exists, please 'git clone'"
    exit 1
fi
if [ ! -d ${SRC_DEB} ]; then
    echo "${SRC_DEB} directory does not exists, please 'git clone'"
    exit 1
fi

echo "I: Copy Debian build instructions"
cp -a ${SRC_DEB}/debian ${SRC}
# Preserve Debian's default of allowing TLSv1.0 for compatibility
find ${SRC}/debian/patches -mindepth 1 ! -name allow-tlsv1.patch -delete
echo 'allow-tlsv1.patch' > ${SRC}/debian/patches/series

# Build Debian package
cd ${SRC}
echo "I: Create new Debian Package version"
version="$(git describe --tags | tr _ .)"
dch -v ${version:7} "New version to support AES-GCM-256 for MACsec" -b

echo "I: Build Debian hostap Package"
dpkg-buildpackage -us -uc -tc -b -Ppkg.wpa.nogui

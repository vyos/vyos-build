#!/bin/sh
CWD=$(pwd)
set -e

SRC=minisign

if [ ! -d ${SRC} ]; then
    echo "source directory does not exists, please 'git clone'"
    exit 1
fi

# Build instructions as per https://github.com/jedisct1/minisign/blob/master/README.md
BUILD_DIR="${SRC}/build"
mkdir -p ${BUILD_DIR}
cd ${BUILD_DIR}
cmake ..
make

# install
base="minisign_$(git describe --always)_amd64"
mkdir -p ${base}/usr/bin
mkdir -p ${base}/DEBIAN
cp minisign ${base}/usr/bin

cat << EOF >${base}/DEBIAN/control
Package: minisign
Version: 0.9
License: ISC
Vendor: none
Architecture: amd64
Maintainer: VyOS Package Maintainers <maintainers@vyos.net>
Installed-Size: 30
Depends: libsodium13
Section: default
Priority: extra
Homepage: https://github.com/jedisct1/minisign
Description: A dead simple tool to sign files and verify signatures.
EOF

fakeroot dpkg-deb --build ${base}
cp *.deb ${CWD}

# do not confuse Jenkins by providing multiple minisign deb files
cd ${CWD}
rm -rf ${BUILD_DIR}

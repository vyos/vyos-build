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
mkdir -p usr/bin
cp minisign usr/bin

fpm --input-type dir --output-type deb --name minisign \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "A dead simple tool to sign files and verify signatures." \
    --depends libsodium23 --architecture $(dpkg --print-architecture) \
    --version $(git describe --always) --license ISC --deb-compression gz usr

cp *.deb ${CWD}

# do not confuse Jenkins by providing multiple minisign deb files
cd ${CWD}
rm -rf ${BUILD_DIR}

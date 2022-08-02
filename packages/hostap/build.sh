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
rm -rf ${SRC}/debian/patches

# Build Debian package
cd ${SRC}
echo "I: Build Debian hostap Package"
dpkg-buildpackage -us -uc -tc -b -Ppkg.wpa.nogui

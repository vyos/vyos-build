#!/bin/sh -x
CWD=$(pwd)
set -e

SRC=keepalived

if [ ! -d ${SRC} ]; then
    echo "source directory does not exists, please 'git clone'"
    exit 1
fi

echo "I: Copy Debian build system"
cp -a debian ${SRC}

cd ${SRC}
echo "I: Retrieve version information from Git"
dch -v "1:$(git describe --tags | cut -c2-)" "VyOS build"

# Build Debian FRR package
echo "I: Build VyOS keepalived Package"
dpkg-buildpackage -us -uc -tc -b

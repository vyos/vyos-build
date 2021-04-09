#!/bin/sh
CWD=$(pwd)
set -e

SRC=iproute2
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}
PATCH_DIR=${CWD}/patches
for patch in $(ls ${PATCH_DIR})
do
    echo "I: Apply patch: ${PATCH_DIR}/${patch}"
    patch -p1 < ${PATCH_DIR}/${patch}
done

echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b -d

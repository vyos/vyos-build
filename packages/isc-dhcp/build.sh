#!/bin/sh
CWD=$(pwd)
set -e

SRC=isc-dhcp
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}
PATCH_DIR=${CWD}/patches
for patch in $(ls ${PATCH_DIR})
do
    echo "I: Copy patch: ${PATCH_DIR}/${patch}"
    cp ${PATCH_DIR}/${patch} debian/patches/${patch}
    echo ${patch} >> debian/patches/series
done

echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b -d

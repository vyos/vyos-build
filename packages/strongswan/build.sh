#!/bin/sh
CWD=$(pwd)
set -e

SRC=strongswan
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

PATCH_DIR=${CWD}/patches
if [ -d $PATCH_DIR ]; then
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${patch} to main repository"
        cp ${PATCH_DIR}/${patch} ${SRC}/debian/patches/
        echo ${patch} >> ${SRC}/debian/patches/series
    done
fi

cd ${SRC}
echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b

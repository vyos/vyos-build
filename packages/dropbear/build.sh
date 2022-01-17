#!/bin/sh
CWD=$(pwd)
set -e

SRC=dropbear
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}
PATCH_DIR=${CWD}/patches
if [ -d $PATCH_DIR ]; then
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${patch} to main repository"
        patch -p1 < ${PATCH_DIR}/${patch}
    done
fi

echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b

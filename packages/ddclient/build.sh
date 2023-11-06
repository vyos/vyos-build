#!/bin/bash
CWD=$(pwd)
set -e

SRC_DEBIAN=ddclient-debian
SRC_GITHUB=ddclient-github

if [ ! -d ${SRC_DEBIAN} ]; then
    echo "${SRC_DEBIAN} directory does not exists, please 'git clone'"
    exit 1
fi

if [ ! -d ${SRC_GITHUB} ]; then
    echo "${SRC_GITHUB} directory does not exists, please 'git clone'"
    exit 1
fi

echo "I: Copy Debian build instructions"
cp -a ${SRC_DEBIAN}/debian ${SRC_GITHUB}
# Preserve some of the Debian's default patches
cat > ${SRC_GITHUB}/debian/patches/series << EOF
maxinterval.diff
news.diff
EOF
# Remove vestigial documentation
sed -i '/README\.ssl/d' ${SRC_GITHUB}/debian/docs

PATCH_DIR=${CWD}/patches
if [ -d ${PATCH_DIR} ]; then
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${patch} to main repository"
        cp ${PATCH_DIR}/${patch} ${SRC_GITHUB}/debian/patches/
        echo ${patch} >> ${SRC_GITHUB}/debian/patches/series
    done
fi

cd ${SRC_GITHUB}

echo "I: Ensure Debian build dependencies are met"
sudo mk-build-deps --install --tool "apt-get --yes --no-install-recommends"

echo "I: Bump Debian Package version"
version="$(git describe --tags)"
dch -v "${version:1}+vyos0" "Patchset for miscellaneous fixes"
dch -a "Forward port to upstream version ${version:1}"

echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b

#!/bin/sh
CWD=$(pwd)
set -e

# extracted build dependencies, as autogenerationg and installing them will fail :/
sudo apt-get install -y bison \
    bzip2 \
    debhelper-compat \
    dh-apparmor \
    dpkg-dev  \
    flex \
    gperf \
    libiptc-dev \
    libcap-dev \
    libcurl3-dev \
    libgcrypt20-dev \
    libgmp3-dev \
    libkrb5-dev \
    libldap2-dev \
    libnm-dev \
    libpam0g-dev \
    libsqlite3-dev \
    libssl-dev \
    libsystemd-dev \
    libtool \
    libtss2-dev \
    libxml2-dev \
    pkg-config \
    po-debconf \
    systemd \
    libsystemd-dev \
    tzdata

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

echo "I: bump version"
dch -v "5.9.11-2+vyos0" "Patchset for DMVPN support" -b

echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b -d

#!/bin/sh
CWD=$(pwd)
set -e

FRR_SRC=frr

if [ ! -d ${FRR_SRC} ]; then
    echo "FRR source directory does not exists, please 'git clone'"
    exit 1
fi

# VyOS requires some small FRR Patches - apply them here
# It's easier to habe them here and make use of the upstream
# repository instead of maintaining a full Fork.
# Saving time/resources is essential :-)
cd ${FRR_SRC}

PATCH_DIR=${CWD}/patches

echo "I: Apply FRRouting patches not in main repository:"
for patch in $(ls ${PATCH_DIR})
do
    if [ -z "$(git config --list | grep -e user.name -e user.email)" ]; then
        # if git user.name and user.email is not set, -c sets temorary user.name and
        # user.email variables as these is not set in the build container by default.
        OPTS="-c user.name=VyOS-CI -c user.email=maintainers@vyos.io"
    fi
    git $OPTS am ${PATCH_DIR}/${patch}
done

# Prepare FRR source for building
echo "I: Prepare FRR source for building"
./tools/tarsource.sh -V

# Build Debian FRR package
echo "I: Build Debian FRR Package"
dpkg-buildpackage -us -uc -Ppkg.frr.rtrlib

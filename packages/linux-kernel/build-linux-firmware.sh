#!/bin/bash

# This script will use "list-required-firmware" to scan the kernel source repository
# in combination with its configuration file which drivers are compiled. Some of those
# drivers require proprietary firmware.
#
# All selected drivers are then precomfiled "make drivers/foo/bar.i" and we grep for
# the magic word "UNIQUE_ID_firmware" which identifies firmware files.

CWD=$(pwd)
LINUX_SRC="linux"
LINUX_FIRMWARE="linux-firmware"
KERNEL_VAR_FILE=${CWD}/kernel-vars

# Some firmware files might not be easy to extract (e.g. Intel iwlwifi drivers)
# thus we simply ammend them "manually"
ADD_FW_FILES="iwlwifi*"

if [ ! -d ${LINUX_SRC} ]; then
    echo "Kernel source missing"
    exit 1
fi

if [ ! -d ${LINUX_FIRMWARE} ]; then
    echo "Linux firmware repository missing"
    exit 1
fi

. ${KERNEL_VAR_FILE}

result=()
# Retrieve firmware blobs from source files
for FILE in $(${CWD}/list-required-firmware.py -k ${LINUX_SRC} -c ${CWD}/x86_64_vyos_defconfig -s drivers/net -s drivers/usb); do
    cd ${CWD}/${LINUX_SRC}
    echo "I: determine required firmware blobs for: ${FILE}"
    make LOCALVERSION=${KERNEL_SUFFIX} ${FILE/.c/.i} > /dev/null 2>&1

    if [ "$?" == "0" ]; then
        result+=( $(grep UNIQUE_ID_firmware ${FILE/.c/.i} | cut -d" " -f12- | xargs printf "%s" | sed -e "s/;/ /g") )
    fi
done

# Debian package will use the descriptive Git commit as version
GIT_COMMIT=$(cd ${CWD}/${LINUX_FIRMWARE}; git describe --always)
VYOS_FIRMWARE_NAME="vyos-linux-firmware"
VYOS_FIRMWARE_DIR="${CWD}/${VYOS_FIRMWARE_NAME}_${GIT_COMMIT}-0_all"
if [ -d ${VYOS_FIRMWARE_DIR} ]; then
    # remove Debian package folder and deb file from previous runs
    rm -rf ${VYOS_FIRMWARE_DIR}*
fi
mkdir -p ${VYOS_FIRMWARE_DIR}

# Copy firmware file from linux firmware repository into
# assembly folder for the vyos-firmware package
SED_REPLACE="s@${CWD}/${LINUX_FIRMWARE}/@@"
for FW in ${result[@]}; do
    FW_FILE=$(basename $FW)

    res=()
    for tmp in $(find ${CWD}/linux-firmware -type f -name ${FW_FILE} | sed -e ${SED_REPLACE} )
    do
        res+=( "$tmp" )
    done

    for FILE in ${res[@]}; do
        FW_DIR="${VYOS_FIRMWARE_DIR}/lib/firmware/$(dirname ${FILE})"
        mkdir -p ${FW_DIR}
        echo "I: install firmware: ${FILE}"
        cp ${CWD}/linux-firmware/${FILE} ${FW_DIR}
    done
done

# Install additional firmware files that could not be autodiscovered
for FW in ${ADD_FW_FILES}
do
    FW_DIR="${VYOS_FIRMWARE_DIR}/lib/firmware/$(dirname ${FW})"
    mkdir -p ${FW_DIR}
    echo "I: install firmware: ${FW}"
    cp  ${CWD}/linux-firmware/${FW} ${FW_DIR}
done

# Describe Debian package
mkdir ${VYOS_FIRMWARE_DIR}/DEBIAN
cat << EOF >${VYOS_FIRMWARE_DIR}/DEBIAN/control
Package: ${VYOS_FIRMWARE_NAME}
Version: ${GIT_COMMIT}
Section: kernel
Priority: extra
Architecture: all
Maintainer: VyOS Package Maintainers <maintainers@vyos.net>
Description: Firmware blobs for use with the Linux kernel
EOF

# Build Debian package
fakeroot dpkg-deb --build ${VYOS_FIRMWARE_DIR}

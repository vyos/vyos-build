#!/bin/bash

# All selected drivers are then precomfiled "make drivers/foo/bar.i" and we grep for
# the magic word "UNIQUE_ID_firmware" which identifies firmware files.

CWD=$(pwd)
LINUX_SRC="linux"
LINUX_FIRMWARE="linux-firmware"
KERNEL_VAR_FILE=${CWD}/kernel-vars

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
FW_FILES=$(find ${LINUX_SRC}/debian/linux-image/lib/modules/${KERNEL_VERSION}${KERNEL_SUFFIX}/kernel/drivers/net -name *.ko | xargs modinfo | grep "^firmware:" | awk '{print $2}')

# Debian package will use the descriptive Git commit as version
GIT_COMMIT=$(cd ${CWD}/${LINUX_FIRMWARE}; git describe --always)
VYOS_FIRMWARE_NAME="vyos-linux-firmware"
VYOS_FIRMWARE_DIR="${VYOS_FIRMWARE_NAME}_${GIT_COMMIT}-0_all"
if [ -d ${VYOS_FIRMWARE_DIR} ]; then
    # remove Debian package folder and deb file from previous runs
    rm -rf ${VYOS_FIRMWARE_DIR}*
fi
mkdir -p ${VYOS_FIRMWARE_DIR}

# Install firmware files to build directory
LINUX_FIRMWARE_BUILD_DIR="${LINUX_FIRMWARE}_${GIT_COMMIT}"

if [ -d ${LINUX_FIRMWARE_BUILD_DIR} ]; then
    rm -rf "${LINUX_FIRMWARE_BUILD_DIR}"
fi

mkdir -p "${LINUX_FIRMWARE_BUILD_DIR}"

(
    cd ${LINUX_FIRMWARE}
    ./copy-firmware.sh "${CWD}/${LINUX_FIRMWARE_BUILD_DIR}"
)

# Copy firmware file from linux firmware build directory into
# assembly folder for the vyos-firmware package
SED_REPLACE="s@${CWD}/${LINUX_FIRMWARE}/@@"
for FILE_PATTERN in ${FW_FILES}; do
    find "${LINUX_FIRMWARE_BUILD_DIR}" -path "*/${FILE_PATTERN}" -print0 | while IFS= read -r -d $'\0' FILE; do
        TARGET="$(echo "${FILE}" | sed "s/${LINUX_FIRMWARE_BUILD_DIR}\///g")"
        TARGET_DIR="${VYOS_FIRMWARE_DIR}/lib/firmware/$(dirname "${TARGET}")"
        # If file is a symlink install the symlink target as well
        if [ -h "${FILE}" ]; then
            if [ ! -f "${TARGET_DIR}/$(basename "${TARGET}")" ]; then
                if [ -f "${LINUX_FIRMWARE_BUILD_DIR}/${TARGET}" ]; then
                    mkdir -p "${TARGET_DIR}"

                    echo "I: install firmware: ${TARGET}"
                    cp "${CWD}/${LINUX_FIRMWARE_BUILD_DIR}/${TARGET}" "${TARGET_DIR}"
		    # If file links to other folder which this script not cover. Create folder and copy together.
                    if [ -L "${LINUX_FIRMWARE_BUILD_DIR}/${TARGET}" ]; then
                        REALPATH_TARGET=$(realpath --relative-to="${CWD}/${LINUX_FIRMWARE_BUILD_DIR}" "${CWD}/${LINUX_FIRMWARE_BUILD_DIR}/${TARGET}")
                        REALPATH_TARGET_DIR="${VYOS_FIRMWARE_DIR}/lib/firmware/$(dirname "${REALPATH_TARGET}")"
                        mkdir -p "${REALPATH_TARGET_DIR}"
                        echo "I: install firmware: ${REALPATH_TARGET}"
                        cp "${CWD}/${LINUX_FIRMWARE_BUILD_DIR}/${REALPATH_TARGET}" "${REALPATH_TARGET_DIR}"
                    fi
                 else
                    echo "I: firmware file not found: ${TARGET}"
                fi
            fi
        fi

        if [ -f "${FILE}" ]; then
            mkdir -p "${TARGET_DIR}"
            echo "I: install firmware: ${TARGET}"
            cp -P "${CWD}/${LINUX_FIRMWARE_BUILD_DIR}/${TARGET}" "${TARGET_DIR}"
        else
            echo "I: firmware file not found: ${TARGET}"
        fi
    done
done

echo "I: Create linux-firmware package"
rm -f ${VYOS_FIRMWARE_NAME}_*.deb
fpm --input-type dir --output-type deb --name ${VYOS_FIRMWARE_NAME} \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "Binary firmware for various drivers in the Linux kernel" \
    --architecture all --version ${GIT_COMMIT} --deb-compression gz -C ${VYOS_FIRMWARE_DIR}

rm -rf "${LINUX_FIRMWARE_BUILD_DIR}"
rm -rf ${VYOS_FIRMWARE_DIR}

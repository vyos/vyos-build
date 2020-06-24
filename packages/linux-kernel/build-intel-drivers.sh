#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

declare -a intel=(
    "http://dev.packages.vyos.net/source-mirror/ixgbe-5.7.1.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/igb-5.3.5.61.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/i40e-2.11.29.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/ixgbevf-4.7.1.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/i40evf-3.6.15.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/iavf-3.9.5.tar.gz"
)

for url in "${intel[@]}"
do
    cd ${CWD}

    DRIVER_FILE="$(basename ${url})"
    DRIVER_DIR="${DRIVER_FILE%.tar.gz}"
    DRIVER_NAME="${DRIVER_DIR%-*}"
    DRIVER_VERSION="${DRIVER_DIR##*-}"
    DRIVER_VERSION_EXTRA="-0"

    # Build up Debian related variables required for packaging
    DEBIAN_ARCH=$(dpkg --print-architecture)
    DEBIAN_DIR="${CWD}/vyos-intel-${DRIVER_NAME}_${DRIVER_VERSION}${DRIVER_VERSION_EXTRA}_${DEBIAN_ARCH}"
    DEBIAN_CONTROL="${DEBIAN_DIR}/DEBIAN/control"

    # Fetch Intel driver source from SourceForge
    if [ -e ${DRIVER_FILE} ]; then
        rm -f ${DRIVER_FILE}
    fi
    curl -L -o ${DRIVER_FILE} ${url}
    if [ "$?" -ne "0" ]; then
        exit 1
    fi

    # Unpack archive
    if [ -d ${DRIVER_DIR} ]; then
        rm -rf ${DRIVER_DIR}
    fi
    tar xf ${DRIVER_FILE}


    cd ${DRIVER_DIR}/src
    if [ -z $KERNEL_DIR ]; then
        echo "KERNEL_DIR not defined"
        exit 1
    fi
    echo "I: Compile Kernel module for Intel ${DRIVER_NAME} driver"
    KSRC=${KERNEL_DIR} \
        INSTALL_MOD_PATH=${DEBIAN_DIR} \
        make -j $(getconf _NPROCESSORS_ONLN) install

    mkdir -p $(dirname "${DEBIAN_CONTROL}")
    cat << EOF >${DEBIAN_CONTROL}
Package: vyos-intel-${DRIVER_NAME}
Version: ${DRIVER_VERSION}-${DRIVER_VERSION_EXTRA}
Section: kernel
Priority: extra
Architecture: ${DEBIAN_ARCH}
Maintainer: VyOS Package Maintainers <maintainers@vyos.net>
Description: Vendor based driver for Intel ${DRIVER_NAME}
Depends: linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX}
EOF

    # delete non required files which are also present in the kernel package
    # und thus lead to duplicated files
    find ${DEBIAN_DIR} -name "modules.*" | xargs rm -f

    # build Debian package
    echo "I: Building Debian package vyos-intel-${DRIVER_NAME}"
    fakeroot dpkg-deb --build ${DEBIAN_DIR}


    echo "I: Cleanup ${DRIVER_NAME} source"
    cd ${CWD}
    if [ -e ${DRIVER_FILE} ]; then
        rm -f ${DRIVER_FILE}
    fi
    if [ -d ${DRIVER_DIR} ]; then
        rm -rf ${DRIVER_DIR}
    fi
    if [ -d ${DEBIAN_DIR} ]; then
        rm -rf ${DEBIAN_DIR}
    fi
done

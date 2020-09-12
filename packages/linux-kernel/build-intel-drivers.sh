#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

declare -a intel=(
    "http://dev.packages.vyos.net/source-mirror/ixgbe-5.8.1.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/ixgbevf-4.8.1.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/igb-5.3.6.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/i40e-2.12.6.tar.gz"
    "http://dev.packages.vyos.net/source-mirror/iavf-4.0.1.tar.gz"
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
    DEBIAN_POSTINST="${CWD}/vyos-intel-driver.postinst"

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

    # delete non required files which are also present in the kernel package
    # und thus lead to duplicated files
    find ${DEBIAN_DIR} -name "modules.*" | xargs rm -f

    echo "#!/bin/sh" > ${DEBIAN_POSTINST}
    echo "/sbin/depmod -a ${KERNEL_VERSION}${KERNEL_SUFFIX}" >> ${DEBIAN_POSTINST}

    # build Debian package
    echo "I: Building Debian package vyos-intel-${DRIVER_NAME}"
    cd ${CWD}
    if [ -f ${DEBIAN_DIR}.deb ]; then
        rm ${DEBIAN_DIR}.deb
    fi
    fpm --input-type dir --output-type deb --name vyos-intel-${DRIVER_NAME} \
        --version ${DRIVER_VERSION}${DRIVER_VERSION_EXTRA} --deb-compression gz \
        --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
        --description "Vendor based driver for Intel ${DRIVER_NAME} NIC" \
	--depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
	--license "GPL2" \
        -C ${DEBIAN_DIR} --after-install ${DEBIAN_POSTINST}

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

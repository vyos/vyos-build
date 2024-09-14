#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if ! dpkg-architecture -iamd64; then
    echo "Intel-QAT is only buildable on amd64 platforms"
    exit 0
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

url="https://dev.packages.vyos.net/source-mirror/QAT.L.4.24.0-00005.tar.gz"

cd ${CWD}

DRIVER_FILE=$(basename ${url} | sed -e s/tar_0/tar/)
DRIVER_DIR="${DRIVER_FILE%.tar.gz}"
DRIVER_NAME="QAT"
DRIVER_NAME_EXTRA="L."
DRIVER_VERSION=$(echo ${DRIVER_DIR} | awk -F${DRIVER_NAME} '{print $2}' | awk -F${DRIVER_NAME_EXTRA} '{print $2}')
DRIVER_VERSION_EXTRA="-0"

# Build up Debian related variables required for packaging
DEBIAN_ARCH=$(dpkg --print-architecture)
DEBIAN_DIR="${CWD}/vyos-intel-${DRIVER_NAME}_${DRIVER_VERSION}${DRIVER_VERSION_EXTRA}_${DEBIAN_ARCH}"
DEBIAN_CONTROL="${DEBIAN_DIR}/DEBIAN/control"
DEBIAN_POSTINST="${CWD}/vyos-intel-qat.postinst"

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
mkdir -p ${DRIVER_DIR}
tar -C ${DRIVER_DIR} -xf ${DRIVER_FILE}

cd ${DRIVER_DIR}
if [ -z $KERNEL_DIR ]; then
    echo "KERNEL_DIR not defined"
    exit 1
fi

echo "I: Compile Kernel module for Intel ${DRIVER_NAME} driver"
mkdir -p \
    ${DEBIAN_DIR}/lib/firmware \
    ${DEBIAN_DIR}/usr/sbin \
    ${DEBIAN_DIR}/usr/lib/x86_64-linux-gnu \
    ${DEBIAN_DIR}/etc/init.d
KERNEL_SOURCE_ROOT=${KERNEL_DIR} ./configure --enable-kapi --enable-qat-lkcf
make -j $(getconf _NPROCESSORS_ONLN) all
make INSTALL_MOD_PATH=${DEBIAN_DIR} INSTALL_FW_PATH=${DEBIAN_DIR} \
    qat-driver-install adf-ctl-all

if [ "x$?" != "x0" ]; then
    exit 1
fi

cp quickassist/qat/fw/*.bin ${DEBIAN_DIR}/lib/firmware
cp build/*.so ${DEBIAN_DIR}/usr/lib/x86_64-linux-gnu
cp build/adf_ctl ${DEBIAN_DIR}/usr/sbin
cp quickassist/build_system/build_files/qat_service ${DEBIAN_DIR}/etc/init.d
cp build/usdm_drv.ko ${DEBIAN_DIR}/lib/modules/${KERNEL_VERSION}${KERNEL_SUFFIX}/updates/drivers
chmod 644 ${DEBIAN_DIR}/lib/firmware/*
chmod 755 ${DEBIAN_DIR}/etc/init.d/* ${DEBIAN_DIR}/usr/local/bin/*

if [ -f ${DEBIAN_DIR}.deb ]; then
    rm ${DEBIAN_DIR}.deb
fi

# build Debian package
echo "I: Building Debian package vyos-intel-${DRIVER_NAME}"
cd ${CWD}

# delete non required files which are also present in the kernel package
# und thus lead to duplicated files
find ${DEBIAN_DIR} -name "modules.*" | xargs rm -f

echo "#!/bin/sh" > ${DEBIAN_POSTINST}
echo "/sbin/depmod -a ${KERNEL_VERSION}${KERNEL_SUFFIX}" >> ${DEBIAN_POSTINST}

fpm --input-type dir --output-type deb --name vyos-intel-${DRIVER_NAME} \
    --version ${DRIVER_VERSION}${DRIVER_VERSION_EXTRA} --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "Vendor based driver for Intel ${DRIVER_NAME}" \
    --depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
    --license "GPL2" -C ${DEBIAN_DIR} --after-install ${DEBIAN_POSTINST}

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
if [ -f ${DEBIAN_POSTINST} ]; then
    rm -f ${DEBIAN_POSTINST}
fi

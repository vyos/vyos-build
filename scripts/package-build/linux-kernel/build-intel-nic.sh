#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if ! dpkg-architecture -iamd64; then
    echo "Intel drivers only buildable on amd64 platforms"
    exit 0
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

if [ -z $KERNEL_DIR ]; then
    echo "KERNEL_DIR not defined"
    exit 1
fi

DRIVER_NAME=$1
cd ${CWD}/ethernet-linux-${DRIVER_NAME}
if [ -d .git ]; then
    git clean --force -d -x
    git reset --hard origin/main
fi

DRIVER_VERSION=$(git describe | sed s/^v//)

# Build up Debian related variables required for packaging
DEBIAN_ARCH=$(dpkg --print-architecture)
DEBIAN_DIR="${CWD}/vyos-intel-${DRIVER_NAME}_${DRIVER_VERSION}_${DEBIAN_ARCH}"
DEBIAN_CONTROL="${DEBIAN_DIR}/DEBIAN/control"
DEBIAN_POSTINST="${CWD}/vyos-intel-${DRIVER_NAME}.postinst"

# See https://vyos.dev/T6155
# See https://vyos.dev/T6162
PATCH_DIR=${CWD}/patches/${DRIVER_NAME}
if [ -d $PATCH_DIR ]; then
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${PATCH_DIR}/${patch}"
        patch -p1 < ${PATCH_DIR}/${patch}
    done
fi

echo "I: Compile Kernel module for Intel ${DRIVER_NAME} driver"
make KSRC=${KERNEL_DIR} BUILD_KERNEL=${KERNEL_VERSION}${KERNEL_SUFFIX} INSTALL_MOD_PATH=${DEBIAN_DIR} INSTALL_FW_PATH=${DEBIAN_DIR} -j $(getconf _NPROCESSORS_ONLN) -C src install

if [ "x$?" != "x0" ]; then
    exit 1
fi

if [ -f ${DEBIAN_DIR}.deb ]; then
    rm ${DEBIAN_DIR}.deb
fi

# build Debian package
echo "I: Building Debian package vyos-intel-${DRIVER_NAME}"
cd ${CWD}

# Sign generated Kernel modules
${CWD}/sign-modules.sh ${DEBIAN_DIR}

# delete non required files which are also present in the kernel package
# und thus lead to duplicated files
find ${DEBIAN_DIR} -name "modules.*" | xargs rm -f

echo "#!/bin/sh" > ${DEBIAN_POSTINST}
echo "/sbin/depmod -a ${KERNEL_VERSION}${KERNEL_SUFFIX}" >> ${DEBIAN_POSTINST}

fpm --input-type dir --output-type deb --name vyos-intel-${DRIVER_NAME} \
    --version ${DRIVER_VERSION} --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "Vendor based driver for Intel ${DRIVER_NAME}" \
    --depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
    --license "GPL2" -C ${DEBIAN_DIR} --after-install ${DEBIAN_POSTINST}

# cleanup
rm -rf -- "${DEBIAN_DIR}" "${DEBIAN_POSTINST}"

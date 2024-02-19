#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

ACCEL_SRC=${CWD}/accel-ppp
if [ ! -d ${ACCEL_SRC} ]; then
    echo "Accel-PPP source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

PATCH_DIR=${CWD}/patches/accel-ppp
if [ -d $PATCH_DIR ]; then
    cd ${ACCEL_SRC}
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${PATCH_DIR}/${patch}"
        patch -p1 < ${PATCH_DIR}/${patch}
    done
fi

. ${KERNEL_VAR_FILE}
mkdir -p ${ACCEL_SRC}/build
cd ${ACCEL_SRC}/build

echo "I: Build Accel-PPP Debian package"
cmake -DBUILD_IPOE_DRIVER=TRUE \
    -DBUILD_VLAN_MON_DRIVER=TRUE \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DKDIR=${KERNEL_DIR} \
    -DLUA=5.3 \
    -DMODULES_KDIR=${KERNEL_VERSION}${KERNEL_SUFFIX} \
    -DCPACK_TYPE=Debian12 ..
make
cpack -G DEB

# rename resulting Debian package according git description
mv accel-ppp*.deb ${CWD}/accel-ppp_$(git describe --always --tags)_$(dpkg --print-architecture).deb

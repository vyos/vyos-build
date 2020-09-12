#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
WIREGUARD_SRC=${CWD}/wireguard-linux-compat

if [ ! -d ${WIREGUARD_SRC} ]; then
    echo "WireGuard source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}
cd ${WIREGUARD_SRC}

# We need some WireGuard patches for building, it's easier to have them here
# and make use of the upstream repository instead of maintaining a full fork,
# saving time/resources is essential :-)
PATCH_DIR=${CWD}/patches/wireguard-linux-compat
for patch in $(ls ${PATCH_DIR})
do
    echo "I: Apply WireGuard patch: ${PATCH_DIR}/${patch}"
    patch -p1 < ${PATCH_DIR}/${patch}
done

echo "I: Build Debian WireGuard package"
KERNELDIR=$KERNEL_DIR dpkg-buildpackage -b -us -uc -tc

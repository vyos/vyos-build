#!/bin/sh

ARCH_TRIPLET=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

ACCEL_SRC=${CWD}/accel-ppp-ng
if [ ! -d ${ACCEL_SRC} ]; then
    echo "Accel-PPP source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

sudo apt-get update
sudo apt-get install -y vpp vpp-dev

cd ${ACCEL_SRC}
git reset --hard HEAD
git clean --force -d -x

PATCH_DIR=${CWD}/patches/accel-ppp-ng
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
    -DHAVE_VPP=1 \
    -DHAVE_SESSION_HOOKS=1 \
    -DCPACK_TYPE=Debian12 ..
make

# Sign generated Kernel modules. Keep the uncompressed .ko next to the
# resulting .ko.xz: cpack's DEB packaging re-runs "make all" as part of
# its install step, and if the .ko CMake tracks as a build output were
# removed by compression, it would be silently rebuilt unsigned before
# being packaged.
${CWD}/sign-modules.sh . --keep

cpack -G DEB

# rename resulting Debian package according git description
mv accel-ppp*.deb ${CWD}/accel-ppp-ng_$(git describe --always --tags)_$(dpkg --print-architecture).deb


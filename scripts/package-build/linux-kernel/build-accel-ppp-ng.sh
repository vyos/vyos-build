#!/bin/sh
set -e

ARCH_TRIPLET=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
VPP_SYSROOT=${CWD}/vpp-sysroot

ACCEL_SRC=${CWD}/accel-ppp-ng
if [ ! -d ${ACCEL_SRC} ]; then
    echo "Accel-PPP source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

# Link against the VPP packages from the VyOS APT repository - the same ones
# that end up in the image - instead of building VPP from source. They are
# only unpacked, not installed, so the build container stays untouched.
VPP_VERSION=$(apt-cache policy vpp-dev | awk '/Candidate:/ {print $2}')
if [ -z "${VPP_VERSION}" ] || [ "${VPP_VERSION}" = "(none)" ]; then
    echo "E: vpp-dev not found in APT sources, is the VyOS repository configured?"
    exit 1
fi

echo "I: Unpack VPP ${VPP_VERSION} development files"
rm -rf ${VPP_SYSROOT}
mkdir -p ${VPP_SYSROOT}/debs
cd ${VPP_SYSROOT}/debs
apt-get download vpp=${VPP_VERSION} vpp-dev=${VPP_VERSION} \
    libvppinfra=${VPP_VERSION} libvppinfra-dev=${VPP_VERSION}
for deb in *.deb; do
    dpkg-deb -x ${deb} ${VPP_SYSROOT}
done
cd ${CWD}

VPP_INCLUDE_PATH="${VPP_SYSROOT}/usr/include"
VPP_LIBRARY_PATH="${VPP_SYSROOT}/usr/lib/${ARCH_TRIPLET}"
if [ ! -f ${VPP_INCLUDE_PATH}/vapi/vapi.h ] || [ ! -e ${VPP_LIBRARY_PATH}/libvapiclient.so ]; then
    echo "E: VPP development files not found in ${VPP_SYSROOT}"
    exit 1
fi

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
CPATH="${VPP_INCLUDE_PATH}" LIBRARY_PATH="${VPP_LIBRARY_PATH}" make

# Sign generated Kernel modules. Keep the uncompressed .ko next to the
# resulting .ko.xz: cpack's DEB packaging re-runs "make all" as part of
# its install step, and if the .ko CMake tracks as a build output were
# removed by compression, it would be silently rebuilt unsigned before
# being packaged.
${CWD}/sign-modules.sh . --keep

cpack -G DEB

# rename resulting Debian package according git description
mv accel-ppp*.deb ${CWD}/accel-ppp-ng_$(git describe --always --tags)_$(dpkg --print-architecture).deb
